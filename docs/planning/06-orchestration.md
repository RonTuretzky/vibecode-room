# Panopticon — Implementation Orchestration (V0)

> **Audio-only. Voice is the sole operational modality.** This document specifies **how the V0 tickets
> are actually built**: how they parallelize into worktrees, how work lands, which gates run where, which
> model builds/reviews/verifies each ticket, how many workers run at once, what evidence every ticket
> persists, and what each fresh-context worker is handed. Per the operating bar, **the verification plan
> is the centerpiece** — the orchestration logic is itself tested (§8), and a ticket lands only with
> recorded **red-before-green** evidence (§3, §6).
>
> **Each field below is a DECISION, not a consideration** — a verdict the implementation workflow obeys.
>
> **Upstream (read from disk, not assumed):**
> `docs/planning/03-eng.md` (architecture, §9 seam, §10 registry, §17 probes, §22 round-1 probe results),
> `docs/planning/04-backpressure.md` (the gate matrix), `docs/planning/05-tickets.md` (the V0 tickets, the
> DAG, phases), and the machine copy `artifacts/smithering/tickets.json`.
>
> **Targets (binding):** repo = `.` · base branch = `main` · VCS = jj co-located with git.
>
> **State of the world (round-1, 2026-06-14):** **the pipeline is PAUSED** pending the remaining blocking
> probes; P-SEAM, P-ASR-Deepgram, A-LLM-SUB, P-TTS-streaming are still open (§22 of eng). The orchestration
> below is the machine that runs *once those gates clear* — and its pre-build probe gate (§3) is exactly
> what is holding the line today. **V0 runs dangerously / to completion** — there is no per-step approval
> gate, read-back, or safety hook in scope (E6/E7/E8).

---

## 0. The orchestration model in one breath

The implementation workflow is a **Smithers durable run** that walks the `tickets.json` DAG. **Speed is the
priority — maximize concurrency.** For each ready ticket it cuts a **per-ticket jj/git worktree off `main`**,
hands a **fresh-context implementer agent** the ticket JSON + the doc paths to read from disk, requires the
ticket's **full test suite** to pass with **recorded red-before-green**, runs a **two-model review (Codex
gpt-5.5 + Opus 4.8)** and an **independent Sonnet 4.6 test-authority verifier**, then lands through an
**optimistic merge lane (land-then-learn) with postsubmit eviction**. Tickets are ordered to **minimize
merge conflicts**. Every ticket persists its evidence under `artifacts/smithering/build/<ticketId>/`, and
every judgment call gets a self-contained HTML decision log under `artifacts/smithering/decisions/`. Probes
gate *before* their dependents are even scheduled; **all tests run in both pre-submit and post-submit on `main`**.

Seven decisions, each its own section: **worktreeLayout (§1) · mergePolicy (§2) · testTiers (§3) ·
modelAssignment (§4) · concurrency (§5) · observability (§6) · contextManagement (§7)**, plus the
**computed wave & track schedule (§11)** the generated workflow walks.

> **Integration-branch reconciliation (binding override).** Where §1/§2 below say "off `main`" / "land on
> `main`", read **the integration branch** (default `smithering/integration`). **This workflow NEVER merges
> to the base branch `main` — no exceptions.** All work lands on the integration branch, which is the
> build's trunk; worktrees base off it, the optimistic lane lands onto it, and the postsubmit suite runs on it.
> **Merging the integration branch into `main` is a deliberate human act after delivery**, not something
> this run ever performs. The generated workflow (`.smithers/workflows/smithering-impl.tsx`) hard-guards
> the land step to refuse any target equal to `main`/the base branch.

---

## 1. DECISION — worktreeLayout

**Decision (ORCH-A-01).** **One jj/git worktree per ticket** — concurrency is maximized, so as many
worktrees run at once as the DAG allows. Co-located in the target repo (`.`), branch `build/<ticketId>` in
worktree `.smithers/wt/<ticketId>`, **branched off the current `main` tip once every `dependsOn` ancestor
has landed**. The stable kebab `id` (the durable Smithers task id) names the worktree — never an index or
timestamp. **Within a wave, tickets are ordered to MINIMIZE merge conflicts** (disjoint-path tickets land
first; tickets that touch the same files are sequenced adjacently so their optimistic re-rebases are cheap).
Smithers worktree runs **auto-rebase on resume**, and jj records rebase conflicts as first-class state
rather than failing silently, so a resumed worker re-reads disk and resolves the materialized conflict.

