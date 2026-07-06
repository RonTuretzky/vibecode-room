# Prior Art — Vibersyn Ambient Audio Agent

> Researched 2026-06-13. Covers open-source projects, reusable libraries, and architectural
> patterns relevant to building Vibersyn: an ambient, audio-only AI agent that continuously
> observes speech, decides when to act (vs. pass), and spawns/steers durable agent processes.

---

## 1. Cue — the direct foundation (`github.com/jameslbarnes/cue`)

**What it is:** The library Vibersyn builds on. Cue is a "silent realtime harness for agents
you communicate with through the world." Created by James L. Barnes. TypeScript (85.6% of
codebase), 63 commits as of research date.

**Core pipeline:**
```
continuous stream → observation → cue policy → context packet → agent/model/tool → action or observe.pass → JSONL recording
```

**Observation types (normalized world events):**
- `transcript.segment` — text, isFinal, speaker (from Deepgram or VoxTerm)
- Vision descriptions — from Moondream VLM
- Sensor/signal values — numeric data from environment

**Cue types (deterministic wake conditions):**
- `TextCue(["keyword"])` — keyword match in transcript
- `SpeakerChangedCue()` — fires when speaker identity changes
- `SpeakerWordCue(["wait", "actually"], { speaker: "speaker_1" })` — per-speaker keyword
- `WordCountCue(30)` — segment length threshold
- `IntervalCue(10)` — fires every N seconds
- `IdleCue()` — silence / no activity
- `SignalThresholdCue("audio.energy", 0.45)` — numeric threshold with rising-edge support

**Core components:**
- `CueHarness` — session orchestrator: manages cues, programs, tool execution
- `Program` — model routine that fires when a matching cue activates; declares available tools
- `MappedActionTool` — maps model output to external actions; supports `cooldownSeconds`
- `observe.pass` — first-class no-op tool; always available; records explicit non-intervention

**Provider slots (pluggable):**
- `transcriptionProvider` — Deepgram (default) or VoxTerm (local offline)
- `vlmProvider` — Moondream
- `llmProvider` — Cerebras (default in examples), any OpenAI-compatible
- `outputProviders` — external system actions

**Built-in observability (JSONL per session):**
```
.cue/runs/<sessionId>/observations.jsonl
.cue/runs/<sessionId>/decisions.jsonl   ← includes every observe.pass decision
.cue/runs/<sessionId>/actions.jsonl
```

**MCP control plane:**
- `cue.get_state`, `cue.update_runtime`, `cue.send_observation`, `cue.replay_transcript`
- The Vibersyn↔Smithers integration maps directly onto `cue.send_observation` and `cue.update_runtime`

**HTTP / WebSocket server:**
- `POST /sessions/:id/observations` — ingest observations
- `GET /sessions/:id/events` — subscribe to event stream (SSE)
- `PATCH /sessions/:id/runtime` — live parameter patching
- `GET /sessions/:id/agent` — machine-readable manifest

**Flagship example — Etherea:** A live AI video agent that monitors speech, silence, generated
frames, and timing to decide when to update realtime video prompts vs. hold state. Nearly
identical to Vibersyn's always-on listening loop.

**Other bundled examples:** `but-coach`, `meeting-red-alert`, `live-dashboard`,
`conversation-shader`, `voxterm-live`, `realtime-video`, `playground`

**Design philosophy:** Restraint is first-class. Most events don't warrant activation.
`observe.pass` encodes intentional non-action as a tracked decision. "Creative logic should
survive infrastructure changes."

**Vibersyn mapping:**
| Vibersyn concept | Cue primitive |
|---|---|
| Magic words / voice triggers | `TextCue`, `SpeakerWordCue` |
| Suggestion cadence (idle-preferring) | `IdleCue`, `IntervalCue` |
| C2/C3 two-channel routing | Two separate `Program`s; one ambient + one scoped |
| Route to nothing | `observe.pass` |
| Speaker diarization | `SpeakerChangedCue` + `speaker` in transcript observation |
| Deterministic trace | Built-in JSONL recording |

**Validation bar note:** Cue's APIs are known from its README but must be exercised against the
real library before Vibersyn builds on them. Treat Cue validation as a P0 gate.

