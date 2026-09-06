import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { insidePark, localFromLatLon, POND_STAGE } from './park-frame';
import { insideParkOutline, PARK_OUTLINE, distanceToParkBoundary } from './park-outline';
import { buildParkStreets, streetLookup, streetSegments, streetWidth, type StreetSegment, type StreetWay } from './park-streets';
import { glassBuilding } from './park-facades';
import { buildBuildings } from './park-world';
import { refreshSouthWalks, type ParkStreetData } from './park-walks';
import { PARK_SITES } from './park-sites';

// Parse the asset at runtime rather than asking TypeScript to infer a huge
// structural type for every captured OSM tag combination.
const data = JSON.parse(readFileSync(new URL('../../public/assets/park/streets.json', import.meta.url), 'utf8')) as ParkStreetData;

describe('mapped park boundary', () => {
  test('the eastern lawn follows the mapped boundary rather than the crop rectangle', () => {
    expect(insidePark(-361.65, 1565.95)).toBe(false);
    expect(insideParkOutline(-361.65, 1565.95)).toBe(true);
    expect(insideParkOutline(POND_STAGE.x, POND_STAGE.z, -4)).toBe(true);
    const plaza = localFromLatLon(40.76455, -73.974);
    expect(insideParkOutline(plaza.x, plaza.z)).toBe(false);
  });

  test('padding expands and contracts the boundary consistently across spatial bucket edges', () => {
    const line = new THREE.Line3(), point = new THREE.Vector3(), nearest = new THREE.Vector3();
    for (let i = 0; i < PARK_OUTLINE.length - 1; i += 3) {
      const a = PARK_OUTLINE[i]!, b = PARK_OUTLINE[i + 1]!, length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1) continue;
      for (const offset of [-8, -.1, .1, 8]) {
        const x = (a.x + b.x) / 2 - (b.z - a.z) / length * offset;
        const z = (a.z + b.z) / 2 + (b.x - a.x) / length * offset;
        let distance = Infinity;
        point.set(x, 0, z);
        for (let k = 1; k < PARK_OUTLINE.length; k++) {
          line.start.set(PARK_OUTLINE[k - 1]!.x, 0, PARK_OUTLINE[k - 1]!.z);
          line.end.set(PARK_OUTLINE[k]!.x, 0, PARK_OUTLINE[k]!.z);
          line.closestPointToPoint(point, true, nearest); distance = Math.min(distance, nearest.distanceTo(point));
        }
        expect(distanceToParkBoundary(x, z)).toBeCloseTo(distance, 7);
        const inside = insideParkOutline(x, z);
        for (const pad of [-65, -6, 6, 65]) {
          expect(insideParkOutline(x, z, pad)).toBe(pad > 0 ? inside || distance <= pad : inside && distance >= -pad);
        }
      }
    }
  });
});

