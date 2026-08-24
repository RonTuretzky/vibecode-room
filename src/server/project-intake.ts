/**
 * WHAT IS A PROJECT, AND WHAT SHOULD THE ROOM DO WITH IT?
 *
 * The QR/guest import took a link plus a free-text description and went
 * straight to building. Someone imported a repo and typed "just study it
 * first" — a perfectly clear instruction that the room silently ignored,
 * because the description was only ever used as build framing. Meanwhile the
 * tree grew issue fruit you could pick up and start work on, with no signal
 * that a GitHub issue can be years stale and already done.
 *
 * This module is the missing structure: an import declares an INTENT, and the
 * room does that. Two intents, because a room only really has two answers:
 *
 *   • "study"  — read the project and produce a brief. Nothing is built, and
 *     nothing is changed. This is the default for a repo imported with no
 *     instruction: a codebase you have never seen is something to understand
 *     before it is something to change.
 *   • "build"  — the old behavior; fan out to the build backends now. The
 *     default when there IS no repo (a context-only submission is an idea,
 *     and an idea has nothing to study).
 *
 * Both are honest defaults, and both can be said in plain language, because
 * that is what people actually do with the box.
 */

export type ProjectIntent = "study" | "build";

// Plain-language ways of asking for a read rather than a build. Deliberately
// literal — this decides whether the room writes code, so a stretch match is
// worse than a miss (a miss is one press away from being corrected).
const STUDY_PHRASES = [
  "study",
  "just look",
  "look at it",
  "look at this",
  "read it",
  "read this",
  "read through",
  "understand",
  "explore",
  "get familiar",
  "familiarize",
  "familiarise",
  "learn about",
  "review it",
  "review this",
  "analyze",
  "analyse",
  "summarize",
  "summarise",
  "explain",
  "audit",
  "survey",
  "what does it do",
  "what is this",
  "figure out",
  "orient",
  "onboard",
  "no changes",
  "don't build",
  "dont build",
  "do not build",
  "before building",
  "first before",
];

export function readIntent(description: string | null | undefined, hasRepo: boolean): ProjectIntent {
  const text = (description ?? "").toLowerCase();
  if (STUDY_PHRASES.some((phrase) => text.includes(phrase))) {
    return "study";
  }
  // NO INSTRUCTION AT ALL, with a repo: study it. Someone who pastes a link
  // and says nothing has not asked for anything to be built, and a codebase
  // nobody has described is exactly the case where a read comes first.
  //
  // ANY OTHER description is a build. Enumerating build verbs was the wrong
  // shape — "give the widget a dark mode" is obviously work, and no phrase
  // list survives the ways people describe what they want. Describing
  // something IS asking for it; asking to read is the marked case, and it is
  // the one with the short, checkable vocabulary above.
  if (hasRepo && text.trim().length === 0) {
    return "study";
  }
  return "build";
}

// ── issue freshness ─────────────────────────────────────────────────────────

/**
 * How stale a GitHub issue is. The room hangs open issues on a tree as fruit
 * you can pick and start working, which quietly implies they are all live
 * work — but a maintainer who does not groom their tracker leaves issues that
 * were fixed, abandoned, or made irrelevant years ago. The tree should say so
 * before someone spends a build on one.
 *
 * Thresholds are deliberately generous: plenty of healthy projects answer
 * issues in weeks, not days.
 */
export type IssueFreshness = "fresh" | "aging" | "stale" | "unknown";

export const ISSUE_AGING_DAYS = 90;
export const ISSUE_STALE_DAYS = 365;

export function issueFreshness(updatedAtMs: number | null | undefined, nowMs: number): IssueFreshness {
  if (typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs)) {
    return "unknown";
  }
  const days = (nowMs - updatedAtMs) / 86_400_000;
  if (days < 0) {
    return "fresh"; // clock skew: never claim staleness we cannot prove
  }
  if (days >= ISSUE_STALE_DAYS) {
    return "stale";
  }
  if (days >= ISSUE_AGING_DAYS) {
    return "aging";
  }
  return "fresh";
}

/** Human age for the fruit card: "3 days ago", "14 months ago". */
export function ageLabel(updatedAtMs: number | null | undefined, nowMs: number): string | null {
  if (typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs)) {
    return null;
  }
  const days = Math.floor((nowMs - updatedAtMs) / 86_400_000);
  if (days < 0) {
    return null;
  }
  if (days === 0) {
    return "today";
  }
  if (days === 1) {
    return "yesterday";
  }
  if (days < 30) {
    return `${days} days ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 24) {
    return `${months} month${months === 1 ? "" : "s"} ago`;
  }
  return `${Math.floor(days / 365)} years ago`;
}

/**
 * The warning a stale issue carries into the take-this-issue flow. Null when
 * there is nothing to warn about — the room does not nag about live work.
 */
export function stalenessWarning(freshness: IssueFreshness, age: string | null): string | null {
  if (freshness === "stale") {
    return `Last touched ${age ?? "over a year ago"} — it may already be done, or no longer wanted. Worth checking upstream before building.`;
  }
  if (freshness === "aging") {
    return `Last touched ${age ?? "a while ago"} — check it is still wanted.`;
  }
  return null;
}
