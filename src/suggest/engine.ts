import { TraceProcessor } from "../obs/trace";
import type { DecisionInput, DecisionLLM, DecisionOutput } from "../providers";
import { pendingSuggestionSchema, type LogEvent, type PendingSuggestion, type TranscriptObservation } from "../types";

export const DEFAULT_SUGGESTION_POLICY = "suggestion-engine.v0";
export const DEFAULT_SUGGESTION_MODEL = "suggestion-engine-temp-0";

export const SUGGESTION_ENGINE_ENV_DEFAULTS = Object.freeze({
  PANOP_SUGGEST_WORD_FLOOR: { default: "60", description: "REQ-3 word floor before ambient suggestions are eligible." },
  PANOP_SUGGEST_TIME_FLOOR_SECONDS: {
    default: "90",
    description: "REQ-3 substantive-talk elapsed floor before ambient suggestions are eligible.",
  },
  PANOP_SUGGEST_QUALITY_THRESHOLD: { default: "0.7", description: "Minimum DecisionLLM quality score required to fire." },
  PANOP_SUGGEST_INTERRUPT_LOW_THRESHOLD: {
    default: "0.65",
    description: "Maximum weighted interrupt cost considered low enough for immediate delivery.",
  },
  PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: {
    default: "0.4",
    description: "Interrupt-cost weight for words/minute over the last 30 seconds.",
  },
  PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: {
    default: "0.4",
    description: "Interrupt-cost weight for speech less than five seconds old.",
  },
  PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: {
    default: "0.2",
    description: "Interrupt-cost weight for pending steering commands.",
  },
  PANOP_SUGGEST_INTERRUPT_VELOCITY_HIGH_WPM: {
    default: "160",
    description: "Words/minute value that saturates the speech-velocity interrupt component.",
  },
  PANOP_SUGGEST_CADENCE_CAP_SECONDS: {
    default: "180",
    description: "Minimum seconds between spoken suggestion deliveries.",
  },
  PANOP_SUGGEST_TTL_SECONDS: { default: "90", description: "Queued suggestion lifetime before expiry." },
  PANOP_SUGGEST_IDLE_GAP_SECONDS: {
    default: "10",
    description: "Room-idle gap required for delivery when interrupt cost is not low.",
  },
} satisfies Record<string, { default: string; description: string }>);

export interface SuggestionEngineConfig {
  wordFloor: number;
  timeFloorSeconds: number;
  qualityThreshold: number;
  interruptLowThreshold: number;
  interruptVelocityWeight: number;
  interruptRecencyWeight: number;
  interruptPendingSteeringWeight: number;
  interruptVelocityHighWpm: number;
  cadenceCapSeconds: number;
  ttlSeconds: number;
  idleGapSeconds: number;
}

export interface SuggestionObservationInput {
  observation: TranscriptObservation;
  correlationId?: string;
  roomIdleMs?: number;
  pendingSteerings?: number;
}

export interface IdleCueInput {
  sessionId: string;
  idleForMs: number;
  correlationId?: string;
  pendingSteerings?: number;
}

export interface SuggestionEngineOptions {
  sessionId: string;
  llm?: DecisionLLM;
  trace?: TraceProcessor;
  clock?: () => number;
  idFactory?: () => string;
  env?: Record<string, string | undefined>;
  model?: string;
  acceptanceOwner?: SuggestionAcceptanceOwner;
}

export interface SuggestionAcceptanceOwner {
  acceptSuggestion(suggestion: PendingSuggestion): void | Promise<void>;
}

export type SuggestionEngineDecision =
  | { kind: "pass"; reason: string; events: LogEvent[] }
  | { kind: "queued"; reason: string; queued: PendingQueuedSuggestion; events: LogEvent[] }
  | { kind: "fired"; suggestion: PendingSuggestion; events: LogEvent[] }
  | { kind: "expired"; suggestion: PendingQueuedSuggestion; events: LogEvent[] }
  | { kind: "idle"; events: LogEvent[] };

export interface PendingQueuedSuggestion {
  suggestion: PendingSuggestion;
  queuedAtMs: number;
  expiresAtMs: number;
  decision: SuggestionDecisionMeta;
}

export interface SuggestionDecisionMeta {
  policy: string;
  wordCount: number;
  elapsedS: number;
  quality: number;
  interruptCost: number;
  decision: "pass" | "queue" | "fire" | "expired";
  decisionId: string;
  correlationId: string;
}

interface TranscriptWindowEntry {
  atMs: number;
  words: number;
}

