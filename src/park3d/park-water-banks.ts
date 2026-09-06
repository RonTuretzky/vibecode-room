export interface WaterBankSegment { ax: number; az: number; bx: number; bz: number; level: number }
const smooth = (v: number) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };

/** Follow the actual clipped contour rather than an axis-biased flood grid.
 * Buckets bound the work to a small neighbourhood of each shoreline query. */
export function createWaterBankSampler(segments: readonly WaterBankSegment[], source: {
  waterAt: (x: number, z: number) => number;
  surfaceAt: (x: number, z: number) => number | null;
  groundAt: (x: number, z: number) => number;
}) {
  const reach = 14, bucketSize = 8, buckets = new Map<string, WaterBankSegment[]>();
  for (const s of segments) {
    for (let ix = Math.floor((Math.min(s.ax, s.bx) - reach) / bucketSize); ix <= Math.floor((Math.max(s.ax, s.bx) + reach) / bucketSize); ix++) {
      for (let iz = Math.floor((Math.min(s.az, s.bz) - reach) / bucketSize); iz <= Math.floor((Math.max(s.az, s.bz) + reach) / bucketSize); iz++) {
        const key = `${ix},${iz}`, bucket = buckets.get(key) ?? []; bucket.push(s); buckets.set(key, bucket);
      }
    }
  }
  return (x: number, z: number): number | null => {
    const wet = source.waterAt(x, z);
    if (wet >= .5) {
      const level = source.surfaceAt(x, z);
      return level == null ? null : level - .01 - smooth((wet - .5) / .5) * 1.1;
    }
    let nearest = reach * reach, level: number | null = null;
    for (const s of buckets.get(`${Math.floor(x / bucketSize)},${Math.floor(z / bucketSize)}`) ?? []) {
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (dx * dx + dz * dz || 1)));
      const distance = (x - s.ax - t * dx) ** 2 + (z - s.az - t * dz) ** 2;
      if (distance < nearest) { nearest = distance; level = s.level; }
    }
    if (level == null) return null;
    let run = Math.sqrt(nearest);
    if (run < 2 && wet > 0) {
      // A bilinear mask curves between the clipped triangle edges. Its
      // local gradient brings the grade to the exact wet contour instead
      // of introducing a centimetre-scale jump at that approximation.
      const dx = (source.waterAt(x + .25, z) - source.waterAt(x - .25, z)) * 2;
      const dz = (source.waterAt(x, z + .25) - source.waterAt(x, z - .25)) * 2;
      const gradient = Math.hypot(dx, dz);
      if (gradient > .001) run = Math.min(run, (.5 - wet) / gradient);
    }
    const bank = level - .01 + run * .42 + run * run * .025;
    // Do not leave a hard cutoff at the end of the grading footprint. The
    // caller still uses this as an upper bound when carving the dry terrain.
    const blend = smooth((run - 10) / 4);
    return blend === 0 ? bank : bank + (source.groundAt(x, z) - bank) * blend;
  };
}
