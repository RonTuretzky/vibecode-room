import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PARK_SITES, WOLLMAN_PATIO, inSite, siteDistance, distanceToSegment, type SitePoint } from './park-sites';
import { parkStoneTexture, parkRoofTexture } from './park-materials';

const site = PARK_SITES.wollmanClubhouse, rink = PARK_SITES.wollman;
export const WOLLMAN_CLUBHOUSE_HEIGHT = site.heightM ?? 5;
const reach = Math.max(...site.ring.map(p => Math.hypot(p.x - site.x, p.z - site.z))) + 9;
const towardsRink = new THREE.Vector2(rink.x - site.x, rink.z - site.z).normalize();
const clockwise = THREE.ShapeUtils.isClockWise(site.ring.map(p => new THREE.Vector2(p.x, p.z)));
const perimeter = site.ring.map((a, i) => {
  const b = site.ring[(i + 1) % site.ring.length]!, dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
  const nx = (clockwise ? -dz : dz) / length, nz = (clockwise ? dx : -dx) / length;
  return { a, b, nx, nz, front: nx * towardsRink.x + nz * towardsRink.y > .15 };
});

/** The clubhouse occupies the hillside below an overlook. Keep the frontage
 * clear of earth, with a buried rear ledge supporting the roof approaches.
 * Behind the building, feather the terrain toward the roof-level entrance. */
export function createWollmanFacilitiesGrade(level: number) {
  const roof = level + WOLLMAN_CLUBHOUSE_HEIGHT;
  function profileAt(x: number, z: number, original: number) {
    if (Math.hypot(x - site.x, z - site.z) > reach) return { target: original, weight: 0 };
    if (WOLLMAN_PATIO.some(ring => inSite(x, z, ring))) return { target: level, weight: 1 };
    const distance = siteDistance(x, z, site.ring);
    let nearest = Infinity, rearDistance = Infinity, front = false;
    for (const edge of perimeter) {
      const d = distanceToSegment(x, z, edge.a, edge.b);
      if (d < nearest) { nearest = d; front = edge.front; }
      if (!edge.front) rearDistance = Math.min(rearDistance, d);
    }
    if (distance <= 0) {
      // Support the 2 m terrain triangles on both sides of the roof edge.
      // The interior ledge stays hidden beneath the deck and drops to the
      // floor before reaching the glazed frontage.
      const t = THREE.MathUtils.clamp((rearDistance - 3.25) / 1.75, 0, 1);
      return { target: THREE.MathUtils.lerp(roof, Math.min(original, level - .12), t * t * (3 - 2 * t)), weight: 1 };
    }
    const t = THREE.MathUtils.clamp((distance - (front ? 0 : 3.25)) / (front ? 3 : 5), 0, 1);
    return { target: front ? level : roof, weight: 1 - t * t * (3 - 2 * t) };
  }
  return { roof,
    deckAt(x: number, z: number): number | null {
      if (Math.hypot(x - site.x, z - site.z) > reach || siteDistance(x, z, site.ring) > .02) return null;
      return roof + .08;
    },
    heightAt(x: number, z: number, original: number) {
      const { target, weight } = profileAt(x, z, original);
      return THREE.MathUtils.lerp(original, target, weight);
    },
    constrainWalkAt(x: number, z: number, gradedGround: number, walkGround: number) {
      // Walk corridors overlap here at different elevations. Preserve the
      // engineered terrace/forecourt instead of averaging it into the lower
      // rink walk. Blend only the walk's delta, so the terrain feather is not
      // applied twice.
      return THREE.MathUtils.lerp(walkGround, gradedGround, profileAt(x, z, gradedGround).weight);
    },
  };
}

