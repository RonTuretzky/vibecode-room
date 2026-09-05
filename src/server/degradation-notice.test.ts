import { describe, expect, test } from "bun:test";
import {
  agentTickLegs,
  buildDegradationNotice,
  formatDegradationNotice,
  healthPayload,
  type RuntimeLegSelections,
} from "./degradation-notice";

const ALL_STUBBED: RuntimeLegSelections = {
  asr: "replay",
  tts: "noop",
  sink: "noop",
  decider: "heuristic",
  smithers: "memory",
  summarizer: "deterministic",
};

const ALL_REAL: RuntimeLegSelections = {
  asr: "deepgram",
  tts: "elevenlabs",
  sink: "device",
  decider: "claude",
  smithers: "gateway",
  summarizer: "cerebras",
};

describe("buildDegradationNotice", () => {
  test("lists exactly the degraded legs for the default all-stubbed selection", () => {
    const notice = buildDegradationNotice(ALL_STUBBED);
    expect(notice.allReal).toBe(false);
    expect(notice.degraded.map((d) => d.leg).sort()).toEqual(["asr", "decider", "sink", "smithers", "summarizer", "tts"]);
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
    expect(buildDegradationNotice({ ...ALL_REAL, summarizer: "deterministic" }).degraded.map((d) => d.leg)).toEqual([
      "summarizer",
    ]);
  });

  test("the memory Smithers leg names its fake telemetry, not just fixture spawns", () => {
    const [leg] = buildDegradationNotice({ ...ALL_REAL, smithers: "memory" }).degraded;
    expect(leg?.detail).toContain("telemetry is fake");
  });

  test("an ABSENT summarizer selection is itself degraded — allReal cannot be claimed while the leg is unwired", () => {
    const { summarizer: _omitted, ...unwired } = ALL_REAL;
    const notice = buildDegradationNotice(unwired);
    expect(notice.allReal).toBe(false);
    expect(notice.degraded.map((d) => d.leg)).toEqual(["summarizer"]);
    expect(notice.degraded[0]?.mode).toBe("unwired");
    expect(notice.degraded[0]?.upgrade).toContain("selectSummarizer");
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
    expect(text.split("\n")).toHaveLength(7); // header + 6 legs
    expect(text).toContain("DEEPGRAM_API_KEY");
    expect(text).toContain("VIBERSYN_TTS_PROVIDER=elevenlabs");
    expect(text).toContain("VIBERSYN_AUDIO_SINK=device");
    expect(text).toContain("VIBERSYN_DECISION_LLM=claude");
    expect(text).toContain("VIBERSYN_SMITHERS_GATEWAY_URL");
    expect(text).toContain("VIBERSYN_SUMMARIZER=cerebras");
  });
});

// ── dynamic agent-tick legs (the sky relate 402 that was silent for 77 ticks) ─

describe("agentTickLegs + healthPayload dynamic degradation", () => {
  const healthy = { missStreak: 0, lastMissReason: null };
  const failing = { missStreak: 5, lastMissReason: "cerebras 402: payment_required" };

  test("below the streak threshold no leg appears; at it, both agents report", () => {
    expect(agentTickLegs({ skyRelate: healthy, topicRefiner: healthy })).toEqual([]);
    expect(agentTickLegs({ skyRelate: { missStreak: 2, lastMissReason: "timeout" } })).toEqual([]);
    const legs = agentTickLegs({ skyRelate: failing, topicRefiner: { missStreak: 3, lastMissReason: "timeout" } });
    expect(legs.map((leg) => leg.leg)).toEqual(["sky-relate", "topic-refiner"]);
    expect(legs[0]!.detail).toBe("sky relate: 5 consecutive misses (cerebras 402: payment_required)");
    expect(legs[1]!.detail).toBe("topic refiner: 3 consecutive misses (timeout)");
    expect(legs[0]!.upgrade).toContain("configured research model");
  });

  test("healthPayload appends dynamic legs and flips allReal; healthy agents leave it untouched", () => {
    const boot = buildDegradationNotice(ALL_REAL);
    expect(boot.allReal).toBe(true);
    const degradedHealth = healthPayload({ degradation: boot, skyAgent: failing, topicRefiner: healthy });
    expect(degradedHealth.degradation.allReal).toBe(false);
    expect(degradedHealth.degradation.degraded.map((leg) => leg.leg)).toEqual(["sky-relate"]);
    // Healthy agents: the payload passes the boot notice through by REFERENCE
    // (legacy callers and the composition self test rely on identity).
    const healthyPayload = healthPayload({ degradation: boot, skyAgent: healthy, topicRefiner: healthy });
    expect(healthyPayload.degradation).toBe(boot);
  });
});
