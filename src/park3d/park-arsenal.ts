import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AXIS, PERP } from './park-frame';
import { PARK_SITES, siteDistance, type SitePoint } from './park-sites';
import { parkBrickTexture, parkStoneTexture } from './park-materials';
import type { ParkWalk } from './park-walks';

const site = PARK_SITES.arsenal;
const ring = site.ring.map(p => ({
  x: (p.x - site.x) * AXIS.x + (p.z - site.z) * AXIS.z,
  z: (p.x - site.x) * PERP.x + (p.z - site.z) * PERP.z,
}));

/** Source footprint and maximum height; cornice/floor heights are modeled
 * proportions from LPC LP-0312, not a measured architectural survey. */
export const ARSENAL_HEIGHT = site.heightM ?? 23.5;
const roof = ARSENAL_HEIGHT - 5.3, base = 3.1;

/** Join the modeled stair foot to the closest mapped walk in front of it.
 * This short connector is an inferred entrance apron, never a new long path. */
export function arsenalApproach(paths: readonly ParkWalk[]): ParkWalk | null {
  const start = { x: site.x + PERP.x * 13.1, z: site.z + PERP.z * 13.1 };
  let nearest: { x: number; z: number; distance: number } | null = null;
  for (const path of paths) for (let i = 2; i < path.pts.length; i += 2) {
    const ax = path.pts[i - 2]!, az = path.pts[i - 1]!, dx = path.pts[i]! - ax, dz = path.pts[i + 1]! - az;
    const t = THREE.MathUtils.clamp(((start.x - ax) * dx + (start.z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
    const x = ax + t * dx, z = az + t * dz;
    if ((x - start.x) * PERP.x + (z - start.z) * PERP.z < -.1) continue;
    const distance = Math.hypot(x - start.x, z - start.z);
    if (distance < 8 && (!nearest || distance < nearest.distance)) nearest = { x, z, distance };
  }
  return nearest && nearest.distance > .2 ? { width: 5.7, surface: 'paving_stones', kind: 'walk', pts: [start.x, start.z, nearest.x, nearest.z] } : null;
}

export function createArsenalGrade(groundAt: (x: number, z: number) => number) {
  const heights = site.ring.map(p => groundAt(p.x, p.z)).sort((a, b) => a - b);
  const level = heights[Math.floor(heights.length / 2)]!;
  const reach = Math.max(...site.ring.map(p => Math.hypot(p.x - site.x, p.z - site.z))) + 5;
  return { level, heightAt(x: number, z: number, original: number) {
    if (Math.hypot(x - site.x, z - site.z) > reach) return original;
    const localX = (x - site.x) * AXIS.x + (z - site.z) * AXIS.z;
    const localZ = (x - site.x) * PERP.x + (z - site.z) * PERP.z;
    const stepsDistance = Math.max(Math.abs(localX) - 3.15, 7.5 - localZ, localZ - 13.4);
    const distance = Math.min(siteDistance(x, z, site.ring), stepsDistance);
    const t = THREE.MathUtils.clamp((distance - .5) / 3, 0, 1);
    return THREE.MathUtils.lerp(level, original, t * t * (3 - 2 * t));
  } };
}

export function buildArsenal(level: number): THREE.Group {
  const group = new THREE.Group(); group.name = 'The Arsenal';
  group.position.set(site.x, level, site.z);
  // Local X follows the long north/south facade; Z points toward Fifth Ave.
  group.rotation.y = Math.atan2(-AXIS.z, AXIS.x);
  const brickMap = typeof document === 'undefined' ? null : parkBrickTexture();
  const stoneMap = typeof document === 'undefined' ? null : parkStoneTexture().clone();
  stoneMap?.repeat.set(.4, .4);
  const materials = [
    new THREE.MeshStandardMaterial({ color: 0xbd7951, map: brickMap, bumpMap: brickMap, bumpScale: .025, roughness: .96 }),
    new THREE.MeshStandardMaterial({ color: 0x8d8980, map: stoneMap, bumpMap: stoneMap, bumpScale: .05, roughness: .97 }),
    new THREE.MeshStandardMaterial({ color: 0xd7d0ba, roughness: .9 }),
    new THREE.MeshStandardMaterial({ color: 0x32464a, roughness: .3, metalness: .2 }),
    new THREE.MeshStandardMaterial({ color: 0x4c504b, roughness: .97 }),
  ];
  materials[1]!.userData.ownsParkMap = true;
  const batches = materials.map(() => [] as THREE.BufferGeometry[]);
  function box(material: number, w: number, h: number, d: number, x: number, y: number, z: number, yaw = 0) {
    const geo = new THREE.BoxGeometry(w, h, d);
    // World-scale brick courses on all box faces.
    const pos = geo.getAttribute('position'), normal = geo.getAttribute('normal'), uv = geo.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (Math.abs(normal.getX(i)) > .5 ? pos.getZ(i) : pos.getX(i)) / 2.4, (pos.getY(i) + y) / .8);
    geo.rotateY(yaw); geo.translate(x, y, z); batches[material]!.push(geo);
  }
  function slab(points: readonly SitePoint[], y: number, material: number) {
    const shape = new THREE.Shape(points.map(p => new THREE.Vector2(p.x, -p.z)));
    const geo = new THREE.ShapeGeometry(shape); geo.rotateX(-Math.PI / 2); geo.translate(0, y, 0);
    batches[material]!.push(geo);
  }
  function walls(points: readonly SitePoint[], bottom: number, top: number, material: number) {
    const pos: number[] = [], uv: number[] = [];
    const clockwise = THREE.ShapeUtils.isClockWise(points.map(p => new THREE.Vector2(p.x, p.z)));
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!, b = points[(i + 1) % points.length]!, length = Math.hypot(b.x - a.x, b.z - a.z);
      const corners = [[a.x, bottom, a.z, 0, bottom], [b.x, bottom, b.z, length, bottom], [b.x, top, b.z, length, top], [a.x, top, a.z, 0, top]];
      for (const k of clockwise ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) {
        const p = corners[k]!; pos.push(p[0]!, p[1]!, p[2]!); uv.push(p[3]! / 2.4, p[4]! / .8);
      }
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.computeVertexNormals(); batches[material]!.push(geo);
  }
  walls(ring, -1.5, base, 1); walls(ring, base, roof, 0); slab(ring, roof, 4);

  // Every exposed long facade edge follows the surveyed outline. Short
  // octagonal facets belong to towers and get slit windows below instead.
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!, dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
    if (length < 5) continue;
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    let nx = -dz / length, nz = dx / length;
    if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
    const yaw = Math.atan2(nx, nz);
    // Cornice and parapet cover the roof edges, with individual merlons.
    box(2, length, .22, .5, mx, roof - .18, mz, yaw);
    box(0, length, .5, .42, mx, roof + .25, mz, yaw);
    const crenels = Math.max(2, Math.round(length / 1.6));
    for (let n = 0; n < crenels; n++) {
      const t = (n + .5) / crenels;
      box(0, .72, .7, .44, a.x + dx * t, roof + .85, a.z + dz * t, yaw);
      box(2, .78, .09, .5, a.x + dx * t, roof + 1.245, a.z + dz * t, yaw);
    }
    const bays = Math.max(1, Math.round(length / 3.9));
    for (let n = 0; n < bays; n++) {
      const t = (n + .5) / bays, x = a.x + dx * t + nx * .035, z = a.z + dz * t + nz * .035;
      for (let floor = 0; floor < 3; floor++) {
        const y = 5.5 + floor * 4.15, w = 1.55, h = 2.35;
        box(3, w, h, .035, x, y, z, yaw);
        for (const side of [-1, 1]) box(2, .11, h + .16, .12, x + dx / length * side * (w / 2 + .02), y, z + dz / length * side * (w / 2 + .02), yaw);
        for (const yy of [-h / 2, 0, h / 2]) box(2, w + .2, yy === 0 ? .07 : .14, .15, x, y + yy, z, yaw);
        box(2, .07, h, .14, x, y, z, yaw);
        box(2, w + .35, .17, .32, x + nx * .04, y - h / 2 - .16, z + nz * .04, yaw);
      }
    }
  }

  // The eight partly engaged octagons are reconstructed from their mapped
  // exposed facets. Their upper story is independent of the main roof.
  const towerRuns = [[0, 5], [6, 9], [10, 13], [14, 19], [20, 25], [26, 29], [30, 33], [34, 39]];
  for (const [start, end] of towerRuns) {
    const points = ring.slice(start, end! + 1);
    const cx = (Math.min(...points.map(p => p.x)) + Math.max(...points.map(p => p.x))) / 2;
    // Exposed facets cover one half of each engaged octagon. Its full
    // centre sits 2.6 m inside the outer face; use the mapped lateral centre.
    const outer = Math.abs(points.reduce((v, p) => Math.abs(p.z) > Math.abs(v) ? p.z : v, 0));
    const sign = points[0]!.z > 0 ? 1 : -1, cz = sign * (outer - 2.6);
    const tower = Array.from({ length: 8 }, (_, i) => {
      const a = Math.PI / 8 + i * Math.PI / 4; return { x: cx + Math.cos(a) * 2.8, z: cz + Math.sin(a) * 2.8 };
    });
    walls(tower, roof - .08, ARSENAL_HEIGHT - 1.1, 0);
    slab(tower, ARSENAL_HEIGHT - 1.1, 4);
    for (let n = 0; n < 8; n++) {
      const a = tower[n]!, b = tower[(n + 1) % 8]!, mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const yaw = Math.atan2(mx - cx, mz - cz);
      box(2, Math.hypot(b.x - a.x, b.z - a.z) + .1, .16, .36, mx, ARSENAL_HEIGHT - 1.15, mz, yaw);
      box(0, .92, 1, .42, mx, ARSENAL_HEIGHT - .6, mz, yaw);
      box(2, 1, .1, .5, mx, ARSENAL_HEIGHT - .05, mz, yaw);
      box(3, .36, 1.5, .08, mx + (mx - cx) * .018, ARSENAL_HEIGHT - 3, mz + (mz - cz) * .018, yaw);
    }
  }

  // Broad raised east entrance, shallow treads and pale stone surround.
  // Detail is illustrative; the cannon/rifle sculpture is not reproduced.
  const doorZ = 7.6;
  for (let i = 0; i < 18; i++) {
    const h = (i + 1) * base / 18;
    box(1, 5.7, h, .32, 0, h / 2, doorZ + (18 - i) * .31);
  }
  box(3, 2.5, 3.2, .14, 0, base + 1.6, doorZ + .1);
  for (const x of [-1.4, 1.4]) box(2, .3, 3.55, .35, x, base + 1.7, doorZ + .2);
  box(2, 3.2, .4, .5, 0, base + 3.65, doorZ + .2);
  for (const x of [-3.05, 3.05]) {
    const rail = new THREE.BoxGeometry(.13, .15, 6.2);
    rail.rotateX(Math.atan2(base, 5.6)); rail.translate(x, 2.5, doorZ + 2.9); batches[2]!.push(rail);
    for (let n = 0; n < 10; n++) box(2, .1, .95, .1, x, 3.5 - n * .3, doorZ + n * .57);
  }
  for (let i = 0; i < batches.length; i++) {
    const parts = batches[i]!;
    const expanded = parts.map(p => p.index ? p.toNonIndexed() : p);
    const geometry = mergeGeometries(expanded)!;
    for (const part of new Set([...parts, ...expanded])) part.dispose();
    const mesh = new THREE.Mesh(geometry, materials[i]);
    mesh.name = ['arsenal-brick', 'arsenal-granite', 'arsenal-trim', 'arsenal-windows', 'arsenal-roofs'][i]!;
    mesh.castShadow = mesh.receiveShadow = true; group.add(mesh);
  }
  return group;
}
