import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Fleet rail HOVER-SCROLL — ▲/▼ affordances pinned above/below the scrolling
 * fleet list, for the operator who POINTS instead of wheels.
 *
 * The primary user stands across the room driving a dwell cursor (gesture
 * camera / arcade joystick / guest phone via GestureLayer). That cursor can
 * click-by-dwelling but can NOT wheel-scroll, so an overflowing fleet list was
 * simply unreachable past the fold. The fix is hover-to-scroll: while a cursor
 * rests on an affordance the list glides (~a few hundred px/s via rAF); moving
 * off stops it. Two hover sources feed the same loop:
 *
 *   - css :hover        — a desk mouse resting on the button;
 *   - [data-dwell-hot]  — the attribute GestureLayer sets per-frame on the
 *                         element a gesture cursor currently points at.
 *
 * The buttons are plain enabled <button>s so the dwell selector
 * ("button:not(:disabled), [data-dwell]") targets them automatically — that is
 * what makes GestureLayer decorate them with data-dwell-hot at all. Completing
 * a dwell on one fires a synthesized .click(), which is deliberately a no-op:
 * the value IS the hover, the fire flash is harmless.
 *
 * The affordances render only while the list actually overflows (checked every
 * frame — fleet panels grow/shrink as builds progress), so the common 1–2
 * panel room never shows scroll chrome.
 */

// "A few hundred px/s": fast enough to traverse a long fleet in a couple of
// seconds, slow enough to read panels streaming by and release in time.
export const FLEET_SCROLL_PX_PER_SECOND = 320;

// A background tab's rAF can stall for seconds; on resume one giant frame
// delta must not teleport the list. Clamp each frame's step to this budget.
const MAX_FRAME_SECONDS = 0.1;

// Pure: pixels to scroll this frame. direction is -1 (up) / +1 (down);
// dtSeconds is the frame delta, clamped to [0, MAX_FRAME_SECONDS].
export function hoverScrollDelta(direction: -1 | 1, dtSeconds: number): number {
  const dt = Math.min(Math.max(dtSeconds, 0), MAX_FRAME_SECONDS);
  return direction * FLEET_SCROLL_PX_PER_SECOND * dt;
}

// Pure: does the rail need scroll affordances at all? A small tolerance so
// sub-pixel rounding between scrollHeight and clientHeight never flickers the
// buttons into existence.
export function railOverflows(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - clientHeight > 4;
}

// Is this affordance currently "held" by any cursor? Either the OS mouse
// (:hover) or a gesture/joystick/guest cursor (data-dwell-hot, applied by
// GestureLayer's frame loop). Attribute first: it needs no selector engine.
function isHoverHot(el: Element): boolean {
  if (el.hasAttribute("data-dwell-hot")) {
    return true;
  }
  try {
    return el.matches(":hover");
  } catch {
    return false; // selector engine without :hover support (non-browser DOM)
  }
}

export interface FleetScrollRailProps {
  children: ReactNode;
  // Test seam: SSR renders (renderToStaticMarkup) never run the effect that
  // measures overflow, so tests force the affordances visible. FleetPanel
  // itself never passes this — live visibility is measured per frame.
  initialOverflowing?: boolean;
}

// Wraps the scrolling .fleet-panels list with the two hover-scroll buttons.
// The buttons live OUTSIDE the scroll container (flex rows above/below), so
// they stay pinned while the list moves and never occlude panel content.
export function FleetScrollRail({ children, initialOverflowing = false }: FleetScrollRailProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const upRef = useRef<HTMLButtonElement | null>(null);
  const downRef = useRef<HTMLButtonElement | null>(null);
  const [overflowing, setOverflowing] = useState(initialOverflowing);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dtSeconds = (now - last) / 1000;
      last = now;
      const scroller = scrollRef.current;
      if (scroller !== null) {
        // Live overflow check: panels appear/expand as builds progress, so the
        // affordances must (dis)appear without any React-visible event. The
        // setState bails out when unchanged — no re-render churn.
        setOverflowing(railOverflows(scroller.scrollHeight, scroller.clientHeight));

        const drive = (btn: HTMLButtonElement | null, direction: -1 | 1) => {
          if (btn === null) {
            return;
          }
          if (isHoverHot(btn)) {
            scroller.scrollTop += hoverScrollDelta(direction, dtSeconds);
          }
          // At-limit affordance: the button dims (CSS) when its direction has
          // nowhere left to go, but stays a live target — hiding a control
          // under a mid-dwell cursor would be rude.
          const atLimit =
            direction === -1
              ? scroller.scrollTop <= 0
              : scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1;
          if (atLimit) {
            btn.setAttribute("data-at-limit", "1");
          } else {
            btn.removeAttribute("data-at-limit");
          }
        };
        drive(upRef.current, -1);
        drive(downRef.current, 1);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="fleet-scroll-rail" data-testid="fleet-scroll-rail">
      {overflowing ? (
        <button
          type="button"
          ref={upRef}
          className="fleet-scroll-btn fleet-scroll-up"
          data-testid="fleet-scroll-up"
          aria-label="Scroll the fleet list up (rest the cursor here)"
          title="Hover / point here to scroll the fleet up."
          // Deliberate no-op: dwell completion synthesizes a click, but the
          // interaction IS the hover — there is nothing sensible to toggle.
          onClick={() => {}}
        >
          ▲
        </button>
      ) : null}
      <div className="fleet-panels" ref={scrollRef}>
        {children}
      </div>
      {overflowing ? (
        <button
          type="button"
          ref={downRef}
          className="fleet-scroll-btn fleet-scroll-down"
          data-testid="fleet-scroll-down"
          aria-label="Scroll the fleet list down (rest the cursor here)"
          title="Hover / point here to scroll the fleet down."
          onClick={() => {}}
        >
          ▼
        </button>
      ) : null}
    </div>
  );
}
