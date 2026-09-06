// Stop short of vertical so the camera keeps a stable up direction.
export const CAMERA_PITCH_LIMIT = Math.PI * 85 / 180;
export function clampCameraPitch(pitch: number): number {
  return Number.isFinite(pitch) ? Math.max(-CAMERA_PITCH_LIMIT, Math.min(CAMERA_PITCH_LIMIT, pitch)) : 0;
}

/** A manual tilt augments the existing orbit/preset framing without moving
 * its eye. Zero offset reproduces the original look-at point. */
export function orbitCameraPitch(height: number, lookY: number, radius: number, offset = 0): number {
  return clampCameraPitch(Math.atan2(lookY - height, Math.max(.1, radius)) + offset);
}
export function clampOrbitTilt(height: number, lookY: number, radius: number, offset: number): number {
  const base = Math.atan2(lookY - height, Math.max(.1, radius));
  return clampCameraPitch(base + offset) - base;
}
