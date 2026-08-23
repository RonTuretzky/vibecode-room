// The Central Park frame shared by the park3d page (both the Google-tiles
// stream and the baked open-data world) and the room's ?env=park environment.
//
// Local frame: metres, +X east, +Y up, −Z north, origin on the park's centre
// line at ~85th St. The constants mirror scripts/fetch-park-data.py (the bake
// validates its manifest against them at load time).
//
// Why a frame module at all: the evaluation page started as ONE 20-block
// slab (110th→90th St) cropped by clipping planes; rendering the whole park
// means the crop, the camera presets and the data bake all have to agree on
// where the park is and which way it points.

import * as THREE from "three";

export const DEG = Math.PI / 180;

// Park centre — midpoint of the corner diagonals.
export const PARK_CENTER = { lat: 40.7829, lon: -73.9656 };
// Manhattan grid: the park's long axis runs ~29° east of true north.
export const AXIS_BEARING = 29 * DEG;
// 59th→110th St ≈ 4.08 km; 5th Ave→Central Park West ≈ 0.85 km.
export const PARK_HALF_LEN = 2040;
export const PARK_HALF_WIDTH = 424;

// The original evaluation slab (110th→90th St: North Woods, Harlem Meer, the
// Reservoir's north end) — kept verbatim so presets 1–6 keep answering the
// same "which altitudes look acceptable" question they were built for.
export const SEGMENT = { lat: 40.7922, lon: -73.9584, halfLen: 805, halfWidth: 465 };

// City margin rendered around the park rectangle (metres): south reaches
// ~48th St so the Midtown wall fronts the classic view from the south; across
// covers to Park Ave / Columbus Ave.
export const MARGIN = { south: 900, north: 250, across: 400 };

// Unit vectors of the park's axes in the local frame.
export const AXIS = new THREE.Vector3(Math.sin(AXIS_BEARING), 0, -Math.cos(AXIS_BEARING)); // toward 110th St
export const PERP = new THREE.Vector3(Math.cos(AXIS_BEARING), 0, Math.sin(AXIS_BEARING)); // toward 5th Ave

// The bake maps lat/lon through web mercator and scales by cos(lat₀), so
// its local metre is R·π/180·cos(lat₀)/cos(lat) per degree — the same
// spherical constant here (NOT the 111,132 m/° ellipsoidal figure, which
// would put Sheep Meadow 2 m north of where the baked data has it).
const METRES_PER_DEG_LAT = (6378137 * Math.PI) / 180;
const METRES_PER_DEG_LON = METRES_PER_DEG_LAT * Math.cos(PARK_CENTER.lat * DEG);

// Local approximation of the bake's mapping: exact at the centre, within
// ~0.3 m across the 6 km frame (the cos(lat₀)/cos(lat) stretch).
export function localFromLatLon(lat: number, lon: number): { x: number; z: number } {
  return {
    x: (lon - PARK_CENTER.lon) * METRES_PER_DEG_LON,
    z: -(lat - PARK_CENTER.lat) * METRES_PER_DEG_LAT,
  };
}

// Park-axis coordinates of a local point: along (+ toward 110th St) and
// across (+ toward 5th Ave).
export function alongAcross(x: number, z: number): { along: number; across: number } {
  return { along: x * AXIS.x + z * AXIS.z, across: x * PERP.x + z * PERP.z };
}

export function localFromAlongAcross(along: number, across: number): { x: number; z: number } {
  return { x: along * AXIS.x + across * PERP.x, z: along * AXIS.z + across * PERP.z };
}

export function insidePark(x: number, z: number, pad = 0): boolean {
  const { along, across } = alongAcross(x, z);
  return Math.abs(along) <= PARK_HALF_LEN + pad && Math.abs(across) <= PARK_HALF_WIDTH + pad;
}

// ── crop ───────────────────────────────────────────────────────────────────
// park    the whole park plus its city margin (the iconic rectangle)
// segment the original 110th→90th St evaluation slab
// city    no crop — everything the data covers
export type CropMode = "park" | "segment" | "city";
export const CROP_ORDER: CropMode[] = ["park", "segment", "city"];

export function nextCrop(mode: CropMode): CropMode {
  return CROP_ORDER[(CROP_ORDER.indexOf(mode) + 1) % CROP_ORDER.length];
}

interface Slab {
  alongMin: number;
  alongMax: number;
  acrossMin: number;
  acrossMax: number;
}

export function cropSlab(mode: CropMode): Slab | null {
  if (mode === "city") {
    return null;
  }
  if (mode === "segment") {
    const c = localFromLatLon(SEGMENT.lat, SEGMENT.lon);
    const { along, across } = alongAcross(c.x, c.z);
    return {
      alongMin: along - SEGMENT.halfLen,
      alongMax: along + SEGMENT.halfLen,
      acrossMin: across - SEGMENT.halfWidth,
      acrossMax: across + SEGMENT.halfWidth,
    };
  }
  return {
    alongMin: -PARK_HALF_LEN - MARGIN.south,
    alongMax: PARK_HALF_LEN + MARGIN.north,
    acrossMin: -PARK_HALF_WIDTH - MARGIN.across,
    acrossMax: PARK_HALF_WIDTH + MARGIN.across,
  };
}

