import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { ProjectorProcess, ProjectorSnapshot } from "./types";
import type { SceneDwellRect } from "./gesture/scene-source";
import { laneStatusLabel, processLanes, type GuidedLane } from "./guided/machine";
import { executionOf, stageOf, type ProcessStage } from "./stage";
import { ExecutionChip } from "./BuildChips";
import { TakeHomeQr } from "./TakeHomeQr";
import "./TreeMenu.css";

/**
 * Tree menu — the per-tree control surface, anchored beside the picked tree.
 *
 * THE TREE IS THE INTERFACE: the fleet rail is gone from the walls, so
 * click/dwell-picking a garden tree opens THIS panel right next to it. It
 * re-derives its position from the pick-time anchor (the tree's screen-
 * projected dwell rect — RoomScene passes it through onSelectProcess) and
 * clamps to the viewport WITHOUT covering the tree; it does not chase the
 * tree frame-by-frame. Every control is a plain enabled <button> at
 * gesture-mode sizes, so GestureLayer's collectDomTargets makes the whole
 * menu dwell-native automatically.
 *
 * Contents (reuse before reinvent — the guided demo already solved these):
 *   - header: inferred project title / callsign / state·progress line + ✕.
 *   - concept lanes via the SHARED processLanes derivation (guided/machine.ts):
 *     a ready lane's row is a button opening that backend's deck; a building
 *     lane is an honest status row with the live percent — never a dead button.
 *   - steer: picking the tree already POSTed /api/process/:upid/select, so the
 *     menu SAYS the tree is steer-armed and offers the typed steer input (the
 *     same contract as the deck's iterate bar → POST /api/process/:upid/steer).
 *   - 🗑 remove with a TWO-STAGE confirm (second dwell within ~4s) → POST
 *     /api/process/:upid/dismiss (stops builds + removes from the snapshot).
 *   - the SELF/mirror tree gets the same shape with "the room" flavor and NO
 *     remove button — the room must not dismiss itself.
 */

// The remove confirm window: the second press must land within this budget or
// the button falls back to its resting stage (a wandering dwell cursor four
// seconds later must not delete a build).
export const DISMISS_CONFIRM_MS = 4_000;

// Placement geometry (desk-mode footprint; gesture mode scales the CONTENT,
// the panel clamps the same way). Estimated height: placement must be pure +
// SSR-safe, so it works from a nominal size instead of a DOM measurement.
export const TREE_MENU_WIDTH = 440;
export const TREE_MENU_EST_HEIGHT = 560;
const MENU_GAP = 18;
const VIEWPORT_MARGIN = 16;

export interface TreeMenuPlacement {
  left: number;
  top: number;
}

// Pure: where the panel opens. Prefers the side of the anchor rect with room
// (right first — labels read left-to-right), so the menu never covers the tree
// it belongs to; everything clamps inside the viewport margins. A null anchor
// (projection unavailable / keyboard select) rests against the right edge.
export function treeMenuPlacement(
  anchor: SceneDwellRect | null,
  viewport: { width: number; height: number },
  menu: { width: number; height: number } = { width: TREE_MENU_WIDTH, height: TREE_MENU_EST_HEIGHT },
): TreeMenuPlacement {
  const clampTop = (top: number): number =>
    Math.min(Math.max(VIEWPORT_MARGIN, top), Math.max(VIEWPORT_MARGIN, viewport.height - menu.height - VIEWPORT_MARGIN));
  if (anchor === null) {
    return {
      left: Math.max(VIEWPORT_MARGIN, viewport.width - menu.width - VIEWPORT_MARGIN),
      top: clampTop((viewport.height - menu.height) / 2),
    };
  }
  const rightOf = anchor.left + anchor.width + MENU_GAP;
  const leftOf = anchor.left - MENU_GAP - menu.width;
  let left: number;
  if (rightOf + menu.width <= viewport.width - VIEWPORT_MARGIN) {
    left = rightOf;
  } else if (leftOf >= VIEWPORT_MARGIN) {
    left = leftOf;
  } else {
    // Neither side fits fully (tree fills the frame): clamp toward the right
    // edge — partial overlap beats an off-screen panel.
    left = Math.min(Math.max(VIEWPORT_MARGIN, rightOf), Math.max(VIEWPORT_MARGIN, viewport.width - menu.width - VIEWPORT_MARGIN));
  }
  return { left, top: clampTop(anchor.top + anchor.height / 2 - menu.height / 2) };
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
  // The existing typed-steer path (same handler as the deck's iterate bar).
  onSteer: (text: string) => void;
  // POST /api/process/:upid/dismiss — only reachable through the two-stage
  // confirm, and never rendered for the self tree.
  onDismiss: (upid: string) => void;
}

