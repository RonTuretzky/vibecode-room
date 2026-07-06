# Engineering Dependencies & Infrastructure — Vibersyn V0
*Written: 2026-06-13. Sourced from `docs/planning/01-prd.md`, `docs/planning/02-design.md`,
`artifacts/smithering/research/prior-art.md`, `artifacts/smithering/research/domain.md`,
`.smithers/package.json`.*

---

## Overview

Vibersyn's dependency stack decomposes into six concern layers:

1. **Audio observation harness** — Cue (the canonical substrate, P0 gate)
2. **Durable agent process management** — Smithers (first-party platform)
3. **Streaming ASR** — Deepgram Nova-3 (Cue default; abstracted behind interface)
4. **Low-latency TTS** — unverified; probe selects winner
5. **Cheap/fast decision LLM** — Cerebras/Haiku-tier (hot loop only)
6. **On-device unmute keyword spotter** — assumed present; not yet selected
7. **Observability** — Cue JSONL (Cue layer) + Langfuse/OTel (Smithers layer)
8. **Runtime & HTTP** — Bun + Hono + React 19

All model calls route through **Smithers subscriptions — never a raw API key** (PRD §6, design §11.2).
The TTS provider and on-device spotter are **unverified** — they require probes before any code is
built on them. The Cue repo has a **P0 availability blocker** (see §1 below).

---

## 1. Cue — `github.com/jameslbarnes/cue`

### What it does for us
Cue is the **canonical audio observation harness** (PRD D2, binding). It turns continuous mic audio
into structured observations, applies deterministic cue policies (wake word, word count, idle, speaker
change, interval), and wakes the right program/model/tool with the right context — or emits
`observe.pass` (logged, first-class no-op). It is the entire input, routing, and suggestion trigger
layer for Vibersyn. We do **not** re-implement any of this; our contribution is a thin adapter.

**Specific primitives we build on:**
- `TextCue` / `SpeakerWordCue` — magic-word detection (wake, callsigns, mute/panic)
- `WordCountCue`, `IdleCue`, `IntervalCue` + `cooldownSeconds` — suggestion gate and cadence
- `observe.pass` — explicit, logged non-action (the majority-case output)
- `CueHarness` — session orchestrator with pluggable provider slots
- `Program` — two independent Programs for two-channel routing (C2/C3)
- `MappedActionTool` — Cue decision → Smithers action dispatch
- Built-in JSONL trace files (observations, decisions, actions per session)
- HTTP/SSE routes (`GET /sessions/:id/events`, `PATCH /sessions/:id/runtime`)
- Transcription provider slot accepts Deepgram or VoxTerm (offline)
- LLM provider slot accepts Cerebras or any OpenAI-compatible

### Maturity
TypeScript (85.6%), ~63 commits as of 2026-06-13. A working flagship demo (Etherea, live AI video
agent) demonstrates the continuous-stream → policy → act-or-pass loop in production. API is
documented in the README. The library is purpose-built for the exact ambient observation pattern
Vibersyn needs — no alternative comes close (prior-art.md §9).

### Lock-in risk — HIGH
The entire voice input layer, routing logic, and cue policy system is Cue. If Cue's API differs from
our assumptions or the repo is unavailable, REQ-1, REQ-3, REQ-5, REQ-6, REQ-7 must be redesigned
from scratch.

**Mitigation (D2):** all Cue-specific calls live in a **thin owned adapter layer**. Any Cue gaps we
encounter are added to the adapter rather than blocking build. Extensions are recorded as risks.

### ⚠ P0 BLOCKER: repo availability unconfirmed
`domain.md` §7 could not confirm the repo was publicly accessible on 2026-06-13. `prior-art.md` §1
documents the API as found in the README, but no code was executed against the real library. **P-CUE
(probe against the real library) is the first build task and a hard gate.** Everything in this
document about Cue is README-derived and unconfirmed.

### Leading alternative
**Roll our own harness** using Pipecat (Python, frame-based voice pipeline) or LiveKit Agents
(Python, WebRTC-native, semantic turn detection). Neither provides `observe.pass` as a first-class
concept; both are request/response conversational, not ambient. If Cue is unavailable, the design
for the observation/routing/cue-policy layer must be rebuilt; the Pipecat frame model is the closest
structural analog. Cost: significant redesign of REQ-1/3/5/6/7.

---

## 2. Smithers — `smithers-orchestrator` ^0.23.0

