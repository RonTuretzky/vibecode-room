import type { ProjectorSnapshot } from "./types";

/**
 * SELF-HOSTING seam for the wall UI (VIBERSYN_SELF_MODE=1).
 *
 * Server contract (composition.ts): the snapshot gains a top-level `bootId`
 * (the server process's stable per-boot id, also on /api/health) and a `self`
 * surface ({ upid, callsign, reloadPending }). When the room reloads itself
 * the sequence on the wire is: reloadPending flips true → the SSE stream dies
 * (the server exits 87) → the supervisor rebuilds/relaunches → the stream
 * reconnects and the FIRST frame carries a NEW bootId → the wall reloads the
 * page so both walls pick up the new build.
 *
 * Like buildloop.ts/stage.ts this is the tolerant wall-side seam: local
 * mirrors of the shapes plus defensive extractors, so an old server (no
 * bootId, no self) degrades to nothing — never a stray reload loop.
 */

// Mirror of the server's SelfSurface (a deliberate copy — the browser bundle
// never imports server code).
export interface SelfWallState {
  upid: string;
  callsign: string;
  reloadPending: boolean;
}

export type SelfAwareSnapshot = ProjectorSnapshot & { bootId?: string; self?: SelfWallState | null };

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// The server's per-boot id, or null against an old server / malformed frame.
export function bootIdOf(snapshot: ProjectorSnapshot): string | null {
  return asNonEmptyString((snapshot as SelfAwareSnapshot).bootId as unknown);
}

// The self surface, or null when self mode is off / the server predates it.
export function selfOf(snapshot: ProjectorSnapshot): SelfWallState | null {
  const raw = (snapshot as SelfAwareSnapshot).self as unknown;
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const upid = asNonEmptyString(record.upid);
  const callsign = asNonEmptyString(record.callsign);
  if (upid === null || callsign === null) {
    return null;
  }
  return { upid, callsign, reloadPending: record.reloadPending === true };
}

// THE RELOAD DECISION: reload the page only when the page has already bound to
// one bootId AND the incoming frame carries a DIFFERENT non-empty one. A null
// on either side (old server, malformed frame, first frame ever) never
// reloads — a missing field must not bounce the wall.
export function shouldReloadForBoot(loadedBootId: string | null, incomingBootId: string | null): boolean {
  return loadedBootId !== null && loadedBootId.length > 0 && incomingBootId !== null && incomingBootId.length > 0 && incomingBootId !== loadedBootId;
}

// Fold one snapshot's bootId into the page's tracked boot binding. Pure, so
// the App's effect (and the unit tests) share the exact decision: the FIRST
// non-empty bootId binds; a later differing one demands a reload.
export function trackBootId(
  bound: string | null,
  snapshot: ProjectorSnapshot,
): { bound: string | null; reload: boolean } {
  const incoming = bootIdOf(snapshot);
  if (incoming === null) {
    return { bound, reload: false };
  }
  if (bound === null) {
    return { bound: incoming, reload: false };
  }
  return { bound, reload: shouldReloadForBoot(bound, incoming) };
}
