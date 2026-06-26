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
import { RunEventDriver, type RunEventStreamClient } from "./run-event-driver";
import type { GatewayRpcTransport, SmithersClient } from "../seam/smithers-client";
import type { AcceptanceSpawnResult } from "../acceptance/spawn";
import { selectAsrProvider, selectDecisionLLM, selectTtsProvider, type ASRProvider, type AsrProviderMode, type DecisionLLM } from "../providers";
import type { ClaudeMessagesTransport, ReplayASRSource, TTSProvider, TTSTransport, VoxTermSegmentSource } from "../providers";
import { drainTtsStream, type TtsAudioSink } from "./tts-sink";
import { selectAudioSink, type AudioSink } from "./audio-device-sink";
import { IdleCueDriver } from "./idle-cue-driver";
import {
  readSuggestionEngineConfig,
  SuggestionEngine,
  type PendingQueuedSuggestion,
  type SuggestionEngineConfig,
  type SuggestionEngineDecision,
} from "../suggest/engine";
import { StageSequencer, type CanonicalStage } from "../spine/stage-sequencer";
import type { LogEvent, OutputDecision, PendingSuggestion } from "../types";
import { demoProjectorSnapshot, withUnmuted } from "../ui/demo-data";
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
  PANOP_SESSION_ID?: string;
  PANOP_INITIAL_MUTED?: string;
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
  readonly muteController: MuteController;
  readonly suggestionEngine: SuggestionEngine;
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
  // PANOP_TTS_PROVIDER=elevenlabs can drain a stubbed synthesized stream in
  // tests/e2e with no network or audio device.
  ttsTransport?: TTSTransport;
  // Injectable real audio sink (ISSUE-0026). When provided it backs BOTH the
  // earcon playPcm path and the TTS drain sink, so a test/the browser-broadcast
  // path (ISSUE-0027) can substitute a sink that actually retains the audible
  // bytes. Unset, the runtime falls back to selectAudioSink(env) — the silent
  // no-op sink unless PANOP_AUDIO_SINK=device.
  audioSink?: AudioSink;
  // Injectable monotonic clock (ISSUE-0024). The whole runtime — including the
  // room-idle gap that drives deferred-suggestion delivery — reads time through
  // this, so tests advance silence deterministically instead of waiting on the
  // wall clock. Defaults to Date.now.
  clock?: () => number;
}

export async function createProjectorRuntime(
  env: ProjectorRuntimeEnv = process.env,
  options: ProjectorRuntimeOptions = {},
): Promise<ProjectorRuntime> {
  const sessionId = env.PANOP_SESSION_ID ?? demoProjectorSnapshot.sessionId;
  const runtime = new LiveProjectorRuntime(sessionId, env, options);
  await runtime.initCueBridge();
  await runtime.seedDemoFleet();

  if (env.PANOP_INITIAL_MUTED !== "0") {
    await runtime.muteForInitialState();
  }

  runtime.publish();
  return runtime;
}

class LiveProjectorRuntime implements ProjectorRuntime {
  readonly asrMode: AsrProviderMode;
  readonly micMode: AsrProviderMode;
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
  readonly acceptanceController: AcceptanceController;
  readonly registry: ProcessRegistry;
  readonly stageSequencer: StageSequencer;
  readonly trace: TraceProcessor;
  readonly emergencyController: EmergencyStopController;
  readonly idleCueDriver: IdleCueDriver;
  readonly runEventDriver: RunEventDriver;
  readonly #clock: () => number;
  readonly #session: EmergencySessionState;
  readonly #env: ProjectorRuntimeEnv;
  readonly #subscribers = new Set<ProjectorRuntimeSubscriber>();
  readonly #outputs: OutputDecision[] = [];
  readonly #demoProcesses: SeededProcessView[];
  #snapshot: ProjectorSnapshot = demoProjectorSnapshot;
  #emergencyTriggered = false;
  // Live microphone state. `#liveFinals` are committed (final) ASR lines;
  // `#interim` is the in-flight partial that Deepgram revises as you speak.
  #liveFinals: TranscriptLine[] = [];
  #interim: TranscriptLine | null = null;
  #micActive = false;
  #micBytes = 0;
  #micLastPublishMs = 0;
  // Ambient-suggestion state, fed by FINAL observations only. `#lastSuggestionDecision`
  // is the latest engine verdict; `#lastFinalAtMs` lets us report room-idle gap.
  #lastSuggestionDecision: SuggestionEngineDecision | null = null;
  #lastFinalAtMs: number | null = null;

