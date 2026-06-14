# Panopticon — Ticket Breakdown (V0)

> **Audio-only. Voice is the sole operational modality.** This document breaks the V0 implementation
> into **measurable, verifiable tickets**. Each ticket has a STABLE kebab-case id (it becomes a durable
> Smithers task id — never an index/timestamp), self-contained instructions for a fresh-context agent,
> `requirementIds` tracing to the PRD, a `verification[]` mix (command/e2e/agent-review) drawn from the
> backpressure matrix, `dependsOn[]`, and a complexity.
>
> **Upstream (read from disk, not assumed):** `docs/planning/01-prd.md` (REQ-1..16, D1–D6, §6 probes),
> `docs/planning/02-design.md` (D-DD-01..25, §11 probe surface, §13 matrix), `docs/planning/03-eng.md`
> (architecture, §17 probes, §18 traceability, **§22 round-1 probe results & amendments**),
> `docs/planning/04-backpressure.md` (the per-criterion gate matrix the verification entries are drawn
> from). Machine copy the implementation workflow imports: `artifacts/smithering/tickets.json`.
>
> **Validation is the centerpiece, not an afterthought.** Every ticket enumerates CONCRETE
> unit/integration command tests **AND** e2e tests (it is an AND — either layer alone should leave us
> fairly confident), plus agent-review entries for what only a smart agent can judge. Every test names
> the **red-before-green** failure injection that proves it can fail; "the agent said it's done" is
> never evidence. Third-party APIs are validated against the REAL library by a probe before any code is
> built on them. Every component emits structured, traceable observability.

---

## How this breakdown is ordered

- **Ticket 1 (`walking-skeleton-smoke`) is the cheapest end-to-end slice and becomes the repo smoke
  test.** It runs headless on in-process doubles (no Cue, no network, no mic, no keys): one recorded
  transcript JSONL → a deterministic match → one structured trace line. It legitimately precedes the
  P-CUE "first build task" gate because it imports no third-party surface.
- **`probe-cue-substrate` (P-CUE) is the first *third-party* build task** and the P0 blocker: confirm
  the Cue repo is accessible, build it from source, and prove the policy/`observe.pass`/two-`Program`/
  `MappedActionTool`/provider-slot surface (plus the ≤300 ms `TextCue` latency assertion) against the
  real library. Nothing Cue-dependent is built until it is green.
- **Validate-before-build probes gate the code that depends on them.** P-CUE, P-HOOK, P-ASR, P-TTS,
  P-LLM/A-LLM-SUB, P-SMITHERS, P-SEAM, **P-SPOTTER**, **P-SHELL-PARSE** are blocking; P-BUN-NATIVE,
  P-PHONETIC, P-OTEL are warning/informational (folded into their consuming tickets).
- The dependency graph is a **DAG** (verified acyclic): foundations → probes → Cue adapter + ASR
  bridge → routing/vocabulary/intent-gate → audio output + mute → suggestion + acceptance + seam →
  safety + registry/fleet → emergency/onboarding/observability → the canonical spine → latency +
  fleet/durability e2e.

### The §22 round-1 probe learnings, folded into tickets

The round-1 assumption probes ran (2026-06-14); 3 of 4 blocking probes failed and the pipeline is
paused pending human approval of the amendments. Those amendments are first-class ticket content:

