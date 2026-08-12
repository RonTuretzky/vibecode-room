// POPUP DISMISS — the gesture wall's "click on empty ground" equivalent.
//
// A mouse can close the tree menu by clicking empty ground (RoomScene's
// onPickMiss), but a gesture wall has no click: before this, a dwell cursor
// could OPEN a menu and never dismiss it (live-room P0 — the ✕ was its only
// close verb, and a mis-placed panel could carry it off-screen). Two dismiss
// verbs, decided by this pure fold so the timing is unit-testable without the
// GestureLayer's RAF loop:
//
//   - DWELL-MISS: at least one cursor is present and NONE of them is over any
//     dwell target (DOM zone or scene node) for MISS seconds continuously —
//     someone is deliberately parking on empty ground, close the top popup.
//   - WALKED AWAY: no cursor at all for ABSENT seconds — nobody is pointing
//     anymore; a popup left open on the projector is stale glass.
//
// After a dismissal fires the timers reset, so a held condition re-fires at
// most once per window (the App's handler is a no-op when nothing is open).

export const POPUP_MISS_SECONDS = 1.5;
export const POPUP_ABSENT_SECONDS = 6;

// Non-target glass that must still count as "on target" for the dismiss check:
// an open popup opts its WHOLE panel in with this attribute (TreeMenu, the
// idea action card), so a cursor reading its non-button regions — title/
// status block, lane status rows, the QR figure, the ExecutionChip — never
// reads as empty ground that closes the popup under the reader's cursor. The
// shield is dismiss-only: it is NOT a dwell target (dwelling on the body must
// not synthesize a click).
export const DWELL_SHIELD_SELECTOR = "[data-dwell-shield]";

export interface DismissRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Pure point-vs-rect test for the dismiss check, with an optional fractional
// halo (of the rect's own width/height per side — the same geometry as
// Zone.contains with a negative margin). The dwell selector HOLDS an acquired
// zone inside a sticky halo (hysteresis), so the dismiss check must test the
// SAME expanded bounds: a cursor the selector still considers on-target (or
// one parked in the halo right after firing) must never read as empty ground.
export function cursorOverRect(px: number, py: number, rect: DismissRect, halo = 0): boolean {
  const hx = rect.width * halo;
  const hy = rect.height * halo;
  return px >= rect.left - hx && px <= rect.left + rect.width + hx && py >= rect.top - hy && py <= rect.top + rect.height + hy;
}

export interface PopupDismissState {
  // When every present cursor first sat on empty ground (seconds), or null.
  missSince: number | null;
  // When the last cursor disappeared (seconds), or null while any is present.
  absentSince: number | null;
}

export const POPUP_DISMISS_IDLE: PopupDismissState = { missSince: null, absentSince: null };

export interface PopupDismissSample {
  // Tracked cursors this frame (camera + guests + the mouse-test cursor).
  cursorCount: number;
  // Is ANY cursor over a dwell target right now? (Inflated DOM hitboxes and
  // raycast scene nodes both count — someone mid-aim must never lose their
  // popup to jitter across a gap.)
  anyOnTarget: boolean;
  // Has a cursor EVER been tracked on this wall? "Walked away" means somebody
  // was pointing and then left — with no hand source at all (the ordinary
  // case: ?remote is on by default, so the dwell layer mounts on every wall
  // whether or not any camera is feeding it) nobody ever arrived, so nobody
  // can walk away. Without this the rule fired on a 6s cycle forever and every
  // tree menu, branch popup and record window closed itself within seconds of
  // opening, with nobody in the room. Defaults to true so the pure fold's own
  // tests keep describing the walked-away rule directly.
  cursorSeenEver?: boolean;
}

export function popupDismissStep(
  state: PopupDismissState,
  sample: PopupDismissSample,
  t: number,
  missSeconds: number = POPUP_MISS_SECONDS,
  absentSeconds: number = POPUP_ABSENT_SECONDS,
): { state: PopupDismissState; dismiss: boolean } {
  if (sample.cursorCount === 0) {
    if (sample.cursorSeenEver === false) {
      // No hand source has ever produced a cursor here: there is no absence to
      // measure. Hold the popup — a mouse/desk operator owns this wall.
      return { state: POPUP_DISMISS_IDLE, dismiss: false };
    }
    const absentSince = state.absentSince ?? t;
    if (t - absentSince >= absentSeconds) {
      return { state: POPUP_DISMISS_IDLE, dismiss: true };
    }
    return {
      state: state.missSince === null && state.absentSince === absentSince ? state : { missSince: null, absentSince },
      dismiss: false,
    };
  }
  if (sample.anyOnTarget) {
    return { state: state === POPUP_DISMISS_IDLE || (state.missSince === null && state.absentSince === null) ? state : POPUP_DISMISS_IDLE, dismiss: false };
  }
  const missSince = state.missSince ?? t;
  if (t - missSince >= missSeconds) {
    return { state: POPUP_DISMISS_IDLE, dismiss: true };
  }
  return {
    state: state.absentSince === null && state.missSince === missSince ? state : { missSince, absentSince: null },
    dismiss: false,
  };
}