| Knob | Choice | Why |
|---|---|---|
| Granularity | per **ticket**, not per phase, not per file | The DAG is expressed per ticket; a worktree per ticket means parallel tickets never share a working copy, so edits only ever meet in the optimistic merge lane (§2). Ordering within a wave minimizes how often they actually collide. |
| Base | `main` at the ticket's dependency-closure tip | A ticket reads the **real, landed** interfaces of its deps (e.g. `src/types.ts` from `shared-types-contract`) instead of re-deriving them. |
| Lifetime | = ticket lifetime; removed after land, or **kept** while it still carries an unresolved jj conflict | Durable: a killed/resumed run finds its worktree exactly as left (REQ-15 ethic applied to the build). |
| Probe worktrees | disposable; write **only** under `poc/` and `artifacts/smithering/probes/` | Disjoint paths → probes parallelize freely and land via a trivial fast lane with no `src/` conflicts. |

**Scheduling rule.** `ready(t)` ⇔ every `t.dependsOn` has **landed on `main`** *and* every blocking probe
`t` depends on is **green** (§3 pre-build probe gate). The workflow takes ready tickets in topo-rank order up to
the concurrency cap (§5). Phase-0 fan-out (`record-replay-harness`, `provider-interface-doubles`,
`trace-processor-observability`, `probe-suite-harness`) and the Phase-1 independent probes are the only
wide antichains; the rest of the DAG is dependency-narrow.

**Verify (the layout logic).**
- *DAG-acyclic test* — `tickets.json` `dependsOn` is acyclic and every reference resolves. **RBG:** add a
  back-edge → cycle detector fails.
- *base-correctness test* — a ticket's worktree base contains every dep's landed commit. **RBG:** branch a
  ticket before a dep lands → missing-ancestor assertion fails.
- *worktree-isolation test* — two parallel workers editing the same path land without clobber (second
  rebases → clean merge or jj-conflict bounce). **RBG:** share one working copy → concurrent-edit
  corruption detector fails.
- *Observability:* `build.worktree.create{ticketId, base, branch}`, `build.worktree.rebase{ticketId,
  conflicted:bool}`. Decision doc: `worktree-and-concurrency.html`.

---

## 2. DECISION — mergePolicy

**Decision (ORCH-A-02).** **Optimistic merging — land-then-learn with postsubmit eviction.** Speed is the
priority, so a ticket whose own full suite is green **lands immediately** (it does not wait its turn behind a
serializer); the **postsubmit full suite on `main`** is the safety net, and a postsubmit break **evicts** the
offending land (and re-rebases its dependents) rather than holding every land hostage to a single writer.

The reasoning is throughput: serializing every land behind one writer wastes the concurrency §1/§5 buy us.
Optimistic land + eviction is *custom* logic — `CheckSuite` (attribute the postsubmit break) + `Saga`
(compensate every dependent that already branched) + `jj revert` (surgical back-out) + cascade re-rebase
(worktree runs auto-rebase on resume, materializing conflicts a human/agent then resolves). We accept that
machinery because it is faster, and we cap its blast radius by ordering tickets to minimize conflicts (§1)
and by keeping the postsubmit suite fast so eviction fires quickly.

| Mechanism | V0 verdict | Reason |
|---|---|---|
| MergeQueue as a **concurrency limiter** (high depth) | **USE** | Caps host run-slots, but does **not** serialize to one writer — lands proceed optimistically as soon as a ticket is green. |
| **Pre-submit gate on the rebased tip** | **BUILD** | A ticket re-runs **all its tests** (§3) *after* rebasing onto the current tip; green → land; jj conflict → **bounce to the worker** (conflict materialized) for a fix-up resume, never a force-land. |
| Optimistic land + **postsubmit auto-eviction** (CheckSuite + Saga + jj revert + cascade) | **BUILD** | The chosen approach — land-then-learn is faster; a postsubmit break is attributed, the bad land is `jj revert`-ed, and every dependent that already branched is compensated and re-rebased. |
| **Postsubmit full suite on `main`** | **RUN — auto-evict on failure** | After each land the **same full suite** (§3) runs again; a red postsubmit fires **automatic eviction** of the attributed land plus a **recorded eviction decision** (`decisions/build/<slug>.html`) for the audit trail. |

Because every land is **already green with recorded RBG** before it lands, postsubmit breaks (and therefore
evictions) are expected to be rare — but when one fires, eviction is automatic, not a manual lane.

**Verify (the merge logic).**
- *optimistic-land test* — a ticket whose full suite is green lands without waiting for a serializer; two
  green tickets can land concurrently. **RBG:** force a single-writer lock → the concurrency assertion fails.
- *gate-before-land test* — a ticket with a failing/absent pre-submit suite **or no recorded RBG** cannot
  land. **RBG:** stub `rbgRecorded:false` → land refused; supply both red+green logs → allowed.
- *rebase-conflict-bounce test* — a forced jj conflict returns the ticket to its worker (not force-landed).
  **RBG:** auto-resolve-by-discard → conflict-bounce assertion fails.
- *postsubmit-eviction test* — an injected `main` failure attributes the break, `jj revert`s the bad land,
  and re-rebases its dependents. **RBG:** disable attribution → eviction targets the wrong land → fails.
