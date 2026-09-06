// Geographic control points, retained locally with OSM IDs/revisions. Model
// detail is still interpretive; locations and footprints come from this data.
import siteData from './data/south-park-sites.json';
import { DEG, localFromLatLon } from './park-frame';

export type ParkSiteKey = keyof typeof siteData.features;
export interface SitePoint { x: number; z: number }
export interface ParkSite {
  name: string; osmWay: number; version: number; modified: string;
  coordinates: number[][]; heightM?: number;
  lat: number; lon: number; x: number; z: number; ring: SitePoint[];
}
export const PARK_SITES = Object.fromEntries(Object.entries(siteData.features).map(([key, feature]) => {
  const coordinates = feature.coordinates;
  const lat = (Math.min(...coordinates.map(p => p[1]!)) + Math.max(...coordinates.map(p => p[1]!))) / 2;
  const lon = (Math.min(...coordinates.map(p => p[0]!)) + Math.max(...coordinates.map(p => p[0]!))) / 2;
  const ring = coordinates.map(([lon, lat]) => localFromLatLon(lat!, lon!));
  if (ring.length > 2 && ring[0]!.x === ring.at(-1)!.x && ring[0]!.z === ring.at(-1)!.z) ring.pop();
  return [key, { ...feature, lat, lon, ...localFromLatLon(lat, lon), ring }];
})) as Record<ParkSiteKey, ParkSite>;

export function inSite(x: number, z: number, ring: readonly SitePoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(x: number, z: number, a: SitePoint, b: SitePoint): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - a.x - t * dx, z - a.z - t * dz);
}

export function siteDistance(x: number, z: number, ring: readonly SitePoint[]): number {
  let distance = Infinity;
  for (let i = 0; i < ring.length; i++) distance = Math.min(distance, distanceToSegment(x, z, ring[i]!, ring[(i + 1) % ring.length]!));
  return inSite(x, z, ring) ? -distance : distance;
}

// Use the long edge of the actual bridge outline, not a Manhattan-grid guess.
export const GAPSTOW_LAYOUT = (() => {
  const site = PARK_SITES.gapstow;
  let dx = 1, dz = 0, longest = 0;
  site.ring.forEach((a, i) => {
    const b = site.ring[(i + 1) % site.ring.length]!, length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length > longest) { longest = length; dx = (b.x - a.x) / length; dz = (b.z - a.z) / length; }
  });
  if (dx < 0) { dx = -dx; dz = -dz; }
  const along = site.ring.map(p => (p.x - site.x) * dx + (p.z - site.z) * dz);
  const across = site.ring.map(p => -(p.x - site.x) * dz + (p.z - site.z) * dx);
  return { length: Math.max(...along) - Math.min(...along), width: Math.max(...across) - Math.min(...across),
    bearing: 180 - Math.atan2(-dz, dx) / DEG, dx, dz };
})();

/** Keep photoscans off mapped buildings, the rink and path surfaces. Spatial
 * buckets avoid scanning the entire park's 1,800 walks for every plant. */
export function createParkPlantingMask(lines: readonly { width: number; pts: number[] }[]): (x: number, z: number, clearance?: number) => boolean {
  const cell = 16;
  const buckets = new Map<string, { a: SitePoint; b: SitePoint; half: number }[]>();
  for (const line of lines) for (let i = 2; i < line.pts.length; i += 2) {
    const a = { x: line.pts[i - 2]!, z: line.pts[i - 1]! }, b = { x: line.pts[i]!, z: line.pts[i + 1]! }, half = line.width / 2;
    const pad = half + 3;
    for (let x = Math.floor((Math.min(a.x, b.x) - pad) / cell); x <= Math.floor((Math.max(a.x, b.x) + pad) / cell); x++) {
      for (let z = Math.floor((Math.min(a.z, b.z) - pad) / cell); z <= Math.floor((Math.max(a.z, b.z) + pad) / cell); z++) {
        const key = `${x},${z}`, bucket = buckets.get(key) ?? [];
        bucket.push({ a, b, half }); buckets.set(key, bucket);
      }
    }
  }
  const sites = ['wollman', 'dairy', 'chess', 'carousel', 'copCot', 'gapstow', 'arsenal'] as const;
  const masks = sites.map(key => {
    const site = PARK_SITES[key];
    return { site, radius: Math.max(...site.ring.map(p => Math.hypot(p.x - site.x, p.z - site.z))) + 6 };
  });
  return (x, z, clearance = 1) => {
    for (const { site, radius } of masks) {
      if (Math.hypot(x - site.x, z - site.z) < radius && siteDistance(x, z, site.ring) < clearance + (site === PARK_SITES.wollman ? 3 : 0)) return false;
    }
    return !(buckets.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []).some(s => distanceToSegment(x, z, s.a, s.b) < s.half + Math.min(clearance, 3));
  };
}

const hallett = PARK_SITES.hallett;
const hallettReach = Math.max(...hallett.ring.map(p => Math.hypot(p.x - hallett.x, p.z - hallett.z))) + 4;
/** The photo classifier mistakes sunlit woodland for lawn. The mapped
 * sanctuary supplies woodland coverage, with a soft four-metre inner edge. */
export function hallettWoodlandAt(x: number, z: number): number {
  if (Math.hypot(x - hallett.x, z - hallett.z) > hallettReach) return 0;
  const t = Math.max(0, Math.min(1, -siteDistance(x, z, hallett.ring) / 4));
  return t * t * (3 - 2 * t);
}
