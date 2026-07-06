import { logEventSchema, type LogEvent, type OutputDecision } from "../types";

export const CONSENT_ANNOUNCEMENT =
  "Vibersyn is listening. Only transcripts are saved. Say 'Viber, status' for a rundown; say 'mute' to pause.";
export const CONSENT_MAX_START_DELAY_MS = 3_000;
export const CONSENT_MAX_DURATION_MS = 8_000;
export const CONSENT_ESTIMATED_WORDS_PER_MINUTE = 150;

export interface ConsentSchedulerOptions {
  sessionId: string;
  provider: string;
  clock?: () => number;
  onOutput?: (decision: OutputDecision) => void | Promise<void>;
  onTrace?: (event: LogEvent) => void;
}

export interface ConsentSchedulerResult {
  spoken: boolean;
  text: string;
  firedAtMs: number;
  latencyMs: number;
  event: LogEvent;
}

export class ConsentScheduler {
  readonly #sessionId: string;
  readonly #provider: string;
  readonly #clock: () => number;
  readonly #onOutput?: ConsentSchedulerOptions["onOutput"];
  readonly #onTrace?: ConsentSchedulerOptions["onTrace"];
  #startedAtMs: number | null = null;
  #result: ConsentSchedulerResult | null = null;

  constructor(options: ConsentSchedulerOptions) {
    this.#sessionId = options.sessionId;
    this.#provider = options.provider;
    this.#clock = options.clock ?? (() => performance.now());
    this.#onOutput = options.onOutput;
    this.#onTrace = options.onTrace;

    assertConsentAnnouncement(CONSENT_ANNOUNCEMENT);
  }

  async start(startedAtMs = this.#clock()): Promise<ConsentSchedulerResult> {
    if (this.#result !== null) {
      return this.#result;
    }

    this.#startedAtMs = startedAtMs;
    return this.fire();
  }

  async fire(): Promise<ConsentSchedulerResult> {
    if (this.#result !== null) {
      return this.#result;
    }

    const startedAtMs = this.#startedAtMs ?? this.#clock();
    const firedAtMs = this.#clock();
    const latencyMs = Math.max(0, firedAtMs - startedAtMs);

    if (latencyMs > CONSENT_MAX_START_DELAY_MS) {
      throw new Error(`Consent announcement fired after ${latencyMs}ms; expected <= ${CONSENT_MAX_START_DELAY_MS}ms.`);
    }

    await this.#onOutput?.({
      channel: "tts",
      text: CONSENT_ANNOUNCEMENT,
      wordCount: countWords(CONSENT_ANNOUNCEMENT),
      summarized: false,
    });

    const event = logEventSchema.parse({
      level: "info",
      event: "session.start",
      sessionId: this.#sessionId,
      latencyMs,
      meta: {
        provider: this.#provider,
        consentSpoken: true,
        transcriptOnlyStated: true,
      },
    });

    this.#onTrace?.(event);
    this.#result = {
      spoken: true,
      text: CONSENT_ANNOUNCEMENT,
      firedAtMs,
      latencyMs,
      event,
    };
    return this.#result;
  }

  consentSpoken(): boolean {
    return this.#result !== null;
  }
}

export function assertConsentAnnouncement(text: string): void {
  if (text !== CONSENT_ANNOUNCEMENT) {
    throw new Error("Consent announcement text must match the required literal.");
  }
  if (!text.includes("Only transcripts are saved.")) {
    throw new Error("Consent announcement must state that only transcripts are saved.");
  }
  if (!text.includes("say 'mute' to pause.")) {
    throw new Error("Consent announcement must name the actual mute word.");
  }
  if (sentenceCount(text) !== 3) {
    throw new Error("Consent announcement must be exactly three sentences.");
  }
  if (estimatedSpeechDurationMs(text) > CONSENT_MAX_DURATION_MS) {
    throw new Error(`Consent announcement must be speakable within ${CONSENT_MAX_DURATION_MS}ms.`);
  }
}

export function estimatedSpeechDurationMs(text: string): number {
  return (countWords(text) / CONSENT_ESTIMATED_WORDS_PER_MINUTE) * 60_000;
}

export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function sentenceCount(text: string): number {
  return text.split(/[.!?]+(?:\s|$)/u).map((sentence) => sentence.trim()).filter(Boolean).length;
}
