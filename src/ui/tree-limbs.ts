// ── The garden fleet tree's HD body + issue FRUIT (PURE derivations) ────────
// ONE VISUAL LANGUAGE: every garden fleet tree — adopted GitHub imports AND
// local concept/commissioned trees — is GROWN by the HD tree engine
// (src/ui/tree/build.ts, the SELF tree's substrate). This module owns the
// pure data side of that body:
//   • fleetTreeSpec3D maps a tree's REAL data into the TreeSpec3D the engine
//     builds: adopted imports stand full-grown in the self tree's trunk
//     family and every room/* branch of the snapshot's treeRepo becomes a
//     REAL engine branch (length/thickness scale with its commit count, the
//     tip card reads "<branch> / N commits · PR ✓", the tip bud goes CI-green
//     once a PR is open); local concepts grow as small young saplings and
//     rise to full grown when commissioned — all id-seeded, so trees are
//     individuals,
//   • open GitHub issues (fetched by App from /api/process/:upid/issues) hang
//     as emissive FRUIT on ONE translucent holo branch arcing off mid-trunk —
//     deliberately an ATTACHMENT (ghostly, never wood), so it stays out of
//     the body spec.
// Everything here is pure data (no three.js): RoomScene feeds the spec to
// buildTreeLOD and turns fruit specs into spheres, and the signatures below
// gate the entry rebuild exactly like every other structural spec change.
// Deterministic per branch/tree identity via the tree module's hashSeed/
// mulberry32, so a re-published but unchanged snapshot regrows pixel-
// identical trees.

import { FOREST_LEAF_LUSH } from "./forest-spec";
import { hashSeed, mulberry32, type TreeBranchSpec3D, type TreeSpec3D, type TreeVec3 } from "./tree/spec";

// The snapshot's treeRepo surface (mirrors ProjectorProcess.treeRepo — kept
// structural here so the scene spec layer never imports server-shaped types).
export interface TreeRepoBranch {
  name: string;
  commits: number;
  prUrl?: string;
}

export interface TreeRepoInfo {
  branches: TreeRepoBranch[];
  remoteUrl: string | null;
}

// One open GitHub issue as the fruit poller surfaces it ({issues:[…]} from
// GET /api/process/:upid/issues).
export interface IssueInfo {
  number: number;
  title: string;
  labels: string[];
}

// Bounded render caps: treeRepo.branches is server-bounded (<=8) but clamp
// anyway; fruit caps at 5 so the holo branch never turns into a bead chain.
export const LIMB_CAP = 8;
export const FRUIT_CAP = 5;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// ── limbs ───────────────────────────────────────────────────────────────────

export interface LimbSpec {
  // Full branch ref ("room/spoken-changes") — the pick payload + POST target.
  branch: string;
  // The short display name ("spoken-changes").
  short: string;
  commits: number;
  prUrl: string | null;
  // Geometry params (world units at scale 1; RoomScene multiplies by the
  // body scale of whichever tree body was grown).
  azimuth: number;
  yFrac: number;
  length: number;
  lift: number;
  thickness: number;
}

// Only the room/* rails render as limbs: main IS the trunk, and concept lanes
// (concept/<backend>) belong to local trees, which grow no limb chrome.
export function roomBranches(repo: TreeRepoInfo | null | undefined): TreeRepoBranch[] {
  return (repo?.branches ?? []).filter((branch) => branch.name.startsWith("room/"));
}

// Commit-count clamp feeding limb size — a runaway branch must not grow a
// limb longer than the tree.
function commitNorm(commits: number, cap: number): number {
  return Math.max(0, Math.min(Number.isFinite(commits) ? commits : 0, cap));
}

// Pure: the snapshot's treeRepo → one LimbSpec per room/* branch (capped).
// Deterministic per branch name; ordered by the repo's own branch order so
// limbs keep their azimuth slots as commits tick.
export function limbSpecs(repo: TreeRepoInfo | null | undefined): LimbSpec[] {
  const branches = roomBranches(repo).slice(0, LIMB_CAP);
  const count = branches.length;
  return branches.map((branch, index) => {
    const rng = mulberry32(hashSeed(`limb:${branch.name}`));
    const yFrac = count <= 1 ? 0.62 : 0.42 + (0.38 * index) / (count - 1);
    return {
      branch: branch.name,
      short: branch.name.slice("room/".length),
      commits: Math.max(0, Math.round(branch.commits)),
      prUrl: typeof branch.prUrl === "string" && branch.prUrl.length > 0 ? branch.prUrl : null,
      azimuth: index * GOLDEN_ANGLE + (rng() - 0.5) * 0.8,
      yFrac,
      length: 2.1 + 0.22 * commitNorm(branch.commits, 10),
      lift: 0.8 + rng() * 0.6,
      thickness: 0.09 + 0.008 * commitNorm(branch.commits, 8),
    };
  });
}