describe('city streets and walls', () => {
  test('carriageway dimensions use tags with bounded fallbacks', () => {
    expect(streetWidth({ width: '20', lanes: '4' })).toBe(20);
    expect(streetWidth({ lanes: '3', highway: 'secondary' })).toBeCloseTo(12.3);
    for (const tags of [{ width: 'bad' }, { width: '-4' }, { lanes: '99' }, { highway: 'service' }]) {
      expect(streetWidth(tags)).toBeGreaterThanOrEqual(3);
      expect(streetWidth(tags)).toBeLessThanOrEqual(40);
    }
  });

  test('intersection lookup opens crossing roads while preserving a straight sidewalk', () => {
    const horizontal: StreetSegment = { id: 1, ax: -100, az: 0, bx: 100, bz: 0, width: 12, lanes: 3, name: 'A', oneway: true, start: 0 };
    const vertical: StreetSegment = { ...horizontal, id: 2, ax: 0, az: -100, bx: 0, bz: 100 };
    const lookup = streetLookup([horizontal, vertical]);
    expect(lookup.occupied(0, 7, 1)).toBe(true);
    expect(lookup.occupied(20, 7, 1)).toBe(false);
    expect(lookup.occupied(0, 0, 1)).toBe(true);
    expect(lookup.occupied(49, 0, 2)).toBe(true);
    expect(lookup.occupied(-49, 0, 2)).toBe(true);
    expect(lookup.occupied(150, 150)).toBe(false);
  });

  test('the bundled road network stays outside the park and fits its geometry budget', () => {
    const bounds = { west: POND_STAGE.x - 1250, east: POND_STAGE.x + 1250, north: POND_STAGE.z - 1250, south: POND_STAGE.z + 1250 };
    const segments = streetSegments(data.ways, bounds);
    expect(segments.some(s => s.name === 'Central Park South')).toBe(true);
    expect(segments.some(s => s.name === '5th Avenue')).toBe(true);
    expect(segments.every(s => !insideParkOutline((s.ax + s.bx) / 2, (s.az + s.bz) / 2, -4))).toBe(true);
    const streets = buildParkStreets(data.ways, (x, z) => x * .001 + z * .002, bounds, []);
    let triangles = 0;
    for (const child of streets.group.children) {
      const mesh = child as THREE.Mesh, positions = mesh.geometry.getAttribute('position');
      triangles += mesh.geometry.index!.count / 3;
      expect(Array.from(positions.array).every(Number.isFinite)).toBe(true);
    }
    expect(triangles).toBeGreaterThan(1000);
    expect(triangles).toBeLessThan(60000);
    streets.dispose();
  });

  test('a tagged low wall retains its height and an intersecting walk leaves a real opening', () => {
    const coordinates = [[-73.96994, 40.76872], [-73.9698, 40.76891]];
    const way: StreetWay = { id: 1, tags: { barrier: 'wall', height: '.25' }, coordinates };
    const [a, b] = coordinates.map(([lon, lat]) => localFromLatLon(lat!, lon!));
    const x = (a!.x + b!.x) / 2, z = (a!.z + b!.z) / 2;
    const bounds = { west: x - 40, east: x + 40, north: z - 40, south: z + 40 };
    const make = (paths: { width: number; pts: number[] }[]) => buildParkStreets([way], () => 0, bounds, paths);
    const closed = make([]), open = make([{ width: 4, pts: [x - 20, z, x + 20, z] }]);
    expect(new THREE.Box3().setFromObject(closed.group).max.y).toBeCloseTo(.25);
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 10, z), new THREE.Vector3(0, -1, 0));
    closed.group.updateMatrixWorld(); open.group.updateMatrixWorld();
    expect(ray.intersectObject(closed.group, true).length).toBeGreaterThan(0);
    expect(ray.intersectObject(open.group, true).length).toBe(0);
    closed.dispose(); open.dispose();
  });
});

test('tall prewar buildings retain masonry while modern towers get glass', () => {
  expect(glassBuilding(250, 1930)).toBe(false);
  expect(glassBuilding(100, 1980)).toBe(true);
  expect(glassBuilding(200, 0)).toBe(true);
  const mesh = buildBuildings([[2500, 0, 1930, [0, 0, 200, 0, 200, 100, 0, 100]]], .1, () => 0);
  expect(mesh.geometry.groups[0]!.count).toBe(24);
  expect(mesh.geometry.groups[1]!.count).toBe(0);
  mesh.geometry.dispose(); (mesh.material as THREE.Material[]).forEach(m => m.dispose());
});

test('refreshed walks restore the perimeter, retain Gapstow, and meet the old network at the extract edge', () => {
  const north = localFromLatLon(data.walkBounds[2]!, data.walkBounds[1]!).z;
  const original = [{ width: 2.6, pts: [-500, north - 20, -500, north + 20] },
    { width: 8.5, pts: [-500, north + 20, -480, north + 40] }];
  const kept = refreshSouthWalks(original, { ...data, walks: [] } as ParkStreetData);
  expect(kept[0]!.pts).toEqual([-500, north - 20, -500, north]);
  expect(kept[1]).toBe(original[1]);
  const walks = refreshSouthWalks([], data as ParkStreetData);
  expect(walks.length).toBeGreaterThan(300);
  let gapstowDistance = Infinity, restored = 0;
  for (const walk of walks) {
    expect(walk.pts.every(Number.isFinite)).toBe(true);
    for (let i = 2; i < walk.pts.length; i += 2) {
      const x = (walk.pts[i - 2]! + walk.pts[i]!) / 2, z = (walk.pts[i - 1]! + walk.pts[i + 1]!) / 2;
      expect(insideParkOutline(x, z, 8)).toBe(true);
      if (!insidePark(x, z)) restored++;
      gapstowDistance = Math.min(gapstowDistance, Math.hypot(x - PARK_SITES.gapstow.x, z - PARK_SITES.gapstow.z));
    }
  }
  expect(gapstowDistance).toBeLessThan(3);
  expect(restored).toBeGreaterThan(100);
  expect(data.trees.length).toBeGreaterThan(50);
});
