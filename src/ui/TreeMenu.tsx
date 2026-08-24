import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { ProjectorProcess, ProjectorSnapshot } from "./types";
import type { SceneDwellRect } from "./gesture/scene-source";
import { tendChipLayout, tendChipSize, type TendChipId } from "./tend-radial";
import { laneStatusLabel, processLanes, type GuidedLane } from "./guided/machine";
import { executionOf, stageOf, type ProcessStage } from "./stage";
import { ExecutionChip } from "./BuildChips";
import { RecordSteerToggle } from "./RecordSteerToggle";
import {
  haltSelfRun,
  loadSelfVersion,
  manageSelfVersion,
  useSelfBranches,
  type SelfBranchesPayload,
} from "./self-repo";
import { TakeHomeQr } from "./TakeHomeQr";
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
 *   - concept lanes via the SHARED processLanes derivation (guided/machine.ts):
 *     a ready lane's row is a button opening that backend's deck; a building
 *     lane is an honest status row with the live percent — never a dead button.
 *   - steer: the RecordSteerToggle — press to route EVERYTHING spoken into
 *     this process (select), press again to stop (select/clear). No typing.
 *   - 🗑 remove with a TWO-STAGE confirm (second dwell within ~4s) → POST
 *     /api/process/:upid/dismiss (stops builds + removes from the snapshot).
 *
 * THE SELF TREE gets "TEND THE TREE" instead — a CONSTELLATION OF CHIPS, no
 * panel, no container (the two-column glass slab hid the garden and never
 * framed the tree it tended — live-room verdict). Every verb and every branch
 * row is its OWN floating glass chip in ONE plant vocabulary (branch = the
 * git word AND the plant word; main = the trunk), positioned by
 * tendChipLayout (tend-radial.ts) around the tree's projected anchor rect:
 * GRAFT roots the verb arc at the base, the GROWING card (+ ✂ stop growing)
 * sits beside it, the 🌳 you-are-here trunk verbs at mid-height, and the
 * grown branches hang as leaf-chips on the opposite arc — dwell-PAGINATED
 * four at a time (no CSS scroll, ever) with a per-branch FOCUS chip among
 * the limbs carrying the 2×2 verb grid (climb/merge/press/prune). The chips
 * re-project as the tree sways (the App's 1 Hz anchor chase + 240ms CSS
 * glide — the halo idiom), and the garden stays visible between them.
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

// useLayoutEffect measures before paint in the browser; on the server (the
// SSR unit tests render with renderToStaticMarkup) it downgrades to useEffect
// to keep React quiet — the nominal-size placement is the SSR answer anyway.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface TreeMenuPlacement {
  left: number;
  top: number;
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
    statusLine: `${process.state} · ${Math.round(process.progress)}%${
      process.progressLabel.length > 0 ? ` · ${process.progressLabel}` : ""
    }`,
    // The MIRROR runs durable self-runs, never concept lanes — roster-derived
    // "queued…" rows on the room's own tree read as dead deck buttons from
    // projector distance (live-room report). Its real telemetry is the
    // ExecutionChip / growing card below.
    lanes: isSelf ? [] : processLanes(process, snapshot),
    isSelf,
    hasFixtureDeck: (process.slides?.length ?? 0) > 0,
    published:
      typeof process.publishedUrl === "string" &&
      process.publishedUrl.length > 0 &&
      typeof process.publishedQrSvg === "string"
        ? { url: process.publishedUrl, qrSvg: process.publishedQrSvg }
        : null,
    deployUrl: typeof process.deployUrl === "string" && process.deployUrl.length > 0 ? process.deployUrl : null,
    adopted:
      !isSelf && typeof process.treeRepo?.remoteUrl === "string" && process.treeRepo.remoteUrl.length > 0,
  };
}

