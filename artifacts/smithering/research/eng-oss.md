# Engineering OSS Research — Vibersyn

> Written: 2026-06-13. Upstream: `docs/planning/02-design.md`, `artifacts/smithering/research/prior-art.md`,
> `artifacts/smithering/research/domain.md`. Topic: how real open-source codebases structure the same
> kind of system as Vibersyn — ambient audio observation, streaming voice pipelines, on-device keyword
> detection, and durable agent process management.
>
> **Factual posture:** All module paths, class names, and API shapes below are derived from training data
> (knowledge cutoff August 2025) and public README/documentation at research time. The specific method
> signatures and return shapes noted here MUST be exercised against the real library before any
> Vibersyn code depends on them — per the design's P0 probe gate requirement. Nothing below
> substitutes for running the probes.

---

## 0. Why these four codebases

Vibersyn has four engineering sub-problems that each have at least one mature open-source treatment:

| Sub-problem | Codebase studied | Why |
|---|---|---|
| Real-time voice pipeline: stream → VAD → ASR → policy → output | **Pipecat** (`pipecat-ai/pipecat`) | Frame-based composable pipeline; best-documented open-source example of the exact voice AI pipeline shape |
| On-device keyword spotting (the "Daybreak" unmute spotter) | **OpenWakeWord** (`dscripka/openWakeWord`) | ML-based always-on wake word detection; the only open-source system with documented false-positive rates for always-on scenarios |
| Durable workflows: spawn, signal, pause/resume, replay-from-history | **Temporal TypeScript SDK** (`temporalio/sdk-typescript`) | The reference implementation for durable execution with the exact signal + child-workflow + replay patterns Smithers implements |
| End-to-end offline voice assistant: event bus + pluggable providers + test harness | **Rhasspy 3** (`rhasspy/rhasspy`) | Complete voice assistant reference architecture; shows how provider slots, event bus, and replay-based testing compose |

---

## 1. Pipecat (`pipecat-ai/pipecat`)

### 1.1 What it is

Pipecat is a Python framework from Daily for real-time voice and multimodal AI pipelines. Core
abstraction: a **Pipeline** of **Processors**, each of which receives **Frames** on an input queue
and emits Frames on an output queue. Everything moves as typed frames; the pipeline composes
processors like Unix pipes.

### 1.2 Module structure

```
pipecat/
  frames/
    frames.py            # All Frame dataclasses: AudioRawFrame, TranscriptionFrame,
                         # LLMMessagesFrame, TTSAudioRawFrame, EndFrame, etc.
  processors/
    aggregators/
      llm_response_aggregator.py   # Collects LLM token stream → full message
      user_response_aggregator.py  # Collects VAD segments → user utterance
    filters/
      stt_mute_filter.py  # Drops audio frames when mute flag is set
    audio/
      audio_buffer_processor.py   # Accumulates raw PCM into configurable windows
  services/
    deepgram/
      stt.py             # DeepgramSTTService: WebSocket streaming ASR → TranscriptionFrame
      tts.py             # DeepgramTTSService: text → streaming audio → TTSAudioRawFrame
    elevenlabs/
      tts.py             # ElevenLabsTTSService
    openai/
      llm.py             # OpenAILLMService: handles tool calls, streaming tokens
      tts.py
  transports/
    network/
      websocket_server.py   # WebSocket transport
      fastapi_websocket.py  # FastAPI integration
    local/
      audio.py              # Local mic input + speaker output (PyAudio)
    daily/
      transport.py          # Daily WebRTC transport (multi-participant room)
  pipeline/
    pipeline.py        # Pipeline: links processors, starts/stops the frame flow
    task.py            # PipelineTask: async task wrapping a pipeline run
  vad/
    silero.py          # SileroVAD: local VAD model; emits StartedSpeakingFrame / StoppedSpeakingFrame
    webrtc_vad.py
```

### 1.3 Data flow

