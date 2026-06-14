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
> `docs/planning/03-eng.md` (architecture, §8 safety hook, §9 seam, §10 registry, §17 probes, §22 round-1
> probe results, §23 POC findings), `docs/planning/04-backpressure.md` (the 74-gate matrix + tiering
> rules), `docs/planning/05-tickets.md` (28 tickets, the DAG, phases), and the machine copy
> `artifacts/smithering/tickets.json`. POC: `artifacts/smithering/poc/safety-hook-approval-roundtrip/FINDINGS.md`.
>
> **Targets (binding):** repo = `.` · base branch = `main` · VCS = jj co-located with git.
>
> **State of the world (round-1, 2026-06-14):** **the pipeline is PAUSED.** 3 of 4 blocking assumption
> probes failed (§22 of eng); P-SEAM, P-ASR-Deepgram, A-LLM-SUB, P-TTS-streaming are still open. The
> orchestration below is the machine that runs *once those gates clear* — and its pre-build tier (§3) is
> exactly what is holding the line today.

---

## 0. The orchestration model in one breath

The implementation workflow is a **Smithers durable run** that walks the `tickets.json` DAG. For each
ready ticket it cuts a **jj worktree off `main`**, hands a **fresh-context implementer agent** the ticket
JSON + the doc paths to read from disk, requires the ticket's **deterministic gate tier** to pass with
**recorded red-before-green**, runs a **cross-family reviewer** (≠ the implementer's model family) and an
**independent test-authority verifier**, then lands through a **depth-1 serialized merge lane**. Every
ticket persists its evidence under `artifacts/smithering/build/<ticketId>/`, and every judgment call gets
a self-contained HTML decision log under `artifacts/smithering/decisions/`. Probes gate *before* their
dependents are even scheduled; the full real-world suite runs **postsubmit on `main`**.

Seven decisions, each its own section: **worktreeLayout (§1) · mergePolicy (§2) · testTiers (§3) ·
modelAssignment (§4) · concurrency (§5) · observability (§6) · contextManagement (§7)**, plus the
**computed wave & track schedule (§11)** the generated workflow walks.

> **Integration-branch reconciliation (binding override).** Where §1/§2 below say "off `main`" / "land on
> `main`", read **the integration branch** (default `smithering/integration`). **This workflow NEVER merges
> to the base branch `main` — no exceptions.** All work lands on the integration branch, which is the
> build's trunk; worktrees base off it, the depth-1 lane lands onto it, and the postsubmit suite runs on it.
> **Merging the integration branch into `main` is a deliberate human act after delivery**, not something
> this run ever performs. The generated workflow (`.smithers/workflows/smithering-impl.tsx`) hard-guards
> the land step to refuse any target equal to `main`/the base branch.

---

## 1. DECISION — worktreeLayout

**Decision (ORCH-A-01).** **One jj/git worktree per ticket**, co-located in the target repo (`.`), branch
`build/<ticketId>` in worktree `.smithers/wt/<ticketId>`, **branched off the current `main` tip once every
`dependsOn` ancestor has landed**. The stable kebab `id` (the durable Smithers task id) names the worktree —
never an index or timestamp. Smithers worktree runs **auto-rebase on resume**, and jj records rebase
conflicts as first-class state rather than failing silently, so a resumed worker re-reads disk and resolves
the materialized conflict.

| Knob | Choice | Why |
|---|---|---|
| Granularity | per **ticket**, not per phase, not per file | The DAG is expressed per ticket; a worktree per ticket means parallel tickets never share a working copy, so edits only ever meet in the merge lane (§2). |
| Base | `main` at the ticket's dependency-closure tip | A ticket reads the **real, landed** interfaces of its deps (e.g. `src/types.ts` from `shared-types-contract`) instead of re-deriving them. |
| Lifetime | = ticket lifetime; removed after land, or **kept** while it still carries an unresolved jj conflict | Durable: a killed/resumed run finds its worktree exactly as left (REQ-15 ethic applied to the build). |
| Probe worktrees | disposable; write **only** under `poc/` and `artifacts/smithering/probes/` | Disjoint paths → probes parallelize freely and land via a trivial fast lane with no `src/` conflicts. |

**Scheduling rule.** `ready(t)` ⇔ every `t.dependsOn` has **landed on `main`** *and* every blocking probe
`t` depends on is **green** (§3 pre-build tier). The workflow takes ready tickets in topo-rank order up to
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

**Decision (ORCH-A-02).** **A depth-1 serialized merge lane. We do NOT build optimistic merging with
postsubmit auto-eviction in V0.**

The note is the whole point: Smithers' **MergeQueue is only a concurrency limiter**. Optimistic merge +
eviction is *custom* logic — `CheckSuite` (attribute the postsubmit break) + `Saga` (compensate every
dependent that already branched) + `jj revert` (surgical back-out) + cascade re-rebase (where worktree runs
auto-rebase on resume *even if the rebase fails*, materializing conflicts a human/agent must resolve). That
machinery's failure modes (mis-attribution, partial compensation, rebase cascades) threaten **silent work
loss**, which the REQ-15 durability ethic forbids — and it would be built to save a handful of serialized
lands across only ~28 DAG-ordered tickets.

| Mechanism | V0 verdict | Reason |
|---|---|---|
| MergeQueue as a **depth-1 land serializer** | **USE** (pure concurrency limiter) | Exactly its purpose: one writer to `main` at a time, ordered by topo rank. |
| **Pre-merge gate on the rebased tip** | **BUILD** | A ticket re-runs its deterministic tier (§3) *after* rebasing onto the lane tip; green → fast-forward land; jj conflict → **bounce to the worker** (conflict materialized) for a fix-up resume, never a force-land. |
| Optimistic land + **auto-eviction** (CheckSuite + Saga + jj revert + cascade) | **DO NOT BUILD** | Low merge contention (DAG-serialized), high custom-logic risk, silent-loss failure modes. |
| **Postsubmit full suite on `main`** | **RUN — manual revert on failure** | After each land the full matrix (§3) runs; a red postsubmit opens a **recorded revert-or-forward-fix decision** (`decisions/build/<slug>.html`) resolved at the orchestrator's gate — `jj revert` is the back-out, applied deliberately, not autonomously. |

Because every land is **already pre-merge-green with recorded RBG**, postsubmit failures are expected to be
rare, so a manual revert lane is adequate and far cheaper than an evictor.

**Verify (the merge logic).**
- *lane-serialization test* — two concurrent lands → exactly one holds the write lock; the second rebases
  onto the first. **RBG:** set lane depth 2 → interleave detector fails.
- *gate-before-land test* — a ticket with a failing/absent pre-merge gate **or no recorded RBG** cannot
  enter the lane. **RBG:** stub `rbgRecorded:false` → land refused; supply both red+green logs → allowed.
- *rebase-conflict-bounce test* — a forced jj conflict returns the ticket to its worker (not force-landed).
  **RBG:** auto-resolve-by-discard → conflict-bounce assertion fails.
- *postsubmit-revert test* — an injected `main` failure writes a revert-or-forward-fix decision log and
  fires **no** autonomous eviction.
- *Observability:* `merge.lane.enqueue{ticketId, rank}`, `merge.lane.land{ticketId, ff:bool}`,
  `merge.lane.bounce{ticketId, reason:'conflict'|'gate'}`, `postsubmit.fail{ticketId, gate}`. Decision doc:
  `merge-policy-serialized-lane.html`.

---

## 3. DECISION — testTiers

**Decision (ORCH-A-03).** **Three tiers. A deterministic, hermetic subset gates the merge; the full
real-world suite runs postsubmit; probes gate before build.** An agent may gate a land on the optimistic
subset **only because** postsubmit runs *everything* — nothing is permanently skipped.

| Tier | When | Matrix methods (from `04-backpressure.md`) |
|---|---|---|
| **Pre-build (probe gate)** | before a *dependent* ticket's worktree is created | the 13 `P-*`/`A-*` probe gates (real-API), recorded under `artifacts/smithering/probes/` |
| **Pre-merge (per ticket, blocks the land)** | on the rebased lane tip, every time | `unit_test` · `integration_test` · `schema` · `tsc --noEmit` · the `walking-skeleton-smoke` smoke · architecture lint · the secret-redaction unit test · **hermetic replay-driven e2e** (doubles only — no net/mic/keys, temp-0) |
| **Postsubmit (on `main`, full suite)** | after each land + on an integration cadence | **every** pre-merge check **plus** live `e2e_test` (real stack) · `eval` (corpus recall/FP, AC3.4) · latency **benchmarks** as regression baselines (AC10.1/10.2) · durability-restart (AC15.3) · no-screen harness (AC5.1) · whole-session live secret-scan (SEC-1) · `manual_check` (e.g. the §22 A4 human earcon perceptual test) |

**Partition rule = matrix rule 2 ("cheapest method that actually proves it").**
- A **deterministic invariant / logic / contract** is honestly provable by a headless `bun test` → it sits
  **pre-merge** (priority ladder, dispatch invariant, 15-word guard, collision guard, trace schema, the
  shell classifier, hook-intercept on doubles).
- A **real-world property** (measured latency, recall on the corpus, durability across a real restart,
  hands-free no-screen, real third-party behavior) cannot be proven by a mock → it sits
  **postsubmit / pre-build**.
- The matrix's **AND** is preserved *across tiers*: the unit half gates the merge, the e2e half gates the
  integration. Deleting either tier must still leave us fairly confident — the bar holds.

**Per-ticket mechanics.** Each worker runs its ticket's *entire* `verification[]` block locally (the worker
must); the **merge gate enforces only the pre-merge subset** for speed, with the postsubmit backstop
guaranteeing the rest. RBG recordings for **every** pre-merge blocking gate are mandatory before land
(§6). A blocking gate with no failable test — or whose only evidence is "the agent said it's done" —
**blocks merge** (matrix §"How the workflow consumes this").

