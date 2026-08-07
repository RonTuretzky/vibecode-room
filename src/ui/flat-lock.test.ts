import { describe, expect, test } from "bun:test";
import {
  FLAT_EYE_DISTANCE,
  FLAT_EYE_HEIGHT,
  FLAT_SPAN,
  FLAT_TOTAL_HORIZONTAL_FOV_DEG,
  FLAT_YAW,
  flatEye,
  flatVerticalFovDeg,
  flatViewDir,
  flatViewOffset,
  flatWallIndex,
} from "./flat-lock";

describe("flat-locked window pair", () => {
  test("wall A is the left column; null/empty/unparseable walls fall back to it", () => {
    expect(flatWallIndex("A")).toBe(0);
    expect(flatWallIndex("a")).toBe(0);
    expect(flatWallIndex(null)).toBe(0);
    expect(flatWallIndex(undefined)).toBe(0);
    expect(flatWallIndex("")).toBe(0);
    expect(flatWallIndex("  ")).toBe(0);
    expect(flatWallIndex("2")).toBe(0); // below "A" → clamp to the base
  });

  test("wall B is the right column, and further letters fold back into the pair", () => {
    expect(flatWallIndex("B")).toBe(1);
    expect(flatWallIndex(" b ")).toBe(1);
    expect(flatWallIndex("C")).toBe(0); // folds modulo the span
    expect(flatWallIndex("D")).toBe(1);
  });

  test("SEAM COHERENCE: A's slice ends exactly where B's slice begins, tiling the full image", () => {
    const w = 1920;
    const h = 1080;
    const a = flatViewOffset("A", w, h);
    const b = flatViewOffset("B", w, h);
    // Same full frustum on both windows — that is what makes the pair rigid.
    expect(a.fullWidth).toBe(b.fullWidth);
    expect(a.fullHeight).toBe(b.fullHeight);
    // A's right edge IS B's left edge, and together they tile the whole image
    // with no gap and no overlap.
    expect(a.offsetX + a.width).toBe(b.offsetX);
    expect(b.offsetX + b.width).toBe(a.fullWidth);
    expect(a.fullWidth).toBe(FLAT_SPAN * w);
    // No vertical split: both slices span the full height.
    expect(a.offsetY).toBe(0);
    expect(b.offsetY).toBe(0);
    expect(a.height).toBe(h);
    expect(b.height).toBe(h);
  });

  test("both windows share ONE eye and ONE horizontal view direction (no per-wall yaw step)", () => {
    // flatEye/flatViewDir take no wall argument — the sharing is structural.
    // Pin the convention instead: yaw 0 looks down -Z from +Z, horizontal.
    const eye = flatEye();
    const dir = flatViewDir();
    expect(eye.y).toBe(FLAT_EYE_HEIGHT);
    expect(Math.hypot(eye.x, eye.z)).toBeCloseTo(FLAT_EYE_DISTANCE, 12);
    // Eye sits back along the view direction: eye → origin IS the view dir.
    const toOrigin = Math.hypot(eye.x, eye.z);
    expect(-eye.x / toOrigin).toBeCloseTo(dir.x, 12);
    expect(-eye.z / toOrigin).toBeCloseTo(dir.z, 12);
    expect(FLAT_YAW).toBe(0);
  });

  test("the seam bisects the content: the scene origin projects onto the full image's centre line", () => {
    // With the eye behind the origin along the view direction, the origin
    // sits on the shared frustum's optical axis — x = fullWidth/2, exactly
    // the A/B seam of the tiled pair.
    const eye = flatEye();
    const dir = flatViewDir();
    const cross = eye.x * dir.z - eye.z * dir.x; // 2D cross: 0 ⇔ origin on the axis
    expect(cross).toBeCloseTo(0, 12);
  });
});

describe("flat-locked fov (three.js fov is VERTICAL; the pair pins the TOTAL horizontal)", () => {
  // Recover the horizontal fov (deg) from a vertical fov (deg) at an aspect.
  const horizontalOf = (verticalDeg: number, aspect: number): number =>
    (Math.atan(Math.tan((verticalDeg * Math.PI) / 360) * aspect) * 360) / Math.PI;

  test("the computed vertical fov yields EXACTLY the total horizontal fov at every full aspect", () => {
    for (const windowAspect of [16 / 9, 16 / 10, 4 / 3, 1, 2.35, 0.75]) {
      const fullAspect = FLAT_SPAN * windowAspect;
      expect(horizontalOf(flatVerticalFovDeg(fullAspect), fullAspect)).toBeCloseTo(
        FLAT_TOTAL_HORIZONTAL_FOV_DEG,
        10,
      );
    }
  });

  test("degenerate aspects (unlaid-out window) fall back to the two-16:9-window strip", () => {
    const fallback = flatVerticalFovDeg((FLAT_SPAN * 16) / 9);
    expect(flatVerticalFovDeg(0)).toBe(fallback);
    expect(flatVerticalFovDeg(-2)).toBe(fallback);
    expect(flatVerticalFovDeg(Number.NaN)).toBe(fallback);
  });
});
