import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { localFromLatLon } from './park-frame';
import { refreshSouthWalks } from './park-walks';
import { createWalkGrade } from './park-walk-grade';
import { terrainSurfaceSampler } from './park-world';
import { buildWollmanFacilities, createWollmanFacilitiesGrade, WOLLMAN_CLUBHOUSE_HEIGHT } from './park-wollman-facilities';
import { PARK_SITES, WOLLMAN_PATIO, createParkPlantingMask, inSite } from './park-sites';

const site = PARK_SITES.wollmanClubhouse;
test('the clubhouse roof follows its curved footprint, supports walks and leaves the rink open', () => {
  const grade = createWollmanFacilitiesGrade(10), model = buildWollmanFacilities(10, () => 10);
  model.updateMatrixWorld(true);
  const roof = model.getObjectByName('wollman-overlook-roof')!;
  const ray = new THREE.Raycaster(); let samples = 0;
  for (let x = site.x - 55; x < site.x + 55; x += 2) for (let z = site.z - 40; z < site.z + 40; z += 2) {
    if (!inSite(x, z, site.ring)) continue;
    ray.set(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
    const hits = ray.intersectObject(roof);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.point.y).toBeCloseTo(grade.deckAt(x, z)!, 4);
    expect(grade.heightAt(x, z, 20)).toBeLessThanOrEqual(grade.roof);
    samples++;
  }
  expect(samples).toBeGreaterThan(100);
  expect(grade.roof).toBe(10 + WOLLMAN_CLUBHOUSE_HEIGHT);
  for (const p of site.ring) expect(grade.deckAt(p.x, p.z)).toBeCloseTo(grade.roof + .08);
  expect(grade.deckAt(PARK_SITES.wollman.x, PARK_SITES.wollman.z)).toBeNull();
  expect(grade.heightAt(site.x + 200, site.z, 123)).toBe(123);
  let triangles = 0;
  model.traverse(n => { if (n instanceof THREE.Mesh) {
    triangles += n.geometry.getAttribute('position').count / 3;
    expect(Array.from(n.geometry.getAttribute('position').array).every(Number.isFinite)).toBe(true);
    n.geometry.dispose(); (n.material as THREE.Material).dispose();
  } });
  expect(model.children.length).toBeLessThanOrEqual(4);
  expect(triangles).toBeLessThan(14000);
});

test('plants exclude the clubhouse and service footprints', () => {
  const plants = createParkPlantingMask([]);
  for (const site of [PARK_SITES.wollmanClubhouse, PARK_SITES.wollmanService]) {
    for (const p of site.ring) expect(plants(p.x, p.z)).toBe(false);
  }
  const grade = createWollmanFacilitiesGrade(10);
  expect(WOLLMAN_PATIO.length).toBeGreaterThan(10);
  for (const panel of WOLLMAN_PATIO) {
    const p = panel.reduce((sum, p) => ({ x: sum.x + p.x / 4, z: sum.z + p.z / 4 }), { x: 0, z: 0 });
    expect(plants(p.x, p.z)).toBe(false);
    expect(grade.heightAt(p.x, p.z, 99)).toBe(10);
  }
});

test('the actual overlook footway meets the roof without a height jump at either end', () => {
  const data = JSON.parse(readFileSync(new URL('../../public/assets/park/streets.json', import.meta.url), 'utf8'));
  const walk = data.walks.find((w: { id: number }) => w.id === 162154228);
  const points = walk.coordinates.map(([lon, lat]: number[]) => localFromLatLon(lat!, lon!));
  const grade = createWollmanFacilitiesGrade(10);
  const groundAt = (x: number, z: number) => grade.heightAt(x, z, 14);
  const walkGrade = createWalkGrade(refreshSouthWalks([], data), { groundAt,
    referenceAt: (x, z) => grade.deckAt(x, z) ?? groundAt(x, z),
    waterAt: () => 0, waterLevelAt: () => null, bridgeAt: grade.deckAt });
  const surface = (p: { x: number; z: number }) => grade.deckAt(p.x, p.z) ?? grade.heightAt(p.x, p.z, 14);
  let crossings = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const inside = inSite(a.x, a.z, site.ring);
    if (inside === inSite(b.x, b.z, site.ring)) continue;
    let low = 0, high = 1;
    for (let k = 0; k < 24; k++) {
      const t = (low + high) / 2, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      if (inSite(x, z, site.ring) === inside) low = t; else high = t;
    }
    const middle = (low + high) / 2, offset = .1 / Math.hypot(b.x - a.x, b.z - a.z);
    const p = (t: number) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    expect(Math.abs(surface(p(middle - offset)) - surface(p(middle + offset)))).toBeLessThan(.12);
    // Check actual triangles, at several grid phases. Continuous analytic
    // grades alone missed a 1.6–4.1 m drop caused by buried interior vertices.
    for (const phase of [0, .5, 1, 1.5]) {
      const meshSurface = (point: { x: number; z: number }) => {
        const deck = grade.deckAt(point.x, point.z); if (deck != null) return deck;
        const x = Math.floor((point.x - phase) / 2) * 2 + phase, z = Math.floor((point.z - phase) / 2) * 2 + phase;
        const geo = new THREE.PlaneGeometry(2, 2, 1, 1); geo.rotateX(-Math.PI / 2); geo.translate(x + 1, 0, z + 1);
        const positions = geo.getAttribute('position');
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i), z = positions.getZ(i);
          positions.setY(i, grade.constrainWalkAt(x, z, groundAt(x, z), walkGrade.heightAt(x, z)));
        }
        const result = terrainSurfaceSampler(positions, 1, 1, x, z, 2, 2, () => 14)(point.x, point.z);
        geo.dispose(); return result;
      };
      expect(Math.abs(meshSurface(p(middle - offset)) - meshSurface(p(middle + offset)))).toBeLessThan(.12);
    }
    crossings++;
  }
  expect(crossings).toBe(2);
});