**Today (round-1 §22):** the pre-build tier is **holding the pipeline paused**. No Cue-dependent ticket
(`cue-adapter-and-policies`, `routing-*`, …) or hot-loop-LLM-dependent ticket (`intent-gate-semantic-check`,
`suggestion-engine`) may enter pre-merge until **P-ASR-Deepgram (A1.2)**, **A-LLM-SUB / Haiku-via-subscription
(A2.4)**, **P-SEAM (needs the Cue source build, A3)** and **P-TTS-streaming + human earcon test (A4)** go
green. This is the tier system working as designed, not a bug.

**Verify (the tiering logic).**
- *tier-coverage test* — every blocking matrix row is assigned to exactly one tier; `pre-merge ∪ postsubmit
  = full blocking set`. **RBG:** drop a row from both → coverage hole → fails.
- *no-skip test* — `postsubmit ⊇ pre-merge`. **RBG:** remove a pre-merge check from postsubmit → superset
  assertion fails.
- *probe-precedence test* — a ticket whose dependency's blocking probe is unrun/failed is **not scheduled**.
  **RBG:** mark `P-CUE` failed → assert `cue-adapter-and-policies` never starts.
- *Observability:* `gate.pre_build{probe, status}`, `gate.pre_merge{ticketId, criterionId, status,
  rbgRecorded}`, `gate.postsubmit{criterionId, status, baseline?}`. Decision doc:
  `test-tiers-presubmit-postsubmit.html`.

