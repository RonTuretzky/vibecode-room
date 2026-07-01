import { describe, expect, test } from "bun:test";
import type { ClaudeCliRunner } from "./claude-cli";
import { HostClaudeIdeaDetector } from "./detector";
import {
  scoreDetection,
  scoreGrounding,
  scorePitchQuality,
  scoreStructure,
  toScorableIdea,
  type ScorableIdea,
} from "./scorers";
import type { DetectionInput, TranscriptTurn } from "./types";

function turn(id: string, text: string): TranscriptTurn {
  return { id, speaker: "speaker_0", text, atMs: 0 };
}

const laundromat: TranscriptTurn[] = [
  turn("turn-0001", "so i have this idea for a crypto laundromat cooperative"),
  turn("turn-0002", "where all consumers get revenue share"),
  turn("turn-0003", "you can buy liquid ownership in the laundromat network"),
];
const turnIds = new Set(laundromat.map((t) => t.id));

function idea(over: Partial<ScorableIdea> = {}): ScorableIdea {
  return { pitch: "Build a crypto laundromat co-op", confidence: 0.8, startTurnId: "turn-0001", endTurnId: "turn-0003", quote: "crypto laundromat cooperative", ...over };
}

describe("scoreGrounding", () => {
  test("1.0 when every idea cites real turns with a quote", () => {
    expect(scoreGrounding([idea()], turnIds).score).toBe(1);
  });
  test("0 when an idea cites a turn not in the window", () => {
    expect(scoreGrounding([idea({ startTurnId: "turn-9999" })], turnIds).score).toBe(0);
  });
  test("0 for a missing quote; partial for a mix", () => {
    expect(scoreGrounding([idea({ quote: "  " })], turnIds).score).toBe(0);
    expect(scoreGrounding([idea(), idea({ endTurnId: "turn-9999" })], turnIds).score).toBe(0.5);
  });
  test("empty candidate set is vacuously grounded", () => {
    expect(scoreGrounding([], turnIds).score).toBe(1);
  });
});

describe("scoreStructure", () => {
  test("flags empty pitch and out-of-range confidence", () => {
    expect(scoreStructure([idea()]).score).toBe(1);
    expect(scoreStructure([idea({ pitch: "" })]).score).toBe(0);
    expect(scoreStructure([idea({ confidence: 1.5 })]).score).toBe(0);
    expect(scoreStructure([idea({ confidence: -0.1 })]).score).toBe(0);
  });
});

describe("scorePitchQuality", () => {
  test("rewards crisp imperative pitches, penalizes long/hedged ones", () => {
    expect(scorePitchQuality([idea({ pitch: "Build a laundromat co-op app" })]).score).toBe(1);
    expect(scorePitchQuality([idea({ pitch: "Maybe build something not sure what exactly" })]).score).toBe(0); // hedged
    expect(scorePitchQuality([idea({ pitch: "a ".repeat(20).trim() })]).score).toBe(0); // > 14 words
  });
});

describe("toScorableIdea", () => {
  test("normalizes a runtime DetectedIdea (nested contextSpan)", () => {
    const s = toScorableIdea({ pitch: "X", confidence: 0.7, contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0002", quote: "q" } });
    expect(s).toEqual({ pitch: "X", confidence: 0.7, startTurnId: "turn-0001", endTurnId: "turn-0002", quote: "q" });
  });
  test("normalizes a flat workflow idea and rejects malformed ones", () => {
    expect(toScorableIdea({ pitch: "Y", confidence: 0.5, startTurnId: "turn-0001", endTurnId: "turn-0001", quote: "q" })?.pitch).toBe("Y");
    expect(toScorableIdea({ pitch: "", startTurnId: "turn-0001", endTurnId: "turn-0001" })).toBeNull();
  });
});

describe("scoreDetection over real detector output (fake runner, no live agent)", () => {
  test("a well-grounded detection scores >= 0.9 combined", async () => {
    const runner: ClaudeCliRunner = async () =>
      JSON.stringify({
        assessments: [
          {
            matchId: null,
            category: "proposal",
            concreteness: 2,
            buildableAsSoftware: 3,
            intent: 2,
            novelty: 2,
            pitch: "Crypto laundromat co-op with revenue share",
            startTurn: "turn-0001",
            endTurn: "turn-0003",
            quote: "ignored, repaired from turns",
            questions: [],
            answers: [],
            rationale: "buildable proposal",
          },
        ],
      });
    const input: DetectionInput = { sessionId: "s", correlationId: "c", turns: laundromat, known: [] };
    const result = await new HostClaudeIdeaDetector({ runner }).detect(input);

    const scorable = result.candidates.map((c) => toScorableIdea(c)).filter((v): v is ScorableIdea => v !== null);
    expect(scorable).toHaveLength(1);
    expect(scoreDetection(scorable, turnIds).score).toBeGreaterThanOrEqual(0.9);
  });

  test("a hallucinated span (turn id the model never saw) is caught by grounding", () => {
    // The detector repairs cited ids to window bounds, so to exercise the scorer we
    // grade a raw candidate that cites a nonexistent turn directly.
    const bogus: ScorableIdea = idea({ startTurnId: "turn-4242" });
    expect(scoreGrounding([bogus], turnIds).score).toBe(0);
    expect(scoreDetection([bogus], turnIds).score).toBeLessThan(0.8);
  });
});
