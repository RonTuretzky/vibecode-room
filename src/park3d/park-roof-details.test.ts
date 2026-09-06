import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { roofInset, buildRoofDetails } from './park-roof-details';
import { buildBuildings } from './park-buildings';
import { skylineProfile } from './park-skyline-profile';

const ring = [{ x: 0, z: 0 }, { x: 0, z: 20 }, { x: 30, z: 20 }, { x: 30, z: 0 }];
test('extra collinear footprint vertices preserve simple tower setbacks without shrinking concave lots', () => {
  const rectangle = [0, 0, 10, 0, 20, 0, 20, 10, 0, 10];
  expect(skylineProfile(90, 1930, rectangle, true)).toHaveLength(3);
  expect(skylineProfile(90, 2000, [0, 0, 18, 0, 20, 2, 20, 10, 0, 10], true)).toHaveLength(2);
  expect(skylineProfile(90, 1930, [0, 0, 20, 0, 20, 5, 5, 5, 5, 20, 0, 20], true)).toHaveLength(1);
});

test('a parapet stays within the mapped roof and leaves a genuinely recessed center', () => {
  const inner = roofInset(ring, .45)!;
  const details = buildRoofDetails([{ outer: ring, inner, deck: 98.95, top: 100, color: new THREE.Color(0xa69f91), glass: false, seed: 3 }])!;
  const box = new THREE.Box3().setFromObject(details);
  expect(box.min.x).toBe(0); expect(box.max.x).toBe(30); expect(box.max.y).toBeCloseTo(100);
  const ray = new THREE.Raycaster(new THREE.Vector3(.1, 120, 10), new THREE.Vector3(0, -1, 0));
  expect(ray.intersectObject(details)[0]!.point.y).toBeCloseTo(100);
  ray.set(new THREE.Vector3(15, 120, 10), new THREE.Vector3(0, -1, 0));
  expect(ray.intersectObject(details)).toHaveLength(0);
  const p = details.geometry.getAttribute('position'), n = details.geometry.getAttribute('normal');
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    normal.subVectors(b, a).cross(c.sub(a)).normalize();
    expect(normal.dot(a.fromBufferAttribute(n, i))).toBeGreaterThan(.999);
  }
  expect(p.count / 3).toBeLessThan(200);
  details.geometry.dispose(); (details.material as THREE.Material).dispose();
});

test('narrow and concave roofs do not create exterior or collapsed parapet corners', () => {
  const concave = [{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 4, z: 10 }, { x: 4, z: 4 }, { x: 10, z: 4 }, { x: 10, z: 0 }];
  for (const p of roofInset(concave, .45)!) expect(p.x < 4 || p.z < 4).toBe(true);
  const narrow = [{ x: 0, z: 0 }, { x: 0, z: .1 }, { x: 10, z: .1 }, { x: 10, z: 0 }];
  expect(roofInset(narrow, .45)).toBeNull();
});

test('roof detail respects landmark exclusions and the neighbourhood budget', () => {
  const row: [number, number, number, number[]] = [600, 0, 1930, ring.flatMap(p => [p.x * 10, p.z * 10])];
  const near = buildBuildings([row], .1, () => 0, { detail: true, focus: { x: 0, z: 0 } });
  const far = buildBuildings([row], .1, () => 0, { detail: true, focus: { x: 2000, z: 2000 } });
  const excluded = buildBuildings([row], .1, () => 0, { detail: true, exclude: [{ x: 15, z: 10, r: 30 }] });
  expect(near.getObjectByName('park-roof-details')).toBeDefined();
  expect(far.getObjectByName('park-roof-details')).toBeUndefined();
  expect(excluded.getObjectByName('park-roof-details')).toBeUndefined();
  expect(new THREE.Box3().setFromObject(near).max.y).toBeCloseTo(59.6);
  for (const root of [near, far, excluded]) root.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    node.geometry.dispose(); for (const m of Array.isArray(node.material) ? node.material : [node.material]) m.dispose();
  });
});
