import { describe, expect, test } from "bun:test";
import { reconcile, statusForConfidence, type ReconcileOptions } from "./reconciler";
import type { DetectedIdea, IdeaCandidate, TranscriptTurn } from "./types";

const turns: TranscriptTurn[] = [
  { id: "turn-0001", speaker: null, text: "a", atMs: 0 },
  { id: "turn-0002", speaker: null, text: "b", atMs: 1 },
  { id: "turn-0003", speaker: null, text: "c", atMs: 2 },
];

function opts(over: Partial<ReconcileOptions> = {}): ReconcileOptions {
  let n = 0;
  return {
    nowMs: 1000,
    readyThreshold: 0.6,
    readyHysteresis: 0.12,
    maxMissedRounds: 2,
    idFactory: () => `idea-${++n}`,
    turns,
    ...over,
  };
}

function detected(over: Partial<DetectedIdea> = {}): DetectedIdea {
  return {
    matchId: null,
    pitch: "Build a thing",
    confidence: 0.8,
    questions: [],
    answers: [],
    contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0002", quote: "a b" },
    rationale: "",
    ...over,
  };
}

function candidate(over: Partial<IdeaCandidate> = {}): IdeaCandidate {
  return {
    id: "idea-existing",
    pitch: "Old pitch",
    confidence: 0.7,
    questions: [],
    answers: [],
    contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0001", quote: "a" },
    rationale: "",
    status: "ready",
    firstSeenAtMs: 0,
    updatedAtMs: 0,
    missedRounds: 0,
    ...over,
  };
}

describe("statusForConfidence", () => {
  test("promotes at threshold, holds with hysteresis, else forming", () => {
    expect(statusForConfidence(0.6, false, 0.6, 0.12)).toBe("ready");
    expect(statusForConfidence(0.55, false, 0.6, 0.12)).toBe("forming");
    expect(statusForConfidence(0.5, true, 0.6, 0.12)).toBe("ready"); // sticky within hysteresis
    expect(statusForConfidence(0.47, true, 0.6, 0.12)).toBe("forming"); // dropped below
  });
});

describe("reconcile", () => {
  test("creates a new candidate, status driven by confidence", () => {
    const r = reconcile([], [detected({ confidence: 0.9 })], opts());
    expect(r.created).toHaveLength(1);
    expect(r.candidates[0].status).toBe("ready");
    expect(r.candidates[0].id).toBe("idea-1");
    expect(r.candidates[0].contextSpan.startTurnId).toBe("turn-0001");
  });

  test("updates an existing candidate by matchId in place (keeps id + firstSeen)", () => {
    const existing = candidate({ id: "idea-keep", firstSeenAtMs: 5 });
    const r = reconcile([existing], [detected({ matchId: "idea-keep", pitch: "Elaborated pitch", confidence: 0.95 })], opts());
    expect(r.created).toHaveLength(0);
    expect(r.updated).toHaveLength(1);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].id).toBe("idea-keep");
    expect(r.candidates[0].pitch).toBe("Elaborated pitch");
    expect(r.candidates[0].firstSeenAtMs).toBe(5);
    expect(r.candidates[0].missedRounds).toBe(0);
  });

  test("merges by span overlap when matchId is omitted", () => {
    const existing = candidate({ id: "idea-overlap", contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0002", quote: "a b" } });
    const r = reconcile([existing], [detected({ matchId: null, contextSpan: { startTurnId: "turn-0002", endTurnId: "turn-0003", quote: "b c" } })], opts());
    expect(r.updated).toHaveLength(1);
    expect(r.candidates[0].id).toBe("idea-overlap");
  });

  test("ages an un-redetected candidate and supersedes it past maxMissedRounds", () => {
    let existing = candidate({ id: "idea-stale", missedRounds: 0 });
    let r = reconcile([existing], [], opts({ maxMissedRounds: 2 }));
    expect(r.candidates[0].missedRounds).toBe(1);
    existing = r.candidates[0];
    r = reconcile([existing], [], opts({ maxMissedRounds: 2 }));
    expect(r.candidates[0].missedRounds).toBe(2);
    existing = r.candidates[0];
    r = reconcile([existing], [], opts({ maxMissedRounds: 2 }));
    expect(r.candidates).toHaveLength(0); // superseded → dropped from active set
    expect(r.superseded).toHaveLength(1);
  });

  test("a distinct, non-overlapping idea becomes a second candidate", () => {
    const existing = candidate({ id: "idea-a", contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0001", quote: "a" } });
    const r = reconcile(
      [existing],
      [detected({ matchId: "idea-a", pitch: "still a" }), detected({ matchId: null, contextSpan: { startTurnId: "turn-0003", endTurnId: "turn-0003", quote: "c" }, pitch: "new b" })],
      opts(),
    );
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.map((c) => c.pitch)).toEqual(["still a", "new b"]);
  });
});
