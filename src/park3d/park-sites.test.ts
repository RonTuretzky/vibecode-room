import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { GAPSTOW_LAYOUT, PARK_SITES, createParkPlantingMask, inSite, hallettWoodlandAt } from './park-sites';
import { buildGapstow, buildLandmarks, LANDMARKS, OUTCROPS } from './park-landmarks';
import { buildWollmanRink, createWollmanGrade } from './park-wollman';
import { createGapstowCrossing, gapstowDeckAt } from './park-gapstow-ground';
import { DEG } from './park-frame';

const dispose = (root: THREE.Object3D) => root.traverse(node => {
  if (node instanceof THREE.Mesh) {
    node.geometry.dispose();
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
  }
});

test('south-end landmarks preserve the mapped north/south and east/west relationships', () => {
  // Conservancy map: the Dairy and Chess House are north of the rink;
  // Hallett is west of Gapstow; the Carousel is farther north again.
  const s = PARK_SITES;
  expect(s.dairy.z).toBeLessThan(s.wollman.z - 100);
  expect(s.chess.z).toBeLessThan(s.wollman.z - 100);
  expect(s.carousel.z).toBeLessThan(s.chess.z - 70);
  expect(s.hallett.x).toBeLessThan(s.gapstow.x - 70);
  expect(s.sherman.z).toBeLessThan(s.pulitzer.z - 60);
  expect(OUTCROPS.filter(s => /Umpire|Rat Rock/.test(s.name))).toHaveLength(1);
  for (const key of ['dairy', 'chess', 'carousel', 'copCot', 'inscope'] as const) {
    const site = s[key];
    expect(LANDMARKS.some(l => l.lat === site.lat && l.lon === site.lon)).toBe(true);
    expect(site.version).toBeGreaterThan(0);
  }
});

test('Gapstow follows its mapped footprint and leaves a full-width arch opening', () => {
  const bridge = buildGapstow();
  const layout = GAPSTOW_LAYOUT;
  expect(layout.length).toBeGreaterThan(22); expect(layout.length).toBeLessThan(24);
  expect(layout.width).toBeGreaterThan(5); expect(layout.width).toBeLessThan(7);
  const box = new THREE.Box3().setFromObject(bridge);
  expect(box.max.x - box.min.x).toBeCloseTo(layout.length, 0);
  const yaw = Math.PI - layout.bearing * DEG;
  const span = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  expect(span.x).toBeCloseTo(layout.dx); expect(span.z).toBeCloseTo(layout.dz);
  const ray = new THREE.Raycaster(new THREE.Vector3(5.5, 1, -10), new THREE.Vector3(0, 0, 1));
  bridge.updateMatrixWorld(true);
  expect(ray.intersectObject(bridge, true)).toHaveLength(0);
  dispose(bridge);
});

test('bridges stand on the corrected water level while buildings stand on land', () => {
  const group = buildLandmarks(() => 12, { waterAt: () => 7, rinkLevel: 10 });
  expect(group.getObjectByName('Gapstow Bridge')!.position.y).toBe(7);
  expect(group.getObjectByName('The Dairy')!.position.y).toBe(12);
  expect(group.getObjectByName('Wollman Rink')!.position.y).toBe(10);
  dispose(group);
});

test('Wollman has upward-facing geometry covering the footprint, on a level graded site', () => {
  const s = PARK_SITES.wollman;
  const ground = (x: number, z: number) => 10 + (x - s.x) * .06 + (z - s.z) * .03;
  const grade = createWollmanGrade(ground);
  const rink = buildWollmanRink(grade.level);
  const surface = rink.getObjectByName('wollman-mapped-surface') as THREE.Mesh;
  rink.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(); let samples = 0;
  for (let x = s.x - 40; x <= s.x + 40; x += 5) for (let z = s.z - 40; z <= s.z + 40; z += 5) {
    if (!inSite(x, z, s.ring)) continue;
    expect(grade.heightAt(x, z, ground(x, z))).toBeCloseTo(grade.level);
    ray.set(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(surface)[0]!.point.y).toBeCloseTo(grade.level + .1, 4);
    samples++;
  }
  expect(samples).toBeGreaterThan(80);
  expect(grade.heightAt(s.x + 150, s.z, 99)).toBe(99);
  expect(grade.heightAt(s.x, s.z, 99)).toBe(grade.level);
  dispose(rink);
});

