import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PARK_SITES, siteDistance, distanceToSegment } from './park-sites';

/** A level recreation surface on the mapped rink footprint. The 8 m DEM
 * cannot resolve its retaining edge. Grade a narrow apron, not the hillside. */
export function createWollmanGrade(groundAt: (x: number, z: number) => number) {
  const site = PARK_SITES.wollman;
  const heights = site.ring.map(p => groundAt(p.x, p.z)).sort((a, b) => a - b);
  const level = heights[Math.floor(heights.length / 2)]!;
  const reach = Math.max(...site.ring.map(p => Math.hypot(p.x - site.x, p.z - site.z))) + 9;
  return { level, heightAt(x: number, z: number, original: number) {
    if (Math.hypot(x - site.x, z - site.z) > reach) return original;
    const distance = siteDistance(x, z, site.ring);
    const t = Math.max(0, Math.min(1, (distance - 3) / 5));
    return level + (original - level) * t * t * (3 - 2 * t);
  } };
}

export function buildWollmanRink(level: number, paths: readonly { width: number; pts: number[] }[] = []): THREE.Group {
  const group = new THREE.Group(); group.name = 'Wollman Rink';
  const site = PARK_SITES.wollman;
  // Work near a local origin so small paving offsets survive float32 geometry.
  group.position.set(site.x, level, site.z);
  const ring = site.ring.map(p => new THREE.Vector2(p.x - site.x, p.z - site.z));
  // An understated, unprogrammed warm-season recreation slab. Ice and the
  // changing seasonal court/event fit-out are deliberately not fabricated.
  const surface = new THREE.ShapeGeometry(new THREE.Shape(ring.map(p => new THREE.Vector2(p.x, -p.y))));
  surface.rotateX(-Math.PI / 2); surface.translate(0, .10, 0);
  const mesh = new THREE.Mesh(surface, new THREE.MeshStandardMaterial({ color: 0x697c80, roughness: .88 }));
  mesh.name = 'wollman-mapped-surface'; mesh.receiveShadow = true; group.add(mesh);
  const stone = new THREE.MeshStandardMaterial({ color: 0xb5afa0, roughness: .96 });
  const apronRing = ring.map(p => p.clone().multiplyScalar(1 + 2.8 / p.length()));
  const apronGeometry = new THREE.ShapeGeometry(new THREE.Shape(apronRing.map(p => new THREE.Vector2(p.x, -p.y))));
  apronGeometry.rotateX(-Math.PI / 2); apronGeometry.translate(0, .06, 0);
  const apron = new THREE.Mesh(apronGeometry, stone); apron.receiveShadow = true;
  apron.name = 'wollman-apron'; group.add(apron);
  const iron = new THREE.MeshStandardMaterial({ color: 0x394743, roughness: .72, metalness: .25 });
  const edges: THREE.BufferGeometry[] = [], rails: THREE.BufferGeometry[] = [];
  // Open the perimeter where mapped walks reach the rink. These are inferred
  // access gaps, not surveyed gates or an operational access-control model.
  const approaches = paths.flatMap(path => {
    const segments = [];
    for (let i = 2; i < path.pts.length; i += 2) {
      const a = { x: path.pts[i - 2]! - site.x, z: path.pts[i - 1]! - site.z };
      const b = { x: path.pts[i]! - site.x, z: path.pts[i + 1]! - site.z };
      if (Math.min(Math.hypot(a.x, a.z), Math.hypot(b.x, b.z)) < 70) segments.push({ a, b, half: path.width / 2 + .6 });
    }
    return segments;
  });
  const accessAt = (x: number, z: number) => approaches.some(s => distanceToSegment(x, z, s.a, s.b) < s.half);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const dx = b.x - a.x, dz = b.y - a.y, length = Math.hypot(dx, dz), angle = -Math.atan2(dz, dx);
    const x = (a.x + b.x) / 2, z = (a.y + b.y) / 2;
    const curb = new THREE.BoxGeometry(length + .04, .22, .42);
    curb.rotateY(angle); curb.translate(x, .11, z); edges.push(curb);
    const count = Math.max(1, Math.ceil(length / 1.3));
    for (let j = 0; j < count; j++) {
      const mx = a.x + dx * (j + .5) / count, mz = a.y + dz * (j + .5) / count;
      if (accessAt(mx, mz)) continue;
      const rail = new THREE.BoxGeometry(length / count + .02, .055, .055);
      rail.rotateY(angle); rail.translate(mx, 1.02, mz); rails.push(rail);
      const px = a.x + dx * j / count, pz = a.y + dz * j / count;
      if (!accessAt(px, pz)) {
        const post = new THREE.BoxGeometry(.055, .88, .055);
        post.translate(px, .58, pz); rails.push(post);
      }
    }
  }
  for (const [parts, material] of [[edges, stone], [rails, iron]] as const) {
    if (!parts.length) { material.dispose(); continue; }
    const detail = new THREE.Mesh(mergeGeometries([...parts])!, material);
    parts.forEach(g => g.dispose()); detail.castShadow = true; detail.receiveShadow = true; group.add(detail);
  }
  group.userData.osmWay = site.osmWay;
  return group;
}
