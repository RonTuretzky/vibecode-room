import { cueDecisionSchema, type CueDecision } from "../../types";
import type { DecisionInput, DecisionLLM, DecisionMessage, DecisionOutput } from "../types";

export const WINDOWED_DECISION_POLICY = "windowed-decision.v0";

// A rolling-context decorator for any DecisionLLM. The SuggestionEngine feeds one
// fragmented ASR final at a time, and no single fragment is a complete idea — so a
// per-utterance decider passes on each. This wrapper accumulates recent fragments
// into a bounded window (by age + word count), judges the WHOLE window through the
// inner decider, throttles how often the (possibly expensive) inner call runs, and
// resets the window once an idea is proposed. Orthogonal to which model judges —
// wrap the heuristic, the Claude fetch path, or the host-Claude CLI alike.

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_WINDOW_WORDS = 120;
const DEFAULT_MIN_INTERVAL_MS = 0;

export interface WindowedDecisionLLMOptions {
  windowMs?: number;
  windowWords?: number;
  /** Minimum time between inner calls; intervening finals return a throttled pass. */
  minIntervalMs?: number;
  now?: () => number;
  policy?: string;
}

export class WindowedDecisionLLM implements DecisionLLM {
  readonly #inner: DecisionLLM;
  readonly #windowMs: number;
  readonly #windowWords: number;
  readonly #minIntervalMs: number;
  readonly #now: () => number;
  readonly #policy: string;
  #window: Array<{ atMs: number; text: string }> = [];
  #lastCallAtMs = Number.NEGATIVE_INFINITY;

  constructor(inner: DecisionLLM, options: WindowedDecisionLLMOptions = {}) {
    this.#inner = inner;
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#windowWords = options.windowWords ?? DEFAULT_WINDOW_WORDS;
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#policy = options.policy ?? WINDOWED_DECISION_POLICY;
  }

  async decide(input: DecisionInput): Promise<DecisionOutput> {
    const now = this.#now();
    const fragment = extractTranscript(input);
    if (fragment.length > 0) {
      this.#window.push({ atMs: now, text: fragment });
    }
    this.#pruneWindow(now);
    const windowText = this.#windowText();

    if (windowText.length === 0 || now - this.#lastCallAtMs < this.#minIntervalMs) {
      return this.#pass(input, "throttled-or-empty");
    }
    this.#lastCallAtMs = now;

    // Judge the whole window: hand the inner decider an input whose user content
    // is the accumulated transcript (preserving system prompt / tools / metadata).
    const output = await this.#inner.decide(windowedInput(input, windowText));

    if (output.decision.kind === "action") {
      this.#window = []; // reset context after proposing an idea
    }
    return output;
  }

  #pass(input: DecisionInput, note: string): DecisionOutput {
    const decision: CueDecision = {
      kind: "pass",
      addressed: false,
      reason: "ambient",
      policy: this.#policy,
      decisionId: decisionIdFrom(input),
      correlationId: input.correlationId,
      meta: { quality: 0, note },
    };
    return { id: `decision-${input.correlationId}`, model: input.model, temperature: 0, decision: cueDecisionSchema.parse(decision) };
  }

  #pruneWindow(now: number): void {
    this.#window = this.#window.filter((entry) => now - entry.atMs <= this.#windowMs);
    let words = wordCount(this.#windowText());
    while (this.#window.length > 1 && words > this.#windowWords) {
      const dropped = this.#window.shift();
      words -= dropped ? wordCount(dropped.text) : 0;
    }
  }

  #windowText(): string {
    return this.#window.map((entry) => entry.text).join(" ").replace(/\s+/gu, " ").trim();
  }
}

function windowedInput(input: DecisionInput, windowText: string): DecisionInput {
  const nonUser: DecisionMessage[] = input.messages.filter((message) => message.role !== "user");
  return { ...input, messages: [...nonUser, { role: "user", content: windowText }] };
}

function extractTranscript(input: DecisionInput): string {
  const parts: string[] = [];
  for (const message of input.messages) {
    if (message.role !== "user") {
      continue;
    }
    parts.push(transcriptFromContent(message.content));
  }
  return parts.join(" ").replace(/\s+/gu, " ").trim();
}

function transcriptFromContent(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed) && typeof parsed.transcript === "string") {
      return parsed.transcript;
    }
  } catch {
    // plain text
  }
  return content;
}

function decisionIdFrom(input: DecisionInput): string {
  const fromMeta = input.metadata?.decisionId;
  if (typeof fromMeta === "string" && fromMeta.trim().length > 0) {
    return fromMeta;
  }
  return `decision-${input.correlationId}`;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