const APPOLOGETIC_LANGUAGE = /\b(?:sorry|apolog(?:y|ize|ise|etic)|apologies|regret)\b/iu;

export class SuggestionEngine {
  readonly #sessionId: string;
  readonly #llm?: DecisionLLM;
  readonly #trace: TraceProcessor;
  readonly #clock: () => number;
  readonly #idFactory: () => string;
  readonly #env: Record<string, string | undefined>;
  readonly #model: string;
  readonly #acceptanceOwner?: SuggestionAcceptanceOwner;
  readonly #window: TranscriptWindowEntry[] = [];
  #substantiveStartedAtMs: number | null = null;
  #substantiveWords = 0;
  #lastUtteranceAtMs: number | null = null;
  #lastDeliveryAtMs: number | null = null;
  #queued: PendingQueuedSuggestion | null = null;

  constructor(options: SuggestionEngineOptions) {
    this.#sessionId = options.sessionId;
    this.#llm = options.llm;
    this.#trace = options.trace ?? new TraceProcessor({ clock: options.clock });
    this.#clock = options.clock ?? (() => performance.now());
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#env = options.env ?? process.env;
    this.#model = options.model ?? DEFAULT_SUGGESTION_MODEL;
    this.#acceptanceOwner = options.acceptanceOwner;
  }

  async observe(input: SuggestionObservationInput): Promise<SuggestionEngineDecision> {
    const nowMs = this.#clock();
    const observation = input.observation;
    const correlationId = input.correlationId ?? `corr-${this.#idFactory()}`;
    const decisionId = `decision-${this.#idFactory()}`;
    const config = readSuggestionEngineConfig(this.#env);
    const wordCount = countWords(observation.text);
    const startedAtMs = nowMs - observation.latencyMs;

    this.#observeSpeech(nowMs, wordCount);

    if (!observation.isFinal || wordCount === 0) {
      return this.#pass({
        observation,
        correlationId,
        decisionId,
        startedAtMs,
        reason: observation.isFinal ? "empty-transcript" : "non-final-transcript",
        quality: 0,
        interruptCost: this.#interruptCost(nowMs, input.pendingSteerings, config),
        decision: "pass",
        config,
      });
    }