| §22 learning | Where it lives |
|---|---|
| Keyword-only `TextCue` is insufficient (80% context FP, 53% natural false-accept) → add a cheap-LLM **intent gate** + whole-utterance pre-filter between keyword and action | `intent-gate-semantic-check` (consumed by `suggestion-engine`, `acceptance-spawn-flow`) |
| Drop the NATO-subset callsigns (`alpha/bravo/charlie/delta/echo` occur in dev speech) → **coined multi-syllable** callsigns | `callsigns-and-collision-guard` |
| Cue has **no built-in Deepgram provider** → build the audio-capture → ASR → Cue WebSocket bridge (ENG-T-10, new scope) | `audio-capture-asr-bridge` |
| Real-time steering needs **gateway mode** (`smithers up --serve`), not detach; call the gateway signal API, not the CLI; install Cue from source | `probe-smithers-durable-runs`, `cue-smithers-seam-dispatcher`, `probe-cue-substrate` |
| Diarization unverified (no `DEEPGRAM_API_KEY`) → re-run P-ASR against Deepgram Nova-3; VAD-only fallback if unavailable | `probe-asr-deepgram` |
| Cerebras meets latency but **A-LLM-SUB still open** (Haiku-via-subscription untested, zero credits); raise cost gate $0.10 → $0.15/hr; ACT-prompt fix | `probe-hot-loop-llm-subscription` |
| TTS 1.27 s was a `say` artifact → measure streaming time-to-first-chunk; **pre-cache** the 5 fixed phrases; redesign E4/E5 earcons (ZCR-CV < 0.15); human perceptual test | `probe-streaming-tts`, `earcons-and-output-policy` |
| P-SPOTTER raised to **blocking** (voice-unmute is the sole operational unmute); P-SHELL-PARSE, A-LLM-SUB blocking | `probe-keyword-spotter`, `shell-command-classifier`, `probe-hot-loop-llm-subscription` |

---

## Build phases (topologically ordered)

**Phase 0 — Foundations (headless, no third-party).**
`walking-skeleton-smoke` → `shared-types-contract` → `record-replay-harness`, `provider-interface-doubles`,
`trace-processor-observability` → `subscription-credentials-redaction`; `probe-suite-harness`.

**Phase 1 — Validate-before-build probes (gates).**
`probe-cue-substrate` (P0, first build task), `probe-asr-deepgram`, `probe-hot-loop-llm-subscription`,
`probe-streaming-tts`, `probe-smithers-durable-runs` → `probe-pretool-safety-hook` → `seam-gate-correlation`,
`probe-cue-smithers-seam`, `probe-keyword-spotter`.

**Phase 2 — Cue substrate & audio ingress.**
`audio-capture-asr-bridge` → `cue-adapter-and-policies`.

**Phase 3 — Routing, vocabulary, intent gate.**
`routing-dispatch-invariants` → `callsigns-and-collision-guard`, `steering-window-lifecycle`,
`intent-gate-semantic-check`.

**Phase 4 — Audio output & mute.**
`earcons-and-output-policy` → `mute-controller-and-spotter`.

**Phase 5 — Suggestion, corpus, seam, acceptance.**
`replay-corpus-contract` → `suggestion-engine`; `cue-smithers-seam-dispatcher` → `acceptance-spawn-flow`.

**Phase 6 — Safety, registry, fleet.**
`shell-command-classifier` → `safety-execution-boundary-hook`; `process-registry-lifecycle-fleet` →
`emergency-stop-control`.

**Phase 7 — Onboarding, observability, the spine, acceptance e2es.**
`onboarding-consent-persistence-guard`, `observability-trace-and-board`,
`canonical-spine-and-no-screen-harness` → `latency-benchmark-suite`,
`fleet-concurrency-and-durability-e2e`.

---

## Tickets

Each ticket below lists `id` · complexity · `requirementIds` · `dependsOn`, a short intent, and its
verification mix. Full self-contained instructions live in `artifacts/smithering/tickets.json`.

### Foundations

#### `walking-skeleton-smoke` — *medium* — REQ-5, REQ-16, engineering-only — depends on: —
The cheapest end-to-end slice; **the smoke test**. Bun/Hono scaffold + CI (`bun test`, `tsc --noEmit`),
stub `src/types.ts`, a minimal replay reader, a deterministic wake matcher, a minimal `TraceProcessor`,
and one headless test that drives a 2-line transcript fixture to exactly one structured trace line.
*Verify:* command (smoke test, RBG = break the matcher), command (`bun test`+`tsc` CI gate, RBG = type
error), agent-review (true walking skeleton, doubles only).

