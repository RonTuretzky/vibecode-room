import { RecordingAudioOutput } from "../audio/test-doubles";
import { playAck, playEarcon } from "../audio/earcons";
import { NoopTTSProvider, ReplayASRProvider, type DecisionInput, type DecisionLLM, type DecisionOutput } from "../providers";
import { AcceptanceClassifier } from "../acceptance/classifier";
import { PendingSuggestionOwner } from "../acceptance/pending";
import { AcceptanceController, AcceptanceSpawner, createProcessRegistryAcceptanceSeam } from "../acceptance/spawn";
import { CueAdapter } from "../cue/adapter";
import { matchWakeWord } from "../cue/wake-matcher";
import { TraceProcessor, type CausalChain } from "../obs/trace";
import { ProcessRegistry, type RegistryProcess } from "../process/registry";
import { MemorySmithersClient } from "../process/test-helpers";
import { SteeringWindowManager } from "../routing/steering-window";
import { SuggestionEngine, type SuggestionAcceptanceOwner } from "../suggest/engine";
import type { LogEvent, OutputDecision, PendingSuggestion, TranscriptObservation } from "../types";
import { NoScreenHarness } from "./no-screen-harness";
import { StageSequencer, type StageTransition } from "./stage-sequencer";

export interface CanonicalSpineOptions {
  sessionId?: string;
  observations?: readonly TranscriptObservation[];
  fleetEnabled?: boolean;
  noScreen?: NoScreenHarness;
  clock?: AdjustableClock;
}

export interface CanonicalSpineResult {
  correlationId: string;
  chain: CausalChain;
  traceEvents: LogEvent[];
  outputs: OutputDecision[];
  audio: RecordingAudioOutput;
  tts: NoopTTSProvider;
  noScreen: NoScreenHarness;
  registry: ProcessRegistry;
  spawned: RegistryProcess;
  transitions: StageTransition[];
  fleetEnabled: boolean;
}

export interface AdjustableClock {
  now(): number;
  advance(ms: number): void;
}

const DEFAULT_SESSION_ID = "canonical-spine";

