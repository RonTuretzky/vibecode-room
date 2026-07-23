// SHARED CORNER-RIG OFFSETS — the ?span=1 cross-window camera channel.
//
// In the corner-locked pair the seam survives ANY camera move as long as both
// windows keep (a) the SAME eye point, (b) view yaws exactly 90° apart, and
// (c) a horizontal view direction (zero pitch — see corner-lock.ts). So the
// whole panorama may yaw about the vertical axis, crane up/down, and dolly
// in/out — provided both windows apply IDENTICAL offsets. The two wall windows
// are same-origin, so localStorage `storage` events give a drift-free absolute
// channel: the DRIVER window (wall index 0, the one whose PinchCameraLayer is
// authoritative) writes the offsets; every other window mirrors them. Mirrors
// never integrate deltas, so they cannot drift — a late-opened or briefly
// hidden window snaps to the exact shared pose.
//
// Pure math + storage glue only; the rig itself lives in RoomScene.tsx.

import {
  CORNER_EYE_DISTANCE,
  CORNER_EYE_HEIGHT,
  cornerWallIndex,
} from "./corner-lock";

export interface CornerRigOffsets {
  // Added to every window's locked yaw AND to the seam/eye azimuth: rotates
  // the whole panorama about the world Y axis through the scene origin.
  yaw: number;
  // Added to the shared eye height (view stays horizontal — seam-safe crane).
  height: number;
  // Multiplies the shared eye distance (seam-safe dolly).
  dist: number;
}

export const CORNER_RIG_STORAGE_KEY = "vibersyn.corner-rig";

export const CORNER_OFFSETS_ZERO: CornerRigOffsets = { yaw: 0, height: 0, dist: 1 };

// Absolute envelopes matching the free rig's clamps (orbitBy height [1.4,30],
// zoom radius [4,45]) so the corner pair can never be driven somewhere the
// mouse couldn't go.
const EYE_HEIGHT_MIN = 1.4;
const EYE_HEIGHT_MAX = 30;
const EYE_DIST_MIN = 4;
const EYE_DIST_MAX = 45;

// Clamp arbitrary (possibly non-finite / stale-storage) offsets into the safe
// envelope. Non-finite fields reset to the identity offset, not to NaN poses.
export function clampCornerOffsets(o: Partial<CornerRigOffsets> | null | undefined): CornerRigOffsets {
  const yaw = typeof o?.yaw === "number" && Number.isFinite(o.yaw) ? o.yaw : 0;
  const heightRaw = typeof o?.height === "number" && Number.isFinite(o.height) ? o.height : 0;
  const distRaw = typeof o?.dist === "number" && Number.isFinite(o.dist) && o.dist > 0 ? o.dist : 1;
  const height = Math.max(EYE_HEIGHT_MIN - CORNER_EYE_HEIGHT, Math.min(EYE_HEIGHT_MAX - CORNER_EYE_HEIGHT, heightRaw));
  const dist = Math.max(EYE_DIST_MIN / CORNER_EYE_DISTANCE, Math.min(EYE_DIST_MAX / CORNER_EYE_DISTANCE, distRaw));
  return { yaw, height, dist };
}

// The driver is the wall-index-0 window (wall "A" in the standard pair): the
// single authority that turns pinch/hand intents into shared offsets. Every
// other window mirrors. (Both windows receive the same hands stream; without a
// single driver each would integrate its own copy and double-apply.)
export function isCornerDriver(wall: string | null | undefined): boolean {
  return cornerWallIndex(wall) === 0;
}

export function readCornerOffsets(): CornerRigOffsets {
  if (typeof window === "undefined") {
    return { ...CORNER_OFFSETS_ZERO };
  }
  try {
    const raw = window.localStorage.getItem(CORNER_RIG_STORAGE_KEY);
    if (raw === null) {
      return { ...CORNER_OFFSETS_ZERO };
    }
    return clampCornerOffsets(JSON.parse(raw) as Partial<CornerRigOffsets>);
  } catch {
    return { ...CORNER_OFFSETS_ZERO }; // storage unavailable / corrupt JSON
  }
}

export function writeCornerOffsets(o: CornerRigOffsets): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(CORNER_RIG_STORAGE_KEY, JSON.stringify(o));
  } catch {
    // Best-effort: kiosk/private mode keeps the driver window working solo.
  }
}

// Mirror-side: fires with the clamped offsets whenever ANOTHER window writes
// them (localStorage `storage` events never fire in the writing window).
export function subscribeCornerOffsets(cb: (o: CornerRigOffsets) => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key !== CORNER_RIG_STORAGE_KEY || e.newValue === null) {
      return;
    }
    try {
      cb(clampCornerOffsets(JSON.parse(e.newValue) as Partial<CornerRigOffsets>));
    } catch {
      // Corrupt payload: keep the last good pose.
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
