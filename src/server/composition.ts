import { AcceptanceClassifier } from "../acceptance/classifier";
import { PendingSuggestionOwner } from "../acceptance/pending";
import { AcceptanceController, AcceptanceSpawner, createProcessRegistryAcceptanceSeam } from "../acceptance/spawn";
import { MuteController } from "../audio/mute-controller";
import { playAck, playEarcon, type AudioOutput, type PcmClip } from "../audio/earcons";
import { ttsDecision } from "../audio/output-policy";
import { CueAdapter } from "../cue/adapter";
import { createCueBridge, type CueBridge, type CueBridgeMode } from "./cue-bridge";
import { EMERGENCY_STOP_LATENCY_BUDGET_MS, EmergencySessionState, EmergencyStopController } from "../emergency/stop";
import { TraceProcessor } from "../obs/trace";
import { ProcessRegistry, type RegistryProcess } from "../process/registry";
import { GatewayRegistryClient, selectSmithersClient, type RegistrySmithersClient } from "./smithers-select";
import { buildDegradationNotice, type DegradationNotice, type SmithersClientMode } from "./degradation-notice";
import { RunEventDriver, type RunEventStreamClient } from "./run-event-driver";
import type { GatewayRpcTransport, SmithersClient } from "../seam/smithers-client";
import type { AcceptanceSpawnResult } from "../acceptance/spawn";
import { selectAsrProvider, selectDecisionLLM, selectTtsProvider, type ASRProvider, type AsrProviderMode, type DecisionLLM } from "../providers";
import type { ClaudeMessagesTransport, ReplayASRSource, TTSProvider, TTSTransport, VoxTermSegmentSource } from "../providers";
import { drainTtsStream, type TtsAudioSink } from "./tts-sink";
import { selectAudioSink, type AudioSink, type AudioSinkMode } from "./audio-device-sink";
import { IdleCueDriver } from "./idle-cue-driver";
import { IdeaBuildRegistry, type BuilderAgent } from "./idea-builder";
import {
  readSuggestionEngineConfig,
  SuggestionEngine,
  type PendingQueuedSuggestion,
  type SuggestionEngineConfig,
  type SuggestionEngineDecision,
} from "../suggest/engine";
import { DetectionRunner, selectDetectionRunner, type DetectionSnapshot } from "./detection-runner";
import { DETECTION_BUBBLE_TTL_MS, pendingSuggestionFromCandidate, projectorSuggestionFromCandidate } from "./idea-suggestion";
import type { IdeaDetector } from "../detect";
import { StageSequencer, type CanonicalStage } from "../spine/stage-sequencer";
import type { LogEvent, OutputDecision, PendingSuggestion } from "../types";
import { demoProjectorSnapshot, emptyProjectorSnapshot, withUnmuted } from "../ui/demo-data";
import type { ProjectorProcess, ProjectorProcessState, ProjectorSnapshot, ProjectorSuggestion, TranscriptLine } from "../ui/types";
import type { TranscriptObservation } from "../types";

export type ProjectorRuntimeSubscriber = (snapshot: ProjectorSnapshot) => void;

// A live browser-microphone session. The /api/mic WebSocket pushes raw PCM
// frames in via `pushAudio`; the runtime streams them through the ASR provider
// and surfaces resulting transcript lines on the projector snapshot.
export interface MicSession {
  readonly id: string;
  pushAudio(chunk: Uint8Array): void;
  stop(): Promise<void>;
}

// Keep at most this many committed (final) transcript lines on the snapshot so a
// long-running room session does not grow the published payload without bound.
const MAX_LIVE_TRANSCRIPT_LINES = 40;

export interface ProjectorRuntimeEnv {
  DEEPGRAM_API_KEY?: string;
  VIBERSYN_SESSION_ID?: string;
  VIBERSYN_INITIAL_MUTED?: string;
  // Opt-in: seed the FIXTURE demo fleet (Atlas/Cobalt) into the live registry at
  // boot. OFF by default so an idle live runtime has zero processes; set to "1"
  // for the projector demo (`bun run start`) / tests that exercise the fleet.
  VIBERSYN_SEED_DEMO_FLEET?: string;
  [key: string]: string | undefined;
}

export interface ProjectorRuntime {
  readonly sessionId: string;
  readonly asrMode: AsrProviderMode;
  readonly micMode: AsrProviderMode;
  readonly asr: ASRProvider;
  readonly tts: TTSProvider;
  readonly cueAdapter: CueAdapter;
  // Which Cue wake/earcon path is active (GAP-006). `null` only before the async
  // bridge selection runs; `createProjectorRuntime` always resolves it.
  readonly cueBridgeMode: CueBridgeMode | null;
  // Structured startup degradation notice (GAP-002): which legs resolved to a
  // stubbed/offline backend and how to upgrade each. Logged at boot and surfaced
  // on /api/health so a degraded deployment is explicit, not silent.
  readonly degradation: DegradationNotice;
  readonly muteController: MuteController;
  readonly suggestionEngine: SuggestionEngine;
  // Ambient idea detection (replaces the word/time gate): windowed model inference
  // over the rolling transcript that surfaces grounded idea candidates. Drives the
  // idea bubble, click-to-build, and auto-build.
  readonly detection: DetectionRunner;
  readonly acceptanceController: AcceptanceController;
  readonly registry: ProcessRegistry;
  readonly stageSequencer: StageSequencer;
  readonly trace: TraceProcessor;
  readonly emergencyController: EmergencyStopController;
  // Polls the room-idle gap to deliver a deferred (high interrupt cost) suggestion
  // once the room falls quiet (ISSUE-0024). The server boundary calls start();
  // tests drive tick() deterministically off the injected clock.
  readonly idleCueDriver: IdleCueDriver;
  // Subscribes each spawned run to the gateway's live event stream and folds the
  // frames into a per-UPID overlay that the process panel reads (ISSUE-0021), so
  // a live run shows real progress/lastOutput/state instead of demo fixtures.
  readonly runEventDriver: RunEventDriver;
  // Real accept->build->preview registry: each voice-accepted idea scaffolds a
  // runnable artifact + a live preview server, tracked here per UPID so the
  // snapshot can surface previewUrl/buildStatus and lifecycle can tear it down.
  readonly ideaBuilds: IdeaBuildRegistry;
  // The most recent decision the SuggestionEngine returned for a live final
  // observation (null before the first one). ISSUE-0009/0010 read this — plus
  // `pendingSuggestion()` — to drive delivery/acceptance off the live runtime.
  readonly lastSuggestionDecision: SuggestionEngineDecision | null;
  pendingSuggestion(): PendingQueuedSuggestion | null;
  snapshot(): ProjectorSnapshot;
  subscribe(subscriber: ProjectorRuntimeSubscriber): () => void;
  unmute(correlationId?: string): Promise<ProjectorSnapshot>;
  emergencyStop(correlationId?: string): Promise<ProjectorSnapshot>;
  startMicSession(correlationId?: string): MicSession;
  // Click-to-build (CLICK THE IDEA BUBBLE -> BUILD): accept the CURRENT pending
  // suggestion directly, bypassing the spoken AcceptanceClassifier/semantic gate,
  // by spawning through the same accept path (build:true) so ideaBuilds.build runs
  // and a process with previewUrl/buildStatus appears on the snapshot. A no-op
  // returning the current snapshot when there is no pending suggestion.
  acceptPendingSuggestion(correlationId?: string): Promise<ProjectorSnapshot>;
  // Click-to-steer (CLICK A PROJECT -> STEER IT): set the steering target UPID so
  // subsequent live FINAL transcript lines route to THAT process's agent loop
  // (registry.steer) instead of seeding a fresh ambient suggestion.
  setSteeringTarget(upid: string, correlationId?: string): ProjectorSnapshot;
  // Clear the steering target; live transcript returns to ambient suggestion +
  // click-to-build behavior.
  clearSteeringTarget(correlationId?: string): ProjectorSnapshot;
  steeringTarget(): string | null;
  // AUTO-BUILD toggle (no click required): when on, every fired suggestion is
  // accepted+built the instant it pops.
  setAutoAccept(on: boolean, correlationId?: string): ProjectorSnapshot;
  autoAccept(): boolean;
}

interface SeededProcessView {
  upid: string;
  runId: string;
  callsign: string;
  task: string;
  model: string;
  progressLabel: string;
  progress: number;
  lastOutput: string;
  events: string[];
}