- *Observability:* `merge.land{ticketId, rank}`, `merge.land.ff{ticketId, ff:bool}`,
  `merge.bounce{ticketId, reason:'conflict'|'gate'}`, `postsubmit.fail{ticketId, gate}`,
  `postsubmit.evict{ticketId, dependentsRebased}`. Decision doc: `merge-policy-optimistic-eviction.html`.

---

## 3. DECISION — testTiers

**Decision (ORCH-A-03).** **No pre/post-submit test tiers. Run ALL tests in BOTH pre-submit and post-submit.**
Probes still gate before build (they validate third-party APIs before any code depends on them), but for the
ticket's own tests there is no "cheap hermetic subset vs. full real-world suite" split: the **entire**
`verification[]` runs to gate the land, and the **same entire suite** runs again postsubmit on `main`. We
**assume tests are fast** and do not design tiers. (If a single test turns out to be slow, a human monitor
can move it to postsubmit-only later — but we do not plan for that up front.)

| Phase | When | What runs |
|---|---|---|
| **Pre-build (probe gate)** | before a *dependent* ticket's worktree is created | the `P-*`/`A-*` probe gates (real-API), recorded under `artifacts/smithering/probes/` |
| **Pre-submit (per ticket, blocks the land)** | on the rebased tip, every time | the ticket's **entire** `verification[]` — every `unit_test` / `integration_test` / `e2e_test` / `eval` / `schema` / `tsc --noEmit` / lint / smoke / secret-scan it owns |
| **Post-submit (on `main`)** | after each land + on an integration cadence | the **same entire suite** again, plus the cross-ticket integration e2es — latency benchmarks (AC10.1/10.2) and durability-restart (AC15.3) are stored as regression baselines, and a `manual_check` (e.g. the §22 A4 human earcon perceptual test) runs here |

**Partition rule = none.** There is no subset to partition: pre-submit == post-submit == the full suite.
The matrix's **AND** (unit *and* e2e) holds trivially because both halves run in both places. A blocking
gate with no failable test — or whose only evidence is "the agent said it's done" — **blocks the land**
(matrix §"How the workflow consumes this").

**Per-ticket mechanics.** Each worker runs its ticket's *entire* `verification[]` block to gate the land,
and the postsubmit pass re-runs it on `main`. RBG recordings for **every** blocking gate are mandatory
before land (§6).

**Today (round-1 §22):** the pre-build probe gate is **holding the pipeline paused**. No Cue-dependent ticket
(`cue-adapter-and-policies`, `routing-*`, …) or hot-loop-LLM-dependent ticket (`intent-gate-semantic-check`,
`suggestion-engine`) may build until **P-ASR-Deepgram (A1.2)**, **A-LLM-SUB (A2.4)**, **P-SEAM (needs the Cue
source build, A3)** and **P-TTS-streaming + human earcon test (A4)** go green. This is the probe gate working
as designed, not a bug.

**Verify (the test logic).**
- *full-suite-both-phases test* — the set of tests run pre-submit equals the set run post-submit equals the
  ticket's full `verification[]`. **RBG:** drop a test from the post-submit pass → equality assertion fails.
- *probe-precedence test* — a ticket whose dependency's blocking probe is unrun/failed is **not scheduled**.
  **RBG:** mark `P-CUE` failed → assert `cue-adapter-and-policies` never starts.
- *Observability:* `gate.pre_build{probe, status}`, `gate.presubmit{ticketId, criterionId, status,
  rbgRecorded}`, `gate.postsubmit{criterionId, status, baseline?}`. Decision doc:
  `test-all-both-phases.html`.

---

## 4. DECISION — modelAssignment

**Decision (ORCH-A-04).** **Fixed roles, not complexity-based.** Every ticket is built with the same model
matrix regardless of complexity:

- **Implementation: ALWAYS Codex 5.5** (OpenAI `gpt-5.5` via the Codex CLI). **Never Opus.**
- **Verification: ALWAYS Sonnet 4.6** (`claude-sonnet-4-6`).
- **Review: BOTH Codex 5.5** (`gpt-5.5`) **AND Opus 4.8** (`claude-opus-4-8`) — two independent reviewers.
- **Planning: Opus 4.8** (`claude-opus-4-8`).

<!-- TODO (aspirational, not yet wired): use Fable (Fable 5, `claude-fable-5`) in the loop once available. -->

**Cross-family principle still holds.** The implementer is **OpenAI/Codex** (`gpt-5.5`); the **Opus 4.8
reviewer is the cross-family Anthropic check** on that OpenAI-implemented code. A model reviewing its own
family's output shares that family's training-correlated blind spots, so the Opus reviewer breaks that
correlation by construction. (The Codex reviewer is the same-family second read; the cross-family invariant
is satisfied by the Opus reviewer, and **the implementer family is OpenAI**, not Anthropic.)

