// CORNER-LOCKED CAMERA PAIR — pure math (the rig lives in RoomScene.tsx).
//
// In gesture mode the two projector windows (?gesture=1&wall=A|B) render ONE
// continuous 3D world wrapping the physical 90° room corner. Both windows put
// the camera at the SAME eye point with a HORIZONTAL view direction; only the
// yaw differs — exactly 90° per wall letter — and each window renders a
// symmetric frustum with exactly 90° HORIZONTAL field of view. Two such
// frustums tile seamlessly: wall A's right-edge view direction IS wall B's
// left-edge view direction, so content sliding off A's right edge continues
// onto B's left edge across the corner. (The horizontal view direction
// matters: symmetric frustums rotated about the camera's own up axis share an
// exact boundary plane only when up = world +Y, i.e. zero pitch.)
//
// Yaw convention matches RoomScene's orbit-rig angle: the view direction for
// yaw `a` is (-sin a, 0, -cos a) — yaw 0 looks down -Z — and the screen-right
// edge of a 90° window corresponds to yaw a - PI/4, the left edge to a + PI/4.
// Wall B sits to wall A's RIGHT in the physical corner, so its yaw steps by
// -PI/2 (a +90° turn about the vertical axis, clockwise seen from above).

// Each window's horizontal field of view: exactly a quarter turn, so the wall
// pair tiles the corner with no gap and no overlap.
export const CORNER_HORIZONTAL_FOV_DEG = 90;

// Shared base yaw (wall A). At +PI/4 the A/B seam (base - PI/4) sits at yaw 0,
// so the scene centre lands exactly ON the physical corner — the corner is the
// middle of the wrapped panorama, half the field on each wall.
export const CORNER_BASE_YAW = Math.PI / 4;

// Per-wall-letter yaw step: -90° (clockwise seen from above) per letter, so
// letters A→D tile the full 360° around the shared eye point.
export const CORNER_WALL_YAW_STEP = -Math.PI / 2;

// The shared eye point: fixed for every window of the pair. Height doubles as
// the look height (horizontal view — see above), distance places the eye far
// enough back that the whole meadow/nebula reads across both walls.
export const CORNER_EYE_HEIGHT = 4.6;
export const CORNER_EYE_DISTANCE = 15.5;

// The A/B seam yaw: halfway between the two walls' view directions.
export const CORNER_SEAM_YAW = CORNER_BASE_YAW + CORNER_WALL_YAW_STEP / 2;

// Wall letter → pair index: "A"/null/unparseable → 0, "B" → 1, …, wrapping
// modulo 4 (four 90° windows tile the full turn).
export function cornerWallIndex(wall: string | null | undefined): number {
  if (wall === null || wall === undefined || wall.trim().length === 0) {
    return 0;
  }
  const step = wall.trim().toUpperCase().charCodeAt(0) - 65; // "A" → 0, "B" → 1, …
  if (!Number.isFinite(step) || step <= 0) {
    return 0;
  }
  return step % 4;
}

// This window's locked yaw: one shared base constant plus the per-wall step.
export function cornerYaw(wall: string | null | undefined): number {
  return CORNER_BASE_YAW + cornerWallIndex(wall) * CORNER_WALL_YAW_STEP;
}

// The (horizontal) view direction for a yaw, in the rig's convention.
export function cornerViewDir(yaw: number): { x: number; z: number } {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

// The shared eye point, placed so the direction from eye to the scene origin
// is exactly the A/B seam direction (the corner bisects the content).
export function cornerEye(): { x: number; y: number; z: number } {
  return {
    x: Math.sin(CORNER_SEAM_YAW) * CORNER_EYE_DISTANCE,
    y: CORNER_EYE_HEIGHT,
    z: Math.cos(CORNER_SEAM_YAW) * CORNER_EYE_DISTANCE,
  };
}

// three.js PerspectiveCamera.fov is VERTICAL. Compute the vertical fov (deg)
// that yields EXACTLY the 90° horizontal fov at the given aspect ratio:
//   hFov = 2·atan(tan(vFov/2)·aspect)  ⇒  vFov = 2·atan(tan(hFov/2)/aspect).
// A degenerate aspect (0/NaN — e.g. a not-yet-laid-out window) falls back to
// 16:9 so the camera is never handed a nonsense fov.
export function cornerVerticalFovDeg(aspect: number): number {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const halfHorizontal = (CORNER_HORIZONTAL_FOV_DEG * Math.PI) / 360;
  return (Math.atan(Math.tan(halfHorizontal) / safeAspect) * 360) / Math.PI;
}
