import type { ParkWalk } from './park-walks';
import { walkSurface } from './park-walk-materials';

interface Segment { line: ParkWalk; ax: number; az: number; dx: number; dz: number; lengthSq: number; half: number }

/** Edging stops where another mapped walk enters. Look up whole segments in
 * spatial buckets so nearby junctions work even across a bucket boundary. */
export function walkJunctions(lines: ParkWalk[]) {
  const buckets = new Map<string, Segment[]>(), cell = 16;
  // One route owns the paving at a crossing. Wider routes continue through;
  // an explicit mapped finish wins ties, then source order makes it stable.
  const priority = new Map([...new Set(lines)].sort((a, b) => b.width - a.width || Number(!!b.surface) - Number(!!a.surface))
    .map((line, i) => [line, i]));
  for (const line of lines) for (let i = 2; i < line.pts.length; i += 2) {
    const ax = line.pts[i - 2]!, az = line.pts[i - 1]!, dx = line.pts[i]! - ax, dz = line.pts[i + 1]! - az;
    const lengthSq = dx * dx + dz * dz;
    // Only the other walk's core replaces this edge. Removing both margins
    // where two edges meet would leave small square holes at junction corners.
    const half = line.width / 2 - (walkSurface(line).hardEdge && line.kind !== 'steps' ? Math.min(.32, line.width * .2) : 0);
    if (lengthSq < .000001) continue;
    const segment = { line, ax, az, dx, dz, lengthSq, half };
    for (let x = Math.floor((Math.min(ax, ax + dx) - half) / cell); x <= Math.floor((Math.max(ax, ax + dx) + half) / cell); x++) {
      for (let z = Math.floor((Math.min(az, az + dz) - half) / cell); z <= Math.floor((Math.max(az, az + dz) + half) / cell); z++) {
        const key = `${x},${z}`, bucket = buckets.get(key) ?? []; bucket.push(segment); buckets.set(key, bucket);
      }
    }
  }
  return (line: ParkWalk, x: number, z: number, ownedOnly = false): boolean => {
    for (const s of buckets.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []) {
      if (s.line === line) continue;
      if (ownedOnly && (s.line.kind === 'steps' || priority.get(s.line)! > priority.get(line)!)) continue;
      const projection = ((x - s.ax) * s.dx + (z - s.az) * s.dz) / s.lengthSq;
      // Paving ribbons have flat end caps: their continuation cannot cut a
      // hole in a neighbour. Retain a tiny overlap to avoid a precision seam.
      if (projection < .00001 || projection > .99999) continue;
      const t = Math.max(0, Math.min(1, projection));
      if ((x - s.ax - s.dx * t) ** 2 + (z - s.az - s.dz * t) ** 2 < (s.half - .02) ** 2) return true;
    }
    return false;
  };
}
