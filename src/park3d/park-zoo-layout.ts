import { alongAcross, localFromAlongAcross } from './park-frame';
import { PARK_SITES, ZOO_COURT, siteDistance, type SitePoint } from './park-sites';

/** X/Z here are park-axis along/across metres. Clipping separates the
 * connected mapped roof into pavilions and open galleries. Interior division
 * lines are inferred from the WCS visitor map, not surveyed room boundaries. */
export const zooAxisRing = (ring: readonly SitePoint[]) => ring.map(p => {
  const a = alongAcross(p.x, p.z); return { x: a.along, z: a.across };
});
export const zooWorldRing = (ring: readonly SitePoint[]) => ring.map(p => localFromAlongAcross(p.x, p.z));
export function clipZooRing(ring: readonly SitePoint[], axis: 'x' | 'z', edge: number, greater: boolean): SitePoint[] {
  const out: SitePoint[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const ia = greater ? a[axis] >= edge : a[axis] <= edge, ib = greater ? b[axis] >= edge : b[axis] <= edge;
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = (edge - a[axis]) / (b[axis] - a[axis]);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out.filter((p, i) => Math.hypot(p.x - out[(i + 1) % out.length]!.x, p.z - out[(i + 1) % out.length]!.z) > .001);
}
const complex = zooAxisRing(PARK_SITES.zooComplex.ring);
function section(x0: number, x1: number, z0: number, z1: number) {
  let r = clipZooRing(complex, 'x', x0, true); r = clipZooRing(r, 'x', x1, false);
  r = clipZooRing(r, 'z', z0, true); return clipZooRing(r, 'z', z1, false);
}
export const ZOO_PAVILIONS = [
  { name: 'Tropic Zone', ring: zooAxisRing(PARK_SITES.zooTropic.ring), height: 9.2, glassRoof: true },
  { name: 'Northern pavilion', ring: section(-1679, -1600, 324, 383), height: 9.2 },
  { name: 'Western habitat pavilion', ring: section(-1693, -1679, 295, 335), height: 6.4 },
  { name: 'Eastern theater pavilion', ring: section(-1680, -1640, 398, 440), height: 8.4 },
  { name: 'Southern guest pavilion', ring: section(-1785, -1761, 343, 384), height: 7.2 },
  { name: 'Cafe pavilion', ring: section(-1850, -1790, 290, 385), height: 7.2 },
  { name: 'Gift shop pavilion', ring: zooAxisRing(PARK_SITES.zooGift.ring), height: PARK_SITES.zooGift.heightM ?? 9.1 },
  { name: 'Ticket pavilion', ring: zooAxisRing(PARK_SITES.zooTickets.ring), height: PARK_SITES.zooTickets.heightM ?? 6.5 },
].map(p => ({ ...p, worldRing: zooWorldRing(p.ring) }));

export function createZooGrade(groundAt: (x: number, z: number) => number) {
  const courtLevel = groundAt(PARK_SITES.zooPool.x, PARK_SITES.zooPool.z);
  const parts = [{ ring: ZOO_COURT, level: courtLevel }, ...ZOO_PAVILIONS.map(p => {
    const heights = p.worldRing.map(v => groundAt(v.x, v.z)).sort((a, b) => a - b);
    return { ring: p.worldRing, level: heights[Math.floor(heights.length / 2)]! };
  })].map(p => {
    const x = p.ring.reduce((s, v) => s + v.x, 0) / p.ring.length, z = p.ring.reduce((s, v) => s + v.z, 0) / p.ring.length;
    return { ...p, x, z, reach: Math.max(...p.ring.map(v => Math.hypot(v.x - x, v.z - z))) + 5 };
  });
  // The pavilions facing the formal court share its entrance level. Treating
  // each 8 m DEM median as an independent floor put a 2–3 m climb in the
  // narrow gap between the paving and the northern doors. Exterior terrain
  // feathers into this modeled built level; outlying pavilions retain theirs.
  for (const index of [1, 2, 4]) parts[index + 1]!.level = courtLevel;
  function profileAt(x: number, z: number) {
    let influence = 0, weightedLevel = 0, weights = 0;
    for (const p of parts) {
      if (Math.hypot(x - p.x, z - p.z) > p.reach) continue;
      const d = siteDistance(x, z, p.ring);
      if (d <= 0) return { level: p.level, weight: 1 };
      if (d >= 4.8) continue;
      const t = Math.max(0, Math.min(1, (d - .8) / 4));
      influence += 1 - t * t * (3 - 2 * t);
      const fade = 1 - d / 4.8, weight = fade * fade / (d * d);
      weightedLevel += p.level * weight; weights += weight;
    }
    // Blend overlapping exterior aprons continuously. Choosing the closest
    // building alone introduced a 2 m step at the court's northern edge.
    // Two nearby aprons can fully cover the gap between them. Using only
    // the strongest feather left a hump of the original hill in that gap.
    return { level: weights ? weightedLevel / weights : 0, weight: Math.min(1, influence) };
  }
  return { courtLevel, pavilionLevels: parts.slice(1).map(p => p.level),
    heightAt(x: number, z: number, original: number) {
      const p = profileAt(x, z); return original + (p.level - original) * p.weight;
    },
    constrainWalkAt(x: number, z: number, graded: number, walk: number) {
      return walk + (graded - walk) * profileAt(x, z).weight;
    },
  };
}
