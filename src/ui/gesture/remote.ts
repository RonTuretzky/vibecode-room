// Guest-hands mode (remote hand controls over the room LAN) — the constants and
// pure helpers SHARED between the wall UI and the projector server's relay hub
// (src/server/remote-hands.ts imports from here; precedent: app.ts already
// imports ../ui modules). Keeping the id math in one module is what guarantees
// the wall and the hub can never disagree about which cursor ids are guests'.
//
// Id layout: guests live in a NEGATIVE id space — every guest connection gets
// an exclusive block of GUEST_ID_STRIDE consecutive ids descending from
// GUEST_ID_BASE (-1000, -1001, … then -1008 for the next guest). The fusion
// tracker mints POSITIVE ids that grow without bound over a long session
// (gesture-wall tracking: ids are never reused), so any positive guest range
// would eventually be invaded; negatives are disjoint BY CONSTRUCTION from
// every camera track and from the local mouse-test cursor (-1). Within a
// block, the guest's local hand id (0 = left/pad, 1 = right) picks the slot —
// a stable id per physical hand, which is what keeps its dwell state and hue
// steady across frames.

import type { DwellCaps } from "./core";

export const GUEST_ID_BASE = -1000;
export const GUEST_ID_STRIDE = 8;

// The globally-unique cursor id for a guest connection's local hand id.
// Local ids outside [0, stride) are folded in (defensive — the hub validates).
export function guestCursorId(guestSeq: number, localId: number): number {
  const slot = ((localId % GUEST_ID_STRIDE) + GUEST_ID_STRIDE) % GUEST_ID_STRIDE;
  return GUEST_ID_BASE - (guestSeq * GUEST_ID_STRIDE + slot);
}

export function isGuestCursorId(id: number): boolean {
  return id <= GUEST_ID_BASE;
}

// The wall-side dwell capabilities for a cursor id (fed to MultiDwell). A
// guest steering a dot from their own laptop is ALWAYS deliberately aiming —
// there is no "open roaming hand" state to guard against — so hover alone
// accumulates dwell (no pinch/press marathon required to click), and a pinch
// or pad press landing on a target clicks it immediately (the fast path).
// Camera/fusion cursors (and the -1 mouse-test cursor) get no caps: their
// dwell keeps requiring `engaged`, exactly as before guests existed.
export function guestDwellCaps(id: number): DwellCaps {
  return isGuestCursorId(id) ? { hoverDwells: true, instantFire: true } : {};
}

// Guests aiming from their own laptop NEED to see their dot on the wall (they
// have no arm→wall mapping to go by), so guest cursors always draw — the
// room-scale "dots read as clutter" preference only governs in-room cursors.
export function shouldDrawCursorDot(id: number, dotsPreference: boolean): boolean {
  return dotsPreference || isGuestCursorId(id);
}

// The per-frame dot list the overlay renderer iterates: with the preference on,
// everything; with it off, ONLY guest cursors. A pure function so the
// guests-always-draw rule stays unit-tested even though the canvas renderer
// itself is not — GestureLayer.draw() must iterate THIS, never re-gate on the
// bare preference (the pre-guests code returned early when dots were off).
export function visibleCursorDots<T>(
  cursors: ReadonlyMap<number, T>,
  dotsPreference: boolean,
): Array<[number, T]> {
  return [...cursors].filter(([id]) => shouldDrawCursorDot(id, dotsPreference));
}

// The wall's same-origin subscription socket for merged guest cursors. The
// production wall is served BY the projector server (run-room.sh), so the
// page's own origin is the right default; ?remote=ws://… overrides it for
// split-origin setups (e.g. Vite dev against a separately-bound server).
export function roomHandsSocketUrl(location: { protocol: string; host: string }): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/api/hands/room`;
}

// ── Remote WASD holds ────────────────────────────────────────────────────────
// Guests' on-screen W/A/S/D buttons drive the wall's fly-through camera by
// synthesizing the SAME window key events the desk keyboard produces. This
// class owns the pure state: per-guest held sets (guests heartbeat every
// ~250ms while holding), the union across guests, and the keydown/keyup DIFF
// the layer must dispatch. A guest that falls silent while holding (crash,
// Wi-Fi drop) is evicted after STALE seconds so the camera can never walk
// forever on a dead connection.

export const REMOTE_KEYS_STALE_SECONDS = 1.5;

export class RemoteKeyHolds {
  readonly #staleSeconds: number;
  readonly #guests = new Map<number, { held: Set<string>; lastSeen: number }>();
  readonly #applied = new Set<string>();

  constructor(staleSeconds = REMOTE_KEYS_STALE_SECONDS) {
    this.#staleSeconds = staleSeconds;
  }

  // Record a guest's current holds. `t` is seconds on the layer's clock.
  update(guest: number, held: readonly string[], t: number): void {
    if (held.length === 0) {
      this.#guests.delete(guest);
      return;
    }
    this.#guests.set(guest, { held: new Set(held), lastSeen: t });
  }

  // Advance to time `t`: evict silent guests, recompute the union, and return
  // the keys to press (down) and release (up) since the last call.
  diff(t: number): { down: string[]; up: string[] } {
    for (const [guest, entry] of [...this.#guests]) {
      if (t - entry.lastSeen > this.#staleSeconds) {
        this.#guests.delete(guest);
      }
    }
    const union = new Set<string>();
    for (const entry of this.#guests.values()) {
      for (const key of entry.held) {
        union.add(key);
      }
    }
    const down = [...union].filter((key) => !this.#applied.has(key));
    const up = [...this.#applied].filter((key) => !union.has(key));
    for (const key of down) {
      this.#applied.add(key);
    }
    for (const key of up) {
      this.#applied.delete(key);
    }
    return { down, up };
  }

  // Unmount: everything currently applied must be released.
  releaseAll(): string[] {
    const up = [...this.#applied];
    this.#applied.clear();
    this.#guests.clear();
    return up;
  }
}