#### `shared-types-contract` — *small* — engineering-only — depends on: `walking-skeleton-smoke`
Full ENG-T-01 `src/types.ts` per eng §1.3 (all 14 interfaces/types + zod mirrors). *Verify:* command
(type-roundtrip + schema-presence, RBG = drop `correlationId`), agent-review (completeness vs §1.3).

#### `record-replay-harness` — *medium* — engineering-only — depends on: `shared-types-contract`
ENG-T-02 — `src/replay/harness.ts`: JSONL → temp-0 decision loop → hashed, deterministic replay; assert
shape/invariants, never exact text. *Verify:* command (determinism, RBG = inject nondeterminism),
command (invariant helpers), agent-review (single seam over the AI surface).

#### `provider-interface-doubles` — *small* — engineering-only, REQ-1, REQ-10 — depends on: `shared-types-contract`
ENG-T-04 — typed provider boundary (`ASRProvider`/`TTSProvider`/`DecisionLLM`/`KeywordSpotter`) +
replay/noop doubles + architecture lint. *Verify:* command (boundary-substitution + conformance, RBG =
concrete import), agent-review (`Detection|null` scope fence).

#### `trace-processor-observability` — *medium* — REQ-16, engineering-only — depends on: `shared-types-contract`
ENG-T-03 — `src/obs/trace.ts` pipeline stage; verb-noun `LogEvent`, stable ids, measured `latencyMs`,
correlationId chain query, redaction seam. *Verify:* command (trace-schema + causal-chain + pass-logging,
RBG = drop `correlationId`), command (roundtrip), agent-review (no-context reconstruction).

#### `subscription-credentials-redaction` — *medium* — SEC-1, REQ-16, engineering-only — depends on: `shared-types-contract`, `trace-processor-observability`
ENG-T-09 — `SubscriptionCredentialProvider` (the one credential path; raw key rejected) + fail-closed
redaction filter. *Verify:* command (subscription-path + secret-redaction, RBG = disable filter), e2e
(whole-session secret-scan, RBG = plant a key), agent-review (one path, fail-closed).

#### `probe-suite-harness` — *small* — engineering-only — depends on: `walking-skeleton-smoke`
ENG-T-05 — `poc/` harness: real-API probe runner, RBG recording, report writer, secret-scan. *Verify:*
command (sample probe writes report + RBG, refuses non-failable assertions), agent-review (failures
surfaced, not swallowed).

### Validate-before-build probes

#### `probe-cue-substrate` — *large* — REQ-1/3/5/6/7 — depends on: `probe-suite-harness`
**P-CUE (P0 blocker, first third-party build task).** Confirm repo access, build Cue from source,
exercise every §11.1 primitive + the ≤300 ms `TextCue` latency assertion; record the WebSocket
transcription ingress shape (no built-in Deepgram provider). *Verify:* command (each §11.1 row failable),
command (TextCue-latency, RBG = 50 ms budget), agent-review (repo access + fallback verdict).

#### `probe-asr-deepgram` — *medium* — REQ-1, REQ-10 — depends on: `probe-suite-harness`, `subscription-credentials-redaction`
**P-ASR (P0, re-run).** Deepgram Nova-3: isFinal, diarization labels, <200 ms word-final, silence→no-obs,
subscription credential. *Verify:* command (each failable, RBG = <50 ms), command (secret-redaction),
agent-review (diarization stability vs VAD fallback).

#### `probe-hot-loop-llm-subscription` — *medium* — REQ-3, REQ-10, engineering-only — depends on: `probe-suite-harness`, `subscription-credentials-redaction`
**P-LLM + A-LLM-SUB (P0).** Haiku-4.5 through Smithers subscriptions; temp-0 determinism, ~100 ms,
MappedActionTool schema, no raw key; cost gate $0.10→$0.15/hr; ACT-prompt fix. *Verify:* command
(determinism/latency/schema/subscription, RBG = raw key), agent-review (A-LLM-SUB verdict / PRD §6
conflict to gate).

