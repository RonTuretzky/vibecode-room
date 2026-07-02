import { describe, expect, test } from "bun:test";
import { buildJudgePrompt, buildVerifyPrompt, parseJudgeReply, parseVerifyReply } from "./prompt";
import type { DetectionInput, JudgedIdea, TranscriptTurn } from "./types";

function turn(id: string, text: string, speaker = "amy"): TranscriptTurn {
  return { id, speaker, text, atMs: 0 };
}

const laundromat = [
  turn("turn-0001", "so i have this idea for a crypto laundromat cooperative"),
  turn("turn-0002", "where all consumers get revenue share", "bo"),
  turn("turn-0003", "you can buy liquid ownership in the laundromat network"),
];

function input(over: Partial<DetectionInput> = {}): DetectionInput {
  return { sessionId: "s", correlationId: "c", turns: laundromat, known: [], ...over };
}

function reply(assessments: unknown[]): string {
  return JSON.stringify({ assessments });
}

const strongProposal = {
  matchId: null,
  category: "proposal",
  concreteness: 2,
  buildableAsSoftware: 2,
  intent: 2,
  novelty: 2,
  pitch: "Build a crypto laundromat co-op app",
  startTurn: "turn-0001",
  endTurn: "turn-0003",
  quote: "model paraphrase to be repaired",
  questions: ["On-chain or points?"],
  answers: ["On-chain", "Points"],
  rationale: "genuine proposal",
};

