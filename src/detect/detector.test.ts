import { describe, expect, test } from "bun:test";
import type { ClaudeCliRunner } from "./claude-cli";
import { HeuristicIdeaDetector, HostClaudeIdeaJudge, selectIdeaDetector } from "./detector";
import type { DetectionInput, TranscriptTurn } from "./types";

function turn(id: string, text: string, speaker: string | null = "speaker_0"): TranscriptTurn {
  return { id, speaker, text, atMs: 0 };
}

function input(turns: TranscriptTurn[], known: DetectionInput["known"] = []): DetectionInput {
  return { sessionId: "session-x", correlationId: "corr-x", turns, known };
}

const laundromat = [
  turn("turn-0001", "so i have this idea for a crypto laundromat cooperative"),
  turn("turn-0002", "where all consumers get revenue share"),
  turn("turn-0003", "you can buy liquid ownership in the laundromat network"),
];

const assessment = (over: Record<string, unknown> = {}) => ({
  matchId: null,
  category: "proposal",
  concreteness: 2,
  buildableAsSoftware: 2,
  intent: 2,
  novelty: 2,
  pitch: "Build a crypto laundromat co-op app",
  startTurn: "turn-0001",
  endTurn: "turn-0003",
  quote: "paraphrase",
  questions: ["Token-gated membership?"],
  answers: ["Yes", "No"],
  rationale: "concrete buildable product",
  ...over,
});

describe("HostClaudeIdeaJudge.detect", () => {
  test("judges the window via the rubric and returns grounded candidates with derived confidence", async () => {
    const prompts: string[] = [];
    const runner: ClaudeCliRunner = async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify({ assessments: [assessment()] });
    };
    const result = await new HostClaudeIdeaJudge({ runner }).detect(input(laundromat));
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0];
    expect(c.confidence).toBeCloseTo(0.667, 2); // derived, not model-supplied
    expect(c.judgment?.rubric.category).toBe("proposal");
    expect(c.contextSpan.quote).toContain("crypto laundromat cooperative"); // repaired
    // The prompt is the anchored-rubric judge prompt, not the old paragraph.
    expect(prompts[0]).toContain("concreteness 0-3");
    expect(prompts[0]).toContain("Example 6");
  });

  test("gated spans (existing product / joke) yield no candidates but are traced in raw", async () => {
    const runner: ClaudeCliRunner = async () =>
      JSON.stringify({
        assessments: [
          assessment({ category: "existing-product", novelty: 0, pitch: "Linear calendar" }),
          assessment({ category: "hypothetical", intent: 0, pitch: "Text your ex app" }),
        ],
      });
    const result = await new HostClaudeIdeaJudge({ runner }).detect(input(laundromat));
    expect(result.candidates).toHaveLength(0);
    expect((result.raw as { assessments: unknown[] }).assessments).toHaveLength(2);
  });

  test("fails soft (zero candidates) when the runner throws; empty window never calls the runner", async () => {
    let called = 0;
    const throwing: ClaudeCliRunner = async () => {
      called += 1;
      throw new Error("spawn failed");
    };
    const judge = new HostClaudeIdeaJudge({ runner: throwing });
    const result = await judge.detect(input(laundromat));
    expect(result.candidates).toHaveLength(0);
    expect(result.raw).toMatchObject({ error: "spawn failed" });
    await judge.detect(input([]));
    expect(called).toBe(1);
  });
});

describe("HostClaudeIdeaJudge.verify (adversarial pass)", () => {
  const judged = async (runner: ClaudeCliRunner) => {
    const detectRunner: ClaudeCliRunner = async () => JSON.stringify({ assessments: [assessment()] });
    const idea = (await new HostClaudeIdeaJudge({ runner: detectRunner }).detect(input(laundromat))).candidates[0];
    return { idea, judge: new HostClaudeIdeaJudge({ runner }) };
  };

  test("an explicit reject vetoes with the reason", async () => {
    const { idea, judge } = await judged(async (prompt) => {
      expect(prompt).toContain("Reject ONLY");
      expect(prompt).toContain("Build a crypto laundromat co-op app");
      return JSON.stringify({ verdict: "reject", reason: "this already exists as X" });
    });
    expect(await judge.verify(idea, input(laundromat))).toEqual({ uphold: false, reason: "this already exists as X" });
  });

  test("uphold, garbage, and runner errors all fail OPEN", async () => {
    const { idea } = await judged(async () => "unused");
    const uphold = new HostClaudeIdeaJudge({ runner: async () => JSON.stringify({ verdict: "uphold", reason: "new" }) });
    const garbage = new HostClaudeIdeaJudge({ runner: async () => "not json" });
    const broken = new HostClaudeIdeaJudge({
      runner: async () => {
        throw new Error("timeout");
      },
    });
    expect((await uphold.verify(idea, input(laundromat))).uphold).toBe(true);
    expect((await garbage.verify(idea, input(laundromat))).uphold).toBe(true);
    expect((await broken.verify(idea, input(laundromat))).uphold).toBe(true);
  });
});

describe("HeuristicIdeaDetector (rubric-shaped fallback)", () => {
  test("multi-cue talk surfaces (concreteness 2 → ~0.667); judgment attached", () => {
    const result = new HeuristicIdeaDetector().detectSync(input(laundromat));
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0];
    expect(c.judgment?.rubric.concreteness).toBe(2);
    expect(c.confidence).toBeCloseTo(0.667, 2);
    expect(c.contextSpan.startTurnId).toBe("turn-0001");
    expect(c.contextSpan.endTurnId).toBe("turn-0003");
  });

  test("a single cue is a forming idea (held below the default threshold)", () => {
    const result = new HeuristicIdeaDetector().detectSync(input([turn("turn-0001", "maybe an app for that")]));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].confidence).toBeCloseTo(0.55, 2);
    expect(result.candidates[0].judgment?.assessment.surfaceable).toBe(false);
  });

  test("pure chatter yields nothing; overlap sets matchId", () => {
    expect(new HeuristicIdeaDetector().detectSync(input([turn("t1", "how was the game")])).candidates).toHaveLength(0);
    const known = [{ id: "cand-9", pitch: "x", contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0002", quote: "x" } }];
    expect(new HeuristicIdeaDetector().detectSync(input(laundromat, known)).candidates[0].matchId).toBe("cand-9");
  });
});

describe("selectIdeaDetector", () => {
  test("defaults to host-claude; heuristic override; unknown throws", () => {
    expect(selectIdeaDetector({}).mode).toBe("host-claude");
    const sel = selectIdeaDetector({ VIBERSYN_IDEA_DETECTOR: "heuristic" });
    expect(sel.mode).toBe("heuristic");
    expect(sel.detector).toBeInstanceOf(HeuristicIdeaDetector);
    expect(() => selectIdeaDetector({ VIBERSYN_IDEA_DETECTOR: "gpt" })).toThrow(/Unknown VIBERSYN_IDEA_DETECTOR/u);
  });
});
