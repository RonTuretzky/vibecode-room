import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { buildBuildings, buildWater, buildPaths, terrainSurfaceSampler, clipWaterTriangle } from "./park-world";

// Geometric normal of an indexed triangle vs. the stored vertex normal: the
// extrusion must be front-facing from outside (walls) and above (roofs) for
// EITHER ring winding, since NYC footprints come in both.
function checkWinding(mesh: THREE.Mesh): { walls: number; roofs: number } {
  const geometry = mesh.geometry;
  const pos = geometry.getAttribute("position");
  const nrm = geometry.getAttribute("normal");
  const index = geometry.getIndex()!;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const stored = new THREE.Vector3();
  let walls = 0;
  let roofs = 0;
  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i);
    const ib = index.getX(i + 1);
    const ic = index.getX(i + 2);
    a.fromBufferAttribute(pos, ia);
    b.fromBufferAttribute(pos, ib);
    c.fromBufferAttribute(pos, ic);
    n.subVectors(b, a).cross(c.clone().sub(a));
    if (n.lengthSq() === 0) {
      continue; // padding triangle
    }
    n.normalize();
    stored.fromBufferAttribute(nrm, ia);
    expect(n.dot(stored)).toBeGreaterThan(0.999);
    if (stored.y > 0.5) {
      roofs++;
    } else {
      walls++;
    }
  }
  return { walls, roofs };
}

describe("park buildings extrusion", () => {
  const groundAt = () => 10;
  // 20 m × 10 m lot in decimetres, clockwise seen from above (+x east, +z south).
  const cw = [0, 0, 200, 0, 200, 100, 0, 100];
  const ccw = [0, 0, 0, 100, 200, 100, 200, 0];

  test("walls face outward and roofs face up for both ring windings", () => {
    for (const ring of [cw, ccw]) {
      const mesh = buildBuildings([[300, 0, 1920, ring]], 0.1, groundAt);
      const { walls, roofs } = checkWinding(mesh);
      expect(walls).toBe(8);
      expect(roofs).toBe(2);
      // Outward: every wall normal points away from the footprint centroid.
      const pos = mesh.geometry.getAttribute("position");
      const nrm = mesh.geometry.getAttribute("normal");
      for (let v = 0; v < pos.count; v++) {
        if (nrm.getY(v) > 0.5) {
          continue;
        }
        const dx = pos.getX(v) - 10;
        const dz = pos.getZ(v) - 5;
        expect(dx * nrm.getX(v) + dz * nrm.getZ(v)).toBeGreaterThan(0);
      }
    }
  });

  test("height comes from the roof field, base from the sampled ground", () => {
    const mesh = buildBuildings([[300, 0, 1920, cw]], 0.1, groundAt);
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!;
    expect(box.min.y).toBeCloseTo(10 - 0.4);
    expect(box.max.y).toBeCloseTo(10 - 0.4 + 30);
    expect(box.max.x).toBeCloseTo(20);
    expect(box.max.z).toBeCloseTo(10);
  });

  test("an excluded site collapses its building to degenerate padding", () => {
    const mesh = buildBuildings([[300, 0, 1920, cw]], 0.1, groundAt, { exclude: [{ x: 10, z: 5, r: 30 }] });
    mesh.geometry.computeBoundingBox();
    // Only the sunken padding vertex remains above the buffers' zero-fill.
    expect(mesh.geometry.boundingBox!.min.y).toBe(-1000);
    expect(mesh.geometry.boundingBox!.max.y).toBe(0);
    // A site elsewhere leaves the building alone.
    const kept = buildBuildings([[300, 0, 1920, cw]], 0.1, groundAt, { exclude: [{ x: 500, z: 5, r: 30 }] });
    kept.geometry.computeBoundingBox();
    expect(kept.geometry.boundingBox!.max.y).toBeCloseTo(10 - 0.4 + 30);
  });

  test("excludeInsidePark drops park-interior footprints, keeps the city", () => {
    // A ring at the park centre (local origin) vs the same ring 3 km east.
    const at = (ox: number) => cw.map((v, i) => (i % 2 === 0 ? v + ox * 10 : v));
    const inside = buildBuildings([[300, 0, 1980, at(0)]], 0.1, groundAt, { excludeInsidePark: true });
    inside.geometry.computeBoundingBox();
    expect(inside.geometry.boundingBox!.min.y).toBe(-1000); // degenerate padding only
    const outside = buildBuildings([[300, 0, 1980, at(3000)]], 0.1, groundAt, { excludeInsidePark: true });
    outside.geometry.computeBoundingBox();
    expect(outside.geometry.boundingBox!.max.y).toBeCloseTo(10 - 0.4 + 30);
  });

  test("the base is darker than the top (street-canyon shading)", () => {
    const mesh = buildBuildings([[300, 0, 1920, cw]], 0.1, groundAt);
    const pos = mesh.geometry.getAttribute("position");
    const col = mesh.geometry.getAttribute("color");
    let baseSum = 0;
    let topSum = 0;
    for (let v = 0; v < 4; v++) {
      const lum = col.getX(v) + col.getY(v) + col.getZ(v);
      if (pos.getY(v) < 10) {
        baseSum += lum;
      } else {
        topSum += lum;
      }
    }
    expect(baseSum).toBeLessThan(topSum);
  });
});


