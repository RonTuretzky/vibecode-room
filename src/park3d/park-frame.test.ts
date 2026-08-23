import { describe, expect, test } from "bun:test";
import manifest from "../../public/assets/park/manifest.json";
import {
  AXIS,
  MARGIN,
  PARK_CENTER,
  PARK_HALF_LEN,
  PARK_HALF_WIDTH,
  PERP,
  PRESETS,
  SEGMENT,
  SHEEP_MEADOW,
  SHEEP_MEADOW_GROUND_M,
  alongAcross,
  cropPlanes,
  cropSlab,
  insidePark,
  localFromAlongAcross,
  localFromLatLon,
  nextCrop,
  presetEye,
  presetTarget,
} from "./park-frame";

describe("park frame", () => {
  test("the park centre is the local origin and the axes are orthonormal", () => {
    const c = localFromLatLon(PARK_CENTER.lat, PARK_CENTER.lon);
    expect(c.x).toBeCloseTo(0);
    expect(c.z).toBeCloseTo(0);
    expect(AXIS.length()).toBeCloseTo(1);
    expect(PERP.length()).toBeCloseTo(1);
    expect(AXIS.dot(PERP)).toBeCloseTo(0);
    // The long axis points NORTH-ish (−Z) and a little east; across points
    // east-ish (toward 5th Ave).
    expect(AXIS.z).toBeLessThan(0);
    expect(AXIS.x).toBeGreaterThan(0);
    expect(PERP.x).toBeGreaterThan(0);
  });

  test("along/across ↔ local round-trips", () => {
    for (const [along, across] of [
      [0, 0],
      [1500, -300],
      [-2400, 410],
    ]) {
      const p = localFromAlongAcross(along, across);
      const back = alongAcross(p.x, p.z);
      expect(back.along).toBeCloseTo(along, 6);
      expect(back.across).toBeCloseTo(across, 6);
    }
  });

  test("the original segment slab sits on the park's centre line, inside the park crop", () => {
    const c = localFromLatLon(SEGMENT.lat, SEGMENT.lon);
    const { along, across } = alongAcross(c.x, c.z);
    // 100th St: ten blocks south of 110th.
    expect(along).toBeGreaterThan(1100);
    expect(along).toBeLessThan(1300);
    expect(Math.abs(across)).toBeLessThan(60);
    const seg = cropSlab("segment")!;
    const park = cropSlab("park")!;
    expect(seg.alongMin).toBeGreaterThan(park.alongMin);
    expect(seg.alongMax).toBeLessThan(park.alongMax);
    expect(seg.acrossMin).toBeGreaterThan(park.acrossMin);
    expect(seg.acrossMax).toBeLessThan(park.acrossMax);
    expect(cropSlab("city")).toBeNull();
  });

  test("crop planes keep the inside of the slab and cut outside it", () => {
    expect(cropPlanes("city")).toHaveLength(0);
    const park = cropPlanes("park");
    expect(park).toHaveLength(4);
    const inside = (planes: typeof park, x: number, z: number) =>
      planes.every((plane) => plane.distanceToPoint({ x, y: 0, z } as never) >= 0);
    // Origin, the Met (east edge), Columbus Circle's corner: in.
    expect(inside(park, 0, 0)).toBe(true);
    const north = localFromAlongAcross(PARK_HALF_LEN + MARGIN.north - 1, 0);
    expect(inside(park, north.x, north.z)).toBe(true);
    // Past the margin: out.
    const farNorth = localFromAlongAcross(PARK_HALF_LEN + MARGIN.north + 5, 0);
    expect(inside(park, farNorth.x, farNorth.z)).toBe(false);
    const east = localFromAlongAcross(0, PARK_HALF_WIDTH + MARGIN.across + 5);
    expect(inside(park, east.x, east.z)).toBe(false);
    // The segment crop excludes the park centre (it starts at 90th St).
    expect(inside(cropPlanes("segment"), 0, 0)).toBe(false);
  });

  test("C cycles park → segment → city → park", () => {
    expect(nextCrop("park")).toBe("segment");
    expect(nextCrop("segment")).toBe("city");
    expect(nextCrop("city")).toBe("park");
  });

  test("presets 1–6 are the untouched segment ladder; 7–9 frame the whole park", () => {
    expect(PRESETS).toHaveLength(9);
    const c = localFromLatLon(SEGMENT.lat, SEGMENT.lon);
    const seg = alongAcross(c.x, c.z);
    const alts = [2500, 1200, 600, 250, 100, 40];
    PRESETS.slice(0, 6).forEach((preset, i) => {
      expect(preset.eye.alt).toBe(alts[i]);
      expect(preset.crop).toBe("segment");
      // Eye south of the segment centre, looking north at it.
      expect(preset.eye.along).toBeLessThan(seg.along);
      expect(preset.target.along).toBeCloseTo(seg.along, 6);
      expect(preset.target.across).toBeCloseTo(seg.across, 6);
    });
    const postcard = PRESETS[6];
    expect(postcard.crop).toBe("park");
    expect(postcard.eye.along).toBeLessThan(-PARK_HALF_LEN); // above Midtown
    expect(postcard.target.along).toBeGreaterThan(postcard.eye.along); // looking north
    const satellite = PRESETS[7];
    expect(satellite.eye.alt).toBeGreaterThan(4000);
    const meadow = PRESETS[8];
    expect(meadow.eye.alt).toBeLessThan(3);
    expect(meadow.target.along).toBeLessThan(meadow.eye.along); // looking south
    for (const preset of PRESETS.filter((p) => p.groundRelative !== true)) {
      const eye = presetEye(preset);
      const target = presetTarget(preset);
      expect(Number.isFinite(eye.x + eye.y + eye.z)).toBe(true);
      expect(eye.y).toBe(preset.eye.alt);
      expect(target.y).toBe(preset.target.alt);
    }
  });

  test("the TS frame agrees with the bake's manifest (centre, axis, extents, Sheep Meadow)", () => {
    expect(manifest.center.lat).toBe(PARK_CENTER.lat);
    expect(manifest.center.lon).toBe(PARK_CENTER.lon);
    expect(manifest.axisBearingDeg).toBe(29);
    expect(manifest.park.halfLen).toBe(PARK_HALF_LEN);
    expect(manifest.park.halfWidth).toBe(PARK_HALF_WIDTH);
    expect(manifest.segment.lat).toBe(SEGMENT.lat);
    expect(manifest.segment.lon).toBe(SEGMENT.lon);
    // The bake maps lat/lon through mercator·cos(lat₀); the TS approximation
    // must land the anchor on the same baked pixel (< 0.5 m).
    const anchor = manifest.anchors.sheepMeadow;
    expect(Math.abs(SHEEP_MEADOW.x - anchor.x)).toBeLessThan(0.5);
    expect(Math.abs(SHEEP_MEADOW.z - anchor.z)).toBeLessThan(0.5);
    expect(SHEEP_MEADOW_GROUND_M).toBe(anchor.groundM);
  });

  test("the meadow preset stands at eye height on the lawn, not at the frame's y = 0", () => {
    const meadow = PRESETS[8];
    expect(meadow.groundRelative).toBe(true);
    // Default ground: the baked anchor height (the lawn is below the centre).
    expect(presetEye(meadow).y).toBeCloseTo(SHEEP_MEADOW_GROUND_M + 1.7);
    expect(presetTarget(meadow).y).toBeCloseTo(SHEEP_MEADOW_GROUND_M + 80);
    // A DEM sampler overrides it; absolute presets ignore it entirely.
    expect(presetEye(meadow, () => -20).y).toBeCloseTo(-18.3);
    expect(presetEye(PRESETS[6], () => -20).y).toBe(PRESETS[6].eye.alt);
  });

  test("Sheep Meadow is inside the park, west of the centre line, south of 70th", () => {
    expect(insidePark(SHEEP_MEADOW.x, SHEEP_MEADOW.z)).toBe(true);
    const { along, across } = alongAcross(SHEEP_MEADOW.x, SHEEP_MEADOW.z);
    expect(across).toBeLessThan(0);
    expect(along).toBeLessThan(-1100);
    expect(along).toBeGreaterThan(-1700);
  });
});
