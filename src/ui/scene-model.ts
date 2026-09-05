import type { IdeaTrayItem, ProjectorProcess } from "./types";
import { type SceneDwellRect } from "./gesture/scene-source";
import type { SelfTreeSpec } from "./self-repo";
import { type TreeBranchSpec3D } from "./tree";
import { type SkyCloudRef, type SkyLinkRef } from "./sky/constellation-layout";
import { fruitSignature, limbSignature, type IssueInfo, type TreeRepoInfo } from "./tree-limbs";


// The full-viewport 3D stage (after conductor-github-visualizer): the scene IS
// the app background and every panel floats over it. Two render modes share
// the same data:
//   garden — processes are trees, ideas are flowers on a sunlit pasture
//   orbit  — processes and ideas are glowing orbs adrift in a nebula
// Navigation matches the visualizer: drag = orbit, shift+drag = pan,
// wheel = zoom, fit-to-content on demand. Clicks still build/steer (a drag
// longer than a few px suppresses the click, like the original).
//
// TWO-WALL CONTRACT: every window renders the COMPLETE scene (all ideas AND
// all builds). The scene never assumes it is a singleton per machine — each
// window owns its renderer, camera rig, and animation loop, and only the data
// (via the shared SSE stream upstream) is common. A `wall` identity may seed a
// different DEFAULT camera yaw per window so two projections of the same room
// don't boot pixel-identical, but it never filters content.
//
// In gesture mode (`cornerLock`) the two windows instead form a RIGID camera
// pair rendering ONE continuous world around the physical 90° corner: one
// shared eye point, yaws exactly 90° apart, 90° horizontal FOV per window —
// wall A's right edge continues onto wall B's left edge (see corner-lock.ts).

export interface IdeaOrbSpec {
  id: string | null; // null = the primary pending suggestion
  pitch: string;
  confidence: number;
  status: "ready" | "forming";
  maturity: IdeaTrayItem["maturity"];
  verified: boolean;
}


// A tree's per-backend build-lane tally: how many concept mock lanes are still
// mocking, went mock-ready, or failed. Rendered as small status satellites
// around the node. All counts default to 0 when the summary is absent.
export interface TreeBuildSummary {
  building: number;
  ready: number;
  failed: number;
}


export interface TreeSpec {
  statusText?: string;
  upid: string;
  callsign: string;
  state: ProjectorProcess["state"];
  progress: number;
  // The INFERRED project title (LLM-named); labels prefer it over the callsign.
  task: string;
  // True when this process is the live steering target — the node gets a
  // steering ring so the room can see where spoken transcript is routing.
  steering: boolean;
  // TWO-STAGE (now THREE-STAGE) language, legible at projector distance: a
  // "concept" (kickoff: mock lanes + pitch deck) renders as a SAPLING; a
  // "commissioned" project (real subscription execution running) grows into the
  // FULL tree with a gold commission ring + live progress arc; a "built" one
  // (execution finished) keeps the full tree with a brighter completion ring.
  // Absent = concept (legacy callers).
  stage?: "concept" | "commissioned" | "built";
  // ── richer per-process indicators (all OPTIONAL / back-compat) ────────────
  // Per-backend build-lane tally → small status satellites around the node.
  // Absent = no build lanes drawn (legacy callers).
  builds?: TreeBuildSummary;
  // True once a public GitHub Pages pitch deck exists for this project → a small
  // take-home beacon crowns the node. Absent/false = no beacon.
  published?: boolean;
  // Count of failed build lanes / a failed run → a red failure pip. Also implied
  // by a halted/blocked state. Absent = 0.
  failedCount?: number;
  // GIT SUBSTRATE (adopted GitHub imports): the tree's real repo surface —
  // every room/* branch renders as a LIMB on the garden tree (length/
  // thickness scale with its commit count, tip card reads name + commits +
  // PR ✓). Absent/null = no limbs (local trees, legacy callers).
  treeRepo?: TreeRepoInfo | null;
  // ISSUE FRUIT (adopted imports): open GitHub issues (App polls
  // /api/process/:upid/issues) — up to FRUIT_CAP hang as emissive fruit on
  // ONE translucent holo branch off the mid-trunk. Absent = no fruit.
  issues?: IssueInfo[];
  // CHOSEN PLANTING SPOT (the idea card's "Plant…" flow): local scene metres
  // where the person planted this tree. Garden radial layout only — the
  // abstract layouts (orbit/ball/disk) keep their own geometry. Absent/null =
  // the automatic slot row.
  plantedAt?: { x: number; z: number } | null;
}


