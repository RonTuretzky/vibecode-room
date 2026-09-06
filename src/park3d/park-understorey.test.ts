import { expect, test } from 'bun:test';
import { understoreyGeometry, understoreyPlacements, type UnderstoreySource } from './park-understorey';

const source: UnderstoreySource = { groundAt: (x, z) => 10 + x * .02 + z * .03,
  canopyAt: () => 12, lawnAt: () => 0, waterAt: x => x < -40 ? 1 : 0,
  canPlant: (x, z, clearance) => Math.abs(z) > 3 + clearance };

test('understorey stays grounded in woodland, outside water, paths and the project clearing', () => {
  const plants = understoreyPlacements(source, { x: 0, z: 0 }, 100);
  expect(plants.length).toBeGreaterThan(100);
  expect(plants).toEqual(understoreyPlacements(source, { x: 0, z: 0 }, 100));
  for (const p of plants) {
    expect(p.x).toBeGreaterThanOrEqual(-38.5);
    expect(Math.abs(p.z)).toBeGreaterThan(3 + 1.5 * p.scale);
    expect(Math.hypot(p.x, p.z)).toBeGreaterThanOrEqual(48);
    expect(p.y).toBe(source.groundAt(p.x, p.z));
  }
  expect(understoreyPlacements({ ...source, lawnAt: () => 1 }, { x: 0, z: 0 }, 100)).toHaveLength(0);
  expect(understoreyPlacements({ ...source, groundAt: x => x * 2 }, { x: 0, z: 0 }, 100)).toHaveLength(0);
});

test('dense woodland is capped without favoring one map edge', () => {
  const plants = understoreyPlacements({ ...source, waterAt: () => 0, canPlant: () => true }, { x: 0, z: 0 });
  expect(plants).toHaveLength(900);
  expect(plants.filter(p => p.x > 0).length).toBeGreaterThan(250);
  expect(plants.filter(p => p.x < 0).length).toBeGreaterThan(250);
  expect(plants.filter(p => p.z > 0).length).toBeGreaterThan(250);
  expect(plants.filter(p => p.z < 0).length).toBeGreaterThan(250);
});

test('shrub forms use human-scale leaves and bounded geometry with finite normals', () => {
  for (const form of [0, 1]) {
    const geometry = understoreyGeometry(form);
    let triangles = 0;
    for (const g of [geometry.canopy, geometry.wood]) {
      g.computeBoundingBox();
      expect(g.boundingBox!.max.y).toBeLessThan(2.2);
      triangles += (g.index?.count ?? g.getAttribute('position').count) / 3;
      expect(Array.from(g.getAttribute('normal').array).every(Number.isFinite)).toBe(true);
      g.dispose();
    }
    expect(triangles).toBeLessThanOrEqual(300);
  }
});
