import { describe, expect, test } from "bun:test";
import { createProjectorRuntime } from "./composition";
import { healthPayload } from "./degradation-notice";

// Integration: the runtime accessor and the /api/health payload report the same
// degradation flags as the startup notice (no real providers configured here).
describe("health surface exposes degradation flags", () => {
  test("default runtime reports every leg degraded, matching the health payload", async () => {
    const runtime = await createProjectorRuntime({});

    expect(runtime.degradation.allReal).toBe(false);
    expect(runtime.degradation.degraded.map((d) => d.leg).sort()).toEqual([
      "asr",
      "decider",
      "sink",
      "smithers",
      "tts",
    ]);

    const health = healthPayload(runtime);
    expect(health.ok).toBe(true);
    expect(health.app).toBe("vibersyn-projector");
    // the health surface reports exactly the runtime's degradation block
    expect(health.degradation).toBe(runtime.degradation);
  });

  test("a partially-upgraded leg drops out of the degradation set", async () => {
    // DEEPGRAM_API_KEY upgrades the ASR leg to deepgram; the rest stay stubbed.
    const runtime = await createProjectorRuntime({ DEEPGRAM_API_KEY: "dg-test-key" });
    expect(runtime.degradation.degraded.map((d) => d.leg)).not.toContain("asr");
    expect(runtime.degradation.degraded.map((d) => d.leg).sort()).toEqual(["decider", "sink", "smithers", "tts"]);
  });
});