export interface ProjectorRuntimeOptions {
  // Injects a gateway RPC transport for the Smithers client (tests/e2e drive the
  // gateway path with a stub transport; production builds the real one from env).
  smithersTransport?: GatewayRpcTransport;
  // Injectable ASR sources for the registry-selected backends (tests/e2e feed a
  // synthetic feed with no mic/process/network). `voxtermSource` drives the
  // voxterm backend; `replaySource` (observations array or jsonl path) drives the
  // replay backend. Both flow to the ambient + live-mic providers.
  voxtermSource?: VoxTermSegmentSource;
  replaySource?: ReplayASRSource;
  // Injectable Anthropic transport for the auto-selected Claude decider, so a
  // credential-present runtime can be exercised in tests/e2e with no network.
  decisionTransport?: ClaudeMessagesTransport;
  // Injectable ElevenLabs streaming transport (ISSUE-0022), so a runtime with
  // VIBERSYN_TTS_PROVIDER=elevenlabs can drain a stubbed synthesized stream in
  // tests/e2e with no network or audio device.
  ttsTransport?: TTSTransport;
  // Injectable real audio sink (ISSUE-0026). When provided it backs BOTH the
  // earcon playPcm path and the TTS drain sink, so a test/the browser-broadcast
  // path (ISSUE-0027) can substitute a sink that actually retains the audible
  // bytes. Unset, the runtime falls back to selectAudioSink(env) — the silent
  // no-op sink unless VIBERSYN_AUDIO_SINK=device.
  audioSink?: AudioSink;
  // Injectable monotonic clock (ISSUE-0024). The whole runtime — including the
  // room-idle gap that drives deferred-suggestion delivery — reads time through
  // this, so tests advance silence deterministically instead of waiting on the
  // wall clock. Defaults to Date.now.
  clock?: () => number;
  // Root directory the real accept->build->preview artifacts are scaffolded under
  // (idea-builder). Defaults to <cwd>/builds. Tests point it at a temp dir so the
  // repo tree stays clean and each run is isolated.
  buildsRoot?: string;
  // The real coding agent that turns an accepted idea's scaffold into a working
  // app (idea-builder). Defaults to the host `claude` CLI builder. Tests inject a
  // synthetic builder so no real `claude` spawn occurs.
  builderAgent?: BuilderAgent;
  // Injectable idea detector (the inference that decides whether a buildable idea
  // was proposed and which span of conversation it came from). Production selects
  // host-`claude` inference, or the durable Smithers `idea-detection` run when a
  // gateway is configured. Tests inject a scripted/heuristic detector so detection
  // is deterministic with no model spawn.
  ideaDetector?: IdeaDetector;
}

export async function createProjectorRuntime(
  env: ProjectorRuntimeEnv = process.env,
  options: ProjectorRuntimeOptions = {},
): Promise<ProjectorRuntime> {
  const sessionId = env.VIBERSYN_SESSION_ID ?? emptyProjectorSnapshot.sessionId;
  const runtime = new LiveProjectorRuntime(sessionId, env, options);
  await runtime.initCueBridge();
  // The seeded demo fleet (FIXTURE Atlas/Cobalt processes) is OFF by default in
  // the live server: an idle runtime must have ZERO processes until a real idea
  // is accepted and spawns one. It stays available for tests/demo via the opt-in
  // VIBERSYN_SEED_DEMO_FLEET=1 flag.
  if (env.VIBERSYN_SEED_DEMO_FLEET === "1") {
    await runtime.seedDemoFleet();
  }
  runtime.startAcceptanceWatchdog();

  if (env.VIBERSYN_INITIAL_MUTED !== "0") {
    await runtime.muteForInitialState();
  }

  runtime.publish();
  return runtime;
}

class LiveProjectorRuntime implements ProjectorRuntime {
  readonly asrMode: AsrProviderMode;
  readonly micMode: AsrProviderMode;
  readonly degradation: DegradationNotice;
  readonly asr: ASRProvider;
  readonly #micAsr: ASRProvider;
  // Selected by env (Noop default — silent-but-recorded, no key/network/device).
  // ISSUE-0013 replaces the former hardcoded NoopTTSProvider so the live loop
  // actually drives a spoken path on suggestion delivery and spawn ack (GAP-005).
  readonly tts: TTSProvider;
  // Earcon/ack PCM output for the stage-sequencer audio path. It adapts each
  // prerendered clip onto the selected audio sink (ISSUE-0026), so an injected
  // recording/device sink actually retains the played earcon bytes.
  readonly #audio: AudioOutput;
  // Device sink for synthesized TTS bytes — the SAME selected sink the earcon
  // path writes to (ISSUE-0026). The drained stream is read (forcing synthesis to
  // completion) and routed here; the no-op default drops it, a device sink keeps it.
  readonly #ttsSink: TtsAudioSink;
  readonly cueAdapter: CueAdapter;
  readonly #decisionLlm: DecisionLLM;
  #cueBridge: CueBridge | null = null;
  readonly muteController: MuteController;
  readonly suggestionEngine: SuggestionEngine;
  // Ambient idea detection (replaces the word/time gate): windowed model inference
  // over the rolling transcript that surfaces grounded idea candidates. Drives the
  // idea bubble, click-to-build, and auto-build.
  readonly detection: DetectionRunner;
  readonly acceptanceController: AcceptanceController;
  readonly registry: ProcessRegistry;
  readonly stageSequencer: StageSequencer;
  readonly trace: TraceProcessor;
  readonly emergencyController: EmergencyStopController;
  readonly idleCueDriver: IdleCueDriver;
  readonly runEventDriver: RunEventDriver;
  readonly ideaBuilds: IdeaBuildRegistry;
  readonly #clock: () => number;
  readonly #session: EmergencySessionState;
  readonly #env: ProjectorRuntimeEnv;
  readonly #subscribers = new Set<ProjectorRuntimeSubscriber>();
  readonly #outputs: OutputDecision[] = [];
  readonly #demoProcesses: SeededProcessView[];
  #snapshot: ProjectorSnapshot = emptyProjectorSnapshot;
  #emergencyTriggered = false;
  // Live microphone state. `#liveFinals` are committed (final) ASR lines;
  // `#interim` is the in-flight partial that Deepgram revises as you speak.
  #liveFinals: TranscriptLine[] = [];
  #interim: TranscriptLine | null = null;
  #micActive = false;
  #micBytes = 0;
  #micLastPublishMs = 0;
  #acceptanceWatchdog: ReturnType<typeof setInterval> | null = null;
  // Ambient-suggestion state, fed by FINAL observations only. `#lastSuggestionDecision`
  // is the latest engine verdict; `#lastFinalAtMs` lets us report room-idle gap.
  #lastSuggestionDecision: SuggestionEngineDecision | null = null;
  #lastFinalAtMs: number | null = null;
  // Click-to-steer target (CLICK A PROJECT -> STEER IT). When non-null, live FINAL
  // transcript lines are routed to this process's agent loop via registry.steer
  // instead of seeding a fresh ambient suggestion. Set/cleared by the projector
  // click endpoints; cleared automatically if the target stops being live.
  #steeringUpid: string | null = null;
  // AUTO-BUILD toggle. When true, every fired suggestion is accepted+built the
  // instant it pops — no click required. Operator flips it from the projector
  // (POST /api/auto-accept) or boots with VIBERSYN_AUTO_ACCEPT=1. A re-entrancy guard
  // (#autoAcceptInFlight) keeps a slow build from stacking a second auto-accept.
  #autoAccept = false;
  #autoAcceptInFlight = false;
  // Idea detection wiring. `#detectionMode` records which backend was selected
  // (host-claude | heuristic | smithers | injected) for the degradation notice;
  // `#detectionPrimaryId` is the candidate currently surfaced as the bubble (so a
  // newly-ready idea is delivered/queued exactly once); `#pendingOwner` is the
  // acceptance pending sink a surfaced idea is fed into so spoken/click/auto accept
  // all act on a consistent suggestion.
  readonly #detectionMode: string;
  #detectionPrimaryId: string | null = null;
  readonly #pendingOwner: PendingSuggestionOwner;