// The ring style that marks a tree's stage on the ground/orb.
export type TreeRingStyle = "none" | "commission" | "built";


// The RESOLVED, render-ready indicator plan for a tree — pure derivation from a
// TreeSpec, shared by every render style (garden trees, orbit orbs, hyperbolic
// flora) and unit-tested independently of three.js.
export interface TreeIndicators {
  // Full-grown tree (commissioned/built) vs a young sapling (concept).
  grown: boolean;
  // Stage ring style around the node.
  ring: TreeRingStyle;
  // Per-status build-lane counts (clamped, integer, defaulted to 0).
  lanes: TreeBuildSummary;
  // A public pitch deck exists → take-home beacon.
  published: boolean;
  // 0..1 sweep of a LIVE progress arc while the run is executing (progress in
  // (0,100) and the state is active/planning), or null for no arc.
  progressArc: number | null;
  // A red failure pip (failed lane(s) or a halted/blocked state).
  failed: boolean;
}


export function clampCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}


// Pure: resolve a TreeSpec into its render-ready indicator plan. Kept free of
// three.js so it is unit-tested directly and reused across all render styles.
export function treeIndicators(spec: TreeSpec): TreeIndicators {
  const stage = spec.stage ?? "concept";
  // An ADOPTED tree (imported GitHub repo — treeRepo.remoteUrl set) is an
  // EXISTING real project, not a concept being sketched: it stands full-grown
  // from the moment it lands (dress-rehearsal finding: the convent tree
  // rendered as a barely-visible sapling on the panorama).
  const adopted = spec.treeRepo?.remoteUrl != null;
  const grown = adopted || stage === "commissioned" || stage === "built";
  const ring: TreeRingStyle = stage === "built" ? "built" : stage === "commissioned" ? "commission" : "none";
  const lanes: TreeBuildSummary = {
    building: clampCount(spec.builds?.building),
    ready: clampCount(spec.builds?.ready),
    failed: clampCount(spec.builds?.failed),
  };
  const failed = clampCount(spec.failedCount) > 0 || spec.state === "halted" || spec.state === "blocked";
  // Live progress arc only while actually executing (active/planning) and mid-
  // flight — never on a static concept, a paused run, or a finished build.
  const pct = Math.min(100, Math.max(0, spec.progress));
  const executing = (spec.state === "active" || spec.state === "planning") && stage !== "built";
  const progressArc = executing && pct > 0 && pct < 100 ? pct / 100 : null;
  return { grown, ring, lanes, published: spec.published === true, progressArc, failed };
}


export type SceneMode = "garden" | "orbit";

// Garden horizon: pastoral hills (default) or the real Central Park far-field
// around Sheep Meadow (?env=park). Orbit mode ignores it.
export type SceneEnvironment = "meadow" | "park";

// Spatial layout strategies (visualizer parity: standard radial, H3 Poincaré
// ball after Munzner 1997, and the Lamping/Rao/Pirolli Poincaré disk).
export type SceneLayout = "radial" | "ball" | "disk";


// ── RESEARCH MODE specs ─────────────────────────────────────────────────────
// The 3D dialogue tree (VoxTerm's flat transcript list, grown into space): the
// conversation is a REAL TREE — a tapered trunk rises from the meadow, each
// concept topic grows a branch, speaker-colored turn leaves hang from their
// topic's branch — and research quests BUD off the exact turn they were
// grounded in — proposed crystals are clickable to spawn the research, a
// finished crystal opens the dossier deck.
export interface DialogueNodeSpec {
  id: string;
  speaker: string | null;
  text: string;
  atMs: number;
  // The concept branch this turn hangs from. Null/absent = unclustered (the
  // leaf falls back to the tree's single fallback branch).
  topicId?: string | null;
}


// One concept cluster over the dialogue window (the snapshot's dialogueTopics
// contract): a BRANCH of the conversation tree. Turns reference their topic
// via topicId; turnIds is the server's member list — grouping honors both, so
// neither side of the contract can strand a leaf.
export interface DialogueTopicSpec {
  id: string;
  label: string;
  turnIds: string[];
  freshAtMs: number;
}


