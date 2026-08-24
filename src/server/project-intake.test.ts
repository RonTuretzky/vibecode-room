import { describe, expect, test } from "bun:test";

import {
  ISSUE_AGING_DAYS,
  ISSUE_STALE_DAYS,
  ageLabel,
  issueFreshness,
  readIntent,
  stalenessWarning,
} from "./project-intake";

const NOW = 1_700_000_000_000;
const daysAgo = (days: number) => NOW - days * 86_400_000;

describe("readIntent", () => {
  test("THE LIVE MISS: 'just study it first' asks for a study, not a build", () => {
    expect(readIntent("just study it first", true)).toBe("study");
  });

  test("the other plain ways of asking for a read", () => {
    for (const text of [
      "look at this repo and tell me what it does",
      "I want to understand the architecture",
      "read through the code first",
      "explain what is going on here",
      "audit the auth flow",
      "don't build anything yet",
      "get familiar with it before building",
    ]) {
      expect(readIntent(text, true)).toBe("study");
    }
  });

  test("an explicit build ask still builds", () => {
    expect(readIntent("build a dashboard for this", true)).toBe("build");
    expect(readIntent("implement dark mode", true)).toBe("build");
    expect(readIntent("fix the login bug", true)).toBe("build");
  });

  test("study wins over build when both are said — it is a sequence", () => {
    expect(readIntent("study it first, then build the importer", true)).toBe("study");
  });

  test("DEFAULTS: a repo with no instruction is studied; a bare idea is built", () => {
    expect(readIntent(null, true)).toBe("study");
    expect(readIntent("   ", true)).toBe("study");
    expect(readIntent(null, false)).toBe("build");
    // A described idea with no repo has nothing to read.
    expect(readIntent("a tool that tracks my plants", false)).toBe("build");
  });

  test("any other description is a build — describing something IS asking for it", () => {
    // The build side is deliberately NOT a verb list: no enumeration survives
    // the ways people describe what they want ("give the widget a dark mode"
    // is plainly work). Asking to READ is the marked case.
    expect(readIntent("give the widget a dark mode", true)).toBe("build");
    expect(readIntent("a synthwave dashboard for our ticket queue", true)).toBe("build");
    expect(readIntent("acme internal thing", true)).toBe("build");
  });
});

describe("issue freshness", () => {
  test("bands", () => {
    expect(issueFreshness(daysAgo(3), NOW)).toBe("fresh");
    expect(issueFreshness(daysAgo(ISSUE_AGING_DAYS), NOW)).toBe("aging");
    expect(issueFreshness(daysAgo(ISSUE_STALE_DAYS), NOW)).toBe("stale");
    expect(issueFreshness(daysAgo(ISSUE_AGING_DAYS - 1), NOW)).toBe("fresh");
  });

  test("no timestamp is 'unknown', never silently 'fresh'", () => {
    expect(issueFreshness(null, NOW)).toBe("unknown");
    expect(issueFreshness(undefined, NOW)).toBe("unknown");
    expect(issueFreshness(Number.NaN, NOW)).toBe("unknown");
  });

  test("clock skew never invents staleness", () => {
    expect(issueFreshness(NOW + 86_400_000, NOW)).toBe("fresh");
  });

  test("age reads like a person wrote it", () => {
    expect(ageLabel(daysAgo(0), NOW)).toBe("today");
    expect(ageLabel(daysAgo(1), NOW)).toBe("yesterday");
    expect(ageLabel(daysAgo(5), NOW)).toBe("5 days ago");
    expect(ageLabel(daysAgo(420), NOW)).toBe("14 months ago");
    expect(ageLabel(daysAgo(1200), NOW)).toBe("3 years ago");
    expect(ageLabel(null, NOW)).toBeNull();
  });

  test("only stale/aging issues warn — live work is not nagged about", () => {
    expect(stalenessWarning("stale", "14 months ago")).toContain("may already be done");
    expect(stalenessWarning("aging", "4 months ago")).toContain("still wanted");
    expect(stalenessWarning("fresh", "2 days ago")).toBeNull();
    expect(stalenessWarning("unknown", null)).toBeNull();
  });
});