#### `probe-streaming-tts` — *medium* — REQ-9, REQ-10 — depends on: `probe-suite-harness`, `subscription-credentials-redaction`
**P-TTS (P0, selection benchmark).** Streaming first-byte ≤200 ms across 2026 candidates; pre-cache 5
fixed phrases; no key logged. *Verify:* command (first-byte failable, RBG = ≤20 ms), agent-review
(selection + pre-cache <100 ms).

#### `probe-smithers-durable-runs` — *medium* — REQ-4/8/13/15 — depends on: `probe-suite-harness`
**P-SMITHERS (P0, hardening A3 PASS).** spawn/stream/pause/resume/steer/recovery/concurrent + fork
realization; **gateway mode** (not CLI/detach). *Verify:* command (each lifecycle op failable, RBG =
disable checkpointing), agent-review (fork verdict + gateway path).

#### `probe-pretool-safety-hook` — *medium* — REQ-11 — depends on: `probe-smithers-durable-runs`
**P-HOOK (P0).** PreToolUse hook intercepts and HOLDS a destructive tool call before execution;
approve/deny/timeout resolve (file unmodified). *Verify:* command (held tool unmodified, RBG = bypass
hook), agent-review (genuinely pre-execution).

#### `seam-gate-correlation` — *small* — REQ-11 — depends on: `probe-pretool-safety-hook`
**POC FINDING-5 (HIGH).** Design gap in eng §9: the approval-gate hook mints a `gateId` in-subprocess,
but the voice dispatcher has no mechanism to route voice "confirm" to the right gate without a
`pendingGates: Map<upid, gateId>` cache. Implement in `src/seam/dispatcher.ts`: set on `approval`
run-event; resolve on 'confirm' for that UPID; clear on dead-man timeout run-event; log stale 'confirm'
and drop (not error). *Verify:* command (pending-gate-set, confirm-resolves-right-gate,
dead-man-clears-map, stale-confirm-dropped — each failable), agent-review (single bridging mechanism).

#### `probe-cue-smithers-seam` — *medium* — REQ-4/8/11/13/15 — depends on: `probe-cue-substrate`, `probe-smithers-durable-runs`
**P-SEAM (P0, top integration risk).** Cue `MappedActionTool` action round-trips into a real Smithers
run; SSE run-events (incl. approval) flow back; spawn ≤3 s non-blocking; reconnect; UPID↔window.
*Verify:* command (round-trip failable, RBG = make dispatch blocking), agent-review (bidirectional/async,
approval round-trip).

#### `probe-keyword-spotter` — *medium* — REQ-2 — depends on: `probe-suite-harness`
**P-SPOTTER (P0, blocking — R10) + P-BUN-NATIVE (warning).** Local "Daybreak" recall + <1 FP/hr,
rejects near-homophones, emits only `mute.released`; Bun native load (sidecar fallback). *Verify:*
command (recall/FP/scope failable, RBG = near-homophone match), command (Bun native), agent-review
(reliability vs sole-unmute).

### Cue substrate & audio ingress

#### `audio-capture-asr-bridge` — *medium* — REQ-1 — depends on: `probe-cue-substrate`, `probe-asr-deepgram`
**ENG-T-10 (new scope, §22 A1.3).** Mic PCM → `ASRProvider` → JSON transcript events → Cue WebSocket
`/sessions/:id/transcription`; honors the mute fork + persistence guard; VAD fallback if no diarization.
*Verify:* command (well-formed events, no PCM written, RBG = PCM writer), e2e (real ingress), agent-review
(single audio→Cue path).

#### `cue-adapter-and-policies` — *large* — REQ-1/3/5/6/7 — depends on: `probe-cue-substrate`, `shared-types-contract`, `audio-capture-asr-bridge`
§3 — `src/cue/` harness/adapter/policies/programs: normalize observations, log decisions, hot-plane
earcon source, two independent `Program`s, owned extensions as risks (D2). *Verify:* command
(normalization/pass-logging/two-Program/recognition-source, RBG = ambient→steering), e2e (earcon ≤300 ms
while LLM delayed), agent-review (nothing Cue re-implemented).

