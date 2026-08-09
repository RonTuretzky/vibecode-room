import { useEffect, useRef, useState } from "react";
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

// STICKY TRAY (live-room request): once open, the tray stays open until the
// toggle is clicked again — no idle timeout. Hover/dwell-hot still OPENS it
// (walk-up discoverability); only an explicit click closes.

// Is any cursor "on" the dock? Attribute first (needs no selector engine),
// then :hover on the root (true while the mouse is over ANY descendant), then
// :focus-visible (keyboard focus inside the tray; mouse-clicked buttons do not
// match it, so a stray click can never pin the tray open forever).
function dockIsHot(root: HTMLElement): boolean {
  if (root.hasAttribute("data-dwell-hot") || root.querySelector("[data-dwell-hot]") !== null) {
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
}

export function ControlDock({ children, initialExpanded = false }: ControlDockProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(initialExpanded);
  // Click-to-close latch: after an explicit collapse click, hover must not
  // instantly re-expand (the clicking cursor is still ON the button). Held
  // until the dock goes cold once; then hover-expand works again.
  const holdClosed = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    let raf = 0;
    const frame = () => {
      const root = rootRef.current;
      if (root !== null) {
        if (dockIsHot(root)) {
          if (!holdClosed.current) {
            setExpanded(true); // bails when already true — no re-render churn
          }
        } else {
          holdClosed.current = false; // cursor left — hover may expand again
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className="control-dock"
      data-testid="control-dock"
      data-expanded={expanded ? "true" : "false"}
      ref={rootRef}
      // Keyboard path: tabbing to the dock button (or anything inside) expands
      // immediately — React's onFocus bubbles like focusin.
      onFocus={() => setExpanded(true)}
    >
      <button
        type="button"
        className="ctl-button dock-toggle"
        data-testid="control-dock-button"
        aria-expanded={expanded}
        aria-label="Room controls — rest the cursor here to unfold them"
        title="Room controls: rest the cursor (or hover) here to unfold the full button cluster. It folds away by itself."
        // Toggle: a click (real or dwell-fired ON this button) closes an open
        // tray — deliberate enough, since the cursor is on the toggle, not
        // mid-reach for a tray button. The holdClosed latch stops the hover
        // loop from instantly reopening it under the same cursor.
        onClick={() =>
          setExpanded((open) => {
            if (open) {
              holdClosed.current = true;
              return false;
            }
            return true;
          })
        }
      >
        ⚙ Controls
      </button>
      <div className="control-dock-tray" data-testid="control-dock-tray">
        {children}
      </div>
    </div>
  );
}