    this.#substantiveStartedAtMs ??= nowMs;
    this.#substantiveWords += wordCount;
    const elapsedS = elapsedSeconds(this.#substantiveStartedAtMs, nowMs);
    const gatePassed = this.#substantiveWords >= config.wordFloor || elapsedS >= config.timeFloorSeconds;
    const interruptCost = this.#interruptCost(nowMs, input.pendingSteerings, config);

    if (!gatePassed) {
      return this.#pass({
        observation,
        correlationId,
        decisionId,
        startedAtMs,
        reason: "req3-floor",
        quality: 0,
        interruptCost,
        decision: "pass",
        config,
      });
    }

    const scored = await this.#score(observation, correlationId, decisionId);
    if (!scored.accepted) {
      return this.#pass({
        observation,
        correlationId,
        decisionId,
        startedAtMs,
        reason: scored.reason,
        quality: scored.quality,
        interruptCost,
        decision: "pass",
        config,
      });
    }

    const suggestion = this.#pendingSuggestion(scored, correlationId, nowMs, config);
    const roomIdleMs = input.roomIdleMs ?? 0;
    const cadenceOpen =
      this.#lastDeliveryAtMs === null || nowMs - this.#lastDeliveryAtMs >= config.cadenceCapSeconds * 1_000;
    const fire =
      scored.quality >= config.qualityThreshold &&
      cadenceOpen &&
      (interruptCost <= config.interruptLowThreshold || roomIdleMs >= config.idleGapSeconds * 1_000);

    if (fire) {
      return this.#fire(suggestion, observation.sessionId, startedAtMs, nowMs, {
        policy: DEFAULT_SUGGESTION_POLICY,
        wordCount: this.#substantiveWords,
        elapsedS,
        quality: scored.quality,
        interruptCost,
        decision: "fire",
        decisionId,
        correlationId,
      });
    }

    if (scored.quality < config.qualityThreshold) {
      return this.#pass({
        observation,
        correlationId,
        decisionId,
        startedAtMs,
        reason: "quality-threshold",
        quality: scored.quality,
        interruptCost,
        decision: "pass",
        config,
      });
    }

    const queued: PendingQueuedSuggestion = {
      suggestion,
      queuedAtMs: nowMs,
      expiresAtMs: nowMs + config.ttlSeconds * 1_000,
      decision: {
        policy: DEFAULT_SUGGESTION_POLICY,
        wordCount: this.#substantiveWords,
        elapsedS,
        quality: scored.quality,
        interruptCost,
        decision: "queue",
        decisionId,
        correlationId,
      },
    };
    this.#queued = queued;
    const event = this.#recordDecision("suggestion.queued", observation.sessionId, startedAtMs, nowMs, queued.decision, {
      reason: cadenceOpen ? "interrupt-cost" : "cadence-cap",
      suggestionId: suggestion.suggestionId,
      expiresAt: suggestion.expiresAt,
    });
    return { kind: "queued", reason: cadenceOpen ? "interrupt-cost" : "cadence-cap", queued, events: [event] };
  }

  async observeIdleCue(input: IdleCueInput): Promise<SuggestionEngineDecision> {
    const nowMs = this.#clock();
    const config = readSuggestionEngineConfig(this.#env);
    const queued = this.#queued;
    if (queued === null) {
      return { kind: "idle", events: [] };
    }

    if (nowMs >= queued.expiresAtMs) {
      return this.#expire(input.sessionId, nowMs, queued);
    }

    if (input.idleForMs < config.idleGapSeconds * 1_000) {
      return { kind: "idle", events: [] };
    }

    const cadenceOpen =
      this.#lastDeliveryAtMs === null || nowMs - this.#lastDeliveryAtMs >= config.cadenceCapSeconds * 1_000;
    if (!cadenceOpen) {
      return { kind: "idle", events: [] };
    }

    this.#queued = null;
    const decision = {
      ...queued.decision,
      decision: "fire" as const,
      interruptCost: this.#interruptCost(nowMs, input.pendingSteerings, config),
      correlationId: input.correlationId ?? queued.decision.correlationId,
    };
    return this.#fire(queued.suggestion, input.sessionId, queued.queuedAtMs, nowMs, decision);
  }

  pending(): PendingQueuedSuggestion | null {
    return this.#queued === null ? null : structuredClone(this.#queued);
  }

  // Drop the currently queued suggestion without firing it. Used by the click-to-
  // build path: once the operator clicks the popped idea to accept it, the engine's
  // queued entry is consumed so it is not later re-delivered or re-expired.
  clearPending(): void {
    this.#queued = null;
  }

  events(): LogEvent[] {
    return this.#trace.events();
  }

  #observeSpeech(nowMs: number, words: number): void {
    this.#lastUtteranceAtMs = nowMs;
    this.#window.push({ atMs: nowMs, words });
    const cutoff = nowMs - 30_000;
    while (this.#window.length > 0 && this.#window[0].atMs < cutoff) {
      this.#window.shift();
    }
  }

  #interruptCost(nowMs: number, pendingSteerings = 0, config: SuggestionEngineConfig): number {
    const wordsInWindow = this.#window.reduce((sum, entry) => sum + entry.words, 0);
    const velocityWpm = wordsInWindow * 2;
    const velocityComponent = clamp01(velocityWpm / config.interruptVelocityHighWpm);
    const recencyComponent =
      this.#lastUtteranceAtMs !== null && nowMs - this.#lastUtteranceAtMs < 5_000 ? 1 : 0;
    const steeringComponent = clamp01(pendingSteerings);
    return round3(
      velocityComponent * config.interruptVelocityWeight +
        recencyComponent * config.interruptRecencyWeight +
        steeringComponent * config.interruptPendingSteeringWeight,
    );
  }

  async #score(
    observation: TranscriptObservation,
    correlationId: string,
    decisionId: string,
  ): Promise<ScoredSuggestion> {
    if (this.#llm === undefined) {
      return { accepted: false, reason: "decision-llm-unavailable", quality: 0, pitch: "", mcqs: [], answers: [] };
    }

    const output = await this.#llm.decide(createSuggestionDecisionInput({
      observation,
      correlationId,
      decisionId,
      model: this.#model,
    }));
    return scoreFromDecisionOutput(output);
  }

  #pendingSuggestion(
    scored: ScoredSuggestion,
    correlationId: string,
    nowMs: number,
    config: SuggestionEngineConfig,
  ): PendingSuggestion {
    return pendingSuggestionSchema.parse({
      suggestionId: `suggestion-${this.#idFactory()}`,
      pitch: clampWords(removeApologetic(scored.pitch) || deterministicPitch(), 12),
      mcqs: normalizeMcqs(scored.mcqs),
      answers: normalizeAnswers(scored.answers, scored.mcqs),
      correlationId,
      expiresAt: nowMs + config.ttlSeconds * 1_000,
    });
  }

  async #fire(
    suggestion: PendingSuggestion,
    sessionId: string,
    startedAtMs: number,
    endedAtMs: number,
    decision: SuggestionDecisionMeta,
  ): Promise<SuggestionEngineDecision> {
    this.#lastDeliveryAtMs = endedAtMs;
    await this.#acceptanceOwner?.acceptSuggestion(suggestion);
    const event = this.#recordDecision("route.suggestion", sessionId, startedAtMs, endedAtMs, decision, {
      suggestionId: suggestion.suggestionId,
      pitch: suggestion.pitch,
      mcqs: suggestion.mcqs,
      expiresAt: suggestion.expiresAt,
    });
    return { kind: "fired", suggestion, events: [event] };
  }

  #expire(sessionId: string, nowMs: number, queued: PendingQueuedSuggestion): SuggestionEngineDecision {
    this.#queued = null;
    const decision = { ...queued.decision, decision: "expired" as const };
    const event = this.#recordDecision("suggestion.expired", sessionId, queued.expiresAtMs, nowMs, decision, {
      suggestionId: queued.suggestion.suggestionId,
      queuedAtMs: queued.queuedAtMs,
      expiresAt: queued.suggestion.expiresAt,
    });
    return { kind: "expired", suggestion: queued, events: [event] };
  }

  #pass(input: {
    observation: TranscriptObservation;
    correlationId: string;
    decisionId: string;
    startedAtMs: number;
    reason: string;
    quality: number;
    interruptCost: number;
    decision: "pass";
    config: SuggestionEngineConfig;
  }): SuggestionEngineDecision {
    const meta: SuggestionDecisionMeta = {
      policy: DEFAULT_SUGGESTION_POLICY,
      wordCount: this.#substantiveWords,
      elapsedS: elapsedSeconds(this.#substantiveStartedAtMs, this.#clock()),
      quality: input.quality,
      interruptCost: input.interruptCost,
      decision: input.decision,
      decisionId: input.decisionId,
      correlationId: input.correlationId,
    };
    const [observed, routed] = this.#trace.recordObservationPass({
      sessionId: input.observation.sessionId,
      correlationId: input.correlationId,
      startedAtMs: input.startedAtMs,
      endedAtMs: this.#clock(),
      meta: {
        addressed: false,
        reason: "ambient",
        utteranceId: input.observation.utteranceId,
        ...meta,
        passReason: input.reason,
        wordFloor: input.config.wordFloor,
        timeFloorSeconds: input.config.timeFloorSeconds,
      },
    });
    return { kind: "pass", reason: input.reason, events: [observed, routed] };
  }

  #recordDecision(
    event: "route.suggestion" | "suggestion.queued" | "suggestion.expired",
    sessionId: string,
    startedAtMs: number,
    endedAtMs: number,
    decision: SuggestionDecisionMeta,
    extra: Record<string, unknown>,
  ): LogEvent {
    return this.#trace.record({
      event,
      sessionId,
      correlationId: decision.correlationId,
      startedAtMs,
      endedAtMs,
      meta: { ...decision, ...extra },
    });
  }
}