// A tend verb in flight: which verb and on which branch (null = the here-card
// / the growing run). One at a time — every verb button disables while busy.
// A prune carries its chosen `scope` so the busy line can say what the wait
// actually is ("removing the graft everywhere…" is a longer cut).
interface TendBusy {
  verb: "climb" | "merge" | "press" | "prune" | "stop";
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
  // GROW A BRANCH (adopted trees only): POST /api/process/:upid/branch — the
  // App fires it and closes the menu; the new limb appears via the snapshot.
  // Absent = the row never renders.
  onGrowBranch?: (upid: string) => void;
  // SSR/test seam for the self tree's rails (the effect-free static renderer
  // cannot fetch /api/self/branches) — the live wall leaves this undefined.
  selfBranches?: SelfBranchesPayload | null;
  // SSR/test seam for the tend surface's interaction states (the static
  // renderer cannot dwell): boots the body in a focus view / with a verb
  // armed / on a later page / mid-verb (busy). The live wall leaves this
  // undefined.
  tendSeed?: { focusBranch?: string; armed?: string; page?: number; busy?: TendBusy };
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
  onOpenLiveApp,
  onGrowBranch,
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
  // REAL-SIZE PLACEMENT: measure the rendered panel (CSS decides the true
  // footprint — gesture mode widens it) and re-place from that. The measure
  // runs pre-paint (layout effect), so the nominal-size first pass is never
  // visible; the guarded setState bails once the size settles, so this cannot
  // loop. Re-measured every render because the CONTENT changes size too
  // (lanes appear, verbs arm, QR lands).
  const panelRef = useRef<HTMLElement | null>(null);
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null);
  useIsomorphicLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const rect = panel.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    setMeasured((current) =>
      current !== null && Math.abs(current.width - rect.width) < 1 && Math.abs(current.height - rect.height) < 1
        ? current
        : { width: rect.width, height: rect.height },
    );
  });
  // Placement feeds the NON-SELF panel only — the self tree's constellation
  // (below) positions per-chip via tendChipLayout instead. The SELF width
  // exports remain the pure placement contract for tests/callers.
  const placement = treeMenuPlacement(anchor, viewport, measured ?? undefined);

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
  const [tendError, setTendError] = useState<string | null>(null);
  const [tendNote, setTendNote] = useState<string | null>(null);
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
    void manageSelfVersion(branch, action, scope).then((result) => {
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
    void loadSelfVersion(branch).then((result) => {
      if (result.ok) {
        return; // the room is rebuilding onto the branch — this window reloads
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
    void haltSelfRun().then((result) => {
      setBusy(null);
      if (result.ok) {
        setHaltNote(result.halted ? "✂ stopped — the branch keeps what grew" : "nothing growing — it already finished");
      } else {
        setHaltNote(result.error);
        onControlFailure?.("stop growing", result.status);
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
    // Gesture-XL chips take wider nominal footprints; the wall sets the class
    // on <main> (App), so the component reads it rather than growing a prop.
    const gestureWall = typeof document !== "undefined" && document.querySelector("main.gesture-mode") !== null;
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
    const chipStyle = (id: TendChipId): CSSProperties => {
      const size = tendChipSize(id, gestureWall);
      const pos = layout[id] ?? { left: viewport.width - size.width - 16, top: 16 };
      return { left: `${Math.round(pos.left)}px`, top: `${Math.round(pos.top)}px`, width: `${size.width}px` };
    };
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
            <RecordSteerToggle process={process} kind="room" transcript={snapshot.transcript} />
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

  return (
    <section
      ref={panelRef}
      className={`tree-menu stage-${model.stage}`}
      data-testid="tree-menu"
      data-upid={process.upid}
      data-stage={model.stage}
      data-self="false"
      // Dwell-miss dismissal shield (popup-dismiss.ts): the panel's WHOLE rect
      // counts as on-target ground, so a cursor reading the title/status/lane
      // rows/QR — none of which are dwell targets — never closes the menu.
      data-dwell-shield="1"
      role="dialog"
      aria-label={`Tree controls for ${model.callsign}`}
      style={{ left: `${Math.round(placement.left)}px`, top: `${Math.round(placement.top)}px` }}
      onClick={(clickEvent) => clickEvent.stopPropagation()}
    >
      <header className="tree-menu-head">
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
        <button
          type="button"
          className="ctl-button tree-menu-close"
          data-testid="tree-menu-close"
          onClick={onClose}
          title="Close this tree's menu"
        >
          ✕
        </button>
      </header>

      {/* Commission-stage telemetry (reused chip: executing → BUILT + link).
          The SELF tree early-returned above with its own settled/growing chip
          slots — same data, no duplication. */}
      {execution !== null ? <ExecutionChip execution={execution} /> : null}

      <>
          {/* CONCEPT LANES (shared derivation with the guided demo's race): a
              ready lane is a real button into that backend's deck; a building/
              queued/failed lane is an honest status row — the percent shows,
              and there is no dead button pretending otherwise. */}
          {model.lanes.length > 0 ? (
            <div className="tree-menu-lanes" data-testid="tree-menu-lanes">
              {model.lanes.map((lane) =>
                lane.status === "ready" && (lane.hasDeck || lane.previewUrl !== null) ? (
                  <button
                    key={lane.id}
                    type="button"
                    className="tree-menu-lane lane-ready"
                    data-testid="tree-menu-lane"
                    data-backend={lane.id}
                    data-status={lane.status}
                    title={`Open the deck window on the ${lane.label} result.`}
                    onClick={() => onOpenDeck(process.upid, lane.id)}
                  >
                    <span className="tree-lane-label">{lane.label}</span>
                    <span className="tree-lane-status">{laneStatusLabel(lane)}</span>
                    <span className="tree-lane-open">View ▸</span>
                  </button>
                ) : (
                  <div
                    key={lane.id}
                    className={`tree-menu-lane lane-${lane.status}`}
                    data-testid="tree-menu-lane"
                    data-backend={lane.id}
                    data-status={lane.status}
                    title={lane.summary ?? undefined}
                  >
                    <span className="tree-lane-label">{lane.label}</span>
                    <span className="tree-lane-status">{laneStatusLabel(lane)}</span>
                  </div>
                ),
              )}
            </div>
          ) : null}

          {/* 🌐 LIVE APP: an imported tree's confirmed deployment (deployUrl)
              OR a commissioned build that finished — the execution lane's
              served full-app preview. Either way one press opens the holo
              panel beside the tree (the App swaps this menu out). This is the
              loop's promised ending, dwell-reachable — never a mouse-only
              link. */}
          {(model.deployUrl !== null || (execution?.status === "built" && execution.previewUrl !== null)) &&
          onOpenLiveApp !== undefined ? (
            <button
              type="button"
              className="ctl-button tree-menu-live"
              data-testid="tree-menu-live"
              title={`Open the live app (${model.deployUrl ?? execution?.previewUrl ?? ""}) on a holo panel beside this tree.`}
              onClick={() => onOpenLiveApp(process.upid)}
            >
              🌐 Live app ▸
            </button>
          ) : null}

          {/* 🌱 GROW A BRANCH (adopted trees only): one press names a real room/*
              rail off the freshly fetched origin tip; the menu closes and the new
              LIMB grows on the tree within a snapshot tick. */}
          {model.adopted && onGrowBranch !== undefined ? (
            <button
              type="button"
              className="ctl-button tree-menu-grow"
              data-testid="tree-menu-grow"
              title="Grow a real branch (room/spoken-changes) on this import's repo — it appears as a limb on the tree."
              onClick={() => onGrowBranch(process.upid)}
            >
              🌱 Grow a branch ▸
            </button>
          ) : null}

          {/* Fixture decks (mock room) keep their one-press open. */}
          {model.hasFixtureDeck ? (
            <button
              type="button"
              className="ctl-button tree-menu-deck"
              data-testid="tree-menu-deck"
              title="Open this project's slideshow deck."
              onClick={() => onOpenDeck(process.upid)}
            >
              🎞 Deck ▸
            </button>
          ) : null}

          {/* STEER = the record toggle, nothing typed (live-room directive). The
              lit state rides the snapshot's steering flag, so the button shows the
              honest truth about where spoken words are going. */}
          <div className="tree-menu-steer" data-testid="tree-menu-steer">
            <RecordSteerToggle process={process} kind="build" transcript={snapshot.transcript} />
          </div>
      </>

      {/* Take-home QR (folded in from the old fleet card — the rail is gone). */}
      {model.published !== null ? (
        <TakeHomeQr url={model.published.url} qrSvg={model.published.qrSvg} size="card" />
      ) : null}

      {/* 🗑 REMOVE (never for the self tree — it early-returned above):
          two-stage confirm on the FLEET budget (DISMISS_CONFIRM_MS — a
          single-question flow, unlike the prune's two); the second press
          stops this project's builds and removes it from the snapshot —
          builds bookkeeping only, nothing beyond the room. */}
      {dismissArmed ? (
        <button
          type="button"
          className="ctl-button tree-menu-remove is-armed"
          data-testid="tree-menu-remove-confirm"
          title="Really remove: stop this project's builds and take its tree off the wall."
          onClick={() => onDismiss(process.upid)}
        >
          really remove?
        </button>
      ) : (
        <button
          type="button"
          className="ctl-button tree-menu-remove"
          data-testid="tree-menu-remove"
          title="Remove this project (asks once more): stops its builds and removes it from the wall. Never touches GitHub or files outside the build bookkeeping."
          onClick={() => setDismissArmed(true)}
        >
          🗑 remove
        </button>
      )}
    </section>
  );
}
