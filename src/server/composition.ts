import { AcceptanceClassifier } from "../acceptance/classifier";
import { PendingSuggestionOwner } from "../acceptance/pending";
import { AcceptanceController, AcceptanceSpawner, createProcessRegistryAcceptanceSeam } from "../acceptance/spawn";
import { MuteController } from "../audio/mute-controller";
import { CueAdapter } from "../cue/adapter";
import { EMERGENCY_STOP_LATENCY_BUDGET_MS, EmergencySessionState, EmergencyStopController } from "../emergency/stop";
import { TraceProcessor } from "../obs/trace";
import { ProcessRegistry, type RegistryProcess } from "../process/registry";
import { MemorySmithersClient } from "../process/test-helpers";
import { DeepgramNova3ASRProvider, ReplayASRProvider, NoopTTSProvider, type ASRProvider } from "../providers";
import type { TTSProvider } from "../providers";
import { SuggestionEngine } from "../suggest/engine";
import { StageSequencer } from "../spine/stage-sequencer";
import type { DecisionInput, DecisionLLM, DecisionOutput } from "../providers";
import type { LogEvent, OutputDecision, PendingSuggestion } from "../types";
import { demoProjectorSnapshot, withUnmuted } from "../ui/demo-data";
import type { ProjectorProcess, ProjectorProcessState, ProjectorSnapshot } from "../ui/types";

export type ProjectorRuntimeSubscriber = (snapshot: ProjectorSnapshot) => void;

export interface ProjectorRuntimeEnv {
  DEEPGRAM_API_KEY?: string;
  PANOP_SESSION_ID?: string;
  PANOP_INITIAL_MUTED?: string;
  [key: string]: string | undefined;
}

export interface ProjectorRuntime {
  readonly sessionId: string;
  readonly asrMode: "deepgram" | "replay";
  readonly asr: ASRProvider;
  readonly tts: TTSProvider;
  readonly cueAdapter: CueAdapter;
  readonly muteController: MuteController;
  readonly suggestionEngine: SuggestionEngine;
  readonly acceptanceController: AcceptanceController;
  readonly registry: ProcessRegistry;
  readonly stageSequencer: StageSequencer;
  readonly trace: TraceProcessor;
  readonly emergencyController: EmergencyStopController;
  snapshot(): ProjectorSnapshot;
  subscribe(subscriber: ProjectorRuntimeSubscriber): () => void;
  unmute(correlationId?: string): Promise<ProjectorSnapshot>;
  emergencyStop(correlationId?: string): Promise<ProjectorSnapshot>;
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

export async function createProjectorRuntime(env: ProjectorRuntimeEnv = process.env): Promise<ProjectorRuntime> {
  const sessionId = env.PANOP_SESSION_ID ?? demoProjectorSnapshot.sessionId;
  const runtime = new LiveProjectorRuntime(sessionId, env);
  await runtime.seedDemoFleet();

  if (env.PANOP_INITIAL_MUTED !== "0") {
    await runtime.muteForInitialState();
  }

  runtime.publish();
  return runtime;
}

class LiveProjectorRuntime implements ProjectorRuntime {
  readonly asrMode: "deepgram" | "replay";
  readonly asr: ASRProvider;
  readonly tts = new NoopTTSProvider();
  readonly cueAdapter: CueAdapter;
  readonly muteController: MuteController;
  readonly suggestionEngine: SuggestionEngine;
  readonly acceptanceController: AcceptanceController;
  readonly registry: ProcessRegistry;
  readonly stageSequencer: StageSequencer;
  readonly trace: TraceProcessor;
  readonly emergencyController: EmergencyStopController;
  readonly #session: EmergencySessionState;
  readonly #subscribers = new Set<ProjectorRuntimeSubscriber>();
  readonly #outputs: OutputDecision[] = [];
  readonly #demoProcesses: SeededProcessView[];
  #snapshot: ProjectorSnapshot = demoProjectorSnapshot;
  #emergencyTriggered = false;