describe("park water and banks", () => {
  test("a noisy DEM produces a level pond with its entire bed below water", () => {
    const water = buildWater((x, z) => Math.abs(x) < 8 && Math.abs(z) < 8 ? 1 : 0, (x, z) => 12 + x * .3 + z * .2, 30, 30, 2, { x: 0, z: 0 });
    expect(water.hero).not.toBeNull();
    expect(water.mesh).toBeNull();
    for (let x = -7; x < 8; x += 2) {
      expect(water.surfaceAt(x, 1)).toBeCloseTo(water.hero!.level);
      expect(water.bankHeightAt(x, 1)).toBeLessThan(water.hero!.level);
    }
    expect(water.surfaceAt(15, 0)).toBeNull();
    expect(water.bankHeightAt(29, 0)).toBeNull();
    let previous = water.bankHeightAt(7, 1)!;
    for (let x = 9; x < 20; x += 2) {
      const next = water.bankHeightAt(x, 1)!;
      expect(next).toBeGreaterThan(previous);
      previous = next;
    }
    water.hero!.geometry.dispose();
  });

  test("translated crops retain world coordinates and independent water levels", () => {
    const water = buildWater((x) => (x > 90 && x < 98) || (x > 102 && x < 110) ? 1 : 0,
      x => x < 100 ? 5 : 15, 20, 10, 2, { x: 95, z: 200 }, { x: 100, z: 200 });
    expect(water.hero!.level).toBeCloseTo(5.1);
    expect(water.surfaceAt(105, 200)).toBeCloseTo(15.1);
    expect(water.surfaceAt(95, 0)).toBeNull();
    water.hero!.geometry.computeBoundingBox();
    expect(water.hero!.geometry.boundingBox!.min.x).toBe(91);
    expect(water.hero!.geometry.boundingBox!.max.y).toBe(-190);
    const pos = water.mesh!.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) expect(pos.getY(i)).toBeCloseTo(15.1);
    water.hero!.geometry.dispose(); water.mesh!.geometry.dispose();
    (water.mesh!.material as THREE.Material).dispose();
  });

  test("a hero point outside a crop cannot select its edge water", () => {
    const water = buildWater(() => 1, () => 5, 10, 10, 2, { x: 50, z: 0 });
    expect(water.hero).toBeNull();
    expect(water.mesh).not.toBeNull();
    water.mesh!.geometry.dispose(); (water.mesh!.material as THREE.Material).dispose();
  });
});

describe("paths on rendered terrain", () => {
  test("surface sampling uses the actual triangle diagonal, including crop edges", () => {
    const heights = [0, 2, 4, 12];
    const sample = terrainSurfaceSampler({ getY: (i: number) => heights[i]! }, 1, 1, 10, 20, 2, 2, () => -100);
    expect(sample(10.5, 20.5)).toBeCloseTo(1.5);
    expect(sample(11.5, 21.5)).toBeCloseTo(7.5);
    expect(sample(12, 22)).toBe(12);
    expect(sample(9, 20)).toBe(-100);
  });

  test("both path edges follow sloped ground and sparse paths stop at water", () => {
    const ground = (x: number, z: number) => x * .2 + z * .4;
    const mesh = buildPaths([{ width: 2, pts: [-10, 0, 10, 0] }], ground, x => Math.abs(x) < 2 ? 1 : 0)!;
    const pos = mesh.geometry.getAttribute("position"), indices = mesh.geometry.getIndex()!;
    expect(pos.count).toBeGreaterThan(20);
    for (let i = 0; i < pos.count; i++) {
      const clearance = pos.getY(i) - ground(pos.getX(i), pos.getZ(i));
      expect(clearance).toBeGreaterThan(.06);
      expect(clearance).toBeLessThan(.09);
    }
    for (let i = 0; i < indices.count; i += 3) {
      const xs = [0, 1, 2].map(k => pos.getX(indices.getX(i + k)));
      expect(xs.every(x => x <= -2) || xs.every(x => x >= 2)).toBe(true);
    }
    mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose();
  });
});


test("water contour clips a diagonal shoreline without filling the dry corner", () => {
  const polygon = clipWaterTriangle([{ x: 0, z: 0, wet: 1 }, { x: 0, z: 2, wet: 0 }, { x: 2, z: 0, wet: 0 }]);
  expect(polygon.map(p => [p.x, p.z])).toEqual([[0, 0], [0, 1], [1, 0]]);
});
