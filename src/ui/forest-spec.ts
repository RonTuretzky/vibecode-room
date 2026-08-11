// ── GitHub forest: org payload → TreeSpec3D grove (PURE) ────────────────────
// Maps the forest payload served by /api/forest (see src/server/github-org.ts,
// which imports THIS module's types as its source of truth) into one HD tree
// per repo for the Phase-4 tree engine:
//   • trunk height + foliage density follow pushedAt freshness (a repo pushed
//     today stands tall and lush; a stale one shrinks and thins toward parched
//     tones),
//   • every open PR is a branch — STACKED PRs (base ref = another open PR's
//     head ref) grow off the parent PR's branch TIP, mirroring the stack,
//   • CI status colors the branch tip (pass green / fail red / pending amber /
//     no checks bark), drafts grow thinner wood,
//   • open issues become "marker" adornments clustered near the trunk base,
//     hued by their first label — emitted ONLY when issuesVisible.
// Everything is deterministic: positions and organic wobble derive from
// repo/PR/issue identity through the tree module's hashSeed/mulberry32, so a
// re-fetched but unchanged payload rebuilds pixel-identical trees (and
// treeSpecSignature reconciles skip the rebuild entirely).

import {
  hashSeed,
  mulberry32,
  type TreeAdornmentSpec,
  type TreeBranchSpec3D,
  type TreeSpec3D,
  type TreeVec3,
} from "./tree/spec";

// ── payload types (the /api/forest contract; server mirrors via import) ─────

export type ForestCi = "pass" | "fail" | "pending" | "none";

export interface ForestPr {
  number: number;
  title: string;
  draft: boolean;
  ci: ForestCi;
  baseRef: string;
  headRef: string;
  // Set when baseRef equals another OPEN PR's headRef in the same repo: this
  // PR is stacked on that one (its branch grows from the parent's tip).
  stackedOn?: number;
}

export interface ForestIssue {
  number: number;
  title: string;
  labels: string[];
}

export interface ForestRepo {
  name: string;
  pushedAtMs: number;
  prs: ForestPr[];
  issues: ForestIssue[];
}

export interface ForestPayload {
  org: string;
  fetchedAtMs: number;
  repos: ForestRepo[];
}

// What GET /api/forest serves before any org is imported (`loading` marks an
// import in flight whose first fetch has not landed yet).
export type ForestState = ForestPayload | { org: null; loading?: string };

export function hasForest(state: ForestState | null | undefined): state is ForestPayload {
  return state !== null && state !== undefined && state.org !== null;
}

// ── palette ─────────────────────────────────────────────────────────────────

// CI status → branch-tip bud color. "none" reads as plain bark: no checks is
// the resting state, not a warning.
export const FOREST_CI_COLORS: Record<ForestCi, number> = {
  pass: 0x46c66e,
  fail: 0xe05555,
  pending: 0xf0c674,
  none: 0x6b503a,
};

// Foliage greens (fresh repos) and the parched olive set (stale repos) — the
// lush pool matches the dialogue tree's garden family.
export const FOREST_LEAF_LUSH = [0x5c8a41, 0x6f9d4c, 0x82b05a, 0x96c06b];
export const FOREST_LEAF_PARCHED = [0x8a8a4a, 0x9d8f4c, 0xa38f58, 0x7d7a45];

// Unlabeled issues fall back to this neutral gray marker.
export const FOREST_ISSUE_FALLBACK_COLOR = 0x9a9aa8;

// Issue markers are hued by the FIRST label's name (deterministic hash → hue,
// fixed garden-friendly saturation/lightness) so one label reads as one color
// across the whole grove.
export function issueMarkerColor(labels: readonly string[]): number {
  const label = labels[0];
  if (label === undefined || label.length === 0) {
    return FOREST_ISSUE_FALLBACK_COLOR;
  }
  return hslToHex(hashSeed(label.toLowerCase()) % 360, 0.62, 0.6);
}

function hslToHex(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): number => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(c * 255);
  };
  return (channel(0) << 16) | (channel(8) << 8) | channel(4);
}

// ── grove layout ────────────────────────────────────────────────────────────

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
// Ring spacing of the sunflower spiral (world units). ~30 trees span a ~40u
// grove — the LOD bands shed detail across it.
const GROVE_SPACING = 7;

// Freshness saturates: anything pushed within the last ~90 days keeps some
// green; beyond that the tree bottoms out at its parched minimum.
const FRESHNESS_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

// PR title budget on the tip label.
const TIP_TITLE_MAX = 40;