| Role | Model | Notes |
|---|---|---|
| **Implementation** | **Codex 5.5** (`gpt-5.5`, Codex CLI) | Always. Never Opus. |
| **Verification** | **Sonnet 4.6** (`claude-sonnet-4-6`) | Independent test-authority verifier, fresh context. |
| **Review** | **Codex 5.5** (`gpt-5.5`) **and** **Opus 4.8** (`claude-opus-4-8`) | Two reviewers; Opus is the cross-family (Anthropic) check on the OpenAI implementation. |
| **Planning** | **Opus 4.8** (`claude-opus-4-8`) | — |

The **verifier's authority is the test result, never its opinion** — the build-time analog of
ENG-A-04 ("invariants in code, not the LLM"). The Sonnet 4.6 verifier confirms each blocking gate's test was
*capable of failing* (the red run exists and is genuine) and that the green run passes; it does not
re-litigate taste.

**Safety-critical tickets.** No special implementer override — every ticket implements with Codex 5.5. The
Opus 4.8 reviewer (cross-family) plus the Codex 5.5 reviewer cover review; an adversarial `codex challenge`
pass may additionally run where a ticket warrants extra scrutiny.

**Verify (the assignment logic).**
- *fixed-role test* — every ticket's implementer is `gpt-5.5`, its verifier is `claude-sonnet-4-6`, and its
  reviewers are exactly `{gpt-5.5, claude-opus-4-8}`. **RBG:** assign Opus as an implementer → fixed-role
  guard rejects (else fails).
- *cross-family-guard test* — at least one reviewer family ≠ the implementer family (`gpt-5.5` →
  `claude-opus-4-8` satisfies it). **RBG:** drop the Opus reviewer → cross-family assertion fails.
- *verifier-independence test* — the Sonnet verifier is a distinct run/context from the implementer
  (different `runId`, fresh prompt). **RBG:** reuse implementer context → independence assertion fails.
- *review-recorded test* — a land requires both reviewers' `review.json` verdicts **and** `verify.json`
  (passing gate re-run). **RBG:** drop a `review.json` → land refused.
- *Observability:* `model.assign{ticketId, implementer:'gpt-5.5', verifier:'claude-sonnet-4-6',
  reviewers:['gpt-5.5','claude-opus-4-8']}`, `review.verdict{ticketId, model, pass, findings}`. Decision doc:
  `fixed-role-model-assignment.html`.

---

## 5. DECISION — concurrency

**Decision (ORCH-A-05).** **Maximize concurrency — run as many ticket workers as the host allows (cap ~8);
probe phase bursts to the same cap.** Speed is the priority; the cap exists only to stay under the host's
Smithers run-slots, not to throttle for merge serialization (the lane is optimistic, §2).

- The **widest ready-set (antichain)** in the graph is ~7 (wave 2): the contracts/infra fan-out
  (`record-replay-harness`, `provider-interface-doubles`, `trace-processor-observability`) plus the
  independent probes (`probe-cue-substrate`, `probe-smithers-durable-runs`, …). We run the whole antichain
  at once whenever host slots allow.
- Each worker is **heavy**: Codex 5.5 implementer + two reviewers (Codex 5.5 + Opus 4.8) + Sonnet 4.6
  verifier, each running `bun test` / `tsc`, several spawning **real Smithers child runs**. The cap keeps us
  under the host's Smithers run-slots — the build-layer analog of the §10.1 pre-spawn resource check — and
  leaves headroom so the postsubmit live-e2e / latency / durability suite is not starved.
- Because the merge lane is **optimistic** (§2), more in-flight workers do **not** serialize behind a single
  writer — green tickets land as soon as they pass, so concurrency directly buys throughput. Tickets are
  ordered to minimize conflicts (§1) so optimistic re-rebases stay cheap even at the cap.
- **Probes burst to the cap** because they are disjoint-path (write only `poc/` + `probes/`),
  external-API-**latency**-bound rather than CPU-bound, and **do not merge `src/`** — so they cost little
  locally and never churn the lane.

**Verify (the concurrency logic).**
- *antichain-schedule test* — never schedule a ticket whose deps haven't landed; never exceed the host cap.
  **RBG:** raise the cap past host slots with a wide ready-set → over-cap (resource) assertion fires.
- *resource-headroom test* — at the worker cap, the next spawn is **refused** with
  `build.spawn.refused{reason}` (mirrors §10.1). **RBG:** remove the cap check → an over-cap worker starts → fails.
- *Observability:* `build.concurrency{inFlight, cap, readyCount}`, `build.spawn.refused{reason}`. Decision
  doc: `worktree-and-concurrency.html`.

---

## 6. DECISION — observability

