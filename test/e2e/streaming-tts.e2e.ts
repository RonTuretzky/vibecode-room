import { describe, expect, test } from "bun:test";
import { createElevenLabsFlashTTSFromEnv } from "../../src/providers/tts/elevenlabs";

// Guarded live synthesis. Self-skips unless ELEVENLABS_API_KEY is set so the
// suite is green offline; when the key is present it makes a real streaming
// request and proves the first audio bytes arrive before synthesis completes.
const live = createElevenLabsFlashTTSFromEnv();

describe("P-TTS live streaming synthesis (guarded)", () => {
  test.skipIf(live.provider === null)("real ElevenLabs Flash speak() yields audio bytes", async () => {
    const provider = live.provider!;
    const stream = await provider.speak("Panopticon streaming text to speech smoke test.");
    const reader = stream.getReader();

    let total = 0;
    try {
      while (total === 0) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        total += value.byteLength;
      }
    } finally {
      reader.releaseLock();
      await stream.cancel().catch(() => {});
    }

    expect(total).toBeGreaterThan(0);
  });

  test("credential seam resolves even when the live key is absent", () => {
    expect(live.credentialSource).toEqual({
      kind: "environment",
      provider: "tts",
      variable: "ELEVENLABS_API_KEY",
      redacted: true,
    });
    if (live.provider === null) {
      expect(live.skippedReason).toContain("ELEVENLABS_API_KEY");
    }
  });
});