export async function runCanonicalSpineScenario(options: CanonicalSpineOptions = {}): Promise<CanonicalSpineResult> {
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
  const clock = options.clock ?? adjustableClock(1_000);
  const trace = new TraceProcessor({ clock: clock.now });
  const outputs: OutputDecision[] = [];
  const audio = new RecordingAudioOutput();
  const tts = new NoopTTSProvider();
  const noScreen = options.noScreen ?? new NoScreenHarness({ clock: clock.now });
  const fleetEnabled = options.fleetEnabled ?? true;
  const registry = new ProcessRegistry({
    client: new MemorySmithersClient(),
    sessionId,
    now: clock.now,
    onTrace: (event) => recordExternalTrace(trace, event, clock.now),
  });
  const pending = new PendingSuggestionOwner({ clock: clock.now });
  const acceptanceOwner = new RecordingAcceptanceOwner(pending);
  const suggestionEngine = new SuggestionEngine({
    sessionId,
    trace,
    clock: clock.now,
    idFactory: sequenceIds("canonical"),
    llm: canonicalSuggestionDecisionLLM(),
    acceptanceOwner,
    env: {
      ...process.env,
      PANOP_SUGGEST_WORD_FLOOR: "1",
      PANOP_SUGGEST_TIME_FLOOR_SECONDS: "999",
      PANOP_SUGGEST_QUALITY_THRESHOLD: "0.7",
      PANOP_SUGGEST_CADENCE_CAP_SECONDS: "0",
      PANOP_SUGGEST_IDLE_GAP_SECONDS: "1",
    },
  });
  const adapter = new CueAdapter({
    sessionId,
    trace,
    clock: clock.now,
    idFactory: sequenceIds("cue"),
    textCueWords: ["panop"],
  });
  const sequencer = new StageSequencer({
    sessionId,
    trace,
    clock: clock.now,
    onOutput: async (decision, transition) => {
      outputs.push(decision);
      await emitOutput({ decision, audio, tts, trace, sessionId, clock, correlationId: transition.correlationId });
    },
  });
  const openedWindows: RegistryProcess[] = [];
  const spawner = new AcceptanceSpawner({
    seam: createProcessRegistryAcceptanceSeam(registry),
    sessionId,
    clock: clock.now,
    activeProcessCount: () => registry.activeRecords().length,
    onOutput: (decision) => {
      outputs.push(decision);
    },
    openSteeringWindow: (process) => openedWindows.push(process),
  });
  const acceptance = new AcceptanceController({
    pending,
    classifier: new AcceptanceClassifier({ pending, idFactory: sequenceIds("accept") }),
    spawner,
  });
  const observations = options.observations ?? canonicalObservations(sessionId);
  const asr = new ReplayASRProvider(observations);
  let activeCorrelationId = "";
  let spawned: RegistryProcess | null = null;

  if (process.env.PANOP_RBG_CONSUME_SCREEN === "1") {
    noScreen.consume("keyboard", "rbg-shortcut");
  }

  for await (const observation of asr.stream(emptyAudioStream())) {
    const wake = matchWakeWord(observation);
    const correlationId = activeCorrelationId || wake.correlationId;
    activeCorrelationId = correlationId;
    recordObservation(trace, observation, correlationId, clock.now);

    if (wake.kind === "action" && observation.utteranceId === "utt-wake-build") {
      trace.record({
        event: "command.wake",
        sessionId,
        correlationId,
        startedAtMs: clock.now() - observation.latencyMs,
        endedAtMs: clock.now(),
        meta: {
          utteranceId: observation.utteranceId,
          wakeWord: "panop",
          decisionId: wake.decisionId,
        },
      });
      await sequencer.transition("ACTIVE_LISTEN", {
        correlationId,
        reason: "wake-detected",
        audible: { channel: "earcon", id: "E1" },
      });
      await adapter.emitTextCueEarcon(observation, { name: "text", metadata: { pattern: "panop" } }, correlationId);

      const suggestion = await suggestionEngine.observe({ observation, correlationId, roomIdleMs: 1_000 });
      if (suggestion.kind !== "fired") {
        throw new Error(`Canonical scenario expected suggestion delivery, got ${suggestion.kind}.`);
      }
      const spoken = suggestionSpeech(suggestion.suggestion);
      await sequencer.transition("SUGGESTION_DELIVERY", {
        correlationId,
        reason: "route-suggestion",
        audible: { channel: "ack", id: "route-suggestion" },
        meta: { suggestionId: suggestion.suggestion.suggestionId },
      });
      await emitOutput({
        decision: ttsDecision(spoken),
        audio,
        tts,
        trace,
        sessionId,
        clock,
        correlationId,
      });
      outputs.push(ttsDecision(spoken));
      continue;
    }

    trace.record({
      event: "route.acceptance",
      sessionId,
      correlationId,
      startedAtMs: clock.now() - observation.latencyMs,
      endedAtMs: clock.now(),
      meta: {
        utteranceId: observation.utteranceId,
        candidate: observation.text,
      },
    });
    const classification = await acceptance.observe({ observation, correlationId });

    if (classification.kind === "spawned" && classification.spawn.accepted) {
      spawned = classification.spawn.process;
      if (fleetEnabled) {
        const steering = new SteeringWindowManager({
          sessionId,
          clock: clock.now,
          processes: [{ callsign: spawned.callsign, upid: spawned.upid }],
        });
        steering.ingestUtterance({
          text: spawned.callsign,
          utteranceId: "utt-open-steering-window",
          correlationId,
          sessionId,
          nowMs: clock.now(),
        });
      }
      await sequencer.transition("SPAWN", {
        correlationId,
        reason: "acceptance-spawn",
        audible: { channel: "earcon", id: "E3" },
        meta: { upid: spawned.upid, callsign: spawned.callsign },
      });
      await sequencer.transition("ACK", {
        correlationId,
        reason: "spoken-confirmation",
        audible: ttsDecision(classification.spawn.process.callsign + " spawned."),
        meta: { upid: spawned.upid, callsign: spawned.callsign },
      });
      break;
    }
  }

  noScreen.assertZeroConsumed();
  if (spawned === null) {
    throw new Error("Canonical scenario did not spawn a process.");
  }

  const chain = trace.query(activeCorrelationId);
  return {
    correlationId: activeCorrelationId,
    chain,
    traceEvents: trace.events(),
    outputs,
    audio,
    tts,
    noScreen,
    registry,
    spawned,
    transitions: sequencer.transitions(),
    fleetEnabled,
  };
}