---

## 2. Ambient agent pattern — closest conceptual prior art

### LangChain Ambient Agents (January 14, 2025)
- **Blog:** https://www.langchain.com/blog/introducing-ambient-agents
- **What it is:** LangChain's formal introduction of ambient agents — agents that subscribe to
  event streams and act when appropriate, rather than waiting for chat prompts.
- **Architecture:** LangGraph + persistence layer + native human-in-loop interrupts + long-term
  memory (namespaced key-value with semantic search) + cron-based triggering.
- **When-to-act model:** Three check-in patterns: Notify (flag without acting), Question (seek
  clarification), Review (submit for approval). No explicit `pass` primitive.
- **Reference impl:** An email assistant + "Agent Inbox" UI (ticketing hybrid for agent interactions).
- **Key difference from Cue:** LangChain's model requires a human in the loop for most decisions.
  Cue's `observe.pass` is an autonomous decision to not act, with no human required. Vibersyn
  needs the Cue approach — a room of humans should not be pestered with constant check-ins.

### Medium / ambient agents concept
- **Source:** https://medium.com/@pinarpatton/ambient-agents-when-events-not-prompts-are-the-trigger
- Defines the pattern: "event streams, not prompts, are the trigger." Agents run continuously;
  the trigger is a world event, not a user message.
- Validates the core Vibersyn model. No concrete library.

---

## 3. Voice pipeline orchestration frameworks

### Pipecat (`github.com/pipecat-ai/pipecat`)
- **What it is:** Open-source Python framework from Daily for real-time voice and multimodal
  conversational agents.
- **Pipeline model:** Frame-based streaming — VAD → STT → LLM → TTS, with automatic interruption
  handling. Composable pipeline of processors.
- **Multi-agent:** Supports handoff, fan-out, and coordination over a shared bus.
- **Key primitives:** Frames (data units), Processors (transforms), Transports (WebSocket, WebRTC,
  Daily, LiveKit).
- **Key difference from Cue:** Conversational — expects a human turn and generates a response. No
  native `observe.pass` or wake/sleep policy layer. VAD handles listen/respond boundary, not a
  cue-policy system.
- **Reuse opportunity:** Could be used for the TTS output layer (speaking suggestions back) while
  Cue handles the observation/decision layer. However, Cue already has an `outputProvider` slot;
  this duplication should be avoided unless Cue's TTS is insufficient.
- **GitHub:** https://github.com/pipecat-ai/pipecat

### LiveKit Agents (`github.com/livekit/agents`)
- **What it is:** Open-source Python framework from LiveKit, built on their WebRTC media server.
- **Primitives:** `Agent`, `AgentSession`, `AgentServer`, `JobContext`, semantic turn detection
  (transformer model to detect when user is done speaking, not just VAD).
- **Dispatch APIs:** Built-in job scheduling for concurrent agent management.
- **Key difference from Vibersyn:** Room-model native (multi-participant, group calls, video) but
  not designed for the ambient/silent observation pattern; requires an active participant to speak
  to. Semantic turn detection is more sophisticated than VAD, but the concept is still
  request/response.
- **Reuse opportunity:** Semantic turn detection model could inform how Cue decides when a user
  has finished an utterance vs. is pausing mid-sentence — relevant for `IdleCue` tuning.
- **GitHub:** https://github.com/livekit/agents

---

## 4. Always-on transcription providers

### Deepgram Nova-3
- **What it is:** Commercial streaming STT via WebSocket with next-gen speaker diarization.
- **Capabilities:** `isFinal` flag per segment, `speaker_0`/`speaker_1` labels, sub-500ms latency.
- **Relationship to Cue:** Cue ships `deepgramTranscriptionProvider` as its default transcription
  backend. `isFinal` maps to `transcript.segment` observations; speaker IDs map to
  `SpeakerChangedCue` / `SpeakerWordCue`.
- **URL:** https://deepgram.com

### AssemblyAI Universal-3 Pro Streaming
- **What it is:** Commercial streaming STT; #1 on HuggingFace Open ASR Leaderboard.
- **Capabilities:** Slam-1 speech-language model (Oct 2025), Voice Agent API (WebSocket, STT+LLM+TTS
  unified).
