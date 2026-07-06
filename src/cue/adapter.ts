import { TraceProcessor } from "../obs/trace";
import type { DispatchedAction, LogEvent, TranscriptObservation } from "../types";
import { transcriptObservationSchema } from "../types";
import {
  evaluateSemanticIntentGate,
  type SemanticIntentGateOptions,
  type SemanticIntentGateResult,
} from "./intent-gate";
import { assertPrematcherParity } from "./policies";
import type { CueIngestResult } from "./source";

export interface CueObservationFrame {
  text?: unknown;
  transcript?: unknown;
  isFinal?: unknown;
  final?: unknown;
  speaker?: unknown;
  sessionId?: unknown;
  latencyMs?: unknown;
  utteranceId?: unknown;
  rawInferenceMs?: unknown;
  payload?: Record<string, unknown>;
}

export interface EarconSink {
  emit(event: EarconEmission): void | Promise<void>;
}

export interface EarconEmission {
  id: "E1" | "E2" | "E3" | "E4" | "E5" | "mute-tone";
  source: "cue-textcue" | "adapter-prematch";
  correlationId: string;
  latencyMs: number;
  matchedWord: string;
}

export interface CueDecisionLog {
  correlationId: string;
  decisionId: string;
  events: LogEvent[];
  actions: DispatchedAction[];
  earcons: EarconEmission[];
}

export interface CueAdapterOptions {
  sessionId: string;
  trace?: TraceProcessor;
  earconSink?: EarconSink;
  clock?: () => number;
  idFactory?: () => string;
  textCueWords?: readonly string[];
  usePrematcher?: boolean;
  prematcherWords?: readonly string[];
  semanticIntentGate?: SemanticIntentGateOptions;
  // Operator-visible tag stamped onto the earcon trace meta as `path` so a
  // wake/earcon trace can be attributed to the Cue path that produced it — the
  // upstream harness adapter ('harness') vs the in-runtime fallback adapter
  // ('fallback'). Undefined leaves the trace untagged (GAP-006).
  earconPath?: string;
}

export class CueAdapter {
  readonly #sessionId: string;
  readonly #trace: TraceProcessor;
  readonly #earconSink?: EarconSink;
  readonly #clock: () => number;
  readonly #idFactory: () => string;
  readonly #textCueWords: readonly string[];
  readonly #usePrematcher: boolean;
  readonly #prematcherWords: readonly string[];
  readonly #semanticIntentGate?: SemanticIntentGateOptions;
  readonly #earconPath?: string;

