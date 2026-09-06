import { GAPSTOW_LAYOUT, PARK_SITES } from './park-sites';

export function gapstowDeckAt(along: number): number {
  return 2.45 + 1.60 * (1 - (along / (GAPSTOW_LAYOUT.length / 2)) ** 2);
}

/** Reconcile metre-scale abutments with the 8 m bare-earth DEM. The mapped
 * masonry stops at the bridge footprint; short earthen approaches meet its
 * deck without filling the arch or inventing long stone ramps. */
export function createGapstowCrossing(waterLevel: number) {
  const site = PARK_SITES.gapstow, { dx, dz, length, width } = GAPSTOW_LAYOUT;
  const smooth = (a: number, b: number, v: number) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t);
  };
  const local = (x: number, z: number) => ({ along: (x - site.x) * dx + (z - site.z) * dz, across: -(x - site.x) * dz + (z - site.z) * dx });
  return {
    grade(x: number, z: number, original: number) {
      const { along, across } = local(x, z), a = Math.abs(along);
      // No bank grading beneath the 13.4 m clear arch.
      if (a < 7.2 || a > length / 2 + 12 || Math.abs(across) > width / 2 + 5) return original;
      const weight = smooth(7.2, length / 2 - .3, a) * (1 - smooth(length / 2, length / 2 + 12, a)) *
        (1 - smooth(width / 2, width / 2 + 5, Math.abs(across)));
      return original + (waterLevel + gapstowDeckAt(length / 2) - original) * weight;
    },
    deckAt(x: number, z: number): number | null {
      const { along, across } = local(x, z);
      return Math.abs(along) <= length / 2 && Math.abs(across) <= width / 2 - .45 ? waterLevel + gapstowDeckAt(along) : null;
    },
  };
}