export function buildWollmanFacilities(level: number, groundAt: (x: number, z: number) => number,
  paths: readonly { width: number; pts: number[] }[] = []): THREE.Group {
  const group = new THREE.Group(); group.name = 'Wollman Clubhouse and Overlook'; group.position.set(site.x, level, site.z);
  const ring = site.ring.map(p => ({ x: p.x - site.x, z: p.z - site.z }));
  const stoneMap = typeof document === 'undefined' ? null : parkStoneTexture().clone(); stoneMap?.repeat.set(.28, .28);
  const roofMap = typeof document === 'undefined' ? null : parkRoofTexture();
  const materials = [
    new THREE.MeshStandardMaterial({ color: 0xb0a491, map: stoneMap, bumpMap: stoneMap, bumpScale: .035, roughness: .94 }),
    new THREE.MeshStandardMaterial({ color: 0x4b6263, roughness: .28, metalness: .18 }),
    new THREE.MeshStandardMaterial({ color: 0x5c5947, roughness: .87 }),
    new THREE.MeshStandardMaterial({ color: 0xc1b59c, map: roofMap, roughness: .97 }),
  ];
  materials[0]!.userData.ownsParkMap = true;
  const batches = materials.map(() => [] as THREE.BufferGeometry[]);
  const h = WOLLMAN_CLUBHOUSE_HEIGHT;
  function box(index: number, w: number, height: number, depth: number, x: number, y: number, z: number, yaw = 0) {
    const g = new THREE.BoxGeometry(w, height, depth); g.rotateY(yaw); g.translate(x, y, z); batches[index]!.push(g);
  }
  function roof(points: SitePoint[], y: number, index: number) {
    const g = new THREE.ShapeGeometry(new THREE.Shape(points.map(p => new THREE.Vector2(p.x, -p.z))));
    g.rotateX(-Math.PI / 2); g.translate(0, y, 0);
    const p = g.getAttribute('position'), uv = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 3, p.getZ(i) / 3);
    batches[index]!.push(g);
  }
  const access = paths.flatMap(path => {
    const segments: { a: SitePoint; b: SitePoint; half: number }[] = [];
    for (let i = 2; i < path.pts.length; i += 2) {
      const a = { x: path.pts[i - 2]! - site.x, z: path.pts[i - 1]! - site.z }, b = { x: path.pts[i]! - site.x, z: path.pts[i + 1]! - site.z };
      if (Math.min(Math.hypot(a.x, a.z), Math.hypot(b.x, b.z)) < reach) segments.push({ a, b, half: path.width / 2 + .5 });
    }
    return segments;
  });
  const accessAt = (x: number, z: number) => access.some(s => distanceToSegment(x, z, s.a, s.b) < s.half);
  roof(ring, h + .08, 3);
  for (const panel of WOLLMAN_PATIO) roof(panel.map(p => ({ x: p.x - site.x, z: p.z - site.z })), .065, 0);
  const clockwise = THREE.ShapeUtils.isClockWise(ring.map(p => new THREE.Vector2(p.x, p.z)));
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!, dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, yaw = -Math.atan2(dz, dx);
    const nx = (clockwise ? -dz : dz) / length, nz = (clockwise ? dx : -dx) / length;
    const facesRink = nx * towardsRink.x + nz * towardsRink.y > .15;
    // The mapped curved front is a rhythm of shaded glazing and masonry
    // piers; rear walls disappear into the hill under the walking terrace.
    box(0, length + .03, h + .6, .26, mx - nx * .12, (h - .6) / 2, mz - nz * .12, yaw);
    box(0, length + .08, .28, .6, mx, h - .08, mz, yaw);
    if (facesRink && length > .8) {
      const bays = Math.max(1, Math.round(length / 2.7));
      for (let n = 0; n < bays; n++) {
        const t = (n + .5) / bays, x = a.x + dx * t, z = a.z + dz * t, width = length / bays;
        box(1, Math.max(.4, width - .25), 2.55, .035, x + nx * .03, 1.85, z + nz * .03, yaw);
        box(2, .09, 2.7, .1, x + nx * .09, 1.85, z + nz * .09, yaw);
        for (const yy of [.5, 3.2]) box(2, width - .16, .09, .12, x + nx * .09, yy, z + nz * .09, yaw);
      }
      // Slatted timber canopy extends over the front patio. Repeating
      // rafters cast actual shadows and leave the space underneath open.
      const rafters = Math.max(1, Math.ceil(length / 1.15));
      for (let n = 0; n < rafters; n++) {
        const t = (n + .5) / rafters, x = a.x + dx * t, z = a.z + dz * t;
        box(2, .12, .18, 3.6, x + nx * 1.5, h - .65, z + nz * 1.5, yaw);
      }
      for (const off of [.7, 2, 3]) box(2, length + .06, .13, .12, mx + nx * off, h - .73, mz + nz * off, yaw);
      box(2, .14, h - .8, .14, a.x + nx * 2.9, (h - .8) / 2, a.z + nz * 2.9);
    }
    // Railing gaps follow roof walk approaches, retaining access from the hill.
    const posts = Math.max(1, Math.ceil(length / 1.35));
    for (let n = 0; n < posts; n++) {
      const t = (n + .5) / posts, x = a.x + dx * t, z = a.z + dz * t;
      if (accessAt(x, z)) continue;
      box(2, length / posts + .02, .055, .055, x, h + 1.12, z, yaw);
      box(2, .055, .95, .055, x, h + .6, z);
    }
  }
  // Smaller mapped service structure east of the clubhouse. Its role and
  // facade details are interpretive; the footprint/height are retained.
  const service = PARK_SITES.wollmanService;
  const serviceRing = service.ring.map(p => ({ x: p.x - site.x, z: p.z - site.z }));
  const base = groundAt(service.x, service.z) - level, serviceHeight = service.heightM ?? 3.3;
  roof(serviceRing, base + serviceHeight, 3);
  for (let i = 0; i < serviceRing.length; i++) {
    const a = serviceRing[i]!, b = serviceRing[(i + 1) % serviceRing.length]!, length = Math.hypot(b.x - a.x, b.z - a.z), yaw = -Math.atan2(b.z - a.z, b.x - a.x);
    box(0, length, serviceHeight + 1, .25, (a.x + b.x) / 2, base + (serviceHeight - 1) / 2, (a.z + b.z) / 2, yaw);
  }
  for (let i = 0; i < batches.length; i++) {
    const parts = batches[i]!, expanded = parts.map(p => p.index ? p.toNonIndexed() : p);
    const mesh = new THREE.Mesh(mergeGeometries(expanded)!, materials[i]);
    for (const p of new Set([...parts, ...expanded])) p.dispose();
    mesh.name = ['wollman-facility-masonry', 'wollman-facility-glazing', 'wollman-facility-timber', 'wollman-overlook-roof'][i]!;
    mesh.castShadow = mesh.receiveShadow = true; group.add(mesh);
  }
  return group;
}