interface ScoredSuggestion {
  accepted: boolean;
  reason: string;
  quality: number;
  pitch: string;
  mcqs: string[];
  answers: string[];
}

export function readSuggestionEngineConfig(
  env: Record<string, string | undefined> = process.env,
): SuggestionEngineConfig {
  return {
    wordFloor: envPositiveNumber(env, "PANOP_SUGGEST_WORD_FLOOR"),
    timeFloorSeconds: envPositiveNumber(env, "PANOP_SUGGEST_TIME_FLOOR_SECONDS"),
    qualityThreshold: envRatio(env, "PANOP_SUGGEST_QUALITY_THRESHOLD"),
    interruptLowThreshold: envPositiveNumber(env, "PANOP_SUGGEST_INTERRUPT_LOW_THRESHOLD"),
    interruptVelocityWeight: envNonNegativeNumber(env, "PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT"),
    interruptRecencyWeight: envNonNegativeNumber(env, "PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT"),
    interruptPendingSteeringWeight: envNonNegativeNumber(env, "PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT"),
    interruptVelocityHighWpm: envPositiveNumber(env, "PANOP_SUGGEST_INTERRUPT_VELOCITY_HIGH_WPM"),
    cadenceCapSeconds: envNonNegativeNumber(env, "PANOP_SUGGEST_CADENCE_CAP_SECONDS"),
    ttlSeconds: envPositiveNumber(env, "PANOP_SUGGEST_TTL_SECONDS"),
    idleGapSeconds: envPositiveNumber(env, "PANOP_SUGGEST_IDLE_GAP_SECONDS"),
  };
}

