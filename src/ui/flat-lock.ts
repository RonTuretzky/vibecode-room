// FLAT-LOCKED CAMERA PAIR — pure math (the rig lives in RoomScene.tsx).
//
// The flat-wall sibling of corner-lock.ts. On the flat rig the two projector
// windows sit SIDE BY SIDE on ONE physical wall (no 90° corner — see
// docs/FLAT-WALL.md), so the pair must render one continuous
// picture the way a two-projector extended desktop does. Both windows put the
// camera at the SAME eye point with the SAME view direction; each window then
// renders ITS HALF of a single wide frustum via three.js
// PerspectiveCamera.setViewOffset — window 0 (wall A) the left half, window 1
// (wall B) the right half. Halves of one frustum share the projection plane,
// so the tiling is exact for coplanar projections: content sliding off A's
// right edge continues onto B's left edge with no kink. (The corner-lock
// trick — same eye, yawed frustums — would tile with a perspective bend at
// the seam here, because its two virtual image planes meet at an angle the
// physical wall doesn't have.)
//
// Unlike the corner pair there is no per-wall yaw step: the ONE shared yaw
// uses the same (-sin a, 0, -cos a) view-direction convention as RoomScene's
// orbit rig, and the seam (the shared frustum's vertical centre line) bisects
// the scene origin exactly like the corner rig's seam does.

import { cornerWallIndex } from "./corner-lock";

// Windows in the pair. flatWallIndex folds wall letters into [0, FLAT_SPAN):
// with the classic A+B pair, A is the left half and B the right half.
export const FLAT_SPAN = 2;

// Horizontal field of view of the COMBINED frustum (the whole flat wall).
// Split across two windows this is milder per window than the corner rig's
// 90° — coplanar projections stretch fast at high angles.
export const FLAT_TOTAL_HORIZONTAL_FOV_DEG = 110;

// The shared eye: same look height as the corner rig; further back, because
// the wide two-window strip (~32:9) is vertically shallow — the extra
// distance keeps the meadow + tree crown inside the panorama's vertical fov.
export const FLAT_EYE_HEIGHT = 4.6;
export const FLAT_EYE_DISTANCE = 20;

// The single shared yaw: 0 looks down -Z (RoomScene's convention), horizontal.
export const FLAT_YAW = 0;

// Wall letter → column in the panorama: "A"/null/unparseable → 0 (left),
// "B" → 1 (right), further letters folding modulo FLAT_SPAN.
export function flatWallIndex(wall: string | null | undefined): number {
  return cornerWallIndex(wall) % FLAT_SPAN;
}

// The (horizontal) shared view direction, in the rig's yaw convention.
export function flatViewDir(): { x: number; z: number } {
  return { x: -Math.sin(FLAT_YAW), z: -Math.cos(FLAT_YAW) };
}

// The shared eye point: FLAT_EYE_DISTANCE back from the scene origin along
// the view direction, so eye → origin IS the seam's centre line and the
// content splits half per window.
export function flatEye(): { x: number; y: number; z: number } {
  return {
    x: Math.sin(FLAT_YAW) * FLAT_EYE_DISTANCE,
    y: FLAT_EYE_HEIGHT,
    z: Math.cos(FLAT_YAW) * FLAT_EYE_DISTANCE,
  };
}

// This window's slice of the shared frustum, in setViewOffset's terms: the
// full image is FLAT_SPAN windows wide, and this window renders the column at
// its wall index. Passing each window's own pixel size keeps the mapping
// exact whatever the projector resolution (the pair is assumed same-sized —
// run-room.sh opens two identical fullscreen windows).
export function flatViewOffset(
  wall: string | null | undefined,
  width: number,
  height: number,
): { fullWidth: number; fullHeight: number; offsetX: number; offsetY: number; width: number; height: number } {
  return {
    fullWidth: FLAT_SPAN * width,
    fullHeight: height,
    offsetX: flatWallIndex(wall) * width,
    offsetY: 0,
    width,
    height,
  };
}

// three.js PerspectiveCamera.fov is VERTICAL, and under setViewOffset it
// describes the FULL combined frustum. Compute the vertical fov (deg) that
// yields EXACTLY the total horizontal fov at the given FULL-panorama aspect
// (FLAT_SPAN × the window aspect — setViewOffset itself sets camera.aspect to
// fullWidth/fullHeight). A degenerate aspect (0/NaN — a not-yet-laid-out
// window) falls back to the two-16:9-window strip.
export function flatVerticalFovDeg(fullAspect: number): number {
  const safeAspect =
    Number.isFinite(fullAspect) && fullAspect > 0 ? fullAspect : (FLAT_SPAN * 16) / 9;
  const halfHorizontal = (FLAT_TOTAL_HORIZONTAL_FOV_DEG * Math.PI) / 360;
  return (Math.atan(Math.tan(halfHorizontal) / safeAspect) * 360) / Math.PI;
}