export interface ResearchNodeSpec {
  id: string;
  topic: string;
  kind: "fact-check" | "deep-dive" | "bias-scan";
  status: "proposed" | "researching" | "complete" | "failed";
  confidence: number;
  progress: number;
  // The grounding turn id (dialogue anchor), when it is still in the window.
  turnId: string | null;
}


export interface RoomSceneProps {
  ideas: IdeaOrbSpec[];
  trees: TreeSpec[];
  mode: SceneMode;
  layout: SceneLayout;
  // Garden far-field: "meadow" hills or the real Central Park ("park").
  // Seeded by ?env=park and toggleable at runtime from the Controls dock —
  // switching swaps ground and horizon only; the tree/idea content and the
  // camera stay put.
  environment?: SceneEnvironment;
  // PLANTING MODE (the idea card's "Plant…" flow): while true, the pointer
  // hovers a ghost marker over the ground and a click hands the chosen spot
  // to onPlantPick instead of picking nodes. The scene validates the spot
  // (inside the park boundary / on the meadow, never in water).
  planting?: boolean;
  onPlantPick?: (point: { x: number; z: number }) => void;
  // Wall identity ("A" | "B" | …) or null. Seeds the default camera yaw (desk
  // mode) or selects this window's side of the corner-locked pair (gesture
  // mode) — it NEVER filters content.
  wall?: string | null;
  // CORNER LOCK (gesture mode with an explicit wall): this window is one half
  // of a rigid two-window pair rendering a single continuous world around the
  // physical 90° corner — fixed shared eye point, per-wall yaws exactly 90°
  // apart, exactly 90° horizontal FOV, and NO drift/orbit/fit/focus so the
  // seam edge stays coherent. Fixed per window (URL-derived).
  cornerLock?: boolean;
  // FLAT LOCK (?flat=1 with an explicit wall): the flat-rig sibling of the
  // corner lock — the two windows sit side by side on ONE physical wall, so
  // they render halves of a SINGLE wide frustum (shared eye, one shared view
  // direction, per-window setViewOffset — see flat-lock.ts) and the pair
  // tiles one continuous picture. Mouse/fit/focus/WASD stay gated off, but
  // the pinch camera may orbit/zoom the SHARED panorama: every window applies
  // the identical hands-stream deltas, keeping the pair in lockstep. Fixed
  // per window (URL-derived).
  flatLock?: boolean;
  // CONTINUOUS AUTO-FRAMING (dedicated displays — the research ceiling
  // projector): every ~0.75s the desk rig re-measures the content bounds and,
  // when the ideal framing drifted meaningfully (see shouldAutoRefit), writes
  // the fit targets so the existing lerp glides the camera out/recenters —
  // the whole conversation tree stays in view as it grows. Suspended during
  // manual camera input and for 4s after (autoFitSuspended); inert under the
  // corner/flat lock (rigid pairs may not move). Fixed per window
  // (URL-derived, like the locks).
  autoFit?: boolean;
  // Increment to request a one-shot fit-to-content camera move.
  fitSignal: number;
  // GUIDED-DEMO FOCUS: when set, the camera glides to frame this process's
  // node (retrying until the node exists, since a fresh spawn's tree appears a
  // beat after the snapshot). Null = no focus request; the user's own
  // drag/zoom/fit always takes over afterwards.
  focusUpid?: string | null;
  // When false (pure gesture mode: hands point, nobody drags), the pointer
  // never binds to the scene — no drag-orbit/pan/zoom/click, so pointing at a
  // node can never fight the camera. Keyboard camera controls (G/L/F) and the
  // dwell layer's raycast targeting still work. Fixed per window (URL-derived).
  pointerNav?: boolean;
  onAcceptIdea: (id: string | null) => void;
  // Tree pick → the anchored per-tree menu. `anchor` is the picked tree's
  // screen-projected bounding rect (the dwell rect), re-derived at pick time
  // so the menu opens BESIDE the tree instead of over it; null when the
  // projection is unavailable (degenerate rect / zero-size canvas).
  onSelectProcess: (callsign: string, anchor?: SceneDwellRect | null) => void;
  // A plain click on empty ground (no node hit, not a drag): App closes the
  // open tree menu. Mouse/touch only — dwell cursors have no "miss" gesture,
  // so the menu's ✕ button covers gesture mode.
  onPickMiss?: () => void;
  // BRANCH LIMB pick (adopted trees): open the branch's contextual popup.
  // `anchor` is the LIMB TIP's own projected rect (the SUB-OBJECT dwell
  // rect, re-derived at pick time) — never the whole-tree bbox — so the
  // glass opens beside the limb it belongs to. Optional: legacy callers/
  // tests without the popups simply get no-op limb picks.
  onPickBranch?: (callsign: string, branch: string, anchor: SceneDwellRect | null) => void;
  // ISSUE FRUIT pick (adopted trees): open the issue's contextual popup,
  // anchored to the FRUIT's own projected rect. Same optionality contract.
  onPickIssue?: (callsign: string, issueNumber: number, anchor: SceneDwellRect | null) => void;
  // RESEARCH MODE (all optional so legacy callers/tests are untouched): the
  // dialogue window + research quests to grow the conversation SKY from, and
  // the click handler for research rain (proposed → accept and spawn the
  // research; complete → open the dossier deck — App decides by status).
  dialogue?: DialogueNodeSpec[];
  // Concept clusters over the dialogue window: each topic condenses a CLOUD
  // of the conversation sky (the offline fallback when `sky` is absent).
  topics?: DialogueTopicSpec[];
  research?: ResearchNodeSpec[];
  onResearchNode?: (id: string) => void;
  // Click/dwell a CLOUD (it picks as its topic's freshest turn — the branch-
  // tip precedent): research that utterance directly.
  // A constellation was picked (click or dwell, star or whole patch): the turn
  // key, the constellation it belongs to, and the picked node's projected rect
  // so the topic card opens beside it. `cloudId` is null only for payloads
  // from before constellations carried their own id.
  onDialogueNode?: (turnId: string, cloudId: string | null, anchor: SceneDwellRect | null) => void;
  // The server's conversation sky (ProjectorSnapshot.sky): clouds remembered
  // BEYOND the rolling dialogue window + provenance-tagged relations. Absent
  // → clouds derive from `topics` and no wisps render (degradation gate).
  sky?: { clouds: SkyCloudRef[]; links: SkyLinkRef[]; agentAtMs: number | null; dust?: Array<{ atMs: number }> };
  // True while a research round's inference is in flight — the zenith core
  // brightens (the sky visibly "considers"). Real snapshot data, never a timer.
  researchThinking?: boolean;
  // Research-pinned window (?research=1 — the ceiling projector): seeds the
  // steep oblique boot pose over the cloud deck. Fixed per window like the
  // locks.
  skyView?: boolean;
  // SELF-REBUILD (armed walls): the room's OWN repository as ONE MORE garden
  // tree — the HD forest spec (open PRs as CI-tipped branches) fed by App's
  // useSelfRepoTree hook. Null/absent = no self tree (toggle off, ceiling
  // research pin, loader still warming). Rendered in the garden's radial
  // layout only, in the slot right after the fleet; identity is stable
  // (upid "self:repo") so reconciliation never churns it. While standing it
  // REPLACES the mirror process's generic fleet tree (visibleTreeSpecs) and
  // adopts the mirror's live TreeSpec from `trees`, so selecting it steers
  // the room itself.
  selfTree?: SelfTreeSpec | null;
}