### What it does for us
Smithers is the **durable agent process manager** for Vibersyn's spawned processes (REQ-4, REQ-13,
REQ-15). It provides: durable run spawn with seed payload; `streamRunEvents` (SSE) for live process
status; pause/resume; steer/signal (mid-run voice injection); pre-kill context archive; restart
recovery to last durable checkpoint; and concurrent runs for the V0 two-process fleet.

All Claude model calls for per-process planning route through **Smithers subscriptions** — no raw
API keys. This is a hard architectural constraint (PRD §6, design §11.2).

### Maturity
First-party platform — this is the orchestration system this project is hosted on (`smithers-
orchestrator` v0.23.0 confirmed in `.smithers/package.json`). The `.smithers/` directory contains
the live gateway, workflow definitions, and session data. The platform is in active use; the specific
fork/resume/pause/steer semantics against our process lifecycle model are **unconfirmed** and require
probe P-SMITHERS before build. (Fork may require a fresh seeded run + `parentId` lineage rather than
a native fork primitive.)

### Lock-in risk — HIGH (single-vendor; mitigated by first-party status)
All process lifecycle, model routing, and subscription management depend on Smithers. However, this
is the host platform for the project itself — Smithers is not a third-party constraint, it is the
operating environment. The risk is API surface mismatch, not vendor abandonment.

### Leading alternative
**Temporal.io** — production-grade open-source durable workflows (fork semantics via child
workflows, pause/resume via signals, replay from event history). TypeScript SDK available. Directly
models the Smithers primitives Vibersyn needs. Restate.dev is a lighter TypeScript-native
alternative with similar `suspend/resume` patterns. Adopting either would require decoupling from
Smithers subscriptions (losing the bundled model routing) and significant plumbing — not recommended
for V0.

---

## 3. Deepgram Nova-3 — streaming ASR

### What it does for us
Deepgram Nova-3 is the **primary transcription provider** (D4, PRD §6 P-ASR). It provides:
continuous WebSocket streaming; `isFinal` flag per segment; `speaker_0`/`speaker_1` diarization
labels (consumed by `SpeakerChangedCue` / `SpeakerWordCue`); and sub-300ms word-final latency. It is
already Cue's default `transcriptionProvider` — Vibersyn's thin adapter normalizes its output into
`{text, isFinal, speaker, sessionId, latencyMs}`.

### Maturity
Commercial production service. Widely deployed; $0.26–$0.46/hr. Deepgram's next-gen diarization
outperforms pyannote on domain-specific data (10× faster). Used by Cue's flagship Etherea demo.

### Lock-in risk — MEDIUM (mitigated by interface abstraction)
Deepgram is abstracted behind the `ASRProvider` interface (`design §11.3`), making it swappable.
The primary switching cost is re-validating diarization label format and `isFinal` timing against the
new provider. The `SpeakerChangedCue` mapping is the tightest coupling — it depends on stable
speaker labels.

### Probe required (P-ASR — P0)
Must assert: `isFinal` flag shape and timing; diarization label format; measured word-final latency
**<200 ms** (to leave headroom for ≤300 ms earcon, REQ-10 AC10.1); no observation on silence;
behavior under overlapping speech (2 simultaneous speakers).

### Leading alternative
**AssemblyAI Universal-3 Pro Streaming** — #1 on HuggingFace Open ASR Leaderboard as of 2026;
Voice Agent API (WebSocket, STT+LLM+TTS unified); Slam-1 speech-language model (Oct 2025). Not
currently in Cue's provider list — would need a custom `transcriptionProvider` adapter. The Voice
Agent API's bundled LLM+TTS could be evaluated if Cue's modular provider slots are sufficient.

**VoxTerm** — local offline provider already in Cue's codebase; no API key needed. Use for offline
dev/test. Not suitable for production latency targets.

---

## 4. TTS Provider — unverified; probe selects winner

### What it does for us
The TTS provider converts agent text output (suggestions, acks, spoken summaries, safety read-backs)
to streaming audio. The requirement is: first audio byte ≤200 ms of text submission (to keep total
round-trip <1 s, REQ-10 AC10.2); consistent neutral voice; streaming output (not batch). The
15-word hard guard runs **before** any submission to TTS.

### Maturity
All three candidates are commercial:

| Candidate | Note |
|---|---|
| **ElevenLabs Flash v3** | Ultra-low-latency mode; widely used for real-time voice agents |
| **Cartesia Sonic** | Claimed <100ms TTFB; TypeScript SDK; designed for agent workloads |
| **PlayHT 3.0 Turbo** | Low-latency streaming; voice clone options; PlayDialog model |