  constructor(
    readonly sessionId: string,
    env: ProjectorRuntimeEnv,
  ) {
    const clock = () => Date.now();
    this.trace = new TraceProcessor({ clock });
    this.#demoProcesses = demoProjectorSnapshot.processes.map((process) => ({ ...process }));
    this.#session = new EmergencySessionState({ sessionId, listening: true, muted: false });
    this.muteController = new MuteController({
      sessionId,
      now: clock,
      onTrace: (event) => this.recordExternalTrace(event),
      onOutput: (decision) => this.recordOutput(decision),
    });

    const selectedAsr = selectAsrProvider(env, sessionId);
    this.asrMode = selectedAsr.mode;
    this.asr = this.muteController.protectCloudAsr(selectedAsr.provider);
    this.cueAdapter = new CueAdapter({
      sessionId,
      trace: this.trace,
      clock,
      textCueWords: ["panop"],
    });
    // The projector demo (`bun run start`) drives an in-process Smithers client:
    // the seeded fleet are deterministic fixtures, not real Smithers runs, so
    // halting them in memory is the correct behavior here. A production deployment
    // that drives real runs injects a gateway-backed client via this same option
    // (ProcessRegistryOptions.client) — that is the single swap point.
    this.registry = new ProcessRegistry({
      client: new MemorySmithersClient(),
      sessionId,
      now: clock,
      onTrace: (event) => this.recordExternalTrace(event),
      onOutput: (decision) => this.recordOutput(decision),
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
      classifier: new AcceptanceClassifier({ pending }),
      spawner,
    });
    this.suggestionEngine = new SuggestionEngine({
      sessionId,
      trace: this.trace,
      clock,
      llm: demoSuggestionDecisionLLM(),
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
      onOutput: (decision) => this.recordOutput(decision),
    });
    this.emergencyController = new EmergencyStopController({
      registry: this.registry,
      listener: this.#session,
      sessionId,
      now: clock,
      onTrace: (event) => this.recordExternalTrace(event),
      onOutput: (decision) => this.recordOutput(decision),
    });
  }

  snapshot(): ProjectorSnapshot {
    return this.#snapshot;
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

    return {
      ...demoProjectorSnapshot,
      sessionId: this.sessionId,
      listening,
      muted,
      globalState: this.#emergencyTriggered ? "emergency stopped" : muted ? "muted" : "ready",
      activeCue: this.#emergencyTriggered ? "none" : muted ? "muted" : previous.activeCue,
      emergencyStopTriggered: this.#emergencyTriggered,
      audio: this.audioSnapshot(previous),
      processes: this.processSnapshots(),
      trace: [...demoProjectorSnapshot.trace, ...this.trace.events()].slice(-80),
      updatedAt: new Date().toISOString(),
    };
  }

  private processSnapshots(): ProjectorProcess[] {
    const demoByUpid = new Map(this.#demoProcesses.map((process) => [process.upid, process]));

    return this.registry.records().map((record) => {
      const demo = demoByUpid.get(record.upid);
      return {
        upid: record.upid,
        runId: record.runId,
        // The registry normalizes callsigns to lowercase for voice matching; the
        // projector shows the pre-authored display casing ("Atlas"/"Cobalt").
        callsign: demo?.callsign ?? record.callsign,
        state: projectorState(record.state),
        selected: record.selected,
        task: demo?.task ?? "Panopticon task",
        model: demo?.model ?? "runtime",
        progressLabel: record.state === "dead" ? "halted" : demo?.progressLabel ?? record.lastAction,
        progress: record.state === "dead" ? 100 : demo?.progress ?? Math.min(95, record.progressSeq * 12),
        lastOutput: record.state === "dead" ? "Halted by emergency stop." : demo?.lastOutput ?? record.lastAction,
        lastAction: record.lastAction === "spawn" && demo !== undefined ? demo.events[0] ?? record.lastAction : record.lastAction,
        events: record.state === "dead" ? [...(demo?.events ?? []), "halted"] : demo?.events ?? [record.lastAction],
      };
    });
  }

  private audioSnapshot(previous: ProjectorSnapshot): ProjectorSnapshot["audio"] {
    const lastOutput = [...this.#outputs].reverse().find((decision) => decision.channel === "tts" || decision.channel === "earcon");
    if (lastOutput === undefined) {
      return previous.audio;
    }
    if (lastOutput.channel === "tts") {
      return {
        ...previous.audio,
        lastSpoken: lastOutput.text,
      };
    }
    return {
      ...previous.audio,
      earcon: lastOutput.id,
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
}

function selectAsrProvider(
  env: ProjectorRuntimeEnv,
  sessionId: string,
): { mode: "deepgram" | "replay"; provider: ASRProvider } {
  const apiKey = env.DEEPGRAM_API_KEY;
  if (apiKey !== undefined && apiKey.length > 0) {
    return {
      mode: "deepgram",
      provider: new DeepgramNova3ASRProvider({ apiKey, sessionId }),
    };
  }

  return {
    mode: "replay",
    provider: new ReplayASRProvider([]),
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

function demoSuggestionDecisionLLM(): DecisionLLM {
  return {
    async decide(input: DecisionInput): Promise<DecisionOutput> {
      return {
        id: `decision-${input.correlationId}`,
        model: input.model,
        temperature: 0,
        decision: {
          kind: "pass",
          correlationId: input.correlationId,
          policy: "server-runtime-demo",
          decisionId: `decision-${input.correlationId}`,
          addressed: false,
          reason: "ambient",
          meta: {},
        },
      };
    },
  };
}