// SELF-REBUILD repo tree (the room's OWN repository standing in the garden):
// the stable reconcile identity, the label accent, and the height adaptation
// — the forest spec authors trunks at 5.5–10u (org-grove scale), scaled so
// the self tree stands WITH the fleet trees, not over them.
export const SELF_TREE_UPID = "self:repo";

// The standing SELF process — the mirror, THE control surface for steering the
// room's own source — is pinned server-side with upid "self" / callsign
// "mirror" (src/self/commission.ts: SELF_UPID / SELF_CALLSIGN). That module
// sits behind server-only deps, so the UI matches on the upid STRING here
// instead of importing it.
export const SELF_PROCESS_UPID = "self";


// Node label title: the inferred project title when the server has named the
// build, else the callsign so a freshly spawned process is never label-less.
export function treeTitle(spec: TreeSpec): string {
  return spec.task.length > 0 ? spec.task : spec.callsign;
}


// The stage word carried onto every node label in every render style.
export function stageWord(stage: TreeSpec["stage"]): string {
  return stage === "built" ? "built" : stage === "commissioned" ? "commissioned" : "concept";
}


// Node label status: stage · state · progress, with the live steering marker
// appended so the steering target reads from across the room.
export function treeStatus(spec: TreeSpec): string {
  if (spec.statusText) return `${spec.statusText}${spec.steering ? " · recording" : ""}`;
  return `${stageWord(spec.stage)} · ${spec.state} · ${Math.round(spec.progress)}%${spec.steering ? " · ⟵ steering" : ""}`;
}


