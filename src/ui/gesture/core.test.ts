import { describe, expect, test } from "bun:test";
import { DwellSelector, LowPassFilter, OneEuroFilter, Point2DFilter, Zone, buildGrid, idToHue } from "./core";

describe("LowPassFilter", () => {
  test("lazy-inits to first value then EMA; rejects bad alpha", () => {
    const f = new LowPassFilter(0.5);
    expect(f.last()).toBeNull();
    expect(f.call(10)).toBe(10);
    expect(f.call(20)).toBe(15); // 0.5*20 + 0.5*10
    expect(() => new LowPassFilter(0)).toThrow();
    expect(() => new LowPassFilter(1.5)).toThrow();
  });
});

describe("OneEuroFilter / Point2DFilter", () => {
  test("deterministic + first sample passes through", () => {
    const a = new OneEuroFilter(60, 1.0, 0.007);
    const b = new OneEuroFilter(60, 1.0, 0.007);
    // First sample passes through; two filters with identical inputs agree.
    expect(a.call(0.5, 0)).toBe(0.5);
    expect(b.call(0.5, 0)).toBe(0.5);
    expect(a.call(0.6, 1 / 60)).toBe(b.call(0.6, 1 / 60));
    const p = new Point2DFilter();
    expect(p.call(0.2, 0.8, 0)).toEqual([0.2, 0.8]);
  });
});

describe("Zone.contains margins", () => {
  test("positive margin shrinks, negative grows (fractional of w/h)", () => {
    const z = new Zone("z", "", 0.2, 0.2, 0.4, 0.4); // covers [0.2,0.6]^2
    expect(z.contains(0.4, 0.4)).toBe(true); // center
    expect(z.contains(0.61, 0.4)).toBe(false); // just outside
    // margin 0.1 -> inset 0.04 each side -> core [0.24,0.56]
    expect(z.contains(0.25, 0.4, 0.1)).toBe(true);
    expect(z.contains(0.23, 0.4, 0.1)).toBe(false);
    // negative margin -> expand by 0.04 -> [0.16,0.64]
    expect(z.contains(0.63, 0.4, -0.1)).toBe(true);
  });
});

describe("buildGrid", () => {
  test("2x3 row-major ids/rects with padding gutters", () => {
    const zones = buildGrid(2, 3, 0.06);
    expect(zones).toHaveLength(6);
    expect(zones[0].id).toBe("r0c0");
    expect(zones[5].id).toBe("r1c2");
    // cell 0: cellW=1/3, padding gutter = 0.06/3
    expect(zones[0].x).toBeCloseTo(0.06 / 3, 5);
    expect(zones[0].w).toBeCloseTo((1 / 3) * (1 - 0.12), 5);
  });
});

