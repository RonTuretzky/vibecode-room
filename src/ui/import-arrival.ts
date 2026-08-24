/**
 * WHEN IS AN IMPORT "AN ARRIVAL"?
 *
 * The wall offers a freshly imported tree a chosen spot ("📦 <title> arrived —
 * ⚘ Plant it…"). That offer used to fire on a purely client-side test: a UPID
 * this wall had not seen before, with the very first snapshot seeding the
 * seen-set silently.
 *
 * That test is wrong on ordinary room startup. A wall that connects while the
 * server is still filling its first snapshot seeds an EMPTY seen-set — so the
 * next snapshot, carrying every previously imported project, reads as a burst
 * of brand-new arrivals and the room boots into a "Plant it…" offer nobody
 * asked for. Same bug on any reload, and on the second wall of a two-wall rig.
 *
 * The honest test is the server's arrival timestamp (`source.atMs`): an import
 * is an arrival for a couple of minutes after it actually landed, no matter
 * how many walls boot or reload in the meantime. A server too old to send
 * `atMs` simply never triggers the offer — silence beats a false announcement.
 */

// How long after landing an import still counts as "just arrived". Long enough
// to cover a phone submission plus the clone routine and someone walking back
// to the wall; far short of a room session.
export const IMPORT_ARRIVAL_FRESH_MS = 3 * 60_000;

export interface ArrivalCandidate {
  upid: string;
  source?: { kind: string; atMs?: number } | undefined;
}

/**
 * Pure: is this process a genuine just-landed import worth offering a spot?
 * `seen` holds the UPIDs this wall has already considered (arrival offers fire
 * once per wall, never on every snapshot tick).
 */
export function isFreshImportArrival(
  process: ArrivalCandidate,
  seen: ReadonlySet<string>,
  nowMs: number,
): boolean {
  if (seen.has(process.upid)) {
    return false;
  }
  const source = process.source;
  if (source === undefined) {
    return false;
  }
  if (source.kind !== "github-import" && source.kind !== "phone-import") {
    return false;
  }
  const atMs = source.atMs;
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) {
    return false; // pre-atMs server: never announce rather than announce wrongly
  }
  // A clock-skewed future stamp is not an arrival either — only the window
  // [now - FRESH, now] counts.
  const age = nowMs - atMs;
  return age >= 0 && age <= IMPORT_ARRIVAL_FRESH_MS;
}