- **Relationship to Vibersyn:** An alternative to Deepgram; not currently in Cue's provider list.
  Could be wired in as a custom `transcriptionProvider` if Deepgram proves insufficient.
- **URL:** https://www.assemblyai.com

### VoxTerm
- **What it is:** Local offline transcription provider. Appears in Cue's codebase as
  `voxtermTranscriptionProvider`.
- **Relationship to Vibersyn:** Useful for offline dev/test without a Deepgram API key; Cue
  already supports it.

### Whisper Large V3 Turbo (October 2024, OpenAI)
- **What it is:** Open-source batch STT model. 5.4× speed improvement over Whisper V3.
- **Limitation:** Batch-only; not streaming-suitable for sub-500ms trigger detection. Not suitable
  for Vibersyn's always-on loop. Use Deepgram/AssemblyAI for production.

---

## 5. Speaker diarization

### Deepgram Next-Gen Diarization (cloud)
- Outperforms pyannote on domain-specific data; 10× faster than nearest competitor.
- Used in Cue's `SpeakerChangedCue` / `SpeakerWordCue` via Deepgram's streaming API.
- Returns `speaker_0`, `speaker_1`, etc. in transcript segments.
- **Source:** https://deepgram.com/learn/nextgen-speaker-diarization-and-language-detection-models

### pyannote.audio (`github.com/pyannote/pyannote-audio`)
- **What it is:** Open-source PyTorch-based speaker diarization toolkit.
- **Capabilities:** Speech activity detection, speaker change detection, overlapped speech
  detection, speaker embedding. `speaker-diarization-3.1` available on HuggingFace.
- **Limitation:** Primarily offline/batch; real-time streaming VAD exists but latency is higher
  than Deepgram. Not a drop-in for Cue's streaming provider slot without adaptation.
- **Reuse:** Could be used to build a local offline `transcriptionProvider` for Cue that includes
  diarization, at the cost of higher latency.

**Vibersyn implication:** Cue already abstracts speaker identity through `SpeakerChangedCue`
and `SpeakerWordCue`. The diarization backend is pluggable via `transcriptionProvider`.

---

## 6. Durable agent process management

### Temporal.io
- **What it is:** Open-source durable workflow engine (forked from Uber Cadence, 2020).
- **AI integrations:** OpenAI Agents SDK (2025); Google ADK (2026).
- **Key primitives:** Workflows (durable, replayable), Activities (individual steps), Child
  Workflows (fork semantics), Signals (external events → running workflows), Queries, Timers.
- **Fork pattern:** Child workflows are the fork primitive — independently scheduled and
  resumable, observable from parent.
- **Pause/resume:** Native via `waitForSignal`; workflows replay from event history after crash.
- **Relationship to Smithers:** Temporal is architecturally what Smithers implements — a durable,
  forkable, resumable process manager. Smithers is a purpose-built, lighter-weight implementation
  for the Claude Code / MCP ecosystem. Studying Temporal's Signals API is directly informative
  for modeling Smithers' `steer`/`pause`/`resume` semantics.
- **URL:** https://temporal.io

### Restate (`restate.dev`)
- **What it is:** Open-source durable execution engine; single binary; TypeScript/Java/Go/Python/Rust SDKs.
- **Primitives:** `suspend/resume for human decisions`, `recoverable parallel tasks`,
  `breaking complex agents into smaller workflows`, `pausing/resuming agents`.
- **Relationship to Smithers:** Lower-overhead alternative to Temporal for simpler cases. Its
  TypeScript SDK is directly relevant given Cue is TypeScript. The `suspend/resume` pattern maps
  closely to Smithers' pause/resume.
- **URL:** https://restate.dev

### Microsoft Conductor (`github.com/microsoft/conductor`)
- **What it is:** YAML-defined multi-agent workflows with deterministic routing (Jinja2, not
  LLM routing). Released May 2026. MIT license.
- **Primitives:** `terminate` steps (explicit stop), `wait` steps (human gate), `parallel`
  (static groups or dynamic `for_each`), sub-workflow composition, `--web-bg` dashboard mode.