// ── the self-rebuild repo tree ↔ the mirror process ─────────────────────────
// The HD self-repo tree and the mirror process are ONE thing: while the HD
// tree is standing it REPLACES the mirror's generic fleet tree, adopts the
// mirror's LIVE TreeSpec, and picking it carries the mirror's callsign — so
// select → talk steers the room exactly like clicking the mirror's old node.
// All three seams are pure (no three.js) and unit-tested directly.

// Pure: the fleet specs reconcile actually grows. selfTreePresent = the HD
// self tree renders this pass (self-rebuild armed + forest loaded + garden
// radial); then the upid-"self" fleet spec (the mirror) is skipped — the HD
// tree stands in for it, never drawing the room twice. Whenever the HD tree
// is absent (unarmed, loader warming, orbit/hyperbolic layouts) the mirror
// keeps its normal fleet tree: a LIVE process never drops to zero
// representations.
export function visibleTreeSpecs(trees: TreeSpec[], selfTreePresent: boolean): TreeSpec[] {
  return selfTreePresent ? trees.filter((spec) => spec.upid !== SELF_PROCESS_UPID) : trees;
}


// Pure: the TreeSpec the HD self tree adopts — the mirror's live spec when
// the fleet carries it (state ring, steering pulse, hover keying and label
// chrome all reflect the real process), with a synthetic built/completed
// stand-in when the mirror is absent (demo snapshots, tests). The tree's pick
// payloads carry THIS spec's callsign, so the standard select path opens the
// mirror's detail and arms click-steer.
export function selfTreeProcessSpec(input: SelfTreeSpec, trees: TreeSpec[]): TreeSpec {
  return (
    trees.find((spec) => spec.upid === SELF_PROCESS_UPID) ?? {
      upid: SELF_TREE_UPID,
      callsign: input.repo,
      state: "completed",
      progress: 100,
      task: input.repo,
      steering: false,
      stage: "built",
    }
  );
}


// Pure: the pick payload one PR limb of the HD self tree carries. A branch
// with a real git ref is a FIRST-CLASS branch target (the branch popup opens
// beside it, exactly like an adopted tree's limb); a ref-less spec branch has
// no git meaning, so picking it falls back to selecting the whole tree rather
// than becoming a dead end.
export function selfBranchPick(
  branch: TreeBranchSpec3D,
  callsign: string,
): { kind: "branch"; callsign: string; branch: string } | { kind: "process"; callsign: string } {
  const ref = typeof branch.ref === "string" && branch.ref.length > 0 ? branch.ref : null;
  return ref !== null ? { kind: "branch", callsign, branch: ref } : { kind: "process", callsign };
}


// Pure label chrome for the HD self tree: the title reads the live mirror
// process (inferred title, falling back to the callsign), the sub keeps the
// repo-name + open-PR flavor and appends the live steering marker so the
// steering target reads from across the room.
export function selfTreeLabel(input: SelfTreeSpec, spec: TreeSpec): { title: string; sub: string } {
  const prCount = input.spec.branches.length;
  return {
    title: treeTitle(spec),
    sub: `${input.repo} · ${prCount} open PR${prCount === 1 ? "" : "s"}${spec.steering ? " · ⟵ steering" : ""}`,
  };
}


export function buildsSummaryChanged(a: TreeBuildSummary | undefined, b: TreeBuildSummary | undefined): boolean {
  return (
    (a?.building ?? 0) !== (b?.building ?? 0) ||
    (a?.ready ?? 0) !== (b?.ready ?? 0) ||
    (a?.failed ?? 0) !== (b?.failed ?? 0)
  );
}