describe("buildJudgePrompt", () => {
  test("carries the rubric anchors, hard-case exemplars, ledger, and speaker transcript", () => {
    const p = buildJudgePrompt(
      input({ known: [{ id: "idea-7", pitch: "Old pitch", contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0001", quote: "q" } }] }),
    );
    expect(p).toContain("concreteness 0-3");
    expect(p).toContain("FINAL stance");
    expect(p).toContain("existing-product");
    expect(p).toContain("Example 6"); // retraction exemplar
    expect(p).toContain("id=idea-7");
    expect(p).toContain("[turn-0002] bo: where all consumers get revenue share");
    expect(p).toContain('{"assessments":[]}');
  });
});

describe("parseJudgeReply", () => {
  test("a genuine proposal becomes a JudgedIdea with DERIVED confidence and repaired quote", () => {
    const parsed = parseJudgeReply(reply([strongProposal]), input());
    expect(parsed.ideas).toHaveLength(1);
    const idea = parsed.ideas[0];
    expect(idea.confidence).toBeCloseTo(0.667, 2); // derived from rubric, not model-supplied
    expect(idea.judgment.assessment.surfaceable).toBe(true);
    expect(idea.contextSpan.quote).toContain("crypto laundromat cooperative"); // repaired from turns
    expect(idea.questions).toEqual(["On-chain or points?"]);
  });

  test("model-supplied confidence is IGNORED (only the rubric matters)", () => {
    const parsed = parseJudgeReply(reply([{ ...strongProposal, confidence: 0.01 }]), input());
    expect(parsed.ideas[0].confidence).toBeCloseTo(0.667, 2);
  });

  test("hard-gated spans (existing product, joke) are recorded but NOT candidates", () => {
    const parsed = parseJudgeReply(
      reply([
        { ...strongProposal, category: "existing-product", novelty: 0, pitch: "Linear calendar" },
        { ...strongProposal, category: "hypothetical", intent: 0, pitch: "Text your ex app" },
        strongProposal,
      ]),
      input(),
    );
    expect(parsed.ideas).toHaveLength(1); // only the genuine proposal
    expect(parsed.assessments).toHaveLength(3); // all judged, for trace/evals
    expect(parsed.assessments[0].assessment.blockedBy).toContain("category:existing-product");
  });

  test("a held (forming) proposal IS a candidate — below threshold but not gated", () => {
    const parsed = parseJudgeReply(reply([{ ...strongProposal, concreteness: 1, intent: 1 }]), input());
    expect(parsed.ideas).toHaveLength(1);
    expect(parsed.ideas[0].judgment.assessment.surfaceable).toBe(false);
    expect(parsed.ideas[0].confidence).toBeGreaterThan(0);
  });

  test("retraction exemplar shape: proposal with intent 1 is held, not surfaced", () => {
    const parsed = parseJudgeReply(reply([{ ...strongProposal, intent: 1, pitch: "Sandwich vibe app" }]), input());
    expect(parsed.ideas[0].judgment.assessment.surfaceable).toBe(false);
    expect(parsed.ideas[0].judgment.assessment.blockedBy).toContain("intent-too-low");
  });

  test("junk rubric values are clamped; stale ids never fabricate a window-wide span", () => {
    // Both ids unknown + no matchId → anchor to the window's LATEST turn (where
    // the current talk is), never first..last (which would overlap everything).
    const parsed = parseJudgeReply(
      reply([{ ...strongProposal, concreteness: 99, startTurn: "turn-nope", endTurn: "turn-nope", quote: "model quote kept" }]),
      input(),
    );
    expect(parsed.ideas[0].judgment.rubric.concreteness).toBe(3);
    expect(parsed.ideas[0].contextSpan.startTurnId).toBe("turn-0003");
    expect(parsed.ideas[0].contextSpan.endTurnId).toBe("turn-0003");
    expect(parsed.ideas[0].contextSpan.quote).toBe("model quote kept");
  });

  test("one valid endpoint clamps to it; a matchId with stale ids keeps the tracked idea's span", () => {
    // Only endTurn valid → both endpoints clamp to it.
    const clamped = parseJudgeReply(reply([{ ...strongProposal, startTurn: "turn-nope", endTurn: "turn-0002" }]), input());
    expect(clamped.ideas[0].contextSpan.startTurnId).toBe("turn-0002");
    expect(clamped.ideas[0].contextSpan.endTurnId).toBe("turn-0002");
    // Stale ids + matchId → fall back to the tracked idea's original span (ids
    // are stable forever), with the model quote.
    const known = [{ id: "idea-7", pitch: "Old", contextSpan: { startTurnId: "turn-9001", endTurnId: "turn-9002", quote: "orig" } }];
    const parsed = parseJudgeReply(
      reply([{ ...strongProposal, matchId: "idea-7", startTurn: "turn-9001", endTurn: "turn-9002", quote: "new quote" }]),
      input({ known }),
    );
    expect(parsed.ideas[0].contextSpan).toEqual({ startTurnId: "turn-9001", endTurnId: "turn-9002", quote: "new quote" });
  });

  test("a HARD-GATED re-assessment of a tracked idea IS kept (strong retractions demote immediately)", () => {
    // intent 0 (became a joke) with matchId → confidence 0 but still a candidate,
    // so the ledger can un-surface the tracked idea now, not after stale-supersede.
    const parsed = parseJudgeReply(reply([{ ...strongProposal, matchId: "idea-7", intent: 0 }]), input());
    expect(parsed.ideas).toHaveLength(1);
    expect(parsed.ideas[0].confidence).toBe(0);
    expect(parsed.ideas[0].matchId).toBe("idea-7");
    // …but the same gated span WITHOUT a matchId is still dropped.
    expect(parseJudgeReply(reply([{ ...strongProposal, matchId: null, intent: 0 }]), input()).ideas).toHaveLength(0);
  });

  test("matchId is preserved for ledger reconciliation; malformed replies degrade to empty", () => {
    expect(parseJudgeReply(reply([{ ...strongProposal, matchId: "idea-9" }]), input()).ideas[0].matchId).toBe("idea-9");
    expect(parseJudgeReply("total garbage", input()).ideas).toHaveLength(0);
    expect(parseJudgeReply('{"assessments":[]}', input()).ideas).toHaveLength(0);
  });
});

describe("verification prompts", () => {
  const idea = (): JudgedIdea => parseJudgeReply(reply([strongProposal]), input()).ideas[0];

  test("buildVerifyPrompt carries the pitch, rubric, evidence, and transcript", () => {
    const p = buildVerifyPrompt(idea(), input());
    expect(p).toContain("WHEN IN DOUBT, UPHOLD");
    expect(p).toContain("Build a crypto laundromat co-op app");
    expect(p).toContain("turn-0001..turn-0003");
    expect(p).toContain("[turn-0002] bo:");
  });

  test("parseVerifyReply: explicit reject rejects; everything else fails OPEN", () => {
    expect(parseVerifyReply('{"verdict":"reject","reason":"already exists"}')).toEqual({ uphold: false, reason: "already exists" });
    expect(parseVerifyReply('{"verdict":"uphold","reason":"genuinely new"}').uphold).toBe(true);
    expect(parseVerifyReply("garbled").uphold).toBe(true); // fail-open
    expect(parseVerifyReply('{"verdict":"unsure"}').uphold).toBe(true);
  });
});
