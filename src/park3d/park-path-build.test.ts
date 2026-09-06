import { expect, test } from 'bun:test';
import { buildPaths, buildPathsAsync } from './park-paths';
import type { ParkWalk } from './park-walks';
import * as THREE from 'three';

test('sliced park construction preserves junctions, shoreline clipping, stairs and material groups', async () => {
  const lines: ParkWalk[] = [
    { width: 4, pts: [-40, 0, 0, 4, 40, 0], surface: 'asphalt' },
    { width: 3, pts: [0, -30, 0, 30], surface: 'paving_stones' },
    { width: 2, pts: [25, 0, 30, 8], kind: 'steps' },
    { width: 2, pts: [-30, 0, -20, 20], surface: 'wood' },
  ];
  const ground = (x: number, z: number) => Math.sin(x * .1) * .2 + z * .12;
  const water = (x: number, z: number) => x < -28 && z > 7 ? 1 : 0;
  const sync = buildPaths(lines, ground, water)!;
  const sliced = (await buildPathsAsync(lines, ground, water))!;
  try {
    expect(sliced.userData.stairTreads).toBeGreaterThan(0);
    expect(sliced.userData).toEqual(sync.userData);
    expect(sliced.geometry.groups).toEqual(sync.geometry.groups);
    expect(sliced.geometry.index!.array).toEqual(sync.geometry.index!.array);
    for (const name of Object.keys(sync.geometry.attributes)) {
      expect(sliced.geometry.getAttribute(name).array, name).toEqual(sync.geometry.getAttribute(name).array);
    }
    expect(await buildPathsAsync([], ground, water)).toBeNull();
  } finally {
    for (const mesh of [sync, sliced]) {
      mesh.geometry.dispose();
      const materials = mesh.material as THREE.Material | THREE.Material[];
      (Array.isArray(materials) ? materials : [materials]).forEach(material => material.dispose());
    }
  }
});
