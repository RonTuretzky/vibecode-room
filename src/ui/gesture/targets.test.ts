import { describe, expect, test } from "bun:test";
import { GestureTargets, HITBOX_INFLATE_PX, inflateRect, type TargetDescriptor } from "./targets";

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

// HITBOX INFLATION (pure math): the gesture layer grows every DOM control's
// dwell hitbox by HITBOX_INFLATE_PX per side, clamped to the viewport, so the
// dwellable area exceeds the visual button without ever extending offscreen.
describe("inflateRect", () => {
  test("grows an interior rect by pad on every side", () => {
    const r = inflateRect({ left: 100, top: 200, width: 50, height: 40 }, 24, 1920, 1080);
    expect(r).toEqual({ left: 76, top: 176, width: 98, height: 88 });
  });

  test("clamps to the viewport on every edge (corner-hugging control)", () => {
    const r = inflateRect({ left: 10, top: 5, width: 100, height: 30 }, 24, 1920, 1080);
    expect(r.left).toBe(0); // 10 - 24 clamps to the left edge
    expect(r.top).toBe(0); // 5 - 24 clamps to the top edge
    expect(r.width).toBe(10 + 100 + 24); // left clamp eats the overhang
    expect(r.height).toBe(5 + 30 + 24);

    const br = inflateRect({ left: 1900, top: 1070, width: 30, height: 30 }, 24, 1920, 1080);
    expect(br.left + br.width).toBe(1920); // never past the right edge
    expect(br.top + br.height).toBe(1080); // never past the bottom edge
  });

  test("a degenerate viewport yields a zero-area rect, never negative", () => {
    const r = inflateRect({ left: 50, top: 50, width: 10, height: 10 }, 24, 0, 0);
    expect(r.width).toBe(0);
    expect(r.height).toBe(0);
  });

  test("pad 0 is the identity (scene rects stay exact when uninflated)", () => {
    const rect = { left: 5, top: 6, width: 7, height: 8 };
    expect(inflateRect(rect, 0, 1920, 1080)).toEqual(rect);
  });

  test("the shipped constant gives ~24px of slack per side", () => {
    expect(HITBOX_INFLATE_PX).toBe(24);
  });
});