// Curved limb spine (the forest-spec branchSpine construction): straight run
// from the trunk axis along the azimuth, rising by lift, seeded lateral sway
// fading to zero at BOTH endpoints — the attachment stays buried in the trunk
// and the tip stays exactly where the bud/card/hit sphere expect it.
const SPINE_STEPS = 6;
export function limbPoints(limb: LimbSpec, trunkTop: number, scale: number): TreeVec3[] {
  const start: TreeVec3 = { x: 0, y: trunkTop * limb.yFrac, z: 0 };
  const length = limb.length * scale;
  const lift = limb.lift * scale;
  const dirX = Math.cos(limb.azimuth);
  const dirZ = Math.sin(limb.azimuth);
  const rng = mulberry32(hashSeed(`limb-spine:${limb.branch}`));
  const phase = rng() * Math.PI * 2;
  const amp = length * (0.05 + rng() * 0.05);
  const points: TreeVec3[] = [];
  for (let step = 0; step <= SPINE_STEPS; step += 1) {
    const t = step / SPINE_STEPS;
    const side = Math.sin(t * 3.4 + phase) * amp * Math.sin(Math.PI * t);
    points.push({
      x: start.x + dirX * length * t + -dirZ * side,
      y: start.y + lift * t ** 0.85,
      z: start.z + dirZ * length * t + dirX * side,
    });
  }
  return points;
}

// ── per-limb HIT VOLUMES ────────────────────────────────────────────────────
// The visible wood never raycasts (the tapered tube is merged bark — module
// policy, and a 43k-tri hover test would drag the frame loop), so until now
// only the tip carried a pick sphere: a 0.85-unit target on a 3-unit limb,
// which is why the live room read as "one hitbox for the whole tree". These
// are the invisible spheres the scene threads ALONG the spine so the WHOLE
// branch picks, sized for a projector room (clicks are coarse; gesture dwell
// is coarser still).
export const LIMB_HIT_SAMPLES = 3;
// Sample window along the spine, as a fraction of its length. It starts well
// clear of the trunk so a click on the TRUNK still reads as the whole tree
// (the tree menu is the affordance that must never be lost), and stops short
// of the tip, which owns its own sphere.
export const LIMB_HIT_SPAN: readonly [number, number] = [0.5, 0.92];
// Floor + ceiling on the sphere radius: generous even for a hairline limb,
// never so fat that a stubby sapling limb swallows its own trunk.
export const LIMB_HIT_MIN_RADIUS = 0.5;
export const LIMB_HIT_MAX_LENGTH_FRAC = 0.3;

export interface LimbHitVolume {
  at: TreeVec3;
  radius: number;
}