### Routing, vocabulary, intent gate

#### `routing-dispatch-invariants` — *large* — REQ-6/7/8/12 — depends on: `cue-adapter-and-policies`
§4 — `src/routing/`: priority ladder, routing exclusivity, dispatch invariant, tiered vocabulary,
one-handler-per-command (status/pauseAll/pause/resume/setMode), NL out of scope (NG-2). *Verify:* command
(priority/dispatch-invariant/tier-gating/determinism/command-coverage, RBG = remove guard), e2e
(un-addressed never steers; one-breath; Atlas-pause), agent-review (no LLM authority).

#### `callsigns-and-collision-guard` — *medium* — REQ-7/13 — depends on: `routing-dispatch-invariants`
§4 + §22 A5.2 — drop NATO; **coined multi-syllable** callsigns; Metaphone + phoneme-Levenshtein ≤2
guard; 60 s cooldown; concatenated-STT handling; folds P-PHONETIC. *Verify:* command (collision/cooldown/
stable-codes, RBG = NATO through natural-speech corpus), agent-review (genuinely rare pool).

#### `steering-window-lifecycle` — *small* — REQ-6/8 — depends on: `routing-dispatch-invariants`
§4 — opens on callsign (incl. one-breath); routes to one UPID; closes on Done/Back, 20 s idle, Abort.
*Verify:* command (lifecycle, RBG = disable idle timer), e2e (idle close).

#### `intent-gate-semantic-check` — *medium* — REQ-3/4/7 — depends on: `routing-dispatch-invariants`, `cue-adapter-and-policies`, `probe-hot-loop-llm-subscription`
**§22 A5.1/A5.3 (critical).** Cheap-LLM intent check + whole-utterance pre-filter between `TextCue` and
any spawn/control action; off the ≤300 ms earcon path; temp-0 deterministic. *Verify:* command
('yes, but…' → no action, RBG = remove gate), e2e (corpus FP/false-accept drop, RBG = shuffle labels),
agent-review (off hot path, ACT-prompt fix).

### Audio output & mute

#### `earcons-and-output-policy` — *large* — REQ-2/9/10/12 — depends on: `shared-types-contract`, `provider-interface-doubles`, `probe-streaming-tts`
§5 — hot-plane pre-rendered earcons (E1–E5 + mute tone; E4/E5 redesign per §22 A4.3), four disjoint
Layer-B acks (AC6.4), 15-word guard, never-recite, mute/halt/read-back length rules, timeout "working"
ack, pre-cached phrases. *Verify:* command (latency/disjoint/guard/acks/timeout, RBG per row), e2e
(silence ratio ≤10%, working pulse), agent-review (human perceptual test, §22 A4.4).

#### `mute-controller-and-spotter` — *medium* — REQ-2 — depends on: `earcons-and-output-policy`, `probe-keyword-spotter`, `audio-capture-asr-bridge`
§5.3/§5.3.1/§12 — hard-mute fork ≤500 ms, mute = earcon + one-word "Muted", zero-obs-while-muted,
spotter as sole operational unmute, `mute.heartbeat`. *Verify:* command (mute-latency/no-obs/scope/
unmute-recovery, RBG = leave stream open), e2e (Curtain→Daybreak, zero audio on disk), agent-review
(heartbeat proves closed path).

### Suggestion, corpus, seam, acceptance

#### `replay-corpus-contract` — *medium* — REQ-3 — depends on: `record-replay-harness`
ENG-T-07/R16 — `artifacts/smithering/corpus/replay/`: ≥60 min negatives + ≥50 positives, label schema,
≥2 labelers + κ≥0.7, dev/test split, near-homophones of every always-hot word, transcript-only (NG-6).
*Verify:* command (leakage/schema/size, RBG = overlap segmentId), agent-review (provenance + κ +
representative negatives).

