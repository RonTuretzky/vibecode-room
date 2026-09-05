import { projectStatus } from "./project-status";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import type { ProjectorProcess, ProjectorSnapshot } from "./types";
import type { SceneDwellRect } from "./gesture/scene-source";
import { tendChipLayout, tendChipSize, type TendChipId } from "./tend-radial";
import { laneStatusLabel, processLanes, type GuidedLane } from "./guided/machine";
import { executionOf, stageOf, type ProcessStage } from "./stage";
import { ExecutionChip } from "./BuildChips";
import { buildsOf } from "./buildloop";
import { RecordSteerToggle } from "./RecordSteerToggle";
import {
  haltSelfRun,
  loadSelfVersion,
  manageSelfVersion,
  useSelfBranches,
  type SelfBranchesPayload,
} from "./self-repo";
import { TakeHomeQr } from "./TakeHomeQr";
import { mergeTreeBranch, openTreeBranchPr, steerOntoTreeBranch } from "./tree-repo";
import "./TreeMenu.css";

/**
 * Tree menu — the per-tree control surface, anchored beside the picked tree.
 *
 * THE TREE IS THE INTERFACE: the fleet rail is gone from the walls, so
 * click/dwell-picking a garden tree opens THIS panel right next to it. It
 * re-derives its position from the anchor (the tree's screen-projected dwell
 * rect — RoomScene passes it through onSelectProcess, and the App refreshes
 * it ~1×/s from the live rect while open, so slot re-shuffles/settle easing
 * never orphan the panel) and clamps to the viewport WITHOUT covering the
 * tree; it does not chase the tree frame-by-frame. Every control is a plain
 * enabled <button> at gesture-mode sizes, so GestureLayer's collectDomTargets
 * makes the whole menu dwell-native automatically.
 *
 * Contents (reuse before reinvent — the guided demo already solved these):
 *   - header: inferred project title / callsign / state·progress line + ✕.
 *   - 🗑 remove with a TWO-STAGE confirm (second dwell within ~4s) → POST
 *     /api/process/:upid/dismiss (stops builds + removes from the snapshot).
 *
 * TWO THINGS THIS MENU DELIBERATELY NO LONGER HAS, both at the operator's
 * request, because a doc that promises removed surfaces is its own kind of
 * lie:
 *   - CONCEPT-LANE CHIPS. processLanes (guided/machine.ts) still derives them
 *     and `model.lanes` still carries them, but nothing here renders one. Each
 *     ready lane was a button into that backend's MOCK deck — furniture from
 *     the guided demo's race, not work anyone can point at afterwards.
 *   - THE RECORD-A-CHANGE TOGGLE. Voice steering lives where it commits
 *     somewhere nameable: the SELF tree's graft slot (below) and a branch
 *     card. On a fleet tree the words went into a mock revision.
 *
 * EVERY TREE is tended as a CONSTELLATION OF CHIPS, no panel, no container
 * (the two-column glass slab hid the garden and never framed the tree it
 * tended — live-room verdict). Every verb and every branch row is its OWN
 * floating glass chip in ONE plant vocabulary (branch = the git word AND the
 * plant word; main = the trunk), positioned by tendChipLayout
 * (tend-radial.ts) around the tree's projected anchor rect. The chips
 * re-project as the tree sways (the App's 1 Hz anchor chase + 240ms CSS
 * glide — the halo idiom), and the garden stays visible between them.
 *
 * THE SELF TREE ("tend the tree"): GRAFT roots the verb arc at the base, the
 * GROWING card (+ ✂ stop growing) sits beside it, the 🌳 you-are-here trunk
 * verbs at mid-height, and the grown branches hang as leaf-chips on the
 * opposite arc — dwell-PAGINATED four at a time (no CSS scroll, ever) with a
 * per-branch FOCUS chip among the limbs carrying the 2×2 verb grid
 * (climb/merge/press/prune).
 *
 * FLEET TREES speak the same vocabulary with the verbs their substrate can
 * actually back (the 80f0904 rule: a verb with no rail behind it is the one
 * thing this surface must never grow): concept lanes ride the leaf arc as
 * chips (a ready lane is a real button into that backend's deck), the
 * brief/live-app/deck verbs join the verb arc above the 🎙 record chip, and
 * the two-stage 🗑 remove roots it. ADOPTED trees (GitHub imports with a
 * recorded origin) additionally hang their room/* branches as leaf-chips with
 * a FOCUS view carrying graft-onto-branch / ⬆ open PR / ✓ merge, plus the 🌱
 * GROW verb under the leaf list — which now reports its result honestly
 * (inline receipt + the room-wide failure epilogue) instead of the old
 * fire-and-forget POST that closed the menu and swallowed every refusal.
 */

// The fleet-remove confirm window and the receipt fade. The FLEET remove is a
// single-question flow, so 4s stays honest there (a wandering dwell cursor
// four seconds later must not delete a build); the transient receipts
// (merged/pressed notes) fade on the same budget.
export const DISMISS_CONFIRM_MS = 4_000;

// The TEND armed window (stop / merge / prune stages) — split from the fleet
// budget after the tulip saga: the prune's TWO-question flow (really prune? →
// how far?) at dwell economics (0.8s dwell + 0.4s cooldown per press) cannot
// land inside 4s, and a real prune was lost to the timeout. Ten seconds per
// stage, made VISIBLE by the armed chip's draining countdown bar (.tend-drain
// — pure CSS, `animation: tend-drain 10s linear forwards`, keyed on the armed
// slot so a stage change restarts the drain with its fresh window).
export const ARMED_CONFIRM_MS = 10_000;

// Pure: where an armed confirm falls when its window expires. TULIP RULE
// (a real prune was lost to the old invisible 4s deadline): the fall is
// ALWAYS to resting — a stage-3 (`prune2:`) timeout must never re-arm stage 2
// (`prune:`), and no timeout re-arms anything. The auto-disarm effect calls
// exactly this, so the test pinning it pins the timer's landing spot.
export function armedAfterDeadline(_armed: string): string | null {
  return null;
}

// Pure: the prune stage-2 press ("really prune?"). Only advances to the scope
// question while stage 2 is STILL armed — a press racing the 10s deadline
// no-ops instead of re-opening the flow.
export function pruneStage2Advance(armed: string | null, branch: string): string | null {
  return armed === `prune:${branch}` ? `prune2:${branch}` : null;
}

// Pure: the stage-3 scope buttons ("just this branch" / "remove it
// everywhere") fire ONLY while stage 3 is still armed. TULIP RULE: after the
// deadline the whole flow rests — a late press never cuts anything and never
// re-arms stage 2 from scratch.
export function pruneScopeAllowed(armed: string | null, branch: string): boolean {
  return armed === `prune2:${branch}`;
}

// Placement geometry. The pure function stays SSR-safe by working from a
// NOMINAL size, but the rendered panel is measured (layout effect below) and
// re-placed from its REAL footprint: gesture mode widens the panel to 620px
// via CSS (TreeMenu.css `main.gesture-mode .tree-menu`), and placing a 620px
// panel with 440px math pushed the ✕ close button off-screen at 1920×1080 —
// the occlusion check then dropped it as a dwell target, leaving a gesture
// wall with NO way to dismiss the menu (live-room P0).
export const TREE_MENU_WIDTH = 440;
// Mirror of the gesture-mode CSS width — exported so placement tests exercise
// the widest real footprint, not just the desk nominal.
export const TREE_MENU_GESTURE_WIDTH = 620;
// The SELF tree's tending surface is two columns, so it takes a wider glass
// footprint (desk / gesture) — same export contract as the pair above so the
// placement tests exercise the widest real panel.
export const TREE_MENU_SELF_WIDTH = 760;
export const TREE_MENU_SELF_GESTURE_WIDTH = 960;
export const TREE_MENU_EST_HEIGHT = 560;
const MENU_GAP = 18;
const VIEWPORT_MARGIN = 16;

// Branch list pagination: four stationary rows per page — a dwell cursor
// steps pages with ▲/⌄, and no row ever moves mid-dwell (lists never scroll).
export const TREE_TEND_PAGE_SIZE = 4;

// Pure: one page of a list plus the clamped page/pages arithmetic (the list
// shrinks under the cursor when a branch is pruned/merged away — the shown
// page must clamp back into range rather than render an empty screen).
export function pageSlice<T>(
  list: readonly T[],
  page: number,
  size: number = TREE_TEND_PAGE_SIZE,
): { slice: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const clamped = Math.min(Math.max(0, page), pages - 1);
  return { slice: list.slice(clamped * size, clamped * size + size), page: clamped, pages };
}

