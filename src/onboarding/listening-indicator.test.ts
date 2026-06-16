import { describe, expect, test } from "bun:test";
import { PRERENDERED_EARCONS } from "../audio/earcons";
import { RecordingAudioOutput } from "../audio/test-doubles";
import type { LogEvent } from "../types";
import { ListeningIndicator, nonAuthoritativeBoardBadge } from "./listening-indicator";

describe("onboarding listening indicator", () => {
  test("authoritative indicator is the E2 transcribing-ambient earcon driven by mic-stream state", async () => {
    const output = new RecordingAudioOutput();
    const traces: LogEvent[] = [];
    const indicator = new ListeningIndicator({
      sessionId: "session-indicator",
      output,
      clock: () => 1_000,
      onTrace: (event) => traces.push(event),
    });

    const visualBadge = nonAuthoritativeBoardBadge(false);
    const emission = await indicator.updateFromMicStream({
      phase: "streaming",
      correlationId: "corr-streaming",
      nowMs: 1_000,
    });

    expect(visualBadge).toEqual({ authoritative: false, listening: false, source: "board" });
    expect(emission).toEqual(expect.objectContaining({ id: "E2", source: "transcribing-ambient" }));
    expect(output.calls).toEqual([
      {
        clip: PRERENDERED_EARCONS.E2,
        meta: {
          correlationId: "corr-streaming",
          source: "transcribing-ambient",
          emittedAtMs: 1_000,
        },
      },
    ]);
    expect(indicator.authoritativeState()).toEqual({
      authoritative: true,
      listening: true,
      source: "mic-stream",
      earconId: "E2",
    });
    expect(traces).toContainEqual(
      expect.objectContaining({
        event: "earcon.emit",
        correlationId: "corr-streaming",
        meta: expect.objectContaining({
          id: "E2",
          source: "transcribing-ambient",
          authoritative: true,
          driver: "mic-stream",
        }),
      }),
    );
  });

  test("does not re-emit E2 for unchanged streaming state", async () => {
    const output = new RecordingAudioOutput();
    const indicator = new ListeningIndicator({ sessionId: "session-indicator-repeat", output });

    await indicator.updateFromMicStream({ phase: "streaming", correlationId: "corr-one" });
    const repeated = await indicator.updateFromMicStream({ phase: "streaming", correlationId: "corr-two" });

    expect(repeated).toBeNull();
    expect(output.calls).toHaveLength(1);
  });
});