export function createSuggestionDecisionInput(input: {
  observation: TranscriptObservation;
  correlationId: string;
  decisionId: string;
  model?: string;
}): DecisionInput {
  return {
    model: input.model ?? DEFAULT_SUGGESTION_MODEL,
    temperature: 0,
    correlationId: input.correlationId,
    messages: [
      {
        role: "system",
        content:
          "Score whether the transcript contains a buildable ambient suggestion, not conversational filler. Return action spawn only when buildable. Include quality 0..1, pitch <=12 words, and 1-3 aloud-answerable MCQs in metadata or payload. Do not use apologetic language.",
      },
      {
        role: "user",
        content: JSON.stringify({
          transcript: input.observation.text,
          candidateAction: { type: "spawn", targetUPID: null },
        }),
      },
    ],
    metadata: {
      gate: "suggestion.intent-quality",
      utteranceId: input.observation.utteranceId,
      decisionId: input.decisionId,
    },
  };
}

export function scoreFromDecisionOutput(output: DecisionOutput): ScoredSuggestion {
  if (output.temperature !== 0) {
    throw new Error("Suggestion DecisionLLM output must be temperature 0.");
  }

  if (output.decision.kind !== "action" || output.decision.action.type !== "spawn") {
    return { accepted: false, reason: "intent-gate-pass", quality: qualityFrom(output.decision.meta), pitch: "", mcqs: [], answers: [] };
  }

  const payload = isRecord(output.decision.action.payload) ? output.decision.action.payload : {};
  const meta = output.decision.meta;
  const quality = qualityFrom({ ...payload, ...meta });
  return {
    accepted: true,
    reason: "intent-gate-action",
    quality,
    pitch: firstString(payload.pitch, meta.pitch, payload.text, meta.text),
    mcqs: stringArray(payload.mcqs ?? meta.mcqs),
    answers: stringArray(payload.answers ?? meta.answers),
  };
}

export function countWords(text: string): number {
  return text.trim().match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function envPositiveNumber(env: Record<string, string | undefined>, name: keyof typeof SUGGESTION_ENGINE_ENV_DEFAULTS): number {
  const value = envNumber(env, name);
  if (value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function envNonNegativeNumber(env: Record<string, string | undefined>, name: keyof typeof SUGGESTION_ENGINE_ENV_DEFAULTS): number {
  const value = envNumber(env, name);
  if (value < 0) {
    throw new Error(`${name} must be non-negative.`);
  }
  return value;
}

function envRatio(env: Record<string, string | undefined>, name: keyof typeof SUGGESTION_ENGINE_ENV_DEFAULTS): number {
  const value = envNumber(env, name);
  if (value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1.`);
  }
  return value;
}

function envNumber(env: Record<string, string | undefined>, name: keyof typeof SUGGESTION_ENGINE_ENV_DEFAULTS): number {
  const raw = env[name]?.trim() || SUGGESTION_ENGINE_ENV_DEFAULTS[name].default;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
}

function elapsedSeconds(startMs: number | null, nowMs: number): number {
  return startMs === null ? 0 : Math.max(0, Math.round((nowMs - startMs) / 100) / 10);
}

function qualityFrom(record: Record<string, unknown>): number {
  const raw = record.quality;
  return typeof raw === "number" && Number.isFinite(raw) ? clamp01(raw) : 0;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function normalizeMcqs(mcqs: readonly string[]): string[] {
  const cleaned = mcqs.map((mcq) => removeApologetic(mcq)).filter((mcq) => mcq.length > 0).slice(0, 3);
  return cleaned.length > 0 ? cleaned : ["Proceed?"];
}

function normalizeAnswers(answers: readonly string[], mcqs: readonly string[]): string[] {
  const cleaned = answers.map((answer) => removeApologetic(answer)).filter((answer) => answer.length > 0).slice(0, 3);
  if (cleaned.length > 0) {
    return cleaned;
  }
  return normalizeMcqs(mcqs).map((mcq) => mcq.replace(/\?$/u, ""));
}

function removeApologetic(text: string): string {
  if (!APPOLOGETIC_LANGUAGE.test(text)) {
    return text.trim();
  }
  return text.replace(APPOLOGETIC_LANGUAGE, "").replace(/\s+/gu, " ").trim();
}

function clampWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  return words.slice(0, max).join(" ");
}

function deterministicPitch(): string {
  return "Consider turning this into a scoped task";
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