  constructor(options: CueAdapterOptions) {
    this.#sessionId = options.sessionId;
    this.#trace = options.trace ?? new TraceProcessor({ clock: options.clock });
    this.#earconSink = options.earconSink;
    this.#clock = options.clock ?? (() => performance.now());
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#textCueWords = options.textCueWords ?? [];
    this.#usePrematcher = options.usePrematcher ?? false;
    this.#prematcherWords = options.prematcherWords ?? this.#textCueWords;
    this.#semanticIntentGate = options.semanticIntentGate;
    this.#earconPath = options.earconPath;

    if (this.#usePrematcher) {
      assertPrematcherParity(this.#textCueWords, this.#prematcherWords);
    }
  }

  normalizeObservation(frame: CueObservationFrame): TranscriptObservation {
    const payload = frame.payload ?? {};
    const text = stringValue(frame.text ?? frame.transcript ?? payload.text ?? payload.transcript, "");
    const observation = {
      text,
      isFinal: booleanValue(frame.isFinal ?? frame.final ?? payload.isFinal ?? payload.final, true),
      speaker: nullableString(frame.speaker ?? payload.speaker),
      sessionId: stringValue(frame.sessionId ?? payload.sessionId, this.#sessionId),
      latencyMs: numberValue(frame.latencyMs ?? frame.rawInferenceMs ?? payload.latencyMs ?? payload.rawInferenceMs, 0),
      utteranceId: stringValue(frame.utteranceId ?? payload.utteranceId, `utt-${this.#idFactory()}`),
    };

    return transcriptObservationSchema.parse(observation);
  }

  async handleResult(observation: TranscriptObservation, result: CueIngestResult): Promise<CueDecisionLog> {
    const correlationId = `corr-${this.#idFactory()}`;
    const decisionId = `decision-${this.#idFactory()}`;
    const events: LogEvent[] = [];
    const actions: DispatchedAction[] = [];
    const earcons: EarconEmission[] = [];
    const startedAtMs = this.#clock() - observation.latencyMs;
    const textCue = result.cues.find((cue) => cue.name === "text");

    if (textCue !== undefined) {
      const emission = this.#earconEmission("cue-textcue", correlationId, observation, textCue.metadata?.pattern);
      earcons.push(emission);
      await this.#earconSink?.emit(emission);
      events.push(
        this.#trace.record({
          event: "earcon.emit",
          sessionId: observation.sessionId,
          correlationId,
          startedAtMs,
          endedAtMs: startedAtMs + emission.latencyMs,
          meta: {
            id: emission.id,
            source: emission.source,
            matchedWord: emission.matchedWord,
            utteranceId: observation.utteranceId,
            ...(this.#earconPath !== undefined ? { path: this.#earconPath } : {}),
          },
        }),
      );
    } else if (this.#usePrematcher) {
      const matched = firstWordMatch(observation.text, this.#prematcherWords);
      if (matched !== undefined) {
        const emission = this.#earconEmission("adapter-prematch", correlationId, observation, matched);
        earcons.push(emission);
        await this.#earconSink?.emit(emission);
      }
    }

    for (const toolResult of result.toolResults) {
      if (toolResult.tool === "observe.pass") {
        const [observed, routed] = this.#trace.recordObservationPass({
          sessionId: observation.sessionId,
          correlationId,
          startedAtMs,
          endedAtMs: this.#clock(),
          meta: {
            addressed: Boolean(textCue),
            reason: "ambient",
            utteranceId: observation.utteranceId,
            policy: "cue.observe.pass",
            decisionId,
          },
        });
        events.push(observed, routed);
        continue;
      }

      for (const action of toolResult.actions ?? []) {
        const dispatched = mapCueAction(action, correlationId);
        const intentGate = await evaluateSemanticIntentGate({
          observation,
          cueDecision: textCue,
          action: dispatched,
          correlationId,
          decisionId,
          options: this.#semanticIntentGate,
        });
        events.push(this.#recordIntentGate(observation, correlationId, decisionId, startedAtMs, dispatched, intentGate));
        if (!intentGate.accepted) {
          const [observed, routed] = this.#trace.recordObservationPass({
            sessionId: observation.sessionId,
            correlationId,
            startedAtMs,
            endedAtMs: this.#clock(),
            meta: {
              addressed: Boolean(textCue),
              reason: "dropped",
              utteranceId: observation.utteranceId,
              policy: "cue.semantic-intent-gate",
              decisionId,
              action: dispatched.type,
              gateSource: intentGate.source,
              gateReason: intentGate.reason,
            },
          });
          events.push(observed, routed);
          continue;
        }

        actions.push(dispatched);
        events.push(
          this.#trace.record({
            event: "route.action",
            sessionId: observation.sessionId,
            correlationId,
            upid: dispatched.targetUPID ?? undefined,
            startedAtMs,
            endedAtMs: this.#clock(),
            meta: {
              action: dispatched.type,
              targetUPID: dispatched.targetUPID,
              payload: dispatched.payload,
              decisionId,
              policy: "cue.mapped-action",
              utteranceId: observation.utteranceId,
            },
          }),
        );
      }
    }

    if (result.toolResults.length === 0) {
      const [observed, routed] = this.#trace.recordObservationPass({
        sessionId: observation.sessionId,
        correlationId,
        startedAtMs,
        endedAtMs: this.#clock(),
        meta: {
          addressed: Boolean(textCue),
          reason: "ambient",
          utteranceId: observation.utteranceId,
          policy: "cue.no-tool-result",
          decisionId,
        },
      });
      events.push(observed, routed);
    }

    return { correlationId, decisionId, events, actions, earcons };
  }

  async emitTextCueEarcon(
    observation: TranscriptObservation,
    cueDecision: { name?: string; metadata?: Record<string, unknown> },
    correlationId = `corr-${this.#idFactory()}`,
  ): Promise<EarconEmission> {
    if (cueDecision.name !== "text") {
      throw new Error("Earcon fast path requires a Cue TextCue decision.");
    }

    const emission = this.#earconEmission("cue-textcue", correlationId, observation, cueDecision.metadata?.pattern);
    await this.#earconSink?.emit(emission);
    this.#trace.record({
      event: "earcon.emit",
      sessionId: observation.sessionId,
      correlationId,
      startedAtMs: this.#clock() - observation.latencyMs,
      endedAtMs: this.#clock(),
      meta: {
        id: emission.id,
        source: emission.source,
        matchedWord: emission.matchedWord,
        utteranceId: observation.utteranceId,
      },
    });
    return emission;
  }

  events(): LogEvent[] {
    return this.#trace.events();
  }

  #earconEmission(
    source: EarconEmission["source"],
    correlationId: string,
    observation: TranscriptObservation,
    matchedWord: unknown,
  ): EarconEmission {
    const latencyMs = Math.max(0, this.#clock() - (this.#clock() - observation.latencyMs));
    return {
      id: "E1",
      source,
      correlationId,
      latencyMs,
      matchedWord: typeof matchedWord === "string" ? matchedWord : "",
    };
  }

  #recordIntentGate(
    observation: TranscriptObservation,
    correlationId: string,
    decisionId: string,
    startedAtMs: number,
    action: DispatchedAction,
    result: SemanticIntentGateResult,
  ): LogEvent {
    const llmMeta =
      result.llmOutput === undefined ? {} : { llmDecisionKind: result.llmOutput.decision.kind };

    return this.#trace.record({
      event: "decision.intent",
      sessionId: observation.sessionId,
      correlationId,
      startedAtMs,
      endedAtMs: this.#clock(),
      meta: {
        accepted: result.accepted,
        source: result.source,
        reason: result.reason,
        action: action.type,
        targetUPID: action.targetUPID,
        decisionId,
        utteranceId: observation.utteranceId,
        ...llmMeta,
      },
    });
  }
}

