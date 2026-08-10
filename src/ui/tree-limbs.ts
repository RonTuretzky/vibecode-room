// ── Branch LIMBS + issue FRUIT on adopted trees (PURE derivations) ──────────
// An adopted GitHub import's tree carries its git substrate on its body:
//   • every room/* branch of the snapshot's treeRepo grows as a real LIMB —
//     length/thickness scale with the branch's commit count, and the tip card
//     reads "<branch> · N commits · PR ✓",
//   • open GitHub issues (fetched by App from /api/process/:upid/issues) hang
//     as emissive FRUIT on ONE translucent holo branch arcing off mid-trunk.
// Everything here is pure data (no three.js): RoomScene turns limb/fruit specs
// into CatmullRom tubes + spheres, and the signatures below gate the entry
// rebuild exactly like every other structural spec change. Deterministic per
// branch/tree identity via the tree module's hashSeed/mulberry32, so a
// re-published but unchanged snapshot regrows pixel-identical limbs.

import { hashSeed, mulberry32, type TreeVec3 } from "./tree/spec";

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