  constructor(
    readonly sessionId: string,
    env: ProjectorRuntimeEnv,
    options: ProjectorRuntimeOptions = {},
  ) {
    this.#env = env;
    const clock = options.clock ?? (() => Date.now());
    this.#clock = clock;
    // Single audible-output sink seam (ISSUE-0026): an injected sink wins, else
    // selectAudioSink(env) (no-op unless VIBERSYN_AUDIO_SINK=device). The one sink
    // backs both the earcon playPcm path and the TTS drain so a fired suggestion's
    // synthesized PCM and a spawn earcon land in the same place.
    const audioSinkSelection = selectAudioSink(env);
    // An injected sink (test/browser-broadcast) is a real audible path, not the no-op.
    const sinkMode: AudioSinkMode = options.audioSink ? "device" : audioSinkSelection.mode;
    const audioSink = options.audioSink ?? audioSinkSelection.sink;
    this.#audio = new BufferedAudioOutput(audioSink);
    this.#ttsSink = audioSink;
    const ttsSelection = selectTtsProvider(env, { transport: options.ttsTransport });
    this.tts = ttsSelection.provider;
    this.trace = new TraceProcessor({ clock });
    this.#demoProcesses = demoProjectorSnapshot.processes.map((process) => ({ ...process }));
    this.#session = new EmergencySessionState({ sessionId, listening: true, muted: false });
    this.muteController = new MuteController({
      sessionId,
      now: clock,
      onTrace: (event) => this.recordExternalTrace(event),
      onOutput: (decision) => this.recordOutput(decision),
    });

    // Single ASR selection seam (ISSUE-0016): VIBERSYN_ASR_PROVIDER picks the backend
    // (deepgram|voxterm|replay), defaulting to Deepgram when DEEPGRAM_API_KEY is
    // present and replay otherwise. Tests inject a voxterm/replay source.
    const selectedAsr = selectAsrProvider(env, {
      sessionId,
      voxtermSource: options.voxtermSource,
      replaySource: options.replaySource,
    });
    this.asrMode = selectedAsr.mode;
    this.asr = this.muteController.protectCloudAsr(selectedAsr.provider);

    // A second, long-lived ASR provider dedicated to the live browser mic. The mic
    // profile lifts the Deepgram close-timer so a long room session is not cut off
    // mid-stream. It is mute-protected too, so a muted room never streams audio to
    // the cloud. The replay source falls back to VIBERSYN_MIC_REPLAY_PATH so the live
    // mic path stays deterministically drivable offline.
    const selectedMicAsr = selectAsrProvider(env, {
      sessionId,
      micProfile: true,
      voxtermSource: options.voxtermSource,
      replaySource: options.replaySource ?? env.VIBERSYN_MIC_REPLAY_PATH,
    });
    this.micMode = selectedMicAsr.mode;
    this.#micAsr = this.muteController.protectCloudAsr(selectedMicAsr.provider);
    this.cueAdapter = new CueAdapter({
      sessionId,
      trace: this.trace,
      clock,
      textCueWords: ["viber"],
      // Tag the fallback adapter so its earcon trace is distinguishable from the
      // upstream harness adapter's when operators inspect the live trace (GAP-006).
      earconPath: "fallback",
    });
    // Real decider selected by env (ISSUE-0023): the Claude decider auto-selects
    // when a model credential resolves, else the no-key heuristic. The single
    // selected instance is shared by the SuggestionEngine scoring, the acceptance
    // intent-gate, and the Cue harness fast-path bridge.
    const decisionSelection = selectDecisionLLM(env, { claudeTransport: options.decisionTransport });
    this.#decisionLlm = decisionSelection.llm;
    // Single Smithers-client swap point (GAP-004). With no gateway config the
    // projector demo (`bun run start`) drives an in-memory client — the seeded
    // fleet are deterministic fixtures, not real runs, so halting them in memory
    // is correct. When VIBERSYN_SMITHERS_GATEWAY_URL (or an injected transport) is
    // present, selectSmithersClient returns a gateway-backed client that routes
    // spawn/halt to a real Smithers gateway over its RPC transport.
    const smithersClient = selectSmithersClient(env, { transport: options.smithersTransport });
    const smithersMode: SmithersClientMode = smithersClient instanceof GatewayRegistryClient ? "gateway" : "memory";
    // Structured degradation notice computed from the resolved per-leg selections
    // (GAP-002). The live mic ASR is the leg that gates real transcription.
    this.degradation = buildDegradationNotice({
      asr: this.micMode,
      tts: ttsSelection.mode,
      sink: sinkMode,
      decider: decisionSelection.mode,
      smithers: smithersMode,
    });
    // Real accept->build->preview registry. A voice-accepted idea spawns a
    // process AND scaffolds a runnable artifact served live from builds/<upid>/.
    // The runtime owns the instance (pointing builds at a test-safe root) and
    // shares it with the registry, which triggers the build on an accept-path
    // spawn (build:true — the demo seed spawns bare and never builds) and tears
    // the preview server down on halt.
    this.ideaBuilds = new IdeaBuildRegistry({
      buildsRoot: options.buildsRoot,
      builderAgent: options.builderAgent,
    });
    this.registry = new ProcessRegistry({
      client: smithersClient,
      sessionId,
      now: clock,
      ideaBuilds: this.ideaBuilds,
      // A halted/emergency-stopped process drops its preview; republish so the
      // "Preview ->" link disappears from the snapshot immediately. If the halted
      // process was the steering target, drop the target so transcript stops
      // routing into a dead process and returns to ambient handling.
      onHalt: (upid) => {
        if (this.#steeringUpid === upid) {
          this.#steeringUpid = null;
        }
        this.publish();
      },
      onTrace: (event) => this.recordExternalTrace(event),
      onOutput: (decision) => this.recordOutput(decision),
    });
    // Live run telemetry into the process panel (ISSUE-0021). The driver streams
    // off the same selected Smithers client the registry spawns through; on each
    // overlay change it republishes so the snapshot reflects live progress. In the
    // in-memory default the stream is empty, so the seeded fleet keeps its fixtures.
    this.runEventDriver = new RunEventDriver({
      client: runEventStreamClient(smithersClient),
      onUpdate: () => this.publish(),
    });

    // Click-to-build: a delivered suggestion bubble must persist long enough to
    // CLICK it, not self-destruct in ~10s (the old voice-"yes" no-answer window).
    // The watchdog still eventually expires an ignored bubble so the loop never
    // wedges, but the window is now long and configurable (default 120s; total
    // clear time is ~2x this due to the requeue-once expiry). VIBERSYN_ACCEPT_WINDOW_SECONDS=0
    // restores the legacy short default.
    const acceptWindowSeconds = Number(env.VIBERSYN_ACCEPT_WINDOW_SECONDS ?? "120");
    const noAnswerTimeoutMs = Number.isFinite(acceptWindowSeconds) && acceptWindowSeconds > 0
      ? Math.round(acceptWindowSeconds * 1000)
      : undefined;
    this.#autoAccept = env.VIBERSYN_AUTO_ACCEPT === "1" || env.VIBERSYN_AUTO_ACCEPT === "true";
    const pending = new PendingSuggestionOwner({ clock, noAnswerTimeoutMs });
    this.#pendingOwner = pending;
    const acceptanceSeam = createProcessRegistryAcceptanceSeam(this.registry);
    const spawner = new AcceptanceSpawner({
      seam: acceptanceSeam,
      sessionId,
      clock,
      activeProcessCount: () => this.registry.activeRecords().length,
      onTrace: (event) => this.recordExternalTrace(event),
      onOutput: (decision) => this.recordOutput(decision),
    });
    this.acceptanceController = new AcceptanceController({
      pending,
      // The same selected decider backs the acceptance intent-gate (ISSUE-0023),
      // so spoken accept/decline classification gets the same model-quality
      // semantic judgement the SuggestionEngine uses to score ideas.
      classifier: new AcceptanceClassifier({ pending, semanticIntentGate: { llm: this.#decisionLlm } }),
      spawner,
    });
    this.suggestionEngine = new SuggestionEngine({
      sessionId,
      trace: this.trace,
      clock,
      // Replaces the former always-pass demo stub so live finals get real decisions.
      llm: this.#decisionLlm,
      acceptanceOwner: {
        acceptSuggestion: (suggestion: PendingSuggestion) => {
          pending.acceptSuggestion(suggestion);
        },
      },
      env,
    });
    this.stageSequencer = new StageSequencer({
      sessionId,
      trace: this.trace,
      clock,
      // Mirrors the canonical.ts emitOutput pattern: every audible stage
      // transition is recorded in #outputs AND routed through the audio/tts path
      // so earcons play, the spoken ack reaches this.tts.speak, and audioSnapshot
      // reflects lastSpoken/earcon (GAP-005/GAP-008).
      onOutput: (decision, transition) => this.emitOutput(decision, transition.correlationId),
    });
    this.emergencyController = new EmergencyStopController({
      registry: this.registry,
      listener: this.#session,
      sessionId,
      now: clock,
      onTrace: (event) => this.recordExternalTrace(event),
      onOutput: (decision) => this.recordOutput(decision),
    });
    // Room-idle delivery of deferred suggestions (ISSUE-0024). The driver reads
    // the same clock and #lastFinalAtMs the suggestion path stamps, so the
    // measured silence is exact. On a 'fired' idle decision it speaks the
    // suggestion through the same SUGGESTION_DELIVERY path a live fire takes.
    this.idleCueDriver = new IdleCueDriver({
      engine: this.suggestionEngine,
      sessionId,
      clock,
      env,
      lastFinalAtMs: () => this.#lastFinalAtMs,
      onDecision: (decision) => this.deliverIdleDecision(decision),
    });

    // Idea detection replaces the word/time gate as the source of idea bubbles. It
    // runs windowed model inference over the rolling transcript and surfaces
    // grounded candidates. With a Smithers gateway configured it runs as the
    // durable `idea-detection` run; otherwise host-`claude` inference runs inline.
    // Tests inject a deterministic detector so no model spawns.
    const detectionSmithersClient =
      smithersClient instanceof GatewayRegistryClient ? smithersClient.client : undefined;
    const detectionSelection = selectDetectionRunner({
      sessionId,
      env,
      clock,
      detector: options.ideaDetector,
      smithersClient: detectionSmithersClient,
      tickIntervalMs: Number(env.VIBERSYN_DETECT_TICK_MS ?? "1000"),
      onUpdate: (snapshot) => this.onDetectionUpdate(snapshot),
      onTrace: (event) => this.recordExternalTrace(event),
      onError: (error) =>
        this.recordExternalTrace({
          event: "detect.error",
          level: "error",
          sessionId,
          meta: { message: error instanceof Error ? error.message : String(error) },
        }),
    });
    this.detection = detectionSelection.runner;
    this.#detectionMode = detectionSelection.mode;
  }

  snapshot(): ProjectorSnapshot {
    return this.#snapshot;
  }

  get lastSuggestionDecision(): SuggestionEngineDecision | null {
    return this.#lastSuggestionDecision;
  }

  get cueBridgeMode(): CueBridgeMode | null {
    return this.#cueBridge?.mode ?? null;
  }

  // Select the Cue wake/earcon path once at startup (GAP-006): the upstream Cue
  // harness fast-path when a build is present, otherwise the deterministic
  // in-runtime CueAdapter fallback. Selection never throws — a missing build (or
  // a harness that fails to construct) degrades gracefully to the fallback.
  async initCueBridge(): Promise<void> {
    this.#cueBridge = await createCueBridge({
      sessionId: this.sessionId,
      providers: { transcription: this.asr, llm: this.#decisionLlm, output: this.tts },
      fallbackAdapter: this.cueAdapter,
      textCueWords: ["viber"],
      trace: this.trace,
      clock: () => Date.now(),
    });
  }

  pendingSuggestion(): PendingQueuedSuggestion | null {
    return this.suggestionEngine.pending();
  }

  subscribe(subscriber: ProjectorRuntimeSubscriber): () => void {
    this.#subscribers.add(subscriber);
    try {
      subscriber(this.#snapshot);
    } catch {
      // The initial send failed (e.g. the SSE stream closed during connect) —
      // don't leave a dead subscriber registered until the next publish prunes it.
      this.#subscribers.delete(subscriber);
    }
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  async unmute(correlationId = `corr-unmute-${crypto.randomUUID()}`): Promise<ProjectorSnapshot> {
    if (this.#emergencyTriggered) {
      this.#snapshot = this.buildSnapshot();
      this.publish();
      return this.#snapshot;
    }

    await this.muteController.releaseFromButton({ correlationId });
    this.#session.startFreshSession();
    this.#snapshot = withUnmuted(this.buildSnapshot());
    this.publish();
    return this.#snapshot;
  }

  async emergencyStop(correlationId = `corr-emergency-${crypto.randomUUID()}`): Promise<ProjectorSnapshot> {
    // The emergency state is sticky: once flipped, the projector must reflect a
    // stopped session even if a downstream halt is slow, rejects, or throws.
    this.#emergencyTriggered = true;
    try {
      await this.muteController.engage({ correlationId });
      const result = await this.emergencyController.trigger(correlationId);
      if (!result.ok) {
        console.warn(
          `Emergency stop did not fully confirm within budget (halted=${result.processesHalted}, latencyMs=${result.latencyMs}, budgetMs=${EMERGENCY_STOP_LATENCY_BUDGET_MS}, correlationId=${correlationId}).`,
        );
      }
    } catch (error) {
      console.error("Emergency stop encountered an error while halting processes:", error);
    } finally {
      // Tear down every live accept->build->preview server as part of the kill-all
      // (per-process halt already stops its own; this also reaps any in-flight or
      // not-yet-halted build so no loopback preview outlives the session).
      await this.ideaBuilds.stopAll().catch(() => undefined);
      // Drop any in-flight idea candidates so the bubble clears with the kill-all.
      this.detection.clear();
      this.#detectionPrimaryId = null;
      this.#snapshot = this.buildSnapshot();
      this.publish();
    }
    return this.#snapshot;
  }

  // CLICK THE IDEA BUBBLE -> BUILD. Accept the CURRENT pending suggestion directly,
  // bypassing the spoken AcceptanceClassifier/semantic gate, by spawning through
  // the same accept path the spoken "yes" takes (the ProcessRegistry seam's
  // build:true spawn), so the existing idea-builder (ideaBuilds.build) runs and a
  // process with previewUrl/buildStatus appears on the snapshot. A no-op returning
  // the current snapshot when there is no pending suggestion.
  async acceptPendingSuggestion(
    correlationId = `corr-accept-click-${crypto.randomUUID()}`,
  ): Promise<ProjectorSnapshot> {
    if (this.#emergencyTriggered) {
      return this.#snapshot;
    }
    // Accept the surfaced idea: prefer the acceptance pending set when the idea was
    // surfaced; if it already expired but a bubble is still on screen, convert the
    // live detection primary so a visible bubble is ALWAYS clickable.
    const primary = this.detection.primary();
    let suggestion = this.acceptanceController.currentPending();
    if (suggestion === null && primary !== null) {
      suggestion = pendingSuggestionFromCandidate(primary, correlationId, this.#clock() + DETECTION_BUBBLE_TTL_MS);
    }
    if (suggestion === null) {
      // Nothing on screen to accept — the click is a no-op; return the live snapshot.
      return this.#snapshot;
    }
    this.recordExternalTrace({
      event: "suggestion.accept.click",
      level: "info",
      sessionId: this.sessionId,
      correlationId,
      meta: { suggestionId: suggestion.suggestionId, pitch: suggestion.pitch },
    });
    try {
      const spawn = await this.acceptanceController.spawnAccepted(suggestion, correlationId);
      if (spawn.accepted) {
        // Consume the accepted candidate so detection doesn't re-surface it, and
        // clear the on-screen bubble — the idea became a process.
        const acceptedId = candidateIdFromSuggestionId(suggestion.suggestionId) ?? primary?.id ?? null;
        if (acceptedId !== null) {
          this.detection.accept(acceptedId);
        }
        this.#detectionPrimaryId = null;
        await this.spawnAck(spawn, correlationId);
        this.subscribeRunEvents(spawn.process.upid, spawn.process.runId);
      }
    } catch (error) {
      this.recordExternalTrace({
        event: "suggestion.accept.error",
        level: "error",
        sessionId: this.sessionId,
        correlationId,
        meta: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    this.publish();
    return this.#snapshot;
  }

  // AUTO-BUILD toggle. Flip on => every fired idea is built without a click; flip
  // off => back to click-to-build. Returns the fresh snapshot so the UI reflects
  // the new state immediately.
  setAutoAccept(on: boolean, correlationId = `corr-auto-accept-toggle-${crypto.randomUUID()}`): ProjectorSnapshot {
    this.#autoAccept = on;
    this.recordExternalTrace({
      event: "suggestion.autoaccept.set",
      level: "info",
      sessionId: this.sessionId,
      correlationId,
      meta: { on },
    });
    this.publish();
    return this.#snapshot;
  }

  autoAccept(): boolean {
    return this.#autoAccept;
  }

  // CLICK A PROJECT -> STEER IT. Set the steering target UPID so subsequent live
  // FINAL transcript lines route to that process's agent loop (registry.steer)
  // instead of seeding a fresh ambient suggestion. The steered bubble is surfaced
  // via the snapshot's `steeringUpid` + per-process `steering` flag.
  setSteeringTarget(upid: string, correlationId = `corr-steer-select-${crypto.randomUUID()}`): ProjectorSnapshot {
    if (this.#emergencyTriggered) {
      return this.#snapshot;
    }
    const live = this.registry.activeRecords().some((record) => record.upid === upid);
    if (!live) {
      // The target is gone (halted / never existed): clear any stale steering and
      // return the current snapshot rather than steering into a dead process.
      return this.clearSteeringTarget(correlationId);
    }
    this.#steeringUpid = upid;
    this.recordExternalTrace({
      event: "steering.target.set",
      level: "info",
      sessionId: this.sessionId,
      correlationId,
      upid,
      meta: { upid },
    });
    this.publish();
    return this.#snapshot;
  }

  // Clear the steering target; live transcript returns to ambient suggestion +
  // click-to-build behavior.
  clearSteeringTarget(correlationId = `corr-steer-clear-${crypto.randomUUID()}`): ProjectorSnapshot {
    const had = this.#steeringUpid;
    this.#steeringUpid = null;
    if (had !== null) {
      this.recordExternalTrace({
        event: "steering.target.cleared",
        level: "info",
        sessionId: this.sessionId,
        correlationId,
        upid: had,
        meta: { upid: had },
      });
    }
    this.publish();
    return this.#snapshot;
  }

  steeringTarget(): string | null {
    return this.#steeringUpid;
  }

  startMicSession(correlationId = `corr-mic-${crypto.randomUUID()}`): MicSession {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    const audio = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
      cancel: () => {
        closed = true;
      },
    });

    this.#micActive = true;
    this.#micBytes = 0;
    this.#micLastPublishMs = 0;
    this.#interim = null;
    this.recordExternalTrace({
      event: "mic.session.open",
      level: "info",
      sessionId: this.sessionId,
      correlationId,
      meta: { mode: this.micMode },
    });
    this.publish();

    // Drain the ASR provider in the background; each observation updates the
    // live transcript and republishes the snapshot to all SSE subscribers.
    const drained = (async () => {
      try {
        for await (const observation of this.#micAsr.stream(audio)) {
          await this.ingestTranscript(observation, correlationId);
        }
      } catch (error) {
        this.recordExternalTrace({
          event: "mic.session.error",
          level: "error",
          sessionId: this.sessionId,
          correlationId,
          meta: { message: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        // Note: `#micActive` is tied to the socket lifetime (cleared in stop()),
        // not to this drain completing. In replay mode the ASR stream ends
        // immediately, but the room mic is still open and feeding the server.
        this.#interim = null;
        this.publish();
      }
    })();

    return {
      id: correlationId,
      pushAudio: (chunk: Uint8Array) => {
        if (closed || controller === null || chunk.byteLength === 0) {
          return;
        }
        this.#micBytes += chunk.byteLength;
        try {
          controller.enqueue(chunk);
        } catch {
          // The stream was already closed/cancelled; drop the late frame.
        }
        // Throttle byte-counter publishes so a steady mic stream (many frames/s)
        // doesn't flood SSE subscribers.
        const now = Date.now();
        if (now - this.#micLastPublishMs >= 200) {
          this.#micLastPublishMs = now;
          this.publish();
        }
      },
      stop: async () => {
        if (closed) {
          return;
        }
        closed = true;
        this.#micActive = false;
        try {
          controller?.close();
        } catch {
          // Already closed.
        }
        this.recordExternalTrace({
          event: "mic.session.close",
          level: "info",
          sessionId: this.sessionId,
          correlationId,
          meta: { bytesReceived: this.#micBytes },
        });
        this.publish();
        await drained.catch(() => undefined);
      },
    };
  }

  // Fold one ASR observation into the live transcript, then — for FINAL results
  // only — drive the ambient SuggestionEngine. Interim (partial) results replace
  // the single in-flight line and must NOT move the engine's gates.
  private async ingestTranscript(observation: TranscriptObservation, correlationId: string): Promise<void> {
    const text = observation.text.trim();
    if (text.length === 0) {
      return;
    }
    const line: TranscriptLine = {
      time: new Date().toISOString().slice(11, 19),
      speaker: observation.speaker ?? "Room",
      text,
      kind: "room",
    };
    if (observation.isFinal) {
      this.#liveFinals = [...this.#liveFinals, line].slice(-MAX_LIVE_TRANSCRIPT_LINES);
      this.#interim = null;
    } else {
      this.#interim = line;
    }
    this.publish();

    if (observation.isFinal) {
      // Wake/earcon fast-path (GAP-006): every FINAL observation reaches the active
      // Cue path (harness or fallback) exactly once, so a 'viber' wake word emits an
      // earcon trace. This is orthogonal to the suggestion/acceptance routing below.
      await this.driveCueBridge(observation, correlationId);

      // CLICK A PROJECT -> STEER IT. While a steering target is set, route this
      // FINAL line to that process's agent loop (registry.steer) instead of seeding
      // a fresh ambient suggestion. Behavior is unchanged when no target is set.
      if (this.#steeringUpid !== null) {
        await this.routeSteering(observation, correlationId);
        return;
      }

      // Expire a stale pending suggestion FIRST. Acceptance otherwise only times
      // out on a room-idle tick; during continuous talk the room never goes idle,
      // so without this an un-answered suggestion would wedge the loop into
      // accept/decline mode forever and no new ideas could form.
      this.acceptanceController.checkExpiry(this.#clock());

      // Once an idea is surfaced and pending, subsequent FINAL utterances are
      // accept/decline/answer candidates — route them to the AcceptanceController
      // (GAP-003). Otherwise feed the line to idea DETECTION, which decides over
      // the rolling window whether a buildable idea was proposed (no word/time
      // gate) and surfaces it via onDetectionUpdate.
      if (this.acceptanceController.awaitingAcceptance()) {
        await this.routeAcceptance(observation, correlationId);
      } else {
        await this.driveDetection(observation, correlationId);
      }
    }
  }

  // Route one FINAL observation into the AcceptanceController while a suggestion
  // is pending. An affirmative spawns through the ProcessRegistry seam (the spawn
  // surfaces on the next snapshot via processSnapshots); a decline clears the
  // pending suggestion without spawning.
  private async routeAcceptance(observation: TranscriptObservation, correlationId: string): Promise<void> {
    const acceptanceCorrelationId = `${correlationId}-${observation.utteranceId}`;
    this.recordExternalTrace({
      event: "route.acceptance",
      level: "info",
      sessionId: this.sessionId,
      correlationId: acceptanceCorrelationId,
      meta: { utteranceId: observation.utteranceId, candidate: observation.text },
    });
    try {
      const result = await this.acceptanceController.observe({ observation, correlationId: acceptanceCorrelationId });
      // On a spoken accept the registry spawns: open the SPAWN stage (earcon E3)
      // and the ACK stage with a spoken confirmation, routed through this.tts so
      // the live loop both earcons and speaks on accept (GAP-005/GAP-008).
      if (result.kind === "spawned" && result.spawn.accepted) {
        // A spoken "yes" built the surfaced idea — consume the detection candidate
        // so it isn't re-surfaced, and clear the bubble.
        if (this.#detectionPrimaryId !== null) {
          this.detection.accept(this.#detectionPrimaryId);
          this.#detectionPrimaryId = null;
        }
        await this.spawnAck(result.spawn, acceptanceCorrelationId);
        // Subscribe the freshly spawned run to its live event stream so the
        // process panel reflects real progress (ISSUE-0021). Fire-and-forget: the
        // overlay updates republish on their own, and a stream failure must not
        // abort acceptance routing.
        this.subscribeRunEvents(result.spawn.process.upid, result.spawn.process.runId);
      }
    } catch (error) {
      this.recordExternalTrace({
        event: "acceptance.error",
        level: "error",
        sessionId: this.sessionId,
        correlationId: acceptanceCorrelationId,
        meta: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    // Reflect any registry spawn (or cleared pending) on the published snapshot.
    this.publish();
  }

  // Route one FINAL transcript line to the current steering target's agent loop
  // (CLICK A PROJECT -> STEER IT). The text is sent through the process registry's
  // steer/signal for that UPID, correlationId-tagged, so the build's agent receives
  // the spoken instruction instead of the runtime seeding a new ambient suggestion.
  // If the target has gone dead, the steering is cleared and the line falls back to
  // ambient suggestion handling.
  private async routeSteering(observation: TranscriptObservation, correlationId: string): Promise<void> {
    const upid = this.#steeringUpid;
    if (upid === null) {
      return;
    }
    if (!this.registry.activeRecords().some((record) => record.upid === upid)) {
      // The steered process is no longer live: drop the target and re-run this
      // FINAL line through the normal ambient path so it is not lost.
      this.clearSteeringTarget(`${correlationId}-steer-stale`);
      this.acceptanceController.checkExpiry(this.#clock());
      if (this.acceptanceController.awaitingAcceptance()) {
        await this.routeAcceptance(observation, correlationId);
      } else {
        await this.driveDetection(observation, correlationId);
      }
      return;
    }
    const steerCorrelationId = `${correlationId}-${observation.utteranceId}`;
    try {
      await this.registry.steer(upid, { text: observation.text, source: "live-transcript" }, steerCorrelationId);
    } catch (error) {
      this.recordExternalTrace({
        event: "steering.route.error",
        level: "error",
        sessionId: this.sessionId,
        correlationId: steerCorrelationId,
        upid,
        meta: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    this.publish();
  }

  // Route one FINAL observation through the active Cue wake/earcon path. The
  // bridge emits an earcon trace on a wake-word match (via the harness-owned or
  // in-runtime adapter, both wired to this.trace). Failures are non-fatal: a
  // broken wake path must never abort live transcript ingestion.
  private async driveCueBridge(observation: TranscriptObservation, correlationId: string): Promise<void> {
    if (this.#cueBridge === null) {
      return;
    }
    try {
      const decision = await this.#cueBridge.observeFinal(observation);
      // A wake word match emits a text-cue earcon on the active Cue path; mirror
      // that into the canonical spine by opening the ACTIVE_LISTEN stage with E1.
      if (decision !== null && decision.earcons.length > 0) {
        await this.driveTransition("ACTIVE_LISTEN", {
          correlationId,
          reason: "wake-detected",
          audible: { channel: "earcon", id: "E1" },
        });
      }
    } catch (error) {
      this.recordExternalTrace({
        event: "cue.bridge.error",
        level: "error",
        sessionId: this.sessionId,
        correlationId,
        meta: {
          mode: this.#cueBridge.mode,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  // Feed one FINAL observation into idea DETECTION. The detection runner appends
  // the turn to its rolling window and, when its cheap scheduling policy allows,
  // runs windowed model inference — surfacing grounded candidates asynchronously
  // via onDetectionUpdate. This replaces the per-utterance SuggestionEngine gate.
  private async driveDetection(observation: TranscriptObservation, correlationId: string): Promise<void> {
    const nowMs = this.#clock();
    this.#lastFinalAtMs = nowMs;
    await this.detection.ingestTurnAndDetect({
      speaker: observation.speaker,
      text: observation.text,
      atMs: nowMs,
      correlationId: `${correlationId}-${observation.utteranceId}`,
    });
  }

  // React to a detection round: a newly-READY primary candidate becomes the idea
  // bubble. It is delivered (spoken) once, fed into the acceptance pending so a
  // spoken/click accept acts on it, and — when AUTO-BUILD is on — built immediately.
  // The snapshot's bubble is always sourced live from detection.primary(), so this
  // only handles the side effects of a NEW idea surfacing.
  private async onDetectionUpdate(snapshot: DetectionSnapshot): Promise<void> {
    const primary = snapshot.primary;
    if (primary === null) {
      this.#detectionPrimaryId = null;
      this.publish();
      return;
    }
    if (primary.id !== this.#detectionPrimaryId) {
      this.#detectionPrimaryId = primary.id;
      const correlationId = `corr-detect-${primary.id}`;
      const pending = pendingSuggestionFromCandidate(primary, correlationId, this.#clock() + DETECTION_BUBBLE_TTL_MS);
      // Make spoken/click/auto accept act on the surfaced idea consistently.
      this.#pendingOwner.acceptSuggestion(pending);
      await this.deliverSuggestionAudio(pending, correlationId).catch(() => undefined);
      // AUTO-BUILD: build the surfaced idea immediately when the toggle is on. The
      // guard drops overlapping fires while a build spins up so a chatty room
      // doesn't stack spawns; the next surfaced idea catches it.
      if (this.#autoAccept && !this.#autoAcceptInFlight) {
        this.#autoAcceptInFlight = true;
        void this.acceptPendingSuggestion(`corr-auto-accept-${primary.id}`).finally(() => {
          this.#autoAcceptInFlight = false;
        });
      }
    }
    this.publish();
  }

  // Wall-clock watchdog: a delivered suggestion that is never voice-accepted must
  // not wedge the loop in accept/decline mode forever. The per-final checkExpiry
  // stops firing once the room goes quiet (no more finals), so a timer drives the
  // no-answer expiry and returns the runtime to ambient idea generation.
  startAcceptanceWatchdog(intervalMs = 1500): void {
    if (this.#acceptanceWatchdog !== null) {
      return;
    }
    const timer = setInterval(() => {
      const wasAwaiting = this.acceptanceController.awaitingAcceptance();
      this.acceptanceController.checkExpiry(this.#clock());
      if (wasAwaiting && !this.acceptanceController.awaitingAcceptance()) {
        this.recordExternalTrace({
          event: "acceptance.expired",
          level: "info",
          sessionId: this.sessionId,
          correlationId: "corr-acceptance-watchdog",
          meta: {},
        });
        this.publish();
      }
    }, intervalMs);
    (timer as { unref?: () => void }).unref?.();
    this.#acceptanceWatchdog = timer;
  }

  async seedDemoFleet(): Promise<void> {
    const [atlas, cobalt] = this.#demoProcesses;
    if (atlas === undefined || cobalt === undefined) {
      return;
    }

    // The demo fleet uses pre-authored callsigns (Atlas/Cobalt) that are display
    // fixtures, not live voice-assigned callsigns. The phonetic collision guard
    // exists to keep *spoken* steering unambiguous (e.g. "Cobalt" sits close to
    // the panic word "abort"), so it must not reject the deterministic seed.
    // Suspend it only for the duration of seeding; live voice spawns keep it on.
    const priorGuard = process.env.VIBERSYN_RBG_DISABLE_CALLSIGN_COLLISION_GUARD;
    process.env.VIBERSYN_RBG_DISABLE_CALLSIGN_COLLISION_GUARD = "1";
    try {
      await this.registry.spawn({
        upid: atlas.upid,
        runId: atlas.runId,
        callsign: atlas.callsign,
        workflow: "vibersyn-demo",
        prompt: atlas.task,
        input: { task: atlas.task, source: "projector-demo" },
        correlationId: "corr-demo-seed-atlas",
      });
      this.registry.advanceAutonomousTick("corr-demo-seed-atlas-active");
      await this.registry.spawn({
        upid: cobalt.upid,
        runId: cobalt.runId,
        callsign: cobalt.callsign,
        workflow: "vibersyn-demo",
        prompt: cobalt.task,
        input: { task: cobalt.task, source: "projector-demo" },
        correlationId: "corr-demo-seed-cobalt",
      });
      this.registry.select(atlas.upid, "corr-demo-seed-select");
    } finally {
      if (priorGuard === undefined) {
        delete process.env.VIBERSYN_RBG_DISABLE_CALLSIGN_COLLISION_GUARD;
      } else {
        process.env.VIBERSYN_RBG_DISABLE_CALLSIGN_COLLISION_GUARD = priorGuard;
      }
    }
  }

  async muteForInitialState(): Promise<void> {
    await this.muteController.engage({ correlationId: "corr-demo-initial-mute" });
    this.#session.stopListening();
    this.#snapshot = this.buildSnapshot();
  }

  publish(): void {
    this.#snapshot = this.buildSnapshot(this.#snapshot);
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(this.#snapshot);
      } catch {
        // A closed/errored stream must not abort the whole broadcast — prune it.
        this.#subscribers.delete(subscriber);
      }
    }
  }

  private buildSnapshot(previous: ProjectorSnapshot = this.#snapshot): ProjectorSnapshot {
    const muted = this.#emergencyTriggered || this.muteController.isMuted();
    const listening = !this.#emergencyTriggered && this.#session.isListening() && !muted;
    const liveActiveCue = this.#micActive ? "ambient listening" : previous.activeCue;

    return {
      ...emptyProjectorSnapshot,
      sessionId: this.sessionId,
      listening,
      muted,
      globalState: this.#emergencyTriggered ? "emergency stopped" : muted ? "muted" : "ready",
      activeCue: this.#emergencyTriggered ? "none" : muted ? "muted" : liveActiveCue,
      emergencyStopTriggered: this.#emergencyTriggered,
      suggestion: this.suggestionSnapshot(),
      audio: this.audioSnapshot(previous),
      processes: this.processSnapshots(),
      transcript: this.transcriptSnapshot(),
      // Real trace only — no demo fixtures. An idle runtime that has emitted no
      // events shows an empty trace, not the canned demo causal chain.
      trace: [...this.trace.events()].slice(-80),
      updatedAt: new Date().toISOString(),
      mic: { mode: this.micMode, active: this.#micActive, bytesReceived: this.#micBytes },
      steeringUpid: this.#steeringUpid,
      autoAccept: this.#autoAccept,
    };
  }

  // The live transcript region reflects the real room audio. With no live mic
  // line yet it is EMPTY (neutral idle state) — never the canned demo lines.
  private transcriptSnapshot(): TranscriptLine[] {
    if (this.#liveFinals.length === 0 && this.#interim === null) {
      return [];
    }
    const lines = [...this.#liveFinals];
    if (this.#interim !== null) {
      lines.push(this.#interim);
    }
    return lines.slice(-MAX_LIVE_TRANSCRIPT_LINES);
  }

  // Reflect the live idea-DETECTION primary candidate in the idea bubble: its
  // pitch/confidence and the span of conversation it was grounded in. Before any
  // idea is detected (or while muted/stopped) show the neutral idle bubble (empty
  // pitch) — never the demo fixture.
  private suggestionSnapshot(): ProjectorSuggestion {
    // The bubble reflects live idea DETECTION: the highest-confidence ready
    // candidate, carrying its grounding span. Muted/stopped → neutral idle bubble.
    if (this.#emergencyTriggered || this.muteController.isMuted()) {
      return emptyProjectorSnapshot.suggestion;
    }
    const primary = this.detection.primary();
    return primary === null ? emptyProjectorSnapshot.suggestion : projectorSuggestionFromCandidate(primary);
  }

  private processSnapshots(): ProjectorProcess[] {
    const demoByUpid = new Map(this.#demoProcesses.map((process) => [process.upid, process]));

    return this.registry.records().map((record) => {
      const demo = demoByUpid.get(record.upid);
      // Live run telemetry (ISSUE-0021): a spawned run streaming gateway events has
      // an overlay whose progress/lastOutput/state replace the demo-fixture values
      // for that UPID. The seeded fleet has no live run, so no overlay exists and it
      // keeps its fixtures. A dead (halted) process always shows the halt state —
      // live telemetry never overrides an emergency stop.
      const live = record.state === "dead" ? undefined : this.runEventDriver.overlay(record.upid);
      // Real preview surface (accept->build->preview). A halted process drops its
      // preview (the server is torn down on halt), so a dead record never carries
      // a stale URL. The seeded demo fleet has no build, so build state is null.
      const build = record.state === "dead" ? undefined : this.ideaBuilds.state(record.upid);
      return {
        upid: record.upid,
        runId: record.runId,
        previewUrl: build?.previewUrl ?? null,
        buildStatus: build?.status ?? null,
        // The registry normalizes callsigns to lowercase for voice matching; the
        // projector shows the pre-authored display casing ("Atlas"/"Cobalt").
        callsign: demo?.callsign ?? record.callsign,
        state: record.state === "dead" ? "halted" : live?.state ?? projectorState(record.state),
        selected: record.selected,
        // Click-to-steer marker: this process is the live steering target, so
        // subsequent FINAL transcript lines route to it. A dead record never steers.
        steering: record.state !== "dead" && this.#steeringUpid === record.upid,
        task: demo?.task ?? "Vibersyn task",
        model: demo?.model ?? "runtime",
        progressLabel: record.state === "dead" ? "halted" : demo?.progressLabel ?? record.lastAction,
        progress: record.state === "dead" ? 100 : live?.progress ?? demo?.progress ?? Math.min(95, record.progressSeq * 12),
        lastOutput: record.state === "dead" ? "Halted by emergency stop." : live?.lastOutput ?? demo?.lastOutput ?? record.lastAction,
        lastAction: record.lastAction === "spawn" && demo !== undefined ? demo.events[0] ?? record.lastAction : record.lastAction,
        events: record.state === "dead" ? [...(demo?.events ?? []), "halted"] : demo?.events ?? [record.lastAction],
      };
    });
  }

  // Reflect the most recent spoken phrase and earcon independently: a spoken ack
  // (tts) and an earcon often land together on one turn (e.g. SPAWN E3 + ACK
  // speech), so the snapshot must surface both, not just whichever was emitted
  // last. Falls back to the previous audio fields before any live output exists.
  private audioSnapshot(previous: ProjectorSnapshot): ProjectorSnapshot["audio"] {
    let lastSpoken: string | undefined;
    let earcon: string | undefined;
    for (const decision of this.#outputs) {
      if (decision.channel === "tts") {
        lastSpoken = decision.text;
      } else if (decision.channel === "earcon") {
        earcon = decision.id;
      }
    }
    return {
      ...previous.audio,
      lastSpoken: lastSpoken ?? previous.audio.lastSpoken,
      earcon: earcon ?? previous.audio.earcon,
    };
  }

  private recordExternalTrace(event: LogEvent): void {
    // The mute heartbeat fires every ~1s for the life of the (long-running)
    // server while muted. It is liveness noise, not causal-chain data, and the
    // TraceProcessor buffer is unbounded — recording it would grow memory and
    // make every snapshot publish copy an ever-larger array. Drop it.
    if (event.event === "mute.heartbeat") {
      return;
    }
    const startedAtMs = Date.now();
    this.trace.record({
      event: event.event,
      level: event.level,
      sessionId: event.sessionId,
      correlationId: event.correlationId ?? "corr-runtime",
      upid: event.upid,
      startedAtMs,
      endedAtMs: startedAtMs + (event.latencyMs ?? 0),
      meta: event.meta,
    });
    // A completed accept->build->preview build flips buildStatus/previewUrl on the
    // owning process; republish so subscribers see the live "Preview ->" link the
    // moment the scaffolded page is served (or the failure).
    if (event.event === "process.build") {
      this.publish();
    }
  }

  private recordOutput(decision: OutputDecision): void {
    this.#outputs.push(decision);
  }

  // Open the ACTIVE_LISTEN stage when the spine is still IDLE so a suggestion
  // delivery / spawn that arrives without a preceding wake word (the common
  // ambient case) still has a valid canonical path to transition along.
  private async ensureActiveListen(correlationId: string): Promise<void> {
    if (this.stageSequencer.state() === "IDLE") {
      await this.driveTransition("ACTIVE_LISTEN", { correlationId, reason: "ambient-listen", audible: null });
    }
  }

  // Subscribe one spawned run to its live gateway event stream (ISSUE-0021). The
  // RunEventDriver folds frames into a per-UPID overlay and republishes via its
  // onUpdate hook, so the process panel tracks real progress. Fire-and-forget: a
  // stream/transport failure is swallowed so it can never wedge live ingestion.
  private subscribeRunEvents(upid: string, runId: string): void {
    void this.runEventDriver.subscribe(upid, runId).catch((error) => {
      this.recordExternalTrace({
        event: "run.events.error",
        level: "error",
        sessionId: this.sessionId,
        upid,
        meta: { message: error instanceof Error ? error.message : String(error) },
      });
    });
  }

  // Handle one idle-cue decision from the IdleCueDriver. A suggestion that was
  // deferred at fire time (high interrupt cost) reaches here as a 'fired'
  // decision once the room has been quiet for the idle gap: reflect it on the
  // snapshot and speak it through the same SUGGESTION_DELIVERY path a live fire
  // takes. Non-fired decisions (e.g. 'expired') only update the bubble.
  private async deliverIdleDecision(decision: SuggestionEngineDecision): Promise<void> {
    this.#lastSuggestionDecision = decision;
    if (decision.kind === "fired") {
      await this.deliverSuggestionAudio(decision.suggestion, `corr-idle-${decision.suggestion.suggestionId}`);
    }
    this.publish();
  }

  // Speak a fired suggestion and record the SUGGESTION_DELIVERY transition.
  private async deliverSuggestionAudio(suggestion: PendingSuggestion, correlationId: string): Promise<void> {
    await this.ensureActiveListen(correlationId);
    const spoken = await ttsDecision(suggestionSpeech(suggestion), { fallback: "I have a suggestion." });
    await this.driveTransition("SUGGESTION_DELIVERY", {
      correlationId,
      reason: "route-suggestion",
      audible: spoken,
      meta: { suggestionId: suggestion.suggestionId },
    });
  }

  // Earcon + spoken confirmation for an accepted spawn, recorded as the
  // SPAWN -> ACK transitions, then reset to IDLE for the next ambient cycle.
  private async spawnAck(spawn: Extract<AcceptanceSpawnResult, { accepted: true }>, correlationId: string): Promise<void> {
    await this.ensureActiveListen(correlationId);
    await this.driveTransition("SPAWN", {
      correlationId,
      reason: "acceptance-spawn",
      audible: { channel: "earcon", id: "E3" },
      meta: { upid: spawn.process.upid, callsign: spawn.process.callsign },
    });
    const spokenAck = spawn.outputs.find((output) => output.channel === "tts");
    const ackText = spokenAck?.channel === "tts" ? spokenAck.text : `${spawn.process.callsign} spawned.`;
    await this.driveTransition("ACK", {
      correlationId,
      reason: "spoken-confirmation",
      audible: await ttsDecision(ackText, { fallback: "Spawned." }),
      meta: { upid: spawn.process.upid, callsign: spawn.process.callsign },
    });
    await this.driveTransition("IDLE", { correlationId, reason: "ack-complete", audible: null });
  }

  // Drive one canonical stage transition without ever aborting live ingestion: an
  // invalid/failed transition is recorded as a trace event and swallowed.
  private async driveTransition(
    to: CanonicalStage,
    input: { correlationId: string; reason: string; audible?: OutputDecision | null; meta?: Record<string, unknown> },
  ): Promise<void> {
    try {
      await this.stageSequencer.transition(to, input);
    } catch (error) {
      this.recordExternalTrace({
        event: "stage.transition.error",
        level: "error",
        sessionId: this.sessionId,
        correlationId: input.correlationId,
        meta: { to, reason: input.reason, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  // Record an audible OutputDecision in #outputs and play/speak it. Mirrors the
  // canonical.ts emitOutput pattern: earcon/ack clips play to the audio sink and
  // TTS reaches this.tts.speak, with a trace event per channel. Failures here must
  // not abort a stage transition, so the emit is best-effort.
  private async emitOutput(decision: OutputDecision, correlationId: string): Promise<void> {
    this.#outputs.push(decision);
    const startedAtMs = Date.now();
    try {
      switch (decision.channel) {
        case "earcon":
          await playEarcon(this.#audio, decision.id, { correlationId, source: "stage-sequencer" });
          this.recordTimedTrace("earcon.emit", correlationId, startedAtMs, { id: decision.id, source: "stage-sequencer" });
          return;
        case "ack":
          await playAck(this.#audio, decision.id, { correlationId, source: "stage-sequencer" });
          this.recordTimedTrace("ack.emit", correlationId, startedAtMs, { ackId: decision.id, source: "stage-sequencer" });
          return;
        case "tts": {
          // Synthesize, then fully drain the returned audio stream to the sink so
          // the bytes are actually read (the prior code awaited + discarded the
          // stream). The drain is best-effort: a read/sink failure is recorded but
          // never propagated, so it cannot abort the in-flight stage transition.
          const stream = await this.tts.speak(decision.text);
          let drained = { bytes: 0, chunks: 0 };
          try {
            drained = await drainTtsStream(stream, { sink: this.#ttsSink });
          } catch (error) {
            await stream.cancel().catch(() => undefined);
            this.recordExternalTrace({
              event: "output.tts.drain.error",
              level: "error",
              sessionId: this.sessionId,
              correlationId,
              meta: { message: error instanceof Error ? error.message : String(error) },
            });
          }
          this.recordTimedTrace("output.tts", correlationId, startedAtMs, {
            text: decision.text,
            wordCount: decision.wordCount,
            summarized: decision.summarized,
            bytes: drained.bytes,
            chunks: drained.chunks,
          });
          return;
        }
        case "silent":
          this.recordTimedTrace("output.silent", correlationId, startedAtMs, {});
          return;
      }
    } catch (error) {
      this.recordExternalTrace({
        event: "output.emit.error",
        level: "error",
        sessionId: this.sessionId,
        correlationId,
        meta: { channel: decision.channel, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private recordTimedTrace(event: string, correlationId: string, startedAtMs: number, meta: Record<string, unknown>): void {
    this.trace.record({
      event,
      sessionId: this.sessionId,
      correlationId,
      startedAtMs,
      endedAtMs: Date.now(),
      meta,
    });
  }
}

// Earcon/ack audio output backed by the selected audio sink (ISSUE-0026). Each
// prerendered clip's Int16 PCM is viewed as bytes and routed to the sink — the
// no-op sink drops them (silent production default), a recording/device sink
// retains them. The write is best-effort: a sink failure is swallowed so it can
// never abort the in-flight stage transition (emitOutput records it as a trace).
class BufferedAudioOutput implements AudioOutput {
  readonly #sink: AudioSink;

  constructor(sink: AudioSink) {
    this.#sink = sink;
  }

  async playPcm(clip: PcmClip): Promise<void> {
    const bytes = new Uint8Array(clip.pcm.buffer, clip.pcm.byteOffset, clip.pcm.byteLength);
    await this.#sink.write(bytes);
  }
}

// Spoken form of a fired suggestion: the pitch plus its lead question, mirroring
// the canonical spine's suggestionSpeech so the live ack reads the same way.
function suggestionSpeech(suggestion: PendingSuggestion): string {
  return `${suggestion.pitch}. ${suggestion.mcqs[0] ?? "Proceed?"}`;
}

// Resolve a streamRunEvents-capable client from whatever the registry was given
// (ISSUE-0021). The gateway path wraps a GatewaySmithersClient that streams; the
// in-memory default exposes an empty stream. A client without the method (should
// not happen) degrades to a no-op stream so the runtime never throws on subscribe.
function runEventStreamClient(client: RegistrySmithersClient): RunEventStreamClient {
  if (client instanceof GatewayRegistryClient) {
    return client.client;
  }
  if ("streamRunEvents" in client && typeof (client as Partial<SmithersClient>).streamRunEvents === "function") {
    return client as RunEventStreamClient;
  }
  return {
    async *streamRunEvents() {
      // No live event source (no gateway configured) — seeded fixtures stand.
    },
  };
}

function projectorState(state: RegistryProcess["state"]): ProjectorProcessState {
  switch (state) {
    case "planning":
    case "active":
    case "paused":
      return state;
    case "dead":
      return "halted";
    default:
      return "blocked";
  }
}

// Map one live SuggestionEngine verdict to the projector's idea-bubble shape.
// Returns null for the `idle` no-op verdict so the caller keeps the demo bubble.
// The gate counters come from the engine: words/seconds are the decision meta's
// substantive totals, minWords/minSeconds are the configured REQ-3 floors.
// Exported (ISSUE-0018) so the fired-decision -> bubble projection is unit-testable
// independently of the full runtime drive.
export function liveProjectorSuggestion(
  decision: SuggestionEngineDecision,
  config: SuggestionEngineConfig,
): ProjectorSuggestion | null {
  const minWords = config.wordFloor;
  const minSeconds = config.timeFloorSeconds;
  switch (decision.kind) {
    case "queued":
      return {
        state: "queued",
        pitch: decision.queued.suggestion.pitch,
        confidence: decision.queued.decision.quality,
        gate: gateFrom(decision.queued.decision, minWords, minSeconds),
        questions: [...decision.queued.suggestion.mcqs],
      };
    case "fired": {
      const meta = suggestionMetaFromEvents(decision.events);
      return {
        state: "speaking",
        pitch: decision.suggestion.pitch,
        confidence: meta.quality,
        gate: gateFrom(meta, minWords, minSeconds),
        questions: [...decision.suggestion.mcqs],
      };
    }
    case "expired":
      return {
        state: "declined",
        pitch: decision.suggestion.suggestion.pitch,
        confidence: decision.suggestion.decision.quality,
        gate: gateFrom(decision.suggestion.decision, minWords, minSeconds),
        questions: [...decision.suggestion.suggestion.mcqs],
      };
    case "pass": {
      // A FINAL utterance was scored but produced no suggestion (below the REQ-3
      // floor, or failed the quality gate). Show an idle bubble whose gate still
      // reflects real accumulated speech, so the panel reacts to live audio.
      const meta = suggestionMetaFromEvents(decision.events);
      return {
        state: "idle",
        pitch: "",
        confidence: meta.quality,
        gate: gateFrom(meta, minWords, minSeconds),
        questions: [],
      };
    }
    case "idle":
      return null;
  }
}

interface SuggestionGateMeta {
  wordCount: number;
  elapsedS: number;
  quality: number;
}

function gateFrom(meta: SuggestionGateMeta, minWords: number, minSeconds: number): ProjectorSuggestion["gate"] {
  return { words: meta.wordCount, minWords, seconds: meta.elapsedS, minSeconds };
}

// `fired`/`pass` verdicts don't carry the decision meta on the returned object,
// only on their trace events. Pull the substantive word/time/quality counters
// from the first event whose meta carries them.
function suggestionMetaFromEvents(events: readonly LogEvent[]): SuggestionGateMeta {
  for (const event of events) {
    const meta = event.meta;
    if (typeof meta.wordCount === "number") {
      return {
        wordCount: meta.wordCount,
        elapsedS: numberOr(meta.elapsedS, 0),
        quality: numberOr(meta.quality, 0),
      };
    }
  }
  return { wordCount: 0, elapsedS: 0, quality: 0 };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Recover the detection candidate id from a PendingSuggestion id minted by
// pendingSuggestionFromCandidate (`sug-<candidateId>`).
function candidateIdFromSuggestionId(suggestionId: string): string | null {
  return suggestionId.startsWith("sug-") ? suggestionId.slice("sug-".length) : null;
}
