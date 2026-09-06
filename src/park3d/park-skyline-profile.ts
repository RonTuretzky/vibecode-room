export interface BuildingTier { top: number; scale: number }

/** Restrained, illustrative roof setbacks for simple tower footprints.
 * Heights/footprints remain data-driven; intricate lots and landmark models
 * retain their own geometry. These are not surveyed architectural models. */
export function skylineProfile(height: number, year: number, ring: readonly number[], enabled: boolean): BuildingTier[] {
  if (!enabled || height < 45 || ring.length !== 8) return [{ top: 1, scale: 1 }];
  let winding = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4, k = (i + 2) % 4;
    const cross = (ring[j * 2]! - ring[i * 2]!) * (ring[k * 2 + 1]! - ring[j * 2 + 1]!)
      - (ring[j * 2 + 1]! - ring[i * 2 + 1]!) * (ring[k * 2]! - ring[j * 2]!);
    if (cross === 0 || (winding && Math.sign(cross) !== winding)) return [{ top: 1, scale: 1 }];
    winding = Math.sign(cross);
  }
  return year > 0 && year < 1960
    ? [{ top: .73, scale: 1 }, { top: .9, scale: .84 }, { top: 1, scale: .67 }]
    : [{ top: .92, scale: 1 }, { top: 1, scale: .82 }];
}