export function mapCueAction(action: unknown, correlationId: string): DispatchedAction {
  if (!isRecord(action)) {
    throw new Error("Cue MappedActionTool action must be an object.");
  }

  const rawType = stringValue(action.type, "");
  const payload = isRecord(action.payload) ? action.payload : {};

  if (rawType === "suggestion.queue") {
    return {
      type: "spawn",
      targetUPID: null,
      payload,
      correlationId,
    };
  }

  if (rawType === "smithers.steer") {
    return {
      type: "steer",
      targetUPID: typeof payload.upid === "string" ? payload.upid : null,
      payload,
      correlationId,
    };
  }

  const candidate = rawType.replace(/^smithers\./u, "");
  if (isDispatchType(candidate)) {
    return {
      type: candidate,
      targetUPID: typeof payload.upid === "string" ? payload.upid : null,
      payload,
      correlationId,
    };
  }

  throw new Error(`Unsupported Cue mapped action type: ${rawType}`);
}

function firstWordMatch(text: string, words: readonly string[]): string | undefined {
  const normalized = text.toLowerCase();
  return words.find((word) => new RegExp(`(^|\\b)${escapeRegex(word.toLowerCase())}(\\b|$)`, "u").test(normalized));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isDispatchType(value: string): value is DispatchedAction["type"] {
  return ["spawn", "steer", "pause", "resume", "halt", "pauseAll", "status"].includes(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