---

## 4. DECISION — modelAssignment

**Decision (ORCH-A-04).** **Implement with Anthropic, review with OpenAI (cross-family), verify by test.**
The hard rule — **the reviewing model family ≠ the implementing model family** — is made a *structural
invariant*, enforced at assignment time. A model reviewing its own family's output shares that family's
training-correlated blind spots; family-divergence is the cheapest way to break that correlation.

**The two families.** Anthropic = Opus 4.8 (`claude-opus-4-8`), Sonnet 4.6 (`claude-sonnet-4-6`),
Haiku 4.5 (`claude-haiku-4-5-20251001`) — Fable 5 only *if enabled* (R-ENG-09). OpenAI = GPT-5.4 via the
Codex CLI (`codex review` / `codex challenge`). Default direction: **implement Claude, review Codex**; the
invariant is symmetric (a Codex-implemented ticket is reviewed by Claude) but the default fleet implements
Anthropic and reviews OpenAI.

| Complexity | Implementer (Anthropic) | Reviewer (OpenAI — cross-family) | Verifier (test-authority, fresh context) |
|---|---|---|---|
| **small** | Sonnet 4.6 | Codex GPT-5.4 (`codex review`) | gate suite + Haiku 4.5 RBG-evidence audit |
| **medium** | Sonnet 4.6 (Opus for tricky) | Codex GPT-5.4 (`codex review`) | independent Opus 4.8 agent re-runs the gate tier + confirms recorded RBG |
| **large** | Opus 4.8 | Codex GPT-5.4 (`codex review` + `challenge`) | third fresh-context agent (≠ implementer instance) executes the full `verification[]` + audits every RBG red run |