- **Relationship to Vibersyn:** Closest to Cue's policy layer in terms of determinism, but
  workflow-graph based rather than continuous-stream based. The YAML-defined deterministic routing
  is a useful pattern for the Cue ↔ Smithers action dispatch seam.
- **Source:** https://opensource.microsoft.com/blog/2026/05/14/conductor-deterministic-orchestration-for-multi-agent-ai-workflows/

### agent-fleet-o (`github.com/escapeboy/agent-fleet-o`)
- **What it is:** Open-source self-hosted multi-agent orchestration with visual DAG workflows.
- **Primitives:** 8 node types: agent, conditional, human-task, switch, dynamic-fork. 450+ MCP
  tools.
- **Relationship:** `dynamic-fork` node is the closest to Smithers' fork primitive in a
  general-purpose system. Not audio-native.

### CrewAI (`crewai.com`)
- **What it is:** Multi-agent framework with checkpointing (replay from specific steps), fork
  workflows, hierarchical delegation (Manager Agent distributes work).
- **Memory:** ChromaDB (short-term), SQLite (task results), vector embeddings.
- **Limitation for Vibersyn:** Task-oriented, not stream-oriented. Not designed for a real-time
  audio loop. Its fork/checkpoint patterns are informative but not directly reusable.

---

## 7. Deterministic observability and replay

### Cue's built-in recording (primary recommendation for Vibersyn)
Three JSONL files per session:
- `observations.jsonl` — every normalized world event
- `decisions.jsonl` — every model invocation and chosen tool (including `observe.pass`)
- `actions.jsonl` — every external action taken

The MCP adapter (`cue.replay_transcript`) enables replaying past sessions for debugging and
evaluation. This is the correct observability primitive for the Cue layer — Vibersyn should
extend it, not replace it.

**Recorded decisions are the core insight:** `observe.pass` is recorded in `decisions.jsonl`,
not as an absence of action, but as a positive decision. This makes the decision loop fully
auditable without extra tooling.

### Langfuse (`langfuse.com`)
- **What it is:** Open-source (self-hostable), OpenTelemetry-native LLM observability.
- **Capabilities:** Traces every LLM call, tool call, span — nested hierarchy showing what fired
  and why. Prompt debugging, cost analysis, per-agent token usage. Framework-agnostic.
- **Relationship to Vibersyn:** Best choice for adding visual observability to the Smithers
  process layer (the per-process agent calls, Fable planning steps). Complements Cue's JSONL
  recording. Smithers' structured logs can be forwarded as OTLP traces.
- **URL:** https://langfuse.com

### LangSmith (`langchain.com/langsmith`)
- Deep integration with LangGraph — captures decision steps, tool calls, reasoning.
- Best choice only if Vibersyn's orchestration uses LangGraph (it doesn't — it uses Smithers).
  Not recommended as primary; Langfuse is framework-agnostic and a better fit.

### OpenTelemetry GenAI Semantic Conventions
- Standardized LLM span attributes (stable mid-2024). Defines how to name spans, log tool
  calls, capture prompts without PII leakage.
- Langfuse, LiteLLM, Arize all accept OTLP traces with GenAI conventions.
- **Recommendation:** Instrument Smithers' per-process agent calls with OTel GenAI conventions
  and export to Langfuse. This gives context-free debugging for any later agent.

### Deterministic replay principle
From security/correctness research: non-determinism means you cannot reconstruct the past by
replaying the present — you must **capture and persist**, not recompute.
- Best practice: write a cryptographic receipt before each action executes, independent of the
  model's control.
- Cue's JSONL decision log implements this: `observe.pass` is recorded before the absence of
  action, not after.
- Temporal implements this as the "event history" that replays workflows from scratch after a
  crash — the same principle.

---

## 8. Architectural gap — what doesn't exist yet

The most significant finding is the **gap** in prior art:

1. **Cue** solves the stream → policy → act-or-pass layer cleanly.
2. **Temporal/Restate/Smithers** solve durable process management.
3. **Deepgram + pyannote** solve multi-speaker always-on transcription.
4. **Langfuse + Cue JSONL** solve observability.