```
[Transport] → AudioRawFrame (PCM, 20ms chunks)
    → SileroVAD → StartedSpeakingFrame / StoppedSpeakingFrame
    → UserResponseAggregator (accumulates until StoppedSpeakingFrame)
    → TranscriptionFrame (text, is_final:bool, language)
    → DeepgramSTTService (streaming; emits InterimTranscriptionFrame + TranscriptionFrame)
    → LLMResponseAggregator → LLMMessagesFrame
    → OpenAILLMService → LLMFullResponseStartFrame → token stream → LLMFullResponseEndFrame
    → TTSAggregator (optional sentence-boundary chunking)
    → TTSService → TTSAudioRawFrame (streaming PCM)
    → [Transport output]
```

Every processor is an `asyncio.Queue` pair. The `Pipeline` wires them left-to-right; a processor
that does nothing with a frame passes it downstream unchanged. Sidechannels (metrics, cancel
signals) travel on separate `SystemFrame` subtypes that bypass normal processing.

**Key design insight for Vibersyn:** Pipecat's `stt_mute_filter.py` is the closest existing
reference for the hard-mute pattern (§12 of the design). It gates `AudioRawFrame` based on a
mute flag set by an upstream frame. Vibersyn's cloud-mute can follow the same pattern: a
`MuteEngagedFrame` flips a flag that causes the ASR service to drop all audio. The local spotter
runs as a *parallel* branch that never passes through the mute gate.

### 1.4 Testing strategy

Pipecat's tests live in `tests/` and use two main patterns:

1. **Frame injection tests** (`test_pipeline.py`, `test_aggregators.py`): construct a `Pipeline`
   with test processors; inject a sequence of pre-built Frames; assert the downstream frame
   sequence. No real audio, no network. This is the record-replay analog for the pipeline layer —
   the test is the injected frame sequence, exactly as Vibersyn's design requires JSONL
   replay of pre-recorded ASR observations.

2. **Service unit tests** (`tests/test_deepgram.py`): mock the WebSocket connection at the
   transport layer; feed byte payloads; assert the emitted TranscriptionFrame shapes. This is
   not end-to-end but exercises serialization / frame-shape assumptions before integration.

**What Vibersyn should copy:** inject pre-recorded `TranscriptObservation` JSONL into the
Cue harness the same way Pipecat injects pre-built Frames. The test is "same input sequence → same
decision sequence" — identical to Pipecat's frame injection pattern, applied at the Cue layer.

**What Vibersyn should NOT copy:** Pipecat is request/response — one user utterance → one agent
response. It has no `observe.pass` primitive and no ambient cue policy that decides whether to
respond at all. Its VAD drives turn detection; Cue's cue policies drive act-or-pass. These are
orthogonal concerns; Pipecat's pipeline pattern is the useful lesson, not its turn model.

### 1.5 Earcon dispatch analog

Pipecat emits audio via a TTSAudioRawFrame regardless of content. To implement Vibersyn's
earcon layer (§3), the right Pipecat pattern would be an `EarconProcessor` that intercepts
specific state-transition frames (`WakeDetectedFrame`, `ProcessSpawnedFrame`, etc.) and injects
pre-rendered PCM bytes as `AudioRawFrame`s directly — bypassing the TTS service entirely. This
keeps the earcon ≤300 ms latency path from ever touching the LLM or TTS network calls.

---

## 2. OpenWakeWord (`dscripka/openWakeWord`)

### 2.1 What it is

OpenWakeWord is a Python library for on-device, always-on wake word and keyword spotting using
neural network models. It is the closest open-source analog to what Vibersyn's §12 design calls
the "minimal on-device keyword spotter" for "Daybreak" unmute.

### 2.2 Module structure

```
openwakeword/
  model.py          # OpenWakeWord class: main inference loop
  utils.py          # Audio preprocessing: resampling, normalization, mel spectrogram
  data.py           # Training data helpers (not runtime)
  vad.py            # Silero VAD integration for pre-gating
  VERSIONS.py       # Model registry: pre-trained models and their metadata
  resources/
    models/         # ONNX model files for pre-trained wake words
    custom/         # Slot for user-trained ONNX models
```

