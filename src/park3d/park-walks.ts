import { localFromLatLon } from './park-frame';
import { insideParkOutline } from './park-outline';
import type { StreetWay } from './park-streets';

export interface ParkStreetData {
  ways: StreetWay[];
  walkBounds: number[];
  walks: StreetWay[];
  trees: { id: number; coordinates: number[]; height: string | null; genus: string | null }[];
}
export interface ParkWalk { width: number; pts: number[] }

/** Replace the old rectangle-clipped south-end walks. Split at the extract
 * bounds so the original northern network still joins the refreshed walks. */
export function refreshSouthWalks(original: ParkWalk[], data: ParkStreetData): ParkWalk[] {
  const [southLat, westLon, northLat, eastLon] = data.walkBounds;
  const nw = localFromLatLon(northLat!, westLon!), se = localFromLatLon(southLat!, eastLon!);
  const inBounds = (x: number, z: number) => x >= nw.x && x <= se.x && z >= nw.z && z <= se.z;
  const result: ParkWalk[] = [];
  const clip = (line: ParkWalk, keep: (x: number, z: number) => boolean, densify: boolean) => {
    let run: number[] = [];
    const flush = () => { if (run.length >= 4) result.push({ width: line.width, pts: run }); run = []; };
    for (let i = 2; i < line.pts.length; i += 2) {
      const ax = line.pts[i - 2]!, az = line.pts[i - 1]!, dx = line.pts[i]! - ax, dz = line.pts[i + 1]! - az;
      const cuts = [0, 1];
      for (const t of [(nw.x - ax) / dx, (se.x - ax) / dx, (nw.z - az) / dz, (se.z - az) / dz]) if (t > 0 && t < 1) cuts.push(t);
      if (densify) {
        const count = Math.ceil(Math.hypot(dx, dz) / 3);
        for (let k = 1; k < count; k++) cuts.push(k / count);
      }
      cuts.sort((a, b) => a - b);
      for (let k = 1; k < cuts.length; k++) {
        const t0 = cuts[k - 1]!, t1 = cuts[k]!, middle = (t0 + t1) / 2;
        if (keep(ax + dx * middle, az + dz * middle)) {
          if (!run.length) run.push(ax + dx * t0, az + dz * t0);
          run.push(ax + dx * t1, az + dz * t1);
        } else flush();
      }
    }
    flush();
  };
  for (const line of original) {
    // The new extract covers walks, not the park's drive network.
    if (line.width > 5.5) result.push(line);
    else clip(line, (x, z) => !inBounds(x, z), false);
  }
  for (const way of data.walks) {
    const fallback = way.tags.highway === 'pedestrian' ? 3.6 : way.tags.highway === 'cycleway' || way.tags.highway === 'bridleway' ? 3.4 : 2.6;
    const width = Math.min(9, Math.max(1.2, Number(way.tags.width) || fallback));
    const pts = way.coordinates.flatMap(([lon, lat]) => { const p = localFromLatLon(lat!, lon!); return [p.x, p.z]; });
    clip({ width, pts }, (x, z) => inBounds(x, z) && insideParkOutline(x, z, 8), true);
  }
  return result;
}
