import { expect, test } from 'bun:test';
import { sampleWaterRipple } from './park-water-ripples';

test('ripple normals remain seamless across tile edges and normalized for lighting', () => {
  for (let i = 0; i <= 32; i++) {
    const t = i / 32;
    for (const [a, b] of [[sampleWaterRipple(0, t), sampleWaterRipple(1, t)], [sampleWaterRipple(t, 0), sampleWaterRipple(t, 1)]]) {
      for (const key of ['x', 'y', 'z'] as const) expect(a![key]).toBeCloseTo(b![key], 7);
    }
    const p = sampleWaterRipple(t, t * .37);
    expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1, 7);
    expect(p.z).toBeGreaterThan(.9);
  }
});
