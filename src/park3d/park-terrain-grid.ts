/** Dense near the project lawn and Pond; smoothly coarser toward the city.
 * The same axis is used for geometry and collision/placement interpolation. */
export function parkTerrainAxis(min: number, max: number, focus: number, step: number): number[] {
  const axis = [min];
  while (axis[axis.length - 1]! < max) {
    const current = axis[axis.length - 1]!;
    const distance = Math.abs(current - focus);
    const fade = Math.max(0, Math.min(1, (distance - 180) / 550));
    const stride = step + (Math.max(step, 18) - step) * fade * fade;
    axis.push(Math.min(max, current + stride));
  }
  return axis;
}

/** Fractional grid coordinate on a monotonically increasing nonuniform axis. */
export function terrainAxisCoordinate(axis: readonly number[], position: number): number {
  let low = 0, high = axis.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >>> 1;
    if (axis[mid]! > position) high = mid; else low = mid;
  }
  return low + (position - axis[low]!) / (axis[high]! - axis[low]!);
}
