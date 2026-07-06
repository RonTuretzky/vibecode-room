import { describe, expect, test } from "bun:test";
import {
  buildDegradationNotice,
  formatDegradationNotice,
  type RuntimeLegSelections,
} from "./degradation-notice";

const ALL_STUBBED: RuntimeLegSelections = {
  asr: "replay",
  tts: "noop",
  sink: "noop",
  decider: "heuristic",
  smithers: "memory",
};

const ALL_REAL: RuntimeLegSelections = {
  asr: "deepgram",
  tts: "elevenlabs",
  sink: "device",
  decider: "claude",
  smithers: "gateway",
};

describe("buildDegradationNotice", () => {
  test("lists exactly the degraded legs for the default all-stubbed selection", () => {
    const notice = buildDegradationNotice(ALL_STUBBED);
    expect(notice.allReal).toBe(false);
    expect(notice.degraded.map((d) => d.leg).sort()).toEqual(["asr", "decider", "sink", "smithers", "tts"]);
    // every degraded leg names how to upgrade it
    for (const leg of notice.degraded) {
      expect(leg.upgrade.length).toBeGreaterThan(0);
      expect(leg.detail.length).toBeGreaterThan(0);
    }
  });

  test("is empty / allReal when every leg is a real backend", () => {
    const notice = buildDegradationNotice(ALL_REAL);
    expect(notice.allReal).toBe(true);
    expect(notice.degraded).toHaveLength(0);
  });

  test("voxterm ASR counts as real (only replay is degraded)", () => {
    expect(buildDegradationNotice({ ...ALL_REAL, asr: "voxterm" }).allReal).toBe(true);
    expect(buildDegradationNotice({ ...ALL_REAL, asr: "replay" }).degraded.map((d) => d.leg)).toEqual(["asr"]);
  });

  test("replay decider is also degraded", () => {
    expect(buildDegradationNotice({ ...ALL_REAL, decider: "replay" }).degraded.map((d) => d.leg)).toEqual(["decider"]);
  });

  test("each leg toggles independently", () => {
    expect(buildDegradationNotice({ ...ALL_REAL, tts: "noop" }).degraded.map((d) => d.leg)).toEqual(["tts"]);
    expect(buildDegradationNotice({ ...ALL_REAL, sink: "noop" }).degraded.map((d) => d.leg)).toEqual(["sink"]);
    expect(buildDegradationNotice({ ...ALL_REAL, smithers: "memory" }).degraded.map((d) => d.leg)).toEqual(["smithers"]);
  });
});

describe("formatDegradationNotice", () => {
  test("all-real renders a single explicit no-degradation line", () => {
    const text = formatDegradationNotice(buildDegradationNotice(ALL_REAL));
    expect(text).toContain("no degradation");
    expect(text.split("\n")).toHaveLength(1);
  });

  test("all-stubbed renders a header + one line per leg, each with its upgrade env", () => {
    const text = formatDegradationNotice(buildDegradationNotice(ALL_STUBBED));
    expect(text.split("\n")).toHaveLength(6); // header + 5 legs
    expect(text).toContain("DEEPGRAM_API_KEY");
    expect(text).toContain("VIBERSYN_TTS_PROVIDER=elevenlabs");
    expect(text).toContain("VIBERSYN_AUDIO_SINK=device");
    expect(text).toContain("VIBERSYN_DECISION_LLM=claude");
    expect(text).toContain("VIBERSYN_SMITHERS_GATEWAY_URL");
  });
});