export function TreeMenu({ process, snapshot, anchor, onClose, onOpenDeck, onSteer, onDismiss }: TreeMenuProps) {
  const model = treeMenuModel(process, snapshot);
  const execution = executionOf(process);
  // Re-derived per render — the anchor prop only changes on a fresh pick, so
  // the panel holds still between picks (no frame-by-frame tracking).
  const viewport =
    typeof window !== "undefined"
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 1920, height: 1080 };
  const placement = treeMenuPlacement(anchor, viewport);

  // Typed steer (mirrors the deck's iterate bar contract).
  const [steerText, setSteerText] = useState("");
  const [steerSent, setSteerSent] = useState(false);
  const submitSteer = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const text = steerText.trim();
      if (text.length === 0) {
        return;
      }
      onSteer(text);
      setSteerText("");
      setSteerSent(true);
    },
    [steerText, onSteer],
  );

  // TWO-STAGE remove: the first press arms "really remove?"; it disarms by
  // itself after DISMISS_CONFIRM_MS. Both stages reset when the menu moves to
  // another tree so a stale confirm can never delete the wrong build.
  const [dismissArmed, setDismissArmed] = useState(false);
  useEffect(() => {
    setDismissArmed(false);
    setSteerText("");
    setSteerSent(false);
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
      className={`tree-menu stage-${model.stage}`}
      data-testid="tree-menu"
      data-upid={process.upid}
      data-stage={model.stage}
      data-self={model.isSelf ? "true" : "false"}
      role="dialog"
      aria-label={`Tree controls for ${model.callsign}`}
      style={{ left: `${Math.round(placement.left)}px`, top: `${Math.round(placement.top)}px` }}
      onClick={(clickEvent) => clickEvent.stopPropagation()}
    >
      <header className="tree-menu-head">
        <div className="tree-menu-identity">
          <span className="tree-menu-eyebrow">
            {model.isSelf ? "🪞 the room" : model.stage === "commissioned" ? "🌳 commissioned" : "🌱 concept"}
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

      {/* STEER: picking the tree already POSTed the select, so this is honest —
          the room routes speech here now; the input is the typed parallel. */}
      <div className="tree-menu-steer" data-testid="tree-menu-steer">
        <span className="tree-menu-steer-note">
          {model.isSelf ? "🎙 talking changes the room — this tree is steer-armed" : "🎙 talking steers this build now"}
        </span>
        <form className="tree-menu-steer-form" onSubmit={submitSteer}>
          <input
            className="tree-menu-steer-input"
            data-testid="tree-menu-steer-input"
            type="text"
            value={steerText}
            onChange={(changeEvent) => {
              setSteerText(changeEvent.target.value);
              setSteerSent(false);
            }}
            placeholder={model.isSelf ? "type a change for the room" : "type a change — or just say it out loud"}
            aria-label={model.isSelf ? "Type a change for the room" : "Type a change for this build"}
          />
          <button type="submit" className="ctl-button tree-menu-steer-send" data-testid="tree-menu-steer-send">
            Send
          </button>
        </form>
        {steerSent ? (
          <span className="tree-menu-steer-sent" data-testid="tree-menu-steer-sent" role="status">
            Locked in — the build reshapes with this change
          </span>
        ) : null}
      </div>

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