The **verifier's authority is the test result, never its opinion** — the build-time analog of
ENG-A-04 ("invariants in code, not the LLM"). It confirms each blocking gate's test was *capable of
failing* (the red run exists and is genuine) and that the green run passes; it does not re-litigate taste.

**Safety-critical tickets.** `safety-execution-boundary-hook` and `shell-command-classifier` implement with
**Opus 4.8** and additionally get an **adversarial red-team pass from the reviewer family** (Codex
`challenge` against the read-safe allowlist — the §8.1.1 / FINDINGS RBG table). Product-runtime constraint
(POC FINDING-1): the **shipped** safety processes must run on `ClaudeCodeAgent` (the PreToolUse hook is a
Claude Code CLI `settings.json` mechanism, *not* a Smithers API). That constrains the *product's* agent,
not the *build's* reviewer — cross-family review of the implementing code still applies.

**Verify (the assignment logic).**
- *cross-family-guard test* — for every assignment `reviewer.family !== implementer.family`. **RBG:** assign
  a Sonnet reviewer to an Opus implementer → guard rejects (else fails).
- *verifier-independence test* — the verifier is a distinct run/context from the implementer (different
  `runId`, fresh prompt). **RBG:** reuse implementer context → independence assertion fails.
- *review-recorded test* — a land requires `review.json` (cross-family verdict) **and** `verify.json`
  (passing gate re-run). **RBG:** drop `review.json` → land refused.
- *Observability:* `model.assign{ticketId, implementer, implFamily, reviewer, revFamily, verifier}`,
  `review.verdict{ticketId, family, pass, findings}`. Decision doc: `cross-family-model-assignment.html`.

---

## 5. DECISION — concurrency

**Decision (ORCH-A-05).** **Max 6 concurrent ticket workers; merge lane depth 1; probe phase may burst to
8.** Sized to the DAG's real width, not a round number.

- The **widest ready-set (antichain)** in the graph is ~6: Phase-0's fan-out is ~4
  (`record-replay-harness`, `provider-interface-doubles`, `trace-processor-observability`,
  `probe-suite-harness`), and Phase-1's independent probes are ~6 (`probe-cue-substrate`,
  `probe-asr-deepgram`, `probe-hot-loop-llm-subscription`, `probe-streaming-tts`,
  `probe-smithers-durable-runs`, `probe-keyword-spotter`). Past those, the DAG narrows. A cap above 6 buys
  idle workers, not throughput.
- Each worker is **heavy**: implementer + cross-family reviewer + verifier, each running `bun test` /
  `tsc`, several spawning **real Smithers child runs**. Capping at 6 keeps us under the host's Smithers
  run-slots — the build-layer analog of the §10.1 pre-spawn resource check — and leaves headroom so the
  postsubmit live-e2e / latency / durability suite is not starved.
