// ── the PROCESS pick surface of an HD tree body (pure, no three.js) ─────────
// The HD tree engine deliberately makes everything it draws unpickable —
// "Nothing here is pickable: every mesh gets a no-op raycast (consumers own
// their hit volumes)" (src/ui/tree/build.ts) — so an HD-grown tree is
// clickable ONLY through the invisible volumes its consumer adds around it.
// Getting those volumes wrong is what makes a tree look perfectly rendered and
// pick stone dead, so the plan lives here as PURE DATA and is unit-tested:
// RoomScene just turns each volume into one invisible unit-sphere mesh scaled
// to `radius` and stamped with the {kind:"process"} payload.
//
// TWO volumes, and the split is load-bearing:
//   • CANOPY — an ellipsoid fitted to the body's REAL drawn bounds, so a click
//     on the LEAVES (by far the biggest target on a projector wall) selects
//     the tree. A trunk-sized sphere at 0.58·height leaves the whole crown and
//     the outer canopy ring carrying no payload at all: the click resolves to
//     nothing, which the pointer path reads as empty ground and CLOSES the
//     menu. That is the regression this module exists to prevent.
//   • TRUNK — a slim column hugging the stem, TAPERED to the same profile the
//     engine draws (wide root flare, thin at the top). Its far face sits just
//     behind the trunk axis, i.e. NEARER to the camera than any far-side limb
//     tip (limbs reach 2-4u), so a click aimed at the trunk resolves to the
//     TREE instead of being stolen by a branch volume hiding behind it.
//     The taper is load-bearing, not cosmetic: an untapered column is an
//     INVISIBLE POLE, and everything it shadows becomes unclickable. A
//     straight ellipsoid of the flare radius is 5-9x wider than the wood at
//     mid/upper trunk, and a headless raycast sweep (72 azimuths x 3
//     elevations over 3 trees) measured it stealing 172 of 1620 branch-tip
//     clicks — a bud plainly visible on the wall that opens the tree menu
//     instead of its branch. Tapered to the drawn wood + a 0.18 slop that
//     drops to 67, all of which are angles where the WOOD really is in front.
//
// Both are rendered BACK-side by the consumer so only their FAR face is
// reported by the raycaster. That is what keeps the coarse volumes from
// swallowing everything they enclose: a branch-tip or issue-fruit volume
// nested inside the canopy is hit first and still wins its own sub-pick, while
// a ray that touches no sub-object falls through to the tree itself.

export interface HitVec3 {
  x: number;
  y: number;
  z: number;
}

export interface HitBounds {
  min: HitVec3;
  max: HitVec3;
}

// One coarse volume. Two shapes, because the two jobs have opposite needs:
//   • "ellipsoid" — a unit sphere at `center` scaled by `radius` (semi-axes).
//   • "column" — a truncated cone from `radiusBottom` (= `radius.x`/`radius.z`)
//     up to `radiusTop`, `radius.y` being its HALF-height. This is the trunk.
export interface ProcessHitVolume {
  id: "canopy" | "trunk";
  shape: "ellipsoid" | "column";
  center: HitVec3;
  radius: HitVec3;
  // Column only: the radius at the top of the cone (the engine's trunk taper).
  radiusTop: number;
}

// Slack on the fitted canopy ellipsoid. An ellipsoid inscribed in a box only
// touches the box at its face centres, so foliage out near a box CORNER (the
// outermost leaf cluster of the longest limb) falls outside a snug fit and
// carries no payload — a click on real, drawn leaves that closes the menu.
// 1.25 is measured, not guessed: sampling every leaf/adornment instance origin
// AND every merged-wood vertex of 24 seeded bodies (13,803 points) leaves 41
// points outside at 1.08, 10 at 1.15, 2 at 1.20 and ZERO at 1.25. It stays
// well inside the garden's 13-unit tree slots, so neighbouring canopies never
// overlap and a click can never resolve to the wrong tree.
export const CANOPY_HIT_SLACK = 1.25;
export const CANOPY_HIT_PAD = 0.25;
// The engine's trunk profile (src/ui/tree/build.ts): the tube radius is
// `radius * (0.22 + 0.78 * (1-t)^1.3)` plus a root flare of `radius * 0.6` at
// the very base — so it peaks at `radius * 1.6` at the root and thins to
// `radius * 0.22` at the top. The column mirrors both ends.
export const TRUNK_HIT_FLARE = 1.6;
export const TRUNK_HIT_TAPER = 0.22;
// Clickable slop around the drawn wood. Bigger than this and the column starts
// shadowing branch tips that are plainly visible beside the trunk.
export const TRUNK_HIT_PAD = 0.18;
// The engine roots the trunk spine at y = -0.5, below the ground plane.
export const TRUNK_HIT_ROOT_Y = -0.5;
// Floors so a sapling (trunk radius 0.14, canopy barely a metre across) still
// has a target a hand-tracked cursor can actually land on.
export const MIN_CANOPY_HIT_RADIUS = 1.2;
export const MIN_TRUNK_HIT_RADIUS = 0.45;

