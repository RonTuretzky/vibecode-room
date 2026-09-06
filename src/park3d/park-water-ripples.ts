// A periodic wave spectrum with phase distortion. Integer frequencies keep
// the tile seamless; varied directions/phases break the old diagonal grating.
const TAU = Math.PI * 2;
const waves = [[3, 1], [4, -1], [5, 2], [6, -3], [7, 1], [9, 2], [10, -4], [12, 5],
  [13, -2], [15, 4], [2, 5], [-3, 7], [4, 8], [6, 11], [-4, 13], [3, 16]]
  .map(([x, y], i) => ({ x: x!, y: y!, amplitude: .16 / Math.pow(Math.hypot(x!, y!), 1.5),
    phase: (i * 2.399963229728653 + .73) % TAU, warp: .4 + (i % 5) * .23 }));

/** Unit tangent-space normal for a point in the repeated texture domain. */
export function sampleWaterRipple(u: number, v: number): { x: number; y: number; z: number } {
  const a = TAU * (u + v) + .8, b = TAU * (2 * u - v) + 2.1;
  const warp = .7 * Math.sin(a) + .4 * Math.sin(b);
  const du = TAU * (.7 * Math.cos(a) + .8 * Math.cos(b));
  const dv = TAU * (.7 * Math.cos(a) - .4 * Math.cos(b));
  let dx = 0, dy = 0;
  for (const wave of waves) {
    const c = Math.cos(TAU * (wave.x * u + wave.y * v) + wave.phase + wave.warp * warp) * wave.amplitude;
    dx += c * (TAU * wave.x + wave.warp * du);
    dy += c * (TAU * wave.y + wave.warp * dv);
  }
  dx *= .16; dy *= .16;
  const length = Math.hypot(dx, dy, 1);
  return { x: -dx / length, y: -dy / length, z: 1 / length };
}