### 2.3 Inference pipeline

```
[Raw PCM 16kHz mono] → circular audio buffer (80 ms window, 10 ms hop)
    → mel spectrogram (compute_melspec() in utils.py, 32-band, 128 ms context)
    → ONNX Runtime session (model.predict())
    → confidence score [0.0, 1.0] per wake word
    → threshold gate (default 0.5, configurable per word)
    → fires callback on crossing (rising edge only, with refractory period)
```

The model ingests a fixed-length mel spectrogram window (approximately 1.5 seconds of audio
context) and outputs a score per registered keyword. ONNX Runtime runs the inference in < 5 ms
on a modern CPU.

**Key property for Vibersyn's "Daybreak" spotter:** The library runs as a pure local inference
loop with no network calls. The audio processing is entirely on-device. It can be started/stopped
independently of the cloud ASR stream. The `model.predict()` method returns confidence scores
without emitting any transcript — exactly matching the §12 requirement that "it cannot transcribe,
route, suggest, or steer; it emits only `mute.released`."

### 2.4 Training a custom keyword

OpenWakeWord supports custom keywords via few-shot learning on synthetic training data generated
from text-to-speech. The documented pattern:

```python
# Training with synthetic audio (documented in README; requires separate training script)
from openwakeword.train import train_model
train_model(
    keyword="daybreak",
    positive_samples="path/to/daybreak_tts_samples/*.wav",  # TTS-generated
    negative_samples="path/to/noise_and_speech/",
    output_model="daybreak_model.onnx"
)
```

For Vibersyn, "Daybreak" would need a custom model. The library documents that 100–500
positive TTS-synthesized samples + standard negative sample set produces acceptable accuracy for
single-word triggers. **This claim must be validated against real accuracy figures before
shipping** — the probe should measure false-positive rate against a sample of typical team room
speech (technical vocabulary, overlapping voices) and false-negative rate against at least 50
spoken "Daybreak" samples at different distances and volumes.

### 2.5 Data flow and scope guard

```python
import openwakeword
model = openwakeword.Model(wakeword_models=["daybreak_model.onnx"], inference_framework="onnx")

# Audio input loop (runs while cloud stream is muted)
while muted:
    audio_chunk = mic.read(1280)  # 80ms @ 16kHz
    prediction = model.predict(audio_chunk)
    if prediction["daybreak"] > THRESHOLD:
        emit_event("mute.released", {trigger: "voice", latencyMs: measured})
        break  # Exit spotter loop; hand back to cloud ASR path
```

