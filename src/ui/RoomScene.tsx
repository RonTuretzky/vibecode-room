import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { IdeaTrayItem, ProjectorProcess } from "./types";
import { registerSceneDwellSource, SCENE_PROC_TARGET_PREFIX, type SceneDwellRect } from "./gesture/scene-source";
import { registerSceneCameraControl } from "./gesture/camera-source";
import { getFlatPoseSender, registerSceneFlatPoseControl } from "./gesture/flat-pose-source";
import { cornerEye, cornerVerticalFovDeg, cornerYaw } from "./corner-lock";
import { FLAT_EYE_DISTANCE, FLAT_EYE_HEIGHT, FLAT_YAW, flatVerticalFovDeg, flatViewOffset } from "./flat-lock";
import { loadGardenFlora, type FloraLibrary } from "./garden-flora";
import { buildCentralPark, loadCentralParkLayout, type CentralParkBuild } from "./central-park";
import type { SelfTreeSpec } from "./self-repo";
import {
  buildTreeLOD,
  hashSeed,
  treeSpecSignature,
  type BuiltTree,
  type TreeBranchSpec3D,
  type TreeSpec3D,
} from "./tree";
import {
  ACTIVE_MS,
  MAX_WISPS,
  R_HORIZON,
  SKY_ALT,
  SKY_FAN_HALF,
  cloudAge,
  cloudAltitude,
  cloudRadius,
  staggeredRadius,
  fanAzimuth,
  gravitatedAzimuth,
  lifeFactor,
  mergeTarget,
  puffCount,
  puffRadius,
  questCloudId,
  radiusNorm,
  resolveClouds,
  rimFactor,
  rimFlatten,
  selectWisps,
  spreadAzimuths,
  strongestPartner,
  type ResolvedCloud,
  type SkyCloudRef,
  type SkyLinkRef,
} from "./sky/cloud-layout";
import {
  SAPLING_LIMB_SCALE,
  fleetTreeSpec3D,
  fruitSignature,
  fruitSpecs,
  holoArcPoints,
  limbSignature,
  resolveScenePick,
  spineHitPoints,
  type IssueInfo,
  type ScenePickPayload,
  type TreeRepoInfo,
} from "./tree-limbs";
import { processHitVolumes } from "./tree-hit-volumes";

// The pure conversation-tree layout maths now live in the reusable HD tree
// module (src/ui/tree/dialogue-layout.ts) — re-exported here so every existing
// consumer and the RoomScene.test.ts suite keep their import path.
export {
  dialogueBranchLength,
  dialogueBranchPoint,
  dialogueBranches,
  dialogueLeafPosition,
  dialogueLeafT,
  dialogueTrunkHeight,
  type DialogueBranch,
} from "./tree";

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

function clampCount(value: number | undefined): number {
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

interface RoomSceneProps {
  ideas: IdeaOrbSpec[];
  trees: TreeSpec[];
  mode: SceneMode;
  layout: SceneLayout;
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
  onDialogueNode?: (turnId: string) => void;
  // The server's conversation sky (ProjectorSnapshot.sky): clouds remembered
  // BEYOND the rolling dialogue window + provenance-tagged relations. Absent
  // → clouds derive from `topics` and no wisps render (degradation gate).
  sky?: { clouds: SkyCloudRef[]; links: SkyLinkRef[]; agentAtMs: number | null };
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
  // CENTRAL PARK (?park=1): lay the real park under the garden as a stylized
  // diorama (baked OSM layers + the surveyed trees — see central-park.ts).
  // Fixed per window (URL-derived, like the locks).
  park?: boolean;
}

const MATURITY_COLOR: Record<IdeaTrayItem["maturity"], number> = {
  forming: 0x38bdf8,
  proposed: 0x38bdf8,
  elaborated: 0x00bcd4,
  actionable: 0x00ff88,
};
const STATE_COLOR: Record<TreeSpec["state"], number> = {
  planning: 0x38bdf8,
  active: 0x00ff88,
  paused: 0xf5a623,
  halted: 0xff3b30,
  blocked: 0xff5544,
  completed: 0x9affc9,
};
const BUD_COLOR = 0x6b8296;
const VERIFIED_COLOR = 0x9affc9;
const STEERING_COLOR = 0x9ee2ff;
// Gold ground ring marking a COMMISSIONED project (real execution running).
const COMMISSION_COLOR = 0xffd166;
// Brighter completion ring for a BUILT project (execution finished).
const BUILT_RING_COLOR = 0xffe6a3;
// Build-lane satellite palette (mocking / mock-ready / failed).
const LANE_BUILDING_COLOR = 0xf5a623;
const LANE_READY_COLOR = 0x00ff88;
const LANE_FAILED_COLOR = 0xff3b30;
// Take-home publish beacon + the live progress arc + failure pip.
const PUBLISHED_COLOR = 0x9ee2ff;
const PROGRESS_ARC_COLOR = 0x9affc9;
const FAILED_PIP_COLOR = 0xff3b30;
const FLASH_MS = 1500;
// SELF-REBUILD repo tree (the room's OWN repository standing in the garden):
// the stable reconcile identity, the label accent, and the height adaptation
// — the forest spec authors trunks at 5.5–10u (org-grove scale), scaled so
// the self tree stands WITH the fleet trees, not over them.
export const SELF_TREE_UPID = "self:repo";
const SELF_TREE_ACCENT = 0x8fd8a8;
const SELF_TREE_SCALE = 0.75;
// The standing SELF process — the mirror, THE control surface for steering the
// room's own source — is pinned server-side with upid "self" / callsign
// "mirror" (src/self/commission.ts: SELF_UPID / SELF_CALLSIGN). That module
// sits behind server-only deps, so the UI matches on the upid STRING here
// instead of importing it.
export const SELF_PROCESS_UPID = "self";

// Research crystal colors reuse the FIXED status semantics: proposed=planning
// blue, researching=active green, complete=completed mint, failed=halted red.
const RESEARCH_STATUS_COLOR: Record<ResearchNodeSpec["status"], number> = {
  proposed: 0x38bdf8,
  researching: 0x00ff88,
  complete: 0x9affc9,
  failed: 0xff3b30,
};
// Speaker identity palette (NOT status colors — cool identity tints, no
// violet): deterministic per speaker name so a voice keeps its color.
const SPEAKER_COLORS = [0x9ee2ff, 0x7fe0c3, 0xffd9a0, 0xa8c7ff, 0xffb3c7, 0xd6f0a0];
// The conversation SKY. Research is a MODE SWITCH (the idea garden hides
// while it is on), so looking up you see CLOUDS: one sculpted cumulus per
// concept topic on a polar time disc (zenith = now, horizon = the past — the
// pure laws live in sky/cloud-layout.ts), wisps between related clouds
// (WARM = the agent thread said so, COOL = deterministic lexical fallback),
// and research quests hanging under their cloud as status-colored RAIN.
// Render caps for the preallocated one-draw-call buffers.
const SKY_MAX_CLOUDS = 14;
const SKY_MAX_PUFFS_PER_CLOUD = 16;
const SKY_MAX_PUFFS = SKY_MAX_CLOUDS * SKY_MAX_PUFFS_PER_CLOUD;
// Wisps render as soft additive RIBBONS (real width + a feathered edge — a
// 1px hairline reads as a lens scratch at projector distance): per wisp,
// SKY_WISP_SEGMENTS quads of 6 non-indexed vertices.
const SKY_WISP_SEGMENTS = 12;
const SKY_MAX_WISP_VERTS = 12 * SKY_WISP_SEGMENTS * 6;
// Rain: slanted streak quads (6 verts each) — a real shower spread under the
// cloud base with varied length/alpha (a few 1px ticks read as a glitch).
const SKY_MAX_RAIN_QUESTS = 12;
const SKY_MAX_RAIN_STREAKS = 10;
const SKY_MAX_RAIN_VERTS = SKY_MAX_RAIN_QUESTS * SKY_MAX_RAIN_STREAKS * 6;
// Wisp provenance colors — the sky's honesty surface: a link the agent thread
// judged glows WARM amber; the deterministic lexical fallback stays COOL ice
// (bright cores for projector legibility but kept r>b vs r<b, so a
// background-subtracted pixel probe still separates the two provenances).
const WISP_AGENT_COLOR = 0xffb27a;
const WISP_LEXICAL_COLOR = 0x8fd0ff;
// Cloud body ramp: dormant clouds sit lavender-grey; an ACTIVE cloud burns
// near-white (the focal law: the newest cloud must be unmistakable at a
// glance). Aged clouds additionally haze toward the dusk (aerial perspective).
const CLOUD_ACTIVE_COLOR = 0xf4f7fa;
const CLOUD_DORMANT_COLOR = 0x93a2bc;
// Green NOW accent for the active cloud's card (matches the ready-state green
// the room already speaks).
const CLOUD_NOW_ACCENT = 0x6ee7a0;
// Raw-sRGB working copies for the sky shaders (see rawColor below): the ramp
// endpoints the frame loop lerps between and the ribbon provenance colors.
const CLOUD_ACTIVE_RGB = rawColor(CLOUD_ACTIVE_COLOR);
const CLOUD_DORMANT_RGB = rawColor(CLOUD_DORMANT_COLOR);
const WISP_AGENT_RGB = rawColor(WISP_AGENT_COLOR);
const WISP_LEXICAL_RGB = rawColor(WISP_LEXICAL_COLOR);
// Rain: the status hue pulled WELL toward blue-grey so streaks read as
// weather (the semantics stay — blue proposed / green researching / mint
// complete / red failed — as a tint on the shower, not neon ticks; the
// droplet glow at the head keeps the saturated status color for the read).
const RAIN_GREY_RGB = rawColor(0x9db4cc);
const RAIN_STATUS_RGB: Record<ResearchNodeSpec["status"], THREE.Color> = {
  proposed: rawColor(RESEARCH_STATUS_COLOR.proposed).lerp(RAIN_GREY_RGB, 0.62),
  researching: rawColor(RESEARCH_STATUS_COLOR.researching).lerp(RAIN_GREY_RGB, 0.55),
  complete: rawColor(RESEARCH_STATUS_COLOR.complete).lerp(RAIN_GREY_RGB, 0.45),
  failed: rawColor(RESEARCH_STATUS_COLOR.failed).lerp(RAIN_GREY_RGB, 0.65),
};

function speakerColor(speaker: string | null): number {
  if (speaker === null || speaker.length === 0) {
    return SPEAKER_COLORS[0];
  }
  let hash = 0;
  for (let index = 0; index < speaker.length; index += 1) {
    hash = (hash * 31 + speaker.charCodeAt(index)) >>> 0;
  }
  return SPEAKER_COLORS[hash % SPEAKER_COLORS.length];
}

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

function buildsSummaryChanged(a: TreeBuildSummary | undefined, b: TreeBuildSummary | undefined): boolean {
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

// ── hyperbolic layout constants (after the visualizer's H3/disk modes) ───────
// Poincaré radial coordinates r ∈ (0,1): shells picked via tanh(d/2) for a
// hyperbolic edge length d; display scale is the conformal factor 1 - r².
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const BALL_RADIUS = 5.8;
const BALL_CENTER_Y = 3.6;
const BALL_SHELL_PROC = 0.5; // tanh(1.1/2)
const BALL_SHELL_READY = 0.74; // tanh(1.9/2)
const BALL_SHELL_FORMING = 0.87; // tanh(2.65/2)
const DISK_RADIUS = 7.2;
const DISK_R_PROC = 0.45;
const DISK_R_READY = 0.7;
const DISK_R_FORMING = 0.87;

// Evenly spread point i of n over the unit sphere (Fibonacci sphere).
function fibSphereDir(i: number, n: number): THREE.Vector3 {
  const z = 1 - (2 * (i + 0.5)) / Math.max(n, 1);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = i * GOLDEN_ANGLE;
  return new THREE.Vector3(r * Math.cos(phi), z, r * Math.sin(phi));
}

// Conformal Poincaré scale: nodes shrink toward the boundary (focus+context).
function poincareScale(r: number): number {
  return Math.max(1 - r * r, 0.22);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ideaKey(spec: IdeaOrbSpec): string {
  return spec.id ?? "__primary__";
}

// Per-wall DEFAULT camera yaw: wall A (or no wall) faces the scene head-on and
// each subsequent wall letter starts ~32° further around the orbit, so two
// projections of the same full room don't boot pixel-identical. This is purely
// the boot framing — every window's drag/zoom/fit owns its camera afterwards,
// and the seed NEVER filters what the scene contains.
function wallYawSeed(wall: string | null | undefined): number {
  if (wall === null || wall === undefined || wall.length === 0) {
    return 0;
  }
  const step = wall.trim().toUpperCase().charCodeAt(0) - 65; // "A" → 0, "B" → 1, …
  if (!Number.isFinite(step) || step <= 0) {
    return 0;
  }
  return (step % 8) * 0.55;
}

function cssHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

// Raw-sRGB color for the sky's hand-authored ShaderMaterials: THREE's color
// management converts hex to the linear working space, but a raw shader
// writes its output UNENCODED — authored hexes come out dark. Storing the raw
// sRGB bytes makes the shader output match the intended hex on screen.
function rawColor(hex: number): THREE.Color {
  const color = new THREE.Color();
  color.setRGB(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255, THREE.LinearSRGBColorSpace);
  return color;
}

// Canvas-texture label sprite: word-wrapped title over a rounded glass card,
// always on top, scaled to the true canvas aspect.
function makeLabelSprite(title: string, statusLine: string, accentCss: string): THREE.Sprite {
  const dpr = 2;
  const maxWidth = 220;
  const padX = 13;
  const padY = 9;
  const titleFont = "600 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const statusFont = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = titleFont;
  // Overflow guards: (1) clamp long titles to ~28 chars with an ellipsis —
  // the full title lives in the tree menu / hover card; (2) a single unbroken
  // word (repo names like "conductor-github-visualizer") can still measure
  // wider than the card, so every drawn line is measure-trimmed to fit.
  const titleMax = 28;
  const clamped = title.length > titleMax ? `${title.slice(0, titleMax - 1).trimEnd()}…` : title;
  const innerWidth = maxWidth - padX * 2;
  const fitLine = (line: string): string => {
    if (measure.measureText(line).width <= innerWidth) {
      return line;
    }
    let cut = line;
    while (cut.length > 1 && measure.measureText(`${cut}…`).width > innerWidth) {
      cut = cut.slice(0, -1);
    }
    return `${cut.trimEnd()}…`;
  };
  const words = clamped.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const attempt = current.length > 0 ? `${current} ${word}` : word;
    if (measure.measureText(attempt).width > innerWidth && current.length > 0) {
      lines.push(fitLine(current));
      current = word;
      if (lines.length === 3) {
        break;
      }
    } else {
      current = attempt;
    }
  }
  if (lines.length < 3 && current.length > 0) {
    lines.push(fitLine(current));
  } else if (current.length > 0) {
    lines[2] = fitLine(`${lines[2].slice(0, 26)}…`);
  }
  const widest = Math.max(...lines.map((line) => measure.measureText(line).width), measure.measureText(statusLine).width * 0.8);
  const width = Math.min(maxWidth, Math.ceil(widest) + padX * 2);
  const lineHeight = 17;
  const statusHeight = statusLine.length > 0 ? 15 : 0;
  const height = padY * 2 + lines.length * lineHeight + statusHeight;

  const canvas = document.createElement("canvas");
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  const paint = (status: string) => {
    ctx.clearRect(0, 0, width, height);
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, width - 1, height - 1, 9);
    ctx.fillStyle = "rgba(6, 16, 24, 0.78)";
    ctx.fill();
    ctx.strokeStyle = "rgba(158, 226, 255, 0.2)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = titleFont;
    ctx.fillStyle = "#eaf6ff";
    ctx.textBaseline = "top";
    lines.forEach((line, i) => ctx.fillText(line, padX, padY + i * lineHeight));
    if (status.length > 0) {
      ctx.font = statusFont;
      ctx.fillStyle = accentCss;
      ctx.fillText(status.toUpperCase(), padX, padY + lines.length * lineHeight + 2);
    }
  };
  paint(statusLine);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  const worldScale = 1 / 56;
  sprite.scale.set(width * worldScale, height * worldScale, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 12;
  // Status-only repaint hook (live progress ticks): redraw the SAME canvas and
  // re-upload it (needsUpdate) — no new texture/material/sprite allocation.
  // The card geometry is frozen at build width; a percent tick shifts the
  // status by a couple px at most, and any structural change (state, stage,
  // title, steering) rebuilds the whole label anyway.
  sprite.userData.updateStatus = (status: string) => {
    paint(status);
    texture.needsUpdate = true;
  };
  return sprite;
}

// Repaint an existing label sprite's status line in place (see the
// updateStatus hook above) — the sprite, material, canvas and texture persist.
function updateLabelStatus(label: THREE.Sprite, status: string): void {
  (label.userData.updateStatus as ((status: string) => void) | undefined)?.(status);
}

// Soft radial glow texture (halos, moon, auroras) tinted via material color.
function makeGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,0.85)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.28)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

