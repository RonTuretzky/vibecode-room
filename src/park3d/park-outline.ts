import outline from './data/park-outline.json';
import { localFromLatLon } from './park-frame';

export const PARK_OUTLINE = outline.coordinates.map(([lon, lat]) => localFromLatLon(lat!, lon!));
const edges = PARK_OUTLINE.slice(1).map((b, i) => ({ a: PARK_OUTLINE[i]!, b }));
const bounds = {
  west: Math.min(...PARK_OUTLINE.map(p => p.x)), east: Math.max(...PARK_OUTLINE.map(p => p.x)),
  north: Math.min(...PARK_OUTLINE.map(p => p.z)), south: Math.max(...PARK_OUTLINE.map(p => p.z)),
};
const size = 64, rows = new Map<number, typeof edges>(), cells = new Map<string, typeof edges>();
for (const edge of edges) {
  for (let z = Math.floor(Math.min(edge.a.z, edge.b.z) / size); z <= Math.floor(Math.max(edge.a.z, edge.b.z) / size); z++) {
    const row = rows.get(z) ?? []; row.push(edge); rows.set(z, row);
  }
  for (let x = Math.floor((Math.min(edge.a.x, edge.b.x) - size) / size); x <= Math.floor((Math.max(edge.a.x, edge.b.x) + size) / size); x++) {
    for (let z = Math.floor((Math.min(edge.a.z, edge.b.z) - size) / size); z <= Math.floor((Math.max(edge.a.z, edge.b.z) + size) / size); z++) {
      const key = `${x},${z}`, cell = cells.get(key) ?? []; cell.push(edge); cells.set(key, cell);
    }
  }
}

function edgeDistanceSquared(x: number, z: number, candidates: typeof edges): number {
  let distance = Infinity;
  for (const { a, b } of candidates) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    distance = Math.min(distance, (x - a.x - dx * t) ** 2 + (z - a.z - dz * t) ** 2);
  }
  return distance;
}

export function distanceToParkBoundary(x: number, z: number): number {
  return Math.sqrt(edgeDistanceSquared(x, z, edges));
}

/** Real park outline for surface materials and planting. The rectangle in
 * park-frame remains the coordinate/crop frame, not the land boundary. */
export function insideParkOutline(x: number, z: number, pad = 0): boolean {
  const margin = Math.max(0, pad);
  if (x < bounds.west - margin || x > bounds.east + margin || z < bounds.north - margin || z > bounds.south + margin) return false;
  let inside = false;
  for (const { a, b } of rows.get(Math.floor(z / size)) ?? []) {
    if ((a.z > z) !== (b.z > z) && x < a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z)) inside = !inside;
  }
  if (pad === 0 || (pad > 0 && inside) || (pad < 0 && !inside)) return inside;
  const near = Math.abs(pad) > size ? edges : cells.get(`${Math.floor(x / size)},${Math.floor(z / size)}`) ?? [];
  const distance = edgeDistanceSquared(x, z, near);
  return pad > 0 ? distance <= pad * pad : distance >= pad * pad;
}
