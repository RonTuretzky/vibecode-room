import { describe, expect, test } from "bun:test";
import {
  ACTIVE_MS,
  AGE_KNEE,
  FRESH_LIFT,
  MAX_SKY_CLOUDS,
  MAX_WISPS,
  R_CORE,
  R_HORIZON,
  SKY_ALT,
  SKY_FAN_HALF,
  azBase,
  cloudAge,
  cloudAltitude,
  cloudRadius,
  fanAzimuth,
  gravitatedAzimuth,
  lifeFactor,
  mergeTarget,
  puffCount,
  puffRadius,
  questCloudId,
  radiusNorm,
  resolveClouds,
  rimFactor,
  rimFlatten,
  selectWisps,
  spreadAzimuths,
  strongestPartner,
  type ResolvedCloud,
  type SkyLinkRef,
  type SkyTurnRef,
  staggeredRadius,
  R_STAGGER,
} from "./cloud-layout";

// Pure sky layout maths — the ceiling's time→place, said→size, and
// relation→wisp laws, tested exactly the way the tree's layout was.

function cloud(overrides: Partial<ResolvedCloud> & { id: string }): ResolvedCloud {
  return {
    label: overrides.id,
    labelSource: "topic",
    firstAtMs: 0,
    freshAtMs: 0,
    turnCount: 1,
    liveTopicId: overrides.id,
    dominantSpeaker: null,
    freshestTurnId: null,
    ...overrides,
  };
}

describe("time → place (the polar log law)", () => {
  test("radius is monotone in age and clamped to the disc", () => {
    let prior = -1;
    for (const age of [0, 1_000, 30_000, 120_000, 600_000, 1_800_000, 7_200_000]) {
      const radius = cloudRadius(age);
      expect(radius).toBeGreaterThanOrEqual(R_CORE);
      expect(radius).toBeLessThanOrEqual(R_HORIZON);
      expect(radius).toBeGreaterThanOrEqual(prior);
      prior = radius;
    }
    expect(cloudRadius(0)).toBe(R_CORE);
    expect(cloudRadius(Number.MAX_SAFE_INTEGER)).toBe(R_HORIZON);
  });

  test("log-law checkpoints on the widened band: 5s ≈ 5.7, 6min ≈ 21.4, 25min ≈ 32.5", () => {
    expect(cloudRadius(5_000)).toBeCloseTo(5.7, 1);
    expect(cloudRadius(360_000)).toBeCloseTo(21.4, 1);
    expect(cloudRadius(1_500_000)).toBeCloseTo(32.5, 1);
  });

  test("age clamps clock skew to zero", () => {
    expect(cloudAge(1_000, 5_000)).toBe(0);
    expect(cloudAge(6_000, 5_000)).toBe(1_000);
  });

  test("azimuth is hash-stable and gravitation is bounded to a quarter of the gap", () => {
    const az = azBase("topic-0007");
    expect(azBase("topic-0007")).toBe(az); // same id, same bearing, forever
    expect(az).toBeGreaterThanOrEqual(0);
    expect(az).toBeLessThan(Math.PI * 2);
    expect(azBase("topic-0008")).not.toBe(az);
    // Full-strength pull moves exactly 25% of the wrapped gap…
    expect(gravitatedAzimuth(0, 1, 1)).toBeCloseTo(0.25, 5);
    // …wrapping the short way around the circle…
    expect(gravitatedAzimuth(0.1, Math.PI * 2 - 0.1, 1)).toBeCloseTo(0.1 - 0.05, 5);
    // …and zero strength means zero drift.
    expect(gravitatedAzimuth(0.4, 3, 0)).toBe(0.4);
  });

  test("fan azimuth is stable and stays inside the visible fan", () => {
    const center = Math.PI;
    const az = fanAzimuth("topic-0007", center);
    expect(fanAzimuth("topic-0007", center)).toBe(az); // hash-stable
    expect(Math.abs(az - center)).toBeLessThanOrEqual(SKY_FAN_HALF);
    expect(fanAzimuth("topic-0008", center)).not.toBe(az);
  });

  test("spreadAzimuths pushes clumped clouds apart, clamped to the fan", () => {
    const center = Math.PI;
    const spread = spreadAzimuths(
      [
        { id: "a", az: center - 0.02 },
        { id: "b", az: center },
        { id: "c", az: center + 0.02 },
      ],
      center,
      0.5,
    );
    const values = ["a", "b", "c"].map((id) => spread.get(id)!).sort((x, y) => x - y);
    expect(values[1]! - values[0]!).toBeGreaterThanOrEqual(0.4);
    expect(values[2]! - values[1]!).toBeGreaterThanOrEqual(0.4);
    for (const az of values) {
      expect(az).toBeGreaterThanOrEqual(center - SKY_FAN_HALF);
      expect(az).toBeLessThanOrEqual(center + SKY_FAN_HALF);
    }
    // Already-spread clouds are left exactly where their hash put them.
    const untouched = spreadAzimuths(
      [
        { id: "a", az: center - 1 },
        { id: "b", az: center + 1 },
      ],
      center,
      0.5,
    );
    expect(untouched.get("a")).toBe(center - 1);
    expect(untouched.get("b")).toBe(center + 1);
  });

  test("fresh clouds ride above the deck; the lift decays with age norm", () => {
    expect(cloudAltitude(0, 0)).toBeCloseTo(SKY_ALT + FRESH_LIFT, 5);
    expect(cloudAltitude(1, 0)).toBeCloseTo(SKY_ALT, 5);
    expect(cloudAltitude(0.5, 0)).toBeGreaterThan(cloudAltitude(0.9, 0));
    expect(cloudAltitude(1, 0.7)).toBeCloseTo(SKY_ALT + 0.7, 5); // jitter passes through
  });
});

