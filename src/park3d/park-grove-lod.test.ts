import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { createGroveBaseRange, GROVE_DETAIL_LIMIT, selectGroveDetail } from './park-grove-lod';

const camera = new THREE.PerspectiveCamera(70, 1.5, .1, 1000);
function view(x = 0, z = 0) {
  camera.position.set(x, 3, z); camera.lookAt(x, 3, z - 1); camera.updateMatrixWorld();
  return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
}
const crown = (x: number, z: number) => new THREE.Sphere(new THREE.Vector3(x, 5, z), 5);

test('close tree detail follows the camera to another region within a fixed budget', () => {
  const trees = [0, 300].flatMap(x => Array.from({ length: 30 }, (_, i) => crown(x + i % 5 - 2, -20 - i * 1.1)));
  const initial = selectGroveDetail(trees, camera.position, view(), new Set());
  expect(initial.size).toBe(GROVE_DETAIL_LIMIT); expect([...initial].every(i => i < 30)).toBe(true);
  const next = selectGroveDetail(trees, camera.position, view(300), initial);
  expect(next.size).toBe(GROVE_DETAIL_LIMIT); expect([...next].every(i => i >= 30)).toBe(true);
  const back = selectGroveDetail(trees, camera.position, view(), next);
  expect(back).toEqual(initial);
});

test('retained trees have a distance grace band while behind-camera trees yield', () => {
  const trees = [crown(0, -70), crown(0, 20), crown(200, -20)];
  const selected = selectGroveDetail(trees, camera.position, view(), new Set());
  expect([...selected]).toEqual([0]);
  expect([...selectGroveDetail(trees, camera.position, view(0, 12), selected)]).toEqual([0]);
  expect(selectGroveDetail(trees, camera.position, view(0, 12), new Set()).size).toBe(0);
  expect(selectGroveDetail(trees, camera.position, view(0, 25), selected).has(0)).toBe(false);
});

test('a close competitor does not churn a full detail budget on small movements', () => {
  const trees = Array.from({ length: 17 }, (_, i) => crown(i === 16 ? .5 : 0, -30 - i * .01));
  const initial = selectGroveDetail(trees, camera.position, view(), new Set());
  expect(selectGroveDetail(trees, camera.position, view(.6), initial)).toEqual(initial);
});

test('merged root ranges disappear and restore exactly without touching neighboring roots', () => {
  for (const ArrayType of [Uint16Array, Uint32Array]) {
    const original = new ArrayType([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const index = new THREE.BufferAttribute(original.slice(), 1), range = createGroveBaseRange(index, 3, 6);
    range.setVisible(false);
    expect(Array.from(index.array)).toEqual([0, 1, 2, 3, 3, 3, 3, 3, 3, 9, 10, 11]);
    const version = index.version; range.setVisible(false); expect(index.version).toBe(version);
    expect(index.updateRanges).toEqual([{ start: 3, count: 6 }]);
    range.setVisible(true); expect(index.array).toEqual(original);
    for (let cycle = 0; cycle < 20; cycle++) { range.setVisible(false); range.setVisible(true); }
    expect(index.array).toEqual(original);
  }
});
