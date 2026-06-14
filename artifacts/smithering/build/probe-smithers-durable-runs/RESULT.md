# probe-smithers-durable-runs

## Built

- Added `poc/p-smithers.test.ts`, a real Smithers Gateway probe that registers a durable workflow against a persistent SQLite database.
- The probe asserts gateway-launched run spawn with seed payload, `streamRunEvents` WebSocket event shape, waiting-event pause, explicit `resumeRun`, gateway `submitSignal` steering, pre-restart context archive, restart recovery equality, five concurrent durable runs, and fork realization.
- Fork verdict: Gateway V0 has no native fork RPC (`forkRun` returns `METHOD_NOT_FOUND`), so Panopticon V0 should realize process forks as a fresh gateway-launched seeded run carrying `parentId` lineage in the input. Native Smithers time-travel fork exists as a CLI capability, but the app process control plane should stay on Gateway APIs.
- Steering verdict: Panopticon process launch and mid-run steering must use Gateway mode and the Gateway `submitSignal` RPC path. The probe does not use the `smithers signal` CLI for steering.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| P-SMITHERS | passed | `evidence/P-SMITHERS-rbg-red.log`, `evidence/P-SMITHERS-green.log`, `tests.log` |

## Dependency Results

- `probe-suite-harness` was read and was already green at `artifacts/smithering/probes/probe-suite-harness/verdict.json`.
- Dependency result read from `artifacts/smithering/build/probe-suite-harness/RESULT.md`.

## Source Gaps

- The requested `docs/planning/*.md`, `docs/planning/04-backpressure.md`, `docs/planning/05-tickets.md`, `docs/planning/06-orchestration.md`, `artifacts/smithering/probes/assumption-durable-voice-steerable-processes/`, and `artifacts/smithering/poc/safety-hook-approval-roundtrip/FINDINGS.md` paths were not present in this isolated worktree. The probe was grounded in the landed dependency harness, installed Smithers docs, `.smithers/gateway.ts`, and the installed Smithers package's Gateway implementation/tests.

## Reports

- `artifacts/smithering/probes/probe-smithers-durable-runs/pre-kill-context.json`
- `artifacts/smithering/probes/probe-smithers-durable-runs/fork-realization.json`
- `artifacts/smithering/probes/probe-smithers-durable-runs/verdict.json`

## Blockers

None surfaced.
