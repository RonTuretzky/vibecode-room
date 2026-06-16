# smithering-impl — blocking review fixes (durable record)

Cross-model reviewer raised 6 blocking issues against
`.smithers/workflows/smithering-impl.tsx`. Each was resolved with the smallest change that
keeps the orchestration design (ORCH-A-01..08) intact. Verification commands re-run before
finishing are at the bottom; all are green.

## 1 — Workflow does not typecheck (`ctx.idempotencyKey` `string | null`)
**Fix.** `landTool.execute` now coalesces the nullable tool-context key to the stable
ticket-derived key: `ctx.idempotencyKey ?? \`land-${args.ticketId}\``. The fallback is the
same value the deterministic lane uses, so resume stays a no-op.
**Evidence.** `tsc --noEmit` on the file directly (the reviewer's exact command) is now
exit 0; previously errored at line 445.

## 2 — Blocking gates not wired into the merge gate
**Fix.** Added a deterministic, CODE-authoritative pre-merge gate (`runMergeGate`) that runs
after the `--no-commit` merge stages the rebased tip and BEFORE commit. It:
- machine-reads the worker's `gates.json`, `verify.json`, `review.json` and runs
  `evaluateEvidenceBundle` (src/orchestration/core.ts) — every pre-merge blocking gate must
  be `passed`, `rbgRecorded`, with red+green run files that exist and are non-empty;
- runs a fail-closed **secret scan** over the whole bundle (`bundleSecretCount`);
- re-runs `tsc --noEmit` and `bun test` (the pre-merge subset incl. the walking-skeleton
  smoke) on the **merged tip** in the integration worktree;
- runs `lint:arch` as a blocking gate when the build has defined it (logged-skip otherwise);
- runs `postsubmit` AFTER a successful land and records its verdict (ORCH-A-02: postsubmit
  failure is a manual human revert, so it records rather than blocks).
A red gate `git merge --abort`s and BOUNCES with the concrete reasons in the trace.
`ticketDone` now ANDs the agent booleans with `ticketEvidenceComplete` (the same machine
check), so "the agent said done" is never sufficient.

## 3 — Probe gates / Cue validation were prompt-only, not scheduler-enforced
**Fix.** `ticketEligible` now requires, in addition to deps landed, that **every transitive
blocking probe** (`blockingProbeClosure`, src/orchestration/core.ts) has a recorded GREEN
verdict artifact on disk (`probeVerdictGreen` reads `<probe>/probes/<probe>/verdict.json` and
requires an explicit truthy `green`/`pass`/`overallPassed`). A ticket whose probe is
unrun/red renders as `blocked` and never schedules — Cue / third-party work proceeds only on
a real green probe artifact, not agent compliance. Probe tickets are instructed to write the
machine-readable `verdict.json`.

## 4 — Durable evidence bundle not authoritative
**Fix.** `REQUIRED_BUNDLE_FILES` (RESULT.md, gates.json, verify.json, review.json,
secret-scan.json) must all exist and be non-empty for a land. The reviewer prompt now WRITES
`review.json`; the implementer prompt documents that `review.json`/`verify.json` complete the
bundle and that the land gate machine-checks all of it. `logEvent` no longer silently
swallows a trace-write failure (it surfaces to stderr); the authoritative per-ticket bundle
is the fail-closed record. `.gitignore` now keeps `build/`+`probes/` RBG `*.log` evidence so
it travels with the merge.

## 5 — Orchestration tests + e2e dry-run absent
**Fix.** Extracted the pure scheduler/gate logic into `src/orchestration/core.ts` (imported
by the workflow, so the shipped logic IS the tested logic) and added
`src/orchestration/*.test.ts` covering the §8 invariants with red-before-green moves:
`dag.test.ts` (acyclic + dangling-ref), `probe-precedence.test.ts` (transitive probe gate),
`evidence-gate.test.ts` (no-RBG / verify-fail / review-reject / missing-file → land refused),
`secret-scan.test.ts` (plant a fake key), `cross-family.test.ts` (same-family throws), and
`e2e-dry-run.test.ts` (schedule → fake implement → review → verify → serialized land → trace
reconstruction over a synthetic 3-ticket DAG, with a red-probe halt). 33 tests, all failable.

## 6 — Side-effect safety not launch-ready
**Fix.** `landTool.idempotent` is now `true` (the impl is a no-op when the branch is already
in integration ancestry). The land lane runs ALL git ops (`checkout`/`merge`/`commit`) in a
DEDICATED clean integration worktree `.smithers/integration` (created idempotently by
`ensureIntegrationBranch` via `git worktree add`), never the dirty / detached-HEAD repo root
— removing the resume + unrelated-change risk. The land task still calls `landTicketBranch`
directly (merge authority stays in CODE, never the LLM) with a stable ticket-derived
idempotency key.

## Verification (all green)
- `bunx tsc --noEmit` (project) → exit 0
- `bunx tsc --noEmit … .smithers/workflows/smithering-impl.tsx` (reviewer's direct cmd) → exit 0
- `bun test src/orchestration` → 33 pass / 0 fail
- `bunx smithers-orchestrator graph .smithers/workflows/smithering-impl.tsx` → exit 0
- `… graph … --input '{"smoke":true}'` → exit 0
