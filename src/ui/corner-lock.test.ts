import { describe, expect, test } from "bun:test";
import {
  CORNER_BASE_YAW,
  CORNER_EYE_DISTANCE,
  CORNER_EYE_HEIGHT,
  CORNER_HORIZONTAL_FOV_DEG,
  CORNER_WALL_YAW_STEP,
  cornerEye,
  cornerVerticalFovDeg,
  cornerViewDir,
  cornerWallIndex,
  cornerYaw,
} from "./corner-lock";

// Half of one window's horizontal field of view, in radians (45°): the offset
// from a window's central yaw to its screen-left (+) / screen-right (−) edge.
const HALF_WINDOW = (CORNER_HORIZONTAL_FOV_DEG * Math.PI) / 360;

describe("corner-locked yaw pair", () => {
  test("wall A carries the shared base yaw; null/empty/unparseable walls fall back to it", () => {
    expect(cornerYaw("A")).toBe(CORNER_BASE_YAW);
    expect(cornerYaw("a")).toBe(CORNER_BASE_YAW);
    expect(cornerYaw(null)).toBe(CORNER_BASE_YAW);
    expect(cornerYaw(undefined)).toBe(CORNER_BASE_YAW);
    expect(cornerYaw("")).toBe(CORNER_BASE_YAW);
    expect(cornerYaw("  ")).toBe(CORNER_BASE_YAW);
    expect(cornerYaw("2")).toBe(CORNER_BASE_YAW); // below "A" → clamp to the base
  });

  test("the pair is EXACTLY 90° apart, wall B a quarter turn clockwise (from above) of wall A", () => {
    expect(cornerYaw("B")).toBeCloseTo(cornerYaw("A") + CORNER_WALL_YAW_STEP, 12);
    expect(Math.abs(cornerYaw("A") - cornerYaw("B"))).toBeCloseTo(Math.PI / 2, 12);
    // Lowercase / padded wall ids resolve to the same locked yaw.
    expect(cornerYaw(" b ")).toBe(cornerYaw("B"));
  });

  test("SEAM COHERENCE: wall A's right-edge view direction IS wall B's left-edge view direction", () => {
    const rightEdgeOfA = cornerViewDir(cornerYaw("A") - HALF_WINDOW);
    const leftEdgeOfB = cornerViewDir(cornerYaw("B") + HALF_WINDOW);
    expect(rightEdgeOfA.x).toBeCloseTo(leftEdgeOfB.x, 12);
    expect(rightEdgeOfA.z).toBeCloseTo(leftEdgeOfB.z, 12);
  });

  test("the scene centre lands exactly ON the A/B seam (the corner bisects the content)", () => {
    const eye = cornerEye();
    expect(eye.y).toBe(CORNER_EYE_HEIGHT);
    const toOrigin = Math.hypot(eye.x, eye.z);
    expect(toOrigin).toBeCloseTo(CORNER_EYE_DISTANCE, 12);
    const seamDir = cornerViewDir(cornerYaw("A") - HALF_WINDOW);
    expect(-eye.x / toOrigin).toBeCloseTo(seamDir.x, 12);
    expect(-eye.z / toOrigin).toBeCloseTo(seamDir.z, 12);
  });

  test("four wall letters tile the full 360° turn and then wrap", () => {
    expect(cornerWallIndex("A")).toBe(0);
    expect(cornerWallIndex("B")).toBe(1);
    expect(cornerWallIndex("C")).toBe(2);
    expect(cornerWallIndex("D")).toBe(3);
    expect(cornerWallIndex("E")).toBe(0); // wraps: 4 × 90° windows = the full turn
    // Adjacent letters always share one frustum edge (seam per neighbour).
    for (const [left, right] of [["A", "B"], ["B", "C"], ["C", "D"]] as const) {
      const rightEdge = cornerViewDir(cornerYaw(left) - HALF_WINDOW);
      const leftEdge = cornerViewDir(cornerYaw(right) + HALF_WINDOW);
      expect(rightEdge.x).toBeCloseTo(leftEdge.x, 12);
      expect(rightEdge.z).toBeCloseTo(leftEdge.z, 12);
    }
  });
});

describe("corner-locked fov (three.js fov is VERTICAL; the corner needs 90° HORIZONTAL)", () => {
  // Recover the horizontal fov (deg) from a vertical fov (deg) at an aspect.
  const horizontalOf = (verticalDeg: number, aspect: number): number =>
    (Math.atan(Math.tan((verticalDeg * Math.PI) / 360) * aspect) * 360) / Math.PI;

  test("the computed vertical fov yields EXACTLY 90° horizontal at every aspect", () => {
    for (const aspect of [16 / 9, 16 / 10, 4 / 3, 1, 2.35, 0.75]) {
      expect(horizontalOf(cornerVerticalFovDeg(aspect), aspect)).toBeCloseTo(90, 10);
    }
  });

  test("a square window needs exactly 90° vertical; wider windows need less", () => {
    expect(cornerVerticalFovDeg(1)).toBeCloseTo(90, 10);
    expect(cornerVerticalFovDeg(16 / 9)).toBeCloseTo(58.7155, 3);
    expect(cornerVerticalFovDeg(16 / 9)).toBeLessThan(90);
  });

  test("degenerate aspects (unlaid-out window) fall back to a sane 16:9 fov", () => {
    const fallback = cornerVerticalFovDeg(16 / 9);
    expect(cornerVerticalFovDeg(0)).toBe(fallback);
    expect(cornerVerticalFovDeg(-2)).toBe(fallback);
    expect(cornerVerticalFovDeg(Number.NaN)).toBe(fallback);
  });
});