test('planting excludes mapped structures and paths across spatial bucket boundaries', () => {
  const allowed = createParkPlantingMask([{ width: 4, pts: [-50, 15.9, 50, 15.9] }]);
  for (const x of [-32.1, -16.1, -.1, 15.9, 31.9]) {
    expect(allowed(x, 16.2)).toBe(false);
    expect(allowed(x, 25)).toBe(true);
  }
  for (const key of ['wollman', 'dairy', 'chess', 'carousel', 'copCot', 'gapstow'] as const) {
    const s = PARK_SITES[key]; expect(allowed(s.x, s.z)).toBe(false);
  }
});

test('the mapped Gapstow axis agrees with the existing baked footway crossing', () => {
  const data = JSON.parse(readFileSync(new URL('../../public/assets/park/paths.json', import.meta.url), 'utf8'));
  const s = PARK_SITES.gapstow;
  const crossings = data.paths.filter(([, pts]: [number, number[]]) => {
    for (let i = 2; i < pts.length; i += 2) {
      const ax = pts[i - 2]! / 10 - s.x, az = pts[i - 1]! / 10 - s.z;
      const bx = pts[i]! / 10 - s.x, bz = pts[i + 1]! / 10 - s.z;
      if (Math.hypot(ax, az) < 20 && Math.hypot(bx, bz) < 20 && Math.hypot(bx - ax, bz - az) > 10) {
        const cross = Math.abs((bx - ax) * GAPSTOW_LAYOUT.dz - (bz - az) * GAPSTOW_LAYOUT.dx) / Math.hypot(bx - ax, bz - az);
        if (cross < .12) return true;
      }
    }
    return false;
  });
  expect(crossings.length).toBeGreaterThan(0);
});


test('Gapstow earthen approaches reach the deck without filling its arch', () => {
  const s = PARK_SITES.gapstow, layout = GAPSTOW_LAYOUT;
  const crossing = createGapstowCrossing(7);
  for (const sign of [-1, 1]) {
    const x = s.x + sign * layout.dx * layout.length / 2;
    const z = s.z + sign * layout.dz * layout.length / 2;
    expect(crossing.grade(x, z, 7)).toBeCloseTo(7 + gapstowDeckAt(layout.length / 2), 5);
    const outside = layout.length / 2 + 13;
    expect(crossing.grade(s.x + sign * layout.dx * outside, s.z + sign * layout.dz * outside, 8)).toBe(8);
  }
  expect(crossing.grade(s.x, s.z, 6)).toBe(6);
  expect(crossing.deckAt(s.x, s.z)).toBeCloseTo(11.05);
  expect(crossing.deckAt(s.x - layout.dz * 8, s.z + layout.dx * 8)).toBeNull();
});


test('the mapped Hallett woodland restores canopy without turning the Pond into a forest', () => {
  const s = PARK_SITES.hallett;
  expect(hallettWoodlandAt(s.x, s.z)).toBe(1);
  expect(hallettWoodlandAt(s.x + 200, s.z)).toBe(0);
  for (const p of s.ring) expect(hallettWoodlandAt(p.x, p.z)).toBeCloseTo(0, 5);
});

test('a mapped walk opens the rink perimeter instead of ending at a railing', () => {
  const site = PARK_SITES.wollman, a = site.ring[0]!, b = site.ring[1]!;
  const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2;
  const n = new THREE.Vector3(x - site.x, 0, z - site.z).normalize();
  const closed = buildWollmanRink(0);
  const open = buildWollmanRink(0, [{ width: 8, pts: [x - n.x * 6, z - n.z * 6, x + n.x * 6, z + n.z * 6] }]);
  closed.updateMatrixWorld(true); open.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(x + n.x * 3, 1.02, z + n.z * 3), n.clone().negate(), 0, 6);
  expect(ray.intersectObject(closed, true).length).toBeGreaterThan(0);
  expect(ray.intersectObject(open, true)).toHaveLength(0);
  dispose(closed); dispose(open);
});
