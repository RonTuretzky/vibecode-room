import { describe, expect, test } from "bun:test";

import { IMPORT_ARRIVAL_FRESH_MS, isFreshImportArrival } from "./import-arrival";

const NOW = 1_700_000_000_000;

const imported = (upid: string, atMs: number | undefined, kind = "github-import") => ({
  upid,
  source: atMs === undefined ? { kind } : { kind, atMs },
});

describe("isFreshImportArrival", () => {
  test("an import that just landed is an arrival", () => {
    expect(isFreshImportArrival(imported("u1", NOW - 5_000), new Set(), NOW)).toBe(true);
  });

  test("THE STARTUP BUG: old imports are not arrivals, even to a wall that has never seen them", () => {
    // The exact live failure: the wall connected before the server's first
    // filled snapshot, so its seen-set was empty and every long-standing
    // import re-announced itself as "📦 … arrived — ⚘ Plant it…" on ordinary
    // room startup.
    const anHourOld = NOW - 60 * 60_000;
    expect(isFreshImportArrival(imported("u1", anHourOld), new Set(), NOW)).toBe(false);
  });

  test("the window closes at the freshness edge", () => {
    expect(isFreshImportArrival(imported("u1", NOW - IMPORT_ARRIVAL_FRESH_MS), new Set(), NOW)).toBe(true);
    expect(isFreshImportArrival(imported("u1", NOW - IMPORT_ARRIVAL_FRESH_MS - 1), new Set(), NOW)).toBe(false);
  });

  test("already-seen upids never re-announce", () => {
    expect(isFreshImportArrival(imported("u1", NOW - 1_000), new Set(["u1"]), NOW)).toBe(false);
  });

  test("phone imports arrive too; non-imports never do", () => {
    expect(isFreshImportArrival(imported("u1", NOW - 1_000, "phone-import"), new Set(), NOW)).toBe(true);
    expect(isFreshImportArrival(imported("u2", NOW - 1_000, "idea"), new Set(), NOW)).toBe(false);
    expect(isFreshImportArrival({ upid: "u3" }, new Set(), NOW)).toBe(false);
  });

  test("a server too old to stamp arrivals stays silent", () => {
    expect(isFreshImportArrival(imported("u1", undefined), new Set(), NOW)).toBe(false);
  });

  test("a future stamp (clock skew) is not an arrival", () => {
    expect(isFreshImportArrival(imported("u1", NOW + 60_000), new Set(), NOW)).toBe(false);
  });
});