// Pure: a limb spine (attachment→tip — as limbPoints builds it for adopted
// trees, and as TreeSpec3D branch points give it on the self tree) → the
// invisible pick spheres strung along it. Samples ride the spine's own
// polyline, so every volume sits ON the wood; none lands at the buried
// attachment and the count is fixed per limb, so a busy branch never
// multiplies the scene's mesh budget.
export function spineHitPoints(points: readonly TreeVec3[], thickness: number): LimbHitVolume[] {
  if (points.length < 2) {
    return [];
  }
  // Cumulative arc length over the polyline — sampling by LENGTH keeps the
  // volumes evenly spread however the spine was tessellated.
  const spans: number[] = [0];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    const dz = current.z - previous.z;
    spans.push(spans[index - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  const total = spans[spans.length - 1];
  if (!(total > 0)) {
    return []; // degenerate spine (all points coincident) — nothing to hit
  }
  const radius = Math.min(
    Math.max(LIMB_HIT_MIN_RADIUS, thickness * 5),
    total * LIMB_HIT_MAX_LENGTH_FRAC,
  );
  const [from, to] = LIMB_HIT_SPAN;
  const volumes: LimbHitVolume[] = [];
  for (let sample = 0; sample < LIMB_HIT_SAMPLES; sample += 1) {
    const t = from + ((to - from) * sample) / Math.max(1, LIMB_HIT_SAMPLES - 1);
    const along = total * t;
    let segment = 1;
    while (segment < spans.length - 1 && spans[segment] < along) {
      segment += 1;
    }
    const start = points[segment - 1];
    const end = points[segment];
    const spanLength = spans[segment] - spans[segment - 1];
    const local = spanLength > 0 ? (along - spans[segment - 1]) / spanLength : 0;
    volumes.push({
      at: {
        x: start.x + (end.x - start.x) * local,
        y: start.y + (end.y - start.y) * local,
        z: start.z + (end.z - start.z) * local,
      },
      radius,
    });
  }
  return volumes;
}

// ── pick precedence ─────────────────────────────────────────────────────────
// A tree's COARSE whole-tree hit volume geometrically encloses its own limb
// tips and fruit (the sphere is metres wide; a limb tip sits ~2 units out at
// canopy height), so "the nearest payload the ray crossed wins" made every
// sub-target unreachable — the live-room report was "the whole tree seems to
// have one hitbox". This is the rule that repairs it, kept pure so it is
// testable without a renderer.
export interface ScenePickPayload {
  kind: string;
  key?: string;
  callsign?: string;
  branch?: string;
  number?: number;
  // Ceiling only: the CONSTELLATION a dialogue pick belongs to. Every star and
  // the whole-patch ellipsoid carry it, so picking anywhere in a constellation
  // opens that thread's topic card.
  cloud?: string;
  // Set ONLY on a tree's coarse whole-body proxy: the metres-wide invisible
  // CANOPY ellipsoid standing in for geometry that never raycasts (the HD
  // engine's merged wood + instanced foliage). It spans the whole crown, so a
  // sub-object of the SAME tree may overrule it.
  coarse?: boolean;
  // Set on the volume that hugs the TRUNK — the tapered column following the
  // engine's own drawn stem profile, the pixels the whole-tree menu must
  // never lose.
  trunk?: boolean;
  // Set on the spine volumes strung ALONG a limb: invisible spheres several
  // times fatter than the hairline wood they stand for, so they are the one
  // sub-target that yields back to its own trunk.
  alongLimb?: boolean;
}

// Pure: the payloads a ray crossed, NEAREST FIRST → the one the room should
// act on.
//   • A real (non-coarse) nearest hit wins outright — the trunk-hugging column
//     IS where the wood is, so a click on the trunk keeps opening the tree
//     menu even with a limb behind it.
//   • When the nearest hit is the coarse proxy, walk on: the first thing of
//     the SAME tree the ray actually reaches decides — a limb/fruit in front
//     of the trunk picks that branch/issue, the trunk volume picks the tree.
//   • A different tree's sub-object never hijacks a nearer trunk, and a ray
//     that crossed only the proxy still opens the tree menu.
//   • Last word to the TIGHTER TARGET: a limb's spine volumes are deliberately
//     OVERSIZED — 0.5-unit spheres standing in for hairline wood 3-15× thinner,
//     because a projector room is clicked coarsely. That padding is invisible,
//     so wherever it crosses in front of something of the SAME tree that the
//     eye actually sees — the trunk column (tapered to the drawn stem), a tip
//     bud with its PR card, an issue fruit — it silently eats those pixels. It
//     yields to them instead. Off that chrome the spine volume is the whole
//     point and still wins, and a NEIGHBOUR tree's chrome never claims it.
//     Measured (real rays, 3 seeded fleet trees, 72 azimuths × 3 elevations):
//     the yield returns 100% of the trunk silhouette and lifts tip pickability
//     84.7%→88.5% and fruit 61.9%→67.0%, for 1.6pp of mid-limb wood area.
export function resolveScenePick(hits: readonly ScenePickPayload[]): ScenePickPayload | null {
  const nearest = hits[0];
  if (nearest === undefined) {
    return null;
  }
  const chosen =
    nearest.kind !== "process" || nearest.coarse !== true
      ? nearest
      : (hits.find(
          (hit) =>
            hit.callsign === nearest.callsign &&
            (hit.kind === "branch" || hit.kind === "issue" || (hit.kind === "process" && hit.coarse !== true)),
        ) ?? nearest);
  if (chosen.alongLimb === true) {
    const ownChrome = hits.find(
      (hit) =>
        hit.callsign === chosen.callsign &&
        hit.alongLimb !== true &&
        ((hit.kind === "process" && hit.trunk === true) || hit.kind === "branch" || hit.kind === "issue"),
    );
    if (ownChrome !== undefined) {
      return ownChrome;
    }
  }
  return chosen;
}

// The tip card text: branch name over commit count, with the PR marker once a
// real PR is open against the origin.
export function limbTipCard(limb: LimbSpec): { title: string; sub: string } {
  return {
    title: limb.short,
    sub: `${limb.commits} commit${limb.commits === 1 ? "" : "s"}${limb.prUrl !== null ? " · PR ✓" : ""}`,
  };
}

// Structural signature over the limb-relevant slice of treeRepo: reconcile
// regrows the tree entry exactly when this changes (a branch appearing, a
// commit landing, a PR opening) — a re-published but unchanged snapshot is a
// no-op, like every other structural gate.
export function limbSignature(repo: TreeRepoInfo | null | undefined): string {
  return roomBranches(repo)
    .map((branch) => `${branch.name}:${Math.round(branch.commits)}:${branch.prUrl ?? ""}`)
    .join("|");
}

// ── the HD fleet-tree body spec ─────────────────────────────────────────────

// Branch-tip bud colors: CI-pass green once a real PR is open against the
// origin (the forest's vocabulary), calm sky blue otherwise.
export const LIMB_BUD_PR_COLOR = 0x46c66e;
export const LIMB_BUD_COLOR = 0x9ee2ff;

// Trunk families: the grown band sits inside the forest/self spec's 5.5–10u
// authoring scale so adopted and local trees stand WITH the self tree; the
// sapling band stays waist-height so "young / not yet real" reads across the
// room. Limbs/decor shrink with the sapling body (the old graft's 0.55).
const GROWN_TRUNK_MIN = 6.2;
const GROWN_TRUNK_VAR = 1.8;
const SAPLING_TRUNK_MIN = 2.3;
const SAPLING_TRUNK_VAR = 0.6;
export const SAPLING_LIMB_SCALE = 0.55;

export interface FleetTreeInput {
  // Stable per-tree identity (the upid) — seeds ALL organic variation, so a
  // rebuilt tree regrows the exact same individual.
  id: string;
  // Full-grown (adopted import / commissioned / built) vs a concept sapling —
  // treeIndicators(spec).grown is the scene-side source.
  grown: boolean;
  treeRepo?: TreeRepoInfo | null;
}

// Pure: a fleet tree's real data → the TreeSpec3D the HD engine grows.
// Data limbs (room/* branches) carry status tips — the tip card text via
// limbTipCard, the bud color by PR presence, and pickId = the FULL branch ref
// so the scene's tip chrome can stamp its pick payload/sub-target id. A few
// DECORATIVE branches (no tips) fill the silhouette so a tree with little
// data still reads as a tree.
export function fleetTreeSpec3D(input: FleetTreeInput): TreeSpec3D {
  const rng = mulberry32(hashSeed(`fleet:${input.id}`));
  const trunkHeight = input.grown
    ? GROWN_TRUNK_MIN + rng() * GROWN_TRUNK_VAR
    : SAPLING_TRUNK_MIN + rng() * SAPLING_TRUNK_VAR;
  const scale = input.grown ? 1 : SAPLING_LIMB_SCALE;
  const limbs = limbSpecs(input.treeRepo);
  const branches: TreeBranchSpec3D[] = limbs.map((limb) => {
    const card = limbTipCard(limb);
    return {
      id: `limb:${limb.branch}`,
      points: limbPoints(limb, trunkHeight, scale),
      thickness: limb.thickness * scale,
      tip: {
        kind: "status" as const,
        color: limb.prUrl !== null ? LIMB_BUD_PR_COLOR : LIMB_BUD_COLOR,
        label: card.title,
        sub: card.sub,
        pickId: limb.branch,
      },
    };
  });
  // Decorative fill: reuse the limb spine construction through a synthetic
  // LimbSpec (same curvature family as the data limbs), azimuths offset half
  // a turn from the data fan so decor never crowds a tip card.
  const decorCount = input.grown ? Math.max(2, 5 - limbs.length) : 2;
  for (let index = 0; index < decorCount; index += 1) {
    const decoRng = mulberry32(hashSeed(`fleet-deco:${input.id}:${index}`));
    const deco: LimbSpec = {
      branch: `deco:${input.id}:${index}`,
      short: "",
      commits: 0,
      prUrl: null,
      azimuth: Math.PI + index * GOLDEN_ANGLE + (decoRng() - 0.5) * 0.9,
      yFrac: 0.48 + decoRng() * 0.34,
      length: 1.5 + decoRng() * 1.0 + trunkHeight * 0.16,
      lift: 0.9 + decoRng() * 0.7,
      thickness: 0.1 + decoRng() * 0.03,
    };
    branches.push({
      id: `deco-${index}`,
      points: limbPoints(deco, trunkHeight, scale),
      thickness: deco.thickness * scale,
    });
  }
  return {
    id: `fleet:${input.id}`,
    trunk: {
      height: trunkHeight,
      radius: input.grown ? 0.3 + 0.02 * Math.min(limbs.length, 8) : 0.14,
    },
    branches,
    foliage: { density: input.grown ? 0.6 : 0.34, palette: FOREST_LEAF_LUSH },
  };
}

// ── issue fruit ─────────────────────────────────────────────────────────────

// Label → fruit color: the fixed status vocabulary (bug reads as the failure
// red, enhancement as the active green, everything else amber).
export const FRUIT_BUG_COLOR = 0xff3b30;
export const FRUIT_ENHANCEMENT_COLOR = 0x00ff88;
export const FRUIT_DEFAULT_COLOR = 0xf5a623;

export function fruitColor(labels: readonly string[]): number {
  const lowered = labels.map((label) => label.toLowerCase());
  if (lowered.includes("bug")) {
    return FRUIT_BUG_COLOR;
  }
  if (lowered.includes("enhancement")) {
    return FRUIT_ENHANCEMENT_COLOR;
  }
  return FRUIT_DEFAULT_COLOR;
}

export interface FruitSpec {
  number: number;
  title: string;
  color: number;
  // Position along the holo branch curve, 0 (attachment) .. 1 (tip) — spaced
  // so fruits never bunch at either end.
  t: number;
}

// Pure: the fetched issue list → capped fruit specs, spaced along the arc.
export function fruitSpecs(issues: readonly IssueInfo[] | null | undefined): FruitSpec[] {
  const capped = (issues ?? []).slice(0, FRUIT_CAP);
  return capped.map((issue, index) => ({
    number: issue.number,
    title: issue.title,
    color: fruitColor(issue.labels),
    t: (index + 1) / (capped.length + 1),
  }));
}

// The ghost branch the fruit hangs on: ONE translucent arc from mid-trunk,
// curving outward and up, then drooping toward the tip like a laden bough.
// Deterministic per tree id so it never spins between reconciles.
export const HOLO_ARC_STEPS = 8;
export function holoArcPoints(seedKey: string, trunkTop: number, scale: number): TreeVec3[] {
  const rng = mulberry32(hashSeed(`holo:${seedKey}`));
  const azimuth = rng() * Math.PI * 2;
  const length = 3.2 * scale;
  const lift = 1.5 * scale;
  const droop = 0.9 * scale;
  const startY = trunkTop * 0.52;
  const dirX = Math.cos(azimuth);
  const dirZ = Math.sin(azimuth);
  const points: TreeVec3[] = [];
  for (let step = 0; step <= HOLO_ARC_STEPS; step += 1) {
    const t = step / HOLO_ARC_STEPS;
    points.push({
      x: dirX * length * t,
      y: startY + lift * Math.sin(Math.PI * t * 0.62) - droop * t * t,
      z: dirZ * length * t,
    });
  }
  return points;
}

// Structural signature over the fruit set (count/order/color changes regrow
// the entry; title edits don't — titles render in the popup, not the scene).
export function fruitSignature(issues: readonly IssueInfo[] | null | undefined): string {
  return fruitSpecs(issues)
    .map((fruit) => `${fruit.number}:${fruit.color}`)
    .join("|");
}