- The merge lane is **depth-1**, so more than ~6 in-flight only multiplies rebase churn (every land
  invalidates the others' base). Six matches worker throughput to the lane's drain rate.
- **Probes burst to 8** because they are disjoint-path (write only `poc/` + `probes/`), external-API-**latency**-bound
  rather than CPU-bound, and **do not merge `src/`** — so they cost little locally and never churn the lane.

**Verify (the concurrency logic).**
- *antichain-schedule test* — never schedule a ticket whose deps haven't landed; never exceed 6 in-flight
  (8 for probes). **RBG:** raise the cap to 99 with a 7-wide ready-set → over-cap assertion fires.
- *resource-headroom test* — at the worker cap, a 7th spawn is **refused** with `build.spawn.refused{reason}`
  (mirrors §10.1). **RBG:** remove the cap check → a 7th worker starts → fails.
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
| `gates.json` | one row per gate: `{criterionId, method, tier, status, rbgRecorded, testPath, redRunPath, greenRunPath}` — the machine record the merge lane reads |
| `evidence/` | the **RBG recordings** mapped from the matrix "Evidence required" column: per blocking gate a **red** (failing) run + a **green** run, named by criterion, e.g. `AC11.1-rbg-red.log` / `AC11.1-green.log` |
| `tests.log`, `tsc.log` | full `bun test` + typecheck output |
| `review.json` | cross-family reviewer verdict (`{family, model, pass, findings[]}`) |
| `verify.json` | the independent verifier's re-run result (`{ranTests, rbgConfirmed, pass}`) |
| `trace/*.jsonl` | structured `LogEvent` JSONL from any e2e the ticket ran (the eng §13 contract), **secret-scanned** |
| `secret-scan.json` | whole-bundle scan result: zero key-shaped strings (SEC-1) |

**Build-level trace.** The orchestrator emits its own structured stream keyed by `ticketId`:
`build.ticket.start/land/bounce`, `merge.lane.*`, `gate.*`, `model.assign`, `build.spawn.refused` — so a
later agent with **no context** can reconstruct *why any ticket is in its state* (REQ-16 applied to the
build itself). Verb-noun event names; stable ids; **measured** `latencyMs`; fail-closed secret redaction
reused from `subscription-credentials-redaction`.

**HTML decision logs** (`artifacts/smithering/decisions/build/<slug>.html`, same self-contained template as
the existing ENG-A docs) are written for every genuine judgment call: a postsubmit revert-vs-forward-fix,
a probe-failure amendment, an **implementer↔cross-family-reviewer disagreement** and how it resolved, an
optimistic-subset deviation, a rebase-conflict resolution that changed semantics. Each records the
decision, the alternatives, example inputs/outputs, and a diff where it helps a human review fast.

**Verify (the observability logic).**
- *evidence-completeness test* — a land requires, for each pre-merge blocking gate, a `redRunPath` **and**
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
   rows), `05-tickets.md` — plus the relevant `artifacts/smithering/decisions/*.html`, the recorded probe
   verdicts under `artifacts/smithering/probes/`, and `…/poc/safety-hook-approval-roundtrip/FINDINGS.md`
   whenever the ticket touches the safety hook.
3. **The worktree contract** — base commit, branch, worktree path, and the list of **already-landed
   dependency ids with their `RESULT.md` paths**, so the worker reads the *real built interfaces*
   (e.g. `src/types.ts`) instead of re-deriving them.
4. **The exact gate obligations** — its pre-merge tier (§3), the **mandatory RBG recording** requirement,
   and the output paths under `artifacts/smithering/build/<id>/` (§6).
5. **Its model-role contract** — that it is the implementer, and that a **cross-family reviewer + independent
   verifier** will follow (§4).

**A worker must NEVER assume:**
- **…upstream context from conversation** — it reads artifacts from disk (operating rule).
- **…that a probe passed** — it checks the probe's recorded verdict under `artifacts/smithering/probes/`;
  if a blocking probe for its dependency is unrun or failed, it **stops and surfaces a blocker in
  structured output**, it does not build on an unproven API. (This is precisely the paused state today.)
- **…an interface from a sibling ticket that hasn't landed** — only landed deps' real code may be depended
  on.
- **…its own success** — it never invents test results or evidence; "the agent said it's done" is not
  evidence; only a recorded RBG (a test shown capable of failing, then passing) counts.
- **…it may write secrets** — credentials come only via `SubscriptionCredentialProvider`; no raw key in any
  artifact, log, trace, or commit.
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
| ≤6 workers (8 probes), refuse the 7th | `concurrency-cap`, `resource-headroom` | raise cap to 99 |
| Depth-1 lane, gate-before-land, conflict-bounce | `lane-serialization`, `gate-before-land`, `rebase-conflict-bounce` | lane depth 2 / `rbgRecorded:false` / auto-discard conflict |
| `reviewer.family ≠ implementer.family`; verifier independent | `cross-family-guard`, `verifier-independence` | same-family reviewer / reuse context |
| `postsubmit ⊇ pre-merge`; full tier coverage | `no-skip`, `tier-coverage` | drop a row from postsubmit |
| No land without recorded RBG red+green | `evidence-completeness` | delete a red run |
| Worker prompt complete; probe-halt; fresh-context | `prompt-completeness`, `probe-halt`, `fresh-context` | strip doc paths / stale cache |
| Zero secrets in the build tree | `secret-scan` | plant a fake key |

Per the bar this is an **AND**: the unit tests above gate the orchestrator's own merges, and an **e2e
dry-run** drives the workflow over a 3-ticket synthetic DAG end-to-end (schedule → worktree → fake
implement → cross-family review → verify → serialized land → postsubmit) asserting the full build trace
reconstructs — the orchestration analog of the canonical spine.

