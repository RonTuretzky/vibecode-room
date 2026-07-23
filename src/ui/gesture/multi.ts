// Multi-cursor dwell coordination — the fusion stream can carry several cursors
// (two hands / two people). Each cursor gets its own DwellSelector, but targets
// are single-owner: the FIRST cursor to start dwelling on a zone CLAIMS it (one
// primary per target), and a completed dwell LOCKS the zone briefly for every
// cursor — mirroring the standalone gesture wall's per-zone lock
// (gesture-wall/web/wall.js: ZONE_LOCK_SECONDS) so two users can never
// double-activate the same control.
//
// Pure logic — no DOM, no sockets — so the whole state machine is unit-testable
// with fake cursor feeds.

import { DwellSelector, type Zone } from "./core";

export interface DwellCursor {
  id: number;
  x: number; // normalized [0,1]
  y: number; // normalized [0,1]
  engaged: boolean;
}

// A completed dwell: which zone fired and which cursor drove it.
export interface DwellFire {
  zoneId: string;
  cursorId: number;
}

// A zone currently being dwelled (for rendering the highlight + progress ring).
// By construction there is at most ONE entry per zoneId (the claiming cursor).
export interface ActiveDwell {
  zoneId: string;
  cursorId: number;
  progress: number; // 0..1
}

export interface MultiDwellResult {
  fired: DwellFire[];
  active: ActiveDwell[];
}

export interface MultiDwellOptions {
  dwellSeconds?: number;
  cooldownSeconds?: number;
  hysteresis?: number;
  // After a zone fires it is locked for ALL cursors this long (first-to-dwell
  // wins; the runner-up cannot immediately re-fire the same control).
  lockSeconds?: number;
}

export class MultiDwell {
  readonly #dwellSeconds: number;
  readonly #cooldownSeconds: number;
  readonly #hysteresis: number;
  readonly #lockSeconds: number;
  readonly #dwellers = new Map<number, DwellSelector>();
  // zoneId -> owning cursorId (the primary). A zone claimed by one cursor is
  // invisible to every other cursor's target resolution.
  readonly #claims = new Map<string, number>();
  // cursorId -> zoneId it currently claims (reverse index for cheap release).
  readonly #claimOf = new Map<number, string>();
  // zoneId -> unlock time (seconds). Set on fire; pruned when expired.
  readonly #locks = new Map<string, number>();

  constructor(options: MultiDwellOptions = {}) {
    this.#dwellSeconds = options.dwellSeconds ?? 0.8;
    this.#cooldownSeconds = options.cooldownSeconds ?? 0.4;
    this.#hysteresis = options.hysteresis ?? 0.15;
    this.#lockSeconds = options.lockSeconds ?? 0.4;
  }

  #isLocked(zoneId: string, t: number): boolean {
    const until = this.#locks.get(zoneId);
    return until !== undefined && t < until;
  }

  #releaseClaim(cursorId: number): void {
    const zoneId = this.#claimOf.get(cursorId);
    if (zoneId !== undefined) {
      if (this.#claims.get(zoneId) === cursorId) {
        this.#claims.delete(zoneId);
      }
      this.#claimOf.delete(cursorId);
    }
  }

  // Advance every cursor's dwell against the shared zone set. `t` is seconds.
  // Cursor order matters only in the same-tick race for a fresh zone: earlier
  // cursors claim first (deterministic; callers feed a stable order).
  update(zones: readonly Zone[], cursors: readonly DwellCursor[], t: number): MultiDwellResult {
    // Housekeeping: expired locks, dwellers/claims for vanished cursors.
    for (const [zoneId, until] of [...this.#locks]) {
      if (t >= until) {
        this.#locks.delete(zoneId);
      }
    }
    const liveIds = new Set(cursors.map((c) => c.id));
    for (const id of [...this.#dwellers.keys()]) {
      if (!liveIds.has(id)) {
        this.#dwellers.delete(id);
        this.#releaseClaim(id);
      }
    }

    const fired: DwellFire[] = [];
    const active: ActiveDwell[] = [];

    for (const cursor of cursors) {
      let dweller = this.#dwellers.get(cursor.id);
      if (dweller === undefined) {
        // refireOnlyAfterLeave: a dwell = ONE activation; the cursor must leave
        // the target before it can activate it again.
        dweller = new DwellSelector(this.#dwellSeconds, this.#cooldownSeconds, this.#hysteresis, true);
        this.#dwellers.set(cursor.id, dweller);
      }

      // A zone locked (just fired) or claimed by ANOTHER cursor is invisible to
      // this dweller — it can neither acquire nor keep progressing on it.
      const visible = zones.filter((zone) => {
        if (this.#isLocked(zone.id, t)) {
          return false;
        }
        const owner = this.#claims.get(zone.id);
        return owner === undefined || owner === cursor.id;
      });
      // Mid-dwell on a zone that just got locked/claimed away: reset (mirrors
      // wall.js resetting dwellers whose active zone got locked by another).
      const held = dweller.activeZone;
      if (held !== null) {
        const owner = this.#claims.get(held.id);
        if (this.#isLocked(held.id, t) || (owner !== undefined && owner !== cursor.id)) {
          dweller.reset();
        }
      }

      const event = dweller.update(visible, [cursor.x, cursor.y], t, cursor.engaged);

      // Claim bookkeeping AFTER the update so a fired (reset) dweller releases
      // its claim and a fresh acquisition claims immediately — before the next
      // cursor in this same tick resolves its own targets.
      const nowZoneId = dweller.activeZone?.id ?? null;
      const prevClaim = this.#claimOf.get(cursor.id);
      if (prevClaim !== nowZoneId) {
        this.#releaseClaim(cursor.id);
        if (nowZoneId !== null && !this.#claims.has(nowZoneId)) {
          this.#claims.set(nowZoneId, cursor.id);
          this.#claimOf.set(cursor.id, nowZoneId);
        }
      }

      if (event !== null) {
        fired.push({ zoneId: event.zoneId, cursorId: cursor.id });
        this.#locks.set(event.zoneId, t + this.#lockSeconds);
      }
      if (dweller.activeZone !== null && this.#claims.get(dweller.activeZone.id) === cursor.id) {
        active.push({ zoneId: dweller.activeZone.id, cursorId: cursor.id, progress: dweller.progress });
      }
    }

    return { fired, active };
  }
}