// Renderer clipping planes for a crop: three.js discards fragments where
// normal·p + constant < 0, so each slab face keeps its inside half-space.
export function cropPlanes(mode: CropMode): THREE.Plane[] {
  const slab = cropSlab(mode);
  if (slab === null) {
    return [];
  }
  return [
    new THREE.Plane(AXIS.clone().negate(), slab.alongMax),
    new THREE.Plane(AXIS.clone(), -slab.alongMin),
    new THREE.Plane(PERP.clone().negate(), slab.acrossMax),
    new THREE.Plane(PERP.clone(), -slab.acrossMin),
  ];
}

// ── camera presets ─────────────────────────────────────────────────────────
// Presets 1–6 are the original segment evaluation ladder (eye south of the
// segment centre, looking north up the slab) and are unchanged. 7–9 are the
// whole-park pictures this frame exists for.
export interface ViewPreset {
  key: string;
  label: string;
  // Eye and look-at target in park-axis coordinates (metres) + altitude.
  // Altitudes are above the frame's y = 0 (the park centre's surface) unless
  // `groundRelative`, in which case both are above the ground at the EYE.
  eye: { along: number; across: number; alt: number };
  target: { along: number; across: number; alt: number };
  groundRelative?: boolean;
  // Crop this preset expects (applied when selected).
  crop: CropMode;
}

const segmentCentre = (() => {
  const c = localFromLatLon(SEGMENT.lat, SEGMENT.lon);
  return alongAcross(c.x, c.z);
})();

const segmentLadder = (alt: number, pitchDeg: number): ViewPreset => {
  const horiz = alt / Math.tan(pitchDeg * DEG);
  return {
    key: String(alt),
    label: `${alt}m`,
    eye: { along: segmentCentre.along - horiz, across: segmentCentre.across, alt },
    target: { along: segmentCentre.along, across: segmentCentre.across, alt: 0 },
    crop: "segment",
  };
};

// The room's stage for ?env=park: the lawn just north of Gapstow Bridge —
// due south the view crosses ~200 m of the Pond's water with the skyline
// behind (picked by scanning the baked water mask along candidate bearings).
export const POND_STAGE = localFromLatLon(40.76765, -73.9738);

// Sheep Meadow (66th–69th St, west of centre): THE ground-level postcard —
// the Midtown wall rising over the tree line to the south.
export const SHEEP_MEADOW = localFromLatLon(40.77156, -73.97442);
// Its lawn sits 11.8 m BELOW the park centre's surface (bake manifest
// anchors.sheepMeadow.groundM — the centre is on a schist rise); the
// ground-relative meadow preset needs this before any DEM has loaded.
export const SHEEP_MEADOW_GROUND_M = -11.8;
// In the Google-tiles frame y = 0 is the WGS84 ellipsoid at the centre, not
// the surface: NAVD88 34.6 m with a −32.6 m geoid puts the centre's ground
// at about +2 m there.
export const TILES_SURFACE_Y = 2;

export const PRESETS: ViewPreset[] = [
  segmentLadder(2500, 72),
  segmentLadder(1200, 60),
  segmentLadder(600, 55),
  segmentLadder(250, 45),
  segmentLadder(100, 30),
  segmentLadder(40, 15),
  {
    // The classic aerial: from above Midtown looking north up the whole
    // rectangle, the Reservoir in the upper third.
    key: "postcard",
    label: "postcard",
    eye: { along: -PARK_HALF_LEN - 700, across: 40, alt: 1150 },
    target: { along: -500, across: 0, alt: 0 },
    crop: "park",
  },
  {
    // Straight down: the green cut-out in the grid, Hudson to East River.
    key: "satellite",
    label: "satellite",
    eye: { along: -15, across: 0, alt: 5200 },
    target: { along: 0, across: 0, alt: 0 },
    crop: "city",
  },
  {
    // Standing on Sheep Meadow (eye height) looking south at Billionaires'
    // Row over the tree line.
    key: "meadow",
    label: "Sheep Meadow",
    eye: { ...alongAcross(SHEEP_MEADOW.x, SHEEP_MEADOW.z), alt: 1.7 },
    target: { ...alongAcross(SHEEP_MEADOW.x, SHEEP_MEADOW.z), alt: 80 },
    groundRelative: true,
    crop: "park",
  },
];
// The meadow preset looks SOUTH: push its target down the axis.
PRESETS[8].target.along -= 600;

// Ground height (frame metres) under a local point. Sources with a DEM pass
// their own sampler; the default knows only the one anchor a ground-relative
// preset stands on.
export type GroundAt = (x: number, z: number) => number;
export const defaultGroundAt: GroundAt = () => SHEEP_MEADOW_GROUND_M;

const presetGround = (preset: ViewPreset, groundAt: GroundAt): number => {
  if (preset.groundRelative !== true) {
    return 0;
  }
  const p = localFromAlongAcross(preset.eye.along, preset.eye.across);
  return groundAt(p.x, p.z);
};

export function presetEye(preset: ViewPreset, groundAt: GroundAt = defaultGroundAt): THREE.Vector3 {
  const p = localFromAlongAcross(preset.eye.along, preset.eye.across);
  return new THREE.Vector3(p.x, preset.eye.alt + presetGround(preset, groundAt), p.z);
}

export function presetTarget(preset: ViewPreset, groundAt: GroundAt = defaultGroundAt): THREE.Vector3 {
  const p = localFromAlongAcross(preset.target.along, preset.target.across);
  return new THREE.Vector3(p.x, preset.target.alt + presetGround(preset, groundAt), p.z);
}