The spotter loop has exactly one exit condition: the confidence threshold. No other branch. This
matches the scope constraint in §12.1 ("spotter scope test — the spotter emits only `mute.released`;
assert it has no code path that can transcribe, route, or persist").

### 2.6 Testing strategy

OpenWakeWord ships with benchmark scripts in `tests/`:

1. **False-positive rate tests** (`test_false_positive_rate.py`): feed hours of neutral speech
   (LibriSpeech, common voice) through the model; count activations; report FP per hour.
   The library targets < 1 FP/hour on neutral speech; technical domain speech may differ.

2. **Accuracy tests**: feed ground-truth "Daybreak" spoken samples; measure recall. Library
   targets ≥ 90% recall at ≤ 1 FP/hour operating point.

3. **Latency benchmark**: measure `model.predict()` latency on target hardware. Documented < 5 ms
   on a modern CPU for a single keyword.

**What Vibersyn should copy:** same benchmark structure for the "Daybreak" probe —
measure recall and FP rate against real team-room audio, at the exact threshold value chosen,
before shipping. The probe IS the test; the passing criteria are named in the design.

---

## 3. Temporal TypeScript SDK (`temporalio/sdk-typescript`)

### 3.1 What it is

Temporal is an open-source durable execution engine. Its TypeScript SDK is the most direct
architectural analog for what Smithers implements: durable named processes that survive crashes,
accept external signals mid-run, can be queried, and replay deterministically from an event
history. Studying it teaches what the Vibersyn↔Smithers seam must accommodate.

### 3.2 Module structure

```
packages/
  worker/
    src/
      worker.ts          # Worker: polls task queues, dispatches workflow/activity tasks
      workflow-worker.ts # Isolates workflow code in a V8 sandbox for replay safety
  client/
    src/
      client.ts          # Client: start/signal/query/describe workflows
      workflow-handle.ts # WorkflowHandle: typed handle to a running workflow instance
  workflow/
    src/
      workflow.ts        # Workflow API: defineQuery, defineSignal, proxyActivities, sleep, etc.
      sinks.ts           # WorkflowSink: side-effects that are safe in the replay sandbox
  activity/
    src/
      activity.ts        # Activity context: heartbeat, cancel, retry policies
```

### 3.3 The signal pattern (maps to Smithers steer/pause/resume)

```typescript
// In the workflow definition (runs in the replay sandbox)
import { defineSignal, defineQuery, setHandler, condition, sleep } from '@temporalio/workflow';

const steerSignal = defineSignal<[SteerPayload]>('steer');
const pauseSignal = defineSignal<[]>('pause');
const resumeSignal = defineSignal<[]>('resume');
const statusQuery = defineQuery<Status>('status');

export async function agentWorkflow(seed: SeedPayload): Promise<RunResult> {
  let paused = false;
  let pendingSteer: SteerPayload | null = null;

  setHandler(steerSignal, (payload) => { pendingSteer = payload; });
  setHandler(pauseSignal, () => { paused = true; });
  setHandler(resumeSignal, () => { paused = false; });
  setHandler(statusQuery, () => computeStatus());

  while (!done) {
    await condition(() => !paused);        // blocks replay-safely on pause; resumes on signal
    if (pendingSteer) {
      await applySteer(pendingSteer);
      pendingSteer = null;
    }
    await runNextStep();
  }
}
```

The signal handler updates mutable state inside the workflow. `condition()` is a
**deterministic** blocking primitive — it replays correctly because it only depends on signal
history, not on wall-clock time or random values. This is exactly the pattern Smithers needs for
`pause/resume/steer`: the running agent blocks at `condition(!paused)` and unblocks when the
Cue adapter sends a signal.

**Key insight for the Cue↔Smithers seam:** Temporal's `signal` ↔ Smithers' `steer/signal` are
isomorphic. When Cue's `MappedActionTool` emits `{type: "steer", upid: "atlas", payload: "..."}`,
the Vibersyn dispatcher calls `smithersClient.signal(upid, "steer", payload)` — exactly as a
Temporal client calls `workflowHandle.signal(steerSignal, payload)`. The adapter owns this
translation; neither Cue nor Smithers knows about the other.

### 3.4 Child workflows (maps to Smithers fork)

```typescript
// Fork a child workflow (e.g., to run a sub-task in parallel)
import { executeChild, startChild } from '@temporalio/workflow';

// Fire-and-forget fork (does not block parent)
const childHandle = await startChild(subTaskWorkflow, {
  args: [{ parentId: workflowInfo().workflowId, ...forkPayload }],
  workflowId: `${parentId}-fork-${forkIndex}`,
});
// Parent continues immediately; child runs independently.
// Parent can signal the child: childHandle.signal(steerSignal, payload)
```

The child workflow has its own event history, its own callsign, and can be independently paused
or killed. This maps directly to Smithers' `fork` primitive — the design's §11.2 note that
"Fork may require a fresh seeded run + `parentId` lineage rather than a native fork" aligns with
Temporal: there is no native "clone state and branch"; you start a child with a fresh seed
derived from the parent's current state at the fork point.

### 3.5 Replay safety rules (critical for Vibersyn's record-replay requirement)

Temporal enforces **determinism inside the workflow sandbox**: no `Date.now()`, no `Math.random()`,
no direct network or disk I/O, no `setTimeout`. All non-deterministic operations are
**Activities** (sandboxed out of the workflow replay thread). The replay log (event history)
records every activity result; on replay, the result is returned from the log without re-running.

**What Vibersyn should copy:** the design's record-replay harness (§13.1) follows the same
principle — pre-recorded ASR JSONL replaces live Deepgram calls exactly as Temporal's event
history replaces live Activity results. The "same input → same output" guarantee requires that
the decision LLM's input is deterministic (temperature-0, pinned model) — matching Temporal's
"all non-determinism is in Activities."

### 3.6 Testing strategy

Temporal's SDK tests use two patterns:

1. **Replay tests** (`test/integration/workflows/`): record an event history from a real run;
   then replay it through the workflow code; assert the command sequence matches. This is the
   gold-standard for verifying that a change to the workflow code doesn't break existing runs.
   
2. **`TestWorkflowEnvironment` unit tests**: an in-process Temporal test environment that runs
   workflow code deterministically, with a controlled clock (`skipTime()`), mocked activities,
   and signal injection. Used for unit-testing signal handlers, timer behavior, and retry logic
   without a real Temporal server.

```typescript
import { TestWorkflowEnvironment } from '@temporalio/testing';

const env = await TestWorkflowEnvironment.createLocal();
const { client, nativeConnection } = env;
const worker = await Worker.create({ connection: nativeConnection, ... });

const handle = await client.workflow.start(agentWorkflow, { args: [seed], taskQueue: 'test' });
await handle.signal(steerSignal, { instruction: 'make it faster' });
await env.sleep('30s');  // advance mock clock
const result = await handle.result();
assert(result.applied === 'make it faster');
await env.teardown();
```

**What Vibersyn should copy:** use Smithers' test harness (equivalent of `TestWorkflowEnvironment`)
to inject steer signals, advance mock clocks (for the 25 s dead-man timer and 20 s steering-window
timeout), and assert the correct lifecycle transitions. The dead-man timer and steering-window
auto-close tests require a controllable clock — exactly as Temporal's `env.sleep()` provides.

---

## 4. Rhasspy 3 (`rhasspy/rhasspy`)

### 4.1 What it is

Rhasspy 3 is a complete open-source offline voice assistant framework. It defines a pipeline
of stages (VAD → ASR → Intent → Handle → TTS) with a pluggable provider model for each stage
and an event bus that connects them. It is the most complete open-source reference architecture
for a full voice assistant at the component-composition level, independent of Vibersyn's
specific AI approach.

### 4.2 Module structure

```
rhasspy/
  audio/
    __init__.py       # AudioChunk, AudioStart, AudioStop dataclasses; RATE/WIDTH/CHANNELS
    webrtc.py         # WebRTC VAD integration
  asr/
    __init__.py       # Transcript, Transcription dataclasses; AsrTranscriber ABC
    whisper.py        # WhisperTranscriber: batch Whisper inference
    faster_whisper.py # FasterWhisperTranscriber: streaming-compatible
  wake/
    __init__.py       # Detection, WakeWordDetector ABC
    porcupine.py      # PorcupineWakeWordDetector: Picovoice Porcupine integration
    openwakeword.py   # OpenWakeWordDetector: wraps OpenWakeWord (see §2)
    snowboy.py
  intent/
    __init__.py       # Intent, IntentRecognizer ABC; slot filling
    fsticuffs.py      # Finite-state transducer intent recognizer (deterministic)
  handle/
    __init__.py       # HandleResult; IntentHandler ABC
  tts/
    __init__.py       # Synthesis, TTSSynthesizer ABC
    larynx.py         # Local neural TTS
    piper.py          # Piper TTS (fast local neural TTS)
  program/
    __init__.py       # ProgramConfig, EventSettings; connects stages via asyncio queues
  server/
    __init__.py       # Wyoming protocol server (unified audio/event transport)
```

### 4.3 Data flow and event bus

Rhasspy 3 uses **Wyoming protocol** as its inter-component bus — a simple line-delimited JSON +
binary payload protocol over TCP/Unix sockets. Each stage is a separate process (or thread);
they communicate via Wyoming events:

```
[MicInput] → audio-chunk events → [VAD]
    → audio-start / audio-stop events → [WakeWordDetector]
    → detection event → [ASR]
    → transcript event → [IntentRecognizer]
    → intent event → [IntentHandler]
    → handle-result event → [TTS]
    → synthesis event → audio-chunk events → [SpeakerOutput]
```

Each component subscribes to the event bus, processes its event type, and emits the next event.
A component that has nothing to do emits nothing (the natural analog of `observe.pass` at the
pipeline level — the wake word detector emits a `detection` event only when a keyword is found;
otherwise it consumes audio chunks silently).

**Key insight for Vibersyn:** Rhasspy's `WakeWordDetector` ABC is exactly the interface
Vibersyn's on-device unmute spotter should implement. The ABC has:

```python
class WakeWordDetector:
    async def detect(self, audio_stream: AsyncIterable[AudioChunk]) -> Optional[Detection]:
        ...  # returns Detection(name=..., timestamp=...) or None (no match)
```

The `Optional[Detection]` return type enforces the scope constraint: the detector either finds
the keyword or finds nothing. It cannot emit anything else. Vibersyn's "Daybreak" spotter
can be modeled as a `WakeWordDetector` that only ever returns `Detection(name="daybreak")` or
`None` — zero other outputs.

### 4.4 Provider slot pattern (maps to Cue's provider slots)

Each stage in Rhasspy 3 is an ABC; the concrete implementation is chosen at startup by config.
The `program/__init__.py` wires them:

```python
@dataclass
class PipelineConfig:
    wake: WakeConfig          # which WakeWordDetector to load
    asr: AsrConfig            # which AsrTranscriber to load
    intent: IntentConfig
    handle: HandleConfig
    tts: TtsConfig
```

This is structurally identical to Cue's `CueHarness` provider slots:

```
Cue CueHarness({
  transcriptionProvider: ...,  # ← Rhasspy's AsrTranscriber slot
  llmProvider: ...,            # ← Rhasspy's IntentRecognizer slot
  outputProviders: [...],      # ← Rhasspy's TTS + Handle slots
})
```

The pattern teaches: **never hard-code a provider; always inject through a typed interface.** This
makes test providers trivial to write (inject a pre-recorded JSONL reader as the `transcriptionProvider`;
inject a no-op as the `outputProvider`) and keeps the system testable without real hardware.

### 4.5 Testing strategy

Rhasspy 3 tests (`tests/`) follow three patterns:

1. **Component unit tests** (`test_wake.py`, `test_asr.py`): construct a concrete provider with
   a test config; feed a pre-recorded `.wav` file; assert the emitted event matches expected. The
   `.wav` files live in `tests/audio/`. No live hardware. This is the reference for Vibersyn's
   ASR provider unit tests: record a sample of "Viber", "Curtain", "Daybreak", "Abort" spoken
   cleanly; assert the ASR transcribes them correctly; assert the cue policy fires on the correct
   trigger; assert it passes on near-homophones.

2. **Pipeline integration tests** (`test_pipeline.py`): construct a full `PipelineConfig` with
   real (but lightweight) providers; feed a recorded audio session; assert the end-to-end
   event sequence. Used to test that a VAD segment boundary triggers ASR correctly, that ASR
   output triggers intent recognition, etc. This maps to Vibersyn's §13.1 record-replay
   harness: inject a JSONL observation stream, assert the action sequence.

3. **Wyoming protocol tests** (`test_wyoming.py`): serialize and deserialize every event type;
   assert round-trip identity. This is the "trace-schema test" analog from Vibersyn §9.1 —
   every log event must round-trip cleanly so a debugging agent can deserialize any stored trace.

**Rhasspy's explicit non-audio test coverage:** the `tests/` directory includes
`test_text_pipeline.py` — a pipeline that runs from text input (simulating a pre-transcribed
utterance) through intent and handle stages, with no audio processing. This is the exact pattern
for Vibersyn's dispatch and routing unit tests: inject a text transcript observation; assert the
correct Cue decision fires; assert the correct Smithers action is dispatched. No audio needed.

---

## 5. Cross-cutting patterns — what all four codebases do

### 5.1 Typed frame/event dataclasses as the shared contract

All four codebases define a central set of typed dataclasses (or TypeScript interfaces) that
all components share:

- Pipecat: `frames/frames.py` — every frame type in one file
- OpenWakeWord: `Detection` with `keyword`, `score`, `timestamp`
- Temporal SDK: `WorkflowHandle<T>` typed on the workflow's result type
- Rhasspy: `AudioChunk`, `Transcript`, `Detection`, `Intent` — all defined in `__init__.py`
  of each stage package

**Vibersyn should define the shared contract up-front** in a single `types.ts` (or equivalent):
`TranscriptObservation`, `CueDecision`, `DispatchedAction`, `RunEvent`, and the log event union.
Every component imports from this file; changes to the schema are visible in one place.

### 5.2 Provider/transport abstraction as the test boundary

Every codebase puts a provider/transport interface at the outermost system boundary, then tests
everything inside that boundary without real I/O:

- Pipecat: mock the WebSocket transport; inject Frames
- OpenWakeWord: feed raw PCM arrays; no mic required in tests
- Temporal: `TestWorkflowEnvironment`; no real Temporal server
- Rhasspy: inject `.wav` files; no live mic; no real ASR API calls

**The test boundary is the provider interface.** For Vibersyn:
- `ASRProvider.stream()` is the boundary for all voice-pipeline tests
- `CueHarness` is the boundary for all observation-decision tests  
- Smithers `streamRunEvents()` is the boundary for all agent lifecycle tests
- The Vibersyn action dispatcher is the boundary for Cue↔Smithers seam tests

All tests below these boundaries can run headless, deterministically, without network.

### 5.3 Record-replay as the universal testing strategy for AI/audio

All four codebases use some form of record-replay:

- Pipecat: inject pre-built Frame sequences; assert downstream sequences
- OpenWakeWord: benchmark against pre-recorded audio clips; report FP/FN counts
- Temporal: record event history; replay through workflow code; assert command sequence
- Rhasspy: feed recorded `.wav` files through the full pipeline; assert event sequence

This is the universal pattern for testing non-deterministic or hardware-dependent systems:
**capture real inputs once; replay them deterministically many times.** Vibersyn's §13.1
harness is the same idea applied to ASR observations: record the real Deepgram output as JSONL;
replay it through the Cue decision layer at temperature-0; assert the action sequence.

### 5.4 Observability as a first-class pipeline stage

- Pipecat: a `MetricsFrame` is emitted by every service processor carrying latency and token
  counts; a `MetricsProcessor` can be inserted anywhere to capture them.
- Temporal: every workflow step is an Event in the event history; every signal, activity result,
  and timer are permanent records. No separate logging needed — the event history IS the trace.
- Rhasspy: every Wyoming event carries a `timestamp`; the Wyoming protocol itself is the trace
  log — serialize all events to disk for replay.

**Vibersyn's structured log (§13.3) should be a first-class pipeline stage,** not bolted on
after the fact. Every event that flows through the Cue harness should also flow through a
`TraceProcessor` that writes the structured JSONL line before emitting downstream. This ensures
no event is ever silently lost: `observe.pass` decisions appear in the trace (as Cue already
records them), latencyMs is measured at the pipeline stage boundary (as Pipecat's MetricsFrame
does), and the Temporal-style event history is the source of truth for causal-chain reconstruction.

---

## 6. Gaps — what these codebases do not cover

1. **Ambient suggestion engine with `observe.pass` as the common case.** No codebase has a
   native "decide whether to interrupt based on room-interrupt cost" primitive. Pipecat and
   Rhasspy always respond to every utterance; Temporal is workflow-triggered, not stream-triggered.
   Cue's `observe.pass` + `WordCountCue` + `IdleCue` is the novel contribution here.

2. **Multi-process named fleet management from voice.** Temporal supports child workflows, but
   the selection-by-name pattern (callsign → open steering window → route subsequent speech) has
   no direct OSS analog. The design's §5 is novel integration work.

3. **Earcon-vs-routing-ack two-layer non-verbal audio output.** No codebase implements the
   Layer A (tonal state earcons) + Layer B (non-tonal routing acks) distinction. The closest
   is Pipecat's frame type routing (AudioRawFrame vs TTSAudioRawFrame) but without the
   acoustic-categorization rule. Vibersyn must implement this from scratch.

4. **On-device unmute spotter with a hard scope fence.** OpenWakeWord provides the detection
   capability; the scope fence (exactly one event type, no transcription path) is enforced by
   Vibersyn's integration layer, not by the library. The integration test (`spotter scope test`
   in §12.1) has no direct prior art to copy — it must be written fresh.

