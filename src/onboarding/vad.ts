export const FIRST_RUN_VAD_DURATION_MS = 5 * 60 * 1_000;
export const FIRST_RUN_VAD_SILENCE_MULTIPLIER = 1.5;

export interface VadThresholdInput {
  silenceThresholdMs: number;
  nowMs: number;
  firstRunStartedAtMs: number;
}

export interface VadThresholdResult {
  silenceThresholdMs: number;
  baseSilenceThresholdMs: number;
  firstRunActive: boolean;
  multiplier: number;
}

export class FirstRunVadTuner {
  readonly #startedAtMs: number;
  readonly #durationMs: number;
  readonly #multiplier: number;
  readonly #clock: () => number;

  constructor(options: { startedAtMs: number; clock?: () => number; durationMs?: number; multiplier?: number }) {
    this.#startedAtMs = options.startedAtMs;
    this.#clock = options.clock ?? (() => performance.now());
    this.#durationMs = options.durationMs ?? FIRST_RUN_VAD_DURATION_MS;
    this.#multiplier = options.multiplier ?? FIRST_RUN_VAD_SILENCE_MULTIPLIER;
  }

  threshold(baseSilenceThresholdMs: number, nowMs = this.#clock()): VadThresholdResult {
    return firstRunVadThreshold({
      silenceThresholdMs: baseSilenceThresholdMs,
      nowMs,
      firstRunStartedAtMs: this.#startedAtMs,
    }, this.#durationMs, this.#multiplier);
  }
}

export function firstRunVadThreshold(
  input: VadThresholdInput,
  durationMs = FIRST_RUN_VAD_DURATION_MS,
  multiplier = FIRST_RUN_VAD_SILENCE_MULTIPLIER,
): VadThresholdResult {
  if (!Number.isFinite(input.silenceThresholdMs) || input.silenceThresholdMs < 0) {
    throw new Error("silenceThresholdMs must be a nonnegative finite number.");
  }

  const firstRunActive = input.nowMs - input.firstRunStartedAtMs < durationMs;
  return {
    silenceThresholdMs: firstRunActive ? input.silenceThresholdMs * multiplier : input.silenceThresholdMs,
    baseSilenceThresholdMs: input.silenceThresholdMs,
    firstRunActive,
    multiplier: firstRunActive ? multiplier : 1,
  };
}
