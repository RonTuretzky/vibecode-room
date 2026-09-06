import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { AXIS, localFromAlongAcross } from './park-frame';
import { PARK_SITES, ZOO_COURT, inSite, createParkPlantingMask } from './park-sites';
import { createZooGrade, ZOO_PAVILIONS } from './park-zoo-layout';
import { buildZoo } from './park-zoo';

function dispose(group: THREE.Group) {
  group.traverse(n => { if (n instanceof THREE.Mesh) { n.geometry.dispose(); (n.material as THREE.Material).dispose(); } });
}
test('Zoo roof surfaces cover the mapped complex while all three clock passages stay open', () => {
  const grade = createZooGrade(() => 10), model = buildZoo(() => 10, grade.courtLevel, grade.pavilionLevels);
  model.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(), ring = PARK_SITES.zooComplex.ring;
  let samples = 0;
  for (let x = Math.min(...ring.map(p => p.x)); x <= Math.max(...ring.map(p => p.x)); x += 2) {
    for (let z = Math.min(...ring.map(p => p.z)); z <= Math.max(...ring.map(p => p.z)); z += 2) {
      if (!inSite(x, z, ring)) continue;
      ray.set(new THREE.Vector3(x, 50, z), new THREE.Vector3(0, -1, 0)); ray.far = 100;
      const hits = ray.intersectObject(model);
      expect(hits.length).toBeGreaterThan(0); expect(hits[0]!.point.y).toBeGreaterThan(14); samples++;
    }
  }
  expect(samples).toBeGreaterThan(500);
  for (const offset of [-4.6, 0, 4.6]) {
    const start = localFromAlongAcross(-1673.2, 390 + offset);
    ray.set(new THREE.Vector3(start.x, 11.7, start.z), AXIS.clone()); ray.far = 12;
    expect(ray.intersectObject(model)).toHaveLength(0);
  }
  let triangles = 0;
  model.traverse(n => { if (n instanceof THREE.Mesh) {
    triangles += n.geometry.getAttribute('position').count / 3;
    expect(Array.from(n.geometry.getAttribute('position').array).every(Number.isFinite)).toBe(true);
  } });
  expect(model.children.length).toBe(8); expect(triangles).toBeLessThan(60000);
  dispose(model);
});

test('Zoo pavilions have finite source-contained sections and controlled ground grades', () => {
  const original = (x: number, z: number) => 10 + x * .03 + z * .02, grade = createZooGrade(original);
  const plants = createParkPlantingMask([]);
  for (const p of ZOO_PAVILIONS) {
    expect(p.ring.length).toBeGreaterThan(3);
    for (const v of p.worldRing) { expect(Number.isFinite(grade.heightAt(v.x, v.z, original(v.x, v.z)))).toBe(true); expect(plants(v.x, v.z)).toBe(false); }
  }
  const pool = PARK_SITES.zooPool;
  expect(grade.heightAt(pool.x, pool.z, 99)).toBeCloseTo(grade.courtLevel);
  expect(grade.constrainWalkAt(pool.x, pool.z, grade.courtLevel, 99)).toBeCloseTo(grade.courtLevel);
  for (const p of ZOO_COURT) expect(plants(p.x, p.z)).toBe(false);
  expect(grade.heightAt(0, 0, 99)).toBe(99);
});

test('the real DEM does not create a ridge between the Zoo court and its northern entrances', async () => {
  const { readFileSync } = await import('node:fs');
  const { makeSampler } = await import('./park-world');
  const root = new URL('../../public/assets/park/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  const bytes = readFileSync(new URL('dem.bin', root));
  const dem = makeSampler(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2), manifest.dem.cols, manifest.dem.rows,
    manifest.extent.halfEast, manifest.extent.halfNorth, 0, manifest.dem.unitM);
  const grade = createZooGrade(dem);
  for (const across of [340, 360, 377]) {
    let previous: number | null = null;
    for (let along = -1684; along < -1676; along += .1) {
      const p = localFromAlongAcross(along, across), y = grade.heightAt(p.x, p.z, dem(p.x, p.z));
      if (previous != null) expect(Math.abs(y - previous)).toBeLessThan(.03);
      previous = y;
    }
  }
});
