import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProjectorProcess, ProjectorSnapshot } from "./types";
import type { SceneDwellRect } from "./gesture/scene-source";
import { laneStatusLabel, processLanes, type GuidedLane } from "./guided/machine";
import { executionOf, stageOf, type ProcessStage } from "./stage";
import { ExecutionChip } from "./BuildChips";
import { RecordSteerToggle } from "./RecordSteerToggle";
import { loadSelfVersion, useSelfBranches } from "./self-repo";
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
 *   - the SELF/mirror tree gets the same shape with "the room" flavor and NO
 *     remove button — the room must not dismiss itself.
 */

// The remove confirm window: the second press must land within this budget or
// the button falls back to its resting stage (a wandering dwell cursor four
// seconds later must not delete a build).
export const DISMISS_CONFIRM_MS = 4_000;

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
export const TREE_MENU_EST_HEIGHT = 560;
const MENU_GAP = 18;
const VIEWPORT_MARGIN = 16;

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
    // ExecutionChip below.
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
}

export function TreeMenu({ process, snapshot, anchor, onClose, onOpenDeck, onDismiss, onOpenLiveApp, onGrowBranch }: TreeMenuProps) {
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
  // (lanes appear, remove arms, QR lands).
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
  const placement = treeMenuPlacement(anchor, viewport, measured ?? undefined);

  // VERSIONS (self tree): every record window cuts a room/* branch — these
  // rows load the room to any of them (checkout + supervisor relaunch). The
  // rails and the load POST live in self-repo.ts, shared verbatim with the
  // self tree's branch popup.
  const versions = useSelfBranches(model.isSelf);
  const [loadingVersion, setLoadingVersion] = useState<string | null>(null);
  const loadVersion = (branch: string) => {
    setLoadingVersion(branch);
    void loadSelfVersion(branch);
  };

  // TWO-STAGE remove: the first press arms "really remove?"; it disarms by
  // itself after DISMISS_CONFIRM_MS. Both stages reset when the menu moves to
  // another tree so a stale confirm can never delete the wrong build.
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

  return (
    <section
      ref={panelRef}
      className={`tree-menu stage-${model.stage}`}
      data-testid="tree-menu"
      data-upid={process.upid}
      data-stage={model.stage}
      data-self={model.isSelf ? "true" : "false"}
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
            {model.isSelf ? "🪞 mirror" : model.stage === "commissioned" ? "🌳 commissioned" : "🌱 concept"}
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

      {/* Commission-stage telemetry (reused chip: executing → BUILT + link). */}
      {execution !== null ? <ExecutionChip execution={execution} /> : null}

      {/* CONCEPT LANES (shared derivation with the guided demo's race): a
          ready lane is a real button into that backend's deck; a building/
          queued/failed lane is an honest status row — the percent shows, and
          there is no dead button pretending otherwise. */}
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

      {/* 🌐 LIVE APP (imported trees only): the deploy-resolver confirmed a
          running deployment, so one press opens the holo panel's same-origin
          /salem window right beside the tree (the App swaps this menu out). */}
      {model.deployUrl !== null && onOpenLiveApp !== undefined ? (
        <button
          type="button"
          className="ctl-button tree-menu-live"
          data-testid="tree-menu-live"
          title={`Open the live deployment (${model.deployUrl}) on a holo panel beside this tree.`}
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
        <RecordSteerToggle process={process} kind={model.isSelf ? "room" : "build"} transcript={snapshot.transcript} />
      </div>

      {/* VERSIONS (self tree only): one row per room/* branch — dwell to load
          the room to that version (checkout → rebuild → relaunch). */}
      {model.isSelf && versions !== null && versions.branches.length > 0 ? (
        <div className="tree-menu-versions" data-testid="tree-menu-versions">
          <span className="tree-menu-versions-head">versions · running {versions.current}</span>
          {/* Scroll through every version (not just the first few): the list
              scrolls inside a capped viewport. */}
          <div className="tree-menu-versions-scroll">
            {versions.branches
              .filter((entry) => entry.name !== versions.current)
              .map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  className="ctl-button tree-menu-version"
                  data-testid="tree-menu-version"
                  title={`Load the room to ${entry.name} — rebuilds and relaunches on that branch.`}
                  onClick={() => loadVersion(entry.name)}
                  disabled={loadingVersion !== null}
                >
                  {loadingVersion === entry.name ? "⤵ loading… (the room will reload)" : `⤵ ${entry.name.replace(/^room\//u, "")}`}
                  <span className="tree-menu-version-subject">{entry.subject.replace(/^self: /u, "")}</span>
                </button>
              ))}
          </div>
        </div>
      ) : null}

      {/* Take-home QR (folded in from the old fleet card — the rail is gone). */}
      {model.published !== null ? (
        <TakeHomeQr url={model.published.url} qrSvg={model.published.qrSvg} size="card" />
      ) : null}

      {/* 🗑 REMOVE (never for the self tree): two-stage confirm; the second
          press stops this project's builds and removes it from the snapshot —
          builds bookkeeping only, nothing beyond the room. */}
      {!model.isSelf ? (
        dismissArmed ? (
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
        )
      ) : null}
    </section>
  );
}