---

## 7. Decisions recorded

- **Frame/event-typed shared contract first.** Define `types.ts` before any implementation.
  All four codebases converge on this; the pain of ad-hoc event shapes is documented in
  Rhasspy's early release notes and Pipecat's migration guides.
  
- **Provider interface is the test boundary.** All component tests mock at the provider
  interface, not at the network level. Vibersyn's `ASRProvider`, `TTSProvider`, and Smithers
  client should each have a test double injectable at construction time.

- **Record-replay JSONL is the correct test strategy for the Cue layer.** Confirmed by all
  four codebases; Vibersyn's §13.1 harness is the correct design.

- **Earcon dispatch must bypass all network paths.** Pipecat's Frame routing shows that
  pre-rendered PCM can be injected directly at the transport output stage, bypassing TTS. Use
  this pattern for the ≤300 ms earcon path in Vibersyn.

- **Temporal's `TestWorkflowEnvironment` is the reference for Smithers lifecycle tests.** Clock
  control (`env.sleep`), signal injection (`handle.signal`), and query assertions are the same
  primitives Vibersyn needs for testing the dead-man timer (25 s) and steering-window
  auto-close (20 s idle). Whatever Smithers offers for test doubles, it should support these
  three operations.

- **OpenWakeWord is the correct foundation for the "Daybreak" on-device spotter.** It meets
  the §12 requirements (fully local, no transcript, configurable threshold, refractory period).
  Custom keyword training is supported and documented. The spotter probe must measure FP rate on
  real team-room speech before this is accepted.

---

## Sources

- https://github.com/pipecat-ai/pipecat — Pipecat source (Python, Apache 2.0)
- https://github.com/dscripka/openWakeWord — OpenWakeWord source (Python, Apache 2.0)
- https://github.com/temporalio/sdk-typescript — Temporal TypeScript SDK (MIT)
- https://github.com/rhasspy/rhasspy — Rhasspy 3 source (Python, MIT)
- https://docs.pipecat.ai/guides/fundamentals/pipeline-architecture — Pipecat pipeline architecture docs
- https://github.com/dscripka/openWakeWord/blob/main/README.md — OpenWakeWord README
- https://docs.temporal.io/develop/typescript/core-application — Temporal TypeScript workflow docs
- https://github.com/rhasspy/wyoming — Wyoming protocol spec
- docs/planning/02-design.md (upstream design document)
- artifacts/smithering/research/prior-art.md (upstream OSS survey)
- artifacts/smithering/research/domain.md (upstream domain research)
