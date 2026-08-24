import { useEffect, useRef, useState } from "react";
import { anyLiveCursorOver } from "./gesture/targets";
import type { ReactNode } from "react";

/**
 * CONTROL DOCK — one calm "⚙ Controls" affordance where the always-visible
 * button row used to live (live-room request: the wall should be calm).
 *
 * Resting ANY cursor on the dock button expands a glass popover tray with the
 * full button cluster; the tray then STAYS open until the toggle is clicked
 * (live-room request — no idle timeout). Two hover sources feed the open
 * check (FleetScroll's pattern):
 *
 *   - css :hover        — a desk mouse resting on the dock/tray;
 *   - [data-dwell-hot]  — the attribute GestureLayer stamps per-frame on the
 *                         element a gesture/joystick/guest cursor points at.
 *
 * Keyboard users get expand-on-focus: tabbing into the dock opens the tray
 * (onFocus bubbles), and :focus-visible inside the dock counts as "hot" so the
 * tray stays open while they tab through it.
 *
 * The tray is absolutely positioned (a popover under the dock button), so
 * expanding NEVER reflows the wall layout. While collapsed the tray markup
 * still renders — data-expanded="false" + CSS display:none hide it — which
 * keeps SSR tests simple AND keeps hidden buttons out of dwell targeting
 * (GestureLayer skips zero-size rects). Revealed buttons are plain enabled
 * <button>s, so the dwell selector targets them automatically.
 *
 * NOT in the dock (by design): the emergency banner and the muted room's
 * Unmute button — degraded/alert-state signals must stay visible on the wall,
 * never folded behind a hover.
 */

// DELAYED AUTO-CLOSE (live-room request — "it's a little bit delayed, get out
// of the control"): once the cursor leaves the dock, the tray folds itself
// away after a short grace period instead of staying open forever. Hover/
// dwell-hot re-OPENS it (walk-up discoverability) and cancels a pending close;
// an explicit toggle click still closes immediately.
const IDLE_CLOSE_MS = 1_500;

// Is any cursor "on" the dock? Attribute first (needs no selector engine),
// then :hover on the root (true while the mouse is over ANY descendant), then
// :focus-visible (keyboard focus inside the tray; mouse-clicked buttons do not
// match it, so a stray click can never pin the tray open forever).
function dockIsHot(root: HTMLElement): boolean {
  if (root.hasAttribute("data-dwell-hot") || root.querySelector("[data-dwell-hot]") !== null) {
    return true;
  }
  // A joystick/hands cursor RESTING here counts — it never sets :hover and
  // only sets dwell-hot once acquired, so presence must be checked directly.
  if (anyLiveCursorOver(root.getBoundingClientRect())) {
    return true;
  }
  try {
    if (root.matches(":hover")) {
      return true;
    }
    return root.querySelector(":focus-visible") !== null;
  } catch {
    return false; // selector engine without :hover/:focus-visible (non-browser DOM)
  }
}

export interface ControlDockProps {
  children: ReactNode;
  // Test seam (FleetScroll's initialOverflowing pattern): SSR renders never
  // run the hover-check effect, so tests can boot the tray open. The live app
  // never passes this — expansion is hover/focus-driven.
  initialExpanded?: boolean;
  // COLLAPSE-ON-DEMAND: the App bumps this counter when another glass panel
  // (the tree menu) opens — two glass panels overlapping on the projector
  // reads as broken, so the tray folds away. Hover/dwell re-opens it as usual
  // once the cursor comes back to the dock.
  collapseSignal?: number;
}

export function ControlDock({ children, initialExpanded = false, collapseSignal = 0 }: ControlDockProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(initialExpanded);
  // A mouse click on ⚙ arrives as focus-then-click: the focus handler has
  // just expanded the tray when the click handler runs, and a naive toggle
  // slams it shut in the same gesture — the dock looked click-dead. Remember
  // WHEN focus opened it and let the immediately-following click stand.
  const focusOpenedAtMs = useRef(0);
  // A bumped collapseSignal folds the tray (see the prop doc). Presence never
  // auto-opens (opening is click/dwell only), so no reopen latch is needed.
  useEffect(() => {
    if (collapseSignal > 0) {
      setExpanded(false);
    }
  }, [collapseSignal]);

  // Pending idle-close timer: armed when the dock first goes cold, cleared the
  // moment a cursor comes back so re-entering never triggers a late collapse.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    let raf = 0;
    const frame = () => {
      const root = rootRef.current;
      if (root !== null) {
        if (dockIsHot(root)) {
          // Presence HOLDS an open tray (cancels the idle fold) but never
          // OPENS it — opening is the standard dwell interaction (the dwell
          // ring on ⚙ fires a click) or a real click. Hover-open made the
          // tray spring out at anyone walking a cursor across the corner
          // (live-room report).
          if (closeTimer.current !== null) {
            clearTimeout(closeTimer.current); // cursor back — cancel pending close
            closeTimer.current = null;
          }
        } else {
          // Dock went cold: fold the tray away a little bit delayed.
          if (closeTimer.current === null) {
            closeTimer.current = setTimeout(() => {
              closeTimer.current = null;
              setExpanded(false);
            }, IDLE_CLOSE_MS);
          }
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    };
  }, []);

  return (
    <div
      className="control-dock"
      data-testid="control-dock"
      data-expanded={expanded ? "true" : "false"}
      ref={rootRef}
      // Keyboard path: tabbing to the dock button (or anything inside) expands
      // immediately — React's onFocus bubbles like focusin.
      onFocus={() => {
        setExpanded((open) => {
          if (!open) {
            focusOpenedAtMs.current = Date.now();
          }
          return true;
        });
      }}
    >
      <button
        type="button"
        className="ctl-button dock-toggle"
        data-testid="control-dock-button"
        aria-expanded={expanded}
        aria-label="Room controls — dwell (or click) to unfold them"
        title="Room controls: dwell (or click) to unfold — dwell again to fold. It also folds by itself once you leave."
        // TOGGLE, safely this time. The historical open-then-instant-close
        // bug was hover-open colliding with a toggle click; hover-open is
        // gone (presence only HOLDS, never opens), so a dwell/click on ⚙ now
        // honestly alternates: closed → open, open → closed (live-room ask:
        // dwelling the button again must close the tray). Walking away still
        // idle-folds it.
        onClick={() => {
          if (Date.now() - focusOpenedAtMs.current < 500) {
            return; // the focus of this same gesture already opened it
          }
          setExpanded((open) => !open);
        }}
      >
        ⚙ Controls
      </button>
      <div className="control-dock-tray" data-testid="control-dock-tray">
        {children}
      </div>
    </div>
  );
}
