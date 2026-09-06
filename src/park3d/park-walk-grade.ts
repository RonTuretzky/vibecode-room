import type { ParkWalk } from './park-walks';

interface GradeSegment { ax: number; az: number; bx: number; bz: number; ay: number; by: number; half: number; reach: number }
export interface WalkGradeSource {
  groundAt: (x: number, z: number) => number;
  referenceAt: (x: number, z: number) => number;
  waterAt: (x: number, z: number) => number;
  waterLevelAt: (x: number, z: number) => number | null;
  bridgeAt?: (x: number, z: number) => number | null;
}
const smooth = (v: number) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };

/** Grade narrow walk corridors before triangulating the terrain. Crossfalls
 * should belong to the walk, not inherit a steep bank beside it. Heights are
 * modeled from the DEM, with a short smoothing window, not surveyed grades. */
export function createWalkGrade(lines: ParkWalk[], source: WalkGradeSource,
  bounds?: { west: number; east: number; north: number; south: number }) {
  const buckets = new Map<string, GradeSegment[]>(), cell = 16;
  let count = 0;
  for (const line of lines) {
    if (line.kind === 'bridge') continue;
    const points: { x: number; z: number; y: number; run: number }[] = [];
    let run = 0;
    for (let i = 2; i < line.pts.length; i += 2) {
      const ax = line.pts[i - 2]!, az = line.pts[i - 1]!, dx = line.pts[i]! - ax, dz = line.pts[i + 1]! - az;
      const length = Math.hypot(dx, dz), divisions = Math.max(1, Math.ceil(length / 2));
      if (length < .0001) continue;
      for (let k = 0; k < divisions; k++) {
        const x = ax + dx * k / divisions, z = az + dz * k / divisions;
        points.push({ x, z, y: source.referenceAt(x, z), run: run + length * k / divisions });
      }
      run += length;
    }
    if (line.pts.length < 4 || !points.length) continue;
    const x = line.pts.at(-2)!, z = line.pts.at(-1)!;
    points.push({ x, z, y: source.referenceAt(x, z), run });
    const heights = points.map((p, i) => {
      let sum = 0, weight = 0;
      for (let j = Math.max(0, i - 8); j <= Math.min(points.length - 1, i + 8); j++) {
        const other = points[j]!, w = Math.max(0, 1 - Math.abs(other.run - p.run) / 4);
        sum += other.y * w; weight += w;
      }
      const waterLevel = source.waterLevelAt(p.x, p.z);
      // A noisy bare-earth sample must not leave a dry shore walk submerged.
      return Math.max(sum / weight, waterLevel == null ? -Infinity : waterLevel + .18);
    });
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!, mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      if (source.waterAt(mx, mz) >= .5 || source.bridgeAt?.(mx, mz) != null) continue;
      if (bounds && (mx < bounds.west - 10 || mx > bounds.east + 10 || mz < bounds.north - 10 || mz > bounds.south + 10)) continue;
      // One extra metre of flat shoulder keeps the two-metre terrain grid
      // from reintroducing a cross-slope through the visible path surface.
      const half = line.width / 2 + 1, reach = half + 2.5;
      const segment = { ax: a.x, az: a.z, bx: b.x, bz: b.z, ay: heights[i - 1]!, by: heights[i]!, half, reach };
      for (let ix = Math.floor((Math.min(a.x, b.x) - reach) / cell); ix <= Math.floor((Math.max(a.x, b.x) + reach) / cell); ix++) {
        for (let iz = Math.floor((Math.min(a.z, b.z) - reach) / cell); iz <= Math.floor((Math.max(a.z, b.z) + reach) / cell); iz++) {
          const key = `${ix},${iz}`, bucket = buckets.get(key) ?? []; bucket.push(segment); buckets.set(key, bucket);
        }
      }
      count++;
    }
  }
  return { count,
    heightAt(x: number, z: number): number {
      const base = source.groundAt(x, z), wet = source.waterAt(x, z);
      if (wet >= .5 || source.bridgeAt?.(x, z) != null) return base;
      let height = 0, weights = 0, strongest = 0;
      for (const s of buckets.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []) {
        const dx = s.bx - s.ax, dz = s.bz - s.az;
        const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (dx * dx + dz * dz)));
        const distance = Math.hypot(x - s.ax - dx * t, z - s.az - dz * t);
        if (distance >= s.reach) continue;
        const weight = 1 - smooth((distance - s.half) / (s.reach - s.half));
        const y = s.ay + (s.by - s.ay) * t;
        height += y * weight; weights += weight; strongest = Math.max(strongest, weight);
      }
      if (weights === 0) return base;
      // Preserve the wet contour and bed instead of filling the Pond to
      // support a path whose source line runs close to the shore.
      const shoreFade = 1 - smooth((wet - .25) / .25);
      return base + (height / weights - base) * strongest * shoreFade;
    },
  };
}
