import { describe, expect, test } from "bun:test";
import {
  DWELL_SHIELD_SELECTOR,
  POPUP_ABSENT_SECONDS,
  POPUP_DISMISS_IDLE,
  POPUP_MISS_SECONDS,
  cursorOverRect,
  popupDismissStep,
  type PopupDismissState,
} from "./popup-dismiss";

// The gesture wall's ground-click equivalent: a cursor parked on EMPTY ground
// (~1.5s) or a cursorless stretch (~6s) closes the App's top popup. The fold
// is pure so these tests pin the timing without the GestureLayer's RAF loop.

const onEmpty = { cursorCount: 1, anyOnTarget: false };
const onTarget = { cursorCount: 1, anyOnTarget: true };
const absent = { cursorCount: 0, anyOnTarget: false };

function run(
  samples: { sample: { cursorCount: number; anyOnTarget: boolean }; t: number }[],
): { fires: number[]; state: PopupDismissState } {
  let state = POPUP_DISMISS_IDLE;
  const fires: number[] = [];
  for (const { sample, t } of samples) {
    const step = popupDismissStep(state, sample, t);
    state = step.state;
    if (step.dismiss) {
      fires.push(t);
    }
  }
  return { fires, state };
}

describe("popup dismiss: dwell-miss close (pure fold)", () => {
  test("timing constants stay demo-sane: ~1.5s parked miss, ~6s walked away", () => {
    expect(POPUP_MISS_SECONDS).toBeGreaterThanOrEqual(1);
    expect(POPUP_MISS_SECONDS).toBeLessThanOrEqual(3);
    expect(POPUP_ABSENT_SECONDS).toBeGreaterThanOrEqual(4);
    expect(POPUP_ABSENT_SECONDS).toBeLessThanOrEqual(10);
  });

  test("a cursor parked on empty ground dismisses after MISS seconds, not before", () => {
    const { fires } = run([
      { sample: onEmpty, t: 0 },
      { sample: onEmpty, t: 0.5 },
      { sample: onEmpty, t: 1.4 },
      { sample: onEmpty, t: 1.5 },
    ]);
    expect(fires).toEqual([1.5]);
  });

  test("touching ANY target resets the miss window (mid-aim never loses the popup)", () => {
    const { fires } = run([
      { sample: onEmpty, t: 0 },
      { sample: onEmpty, t: 1.0 },
      { sample: onTarget, t: 1.2 }, // cursor crosses a button / tree
      { sample: onEmpty, t: 1.4 },
      { sample: onEmpty, t: 2.8 }, // only 1.4s since the window restarted
      { sample: onEmpty, t: 2.9 }, // 1.5s → fire
    ]);
    expect(fires).toEqual([2.9]);
  });

  test("no cursor at all dismisses after ABSENT seconds", () => {
    const { fires } = run([
      { sample: absent, t: 0 },
      { sample: absent, t: 5.9 },
      { sample: absent, t: 6.0 },
    ]);
    expect(fires).toEqual([6.0]);
  });

  test("a returning cursor resets the walked-away window", () => {
    const { fires } = run([
      { sample: absent, t: 0 },
      { sample: absent, t: 5 },
      { sample: onTarget, t: 5.5 }, // someone came back mid-window
      { sample: absent, t: 6.5 },
      { sample: absent, t: 12.4 }, // 5.9s since the window restarted
      { sample: absent, t: 12.5 }, // 6s → fire
    ]);
    expect(fires).toEqual([12.5]);
  });

  test("after a fire the timers restart: a held condition fires once per window, never per frame", () => {
    const { fires } = run([
      { sample: onEmpty, t: 0 },
      { sample: onEmpty, t: 1.5 }, // fire #1
      { sample: onEmpty, t: 1.6 }, // fresh window — no immediate re-fire
      { sample: onEmpty, t: 3.0 },
      { sample: onEmpty, t: 3.1 }, // 1.5s after the restart → fire #2
    ]);
    expect(fires).toEqual([1.5, 3.1]);
  });

  test("steady conditions keep state identity (no per-frame allocation churn in the RAF loop)", () => {
    const first = popupDismissStep(POPUP_DISMISS_IDLE, onEmpty, 1);
    const second = popupDismissStep(first.state, onEmpty, 1.2);
    expect(second.state).toBe(first.state);
    const idle = popupDismissStep(POPUP_DISMISS_IDLE, onTarget, 2);
    expect(idle.state).toBe(POPUP_DISMISS_IDLE);
  });
});

// ON-TARGET GEOMETRY for the dismiss check. The dwell selector HOLDS an
// acquired zone inside a 15% sticky halo (DwellSelector hysteresis,
// core.ts) — so the "is any cursor on a target?" sample must test the SAME
// expanded bounds. Before this, anyOnTarget used the base rects: a cursor
// held mid-dwell in the halo (or parked there right after firing a menu
// button) read as empty ground and closed the popup ~1.5s later while the
// user still "felt" on the button.
describe("popup dismiss: on-target geometry (cursorOverRect)", () => {
  // 200×100 rect at (100,100): a 15% halo = 30px horizontally, 15px
  // vertically per side (fractional of the rect's OWN size, exactly like
  // Zone.contains with margin -0.15).
  const rect = { left: 100, top: 100, width: 200, height: 100 };

  test("plain containment (halo 0): inside counts, edges inclusive, outside misses", () => {
    expect(cursorOverRect(200, 150, rect)).toBe(true);
    expect(cursorOverRect(100, 100, rect)).toBe(true);
    expect(cursorOverRect(300, 200, rect)).toBe(true);
    expect(cursorOverRect(99, 150, rect)).toBe(false);
    expect(cursorOverRect(200, 201, rect)).toBe(false);
  });

  test("sticky-halo parity: a cursor in the 15% hysteresis halo is ON target, beyond it is not", () => {
    // Expanded bounds: x ∈ [70, 330], y ∈ [85, 215].
    expect(cursorOverRect(75, 150, rect, 0.15)).toBe(true); // left halo
    expect(cursorOverRect(325, 150, rect, 0.15)).toBe(true); // right halo
    expect(cursorOverRect(200, 90, rect, 0.15)).toBe(true); // top halo
    expect(cursorOverRect(200, 214, rect, 0.15)).toBe(true); // bottom halo
    expect(cursorOverRect(69, 150, rect, 0.15)).toBe(false); // past the halo
    expect(cursorOverRect(200, 216, rect, 0.15)).toBe(false);
    // Without the halo the same halo-park position reads as a miss — the
    // exact mismatch that used to close the popup under a held cursor.
    expect(cursorOverRect(75, 150, rect)).toBe(false);
  });

  test("the popup shield opt-in selector is pinned (GestureLayer query ↔ popup attribute contract)", () => {
    expect(DWELL_SHIELD_SELECTOR).toBe("[data-dwell-shield]");
  });
});