None have been benchmarked against the 200ms TTFB target for this project. The research covered ASR,
**not** TTS (D-DD-14); the probe is both a validation and a benchmark.

### Lock-in risk — LOW (mitigated by interface abstraction)
Abstracted behind the `TTSProvider` interface (`design §11.4`). Switching cost is re-validating
first-byte latency and audio quality. Voice is selected once per session (not per-utterance), which
limits per-call overhead.

### Probe required (P-TTS — P0)
Must assert: first audio byte ≤200 ms from text submission; streaming output (not batch); voice
selector works (consistent session voice). P-TTS **is also the provider selection benchmark** — the
winner earns the V0 slot.

### Leading alternative
**Pipecat's TTS integrations** (OpenAI TTS, Azure, Google, Deepgram Aura) — Pipecat already wraps
several TTS providers and benchmarks them. If Cue's `outputProvider` slot proves insufficient, using
Pipecat's TTS pipeline for the audio-out layer is the clearest fallback, at the cost of a Pipecat
dependency.

---

## 5. Cheap/fast decision LLM — Cue's hot loop

### What it does for us
The hot-loop LLM powers: suggestion scoring (buildable-intent check), the 15-word TTS summarizer,
and the decision/tool-selection layer inside each Cue `Program`. The constraint is **latency and
cost** — it must fit within the ~100ms hot-loop budget and be cheap enough to run on every
transcript segment without burning the session budget.

**No Opus/Sonnet in the hot loop** (NG-9). Per-process planning uses a richer model via Smithers
subscriptions.

### Candidates
| Model | Provider | Why |
|---|---|---|
| **Cerebras-served Llama** (e.g. Llama 3.3 70B) | Cerebras | Cue's default LLM provider in examples; ~100ms p50 on Cerebras inference chips; OpenAI-compatible API |
| **Claude Haiku-4.5** | Anthropic via Smithers | Lowest-cost Claude model; well within NG-9 scope; routes through Smithers subscriptions |

Temperature-0 is required for record-replay compatibility (design §13.1). The probe must confirm
temperature-0 determinism behavior for the selected provider.

### Maturity
Both are production commercial services. Cerebras is already Cue's documented default
(`llmProvider` slot example). Haiku-4.5 is current production (model ID: `claude-haiku-4-5-20251001`).

### Lock-in risk — LOW
Cue's `llmProvider` slot is pluggable (any OpenAI-compatible endpoint). Temperature-0 + record-
replay means the decision layer is testable and reproducible regardless of provider.

### Probe required (P-LLM — P0)
Must assert: temperature-0 determinism (same input → same output N×); p50 latency within ~100ms
hot-loop budget; emitted tool-selection schema matches `MappedActionTool`.

### Leading alternative
**Groq-hosted Llama** — comparable latency to Cerebras, OpenAI-compatible. **Gemini Flash 2.0** —
ultra-low-latency; not OpenAI-compatible without a shim. Any alternative must be validated for
temperature-0 record-replay compatibility before swapping.

---

## 6. On-device unmute keyword spotter

### What it does for us
While the cloud ASR stream is hard-muted ("Curtain" spoken), a fully local on-device spotter
continues listening for exactly one keyword: "Daybreak" (unmute). It emits exactly one event class
(`mute.released`) and nothing else — no transcription, no routing, no network. This preserves
REQ-2 AC2.3 ("no observations while muted") while keeping unmute hands-free via voice (D1).

See design §12 and D-DD-22 for the full constraint rationale.

### Maturity — UNVERIFIED; not yet selected
No specific library has been chosen. The probe is both a selection and a validation.

Candidates:

| Candidate | Language | Notes |
|---|---|---|
| **Picovoice Porcupine** | C/Node.js/Web | Commercial; custom wake-word models; very low CPU; confirmed <5ms detection; Node.js SDK available |
| **Vosk** | C/Node.js | Open-source; offline; small models (40MB); custom grammar; lower latency than whisper.cpp |
| **whisper.cpp (tiny model)** | C/Node.js bindings | Open-source; single-keyword mode possible via grammar; heavier than Porcupine/Vosk for a single word |
| **Pocketsphinx** | C/Node.js | Open-source CMU library; single-keyword detection; dated but lightweight |

