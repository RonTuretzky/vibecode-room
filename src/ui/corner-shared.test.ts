import { describe, expect, test } from "bun:test";
import { CORNER_EYE_DISTANCE, CORNER_EYE_HEIGHT } from "./corner-lock";
import {
  CORNER_OFFSETS_ZERO,
  clampCornerOffsets,
  isCornerDriver,
  readCornerOffsets,
} from "./corner-shared";

describe("clampCornerOffsets", () => {
  test("identity passes through", () => {
    expect(clampCornerOffsets({ yaw: 0, height: 0, dist: 1 })).toEqual({ yaw: 0, height: 0, dist: 1 });
  });

  test("yaw is unclamped (the panorama may spin freely)", () => {
    expect(clampCornerOffsets({ yaw: 12.5, height: 0, dist: 1 }).yaw).toBe(12.5);
    expect(clampCornerOffsets({ yaw: -100, height: 0, dist: 1 }).yaw).toBe(-100);
  });

  test("height offset keeps the absolute eye inside the free rig's [1.4, 30]", () => {
    const low = clampCornerOffsets({ yaw: 0, height: -999, dist: 1 });
    const high = clampCornerOffsets({ yaw: 0, height: 999, dist: 1 });
    expect(CORNER_EYE_HEIGHT + low.height).toBeCloseTo(1.4, 5);
    expect(CORNER_EYE_HEIGHT + high.height).toBeCloseTo(30, 5);
  });

  test("dist scale keeps the absolute eye distance inside the wheel envelope [4, 45]", () => {
    const near = clampCornerOffsets({ yaw: 0, height: 0, dist: 0.0001 });
    const far = clampCornerOffsets({ yaw: 0, height: 0, dist: 1000 });
    expect(CORNER_EYE_DISTANCE * near.dist).toBeCloseTo(4, 5);
    expect(CORNER_EYE_DISTANCE * far.dist).toBeCloseTo(45, 5);
  });

  test("non-finite / missing / negative fields reset to the identity offset", () => {
    expect(clampCornerOffsets({ yaw: Number.NaN, height: Number.POSITIVE_INFINITY, dist: -2 })).toEqual(
      CORNER_OFFSETS_ZERO,
    );
    expect(clampCornerOffsets(null)).toEqual(CORNER_OFFSETS_ZERO);
    expect(clampCornerOffsets({})).toEqual(CORNER_OFFSETS_ZERO);
  });
});

describe("isCornerDriver", () => {
  test("wall index 0 drives; every other window mirrors", () => {
    expect(isCornerDriver("A")).toBe(true);
    expect(isCornerDriver(null)).toBe(true); // no wall parses to index 0
    expect(isCornerDriver("B")).toBe(false);
    expect(isCornerDriver("C")).toBe(false);
  });
});

describe("readCornerOffsets", () => {
  test("SSR / no-window returns the identity offset (never throws)", () => {
    // bun:test has no DOM window; the guard must hand back zeros.
    expect(readCornerOffsets()).toEqual(CORNER_OFFSETS_ZERO);
  });
});
