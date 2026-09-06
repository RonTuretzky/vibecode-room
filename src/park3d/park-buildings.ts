import * as THREE from 'three';
import { skylineProfile } from './park-skyline-profile';
import { insideParkOutline as insidePark } from './park-outline';
import { buildingFacadeMaterial, FACADE_TILE_M, glassBuilding } from './park-facades';
import { roofInset, buildRoofDetails, type RoofPlan } from './park-roof-details';
import { parkRoofTexture } from './park-materials';

// Deterministic per-building variation.
const hash01 = (n: number): number => {
  let h = (n * 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

// Facade palettes: pre-war Manhattan is limestone, brownstone and brick;
// mid-century is beige and grey masonry; the towers are glass.
const PREWAR = [0xcfc2ad, 0x9a7561, 0xa86a55, 0xb89b78, 0xc4b59c];
const MIDCENTURY = [0xb7b2a8, 0xa8a39a, 0x9e9b93, 0xc0b8aa];
const GLASS = [0x8fa6b8, 0x7f95a8, 0xa3b4c2, 0x6f8799, 0x9fb3c4];

function facadeTone(year: number, height: number, seed: number): THREE.Color {
  let palette: number[];
  if (glassBuilding(height, year)) {
    palette = GLASS;
  } else if (year !== 0 && year < 1945) {
    palette = PREWAR;
  } else if (year === 0 && height < 45) {
    palette = PREWAR;
  } else {
    palette = MIDCENTURY;
  }
  const tone = new THREE.Color(palette[Math.floor(hash01(seed) * palette.length)]);
  // ±8% brightness jitter so rows of identical brownstones don't band.
  return tone.multiplyScalar(0.92 + hash01(seed + 7919) * 0.16);
}

// One indexed mesh for the whole city: per building, a quad per footprint
// edge (own normals, so the facades shade as flat faces) and an ear-clipped
// roof. Vertex colours carry the facade tone with a darker base (cheap
// ambient occlusion from the street canyon).
export interface BuildBuildingsOptions {
  facades?: boolean;
  detail?: boolean;
  exclude?: { x: number; z: number; r: number }[];
  excludeInsidePark?: boolean;
  focus?: { x: number; z: number };
}

export function buildBuildings(
  rows: [number, number, number, number[]][],
  unit: number,
  groundAt: (x: number, z: number) => number,
  opts: BuildBuildingsOptions = {},
): THREE.Mesh {
  let vertexCount = 0;
  const profiles = rows.map(([height, , year, ring]) => skylineProfile(height * unit, year, ring, opts.detail === true));
  rows.forEach(([, , , ring], i) => {
    const n = ring.length / 2, tiers = profiles[i]!.length;
    vertexCount += (tiers * 4 + (tiers - 1) * 4 + 1) * n;
  });
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const wallIndex: number[] = [];
  const glassIndex: number[] = [];
  const roofIndex: number[] = [];
  const roofPlans: RoofPlan[] = [];
  let v = 0;
  const roofGrey = new THREE.Color(0x8c8c8c);
  const contour: THREE.Vector2[] = [];
  const exclude = opts.exclude ?? [];
  // One facade tile = FACADE_TILE_M metres of wall in both directions.

  const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color, shade: number, u: number, w: number): number => {
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    normals[v * 3] = nx;
    normals[v * 3 + 1] = ny;
    normals[v * 3 + 2] = nz;
    colors[v * 3] = c.r * shade;
    colors[v * 3 + 1] = c.g * shade;
    colors[v * 3 + 2] = c.b * shade;
    uvs[v * 2] = u;
    uvs[v * 2 + 1] = w;
    return v++;
  };

  rows.forEach(([hUnits, , year, ringUnits], b) => {
    const n = ringUnits.length / 2;
    const xs = new Float64Array(n);
    const zs = new Float64Array(n);
    let area = 0;
    for (let i = 0; i < n; i++) {
      xs[i] = ringUnits[i * 2] * unit;
      zs[i] = ringUnits[i * 2 + 1] * unit;
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += xs[i] * zs[j] - xs[j] * zs[i];
    }
    // Positive shoelace in (x, z) is clockwise seen from above (+Y); the
    // roof and the outward wall normals below assume counter-clockwise.
    if (area > 0) {
      xs.reverse();
      zs.reverse();
    }
    let cx0 = 0;
    let cz0 = 0;
    for (let i = 0; i < n; i++) {
      cx0 += xs[i] / n;
      cz0 += zs[i] / n;
    }
    if (
      (opts.excludeInsidePark === true && insidePark(cx0, cz0, -6)) ||
      exclude.some((site) => (site.x - cx0) ** 2 + (site.z - cz0) ** 2 < site.r * site.r)
    ) {
      // A real model stands here — pad the reserved index slots with
      // degenerate triangles so the preallocated buffers stay dense.
      const a = put(0, -1000, 0, 0, 1, 0, roofGrey, 1, 0, 0);
      for (let k = 0; k < 6 * n; k++) {
        wallIndex.push(a);
      }
      for (let k = 0; k < 3 * (n - 2); k++) {
        roofIndex.push(a);
      }
      return;
    }
    const height = Math.max(3, hUnits * unit);
    const facadeIndices = glassBuilding(height, year) ? glassIndex : wallIndex;
    // With a facade texture the near-white tile multiplies the tone; undim
    // it and sun-facing walls blow out to paper.
    const toneScale = opts.facades !== false ? 0.78 : 1;
    let base = Infinity;
    for (let i = 0; i < n; i++) {
      base = Math.min(base, groundAt(xs[i], zs[i]));
    }
    // Sink slightly so sloped lots never show a floating slab edge.
    base -= 0.4;
    const top = base + height;
    const tone = facadeTone(year, height, b + 1).multiplyScalar(toneScale);
    const roof = tone.clone().lerp(roofGrey, 0.5).multiplyScalar(0.9 / Math.max(toneScale, 0.01));

    const tiers = profiles[b]!;
    const roofScale = tiers[tiers.length - 1]!.scale;
    const roofRing = Array.from(xs, (x, i) => ({ x: cx0 + (x - cx0) * roofScale, z: cz0 + (zs[i]! - cz0) * roofScale }));
    const glass = glassBuilding(height, year);
    const nearbyRoof = !opts.focus || Math.hypot(cx0 - opts.focus.x, cz0 - opts.focus.z) < 850;
    const inset = opts.detail && nearbyRoof && height > 9 ? roofInset(roofRing, glass ? .3 : .45) : null;
    const deck = top - (inset ? glass ? .75 : 1.05 : 0);
    if (inset) roofPlans.push({ outer: roofRing, inner: inset, deck, top, color: tone, glass, seed: b });
    let bottom = 0;
    for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
      const tier = tiers[tierIndex]!;
      const tierX = (i: number) => cx0 + (xs[i]! - cx0) * tier.scale;
      const tierZ = (i: number) => cz0 + (zs[i]! - cz0) * tier.scale;
      let run = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const xi = tierX(i), zi = tierZ(i), xj = tierX(j), zj = tierZ(j);
        const dx = xj - xi, dz = zj - zi, len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len, nz = dx / len;
        const u0 = run / FACADE_TILE_M, u1 = (run + len) / FACADE_TILE_M;
        run += len;
        const low = base + bottom * height, high = tierIndex === tiers.length - 1 ? deck : base + tier.top * height;
        const v0 = bottom * height / FACADE_TILE_M, v1 = (high - base) / FACADE_TILE_M;
        const a = put(xi, low, zi, nx, 0, nz, tone, .78 + bottom * .22, u0, v0);
        const c = put(xj, low, zj, nx, 0, nz, tone, .78 + bottom * .22, u1, v0);
        const d = put(xj, high, zj, nx, 0, nz, tone, .78 + tier.top * .22, u1, v1);
        const e = put(xi, high, zi, nx, 0, nz, tone, .78 + tier.top * .22, u0, v1);
        facadeIndices.push(a, c, d, a, d, e);
        const next = tiers[tierIndex + 1];
        if (next) {
          const innerXi = cx0 + (xs[i]! - cx0) * next.scale, innerZi = cz0 + (zs[i]! - cz0) * next.scale;
          const innerXj = cx0 + (xs[j]! - cx0) * next.scale, innerZj = cz0 + (zs[j]! - cz0) * next.scale;
          const a = put(xi, high, zi, 0, 1, 0, roof, 1, 0, 0);
          const c = put(xj, high, zj, 0, 1, 0, roof, 1, 0, 0);
          const d = put(innerXj, high, innerZj, 0, 1, 0, roof, 1, 0, 0);
          const e = put(innerXi, high, innerZi, 0, 1, 0, roof, 1, 0, 0);
          roofIndex.push(a, c, d, a, d, e);
        }
      }
      bottom = tier.top;
    }
    for (let i = 0; i < n; i++) {
      xs[i] = cx0 + (xs[i]! - cx0) * roofScale;
      zs[i] = cz0 + (zs[i]! - cz0) * roofScale;
    }

    contour.length = 0;
    for (let i = 0; i < n; i++) {
      // Earcut in (x, −z) so the ring is counter-clockwise in a y-up plane
      // seen from +Y, matching the roof normal.
      contour.push(new THREE.Vector2(xs[i], -zs[i]));
    }
    const roofStart = v;
    for (let i = 0; i < n; i++) {
      put(xs[i], deck, zs[i], 0, 1, 0, roof, 1, xs[i]! / 4, zs[i]! / 4);
    }
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const [p, q, r] of tris) {
      // Earcut's output winding depends on its own conventions; orient each
      // roof triangle so its face normal points up (+Y).
      const ny = (zs[q] - zs[p]) * (xs[r] - xs[p]) - (xs[q] - xs[p]) * (zs[r] - zs[p]);
      roofIndex.push(roofStart + p, roofStart + (ny < 0 ? r : q), roofStart + (ny < 0 ? q : r));
    }
    // Degenerate rings (earcut dropping triangles) leave unused slots — pad
    // with a zero-area triangle so the index stays dense.
    const expected = 3 * (n - 2);
    for (let k = tris.length * 3; k < expected; k++) {
      roofIndex.push(roofStart);
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(opts.detail ? positions.subarray(0, v * 3) : positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(opts.detail ? normals.subarray(0, v * 3) : normals, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(opts.detail ? colors.subarray(0, v * 3) : colors, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(opts.detail ? uvs.subarray(0, v * 2) : uvs, 2));
  const index = new Uint32Array(wallIndex.length + glassIndex.length + roofIndex.length);
  index.set(wallIndex, 0);
  index.set(glassIndex, wallIndex.length);
  index.set(roofIndex, wallIndex.length + glassIndex.length);
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.addGroup(0, wallIndex.length, 0);
  geometry.addGroup(wallIndex.length, glassIndex.length, 1);
  geometry.addGroup(wallIndex.length + glassIndex.length, roofIndex.length, 2);
  geometry.computeBoundingSphere();
  const wallMaterial = buildingFacadeMaterial(false, opts.facades !== false);
  const glassMaterial = buildingFacadeMaterial(true, opts.facades !== false);
  const roofMap = typeof document === 'undefined' ? null : parkRoofTexture();
  const mesh = new THREE.Mesh(geometry, [wallMaterial, glassMaterial, new THREE.MeshStandardMaterial({ vertexColors: true,
    map: roofMap, bumpMap: roofMap, bumpScale: .015, roughness: .95 })]);
  mesh.name = "park-buildings";
  // The building body must cast alongside its parapet; isolated roof casters
  // otherwise paint a hollow rectangular outline across the park.
  mesh.castShadow = true; mesh.receiveShadow = true;
  const details = buildRoofDetails(roofPlans);
  if (details) mesh.add(details);
  return mesh;
}