---

## 9. Decisions log & HTML index

| ID | Decision | Doc |
|---|---|---|
| **ORCH-A-01** | One jj/git worktree per ticket, branched off `main` at the dependency-closure tip; auto-rebase on resume; probes write only `poc/`+`probes/` | `worktree-and-concurrency.html` |
| **ORCH-A-02** | Depth-1 **serialized merge lane**; pre-merge gate on the rebased tip; **no** optimistic merge / auto-eviction in V0; manual revert on postsubmit failure | `merge-policy-serialized-lane.html` |
| **ORCH-A-03** | Three tiers — probes **pre-build**, deterministic hermetic subset **pre-merge**, full real-world suite **postsubmit** (`postsubmit ⊇ pre-merge`) | `test-tiers-presubmit-postsubmit.html` |
| **ORCH-A-04** | Implement Anthropic, **review cross-family with OpenAI/Codex**, verify by test; safety tickets get an adversarial Codex `challenge` | `cross-family-model-assignment.html` |
| **ORCH-A-05** | Max **6** ticket workers (probes burst 8), merge lane depth 1 — sized to the DAG's ~6-wide antichain and host run-slots | `worktree-and-concurrency.html` |
| **ORCH-A-06** | Fixed evidence bundle per ticket under `artifacts/smithering/build/<id>/`; HTML decision logs for judgment calls; build-level trace keyed by `ticketId` | (this doc §6) |
| **ORCH-A-07** | Fresh context for every worker; prompt carries ticket JSON + doc paths + landed-dep `RESULT.md`s; never assume probe/sibling/own-success; surface blockers, never raise human | (this doc §7) |
| **ORCH-A-08** | DAG → **13 topological waves** run as `<Parallel>`s on **separate concurrent tracks** (probe / contracts / audio / routing / fleet-safety / observability / harness); critical path = DAG depth (13), not ticket count (37); **never merges to `main`** — lands on the integration branch, a human merges after delivery | (this doc §11) |

---

## 10. Blockers surfaced to the orchestrator's gate (not raised as human requests)

Per the operating rules these are surfaced here and in the structured output, for the gate to take to a
human — never raised by this pass:

1. **The pipeline is PAUSED (round-1 §22).** 3 of 4 blocking probes failed. The orchestration cannot leave
   the pre-build tier for any Cue/hot-loop-LLM/seam/TTS path until **P-ASR-Deepgram**, **A-LLM-SUB**
   (Haiku-4.5-via-subscription), **P-SEAM** (needs the **Cue source build**), and **P-TTS-streaming + the
   human earcon perceptual test** go green. Setup prerequisites: install Cue from source (private pnpm
   monorepo) and launch Panopticon processes via **gateway mode** (`smithers up --serve`), not detach.
2. **P-HOOK is UNRUN and the safety guarantee depends on it** (POC FINDING-1). The PreToolUse hook is a
   **Claude Code CLI `settings.json`** mechanism, not a Smithers API → all safety-gated *product* processes
   are constrained to `ClaudeCodeAgent`, and the hook `timeoutMs` must be set **> 25 s** with
   `onFailure:"block"` (fail-closed) (FINDING-2). `safety-execution-boundary-hook` must not enter pre-merge
   until `probe-pretool-safety-hook` is green.
3. **A-LLM-SUB / PRD-§6 conflict is open (R-ENG-12).** If no subscription-routable model meets the ~100 ms
   hot-loop budget, this is a binding PRD-§6 conflict (raw keys forbidden) for the gate to resolve — amend
   §6 with secure credential handling or accept a slower compliant model. The cost gate is $0.15/hr (A2.3).
4. **AC6.4 ambient-pass silence (R-ENG-10)** remains a *recommended-not-required* PRD amendment; the build
   is AC6.4-compliant by default (four distinct acks). No build dependency.

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
independent concerns (probe vs. types/contracts vs. audio vs. routing vs. safety/fleet vs. docs) proceed
on **separate concurrent tracks**. The wall-clock critical path is therefore the **DAG depth (13 waves),
not the ticket count (37)**.

> Computed from `artifacts/smithering/tickets.json` (37 V0 tickets; the DAG is acyclic and every
> `dependsOn` reference resolves — both are asserted at module load, §8 `dag-acyclic`). The widest
> ready-set (antichain) is **7** at wave 2, which is why the worker cap is 6 with probe waves bursting to 8
> (§5). A ticket builds only once **every `dependsOn` ancestor has LANDED** on the integration branch; a
> ticket whose dep failed to land is held out and **surfaced as a blocker** (never silently skipped).

