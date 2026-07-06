import { describe, expect, test } from "bun:test";
import { GestureTargets, type TargetDescriptor } from "./targets";

function desc(id: string, left: number, top: number, width: number, height: number, activate = () => {}): TargetDescriptor {
  return { id, left, top, width, height, activate };
}

describe("GestureTargets", () => {
  test("normalizes viewport-px rects to [0,1] zones", () => {
    const t = new GestureTargets();
    const zones = t.sync([desc("idea", 200, 100, 400, 300)], 1000, 500);
    expect(zones).toHaveLength(1);
    expect(zones[0].id).toBe("idea");
    expect(zones[0].x).toBe(0.2);
    expect(zones[0].y).toBe(0.2);
    expect(zones[0].w).toBe(0.4);
    expect(zones[0].h).toBe(0.6);
  });

  test("keeps the SAME Zone instance across syncs (dwell identity) and updates its rect", () => {
    const t = new GestureTargets();
    const z1 = t.sync([desc("idea", 0, 0, 100, 100)], 1000, 1000)[0];
    const z2 = t.sync([desc("idea", 50, 50, 100, 100)], 1000, 1000)[0];
    expect(z2).toBe(z1); // identity preserved — dwell keeps accumulating
    expect(z2.x).toBe(0.05); // rect updated in place
  });

  test("adds new targets and drops gone ones", () => {
    const t = new GestureTargets();
    t.sync([desc("a", 0, 0, 100, 100), desc("b", 100, 0, 100, 100)], 1000, 1000);
    expect(t.has("a")).toBe(true);
    expect(t.has("b")).toBe(true);
    t.sync([desc("a", 0, 0, 100, 100)], 1000, 1000); // b disappeared
    expect(t.has("a")).toBe(true);
    expect(t.has("b")).toBe(false);
  });

  test("skips zero-size targets and a zero viewport", () => {
    const t = new GestureTargets();
    expect(t.sync([desc("a", 0, 0, 0, 100)], 1000, 1000)).toHaveLength(0);
    expect(t.sync([desc("a", 0, 0, 100, 100)], 0, 1000)).toHaveLength(0);
  });

  test("activate() invokes the target's action; unknown id is a no-op false", () => {
    const t = new GestureTargets();
    let clicks = 0;
    t.sync([desc("build", 0, 0, 100, 100, () => (clicks += 1))], 1000, 1000);
    expect(t.activate("build")).toBe(true);
    expect(clicks).toBe(1);
    expect(t.activate("nope")).toBe(false);
  });

  test("activate uses the LATEST closure after a re-sync", () => {
    const t = new GestureTargets();
    let which = "";
    t.sync([desc("x", 0, 0, 10, 10, () => (which = "first"))], 100, 100);
    t.sync([desc("x", 0, 0, 10, 10, () => (which = "second"))], 100, 100);
    t.activate("x");
    expect(which).toBe("second"); // re-sync rebinds activation to the live element
  });
});
