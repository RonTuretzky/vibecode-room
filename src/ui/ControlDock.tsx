import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * CONTROL DOCK — one calm "⚙ Controls" affordance where the always-visible
 * button row used to live (live-room request: the wall should be calm).
 *
 * Resting ANY cursor on the dock button expands a glass popover tray with the
 * full button cluster; the tray folds shut ~4s after every cursor has left the
 * dock. Two hover sources feed the same check (FleetScroll's pattern):
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

// "~4s": long enough that a wandering cursor (or a dwell cursor re-aiming
// between two tray buttons) never sees the tray vanish mid-reach, short enough
// that the wall returns to calm soon after everyone walks away.
export const DOCK_COLLAPSE_MS = 4_000;

// Pure: is the collapse due? sinceHotMs is how long the dock has been cold.
export function dockCollapseDue(sinceHotMs: number): boolean {
  return sinceHotMs > DOCK_COLLAPSE_MS;
}

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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    let raf = 0;
    let lastHot = performance.now();
    const frame = (now: number) => {
      const root = rootRef.current;
      if (root !== null) {
        if (dockIsHot(root)) {
          lastHot = now;
          setExpanded(true); // bails when already true — no re-render churn
        } else if (dockCollapseDue(now - lastHot)) {
          setExpanded(false);
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
        // Expand-only: hover already expanded it for a pointing cursor, and a
        // dwell-synthesized click that COLLAPSED the tray would yank every
        // target out from under the cursor mid-reach. Collapse is the timeout.
        onClick={() => setExpanded(true)}
      >
        ⚙ Controls
      </button>
      <div className="control-dock-tray" data-testid="control-dock-tray">
        {children}
      </div>
    </div>
  );
}