export interface ForestPlacement {
  repo: string;
  spec: TreeSpec3D;
  // Ground-plane [x, z]; trees stand at y=0.
  position: [number, number];
}

export interface ForestSpecOptions {
  issuesVisible: boolean;
  // Freshness reference. Defaults to payload.fetchedAtMs so the mapping is a
  // pure function of the payload (no wall clock).
  nowMs?: number;
}

// The main entry: payload → one placed TreeSpec3D per repo. Placement is
// keyed by repo-name hash rank, NOT array order, so a re-sorted payload never
// shuffles the grove.
export function forestPlacements(payload: ForestPayload, options: ForestSpecOptions): ForestPlacement[] {
  const nowMs = options.nowMs ?? payload.fetchedAtMs;
  // Stable spiral slots: rank repos by (name hash, name) — insertion order of
  // the payload never moves a standing tree.
  const ranked = [...payload.repos].sort((a, b) => {
    const ha = hashSeed(a.name);
    const hb = hashSeed(b.name);
    return ha !== hb ? ha - hb : a.name.localeCompare(b.name);
  });
  return ranked.map((repo, index) => {
    const jitter = ((hashSeed(`grove:${repo.name}`) % 1000) / 1000 - 0.5) * 0.5;
    const radius = index === 0 ? 0 : GROVE_SPACING * Math.sqrt(index);
    const angle = index * GOLDEN_ANGLE + jitter;
    return {
      repo: repo.name,
      spec: forestTreeSpec(payload.org, repo, nowMs, options.issuesVisible),
      position: [Math.cos(angle) * radius, Math.sin(angle) * radius] as [number, number],
    };
  });
}

// 1 = pushed right now, 0 = at/beyond the freshness window.
export function repoFreshness01(pushedAtMs: number, nowMs: number): number {
  const ageDays = Math.max(0, nowMs - pushedAtMs) / DAY_MS;
  return Math.max(0, Math.min(1, 1 - ageDays / FRESHNESS_WINDOW_DAYS));
}

function tipLabel(pr: ForestPr): string {
  const title = pr.title.length > TIP_TITLE_MAX ? `${pr.title.slice(0, TIP_TITLE_MAX - 1).trimEnd()}…` : pr.title;
  return `#${pr.number} ${title}`;
}