describe("said → size + life", () => {
  test("puff laws hit the spec checkpoints", () => {
    expect(puffCount(1)).toBe(11);
    expect(puffCount(8)).toBe(16);
    expect(puffCount(0)).toBe(8);
    expect(puffCount(500)).toBe(16); // clamped — no cloud swallows the sky
    expect(puffRadius(1)).toBeCloseTo(2.85, 2);
    expect(puffRadius(8)).toBeCloseTo(5.35, 1);
    expect(puffRadius(10_000)).toBe(6); // bodies stay under the spread gaps
    // Size stays monotone in how much was said.
    expect(puffRadius(4)).toBeGreaterThan(puffRadius(1));
    expect(puffCount(4)).toBeGreaterThan(puffCount(1));
  });

  test("life: full while active, thinning after, dim + flat at the rim", () => {
    expect(lifeFactor(0)).toBe(1);
    expect(lifeFactor(ACTIVE_MS - 1)).toBe(1);
    expect(lifeFactor(ACTIVE_MS)).toBeLessThan(1);
    expect(lifeFactor(3_600_000)).toBeGreaterThan(0.55); // never fully gone
    expect(lifeFactor(600_000)).toBeLessThan(lifeFactor(60_000));
    expect(rimFactor(0.5)).toBe(1);
    expect(rimFactor(0.9)).toBe(0.7);
    expect(rimFlatten(0.9)).toBe(0.5);
  });
});

describe("resolveClouds (snapshot → renderable)", () => {
  const dialogue: SkyTurnRef[] = [
    { id: "rturn-0001", speaker: "s1", atMs: 1_000, topicId: "topic-0001" },
    { id: "rturn-0002", speaker: "s2", atMs: 2_000, topicId: "topic-0001" },
    { id: "rturn-0003", speaker: "s2", atMs: 3_000, topicId: "topic-0002" },
  ];
  const topics = [
    { id: "topic-0001", label: "Solar", turnIds: ["rturn-0001", "rturn-0002"], freshAtMs: 2_000 },
    { id: "topic-0002", label: "Opera", turnIds: ["rturn-0003"], freshAtMs: 3_000 },
  ];

  test("prefers the server sky and joins the freshest live turn as pick target", () => {
    const sky = {
      clouds: [
        cloud({ id: "topic-0001", label: "Solar", firstAtMs: 1_000, freshAtMs: 2_000, turnCount: 7 }),
        // A memory cloud: topic dead, nothing live to pick.
        cloud({ id: "topic-0009", label: "Old thread", firstAtMs: 500, freshAtMs: 900, turnCount: 3, liveTopicId: null }),
      ],
    };
    const resolved = resolveClouds(topics, sky, dialogue);
    expect(resolved.map((entry) => entry.id)).toEqual(["topic-0009", "topic-0001"]); // oldest-first
    const solar = resolved.find((entry) => entry.id === "topic-0001");
    expect(solar?.turnCount).toBe(7); // the server's beyond-window count wins
    expect(solar?.freshestTurnId).toBe("rturn-0002");
    expect(resolved.find((entry) => entry.id === "topic-0009")?.freshestTurnId).toBeNull();
  });

  test("sky absent → clouds derive from dialogueTopics (degradation gate)", () => {
    const resolved = resolveClouds(topics, undefined, dialogue);
    expect(resolved.map((entry) => entry.id)).toEqual(["topic-0001", "topic-0002"]);
    const solar = resolved[0]!;
    expect(solar.turnCount).toBe(2);
    expect(solar.firstAtMs).toBe(1_000);
    expect(solar.dominantSpeaker).not.toBeNull();
    expect(solar.freshestTurnId).toBe("rturn-0002");
    expect(solar.labelSource).toBe("topic");
  });

  test("keeps only the freshest MAX_SKY_CLOUDS", () => {
    const many = {
      clouds: Array.from({ length: 20 }, (_, index) =>
        cloud({ id: `topic-${index}`, firstAtMs: index, freshAtMs: index * 1_000, liveTopicId: null }),
      ),
    };
    const resolved = resolveClouds([], many, []);
    expect(resolved).toHaveLength(MAX_SKY_CLOUDS);
    // The stalest six aged off past the rim.
    expect(resolved.some((entry) => entry.id === "topic-0")).toBe(false);
    expect(resolved.some((entry) => entry.id === "topic-19")).toBe(true);
  });
});

