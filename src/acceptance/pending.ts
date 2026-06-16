import { pendingSuggestionSchema, type PendingSuggestion } from "../types";

export const ACCEPTANCE_STATE_IDLE = "IDLE";
export const ACCEPTANCE_STATE_SUGGESTION_DELIVERY = "SUGGESTION_DELIVERY";
export const DEFAULT_NO_ANSWER_TIMEOUT_MS = 5_000;

export type AcceptanceState = typeof ACCEPTANCE_STATE_IDLE | typeof ACCEPTANCE_STATE_SUGGESTION_DELIVERY;

export interface McqAnswerRecord {
  mcqIndex: number;
  question: string;
  answer: string;
  correlationId?: string;
  answeredAtMs: number;
}

export type PendingExpiryResult =
  | { kind: "not-expired"; pending: PendingSuggestion | null }
  | { kind: "requeued"; pending: PendingSuggestion }
  | { kind: "discarded"; suggestion: PendingSuggestion };

export interface PendingSuggestionOwnerOptions {
  clock?: () => number;
  noAnswerTimeoutMs?: number;
}

export class PendingSuggestionOwner {
  readonly #clock: () => number;
  readonly #noAnswerTimeoutMs: number;
  #state: AcceptanceState = ACCEPTANCE_STATE_IDLE;
  #pending: PendingSuggestion | null = null;
  #answers: McqAnswerRecord[] = [];
  #deadlineAtMs = 0;
  #noAnswerExpiries = 0;

  constructor(options: PendingSuggestionOwnerOptions = {}) {
    this.#clock = options.clock ?? (() => Date.now());
    this.#noAnswerTimeoutMs = options.noAnswerTimeoutMs ?? DEFAULT_NO_ANSWER_TIMEOUT_MS;
  }

  state(): AcceptanceState {
    return this.#state;
  }

  pending(): PendingSuggestion | null {
    return this.#pending === null ? null : cloneSuggestion(this.#pending);
  }

  answerRecords(): McqAnswerRecord[] {
    return this.#answers.map((answer) => ({ ...answer }));
  }

  questionOpen(): boolean {
    return this.#pending !== null && this.#answers.length < this.#pending.mcqs.length;
  }

  acceptSuggestion(suggestion: PendingSuggestion): PendingSuggestion {
    const nowMs = this.#clock();
    this.#pending = pendingSuggestionSchema.parse({
      ...suggestion,
      answers: [],
      expiresAt: nowMs + this.#noAnswerTimeoutMs,
    });
    this.#answers = [];
    this.#state = ACCEPTANCE_STATE_SUGGESTION_DELIVERY;
    this.#deadlineAtMs = nowMs + this.#noAnswerTimeoutMs;
    this.#noAnswerExpiries = 0;
    return this.pendingOrThrow();
  }

  appendAnswer(answer: string, correlationId?: string): McqAnswerRecord | null {
    if (!this.questionOpen() || this.#pending === null) {
      return null;
    }

    const normalized = answer.trim();
    if (normalized.length === 0) {
      return null;
    }

    const mcqIndex = this.#answers.length;
    const record: McqAnswerRecord = {
      mcqIndex,
      question: this.#pending.mcqs[mcqIndex] ?? "",
      answer: normalized,
      correlationId,
      answeredAtMs: this.#clock(),
    };
    this.#answers.push(record);
    this.#pending = pendingSuggestionSchema.parse({
      ...this.#pending,
      answers: this.#answers.map((entry) => entry.answer),
      expiresAt: this.#clock() + this.#noAnswerTimeoutMs,
    });
    this.#deadlineAtMs = this.#pending.expiresAt;
    this.#noAnswerExpiries = 0;
    return { ...record };
  }

  checkExpiry(nowMs = this.#clock()): PendingExpiryResult {
    if (this.#pending === null || nowMs < this.#deadlineAtMs) {
      return { kind: "not-expired", pending: this.pending() };
    }

    if (this.#noAnswerExpiries === 0) {
      this.#noAnswerExpiries = 1;
      this.#deadlineAtMs = nowMs + this.#noAnswerTimeoutMs;
      this.#pending = pendingSuggestionSchema.parse({
        ...this.#pending,
        expiresAt: this.#deadlineAtMs,
      });
      return { kind: "requeued", pending: this.pendingOrThrow() };
    }

    const suggestion = this.pendingOrThrow();
    this.clear();
    return { kind: "discarded", suggestion };
  }

  clear(): void {
    this.#pending = null;
    this.#answers = [];
    this.#state = ACCEPTANCE_STATE_IDLE;
    this.#deadlineAtMs = 0;
    this.#noAnswerExpiries = 0;
  }

  private pendingOrThrow(): PendingSuggestion {
    if (this.#pending === null) {
      throw new Error("No pending suggestion is open.");
    }
    return cloneSuggestion(this.#pending);
  }
}

function cloneSuggestion(suggestion: PendingSuggestion): PendingSuggestion {
  return pendingSuggestionSchema.parse({
    ...suggestion,
    mcqs: [...suggestion.mcqs],
    answers: [...suggestion.answers],
  });
}