describe("DwellSelector", () => {
  const zones = () => [new Zone("a", "", 0, 0, 0.5, 1), new Zone("b", "", 0.5, 0, 0.5, 1)];

  test("fires after dwellSeconds, toggling selected, then cools down", () => {
    const zs = zones();
    const d = new DwellSelector(0.8, 0.4, 0.15);
    const pt: [number, number] = [0.25, 0.5]; // in zone a's core
    expect(d.update(zs, pt, 0.0)).toBeNull(); // enter
    expect(d.update(zs, pt, 0.4)).toBeNull(); // mid-dwell
    expect(d.progress).toBeCloseTo(0.5, 2);
    const ev = d.update(zs, pt, 0.8); // fire
    expect(ev).toEqual({ zoneId: "a", selected: true });
    expect(d.progress).toBe(0); // reset after fire
    // cooldown until 0.8+0.4=1.2 — nothing tracks
    expect(d.update(zs, pt, 1.0)).toBeNull();
    expect(d.activeZone).toBeNull();
    // after cooldown, dwelling again toggles selected back off
    expect(d.update(zs, pt, 1.3)).toBeNull(); // re-enter
    const ev2 = d.update(zs, pt, 2.1);
    expect(ev2?.selected).toBe(false);
  });

  test("moving to a new zone restarts the dwell timer", () => {
    const zs = zones();
    const d = new DwellSelector(0.8, 0.4, 0.15);
    d.update(zs, [0.25, 0.5], 0.0); // enter a
    d.update(zs, [0.25, 0.5], 0.5); // mid
    d.update(zs, [0.75, 0.5], 0.6); // jump to b -> restart, no fire
    expect(d.activeZone?.id).toBe("b");
    expect(d.progress).toBe(0);
    // entered b at t=0.6; fires once elapsed >= 0.8s (use 1.5 to clear float boundary)
    expect(d.update(zs, [0.75, 0.5], 1.5)).toEqual({ zoneId: "b", selected: true });
  });

  test("disengaged or no cursor resets (ring clears)", () => {
    const zs = zones();
    const d = new DwellSelector();
    d.update(zs, [0.25, 0.5], 0.0);
    expect(d.update(zs, [0.25, 0.5], 0.3, false)).toBeNull(); // disengaged
    expect(d.activeZone).toBeNull();
    d.update(zs, [0.25, 0.5], 0.4);
    expect(d.update(zs, null, 0.5)).toBeNull(); // no hand
    expect(d.activeZone).toBeNull();
  });

  test("refireOnlyAfterLeave: one click per approach — holding still does NOT re-fire", () => {
    const zs = zones();
    const d = new DwellSelector(0.8, 0.4, 0.15, true);
    const pt: [number, number] = [0.25, 0.5];
    // First dwell fires once.
    d.update(zs, pt, 0.0);
    expect(d.update(zs, pt, 0.85)).toEqual({ zoneId: "a", selected: true });
    // Keep parked WELL past cooldown + another dwell window — must NOT re-fire.
    expect(d.update(zs, pt, 1.5)).toBeNull();
    expect(d.update(zs, pt, 2.5)).toBeNull();
    expect(d.update(zs, pt, 3.5)).toBeNull();
    // Leave the zone, then return — re-armed, fires again.
    d.update(zs, [0.75, 0.5], 3.6); // move to zone b (leaves a)
    d.update(zs, pt, 4.0); // re-enter a
    expect(d.update(zs, pt, 4.85)).toEqual({ zoneId: "a", selected: false });
  });

  test("refireOnlyAfterLeave re-arms when the hand disengages (pull away)", () => {
    const zs = zones();
    const d = new DwellSelector(0.8, 0.4, 0.15, true);
    const pt: [number, number] = [0.25, 0.5];
    d.update(zs, pt, 0.0);
    expect(d.update(zs, pt, 0.85)?.zoneId).toBe("a"); // fired (cooldown until 1.25)
    d.update(zs, pt, 1.0, false); // disengage (hand away) -> re-arm (clear consumed)
    d.update(zs, pt, 1.3); // re-enter AFTER cooldown -> dwell restarts
    expect(d.update(zs, pt, 2.2)).toEqual({ zoneId: "a", selected: false }); // fires again
  });

  test("sticky hysteresis keeps dwell alive when cursor drifts just outside", () => {
    const zs = [new Zone("a", "", 0.2, 0.2, 0.4, 0.4)];
    const d = new DwellSelector(0.8, 0.4, 0.15);
    d.update(zs, [0.4, 0.4], 0.0); // enter core
    // drift to 0.61 (just outside true edge 0.6) — sticky (-0.15 margin expands ~0.06)
    const ev = d.update(zs, [0.61, 0.4], 0.85);
    expect(ev).toEqual({ zoneId: "a", selected: true }); // still counted, fired
  });
});

describe("idToHue", () => {
  test("stable, spread, fixed mouse hue", () => {
    expect(idToHue(-1)).toBe(200);
    for (let i = 0; i < 30; i += 1) {
      const h = idToHue(i);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      expect(idToHue(i)).toBe(h);
    }
  });
});