**Decision (ORCH-A-06).** **Every ticket persists a fixed evidence bundle under
`artifacts/smithering/build/<ticketId>/`, and every judgment call gets a self-contained HTML decision log
under `artifacts/smithering/decisions/`.** Artifacts on disk are the durable record; the workflow's
structured output is just the index into them. A blocking gate with **no recorded red-before-green = no
land** (matrix §"How the workflow consumes this").

**Per-ticket bundle `artifacts/smithering/build/<ticketId>/`:**

| File / dir | Contents |
|---|---|
| `RESULT.md` | what was built, the gate roll-up, links to dep `RESULT.md`s, surfaced blockers |
| `gates.json` | one row per gate: `{criterionId, method, phase, status, rbgRecorded, testPath, redRunPath, greenRunPath}` — the machine record the merge lane reads |
| `evidence/` | the **RBG recordings** mapped from the matrix "Evidence required" column: per blocking gate a **red** (failing) run + a **green** run, named by criterion, e.g. `AC11.1-rbg-red.log` / `AC11.1-green.log` |
| `tests.log`, `tsc.log` | full `bun test` + typecheck output |
| `review.json` | both reviewers' verdicts (`{reviews:[{model:'gpt-5.5', pass, findings[]}, {model:'claude-opus-4-8', pass, findings[]}]}`) — the Opus verdict is the cross-family check |
| `verify.json` | the independent Sonnet 4.6 verifier's re-run result (`{model:'claude-sonnet-4-6', ranTests, rbgConfirmed, pass}`) |
| `trace/*.jsonl` | structured `LogEvent` JSONL from any e2e the ticket ran (the eng §13 contract), **secret-scanned** |
| `secret-scan.json` | whole-bundle scan result: zero key-shaped strings (SEC-1) |

