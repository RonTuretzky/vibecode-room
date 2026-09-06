import { expect, test } from 'bun:test';
import { parkProjectSlots } from './park-project-layout';

const ground = { canPlant: () => true, groundAt: (x: number, z: number) => x * .05 + z * .1 };

test('park projects retain familiar spacing and grow compactly without rearranging earlier roots', () => {
  const small = parkProjectSlots(5, ground), large = parkProjectSlots(64, ground);
  expect(small.map(p => p.x)).toEqual([0, -13, 13, -26, 26]);
  expect(large.slice(0, 5)).toEqual(small);
  expect(large.slice(0, 32)).toEqual(parkProjectSlots(32, ground));
  expect(large).toHaveLength(64);
  expect(Math.max(...large.map(p => Math.hypot(p.x, p.z)))).toBeLessThan(85);
  for (let i = 0; i < large.length; i++) for (let j = i + 1; j < large.length; j++) {
    expect(Math.hypot(large[i]!.x - large[j]!.x, large[i]!.z - large[j]!.z)).toBeGreaterThanOrEqual(13 - 1e-6);
  }
});

test('project roots use real heights and avoid unsuitable terrain and chosen planting positions', () => {
  const reserved = [{ x: 0, z: -3.2 }, { x: -26, z: 8 }];
  const source = { ...ground, canPlant: (x: number, z: number) => z > -18 && Math.abs(x - 10) > 4 };
  const roots = parkProjectSlots(64, source, reserved);
  expect(roots).toHaveLength(64);
  for (const p of roots) {
    expect(source.canPlant(p.x, p.z)).toBe(true);
    expect(p.y).toBe(source.groundAt(p.x, p.z));
    for (const fixed of reserved) expect(Math.hypot(p.x - fixed.x, p.z - fixed.z)).toBeGreaterThanOrEqual(13 - 1e-6);
  }
  expect(parkProjectSlots(0, ground)).toEqual([]);
  expect(parkProjectSlots(1, { ...ground, canPlant: () => false })).toEqual([]);
});
