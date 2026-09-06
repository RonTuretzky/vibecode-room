import { expect, test } from 'bun:test';
import { createWaterBankSampler, type WaterBankSegment } from './park-water-banks';

function circle(cx: number, cz: number, radius: number, level: number): WaterBankSegment[] {
  return Array.from({ length: 256 }, (_, i) => {
    const a = i * Math.PI / 128, b = (i + 1) * Math.PI / 128;
    return { ax: cx + Math.cos(a) * radius, az: cz + Math.sin(a) * radius,
      bx: cx + Math.cos(b) * radius, bz: cz + Math.sin(b) * radius, level };
  });
}
test('bank grades follow contour distance without a diagonal grid bias', () => {
  const bank = createWaterBankSampler(circle(0, 0, 8, 5), { groundAt: () => 30,
    waterAt: (x, z) => Math.max(0, Math.min(1, 8.5 - Math.hypot(x, z))), surfaceAt: () => 5 });
  for (const run of [.001, 1, 4, 8]) {
    const reference = bank(8 + run, 0)!;
    for (let a = 0; a < Math.PI * 2; a += .1) {
      expect(Math.abs(bank(Math.cos(a) * (8 + run), Math.sin(a) * (8 + run))! - reference)).toBeLessThan(.002);
    }
  }
  expect(bank(0, 0)).toBeLessThan(4);
});

test('a bank returns continuously to high surrounding ground at its outer boundary', () => {
  const bank = createWaterBankSampler(circle(0, 0, 8, 5), { groundAt: () => 30,
    waterAt: () => 0, surfaceAt: () => null });
  for (let a = 0; a < Math.PI * 2; a += .1) {
    const at = (r: number) => bank(Math.cos(a) * r, Math.sin(a) * r) ?? 30;
    expect(Math.abs(at(21.999) - at(22.001))).toBeLessThan(.001);
  }
  expect(bank(40, 0)).toBeNull();
});

test('translated shorelines retain the nearest water body level', () => {
  const bank = createWaterBankSampler([...circle(100, 200, 3, 5), ...circle(120, 200, 3, 15)], {
    groundAt: () => 30, waterAt: () => 0, surfaceAt: () => null,
  });
  expect(bank(104, 200)).toBeCloseTo(5.435);
  expect(bank(116, 200)).toBeCloseTo(15.435);
  expect(bank(0, 0)).toBeNull();
});