Picovoice Porcupine is the leading candidate: purpose-built for always-on keyword detection, Node.js
SDK, custom wake-word enrollment.

### Lock-in risk — LOW (isolated; degrades gracefully)
The spotter is a single-purpose component with exactly one output event class. If unavailable on a
given host, the system degrades to the non-voice emergency control (REQ-14) for unmute — the room is
never permanently trapped muted.

### Probe required (spotter probe — P0)
Must assert: matches "Daybreak"; rejects near-homophones; emits no transcript; runs fully local
(no network traffic); Node.js binding works in Bun's Node.js compat layer.

### Leading alternative
**Cue's `SignalThresholdCue`** — if the spotter can output a numeric signal (audio energy spike on
keyword match), this could wire into Cue's existing threshold cue. However, this would tie the
unmute mechanism to Cue's running harness, which may itself be paused or in an error state during a
mute. Isolation from Cue is safer.

---

## 7. Observability stack

### 7a. Cue JSONL (Cue-layer observability)
Cue writes three JSONL files per session: `observations.jsonl`, `decisions.jsonl` (incl. every
`observe.pass`), `actions.jsonl`. These are the source of truth for causal-chain reconstruction on
the Cue side (REQ-16 AC16.3). MCP tool `cue.replay_transcript` enables replaying past sessions.
**No additional library needed; built into Cue.**

