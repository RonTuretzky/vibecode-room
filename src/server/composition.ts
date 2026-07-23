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
import { IdeaBuildRegistry, type BuilderAgent } from "./idea-builder";
import { BackendSelector } from "../buildloop/selector";
import { BuildOrchestrator, mergeLegacyBuildState, type ProcessBuildSnapshot } from "../buildloop/orchestrator";
import type { BuildBackend } from "../buildloop/types";
import { SmithersBuildBackend } from "../buildloop/backends/smithers";
import { NativeBuildBackend } from "../buildloop/backends/native";
import { ElizaBuildBackend } from "../buildloop/backends/eliza";
import { generateSlideshow } from "../slideshow/generator";
import { selectSummarizer } from "../audio/summarizer";
import type { HotLoopSummaryLLM } from "../audio/output-policy";
import { OnboardingGlue } from "./onboarding-glue";
import type { AcceptanceSpawnSeam } from "../acceptance/spawn";
import type { BuildloopProcess, BuildloopSnapshot } from "../ui/buildloop";
import {
  SuggestionEngine,
  type PendingQueuedSuggestion,
  type SuggestionEngineConfig,
  type SuggestionEngineDecision,
} from "../suggest/engine";
import { DetectionRunner, selectDetectionRunner, type DetectionSnapshot } from "./detection-runner";
import { DETECTION_BUBBLE_TTL_MS, ideaTrayFromCandidates, pendingSuggestionFromCandidate, projectorSuggestionFromCandidate } from "./idea-suggestion";
import { matchWakePhrase, parseVoiceCommand, voiceCommandLabel, wakeWordFromEnv, type WakePhraseMatch } from "./voice-commands";
import { dispatchUtterance, type DispatchDecision, type SteeringWindow as RoutingSteeringWindow } from "../routing/dispatch";
import { includesPhrase, loadRoutingVocabulary, normalizeSpeech, type DocumentedCommand, type RoutingVocabulary } from "../routing/vocabulary";
import { panicHaltOutputs } from "../routing/panic-feedback";
import { NearMissSoftLanding } from "../onboarding/soft-landing";
import { FirstRunVadTuner } from "../onboarding/vad";
import { SeamDispatcher } from "../seam/dispatcher";
import { createCorrelationRecord, type CorrelationRecord, type CorrelationStore } from "../seam/correlation-store";
import { callsignFromRepo, parseGitHubImportUrl } from "./project-import";
import type { IdeaCandidate, IdeaDetector } from "../detect";
import { StageSequencer, type CanonicalStage } from "../spine/stage-sequencer";
import type { DispatchedAction, LogEvent, OutputDecision, PendingSuggestion } from "../types";
import { demoProjectorSnapshot, emptyProjectorSnapshot, withUnmuted } from "../ui/demo-data";
import type { IdeaTrayItem, ProjectorProcess, ProjectorProcessState, ProjectorSnapshot, ProjectorSuggestion, TranscriptLine } from "../ui/types";
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
  // Subscribes each spawned run to the gateway's live event stream and folds the
  // frames into a per-UPID overlay that the process panel reads (ISSUE-0021), so
  // a live run shows real progress/lastOutput/state instead of demo fixtures.
  readonly runEventDriver: RunEventDriver;
  // Seam action API executor (/api/seam/*): validates DispatchedActions and
  // executes them against the live registry — the SAME fleet the voice and
  // click paths drive — so an HTTP/WS action and a spoken command are one system.
  readonly seamDispatcher: SeamDispatcher;
  // Real accept->build->preview registry: each voice-accepted idea scaffolds a
  // runnable artifact + a live preview server, tracked here per UPID so the
  // snapshot can surface previewUrl/buildStatus and lifecycle can tear it down.
  readonly ideaBuilds: IdeaBuildRegistry;
  // Multi-backend BUILD LOOP (src/buildloop). The selector owns the registered
  // backend roster + enable/availability state (the snapshot's top-level
  // `backends[]` and POST /api/backends); the orchestrator fans each accepted
  // idea out to every enabled+available backend concurrently and tracks the
  // per-process builds[] fragment the wall consumes.
  readonly buildSelector: BackendSelector;
  readonly buildOrchestrator: BuildOrchestrator;
  pendingSuggestion(): PendingQueuedSuggestion | null;
  snapshot(): ProjectorSnapshot;
  // Rebuild + broadcast the snapshot NOW and return it. The HTTP control routes
  // call this after registry mutations that do not republish on their own
  // (pause/resume/steer — only halt fires onHalt), so the returned body and the
  // SSE stream both reflect the mutation immediately.
  publishNow(): ProjectorSnapshot;
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
  // IDEA CAPTURE mode toggle: when on, detection runs EAGERLY (a rate-limited
  // force-detect per final) so ideas surface fast. Capture no longer implies
  // building — auto-building happens ONLY when autoAccept is on; otherwise the
  // room confirms via the tray/keyboard/voice.
  setCaptureMode(on: boolean, correlationId?: string): ProjectorSnapshot;
  captureMode(): boolean;
  // IDEA TRAY: accept a SPECIFIC ledger candidate by id (not just the primary
  // bubble), spawning/building through the same accept path as
  // acceptPendingSuggestion. 404-free by contract: an unknown id is a no-op
  // returning the current snapshot.
  acceptIdea(id: string, correlationId?: string): Promise<ProjectorSnapshot>;
  // IDEA TRAY: explicitly reject a candidate — drop it from the ledger and
  // suppress its pitch for the accept-cooldown window (nothing is built).
  // Unknown id is a no-op returning the current snapshot.
  dismissIdea(id: string, correlationId?: string): ProjectorSnapshot;
  // QR import (phone -> POST /api/projects/import): validate a GitHub URL and
  // add it to the fleet as an imported project-in-progress
  // (source: { kind: "github-import", url }).
  importProject(url: string, correlationId?: string): Promise<ImportProjectResult>;
}