#### `suggestion-engine` — *large* — REQ-3 — depends on: `cue-adapter-and-policies`, `intent-gate-semantic-check`, `replay-corpus-contract`
§6 — gate (≥60 words OR ≥90 s) AND quality AND interrupt-cost; queue/idle delivery; 90 s expiry; ≤12-word
pitch + ≤3 MCQs; live knobs; hands `PendingSuggestion` to §7. *Verify:* command (gate-boundary/MCQ/
interrupt-cost/expiry/knobs, RBG = lower threshold), e2e (recall ≥80%, ≤1 FP/10 min on held-out split,
RBG = shuffle labels), agent-review (`observe.pass`-first).

#### `cue-smithers-seam-dispatcher` — *large* — REQ-4/8/11/13/15 — depends on: `probe-cue-smithers-seam`, `probe-smithers-durable-runs`, `shared-types-contract`, `seam-gate-correlation`
§9 (bet #3) — `src/seam/`: async dispatcher (full action set + approve/deny), gateway signal client,
SSE run-event normalizer (≤15-word summarize, reconnect, UPID↔window). *Verify:* command (schema-match/
async/reconnect/approval-roundtrip, RBG = wrong gateId), e2e (spawn ≤3 s + durability-recovery),
agent-review (single home, gateway path).

#### `acceptance-spawn-flow` — *large* — REQ-4 — depends on: `routing-dispatch-invariants`, `cue-smithers-seam-dispatcher`, `intent-gate-semantic-check`, `suggestion-engine`
§7 (R3) — `src/acceptance/`: pending state owner, MCQ accumulation, state-gated accept/decline (via the
intent gate), seed + pre-spawn resource check + spawn, auto-select + PLANNING, decline no-op. *Verify:*
command (exactly-one-spawn/seed/auto-select/tier-gating, RBG = decline→spawn), e2e (accept→durable
process ≤3 s; skip→no-op), agent-review (full causal chain via intent gate).

### Safety, registry, fleet

#### `shell-command-classifier` — *medium* — REQ-11 — depends on: `probe-suite-harness`, `shared-types-contract`
§8.1.1 / ENG-T-08 (R9) — deterministic parse-based shell classifier (read-safe ungated; mutating/redirect/
injection/compound/unknown gated, deny-by-default); folds P-SHELL-PARSE. *Verify:* command (safe/
destructive/unknown/compound/redirect/injection/fuzz/determinism + parser, RBG = move `ls` to mutating),
e2e (Safe-autonomy: `bun test`/`git status` ungated, `rm -rf` held), agent-review (red-team the allowlist).

#### `safety-execution-boundary-hook` — *large* — REQ-11 — depends on: `probe-pretool-safety-hook`, `cue-smithers-seam-dispatcher`, `shell-command-classifier`
§8 (R1) — in-run PreToolUse hook + safe-executor: intercept → deny-by-default classify → hold →
read-back ≤15 words → confirm/deny/dead-man-25 s; modes Safe/Explicit/Dangerous (voice opt-in,
session-only). *Verify:* command (hook-intercept/deny-by-default/state-machine/fuzz/modes, RBG = bypass
hook), e2e (destructive blocks, withhold→abort, confirm→once), agent-review (gate at real call site).

#### `process-registry-lifecycle-fleet` — *large* — REQ-4/8/12/13/15 — depends on: `cue-smithers-seam-dispatcher`, `callsigns-and-collision-guard`
§10 — `src/process/`: UPID registry (max 2, status), lifecycle (planning→active⇄paused→dead, pre-kill
archive, restart recovery), per-process pause/resume, pre-spawn resource check (capacity + headroom +
refusal ack). *Verify:* command (concurrent/isolation/lifecycle/recovery/resource-check, RBG = remove
check), e2e (steer A / pause B, unselected progress, capacity refusal), agent-review (unselected ≠ paused,
no NL pause).

#### `emergency-stop-control` — *small* — REQ-14 — depends on: `process-registry-lifecycle-fleet`
§11 — non-voice kill-all + session-end ≤2 s; **no** steer/select/spawn, **no** unmute/resume verb (R10).
*Verify:* command (scope/no-unmute, RBG = add steer/unmute route), e2e (all halt ≤2 s, fresh session
restarts unmuted, RBG = resume-in-place).

### Onboarding, observability, the spine, acceptance e2es

#### `onboarding-consent-persistence-guard` — *medium* — REQ-1 — depends on: `earcons-and-output-policy`, `audio-capture-asr-bridge`
§12 (R2) — consent scheduler (states "Only transcripts are saved", names "Curtain", ≤3 s, once/session),
listening indicator (E2 authoritative), whole-session raw-audio guard (code invariant), near-miss +
first-run VAD. *Verify:* command (scheduler/content/indicator/guard, RBG = drop transcript-only sentence),
e2e (consent first, whole-session zero-audio scan, RBG = `.wav` write), agent-review (guard is a code
invariant).

#### `observability-trace-and-board` — *medium* — REQ-16 — depends on: `trace-processor-observability`, `cue-smithers-seam-dispatcher`
§13 — causal-chain reconstruction across Cue JSONL + Smithers traces; OTel→Langfuse (P-OTEL); read-only
React board (no mutating endpoint). *Verify:* command (reconstruction + board read-only, RBG = add POST),
e2e (board-down → spine still passes, RBG = await board connection), agent-review (no-context debug).

#### `canonical-spine-and-no-screen-harness` — *large* — REQ-5/6/7/8 — depends on: `acceptance-spawn-flow`, `routing-dispatch-invariants`, `earcons-and-output-policy`, `process-registry-lifecycle-fleet`, `mute-controller-and-spotter`
§10/§6 — integrate the wake→intent→action→confirm spine under one `correlationId`; stage-sequencer;
no-screen harness; degradation test (fleet disabled → spine still passes). *Verify:* command
(stage-sequencer happy + 4 failure branches, RBG = drop ack), e2e (≥9/10 + zero GUI events + degradation,
RBG = broken dispatcher), agent-review (single-correlationId reconstruction, audible legibility).

#### `latency-benchmark-suite` — *medium* — REQ-10 — depends on: `canonical-spine-and-no-screen-harness`
REQ-10 — ≥100 round-trips: p50 <1 s, p95 <1.5 s, earcon <300 ms, timeout ack; recorded regression
baseline. *Verify:* e2e (benchmark, RBG = 100 ms budget / throttle provider), command (timeout-ack, RBG =
remove RoundTripTimer), agent-review (baseline fails on regression).

#### `fleet-concurrency-and-durability-e2e` — *large* — REQ-8/13/15/9 — depends on: `canonical-spine-and-no-screen-harness`, `process-registry-lifecycle-fleet`, `safety-execution-boundary-hook`
EV-6/8/9 — two-process fleet (steer A / pause B, unselected progress, isolation), durability recovery,
restraint ≤10% TTS ticks. *Verify:* e2e (fleet-isolation + recovery, RBG = pause-all-UPIDs / disable
checkpointing), e2e (silence ratio ≤10%, RBG = chatty build), agent-review (fleet additive, no work lost).

---

## Requirements traceability (PRD → tickets)

| PRD requirement | Tickets |
|---|---|
| REQ-1 — Ambient listening, consent, transcript-only | `audio-capture-asr-bridge`, `cue-adapter-and-policies`, `onboarding-consent-persistence-guard`, `provider-interface-doubles`, `probe-asr-deepgram` |
| REQ-2 — Hard spoken mute | `mute-controller-and-spotter`, `earcons-and-output-policy`, `probe-keyword-spotter` |
| REQ-3 — Conservative suggestion engine | `suggestion-engine`, `replay-corpus-contract`, `intent-gate-semantic-check`, `cue-adapter-and-policies`, `probe-hot-loop-llm-subscription` |
| REQ-4 — Hands-free spawn → durable process | `acceptance-spawn-flow`, `cue-smithers-seam-dispatcher`, `process-registry-lifecycle-fleet`, `probe-smithers-durable-runs` |
| REQ-5 — Canonical voice loop (spine) | `canonical-spine-and-no-screen-harness`, `cue-adapter-and-policies`, `walking-skeleton-smoke` |
| REQ-6 — Two-channel routing + acks | `routing-dispatch-invariants`, `steering-window-lifecycle`, `earcons-and-output-policy` |
| REQ-7 — Fixed magic-word vocabulary | `routing-dispatch-invariants`, `callsigns-and-collision-guard`, `intent-gate-semantic-check` |
| REQ-8 — Voice steering of a selected process | `steering-window-lifecycle`, `cue-smithers-seam-dispatcher`, `process-registry-lifecycle-fleet`, `fleet-concurrency-and-durability-e2e` |
| REQ-9 — Rationed spoken output | `earcons-and-output-policy`, `fleet-concurrency-and-durability-e2e` |
| REQ-10 — Sub-second ack latency | `latency-benchmark-suite`, `earcons-and-output-policy`, `probe-asr-deepgram`, `probe-streaming-tts`, `probe-hot-loop-llm-subscription` |
| REQ-11 — Safe-by-default execution | `safety-execution-boundary-hook`, `shell-command-classifier`, `probe-pretool-safety-hook`, `cue-smithers-seam-dispatcher` |
| REQ-12 — Panic/stop word | `routing-dispatch-invariants`, `earcons-and-output-policy`, `process-registry-lifecycle-fleet` |
| REQ-13 — Minimal concurrent fleet | `process-registry-lifecycle-fleet`, `callsigns-and-collision-guard`, `fleet-concurrency-and-durability-e2e` |
| REQ-14 — Non-voice emergency stop | `emergency-stop-control` |
| REQ-15 — Durable processes | `process-registry-lifecycle-fleet`, `cue-smithers-seam-dispatcher`, `fleet-concurrency-and-durability-e2e`, `probe-smithers-durable-runs` |
| REQ-16 — Observability surface + tracing | `trace-processor-observability`, `observability-trace-and-board` |
| SEC-1 — Secret hygiene (PRD §6) | `subscription-credentials-redaction` |
| engineering-only (ENG-T-01..10) | `walking-skeleton-smoke`, `shared-types-contract`, `record-replay-harness`, `provider-interface-doubles`, `trace-processor-observability`, `subscription-credentials-redaction`, `probe-suite-harness`, `replay-corpus-contract`, `shell-command-classifier`, `audio-capture-asr-bridge` |

---

## How the implementation workflow consumes this

- The machine copy is `artifacts/smithering/tickets.json` (`{ "tickets": [...] }`); the implementation
  workflow imports it. Each `id` is a **stable, durable Smithers task id** — do not renumber.
- `dependsOn[]` is a verified **DAG** (acyclic, all references resolve). Schedule in topological order;
  `walking-skeleton-smoke` is first (the smoke test) and the blocking probes gate their dependents.
- Every ticket's `verification[]` maps to a `bun test` path / e2e / agent-review drawn from
  `docs/planning/04-backpressure.md`; a blocking gate must show its named test **passing with a recorded
  red-before-green**. A gate with no failable test — or whose only evidence is "the agent said it's
  done" — blocks merge.
- **Blocking probe failures are surfaced to the orchestrator's gate, not engineered around.** Per §22,
  the round-1 probes already paused the pipeline pending human approval of the amendments folded in
  here (intent gate, coined callsigns, the ASR→Cue bridge, gateway-mode signalling, the $0.15/hr cost
  gate, the earcon redesign, and the raised-to-blocking P-SPOTTER/P-SHELL-PARSE/A-LLM-SUB gates).