### 11.1 The 13 topological waves

| Wave | Width | Tickets (run concurrently in one `<Parallel>`) |
|---|---|---|
| 0 | 1 | `walking-skeleton-smoke` (the smoke slice; `dependsOn:[]`) |
| 1 | 2 | `shared-types-contract` · `probe-suite-harness` |
| 2 | 7 | `record-replay-harness` · `provider-interface-doubles` · `trace-processor-observability` · `shell-command-classifier` · `probe-cue-substrate` · `probe-smithers-durable-runs` · `probe-keyword-spotter` |
| 3 | 4 | `subscription-credentials-redaction` · `replay-corpus-contract` · `probe-pretool-safety-hook` · `probe-cue-smithers-seam` |
| 4 | 4 | `probe-asr-deepgram` · `probe-hot-loop-llm-subscription` · `probe-streaming-tts` · `seam-gate-correlation` |
| 5 | 3 | `audio-capture-asr-bridge` · `earcons-and-output-policy` · `cue-smithers-seam-dispatcher` |
| 6 | 5 | `cue-adapter-and-policies` · `mute-controller-and-spotter` · `safety-execution-boundary-hook` · `onboarding-consent-persistence-guard` · `observability-trace-and-board` |
| 7 | 1 | `routing-dispatch-invariants` |
| 8 | 3 | `callsigns-and-collision-guard` · `steering-window-lifecycle` · `intent-gate-semantic-check` |
| 9 | 2 | `suggestion-engine` · `process-registry-lifecycle-fleet` |
| 10 | 2 | `acceptance-spawn-flow` · `emergency-stop-control` |
| 11 | 1 | `canonical-spine-and-no-screen-harness` |
| 12 | 2 | `latency-benchmark-suite` · `fleet-concurrency-and-durability-e2e` |

Each wave is a `<Sequence>` of **(a)** a `<Parallel maxConcurrency={N}>` of per-ticket worker subtrees
(implement → cross-family review[+challenge] → independent verify, each in its own `<Worktree>`), then
**(b)** a `<MergeQueue maxConcurrency={1}>` land lane. Because the waves themselves run in DAG order, the
depth-1 lane is **globally serialized**: at most one writer touches the integration branch at a time,
ordered by topo rank (§2).

### 11.2 The concurrent tracks (independent concerns that advance in parallel)

Within and across waves the DAG decomposes into these **independent tracks** — they share only the
`shared-types-contract` seam and meet only in the merge lane, so they proceed concurrently:

- **Probe track** (disposable worktrees; write **only** `poc/` + `artifacts/smithering/probes/`, never
  `src/`): `probe-suite-harness` → `probe-cue-substrate`, `probe-smithers-durable-runs`,
  `probe-keyword-spotter`, `probe-pretool-safety-hook`, `probe-cue-smithers-seam`, `probe-asr-deepgram`,
  `probe-hot-loop-llm-subscription`, `probe-streaming-tts`, `seam-gate-correlation`. These gate their
  dependents **pre-build** and burst to concurrency 8.
- **Types/contracts/infra track**: `shared-types-contract` → `record-replay-harness`,
  `provider-interface-doubles`, `trace-processor-observability`, `subscription-credentials-redaction`,
  `replay-corpus-contract`, `shell-command-classifier`.
- **Audio track**: `audio-capture-asr-bridge`, `earcons-and-output-policy`, `mute-controller-and-spotter`,
  `onboarding-consent-persistence-guard`.
- **Routing track**: `cue-adapter-and-policies` → `routing-dispatch-invariants` →
  `callsigns-and-collision-guard`, `steering-window-lifecycle`, `intent-gate-semantic-check`.
- **Seam / fleet / safety track**: `cue-smithers-seam-dispatcher`, `safety-execution-boundary-hook`,
  `process-registry-lifecycle-fleet`, `emergency-stop-control`, `suggestion-engine`, `acceptance-spawn-flow`.
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
number of sequential wave barriers equals the DAG depth, 13, not 37). Decision doc:
`worktree-and-concurrency.html` (the wave/track schedule is the concurrency decision applied to the real
DAG).
