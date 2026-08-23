import { describe, expect, test } from "bun:test";
import { CloudGraph } from "../research/sky";
import { createProjectorApp } from "./app";
import { createProjectorRuntime } from "./composition";
import { healthPayload } from "./degradation-notice";

// Integration: the runtime accessor and the /api/health payload report the same
// degradation flags as the startup notice (no real providers configured here).
describe("health surface exposes degradation flags", () => {
  test("default runtime reports every leg degraded, matching the health payload", async () => {
    const runtime = await createProjectorRuntime({});

    expect(runtime.degradation.allReal).toBe(false);
    // The summarizer leg reports degraded here whether composition has wired
    // selectSummarizer yet ("unwired") or wired it with no CEREBRAS_API_KEY
    // ("deterministic") — a no-key runtime can never claim a real summarizer.
    expect(runtime.degradation.degraded.map((d) => d.leg).sort()).toEqual([
      "asr",
      "decider",
      "sink",
      "smithers",
      "summarizer",
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
    expect(runtime.degradation.degraded.map((d) => d.leg).sort()).toEqual([
      "decider",
      "sink",
      "smithers",
      "summarizer",
      "tts",
    ]);
  });
});

// ── the DYNAMIC sky-relate leg: /api/health hears a persistent 402 ───────────

describe("/api/health grows the sky-relate leg on a miss streak and drops it after a landed tick", () => {
  test("streak 3 → degraded leg with the reason; a landed tick removes it", async () => {
    let mode: "throw" | "ok" = "throw";
    const cloudGraph = new CloudGraph({
      intervalMs: 0,
      runner: async () => {
        if (mode === "throw") {
          throw new Error("cerebras 402: payment_required");
        }
        return "{}";
      },
    });
    const runtime = await createProjectorRuntime({}, { cloudGraph });
    const app = createProjectorApp(runtime);
    const legsOf = async () => {
      const response = await app.request("/api/health");
      const payload = (await response.json()) as { degradation: { degraded: Array<{ leg: string; detail: string }> } };
      return payload.degradation.degraded;
    };
    // Feed the graph 2 clouds so relate ticks actually run, then miss 3 times.
    const observe = () =>
      cloudGraph.observe(
        [
          { id: "topic-0001", label: "solar", turnIds: ["t1"], freshAtMs: 1_000 },
          { id: "topic-0002", label: "battery", turnIds: ["t2"], freshAtMs: 2_000 },
        ],
        [
          { id: "t1", speaker: "s1", text: "solar panel inverter efficiency numbers", atMs: 1_000 },
          { id: "t2", speaker: "s2", text: "battery storage keeps output stable", atMs: 2_000 },
        ],
      );
    for (let tick = 0; tick < 3; tick += 1) {
      observe();
      await cloudGraph.relateNow();
    }
    const degraded = await legsOf();
    const skyLeg = degraded.find((leg) => leg.leg === "sky-relate");
    expect(skyLeg?.detail).toBe("sky relate: 3 consecutive misses (cerebras 402: payment_required)");
    // The tick lands → the leg drops on the next health read.
    mode = "ok";
    observe();
    await cloudGraph.relateNow();
    expect((await legsOf()).some((leg) => leg.leg === "sky-relate")).toBe(false);
    cloudGraph.dispose();
  });
});