**No existing system combines these for the specific pattern:**
> Ambient voice observation → autonomous cue policy → spawned durable named agent processes →
> voice-steerable by name → spoken output → independently pauseable/forkable/killable fleet

The closest integrated system is **Cue's Etherea demo** (continuous stream → LLM decision →
realtime action), but Etherea is single-process — it doesn't spawn and manage a *fleet* of
named agent processes. The Cue↔Smithers composition is Vibersyn's novel contribution.

The second-closest is **Temporal + Pipecat + Langfuse** used together, but these are not
pre-integrated and don't share Cue's explicit `observe.pass` / restraint philosophy.

---

## 9. Decisions recorded here

- **Cue is the correct foundation** — it directly implements the observation → cue policy →
  act-or-pass loop Vibersyn needs. No alternative comes close. Validate its APIs (P0 gate)
  before building.
- **Deepgram Nova-3 is the correct V0 transcription provider** — it's already in Cue's stack,
  gives `isFinal` and speaker diarization, and has the lowest latency of evaluated options.
  VoxTerm for offline dev.
- **Smithers is the correct durable process manager** — purpose-built for the Claude/Smithers
  ecosystem. Temporal/Restate inform the fork/pause/resume design but are not adopted.
- **Langfuse is the correct observability layer for the Smithers side** — framework-agnostic,
  self-hostable, OTLP-native. Cue's JSONL handles the Cue side.
- **Do not adopt Pipecat or LiveKit as primary layers** — both are conversational
  request/response, not ambient. Cue already handles the voice input layer.
- **Do not adopt LangChain Ambient Agents** — the human-in-loop check-in model is the wrong
  pattern for a room of humans who shouldn't be interrupted; Cue's autonomous `observe.pass` is
  the right model.
- **The novel contribution of Vibersyn** (Cue ↔ Smithers multi-process fleet + voice
  selection) has no direct prior art as an integrated system — we are building new ground.

---

## Sources

- https://github.com/jameslbarnes/cue — Cue library (primary foundation)
- https://www.langchain.com/blog/introducing-ambient-agents — LangChain ambient agent concept
- https://venturebeat.com/ai/whats-next-for-agentic-ai-langchain-founder-looks-to-ambient-agents — ambient agents background
- https://github.com/pipecat-ai/pipecat — Pipecat voice pipeline
- https://github.com/livekit/agents — LiveKit Agents
- https://github.com/microsoft/conductor — Microsoft Conductor
- https://opensource.microsoft.com/blog/2026/05/14/conductor-deterministic-orchestration-for-multi-agent-ai-workflows/ — Conductor announcement
- https://temporal.io — Temporal durable execution
- https://restate.dev/blog/durable-ai-loops-fault-tolerance-across-frameworks-and-without-handcuffs — Restate durable loops
- https://www.inngest.com/blog/durable-execution-key-to-harnessing-ai-agents — Inngest
- https://github.com/pyannote/pyannote-audio — pyannote speaker diarization
- https://deepgram.com/learn/nextgen-speaker-diarization-and-language-detection-models — Deepgram diarization
- https://www.assemblyai.com/blog/assemblyai-vs-deepgram-best-voice-agent-api — AssemblyAI vs Deepgram
- https://langfuse.com/blog/2024-07-ai-agent-observability-with-langfuse — Langfuse observability
- https://www.sakurasky.com/blog/missing-primitives-for-trustworthy-ai-part-8/ — deterministic replay principle
- https://github.com/escapeboy/agent-fleet-o — multi-agent fleet orchestration
- https://github.com/andyrewlee/awesome-agent-orchestrators — survey of agent orchestrators
- https://medium.com/@pinarpatton/ambient-agents-when-events-not-prompts-are-the-trigger-183813315cb6 — ambient agent concept
- https://atlan.com/know/event-driven-architecture-for-ai-agents/ — EDA for AI agents
- https://picovoice.ai/blog/complete-guide-voice-activity-detection-vad/ — VAD background
- https://langfuse.com/integrations/native/opentelemetry — OpenTelemetry GenAI conventions