export type ImportProjectResult = { ok: true; snapshot: ProjectorSnapshot } | { ok: false; error: string };

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
  // Multi-backend build roster for the BUILD LOOP fan-out (src/buildloop).
  // Production defaults to the real smithers/native/eliza backends. Tests inject
  // fakes so no real model call or CLI spawn occurs. Seam contract: when this is
  // ABSENT and a legacy `builderAgent` IS injected, the accept path keeps the
  // LEGACY single-build ideaBuilds route (the existing e2e contract — root
  // previewUrl, ideaBuilds.settle) and the orchestrator is constructed but not
  // wired into the registry; injecting buildBackends always routes accepts
  // through the orchestrator instead.
  buildBackends?: BuildBackend[];
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
  readonly runEventDriver: RunEventDriver;
  readonly seamDispatcher: SeamDispatcher;
  readonly ideaBuilds: IdeaBuildRegistry;
  readonly buildSelector: BackendSelector;
  readonly buildOrchestrator: BuildOrchestrator;
  // Session-start onboarding glue: REQ-1 consent disclosure (spoken+traced once,
  // folded into the wall transcript), the authoritative mic-stream listening
  // indicator (E2 on stopped→streaming), and the whole-session transcripts-only
  // persistence guard asserted on every ingested observation.
  readonly #onboarding: OnboardingGlue;
  // Hot-loop summarizer (">15 words → summarize" guard). Selected by env:
  // Cerebras when CEREBRAS_API_KEY resolves, else the deterministic clamp.
  readonly #summarizer: HotLoopSummaryLLM;
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
  // Time of the most recent FINAL observation (null before any speech); lets the
  // runtime report the room-idle gap.
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
  // IDEA CAPTURE mode: an explicit alternative to passive auto-detect. When on,
  // detection runs EAGERLY on every final (a rate-limited force-detect, no
  // word/turn schedule) so deliberately-described ideas surface fast. Capture is
  // detection-only: building still requires an explicit accept (tray/keyboard/
  // voice) or the separate AUTO-BUILD toggle. A distinct indicator on the
  // snapshot shows capture is active.
  #captureMode = false;
  // Voice control (desk mode): the canonical wake word this session listens for,
  // and the last recognized command surfaced on the snapshot so walls can flash
  // confirmation ("vibersyn → build"). Null until the first command.
  readonly #wakeWord: string;
  #voice: ProjectorSnapshot["voice"] = null;
  // FULL voice grammar (src/routing): the documented command set — mute/unmute/
  // panic/stop/pause/resume/pause-all/status — plus callsign-addressed steering.
  // Runs on every NON-wake FINAL; the wake-word table above keeps first claim.
  readonly #routingVocabulary: RoutingVocabulary;
  // Dispatch-level steering window: "[callsign]" alone opens it, "[callsign],
  // [instruction]" opens-and-steers, "done"/"back" or steerIdleSeconds of
  // silence closes it. Read by dispatchUtterance as DispatchContext.openWindow.
  #routingWindow: RoutingSteeringWindow | null = null;
  // Onboarding near-miss soft landing: "Did you mean …?" for an ADDRESSED
  // utterance that matched no command, active for the first 20 minutes of the
  // session (NEAR_MISS_DISABLE_AFTER_MS), then silent.
  readonly #softLanding: NearMissSoftLanding;
  // GitHub-imported fleet entries (QR -> /api/projects/import), keyed by UPID.
  // The registry record stays the source of truth for lifecycle (halt/emergency
  // stop); this map carries the import-only display facts — the display-cased
  // callsign, the task line, and the source URL the projector links to.
  readonly #imports = new Map<string, { url: string; callsign: string; task: string }>();
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
    // First-run VAD grace (onboarding): for the first 5 minutes after boot the
    // live-mic end-of-utterance endpointing gets a +50% silence grace
    // (FIRST_RUN_VAD_SILENCE_MULTIPLIER), so a brand-new room's slower, halting
    // speech is not cut off mid-thought. Resolved per mic session via a thunk;
    // after the window it settles to the 300 ms Deepgram default. ("First run"
    // is per-process — no persisted marker exists yet.)
    const vadTuner = new FirstRunVadTuner({ startedAtMs: clock(), clock });
    const selectedMicAsr = selectAsrProvider(env, {
      sessionId,
      micProfile: true,
      voxtermSource: options.voxtermSource,
      replaySource: options.replaySource ?? env.VIBERSYN_MIC_REPLAY_PATH,
      endpointingMs: () => vadTuner.threshold(300).silenceThresholdMs,
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
    // Hot-loop summarizer selection (the ">15 words → summarize" guard's real
    // leg): Cerebras when the credential resolves, else the deterministic clamp.
    // The selected instance backs every ttsDecision the runtime makes.
    const summarizerSelection = selectSummarizer(env);
    this.#summarizer = summarizerSelection.summarizer;
    // Structured degradation notice computed from the resolved per-leg selections
    // (GAP-002). The live mic ASR is the leg that gates real transcription.
    this.degradation = buildDegradationNotice({
      asr: this.micMode,
      tts: ttsSelection.mode,
      sink: sinkMode,
      decider: decisionSelection.mode,
      smithers: smithersMode,
      summarizer: summarizerSelection.mode,
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
    // Multi-backend BUILD LOOP (src/buildloop): the selector owns the registered
    // roster (VIBERSYN_BUILD_BACKENDS csv, default "smithers,native" — eliza is
    // opt-in; runtime toggles via POST /api/backends), the orchestrator fans each
    // accepted idea out to every enabled+available backend concurrently into
    // builds/<upid>/<backendId>/ with per-build progress, steer re-runs, and the
    // ~2s emergency abort. Registration order = wall display order. The slideshow
    // hook regenerates the per-backend deck after every successful build/steer;
    // it is garnish — the orchestrator swallows its failures.
    this.buildSelector = new BackendSelector({
      backends: options.buildBackends ?? [new SmithersBuildBackend(), new NativeBuildBackend(), new ElizaBuildBackend()],
      env,
    });
    this.buildOrchestrator = new BuildOrchestrator({
      selector: this.buildSelector,
      buildsRoot: options.buildsRoot,
      slideshow: async (input) => {
        await generateSlideshow(input, { signal: input.signal });
      },
      onUpdate: () => this.publish(),
    });
    // Boot probe (fire-and-forget) so the first snapshot shows availability.
    void this.buildSelector.probeAll();
    // Seam contract (see ProjectorRuntimeOptions.buildBackends): an injected
    // legacy builderAgent WITHOUT an injected backend roster keeps the legacy
    // single-build path — existing tests/e2e drive that contract; production
    // (nothing injected) and injected-roster tests fan out via the orchestrator.
    const useOrchestrator = options.buildBackends !== undefined || options.builderAgent === undefined;
    // Concurrency cap: VIBERSYN_MAX_CONCURRENT_PROCESSES (0/unset-invalid → 16).
    // The old hardcoded 2 meant the third spoken idea in a session was refused.
    const maxConcurrent = resolveMaxConcurrentProcesses(env);
    this.registry = new ProcessRegistry({
      client: smithersClient,
      sessionId,
      now: clock,
      maxConcurrentProcesses: maxConcurrent,
      ideaBuilds: this.ideaBuilds,
      orchestrator: useOrchestrator ? this.buildOrchestrator : null,
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
    // Seam action API (/api/seam/*): the dispatcher's client/correlation seams
    // are registry adapters, so seam-dispatched spawn/steer/pause/resume/halt/
    // status act on and report the REAL fleet. The shared CallsignAllocator
    // makes the dispatcher's pre-assigned spawn callsign idempotent when
    // registry.spawn re-assigns it (same upid -> same callsign).
    this.seamDispatcher = new SeamDispatcher({
      client: registrySeamClient(this.registry),
      correlations: new RegistryCorrelationView(this.registry),
      sessionId,
      trace: this.trace,
      now: clock,
      callsigns: this.registry.callsigns,
    });
    // Session-start onboarding glue: constructs the tested onboarding modules
    // (consent scheduler, authoritative listening indicator, persistence guard)
    // over the runtime's real callbacks. The disclosure is announced on the
    // first mic open (announceConsentOnce); the indicator's E2 plays through the
    // same shared audio output as every other earcon; the guard is asserted on
    // every ingested observation (transcripts only, never raw audio).
    this.#onboarding = new OnboardingGlue({
      sessionId,
      provider: this.micMode,
      output: this.#audio,
      clock,
      onOutput: (decision) => this.recordOutput(decision),
      onTrace: (event) => this.recordExternalTrace(event),
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
    this.#captureMode = env.VIBERSYN_CAPTURE_MODE === "1" || env.VIBERSYN_CAPTURE_MODE === "true";
    this.#wakeWord = wakeWordFromEnv(env);
    this.#routingVocabulary = loadRoutingVocabulary(env);
    this.#softLanding = new NearMissSoftLanding({
      sessionStartedAtMs: clock(),
      clock,
      commands: SOFT_LANDING_COMMANDS,
    });
    const pending = new PendingSuggestionOwner({ clock, noAnswerTimeoutMs });
    this.#pendingOwner = pending;
    // DUPLICATE-SPAWN GUARD: every accept route (spoken "yes", bubble click,
    // tray accept, auto-build) funnels through this one seam, so guarding here
    // fixes the double-spawn bug (one utterance spawning upid-1 AND upid-2) for
    // all of them at once: an idea whose normalized pitch matches an accept in
    // the last 120s — or one whose spawn is still in flight — is refused at the
    // seam (surfaces as a traced accepted:false, never a second process).
    const acceptanceSeam = createDuplicateSpawnGuard(createProcessRegistryAcceptanceSeam(this.registry), {
      clock,
      onSuppressed: (info) =>
        this.recordExternalTrace({
          event: "spawn.duplicate.suppressed",
          level: "warn",
          sessionId,
          correlationId: info.correlationId,
          meta: { pitch: info.pitch, reason: info.reason },
        }),
    });
    const spawner = new AcceptanceSpawner({
      seam: acceptanceSeam,
      sessionId,
      clock,
      maxConcurrentProcesses: maxConcurrent,
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
    // Idea detection replaces the word/time gate as the source of idea bubbles. It
    // runs windowed model inference over the rolling transcript and surfaces
    // grounded candidates. With a Smithers gateway configured it runs as the
    // durable `idea-detection` run; otherwise host-`claude` inference runs inline.
    // Tests inject a deterministic detector so no model spawns.
    // Composite gateway client for detection runs: SPAWN must go through the
    // registry wrapper (which persists the UPID→runId correlation record —
    // without it streamRunEvents can never resolve the run and detection would
    // always return zero candidates); streaming and signals use the inner client.
    const detectionSmithersClient: SmithersClient | undefined =
      smithersClient instanceof GatewayRegistryClient
        ? {
            spawn: (seed) => smithersClient.spawn(seed),
            steer: (upid, payload) => smithersClient.client.steer(upid, payload),
            signal: (upid, payload) => smithersClient.client.signal(upid, payload),
            pause: (upid) => smithersClient.client.pause(upid),
            resume: (upid) => smithersClient.client.resume(upid),
            halt: (upid) => smithersClient.client.halt(upid),
            streamRunEvents: (upid, options) => smithersClient.client.streamRunEvents(upid, options),
          }
        : undefined;
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
      // Abort every multi-backend build across every UPID: backends SIGKILL
      // their subprocesses and the per-UPID preview servers stop, all inside the
      // orchestrator's ~2s abort budget — no build outlives the emergency stop.
      await this.buildOrchestrator.abortEverything().catch(() => undefined);
      // Drop any in-flight idea candidates so the bubble clears with the kill-all,
      // and stop the capture creation loop.
      this.detection.clear();
      this.#detectionPrimaryId = null;
      this.#captureMode = false;
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

  // IDEA TRAY -> BUILD. Accept a SPECIFIC ledger candidate by id, spawning
  // through the exact same accept path acceptPendingSuggestion takes for the
  // primary (the seam's build:true spawn), so the idea-builder runs and the
  // process gains previewUrl/buildStatus. 404-free: an unknown id (already
  // accepted/dismissed/superseded) is a no-op returning the current snapshot.
  async acceptIdea(id: string, correlationId = `corr-idea-accept-${crypto.randomUUID()}`): Promise<ProjectorSnapshot> {
    if (this.#emergencyTriggered) {
      return this.#snapshot;
    }
    const candidate = this.detection.candidates().find((entry) => entry.id === id);
    if (candidate === undefined) {
      return this.#snapshot;
    }
    this.recordExternalTrace({
      event: "idea.accept",
      level: "info",
      sessionId: this.sessionId,
      correlationId,
      meta: { id, pitch: candidate.pitch, confidence: candidate.confidence },
    });
    const suggestion = pendingSuggestionFromCandidate(candidate, correlationId, this.#clock() + DETECTION_BUBBLE_TTL_MS);
    try {
      const spawn = await this.acceptanceController.spawnAccepted(suggestion, correlationId);
      if (spawn.accepted) {
        // Consume the accepted candidate (suppresses its pitch for the cooldown)
        // and clear the bubble if this WAS the surfaced primary.
        this.detection.accept(id);
        if (this.#detectionPrimaryId === id) {
          this.#detectionPrimaryId = null;
        }
        await this.spawnAck(spawn, correlationId);
        this.subscribeRunEvents(spawn.process.upid, spawn.process.runId);
      }
    } catch (error) {
      this.recordExternalTrace({
        event: "idea.accept.error",
        level: "error",
        sessionId: this.sessionId,
        correlationId,
        meta: { id, message: error instanceof Error ? error.message : String(error) },
      });
    }
    this.publish();
    return this.#snapshot;
  }

  // IDEA TRAY -> DISMISS. Drop the candidate from the ledger AND suppress its
  // pitch for the accept-cooldown window (the room said no — it must not
  // immediately re-pop). Nothing is built. Unknown id → no-op, current snapshot.
  dismissIdea(id: string, correlationId = `corr-idea-dismiss-${crypto.randomUUID()}`): ProjectorSnapshot {
    const dismissed = this.detection.dismiss(id);
    if (dismissed === null) {
      return this.#snapshot;
    }
    this.recordExternalTrace({
      event: "idea.dismiss",
      level: "info",
      sessionId: this.sessionId,
      correlationId,
      meta: { id, pitch: dismissed.pitch },
    });
    // If the dismissed candidate was feeding the acceptance pending, clear it so
    // room speech stops routing into accept/decline for an idea that is gone.
    const pending = this.acceptanceController.currentPending();
    if (pending !== null && pending.suggestionId === `sug-${id}`) {
      this.#pendingOwner.clear();
    }
    if (this.#detectionPrimaryId === id) {
      this.#detectionPrimaryId = null;
    }
    this.publish();
    return this.#snapshot;
  }

  // QR import: a validated GitHub URL joins the fleet as a project in progress.
  // The process spawns through the registry (so halt/emergency-stop lifecycle
  // applies) with a repo-derived callsign; the import-only display facts (source
  // URL, task line, display casing) live in #imports and are merged into the
  // snapshot. Invalid URLs never reach the registry.
  async importProject(url: string, correlationId = `corr-import-${crypto.randomUUID()}`): Promise<ImportProjectResult> {
    if (this.#emergencyTriggered) {
      return { ok: false, error: "Emergency stop is active." };
    }
    const parsed = parseGitHubImportUrl(url);
    if (!parsed.ok) {
      return parsed;
    }
    const callsign = callsignFromRepo(parsed.repo);
    const task = `Imported from GitHub: ${parsed.owner}/${parsed.repo}`;
    // Imported projects are display fleet entries (like the seeded demo fleet),
    // not voice-steered agents, so the spoken-collision guard must not reject a
    // repo whose name happens to sound like a control word. Suspend it for this
    // spawn only — live voice spawns keep it on (mirrors seedDemoFleet).
    const priorGuard = process.env.VIBERSYN_RBG_DISABLE_CALLSIGN_COLLISION_GUARD;
    process.env.VIBERSYN_RBG_DISABLE_CALLSIGN_COLLISION_GUARD = "1";
    let spawn: Awaited<ReturnType<ProcessRegistry["spawn"]>>;
    try {
      spawn = await this.registry.spawn({
        callsign,
        workflow: "github-import",
        prompt: task,
        input: { source: "github-import", url: parsed.url, owner: parsed.owner, repo: parsed.repo },
        correlationId,
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (priorGuard === undefined) {
        delete process.env.VIBERSYN_RBG_DISABLE_CALLSIGN_COLLISION_GUARD;
      } else {
        process.env.VIBERSYN_RBG_DISABLE_CALLSIGN_COLLISION_GUARD = priorGuard;
      }
    }
    if (!spawn.accepted) {
      return { ok: false, error: spawn.spokenAck };
    }
    this.#imports.set(spawn.process.upid, { url: parsed.url, callsign, task });
    this.recordExternalTrace({
      event: "project.import",
      level: "info",
      sessionId: this.sessionId,
      correlationId,
      upid: spawn.process.upid,
      meta: { url: parsed.url, owner: parsed.owner, repo: parsed.repo, callsign },
    });
    this.publish();
    return { ok: true, snapshot: this.#snapshot };
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

  // IDEA CAPTURE mode. Flip on => detection runs eagerly on every final (a
  // rate-limited force-detect, no word/turn schedule). Capture is DETECTION-only:
  // surfaced ideas land in the tray/bubble for an explicit accept — auto-building
  // requires the separate AUTO-BUILD toggle. Turning it on kicks a detection
  // round NOW over whatever is already in the window, so an idea just described
  // is captured without waiting for the next utterance. Flip off => back to
  // passive detection. Returns the fresh snapshot.
  setCaptureMode(on: boolean, correlationId = `corr-capture-toggle-${crypto.randomUUID()}`): ProjectorSnapshot {
    // Emergency stop is sticky and clears capture mode; don't let it be re-enabled
    // (mirrors setSteeringTarget/acceptPendingSuggestion). Otherwise POST /api/capture
    // or the UI button would trivially undo the kill-all reset.
    if (this.#emergencyTriggered) {
      return this.#snapshot;
    }
    const changed = this.#captureMode !== on;
    this.#captureMode = on;
    this.recordExternalTrace({
      event: "capture.mode.set",
      level: "info",
      sessionId: this.sessionId,
      correlationId,
      meta: { on },
    });
    if (on && changed && !this.#emergencyTriggered) {
      // Start the creation loop immediately over the current window.
      void this.detection.forceDetect(`corr-capture-${correlationId}`).catch(() => undefined);
    }
    this.publish();
    return this.#snapshot;
  }

  captureMode(): boolean {
    return this.#captureMode;
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
    // Onboarding glue (fire-and-forget — the mic must never block on audio):
    // REQ-1 consent disclosure once per session, then the authoritative
    // listening indicator flips streaming (E2 on the stopped→streaming edge).
    void this.announceConsentOnce(correlationId);
    void this.#onboarding.micOpened(correlationId).catch(() => undefined);
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
        // Authoritative listening indicator: mic-stream truth flips back off.
        void this.#onboarding.micClosed(correlationId).catch(() => undefined);
        this.publish();
        await drained.catch(() => undefined);
      },
    };
  }

  // Fold one ASR observation into the live transcript, then — for FINAL results
  // only — drive the ambient SuggestionEngine. Interim (partial) results replace
  // the single in-flight line and must NOT move the engine's gates.
  private async ingestTranscript(observation: TranscriptObservation, correlationId: string): Promise<void> {
    // Whole-session persistence guard (onboarding glue): transcripts ONLY may be
    // folded into published/persisted state — a payload smuggling raw audio
    // throws here, before any fold, and surfaces as a mic.session.error trace.
    this.#onboarding.guardTranscript(observation);
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
      // Voice control (desk mode): a recognized wake phrase makes this utterance
      // a COMMAND, not room material. Execute it and return — the utterance must
      // NOT be ingested as an idea-detection turn (or routed to steering/
      // acceptance), otherwise "vibersyn build it" would pollute the transcript
      // window AND be classified as an accept/decline answer.
      const wake = matchWakePhrase(text, this.#wakeWord);
      if (wake !== null) {
        await this.routeVoiceCommand(wake, observation, correlationId);
        return;
      }

      // Wake/earcon fast-path (GAP-006): every FINAL observation reaches the active
      // Cue path (harness or fallback) exactly once, so a 'viber' wake word emits an
      // earcon trace. This is orthogonal to the suggestion/acceptance routing below.
      await this.driveCueBridge(observation, correlationId);

      // VOICE CALLSIGN STEERING: an utterance ADDRESSED to a live process by its
      // callsign ("atlas, make the header blue") sets that process as the
      // steering target and routes the remainder as steer text — before any
      // ambient routing. Reuses the wake router's fuzzy matcher with the
      // callsign as the wake word, so the same guardrails apply (start-of-
      // utterance anchor, first-letter match, edit budget, phonetic key).
      const addressed = this.matchCallsignAddress(text);
      if (addressed !== null) {
        await this.routeCallsignSteering(addressed, observation, correlationId);
        return;
      }

      // FULL voice grammar (routing/dispatch): mute/unmute/panic/stop/pause/
      // resume/pause-all/status plus callsign-addressed steering. Precedence:
      // the wake table above claims wake-addressed utterances and the fuzzy
      // callsign matcher above claims start-of-utterance callsign addresses;
      // every other FINAL flows here. A command or steering instruction is
      // executed against the live registry/controllers and CONSUMED; a "pass"
      // falls through unchanged so ambient talk still reaches acceptance/
      // detection.
      if (await this.routeGrammar(observation, correlationId)) {
        return;
      }

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

  // VOICE CALLSIGN STEERING match: does this utterance ADDRESS a live process by
  // callsign in its first tokens? Reuses matchWakePhrase (the wake router's
  // fuzzy matcher) with the callsign as the canonical word: the window must
  // start within the first two tokens, anchor on the callsign's first letter,
  // and stay within the edit/phonetic budget — so ordinary room talk that
  // merely mentions a callsign mid-sentence never hijacks steering.
  private matchCallsignAddress(text: string): { upid: string; callsign: string; remainder: string } | null {
    for (const record of this.registry.activeRecords()) {
      const match = matchWakePhrase(text, record.callsign);
      if (match !== null) {
        return { upid: record.upid, callsign: record.callsign, remainder: match.afterWake };
      }
    }
    return null;
  }

  // Route one callsign-addressed FINAL: select the process as the steering
  // target, then steer the remainder of the utterance into its agent loop (the
  // registry forwards it to the smithers client AND fires the orchestrator's
  // correction re-run on ready builds). A bare address ("atlas.") only selects —
  // subsequent lines route via the steering target.
  private async routeCallsignSteering(
    addressed: { upid: string; callsign: string; remainder: string },
    observation: TranscriptObservation,
    correlationId: string,
  ): Promise<void> {
    const steerCorrelationId = `${correlationId}-${observation.utteranceId}-callsign`;
    this.recordExternalTrace({
      event: "steering.callsign",
      level: "info",
      sessionId: this.sessionId,
      correlationId: steerCorrelationId,
      upid: addressed.upid,
      meta: { callsign: addressed.callsign, remainder: addressed.remainder, text: observation.text },
    });
    this.setSteeringTarget(addressed.upid, steerCorrelationId);
    const remainder = addressed.remainder.trim();
    if (remainder.length === 0) {
      return;
    }
    try {
      await this.registry.steer(addressed.upid, { text: remainder, source: "live-transcript" }, steerCorrelationId);
    } catch (error) {
      this.recordExternalTrace({
        event: "steering.route.error",
        level: "error",
        sessionId: this.sessionId,
        correlationId: steerCorrelationId,
        upid: addressed.upid,
        meta: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    this.publish();
  }

  // REQ-1 consent disclosure, once per session (idempotent via the scheduler):
  // spoken+traced through the onboarding glue and folded into the live
  // transcript as a "vibersyn" line so the wall shows the disclosure too.
  private async announceConsentOnce(correlationId: string): Promise<void> {
    if (this.#onboarding.consentSpoken()) {
      return;
    }
    try {
      const { line } = await this.#onboarding.announceConsent();
      this.#liveFinals = [...this.#liveFinals, line].slice(-MAX_LIVE_TRANSCRIPT_LINES);
      this.publish();
    } catch (error) {
      this.recordExternalTrace({
        event: "consent.error",
        level: "error",
        sessionId: this.sessionId,
        correlationId,
        meta: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  // Execute one recognized wake utterance (the server-side wake router — desk
  // mode's primary voice control). The command text after the wake phrase maps
  // to a runtime action via the fixed command table; an unrecognized remainder
  // does nothing but is still traced so a mis-heard command is diagnosable. The
  // snapshot's `voice` field records the last executed command so walls can
  // flash confirmation.
  private async routeVoiceCommand(wake: WakePhraseMatch, observation: TranscriptObservation, correlationId: string): Promise<void> {
    const command = parseVoiceCommand(wake.afterWake);
    const voiceCorrelationId = `${correlationId}-${observation.utteranceId}-voice`;
    this.recordExternalTrace({
      event: "voice.command",
      level: "info",
      sessionId: this.sessionId,
      correlationId: voiceCorrelationId,
      meta: { command: command?.kind ?? "unrecognized", matched: wake.matched, text: observation.text },
    });
    if (command === null) {
      // Near-miss soft landing (onboarding): the room ADDRESSED us (wake phrase
      // matched) but the remainder matched nothing. Instead of dropping it
      // silently, offer "Did you mean …?" for the first 20 minutes of the session.
      await this.offerNearMissSoftLanding(wake.afterWake, voiceCorrelationId);
      return;
    }
    // Stamp the confirmation BEFORE executing so every publish the action itself
    // triggers already carries it.
    this.#voice = { lastCommand: voiceCommandLabel(command), at: new Date().toISOString() };
    switch (command.kind) {
      case "capture-on":
        this.setCaptureMode(true, voiceCorrelationId);
        break;
      case "capture-off":
        this.setCaptureMode(false, voiceCorrelationId);
        break;
      case "build":
        // Same path as POST /api/suggestion/accept: the pending suggestion when
        // one is delivered, else the top ready (primary) detection candidate.
        await this.acceptPendingSuggestion(voiceCorrelationId);
        break;
      case "dismiss":
        this.dismissTopIdea(voiceCorrelationId);
        break;
      case "auto-on":
        this.setAutoAccept(true, voiceCorrelationId);
        break;
      case "auto-off":
        this.setAutoAccept(false, voiceCorrelationId);
        break;
      case "emergency":
        await this.emergencyStop(voiceCorrelationId);
        break;
    }
    this.publish();
  }

  // Voice "dismiss": drop the CURRENT primary bubble, or — when verification is
  // withholding the primary — the strongest ready candidate, so "vibersyn
  // dismiss" always acts on whatever the room is being shown/offered.
  private dismissTopIdea(correlationId: string): void {
    const target =
      this.detection.primary() ??
      this.detection
        .candidates()
        .filter((candidate) => candidate.status === "ready")
        .reduce<IdeaCandidate | null>((best, candidate) => (best === null || candidate.confidence > best.confidence ? candidate : best), null);
    if (target !== null) {
      this.dismissIdea(target.id, correlationId);
    }
  }

  // Evaluate the onboarding near-miss soft landing over an addressed-but-
  // unrecognized utterance and, on a near miss, speak + trace the recovery
  // prompt. Best-effort: never throws into the ingest path.
  private async offerNearMissSoftLanding(text: string, correlationId: string): Promise<void> {
    const result = this.#softLanding.evaluate(text);
    if (result.kind !== "near-miss") {
      return;
    }
    this.recordExternalTrace({
      event: "voice.nearmiss",
      level: "info",
      sessionId: this.sessionId,
      correlationId,
      meta: {
        suggestion: result.text,
        commandId: result.commandId,
        phrase: result.phrase,
        distance: result.distance,
        heard: text,
      },
    });
    await this.emitOutput(
      { channel: "tts", text: result.text, wordCount: countSpokenWords(result.text), summarized: false },
      correlationId,
    );
    this.publish();
  }

  // Run one non-wake FINAL through the routing grammar (src/routing/dispatch)
  // and execute the decision against the live registry/controllers. Returns
  // true when the utterance was consumed (command or steering), false to fall
  // through to click-steer/acceptance/detection. Acceptance answers are
  // deliberately NOT claimed here (pendingSuggestion: null): the semantic
  // AcceptanceClassifier owns yes/no while a suggestion is pending.
  private async routeGrammar(observation: TranscriptObservation, correlationId: string): Promise<boolean> {
    const nowMs = this.#clock();
    const grammarCorrelationId = `${correlationId}-${observation.utteranceId}-grammar`;
    const decision = dispatchUtterance(observation, {
      sessionId: this.sessionId,
      activeProcesses: this.registry.activeRecords().map((record) => ({
        upid: record.upid,
        callsign: record.callsign,
        // activeRecords never returns a dead process; the fold is type-level
        // (the dispatch ActiveProcess state union has no "dead").
        state: record.state === "dead" ? ("halted" as const) : record.state,
        selected: record.selected,
      })),
      openWindow: this.#routingWindow,
      pendingSuggestion: null,
      suggestionEligible: false,
      nowMs,
      trace: this.trace,
      vocabulary: this.#routingVocabulary,
    });

    if (decision.kind === "local") {
      await this.applyLocalEffect(decision, grammarCorrelationId, nowMs);
      this.publish();
      return true;
    }
    if (decision.kind === "action") {
      // Targetless informational commands (status / pause-all) match ANYWHERE
      // in an utterance at the dispatch layer, so an ambient mention ("a status
      // board for the migration") would hijack room material away from idea
      // detection. Execute them only when the utterance is command-shaped —
      // addressed by a routing wake word or short enough to be a bare command —
      // otherwise fall through to ambient handling.
      if (
        (decision.commandId === "status" || decision.commandId === "pauseAll") &&
        !this.isCommandShaped(observation.text)
      ) {
        return false;
      }
      await this.executeRoutedAction(decision, grammarCorrelationId, nowMs);
      this.publish();
      return true;
    }
    // decision.kind === "route" cannot occur (suggestionEligible is false).
    // Addressed near-miss ("abort" with no unambiguous target, "stop" with no
    // window, "pause that one", …): offer the onboarding soft landing and
    // consume the utterance so command-shaped speech is not fed to idea
    // detection. EXCEPTION: accept/decline near-misses ("yes"/"no" — dispatch
    // marks them near-miss because we pass pendingSuggestion: null) MUST fall
    // through so the AcceptanceController keeps owning acceptance answers.
    // All other passes (ambient / low-confidence / rejected-no-target) fall
    // through too.
    if (
      decision.kind === "pass" &&
      decision.reason === "near-miss" &&
      decision.addressed &&
      decision.commandId !== "accept" &&
      decision.commandId !== "decline"
    ) {
      await this.offerNearMissSoftLanding(observation.text, grammarCorrelationId);
      return true;
    }
    return false;
  }

  // Map one routed DispatchedAction onto the real registry/orchestrator method.
  // Handler → runtime mapping (COMMAND_HANDLERS in src/routing/handlers.ts):
  //   steer/selectAndSteer -> ProcessRegistry.steer (+ open/refresh #routingWindow)
  //   pause                -> ProcessRegistry.pause
  //   resume               -> ProcessRegistry.resume
  //   pauseAll             -> ProcessRegistry.pauseAll
  //   stop                 -> ProcessRegistry.halt (trigger "stop")
  //   panic                -> ProcessRegistry.halt (trigger "panic") + panic earcon/ack
  //   status               -> ProcessRegistry.statusSummary() spoken via TTS
  //   accept (spawn)       -> acceptPendingSuggestion (the real accept->build path)
  // Failures are traced, never thrown — a bad command must not abort ingestion.
  private async executeRoutedAction(
    decision: Extract<DispatchDecision, { kind: "action" }>,
    correlationId: string,
    nowMs: number,
  ): Promise<void> {
    const action = decision.action;
    try {
      switch (action.type) {
        case "steer": {
          if (action.targetUPID === null) {
            return;
          }
          await this.registry.steer(action.targetUPID, action.payload, correlationId);
          this.openOrTouchRoutingWindow(decision, nowMs);
          return;
        }
        case "pause":
          if (action.targetUPID === null) {
            return;
          }
          await this.registry.pause(action.targetUPID, correlationId);
          return;
        case "resume":
          if (action.targetUPID === null) {
            return;
          }
          await this.registry.resume(action.targetUPID, correlationId);
          return;
        case "halt": {
          if (action.targetUPID === null) {
            return;
          }
          const trigger = decision.commandId === "panic" ? "panic" : "stop";
          await this.registry.halt(action.targetUPID, correlationId, trigger);
          if (this.#routingWindow?.upid === action.targetUPID) {
            this.#routingWindow = null;
          }
          if (decision.commandId === "panic") {
            for (const output of panicHaltOutputs()) {
              await this.emitOutput(output, correlationId);
            }
          }
          return;
        }
        case "pauseAll":
          await this.registry.pauseAll(correlationId);
          return;
        case "status": {
          const summary = this.registry.statusSummary();
          await this.emitOutput(
            { channel: "tts", text: summary, wordCount: countSpokenWords(summary), summarized: false },
            correlationId,
          );
          return;
        }
        case "spawn":
          // Voice "accept" — same real accept->build->preview path as click/wake-table build.
          await this.acceptPendingSuggestion(correlationId);
          return;
      }
    } catch (error) {
      this.recordExternalTrace({
        event: "voice.grammar.error",
        level: "error",
        sessionId: this.sessionId,
        correlationId,
        upid: action.targetUPID ?? undefined,
        meta: {
          commandId: decision.commandId,
          actionType: action.type,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  // Map one local routing effect onto the runtime.
  //   wake  -> StageSequencer ACTIVE_LISTEN (E1)   mute   -> MuteController.engage
  //   unmute -> MuteController.release + fresh session
  //   declineSuggestion -> dismissTopIdea
  //   openSteeringWindow -> #routingWindow + setSteeringTarget (visible marker)
  //   closeSteeringWindow -> clear both
  private async applyLocalEffect(
    decision: Extract<DispatchDecision, { kind: "local" }>,
    correlationId: string,
    nowMs: number,
  ): Promise<void> {
    switch (decision.localEffect) {
      case "mute":
        await this.muteController.engage({ correlationId });
        return;
      case "unmute":
        await this.muteController.release({ correlationId, trigger: "unmute-word" });
        this.#session.startFreshSession();
        return;
      case "wake":
        await this.driveTransition("ACTIVE_LISTEN", {
          correlationId,
          reason: "wake-detected",
          audible: { channel: "earcon", id: "E1" },
        });
        return;
      case "declineSuggestion":
        this.dismissTopIdea(correlationId);
        return;
      case "openSteeringWindow": {
        if (decision.targetUPID === null || decision.callsign === null) {
          return;
        }
        this.#routingWindow = {
          upid: decision.targetUPID,
          callsign: decision.callsign,
          openedAtMs: nowMs,
          lastActivityMs: nowMs,
        };
        // Mirror onto the click-steer target so the wall shows the steering
        // marker; "done" (closeSteeringWindow) clears both.
        this.setSteeringTarget(decision.targetUPID, correlationId);
        await this.emitOutput({ channel: "ack", id: "route-steer" }, correlationId);
        return;
      }
      case "closeSteeringWindow":
        this.#routingWindow = null;
        this.clearSteeringTarget(correlationId);
        return;
    }
  }

  // "Command-shaped" heuristic for targetless informational commands: the room
  // either addressed us with a routing wake word ("viber status please") or the
  // utterance is short enough (<= 4 tokens) to be a bare spoken command.
  private isCommandShaped(text: string): boolean {
    if (includesPhrase(text, this.#routingVocabulary.wake)) {
      return true;
    }
    return normalizeSpeech(text).split(/\s+/u).filter(Boolean).length <= 4;
  }

  // Open (selectAndSteer) or refresh (steer inside the window) the dispatch
  // steering window so follow-up instructions keep routing to the same process
  // until "done" or steerIdleSeconds of silence.
  private openOrTouchRoutingWindow(decision: Extract<DispatchDecision, { kind: "action" }>, nowMs: number): void {
    if (decision.targetUPID === null || decision.callsign === null) {
      return;
    }
    if (this.#routingWindow?.upid === decision.targetUPID) {
      this.#routingWindow.lastActivityMs = nowMs;
      return;
    }
    this.#routingWindow = {
      upid: decision.targetUPID,
      callsign: decision.callsign,
      openedAtMs: nowMs,
      lastActivityMs: nowMs,
    };
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
    // IDEA CAPTURE mode forces a detection round on every final (bypassing the
    // passive word/turn schedule) so a deliberately-captured idea surfaces fast.
    await this.detection.ingestTurnAndDetect(
      {
        speaker: observation.speaker,
        text: observation.text,
        atMs: nowMs,
        correlationId: `${correlationId}-${observation.utteranceId}`,
      },
      { force: this.#captureMode },
    );
  }

  // React to a detection round: a newly-READY primary candidate becomes the idea
  // bubble. It is delivered (spoken) once, fed into the acceptance pending so a
  // spoken/click accept acts on it, and — when AUTO-BUILD is on — built immediately.
  // The snapshot's bubble is always sourced live from detection.primary(), so this
  // only handles the side effects of a NEW idea surfacing.
  private async onDetectionUpdate(snapshot: DetectionSnapshot): Promise<void> {
    const primary = snapshot.primary;
    // If the surfaced idea disappeared (retraction, veto, supersede) or changed,
    // clear the detection-fed acceptance pending for the DEPARTED candidate —
    // otherwise room speech keeps routing into accept/decline for up to the
    // accept window with no bubble on screen.
    const pending = this.acceptanceController.currentPending();
    if (pending !== null && pending.suggestionId.startsWith("sug-") && pending.suggestionId !== `sug-${primary?.id ?? ""}`) {
      this.#pendingOwner.clear();
    }
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
      // Build the surfaced idea immediately ONLY when AUTO-BUILD is on. IDEA
      // CAPTURE mode deliberately does NOT imply building anymore: capture is
      // eager detection, and the room confirms via the tray/keyboard/voice. The
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

  publishNow(): ProjectorSnapshot {
    this.publish();
    return this.#snapshot;
  }

  private buildSnapshot(previous: ProjectorSnapshot = this.#snapshot): BuildloopSnapshot {
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
      ideas: this.ideasSnapshot(),
      voice: this.#voice,
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
      captureMode: this.#captureMode,
      // Multi-backend build loop: the registered backend roster with enabled +
      // last-probed availability — the wall's toggle chips (POST /api/backends).
      backends: this.buildSelector.snapshot(),
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

  // The idea TRAY mirrors the WHOLE detection ledger (ready first, strongest
  // first) — not just the single primary bubble — so the room can explicitly
  // build/dismiss each candidate. Muted/stopped rooms surface no ideas, the same
  // invariant as the bubble: never show listening-derived content while the room
  // believes it is not being listened to.
  private ideasSnapshot(): IdeaTrayItem[] {
    if (this.#emergencyTriggered || this.muteController.isMuted()) {
      return [];
    }
    return ideaTrayFromCandidates(this.detection.candidates());
  }

  private processSnapshots(): BuildloopProcess[] {
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
      // GitHub-imported project (QR flow): a display fleet entry whose preview IS
      // the repo URL, shown "active"/"imported" while live. Lifecycle (halt /
      // emergency stop) still comes from the registry record, so a dead import
      // shows halted like everything else.
      const imported = this.#imports.get(record.upid);
      // Multi-backend BUILD LOOP fragment: one entry per fanned-out backend
      // (status/progress/previewUrl/summary/slideshowUrl). A dead process shows
      // no builds — the orchestrator tore its servers down on halt. The legacy
      // per-process previewUrl/buildStatus derive from builds[] when the legacy
      // single-build path did not run (mergeLegacyBuildState), so the old
      // "Preview ->" link stays lit on orchestrated builds.
      const builds: ProcessBuildSnapshot[] = record.state === "dead" ? [] : this.registry.builds(record.upid);
      const orchestrated = mergeLegacyBuildState(builds);
      return {
        upid: record.upid,
        runId: record.runId,
        previewUrl: record.state === "dead" ? null : imported?.url ?? build?.previewUrl ?? orchestrated?.previewUrl ?? null,
        buildStatus: build?.status ?? orchestrated?.status ?? null,
        builds,
        // The registry normalizes callsigns to lowercase for voice matching; the
        // projector shows the pre-authored display casing ("Atlas"/"COBALT"-style
        // repo callsigns for imports).
        callsign: imported?.callsign ?? demo?.callsign ?? record.callsign,
        state: record.state === "dead" ? "halted" : imported !== undefined ? "active" : live?.state ?? projectorState(record.state),
        selected: record.selected,
        // Click-to-steer marker: this process is the live steering target, so
        // subsequent FINAL transcript lines route to it. A dead record never steers.
        steering: record.state !== "dead" && this.#steeringUpid === record.upid,
        // A GitHub import's display contract is its "Imported from GitHub: …"
        // line — the registry's inferred title (project naming) must not shadow
        // it. Everything else prefers the inferred title.
        task: imported?.task ?? record.title ?? demo?.task ?? "Vibersyn task",
        model: demo?.model ?? "runtime",
        progressLabel: record.state === "dead" ? "halted" : imported !== undefined ? "imported" : demo?.progressLabel ?? record.lastAction,
        progress: record.state === "dead" ? 100 : live?.progress ?? demo?.progress ?? Math.min(95, record.progressSeq * 12),
        lastOutput: record.state === "dead" ? "Halted by emergency stop." : live?.lastOutput ?? demo?.lastOutput ?? record.lastAction,
        lastAction: record.lastAction === "spawn" && demo !== undefined ? demo.events[0] ?? record.lastAction : record.lastAction,
        events: record.state === "dead" ? [...(demo?.events ?? []), "halted"] : demo?.events ?? [record.lastAction],
        ...(imported === undefined ? {} : { source: { kind: "github-import" as const, url: imported.url } }),
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

  // Speak a fired suggestion and record the SUGGESTION_DELIVERY transition.
  private async deliverSuggestionAudio(suggestion: PendingSuggestion, correlationId: string): Promise<void> {
    await this.ensureActiveListen(correlationId);
    const spoken = await ttsDecision(suggestionSpeech(suggestion), { fallback: "I have a suggestion.", summarizer: this.#summarizer });
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
      audible: await ttsDecision(ackText, { fallback: "Spawned.", summarizer: this.#summarizer }),
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

// Near-miss vocabulary: the routing grammar's documented commands PLUS the wake
// table's phrases (voice-commands.ts COMMAND_TABLE), so "vibersyn build ot"
// lands on "Did you mean 'build it'?". Ids reuse the closest DocumentedCommandId
// (they only surface in trace meta). Bare "yes"/"no" are deliberately excluded —
// at <=3 letters a distance-2 match fires on ordinary speech.
const SOFT_LANDING_COMMANDS: readonly DocumentedCommand[] = [
  { id: "wake", spokenForm: "capture / start capturing / listen", effect: "enable idea capture" },
  { id: "mute", spokenForm: "stop capturing / capture off / stand down", effect: "disable idea capture" },
  { id: "accept", spokenForm: "build it / build that / build this / accept / ship it", effect: "build the surfaced idea" },
  { id: "decline", spokenForm: "dismiss / skip / next", effect: "dismiss the surfaced idea" },
  { id: "panic", spokenForm: "emergency / stop everything / kill everything / shut down", effect: "emergency stop" },
  { id: "pauseAll", spokenForm: "pause all", effect: "pause all running processes" },
  { id: "status", spokenForm: "status", effect: "speak active-process summary" },
  { id: "stop", spokenForm: "stop / halt", effect: "halt selected process" },
  { id: "pause", spokenForm: "pause", effect: "pause target process" },
  { id: "resume", spokenForm: "resume", effect: "resume target process" },
  { id: "endSteering", spokenForm: "done / back", effect: "close steering window" },
];

// Spoken word count for grammar-generated TTS output decisions.
function countSpokenWords(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
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

// SmithersClient facade over the live ProcessRegistry so the SeamDispatcher's
// HTTP/WS actions drive the same fleet as voice. `signal` maps to steer (the
// registry exposes no separate signal channel); run-event streaming is owned by
// RunEventDriver, so the facade's stream is empty.
function registrySeamClient(registry: ProcessRegistry): SmithersClient {
  const corr = (): string => `corr-seam-${crypto.randomUUID()}`;
  return {
    async spawn(seed) {
      const result = await registry.spawn(seed);
      if (!result.accepted) {
        throw new Error(result.spokenAck);
      }
      return result.spawn;
    },
    steer: (upid, payload) => registry.steer(upid, payload, corr()),
    signal: (upid, payload) => registry.steer(upid, payload, corr()),
    pause: (upid) => registry.pause(upid, corr()),
    resume: (upid) => registry.resume(upid, corr()),
    halt: (upid) => registry.halt(upid, corr(), "seam"),
    async *streamRunEvents() {
      // Live streaming is RunEventDriver's job; the seam facade has no source.
    },
  };
}

// Read-only CorrelationStore view over the registry. The registry is the source
// of truth: upsert/update are accepted no-ops (the registry methods invoked by
// registrySeamClient already applied the state change); reads project registry
// records into CorrelationRecords so statusSummary reports the real fleet.
class RegistryCorrelationView implements CorrelationStore {
  readonly #registry: ProcessRegistry;

  constructor(registry: ProcessRegistry) {
    this.#registry = registry;
  }

  async load(): Promise<CorrelationRecord[]> {
    return this.#project(this.#registry.records());
  }

  async allActive(): Promise<CorrelationRecord[]> {
    return this.#project(this.#registry.activeRecords());
  }

  async findByUPID(upid: string): Promise<CorrelationRecord | undefined> {
    return this.#project(this.#registry.records()).find((record) => record.upid === upid);
  }

  async findByRunId(runId: string): Promise<CorrelationRecord | undefined> {
    return this.#project(this.#registry.records()).find((record) => record.runId === runId);
  }

  async upsert(): Promise<void> {
    // Registry already recorded the spawn (registrySeamClient.spawn).
  }

  async update(upid: string, _patch: Partial<Omit<CorrelationRecord, "upid">>): Promise<CorrelationRecord> {
    const record = await this.findByUPID(upid);
    if (record === undefined) {
      throw new Error(`No UPID correlation exists for ${upid}.`);
    }
    return record;
  }

  #project(records: readonly RegistryProcess[]): CorrelationRecord[] {
    return records.map((record) =>
      createCorrelationRecord({
        upid: record.upid,
        runId: record.runId,
        callsign: record.callsign,
        correlationId: `corr-${record.upid}`,
        state: record.state === "dead" ? "halted" : record.state,
        nowMs: record.updatedAtMs,
      }),
    );
  }
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

// 0 or a non-number means "no explicit cap" — use a high finite ceiling rather
// than Infinity so refusal traces stay JSON-safe.
function resolveMaxConcurrentProcesses(env: Record<string, string | undefined>): number {
  const raw = env.VIBERSYN_MAX_CONCURRENT_PROCESSES?.trim();
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return Math.floor(parsed);
  }
  return 16;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Recover the detection candidate id from a PendingSuggestion id minted by
// pendingSuggestionFromCandidate (`sug-<candidateId>`).
function candidateIdFromSuggestionId(suggestionId: string): string | null {
  return suggestionId.startsWith("sug-") ? suggestionId.slice("sug-".length) : null;
}

// --- Duplicate-spawn guard ---------------------------------------------------
//
// Known bug this closes: one utterance could spawn upid-1 AND upid-2 — e.g. the
// auto-build fire and a click/spoken accept racing on the same surfaced idea, or
// the same pitch re-accepted seconds later. Every accept route funnels through
// the ONE acceptance seam composition builds, so the guard wraps it: a spawn
// whose normalized pitch matches an accept from the last DUPLICATE_ACCEPT_WINDOW_MS,
// or one whose spawn is still in flight, is refused at the seam (the spawner
// surfaces it as accepted:false / reason "seam" — no second process, no ack).

export const DUPLICATE_ACCEPT_WINDOW_MS = 120_000;

// Normalize a pitch for duplicate matching: lowercase, punctuation → spaces,
// collapsed whitespace — so "Build a status board!" and "build a status board"
// count as the same accepted idea.
export function normalizeAcceptPitch(pitch: string): string {
  return pitch
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export interface DuplicateSpawnGuardOptions {
  clock?: () => number;
  windowMs?: number;
  onSuppressed?: (info: { pitch: string; reason: "in-flight" | "recently-accepted"; correlationId: string }) => void;
}

export function createDuplicateSpawnGuard(seam: AcceptanceSpawnSeam, options: DuplicateSpawnGuardOptions = {}): AcceptanceSpawnSeam {
  const clock = options.clock ?? (() => Date.now());
  const windowMs = options.windowMs ?? DUPLICATE_ACCEPT_WINDOW_MS;
  const inFlight = new Set<string>();
  const recentAccepts = new Map<string, number>();
  return {
    async dispatch(action: DispatchedAction) {
      if (action.type !== "spawn") {
        return seam.dispatch(action);
      }
      const payload = action.payload as { pitch?: unknown } | null | undefined;
      const key = typeof payload?.pitch === "string" ? normalizeAcceptPitch(payload.pitch) : "";
      if (key.length === 0) {
        // No comparable pitch (should not happen on the accept path) — pass
        // through rather than wedging every pitchless spawn behind one guard key.
        return seam.dispatch(action);
      }
      const now = clock();
      for (const [pitch, acceptedAtMs] of recentAccepts) {
        if (now - acceptedAtMs >= windowMs) {
          recentAccepts.delete(pitch);
        }
      }
      const reason: "in-flight" | "recently-accepted" | null = inFlight.has(key)
        ? "in-flight"
        : (() => {
            const acceptedAtMs = recentAccepts.get(key);
            return acceptedAtMs !== undefined && now - acceptedAtMs < windowMs ? ("recently-accepted" as const) : null;
          })();
      if (reason !== null) {
        options.onSuppressed?.({ pitch: key, reason, correlationId: action.correlationId });
        return {
          accepted: false as const,
          correlationId: action.correlationId,
          error:
            reason === "in-flight"
              ? "Duplicate accept suppressed: an identical idea is already spawning."
              : "Duplicate accept suppressed: the same idea was accepted moments ago.",
        };
      }
      inFlight.add(key);
      try {
        const result = await seam.dispatch(action);
        if (result.accepted) {
          recentAccepts.set(key, clock());
        }
        return result;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