  constructor(
    readonly sessionId: string,
    env: ProjectorRuntimeEnv,
    options: ProjectorRuntimeOptions = {},
  ) {
    this.#env = env;
    const clock = options.clock ?? (() => Date.now());
    this.#clock = clock;
    // Single audible-output sink seam (ISSUE-0026): an injected sink wins, else
    // selectAudioSink(env) (no-op unless PANOP_AUDIO_SINK=device). The one sink
    // backs both the earcon playPcm path and the TTS drain so a fired suggestion's
    // synthesized PCM and a spawn earcon land in the same place.
    const audioSink = options.audioSink ?? selectAudioSink(env).sink;
    this.#audio = new BufferedAudioOutput(audioSink);
    this.#ttsSink = audioSink;
    this.tts = selectTtsProvider(env, { transport: options.ttsTransport }).provider;
    this.trace = new TraceProcessor({ clock });
    this.#demoProcesses = demoProjectorSnapshot.processes.map((process) => ({ ...process }));
    this.#session = new EmergencySessionState({ sessionId, listening: true, muted: false });
    this.muteController = new MuteController({
      sessionId,
      now: clock,
      onTrace: (event) => this.recordExternalTrace(event),
      onOutput: (decision) => this.recordOutput(decision),
    });

    // Single ASR selection seam (ISSUE-0016): PANOP_ASR_PROVIDER picks the backend
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
    // the cloud. The replay source falls back to PANOP_MIC_REPLAY_PATH so the live
    // mic path stays deterministically drivable offline.
    const selectedMicAsr = selectAsrProvider(env, {
      sessionId,
      micProfile: true,
      voxtermSource: options.voxtermSource,
      replaySource: options.replaySource ?? env.PANOP_MIC_REPLAY_PATH,
    });
    this.micMode = selectedMicAsr.mode;
    this.#micAsr = this.muteController.protectCloudAsr(selectedMicAsr.provider);
    this.cueAdapter = new CueAdapter({
      sessionId,
      trace: this.trace,
      clock,
      textCueWords: ["panop"],
      // Tag the fallback adapter so its earcon trace is distinguishable from the
      // upstream harness adapter's when operators inspect the live trace (GAP-006).
      earconPath: "fallback",
    });
    // Real decider selected by env (ISSUE-0023): the Claude decider auto-selects
    // when a model credential resolves, else the no-key heuristic. The single
    // selected instance is shared by the SuggestionEngine scoring, the acceptance
    // intent-gate, and the Cue harness fast-path bridge.
    this.#decisionLlm = selectDecisionLLM(env, { claudeTransport: options.decisionTransport }).llm;
    // Single Smithers-client swap point (GAP-004). With no gateway config the
    // projector demo (`bun run start`) drives an in-memory client — the seeded
    // fleet are deterministic fixtures, not real runs, so halting them in memory
    // is correct. When PANOP_SMITHERS_GATEWAY_URL (or an injected transport) is
    // present, selectSmithersClient returns a gateway-backed client that routes
    // spawn/halt to a real Smithers gateway over its RPC transport.
    const smithersClient = selectSmithersClient(env, { transport: options.smithersTransport });
    this.registry = new ProcessRegistry({
      client: smithersClient,
      sessionId,
      now: clock,
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

    const pending = new PendingSuggestionOwner({ clock });
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
      textCueWords: ["panop"],
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
      this.#snapshot = this.buildSnapshot();
      this.publish();
    }
    return this.#snapshot;
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
      // Cue path (harness or fallback) exactly once, so a 'panop' wake word emits an
      // earcon trace. This is orthogonal to the suggestion/acceptance routing below.
      await this.driveCueBridge(observation, correlationId);

      // Once a suggestion is delivered and pending, subsequent FINAL utterances are
      // accept/decline/answer candidates — route them to the AcceptanceController
      // (GAP-003) instead of seeding a fresh suggestion. The suggestion-engine
      // #fire -> acceptanceOwner.acceptSuggestion path sets that pending state.
      if (this.acceptanceController.awaitingAcceptance()) {
        await this.routeAcceptance(observation, correlationId);
      } else {
        await this.driveSuggestionEngine(observation, correlationId);
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

  // Feed one FINAL observation into the SuggestionEngine and retain its verdict.
  // `roomIdleMs` is the quiet gap since the previous final utterance — the engine
  // uses it to decide whether interrupting now is acceptable.
  private async driveSuggestionEngine(observation: TranscriptObservation, correlationId: string): Promise<void> {
    const nowMs = this.#clock();
    const roomIdleMs = this.#lastFinalAtMs === null ? 0 : Math.max(0, nowMs - this.#lastFinalAtMs);
    this.#lastFinalAtMs = nowMs;
    try {
      const decision = await this.suggestionEngine.observe({
        observation,
        correlationId: `${correlationId}-${observation.utteranceId}`,
        roomIdleMs,
      });
      this.#lastSuggestionDecision = decision;
      // A fired suggestion is spoken: open the SUGGESTION_DELIVERY stage with a
      // TTS summary of the pitch + lead question, routed through this.tts (GAP-005).
      if (decision.kind === "fired") {
        await this.deliverSuggestionAudio(decision.suggestion, `${correlationId}-${observation.utteranceId}`);
      }
    } catch (error) {
      this.recordExternalTrace({
        event: "suggestion.engine.error",
        level: "error",
        sessionId: this.sessionId,
        correlationId,
        meta: { message: error instanceof Error ? error.message : String(error) },
      });
    }
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
    const priorGuard = process.env.PANOP_RBG_DISABLE_CALLSIGN_COLLISION_GUARD;
    process.env.PANOP_RBG_DISABLE_CALLSIGN_COLLISION_GUARD = "1";
    try {
      await this.registry.spawn({
        upid: atlas.upid,
        runId: atlas.runId,
        callsign: atlas.callsign,
        workflow: "panopticon-demo",
        prompt: atlas.task,
        input: { task: atlas.task, source: "projector-demo" },
        correlationId: "corr-demo-seed-atlas",
      });
      this.registry.advanceAutonomousTick("corr-demo-seed-atlas-active");
      await this.registry.spawn({
        upid: cobalt.upid,
        runId: cobalt.runId,
        callsign: cobalt.callsign,
        workflow: "panopticon-demo",
        prompt: cobalt.task,
        input: { task: cobalt.task, source: "projector-demo" },
        correlationId: "corr-demo-seed-cobalt",
      });
      this.registry.select(atlas.upid, "corr-demo-seed-select");
    } finally {
      if (priorGuard === undefined) {
        delete process.env.PANOP_RBG_DISABLE_CALLSIGN_COLLISION_GUARD;
      } else {
        process.env.PANOP_RBG_DISABLE_CALLSIGN_COLLISION_GUARD = priorGuard;
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
      ...demoProjectorSnapshot,
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
      trace: [...demoProjectorSnapshot.trace, ...this.trace.events()].slice(-80),
      updatedAt: new Date().toISOString(),
      mic: { mode: this.micMode, active: this.#micActive, bytesReceived: this.#micBytes },
    };
  }

  // Once any live mic line exists, the transcript region reflects the real room
  // audio; before that it shows the seeded demo lines so the panel is never empty.
  private transcriptSnapshot(): TranscriptLine[] {
    if (this.#liveFinals.length === 0 && this.#interim === null) {
      return demoProjectorSnapshot.transcript;
    }
    const lines = [...this.#liveFinals];
    if (this.#interim !== null) {
      lines.push(this.#interim);
    }
    return lines.slice(-MAX_LIVE_TRANSCRIPT_LINES);
  }

  // Reflect the live SuggestionEngine verdict in the idea bubble. Before any
  // FINAL observation has been scored (`#lastSuggestionDecision === null`), keep
  // the demo bubble so the panel is never empty — mirroring the transcript
  // fallback above. Once a real decision exists, map it to a ProjectorSuggestion
  // with gate counters (words/seconds vs the engine's floors) from the engine.
  private suggestionSnapshot(): ProjectorSuggestion {
    const decision = this.#lastSuggestionDecision;
    if (decision === null) {
      return demoProjectorSnapshot.suggestion;
    }
    const live = liveProjectorSuggestion(decision, readSuggestionEngineConfig(this.#env));
    return live ?? demoProjectorSnapshot.suggestion;
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
      return {
        upid: record.upid,
        runId: record.runId,
        // The registry normalizes callsigns to lowercase for voice matching; the
        // projector shows the pre-authored display casing ("Atlas"/"Cobalt").
        callsign: demo?.callsign ?? record.callsign,
        state: record.state === "dead" ? "halted" : live?.state ?? projectorState(record.state),
        selected: record.selected,
        task: demo?.task ?? "Panopticon task",
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