// One repo → one TreeSpec3D. Exported for focused tests; forestPlacements is
// the scene-facing entry.
export function forestTreeSpec(org: string, repo: ForestRepo, nowMs: number, issuesVisible: boolean): TreeSpec3D {
  const specId = `forest:${org}/${repo.name}`;
  const freshness = repoFreshness01(repo.pushedAtMs, nowMs);
  const trunkHeight = 5.5 + 4.5 * freshness;
  const trunkRadius = 0.34 + 0.03 * Math.min(repo.prs.length, 8);

  // ── PR branches: parents (trunk-attached) first, stacked children off their
  // parent's TIP. BFS over the stack forest; cycle members degrade to roots.
  const prs = [...repo.prs].sort((a, b) => a.number - b.number);
  const byNumber = new Map<number, ForestPr>(prs.map((pr) => [pr.number, pr]));
  interface BuiltBranch {
    tip: TreeVec3;
    azimuth: number;
    length: number;
    thickness: number;
  }
  const built = new Map<number, BuiltBranch>();
  const branches: TreeBranchSpec3D[] = [];

  const isStackedChild = (pr: ForestPr): boolean =>
    pr.stackedOn !== undefined && pr.stackedOn !== pr.number && byNumber.has(pr.stackedOn);
  const roots = prs.filter((pr) => !isStackedChild(pr));
  const rootCount = roots.length;

  const buildBranch = (pr: ForestPr, parent: BuiltBranch | null, rootIndex: number): void => {
    const rng = mulberry32(hashSeed(`${specId}:pr-${pr.number}`));
    let start: TreeVec3;
    let azimuth: number;
    let length: number;
    let lift: number;
    let thickness: number;
    if (parent === null) {
      // Trunk attachment: ON the trunk axis (buried inside the wood), spread
      // along the upper trunk, azimuths on a golden-angle fan.
      const yFrac = rootCount <= 1 ? 0.62 : 0.34 + (0.51 * rootIndex) / (rootCount - 1);
      start = { x: 0, y: trunkHeight * yFrac, z: 0 };
      azimuth = rootIndex * GOLDEN_ANGLE + (rng() - 0.5) * 0.7;
      length = 2 + rng() * 1.1 + trunkHeight * 0.12;
      lift = 0.9 + rng() * 0.7;
      thickness = pr.draft ? 0.055 : 0.11;
    } else {
      // STACKED: this branch grows from the parent PR's branch tip — the
      // first spine point IS the parent tip, hiding the joint in its wood.
      start = { ...parent.tip };
      azimuth = parent.azimuth + (rng() - 0.5) * 1.1;
      length = Math.max(1.3, parent.length * 0.72);
      lift = 0.7 + rng() * 0.5;
      thickness = Math.max(0.04, (pr.draft ? 0.055 : 0.11) * 0.85);
    }
    const points = branchSpine(start, azimuth, length, lift, rng);
    branches.push({
      id: `pr-${pr.number}`,
      // The branch's real git identity: picking this limb steers/loads THIS
      // ref, not the PR number.
      ref: pr.headRef,
      points,
      thickness,
      tip: {
        kind: "status",
        color: FOREST_CI_COLORS[pr.ci],
        label: tipLabel(pr),
        sub: repo.name,
        pickId: `${repo.name}#${pr.number}`,
      },
    });
    built.set(pr.number, { tip: points[points.length - 1], azimuth, length, thickness });
  };

  roots.forEach((pr, rootIndex) => buildBranch(pr, null, rootIndex));
  // Children in stack order: repeat passes until stable (chains resolve one
  // level per pass; a cycle leaves members unbuilt and the fallback roots them).
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const pr of prs) {
      if (built.has(pr.number) || !isStackedChild(pr)) {
        continue;
      }
      const parent = built.get(pr.stackedOn!);
      if (parent !== undefined) {
        buildBranch(pr, parent, 0);
        progressed = true;
      }
    }
  }
  for (const pr of prs) {
    if (!built.has(pr.number)) {
      // Stack cycle (degenerate data): stand the branch on the trunk anyway.
      buildBranch(pr, null, built.size % Math.max(1, rootCount || prs.length));
    }
  }

  // ── issue markers: clustered around the trunk base, first-label hue. Only
  // grown when the issues toggle is on — off means ZERO issue adornments.
  const adornments: TreeAdornmentSpec[] = [];
  if (issuesVisible) {
    for (const issue of repo.issues) {
      const id = `issue:${repo.name}#${issue.number}`;
      const rng = mulberry32(hashSeed(id));
      const theta = rng() * Math.PI * 2;
      const radius = 0.55 + rng() * 0.75;
      adornments.push({
        id,
        kind: "marker",
        position: { x: Math.cos(theta) * radius, y: 0.25 + rng() * 0.95, z: Math.sin(theta) * radius },
        color: issueMarkerColor(issue.labels),
        scale: 0.8 + rng() * 0.5,
      });
    }
  }

  return {
    id: specId,
    trunk: { height: trunkHeight, radius: trunkRadius },
    branches,
    foliage: {
      density: 0.18 + 0.72 * freshness,
      palette: freshness > 0.45 ? FOREST_LEAF_LUSH : FOREST_LEAF_PARCHED,
    },
    adornments,
  };
}

// Curved branch spine: straight run from `start` along `azimuth`, rising by
// `lift`, with a seeded lateral sway that fades to zero at BOTH endpoints so
// the attachment stays buried and the tip stays exactly where pick spheres
// and labels expect it.
const SPINE_STEPS = 6;
function branchSpine(start: TreeVec3, azimuth: number, length: number, lift: number, rng: () => number): TreeVec3[] {
  const dirX = Math.cos(azimuth);
  const dirZ = Math.sin(azimuth);
  const perpX = -dirZ;
  const perpZ = dirX;
  const phase = rng() * Math.PI * 2;
  const amp = length * (0.05 + rng() * 0.04);
  const points: TreeVec3[] = [];
  for (let step = 0; step <= SPINE_STEPS; step += 1) {
    const t = step / SPINE_STEPS;
    const side = Math.sin(t * 3.7 + phase) * amp * Math.sin(Math.PI * t);
    points.push({
      x: start.x + dirX * length * t + perpX * side,
      y: start.y + lift * t ** 0.85,
      z: start.z + dirZ * length * t + perpZ * side,
    });
  }
  return points;
}

// Human word for a CI state (tip cards, issue/PR chips). Lived in the old
// ForestScene canvas — that scene is DELETED (dead code was a trap for the
// room's self-agent, which edited it invisibly), the helper lives on here.
// Hover-card CI phrasing (also the contract test's hook).
export function forestCiWord(ci: ForestCi): string {
  switch (ci) {
    case "pass":
      return "CI passing";
    case "fail":
      return "CI failing";
    case "pending":
      return "CI pending";
    default:
      return "no CI";
  }
}