describe("selectWisps + gravitation partners", () => {
  const shown = new Set(["a", "b", "c", "d"]);

  test("keeps each cloud's strongest link plus anything past the floor, capped", () => {
    const links: SkyLinkRef[] = [
      { a: "a", b: "b", strength: 0.9, source: "agent" },
      { a: "c", b: "d", strength: 0.2, source: "lexical" }, // weak, but c+d's only link
      { a: "a", b: "c", strength: 0.1, source: "lexical" }, // weak and redundant
    ];
    const wisps = selectWisps(links, shown);
    expect(wisps.map((link) => link.strength)).toEqual([0.9, 0.2]);
    // Dangling links (unrendered cloud) never wisp.
    expect(selectWisps([{ a: "a", b: "ghost", strength: 1, source: "agent" }], shown)).toHaveLength(0);
  });

  test("caps at MAX_WISPS strongest-first", () => {
    const ids = new Set<string>();
    const links: SkyLinkRef[] = [];
    for (let index = 0; index < 20; index += 1) {
      const a = `n${index}`;
      const b = `n${index + 20}`;
      ids.add(a);
      ids.add(b);
      links.push({ a, b, strength: 0.4 + index * 0.01, source: "lexical" });
    }
    const wisps = selectWisps(links, ids);
    expect(wisps).toHaveLength(MAX_WISPS);
    expect(wisps[0]!.strength).toBeCloseTo(0.59, 5);
  });

  test("strongestPartner picks the heaviest wisp touching the cloud", () => {
    const wisps: SkyLinkRef[] = [
      { a: "a", b: "b", strength: 0.5, source: "lexical" },
      { a: "c", b: "a", strength: 0.8, source: "agent" },
    ];
    expect(strongestPartner("a", wisps)).toEqual({ id: "c", strength: 0.8 });
    expect(strongestPartner("d", wisps)).toBeNull();
  });
});

describe("rain anchoring + merge choreography", () => {
  const dialogue: SkyTurnRef[] = [
    { id: "rturn-0001", speaker: "s1", atMs: 1_000, topicId: "topic-0001" },
    { id: "rturn-0002", speaker: "s1", atMs: 2_000, topicId: "topic-0002" },
    { id: "rturn-0003", speaker: "s1", atMs: 3_000, topicId: "topic-0002" },
  ];
  const clouds = [cloud({ id: "topic-0001" }), cloud({ id: "topic-0002" })];

  test("a quest hangs under its grounding turn's cloud, zenith when unknown", () => {
    expect(questCloudId("rturn-0001", dialogue, clouds)).toBe("topic-0001");
    expect(questCloudId("rturn-gone", dialogue, clouds)).toBeNull();
    expect(questCloudId(null, dialogue, clouds)).toBeNull();
  });

  test("a vanished cloud glides into the cloud that absorbed its members", () => {
    // topic-0003 vanished; both its last members now sit in topic-0002.
    expect(mergeTarget("topic-0003", ["rturn-0002", "rturn-0003"], dialogue, clouds)).toBe("topic-0002");
    // Split verdict (no majority) → fade in place.
    expect(mergeTarget("topic-0003", ["rturn-0001", "rturn-0002"], dialogue, clouds)).toBeNull();
    // Members gone from the window entirely → fade in place.
    expect(mergeTarget("topic-0003", ["rturn-x", "rturn-y"], dialogue, clouds)).toBeNull();
  });
});

describe("determinism", () => {
  test("same inputs, same sky — layout never rolls dice", () => {
    const norm = radiusNorm(90_000);
    expect(radiusNorm(90_000)).toBe(norm);
    const resolvedA = resolveClouds([], { clouds: [cloud({ id: "t" })] }, []);
    const resolvedB = resolveClouds([], { clouds: [cloud({ id: "t" })] }, []);
    expect(resolvedA).toEqual(resolvedB);
  });
});

// "Way more spaced out" (live-room directive): same-age clouds must not share
// a ring. The stagger is hash-stable per cloud, bounded, and can never fake
// freshness — a NOW cloud stays inside any drifted cloud's lane.
describe("staggeredRadius spreads same-age clouds across lanes", () => {
  test("deterministic per id, and actually different between ids", () => {
    expect(staggeredRadius("topic-1", 60_000)).toBe(staggeredRadius("topic-1", 60_000));
    const lanes = new Set(["topic-1", "topic-2", "topic-3", "topic-4"].map((id) => staggeredRadius(id, 60_000)));
    expect(lanes.size).toBeGreaterThanOrEqual(3);
  });

  test("bounded by the stagger around the age radius, clamped to the band", () => {
    for (const id of ["a", "b", "c", "zz"]) {
      for (const age of [0, 60_000, 1_800_000]) {
        const r = staggeredRadius(id, age);
        expect(Math.abs(r - cloudRadius(age))).toBeLessThanOrEqual(R_STAGGER + 1e-9);
        expect(r).toBeGreaterThanOrEqual(R_CORE * 0.7);
        expect(r).toBeLessThanOrEqual(R_HORIZON);
      }
    }
  });
});
