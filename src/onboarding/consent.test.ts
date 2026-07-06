import { describe, expect, test } from "bun:test";
import type { LogEvent, OutputDecision } from "../types";
import {
  CONSENT_ANNOUNCEMENT,
  CONSENT_MAX_DURATION_MS,
  ConsentScheduler,
  assertConsentAnnouncement,
  countWords,
  estimatedSpeechDurationMs,
} from "./consent";

describe("onboarding consent scheduler", () => {
  test("fires the required spoken consent once within 3 seconds and logs transcript-only metadata", async () => {
    const outputs: OutputDecision[] = [];
    const traces: LogEvent[] = [];
    const scheduler = new ConsentScheduler({
      sessionId: "session-consent",
      provider: "replay-asr",
      clock: steppedClock([1_000, 1_120]),
      onOutput: (decision) => {
        outputs.push(decision);
      },
      onTrace: (event) => traces.push(event),
    });

    const first = await scheduler.start(1_000);
    const second = await scheduler.start(1_000);

    expect(first).toBe(second);
    expect(first.spoken).toBe(true);
    expect(first.latencyMs).toBe(0);
    expect(outputs).toEqual([
      {
        channel: "tts",
        text: CONSENT_ANNOUNCEMENT,
        wordCount: countWords(CONSENT_ANNOUNCEMENT),
        summarized: false,
      },
    ]);
    expect(traces).toEqual([
      expect.objectContaining({
        event: "session.start",
        sessionId: "session-consent",
        meta: {
          provider: "replay-asr",
          consentSpoken: true,
          transcriptOnlyStated: true,
        },
      }),
    ]);
  });

  test("announcement is the literal three-sentence AC1.1 text and stays under the eight-second speech budget", () => {
    expect(CONSENT_ANNOUNCEMENT).toBe(
      "Vibersyn is listening. Only transcripts are saved. Say 'Viber, status' for a rundown; say 'mute' to pause.",
    );
    expect(() => assertConsentAnnouncement(CONSENT_ANNOUNCEMENT)).not.toThrow();
    expect(estimatedSpeechDurationMs(CONSENT_ANNOUNCEMENT)).toBeLessThanOrEqual(CONSENT_MAX_DURATION_MS);
  });

  test("late consent is rejected instead of silently violating the start budget", async () => {
    const scheduler = new ConsentScheduler({
      sessionId: "session-consent-late",
      provider: "replay-asr",
      clock: steppedClock([4_500]),
    });

    await expect(scheduler.start(1_000)).rejects.toThrow("expected <= 3000ms");
  });
});

function steppedClock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
