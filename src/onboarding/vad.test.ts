import { describe, expect, test } from "bun:test";
import { FIRST_RUN_VAD_DURATION_MS, FirstRunVadTuner, firstRunVadThreshold } from "./vad";

describe("first-run VAD tuning", () => {
  test("raises the silence threshold by fifty percent for the first five minutes", () => {
    expect(
      firstRunVadThreshold({
        silenceThresholdMs: 1_000,
        firstRunStartedAtMs: 10_000,
        nowMs: 10_000 + FIRST_RUN_VAD_DURATION_MS - 1,
      }),
    ).toEqual({
      silenceThresholdMs: 1_500,
      baseSilenceThresholdMs: 1_000,
      firstRunActive: true,
      multiplier: 1.5,
    });
  });

  test("returns to the base silence threshold after five minutes", () => {
    const tuner = new FirstRunVadTuner({
      startedAtMs: 10_000,
      clock: () => 10_000 + FIRST_RUN_VAD_DURATION_MS,
    });

    expect(tuner.threshold(1_000)).toEqual({
      silenceThresholdMs: 1_000,
      baseSilenceThresholdMs: 1_000,
      firstRunActive: false,
      multiplier: 1,
    });
  });
});
