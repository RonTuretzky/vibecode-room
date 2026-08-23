import { describe, expect, test } from "bun:test";
import {
  BAND_EDGE,
  MAX_DUST,
  MAX_SKY_CONSTELLATIONS,
  MAX_STARS_PER_CONST,
  SEGMENT_GAP_FAINT_FACTOR,
  SKY_ALT,
  SKY_FAN_HALF,
  asterismHalfLength,
  asterismPositions,
  bandAzimuths,
  constellationAnchor,
  constellationBrightness,
  constellationStars,
  dustPosition,
  nowStarId,
  resolveConstellations,
  segmentAlphaFactor,
  starSize,
  type ConstellationStar,
  type ResolvedCloud,
} from "./constellation-layout";

const CENTER = Math.PI * 0.75;

function consts(n: number): Array<{ id: string; firstAtMs: number }> {
  return Array.from({ length: n }, (_, index) => ({ id: `topic-${String(index + 1).padStart(4, "0")}`, firstAtMs: (index + 1) * 60_000 }));
}

describe("band law: azimuth is founding chronology", () => {
  test("azimuth strictly increases with firstAtMs rank and stays inside the fan", () => {
    for (const n of [1, 3, 7, 12]) {
      const entries = consts(n);
      const map = bandAzimuths(entries, CENTER);
      const ordered = entries.map((entry) => map.get(entry.id)!);
      for (let index = 1; index < ordered.length; index += 1) {
        expect(ordered[index]!).toBeGreaterThan(ordered[index - 1]!);
      }
      for (const az of ordered) {
        expect(az).toBeGreaterThanOrEqual(CENTER - SKY_FAN_HALF);
        expect(az).toBeLessThanOrEqual(CENTER + SKY_FAN_HALF);
      }
    }
  });

  test("founding a NEW topic moves every older constellation monotonically WEST", () => {
    const before = bandAzimuths(consts(6), CENTER);
    const after = bandAzimuths(consts(7), CENTER); // topic-0007 is newest
    for (const entry of consts(6)) {
      expect(after.get(entry.id)!).toBeLessThan(before.get(entry.id)!);
    }
    // …and the newcomer sits east of everyone.
    const all = consts(7).map((entry) => after.get(entry.id)!);
    expect(Math.max(...all)).toBe(after.get("topic-0007")!);
  });

  test("deterministic: two runs are identical", () => {
    const a = bandAzimuths(consts(9), CENTER);
    const b = bandAzimuths(consts(9), CENTER);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});

describe("anchor: chronological bearing × recency radius", () => {
  test("a fresh anchor rides high near the core; a stale one sinks toward the horizon", () => {
    const fresh = constellationAnchor("topic-0001", CENTER, 5_000);
    const stale = constellationAnchor("topic-0001", CENTER, 25 * 60_000);
    expect(Math.hypot(fresh.x, fresh.z)).toBeLessThan(Math.hypot(stale.x, stale.z));
    expect(fresh.y).toBeGreaterThan(stale.y);
    expect(stale.y).toBeGreaterThanOrEqual(SKY_ALT);
  });
});

describe("asterism walk: chronology along the eastward tangent", () => {
  const anchor = { x: 10, y: 18, z: -4 };

  function stars(n: number): ConstellationStar[] {
    return Array.from({ length: n }, (_, index) => ({
      id: `rturn-${index}`,
      atMs: index * 10_000,
      speaker: "s1",
      text: "words",
      live: false,
    }));
  }

  test("tangent projections are non-decreasing in atMs (the line reads as a timeline)", () => {
    const az = CENTER + 0.3;
    const tx = Math.cos(az);
    const tz = -Math.sin(az);
    const positions = asterismPositions(anchor, az, stars(9));
    const along = positions.map((p) => (p.x - anchor.x) * tx + (p.z - anchor.z) * tz);
    for (let index = 1; index < along.length; index += 1) {
      expect(along[index]!).toBeGreaterThan(along[index - 1]!);
    }
  });

  test("the walk stays inside its patch and n=1 centers on the anchor's tangent", () => {
    const az = CENTER;
    const many = asterismPositions(anchor, az, stars(24));
    const half = asterismHalfLength(24);
    for (const p of many) {
      expect(Math.hypot(p.x - anchor.x, p.z - anchor.z)).toBeLessThanOrEqual(half * 1.3);
      expect(Math.abs(p.y - anchor.y)).toBeLessThanOrEqual(0.61);
    }
    const single = asterismPositions(anchor, az, stars(1));
    expect(single).toHaveLength(1);
    const tangent = (single[0]!.x - anchor.x) * Math.cos(az) + (single[0]!.z - anchor.z) * -Math.sin(az);
    expect(Math.abs(tangent)).toBeLessThan(1e-9);
  });

  test("deterministic per star id; patch length grows log with members and caps", () => {
    const a = asterismPositions(anchor, CENTER, stars(5));
    const b = asterismPositions(anchor, CENTER, stars(5));
    expect(a).toEqual(b);
    expect(asterismHalfLength(1)).toBeCloseTo(2.25, 2);
    expect(asterismHalfLength(24)).toBeCloseTo(4.2, 5);
    expect(asterismHalfLength(500)).toBe(4.2);
  });
});

describe("star, line, brightness, and dust laws", () => {
  test("star size follows word count, clamped 4..9", () => {
    expect(starSize(0)).toBe(4);
    expect(starSize(3)).toBeCloseTo(7, 1);
    expect(starSize(500)).toBe(9);
  });

  test("a segment spanning >120s renders at the faint return-line factor", () => {
    expect(segmentAlphaFactor(3_000)).toBe(1);
    expect(segmentAlphaFactor(119_999)).toBe(1);
    expect(segmentAlphaFactor(120_001)).toBe(SEGMENT_GAP_FAINT_FACTOR);
  });

  test("brightness dims with age but never below the floor", () => {
    expect(constellationBrightness(1_000)).toBe(1);
    expect(constellationBrightness(3 * 3_600_000)).toBeGreaterThanOrEqual(0.3);
    expect(constellationBrightness(3 * 3_600_000)).toBeLessThan(0.6);
  });

  test("dust is chronological west→east below the band, confined to the disc", () => {
    const start = 0;
    const now = 1_000_000;
    const early = dustPosition("d1", 100_000, start, now, CENTER);
    const late = dustPosition("d1", 900_000, start, now, CENTER);
    const azOf = (p: { x: number; z: number }) => Math.atan2(p.x, p.z);
    // Eastward = increasing azimuth: the late mote sits counterclockwise of
    // the early one (compare on the circle — atan2 wraps at ±π).
    const delta = (azOf(late) - azOf(early) + Math.PI * 2) % (Math.PI * 2);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(Math.PI);
    expect(early.y).toBeCloseTo(SKY_ALT - 0.8, 5);
    // Determinism + fan confinement.
    expect(dustPosition("d1", 100_000, start, now, CENTER)).toEqual(early);
  });
});

describe("caps + resolution", () => {
  function cloud(id: string, firstAtMs: number, freshAtMs: number): ResolvedCloud {
    return {
      id,
      label: id,
      labelSource: "topic",
      firstAtMs,
      freshAtMs,
      turnCount: 3,
      liveTopicId: null,
      dominantSpeaker: null,
      freshestTurnId: null,
    };
  }

  test("resolveConstellations keeps the freshest 12, presented oldest-first", () => {
    const clouds = Array.from({ length: 16 }, (_, index) => cloud(`topic-${index}`, index * 1_000, index * 1_000 + 500));
    const resolved = resolveConstellations([], { clouds }, []);
    expect(resolved).toHaveLength(MAX_SKY_CONSTELLATIONS);
    // The four stalest dropped; the rest in founding order.
    expect(resolved[0]!.id).toBe("topic-4");
    expect(resolved[11]!.id).toBe("topic-15");
    for (let index = 1; index < resolved.length; index += 1) {
      expect(resolved[index]!.firstAtMs).toBeGreaterThan(resolved[index - 1]!.firstAtMs);
    }
  });

  test("constellationStars joins live window members with retired gists, capped with elision", () => {
    const retired = Array.from({ length: 12 }, (_, index) => ({
      id: `old-${index}`,
      atMs: index * 1_000,
      speaker: "s1",
      gist: `old gist ${index}`,
    }));
    const dialogue = Array.from({ length: 16 }, (_, index) => ({
      id: `live-${index}`,
      speaker: "s2",
      atMs: 100_000 + index * 1_000,
      topicId: "t-live",
      text: `live turn ${index}`,
    }));
    const { stars, elided } = constellationStars(
      { id: "c1", liveTopicId: "t-live", stars: retired, elidedCount: 3 },
      [{ id: "t-live", label: "x", turnIds: dialogue.map((turn) => turn.id), freshAtMs: 200_000 }],
      dialogue,
    );
    expect(stars).toHaveLength(MAX_STARS_PER_CONST);
    // 12 + 16 = 28 → 4 oldest elided on top of the server's 3.
    expect(elided).toBe(7);
    // Chronological, retired first (older), live turns carry live=true.
    expect(stars[0]!.id).toBe("old-4");
    expect(stars.at(-1)!.id).toBe("live-15");
    expect(stars.at(-1)!.live).toBe(true);
    expect(stars[0]!.live).toBe(false);
    expect(MAX_DUST).toBe(48);
  });

  test("exactly one NOW: the freshest live star of the freshest ACTIVE constellation", () => {
    const starsById = new Map<string, ConstellationStar[]>([
      ["c1", [{ id: "s1", atMs: 990_000, speaker: null, text: "", live: true }]],
      [
        "c2",
        [
          { id: "s2", atMs: 995_000, speaker: null, text: "", live: true },
          { id: "s3", atMs: 999_000, speaker: null, text: "", live: false }, // retired never NOW
        ],
      ],
    ]);
    const nowMs = 1_000_000;
    const picked = nowStarId(
      [
        { id: "c1", freshAtMs: 990_000 },
        { id: "c2", freshAtMs: 999_000 },
      ],
      starsById,
      nowMs,
    );
    expect(picked).toEqual({ constellationId: "c2", starId: "s2" });
    // Nothing active → no NOW at all (honesty over decoration).
    expect(
      nowStarId([{ id: "c1", freshAtMs: 100_000 }], starsById, nowMs),
    ).toBeNull();
  });
});
