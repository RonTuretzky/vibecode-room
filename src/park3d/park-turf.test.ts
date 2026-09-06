import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { createParkTurf, turfGeometry, turfTile, type TurfSource } from './park-turf';

const source: TurfSource = { groundAt: (x, z) => x * .2 + z * .1, waterAt: x => x < 2 ? 1 : 0,
  canopyAt: () => 0, lawnAt: () => 1, canPlant: (_x, z, clearance) => z > 3 + clearance };

test('short turf follows slopes, stops at water and path margins, and repeats when revisited', () => {
  const patches = turfTile(source, 0, 0);
  expect(patches.length).toBeGreaterThan(100);
  expect(patches).toEqual(turfTile(source, 0, 0));
  for (const p of patches) {
    expect(p.x).toBeGreaterThanOrEqual(2);
    expect(p.z).toBeGreaterThan(3.18);
    expect(p.y).toBe(source.groundAt(p.x, p.z));
    expect(p.height).toBeGreaterThanOrEqual(.045);
    expect(p.height).toBeLessThan(.11);
  }
  expect(turfTile({ ...source, groundAt: x => x * 2 }, 0, 0)).toHaveLength(0);
  expect(turfTile({ ...source, canPlant: () => false }, 0, 0)).toHaveLength(0);
  expect(turfTile({ ...source, waterAt: () => .3 }, 0, 0)).toHaveLength(0);
});

test('turf geometry stays within its thirty-three-triangle budget with pointed, grounded blades', () => {
  const geometry = turfGeometry(), p = geometry.getAttribute('position');
  expect(geometry.index!.count / 3).toBeLessThanOrEqual(33);
  expect(Array.from(geometry.getAttribute('normal').array).every(Number.isFinite)).toBe(true);
  expect(Math.min(...Array.from({ length: p.count }, (_, i) => p.getY(i)))).toBe(0);
  expect(Math.max(...Array.from({ length: p.count }, (_, i) => p.getY(i)))).toBe(1);
  geometry.dispose();
});

test('long camera routes reuse a bounded turf pool and release every GPU resource', () => {
  const turf = createParkTurf({ ...source, groundAt: () => 0, canPlant: () => true, waterAt: () => 0 }, {
    toRoom: (x, y, z) => new THREE.Vector3(x, y, z), toPark: (x, z) => ({ x, z }),
  });
  const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 20, 0);
  turf.update(camera, 0, 0, false);
  expect(turf.allocatedTiles).toBe(0);
  expect(turf.group.visible).toBe(false);
  camera.position.y = 1.4;
  turf.update(camera, 0, 1, true);
  expect(turf.allocatedTiles).toBe(1);
  let time = 1;
  for (const [x, z] of [[0, 0], [500, -300], [-800, 700], [0, 0]]) {
    camera.position.set(x!, 1.4, z!);
    for (let i = 0; i < 30; i++) turf.update(camera, 0, ++time, true);
    expect(turf.allocatedTiles).toBe(25);
    expect(turf.group.userData.instances).toBeGreaterThan(20000);
    expect(turf.group.userData.instances).toBeLessThanOrEqual(25 * 4096);
  }
  let geometryDisposals = 0, materialDisposals = 0, instanceDisposals = 0;
  const mesh = turf.group.children[0] as THREE.InstancedMesh;
  mesh.geometry.addEventListener('dispose', () => geometryDisposals++);
  (mesh.material as THREE.Material).addEventListener('dispose', () => materialDisposals++);
  turf.group.children.forEach(m => m.addEventListener('dispose' as never, () => instanceDisposals++));
  turf.dispose(); turf.dispose();
  expect(geometryDisposals).toBe(1); expect(materialDisposals).toBe(1); expect(instanceDisposals).toBe(25);
  turf.update(camera, 0, ++time, true);
  expect(turf.allocatedTiles).toBe(25);
});