// Pure: "room/hp-at-hp-four" → "hp at hp four" — the human-readable slug line
// on branch cards. The slug is REQUIRED beside the subject: recorded subjects
// repeat (three limbs of "manufacture GPU server racks…" in one afternoon),
// and only the slug tells them apart.
export function deslugBranch(name: string): string {
  return name.replace(/^room\//u, "").replace(/-/gu, " ");
}

export interface TreeMenuPlacement {
  left: number;
  top: number;
}

// WHERE A CHIP SITS AND HOW BIG IT IS ALLOWED TO BE. One helper for both
// bodies (self + fleet) because they had a copy each and only one of them
// would have learned about the ceiling.
//
// `maxHeight` appears only when the arc could not afford the chip's nominal
// and squeezed it (tend-radial's FLEXIBLE_CHIPS). Without it the chip renders
// at its content height regardless of the budget the layout reserved, and the
// chip below is painted over — a covered centre is a dead dwell target.
function tendChipStyle(
  id: TendChipId,
  layout: Record<string, { left: number; top: number; height?: number }>,
  viewport: { width: number; height: number },
  gesture: boolean,
): CSSProperties {
  const size = tendChipSize(id, gesture);
  const pos = layout[id] ?? { left: viewport.width - size.width - 16, top: 16 };
  return {
    left: `${Math.round(pos.left)}px`,
    top: `${Math.round(pos.top)}px`,
    width: `${size.width}px`,
    ...(pos.height === undefined ? {} : { maxHeight: `${pos.height}px` }),
  };
}

// Pure: where the panel opens. Prefers the side of the anchor rect with room
// (right first — labels read left-to-right), so the menu never covers the tree
// it belongs to; EVERY branch clamps inside the viewport margins. A null
// anchor (projection unavailable / keyboard select) rests against the right
// edge. The unconditional horizontal clamp is load-bearing: the ~1 Hz anchor
// chase adopts LIVE projected rects while cameras move (WASD, guest fly,
// pinch cam, palm-depth walk, the auto-fit pulse), so an anchor may sit
// partially or entirely OFF-screen — the side-picking branches alone would
// then push the panel (and its ✕, the dwell wall's close verb) past the
// viewport edge, the exact live-room P0.
export function treeMenuPlacement(
  anchor: SceneDwellRect | null,
  viewport: { width: number; height: number },
  menu: { width: number; height: number } = { width: TREE_MENU_WIDTH, height: TREE_MENU_EST_HEIGHT },
): TreeMenuPlacement {
  const clampTop = (top: number): number =>
    Math.min(Math.max(VIEWPORT_MARGIN, top), Math.max(VIEWPORT_MARGIN, viewport.height - menu.height - VIEWPORT_MARGIN));
  const clampLeft = (left: number): number =>
    Math.min(Math.max(VIEWPORT_MARGIN, left), Math.max(VIEWPORT_MARGIN, viewport.width - menu.width - VIEWPORT_MARGIN));
  if (anchor === null) {
    return {
      left: clampLeft(viewport.width - menu.width - VIEWPORT_MARGIN),
      top: clampTop((viewport.height - menu.height) / 2),
    };
  }
  const rightOf = anchor.left + anchor.width + MENU_GAP;
  const leftOf = anchor.left - MENU_GAP - menu.width;
  let left: number;
  if (rightOf + menu.width <= viewport.width - VIEWPORT_MARGIN) {
    // Right edge fits; the clamp below still lifts a negative left (anchor
    // off the LEFT edge) back inside the margin.
    left = rightOf;
  } else if (leftOf >= VIEWPORT_MARGIN) {
    // Left edge fits; the clamp below still pulls the right edge back inside
    // when the anchor sits off the RIGHT edge (leftOf alone can exceed it).
    left = leftOf;
  } else {
    // Neither side fits fully (tree fills the frame): rest toward the right
    // edge — partial overlap beats an off-screen panel.
    left = rightOf;
  }
  return { left: clampLeft(left), top: clampTop(anchor.top + anchor.height / 2 - menu.height / 2) };
}

export interface TreeMenuModel {
  title: string;
  callsign: string;
  stage: ProcessStage;
  statusLine: string;
  lanes: GuidedLane[];
  isSelf: boolean;
  // Fixture decks (mock room): the process carries slides directly, so the
  // menu offers the plain deck-open button instead of per-lane views.
  hasFixtureDeck: boolean;
  hasDeck: boolean;
  published: { url: string; qrSvg: string } | null;
  // LIVE DEPLOYMENT (imported trees): the deploy-resolver's confirmed URL —
  // present, the menu grows a "🌐 Live app ▸" row opening the holo panel.
  deployUrl: string | null;
  // ADOPTED (GitHub import with its origin recorded, never the self tree):
  // the menu grows the "🌱 Grow a branch ▸" row — POST /api/process/:upid/
  // branch names a real room/* rail off the freshly fetched origin tip.
  adopted: boolean;
}

// Pure: everything the menu renders, derived from the live snapshot (unit-
// testable without DOM). Title mirrors the scene label: the inferred project
// title when the server named the build, else the callsign — except the SELF
// tree, which is "the room" (its task says "Vibersyn Room", but the menu is
// the surface where the mirror must read as the room itself).
export function treeMenuModel(process: ProjectorProcess, snapshot: ProjectorSnapshot): TreeMenuModel {
  const stage = stageOf(process);
  const isSelf = stage === "self";
  return {
    title: isSelf ? "the room" : process.task.length > 0 ? process.task : process.callsign,
    callsign: process.callsign,
    stage,
    statusLine: projectStatus(process).label,
    // The MIRROR runs durable self-runs, never concept lanes — roster-derived
    // "queued…" rows on the room's own tree read as dead deck buttons from
    // projector distance (live-room report). Its real telemetry is the
    // ExecutionChip / growing card below.
    lanes: isSelf ? [] : processLanes(process, snapshot),
    isSelf,
    hasFixtureDeck: (process.slides?.length ?? 0) > 0,
    hasDeck: (process.slides?.length ?? 0) > 0 || buildsOf(process).some((build) =>
      build.status === "ready" && Boolean(build.slideshowUrl?.trim())),
    published:
      typeof process.publishedUrl === "string" &&
      process.publishedUrl.length > 0 &&
      typeof process.publishedQrSvg === "string"
        ? { url: process.publishedUrl, qrSvg: process.publishedQrSvg }
        : null,
    deployUrl: typeof process.deployUrl === "string" && process.deployUrl.length > 0 ? process.deployUrl : null,
    // ADOPTED = the server said so. It used to mean "has a remoteUrl", but the
    // take-home publish records one on a LOCAL tree (tree-git publish()), so a
    // published local tree grew the whole adopted surface — branch rails and
    // the 🌱 grow chip — over a substrate that refuses every one of those ops.
    // The chip must not offer what cannot work.
    adopted: !isSelf && process.treeRepo?.adopted === true,
  };
}

// A tend verb in flight: which verb and on which branch (null = the here-card
// / the growing run / the whole-tree grow). One at a time — every verb button
// disables while busy. A prune carries its chosen `scope` so the busy line
// can say what the wait actually is ("removing the graft everywhere…" is a
// longer cut). grow/pr/graft are the fleet rails (tree-repo.ts).
interface TendBusy {
  verb: "climb" | "merge" | "press" | "prune" | "stop" | "pr" | "graft";
  branch: string | null;
  scope?: "branch" | "everywhere";
}

// A two-line dwell verb (strong line + honest sub-line). `armedSkin` recolors
// the confirm stage; the sync data-state stamp happens in the click handler
// (markPressed pattern) so an 8fps wall shows the press before React renders.
// `armedKey` marks an ARMED confirm stage: the button renders the draining
// countdown bar (.tend-drain) so the 10s deadline is VISIBLE, keyed on the
// armed slot so a stage change (prune: → prune2:) remounts the bar and the
// drain restarts with its fresh window.
function TendVerb(props: {
  testid: string;
  className?: string;
  line1: string;
  line2: string;
  title?: string;
  disabled?: boolean;
  armedKey?: string;
  onPress: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={`ctl-button tend-verb${props.className !== undefined ? ` ${props.className}` : ""}`}
      data-testid={props.testid}
      data-armed={props.armedKey !== undefined ? "1" : undefined}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      <span className="tend-line">{props.line1}</span>
      <span className="tend-sub">{props.line2}</span>
      {props.armedKey !== undefined ? (
        <span key={props.armedKey} className="tend-drain" data-armed-key={props.armedKey} aria-hidden="true" />
      ) : null}
    </button>
  );
}

export interface TreeMenuProps {
  process: ProjectorProcess;
  snapshot: ProjectorSnapshot;
  // The picked tree's screen rect at pick time (RoomScene projects it); null
  // when unavailable (keyboard select, degenerate projection) → edge resting.
  anchor: SceneDwellRect | null;
  onClose: () => void;
  // The existing deck path: opens the slideshow overlay on this backend's tab.
  onOpenDeck: (upid: string, backend?: string) => void;
  // POST /api/process/:upid/dismiss — only reachable through the two-stage
  // confirm, and never rendered for the self tree.
  onDismiss: (upid: string) => void;
  // LIVE APP (imported trees with a resolved deployUrl): opens the holo panel
  // beside the tree — the App closes this menu and mounts HoloPanel. Absent =
  // the row never renders (older mounts, tests exercising the menu alone).
  onOpenLiveApp?: (upid: string) => void;
  // Present only for a tree the room STUDIED (App probes GET
  // /api/process/:upid/brief) — a built import has no study to read.
  onOpenBrief?: (upid: string) => void;
  // "⚘ Replant…": choose a new ground spot for this tree (planting mode) —
  // the same flow the idea card's Plant… uses, bound to an existing upid.
  // Absent = no replant affordance (static renderers).
  onReplant?: (upid: string) => void;
  // SSR/test seam for the self tree's rails (the effect-free static renderer
  // cannot fetch /api/self/branches) — the live wall leaves this undefined.
  selfBranches?: SelfBranchesPayload | null;
  // SSR/test seam for the tend surface's interaction states (the static
  // renderer cannot dwell): boots the body in a focus view / with a verb
  // armed / on a later page / mid-verb (busy). The live wall leaves this
  // undefined.
  // `note`/`error` seed the honest-receipt chips — the only states set
  // exclusively inside fetch resolutions, which renderToStaticMarkup can
  // never reach.
  tendSeed?: { focusBranch?: string; armed?: string; page?: number; busy?: TendBusy; note?: string; error?: string };
  // Failure toast seam (App.reportControlFailure): a verb whose POST failed
  // says so inline AND raises the room-wide "… failed — nothing changed."
  // epilogue. Absent = inline notes only (tests exercising the menu alone).
  onControlFailure?: (what: string, status?: number) => void;
}

export function TreeMenu({
  process,
  snapshot,
  anchor,
  onClose,
  onOpenDeck,
  onDismiss,
  onReplant,
  onOpenLiveApp,
  onOpenBrief,
  selfBranches,
  onControlFailure,
  tendSeed,
}: TreeMenuProps) {
  const model = treeMenuModel(process, snapshot);
  const execution = executionOf(process);
  // Re-derived per render — the anchor prop changes on a fresh pick and on the
  // App's ~1 Hz anchor refresh, never frame-by-frame.
  const viewport =
    typeof window !== "undefined"
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 1920, height: 1080 };
  // treeMenuPlacement + the TREE_MENU_* width exports stay the pure placement
  // contract for BranchPopup and the placement tests — this component itself
  // now positions every tree per-chip via tendChipLayout.
  // Gesture-XL chips take wider nominal footprints; the wall sets the class
  // on <main> (App), so the component reads it rather than growing a prop.
  const gestureWall = typeof document !== "undefined" && document.querySelector("main.gesture-mode") !== null;

  // THE ROOM'S BRANCHES (self tree): every record window cuts a room/* branch
  // — this payload is the rails the room can actually be tended along. The
  // handle's adopt/refresh seams keep the list honest after prune/merge
  // (Rails 2/3 return the fresh rails in their own response — no second GET).
  const rails = useSelfBranches(model.isSelf, selfBranches);

  // TEND STATE. One armed slot for every two-stage verb ("stop" | "merge:…" |
  // "prune:…") with the shared auto-disarm; one busy verb at a time; the
  // server's refusals verbatim in `tendError`; `tendNote`/`haltNote` are the
  // transient honest receipts. Everything resets when the menu moves to
  // another tree (a stale confirm must never fire on the wrong target).
  const [page, setPage] = useState(tendSeed?.page ?? 0);
  const [focusBranch, setFocusBranch] = useState<string | null>(tendSeed?.focusBranch ?? null);
  const [armed, setArmed] = useState<string | null>(tendSeed?.armed ?? null);
  const [busy, setBusy] = useState<TendBusy | null>(tendSeed?.busy ?? null);
  const [tendError, setTendError] = useState<string | null>(tendSeed?.error ?? null);
  const [tendNote, setTendNote] = useState<string | null>(tendSeed?.note ?? null);
  const [haltNote, setHaltNote] = useState<string | null>(null);
  useEffect(() => {
    setPage(0);
    setFocusBranch(null);
    setArmed(null);
    setBusy(null);
    setTendError(null);
    setTendNote(null);
    setHaltNote(null);
  }, [process.upid]);
  // Auto-disarm: an armed confirm falls back to RESTING after the tend window
  // (ARMED_CONFIRM_MS — 10s, drawn on the chip by the drain bar). Keyed on the
  // armed slot, so the prune stage change (prune: → prune2:) re-runs it and
  // stage 3 gets its own fresh window. TULIP RULE: the fall is always to
  // resting (setArmed(null)) — a stage-3 timeout never re-arms stage 2.
  useEffect(() => {
    if (armed === null) {
      return;
    }
    const timer = setTimeout(() => setArmed(armedAfterDeadline(armed)), ARMED_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  // The armed slot, readable synchronously from click handlers: a press that
  // races the auto-disarm timer must check the CURRENT slot, not the one its
  // closure rendered with (pruneStage2Advance / pruneScopeAllowed guards).
  const armedRef = useRef<string | null>(armed);
  armedRef.current = armed;
  // The menu MOVES between trees without remounting (a new pick just re-points
  // the `process` prop), and the [process.upid] reset above cannot cancel an
  // in-flight verb. Every async verb captures the upid it was pressed on and
  // DROPS its resolution if the menu has moved — otherwise tree A's grow
  // receipt (or refusal, or a stale onClose) lands on tree B's menu, and A's
  // setBusy(null) re-enables B's verbs mid-flight.
  const upidRef = useRef(process.upid);
  upidRef.current = process.upid;
  // The merged/pressed receipts fade on the same budget.
  useEffect(() => {
    if (tendNote === null) {
      return;
    }
    const timer = setTimeout(() => setTendNote(null), DISMISS_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [tendNote]);

  // 8fps-wall ack rule: stamp the SAME attribute React manages, synchronously
  // in the handler, so the press shows at the next frame (markPressed pattern,
  // RecordSteerToggle) — React's own render then takes over.
  const stampPressed = (event: ReactMouseEvent<HTMLButtonElement>, state = "pressed"): void => {
    event.currentTarget.dataset.state = state;
  };

  // A tend verb (merge / press / prune) through the one endpoint. Success
  // adopts the refreshed rails from the response (or re-fetches when an older
  // server sent none) and leaves the focus view for the re-clamped list. A
  // prune carries its excise `scope`; the receipt keeps the one-note rule —
  // conflicts (a branch the graft-revert could not land on, named) win over
  // the rebuild receipt, which wins over the plain merge receipt.
  const tendVerb = (branch: string, verb: "merge" | "press" | "prune", scope?: "branch" | "everywhere"): void => {
    const action = verb === "merge" ? "merge" : verb === "press" ? "archive" : "delete";
    setBusy({ verb, branch, ...(scope !== undefined ? { scope } : {}) });
    setTendError(null);
    setTendNote(null); // one receipt row at a time — a stale note under a fresh error would outgrow the list-view budget
    const forUpid = process.upid;
    void manageSelfVersion(branch, action, scope).then((result) => {
      if (upidRef.current !== forUpid) {
        return; // landed after the menu moved to another tree
      }
      setBusy(null);
      setArmed(null);
      if (result.ok) {
        if (result.branches !== null) {
          rails.adopt(result.branches);
        } else {
          rails.refresh();
        }
        if (result.conflicts.length > 0) {
          setTendNote(`couldn't cleanly remove from ${result.conflicts.join(", ")} (conflicts)`);
        } else if (result.reloading) {
          setTendNote("🍂 pruned — the room is rebuilding without it");
        } else if (verb === "prune" && result.grafts === 0) {
          // "Remove it everywhere" on a branch that never grew anything: the
          // honest receipt, so nobody stands waiting for a reload that has no
          // reason to happen (live-room report: an empty record-window branch).
          setTendNote("🍂 pruned — this branch carried no graft of its own; nothing to remove elsewhere");
        } else if (verb === "merge") {
          setTendNote("🪵 in the trunk — merged");
        }
        setFocusBranch(null);
      } else {
        setTendError(result.error);
        onControlFailure?.(verb === "merge" ? "into the trunk" : verb === "press" ? "press" : "prune");
      }
    });
  };

  // CLIMB (focus view): checkout + supervisor relaunch. Success keeps the
  // busy label — the room reloads under us; a refusal clears it and shows the
  // server's reason (the old load path span forever on failure — fixed here).
  const climbVerb = (branch: string): void => {
    setBusy({ verb: "climb", branch });
    setTendError(null);
    setTendNote(null);
    const forUpid = process.upid;
    void loadSelfVersion(branch).then((result) => {
      if (result.ok) {
        return; // the room is rebuilding onto the branch — this window reloads
      }
      if (upidRef.current !== forUpid) {
        return; // landed after the menu moved to another tree
      }
      setBusy(null);
      setTendError(result.error);
      onControlFailure?.("climb");
    });
  };

  // ✂ STOP GROWING (the halt verb): POST /api/self/run/halt — never the
  // registry's /api/process/self/halt (that kills the pinned mirror record).
  const stopGrowing = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    stampPressed(event, "stopping");
    setArmed(null);
    setBusy({ verb: "stop", branch: null });
    setHaltNote(null);
    const forUpid = process.upid;
    void haltSelfRun().then((result) => {
      if (upidRef.current !== forUpid) {
        return; // landed after the menu moved to another tree
      }
      setBusy(null);
      if (result.ok) {
        setHaltNote(result.halted ? "✂ stopped — the branch keeps what grew" : "nothing growing — it already finished");
      } else {
        setHaltNote(result.error);
        onControlFailure?.("stop growing", result.status);
      }
    });
  };

  // ── FLEET RAILS (adopted trees — tree-repo.ts). Same shape as the self
  // tend verbs: busy → typed result → honest receipt (tendNote) or the
  // server's refusal VERBATIM (tendError + the room-wide failure epilogue).
  // The old grow was a fire-and-forget POST that closed the menu — every 400
  // (substrate disabled, local-tree refusal, git fetch failure) was invisible
  // on the wall, the exact silent-control bug the App's own rule forbids. ──

  // 🌱 GROW A BRANCH is no longer a verb with a handler: it is a RECORDING
  // window (RecordSteerToggle kind="grow", rendered on the chip below). It
  // used to POST a machine-generated name the instant it was pressed, which
  // cut an empty rail called "spoken-changes" before anyone had said what it
  // was for. The branch is now named by what the operator actually says, and
  // is cut only once they have said it.

  // ⬆ OPEN PR (focus view): the whole spoken-changes → PR ride. The URL rides
  // the receipt AND lands on the branch card via the snapshot's prUrl.
  const prVerb = (branch: string): void => {
    setBusy({ verb: "pr", branch });
    setTendError(null);
    setTendNote(null);
    const forUpid = process.upid;
    void openTreeBranchPr(forUpid, branch).then((result) => {
      if (upidRef.current !== forUpid) {
        return; // landed after the menu moved to another tree
      }
      setBusy(null);
      if (result.ok) {
        setTendNote(`⬆ PR open — ${result.url}`);
        setFocusBranch(null);
      } else {
        setTendError(result.error);
        onControlFailure?.("open PR", result.status);
      }
    });
  };

  // ✓ INTO THE TRUNK (focus view, two-stage): squash-merge the branch's open
  // PR into the ORIGIN's main. Refusals ("no PR is open for this branch")
  // surface verbatim — the verb never promises mergeability.
  const mergeAdoptedVerb = (branch: string): void => {
    setBusy({ verb: "merge", branch });
    setTendError(null);
    setTendNote(null);
    const forUpid = process.upid;
    void mergeTreeBranch(forUpid, branch).then((result) => {
      if (upidRef.current !== forUpid) {
        return; // landed after the menu moved to another tree
      }
      setBusy(null);
      setArmed(null);
      if (result.ok) {
        setTendNote("🪵 in the trunk — merged into the origin's main");
        setFocusBranch(null);
      } else {
        setTendError(result.error);
        onControlFailure?.("into the trunk", result.status);
      }
    });
  };

  // 🌱 GRAFT ONTO THIS BRANCH (focus view): stand the steer on this branch —
  // the next spoken change grafts here. The select rail is ACKNOWLEDGE-ONLY
  // (the server always answers 200 with the snapshot — BranchPopup's graft
  // rides the same contract), so the ack closes the menu and the record
  // chip's lit state carries the armed truth; only a transport failure can
  // surface inline.
  const graftOntoBranchVerb = (branch: string): void => {
    setBusy({ verb: "graft", branch });
    setTendError(null);
    setTendNote(null);
    const forUpid = process.upid;
    void steerOntoTreeBranch(forUpid, branch).then((result) => {
      if (upidRef.current !== forUpid) {
        return; // landed after the menu moved to another tree
      }
      setBusy(null);
      if (result.ok) {
        setFocusBranch(branch);
      } else {
        setTendError(result.error);
        onControlFailure?.("graft onto branch", result.status);
      }
    });
  };

  // TWO-STAGE remove (fleet trees): the first press arms "really remove?"; it
  // disarms by itself after DISMISS_CONFIRM_MS. Both stages reset when the
  // menu moves to another tree so a stale confirm can never delete the wrong
  // build.
  const [dismissArmed, setDismissArmed] = useState(false);
  useEffect(() => {
    setDismissArmed(false);
  }, [process.upid]);
  useEffect(() => {
    if (!dismissArmed) {
      return;
    }
    const timer = setTimeout(() => setDismissArmed(false), DISMISS_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [dismissArmed]);

  // ── SELF derivations (cheap; null-safe when not the self tree) ──────────
  const payload = rails.payload;
  const growing = model.isSelf && execution !== null && execution.status === "executing";
  const growLabel = execution?.progressLabel ?? "growing";
  const currentEntry =
    payload === null
      ? null
      : payload.branches.find((entry) => entry.name === payload.current) ?? {
          name: payload.current,
          subject: "",
          date: "",
        };
  const grown = payload === null ? [] : payload.branches.filter((entry) => entry.name !== payload.current);
  const paged = pageSlice(grown, page);
  const focusEntry = focusBranch === null ? null : grown.find((entry) => entry.name === focusBranch) ?? null;
  const anyBusy = busy !== null;
  const cleanSubject = (subject: string): string => subject.replace(/^self: /u, "");

  // The shared merge verb (here-card + focus view): resting → armed(amber) →
  // busy. HONESTY DEVIATION (recorded): the button is NOT pre-flighted for
  // PR/mergeability — the armed line says what the merge needs, and a server
  // 400 surfaces verbatim in the inline error. It never promises success.
  const mergeVerb = (branch: string, testidBase: string) => {
    const key = `merge:${branch}`;
    if (busy?.verb === "merge" && busy.branch === branch) {
      return <TendVerb testid={testidBase} className="verb-merge" line1="🪵 merging…" line2="into the trunk (main)" disabled onPress={() => undefined} />;
    }
    return armed === key ? (
      <TendVerb
        testid={`${testidBase}-confirm`}
        className="verb-merge is-armed-caution"
        line1="make it permanent?"
        line2="merges this branch into the trunk (main) — needs its PR or fast-forward"
        title="Second press merges for real. It needs the branch's PR (or a fast-forward) — a refusal shows right here."
        armedKey={key}
        disabled={anyBusy}
        onPress={(event) => {
          stampPressed(event);
          tendVerb(branch, "merge");
        }}
      />
    ) : (
      <TendVerb
        testid={testidBase}
        className="verb-merge"
        line1="🪵 into the trunk"
        line2="merge to main"
        title="Merge this branch into the trunk (main) — asks once more."
        disabled={anyBusy}
        onPress={(event) => {
          stampPressed(event);
          setArmed(key);
          setTendError(null);
        }}
      />
    );
  };

  // ── THE SELF TREE: a CONSTELLATION OF CHIPS — no panel, no container ──────
  // The tending surface paints NO glass slab: the root is a full-viewport,
  // background-less, pointer-events:none section (keeping the tree-menu
  // testid/upid/self contract the e2e visibility checks rely on) whose
  // children are individual floating glass chips, each absolutely positioned
  // by tendChipLayout from the SAME projected anchor rect the lock halo rides
  // (the App's 1 Hz chase feeds the `anchor` prop; the chips' 240ms CSS
  // left/top glide smooths the steps — the halo idiom). The garden stays
  // visible BETWEEN chips, and parking on that ground is the designed
  // dismissal (onPickMiss / popup-dismiss's 1.5s miss + 6s walk-away): every
  // NON-BUTTON chip carries its OWN data-dwell-shield, and the root carries
  // NONE — a full-viewport shield would swallow the dwell-miss close.
  if (model.isSelf) {
    const present: TendChipId[] = ["identity", "close", "graft"];
    if (growing) {
      present.push("growing");
    }
    if (execution !== null && !growing) {
      present.push("settled");
    }
    if (!growing && haltNote !== null) {
      present.push("halt-note");
    }
    if (payload === null || currentEntry === null) {
      present.push("reading");
    } else {
      present.push("here");
      if (tendNote !== null) {
        present.push("note");
      }
      if (tendError !== null) {
        present.push("error");
      }
      if (focusEntry !== null) {
        present.push("focus");
      } else {
        present.push("branches-head");
        if (grown.length === 0) {
          present.push("empty");
        } else {
          for (let index = 0; index < paged.slice.length; index += 1) {
            present.push(`branch-${index}` as TendChipId);
          }
          if (paged.pages > 1) {
            present.push("pager");
          }
        }
      }
    }
    if (model.published !== null) {
      present.push("qr");
    }
    const layout = tendChipLayout(anchor, viewport, { gesture: gestureWall, present });
      const chipStyle = (id: TendChipId): CSSProperties => tendChipStyle(id, layout, viewport, gestureWall);
    const stopClicks = (clickEvent: ReactMouseEvent<HTMLElement>): void => clickEvent.stopPropagation();
    return (
      <section
        className="tree-tend tree-tend-constellation stage-self"
        data-testid="tree-menu"
        data-upid={process.upid}
        data-stage={model.stage}
        data-self="true"
        role="dialog"
        aria-label={`Tree controls for ${model.callsign}`}
      >
        {/* IDENTITY plate — crowns the verb arc. */}
        <div
          className="tend-chip tend-chip-identity"
          data-chip="identity"
          data-dwell-shield="1"
          style={chipStyle("identity")}
          onClick={stopClicks}
        >
          <div className="tree-menu-identity">
            <span className="tree-menu-eyebrow">{"🌳 the room's tree"}</span>
            <h2 className="tree-menu-title" data-testid="tree-menu-title">
              {model.title}
            </h2>
            <span className="tree-menu-callsign" data-testid="tree-menu-callsign">
              {model.callsign}
            </span>
            <span className={`tree-menu-status state-${process.state}`} data-testid="tree-menu-status">
              {model.statusLine}
            </span>
          </div>
        </div>

        {/* ✕ — crowns the leaf arc; a real enabled button, so the dwell layer
            adopts it automatically (no shield: it IS a target). */}
        <button
          type="button"
          className="tend-chip tend-chip-close ctl-button tree-menu-close"
          data-chip="close"
          data-testid="tree-menu-close"
          style={chipStyle("close")}
          onClick={onClose}
          title="stop tending — close this surface"
        >
          ✕
        </button>

        {/* 🌱 GRAFT — roots the verb arc at the tree's base. */}
        <div
          className="tend-chip tend-chip-graft"
          data-chip="graft"
          data-dwell-shield="1"
          style={chipStyle("graft")}
          onClick={stopClicks}
        >
          <div className="tree-menu-steer" data-testid="tree-menu-steer">
            {/* The room's own graft chip. It echoed correctly but never got
                the server's verdict, so a graft git REFUSED (uncommitted work
                in the tree — nothing was dispatched at all) still read
                "✓ graft taken — the room is growing this change". */}
            <RecordSteerToggle
              process={process}
              kind="room"
              transcript={snapshot.transcript}
              landing={snapshot.steerLanding ?? null}
            />
          </div>
        </div>

        {/* A SETTLED lane (built/failed) keeps its chip beside the graft. */}
        {execution !== null && !growing ? (
          <div
            className="tend-chip tend-chip-settled"
            data-chip="settled"
            data-dwell-shield="1"
            style={chipStyle("settled")}
            onClick={stopClicks}
          >
            <ExecutionChip execution={execution} />
          </div>
        ) : null}

        {growing ? (
          /* 🌿 GROWING — the executing self-run with its ✂, beside the graft. */
          <div
            className="tend-chip tend-chip-growing"
            data-chip="growing"
            data-dwell-shield="1"
            style={chipStyle("growing")}
            onClick={stopClicks}
          >
            <div className="tree-growing-card" data-testid="tree-menu-growing">
              <span className="tree-card-eyebrow">🌿 growing now</span>
              {/* The run's REAL label + percent, verbatim from the lane. */}
              <p className="tree-growing-label">
                {growLabel}
                {execution?.percent != null ? ` · ${Math.round(execution.percent)}%` : ""}
              </p>
              {busy?.verb === "stop" ? (
                <TendVerb testid="tree-menu-halt" className="verb-halt" line1="✂ stopping…" line2="halting this change" disabled onPress={() => undefined} />
              ) : armed === "stop" ? (
                <TendVerb
                  testid="tree-menu-halt-confirm"
                  className="verb-halt is-armed-danger"
                  line1="✂ really stop?"
                  line2={`'${growLabel}' stays half-grown on its branch`}
                  title="Second press cancels the growing self-run. Whatever it already grew stays on its branch."
                  armedKey="stop"
                  onPress={stopGrowing}
                />
              ) : (
                <TendVerb
                  testid="tree-menu-halt"
                  className="verb-halt"
                  line1="✂ stop growing"
                  line2="halt this change"
                  title="Stop the change growing right now (asks once more)."
                  disabled={anyBusy}
                  onPress={(event) => {
                    stampPressed(event);
                    setArmed("stop");
                  }}
                />
              )}
              {haltNote !== null ? (
                <p className="tree-tend-note" data-testid="tree-menu-halt-note">
                  {haltNote}
                </p>
              ) : null}
            </div>
          </div>
        ) : haltNote !== null ? (
          /* The run settled while the note was up (halt landed): keep the
             receipt readable for its own window even as the card folds. */
          <div
            className="tend-chip tend-chip-halt-note"
            data-chip="halt-note"
            data-dwell-shield="1"
            style={chipStyle("halt-note")}
            onClick={stopClicks}
          >
            <p className="tree-tend-note" data-testid="tree-menu-halt-note">
              {haltNote}
            </p>
          </div>
        ) : null}

        {payload === null || currentEntry === null ? (
          <div
            className="tend-chip tend-chip-reading"
            data-chip="reading"
            data-dwell-shield="1"
            style={chipStyle("reading")}
            onClick={stopClicks}
          >
            <p className="tree-tend-reading">reading the tree…</p>
          </div>
        ) : (
          <>
            {/* 🌳 YOU ARE HERE — the trunk verbs, mid-height on the verb arc. */}
            <div
              className="tend-chip tend-chip-here"
              data-chip="here"
              data-dwell-shield="1"
              style={chipStyle("here")}
              onClick={stopClicks}
            >
              <div className="tree-here-card" data-testid="tree-menu-here">
                <div className="tree-here-head">
                  <span className="tree-card-eyebrow">🌳 you are here</span>
                  <span className="tree-here-sub">the room lives on this branch</span>
                </div>
                <p className="tree-here-subject">
                  {cleanSubject(currentEntry.subject.length > 0 ? currentEntry.subject : currentEntry.name)}
                </p>
                <p className="tree-here-slug">
                  {deslugBranch(currentEntry.name)}
                  {currentEntry.date !== undefined && currentEntry.date.length > 0 ? ` · ${currentEntry.date}` : ""}
                </p>
                <div className="tree-here-verbs">
                  {mergeVerb(currentEntry.name, "tree-menu-here-merge")}
                  {busy?.verb === "press" && busy.branch === currentEntry.name ? (
                    <TendVerb testid="tree-menu-here-archive" className="verb-press" line1="🍁 pressing…" line2="the room will reload on the trunk" disabled onPress={() => undefined} />
                  ) : (
                    <TendVerb
                      testid="tree-menu-here-archive"
                      className="verb-press"
                      line1="🍁 press & step off"
                      line2="archive — the room reloads on the trunk"
                      title="Press this branch into the album: the room steps off onto the trunk (main), the branch is renamed archive/…, and the room reloads without it."
                      disabled={anyBusy}
                      onPress={(event) => {
                        stampPressed(event);
                        tendVerb(currentEntry.name, "press");
                      }}
                    />
                  )}
                </div>
              </div>
            </div>

            {/* Honest receipts — fixed slots under the trunk. */}
            {tendNote !== null ? (
              <div
                className="tend-chip tend-chip-note"
                data-chip="note"
                data-dwell-shield="1"
                style={chipStyle("note")}
                onClick={stopClicks}
              >
                <p className="tree-tend-note" data-testid="tree-menu-tend-note">
                  {tendNote}
                </p>
              </div>
            ) : null}
            {tendError !== null ? (
              <div
                className="tend-chip tend-chip-error"
                data-chip="error"
                data-dwell-shield="1"
                style={chipStyle("error")}
                onClick={stopClicks}
              >
                <span className="tree-menu-version-error" data-testid="tree-menu-version-error">
                  {tendError}
                </span>
              </div>
            ) : null}

            {focusEntry !== null ? (
              /* ── FOCUS: the one branch + its verb grid, among the limbs
                 (upper leaf arc — the leaf-chips stand down while it shows,
                 exactly as the list unmounted inside the old panel). ─────── */
              <div
                className="tend-chip tend-chip-focus"
                data-chip="focus"
                data-dwell-shield="1"
                style={chipStyle("focus")}
                onClick={stopClicks}
              >
                <div className="tree-branch-focus">
                  <button
                    type="button"
                    className="ctl-button tree-branch-back"
                    data-testid="tree-menu-version-back"
                    title="Back to the branch list."
                    onClick={() => {
                      setFocusBranch(null);
                      setArmed(null);
                      setTendError(null);
                    }}
                  >
                    ◂ back to branches
                  </button>
                  <div
                    className="tree-branch-card is-open"
                    data-testid="tree-menu-version"
                    data-branch={focusEntry.name}
                    data-open="true"
                  >
                    <span className="tree-branch-subject">🌿 {cleanSubject(focusEntry.subject)}</span>
                    <span className="tree-branch-slug">
                      #{grown.indexOf(focusEntry) + 1} · {deslugBranch(focusEntry.name)}
                      {focusEntry.date !== undefined && focusEntry.date.length > 0 ? ` · ${focusEntry.date}` : ""}
                    </span>
                  </div>
                  <div className="tree-branch-verbs" data-testid="tree-menu-version-actions">
                    {busy?.verb === "climb" && busy.branch === focusEntry.name ? (
                      <TendVerb testid="tree-menu-version-load" className="verb-climb" line1="⤴ climbing…" line2="the room will reload" disabled onPress={() => undefined} />
                    ) : (
                      <TendVerb
                        testid="tree-menu-version-load"
                        className="verb-climb"
                        line1="⤴ climb here"
                        line2="the room reloads onto this branch"
                        title="Load the room onto this branch — rebuilds and relaunches on it."
                        disabled={anyBusy}
                        onPress={(event) => {
                          stampPressed(event);
                          climbVerb(focusEntry.name);
                        }}
                      />
                    )}
                    {mergeVerb(focusEntry.name, "tree-menu-version-merge")}
                    {busy?.verb === "press" && busy.branch === focusEntry.name ? (
                      <TendVerb testid="tree-menu-version-archive" className="verb-press" line1="🍁 pressing…" line2="archiving this branch" disabled onPress={() => undefined} />
                    ) : (
                      <TendVerb
                        testid="tree-menu-version-archive"
                        className="verb-press"
                        line1="🍁 press"
                        line2="archive — keeps the work, leaves the tree"
                        title="Press this branch into the album (archive/…): keeps the work, leaves this list."
                        disabled={anyBusy}
                        onPress={(event) => {
                          stampPressed(event);
                          tendVerb(focusEntry.name, "press");
                        }}
                      />
                    )}
                    {busy?.verb === "prune" && busy.branch === focusEntry.name ? (
                      <TendVerb
                        testid="tree-menu-version-delete"
                        className="verb-prune"
                        line1="🍂 pruning…"
                        line2={busy.scope === "everywhere" ? "removing the graft everywhere…" : "deleting this branch"}
                        disabled
                        onPress={() => undefined}
                      />
                    ) : armed === `prune2:${focusEntry.name}` ? (
                      /* THIRD STAGE — the scope question: the room's branches
                         STACK, so a pruned label's commits usually live on
                         inside descendants. Two big STATIONARY dwell buttons
                         (never a moving target); the armed-slot change re-ran
                         the auto-disarm, so this stage owns a FRESH 10s window
                         — drawn by its own drain bar. */
                      <div className="tree-prune-scope" data-testid="tree-menu-version-delete-scope" data-armed="1">
                        <span
                          key={`prune2:${focusEntry.name}`}
                          className="tend-drain"
                          data-armed-key={`prune2:${focusEntry.name}`}
                          aria-hidden="true"
                        />
                        <p className="tree-prune-scope-question">🍂 prune the branch — and the graft it carries?</p>
                        <div className="tree-prune-scope-verbs">
                          <TendVerb
                            testid="tree-menu-version-delete-scope-branch"
                            className="verb-prune"
                            line1="just this branch"
                            line2="the label falls — its commits live on downstream"
                            title="Delete only this branch: every branch stacked on it keeps the commits it grafted."
                            disabled={anyBusy}
                            onPress={(event) => {
                              // TULIP RULE: a press racing the 10s deadline
                              // no-ops — never a late cut, never stage 2 again.
                              if (!pruneScopeAllowed(armedRef.current, focusEntry.name)) {
                                return;
                              }
                              stampPressed(event);
                              tendVerb(focusEntry.name, "prune", "branch");
                            }}
                          />
                          <TendVerb
                            testid="tree-menu-version-delete-scope-everywhere"
                            className="verb-prune is-armed-danger"
                            line1="remove it everywhere"
                            line2="reverts this graft on every branch that carries it — the room rebuilds if it's on this one"
                            title="Delete the branch AND revert its graft on every branch carrying it — the room rebuilds if the current branch loses it."
                            disabled={anyBusy}
                            onPress={(event) => {
                              if (!pruneScopeAllowed(armedRef.current, focusEntry.name)) {
                                return;
                              }
                              stampPressed(event);
                              tendVerb(focusEntry.name, "prune", "everywhere");
                            }}
                          />
                        </div>
                      </div>
                    ) : armed === `prune:${focusEntry.name}` ? (
                      <TendVerb
                        testid="tree-menu-version-delete-confirm"
                        className="verb-prune is-armed-danger"
                        line1="really prune?"
                        line2="the branch falls — one more choice: how far the cut goes"
                        title="Second press asks the last question: just this branch, or its graft removed everywhere."
                        armedKey={`prune:${focusEntry.name}`}
                        disabled={anyBusy}
                        onPress={(event) => {
                          // Advance ONLY while stage 2 is still armed: a press
                          // racing the timeout must not re-open the flow.
                          const next = pruneStage2Advance(armedRef.current, focusEntry.name);
                          if (next === null) {
                            return;
                          }
                          stampPressed(event);
                          setArmed(next);
                        }}
                      />
                    ) : (
                      <TendVerb
                        testid="tree-menu-version-delete"
                        className="verb-prune"
                        line1="🍂 prune"
                        line2="delete this branch"
                        title="Delete this branch (asks once more)."
                        disabled={anyBusy}
                        onPress={(event) => {
                          stampPressed(event);
                          setArmed(`prune:${focusEntry.name}`);
                          setTendError(null);
                        }}
                      />
                    )}
                  </div>
                </div>
              </div>
            ) : (
              /* ── LEAF ARC: heading + four stationary leaf-chips + pager. ── */
              <>
                <div
                  className="tend-chip tend-chip-branches-head"
                  data-chip="branches-head"
                  data-dwell-shield="1"
                  style={chipStyle("branches-head")}
                  onClick={stopClicks}
                >
                  <span className="tree-branches-head">🌿 branches · {grown.length} grown</span>
                </div>
                {grown.length === 0 ? (
                  <div
                    className="tend-chip tend-chip-empty"
                    data-chip="empty"
                    data-dwell-shield="1"
                    style={chipStyle("empty")}
                    onClick={stopClicks}
                  >
                    <p className="tree-tend-reading">no other branches — graft a change to grow one</p>
                  </div>
                ) : (
                  <>
                    {paged.slice.map((entry, index) => (
                      <div
                        key={entry.name}
                        className="tend-chip tend-chip-branch"
                        data-chip={`branch-${index}`}
                        data-dwell-shield="1"
                        style={chipStyle(`branch-${index}` as TendChipId)}
                        onClick={stopClicks}
                      >
                        <div
                          className="tree-branch-card"
                          data-testid="tree-menu-version"
                          data-branch={entry.name}
                          data-open="false"
                        >
                          <button
                            type="button"
                            className="tree-branch-head"
                            data-testid="tree-menu-version-head"
                            title="tend this branch — climb, merge, press, or prune."
                            onClick={(event) => {
                              stampPressed(event);
                              setFocusBranch(entry.name);
                              setArmed(null);
                              setTendError(null);
                            }}
                          >
                            <span className="tree-branch-subject">🌿 {cleanSubject(entry.subject)}</span>
                            {/* The slug line is REQUIRED: subjects repeat —
                                only the slug + date tell branches apart. #N is
                                the position in the FULL newest-first list. */}
                            <span className="tree-branch-slug">
                              #{grown.indexOf(entry) + 1} · {deslugBranch(entry.name)}
                              {entry.date !== undefined && entry.date.length > 0 ? ` · ${entry.date}` : ""}
                            </span>
                          </button>
                        </div>
                      </div>
                    ))}
                    {paged.pages > 1 ? (
                      <div
                        className="tend-chip tend-chip-pager"
                        data-chip="pager"
                        data-dwell-shield="1"
                        style={chipStyle("pager")}
                        onClick={stopClicks}
                      >
                        <div className="tree-branch-pager" data-testid="tree-menu-branch-pager">
                          {/* At-limit buttons stay ENABLED but dim (FleetScroll
                              precedent) — never hide/disable a control under a
                              mid-dwell cursor; the press just no-ops. */}
                          <button
                            type="button"
                            className="ctl-button tree-branch-page-btn"
                            data-testid="tree-menu-page-newer"
                            data-at-limit={paged.page === 0 ? "1" : undefined}
                            title="Newer branches."
                            onClick={() => {
                              if (paged.page > 0) {
                                setPage(paged.page - 1);
                                setArmed(null);
                                setTendError(null);
                              }
                            }}
                          >
                            ▲ newer
                          </button>
                          <span className="tree-branch-page-status" data-testid="tree-menu-page-status">
                            page {paged.page + 1}/{paged.pages}
                          </span>
                          <button
                            type="button"
                            className="ctl-button tree-branch-page-btn"
                            data-testid="tree-menu-page-older"
                            data-at-limit={paged.page >= paged.pages - 1 ? "1" : undefined}
                            title="Older branches."
                            onClick={() => {
                              if (paged.page < paged.pages - 1) {
                                setPage(paged.page + 1);
                                setArmed(null);
                                setTendError(null);
                              }
                            }}
                          >
                            ⌄ older
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </>
                )}
              </>
            )}
          </>
        )}

        {/* Take-home QR (the room rarely publishes, but the slot is honest). */}
        {model.published !== null ? (
          <div
            className="tend-chip tend-chip-qr"
            data-chip="qr"
            data-dwell-shield="1"
            style={chipStyle("qr")}
            onClick={stopClicks}
          >
            <TakeHomeQr url={model.published.url} qrSvg={model.published.qrSvg} size="card" />
          </div>
        ) : null}
      </section>
    );
  }


  // ── EVERY OTHER TREE: the SAME constellation vocabulary, with the verbs
  // this substrate can actually back. Root contract unchanged (testid/upid/
  // stage/dialog); no root shield — every non-button chip carries its own, so
  // parking on the garden between chips still dwell-dismisses the surface. ──
  const liveOpenable =
    (model.deployUrl !== null || (execution?.status === "built" && execution.previewUrl !== null)) &&
    onOpenLiveApp !== undefined;
  // The adopted tree's room/* rails ride the snapshot (tree-git republishes
  // on every mutation) — no fetch, so SSR renders the list synchronously.
  // Branch cards share the four leaf slots with the lane chips (the arc's
  // vertical budget at gesture sizes cannot stack both families in full), so
  // the page size is whatever the lanes left over — never below one.
  const treeBranches = model.adopted
    ? (process.treeRepo?.branches ?? []).filter((entry) => entry.name.startsWith("room/"))
    : [];
  // Lanes no longer eat leaf slots, so the branch list gets the full page.
  const treePaged = pageSlice(treeBranches, page, TREE_TEND_PAGE_SIZE);
  const treeFocus = focusBranch === null ? null : treeBranches.find((entry) => entry.name === focusBranch) ?? null;
  const branchSubLine = (entry: { name: string; commits: number; prUrl?: string }, index: number): string =>
    `#${index + 1} · ${entry.commits} ${entry.commits === 1 ? "graft" : "grafts"}${
      typeof entry.prUrl === "string" && entry.prUrl.length > 0 ? " · ⬆ PR open" : ""
    }`;

  // No "graft" slot and no lane slots: the record-a-change toggle and the
  // concept-mock buttons are gone from the generalized tree (above), so the
  // radial layout must not reserve arc positions for chips nothing renders —
  // that would leave holes in the ring.
  const present: TendChipId[] = ["identity", "close", "remove"];
  if (execution !== null) {
    present.push("settled");
  }
  if (onOpenBrief !== undefined) {
    present.push("brief");
  }
  if (liveOpenable) {
    present.push("live");
  }
  if (model.hasDeck) {
    present.push("deck");
  }
  if (model.adopted) {
    if (treeFocus !== null) {
      present.push("focus");
    } else {
      present.push("branches-head");
      if (treeBranches.length === 0) {
        present.push("empty");
      } else {
        for (let index = 0; index < treePaged.slice.length; index += 1) {
          present.push(`branch-${index}` as TendChipId);
        }
        if (treePaged.pages > 1) {
          present.push("pager");
        }
      }
    }
    present.push("grow");
  }
  if (tendNote !== null) {
    present.push("note");
  }
  if (tendError !== null) {
    present.push("error");
  }
  if (onReplant !== undefined) {
    present.push("replant");
  }
  if (model.published !== null) {
    present.push("qr");
  }
  const layout = tendChipLayout(anchor, viewport, { gesture: gestureWall, present });
  const chipStyle = (id: TendChipId): CSSProperties => tendChipStyle(id, layout, viewport, gestureWall);
  const stopClicks = (clickEvent: ReactMouseEvent<HTMLElement>): void => clickEvent.stopPropagation();

  return (
    <section
      className={`tree-tend tree-tend-constellation stage-${model.stage}`}
      data-testid="tree-menu"
      data-upid={process.upid}
      data-stage={model.stage}
      data-self="false"
      role="dialog"
      aria-label={`Tree controls for ${model.callsign}`}
    >
      {/* IDENTITY plate — crowns the verb arc. */}
      <div
        className="tend-chip tend-chip-identity"
        data-chip="identity"
        data-dwell-shield="1"
        style={chipStyle("identity")}
        onClick={stopClicks}
      >
        <div className="tree-menu-identity">
          <span className="tree-menu-eyebrow">
            {model.stage === "commissioned" ? "🌳 commissioned" : "🌱 concept"}
          </span>
          <h2 className="tree-menu-title" data-testid="tree-menu-title">
            {model.title}
          </h2>
          <span className="tree-menu-callsign" data-testid="tree-menu-callsign">
            {model.callsign}
          </span>
          <span className={`tree-menu-status state-${process.state}`} data-testid="tree-menu-status">
            {model.statusLine}
          </span>
        </div>
      </div>

      {/* ✕ — crowns the leaf arc; a real enabled button (dwell-native). */}
      <button
        type="button"
        className="tend-chip tend-chip-close ctl-button tree-menu-close"
        data-chip="close"
        data-testid="tree-menu-close"
        style={chipStyle("close")}
        onClick={onClose}
        title="Close this tree's menu"
      >
        ✕
      </button>

      {/* NO CONCEPT-LANE CHIPS, at the operator's request. Each ready lane
          was a button into that backend's MOCK deck — furniture from the
          guided demo's race. The lane data still rides the model for anything
          that wants it; nothing on this menu opens a mock any more. */}

      {/* Commission-stage telemetry (reused chip: executing → BUILT + link). */}
      {execution !== null ? (
        <div
          className="tend-chip tend-chip-settled"
          data-chip="settled"
          data-dwell-shield="1"
          style={chipStyle("settled")}
          onClick={stopClicks}
        >
          <ExecutionChip execution={execution} />
        </div>
      ) : null}

      {/* 📖 ABOUT THIS PROJECT: for an import the room STUDIED rather than
          built — shown only when a study actually exists behind it (App
          probes the brief route and passes the handler in). */}
      {onOpenBrief !== undefined ? (
        <div
          className="tend-chip tend-chip-brief"
          data-chip="brief"
          data-dwell-shield="1"
          style={chipStyle("brief")}
          onClick={stopClicks}
        >
          <TendVerb
            testid="tree-menu-brief"
            className="verb-press"
            line1="📖 about this project"
            line2="what the room learned reading it ▸"
            title="What the room learned reading this repository — nothing has been built."
            onPress={() => onOpenBrief(process.upid)}
          />
        </div>
      ) : null}

      {/* 🌐 LIVE APP: the import's confirmed deployment OR a finished build's
          served preview — one press opens the holo panel beside the tree. */}
      {liveOpenable ? (
        <div
          className="tend-chip tend-chip-live"
          data-chip="live"
          data-dwell-shield="1"
          style={chipStyle("live")}
          onClick={stopClicks}
        >
          <TendVerb
            testid="tree-menu-live"
            className="verb-climb"
            line1="🌐 live app"
            line2="open it beside this tree ▸"
            title={`Open the live app (${model.deployUrl ?? execution?.previewUrl ?? ""}) on a holo panel beside this tree.`}
            onPress={() => onOpenLiveApp?.(process.upid)}
          />
        </div>
      ) : null}

      {/* Both generated and fixture decks have a stable entry point. */}
      {model.hasDeck ? (
        <div
          className="tend-chip tend-chip-deck"
          data-chip="deck"
          data-dwell-shield="1"
          style={chipStyle("deck")}
          onClick={stopClicks}
        >
          <TendVerb
            testid="tree-menu-deck"
            className="verb-press"
            line1="🎞 deck"
            line2="open this project's slideshow ▸"
            title="Open this project's slideshow deck."
            onPress={() => onOpenDeck(process.upid)}
          />
        </div>
      ) : null}

      {/* NO RECORD-A-CHANGE TOGGLE HERE, at the operator's request. On a
          fleet tree the words went into a mock revision — not a change anyone
          can point at afterwards. Voice steering lives where it commits
          somewhere nameable: the SELF tree, and a branch card. */}

      {/* 🗑 REMOVE roots the whole verb arc — two-stage confirm on the FLEET
          budget (DISMISS_CONFIRM_MS, a single-question flow; no drain bar —
          the drain draws the 10s tend window, and this window is 4s). */}
      <div
        className="tend-chip tend-chip-remove"
        data-chip="remove"
        data-dwell-shield="1"
        style={chipStyle("remove")}
        onClick={stopClicks}
      >
        {dismissArmed ? (
          <TendVerb
            testid="tree-menu-remove-confirm"
            className="verb-prune is-armed-danger"
            line1="really remove?"
            line2="stops this project's builds and takes the tree off the wall"
            title="Really remove: stop this project's builds and take its tree off the wall."
            onPress={() => onDismiss(process.upid)}
          />
        ) : (
          <TendVerb
            testid="tree-menu-remove"
            className="verb-prune"
            line1="🗑 remove"
            line2="stops its builds — asks once more"
            title="Remove this project (asks once more): stops its builds and removes it from the wall. Never touches GitHub or files outside the build bookkeeping."
            onPress={(event) => {
              stampPressed(event);
              setDismissArmed(true);
            }}
          />
        )}
      </div>

      {/* ── ADOPTED TREES: the room/* rails as leaf-chips, tended in the same
          words as the room's own — with the verbs the clone substrate really
          backs (graft / open PR / merge; no prune rail exists there). ── */}
      {model.adopted && treeFocus !== null ? (
        <div
          className="tend-chip tend-chip-focus"
          data-chip="focus"
          data-dwell-shield="1"
          style={chipStyle("focus")}
          onClick={stopClicks}
        >
          <div className="tree-branch-focus">
            <button
              type="button"
              className="ctl-button tree-branch-back"
              data-testid="tree-menu-version-back"
              title="Back to the branch list."
              onClick={() => {
                setFocusBranch(null);
                setArmed(null);
                setTendError(null);
              }}
            >
              ◂ back to branches
            </button>
            <div
              className="tree-branch-card is-open"
              data-testid="tree-menu-version"
              data-branch={treeFocus.name}
              data-open="true"
            >
              <span className="tree-branch-subject">🌿 {deslugBranch(treeFocus.name)}</span>
              <span className="tree-branch-slug">{branchSubLine(treeFocus, treeBranches.indexOf(treeFocus))}</span>
            </div>
            <div className="tree-branch-verbs" data-testid="tree-menu-version-actions">
              {busy?.verb === "graft" && busy.branch === treeFocus.name ? (
                <TendVerb testid="tree-menu-branch-graft" className="verb-merge" line1="🌱 grafting…" line2="arming the record onto this branch" disabled onPress={() => undefined} />
              ) : (
                <TendVerb
                  testid="tree-menu-branch-graft"
                  className="verb-merge"
                  line1="🌱 graft onto this branch"
                  line2="your next spoken change grows here"
                  title="Route the next spoken change onto THIS branch — the record starts armed here."
                  disabled={anyBusy}
                  onPress={(event) => {
                    stampPressed(event);
                    graftOntoBranchVerb(treeFocus.name);
                  }}
                />
              )}
              {busy?.verb === "pr" && busy.branch === treeFocus.name ? (
                <TendVerb testid="tree-menu-branch-pr" className="verb-climb" line1="⬆ opening PR…" line2="pushing the branch to the origin" disabled onPress={() => undefined} />
              ) : (
                <TendVerb
                  testid="tree-menu-branch-pr"
                  className="verb-climb"
                  line1="⬆ open PR"
                  line2="its spoken changes → a real PR on the origin"
                  title="Commit this branch's spoken changes, push it, and open (or return) its PR against the origin."
                  disabled={anyBusy}
                  onPress={(event) => {
                    stampPressed(event);
                    prVerb(treeFocus.name);
                  }}
                />
              )}
              {busy?.verb === "merge" && busy.branch === treeFocus.name ? (
                <TendVerb testid="tree-menu-branch-merge" className="verb-merge" line1="🪵 merging…" line2="into the origin's trunk (main)" disabled onPress={() => undefined} />
              ) : armed === `treemerge:${treeFocus.name}` ? (
                <TendVerb
                  testid="tree-menu-branch-merge-confirm"
                  className="verb-merge is-armed-caution"
                  line1="make it permanent?"
                  line2="squash-merges this branch's PR into the origin's main — needs its PR open"
                  title="Second press merges for real. It needs the branch's open PR — a refusal shows right here."
                  armedKey={`treemerge:${treeFocus.name}`}
                  disabled={anyBusy}
                  onPress={(event) => {
                    stampPressed(event);
                    mergeAdoptedVerb(treeFocus.name);
                  }}
                />
              ) : (
                <TendVerb
                  testid="tree-menu-branch-merge"
                  className="verb-merge"
                  line1="🪵 into the trunk"
                  line2="merge its PR into the origin's main"
                  title="Squash-merge this branch's open PR into the origin's main — asks once more."
                  disabled={anyBusy}
                  onPress={(event) => {
                    stampPressed(event);
                    setArmed(`treemerge:${treeFocus.name}`);
                    setTendError(null);
                  }}
                />
              )}
            </div>
          </div>
        </div>
      ) : model.adopted ? (
        /* ── LEAF ARC: heading + stationary leaf-chips + pager. ── */
        <>
          <div
            className="tend-chip tend-chip-branches-head"
            data-chip="branches-head"
            data-dwell-shield="1"
            style={chipStyle("branches-head")}
            onClick={stopClicks}
          >
            <span className="tree-branches-head">🌿 branches · {treeBranches.length} grown</span>
          </div>
          {treeBranches.length === 0 ? (
            <div
              className="tend-chip tend-chip-empty"
              data-chip="empty"
              data-dwell-shield="1"
              style={chipStyle("empty")}
              onClick={stopClicks}
            >
              <p className="tree-tend-reading">no branches yet — 🌱 grow one to start a change</p>
            </div>
          ) : (
            <>
              {treePaged.slice.map((entry, index) => (
                <div
                  key={entry.name}
                  className="tend-chip tend-chip-branch"
                  data-chip={`branch-${index}`}
                  data-dwell-shield="1"
                  style={chipStyle(`branch-${index}` as TendChipId)}
                  onClick={stopClicks}
                >
                  <div
                    className="tree-branch-card"
                    data-testid="tree-menu-version"
                    data-branch={entry.name}
                    data-open="false"
                  >
                    <button
                      type="button"
                      className="tree-branch-head"
                      data-testid="tree-menu-version-head"
                      title="tend this branch — graft onto it, open its PR, or merge it."
                      onClick={(event) => {
                        stampPressed(event);
                        setFocusBranch(entry.name);
                        setArmed(null);
                        setTendError(null);
                      }}
                    >
                      <span className="tree-branch-subject">🌿 {deslugBranch(entry.name)}</span>
                      <span className="tree-branch-slug">{branchSubLine(entry, treeBranches.indexOf(entry))}</span>
                    </button>
                  </div>
                </div>
              ))}
              {treePaged.pages > 1 ? (
                <div
                  className="tend-chip tend-chip-pager"
                  data-chip="pager"
                  data-dwell-shield="1"
                  style={chipStyle("pager")}
                  onClick={stopClicks}
                >
                  <div className="tree-branch-pager" data-testid="tree-menu-branch-pager">
                    <button
                      type="button"
                      className="ctl-button tree-branch-page-btn"
                      data-testid="tree-menu-page-newer"
                      data-at-limit={treePaged.page === 0 ? "1" : undefined}
                      title="Newer branches."
                      onClick={() => {
                        if (treePaged.page > 0) {
                          setPage(treePaged.page - 1);
                          setArmed(null);
                          setTendError(null);
                        }
                      }}
                    >
                      ▲ newer
                    </button>
                    <span className="tree-branch-page-status" data-testid="tree-menu-page-status">
                      page {treePaged.page + 1}/{treePaged.pages}
                    </span>
                    <button
                      type="button"
                      className="ctl-button tree-branch-page-btn"
                      data-testid="tree-menu-page-older"
                      data-at-limit={treePaged.page >= treePaged.pages - 1 ? "1" : undefined}
                      title="Older branches."
                      onClick={() => {
                        if (treePaged.page < treePaged.pages - 1) {
                          setPage(treePaged.page + 1);
                          setArmed(null);
                          setTendError(null);
                        }
                      }}
                    >
                      ⌄ older
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </>
      ) : null}

      {/* 🌱 GROW A BRANCH (adopted trees) — press, SAY WHAT THE BRANCH IS FOR,
          press again: the room cuts a new room/* limb named from those words
          and grows the change on it. The same recording surface the self tree
          and the branch cards use (its sibling verb "🌱 Graft onto this
          branch" records onto an EXISTING limb); the receipt lives on the card
          itself, so a refusal is read where the press happened. */}
      {model.adopted ? (
        <div className="tend-chip tend-chip-grow" data-chip="grow" data-dwell-shield="1" style={chipStyle("grow")} onClick={stopClicks}>
          {/* The chip's name rides the BUTTON, not this wrapper: the wrapper's
              only handler stops click propagation, so an id on it named a
              thing nobody can press — and would keep passing over a chip
              whose button had gone missing. */}
          <RecordSteerToggle
            process={process}
            kind="grow"
            pressTestId="tree-menu-grow"
            transcript={snapshot.transcript}
            landing={snapshot.steerLanding ?? null}
          />
        </div>
      ) : null}

      {/* Honest receipts — fixed slots under the trunk. */}
      {tendNote !== null ? (
        <div
          className="tend-chip tend-chip-note"
          data-chip="note"
          data-dwell-shield="1"
          style={chipStyle("note")}
          onClick={stopClicks}
        >
          <p className="tree-tend-note" data-testid="tree-menu-tend-note">
            {tendNote}
          </p>
        </div>
      ) : null}
      {tendError !== null ? (
        <div
          className="tend-chip tend-chip-error"
          data-chip="error"
          data-dwell-shield="1"
          style={chipStyle("error")}
          onClick={stopClicks}
        >
          <span className="tree-menu-version-error" data-testid="tree-menu-version-error">
            {tendError}
          </span>
        </div>
      ) : null}

      {/* ⚘ REPLANT rests at the roots: choose a new ground spot. */}
      {onReplant !== undefined ? (
        <div
          className="tend-chip tend-chip-replant"
          data-chip="replant"
          data-dwell-shield="1"
          style={chipStyle("replant")}
          onClick={stopClicks}
        >
          <TendVerb
            testid="tree-menu-replant"
            className="verb-press"
            line1="⚘ replant…"
            line2="choose a new spot on the ground"
            title="Choose a new spot for this tree — click the ground where it should grow (Esc cancels)."
            onPress={() => onReplant(process.upid)}
          />
        </div>
      ) : null}

      {/* Take-home QR (folded in from the old fleet card — the rail is gone). */}
      {model.published !== null ? (
        <div
          className="tend-chip tend-chip-qr"
          data-chip="qr"
          data-dwell-shield="1"
          style={chipStyle("qr")}
          onClick={stopClicks}
        >
          <TakeHomeQr url={model.published.url} qrSvg={model.published.qrSvg} size="card" />
        </div>
      ) : null}
    </section>
  );
}