// Structural spec comparison: TRUE when the node's SHAPE changed and the entry
// must be disposed and regrown — identity, state, stage, steering, indicators,
// or the live progress arc appearing/vanishing (its mesh only exists mid-
// flight). Progress ticking WITHIN a stage is deliberately NOT structural: a
// live build reports ~1% ticks for hours, and rebuilding the whole entry
// (geometries, materials, canvas label textures) per tick churned the GPU on
// long-lived projector tabs. Those ticks update the existing entry in place
// instead (label repaint, arc sweep, orb growth) — see reconcile. Exported for
// tests; kept free of three.js like treeIndicators.
export function treeSpecStructurallyChanged(a: TreeSpec, b: TreeSpec): boolean {
  return (
    a.state !== b.state || a.callsign !== b.callsign || a.task !== b.task ||
    a.steering !== b.steering || a.stage !== b.stage ||
    (a.published ?? false) !== (b.published ?? false) ||
    (a.failedCount ?? 0) !== (b.failedCount ?? 0) ||
    buildsSummaryChanged(a.builds, b.builds) ||
    // ADOPTION is structural: gaining/losing a remoteUrl flips the tree from
    // sapling to full-grown (treeIndicators.grown) even when no room/* branch
    // exists yet, so the HD body must regrow at its adult trunk family.
    (a.treeRepo?.remoteUrl != null) !== (b.treeRepo?.remoteUrl != null) ||
    // Limbs/fruit are part of the tree's BODY: a room/* branch appearing, a
    // commit landing, a PR opening, or the issue set shifting regrows the
    // entry — signature-gated exactly like every other structural change, so
    // an unchanged snapshot tick stays a no-op.
    limbSignature(a.treeRepo) !== limbSignature(b.treeRepo) ||
    fruitSignature(a.issues) !== fruitSignature(b.issues) ||
    (treeIndicators(a).progressArc === null) !== (treeIndicators(b).progressArc === null)
  );
}


// ── continuous auto-framing (dedicated displays — the ceiling projector) ────
// The desk rig re-measures the content bounds on this cadence and glides
// out/recenters by itself when the scene outgrew the frame, so a pinned
// window keeps the WHOLE conversation tree in view with nobody at the desk.
export const AUTO_FIT_INTERVAL_MS = 750;

// Manual camera input (drag / wheel / WASD / pinch / joystick) suspends the
// auto-framing; it resumes this long after the LAST touch.
export const AUTO_FIT_RESUME_MS = 4000;

// Hysteresis so idle scenes never twitch: only refit when the ideal radius
// moved more than this fraction of the current one…
export const AUTO_FIT_RADIUS_RATIO = 0.06;

// …or the ideal orbit-target centre drifted farther than this (world units).
export const AUTO_FIT_CENTER_DRIFT = 0.3;


// The rig framing the decision compares: the orbit target on the ground plane
// plus the orbit radius (height follows radius in the fit maths, so it never
// votes separately). Pure data — no three.js — so tests stay render-free.
export interface AutoFitFraming {
  targetX: number;
  targetZ: number;
  radius: number;
}


// The "should refit" hysteresis decision, extracted pure for tests: TRUE when
// the ideal fit differs meaningfully from the current DESIRED rig (the d*
// lerp targets — comparing desired-to-desired means a completed refit is a
// fixed point, so a static scene can never oscillate).
export function shouldAutoRefit(current: AutoFitFraming, ideal: AutoFitFraming): boolean {
  const radiusBase = Math.max(Math.abs(current.radius), 1e-6);
  if (Math.abs(ideal.radius - current.radius) / radiusBase > AUTO_FIT_RADIUS_RATIO) {
    return true;
  }
  const dx = ideal.targetX - current.targetX;
  const dz = ideal.targetZ - current.targetZ;
  return Math.hypot(dx, dz) > AUTO_FIT_CENTER_DRIFT;
}


// The suspend gate, also pure for tests: auto-framing pauses while input is
// live (drag / external pinch grab) and for AUTO_FIT_RESUME_MS after the last
// input stamp, then resumes.
export function autoFitSuspended(nowMs: number, lastInputMs: number, inputActive: boolean): boolean {
  return inputActive || nowMs - lastInputMs < AUTO_FIT_RESUME_MS;
}