// Procedural butterfly wing for ONE side (forewing + hindwing lobes) painted
// with transparent surround: the plane it maps is alpha-tested, so this one
// canvas provides the two-lobed silhouette AND the pattern — dark basal
// suffusion, veins radiating from the root, a dark margin band with pale
// spots, and a hindwing eyespot. Texture space: u=0 body hinge → u=1 tip,
// v=1 (canvas top) is the head end. The base hue comes from the palette.
function makeButterflyWingTexture(base: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(base).getHSL(hsl);
  const tint = (dl: number, a: number): string => {
    const c = new THREE.Color().setHSL(hsl.h, hsl.s, THREE.MathUtils.clamp(hsl.l + dl, 0, 1));
    return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
  };
  const dark = (a: number): string => `rgba(38,28,24,${a})`;
  // Silhouette: costal edge sweeping to the forewing apex, a shallow notch,
  // then the rounder hindwing lobe with a scalloped trailing edge.
  const trace = (): void => {
    ctx.beginPath();
    ctx.moveTo(4, 70);
    ctx.quadraticCurveTo(90, 10, 212, 30); // leading (costal) edge
    ctx.quadraticCurveTo(242, 46, 208, 100); // rounded apex → outer margin
    ctx.quadraticCurveTo(140, 96, 100, 116); // deep notch cutting between lobes
    ctx.quadraticCurveTo(206, 128, 180, 188); // hindwing outer bulge
    ctx.quadraticCurveTo(150, 234, 96, 238); // trailing scallop
    ctx.quadraticCurveTo(60, 240, 34, 218); // anal lobe
    ctx.quadraticCurveTo(12, 196, 4, 152); // back to the body line
    ctx.closePath();
  };
  // Base fill: lighter at the root, deepening slightly toward the margins.
  const shade = ctx.createRadialGradient(14, 120, 8, 14, 120, 250);
  shade.addColorStop(0, tint(0.1, 1));
  shade.addColorStop(0.55, tint(0, 1));
  shade.addColorStop(1, tint(-0.08, 1));
  trace();
  ctx.fillStyle = shade;
  ctx.fill();
  // Everything else clips to the silhouette so the alpha edge stays crisp.
  ctx.save();
  trace();
  ctx.clip();
  // Dark basal suffusion where the wing meets the body.
  const basal = ctx.createRadialGradient(6, 120, 0, 6, 120, 85);
  basal.addColorStop(0, dark(0.55));
  basal.addColorStop(1, dark(0));
  ctx.fillStyle = basal;
  ctx.fillRect(0, 0, size, size);
  // Veins radiating from the root across each lobe.
  ctx.strokeStyle = dark(0.4);
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  const vein = (x0: number, y0: number, x1: number, y1: number, bow: number): void => {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo((x0 + x1) / 2, (y0 + y1) / 2 + bow, x1, y1);
    ctx.stroke();
  };
  vein(12, 96, 222, 34, -16);
  vein(12, 98, 226, 62, -14);
  vein(12, 102, 204, 92, -8);
  vein(12, 106, 160, 102, -4);
  vein(12, 148, 190, 148, 6);
  vein(12, 152, 174, 184, 10);
  vein(12, 156, 132, 220, 12);
  vein(12, 160, 76, 230, 10);
  // Dark margin band around the whole outline (half the stroke lands
  // inside the clip), with a soft wide underlay.
  trace();
  ctx.strokeStyle = dark(0.25);
  ctx.lineWidth = 36;
  ctx.stroke();
  trace();
  ctx.strokeStyle = dark(0.92);
  ctx.lineWidth = 16;
  ctx.stroke();
  // Pale spots riding the dark margin near the apex + hindwing edge.
  ctx.fillStyle = "rgba(255,252,244,0.85)";
  for (const [x, y, r] of [[218, 44, 6], [212, 70, 5], [196, 90, 4.5], [172, 182, 3.5], [138, 218, 3.5]] as const) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Hindwing eyespot: dark ring, pale iris, dark pupil, white glint.
  ctx.fillStyle = dark(0.95);
  ctx.beginPath();
  ctx.arc(148, 168, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = tint(0.16, 1);
  ctx.beginPath();
  ctx.arc(148, 168, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = dark(0.95);
  ctx.beginPath();
  ctx.arc(148, 168, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.arc(145.5, 165.5, 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// Gradient sky dome (visualizer technique) with a 3-stop ramp for extra depth.
// NOTE: BackSide alone makes the sphere visible from inside — flipping the
// geometry with scale(-1,1,1) on top of it double-inverts the winding and the
// dome vanishes (the sky rendered as the black clear color for months).
// `rawSrgb` keeps the authored hexes as-is (see rawColor): the dome shader
// writes unencoded output, so converted colors render darker than authored —
// the orbit night wants that moody sink, the research dusk wants true color.
function makeSkyDome(bottom: number, mid: number, top: number, rawSrgb = false): THREE.Mesh {
  const toColor = rawSrgb ? rawColor : (hex: number) => new THREE.Color(hex);
  const geom = new THREE.SphereGeometry(160, 32, 32);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      bottomColor: { value: toColor(bottom) },
      midColor: { value: toColor(mid) },
      topColor: { value: toColor(top) },
      offset: { value: 20 },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 bottomColor;
      uniform vec3 midColor;
      uniform vec3 topColor;
      uniform float offset;
      varying vec3 vWorldPosition;
      void main() {
        float h = clamp(normalize(vWorldPosition + offset).y, 0.0, 1.0);
        vec3 color = h < 0.35
          ? mix(bottomColor, midColor, smoothstep(0.0, 0.35, h))
          : mix(midColor, topColor, smoothstep(0.35, 1.0, h));
        // Screen-space dither: ±1 LSB of hash noise breaks the visible
        // banding rings a smooth 8-bit gradient otherwise develops.
        float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        gl_FragColor = vec4(color + dither * (1.5 / 255.0), 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  });
  return new THREE.Mesh(geom, mat);
}

function makeStars(rng: () => number, count: number, size: number, opacity: number, fullDome: boolean): THREE.Points {
  const positions: number[] = [];
  for (let i = 0; i < count; i++) {
    const theta = rng() * Math.PI * 2;
    const phi = rng() * Math.PI * (fullDome ? 0.62 : 0.42) + 0.06;
    const r = 130;
    positions.push(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.Points(geom, new THREE.PointsMaterial({ color: 0xdcecff, size, transparent: true, opacity, fog: false }));
}

interface SceneEnv {
  // The env's root group — exposed so the research sky can hide the daylight
  // environment wholesale (the ceiling is its own dusk world) and restore it.
  group: THREE.Group;
  update: (t: number, dt: number) => void;
  dispose: () => void;
}

type EntryKind = "tree" | "flower" | "orb-proc" | "orb-idea" | "cloud" | "research";

interface Entry {
  kind: EntryKind;
  ideaSpec?: IdeaOrbSpec;
  treeSpec?: TreeSpec;
  dialogueSpec?: DialogueNodeSpec;
  researchSpec?: ResearchNodeSpec;
  // CONVERSATION-SKY cloud entries: the resolved cloud this entry renders,
  // its deterministic puff lobes (packed [ox,oy,oz,size,shade] per lobe —
  // written into the shared Points buffer each frame), its body tint, and the
  // slow-refresh layout caches (age norm / life factor, updated on the 1s
  // relayout tick so the frame loop never calls Date.now per cloud).
  cloudSpec?: ResolvedCloud;
  cloudPuffs?: Float32Array;
  cloudPuffN?: number;
  cloudColor?: THREE.Color;
  cloudHit?: THREE.Mesh;
  cloudNorm?: number;
  cloudLife?: number;
  cloudHasAgentLink?: boolean;
  // Speaker tint folded into the body ramp (≤12% — composition, not carnival)
  // and the hash altitude jitter, cached so relayout never re-derives them.
  cloudTint?: THREE.Color;
  cloudJitter?: number;
  // Per-frame pass-1 product: the cloud's shared alpha for pass 2 (the depth-
  // sorted lobe write) — computed once per cloud, consumed per lobe.
  cloudAlphaBase?: number;
  // Research-rain entries: lateral shower spread under the parent cloud's
  // footprint (set at reconcile from the cloud's own radius).
  rainSpread?: number;
  group: THREE.Group;
  mats: (THREE.MeshPhongMaterial | THREE.MeshStandardMaterial)[];
  baseEmissive: number;
  head: THREE.Group | null;
  headY: number;
  // A little companion cat parked next to a garden tree — the frame loop sways
  // it so it "dances" (skips reduced-motion). Null on every non-tree entry.
  cat: THREE.Group | null;
  // The cat's parked X so the dance sway pivots around it (0 when no cat).
  catBaseX: number;
  // Floating crystal-mana shards ringing a garden tree — the frame loop spins
  // and bobs each one. Absent on every non-tree entry.
  mana?: THREE.Mesh[];
  label: THREE.Sprite | null;
  targetPos: THREE.Vector3;
  targetScale: number;
  // Conformal Poincaré factor (1 near the centre, small near the boundary).
  scaleMult: number;
  phase: number;
  flashStart: number | null;
  removing: boolean;
  // In-place progress refresh (label % repaint, live arc sweep, orb growth):
  // reconcile calls it when ONLY progress ticked, so a live build never pays a
  // full dispose+rebuild per 1% tick. Absent on idea entries (ideas rebuild
  // through ideaSpecChanged, which has no per-tick channel).
  updateProgress?: (spec: TreeSpec) => void;
  // The self-repo tree's spec signature (treeSpecSignature): reconcile only
  // rebuilds the entry when the forest payload actually changed shape.
  selfSig?: string;
  // HD-engine body sway (fleet trees grown by buildTreeLOD): the frame loop
  // calls it so the instanced foliage sways; absent on non-HD entries and
  // skipped whole under prefers-reduced-motion.
  bodyUpdate?: (t: number) => void;
  // Module-owned GPU resources beyond the generic sweep (an HD body's
  // BuiltTree): disposeEntry invokes it after the traverse.
  disposeExtra?: () => void;
}

export function RoomScene({ ideas, trees, mode, layout, wall = null, fitSignal, focusUpid = null, pointerNav = true, cornerLock = false, flatLock = false, autoFit = false, onAcceptIdea, onSelectProcess, onPickMiss, onPickBranch, onPickIssue, dialogue = [], topics = [], research = [], onResearchNode, onDialogueNode, sky, researchThinking = false, skyView = false, selfTree = null, park = false }: RoomSceneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const ideasRef = useRef(ideas);
  ideasRef.current = ideas;
  const treesRef = useRef(trees);
  treesRef.current = trees;
  const dialogueRef = useRef(dialogue);
  dialogueRef.current = dialogue;
  const topicsRef = useRef(topics);
  topicsRef.current = topics;
  const researchRef = useRef(research);
  researchRef.current = research;
  const skyRef = useRef(sky);
  skyRef.current = sky;
  const researchThinkingRef = useRef(researchThinking);
  researchThinkingRef.current = researchThinking;
  // Same deal as the locks: the sky view is URL-derived and fixed per window.
  const skyViewRef = useRef(skyView);
  skyViewRef.current = skyView;
  const selfTreeRef = useRef(selfTree);
  selfTreeRef.current = selfTree;
  const onResearchRef = useRef(onResearchNode);
  onResearchRef.current = onResearchNode;
  const onDialogueRef = useRef(onDialogueNode);
  onDialogueRef.current = onDialogueNode;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // Wall identity is fixed per window (parsed from the URL once); a ref keeps
  // the mount-once scene effect honest about never re-running for it.
  const wallRef = useRef(wall);
  wallRef.current = wall;
  // Same deal: gesture windows never rebind pointer navigation mid-session.
  const pointerNavRef = useRef(pointerNav);
  pointerNavRef.current = pointerNav;
  // Same deal: the corner lock is URL-derived and fixed for the window's life.
  const cornerLockRef = useRef(cornerLock);
  cornerLockRef.current = cornerLock;
  // Same deal: the Central Park layer is URL-derived and fixed per window.
  const parkRef = useRef(park);
  parkRef.current = park;
  // Same deal: the flat lock is URL-derived and fixed for the window's life.
  const flatLockRef = useRef(flatLock);
  flatLockRef.current = flatLock;
  // Same deal: auto-fit is URL-derived (App: ?research/?autofit) and fixed.
  const autoFitRef = useRef(autoFit);
  autoFitRef.current = autoFit;
  const fitRef = useRef(fitSignal);
  fitRef.current = fitSignal;
  const focusRef = useRef<string | null>(focusUpid);
  focusRef.current = focusUpid;
  const onAcceptRef = useRef(onAcceptIdea);
  onAcceptRef.current = onAcceptIdea;
  const onSelectRef = useRef(onSelectProcess);
  onSelectRef.current = onSelectProcess;
  const onPickMissRef = useRef(onPickMiss);
  onPickMissRef.current = onPickMiss;
  const onPickBranchRef = useRef(onPickBranch);
  onPickBranchRef.current = onPickBranch;
  const onPickIssueRef = useRef(onPickIssue);
  onPickIssueRef.current = onPickIssue;
  const tick = useRef(0);

  useEffect(() => {
    tick.current += 1;
  }, [ideas, trees, mode, layout, dialogue, topics, research, sky, selfTree]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || typeof window === "undefined") {
      return;
    }
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 400);
    // Two-wall default mode runs TWO simultaneous fullscreen WebGL contexts on
    // one machine, so keep the renderer settings sane: prefer the discrete GPU,
    // cap the pixel ratio, and (below) pause the frame loop while hidden.
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Software rasterizers (headless test Chromium, GPU-less kiosks) crawl
    // under the photoscan flora — they keep the sky/ground and the primitive
    // node glyphs, and skip the instanced vegetation + real-model nodes.
    const debugInfo = renderer.getContext().getExtension("WEBGL_debug_renderer_info");
    const gpuName = debugInfo === null ? "" : String(renderer.getContext().getParameter(debugInfo.UNMASKED_RENDERER_WEBGL));
    const softwareGL = /swiftshader|llvmpipe|softpipe|software/i.test(gpuName);
    container.appendChild(renderer.domElement);

    // Lighting is per-environment (added to each env's group): the garden is a
    // sunny pastoral day, orbit keeps the cool night rig — one global rig can't
    // serve both.

    const glowTexture = makeGlowTexture();

    // ── camera rig (visualizer-style spherical orbit around a pannable target)
    const rig = {
      angle: 0,
      radius: 15,
      height: 4.6,
      targetX: 0,
      targetZ: 0,
      lookY: 1.7,
      // desired* lerp targets so mode/view/fit changes glide
      dAngle: 0,
      dRadius: 15,
      dHeight: 4.6,
      dTargetX: 0,
      dTargetZ: 0,
    };
    const rigDefaults = () => {
      if (layoutRef.current === "ball") {
        return { radius: 12.5, height: 5.4, lookY: BALL_CENTER_Y };
      }
      if (layoutRef.current === "disk") {
        const diskY = modeRef.current === "garden" ? 0.05 : 2.6;
        // Look down onto the disk so the hyperbolic compression reads.
        return { radius: 10.5, height: diskY + 9.5, lookY: diskY };
      }
      if (modeRef.current === "garden") {
        return { radius: 15.5, height: 4.6, lookY: 1.7 };
      }
      return { radius: 14.5, height: 5.2, lookY: 1.7 };
    };
    const resetRig = () => {
      const d = rigDefaults();
      rig.dRadius = d.radius;
      rig.dHeight = d.height;
      rig.lookY = d.lookY;
      rig.dTargetX = 0;
      rig.dTargetZ = 0;
    };
    const applyRig = () => {
      camera.position.set(
        rig.targetX + Math.sin(rig.angle) * rig.radius,
        rig.height,
        rig.targetZ + Math.cos(rig.angle) * rig.radius,
      );
      camera.lookAt(rig.targetX, rig.lookY, rig.targetZ);
    };
    // ── corner lock (gesture mode with an explicit wall) ────────────────────
    // The rigid two-window pair: ONE shared eye point, a horizontal view
    // direction whose yaw is exactly 90° apart per wall, and (in resize) a
    // fov pinned to exactly 90° HORIZONTAL — so the two windows tile one
    // continuous world around the physical corner: wall A's right edge
    // continues onto wall B's left edge. NOTHING may move this camera: drag/
    // wheel are unbound in gesture mode, and fit/focus/inertia/lerp are all
    // gated off below. The orbit rig is bypassed entirely.
    const cornerLocked = cornerLockRef.current;
    const cornerLockedYaw = cornerYaw(wallRef.current);
    const applyCornerRig = () => {
      const eye = cornerEye();
      camera.position.set(eye.x, eye.y, eye.z);
      camera.lookAt(eye.x - Math.sin(cornerLockedYaw), eye.y, eye.z - Math.cos(cornerLockedYaw));
    };
    // ── flat lock (?flat=1 with an explicit wall) ───────────────────────────
    // The FLAT rig's rigid pair: the two windows are halves of a SINGLE wide
    // frustum — one shared eye, ONE shared view direction (no per-wall yaw),
    // and (in resize) a per-window setViewOffset slicing this window's column
    // out of the combined panorama. Coplanar halves share the projection
    // plane, so the pair tiles one continuous picture on the flat wall.
    //
    // SHARED ORBIT: unlike the corner pair, the flat rig is NOT frozen — the
    // pinch camera may orbit/zoom the WHOLE panorama about its roaming centre
    // (which the palm-depth walk translates — free roam anywhere on the map),
    // and WASD holds dolly/turn it (see the frame loop). Both windows receive
    // near-identical input streams (hands fusion; guest key holds broadcast by
    // the relay hub), but "identical forever" is not a real invariant — socket
    // reconnects, refreshes and key-timing skew would drift the copies apart
    // PERMANENTLY, shearing the physical seam. So the pose also SYNCS through
    // the server: after local input this window publishes its targets (~8 Hz,
    // dirty-flagged) up the guest-hands room socket via the flat-pose seam,
    // the hub relays to the partner window (and replays the last pose to a
    // fresh subscriber), and a received pose is ADOPTED verbatim as the
    // targets — the flatView easing below smooths the correction. Adoption
    // marks the targets clean so it never re-publishes (no echo loop);
    // last-writer-wins is fine because both windows compute near-identical
    // values anyway. Mouse/fit/focus stay gated off — only these writers and
    // the sync may move it.
    const flatLocked = flatLockRef.current;
    // cx/cz: the panorama's ROAMING CENTRE on the ground plane — the palm-
    // depth walk translates it along the view direction, so the pair can
    // free-roam anywhere on the map (orbit/zoom then act about this centre).
    const flatRig = { yaw: FLAT_YAW, height: FLAT_EYE_HEIGHT, dist: FLAT_EYE_DISTANCE, cx: 0, cz: 0 };
    // Roam envelope for the centre: generously past the meadow so nothing is
    // out of reach, finite so nobody glides to infinity (the hub clamps its
    // relay at the slightly-wider FLAT_POSE_CENTER_LIMIT, same rule as dist).
    const FLAT_ROAM_LIMIT = 80;
    // Full-speed walk rate for the roaming centre, world units per SECOND —
    // the W/S dolly feel. Each walk intent carries the wall-clock dt it
    // covers (see walkBy), so a 30 Hz TD stream, a 60 fps bridge and a
    // 120 Hz phone fly stream all glide at this same rate.
    const FLAT_WALK_UNITS_PER_SEC = 6;
    // Local input touched flatRig since the last publish (adoption clears it).
    let flatPoseDirty = false;
    let flatPoseLastPublishMs = 0;
    const FLAT_POSE_PUBLISH_MS = 125; // ~8 Hz — plenty against sub-mm/s drift
    // SMOOTHED APPLICATION: the targets above step at the 30 Hz hands-stream
    // cadence; drawing them raw makes the whole panorama judder on a 60 fps
    // render. The drawn pose eases toward the targets each frame instead.
    // Lockstep survives because both windows ease toward IDENTICAL targets
    // with the same rate — any transient divergence decays within ~100 ms.
    const flatView = { yaw: FLAT_YAW, height: FLAT_EYE_HEIGHT, dist: FLAT_EYE_DISTANCE, cx: 0, cz: 0 };
    const applyFlatRig = (dt?: number) => {
      const k = dt === undefined ? 1 : 1 - Math.exp(-dt * 14);
      flatView.yaw += (flatRig.yaw - flatView.yaw) * k;
      flatView.height += (flatRig.height - flatView.height) * k;
      flatView.dist += (flatRig.dist - flatView.dist) * k;
      flatView.cx += (flatRig.cx - flatView.cx) * k;
      flatView.cz += (flatRig.cz - flatView.cz) * k;
      // Eye AND look point offset by the roaming centre together, so the
      // whole shared frustum translates and both windows keep tiling one
      // continuous picture — the seam still bisects (cx, cz).
      const eyeX = flatView.cx + Math.sin(flatView.yaw) * flatView.dist;
      const eyeZ = flatView.cz + Math.cos(flatView.yaw) * flatView.dist;
      camera.position.set(eyeX, flatView.height, eyeZ);
      camera.lookAt(eyeX - Math.sin(flatView.yaw), flatView.height, eyeZ - Math.cos(flatView.yaw));
    };

    resetRig();
    if (flatLocked) {
      applyFlatRig();
    } else if (cornerLocked) {
      applyCornerRig();
    } else {
      // Per-window boot framing: the wall identity only seeds the default yaw
      // (resetRig never touches the angle, so mode/layout switches keep it).
      rig.dAngle = wallYawSeed(wallRef.current);
      rig.angle = rig.dAngle;
      if (skyViewRef.current) {
        // Research ceiling boot pose: an UNDER-DECK vista — the eye sits low
        // outside the disc and pitches up through the cloud layer, so the sky
        // fills the upper two-thirds of the frame (fresh clouds ride high
        // overhead, old ones sink toward the horizon line and haze out).
        // This pose IS the composition: auto-fit is gated off in skyView
        // below — re-framing the bounded disc from outside would pitch the
        // camera back down into a horizon-band view.
        rig.dHeight = 1.8;
        rig.dRadius = 34;
        rig.lookY = SKY_ALT - 3;
      }
      rig.radius = rig.dRadius;
      rig.height = rig.dHeight;
      applyRig();
    }

    // ── environments ────────────────────────────────────────────────────────
    // Pastoral daylight garden built from real CC0 Poly Haven photoscans: a
    // partly-cloudy sky panorama, a tiled grass ground, and instanced
    // grass/wildflower/shrub/rock/tree models (see garden-flora.ts +
    // public/assets/garden/ASSETS.md), plus butterflies and drifting seed
    // motes. Node/label data colors are unchanged — the dark glass label
    // cards pop against the bright sky.
    const buildGardenEnv = (): SceneEnv => {
      const rng = mulberry32(0x47415244);
      const group = new THREE.Group();
      scene.add(group);
      // Aerial perspective: haze tinted to the sky horizon so meadow and hills
      // melt into the sky instead of ending at a hard disc edge.
      scene.fog = new THREE.Fog(0xdcedf8, 80, 210);

      // Daylight rig (env-local): warm sun key matching the panorama's sun,
      // blue-sky/grass hemisphere bounce, and a soft cool fill so shaded
      // sides stay readable. (Photoscan albedos run darker than flat colors,
      // hence hotter intensities than the old procedural pass.)
      group.add(new THREE.HemisphereLight(0xbdd9f2, 0x86b46a, 1.15));
      const sunLight = new THREE.DirectionalLight(0xfff2d9, 1.55);
      sunLight.position.set(-24, 42, -30);
      group.add(sunLight);
      const fillLight = new THREE.DirectionalLight(0xcfe4ff, 0.35);
      fillLight.position.set(18, 12, 16);
      group.add(fillLight);

      // Sky: real tonemapped equirect panorama (Poly Haven puresky) on a
      // vertically SQUASHED dome — the camera rig only frames ~12° above the
      // horizon, and every panorama keeps its blue at the zenith, so the
      // squash compresses that blue down into the visible band. World-
      // anchored, so the two-wall/corner-lock pair stays continuous.
      const skyTexture = new THREE.TextureLoader().load(
        "/assets/garden/sky/sunflowers_puresky_4k.jpg",
      );
      skyTexture.colorSpace = THREE.SRGBColorSpace;
      const skyDome = new THREE.Mesh(
        new THREE.SphereGeometry(340, 48, 32),
        new THREE.MeshBasicMaterial({ map: skyTexture, side: THREE.BackSide, fog: false, depthWrite: false }),
      );
      skyDome.scale.y = 0.32;
      group.add(skyDome);

      // Ground: tiled photoscan grass (1k diff+normal over ~10-unit tiles;
      // the tiling repeat hides under fog, flora cover and label chrome).
      const texLoader = new THREE.TextureLoader();
      const groundDiff = texLoader.load("/assets/garden/ground/aerial_grass_rock_diff_1k.jpg");
      groundDiff.wrapS = THREE.RepeatWrapping;
      groundDiff.wrapT = THREE.RepeatWrapping;
      groundDiff.repeat.set(22, 22);
      groundDiff.colorSpace = THREE.SRGBColorSpace;
      groundDiff.anisotropy = 8;
      const groundNor = texLoader.load("/assets/garden/ground/aerial_grass_rock_nor_1k.jpg");
      groundNor.wrapS = THREE.RepeatWrapping;
      groundNor.wrapT = THREE.RepeatWrapping;
      groundNor.repeat.set(22, 22);
      groundNor.anisotropy = 8;
      const ground = new THREE.Mesh(
        new THREE.CircleGeometry(110, 64),
        // Tint pushes the olive scan toward lush pasture green.
        new THREE.MeshStandardMaterial({ map: groundDiff, normalMap: groundNor, color: 0xaef29a, roughness: 1, metalness: 0 }),
      );
      ground.rotation.x = -Math.PI / 2;
      group.add(ground);

      // Flora: instanced photoscan scatter. Loads async (cached for the page
      // after the first garden build); each species lands as a handful of
      // InstancedMesh draw calls, so density is nearly free. The rng here is
      // dedicated so the async arrival can't perturb the env's other seeds.
      const floraRng = mulberry32(0x464c4f52);
      // Counts × per-model tri budgets (see fetch-garden-assets.py) keep the
      // whole flora pass near ~2M triangles — dense to the eye, cheap to the
      // two projector GPUs. Scales compensate REAL model sizes (the scans are
      // multi-plant patches in meters: the grass patch is ~2.8m wide, the
      // shrub ~3m tall, the jacaranda ~12m).
      // Scales are calibrated to the scans' TRUE sizes (grass tufts ~0.34m,
      // dandelions ~0.17m, the jacaranda ~19m tall): small plants scale UP
      // ~2-3× for projector legibility, the tree scales down to ~8-12 units.
      const FLORA_SCATTER: { name: string; count: number; rMin: number; rMax: number; sMin: number; sMax: number }[] = [
        { name: "grass_medium_01", count: 380, rMin: 3, rMax: 74, sMin: 3.0, sMax: 4.5 },
        { name: "flower_gazania", count: 90, rMin: 4, rMax: 62, sMin: 2.8, sMax: 4.0 },
        { name: "flower_ursinia", count: 90, rMin: 4, rMax: 62, sMin: 2.5, sMax: 3.8 },
        { name: "dandelion_01", count: 80, rMin: 4, rMax: 66, sMin: 3.0, sMax: 4.5 },
        { name: "periwinkle_plant", count: 60, rMin: 5, rMax: 58, sMin: 2.5, sMax: 3.5 },
        { name: "shrub_02", count: 20, rMin: 12, rMax: 80, sMin: 0.8, sMax: 1.2 },
        { name: "shrub_03", count: 20, rMin: 10, rMax: 76, sMin: 2.0, sMax: 3.5 },
        { name: "rock_moss_set_01", count: 12, rMin: 10, rMax: 82, sMin: 0.5, sMax: 0.9 },
        { name: "tree_stump_01", count: 4, rMin: 15, rMax: 55, sMin: 0.9, sMax: 1.2 },
        { name: "jacaranda_tree", count: 10, rMin: 34, rMax: 82, sMin: 0.45, sMax: 0.62 },
        // Indian trees: the jacaranda scan (widely planted across India — the
        // "blue gulmohar" — and standing in here for the country's iconic broad
        // canopies, the Banyan among them) scattered as a second, taller inner
        // band so the meadow carries more of India's big-crowned trees at the
        // SAME photoscan quality as the other trees.
        { name: "jacaranda_tree", count: 8, rMin: 22, rMax: 70, sMin: 0.5, sMax: 0.7 },
      ];
      let floraDisposed = false;
      // Central Park diorama (?park=1): built (async) BEFORE the flora
      // scatters, so the scatter can keep grass and jacarandas out of the
      // park's real water bodies via the layer's point test.
      let parkBuild: CentralParkBuild | null = null;
      // Flower-top landing spots for the butterflies, filled in as the flora
      // scatter runs (async — no flowers loaded simply means no landings).
      const flowerSpots: { x: number; y: number; z: number }[] = [];
      // A dancing cat parked at the foot of every tree in the meadow "sea" of
      // scattered jacarandas — one low-poly companion per placed tree instance,
      // swayed by the env update loop (same hop-and-tilt idiom as the garden
      // build-tree cats). Filled in as the flora scatter lands the trees.
      const catGeoBody = new THREE.SphereGeometry(0.16, 8, 8);
      const catGeoEar = new THREE.OctahedronGeometry(0.55, 0);
      const catGeoTail = new THREE.CylinderGeometry(0.03, 0.05, 1, 5);
      const catMat = new THREE.MeshPhongMaterial({ color: 0x6b5b4a, emissive: 0x6b5b4a, emissiveIntensity: 0.08 });
      const envCats: { group: THREE.Group; baseX: number; baseZ: number; phase: number }[] = [];
      const envMana: { mesh: THREE.Mesh; baseY: number; phase: number }[] = [];
      const spawnTreeCat = (x: number, z: number, scale: number) => {
        const cat = new THREE.Group();
        const body = new THREE.Mesh(catGeoBody, catMat);
        body.scale.set(0.9, 1.2, 0.7);
        body.position.y = 0.24;
        cat.add(body);
        const head = new THREE.Mesh(catGeoBody, catMat);
        head.scale.setScalar(0.8);
        head.position.set(0, 0.5, 0.05);
        cat.add(head);
        for (const side of [-1, 1]) {
          const ear = new THREE.Mesh(catGeoEar, catMat);
          ear.scale.setScalar(0.12);
          ear.position.set(side * 0.12, 0.66, 0.05);
          cat.add(ear);
        }
        const tail = new THREE.Mesh(catGeoTail, catMat);
        tail.scale.set(0.25, 0.4, 0.25);
        tail.position.set(0, 0.32, -0.28);
        tail.rotation.x = -0.7;
        cat.add(tail);
        cat.scale.setScalar(scale);
        cat.position.set(x, 0, z);
        group.add(cat);
        envCats.push({ group: cat, baseX: x, baseZ: z, phase: floraRng() * Math.PI * 2 });
      };
      // A dancing purple chihuahua parked at the foot of every meadow tree too
      // — a low-poly companion (tiny body, big pointed upright ears, small
      // snout, wagging tail) that rides the same cat field so the frame loop
      // hops it into a dance.
      const dogMat = new THREE.MeshPhongMaterial({ color: 0x9b30ff, emissive: 0x9b30ff, emissiveIntensity: 0.12 });
      const spawnTreeDog = (x: number, z: number, scale: number) => {
        const dog = new THREE.Group();
        const body = new THREE.Mesh(catGeoBody, dogMat);
        body.scale.set(0.7, 0.75, 0.95);
        body.position.y = 0.2;
        dog.add(body);
        const head = new THREE.Mesh(catGeoBody, dogMat);
        head.scale.setScalar(0.8);
        head.position.set(0, 0.4, 0.18);
        dog.add(head);
        const snout = new THREE.Mesh(catGeoBody, dogMat);
        snout.scale.set(0.3, 0.3, 0.42);
        snout.position.set(0, 0.34, 0.32);
        dog.add(snout);
        // Big pointed upright ears — the chihuahua's signature.
        for (const side of [-1, 1]) {
          const ear = new THREE.Mesh(catGeoEar, dogMat);
          ear.scale.set(0.1, 0.16, 0.06);
          ear.position.set(side * 0.13, 0.58, 0.16);
          dog.add(ear);
        }
        const tail = new THREE.Mesh(catGeoTail, dogMat);
        tail.scale.set(0.28, 0.35, 0.28);
        tail.position.set(0, 0.4, -0.32);
        tail.rotation.x = -1.0;
        dog.add(tail);
        dog.scale.setScalar(scale);
        dog.position.set(x, 0, z);
        group.add(dog);
        envCats.push({ group: dog, baseX: x, baseZ: z, phase: floraRng() * Math.PI * 2 });
      };
      // Pink tulips ringed around the base of every meadow tree — a low-poly
      // green stem topped by a pink blossom cup, shared geometry/material so a
      // whole ring is a handful of cheap meshes. Static planting (no dance);
      // the ring sits just outside the trunk scan so the blooms read at the
      // tree's foot from the projector.
      const tulipStemGeo = new THREE.CylinderGeometry(0.03, 0.05, 0.7, 5);
      const tulipBloomGeo = new THREE.ConeGeometry(0.14, 0.32, 6);
      const tulipStemMat = new THREE.MeshPhongMaterial({ color: 0x2f7d32, emissive: 0x123d14, emissiveIntensity: 0.1 });
      const tulipBloomMat = new THREE.MeshPhongMaterial({ color: 0xff69b4, emissive: 0xff69b4, emissiveIntensity: 0.18 });
      const spawnTreeTulips = (x: number, z: number, scale: number) => {
        const ring = new THREE.Group();
        const count = 8;
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2 + floraRng() * 0.4;
          const r = 1.8 + floraRng() * 0.6;
          const tulip = new THREE.Group();
          const stem = new THREE.Mesh(tulipStemGeo, tulipStemMat);
          stem.position.y = 0.35;
          tulip.add(stem);
          const bloom = new THREE.Mesh(tulipBloomGeo, tulipBloomMat);
          bloom.position.y = 0.82;
          tulip.add(bloom);
          tulip.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
          ring.add(tulip);
        }
        ring.scale.setScalar(scale);
        ring.position.set(x, 0, z);
        group.add(ring);
      };
      // Crystal mana floating around the base of every meadow tree — a few
      // glowing cyan octahedron shards hovering at head height, shared
      // geometry/material so a whole cluster is a handful of cheap meshes.
      // Bobbing/spin is driven per-shard in the frame loop via envMana.
      const manaGeo = new THREE.OctahedronGeometry(0.22, 0);
      const manaMat = new THREE.MeshPhongMaterial({
        color: 0x66e0ff,
        emissive: 0x33bbff,
        emissiveIntensity: 0.9,
        transparent: true,
        opacity: 0.82,
      });
      const spawnTreeMana = (x: number, z: number, scale: number) => {
        const count = 5;
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2 + floraRng() * 0.6;
          const r = (1.4 + floraRng() * 0.8) * scale;
          const shard = new THREE.Mesh(manaGeo, manaMat);
          const baseY = (1.6 + floraRng() * 1.2) * scale;
          shard.position.set(x + Math.cos(a) * r, baseY, z + Math.sin(a) * r);
          shard.scale.setScalar(scale);
          envMana.push({ mesh: shard, baseY, phase: floraRng() * Math.PI * 2 });
          group.add(shard);
        }
      };
      const scatterFlora = (flora: FloraLibrary) => {
        const dummy = new THREE.Object3D();
        for (const spec of FLORA_SCATTER) {
          const variants = flora.get(spec.name);
          if (variants === undefined || variants.length === 0) {
            continue;
          }
          // Blossom height per variant (bounding boxes are precomputed by
          // garden-flora) so a landing butterfly sits ON the flower head.
          const isFlower = spec.name.startsWith("flower_");
          // The scattered jacarandas ARE the meadow's "sea" of trees; each gets
          // a dancing cat parked at its foot.
          const isTree = spec.name === "jacaranda_tree";
          const variantTopY = variants.map((variant) =>
            variant.pieces.reduce((maxY, piece) => Math.max(maxY, piece.geometry.boundingBox?.max.y ?? 0), 0),
          );
          // Instance i takes variant i % n; angles are an evenly-spaced ring
          // with jitter so even low-count species (the trees) land in every
          // camera wedge instead of gambling on uniform randomness.
          const matrices: THREE.Matrix4[][] = variants.map(() => []);
          for (let i = 0; i < spec.count; i++) {
            const angle = ((i + floraRng() * 0.9) / spec.count) * Math.PI * 2;
            let radius = spec.rMin + floraRng() * (spec.rMax - spec.rMin);
            // Park layer: nothing sprouts out of the Reservoir — re-roll the
            // radius a few times (same wedge, so ring coverage survives),
            // then concede the instance to the water.
            if (parkBuild !== null) {
              for (let tries = 0; tries < 6 && parkBuild.isWater(Math.cos(angle) * radius, Math.sin(angle) * radius); tries++) {
                radius = spec.rMin + floraRng() * (spec.rMax - spec.rMin);
              }
              if (parkBuild.isWater(Math.cos(angle) * radius, Math.sin(angle) * radius)) {
                continue;
              }
            }
            dummy.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
            dummy.rotation.y = floraRng() * Math.PI * 2;
            dummy.scale.setScalar(spec.sMin + floraRng() * (spec.sMax - spec.sMin));
            dummy.updateMatrix();
            matrices[i % variants.length].push(dummy.matrix.clone());
            if (isFlower) {
              flowerSpots.push({
                x: dummy.position.x,
                y: variantTopY[i % variants.length] * dummy.scale.x + 0.05,
                z: dummy.position.z,
              });
            }
            if (isTree) {
              // Nudge the cat just off the trunk toward the meadow centre so it
              // reads at the tree's foot rather than buried in the canopy scan.
              const offset = 2.4;
              const inward = Math.hypot(dummy.position.x, dummy.position.z) || 1;
              const nx = dummy.position.x / inward;
              const nz = dummy.position.z / inward;
              spawnTreeCat(
                dummy.position.x - nx * offset,
                dummy.position.z - nz * offset,
                1.4,
              );
              // The dog stands on the opposite flank of the trunk (a tangential
              // nudge) so cat and dog both read at the tree's foot, not stacked.
              spawnTreeDog(
                dummy.position.x - nx * offset - nz * 1.6,
                dummy.position.z - nz * offset + nx * 1.6,
                1.4,
              );
              // Ring of pink tulips planted around the trunk's base.
              spawnTreeTulips(dummy.position.x, dummy.position.z, 1.4);
              // Crystal mana shards hovering around the tree.
              spawnTreeMana(dummy.position.x, dummy.position.z, 1.4);
            }
          }
          variants.forEach((variant, v) => {
            if (matrices[v].length === 0) {
              return;
            }
            for (const piece of variant.pieces) {
              const instanced = new THREE.InstancedMesh(piece.geometry, piece.material, matrices[v].length);
              matrices[v].forEach((matrix, i) => instanced.setMatrixAt(i, matrix));
              // Geometry/material belong to the page-lifetime flora cache;
              // the dispose traverse below only releases instance buffers.
              instanced.userData.sharedAsset = true;
              // Instances span the whole meadow — skip per-mesh culling
              // rather than trusting instance-unaware bounding volumes.
              instanced.frustumCulled = false;
              group.add(instanced);
            }
          });
        }
      };
      if (!softwareGL) {
        // The park layer (when requested) resolves BEFORE the flora scatter so
        // the scatter's water test sees it; a failed park fetch degrades to
        // the plain meadow rather than blocking the flora.
        const parkReady = parkRef.current
          ? loadCentralParkLayout()
              .then((parkLayout) => {
                if (floraDisposed) {
                  return;
                }
                parkBuild = buildCentralPark(parkLayout);
                group.add(parkBuild.group);
              })
              .catch((error: unknown) => {
                console.warn("central park layer failed to load; plain meadow stays", error);
              })
          : Promise.resolve();
        parkReady.then(() =>
          loadGardenFlora()
            .then((flora) => {
              floraLib = flora;
              // Rebuild the data nodes as real models on the next frame.
              floraNodesDirty = true;
              if (!floraDisposed) {
                scatterFlora(flora);
              }
            })
            .catch((error: unknown) => {
              console.warn("garden flora failed to load; primitive glyphs stay", error);
            }),
        );
      }

      // Rolling hills ring the horizon (haze-tinted by the fog) so the meadow
      // ends in pasture, not at a disc edge; some carry distant tree clumps.
      // Low rolling downs past the meadow edge (same tiled grass texture,
      // tinted toward the horizon pale) — kept FLAT and far so the fog reads
      // them as aerial perspective, with the real jacaranda band in front.
      const hillTones = [0xc2d8b2, 0xcfe2c0, 0xb8cfae];
      for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2 + rng() * 0.7;
        const dist = 98 + rng() * 12;
        const rx = 30 + rng() * 22;
        const ry = 2.2 + rng() * 2.2;
        const hill = new THREE.Mesh(
          new THREE.SphereGeometry(1, 24, 16),
          new THREE.MeshStandardMaterial({ map: groundDiff, color: hillTones[i % hillTones.length], roughness: 1 }),
        );
        hill.scale.set(rx, ry, 16 + rng() * 8);
        hill.position.set(Math.cos(angle) * dist, -ry * 0.35, Math.sin(angle) * dist);
        group.add(hill);
      }

      // Butterflies: alpha-cutout two-lobed wings (procedural veined texture,
      // one shared material per palette variant) hinged on the body line.
      // Flight is a tiny per-butterfly state machine instead of a Lissajous:
      // bursts of quick asymmetric flaps alternate with brief V-wing glides,
      // the heading meanders on a retargeted turn rate (occasionally held
      // hard-over into a slow loop), the body banks into turns and bobs with
      // the flap — and once the flora arrives they sometimes land on a
      // flower, fold their wings upright, and sit for a moment.
      const wingLeftGeo = new THREE.PlaneGeometry(0.34, 0.4);
      wingLeftGeo.translate(0.34 / 2 + 0.008, 0, 0); // hinge at the body line
      wingLeftGeo.rotateX(Math.PI / 2); // lie flat; v=1 (canvas top) → +Z head
      const wingRightGeo = wingLeftGeo.clone();
      wingRightGeo.scale(-1, 1, 1); // mirror carries the UVs — pattern flips too
      const butterflyBodyGeo = new THREE.CapsuleGeometry(0.016, 0.17, 3, 6);
      butterflyBodyGeo.rotateX(Math.PI / 2); // fusiform body along the flight axis
      const butterflyBodyMat = new THREE.MeshPhongMaterial({ color: 0x2e2115, shininess: 8 });
      const butterflyColors = [0xfff6e8, 0xffd166, 0xf5a0c1, 0x9ad7f0, 0xffa94d];
      const butterflyWingMats = butterflyColors.map(
        (color) =>
          new THREE.MeshPhongMaterial({
            map: makeButterflyWingTexture(color),
            side: THREE.DoubleSide,
            alphaTest: 0.5,
            transparent: true,
            opacity: 0.92, // slight translucency — daylight glows through the membrane
            emissive: 0xffffff,
            emissiveIntensity: 0.3,
            shininess: 4,
          }),
      );
      butterflyWingMats.forEach((mat) => {
        mat.emissiveMap = mat.map; // self-light follows the wing pattern
      });
      interface Butterfly {
        group: THREE.Group;
        left: THREE.Mesh;
        right: THREE.Mesh;
        homeX: number; // tether center so the wander stays spread over the meadow
        homeZ: number;
        heading: number;
        speed: number;
        cruise: number;
        vy: number;
        turnRate: number;
        turnTarget: number;
        turnT: number; // countdown to the next turn-rate retarget
        targetAlt: number;
        flapPhase: number; // in beats (advances only while flapping)
        flapFreq: number; // beats/s
        flapEnv: number; // 0 glide/rest ↔ 1 full flap, eased on transitions
        flapping: boolean;
        modeT: number; // time left in the current flap burst / glide
        bank: number;
        mode: 0 | 1 | 2; // 0 wander, 1 approach flower, 2 landed
        landT: number; // wander: next landing try; approach: abort; landed: dwell
        tx: number;
        ty: number;
        tz: number;
      }
      const butterflies: Butterfly[] = [];
      for (let i = 0; i < 8; i++) {
        const mat = butterflyWingMats[i % butterflyWingMats.length];
        const fly = new THREE.Group();
        fly.rotation.order = "YXZ"; // yaw along the path, then pitch, then bank
        const left = new THREE.Mesh(wingLeftGeo, mat);
        const right = new THREE.Mesh(wingRightGeo, mat);
        // Raised at rest so a reduced-motion frame never reads as flat cards.
        left.rotation.z = 0.6;
        right.rotation.z = -0.6;
        fly.add(left);
        fly.add(right);
        fly.add(new THREE.Mesh(butterflyBodyGeo, butterflyBodyMat));
        fly.scale.setScalar(0.85 + rng() * 0.45);
        const homeX = (rng() - 0.5) * 34;
        const homeZ = (rng() - 0.5) * 26;
        fly.position.set(homeX, 1.2 + rng() * 1.8, homeZ);
        group.add(fly);
        butterflies.push({
          group: fly, left, right, homeX, homeZ,
          heading: rng() * Math.PI * 2, speed: 0.8, cruise: 0.75 + rng() * 0.55, vy: 0,
          turnRate: 0, turnTarget: 0, turnT: rng(), targetAlt: 1.2 + rng() * 2,
          flapPhase: rng(), flapFreq: 6.5 + rng() * 2.5, flapEnv: 1, flapping: true,
          modeT: 0.5 + rng(), bank: 0, mode: 0, landT: 8 + rng() * 18, tx: 0, ty: 0, tz: 0,
        });
      }
      const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

      // Drifting seeds/pollen: tiny bright motes low over the grass.
      const motes: { sprite: THREE.Sprite; base: THREE.Vector3; phase: number }[] = [];
      for (let i = 0; i < 16; i++) {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: glowTexture, color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false }),
        );
        const base = new THREE.Vector3((rng() - 0.5) * 30, 0.7 + rng() * 1.8, (rng() - 0.5) * 24);
        sprite.position.copy(base);
        sprite.scale.setScalar(0.14 + rng() * 0.1);
        group.add(sprite);
        motes.push({ sprite, base, phase: rng() * Math.PI * 2 });
      }

      // Flap waveform bounds: each side sweeps from just below horizontal up
      // to ~76° over the back; landed wings fold to ~79° and pump slowly.
      const FLAP_MIN = -0.22;
      const FLAP_MAX = 1.32;
      const GLIDE_ANGLE = 0.42; // shallow dihedral V while gliding
      const WING_FOLD = 1.38;
      return {
        group,
        update: (t, dt) => {
          if (reducedMotion) {
            return;
          }
          for (const fly of butterflies) {
            const pos = fly.group.position;
            let restAngle = GLIDE_ANGLE;
            if (fly.mode === 2) {
              // Landed on a flower: sit still, wings folded upright with an
              // occasional slow open-close pump, then burst off again.
              fly.landT -= dt;
              fly.flapping = false;
              restAngle = WING_FOLD - Math.max(0, Math.sin(t * 1.7 + fly.flapPhase * 9)) * 0.45;
              if (fly.landT <= 0) {
                fly.mode = 0;
                fly.flapping = true;
                fly.modeT = 0.9 + rng() * 0.8; // takeoff burst
                fly.vy = 0.9;
                fly.speed = 0.3;
                fly.landT = 14 + rng() * 22;
                fly.targetAlt = 1.4 + rng() * 2;
              }
            } else {
              // Flap cadence: bursts of quick beats with brief glides between
              // (an approach stays powered all the way onto the flower).
              fly.modeT -= dt;
              if (fly.mode === 1) {
                fly.flapping = true;
              } else if (fly.modeT <= 0) {
                fly.flapping = !fly.flapping;
                if (fly.flapping) {
                  fly.modeT = 0.45 + rng() * 1.1;
                  fly.heading += (rng() - 0.5) * 0.6; // burst opens with a jink
                } else {
                  fly.modeT = 0.25 + rng() * 0.8;
                }
              }
              // Meander: retarget the turn rate about once a second; now and
              // then hold hard-over for seconds — the slow loop.
              fly.turnT -= dt;
              if (fly.turnT <= 0) {
                if (rng() < 0.09) {
                  fly.turnTarget = (rng() < 0.5 ? -1 : 1) * (2.2 + rng() * 0.9);
                  fly.turnT = 1.6 + rng() * 1.6;
                } else {
                  fly.turnTarget = (rng() - 0.5) * 4.4;
                  fly.turnT = 0.4 + rng() * 1.1;
                }
                fly.targetAlt = 1.0 + rng() * 2.4;
              }
              let speedTarget = fly.flapping ? fly.cruise * 1.25 : fly.cruise * 0.6;
              if (fly.mode === 1) {
                // Home in on the flower, bleeding speed as it closes.
                const dx = fly.tx - pos.x;
                const dz = fly.tz - pos.z;
                const dist = Math.hypot(dx, dz);
                fly.turnTarget = THREE.MathUtils.clamp(wrapAngle(Math.atan2(dx, dz) - fly.heading) * 3, -3.5, 3.5);
                speedTarget = Math.min(speedTarget, Math.max(0.3, dist * 0.9));
                fly.landT -= dt;
                if (dist < 0.14 && Math.abs(fly.ty - pos.y) < 0.16) {
                  fly.mode = 2;
                  pos.set(fly.tx, fly.ty, fly.tz);
                  fly.landT = 1.6 + rng() * 3;
                  fly.speed = 0;
                  fly.vy = 0;
                } else if (fly.landT <= 0) {
                  fly.mode = 0; // couldn't line it up — wander off instead
                  fly.landT = 10 + rng() * 15;
                }
              } else {
                // Home tether: steer back once the wander drifts too far.
                const hx = fly.homeX - pos.x;
                const hz = fly.homeZ - pos.z;
                if (hx * hx + hz * hz > 64) {
                  fly.turnTarget = THREE.MathUtils.clamp(wrapAngle(Math.atan2(hx, hz) - fly.heading) * 2, -3, 3);
                }
                // Occasionally pick a nearby flower to drop onto.
                fly.landT -= dt;
                if (fly.landT <= 0) {
                  fly.landT = 12 + rng() * 20;
                  for (let attempt = 0; attempt < 4 && flowerSpots.length > 0; attempt++) {
                    const spot = flowerSpots[(rng() * flowerSpots.length) | 0];
                    const dx = spot.x - pos.x;
                    const dz = spot.z - pos.z;
                    if (dx * dx + dz * dz < 100) {
                      fly.mode = 1;
                      fly.tx = spot.x;
                      fly.ty = spot.y;
                      fly.tz = spot.z;
                      fly.landT = 7; // approach abort timeout
                      break;
                    }
                  }
                }
              }
              // Integrate: ease turn rate and speed, climb while flapping,
              // sink through glides, drift toward the target altitude.
              fly.turnRate += (fly.turnTarget - fly.turnRate) * (1 - Math.exp(-dt * 4));
              fly.heading += fly.turnRate * dt;
              fly.speed += (speedTarget - fly.speed) * (1 - Math.exp(-dt * 3));
              const vyTarget =
                fly.mode === 1
                  ? THREE.MathUtils.clamp((fly.ty - pos.y) * 1.4, -0.7, 0.7)
                  : THREE.MathUtils.clamp((fly.targetAlt - pos.y) * 0.6, -0.6, 0.6) + (fly.flapping ? 0.12 : -0.3);
              fly.vy += (vyTarget - fly.vy) * (1 - Math.exp(-dt * 3.5));
              pos.x += Math.sin(fly.heading) * fly.speed * dt;
              pos.z += Math.cos(fly.heading) * fly.speed * dt;
              pos.y = THREE.MathUtils.clamp(pos.y + fly.vy * dt, 0.5, 4.2);
              if (fly.flapping) {
                fly.flapPhase += fly.flapFreq * dt;
              }
            }
            fly.flapEnv += ((fly.flapping ? 1 : 0) - fly.flapEnv) * (1 - Math.exp(-dt * 10));
            // Wing beat: quick upstroke (35% of the beat) toward vertical
            // over the back, slower downstroke to just below horizontal.
            const s = fly.flapPhase - Math.floor(fly.flapPhase);
            const u = s < 0.35 ? s / 0.35 : 1 - (s - 0.35) / 0.65;
            const beat = FLAP_MIN + (FLAP_MAX - FLAP_MIN) * (0.5 - 0.5 * Math.cos(u * Math.PI));
            const wing = restAngle + (beat - restAngle) * fly.flapEnv;
            fly.left.rotation.z = wing;
            fly.right.rotation.z = -wing;
            // Attitude: yaw along the path, bank into the turn, nose-up trim
            // with a flap-coupled pitch bob.
            fly.group.rotation.y = fly.heading;
            const bankTarget = fly.mode === 2 ? 0 : THREE.MathUtils.clamp(-fly.turnRate * 0.28, -0.55, 0.55);
            fly.bank += (bankTarget - fly.bank) * (1 - Math.exp(-dt * 5));
            fly.group.rotation.z = fly.bank;
            fly.group.rotation.x = -0.12 + Math.sin(s * Math.PI * 2) * 0.1 * fly.flapEnv;
          }
          for (const mote of motes) {
            mote.sprite.position.set(
              mote.base.x + Math.sin(t * 0.22 + mote.phase) * 1.8,
              mote.base.y + Math.sin(t * 0.35 + mote.phase * 2) * 0.6,
              mote.base.z + Math.cos(t * 0.18 + mote.phase) * 1.8,
            );
            mote.sprite.material.opacity = 0.22 + Math.abs(Math.sin(t * 0.7 + mote.phase)) * 0.3;
          }
          // The tree-foot cats dance: a bouncing hop with a wiggling side-step
          // and tail-swaying tilt (same idiom as the garden build-tree cats).
          for (const cat of envCats) {
            cat.group.position.y = Math.abs(Math.sin(t * 3 + cat.phase)) * 0.42;
            cat.group.position.x = cat.baseX + Math.sin(t * 2 + cat.phase) * 0.18;
            cat.group.position.z = cat.baseZ + Math.cos(t * 2 + cat.phase) * 0.12;
            cat.group.rotation.z = Math.sin(t * 6 + cat.phase) * 0.25;
          }
          // Crystal mana shards bob gently and spin above the meadow trees.
          for (const mana of envMana) {
            mana.mesh.position.y = mana.baseY + Math.sin(t * 1.6 + mana.phase) * 0.28;
            mana.mesh.rotation.y = t * 0.9 + mana.phase;
            mana.mesh.rotation.x = Math.sin(t * 0.7 + mana.phase) * 0.4;
          }
        },
        dispose: () => {
          floraDisposed = true;
          // The park detaches + disposes itself FIRST — its InstancedMesh
          // owns real geometry/material, unlike the shared-cache flora the
          // traverse below is calibrated for.
          parkBuild?.dispose();
          parkBuild = null;
          scene.remove(group);
          scene.fog = null;
          scene.background = null;
          skyTexture.dispose();
          groundDiff.dispose();
          groundNor.dispose();
          butterflyWingMats.forEach((mat) => mat.map?.dispose());
          // Tree-foot cat assets are shared across every cat instance, so drop
          // them once here rather than per-mesh in the traverse below.
          catGeoBody.dispose();
          catGeoEar.dispose();
          catGeoTail.dispose();
          catMat.dispose();
          // Tree-foot tulip assets are shared across every ring instance too.
          tulipStemGeo.dispose();
          tulipBloomGeo.dispose();
          tulipStemMat.dispose();
          tulipBloomMat.dispose();
          // Tree-foot crystal-mana assets are shared across every shard too.
          manaGeo.dispose();
          manaMat.dispose();
          group.traverse((node) => {
            if (node instanceof THREE.InstancedMesh) {
              // Flora instances: release ONLY the instance buffers — the
              // geometry/material belong to the page-lifetime flora cache.
              node.dispose();
              return;
            }
            if (node instanceof THREE.Mesh || node instanceof THREE.Points) {
              node.geometry.dispose();
              (Array.isArray(node.material) ? node.material : [node.material]).forEach((m) => m.dispose());
            }
            if (node instanceof THREE.Sprite) {
              node.material.dispose();
            }
          });
        },
      };
    };

    const buildOrbitEnv = (): SceneEnv => {
      const rng = mulberry32(0x4f524249);
      const group = new THREE.Group();
      scene.add(group);
      scene.fog = null;

      // Cool night rig (env-local; the garden runs warm daylight instead).
      group.add(new THREE.AmbientLight(0x9fb8cc, 0.55));
      const key = new THREE.DirectionalLight(0xdfeaff, 0.9);
      key.position.set(8, 14, 6);
      group.add(key);
      const fill = new THREE.DirectionalLight(0x3377ff, 0.3);
      fill.position.set(-8, 4, -6);
      group.add(fill);

      const sky = makeSkyDome(0x0a1a30, 0x0a2a38, 0x04060e);
      group.add(sky);

      const stars = makeStars(rng, 550, 0.45, 0.8, true);
      const brightStars = makeStars(rng, 90, 1.0, 0.95, true);
      group.add(stars);
      group.add(brightStars);

      // Nebula auroras: huge soft additive glows drifting slowly.
      const auroras: { sprite: THREE.Sprite; phase: number }[] = [];
      const auroraSpecs = [
        { color: 0x0fd6c0, x: -34, y: 18, z: -58, scale: 70, opacity: 0.16 },
        { color: 0x3450c8, x: 40, y: 26, z: -66, scale: 84, opacity: 0.13 },
        { color: 0x00bcd4, x: 6, y: -12, z: -72, scale: 60, opacity: 0.1 },
      ];
      for (const spec of auroraSpecs) {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: glowTexture, color: spec.color, transparent: true, opacity: spec.opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
        );
        sprite.position.set(spec.x, spec.y, spec.z);
        sprite.scale.setScalar(spec.scale);
        group.add(sprite);
        auroras.push({ sprite, phase: rng() * Math.PI * 2 });
      }

      // A faint glass floor disc grounds the orbs without a meadow.
      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(60, 64),
        new THREE.MeshBasicMaterial({ color: 0x07202c, transparent: true, opacity: 0.35 }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.6;
      group.add(floor);

      const starsMat = stars.material as THREE.PointsMaterial;
      return {
        group,
        update: (t) => {
          if (reducedMotion) {
            return;
          }
          starsMat.opacity = 0.68 + Math.sin(t * 0.5) * 0.14;
          auroras.forEach((aurora, i) => {
            aurora.sprite.position.x += Math.sin(t * 0.05 + aurora.phase) * 0.02;
            aurora.sprite.material.opacity =
              (i === 0 ? 0.16 : i === 1 ? 0.13 : 0.1) + Math.sin(t * 0.18 + aurora.phase) * 0.03;
          });
        },
        dispose: () => {
          scene.remove(group);
          group.traverse((node) => {
            if (node instanceof THREE.Mesh || node instanceof THREE.Points) {
              node.geometry.dispose();
              (Array.isArray(node.material) ? node.material : [node.material]).forEach((m) => m.dispose());
            }
            if (node instanceof THREE.Sprite) {
              node.material.dispose();
            }
          });
        },
      };
    };

    // ── shared geometries ───────────────────────────────────────────────────
    const GEO = {
      foliageSide: new THREE.IcosahedronGeometry(0.7, 1),
      petal: new THREE.SphereGeometry(0.13, 8, 8),
      flowerCenter: new THREE.SphereGeometry(0.14, 10, 10),
      bud: new THREE.SphereGeometry(0.16, 10, 10),
      stem: new THREE.CylinderGeometry(0.03, 0.05, 1, 5),
      ring: new THREE.TorusGeometry(0.34, 0.015, 8, 48),
      orb: new THREE.SphereGeometry(1, 48, 48),
      turn: new THREE.SphereGeometry(0.22, 16, 16),
      crystal: new THREE.OctahedronGeometry(0.55, 0),
      // Small unit sphere reused for build-lane satellites and failure pips.
      pip: new THREE.SphereGeometry(0.12, 10, 10),
      // Unit sphere reused (scaled per axis) for every coarse tree hit volume
      // — pick() runs per pointermove AND per gesture cursor per frame, so the
      // segment count stays low and the geometry is shared, never per-entry.
      hitShell: new THREE.SphereGeometry(1, 10, 8),
    };
    const stemMat = new THREE.MeshPhongMaterial({ color: 0x1c6b4a, emissive: 0x1c6b4a, emissiveIntensity: 0.08 });

    const ideaEntries = new Map<string, Entry>();
    const treeEntries = new Map<string, Entry>();
    // RESEARCH MODE — the conversation SKY: cloud entries (one per topic, the
    // invisible hit ellipsoid + lazy label) and research rain entries (one per
    // quest, invisible hit sphere + droplet glow). The cloud bodies, wisps and
    // rain streaks live in the shared preallocated buffers below — a handful
    // of draw calls total, rewritten in place every frame (zero allocation).
    const cloudEntries = new Map<string, Entry>();
    const researchEntries = new Map<string, Entry>();
    // freshest-turn-id → cloud id: picks/dwell arrive keyed by the cloud's
    // freshest utterance ({kind:"dialogue"} — the branch-tip precedent), so
    // hover/dwell/activation resolve through this index.
    const freshTurnToCloud = new Map<string, string>();
    // Reconcile-computed render sets the frame loop reads (never allocates).
    let skyWisps: SkyLinkRef[] = [];
    // The last live membership per cloud — mergeTarget's evidence when a
    // cloud vanishes (its members' NEW topics say who absorbed it).
    const prevCloudMembers = new Map<string, string[]>();
    // Honesty flicker bookkeeping: agentAtMs advancing = a real applied agent
    // tick; the sky answers with a brief internal lightning flicker on the
    // clouds the agent linked. Derived from snapshot data, never a timer
    // pretending to be progress.
    let skyAgentAtMs: number | null = null;
    let skyFlashUntil = 0;
    // Hoisted scratch for the per-frame moon-rim uniform (no allocation).
    const skyMoonScratch = new THREE.Vector3();
    // The visible fan's center bearing: directly away from the boot camera,
    // so every cloud (and all of history) stays inside the vista's frame.
    const skyFanCenter = wallYawSeed(wallRef.current) + Math.PI;
    // One wind for the whole sky's rain shear — lateral to the vista so the
    // slant reads on screen (weather has a direction; ticks don't).
    const skyRainWindX = Math.sin(skyFanCenter + Math.PI / 2) * 0.3;
    const skyRainWindZ = Math.cos(skyFanCenter + Math.PI / 2) * 0.3;
    // Back-to-front lobe draw order for the alpha-blended cumulus bodies
    // (normal blending needs sorting or clouds read inside-out). Preallocated
    // slots, re-sorted on the 1s relayout tick — never per frame.
    const skyLobeOrder: { entry: Entry | null; lobe: number; depth: number }[] = Array.from(
      { length: SKY_MAX_PUFFS },
      () => ({ entry: null, lobe: 0, depth: -Infinity }),
    );
    let skyLobeCount = 0;
    const rebuildSkyLobeOrder = (camPos: THREE.Vector3) => {
      let filled = 0;
      for (const entry of cloudEntries.values()) {
        const puffs = entry.cloudPuffs;
        const count = entry.cloudPuffN ?? 0;
        if (puffs === undefined) {
          continue;
        }
        for (let lobe = 0; lobe < count && filled < SKY_MAX_PUFFS; lobe += 1) {
          const slot = skyLobeOrder[filled];
          const j = lobe * 6;
          const dx = entry.group.position.x + puffs[j] - camPos.x;
          const dy = entry.group.position.y + puffs[j + 1] - camPos.y;
          const dz = entry.group.position.z + puffs[j + 2] - camPos.z;
          slot.entry = entry;
          slot.lobe = lobe;
          slot.depth = dx * dx + dy * dy + dz * dz;
          filled += 1;
        }
      }
      for (let index = filled; index < SKY_MAX_PUFFS; index += 1) {
        skyLobeOrder[index].entry = null;
        skyLobeOrder[index].depth = -Infinity;
      }
      skyLobeCount = filled;
      // Farthest first; empty slots (-Infinity) sink to the tail.
      skyLobeOrder.sort((a, b) => b.depth - a.depth);
    };

    // Cumulus puff sprite: a soft base falloff overlaid with deterministic
    // cauliflower billows, sampled by the one-draw-call Points shader below.
    // The billow field is CENTERED (no directional bias): the shader rotates
    // the sample per lobe to kill repeat-stamping, and does ALL of the
    // lighting itself (crown/underside ramp + moon rim) in screen space.
    const makeCloudPuffTexture = (): THREE.CanvasTexture => {
      const size = 256;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      const c = size / 2;
      const base = ctx.createRadialGradient(c, c, 0, c, c, c * 0.98);
      base.addColorStop(0, "rgba(255,255,255,0.9)");
      base.addColorStop(0.48, "rgba(255,255,255,0.55)");
      base.addColorStop(0.8, "rgba(255,255,255,0.13)");
      base.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, size, size);
      const rng = mulberry32(hashSeed("sky:puff"));
      ctx.globalCompositeOperation = "lighter";
      for (let index = 0; index < 34; index += 1) {
        const angle = rng() * Math.PI * 2;
        const reach = rng() * size * 0.27;
        const x = c + Math.cos(angle) * reach;
        const y = c + Math.sin(angle) * reach;
        const radius = size * (0.045 + rng() * 0.1);
        const billow = ctx.createRadialGradient(x, y, 0, x, y, radius);
        billow.addColorStop(0, "rgba(255,255,255,0.4)");
        billow.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = billow;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    };

    // The sky rig: every shared GPU resource of the research sky, built
    // lazily on the first reconcile that resolves a cloud (zero cost when the
    // research props are empty) and torn down whole. Preallocated buffers —
    // the frame loop rewrites them in place.
    interface SkyRig {
      group: THREE.Group;
      puffTexture: THREE.CanvasTexture;
      puffGeom: THREE.BufferGeometry;
      puffMat: THREE.ShaderMaterial;
      puffPos: Float32Array;
      puffSize: Float32Array;
      puffColor: Float32Array;
      puffAlpha: Float32Array;
      puffShade: Float32Array;
      puffHaze: Float32Array;
      puffRot: Float32Array;
      wispGeom: THREE.BufferGeometry;
      wispPos: Float32Array;
      wispColor: Float32Array;
      wispEdge: Float32Array;
      anchorGeom: THREE.BufferGeometry;
      anchorPos: Float32Array;
      anchorColor: Float32Array;
      anchorMat: THREE.ShaderMaterial;
      rainGeom: THREE.BufferGeometry;
      rainPos: Float32Array;
      rainColor: Float32Array;
      rainEdge: Float32Array;
      starMat: THREE.ShaderMaterial;
      moonHalo: THREE.Sprite;
      moonWorld: THREE.Vector3;
      disposables: Array<{ dispose: () => void }>;
    }
    let skyRig: SkyRig | null = null;
    const ensureSkyRig = (): SkyRig => {
      if (skyRig !== null) {
        return skyRig;
      }
      const group = new THREE.Group();
      const disposables: Array<{ dispose: () => void }> = [];
      // Dusk atmosphere: dithered gradient dome + varied stars — the backdrop
      // the cumulus shading agrees with. The daylight garden is HIDDEN while
      // the sky stands (reconcile toggles env.group) — the ceiling is its own
      // dusk world, so no sunny meadow or butterflies fight the night.
      const dome = makeSkyDome(0x5a5382, 0x252c52, 0x0a0f22, true);
      dome.renderOrder = 2;
      group.add(dome);
      disposables.push(dome.geometry, dome.material as THREE.Material);
      scene.fog = new THREE.Fog(0x232a44, 70, 230);
      // A dark meadow-shadow floor grounds the bottom strip of the vista.
      const ground = new THREE.Mesh(
        new THREE.CircleGeometry(240, 48),
        new THREE.MeshBasicMaterial({ color: 0x0c1424 }),
      );
      ground.rotation.x = -Math.PI / 2;
      group.add(ground);
      disposables.push(ground.geometry, ground.material as THREE.Material);
      // A COMMITTED starfield (a dozen faint pixels reads as sensor noise):
      // one Points draw, real size/brightness spread — a magnitude law with a
      // handful of unmistakable heroes — plus warm/cool color temperature and
      // shader twinkle off a uTime uniform (frozen under reduced motion).
      const starCount = 380;
      const starPos = new Float32Array(starCount * 3);
      const starSize = new Float32Array(starCount);
      const starTw = new Float32Array(starCount);
      const starTint = new Float32Array(starCount);
      const starRng = mulberry32(hashSeed("sky:stars"));
      for (let index = 0; index < starCount; index += 1) {
        const theta = starRng() * Math.PI * 2;
        const phi = starRng() * Math.PI * 0.48 + 0.05;
        starPos[index * 3] = 130 * Math.sin(phi) * Math.cos(theta);
        starPos[index * 3 + 1] = 130 * Math.cos(phi);
        starPos[index * 3 + 2] = 130 * Math.sin(phi) * Math.sin(theta);
        const bright = starRng();
        // Magnitude law: mostly modest stars, the top ~8% clearly brighter.
        starSize[index] = 2.6 + bright * bright * 7 + (bright > 0.92 ? 5 : 0);
        starTw[index] = starRng() * Math.PI * 2;
        starTint[index] = starRng();
      }
      const starGeom = new THREE.BufferGeometry();
      starGeom.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
      starGeom.setAttribute("aSize", new THREE.BufferAttribute(starSize, 1));
      starGeom.setAttribute("aTw", new THREE.BufferAttribute(starTw, 1));
      starGeom.setAttribute("aTint", new THREE.BufferAttribute(starTint, 1));
      const starMat = new THREE.ShaderMaterial({
        uniforms: { uMap: { value: glowTexture }, uTime: { value: 0 }, uPx: { value: renderer.getPixelRatio() } },
        vertexShader: `
          attribute float aSize;
          attribute float aTw;
          attribute float aTint;
          uniform float uTime;
          uniform float uPx;
          varying float vA;
          varying float vTint;
          void main() {
            float tw = 0.78 + 0.22 * sin(uTime * (0.5 + fract(aTw) * 0.9) + aTw * 7.0);
            vA = tw * (0.42 + aSize * 0.07);
            vTint = aTint;
            gl_PointSize = aSize * uPx * (0.8 + 0.2 * tw);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D uMap;
          varying float vA;
          varying float vTint;
          void main() {
            vec4 tex = texture2D(uMap, gl_PointCoord);
            // Color temperature spread: icy blue-white through warm white.
            vec3 col = mix(vec3(0.76, 0.85, 1.0), vec3(1.0, 0.93, 0.8), vTint);
            gl_FragColor = vec4(col, tex.a * vA);
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const stars = new THREE.Points(starGeom, starMat);
      stars.renderOrder = 3;
      group.add(stars);
      disposables.push(starGeom, starMat);
      // Concentric TIME BANDS hung just under the deck: soft luminous rings at
      // the 2-minute / 10-minute / horizon radii, so time-as-radius reads as
      // designed sky structure (not a stray circle etched on the ground).
      for (const spec of [
        { mid: cloudRadius(120_000), alpha: 0.15 },
        { mid: cloudRadius(600_000), alpha: 0.11 },
        { mid: R_HORIZON, alpha: 0.09 },
      ]) {
        const half = 1.15;
        const bandGeom = new THREE.RingGeometry(spec.mid - half, spec.mid + half, 96, 1);
        const bandMat = new THREE.ShaderMaterial({
          uniforms: { uMid: { value: spec.mid }, uHalf: { value: half }, uAlpha: { value: spec.alpha } },
          vertexShader: `
            varying float vR;
            void main() {
              vR = length(position.xy);
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: `
            uniform float uMid;
            uniform float uHalf;
            uniform float uAlpha;
            varying float vR;
            void main() {
              float band = 1.0 - clamp(abs(vR - uMid) / uHalf, 0.0, 1.0);
              gl_FragColor = vec4(vec3(0.56, 0.66, 0.86), uAlpha * band * band);
            }
          `,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        });
        const band = new THREE.Mesh(bandGeom, bandMat);
        band.rotation.x = -Math.PI / 2;
        band.position.y = SKY_ALT - 1.1;
        band.renderOrder = 4;
        group.add(band);
        disposables.push(bandGeom, bandMat);
      }
      // The MOON: the light source the cumulus modelling agrees with (warm
      // crowns, moon-side rims), parked off-axis high in the vista. A CRISP
      // DISC — limb-darkened circle with a couple of soft maria — inside a
      // restrained halo (a bare radial glow reads as a bokeh artifact). The
      // halo brightens while research inference is actually in flight
      // (researchThinking — real snapshot data, never a timer).
      const moonAz = skyFanCenter - 0.42;
      const moonCanvas = document.createElement("canvas");
      moonCanvas.width = 128;
      moonCanvas.height = 128;
      const moonCtx = moonCanvas.getContext("2d")!;
      const moonR = 52;
      const limb = moonCtx.createRadialGradient(58, 58, moonR * 0.25, 64, 64, moonR);
      limb.addColorStop(0, "rgba(246, 241, 226, 1)");
      limb.addColorStop(0.75, "rgba(232, 226, 208, 1)");
      limb.addColorStop(1, "rgba(196, 194, 186, 1)");
      moonCtx.fillStyle = limb;
      moonCtx.beginPath();
      moonCtx.arc(64, 64, moonR, 0, Math.PI * 2);
      moonCtx.fill();
      const moonRng = mulberry32(hashSeed("sky:moon"));
      for (let index = 0; index < 7; index += 1) {
        const angle = moonRng() * Math.PI * 2;
        const reach = moonRng() * moonR * 0.55;
        const mx = 64 + Math.cos(angle) * reach;
        const my = 64 + Math.sin(angle) * reach;
        const mr = moonR * (0.1 + moonRng() * 0.16);
        const mare = moonCtx.createRadialGradient(mx, my, 0, mx, my, mr);
        mare.addColorStop(0, "rgba(158, 158, 158, 0.32)");
        mare.addColorStop(1, "rgba(158, 158, 158, 0)");
        moonCtx.fillStyle = mare;
        moonCtx.beginPath();
        moonCtx.arc(mx, my, mr, 0, Math.PI * 2);
        moonCtx.fill();
      }
      const moonTexture = new THREE.CanvasTexture(moonCanvas);
      moonTexture.colorSpace = THREE.SRGBColorSpace;
      const moonCore = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: moonTexture, transparent: true, opacity: 1, depthWrite: false, fog: false }),
      );
      moonCore.position.set(Math.sin(moonAz) * 30, SKY_ALT + 21, Math.cos(moonAz) * 30);
      moonCore.scale.setScalar(3.4);
      moonCore.renderOrder = 5;
      group.add(moonCore);
      disposables.push(moonCore.material, moonTexture);
      const moonHalo = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glowTexture, color: 0xcfd8f2, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
      );
      moonHalo.position.copy(moonCore.position);
      moonHalo.scale.setScalar(11);
      moonHalo.renderOrder = 4;
      group.add(moonHalo);
      disposables.push(moonHalo.material);
      // World-space light position for the puff shader's moon-side rim.
      const moonWorld = moonCore.position.clone();
      // ALL cloud lobes in ONE Points draw call: soft billboards sized in the
      // shader (world size / distance), NORMAL-blended (additive reads as fog,
      // not cumulus) and depth-sorted back-to-front by rebuildSkyLobeOrder.
      // Modelling: per-lobe height shade (aShade) × an in-sprite vertical ramp
      // = bright moonlit crowns over shadowed underbellies, plus a cool rim on
      // the upper silhouette and aerial haze (aHaze) that sinks aged clouds
      // into the dusk.
      const puffTexture = makeCloudPuffTexture();
      const puffGeom = new THREE.BufferGeometry();
      const puffPos = new Float32Array(SKY_MAX_PUFFS * 3);
      const puffSize = new Float32Array(SKY_MAX_PUFFS);
      const puffColor = new Float32Array(SKY_MAX_PUFFS * 3);
      const puffAlpha = new Float32Array(SKY_MAX_PUFFS);
      const puffShade = new Float32Array(SKY_MAX_PUFFS);
      const puffHaze = new Float32Array(SKY_MAX_PUFFS);
      const puffRot = new Float32Array(SKY_MAX_PUFFS);
      puffGeom.setAttribute("position", new THREE.BufferAttribute(puffPos, 3).setUsage(THREE.DynamicDrawUsage));
      puffGeom.setAttribute("aSize", new THREE.BufferAttribute(puffSize, 1).setUsage(THREE.DynamicDrawUsage));
      puffGeom.setAttribute("aColor", new THREE.BufferAttribute(puffColor, 3).setUsage(THREE.DynamicDrawUsage));
      puffGeom.setAttribute("aAlpha", new THREE.BufferAttribute(puffAlpha, 1).setUsage(THREE.DynamicDrawUsage));
      puffGeom.setAttribute("aShade", new THREE.BufferAttribute(puffShade, 1).setUsage(THREE.DynamicDrawUsage));
      puffGeom.setAttribute("aHaze", new THREE.BufferAttribute(puffHaze, 1).setUsage(THREE.DynamicDrawUsage));
      puffGeom.setAttribute("aRot", new THREE.BufferAttribute(puffRot, 1).setUsage(THREE.DynamicDrawUsage));
      puffGeom.setDrawRange(0, 0);
      const puffMat = new THREE.ShaderMaterial({
        uniforms: { uMap: { value: puffTexture }, uScale: { value: 800 }, uMoonView: { value: new THREE.Vector3(0, 1, 0) } },
        vertexShader: `
          attribute float aSize;
          attribute vec3 aColor;
          attribute float aAlpha;
          attribute float aShade;
          attribute float aHaze;
          attribute float aRot;
          varying vec3 vColor;
          varying float vAlpha;
          varying float vShade;
          varying float vHaze;
          varying vec2 vRot;
          varying vec2 vMoonDir;
          uniform float uScale;
          uniform vec3 uMoonView;
          void main() {
            vColor = aColor;
            vAlpha = aAlpha;
            vShade = aShade;
            vHaze = aHaze;
            vRot = vec2(cos(aRot), sin(aRot));
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            // Screen-space direction from this lobe toward the moon: the rim
            // light hugs the moon-facing silhouette (view-space y is up, but
            // gl_PointCoord.y runs down — flip when consumed).
            vMoonDir = normalize(uMoonView.xy - mv.xy + vec2(1e-4));
            gl_PointSize = min(aSize * uScale / max(-mv.z, 0.1), 640.0);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: `
          uniform sampler2D uMap;
          varying vec3 vColor;
          varying float vAlpha;
          varying float vShade;
          varying float vHaze;
          varying vec2 vRot;
          varying vec2 vMoonDir;
          void main() {
            vec2 off = gl_PointCoord - vec2(0.5);
            // Per-lobe stamp rotation: same billow canvas, never the same curl
            // twice. Lighting below stays in UNROTATED screen space.
            vec2 ruv = vec2(vRot.x * off.x - vRot.y * off.y, vRot.y * off.x + vRot.x * off.y) + vec2(0.5);
            vec4 tex = texture2D(uMap, ruv);
            // Crown lobes take a HARDER edge (dense sunlit cauliflower);
            // bases keep the soft feather (mist under the belly).
            float shaped = mix(tex.a, smoothstep(0.1, 0.62, tex.a), vShade * 0.85);
            // Value + hue modelling: warm-white crowns falling to blue-grey
            // undersides — a real shading ramp, not one flat grey.
            float shadeMix = clamp(vShade * 1.15 - (gl_PointCoord.y - 0.5) * 0.9, 0.0, 1.0);
            vec3 lit = vColor * mix(vec3(0.5, 0.55, 0.7), vec3(1.12, 1.07, 0.98), shadeMix);
            // Warm moon-keyed rim on the moon-facing silhouette edge.
            float edge = smoothstep(0.22, 0.5, length(off));
            float facing = clamp(dot(normalize(off + vec2(1e-4)), vec2(vMoonDir.x, -vMoonDir.y)), 0.0, 1.0);
            lit += vec3(1.0, 0.95, 0.84) * edge * facing * facing * 0.55 * (0.35 + 0.65 * vShade);
            // Aerial perspective: age hazes the body into the dusk sky —
            // CAPPED so distant clouds keep a silhouette (never a smudge).
            lit = mix(lit, vec3(0.2, 0.24, 0.38), vHaze);
            gl_FragColor = vec4(lit, shaped * vAlpha);
          }
        `,
        transparent: true,
        depthWrite: false,
      });
      // Seed the pixel factor from the live viewport (resize keeps it fresh;
      // the anchor glows below share it once built).
      puffMat.uniforms.uScale!.value = Math.max(container.clientHeight, 1) / (2 * Math.tan((camera.fov * Math.PI) / 360));
      const puffs = new THREE.Points(puffGeom, puffMat);
      puffs.frustumCulled = false;
      puffs.renderOrder = 6;
      group.add(puffs);
      disposables.push(puffGeom, puffMat, puffTexture);
      // ALL wisps in ONE Mesh of soft-edged additive RIBBONS: quad strips
      // along an arc that bows gently ABOVE the deck (an arch between clouds,
      // never a hairline sagging into the ground). aEdge = (across −1..1,
      // along 0..1) feathers the edge and fades the ends in the shader;
      // provenance (warm agent / cool lexical) × strength lives in the color.
      const wispGeom = new THREE.BufferGeometry();
      const wispPos = new Float32Array(SKY_MAX_WISP_VERTS * 3);
      const wispColor = new Float32Array(SKY_MAX_WISP_VERTS * 3);
      const wispEdge = new Float32Array(SKY_MAX_WISP_VERTS * 2);
      wispGeom.setAttribute("position", new THREE.BufferAttribute(wispPos, 3).setUsage(THREE.DynamicDrawUsage));
      wispGeom.setAttribute("aColor", new THREE.BufferAttribute(wispColor, 3).setUsage(THREE.DynamicDrawUsage));
      wispGeom.setAttribute("aEdge", new THREE.BufferAttribute(wispEdge, 2).setUsage(THREE.DynamicDrawUsage));
      wispGeom.setDrawRange(0, 0);
      const wispMat = new THREE.ShaderMaterial({
        vertexShader: `
          attribute vec3 aColor;
          attribute vec2 aEdge;
          varying vec3 vColor;
          varying vec2 vEdge;
          void main() {
            vColor = aColor;
            vEdge = aEdge;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec3 vColor;
          varying vec2 vEdge;
          void main() {
            float across = 1.0 - abs(vEdge.x);
            float ends = smoothstep(0.0, 0.14, vEdge.y) * smoothstep(1.0, 0.86, vEdge.y);
            // Feathered body with a BRIGHT CORE line: the arc must survive
            // projector distance, not wash out into the haze. The core scales
            // the provenance color proportionally (channel ratios — the
            // warm/cool honesty read — stay intact).
            float core = smoothstep(0.5, 1.0, across);
            gl_FragColor = vec4(vColor * (1.0 + core * 1.1), across * across * ends * (0.5 + 0.5 * core));
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const wispMesh = new THREE.Mesh(wispGeom, wispMat);
      wispMesh.frustumCulled = false;
      wispMesh.renderOrder = 5;
      group.add(wispMesh);
      disposables.push(wispGeom, wispMat);
      // Wisp ENDPOINT ANCHORS: a provenance-colored glow sunk INSIDE each
      // linked cloud, so an arc visibly BELONGS to its two clouds even when
      // the ribbon crosses haze. One extra Points draw, ≤2 per wisp.
      const anchorGeom = new THREE.BufferGeometry();
      const anchorPos = new Float32Array(MAX_WISPS * 2 * 3);
      const anchorColor = new Float32Array(MAX_WISPS * 2 * 3);
      anchorGeom.setAttribute("position", new THREE.BufferAttribute(anchorPos, 3).setUsage(THREE.DynamicDrawUsage));
      anchorGeom.setAttribute("aColor", new THREE.BufferAttribute(anchorColor, 3).setUsage(THREE.DynamicDrawUsage));
      anchorGeom.setDrawRange(0, 0);
      const anchorMat = new THREE.ShaderMaterial({
        uniforms: { uMap: { value: glowTexture }, uScale: { value: 800 } },
        vertexShader: `
          attribute vec3 aColor;
          varying vec3 vColor;
          uniform float uScale;
          void main() {
            vColor = aColor;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = min(2.4 * uScale / max(-mv.z, 0.1), 160.0);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: `
          uniform sampler2D uMap;
          varying vec3 vColor;
          void main() {
            vec4 tex = texture2D(uMap, gl_PointCoord);
            gl_FragColor = vec4(vColor, tex.a * 0.85);
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const anchorPoints = new THREE.Points(anchorGeom, anchorMat);
      anchorPoints.frustumCulled = false;
      anchorPoints.renderOrder = 7;
      group.add(anchorPoints);
      disposables.push(anchorGeom, anchorMat);
      anchorMat.uniforms.uScale!.value = puffMat.uniforms.uScale!.value;
      // ALL rain in ONE Mesh of tapered streak quads anchored to the cloud
      // base: alpha thins to nothing at the tip and glints where the streak
      // leaves the cloud. Status keeps the RESEARCH_STATUS_COLOR hue but
      // desaturated toward rain-grey — finished weather, not debug ticks.
      const rainGeom = new THREE.BufferGeometry();
      const rainPos = new Float32Array(SKY_MAX_RAIN_VERTS * 3);
      const rainColor = new Float32Array(SKY_MAX_RAIN_VERTS * 3);
      const rainEdge = new Float32Array(SKY_MAX_RAIN_VERTS * 2);
      rainGeom.setAttribute("position", new THREE.BufferAttribute(rainPos, 3).setUsage(THREE.DynamicDrawUsage));
      rainGeom.setAttribute("aColor", new THREE.BufferAttribute(rainColor, 3).setUsage(THREE.DynamicDrawUsage));
      rainGeom.setAttribute("aEdge", new THREE.BufferAttribute(rainEdge, 2).setUsage(THREE.DynamicDrawUsage));
      rainGeom.setDrawRange(0, 0);
      const rainMat = new THREE.ShaderMaterial({
        vertexShader: `
          attribute vec3 aColor;
          attribute vec2 aEdge;
          varying vec3 vColor;
          varying vec2 vEdge;
          void main() {
            vColor = aColor;
            vEdge = aEdge;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec3 vColor;
          varying vec2 vEdge;
          void main() {
            float across = 1.0 - abs(vEdge.x);
            float taper = 1.0 - vEdge.y;
            float glint = smoothstep(0.12, 0.0, vEdge.y) * 0.4;
            gl_FragColor = vec4(vColor, across * across * (taper * taper * 0.85 + glint));
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const rainMesh = new THREE.Mesh(rainGeom, rainMat);
      rainMesh.frustumCulled = false;
      rainMesh.renderOrder = 5;
      group.add(rainMesh);
      disposables.push(rainGeom, rainMat);
      scene.add(group);
      skyRig = { group, puffTexture, puffGeom, puffMat, puffPos, puffSize, puffColor, puffAlpha, puffShade, puffHaze, puffRot, wispGeom, wispPos, wispColor, wispEdge, anchorGeom, anchorPos, anchorColor, anchorMat, rainGeom, rainPos, rainColor, rainEdge, starMat, moonHalo, moonWorld, disposables };
      return skyRig;
    };
    const clearSkyRig = () => {
      if (skyRig === null) {
        return;
      }
      scene.remove(skyRig.group);
      for (const resource of skyRig.disposables) {
        resource.dispose();
      }
      skyRig = null;
      // Hand the daylight world back (mode/layout switched away from the sky).
      if (env !== null) {
        env.group.visible = true;
      }
    };

    // Dispose an entry's per-entry GPU resources. Registered materials live in
    // entry.mats; per-node geometries (rings, hit volumes, indicator arcs) are
    // flagged ownGeometry and inline per-entry materials ownMaterial. Everything
    // else on a node is SHARED (GEO.*, trunk/stem, the photoscan flora cache)
    // and is freed once at unmount — never here.
    const disposeEntry = (entry: Entry) => {
      scene.remove(entry.group);
      entry.mats.forEach((mat) => mat.dispose());
      if (entry.label !== null) {
        entry.label.material.map?.dispose();
        entry.label.material.dispose();
      }
      entry.group.traverse((node) => {
        if (node instanceof THREE.Sprite) {
          if (node !== entry.label) {
            // Per-node label sprites (the self tree's PR tip cards) own their
            // canvas map — same ownMap convention as the dialogue tree chrome.
            if (node.userData.ownMap === true) {
              node.material.map?.dispose();
            }
            node.material.dispose();
          }
          return;
        }
        if (node instanceof THREE.Mesh && node.userData.ownGeometry === true) {
          node.geometry.dispose();
        }
        if (node instanceof THREE.Mesh && node.userData.ownMaterial === true) {
          (Array.isArray(node.material) ? node.material : [node.material]).forEach((mat) => mat.dispose());
        }
      });
      entry.disposeExtra?.();
    };

    // ── richer per-process indicators (shared by every render style) ─────────
    // Every indicator is built ONCE per entry (only on a spec change, never per
    // frame) and freed by disposeEntry's generic sweep. Sizes/heights are passed
    // in so garden trees, orbit orbs, and hyperbolic flora reuse the same code.

    // A small ring of build-lane status satellites (mocking=amber, ready=green,
    // failed=red) around the node — one sphere per lane, one material per status.
    const addLaneSatellites = (group: THREE.Group, lanes: TreeBuildSummary, y: number, radius: number, dot: number) => {
      const total = lanes.building + lanes.ready + lanes.failed;
      if (total === 0) {
        return;
      }
      const bands: [number, number][] = [
        [LANE_BUILDING_COLOR, lanes.building],
        [LANE_READY_COLOR, lanes.ready],
        [LANE_FAILED_COLOR, lanes.failed],
      ];
      let placed = 0;
      for (const [color, count] of bands) {
        if (count === 0) {
          continue;
        }
        const mat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.75 });
        for (let i = 0; i < count; i += 1) {
          const angle = (placed / total) * Math.PI * 2 - Math.PI / 2;
          const sat = new THREE.Mesh(GEO.pip, mat);
          sat.userData.ownMaterial = true;
          sat.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
          sat.scale.setScalar(dot);
          group.add(sat);
          placed += 1;
        }
      }
    };

    // Partial gauge arc sweeping 0→`arc` (0..1) of a ring, starting at the top.
    // `tilt` lets orbit/flora lay it in the tilted plane their other rings use;
    // omitted, it lies flat on the ground like the garden's commission ring.
    // Returns the mesh so builders can wire it into their in-place progress
    // updater (setArcSweep) instead of rebuilding the entry per percent tick.
    const arcSweepGeometry = (radius: number, thickness: number, arc: number) =>
      new THREE.TorusGeometry(radius, thickness, 8, 48, Math.PI * 2 * Math.min(Math.max(arc, 0.02), 1));
    const addProgressArc = (group: THREE.Group, arc: number, y: number, radius: number, thickness: number, tilt?: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(arcSweepGeometry(radius, thickness, arc), new THREE.MeshBasicMaterial({ color: PROGRESS_ARC_COLOR, transparent: true, opacity: 0.85 }));
      mesh.userData.ownGeometry = true;
      mesh.userData.ownMaterial = true;
      // Stashed so setArcSweep regrows the sweep at the same ring dimensions.
      mesh.userData.arcRadius = radius;
      mesh.userData.arcThickness = thickness;
      mesh.rotation.x = tilt ?? Math.PI / 2;
      mesh.rotation.z = Math.PI / 2; // start the sweep near the top
      mesh.position.y = y;
      group.add(mesh);
      return mesh;
    };
    // In-place sweep update for a live arc: swap ONLY the small partial-torus
    // geometry — the mesh, material, transform and ownGeometry dispose flag
    // all persist (disposeEntry's sweep frees whichever geometry is current).
    const setArcSweep = (mesh: THREE.Mesh, arc: number) => {
      mesh.geometry.dispose();
      mesh.geometry = arcSweepGeometry(mesh.userData.arcRadius as number, mesh.userData.arcThickness as number, arc);
    };

    // A take-home publish beacon: a bright core + additive halo crowning the node.
    const addPublishedBeacon = (group: THREE.Group, y: number, scale: number) => {
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glowTexture, color: PUBLISHED_COLOR, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
      );
      halo.position.y = y;
      halo.scale.setScalar(scale);
      group.add(halo);
      const core = new THREE.Mesh(GEO.pip, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      core.userData.ownMaterial = true;
      core.position.y = y;
      core.scale.setScalar(scale * 0.4);
      group.add(core);
    };

    // A single red failure pip clipped to the node's crown/shell.
    const addFailedPip = (group: THREE.Group, x: number, y: number, scale: number) => {
      const pip = new THREE.Mesh(GEO.pip, new THREE.MeshBasicMaterial({ color: FAILED_PIP_COLOR }));
      pip.userData.ownMaterial = true;
      pip.position.set(x, y, 0);
      pip.scale.setScalar(scale);
      group.add(pip);
    };

    // The gold/completion stage ring around a grown node. `commission` (executing)
    // is the classic gold halo; `built` (finished) is a brighter, thicker ring.
    const addStageRing = (group: THREE.Group, style: TreeRingStyle, radius: number, y: number, tilt: number) => {
      if (style === "none") {
        return;
      }
      const built = style === "built";
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius, built ? 0.09 : 0.06, 8, 64),
        new THREE.MeshBasicMaterial({ color: built ? BUILT_RING_COLOR : COMMISSION_COLOR, transparent: true, opacity: built ? 0.8 : 0.55 }),
      );
      ring.userData.ownGeometry = true;
      ring.userData.ownMaterial = true;
      ring.rotation.x = tilt;
      ring.position.y = y;
      group.add(ring);
    };

    // ── garden builders ─────────────────────────────────────────────────────
    // ONE VISUAL LANGUAGE: every radial-garden BUILD TREE is grown by the HD
    // tree engine (buildTreeLOD — the SELF tree's substrate) from the pure
    // fleetTreeSpec3D mapping of its real data; the photoscan flora library
    // now serves the IDEA FLOWERS (gazania when ready, dandelion puffball
    // while forming) and the ambient meadow scatter only. The DATA channels
    // ride ON TOP as overlays: the glass label, a state-colored glowing
    // ground ring (also the active-pulse/flash target), the gold commission
    // ring, the steering ring, and a maturity-colored glow at the flower's
    // heart. Until flora arrives (or on software GL) the primitive flower
    // glyphs render.
    let floraLib: FloraLibrary | null = null;
    let floraNodesDirty = false;
    const invisibleHitMat = new THREE.MeshBasicMaterial({ visible: false });
    // The COARSE tree volumes use their own BACK-side material so the
    // raycaster only ever reports their FAR face. Every sub-object volume they
    // enclose (branch tips, issue fruit, and whatever per-limb spine volumes
    // land next) is therefore hit FIRST and wins its own sub-pick, while a ray
    // that touches no sub-object still falls through to {kind:"process"}.
    // Without this the coarse hull's near face shadows the whole tree and
    // every branch/issue pick inside it dies.
    const invisibleShellMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.BackSide });

    // ── GIT SUBSTRATE chrome: branch-tip cards + issue FRUIT ────────────────
    // The BODY (trunk + room/* branch limbs) is grown by the HD engine from
    // fleetTreeSpec3D — this chrome layers the DATA channels on top. Each
    // data branch's tip gets a glowing bud, a floating tip card (the self
    // tree's PR-tip vocabulary: branch name / commits / PR ✓) and an
    // invisible pick sphere; the fetched issue set hangs as emissive FRUIT on
    // ONE translucent additive holo branch arcing off the mid-trunk (an
    // ATTACHMENT by design — deliberately ghostly, never wood). Sub-objects
    // carry BOTH a pick payload (kind "branch"/"issue" routes to the popup
    // callbacks below) and a subTargetId, so the dwell seam projects the
    // SUB-OBJECT's own rect — never the whole-tree bbox. Everything is
    // per-entry owned (ownGeometry/ownMaterial/ownMap) so disposeEntry's
    // generic sweep frees it; limb/fruit changes regrow the entry through
    // the limbSignature/fruitSignature structural gate.
    const SCENE_BRANCH_PREFIX = "scene:branch:";
    const SCENE_ISSUE_PREFIX = "scene:issue:";
    const branchTargetId = (callsign: string, branch: string) => `${SCENE_BRANCH_PREFIX}${callsign}:${branch}`;
    const issueTargetId = (callsign: string, issueNumber: number) => `${SCENE_ISSUE_PREFIX}${callsign}:${issueNumber}`;
    const HOLO_BRANCH_COLOR = 0x67e8f9;
    // The whole-tree PICK SURFACE, shared by every HD-grown tree (fleet AND
    // self): the engine's merged wood and instanced foliage never raycast, so
    // these invisible volumes ARE the tree as far as the mouse and the dwell
    // cursor are concerned. They are fitted to the body's REAL drawn bounds
    // (tree-hit-volumes.ts plans them as pure data), which is what makes a
    // click on the CROWN select the tree — a trunk-sized sphere leaves the
    // canopy dead and the pointer path reads that as empty ground.
    const addProcessHitVolumes = (
      group: THREE.Group,
      body: THREE.Object3D,
      callsign: string,
      trunk: { height: number; radius: number },
    ) => {
      // Measured in the entry group's local space: the body sits at the tree's
      // origin and the volumes are its siblings, so they scale/move with it.
      const box = new THREE.Box3().setFromObject(body);
      const bounds = box.isEmpty()
        ? { min: { x: -1.5, y: 0, z: -1.5 }, max: { x: 1.5, y: trunk.height, z: 1.5 } }
        : { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } };
      for (const volume of processHitVolumes(bounds, trunk)) {
        // The canopy is the shared unit sphere scaled to its semi-axes; the
        // trunk is a per-entry truncated cone tapered like the drawn wood, so
        // it shadows exactly what the wood shadows and no more.
        const hit =
          volume.shape === "column"
            ? new THREE.Mesh(
                new THREE.CylinderGeometry(volume.radiusTop, volume.radius.x, volume.radius.y * 2, 10, 1),
                invisibleShellMat,
              )
            : new THREE.Mesh(GEO.hitShell, invisibleShellMat);
        if (volume.shape === "column") {
          hit.userData.ownGeometry = true;
        } else {
          hit.scale.set(volume.radius.x, volume.radius.y, volume.radius.z);
        }
        hit.position.set(volume.center.x, volume.center.y, volume.center.z);
        // The payload carries WHICH volume this is, so the pure precedence
        // rule (resolveScenePick, tree-limbs.ts) can weigh them without
        // re-deriving the plan:
        //   • CANOPY → `coarse`: a metres-wide stand-in for a body that never
        //     raycasts. It spans every limb and fruit of this tree, so a
        //     sub-target of the SAME tree overrules it.
        //   • TRUNK → `trunk`: not coarse — the tapered column IS the drawn
        //     wood, so a click on it opens the tree menu, and it is what a
        //     fat spine volume crossing in front of it yields back to.
        // Belt and braces with the BackSide material above: BackSide already
        // makes the raycaster report these hulls AFTER everything they
        // enclose, so the rule is a refinement here, not a prerequisite.
        hit.userData.pick =
          volume.id === "trunk"
            ? { kind: "process", callsign, trunk: true }
            : { kind: "process", callsign, coarse: true };
        group.add(hit);
      }
    };
    // THE WHOLE LIMB PICKS, not just its tip. The engine's merged bark never
    // raycasts, so before this a 3-unit branch offered one 0.85-unit sphere at
    // its very end and the room read as "one hitbox per tree". These invisible
    // spheres thread the branch's own spine (spineHitPoints, pure) carrying the
    // SAME payload as the tip.
    // They ride their OWN group — deliberately no subTargetId — because the
    // tipGroup's projected box is the popup anchor rect, and inflating it would
    // drag the card down the branch. Flagged `alongLimb`: they are several
    // times fatter than the wood they stand for, so they are the one sub-target
    // that yields back to its own trunk (resolveScenePick).
    const addLimbSpineHits = (
      group: THREE.Group,
      branchSpec: TreeBranchSpec3D,
      pick: { kind: string; callsign: string; branch: string },
    ) => {
      const volumes = spineHitPoints(branchSpec.points, branchSpec.thickness);
      if (volumes.length === 0) {
        return;
      }
      const spineGroup = new THREE.Group();
      spineGroup.userData.pick = { ...pick, alongLimb: true };
      for (const volume of volumes) {
        const spineHit = new THREE.Mesh(new THREE.SphereGeometry(volume.radius, 8, 8), invisibleHitMat);
        spineHit.userData.ownGeometry = true;
        spineHit.position.set(volume.at.x, volume.at.y, volume.at.z);
        spineGroup.add(spineHit);
      }
      group.add(spineGroup);
    };
    // Tip chrome for every DATA branch of an HD fleet body (tips carrying a
    // pickId — fleetTreeSpec3D stamps the full room/* branch ref there;
    // decorative fill branches have no tip and get no chrome). The WHOLE limb
    // picks: the tip owns the anchor group, and invisible spine volumes carry
    // the same payload down the wood (addLimbSpineHits).
    const addBranchTipChrome = (group: THREE.Group, spec: TreeSpec, spec3d: TreeSpec3D, scale: number) => {
      for (const branchSpec of spec3d.branches) {
        const tipSpec = branchSpec.tip;
        if (tipSpec === undefined || tipSpec.pickId === undefined || tipSpec.pickId === null || branchSpec.points.length === 0) {
          continue;
        }
        const at = branchSpec.points[branchSpec.points.length - 1];
        const tip = new THREE.Vector3(at.x, at.y, at.z);
        const budColor = tipSpec.color;
        const limbPick = { kind: "branch", callsign: spec.callsign, branch: tipSpec.pickId };
        // The SUB-OBJECT: bud + halo + tip card + hit sphere in one group —
        // its projected box IS the popup anchor rect.
        const tipGroup = new THREE.Group();
        tipGroup.userData.subTargetId = branchTargetId(spec.callsign, tipSpec.pickId);
        tipGroup.userData.pick = limbPick;
        const bud = new THREE.Mesh(
          GEO.bud,
          new THREE.MeshPhongMaterial({ color: budColor, emissive: budColor, emissiveIntensity: 0.9 }),
        );
        bud.userData.ownMaterial = true;
        bud.position.copy(tip);
        bud.scale.setScalar(0.9 + 0.7 * scale);
        tipGroup.add(bud);
        const budGlow = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: glowTexture, color: budColor, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        budGlow.position.copy(tip);
        budGlow.scale.setScalar(0.5 + 0.7 * scale);
        tipGroup.add(budGlow);
        const tipLabel = makeLabelSprite(tipSpec.label ?? "", tipSpec.sub ?? "", cssHex(budColor));
        tipLabel.userData.ownMap = true;
        tipLabel.position.set(tip.x, tip.y + 0.22, tip.z);
        tipGroup.add(tipLabel);
        const tipHit = new THREE.Mesh(new THREE.SphereGeometry(0.85, 8, 8), invisibleHitMat);
        tipHit.userData.ownGeometry = true;
        tipHit.position.copy(tip);
        tipGroup.add(tipHit);
        group.add(tipGroup);
        addLimbSpineHits(group, branchSpec, limbPick);
      }
    };
    const addIssueFruit = (group: THREE.Group, spec: TreeSpec, trunkTop: number, scale: number) => {
      const fruits = fruitSpecs(spec.issues);
      if (fruits.length === 0) {
        return;
      }
      // ONE ghostly holo bough for the whole issue set: additive cyan, semi-
      // transparent, no depth write — reads as a hologram, never as wood.
      const arcPoints = holoArcPoints(spec.upid, trunkTop, scale).map((p) => new THREE.Vector3(p.x, p.y, p.z));
      const arcCurve = new THREE.CatmullRomCurve3(arcPoints);
      const holo = new THREE.Mesh(
        new THREE.TubeGeometry(arcCurve, 14, 0.02 + 0.05 * scale, 6, false),
        new THREE.MeshBasicMaterial({ color: HOLO_BRANCH_COLOR, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      holo.userData.ownGeometry = true;
      holo.userData.ownMaterial = true;
      holo.raycast = () => {};
      group.add(holo);
      for (const fruit of fruits) {
        const at = arcCurve.getPoint(fruit.t);
        at.y -= 0.14; // fruit hangs just under the bough
        const fruitGroup = new THREE.Group();
        fruitGroup.userData.subTargetId = issueTargetId(spec.callsign, fruit.number);
        fruitGroup.userData.pick = { kind: "issue", callsign: spec.callsign, number: fruit.number };
        const orb = new THREE.Mesh(
          GEO.bud,
          new THREE.MeshPhongMaterial({ color: fruit.color, emissive: fruit.color, emissiveIntensity: 0.85 }),
        );
        orb.userData.ownMaterial = true;
        orb.position.copy(at);
        orb.scale.setScalar(1.0 + 0.8 * scale);
        fruitGroup.add(orb);
        const halo = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: glowTexture, color: fruit.color, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        halo.position.copy(at);
        halo.scale.setScalar(0.55 + 0.6 * scale);
        fruitGroup.add(halo);
        const fruitHit = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 8), invisibleHitMat);
        fruitHit.userData.ownGeometry = true;
        fruitHit.position.copy(at);
        fruitGroup.add(fruitHit);
        group.add(fruitGroup);
      }
    };

    // A dancing dog parked at the foot of the tree beside the cat — a longer
    // body, snout, droopy ears and a wagging tail. It sits on the far side of
    // the cat and counter-rotates so both companions face outward at the
    // trunk's foot rather than overlapping; makeDancingCat parents it, so it
    // rides the same frame-loop sway (its "dance").
    const makeDancingDog = (): THREE.Group => {
      const dogMat = new THREE.MeshPhongMaterial({ color: 0x8a6a44, emissive: 0x8a6a44, emissiveIntensity: 0.08 });
      const dog = new THREE.Group();
      const dogBody = new THREE.Mesh(GEO.bud, dogMat);
      dogBody.scale.set(1.0, 1.0, 1.3);
      dogBody.position.y = 0.22;
      dogBody.userData.ownMaterial = true;
      dog.add(dogBody);
      const dogHead = new THREE.Mesh(GEO.bud, dogMat);
      dogHead.scale.setScalar(0.85);
      dogHead.position.set(0, 0.42, 0.22);
      dog.add(dogHead);
      const dogSnout = new THREE.Mesh(GEO.bud, dogMat);
      dogSnout.scale.set(0.4, 0.4, 0.6);
      dogSnout.position.set(0, 0.36, 0.4);
      dog.add(dogSnout);
      for (const ex of [-0.14, 0.14]) {
        const ear = new THREE.Mesh(GEO.bud, dogMat);
        ear.scale.set(0.16, 0.32, 0.1);
        ear.position.set(ex, 0.5, 0.18);
        dog.add(ear);
      }
      const dogTail = new THREE.Mesh(GEO.stem, dogMat);
      dogTail.scale.set(0.28, 0.35, 0.28);
      dogTail.position.set(0, 0.4, -0.32);
      dogTail.rotation.x = -1.0;
      dog.add(dogTail);
      dog.position.set(-1.9, 0, 0.4);
      dog.rotation.y = Math.PI / 3;
      return dog;
    };

    // The dancing-cat companion parked at every garden tree's foot — the
    // spoken-feature low-poly build (body, head, ears, tail), extracted
    // verbatim so the HD bodies attach the SAME cat the old bodies did. The
    // caller parks/rotates it; the frame loop's cat field dances it.
    const makeDancingCat = (): THREE.Group => {
      const cat = new THREE.Group();
      const catMat = new THREE.MeshPhongMaterial({ color: 0x6b5b4a, emissive: 0x6b5b4a, emissiveIntensity: 0.08 });
      const catBody = new THREE.Mesh(GEO.bud, catMat);
      catBody.scale.set(0.9, 1.2, 0.7);
      catBody.position.y = 0.24;
      catBody.userData.ownMaterial = true;
      cat.add(catBody);
      const catHead = new THREE.Mesh(GEO.bud, catMat);
      catHead.scale.setScalar(0.8);
      catHead.position.set(0, 0.5, 0.05);
      cat.add(catHead);
      for (const ex of [-0.09, 0.09]) {
        const ear = new THREE.Mesh(GEO.crystal, catMat);
        ear.scale.set(0.12, 0.16, 0.06);
        ear.position.set(ex, 0.62, 0.05);
        cat.add(ear);
      }
      const catTail = new THREE.Mesh(GEO.stem, catMat);
      catTail.scale.set(0.25, 0.4, 0.25);
      catTail.position.set(0, 0.32, -0.28);
      catTail.rotation.x = -0.7;
      cat.add(catTail);
      // The dancing dog rides WITH the cat: parented to the cat group so the
      // frame loop's cat sway carries it into the same dance.
      cat.add(makeDancingDog());
      return cat;
    };

    // The low-poly horse head companion parked opposite the cat (muzzle,
    // head, two pricked ears, neck) — same idiom, extracted verbatim.
    const makeHorseHead = (): THREE.Group => {
      const horse = new THREE.Group();
      const horseMat = new THREE.MeshPhongMaterial({ color: 0x8b6f47, emissive: 0x8b6f47, emissiveIntensity: 0.08 });
      const horseHead = new THREE.Mesh(GEO.bud, horseMat);
      horseHead.scale.set(0.9, 1.1, 0.8);
      horseHead.position.y = 0.55;
      horseHead.userData.ownMaterial = true;
      horse.add(horseHead);
      const horseMuzzle = new THREE.Mesh(GEO.bud, horseMat);
      horseMuzzle.scale.set(0.55, 0.55, 0.9);
      horseMuzzle.position.set(0, 0.42, 0.24);
      horse.add(horseMuzzle);
      for (const ex of [-0.08, 0.08]) {
        const ear = new THREE.Mesh(GEO.crystal, horseMat);
        ear.scale.set(0.1, 0.18, 0.06);
        ear.position.set(ex, 0.76, -0.02);
        horse.add(ear);
      }
      const horseNeck = new THREE.Mesh(GEO.stem, horseMat);
      horseNeck.scale.set(0.35, 0.6, 0.35);
      horseNeck.position.set(0, 0.2, -0.12);
      horseNeck.rotation.x = 0.5;
      horse.add(horseNeck);
      return horse;
    };

    // A ring of pink tulips planted around the base of every garden tree —
    // same GEO.* + own-material idiom as the cat/horse companions: a green
    // stem (GEO.stem) topped by a pink blossom cup (GEO.bud), evenly ringed
    // around the trunk foot at the given radius.
    const makePinkTulipRing = (radius: number): THREE.Group => {
      const ring = new THREE.Group();
      const stemMat = new THREE.MeshPhongMaterial({ color: 0x2f7d32, emissive: 0x123d14, emissiveIntensity: 0.1 });
      const bloomMat = new THREE.MeshPhongMaterial({ color: 0xff69b4, emissive: 0xff69b4, emissiveIntensity: 0.2 });
      const count = 10;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        const tulip = new THREE.Group();
        const stem = new THREE.Mesh(GEO.stem, stemMat);
        stem.scale.set(0.7, 0.7, 0.7);
        stem.position.y = 0.35;
        stem.userData.ownMaterial = true;
        tulip.add(stem);
        const bloom = new THREE.Mesh(GEO.bud, bloomMat);
        bloom.scale.set(0.7, 1.1, 0.7);
        bloom.position.y = 0.78;
        bloom.userData.ownMaterial = true;
        tulip.add(bloom);
        tulip.position.set(Math.cos(a) * radius, 0, Math.sin(a) * radius);
        ring.add(tulip);
      }
      return ring;
    };

    // "computing devices are being produced" — a cluster of freshly-built GPU
    // server racks parked at the tree's foot, blinking green as they come off
    // the line toward the theme's "one hundred times as many GPU factories".
    const makeGpuRackCluster = (radius: number): THREE.Group => {
      const cluster = new THREE.Group();
      const chassisGeo = new THREE.BoxGeometry(0.6, 1.1, 0.42);
      const ventGeo = new THREE.BoxGeometry(0.5, 0.07, 0.03);
      const lightGeo = new THREE.BoxGeometry(0.07, 0.07, 0.03);
      const chassisMat = new THREE.MeshPhongMaterial({ color: 0x2b3440, emissive: 0x0a0f14, emissiveIntensity: 0.15 });
      const ventMat = new THREE.MeshPhongMaterial({ color: 0x11161c });
      const lightMat = new THREE.MeshPhongMaterial({ color: 0x00ff88, emissive: 0x00ff88, emissiveIntensity: 0.8 });
      const count = 4;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + 0.35;
        const rack = new THREE.Group();
        const chassis = new THREE.Mesh(chassisGeo, chassisMat);
        chassis.position.y = 0.55;
        chassis.userData.ownMaterial = true;
        rack.add(chassis);
        for (let v = 0; v < 6; v++) {
          const vent = new THREE.Mesh(ventGeo, ventMat);
          vent.position.set(0, 0.25 + v * 0.15, 0.22);
          vent.userData.ownMaterial = true;
          rack.add(vent);
        }
        const light = new THREE.Mesh(lightGeo, lightMat);
        light.position.set(0.22, 0.98, 0.22);
        light.userData.ownMaterial = true;
        rack.add(light);
        rack.position.set(Math.cos(a) * radius, 0, Math.sin(a) * radius);
        rack.rotation.y = -a;
        cluster.add(rack);
      }
      return cluster;
    };

    // "crystal mana" — a ring of glowing cyan crystal shards floating at head
    // height around the tree's foot. Cheap octahedron meshes sharing one
    // geometry/material (flagged own* so the garden dispose traverse frees
    // them); the frame loop spins/bobs each shard via entry.mana.
    const makeCrystalManaCluster = (radius: number): { group: THREE.Group; shards: THREE.Mesh[] } => {
      const cluster = new THREE.Group();
      const shardGeo = new THREE.OctahedronGeometry(0.3, 0);
      const shardMat = new THREE.MeshPhongMaterial({
        color: 0x66e0ff,
        emissive: 0x33bbff,
        emissiveIntensity: 0.9,
        transparent: true,
        opacity: 0.82,
      });
      const shards: THREE.Mesh[] = [];
      const count = 6;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        const shard = new THREE.Mesh(shardGeo, shardMat);
        shard.userData.ownGeometry = i === 0;
        shard.userData.ownMaterial = i === 0;
        shard.position.set(Math.cos(a) * radius, 1.8 + (i % 2) * 0.6, Math.sin(a) * radius);
        cluster.add(shard);
        shards.push(shard);
      }
      return { group: cluster, shards };
    };

    const buildRealFlower = (spec: IdeaOrbSpec): Entry | null => {
      const ready = spec.status === "ready";
      const variants = floraLib?.get(ready ? "flower_gazania" : "dandelion_01");
      if (variants === undefined || variants.length === 0) {
        return null;
      }
      const color = ready ? MATURITY_COLOR[spec.maturity] : BUD_COLOR;
      const size = ready ? 0.9 + spec.confidence * 1.0 : 0.55 + spec.confidence * 0.45;
      const baseEmissive = ready ? 0.5 + spec.confidence * 0.3 : 0.2;
      const group = new THREE.Group();
      const mats: THREE.MeshStandardMaterial[] = [];
      // Deterministic variant per idea so cards don't reshuffle on updates.
      const variant = variants[Math.abs(ideaKey(spec).split("").reduce((h, ch) => h * 31 + ch.charCodeAt(0), 7)) % variants.length];
      const plant = new THREE.Group();
      for (const piece of variant.pieces) {
        const mesh = new THREE.Mesh(piece.geometry, piece.material);
        mesh.raycast = () => {};
        plant.add(mesh);
      }
      // The scans are ~0.2m plants; scale to data size (confidence).
      plant.scale.setScalar(size * 4.5);
      group.add(plant);
      // The idea's data color glows at the plant's heart + as a soft halo.
      const coreMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: baseEmissive, roughness: 0.4 });
      mats.push(coreMat);
      const core = new THREE.Mesh(GEO.flowerCenter, coreMat);
      core.scale.setScalar(size * 0.55);
      core.position.y = 0.4 * size;
      group.add(core);
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glowTexture, color, transparent: true, opacity: ready ? 0.4 : 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      halo.position.y = 0.45 * size;
      halo.scale.setScalar(1.9 * size);
      group.add(halo);
      if (ready && spec.verified) {
        const ring = new THREE.Mesh(
          GEO.ring,
          new THREE.MeshBasicMaterial({ color: VERIFIED_COLOR, transparent: true, opacity: 0.55 }),
        );
        ring.userData.ownMaterial = true;
        ring.scale.setScalar(size * 1.6);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.08;
        group.add(ring);
      }
      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(0.55, 0.5 * size), 8, 8),
        invisibleHitMat,
      );
      hit.position.y = 0.4 * size;
      hit.userData.ownGeometry = true;
      hit.userData.pick = { kind: "idea", key: ideaKey(spec) };
      group.add(hit);
      let label: THREE.Sprite | null = null;
      if (ready && spec.pitch.length > 0) {
        const statusLine = `${Math.round(spec.confidence * 100)}% · ${spec.maturity}${spec.verified ? " ✓" : ""}`;
        label = makeLabelSprite(spec.pitch, statusLine, cssHex(color));
        label.position.y = 1.1 * size + 0.45;
        group.add(label);
      }
      return { kind: "flower", ideaSpec: spec, group, mats, baseEmissive, head: null, headY: 0, cat: null, catBaseX: 0, label, targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: 0, flashStart: null, removing: false };
    };

    const buildFlower = (spec: IdeaOrbSpec): Entry => {
      const real = buildRealFlower(spec);
      if (real !== null) {
        return real;
      }
      const ready = spec.status === "ready";
      const color = ready ? MATURITY_COLOR[spec.maturity] : BUD_COLOR;
      const size = ready ? 0.9 + spec.confidence * 1.0 : 0.55 + spec.confidence * 0.45;
      const stemH = ready ? 1.0 + spec.confidence * 0.9 : 0.5 + spec.confidence * 0.3;
      const baseEmissive = ready ? 0.4 + spec.confidence * 0.3 : 0.12;
      const group = new THREE.Group();
      const mats: THREE.MeshPhongMaterial[] = [];

      const stem = new THREE.Mesh(GEO.stem, stemMat);
      stem.scale.set(size, stemH, size);
      stem.position.y = stemH / 2;
      group.add(stem);
      const head = new THREE.Group();
      head.position.y = stemH;
      group.add(head);

      if (ready) {
        const centerMat = new THREE.MeshPhongMaterial({ color: 0xffe08a, emissive: 0xffe08a, emissiveIntensity: 0.45 });
        mats.push(centerMat);
        const center = new THREE.Mesh(GEO.flowerCenter, centerMat);
        center.scale.setScalar(size);
        head.add(center);
        const petalMat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: baseEmissive });
        mats.push(petalMat);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          const petal = new THREE.Mesh(GEO.petal, petalMat);
          petal.position.set(Math.cos(a) * 0.2 * size, 0, Math.sin(a) * 0.2 * size);
          petal.scale.set(size, 0.45 * size, 1.5 * size);
          petal.rotation.y = -a;
          head.add(petal);
        }
        if (spec.verified) {
          const ring = new THREE.Mesh(
            GEO.ring,
            new THREE.MeshBasicMaterial({ color: VERIFIED_COLOR, transparent: true, opacity: 0.55 }),
          );
          ring.userData.ownMaterial = true;
          ring.scale.setScalar(size);
          ring.rotation.x = Math.PI * 0.45;
          head.add(ring);
        }
      } else {
        const budMat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: baseEmissive, transparent: true, opacity: 0.6 });
        mats.push(budMat);
        const bud = new THREE.Mesh(GEO.bud, budMat);
        bud.scale.set(size, size * 1.3, size);
        head.add(bud);
      }

      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(0.5, 0.45 * size), 8, 8),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.userData.ownGeometry = true;
      hit.userData.ownMaterial = true;
      hit.userData.pick = { kind: "idea", key: ideaKey(spec) };
      head.add(hit);

      let label: THREE.Sprite | null = null;
      if (ready && spec.pitch.length > 0) {
        const statusLine = `${Math.round(spec.confidence * 100)}% · ${spec.maturity}${spec.verified ? " ✓" : ""}`;
        label = makeLabelSprite(spec.pitch, statusLine, cssHex(color));
        label.position.y = stemH + 0.32 * size + 0.1;
        group.add(label);
      }
      return { kind: "flower", ideaSpec: spec, group, mats, baseEmissive, head, headY: stemH, cat: null, catBaseX: 0, label, targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: 0, flashStart: null, removing: false };
    };

    // EVERY garden fleet tree — adopted imports (salem) AND local concept/
    // commissioned trees — grows its BODY from the HD engine (buildTreeLOD),
    // shaped by its real data through the pure fleetTreeSpec3D mapping:
    // adopted trees stand full-grown in the self tree's trunk family with
    // their room/* branches as REAL engine branches (tip cards + glowing
    // buds via addBranchTipChrome), concepts stand as small young saplings,
    // and id-seeded determinism makes every tree an individual. The DATA
    // overlays (rings, arc, satellites, beacon, pip, glass label), the
    // ghostly issue-fruit bough, the coarse invisible hit sphere (engine
    // wood/foliage never raycasts — module policy) and the dancing-cat +
    // horse-head companions all ride on top exactly as before.
    const buildTree = (spec: TreeSpec): Entry => {
      const color = STATE_COLOR[spec.state];
      const ind = treeIndicators(spec);
      const grown = ind.grown;
      const bodyScale = grown ? 1 : SAPLING_LIMB_SCALE;
      const spec3d = fleetTreeSpec3D({ id: spec.upid, grown, treeRepo: spec.treeRepo });
      const trunkH = spec3d.trunk.height;
      const group = new THREE.Group();
      const built = buildTreeLOD(spec3d);
      group.add(built.group);
      const mats: THREE.MeshStandardMaterial[] = [];
      // Coarse trunk+canopy pick surface, fitted to the body the engine just
      // grew (the engine's merged wood/instanced foliage never raycast).
      addProcessHitVolumes(group, built.group, spec.callsign, spec3d.trunk);
      // State ring: the state-color channel (and the pulse/flash target).
      const ringMat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.55,
        transparent: true,
        opacity: 0.85,
        roughness: 0.5,
      });
      mats.push(ringMat);
      const stateRing = new THREE.Mesh(new THREE.TorusGeometry(grown ? 2.9 : 1.9, 0.09, 10, 64), ringMat);
      stateRing.userData.ownGeometry = true;
      stateRing.rotation.x = Math.PI / 2;
      stateRing.position.y = 0.1;
      group.add(stateRing);
      // Stage ring: the gold commission halo, or the brighter ring once built.
      addStageRing(group, ind.ring, 2.4, 0.06, Math.PI / 2);
      if (spec.steering) {
        // Steering target ring: a glowing ground halo around the tree so the
        // room sees where live transcript is routing.
        const steerRing = new THREE.Mesh(
          new THREE.TorusGeometry(2.1, 0.05, 8, 64),
          new THREE.MeshBasicMaterial({ color: STEERING_COLOR, transparent: true, opacity: 0.65 }),
        );
        steerRing.userData.ownGeometry = true;
        steerRing.userData.ownMaterial = true;
        steerRing.rotation.x = Math.PI / 2;
        steerRing.position.y = 0.14;
        group.add(steerRing);
      }
      // Live indicator overlays — progress arc, build-lane satellites, publish
      // beacon, failure pip — sized to the trunk the engine actually grew.
      const arcMesh = ind.progressArc !== null ? addProgressArc(group, ind.progressArc, 0.18, grown ? 2.6 : 1.6, 0.055) : null;
      addLaneSatellites(group, ind.lanes, trunkH * 0.72, grown ? 2.3 : 1.2, grown ? 0.95 : 0.65);
      if (ind.published) {
        addPublishedBeacon(group, trunkH + 0.9, grown ? 1.5 : 0.95);
      }
      if (ind.failed) {
        addFailedPip(group, grown ? 1.4 : 0.8, trunkH * 0.9, grown ? 0.9 : 0.65);
      }
      // Git substrate chrome: tip cards/buds on the engine-grown room/*
      // limbs, and the issue fruit on its ghostly holo bough attachment.
      addBranchTipChrome(group, spec, spec3d, bodyScale);
      addIssueFruit(group, spec, trunkH, bodyScale);
      const label = makeLabelSprite(treeTitle(spec), treeStatus(spec), cssHex(color));
      label.position.y = trunkH + 1.4;
      // Sprites raycast, so the name plate was a large DEAD target floating
      // over the canopy — clicking a tree's own name resolved to nothing and
      // closed the menu. It carries the tree's payload now.
      label.userData.pick = { kind: "process", callsign: spec.callsign };
      group.add(label);
      // Progress-only tick: repaint the label % and regrow the arc sweep in
      // place — no dispose, no rebuild (structural changes rebuild the entry).
      const updateProgress = (next: TreeSpec) => {
        const arc = treeIndicators(next).progressArc;
        if (arcMesh !== null && arc !== null) {
          setArcSweep(arcMesh, arc);
        }
        updateLabelStatus(label, treeStatus(next));
      };
      // The spoken-feature companions, unchanged: the dancing cat (frame loop
      // dances it via entry.cat/catBaseX) and the horse head opposite it.
      const catBase = grown ? 2.7 : 1.4;
      const cat = makeDancingCat();
      cat.position.set(catBase, 0, catBase * 0.35);
      cat.rotation.y = -Math.PI / 4;
      group.add(cat);
      const horse = makeHorseHead();
      horse.position.set(-catBase, 0, catBase * 0.35);
      horse.rotation.y = Math.PI / 4;
      group.add(horse);
      // Pink tulips ringed around the trunk's base — planted just outside the
      // state ring so the blooms read at the tree's foot.
      group.add(makePinkTulipRing(grown ? 3.3 : 2.3));
      // A cluster of freshly-manufactured GPU racks at the tree's foot.
      group.add(makeGpuRackCluster(grown ? 4.6 : 3.4));
      // Crystal mana floating around the tree — glowing cyan shards the frame
      // loop spins and bobs.
      const manaCluster = makeCrystalManaCluster(grown ? 3.6 : 2.6);
      group.add(manaCluster.group);
      return {
        kind: "tree", treeSpec: spec, group, mats, baseEmissive: 0.55, head: null, headY: 0, cat, catBaseX: catBase, mana: manaCluster.shards, label,
        targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: 0, flashStart: null, removing: false, updateProgress,
        // The engine owns the body's GPU resources; foliage sway rides the
        // shared frame loop through bodyUpdate.
        bodyUpdate: built.update,
        disposeExtra: () => built.dispose(),
      };
    };

    // ── the self-rebuild repo tree ──────────────────────────────────────────
    // The room's OWN repository as ONE MORE garden tree while 🔁 Self-Rebuild
    // is armed — grown by the HD tree module (the conversation tree's engine)
    // from the forest spec: every open PR is a branch and CI colors its tip
    // bud. The scene layers the standard garden chrome on top — the glass
    // label reads the live mirror process over the repo + PR count, each PR
    // tip carries its "#n title / CI word" card (the dialogue tree's exact tip
    // vocabulary), and invisible process-pick hit volumes make hover/click/
    // dwell behave exactly like a fleet tree. The entry ADOPTS the mirror's
    // live TreeSpec (`spec`, via selfTreeProcessSpec) and every pick payload
    // carries the mirror's callsign, so selecting the tree routes through the
    // same onSelectProcess handler into the mirror's detail + click-steer.
    let selfTreeBuilt: BuiltTree | null = null;
    const buildSelfTree = (input: SelfTreeSpec, spec: TreeSpec): Entry => {
      const group = new THREE.Group();
      const built = buildTreeLOD(input.spec);
      group.add(built.group);
      selfTreeBuilt = built;
      const trunkH = input.spec.trunk.height;
      // ONE pick surface for every HD tree: the same fitted trunk+canopy
      // volumes the garden trees get, so clicking the self tree's crown
      // selects it exactly like clicking any adopted tree's.
      addProcessHitVolumes(group, built.group, spec.callsign, input.spec.trunk);
      for (const branchSpec of input.spec.branches) {
        const tipSpec = branchSpec.tip;
        if (tipSpec === undefined || branchSpec.points.length === 0) {
          continue;
        }
        const tip = branchSpec.points[branchSpec.points.length - 1];
        // Every PR limb is its OWN pick target, keyed to the PR's real head
        // ref — the SAME branch contract addBranchTipChrome gives an adopted
        // tree's room/* limbs. A ref-less spec branch falls back to selecting
        // the whole tree, so a pick is never a dead end.
        const branchPick = selfBranchPick(branchSpec, spec.callsign);
        // The SUB-OBJECT: halo + PR card + tip hit in one group — its
        // projected box IS the popup anchor rect.
        const tipGroup = new THREE.Group();
        if (branchPick.kind === "branch") {
          tipGroup.userData.subTargetId = branchTargetId(spec.callsign, branchPick.branch);
        }
        tipGroup.userData.pick = branchPick;
        const tipGlow = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: glowTexture, color: tipSpec.color, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        tipGlow.position.set(tip.x, tip.y + 0.15, tip.z);
        tipGlow.scale.setScalar(1.3);
        tipGroup.add(tipGlow);
        // The PR readout rides the branch tip: "#n title" over the CI word,
        // accented in the tip's CI color (per-tip canvas map → ownMap).
        const tipLabel = makeLabelSprite(tipSpec.label ?? "", tipSpec.sub ?? "", cssHex(tipSpec.color));
        tipLabel.userData.ownMap = true;
        tipLabel.position.set(tip.x, tip.y + 0.25, tip.z);
        tipGroup.add(tipLabel);
        const tipHit = new THREE.Mesh(new THREE.SphereGeometry(1.0, 8, 8), invisibleHitMat);
        tipHit.userData.ownGeometry = true;
        tipHit.position.set(tip.x, tip.y + 0.3, tip.z);
        tipGroup.add(tipHit);
        group.add(tipGroup);
        // …and the wood below it, same contract as the fleet trees'.
        if (branchPick.kind === "branch") {
          addLimbSpineHits(group, branchSpec, branchPick);
        }
      }
      const chrome = selfTreeLabel(input, spec);
      const label = makeLabelSprite(chrome.title, chrome.sub, cssHex(SELF_TREE_ACCENT));
      label.position.y = trunkH + 1.3;
      // Same rule as the garden trees: the name plate is a pick target, not a
      // dead sprite that closes the menu.
      label.userData.pick = { kind: "process", callsign: spec.callsign };
      group.add(label);
      // Live-process chrome from the ADOPTED mirror spec: the stage ring says
      // concept/commissioned/built like any fleet tree, and the steering ring
      // marks the tree while spoken transcript routes to the mirror.
      addStageRing(group, treeIndicators(spec).ring, 2.4, 0.06, Math.PI / 2);
      if (spec.steering) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(2.1, 0.05, 8, 64),
          new THREE.MeshBasicMaterial({ color: STEERING_COLOR, transparent: true, opacity: 0.65 }),
        );
        ring.userData.ownGeometry = true;
        ring.userData.ownMaterial = true;
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.08;
        group.add(ring);
      }
      // Crystal mana floating around the self tree, same as the fleet trees.
      const manaCluster = makeCrystalManaCluster(3.6);
      group.add(manaCluster.group);
      // The adopted spec keys the shared machinery (hover on callsign, dwell
      // entryForTargetId, activation) to the MIRROR, first-class. mats stays
      // empty — the module owns its materials — so the frame loop's
      // active-pulse (mats[0]) skips this entry even in "active" state.
      return {
        kind: "tree", treeSpec: spec, group, mats: [], baseEmissive: 0, head: null, headY: 0, cat: null, catBaseX: 0, mana: manaCluster.shards, label,
        targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: 0, flashStart: null, removing: false,
        disposeExtra: () => {
          built.dispose();
          if (selfTreeBuilt === built) {
            selfTreeBuilt = null;
          }
        },
      };
    };

    // ── orbit builders ──────────────────────────────────────────────────────
    const buildOrbIdea = (spec: IdeaOrbSpec): Entry => {
      const ready = spec.status === "ready";
      const color = ready ? MATURITY_COLOR[spec.maturity] : BUD_COLOR;
      const radius = ready ? 0.8 + spec.confidence * 0.7 : 0.4 + spec.confidence * 0.3;
      const baseEmissive = ready ? 0.55 + spec.confidence * 0.5 : 0.16;
      const group = new THREE.Group();
      const orbMat = new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.12, transparent: true, opacity: ready ? 0.96 : 0.38 });
      orbMat.color.set(color).multiplyScalar(0.55);
      orbMat.emissive.set(color);
      orbMat.emissiveIntensity = baseEmissive;
      const orb = new THREE.Mesh(GEO.orb, orbMat);
      orb.scale.setScalar(radius);
      orb.userData.pick = { kind: "idea", key: ideaKey(spec) };
      group.add(orb);
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glowTexture, color, transparent: true, opacity: ready ? 0.5 : 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      halo.scale.setScalar(radius * 3.4);
      group.add(halo);
      if (ready && spec.verified) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(radius * 1.35, 0.02, 8, 64),
          new THREE.MeshBasicMaterial({ color: VERIFIED_COLOR, transparent: true, opacity: 0.5 }),
        );
        ring.userData.ownGeometry = true;
        ring.userData.ownMaterial = true;
        ring.rotation.x = Math.PI * 0.42;
        group.add(ring);
      }
      let label: THREE.Sprite | null = null;
      if (ready && spec.pitch.length > 0) {
        const statusLine = `${Math.round(spec.confidence * 100)}% · ${spec.maturity}${spec.verified ? " ✓" : ""}`;
        label = makeLabelSprite(spec.pitch, statusLine, cssHex(color));
        label.position.y = radius + 0.25;
        group.add(label);
      }
      return { kind: "orb-idea", ideaSpec: spec, group, mats: [orbMat], baseEmissive, head: null, headY: 0, cat: null, catBaseX: 0, label, targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: 0, flashStart: null, removing: false };
    };

    // Orb radius grows with a run's progress; kept in one place so the build
    // and the in-place progress updater derive the exact same size.
    const orbProcessRadius = (progress: number) => 1.15 + Math.min(Math.max(progress, 0), 100) / 100 * 0.65;

    const buildOrbProcess = (spec: TreeSpec): Entry => {
      const color = STATE_COLOR[spec.state];
      const ind = treeIndicators(spec);
      const radius = orbProcessRadius(spec.progress);
      const tilt = Math.PI * 0.42;
      const group = new THREE.Group();
      // Everything radius-derived (orb, halo, rings, arc, satellites, beacon,
      // pip) lives in `body` so a progress tick grows the orb IN PLACE via one
      // body rescale — only the label stays on the group for exact reposition.
      const body = new THREE.Group();
      group.add(body);
      const orbMat = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.15, transparent: true, opacity: 0.94 });
      orbMat.color.set(color).multiplyScalar(0.5);
      orbMat.emissive.set(color);
      orbMat.emissiveIntensity = 0.5;
      const orb = new THREE.Mesh(GEO.orb, orbMat);
      orb.scale.setScalar(radius);
      orb.userData.pick = { kind: "process", callsign: spec.callsign };
      body.add(orb);
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glowTexture, color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      halo.scale.setScalar(radius * 3.2);
      body.add(halo);
      // Stage ring (commission gold / built completion) in the orbs' tilted plane.
      addStageRing(body, ind.ring, radius * 1.7, 0, tilt);
      if (spec.steering) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(radius * 1.5, 0.03, 8, 64),
          new THREE.MeshBasicMaterial({ color: STEERING_COLOR, transparent: true, opacity: 0.6 }),
        );
        ring.userData.ownGeometry = true;
        ring.userData.ownMaterial = true;
        ring.rotation.x = tilt;
        body.add(ring);
      }
      // Live progress arc, build-lane satellites, take-home beacon, failure pip.
      const arcMesh = ind.progressArc !== null ? addProgressArc(body, ind.progressArc, 0, radius * 1.9, 0.035, tilt) : null;
      addLaneSatellites(body, ind.lanes, 0, radius * 1.35, 1.0);
      if (ind.published) {
        addPublishedBeacon(body, radius + 1.0, radius * 1.3);
      }
      if (ind.failed) {
        addFailedPip(body, radius * 1.05, radius * 0.85, 1.0);
      }
      const label = makeLabelSprite(treeTitle(spec), treeStatus(spec), cssHex(color));
      label.position.y = radius + 0.25;
      group.add(label);
      // Progress-only tick: grow the whole body by ratio (near-everything here
      // is radius-proportional; any residual drift is exact again at the next
      // structural rebuild), lift the label, regrow the arc sweep, repaint %.
      const updateProgress = (next: TreeSpec) => {
        const nextRadius = orbProcessRadius(next.progress);
        body.scale.setScalar(nextRadius / radius);
        label.position.y = nextRadius + 0.25;
        const arc = treeIndicators(next).progressArc;
        if (arcMesh !== null && arc !== null) {
          setArcSweep(arcMesh, arc);
        }
        updateLabelStatus(label, treeStatus(next));
      };
      return { kind: "orb-proc", treeSpec: spec, group, mats: [orbMat], baseEmissive: 0.5, head: null, headY: 0, cat: null, catBaseX: 0, label, targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: 0, flashStart: null, removing: false, updateProgress };
    };

    // ── layout ──────────────────────────────────────────────────────────────
    // Compact garden-styled nodes for the hyperbolic layouts (after the
    // visualizer's createH3GardenNode): a foliage cluster with a crowning
    // bloom for builds, a stemless 5-petal flower (or bud) for ideas.
    const buildFloraProcess = (spec: TreeSpec): Entry => {
      const color = STATE_COLOR[spec.state];
      const ind = treeIndicators(spec);
      const tilt = Math.PI * 0.42;
      const group = new THREE.Group();
      const folMat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.22 });
      const fol = new THREE.Mesh(GEO.foliageSide, folMat);
      fol.scale.setScalar(1.15);
      fol.userData.pick = { kind: "process", callsign: spec.callsign };
      group.add(fol);
      const bloom = new THREE.Mesh(
        GEO.flowerCenter,
        new THREE.MeshPhongMaterial({ color: 0xffe08a, emissive: 0xffe08a, emissiveIntensity: 0.4 }),
      );
      bloom.userData.ownMaterial = true;
      bloom.position.y = 0.95;
      // A grown build's crowning bloom is visibly larger + brighter.
      bloom.scale.setScalar(ind.grown ? 2.1 : 1.5);
      bloom.userData.pick = { kind: "process", callsign: spec.callsign };
      group.add(bloom);
      // Hyperbolic flora reuses the garden indicator vocabulary (tilted plane).
      addStageRing(group, ind.ring, 1.7, 0, tilt);
      if (spec.steering) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(1.5, 0.03, 8, 64),
          new THREE.MeshBasicMaterial({ color: STEERING_COLOR, transparent: true, opacity: 0.6 }),
        );
        ring.userData.ownGeometry = true;
        ring.userData.ownMaterial = true;
        ring.rotation.x = tilt;
        group.add(ring);
      }
      const arcMesh = ind.progressArc !== null ? addProgressArc(group, ind.progressArc, 0, 1.4, 0.03, tilt) : null;
      addLaneSatellites(group, ind.lanes, 0.95, 0.9, 0.5);
      if (ind.published) {
        addPublishedBeacon(group, 1.75, 0.8);
      }
      if (ind.failed) {
        addFailedPip(group, 0.8, 0.95, 0.5);
      }
      const label = makeLabelSprite(treeTitle(spec), treeStatus(spec), cssHex(color));
      label.position.y = 1.35;
      group.add(label);
      // Progress-only tick: repaint the label % and regrow the arc sweep in
      // place — no dispose, no rebuild (structural changes rebuild the entry).
      const updateProgress = (next: TreeSpec) => {
        const arc = treeIndicators(next).progressArc;
        if (arcMesh !== null && arc !== null) {
          setArcSweep(arcMesh, arc);
        }
        updateLabelStatus(label, treeStatus(next));
      };
      return { kind: "tree", treeSpec: spec, group, mats: [folMat], baseEmissive: 0.22, head: null, headY: 0, cat: null, catBaseX: 0, label, targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: 0, flashStart: null, removing: false, updateProgress };
    };

    const buildFloraIdea = (spec: IdeaOrbSpec): Entry => {
      const ready = spec.status === "ready";
      const color = ready ? MATURITY_COLOR[spec.maturity] : BUD_COLOR;
      const size = ready ? 0.95 + spec.confidence * 0.8 : 0.55 + spec.confidence * 0.4;
      const baseEmissive = ready ? 0.4 + spec.confidence * 0.3 : 0.12;
      const group = new THREE.Group();
      const head = new THREE.Group();
      group.add(head);
      const mats: THREE.MeshPhongMaterial[] = [];
      if (ready) {
        const centerMat = new THREE.MeshPhongMaterial({ color: 0xffe08a, emissive: 0xffe08a, emissiveIntensity: 0.45 });
        mats.push(centerMat);
        const center = new THREE.Mesh(GEO.flowerCenter, centerMat);
        center.scale.setScalar(size);
        head.add(center);
        const petalMat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: baseEmissive });
        mats.push(petalMat);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          const petal = new THREE.Mesh(GEO.petal, petalMat);
          petal.position.set(Math.cos(a) * 0.2 * size, 0, Math.sin(a) * 0.2 * size);
          petal.scale.set(size, 0.45 * size, 1.5 * size);
          petal.rotation.y = -a;
          head.add(petal);
        }
        if (spec.verified) {
          const ring = new THREE.Mesh(
            GEO.ring,
            new THREE.MeshBasicMaterial({ color: VERIFIED_COLOR, transparent: true, opacity: 0.55 }),
          );
          ring.userData.ownMaterial = true;
          ring.scale.setScalar(size);
          ring.rotation.x = Math.PI * 0.45;
          head.add(ring);
        }
      } else {
        const budMat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: baseEmissive, transparent: true, opacity: 0.6 });
        mats.push(budMat);
        const bud = new THREE.Mesh(GEO.bud, budMat);
        bud.scale.set(size, size * 1.3, size);
        head.add(bud);
      }
      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(0.55, 0.5 * size), 8, 8),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.userData.ownGeometry = true;
      hit.userData.ownMaterial = true;
      hit.userData.pick = { kind: "idea", key: ideaKey(spec) };
      head.add(hit);
      let label: THREE.Sprite | null = null;
      if (ready && spec.pitch.length > 0) {
        const statusLine = `${Math.round(spec.confidence * 100)}% · ${spec.maturity}${spec.verified ? " ✓" : ""}`;
        label = makeLabelSprite(spec.pitch, statusLine, cssHex(color));
        label.position.y = 0.42 * size + 0.15;
        group.add(label);
      }
      return { kind: "flower", ideaSpec: spec, group, mats, baseEmissive, head, headY: 0, cat: null, catBaseX: 0, label, targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: 0, flashStart: null, removing: false };
    };

    // ── research-sky builders ───────────────────────────────────────────────
    // Regrow a cloud entry's deterministic puff lobes (packed
    // [ox,oy,oz,size,shade,rot] per lobe): a flat-ish BASE row of large lobes
    // with smaller cauliflower lobes stacked above — the cumulus silhouette.
    // Seeded by cloud id, so a cloud keeps its exact shape until more is said.
    // rot varies the sprite stamp per lobe (no visible repeat-stamping).
    const genCloudPuffs = (entry: Entry, cloud: ResolvedCloud) => {
      const count = puffCount(cloud.turnCount);
      const radius = puffRadius(cloud.turnCount);
      const rng = mulberry32(hashSeed(`cloud:${cloud.id}`));
      const data = entry.cloudPuffs ?? new Float32Array(SKY_MAX_PUFFS_PER_CLOUD * 6);
      // Sculpted cumulus: one broad CORE mass, a flat BASE row of large lobes,
      // then smaller cauliflower CROWN lobes tapering toward the top — a flat
      // underside with billowed heights, recognizable in a still screenshot.
      const baseLobes = Math.max(3, Math.round(count * 0.45));
      for (let index = 0; index < count; index += 1) {
        const j = index * 6;
        if (index === 0) {
          // The core mass everything else billows out of.
          data[j] = 0;
          data[j + 1] = 0.26 * radius;
          data[j + 2] = 0;
          data[j + 3] = 1.08 * radius;
          data[j + 4] = 0.55;
          data[j + 5] = rng() * Math.PI * 2;
          continue;
        }
        const angle = rng() * Math.PI * 2;
        if (index <= baseLobes) {
          // Base row: wide, hugging y≈0 (the flat cloud bottom).
          const reach = (0.3 + 0.48 * rng()) * radius;
          data[j] = Math.cos(angle) * reach;
          data[j + 1] = (0.02 + 0.08 * rng()) * radius;
          data[j + 2] = Math.sin(angle) * reach * 0.62;
          data[j + 3] = (0.66 + 0.24 * rng()) * radius;
        } else {
          // Crown: the higher a lobe sits, the nearer the centre and the
          // smaller it billows (the cauliflower taper).
          const heightN = 0.35 + 0.55 * rng();
          const reach = (1.05 - heightN) * (0.55 + 0.3 * rng()) * radius;
          data[j] = Math.cos(angle) * reach;
          data[j + 1] = heightN * 0.95 * radius;
          data[j + 2] = Math.sin(angle) * reach * 0.62;
          data[j + 3] = (0.62 - 0.28 * heightN + 0.12 * rng()) * radius;
        }
        // Shade follows height: dark undersides, moonlit crowns.
        data[j + 4] = Math.max(0, Math.min(1, data[j + 1] / (0.9 * radius) + 0.12));
        // Stamp rotation: every lobe samples the billow canvas differently.
        data[j + 5] = rng() * Math.PI * 2;
      }
      entry.cloudPuffs = data;
      entry.cloudPuffN = count;
      // The body ramp is mixed per relayout tick (dormant → active white);
      // the speaker tint stays a ≤12% nudge so the sky reads composed.
      entry.cloudTint = rawColor(speakerColor(cloud.dominantSpeaker));
      entry.cloudColor = entry.cloudColor ?? new THREE.Color();
      entry.cloudColor.copy(CLOUD_DORMANT_RGB);
      // The invisible hit ellipsoid tracks the cloud's grown size.
      entry.cloudHit?.scale.set(radius * 1.25, radius * 0.75 + 0.5, radius * 1.25);
    };

    // One cloud: an invisible hit ellipsoid (live clouds pick as their topic's
    // FRESHEST utterance — the branch-tip precedent, so click/dwell researches
    // the topic through the existing dialogue path) + a lazy label. The
    // visible body is the shared puff Points buffer.
    const buildCloudEntry = (cloud: ResolvedCloud): Entry => {
      const group = new THREE.Group();
      const hit = new THREE.Mesh(GEO.hitShell, invisibleHitMat);
      if (cloud.freshestTurnId !== null) {
        hit.userData.pick = { kind: "dialogue", key: cloud.freshestTurnId };
      }
      group.add(hit);
      const entry: Entry = { kind: "cloud", cloudSpec: cloud, group, mats: [], baseEmissive: 0, head: null, headY: 0, cat: null, catBaseX: 0, label: null, targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: (hashSeed(cloud.id) % 628) / 100, flashStart: null, removing: false };
      entry.cloudHit = hit;
      genCloudPuffs(entry, cloud);
      return entry;
    };

    // The cloud's name card (topic label / agent condensation). PERSISTENT —
    // one chip per cloud, the glance-readability contract: which topics the
    // room holds must survive a 2-second look from under the projector.
    // EXACTLY ONE chip carries the green NOW accent (the single freshest
    // active cloud); every other card stays cool cyan — no second hue fights
    // for "current". Agent condensations mark the TITLE (✦) instead of
    // stealing an accent; wisp warmth stays the provenance surface. Rebuilt
    // only when the accent tier flips (status ticks repaint in place).
    const ensureCloudLabel = (entry: Entry, cloud: ResolvedCloud, statusLine: string, active: boolean) => {
      const accent = active ? CLOUD_NOW_ACCENT : 0x9ee2ff;
      if (entry.label !== null && entry.label.userData.accent === accent) {
        return;
      }
      if (entry.label !== null) {
        entry.group.remove(entry.label);
        entry.label.material.map?.dispose();
        entry.label.material.dispose();
        entry.label = null;
      }
      const title = cloud.labelSource === "agent" ? `✦ ${cloud.label}` : cloud.label;
      const label = makeLabelSprite(title, statusLine, cssHex(accent));
      // Cloud chips sit far (the under-deck vista is ~35-60 units out), so
      // they scale up to the tree-card read size — and the frame loop
      // distance-normalizes them so every card reads the SAME size on screen.
      label.scale.multiplyScalar(2.2);
      label.userData.baseSX = label.scale.x;
      label.userData.baseSY = label.scale.y;
      // The card OVERLAPS its own crown silhouette (bottom edge sunk into the
      // upper body) — the pill visibly belongs to ITS cloud, never floats.
      label.position.y = puffRadius(cloud.turnCount) * 0.55 + 0.3;
      label.userData.accent = accent;
      entry.label = label;
      entry.group.add(label);
    };

    // One research quest: an invisible hit sphere riding under its cloud (the
    // rain streaks render from the shared buffer) plus a droplet glow once the
    // dossier is ready. Pick payload stays {kind:"research"} — the existing
    // accept/deck plumbing is untouched.
    const buildRainEntry = (spec: ResearchNodeSpec): Entry => {
      const color = RESEARCH_STATUS_COLOR[spec.status];
      const group = new THREE.Group();
      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(1.3, 8, 8),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.userData.ownGeometry = true;
      hit.userData.ownMaterial = true;
      hit.userData.pick = { kind: "research", key: spec.id };
      group.add(hit);
      // The droplet: a small glow at the streak head — bright mint when the
      // dossier is open-able, dim red when the research failed.
      if (spec.status === "complete" || spec.status === "failed") {
        const droplet = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: glowTexture, color, transparent: true, opacity: spec.status === "complete" ? 0.7 : 0.25, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        droplet.scale.setScalar(spec.status === "complete" ? 1.6 : 1.0);
        group.add(droplet);
      }
      return { kind: "research", researchSpec: spec, group, mats: [], baseEmissive: 0, head: null, headY: 0, cat: null, catBaseX: 0, label: null, targetPos: new THREE.Vector3(), targetScale: 1, scaleMult: 1, phase: (hashSeed(spec.id) % 628) / 100, flashStart: null, removing: false };
    };

    // Boundary/context cues per layout: the Poincaré ball's wireframe horizon,
    // or the disk's rim + inner context circles.
    let layoutDecor: THREE.Object3D[] = [];
    const clearLayoutDecor = () => {
      for (const obj of layoutDecor) {
        scene.remove(obj);
        obj.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.geometry.dispose();
            (Array.isArray(node.material) ? node.material : [node.material]).forEach((m) => m.dispose());
          }
        });
      }
      layoutDecor = [];
    };
    const diskY = () => (modeRef.current === "garden" ? 0.05 : 2.6);
    const buildLayoutDecor = () => {
      clearLayoutDecor();
      if (layoutRef.current === "ball") {
        const boundary = new THREE.Mesh(
          new THREE.SphereGeometry(BALL_RADIUS, 24, 16),
          new THREE.MeshBasicMaterial({ color: 0x335577, wireframe: true, transparent: true, opacity: 0.08 }),
        );
        boundary.position.set(0, BALL_CENTER_Y, 0);
        scene.add(boundary);
        layoutDecor.push(boundary);
      } else if (layoutRef.current === "disk") {
        const y = diskY();
        const rim = new THREE.Mesh(
          new THREE.TorusGeometry(DISK_RADIUS, 0.025, 8, 96),
          new THREE.MeshBasicMaterial({ color: 0x4d7ba6, transparent: true, opacity: 0.4 }),
        );
        rim.rotation.x = Math.PI / 2;
        rim.position.y = y;
        scene.add(rim);
        layoutDecor.push(rim);
        for (const rNorm of [DISK_R_PROC, DISK_R_READY]) {
          const circle = new THREE.Mesh(
            new THREE.TorusGeometry(DISK_RADIUS * rNorm, 0.012, 6, 72),
            new THREE.MeshBasicMaterial({ color: 0x4d7ba6, transparent: true, opacity: 0.12 }),
          );
          circle.rotation.x = Math.PI / 2;
          circle.position.y = y;
          scene.add(circle);
          layoutDecor.push(circle);
        }
      }
    };

    const centeredSlot = (index: number): number => {
      const ring = (index + 1) >> 1;
      return index % 2 === 1 ? -ring : ring;
    };
    const treePosition = (index: number, count: number, garden: boolean): { pos: THREE.Vector3; k: number } => {
      if (layoutRef.current === "ball") {
        const dir = fibSphereDir(index, count);
        return {
          pos: dir.clone().multiplyScalar(BALL_SHELL_PROC * BALL_RADIUS).add(new THREE.Vector3(0, BALL_CENTER_Y, 0)),
          k: poincareScale(BALL_SHELL_PROC),
        };
      }
      if (layoutRef.current === "disk") {
        const angle = (index / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2;
        const r = DISK_R_PROC * DISK_RADIUS;
        return { pos: new THREE.Vector3(Math.cos(angle) * r, diskY(), Math.sin(angle) * r), k: poincareScale(DISK_R_PROC) };
      }
      const slot = centeredSlot(index);
      const y = garden ? 0 : 3.1 + (Math.abs(slot) % 2) * 0.9;
      // 13-unit slots (live-room request, twice: space the trees out MORE) with a deeper
      // alternating z stagger so neighboring canopies never read as one mass.
      return { pos: new THREE.Vector3(slot * 13, y, -3.2 - (Math.abs(slot) % 2) * 3.4), k: 1 };
    };
    const flowerPosition = (
      index: number,
      count: number,
      ready: boolean,
      garden: boolean,
    ): { pos: THREE.Vector3; k: number } => {
      if (layoutRef.current === "ball") {
        const shell = ready ? BALL_SHELL_READY : BALL_SHELL_FORMING;
        // Rotate the idea shell off the process shell so nodes never eclipse.
        const dir = fibSphereDir(index, count).applyAxisAngle(new THREE.Vector3(0, 1, 0), 1.1);
        return {
          pos: dir.multiplyScalar(shell * BALL_RADIUS).add(new THREE.Vector3(0, BALL_CENTER_Y, 0)),
          k: poincareScale(shell),
        };
      }
      if (layoutRef.current === "disk") {
        const rNorm = ready ? DISK_R_READY : DISK_R_FORMING;
        const angle = index * GOLDEN_ANGLE + 0.7;
        const r = rNorm * DISK_RADIUS;
        return { pos: new THREE.Vector3(Math.cos(angle) * r, diskY(), Math.sin(angle) * r), k: poincareScale(rNorm) };
      }
      const slot = centeredSlot(index);
      const z = 3.6 + (Math.abs(slot) % 2) * 1.2;
      const y = garden ? 0 : 1.3 + (Math.abs(slot) % 2) * 0.8;
      return { pos: new THREE.Vector3(slot * 2.9, y, z), k: 1 };
    };

    const ideaSpecChanged = (a: IdeaOrbSpec, b: IdeaOrbSpec) =>
      a.status !== b.status || a.maturity !== b.maturity || a.verified !== b.verified ||
      a.pitch !== b.pitch || Math.abs(a.confidence - b.confidence) > 0.005;
    // Rain rebuilds only on a STATUS/topic move (the droplet + hit chrome
    // change); progress rides the streak animation, not a rebuild.
    const researchSpecChanged = (a: ResearchNodeSpec, b: ResearchNodeSpec) =>
      a.status !== b.status || a.topic !== b.topic || a.kind !== b.kind;

    // Trees split changes in two: STRUCTURAL (treeSpecStructurallyChanged →
    // dispose+rebuild) vs a bare progress tick (→ the entry's in-place
    // updateProgress). Progress churns constantly on live builds, so it must
    // never trigger the rebuild path.

    let env: SceneEnv | null = null;
    let builtMode: SceneMode | null = null;
    let builtKey: string | null = null;

    const reconcile = () => {
      const garden = modeRef.current === "garden";
      const hyper = layoutRef.current !== "radial";
      const key = `${modeRef.current}|${layoutRef.current}`;
      if (builtKey !== key) {
        // Style/layout switch: tear the world down and regrow it.
        env?.dispose();
        env = garden ? buildGardenEnv() : buildOrbitEnv();
        for (const entry of ideaEntries.values()) {
          disposeEntry(entry);
        }
        ideaEntries.clear();
        for (const entry of treeEntries.values()) {
          disposeEntry(entry);
        }
        treeEntries.clear();
        for (const entry of cloudEntries.values()) {
          disposeEntry(entry);
        }
        cloudEntries.clear();
        freshTurnToCloud.clear();
        for (const entry of researchEntries.values()) {
          disposeEntry(entry);
        }
        researchEntries.clear();
        clearSkyRig();
        buildLayoutDecor();
        builtMode = modeRef.current;
        builtKey = key;
        resetRig();
      }

      // Resolve the conversation sky FIRST (used below, and it gates the idle
      // placeholder): a window holding clouds is the research ceiling — no
      // stray "forming" flower floating in its dusk.
      const nowMs = Date.now();
      const clouds = resolveClouds(topicsRef.current, skyRef.current, dialogueRef.current);
      const skyActive = clouds.length > 0;

      // PER-WALL CONTRACT: the 3D scene reconciles the FULL data set — all
      // ideas AND all builds — on every window regardless of ?view=. Walls
      // differ by camera vantage (wallYawSeed), never by scene content; only
      // the 2D HUD surfaces are view-scoped (see App.tsx).
      const ideaSpecs: IdeaOrbSpec[] =
        ideasRef.current.length > 0
          ? ideasRef.current
          : skyActive
            ? []
            : [{ id: "__idle__", pitch: "", confidence: 0.25, status: "forming", maturity: "forming", verified: false }];
      // The HD self-repo tree stands in the garden's radial layout only —
      // resolving it HERE (null everywhere else) lets visibleTreeSpecs skip
      // the mirror's fleet tree exactly when the HD tree replaces it, and
      // keep it whenever the HD tree is absent (never zero representations
      // of the live SELF process).
      const selfInput = garden && !hyper ? selfTreeRef.current : null;
      const treeSpecs = visibleTreeSpecs(treesRef.current, selfInput !== null);

      const seenIdeas = new Set<string>();
      ideaSpecs.forEach((spec, index) => {
        const specId = ideaKey(spec);
        seenIdeas.add(specId);
        const existing = ideaEntries.get(specId);
        const placed = flowerPosition(index, ideaSpecs.length, spec.status === "ready", garden);
        const labelLift = hyper ? 0 : (Math.abs(centeredSlot(index)) % 2) * 0.55;
        const create = () => {
          const entry = hyper
            ? garden
              ? buildFloraIdea(spec)
              : buildOrbIdea(spec)
            : garden
              ? buildFlower(spec)
              : buildOrbIdea(spec);
          entry.label?.position.setY(entry.label.position.y + labelLift);
          entry.targetPos = placed.pos;
          entry.scaleMult = placed.k;
          entry.phase = index * 1.9;
          entry.group.position.copy(placed.pos);
          entry.group.scale.setScalar(0.01);
          ideaEntries.set(specId, entry);
          scene.add(entry.group);
          return entry;
        };
        if (existing === undefined) {
          const entry = create();
          if (spec.status === "ready") {
            entry.flashStart = performance.now();
          }
        } else if (existing.ideaSpec !== undefined && ideaSpecChanged(existing.ideaSpec, spec)) {
          const promoted = existing.ideaSpec.status === "forming" && spec.status === "ready";
          const nowVerified = !existing.ideaSpec.verified && spec.verified;
          const keepPos = existing.group.position.clone();
          const keepScale = existing.group.scale.x;
          const keepPhase = existing.phase;
          disposeEntry(existing);
          const entry = create();
          entry.phase = keepPhase;
          entry.group.position.copy(keepPos);
          entry.group.scale.setScalar(Math.max(keepScale, 0.01));
          if (promoted || nowVerified) {
            entry.flashStart = performance.now();
          }
        } else {
          existing.targetPos = placed.pos;
          existing.scaleMult = placed.k;
          existing.removing = false;
          existing.targetScale = 1;
        }
      });
      for (const [specId, entry] of ideaEntries) {
        if (!seenIdeas.has(specId)) {
          entry.removing = true;
          entry.targetScale = 0;
        }
      }

      const seenTrees = new Set<string>();
      treeSpecs.forEach((spec, index) => {
        seenTrees.add(spec.upid);
        const existing = treeEntries.get(spec.upid);
        const placed = treePosition(index, treeSpecs.length, garden);
        const scale = !hyper && garden ? 0.62 + Math.min(Math.max(spec.progress, 0), 100) / 100 * 0.33 : 1;
        const create = () => {
          const entry = hyper
            ? garden
              ? buildFloraProcess(spec)
              : buildOrbProcess(spec)
            : garden
              ? buildTree(spec)
              : buildOrbProcess(spec);
          entry.targetPos = placed.pos;
          entry.targetScale = scale;
          entry.scaleMult = placed.k;
          entry.phase = index * 1.3;
          entry.group.position.copy(placed.pos);
          entry.group.scale.setScalar(0.01);
          treeEntries.set(spec.upid, entry);
          scene.add(entry.group);
          return entry;
        };
        if (existing === undefined) {
          create();
        } else if (existing.treeSpec !== undefined && treeSpecStructurallyChanged(existing.treeSpec, spec)) {
          // Concept → grown (commissioned/built) is THE transformation moment:
          // flash the regrown (now full-size) tree so the room sees it happen.
          const wasGrown = existing.treeSpec.stage === "commissioned" || existing.treeSpec.stage === "built";
          const nowGrown = spec.stage === "commissioned" || spec.stage === "built";
          const promoted = !wasGrown && nowGrown;
          const keepPos = existing.group.position.clone();
          const keepScale = existing.group.scale.x;
          const keepPhase = existing.phase;
          disposeEntry(existing);
          const entry = create();
          entry.phase = keepPhase;
          entry.group.position.copy(keepPos);
          entry.group.scale.setScalar(Math.max(keepScale, 0.01));
          if (promoted) {
            entry.flashStart = performance.now();
          }
        } else {
          // Not structural — at most the progress ticked. Refresh the derived
          // visuals IN PLACE (same rounded-percent granularity the old rebuild
          // path keyed on) and keep the spec current so the next comparison
          // and the in-place gate see fresh values.
          if (existing.treeSpec !== undefined && Math.round(existing.treeSpec.progress) !== Math.round(spec.progress)) {
            existing.updateProgress?.(spec);
          }
          existing.treeSpec = spec;
          existing.targetPos = placed.pos;
          existing.targetScale = scale;
          existing.scaleMult = placed.k;
          existing.removing = false;
        }
      });

      // ── the room's OWN repo as ONE MORE garden tree (self-rebuild armed) ──
      // Not a panel: while App feeds selfTree (toggle armed on a wall window),
      // the repo stands in the NEXT radial slot after the fleet, grown by the
      // HD tree engine with the standard garden chrome (see buildSelfTree) —
      // and it IS the mirror process's node: the fleet sweep above already
      // skipped the upid-"self" spec (visibleTreeSpecs), and the entry adopts
      // the mirror's live TreeSpec so picking/hover/steering route to it.
      // Keyed by the stable SELF_TREE_UPID in treeEntries so picking, hover
      // grow/glow, the dwell seam, fit bounds and the removal fade all reuse
      // the fleet-tree machinery untouched. Rebuilds are gated on the forest
      // payload's treeSpecSignature (a re-fetched but unchanged payload is a
      // no-op) OR a structural change in the adopted mirror spec (steering
      // flipping, state/stage moves — the rings and label must repaint);
      // garden-radial only — orbit and the hyperbolic layouts simply omit it
      // (selfInput resolves null above), and the sweep below fades it out
      // whenever it stops being fed.
      if (selfInput !== null) {
        seenTrees.add(SELF_TREE_UPID);
        const placed = treePosition(treeSpecs.length, treeSpecs.length + 1, garden);
        const sig = treeSpecSignature(selfInput.spec);
        const selfSpec = selfTreeProcessSpec(selfInput, treesRef.current);
        const existing = treeEntries.get(SELF_TREE_UPID);
        if (
          existing === undefined ||
          existing.selfSig !== sig ||
          existing.treeSpec === undefined ||
          treeSpecStructurallyChanged(existing.treeSpec, selfSpec)
        ) {
          const keepPos = existing?.group.position.clone();
          const keepScale = existing?.group.scale.x;
          if (existing !== undefined) {
            disposeEntry(existing);
          }
          const entry = buildSelfTree(selfInput, selfSpec);
          entry.selfSig = sig;
          entry.targetPos = placed.pos;
          entry.targetScale = SELF_TREE_SCALE;
          entry.scaleMult = placed.k;
          entry.phase = treeSpecs.length * 1.3;
          entry.group.position.copy(keepPos ?? placed.pos);
          entry.group.scale.setScalar(Math.max(keepScale ?? 0.01, 0.01));
          treeEntries.set(SELF_TREE_UPID, entry);
          scene.add(entry.group);
        } else {
          // Non-structural drift (progress ticks): keep the adopted mirror
          // spec current so the next comparison sees fresh values.
          existing.treeSpec = selfSpec;
          existing.targetPos = placed.pos;
          existing.targetScale = SELF_TREE_SCALE;
          existing.scaleMult = placed.k;
          existing.removing = false;
        }
      }

      for (const [specId, entry] of treeEntries) {
        if (!seenTrees.has(specId)) {
          entry.removing = true;
          entry.targetScale = 0;
        }
      }

      // ── the conversation SKY ────────────────────────────────────────────
      // One cloud per concept topic on the polar time fan (overhead = now,
      // horizon = the past), wisps between related clouds (provenance-
      // colored), research quests as RAIN. Prefers the server's beyond-the-
      // window `sky`; falls back to dialogueTopics when it is absent (no
      // wisps then — the fallback invents no relations). Zero cost when the
      // research props are empty — nothing mounts, the classic scene is
      // untouched. (`clouds` resolved above, before the idea sweep.)
      if (skyActive) {
        ensureSkyRig();
      }
      // The ceiling is its own dusk world: the daylight garden (meadow,
      // butterflies, sunny panorama) hides wholesale while the sky stands.
      if (env !== null && skyRig !== null) {
        env.group.visible = false;
      }
      const cloudIds = new Set(clouds.map((cloud) => cloud.id));
      skyWisps = selectWisps(skyRef.current?.links ?? [], cloudIds);
      const agentLinked = new Set<string>();
      for (const link of skyWisps) {
        if (link.source === "agent") {
          agentLinked.add(link.a);
          agentLinked.add(link.b);
        }
      }
      // HONESTY FLICKER: agentAtMs ADVANCED = the relate thread actually
      // applied an update — the agent-linked clouds answer with ~1.2s of
      // internal lightning. The lexical fallback never stamps, so the sky
      // never flickers on invented relations.
      const agentAt = skyRef.current?.agentAtMs ?? null;
      if (agentAt !== null && agentAt !== skyAgentAtMs && skyAgentAtMs !== null) {
        skyFlashUntil = performance.now() + 1200;
      }
      skyAgentAtMs = agentAt;
      freshTurnToCloud.clear();
      // Bearings: hash-stable inside the visible fan, gravitated ≤25% toward
      // the strongest partner, then relaxed apart (spreadAzimuths) so the
      // vista reads balanced — clouds never clump into one corner of frame.
      const rawBearings = clouds.map((cloud) => {
        const partner = strongestPartner(cloud.id, skyWisps);
        let az = fanAzimuth(cloud.id, skyFanCenter);
        if (partner !== null) {
          az = gravitatedAzimuth(az, fanAzimuth(partner.id, skyFanCenter), partner.strength);
        }
        return { id: cloud.id, az };
      });
      // Near-uniform spread: bodies cap at puffRadius 6, so pushing bearings
      // toward even spacing keeps every silhouette separate (label→cloud
      // binding depends on it), while ≥14 clouds still honor ~10° minimum.
      const minSep = Math.min(0.8, ((SKY_FAN_HALF * 2) / Math.max(clouds.length - 1, 1)) * 0.9);
      const bearings = spreadAzimuths(rawBearings, skyFanCenter, minSep);
      const seenClouds = new Set<string>();
      for (const cloud of clouds) {
        seenClouds.add(cloud.id);
        // TIME IS THE LAYOUT: radius + altitude follow the age log law (fresh
        // = lifted overhead near the core, old = sunk to the horizon rim);
        // the bearing stays hash-anchored — clouds never orbit randomly.
        const age = cloudAge(nowMs, cloud.freshAtMs);
        const azimuth = bearings.get(cloud.id) ?? fanAzimuth(cloud.id, skyFanCenter);
        const radius = staggeredRadius(cloud.id, age);
        const norm = radiusNorm(age);
        const altJitter = ((hashSeed(`alt:${cloud.id}`) % 1000) / 1000 - 0.5) * 1.4;
        let entry = cloudEntries.get(cloud.id);
        if (entry === undefined) {
          entry = buildCloudEntry(cloud);
          entry.targetPos.set(Math.sin(azimuth) * radius, cloudAltitude(norm, altJitter), Math.cos(azimuth) * radius);
          // Clouds CONDENSE: scale in from nothing at their own spot.
          entry.group.position.copy(entry.targetPos);
          entry.group.scale.setScalar(0.01);
          cloudEntries.set(cloud.id, entry);
          scene.add(entry.group);
        } else {
          const prior = entry.cloudSpec;
          entry.targetPos.set(Math.sin(azimuth) * radius, cloudAltitude(norm, altJitter), Math.cos(azimuth) * radius);
          entry.removing = false;
          entry.targetScale = 1;
          // More said → the cloud regrows its lobes; a rename (agent
          // condensation or topic relabel) drops the card so the next show
          // repaints it.
          if (prior !== undefined && (prior.turnCount !== cloud.turnCount || prior.dominantSpeaker !== cloud.dominantSpeaker)) {
            genCloudPuffs(entry, cloud);
          }
          if (prior !== undefined && prior.label !== cloud.label && entry.label !== null) {
            entry.group.remove(entry.label);
            entry.label.material.map?.dispose();
            entry.label.material.dispose();
            entry.label = null;
          }
          entry.cloudSpec = cloud;
          // The pick identity follows the freshest utterance; a memory cloud
          // (nothing live left) honestly exposes no pick at all.
          if (entry.cloudHit !== undefined) {
            entry.cloudHit.userData.pick =
              cloud.freshestTurnId !== null ? { kind: "dialogue", key: cloud.freshestTurnId } : undefined;
          }
        }
        entry.cloudNorm = norm;
        entry.cloudLife = lifeFactor(age);
        entry.cloudJitter = altJitter;
        entry.cloudHasAgentLink = agentLinked.has(cloud.id);
        if (cloud.freshestTurnId !== null) {
          freshTurnToCloud.set(cloud.freshestTurnId, cloud.id);
        }
      }
      for (const [cloudId, entry] of cloudEntries) {
        if (seenClouds.has(cloudId) || entry.removing) {
          continue;
        }
        // MERGE choreography: a vanished cloud glides into whichever cloud
        // absorbed its members (mergeTarget — real re-assignments, never
        // invented), else it fades where it stands. The survivor flashes.
        const survivorId = mergeTarget(cloudId, prevCloudMembers.get(cloudId) ?? [], dialogueRef.current, clouds);
        const survivor = survivorId !== null ? cloudEntries.get(survivorId) : undefined;
        if (survivor !== undefined) {
          entry.targetPos.copy(survivor.targetPos);
          survivor.flashStart = performance.now();
        }
        entry.removing = true;
        entry.targetScale = 0;
      }
      // Refresh the merge evidence for next time (live membership only).
      prevCloudMembers.clear();
      for (const cloud of clouds) {
        if (cloud.liveTopicId === null) {
          continue;
        }
        const topic = topicsRef.current.find((candidate) => candidate.id === cloud.liveTopicId);
        if (topic !== undefined) {
          prevCloudMembers.set(cloud.id, topic.turnIds);
        }
      }

      // RAIN: one entry per research quest, hanging under its cloud (the
      // zenith core when the grounding turn's cloud is unknown). Siblings fan
      // out so every quest stays separately pointable.
      const researchSpecs = researchRef.current;
      const seenResearch = new Set<string>();
      const rainSiblings = new Map<string, number>();
      for (const spec of researchSpecs) {
        seenResearch.add(spec.id);
        const cloudId = questCloudId(spec.turnId, dialogueRef.current, clouds);
        const anchor = cloudId !== null ? cloudEntries.get(cloudId) : undefined;
        const sibling = rainSiblings.get(cloudId ?? "@zenith") ?? 0;
        rainSiblings.set(cloudId ?? "@zenith", sibling + 1);
        const fan = (hashSeed(`rain:${spec.id}`) % 628) / 100;
        // Streaks stay CONFINED under their cloud's footprint (a detached
        // tick reads as a glitch): lateral spread scales with the cloud's own
        // radius. Orphans (turn gone, cloud unknown) hang at the inner deck.
        const anchorSpread =
          anchor?.cloudSpec !== undefined ? puffRadius(anchor.cloudSpec.turnCount) * (0.28 + 0.18 * sibling) : 0.8 + sibling * 0.5;
        const placed =
          anchor !== undefined
            ? new THREE.Vector3(
                anchor.targetPos.x + Math.cos(fan) * anchorSpread,
                anchor.targetPos.y - 0.9,
                anchor.targetPos.z + Math.sin(fan) * anchorSpread,
              )
            : new THREE.Vector3(
                Math.sin(skyFanCenter) * 4 + Math.cos(fan) * 1.8,
                SKY_ALT + 1.2 - sibling * 0.6,
                Math.cos(skyFanCenter) * 4 + Math.sin(fan) * 1.8,
              );
        // Shower footprint: streaks spread under the parent cloud's own base
        // (orphans get a tight zenith drizzle).
        const spread =
          anchor?.cloudSpec !== undefined ? Math.max(1.2, puffRadius(anchor.cloudSpec.turnCount) * 0.55) : 1.2;
        const existing = researchEntries.get(spec.id);
        if (existing === undefined || (existing.researchSpec !== undefined && researchSpecChanged(existing.researchSpec, spec))) {
          // Completing is THE payoff moment: the finished rain flashes.
          const finished =
            existing?.researchSpec !== undefined && existing.researchSpec.status !== "complete" && spec.status === "complete";
          const keepPos = existing?.group.position.clone();
          const keepScale = existing?.group.scale.x;
          if (existing !== undefined) {
            disposeEntry(existing);
          }
          const entry = buildRainEntry(spec);
          entry.targetPos.copy(placed);
          entry.rainSpread = spread;
          entry.group.position.copy(keepPos ?? placed);
          entry.group.scale.setScalar(Math.max(keepScale ?? 0.01, 0.01));
          researchEntries.set(spec.id, entry);
          scene.add(entry.group);
          if (finished || (existing === undefined && spec.status === "proposed")) {
            entry.flashStart = performance.now();
          }
        } else {
          existing.researchSpec = spec;
          existing.targetPos.copy(placed);
          existing.rainSpread = spread;
          existing.removing = false;
          existing.targetScale = 1;
        }
      }
      for (const [specId, entry] of researchEntries) {
        if (!seenResearch.has(specId)) {
          entry.removing = true;
          entry.targetScale = 0;
        }
      }

      // Fresh membership ⇒ fresh back-to-front lobe order for the normal-
      // blended cumulus bodies (re-sorted again on the 1s relayout tick).
      rebuildSkyLobeOrder(camera.position);

      // Prober stamps: the sky's structural counts (data-labeled-clouds and
      // data-draw-calls ride the 1s tick in the frame loop).
      container.dataset.cloudCount = String(clouds.length);
      container.dataset.wispCount = String(skyWisps.length);
      container.dataset.rainCount = String(Math.min(researchSpecs.length, SKY_MAX_RAIN_QUESTS));

    };

    // ── fit to content (visualizer's fitToScreen, adapted to the orbit rig) ─
    // The one-shot F/fitSignal fit and the continuous auto-fit poll share ONE
    // framing computation over the same bounds: every live entry's target
    // position — ideas, build trees, sky CLOUDS and research rain alike (the
    // cloud disc is bounded at R_HORIZON, so the auto-refit hysteresis
    // converges instead of chasing an ever-growing hull). Scratch objects are
    // hoisted and reused: the ~0.75s auto-fit poll must not allocate.
    const fitBox = new THREE.Box3();
    const fitCenter = new THREE.Vector3();
    const fitSize = new THREE.Vector3();
    const fitExpand = (entries: Map<string, Entry>): boolean => {
      let any = false;
      for (const entry of entries.values()) {
        if (!entry.removing) {
          fitBox.expandByPoint(entry.targetPos);
          any = true;
        }
      }
      return any;
    };
    // Ideal fit framing → out; FALSE when the scene is empty (caller decides:
    // one-shot fit resets the rig, the auto-fit poll just waits).
    const computeFitTargets = (out: { targetX: number; targetZ: number; radius: number; height: number }): boolean => {
      fitBox.makeEmpty();
      let hasContent = fitExpand(ideaEntries);
      hasContent = fitExpand(treeEntries) || hasContent;
      hasContent = fitExpand(cloudEntries) || hasContent;
      hasContent = fitExpand(researchEntries) || hasContent;
      if (!hasContent) {
        return false;
      }
      fitBox.getCenter(fitCenter);
      fitBox.getSize(fitSize);
      const spread = Math.max(fitSize.x, fitSize.z, 6);
      out.targetX = fitCenter.x;
      out.targetZ = fitCenter.z;
      out.radius = Math.min(40, spread * 0.85 + 7);
      out.height = Math.min(26, out.radius * 0.34 + 2);
      return true;
    };
    const fitIdeal = { targetX: 0, targetZ: 0, radius: 0, height: 0 };
    const applyFitTargets = () => {
      rig.dTargetX = fitIdeal.targetX;
      rig.dTargetZ = fitIdeal.targetZ;
      rig.dRadius = fitIdeal.radius;
      rig.dHeight = fitIdeal.height;
    };
    const fitToContent = () => {
      if (skyViewRef.current) {
        // The sky vista IS the composition (an under-deck upward pitch over a
        // bounded disc): any bbox re-frame would put the camera back outside
        // and above, flattening the ceiling into a horizon band. A fit
        // request simply restores the boot pose.
        rig.dHeight = 1.8;
        rig.dRadius = 34;
        rig.lookY = SKY_ALT - 3;
        rig.dTargetX = 0;
        rig.dTargetZ = 0;
        return;
      }
      if (!computeFitTargets(fitIdeal)) {
        resetRig();
        return;
      }
      applyFitTargets();
    };

    // ── pointer: orbit / pan / zoom / click-with-drag-suppression ───────────
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hoveredIdea: string | null = null;
    let hoveredProc: string | null = null;
    let hoveredResearch: string | null = null;
    let hoveredTurn: string | null = null;
    // Limb-tip / fruit hover (adopted trees): cursor affordance only — the
    // glow chrome is built into the sub-objects themselves.
    let hoveredSub = false;
    let dragging = false;
    let panning = false;
    let dragMoved = 0;
    let lastX = 0;
    let lastY = 0;
    // Flick inertia: velocities sampled during the drag keep the camera
    // gliding after release, decaying exponentially.
    let angVel = 0;
    let heightVel = 0;
    let lastMoveAt = 0;
    // True while the pinch-camera layer holds a live grab: the rig tracks
    // tightly (like a mouse drag) and flick inertia stays out of the way.
    let externalGrab = false;
    // CONTINUOUS AUTO-FRAMING bookkeeping (desk rig only): every manual
    // camera input (pointer, wheel, WASD holds, pinch/joystick seam calls)
    // stamps its time here and the poll stays suspended until
    // AUTO_FIT_RESUME_MS after the last stamp. Seeded in the past so a fresh
    // window is eligible immediately; the current-framing scratch keeps the
    // poll allocation-free.
    // skyView windows opt OUT of continuous auto-framing: the under-deck
    // vista is a fixed composition over a bounded disc (R_HORIZON), and the
    // bbox framing would pitch the camera back down into a horizon band.
    const autoFitOn = autoFitRef.current && !cornerLockRef.current && !flatLockRef.current && !skyViewRef.current;
    let lastCameraInputMs = -AUTO_FIT_RESUME_MS;
    let lastAutoFitPollMs = 0;
    const autoFitCurrent = { targetX: 0, targetZ: 0, radius: 0 };
    // The sky's 1s relayout cadence (age drift + label arbitration + stamps).
    let skyLastRelayoutMs = 0;

    // How many payload-bearing intersections one pick considers before the
    // precedence rule runs: deep enough to see a sub-target standing behind
    // its own trunk volume, shallow enough to stay allocation-cheap.
    const PICK_PAYLOAD_CAP = 32;
    const pick = (clientX: number, clientY: number): ScenePickPayload | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return null;
      }
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const targets: THREE.Object3D[] = [];
      for (const entry of ideaEntries.values()) {
        if (!entry.removing) {
          targets.push(entry.group);
        }
      }
      for (const entry of treeEntries.values()) {
        if (!entry.removing) {
          targets.push(entry.group);
        }
      }
      for (const entry of researchEntries.values()) {
        if (!entry.removing) {
          targets.push(entry.group);
        }
      }
      for (const entry of cloudEntries.values()) {
        // Cloud hit ellipsoids pick as their topic's freshest turn
        // ({kind:"dialogue"}); memory clouds carry no payload and fall through.
        if (!entry.removing) {
          targets.push(entry.group);
        }
      }
      // A tree's coarse CANOPY volume encloses its own limbs and fruit, so
      // "the first payload the ray crossed wins" made every sub-target
      // unreachable (the live-room report: "the whole tree seems to have one
      // hitbox"). Collect the payloads in distance order — bounded, so a
      // canopy of hit volumes never walks the whole scene — and let the pure
      // precedence rule decide (resolveScenePick, tree-limbs.ts).
      const payloads: ScenePickPayload[] = [];
      for (const hit of raycaster.intersectObjects(targets, true)) {
        let node: THREE.Object3D | null = hit.object;
        while (node !== null) {
          if (node.userData.pick !== undefined) {
            payloads.push(node.userData.pick as ScenePickPayload);
            break;
          }
          node = node.parent;
        }
        if (payloads.length >= PICK_PAYLOAD_CAP) {
          break;
        }
      }
      return resolveScenePick(payloads);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      dragging = true;
      panning = event.shiftKey;
      dragMoved = 0;
      lastX = event.clientX;
      lastY = event.clientY;
      angVel = 0;
      heightVel = 0;
      lastMoveAt = performance.now();
      lastCameraInputMs = lastMoveAt; // manual input — suspend auto-framing
      // Keep the drag alive even when the pointer crosses a floating panel.
      renderer.domElement.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (dragging) {
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        dragMoved += Math.abs(dx) + Math.abs(dy);
        lastX = event.clientX;
        lastY = event.clientY;
        const nowMs = performance.now();
        const dtMove = Math.max((nowMs - lastMoveAt) / 1000, 0.001);
        lastMoveAt = nowMs;
        if (panning || event.shiftKey) {
          panning = true;
          const panSpeed = 0.0045 * rig.radius;
          rig.dTargetX -= Math.cos(rig.angle) * dx * panSpeed;
          rig.dTargetZ += Math.sin(rig.angle) * dx * panSpeed;
          rig.dTargetX -= Math.sin(rig.angle) * dy * panSpeed;
          rig.dTargetZ -= Math.cos(rig.angle) * dy * panSpeed;
        } else {
          const dAngle = -dx * 0.005;
          const dHeight = dy * 0.045;
          rig.dAngle += dAngle;
          rig.dHeight = Math.max(1.4, Math.min(30, rig.dHeight + dHeight));
          // Exponential moving average keeps the flick velocity stable.
          angVel = angVel * 0.75 + (dAngle / dtMove) * 0.25;
          heightVel = heightVel * 0.75 + (dHeight / dtMove) * 0.25;
        }
        return;
      }
      const picked = pick(event.clientX, event.clientY);
      hoveredIdea = null;
      hoveredProc = null;
      hoveredResearch = null;
      hoveredTurn = null;
      hoveredSub = false;
      if (picked?.kind === "idea" && picked.key !== undefined && picked.key !== "__idle__") {
        const entry = ideaEntries.get(picked.key);
        if (entry?.ideaSpec?.status === "ready") {
          hoveredIdea = picked.key;
        }
      } else if (picked?.kind === "process" && picked.callsign !== undefined) {
        hoveredProc = picked.callsign;
      } else if (picked?.kind === "branch" || picked?.kind === "issue") {
        hoveredSub = true;
      } else if (picked?.kind === "research" && picked.key !== undefined) {
        const entry = researchEntries.get(picked.key);
        const status = entry?.researchSpec?.status;
        if (status === "proposed" || status === "complete") {
          hoveredResearch = picked.key;
        }
      } else if (picked?.kind === "dialogue" && picked.key !== undefined) {
        hoveredTurn = picked.key;
      }
      renderer.domElement.style.cursor =
        hoveredIdea !== null || hoveredProc !== null || hoveredResearch !== null || hoveredTurn !== null || hoveredSub
          ? "pointer"
          : dragging
            ? "grabbing"
            : "grab";
    };
    const onPointerUp = (event: PointerEvent) => {
      const wasDrag = dragMoved > 6;
      dragging = false;
      panning = false;
      if (wasDrag || event.button !== 0) {
        return;
      }
      const picked = pick(event.clientX, event.clientY);
      if (picked?.kind === "idea" && picked.key !== undefined && picked.key !== "__idle__") {
        const entry = ideaEntries.get(picked.key);
        if (entry?.ideaSpec?.status === "ready") {
          onAcceptRef.current(entry.ideaSpec.id);
        }
      } else if (picked?.kind === "process" && picked.callsign !== undefined) {
        // The anchor is the tree's screen-projected rect (same projection the
        // dwell layer targets), so the App's menu can open beside the tree.
        onSelectRef.current(picked.callsign, dwellRectFor(`${SCENE_PROC_PREFIX}${picked.callsign}`));
      } else if (picked?.kind === "branch" && picked.callsign !== undefined && picked.branch !== undefined) {
        // Limb-tip pick: the anchor is the LIMB TIP's own projected rect (the
        // sub-object), so the branch popup opens beside the limb.
        onPickBranchRef.current?.(picked.callsign, picked.branch, dwellRectFor(branchTargetId(picked.callsign, picked.branch)));
      } else if (picked?.kind === "issue" && picked.callsign !== undefined && picked.number !== undefined) {
        // Fruit pick: same sub-object anchor contract for the issue popup.
        onPickIssueRef.current?.(picked.callsign, picked.number, dwellRectFor(issueTargetId(picked.callsign, picked.number)));
      } else if (picked?.kind === "research" && picked.key !== undefined) {
        onResearchRef.current?.(picked.key);
      } else if (picked?.kind === "dialogue" && picked.key !== undefined) {
        onDialogueRef.current?.(picked.key);
      } else if (picked === null) {
        // Empty ground: a deliberate click on nothing closes the tree menu.
        onPickMissRef.current?.();
      }
    };
    const onPointerLeave = () => {
      dragging = false;
      panning = false;
      hoveredIdea = null;
      hoveredProc = null;
      hoveredResearch = null;
      hoveredTurn = null;
      hoveredSub = false;
      renderer.domElement.style.cursor = "grab";
    };
    // WASD fly-through: W/S walk the orbit target along the camera's ground
    // forward, A/D strafe. Held keys apply per-frame in the animate loop (the
    // d* desired-rig fields, so pinch/fusion writers still interleave
    // latest-writer-wins). Shifted keys pass through untouched — Shift+A is
    // the app-level Auto-Build toggle.
    const keysDown = new Set<string>();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }
      const key = event.key.toLowerCase();
      if (key === "w" || key === "a" || key === "s" || key === "d") {
        keysDown.add(key);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      keysDown.delete(event.key.toLowerCase());
    };
    // Focus loss strands keydowns without their keyups — never keep walking.
    const onWindowBlur = () => {
      keysDown.clear();
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      lastCameraInputMs = performance.now(); // manual input — suspend auto-framing
      rig.dRadius = Math.max(4, Math.min(45, rig.dRadius + event.deltaY * 0.02));
    };
    // GESTURE-DWELL SEAM: expose real raycast picking + projected node rects +
    // click-equivalent activation to the gesture layer, so pointing a hand at a
    // node highlights it and a completed dwell fires the exact click semantics
    // (ready idea → build, process → steer/deck) — without any pointer events.
    const SCENE_IDEA_PREFIX = "scene:idea:";
    // Shared with the App's tree-menu anchor refresh — one namespace, no drift.
    const SCENE_PROC_PREFIX = SCENE_PROC_TARGET_PREFIX;
    const SCENE_RESEARCH_PREFIX = "scene:research:";
    const SCENE_TURN_PREFIX = "scene:turn:";
    let dwellHighlights: ReadonlySet<string> = new Set();
    const sceneTargetIdOf = (
      picked: { kind: string; key?: string; callsign?: string; branch?: string; number?: number } | null,
    ): string | null => {
      if (picked?.kind === "idea" && picked.key !== undefined && picked.key !== "__idle__") {
        const entry = ideaEntries.get(picked.key);
        if (entry?.ideaSpec?.status === "ready" && !entry.removing) {
          return `${SCENE_IDEA_PREFIX}${picked.key}`;
        }
      } else if (picked?.kind === "process" && picked.callsign !== undefined) {
        return `${SCENE_PROC_PREFIX}${picked.callsign}`;
      } else if (picked?.kind === "branch" && picked.callsign !== undefined && picked.branch !== undefined) {
        // Limb tips and fruit are first-class dwell targets: their target id
        // resolves to the SUB-OBJECT's own projected rect below.
        return branchTargetId(picked.callsign, picked.branch);
      } else if (picked?.kind === "issue" && picked.callsign !== undefined && picked.number !== undefined) {
        return issueTargetId(picked.callsign, picked.number);
      } else if (picked?.kind === "research" && picked.key !== undefined) {
        const entry = researchEntries.get(picked.key);
        const status = entry?.researchSpec?.status;
        if ((status === "proposed" || status === "complete") && entry !== undefined && !entry.removing) {
          return `${SCENE_RESEARCH_PREFIX}${picked.key}`;
        }
      } else if (picked?.kind === "dialogue" && picked.key !== undefined) {
        // A turn pick is a CLOUD pick (the cloud's hit ellipsoid carries its
        // topic's freshest turn id) — resolve through the fresh-turn index.
        const cloudId = freshTurnToCloud.get(picked.key);
        const entry = cloudId !== undefined ? cloudEntries.get(cloudId) : undefined;
        if (entry !== undefined && !entry.removing) {
          return `${SCENE_TURN_PREFIX}${picked.key}`;
        }
      }
      return null;
    };
    const entryForTargetId = (id: string): Entry | null => {
      if (id.startsWith(SCENE_IDEA_PREFIX)) {
        return ideaEntries.get(id.slice(SCENE_IDEA_PREFIX.length)) ?? null;
      }
      if (id.startsWith(SCENE_RESEARCH_PREFIX)) {
        return researchEntries.get(id.slice(SCENE_RESEARCH_PREFIX.length)) ?? null;
      }
      if (id.startsWith(SCENE_TURN_PREFIX)) {
        const cloudId = freshTurnToCloud.get(id.slice(SCENE_TURN_PREFIX.length));
        return cloudId !== undefined ? cloudEntries.get(cloudId) ?? null : null;
      }
      if (id.startsWith(SCENE_PROC_PREFIX)) {
        const callsign = id.slice(SCENE_PROC_PREFIX.length);
        for (const entry of treeEntries.values()) {
          if (entry.treeSpec?.callsign === callsign) {
            return entry;
          }
        }
      }
      return null;
    };
    const dwellBox = new THREE.Box3();
    const dwellCorner = new THREE.Vector3();
    // Limb-tip/fruit SUB-OBJECT lookup: the tip/fruit groups carry their
    // target id in userData.subTargetId — found by traversal at lookup time
    // (bounded: only live tree entries, only on pick/rect queries).
    const findSubTarget = (id: string): THREE.Object3D | null => {
      for (const entry of treeEntries.values()) {
        if (entry.removing) {
          continue;
        }
        let found: THREE.Object3D | null = null;
        entry.group.traverse((node) => {
          if (found === null && node.userData.subTargetId === id) {
            found = node;
          }
        });
        if (found !== null) {
          return found;
        }
      }
      return null;
    };
    const dwellRectFor = (id: string): SceneDwellRect | null => {
      // Sub-object targets (limb tips, fruit) project THEIR OWN box — the
      // popup anchors beside the limb/fruit, never the whole-tree bbox.
      let target: THREE.Object3D | null;
      if (id.startsWith(SCENE_BRANCH_PREFIX) || id.startsWith(SCENE_ISSUE_PREFIX)) {
        target = findSubTarget(id);
      } else {
        const entry = entryForTargetId(id);
        target = entry === null || entry.removing ? null : entry.group;
      }
      if (target === null) {
        return null;
      }
      const domRect = renderer.domElement.getBoundingClientRect();
      if (domRect.width === 0 || domRect.height === 0) {
        return null;
      }
      dwellBox.setFromObject(target);
      if (dwellBox.isEmpty()) {
        return null;
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < 8; i += 1) {
        dwellCorner.set(
          (i & 1) === 0 ? dwellBox.min.x : dwellBox.max.x,
          (i & 2) === 0 ? dwellBox.min.y : dwellBox.max.y,
          (i & 4) === 0 ? dwellBox.min.z : dwellBox.max.z,
        );
        dwellCorner.project(camera);
        if (dwellCorner.z > 1) {
          continue; // behind the camera
        }
        const sx = domRect.left + ((dwellCorner.x + 1) / 2) * domRect.width;
        const sy = domRect.top + ((1 - dwellCorner.y) / 2) * domRect.height;
        minX = Math.min(minX, sx);
        minY = Math.min(minY, sy);
        maxX = Math.max(maxX, sx);
        maxY = Math.max(maxY, sy);
      }
      if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) {
        return null;
      }
      return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
    };
    const unregisterDwellSource = registerSceneDwellSource({
      pick: (clientX, clientY) => sceneTargetIdOf(pick(clientX, clientY)),
      rectFor: dwellRectFor,
      activate: (id) => {
        // Sub-object targets (limb tips, fruit) dispatch to the popup
        // callbacks with the SUB-OBJECT's projected rect as anchor — the
        // click path's exact contract.
        if (id.startsWith(SCENE_BRANCH_PREFIX) || id.startsWith(SCENE_ISSUE_PREFIX)) {
          const node = findSubTarget(id);
          const payload = node?.userData.pick as
            | { kind: string; callsign?: string; branch?: string; number?: number }
            | undefined;
          if (payload === undefined) {
            return;
          }
          if (payload.kind === "branch" && payload.callsign !== undefined && payload.branch !== undefined) {
            onPickBranchRef.current?.(payload.callsign, payload.branch, dwellRectFor(id));
          } else if (payload.kind === "issue" && payload.callsign !== undefined && payload.number !== undefined) {
            onPickIssueRef.current?.(payload.callsign, payload.number, dwellRectFor(id));
          }
          return;
        }
        const entry = entryForTargetId(id);
        if (entry === null || entry.removing) {
          return;
        }
        if (id.startsWith(SCENE_IDEA_PREFIX) && entry.ideaSpec !== undefined && entry.ideaSpec.status === "ready") {
          onAcceptRef.current(entry.ideaSpec.id);
        } else if (id.startsWith(SCENE_RESEARCH_PREFIX) && entry.researchSpec !== undefined) {
          onResearchRef.current?.(entry.researchSpec.id);
        } else if (id.startsWith(SCENE_TURN_PREFIX) && entry.kind === "cloud") {
          // The dwelled cloud researches its freshest utterance (the turn id
          // IS the target id's key — same contract as the click path).
          onDialogueRef.current?.(id.slice(SCENE_TURN_PREFIX.length));
        } else if (id.startsWith(SCENE_PROC_PREFIX) && entry.treeSpec !== undefined) {
          // Dwell activation: same anchor contract as the click path.
          onSelectRef.current(entry.treeSpec.callsign, dwellRectFor(id));
        }
      },
      setHighlights: (ids) => {
        dwellHighlights = ids;
      },
    });
    // PINCH-CAMERA SEAM: the hand-pinch layer drives the SAME desired-rig d*
    // fields as the mouse, so writers interleave latest-writer-wins (fit /
    // focus / resetRig may also write d*; external input keeps writing and
    // wins). The scene owns the rig and ALL clamps — the layer never touches
    // three.js and cannot push the rig outside the mouse's envelope.
    const unregisterCameraControl = registerSceneCameraControl({
      // Every seam verb is manual camera input (pinch camera, guest joystick
      // keys, …): stamp it so the continuous auto-framing stays suspended
      // while someone is orbiting and for AUTO_FIT_RESUME_MS after.
      orbitBy: (dYaw, dHeight) => {
        lastCameraInputMs = performance.now();
        if (flatLocked) {
          // Shared flat pair: orbit the whole panorama about the scene
          // centre. Deterministic per the hands stream — see the flat-rig
          // comment — so every window lands on the same pose.
          flatRig.yaw += dYaw;
          flatRig.height = Math.max(1.4, Math.min(30, flatRig.height + dHeight));
          flatPoseDirty = true; // local input — publish to the partner window
          return;
        }
        // Exact mirror of the onPointerMove orbit path (incl. height clamp).
        rig.dAngle += dYaw;
        rig.dHeight = Math.max(1.4, Math.min(30, rig.dHeight + dHeight));
      },
      panBy: (dxPx, dyPx) => {
        lastCameraInputMs = performance.now();
        if (flatLocked) {
          // Panning would slide the pair off its seam-centred origin — the
          // panorama stays anchored; orbit/zoom are the flat-pair verbs.
          return;
        }
        // Exact mirror of the onPointerMove shift-pan path.
        const panSpeed = 0.0045 * rig.radius;
        rig.dTargetX -= Math.cos(rig.angle) * dxPx * panSpeed;
        rig.dTargetZ += Math.sin(rig.angle) * dxPx * panSpeed;
        rig.dTargetX -= Math.sin(rig.angle) * dyPx * panSpeed;
        rig.dTargetZ -= Math.cos(rig.angle) * dyPx * panSpeed;
      },
      zoomBy: (scale) => {
        if (!Number.isFinite(scale) || scale <= 0) {
          return; // defensive: a bad ratio must never NaN the rig
        }
        lastCameraInputMs = performance.now();
        if (flatLocked) {
          // Dolly the shared panorama, clamped so the seam maths stay sane.
          flatRig.dist = Math.max(6, Math.min(45, flatRig.dist * scale));
          flatPoseDirty = true; // local input — publish to the partner window
          return;
        }
        // Multiplicative dolly, re-clamped to the onWheel envelope [4,45].
        rig.dRadius = Math.max(4, Math.min(45, rig.dRadius * scale));
      },
      // FREE-ROAM WALK (the one-hand palm-depth gesture): a signed normalized
      // velocity factor plus the wall-clock seconds it covers — the source
      // cadence varies (30 Hz TD, 60 fps bridge, 120 Hz phone rAF), so dt,
      // never the intent count, scales the glide. Positive = toward what's
      // on screen. The scene owns units and the roam envelope; the re-clamps
      // (±1 speed, dt to pinch-cam's WALK_MAX_DT bound) mirror the flick
      // verb's rogue-value rule — bad values can never NaN or teleport the
      // rig. speed 0 (a pinch held at the joystick zero) is a no-op: no
      // rig write, no flat-pose publish churn.
      walkBy: (speed, dtSec) => {
        if (!Number.isFinite(speed) || !Number.isFinite(dtSec)) {
          return; // defensive: bad values must never NaN the rig
        }
        const s = Math.max(-1, Math.min(1, speed));
        const dt = Math.max(0, Math.min(0.1, dtSec));
        if (s === 0 || dt === 0) {
          return;
        }
        lastCameraInputMs = performance.now();
        if (flatLocked) {
          // Translate the panorama's roaming centre along the shared view
          // direction (forward = (-sin yaw, -cos yaw), the flatViewDir /
          // W-key convention) — palm forward walks INTO the picture.
          const step = s * dt * FLAT_WALK_UNITS_PER_SEC;
          flatRig.cx = Math.max(-FLAT_ROAM_LIMIT, Math.min(FLAT_ROAM_LIMIT, flatRig.cx - Math.sin(flatRig.yaw) * step));
          flatRig.cz = Math.max(-FLAT_ROAM_LIMIT, Math.min(FLAT_ROAM_LIMIT, flatRig.cz - Math.cos(flatRig.yaw) * step));
          flatPoseDirty = true; // local input — publish to the partner window
          return;
        }
        // Desk/orbit rig: translate the orbit TARGET along the horizontal
        // view direction (the camera follows its target; radius unchanged).
        // Exact mirror of the WASD W/S math — same forward vector, same
        // radius-scaled units-per-second — integrated over this intent's dt.
        const step = (3.2 + rig.radius * 0.45) * s * dt;
        rig.dTargetX += -Math.sin(rig.angle) * step;
        rig.dTargetZ += -Math.cos(rig.angle) * step;
      },
      // Params deliberately NOT named angVel/heightVel — they must not shadow
      // the inertia vars this feeds.
      flick: (yawVel, hVel) => {
        lastCameraInputMs = performance.now();
        // Defensive re-clamp (the interpreter caps too): a rogue velocity must
        // never launch the camera.
        angVel = Math.max(-4, Math.min(4, yawVel));
        heightVel = Math.max(-30, Math.min(30, hVel));
      },
      setTracking: (on) => {
        lastCameraInputMs = performance.now();
        externalGrab = on;
        if (on) {
          // Same takeover onPointerDown does: a fresh grab kills residual coast.
          angVel = 0;
          heightVel = 0;
        }
      },
    });
    // FLAT-POSE SYNC SEAM (flat lock only): adopt the partner window's shared
    // panorama pose, relayed through the guest-hands hub (GestureLayer bridges
    // the socket). Targets are set DIRECTLY — the flatView easing smooths the
    // correction — re-clamped to this rig's own envelope (the scene owns all
    // clamps; the hub's wider LAN-input clamp is not trusted as ours). Marking
    // the targets clean is the loop breaker: an adopted pose must never
    // re-publish, or the pair would echo poses at each other forever.
    const unregisterFlatPoseControl = flatLocked
      ? registerSceneFlatPoseControl({
          adopt: (pose) => {
            flatRig.yaw = pose.yaw;
            flatRig.height = Math.max(1.4, Math.min(30, pose.height));
            flatRig.dist = Math.max(6, Math.min(45, pose.dist));
            // Roaming centre: absent on old frames parses to 0 upstream; the
            // ?? 0 here is belt+braces so a stale partner can never NaN it.
            flatRig.cx = Math.max(-FLAT_ROAM_LIMIT, Math.min(FLAT_ROAM_LIMIT, pose.cx ?? 0));
            flatRig.cz = Math.max(-FLAT_ROAM_LIMIT, Math.min(FLAT_ROAM_LIMIT, pose.cz ?? 0));
            flatPoseDirty = false;
          },
        })
      : null;

    // Pure gesture mode: pointing must not fight drag-orbit, so the DRAG
    // surface (pointerdown/wheel) never binds — but hover picking and plain
    // clicks still work: with no pointerdown, `dragging` stays false, so
    // pointermove is pure hover highlight and pointerup is pure activation.
    // A laptop trackpad at the gesture wall can therefore click nodes and
    // crystals directly, while orbit stays exclusive to the fusion/pinch rigs.
    // Desk/mouse-dwell modes keep the full drag-orbit / pan / zoom surface.
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);
    // WASD binds window-wide in every mode: the keyboard lives at the desk and
    // never fights the fusion/pinch rigs (desired-rig writers interleave).
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    if (pointerNavRef.current) {
      renderer.domElement.style.cursor = "grab";
      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
    }

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) {
        return;
      }
      renderer.setSize(width, height);
      camera.aspect = width / height;
      // Puff sprites are sized in-shader (world size / distance): keep the
      // pixel factor tied to the viewport height + vertical fov.
      if (skyRig !== null) {
        const pixelFactor = height / (2 * Math.tan((camera.fov * Math.PI) / 360));
        skyRig.puffMat.uniforms.uScale!.value = pixelFactor;
        skyRig.anchorMat.uniforms.uScale!.value = pixelFactor;
      }
      if (flatLocked) {
        // This window renders ITS column of the pair's single wide frustum.
        // setViewOffset also sets camera.aspect to the FULL panorama's, and
        // the fov (VERTICAL in three.js, describing the full frustum) is
        // recomputed so the combined HORIZONTAL fov stays pinned whatever
        // the window size.
        const view = flatViewOffset(wallRef.current, width, height);
        camera.setViewOffset(
          view.fullWidth,
          view.fullHeight,
          view.offsetX,
          view.offsetY,
          view.width,
          view.height,
        );
        camera.fov = flatVerticalFovDeg(camera.aspect);
      } else if (cornerLocked) {
        // camera.fov is VERTICAL in three.js: recompute it from the aspect so
        // the HORIZONTAL fov stays pinned at exactly 90° and the wall pair
        // keeps tiling the corner seamlessly at any window size.
        camera.fov = cornerVerticalFovDeg(camera.aspect);
      }
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    reconcile();
    let lastTick = tick.current;
    let lastFit = fitRef.current;
    // The focus upid whose camera move has already been applied. A pending
    // focus retries each frame until the node exists (fresh spawns land a beat
    // after the snapshot), then applies exactly once.
    let appliedFocus: string | null = null;

    const clock = new THREE.Clock();
    let rafId = 0;
    let running = false;
    const frame = () => {
      if (!running) {
        return;
      }
      rafId = requestAnimationFrame(frame);
      const dt = Math.min(clock.getDelta(), 0.1);
      const t = clock.elapsedTime;
      const now = performance.now();
      if (tick.current !== lastTick) {
        lastTick = tick.current;
        reconcile();
      }
      if (floraNodesDirty) {
        // The photoscan library just landed: regrow the IDEA nodes as real
        // flowers (they re-enter through the normal grow-in animation). Tree
        // bodies are HD-engine grown and never depend on the flora library.
        floraNodesDirty = false;
        for (const entry of ideaEntries.values()) {
          disposeEntry(entry);
        }
        ideaEntries.clear();
        reconcile();
      }
      if (fitRef.current !== lastFit) {
        lastFit = fitRef.current;
        if (flatLocked) {
          // FLAT-LOCK FIT = canonical pose, re-CENTERED on the fleet. The
          // pair can't free-frame (rigid frustum), but the shared pose CAN
          // drift (roam/walk/turn writers + hub replay), and the canonical
          // origin doesn't necessarily face the occupied tree slots
          // (dress-rehearsal finding: an imported tree invisible on BOTH
          // walls). The roam centre exists for exactly this translation:
          // aim yaw/height/dist at the boot framing and put the centre on
          // the garden trees' centroid, then publish — Fit-dwell (dock) and
          // the auto-fit-on-import pulse both bring the garden home on the
          // pair, in lockstep.
          let fitSx = 0;
          let fitSz = 0;
          let fitN = 0;
          for (const entry of treeEntries.values()) {
            if (!entry.removing) {
              fitSx += entry.targetPos.x;
              fitSz += entry.targetPos.z;
              fitN += 1;
            }
          }
          flatRig.yaw = FLAT_YAW;
          flatRig.height = FLAT_EYE_HEIGHT;
          flatRig.dist = FLAT_EYE_DISTANCE;
          flatRig.cx = fitN > 0 ? Math.max(-80, Math.min(80, fitSx / fitN)) : 0;
          flatRig.cz = fitN > 0 ? Math.max(-80, Math.min(80, fitSz / fitN)) : 0;
          flatPoseDirty = true;
        } else if (!cornerLocked) {
          fitToContent(); // corner lock: F is a camera no-op — the pair may not move
        }
      }
      // Guided-demo focus: glide the rig to the requested process node
      // (disabled under corner/flat lock — a rigid pair never reframes).
      const wantFocus = cornerLocked || flatLocked ? null : focusRef.current;
      if (wantFocus !== appliedFocus) {
        if (wantFocus === null) {
          appliedFocus = null;
        } else {
          // While the HD self tree stands in for the mirror's fleet node, a
          // focus request for the mirror process glides to the HD tree.
          const focusEntry =
            treeEntries.get(wantFocus) ??
            (wantFocus === SELF_PROCESS_UPID ? treeEntries.get(SELF_TREE_UPID) : undefined);
          if (focusEntry !== undefined && !focusEntry.removing) {
            rig.dTargetX = focusEntry.targetPos.x;
            rig.dTargetZ = focusEntry.targetPos.z;
            rig.dRadius = Math.max(7, Math.min(rig.dRadius, 11));
            appliedFocus = wantFocus;
          }
        }
      }
      const smoothing = 1 - Math.exp(-dt * 7);
      if (flatLocked) {
        // WASD under the flat lock drives the SHARED pair targets: W/S dolly
        // the whole panorama (flatRig.dist, the same [6,45] envelope as the
        // pinch zoom), A/D turn it (flatRig.yaw; +yaw turns the view left in
        // this rig's convention). Deterministic like every other flat-rig
        // writer: both windows receive identical keydown/keyup timing from
        // the same source (the relay hub broadcasts guest key holds to EVERY
        // window), so the dt-integrated totals match to within one frame —
        // the same transient tolerance the eased rig below already absorbs.
        // (The corner lock stays keys-dead: its rigid pair never moves.)
        if (keysDown.size > 0) {
          if (keysDown.has("w") !== keysDown.has("s")) {
            const dolly = (keysDown.has("w") ? -6 : 6) * dt; // ~6 units/s
            flatRig.dist = Math.max(6, Math.min(45, flatRig.dist + dolly));
            flatPoseDirty = true; // local input — publish to the partner window
          }
          if (keysDown.has("a") !== keysDown.has("d")) {
            flatRig.yaw += (keysDown.has("a") ? 0.9 : -0.9) * dt; // ~0.9 rad/s
            flatPoseDirty = true;
          }
        }
        // FLAT-POSE PUBLISH: local input dirtied the shared targets — push
        // them to the partner window through the hub, throttled to ~8 Hz.
        // A freshly loaded window publishes NOTHING until local input (it
        // adopts the first pose it hears instead), and adoption cleared the
        // flag, so sync corrections never echo back.
        if (flatPoseDirty && now - flatPoseLastPublishMs >= FLAT_POSE_PUBLISH_MS) {
          flatPoseLastPublishMs = now;
          flatPoseDirty = false;
          getFlatPoseSender()?.({ yaw: flatRig.yaw, height: flatRig.height, dist: flatRig.dist, cx: flatRig.cx, cz: flatRig.cz });
        }
        // Rigid flat pair: reassert the locked framing every frame so no
        // stray camera write can ever shear the seam between the halves —
        // same contract as the corner pair below (eased toward the shared
        // targets; see applyFlatRig).
        applyFlatRig(dt);
      } else if (cornerLocked) {
        // Rigid corner pair: reassert the locked framing every frame so no
        // stray camera write can ever drift the seam between the walls. The
        // pinch-camera external grab is a no-op here (like F/focus) — the pair
        // never moves.
        applyCornerRig();
      } else {
        // Track the hand tightly while dragging OR while the pinch camera holds
        // an external grab; glide softly once released.
        const camSmoothing = 1 - Math.exp(-dt * (dragging || externalGrab ? 16 : 6));

        // WASD fly-through: move the desired target on the ground plane
        // relative to the camera's yaw. Forward = camera → target = (-sin,
        // -cos); right = (cos, -sin). Speed scales with zoom so travel feels
        // constant whether inspecting a leaf or crossing the meadow. Corner-
        // locked wall pairs keep their rigid camera (the keyboard sits at the
        // desk anyway).
        if (keysDown.size > 0 && !cornerLocked) {
          const step = (3.2 + rig.radius * 0.45) * dt;
          const fx = -Math.sin(rig.angle);
          const fz = -Math.cos(rig.angle);
          let mx = 0;
          let mz = 0;
          if (keysDown.has("w")) {
            mx += fx;
            mz += fz;
          }
          if (keysDown.has("s")) {
            mx -= fx;
            mz -= fz;
          }
          if (keysDown.has("d")) {
            mx += Math.cos(rig.angle);
            mz += -Math.sin(rig.angle);
          }
          if (keysDown.has("a")) {
            mx -= Math.cos(rig.angle);
            mz -= -Math.sin(rig.angle);
          }
          const mag = Math.hypot(mx, mz);
          if (mag > 1e-6) {
            rig.dTargetX += (mx / mag) * step;
            rig.dTargetZ += (mz / mag) * step;
          }
        }

        // Flick inertia: after release the last drag velocity keeps the orbit
        // drifting, decaying exponentially (~0.4s half-life). A live external
        // grab (pinch camera) suppresses inertia exactly like a mouse drag.
        if (!dragging && !externalGrab && !reducedMotion) {
          if (Math.abs(angVel) > 1e-4) {
            rig.dAngle += angVel * dt;
            angVel *= Math.exp(-dt * 2.2);
          }
          if (Math.abs(heightVel) > 1e-3) {
            rig.dHeight = Math.max(1.4, Math.min(30, rig.dHeight + heightVel * dt));
            heightVel *= Math.exp(-dt * 2.6);
          }
        }

        // CONTINUOUS AUTO-FRAMING (autoFit — the research ceiling projector):
        // every AUTO_FIT_INTERVAL_MS re-measure the same bounds fitToContent
        // uses and, when the ideal framing drifted past the hysteresis
        // (shouldAutoRefit), write the fit targets into rig.d* and let the
        // existing lerp glide the camera out/recenter. Held camera input
        // (drag / pinch grab / WASD) re-stamps here so autoFitSuspended keeps
        // it paused until AUTO_FIT_RESUME_MS after the last touch; a live
        // guided-demo focus keeps its framing too. Manual F/fitSignal above
        // stays the way to force an immediate fit.
        if (autoFitOn) {
          if (dragging || externalGrab || keysDown.size > 0) {
            lastCameraInputMs = now;
          }
          if (now - lastAutoFitPollMs >= AUTO_FIT_INTERVAL_MS) {
            lastAutoFitPollMs = now;
            if (
              !autoFitSuspended(now, lastCameraInputMs, dragging || externalGrab) &&
              focusRef.current === null &&
              computeFitTargets(fitIdeal)
            ) {
              autoFitCurrent.targetX = rig.dTargetX;
              autoFitCurrent.targetZ = rig.dTargetZ;
              autoFitCurrent.radius = rig.dRadius;
              if (shouldAutoRefit(autoFitCurrent, fitIdeal)) {
                applyFitTargets();
              }
            }
          }
        }

        rig.angle = THREE.MathUtils.lerp(rig.angle, rig.dAngle, camSmoothing);
        rig.radius = THREE.MathUtils.lerp(rig.radius, rig.dRadius, camSmoothing);
        rig.height = THREE.MathUtils.lerp(rig.height, rig.dHeight, camSmoothing);
        rig.targetX = THREE.MathUtils.lerp(rig.targetX, rig.dTargetX, camSmoothing);
        rig.targetZ = THREE.MathUtils.lerp(rig.targetZ, rig.dTargetZ, camSmoothing);
        applyRig();
      }

      // The daylight env is hidden while the sky stands — don't animate
      // invisible butterflies.
      if (env !== null && env.group.visible) {
        env.update(t, dt);
      }
      // HD self-repo tree: leaf-card wind sway (instance matrices only).
      if (!reducedMotion) {
        selfTreeBuilt?.update(t);
      }

      const garden = builtMode === "garden";
      const radial = builtKey !== null && builtKey.endsWith("radial");
      for (const [specId, entry] of ideaEntries) {
        entry.group.position.lerp(entry.targetPos, smoothing);
        // Mouse hover and gesture-dwell targeting share the same grow/glow.
        const hovered = hoveredIdea === specId || dwellHighlights.has(`${SCENE_IDEA_PREFIX}${specId}`);
        const target = entry.targetScale * entry.scaleMult * (hovered ? 1.12 : 1);
        const next = THREE.MathUtils.lerp(entry.group.scale.x, target, smoothing);
        entry.group.scale.setScalar(Math.max(next, 0.0001));
        if (entry.removing && entry.group.scale.x < 0.02) {
          disposeEntry(entry);
          ideaEntries.delete(specId);
          continue;
        }
        if (!reducedMotion && radial) {
          if (garden) {
            entry.group.rotation.z = Math.sin(t * 0.6 + entry.phase) * 0.04;
            if (entry.head !== null) {
              entry.head.position.y = entry.headY + Math.sin(t * 0.9 + entry.phase) * 0.05;
            }
          } else {
            entry.group.position.y = entry.targetPos.y + Math.sin(t * 0.7 + entry.phase) * 0.22;
          }
        }
        let boost = hovered ? 0.3 : 0;
        if (entry.flashStart !== null && !reducedMotion) {
          const progress = (now - entry.flashStart) / FLASH_MS;
          if (progress >= 1) {
            entry.flashStart = null;
            entry.mats.forEach((mat) => mat.emissive.copy(mat.color));
          } else {
            const pulse = Math.abs(Math.sin(progress * Math.PI * 3)) * (1 - progress);
            boost += pulse * 1.8;
            entry.mats.forEach((mat) => mat.emissive.copy(mat.color).lerp(new THREE.Color(0xffffff), pulse * 0.8));
          }
        }
        entry.mats.forEach((mat) => {
          mat.emissiveIntensity = entry.baseEmissive + boost;
        });
      }

      for (const [specId, entry] of treeEntries) {
        entry.group.position.lerp(entry.targetPos, smoothing);
        const hovered =
          hoveredProc === entry.treeSpec?.callsign ||
          (entry.treeSpec !== undefined && dwellHighlights.has(`${SCENE_PROC_PREFIX}${entry.treeSpec.callsign}`));
        const target = entry.targetScale * entry.scaleMult * (hovered ? (garden ? 1.06 : 1.12) : 1);
        const next = THREE.MathUtils.lerp(entry.group.scale.x, target, smoothing);
        entry.group.scale.setScalar(Math.max(next, 0.0001));
        if (entry.removing && entry.group.scale.x < 0.02) {
          disposeEntry(entry);
          treeEntries.delete(specId);
          continue;
        }
        if (!reducedMotion) {
          if (garden && radial) {
            entry.group.rotation.z = Math.sin(t * 0.4 + entry.phase) * 0.015;
          } else if (!garden && radial) {
            entry.group.position.y = entry.targetPos.y + Math.sin(t * 0.55 + entry.phase) * 0.25;
          }
          // HD-engine bodies sway their instanced foliage (fleet trees grown
          // by buildTreeLOD — the self tree's sway runs above via
          // selfTreeBuilt; only the visible LOD level pays).
          entry.bodyUpdate?.(t);
          // The companion cat dances: a bouncing hop with a wiggling tilt and
          // a side-to-side sway so the little dancer sashays as it hops.
          if (entry.cat !== null) {
            entry.cat.position.y = Math.abs(Math.sin(t * 3 + entry.phase)) * 0.3;
            entry.cat.position.x = entry.catBaseX + Math.sin(t * 2 + entry.phase) * 0.12;
            entry.cat.rotation.z = Math.sin(t * 6 + entry.phase) * 0.25;
          }
          // Crystal mana shards spin and bob around the tree's foot.
          if (entry.mana !== undefined) {
            for (let m = 0; m < entry.mana.length; m++) {
              const shard = entry.mana[m];
              shard.rotation.y = t * 0.9 + m;
              shard.rotation.x = Math.sin(t * 0.7 + m) * 0.4;
              shard.position.y = (1.8 + (m % 2) * 0.6) + Math.sin(t * 1.6 + m) * 0.22;
            }
          }
          // mats guard: the HD self tree adopts the LIVE mirror spec (often
          // "active") but owns no overlay materials — the module renders its
          // own wood/foliage, so the pulse simply skips it.
          if (entry.treeSpec?.state === "active" && entry.mats.length > 0) {
            entry.mats[0].emissiveIntensity = entry.baseEmissive + Math.sin(t * 1.6 + entry.phase) * 0.07;
          }
        }
      }

      // ── the conversation sky, per frame ─────────────────────────────────
      // Clouds DRIFT (slow τ≈3s lerp — recurrence made visible: a topic that
      // comes back glides overhead instead of snapping). Pass 1 walks the
      // cloud entries (motion, chips, per-cloud light); pass 2 walks the
      // depth-sorted lobe order rewriting the shared Points buffers (normal
      // blending needs back-to-front). Zero allocation in this whole block.
      const skySmoothing = 1 - Math.exp(-dt * 0.35);
      // 1s low-cadence relayout: ages advance through silence between
      // snapshots (radius + altitude keep drifting toward the horizon), the
      // body ramp re-mixes, the lobe order re-sorts, prober stamps refresh.
      const relayoutDue = now - skyLastRelayoutMs >= 1000;
      if (relayoutDue) {
        skyLastRelayoutMs = now;
      }
      const hoveredCloudId = hoveredTurn !== null ? freshTurnToCloud.get(hoveredTurn) ?? null : null;
      let activeCloudId: string | null = null;
      let activeFresh = 0;
      const nowEpoch = Date.now();
      for (const [cloudId, entry] of cloudEntries) {
        const cloud = entry.cloudSpec;
        if (entry.removing || cloud === undefined) {
          continue;
        }
        const age = cloudAge(nowEpoch, cloud.freshAtMs);
        if (age < ACTIVE_MS && cloud.freshAtMs > activeFresh) {
          activeCloudId = cloudId;
          activeFresh = cloud.freshAtMs;
        }
        if (relayoutDue) {
          // Write targets only (auto-fit-poll discipline): radius + altitude
          // from the fresh age; the bearing stays whatever reconcile computed.
          const norm = radiusNorm(age);
          const radial = Math.hypot(entry.targetPos.x, entry.targetPos.z);
          if (radial > 1e-6) {
            const radius = staggeredRadius(cloudId, age);
            entry.targetPos.x *= radius / radial;
            entry.targetPos.z *= radius / radial;
          }
          entry.targetPos.y = cloudAltitude(norm, entry.cloudJitter ?? 0);
          entry.cloudNorm = norm;
          entry.cloudLife = lifeFactor(age);
          // Body ramp: dormant lavender-grey → near-white while ACTIVE (the
          // focal law), relaxing back over ~3min of silence; ≤12% speaker
          // tint on top so the sky stays composed, not carnival.
          const activeness = age < ACTIVE_MS ? 1 : Math.max(0, 1 - (age - ACTIVE_MS) / 180_000);
          if (entry.cloudColor !== undefined) {
            entry.cloudColor.copy(CLOUD_DORMANT_RGB).lerp(CLOUD_ACTIVE_RGB, activeness);
            if (entry.cloudTint !== undefined) {
              entry.cloudColor.lerp(entry.cloudTint, 0.12);
            }
          }
        }
      }
      if (relayoutDue) {
        rebuildSkyLobeOrder(camera.position);
      }
      const flashing = skyFlashUntil > now;
      const rig2 = skyRig;
      if (rig2 !== null) {
        for (const [cloudId, entry] of cloudEntries) {
          entry.group.position.lerp(entry.targetPos, entry.removing ? smoothing : skySmoothing);
          const cloud = entry.cloudSpec;
          const freshId = cloud?.freshestTurnId ?? null;
          const hovered =
            !entry.removing &&
            (hoveredCloudId === cloudId || (freshId !== null && dwellHighlights.has(`${SCENE_TURN_PREFIX}${freshId}`)));
          const scaleTarget = entry.targetScale * (hovered ? 1.12 : 1);
          const nextScale = THREE.MathUtils.lerp(entry.group.scale.x, scaleTarget, smoothing);
          entry.group.scale.setScalar(Math.max(nextScale, 0.0001));
          if (entry.removing && entry.group.scale.x < 0.02) {
            disposeEntry(entry);
            cloudEntries.delete(cloudId);
            continue;
          }
          // PERSISTENT name chips (the glance-readability contract): every
          // live cloud keeps its card; ONLY the single freshest active cloud
          // says the green "NOW" — a refreshed runner-up demotes to a cool
          // "JUST NOW", so two cards never both claim the present. Status
          // ticks repaint in place; accent flips rebuild.
          const wantLabel = !entry.removing && cloud !== undefined;
          if (wantLabel && cloud !== undefined) {
            const age = cloudAge(nowEpoch, cloud.freshAtMs);
            const minutes = Math.round(age / 60_000);
            const active = cloudId === activeCloudId;
            const when = active ? "NOW" : minutes < 1 ? "JUST NOW" : `${minutes} min ago`;
            const status = `${cloud.turnCount} turn${cloud.turnCount === 1 ? "" : "s"} · ${when}`;
            ensureCloudLabel(entry, cloud, status, active);
            if (entry.label !== null && entry.label.userData.lastStatus !== status) {
              entry.label.userData.lastStatus = status;
              updateLabelStatus(entry.label, status);
            }
          }
          if (entry.label !== null) {
            entry.label.visible = wantLabel;
            // TYPE SCALE: every card reads the SAME size on screen — undo the
            // sprite's distance attenuation against a reference depth (far
            // pills were rendering ~60% of the near ones, illegible past 4m).
            const baseSX = entry.label.userData.baseSX as number | undefined;
            const baseSY = entry.label.userData.baseSY as number | undefined;
            if (baseSX !== undefined && baseSY !== undefined) {
              const dist = camera.position.distanceTo(entry.group.position);
              // Group-scale compensation is capped so a condensing/dissolving
              // cloud still carries its card through the scale animation.
              const k = Math.min(2.4, Math.max(0.8, dist / 42)) / Math.max(entry.group.scale.x, 0.5);
              entry.label.scale.set(baseSX * k, baseSY * k, 1);
            }
          }
          const norm = entry.cloudNorm ?? 0;
          const life = entry.cloudLife ?? 1;
          // Lightning: only agent-linked clouds, only while a real applied
          // tick is fresh — a jittery two-tone flicker that decays fast.
          const flicker =
            flashing && entry.cloudHasAgentLink === true && !reducedMotion
              ? (0.5 + 0.5 * Math.sin(t * 23 + entry.phase) * Math.sin(t * 31)) * ((skyFlashUntil - now) / 1200) * 0.6
              : 0;
          // Merge-survivor pulse (the shared flashStart path): the absorbing
          // cloud brightens briefly, then settles.
          let flashBoost = 0;
          if (entry.flashStart !== null) {
            const progress = (now - entry.flashStart) / FLASH_MS;
            if (progress >= 1) {
              entry.flashStart = null;
            } else if (!reducedMotion) {
              flashBoost = Math.abs(Math.sin(progress * Math.PI * 3)) * (1 - progress) * 0.8;
            }
          }
          // FLOOR: every labeled topic keeps a visible body (~40% of active)
          // — a card must never float over empty sky (the aged-out smudge).
          entry.cloudAlphaBase = Math.max(
            0.62 * life * rimFactor(norm) * (1 + flicker + flashBoost),
            0.26,
          ) * (hovered ? 1.3 : 1);
        }
        // Pass 2: rewrite the shared lobe buffer BACK-TO-FRONT (skyLobeOrder)
        // so the normal-blended cumulus bodies layer like real clouds.
        let puffIndex = 0;
        for (let orderIndex = 0; orderIndex < SKY_MAX_PUFFS && puffIndex < SKY_MAX_PUFFS; orderIndex += 1) {
          const slot = skyLobeOrder[orderIndex];
          const entry = slot.entry;
          if (entry === null || entry.group.parent === null) {
            continue; // slot empty, or the entry was disposed since the sort
          }
          const puffs = entry.cloudPuffs;
          const color = entry.cloudColor;
          if (puffs === undefined || color === undefined || slot.lobe >= (entry.cloudPuffN ?? 0)) {
            continue;
          }
          const norm = entry.cloudNorm ?? 0;
          const life = entry.cloudLife ?? 1;
          const active = life >= 1;
          const flatten = rimFlatten(norm);
          const grow = entry.group.scale.x;
          const j = slot.lobe * 6;
          // Lobe-level roil while the cloud is ACTIVE (calm breathe, never
          // a blink — blink stays the emergency register).
          const roil = active && !reducedMotion ? 1 + 0.07 * Math.sin(t * 1.1 + entry.phase + slot.lobe * 1.7) : 1;
          const w = puffIndex * 3;
          rig2.puffPos[w] = entry.group.position.x + puffs[j] * grow * roil;
          rig2.puffPos[w + 1] = entry.group.position.y + puffs[j + 1] * grow * flatten * roil;
          rig2.puffPos[w + 2] = entry.group.position.z + puffs[j + 2] * grow * roil;
          rig2.puffSize[puffIndex] = puffs[j + 3] * grow * (active && !reducedMotion ? 1 + 0.05 * Math.sin(t * 0.9 + entry.phase + slot.lobe) : 1);
          rig2.puffColor[w] = color.r;
          rig2.puffColor[w + 1] = color.g;
          rig2.puffColor[w + 2] = color.b;
          rig2.puffAlpha[puffIndex] = (entry.cloudAlphaBase ?? 0) * (0.78 + 0.22 * puffs[j + 4]);
          rig2.puffShade[puffIndex] = puffs[j + 4];
          // Aerial perspective: the older (rim-normed) the cloud, the deeper
          // its body sinks into the dusk — history reads as haze, CAPPED so
          // a rim cloud is still a cloud shape, not a shapeless smudge.
          rig2.puffHaze[puffIndex] = Math.min(0.45, norm * norm * 0.6);
          rig2.puffRot[puffIndex] = puffs[j + 5];
          puffIndex += 1;
        }
        rig2.puffGeom.setDrawRange(0, puffIndex);
        rig2.puffGeom.getAttribute("position").needsUpdate = true;
        rig2.puffGeom.getAttribute("aSize").needsUpdate = true;
        rig2.puffGeom.getAttribute("aColor").needsUpdate = true;
        rig2.puffGeom.getAttribute("aAlpha").needsUpdate = true;
        rig2.puffGeom.getAttribute("aShade").needsUpdate = true;
        rig2.puffGeom.getAttribute("aHaze").needsUpdate = true;
        rig2.puffGeom.getAttribute("aRot").needsUpdate = true;
        // The moon light direction for the shader's moon-side rim: the moon's
        // fixed world spot expressed in THIS frame's view space (one scratch
        // vector, no allocation).
        skyMoonScratch.copy(rig2.moonWorld).applyMatrix4(camera.matrixWorldInverse);
        (rig2.puffMat.uniforms.uMoonView!.value as THREE.Vector3).copy(skyMoonScratch);
        // WISPS: glowing ribbons arched ABOVE the deck between the clouds'
        // CURRENT positions — width + brightness from strength, color from
        // provenance (warm agent / cool lexical — the honesty surface), and a
        // provenance-colored ANCHOR glow sunk inside each linked cloud so the
        // arc's ownership survives projector distance.
        let wispVert = 0;
        let anchorIndex = 0;
        for (const link of skyWisps) {
          const a = cloudEntries.get(link.a);
          const b = cloudEntries.get(link.b);
          if (a === undefined || b === undefined || wispVert + SKY_WISP_SEGMENTS * 6 > SKY_MAX_WISP_VERTS) {
            continue;
          }
          const warm = link.source === "agent";
          const src = warm ? WISP_AGENT_RGB : WISP_LEXICAL_RGB;
          const tone = 0.45 + 0.5 * link.strength + (warm && flashing ? 0.25 : 0);
          const cr = src.r * tone;
          const cg = src.g * tone;
          const cb = src.b * tone;
          const halfW = 0.32 + 0.55 * link.strength;
          // Endpoints START INSIDE the bodies; the arc bows over the deck.
          const ax = a.group.position.x;
          const ay = a.group.position.y + 0.5;
          const az = a.group.position.z;
          const bx = b.group.position.x;
          const by = b.group.position.y + 0.5;
          const bz = b.group.position.z;
          if (anchorIndex + 2 <= MAX_WISPS * 2) {
            const anchorTone = 0.5 + 0.5 * link.strength;
            let ap = anchorIndex * 3;
            rig2.anchorPos[ap] = ax;
            rig2.anchorPos[ap + 1] = ay;
            rig2.anchorPos[ap + 2] = az;
            rig2.anchorColor[ap] = src.r * anchorTone;
            rig2.anchorColor[ap + 1] = src.g * anchorTone;
            rig2.anchorColor[ap + 2] = src.b * anchorTone;
            ap += 3;
            rig2.anchorPos[ap] = bx;
            rig2.anchorPos[ap + 1] = by;
            rig2.anchorPos[ap + 2] = bz;
            rig2.anchorColor[ap] = src.r * anchorTone;
            rig2.anchorColor[ap + 1] = src.g * anchorTone;
            rig2.anchorColor[ap + 2] = src.b * anchorTone;
            anchorIndex += 2;
          }
          const mx = (ax + bx) / 2;
          const my = (ay + by) / 2 + 1.6;
          const mz = (az + bz) / 2;
          for (let seg = 0; seg < SKY_WISP_SEGMENTS; seg += 1) {
            const t0 = seg / SKY_WISP_SEGMENTS;
            const t1 = (seg + 1) / SKY_WISP_SEGMENTS;
            const i0 = 1 - t0;
            const i1 = 1 - t1;
            const x0 = i0 * i0 * ax + 2 * i0 * t0 * mx + t0 * t0 * bx;
            const y0 = i0 * i0 * ay + 2 * i0 * t0 * my + t0 * t0 * by;
            const z0 = i0 * i0 * az + 2 * i0 * t0 * mz + t0 * t0 * bz;
            const x1 = i1 * i1 * ax + 2 * i1 * t1 * mx + t1 * t1 * bx;
            const y1 = i1 * i1 * ay + 2 * i1 * t1 * my + t1 * t1 * by;
            const z1 = i1 * i1 * az + 2 * i1 * t1 * mz + t1 * t1 * bz;
            // Ribbon width lies in the deck plane, perpendicular to the run.
            const dx = x1 - x0;
            const dz = z1 - z0;
            const segLen = Math.hypot(dx, dz) || 1;
            const px = (-dz / segLen) * halfW;
            const pz = (dx / segLen) * halfW;
            // Two triangles: (A0,A1,B1) + (A0,B1,B0); aEdge = (across, along).
            const base = wispVert * 3;
            const eBase = wispVert * 2;
            rig2.wispPos[base] = x0 - px;
            rig2.wispPos[base + 1] = y0;
            rig2.wispPos[base + 2] = z0 - pz;
            rig2.wispEdge[eBase] = -1;
            rig2.wispEdge[eBase + 1] = t0;
            rig2.wispPos[base + 3] = x0 + px;
            rig2.wispPos[base + 4] = y0;
            rig2.wispPos[base + 5] = z0 + pz;
            rig2.wispEdge[eBase + 2] = 1;
            rig2.wispEdge[eBase + 3] = t0;
            rig2.wispPos[base + 6] = x1 + px;
            rig2.wispPos[base + 7] = y1;
            rig2.wispPos[base + 8] = z1 + pz;
            rig2.wispEdge[eBase + 4] = 1;
            rig2.wispEdge[eBase + 5] = t1;
            rig2.wispPos[base + 9] = x0 - px;
            rig2.wispPos[base + 10] = y0;
            rig2.wispPos[base + 11] = z0 - pz;
            rig2.wispEdge[eBase + 6] = -1;
            rig2.wispEdge[eBase + 7] = t0;
            rig2.wispPos[base + 12] = x1 + px;
            rig2.wispPos[base + 13] = y1;
            rig2.wispPos[base + 14] = z1 + pz;
            rig2.wispEdge[eBase + 8] = 1;
            rig2.wispEdge[eBase + 9] = t1;
            rig2.wispPos[base + 15] = x1 - px;
            rig2.wispPos[base + 16] = y1;
            rig2.wispPos[base + 17] = z1 - pz;
            rig2.wispEdge[eBase + 10] = -1;
            rig2.wispEdge[eBase + 11] = t1;
            for (let v = 0; v < 6; v += 1) {
              const c = (wispVert + v) * 3;
              rig2.wispColor[c] = cr;
              rig2.wispColor[c + 1] = cg;
              rig2.wispColor[c + 2] = cb;
            }
            wispVert += 6;
          }
        }
        rig2.wispGeom.setDrawRange(0, wispVert);
        rig2.wispGeom.getAttribute("position").needsUpdate = true;
        rig2.wispGeom.getAttribute("aColor").needsUpdate = true;
        rig2.wispGeom.getAttribute("aEdge").needsUpdate = true;
        rig2.anchorGeom.setDrawRange(0, anchorIndex);
        rig2.anchorGeom.getAttribute("position").needsUpdate = true;
        rig2.anchorGeom.getAttribute("aColor").needsUpdate = true;
        // The moon halo brightens while inference is really in flight; the
        // stars twinkle off the real clock (parked under reduced motion).
        const haloMat = rig2.moonHalo.material as THREE.SpriteMaterial;
        // Halved bloom at rest (a hot halo reads as an active node); thinking
        // still visibly brightens it — real inference state, never a timer.
        const haloTarget = researchThinkingRef.current ? 0.26 : 0.08;
        haloMat.opacity += (haloTarget - haloMat.opacity) * smoothing;
        if (!reducedMotion) {
          rig2.starMat.uniforms.uTime!.value = t;
        }
      }

      // Research RAIN: a real SHOWER of slanted, varied streaks under each
      // quest's cloud base (wind-sheared, per-streak deterministic length/
      // alpha — never a row of ticks). proposed = sparse faint blue-grey ·
      // researching = dense falling (rewritten in place, cycle-masked so the
      // wrap never pops) · complete = bright mint-grey + droplet · failed =
      // thin dim red-grey. The saturated status read lives in the droplet;
      // the entries (hit spheres + droplets) glide and fade like everything.
      let rainVert = 0;
      // Camera-facing width axis for the vertical quads (no allocation).
      const camE = camera.matrixWorld.elements;
      const camRLen = Math.hypot(camE[0], camE[2]) || 1;
      const camRX = camE[0] / camRLen;
      const camRZ = camE[2] / camRLen;
      for (const [specId, entry] of researchEntries) {
        entry.group.position.lerp(entry.targetPos, smoothing);
        const hovered =
          hoveredResearch === specId || dwellHighlights.has(`${SCENE_RESEARCH_PREFIX}${specId}`);
        const target = entry.targetScale * (hovered ? 1.2 : 1);
        const next = THREE.MathUtils.lerp(entry.group.scale.x, target, smoothing);
        entry.group.scale.setScalar(Math.max(next, 0.0001));
        if (entry.removing && entry.group.scale.x < 0.02) {
          disposeEntry(entry);
          researchEntries.delete(specId);
          continue;
        }
        const status = entry.researchSpec?.status;
        if (rig2 === null || status === undefined || entry.removing) {
          continue;
        }
        let flashBoost = 0;
        if (entry.flashStart !== null) {
          const progress = (now - entry.flashStart) / FLASH_MS;
          if (progress >= 1) {
            entry.flashStart = null;
          } else if (!reducedMotion) {
            flashBoost = Math.abs(Math.sin(progress * Math.PI * 3)) * (1 - progress);
          }
        }
        const color = RAIN_STATUS_RGB[status];
        const streaks = status === "researching" ? SKY_MAX_RAIN_STREAKS : status === "complete" ? 6 : status === "proposed" ? 4 : 3;
        const tone = (status === "proposed" ? 0.5 : status === "failed" ? 0.3 : status === "complete" ? 0.85 : 0.7) + (hovered ? 0.25 : 0) + flashBoost;
        const spread = entry.rainSpread ?? 1.4;
        for (let k = 0; k < streaks && rainVert + 6 <= SKY_MAX_RAIN_VERTS; k += 1) {
          // Deterministic per-streak variation (cheap sin hashes, no alloc):
          // where in the footprint, how long, how bright.
          const h1 = (Math.sin(entry.phase * 13.7 + k * 7.31) + 1) / 2;
          const h2 = (Math.sin(entry.phase * 27.9 + k * 3.17) + 1) / 2;
          const h3 = (Math.sin(entry.phase * 7.3 + k * 11.93) + 1) / 2;
          const falling = status === "researching" && !reducedMotion;
          const phase = falling ? (t * 0.55 + entry.phase + k * 0.61) % 1 : 0.3;
          const cycleMask = falling ? Math.sin(phase * Math.PI) : 1;
          const len = 1.1 + 1.6 * h3;
          const topX = entry.group.position.x + (h1 - 0.5) * 2 * spread;
          const topZ = entry.group.position.z + (h2 - 0.5) * 1.2 * spread;
          const topY = entry.group.position.y + 0.5 - h2 * 0.5 - phase * 1.1;
          const botY = topY - len;
          // Wind shear: the whole sky's rain leans the same way (weather).
          const botX = topX + skyRainWindX * len;
          const botZ = topZ + skyRainWindZ * len;
          const px = camRX * 0.1;
          const pz = camRZ * 0.1;
          const streakTone = tone * (0.45 + 0.55 * h1) * cycleMask;
          const cr = color.r * streakTone;
          const cg = color.g * streakTone;
          const cb = color.b * streakTone;
          const base = rainVert * 3;
          const eBase = rainVert * 2;
          // Quad (A0,A1,B1)+(A0,B1,B0); aEdge = (across, 0 top → 1 tip);
          // bottom verts carry the wind shear (the slant).
          rig2.rainPos[base] = topX - px;
          rig2.rainPos[base + 1] = topY;
          rig2.rainPos[base + 2] = topZ - pz;
          rig2.rainEdge[eBase] = -1;
          rig2.rainEdge[eBase + 1] = 0;
          rig2.rainPos[base + 3] = topX + px;
          rig2.rainPos[base + 4] = topY;
          rig2.rainPos[base + 5] = topZ + pz;
          rig2.rainEdge[eBase + 2] = 1;
          rig2.rainEdge[eBase + 3] = 0;
          rig2.rainPos[base + 6] = botX + px;
          rig2.rainPos[base + 7] = botY;
          rig2.rainPos[base + 8] = botZ + pz;
          rig2.rainEdge[eBase + 4] = 1;
          rig2.rainEdge[eBase + 5] = 1;
          rig2.rainPos[base + 9] = topX - px;
          rig2.rainPos[base + 10] = topY;
          rig2.rainPos[base + 11] = topZ - pz;
          rig2.rainEdge[eBase + 6] = -1;
          rig2.rainEdge[eBase + 7] = 0;
          rig2.rainPos[base + 12] = botX + px;
          rig2.rainPos[base + 13] = botY;
          rig2.rainPos[base + 14] = botZ + pz;
          rig2.rainEdge[eBase + 8] = 1;
          rig2.rainEdge[eBase + 9] = 1;
          rig2.rainPos[base + 15] = botX - px;
          rig2.rainPos[base + 16] = botY;
          rig2.rainPos[base + 17] = botZ - pz;
          rig2.rainEdge[eBase + 10] = -1;
          rig2.rainEdge[eBase + 11] = 1;
          for (let v = 0; v < 6; v += 1) {
            const c = (rainVert + v) * 3;
            rig2.rainColor[c] = cr;
            rig2.rainColor[c + 1] = cg;
            rig2.rainColor[c + 2] = cb;
          }
          rainVert += 6;
        }
      }
      if (rig2 !== null) {
        rig2.rainGeom.setDrawRange(0, rainVert);
        rig2.rainGeom.getAttribute("position").needsUpdate = true;
        rig2.rainGeom.getAttribute("aColor").needsUpdate = true;
        rig2.rainGeom.getAttribute("aEdge").needsUpdate = true;
      }

      renderer.render(scene, camera);
      if (relayoutDue) {
        // Prober stamps that need live values: how many cards are showing and
        // what the sky actually costs (read AFTER render so the count is real).
        let labeled = 0;
        for (const entry of cloudEntries.values()) {
          if (entry.label !== null && entry.label.visible) {
            labeled += 1;
          }
        }
        container.dataset.labeledClouds = String(labeled);
        container.dataset.drawCalls = String(renderer.info.render.calls);
      }
    };
    // TWO-WALL PERF: the default room runs two simultaneous fullscreen WebGL
    // windows on one GPU. Park this window's frame loop entirely while the
    // document is hidden (a backgrounded/occluded wall costs ~0 GPU) and
    // resume on visibility; the tick counter catches up any missed reconciles
    // on the first resumed frame, and the swallowed clock delta keeps the
    // animations from jumping.
    const startLoop = () => {
      if (running) {
        return;
      }
      running = true;
      clock.getDelta();
      frame();
    };
    const stopLoop = () => {
      running = false;
      cancelAnimationFrame(rafId);
    };
    const onSceneVisibility = () => {
      if (document.hidden) {
        stopLoop();
      } else {
        startLoop();
      }
    };
    document.addEventListener("visibilitychange", onSceneVisibility);
    onSceneVisibility();

    return () => {
      stopLoop();
      unregisterDwellSource();
      unregisterCameraControl();
      unregisterFlatPoseControl?.();
      document.removeEventListener("visibilitychange", onSceneVisibility);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
      if (pointerNavRef.current) {
        renderer.domElement.removeEventListener("pointerdown", onPointerDown);
        renderer.domElement.removeEventListener("wheel", onWheel);
      }
      for (const entry of ideaEntries.values()) {
        disposeEntry(entry);
      }
      ideaEntries.clear();
      for (const entry of treeEntries.values()) {
        disposeEntry(entry);
      }
      treeEntries.clear();
      for (const entry of cloudEntries.values()) {
        disposeEntry(entry);
      }
      cloudEntries.clear();
      for (const entry of researchEntries.values()) {
        disposeEntry(entry);
      }
      researchEntries.clear();
      clearSkyRig();
      clearLayoutDecor();
      env?.dispose();
      Object.values(GEO).forEach((geometry) => geometry.dispose());
      stemMat.dispose();
      invisibleHitMat.dispose();
      invisibleShellMat.dispose();
      glowTexture.dispose();
      scene.traverse((node) => {
        if (node instanceof THREE.Mesh && node.geometry !== undefined) {
          node.geometry.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
    // Mount-once scene; updates flow through refs + tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      className="room-scene"
      data-testid="room-scene"
      data-region="fleet"
      data-mode={mode}
      data-layout={layout}
      data-corner-lock={cornerLock ? "true" : "false"}
      data-flat-lock={flatLock ? "true" : "false"}
      data-idea-count={ideas.length}
      data-tree-count={trees.length}
      data-dialogue-count={dialogue.length}
      data-topic-count={topics.length}
      data-research-count={research.length}
      data-self-tree={selfTree !== null ? "true" : "false"}
      aria-label={`Room ${mode}: ${ideas.length} idea${ideas.length === 1 ? "" : "s"}, ${trees.length} build${trees.length === 1 ? "" : "s"}${research.length > 0 ? `, ${research.length} research quest${research.length === 1 ? "" : "s"}` : ""}`}
    />
  );
}