### 7b. Langfuse — Smithers-layer observability
**What it does:** OpenTelemetry-native, self-hostable LLM tracing. Captures nested trace
hierarchies for every LLM call, tool call, and span in the Smithers process layer. Framework-
agnostic (works with Smithers' structured logs via OTLP export).

**Maturity:** Production open-source; self-hostable Docker; OTLP/W3C trace context native; well-
maintained (langfuse.com).

**Lock-in risk — LOW.** Data is exported via OTLP — a standard protocol. Switching to Arize
Phoenix, Honeycomb, or any OTLP backend requires only a config change.

**Decision:** Instrument Smithers' per-process agent calls with OpenTelemetry GenAI semantic
conventions and export to a self-hosted Langfuse instance. Cue's JSONL handles the Cue side;
Langfuse handles the Smithers side. (prior-art.md §7, confirmed decision.)

**Leading alternative:** Arize Phoenix — open-source, self-hostable, OTel-native, LLM-specific.
Functionally equivalent to Langfuse for this use case.

---

## 8. Runtime, framework, and HTTP

### Bun (runtime + test runner)
Confirmed in repo (`bun test` is the test command; `.smithers/bunfig.toml`, `bun.lock` present).
Bun provides: TypeScript execution without compilation step; built-in test runner (`bun:test`);
fast package install. Maturity: Bun 1.x, production stable. Lock-in risk: MEDIUM — Bun is not
Node.js-compatible for all native modules; the on-device spotter (Porcupine/Vosk) needs Bun's
Node.js compat verified. Leading alternative: Node.js 22 + Vitest.

### Hono (HTTP API layer)
Referenced in `domain.md` as "Hono API / WebSocket" for the action dispatcher. Lightweight
TypeScript HTTP framework; runs on Bun natively; WebSocket support built-in. Used for: the
Vibersyn action dispatcher (receives `MappedActionTool` actions from Cue), the observability
board HTTP server, and the emergency-stop endpoint (REQ-14). Lock-in risk: LOW — standard HTTP.
Leading alternative: native Bun HTTP (`Bun.serve`); Express.js.

### React 19 (observability board UI)
Confirmed in `.smithers/package.json` (react: 19.2.7). Powers the optional read-only observability
board (REQ-16, design §9). Non-critical path — board is off the operational path. Lock-in risk:
LOW. Leading alternative: static HTML/vanilla JS (simpler for a read-only display; avoids the
React build step entirely, which may be preferable given the board is debugging-only).

---

## 9. The novel Cue↔Smithers seam (P-SEAM)

The integration point between Cue and Smithers is the **top integration risk** (PRD §9,
prior-art.md §8). No prior art integrates these two systems. The seam works as:

```
Cue MappedActionTool → emits {type, target, payload}
  → Vibersyn action dispatcher (Hono)
  → Smithers spawn/steer/pause API
  → Smithers streamRunEvents (SSE) → normalized run-event observations
  → back into Cue as world state (via cue.send_observation)
  → driving voice-out coherence (15-word summarizer → TTS)
```

Risks:
- Spawn must complete without blocking the Cue loop (AC4.3 requires ≤3 s; async dispatch needed)
- SSE reconnect semantics must not stall voice-out
- UPID↔steering-window correlation must survive Cue session restarts
- Run-events must be summarized to ≤15 words **before** TTS submission

Probe P-SEAM asserts this round-trip end-to-end against real instances of both systems.

---

## 10. Decisions recorded

| ID | Decision | Rationale |
|----|----------|-----------|
| ENG-D-01 | Cue is the mandatory audio observation substrate | No alternative provides `observe.pass`-first ambient loop + pluggable provider slots + JSONL traces. P-CUE is P0. |
| ENG-D-02 | Smithers is the mandatory durable process manager | First-party platform; all model calls route through its subscriptions. No raw API keys. |
| ENG-D-03 | Deepgram Nova-3 is the V0 transcription provider | Already in Cue's stack; `isFinal` + diarization; lowest evaluated latency. Abstracted behind interface. |
| ENG-D-04 | TTS provider selected by probe (ElevenLabs Flash v3 / Cartesia Sonic / PlayHT 3.0 Turbo) | Research benchmarked ASR, not TTS; probe is both validation and benchmark. Target: first byte ≤200 ms. |
| ENG-D-05 | Cheap/fast decision LLM: Cerebras/Haiku-4.5 in hot loop; richer model per-process via Smithers | NG-9: no Opus in the ambient loop. Temperature-0 required for record-replay. |
| ENG-D-06 | On-device unmute spotter: Picovoice Porcupine (leading candidate, unverified) | Purpose-built for always-on single-keyword detection; Node.js SDK; low CPU. Degrades to REQ-14 if absent. |
| ENG-D-07 | Langfuse (self-hosted) + OpenTelemetry GenAI conventions for Smithers-layer observability | Framework-agnostic, OTLP-native, self-hostable. Cue JSONL covers the Cue side. |
| ENG-D-08 | Bun runtime; Hono for HTTP/WebSocket; React 19 for the observability board | Bun is already the project runtime; Hono is lightweight and Bun-native; React 19 confirmed in .smithers/package.json. |
| ENG-D-09 | Thin owned adapter layer between Cue and Smithers; no Cue internals re-implemented | D2 (binding decision). Gaps in Cue are handled in the adapter, not by replacing Cue. |

---

## 11. Open risks

- **R-ENG-01 (P0):** Cue repo unavailable or API differs from README — blocks REQ-1/3/5/6/7.
- **R-ENG-02:** TTS first-byte latency unverified — probe P-TTS selects provider and proves the 200ms budget.
- **R-ENG-03:** Cue↔Smithers seam (P-SEAM) — no prior art; top integration risk.
- **R-ENG-04:** On-device unmute spotter unavailable on host — degrades to non-voice REQ-14 emergency stop.
- **R-ENG-05:** Smithers fork semantics — may require fresh seeded run + `parentId` lineage rather than a native fork; P-SMITHERS determines the pattern.
- **R-ENG-06:** Bun Node.js compat for native modules (Porcupine/Vosk) — must be verified before committing to either spotter library.
- **R-ENG-07:** Deepgram diarization accuracy under real in-room crosstalk — must be tested in the P-ASR probe with 2-speaker simultaneous speech.
- **R-ENG-08:** Fable model reachability — per `intake.md`, Fable may be disabled in this environment; per-process planning model needs a documented fallback (does not affect hot loop).

---

## Sources

- `docs/planning/01-prd.md` — binding decisions D1–D6, §6 dependency gates
- `docs/planning/02-design.md` — §11 probe gates, §14 design decisions log
- `artifacts/smithering/research/prior-art.md` — §1 (Cue), §3 (Pipecat/LiveKit), §4 (ASR), §6 (durable process managers), §7 (observability), §9 (decisions)
- `artifacts/smithering/research/domain.md` — §5 Q4/Q8/Q11 (provider decisions), §3 (Deepgram costs)
- `.smithers/package.json` — confirmed smithers-orchestrator ^0.23.0, React 19.2.7, Bun toolchain
- https://github.com/jameslbarnes/cue — Cue library (README-derived; unconfirmed against real library)
- https://deepgram.com — Deepgram Nova-3 streaming ASR
- https://picovoice.ai — Picovoice Porcupine keyword spotting
- https://langfuse.com — LLM observability
- https://temporal.io — Temporal durable workflows (alternative reference)
- https://restate.dev — Restate durable execution (alternative reference)