export function adjustableClock(startMs: number): AdjustableClock {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

function recordObservation(
  trace: TraceProcessor,
  observation: TranscriptObservation,
  correlationId: string,
  now: () => number,
): void {
  trace.record({
    event: "observe.final",
    sessionId: observation.sessionId,
    correlationId,
    startedAtMs: now() - observation.latencyMs,
    endedAtMs: now(),
    meta: {
      utteranceId: observation.utteranceId,
      speaker: observation.speaker,
      isFinal: observation.isFinal,
      textLength: observation.text.length,
    },
  });
}

function recordExternalTrace(trace: TraceProcessor, event: LogEvent, now: () => number): void {
  trace.record({
    event: event.event,
    sessionId: event.sessionId,
    correlationId: event.correlationId ?? "",
    upid: event.upid,
    startedAtMs: now(),
    endedAtMs: now() + (event.latencyMs ?? 0),
    meta: event.meta,
  });
}

async function emitOutput(input: {
  decision: OutputDecision;
  audio: RecordingAudioOutput;
  tts: NoopTTSProvider;
  trace: TraceProcessor;
  sessionId: string;
  clock: AdjustableClock;
  correlationId: string;
}): Promise<void> {
  const startedAtMs = input.clock.now();
  switch (input.decision.channel) {
    case "earcon":
      await playEarcon(input.audio, input.decision.id, { correlationId: input.correlationId, source: "stage-sequencer" });
      input.trace.record({
        event: "earcon.emit",
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        startedAtMs,
        endedAtMs: input.clock.now(),
        meta: { id: input.decision.id, source: "stage-sequencer" },
      });
      return;
    case "ack":
      await playAck(input.audio, input.decision.id, { correlationId: input.correlationId, source: "stage-sequencer" });
      input.trace.record({
        event: "ack.emit",
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        startedAtMs,
        endedAtMs: input.clock.now(),
        meta: { ackId: input.decision.id, source: "stage-sequencer" },
      });
      return;
    case "tts":
      await input.tts.speak(input.decision.text);
      input.trace.record({
        event: "output.tts",
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        startedAtMs,
        endedAtMs: input.clock.now(),
        meta: {
          text: input.decision.text,
          wordCount: input.decision.wordCount,
          summarized: input.decision.summarized,
        },
      });
      return;
    case "silent":
      input.trace.record({
        event: "output.silent",
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        startedAtMs,
        endedAtMs: input.clock.now(),
        meta: {},
      });
      return;
    default:
      throw new Error(`Unsupported output channel: ${(input.decision as { channel?: string }).channel ?? "unknown"}`);
  }
}

function canonicalSuggestionDecisionLLM(): DecisionLLM {
  return {
    async decide(input: DecisionInput): Promise<DecisionOutput> {
      return {
        id: `decision-${input.correlationId}`,
        model: input.model,
        temperature: 0,
        decision: {
          kind: "action",
          correlationId: input.correlationId,
          policy: "canonical-replay-suggestion",
          decisionId: String(input.metadata?.decisionId ?? "decision-canonical"),
          action: {
            type: "spawn",
            targetUPID: null,
            correlationId: input.correlationId,
            payload: {
              pitch: "Build canonical replay coverage",
              mcqs: ["Use record replay?"],
              answers: ["Use record replay"],
              quality: 0.92,
            },
          },
          meta: {
            quality: 0.92,
            pitch: "Build canonical replay coverage",
            mcqs: ["Use record replay?"],
          },
        },
      };
    },
  };
}

class RecordingAcceptanceOwner implements SuggestionAcceptanceOwner {
  constructor(readonly pending: PendingSuggestionOwner) {}

  acceptSuggestion(suggestion: PendingSuggestion): void {
    this.pending.acceptSuggestion(suggestion);
  }
}

function canonicalObservations(sessionId: string): TranscriptObservation[] {
  return [
    {
      text: "Panop build canonical replay coverage with a no screen harness",
      isFinal: true,
      speaker: "speaker-canonical",
      sessionId,
      latencyMs: 25,
      utteranceId: "utt-wake-build",
    },
    {
      text: "yes",
      isFinal: true,
      speaker: "speaker-canonical",
      sessionId,
      latencyMs: 20,
      utteranceId: "utt-accept",
    },
  ];
}

function suggestionSpeech(suggestion: PendingSuggestion): string {
  return `${suggestion.pitch}. ${suggestion.mcqs[0] ?? "Proceed?"}`;
}

function ttsDecision(text: string): Extract<OutputDecision, { channel: "tts" }> {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  return {
    channel: "tts",
    text,
    wordCount: words.length,
    summarized: false,
  };
}

function emptyAudioStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function sequenceIds(prefix: string): () => string {
  let index = 0;
  return () => `${prefix}-${++index}`;
}