// Plan the coarse {kind:"process"} volumes for one HD tree body.
// `bounds` is the body's real local-space bounding box (THREE.Box3 over the
// built LOD group); `trunk` is the spec the engine actually grew from.
export function processHitVolumes(bounds: HitBounds, trunk: { height: number; radius: number }): ProcessHitVolume[] {
  const fit = (lo: number, hi: number, floor: number) =>
    Math.max(floor, (Math.max(hi - lo, 0) / 2) * CANOPY_HIT_SLACK + CANOPY_HIT_PAD);
  const canopy: ProcessHitVolume = {
    id: "canopy",
    shape: "ellipsoid",
    center: {
      x: (bounds.min.x + bounds.max.x) / 2,
      y: (bounds.min.y + bounds.max.y) / 2,
      z: (bounds.min.z + bounds.max.z) / 2,
    },
    radius: {
      x: fit(bounds.min.x, bounds.max.x, MIN_CANOPY_HIT_RADIUS),
      y: fit(bounds.min.y, bounds.max.y, MIN_CANOPY_HIT_RADIUS),
      z: fit(bounds.min.z, bounds.max.z, MIN_CANOPY_HIT_RADIUS),
    },
    radiusTop: 0,
  };
  // The stem, root flare to tip, following the drawn taper. Slimness is the
  // whole point: it keeps the far face close to the axis so a trunk click
  // beats any far-side limb, while never shadowing the buds beside it.
  const base = Math.max(MIN_TRUNK_HIT_RADIUS, trunk.radius * TRUNK_HIT_FLARE) + TRUNK_HIT_PAD;
  const top = Math.max(MIN_TRUNK_HIT_RADIUS * TRUNK_HIT_TAPER, trunk.radius * TRUNK_HIT_TAPER) + TRUNK_HIT_PAD;
  const height = Math.max(trunk.height - TRUNK_HIT_ROOT_Y, 0.5);
  const column: ProcessHitVolume = {
    id: "trunk",
    shape: "column",
    center: { x: 0, y: TRUNK_HIT_ROOT_Y + height / 2, z: 0 },
    radius: { x: base, y: height / 2, z: base },
    radiusTop: top,
  };
  return [canopy, column];
}

// Is a point inside one planned volume? (The same test the raycaster performs
// geometrically — exposed so the plan's coverage is assertable headlessly.)
export function hitVolumeContains(volume: ProcessHitVolume, at: HitVec3): boolean {
  if (volume.shape === "column") {
    const half = volume.radius.y;
    const dy = at.y - volume.center.y;
    if (half <= 0 || Math.abs(dy) > half) {
      return false;
    }
    // 0 at the root flare, 1 at the tip.
    const t = (dy + half) / (2 * half);
    const r = volume.radius.x + (volume.radiusTop - volume.radius.x) * t;
    return Math.hypot(at.x - volume.center.x, at.z - volume.center.z) <= r;
  }
  const dx = (at.x - volume.center.x) / volume.radius.x;
  const dy = (at.y - volume.center.y) / volume.radius.y;
  const dz = (at.z - volume.center.z) / volume.radius.z;
  return dx * dx + dy * dy + dz * dz <= 1;
}

// Does the plan cover a point at all — i.e. would a ray through it resolve to
// the tree's {kind:"process"} payload rather than to nothing?
export function processHitCovers(volumes: readonly ProcessHitVolume[], at: HitVec3): boolean {
  return volumes.some((volume) => hitVolumeContains(volume, at));
}
