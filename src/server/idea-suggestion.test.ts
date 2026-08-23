import { describe, expect, test } from "bun:test";
import type { IdeaCandidate } from "../detect";
import { pendingSuggestionSchema } from "../types";
import { briefFromCandidate, ideaTrayFromCandidates, ideaTrayItemFromCandidate, pendingSuggestionFromCandidate } from "./idea-suggestion";

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

describe("briefFromCandidate — the ONE place the idea's context brief is constructed", () => {
  test("maps pitch, grounding quote, rationale, deck-normalized Q&A, and maturity from the candidate", () => {
    const brief = briefFromCandidate(
      candidate({
        questions: ["Which sound set?"],
        answers: ["Wood / Electronic"],
      }),
    );
    expect(brief.pitch).toBe("Build a dashboard");
    expect(brief.sourceQuote).toBe("context quote");
    expect(brief.rationale).toBe("grounded proposal");
    expect(brief.qa).toHaveLength(1);
    expect(brief.qa[0]?.id).toMatch(/^q-/u);
    expect(brief.qa[0]?.prompt).toBe("Which sound set?");
    expect(brief.qa[0]?.answers).toEqual(["Wood", "Electronic"]);
    expect(brief.qa[0]?.chosen).toBeUndefined();
    expect(brief.callsign).toBeNull();
    expect(brief.maturity).toBe("proposed");
  });

  test("clamps the source quote at 300 chars and the rationale at 200 (prompt-growth contract)", () => {
    const brief = briefFromCandidate(
      candidate({
        contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0009", quote: "q".repeat(500) },
        rationale: "r".repeat(500),
      }),
    );
    expect(brief.sourceQuote).toHaveLength(300);
    expect(brief.sourceQuote.endsWith("…")).toBe(true);
    expect(brief.rationale).toHaveLength(200);
    expect(brief.rationale.endsWith("…")).toBe(true);
  });

  test("a question-less candidate yields an empty qa list, never a fabricated card", () => {
    expect(briefFromCandidate(candidate()).qa).toEqual([]);
  });

  test("pendingSuggestionFromCandidate carries the brief AND survives the strict schema re-parse", () => {
    // The acceptance path re-parses the suggestion through the .strict()
    // pendingSuggestionSchema (pending.ts) — the brief must ride through
    // WITHOUT being stripped or rejected, or context dies at acceptance.
    const suggestion = pendingSuggestionFromCandidate(
      candidate({ questions: ["Which sound set?"], answers: ["Wood / Electronic"] }),
      "corr-brief",
      99_000,
    );
    expect(suggestion.brief).toEqual(briefFromCandidate(candidate({ questions: ["Which sound set?"], answers: ["Wood / Electronic"] })));
    const reparsed = pendingSuggestionSchema.parse(suggestion);
    expect(reparsed).toEqual(suggestion);
    expect(reparsed.brief?.sourceQuote).toBe("context quote");
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