**Build-level trace.** The orchestrator emits its own structured stream keyed by `ticketId`:
`build.ticket.start/land/bounce`, `merge.*`, `postsubmit.*`, `gate.*`, `model.assign`,
`build.spawn.refused` — so a later agent with **no context** can reconstruct *why any ticket is in its
state* (REQ-16 applied to the build itself). Verb-noun event names; stable ids; **measured** `latencyMs`;
fail-closed secret redaction reused from `secret-redaction`. (No raw provider keys are written anywhere; the
host's logged-in Codex + Claude CLI subscriptions supply model access — see E10.)

**HTML decision logs** (`artifacts/smithering/decisions/build/<slug>.html`, same self-contained template as
the existing ENG-A docs) are written for every genuine judgment call: a postsubmit eviction, a
probe-failure amendment, an **implementer↔reviewer disagreement** (either the Codex 5.5 or the cross-family
Opus 4.8 reviewer) and how it resolved, and a rebase-conflict resolution that changed semantics. Each
records the decision, the alternatives, example inputs/outputs, and a diff where it helps a human review fast.

**Verify (the observability logic).**
- *evidence-completeness test* — a land requires, for each blocking gate, a `redRunPath` **and**
  `greenRunPath` that exist and are non-empty. **RBG:** delete a red run → land refused.
- *build-trace-reconstruction test* — from `build/*` traces alone, rebuild any ticket's
  schedule→implement→review→verify→land chain. **RBG:** drop `ticketId` from a land event → chain breaks.
- *secret-scan test* — the bundle contains zero key-shaped strings. **RBG:** plant a fake `sk-…` in a
  `meta` field → scan fails.

---

## 7. DECISION — contextManagement

**Decision (ORCH-A-07).** **Every worker (implementer, reviewer, verifier) gets fresh context and reads its
inputs from disk** — the build-time mirror of the product's "fresh window, read upstream artifacts from
disk" rule. No worker inherits conversation history; the ticket `id` is the stable durable handle, and a
resumed worker re-reads disk and re-derives state (it never trusts in-memory context — auto-rebase-on-resume
makes this mandatory).

**Each worker prompt MUST carry:**
1. **The ticket object verbatim** from `artifacts/smithering/tickets.json` — `id`, `complexity`,
   `requirementIds`, `dependsOn`, the **full self-contained instructions**, and `verification[]`.
2. **Doc paths to READ FROM DISK** (paths, not summaries): `docs/planning/01-prd.md`, `02-design.md`,
   `03-eng.md` (with the §-anchors the ticket touches), `04-backpressure.md` (the ticket's specific gate
   rows), `05-tickets.md` — plus the relevant `artifacts/smithering/decisions/*.html` and the recorded probe
   verdicts under `artifacts/smithering/probes/`.
3. **The worktree contract** — base commit, branch, worktree path, and the list of **already-landed
   dependency ids with their `RESULT.md` paths**, so the worker reads the *real built interfaces*
   (e.g. `src/types.ts`) instead of re-deriving them.
4. **The exact gate obligations** — its full test suite (§3, run in both phases), the **mandatory RBG
   recording** requirement, and the output paths under `artifacts/smithering/build/<id>/` (§6).
5. **Its model-role contract** — that it is the **Codex 5.5 (`gpt-5.5`) implementer**, and that **two
   reviewers (Codex 5.5 + the cross-family Opus 4.8) and an independent Sonnet 4.6 verifier** will follow (§4).

**A worker must NEVER assume:**
- **…upstream context from conversation** — it reads artifacts from disk (operating rule).
- **…that a probe passed** — it checks the probe's recorded verdict under `artifacts/smithering/probes/`;
  if a blocking probe for its dependency is unrun or failed, it **stops and surfaces a blocker in
  structured output**, it does not build on an unproven API. (This is precisely the paused state today.)
- **…an interface from a sibling ticket that hasn't landed** — only landed deps' real code may be depended
  on.
- **…its own success** — it never invents test results or evidence; "the agent said it's done" is not
  evidence; only a recorded RBG (a test shown capable of failing, then passing) counts.
- **…it may write secrets** — model access comes from the host's logged-in Codex + Claude CLI subscriptions
  (E10); **no raw key** in any artifact, log, trace, or commit.
- **…it may raise a human request** — it never calls ask-human/HumanTask; it **surfaces blockers in
  structured output** and lets the orchestrator's gate talk to the human.

**Verify (the context logic).**
- *prompt-completeness test* — every dispatched worker prompt contains the ticket JSON + the required doc
  paths + the landed-dep `RESULT.md` list. **RBG:** strip the doc paths → completeness assertion fails.
- *probe-halt test* — a worker whose dep's blocking probe is failed/unrun emits a `blocker` structured
  output and writes **no** code. **RBG:** mark the dep probe green-but-actually-unrun → halt assertion
  catches the missing recorded verdict.
- *fresh-context test* — a resumed worker re-reads disk (no reliance on prior in-memory state); a injected
  stale in-memory interface is ignored in favor of the on-disk landed version. **RBG:** feed a stale
  cached interface → assert the on-disk one wins.

---

## 8. Verifying the orchestrator itself (the centerpiece, applied to §1–§7)

The orchestration logic is code, so it is tested like code — each DECISION above ships its own
unit/integration tests with recorded RBG (collected in `src/orchestration/*.test.ts`, gated by
`walking-skeleton-smoke`'s CI). The consolidated invariants a green orchestrator must hold:

| Invariant | Test | RBG move |
|---|---|---|
| DAG is acyclic, refs resolve | `dag-acyclic` | add a back-edge |
| No ticket scheduled before deps land / probes green | `antichain-schedule`, `probe-precedence` | mark a dep unland / a probe failed |
| Max concurrency under host cap, refuse over-cap | `concurrency-cap`, `resource-headroom` | raise cap past host slots |
| Optimistic land, gate-before-land, conflict-bounce, postsubmit eviction | `optimistic-land`, `gate-before-land`, `rebase-conflict-bounce`, `postsubmit-eviction` | force single-writer lock / `rbgRecorded:false` / auto-discard conflict / disable attribution |
| Fixed roles; ≥1 cross-family reviewer; verifier independent | `fixed-role`, `cross-family-guard`, `verifier-independence` | Opus implementer / drop Opus reviewer / reuse context |
| Full suite runs in both phases (pre-submit == post-submit) | `full-suite-both-phases` | drop a test from the post-submit pass |
| No land without recorded RBG red+green | `evidence-completeness` | delete a red run |
| Worker prompt complete; probe-halt; fresh-context | `prompt-completeness`, `probe-halt`, `fresh-context` | strip doc paths / stale cache |
| Zero secrets in the build tree | `secret-scan` | plant a fake key |

Per the bar this is an **AND**: the unit tests above gate the orchestrator's own merges, and an **e2e
dry-run** drives the workflow over a 3-ticket synthetic DAG end-to-end (schedule → worktree → fake
implement (Codex 5.5) → two-model review (Codex 5.5 + Opus 4.8) → Sonnet 4.6 verify → optimistic land →
postsubmit) asserting the full build trace reconstructs — the orchestration analog of the canonical spine.

---

## 9. Decisions log & HTML index

| ID | Decision | Doc |
|---|---|---|
| **ORCH-A-01** | One jj/git worktree per ticket, branched off `main` at the dependency-closure tip; auto-rebase on resume; **order tickets to minimize merge conflicts**; probes write only `poc/`+`probes/` | `worktree-and-concurrency.html` |
| **ORCH-A-02** | **Optimistic merge** — land-then-learn the moment a ticket is green, with **postsubmit auto-eviction** of any land that breaks `main` | `merge-policy-optimistic-eviction.html` |
| **ORCH-A-03** | **No test tiers** — probes gate **pre-build**, then run the **full suite in both pre-submit and post-submit** (assume tests are fast) | `test-all-both-phases.html` |
| **ORCH-A-04** | Fixed roles — **implement Codex 5.5 (`gpt-5.5`)**, **verify Sonnet 4.6**, **review both Codex 5.5 + Opus 4.8** (Opus = cross-family check), **plan Opus 4.8**; Fable 5 is an aspirational TODO | `fixed-role-model-assignment.html` |
| **ORCH-A-05** | **Maximize concurrency** up to the host cap (~8; probes burst the same) — sized to the DAG's ~7-wide antichain and host run-slots, not to a serializer | `worktree-and-concurrency.html` |
| **ORCH-A-06** | Fixed evidence bundle per ticket under `artifacts/smithering/build/<id>/`; HTML decision logs for judgment calls; build-level trace keyed by `ticketId` | (this doc §6) |
| **ORCH-A-07** | Fresh context for every worker; prompt carries ticket JSON + doc paths + landed-dep `RESULT.md`s; never assume probe/sibling/own-success; surface blockers, never raise human | (this doc §7) |
| **ORCH-A-08** | DAG → **13 topological waves** run as `<Parallel>`s on **separate concurrent tracks** (probe / contracts / audio / routing / fleet-safety / observability / harness); critical path = DAG depth (13), not ticket count (37); **never merges to `main`** — lands on the integration branch, a human merges after delivery | (this doc §11) |

---

## 10. Blockers surfaced to the orchestrator's gate (not raised as human requests)

Per the operating rules these are surfaced here and in the structured output, for the gate to take to a
human — never raised by this pass:

1. **The pipeline is PAUSED (round-1 §22).** The remaining blocking probes must clear before the
   orchestration can leave the pre-build phase for any Cue/hot-loop-LLM/seam/TTS path: **P-ASR-Deepgram**,
   **A-LLM-SUB** (cheap/fast hot-loop model via the host's logged-in subscription), **P-SEAM** (needs the
   **Cue source build**), and **P-TTS-streaming + the human earcon perceptual test**. Setup prerequisites:
   install Cue from source (private pnpm monorepo) and launch Panopticon processes via **gateway mode**
   (`smithers up --serve`), not detach.
2. **Safety read-back hook / shell classifier — REMOVED (N-A).** Per the V0 posture (E6/E7/E8) Panopticon
   **runs to completion, dangerously, with no per-action approval gate, no spoken read-back, no dead-man
   timer, no Safe/Explicit/Dangerous modes, and no shell classifier.** The former `probe-pretool-safety-hook`
   (P-HOOK), `safety-execution-boundary-hook`, and `shell-command-classifier` tickets are cut; if safety is
   wanted later we **sandbox the whole process**, not gate via permissions. No build dependency remains here.
3. **A-LLM-SUB hot-loop reachability is open.** Confirm a cheap/fast model meets the ~100 ms hot-loop budget
   through the **host's logged-in Codex/Claude subscriptions** (no raw keys). The cost gate is $0.15/hr (A2.3).
4. **AC6.4 ignored-ambient silence is the requirement (V4).** Ignored ambient speech (`observe.pass` /
   `route.pass`) is **silent** by default — no ack. Earcons remain for explicit state transitions and for
   *addressed* commands. No build dependency.

> The structured output of this pass is the index into the artifacts written here
> (`docs/planning/06-orchestration.md` + the four `decisions/*.html` decision logs); the disk artifacts are
> the durable record.

---

## 11. Wave & track schedule (computed from the DAG — PARALLEL TRACKS ARE MANDATORY)

**Decision (ORCH-A-08).** The build is **NOT a linear ticket-by-ticket chain.** The generated workflow
computes the dependency DAG from each ticket's `dependsOn`, groups tickets into **topological waves**
(`wave(t) = 1 + max(wave of t.dependsOn)`, `wave = 0` for the `dependsOn:[]` roots), and runs **every wave
as a `<Parallel maxConcurrency={N}>` of independent workers** — each ticket in its own git worktree, so
concurrent file writes never collide. Only a real `dependsOn` edge forces sequencing; within a wave,
independent concerns (probe vs. types/contracts vs. audio vs. routing vs. seam/fleet vs. docs) proceed
on **separate concurrent tracks**. The wall-clock critical path is therefore the **DAG depth (the wave
count), not the ticket count**.

> Computed from `artifacts/smithering/tickets.json` (29 V0 tickets after the V0 scope cut — the spotter,
> safety read-back hook, shell classifier, seam gate-correlation, and replay corpus were removed; the DAG is
> acyclic and every `dependsOn` reference resolves — both are asserted at module load, §8 `dag-acyclic`). The
> widest ready-set (antichain) is **~7** at wave 2, which is why the worker cap is ~8 and probe waves burst
> the same (§5). A ticket builds only once **every `dependsOn` ancestor has LANDED** on the integration
> branch; a ticket whose dep failed to land is held out and **surfaced as a blocker** (never silently skipped).

### 11.1 The topological waves

| Wave | Width | Tickets (run concurrently in one `<Parallel>`) |
|---|---|---|
| 0 | 1 | `walking-skeleton-smoke` (the smoke slice; `dependsOn:[]`) |
| 1 | 2 | `shared-types-contract` · `probe-suite-harness` |
| 2 | 5 | `record-replay-harness` · `provider-interface-doubles` · `trace-processor-observability` · `probe-cue-substrate` · `probe-smithers-durable-runs` |
| 3 | 1 | `subscription-credentials-redaction` |
| 4 | 4 | `probe-asr-deepgram` · `probe-hot-loop-llm-subscription` · `probe-streaming-tts` · `probe-cue-smithers-seam` |
| 5 | 3 | `audio-capture-asr-bridge` · `earcons-and-output-policy` · `cue-smithers-seam-dispatcher` |
| 6 | 3 | `cue-adapter-and-policies` · `onboarding-consent-persistence-guard` · `observability-trace-and-board` |
| 7 | 2 | `routing-dispatch-invariants` · `mute-controller` |
| 8 | 3 | `callsigns-and-collision-guard` · `steering-window-lifecycle` · `intent-gate-semantic-check` |
| 9 | 2 | `suggestion-engine` · `process-registry-lifecycle-fleet` |
| 10 | 2 | `acceptance-spawn-flow` · `emergency-stop-control` |
| 11 | 1 | `canonical-spine-and-no-screen-harness` |
| 12 | 2 | `latency-benchmark-suite` · `fleet-concurrency-and-durability-e2e` |

Each wave is a `<Sequence>` of **(a)** a `<Parallel maxConcurrency={N}>` of per-ticket worker subtrees
(Codex 5.5 implement → two-model review (Codex 5.5 + Opus 4.8) → independent Sonnet 4.6 verify, each in its
own `<Worktree>`), then **(b)** an **optimistic land** step. Because the lane is optimistic (§2), green
tickets land as soon as they pass — they are **not** held behind a single serializer — and a postsubmit
break on the integration branch **auto-evicts** the offending land.

### 11.2 The concurrent tracks (independent concerns that advance in parallel)

Within and across waves the DAG decomposes into these **independent tracks** — they share only the
`shared-types-contract` seam and meet only in the merge lane, so they proceed concurrently:

- **Probe track** (disposable worktrees; write **only** `poc/` + `artifacts/smithering/probes/`, never
  `src/`): `probe-suite-harness` → `probe-cue-substrate`, `probe-smithers-durable-runs`,
  `probe-cue-smithers-seam`, `probe-asr-deepgram`, `probe-hot-loop-llm-subscription`,
  `probe-streaming-tts`. These gate their dependents **pre-build** and burst to the host cap.
- **Types/contracts/infra track**: `shared-types-contract` → `record-replay-harness`,
  `provider-interface-doubles`, `trace-processor-observability`, `subscription-credentials-redaction`.
- **Audio track**: `audio-capture-asr-bridge`, `earcons-and-output-policy`, `mute-controller`,
  `onboarding-consent-persistence-guard`.
- **Routing track**: `cue-adapter-and-policies` → `routing-dispatch-invariants` →
  `callsigns-and-collision-guard`, `steering-window-lifecycle`, `intent-gate-semantic-check`.
- **Seam / fleet track**: `cue-smithers-seam-dispatcher`, `process-registry-lifecycle-fleet`,
  `emergency-stop-control`, `suggestion-engine`, `acceptance-spawn-flow`. *(The safety read-back hook and
  shell classifier are cut — V0 runs dangerously; safety, if wanted later, is process sandboxing.)*
- **Observability track**: `observability-trace-and-board`.
- **Integration / e2e harness track** (the convergence point): `canonical-spine-and-no-screen-harness` →
  `latency-benchmark-suite`, `fleet-concurrency-and-durability-e2e`.

### 11.3 Smoke slice

With `input.smoke=true` the workflow processes **only wave 0** — the single `dependsOn:[]` ticket
`walking-skeleton-smoke` — end-to-end **including its verification**, with **NO approval gates**, and
reaches terminal status `finished`. This is the cheapest proof the spine renders, lands on the integration
branch, and the evidence bundle is produced, run by the parent before the expensive full launch.

**Verify (the schedule logic).** `dag-acyclic` (add a back-edge → module-load cycle detector throws) ·
`antichain-schedule` (a ticket whose dep has not landed is held out, never scheduled — `renderBlocked`) ·
`wave-width` (no `<Parallel>` exceeds its cap; probe-only waves use the burst cap) · `critical-path` (the
number of sequential wave barriers equals the DAG depth, not the ticket count). Decision doc:
`worktree-and-concurrency.html` (the wave/track schedule is the concurrency decision applied to the real
DAG).
