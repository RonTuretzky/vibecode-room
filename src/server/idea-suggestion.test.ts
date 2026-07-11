import { describe, expect, test } from "bun:test";
import type { IdeaCandidate } from "../detect";
import { ideaTrayFromCandidates, ideaTrayItemFromCandidate } from "./idea-suggestion";

// The idea TRAY projection: ledger candidates → IdeaTrayItem, ready first, then
// confidence descending — the ordering the projector renders verbatim.

function candidate(overrides: Partial<IdeaCandidate> = {}): IdeaCandidate {
  return {
    id: "idea-1",
    pitch: "Build a dashboard",
    confidence: 0.8,
    questions: [],
    answers: [],
    contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0002", quote: "context quote" },
    spans: [
      { startTurnId: "turn-0001", endTurnId: "turn-0001", quote: "first quote" },
      { startTurnId: "turn-0001", endTurnId: "turn-0002", quote: "latest quote" },
    ],
    rationale: "grounded proposal",
    status: "ready",
    maturity: "proposed",
    verified: true,
    vetoReason: null,
    roundsSeen: 2,
    firstSeenAtMs: 0,
    updatedAtMs: 10,
    missedRounds: 0,
    ...overrides,
  };
}

describe("ideaTrayItemFromCandidate", () => {
  test("maps the candidate fields and takes the LATEST span quote as evidence", () => {
    const item = ideaTrayItemFromCandidate(candidate());
    expect(item).toEqual({
      id: "idea-1",
      pitch: "Build a dashboard",
      confidence: 0.8,
      status: "ready",
      maturity: "proposed",
      verified: true,
      rationale: "grounded proposal",
      evidence: "latest quote",
    });
  });

  test("falls back to the contextSpan quote when the latest span has no text", () => {
    const item = ideaTrayItemFromCandidate(
      candidate({ spans: [{ startTurnId: "turn-0001", endTurnId: "turn-0001", quote: "" }] }),
    );
    expect(item.evidence).toBe("context quote");
  });

  test("omits evidence/rationale when neither quote nor rationale is available", () => {
    const item = ideaTrayItemFromCandidate(
      candidate({
        rationale: "",
        spans: [],
        contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0001", quote: "" },
      }),
    );
    expect(item.evidence).toBeUndefined();
    expect(item.rationale).toBeUndefined();
  });

  test("anything not ready renders as forming and confidence is clamped to 0..1", () => {
    const item = ideaTrayItemFromCandidate(candidate({ status: "forming", confidence: 1.7 }));
    expect(item.status).toBe("forming");
    expect(item.confidence).toBe(1);
  });
});

describe("ideaTrayFromCandidates — ordering (contract)", () => {
  test("ready candidates come first, then confidence descending within each group", () => {
    const tray = ideaTrayFromCandidates([
      candidate({ id: "forming-strong", status: "forming", confidence: 0.5 }),
      candidate({ id: "ready-weak", status: "ready", confidence: 0.6 }),
      candidate({ id: "forming-weak", status: "forming", confidence: 0.2 }),
      candidate({ id: "ready-strong", status: "ready", confidence: 0.9 }),
    ]);
    expect(tray.map((item) => item.id)).toEqual(["ready-strong", "ready-weak", "forming-strong", "forming-weak"]);
  });

  test("an empty ledger maps to an empty tray", () => {
    expect(ideaTrayFromCandidates([])).toEqual([]);
  });
});
