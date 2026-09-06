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

/** Inferred patio panels between the clubhouse frontage and mapped rink.
 * Each frontage edge projects to the nearest rink edge; distant/back edges
 * are excluded. This fills the physical gap without replacing either outline. */
export const WOLLMAN_PATIO: SitePoint[][] = (() => {
  const club = PARK_SITES.wollmanClubhouse, rink = PARK_SITES.wollman;
  const tx = rink.x - club.x, tz = rink.z - club.z;
  const area = club.ring.reduce((s, a, i) => { const b = club.ring[(i + 1) % club.ring.length]!; return s + a.x * b.z - b.x * a.z; }, 0);
  const closest = (p: SitePoint) => {
    let best = { x: p.x, z: p.z }, distance = Infinity;
    for (let i = 0; i < rink.ring.length; i++) {
      const a = rink.ring[i]!, b = rink.ring[(i + 1) % rink.ring.length]!, dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      const x = a.x + t * dx, z = a.z + t * dz, d = Math.hypot(x - p.x, z - p.z);
      if (d < distance) { distance = d; best = { x, z }; }
    }
    return { point: best, distance };
  };
  return club.ring.flatMap((a, i) => {
    const b = club.ring[(i + 1) % club.ring.length]!, dx = b.x - a.x, dz = b.z - a.z;
    const facing = (area < 0 ? -dz * tx + dx * tz : dz * tx - dx * tz) / (Math.hypot(dx, dz) * Math.hypot(tx, tz));
    const ca = closest(a), cb = closest(b);
    return facing > .15 && Math.max(ca.distance, cb.distance) < 18 ? [[a, b, cb.point, ca.point]] : [];
  });
})();

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
  const sites = ['wollman', 'wollmanClubhouse', 'wollmanService', 'dairy', 'chess', 'carousel', 'copCot', 'gapstow', 'arsenal'] as const;
  const masks = sites.map(key => {
    const site = PARK_SITES[key];
    const extra = key === 'wollmanClubhouse' ? WOLLMAN_PATIO.flat() : [];
    return { site, radius: Math.max(...[...site.ring, ...extra].map(p => Math.hypot(p.x - site.x, p.z - site.z))) + 6 };
  });
  return (x, z, clearance = 1) => {
    for (const { site, radius } of masks) {
      if (site === PARK_SITES.wollmanClubhouse && Math.hypot(x - site.x, z - site.z) < radius && WOLLMAN_PATIO.some(ring => siteDistance(x, z, ring) < clearance)) return false;
      if (Math.hypot(x - site.x, z - site.z) < radius && siteDistance(x, z, site.ring) < clearance + (site === PARK_SITES.wollman || site === PARK_SITES.wollmanClubhouse ? 3 : 0)) return false;
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
