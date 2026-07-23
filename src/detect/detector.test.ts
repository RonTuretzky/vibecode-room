import { describe, expect, test } from "bun:test";
import type { ClaudeCliRunner } from "./claude-cli";
import { HeuristicIdeaDetector, HostClaudeIdeaJudge, selectIdeaDetector } from "./detector";
import type { DetectionInput, TranscriptTurn } from "./types";

function turn(id: string, text: string, speaker: string | null = "speaker_0", atMs = 0): TranscriptTurn {
  return { id, speaker, text, atMs };
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

describe("HeuristicIdeaDetector clustering (back-to-back ideas)", () => {
  // Idea 1 (t1), three turns of chatter, idea 2 (t5) — the exact shape the old
  // single-span detector merged into ONE candidate spanning t1..t5.
  const twoIdeas = [
    turn("t1", "let's build a chrome extension for tab hoarders"),
    turn("t2", "how was the game last night"),
    turn("t3", "did you catch that final play"),
    turn("t4", "unbelievable finish honestly"),
    turn("t5", "ooh we should make a split calculator for rent"),
  ];

  test("two ideas three chatter turns apart yield TWO candidates with per-cluster spans and pitches", () => {
    const result = new HeuristicIdeaDetector().detectSync(input(twoIdeas));
    expect(result.candidates).toHaveLength(2);
    const [first, second] = result.candidates;
    expect(first.contextSpan.startTurnId).toBe("t1");
    expect(first.contextSpan.endTurnId).toBe("t1");
    expect(second.contextSpan.startTurnId).toBe("t5");
    expect(second.contextSpan.endTurnId).toBe("t5");
    expect(first.pitch).toContain("chrome extension");
    expect(second.pitch).toContain("split calculator");
  });

  test("chatter between clusters never merges spans or leaks into a cluster's quote", () => {
    const result = new HeuristicIdeaDetector().detectSync(input(twoIdeas));
    for (const c of result.candidates) {
      expect(c.contextSpan.quote).not.toContain("game last night");
    }
  });

  test("a >= 45s silence between cue turns splits clusters even with zero chatter between", () => {
    const spaced = [
      turn("t1", "let's build a habit tracker", "speaker_0", 0),
      turn("t2", "and make a standup timer app", "speaker_0", 60_000),
    ];
    expect(new HeuristicIdeaDetector().detectSync(input(spaced)).candidates).toHaveLength(2);
  });

  test("a brief aside inside the gap limits stays ONE cluster whose span covers it", () => {
    const oneArc = [
      turn("t1", "let's build a habit tracker", "speaker_0", 0),
      turn("t2", "hang on let me grab water", "speaker_0", 10_000),
      turn("t3", "it could integrate a streak timer", "speaker_0", 20_000),
    ];
    const result = new HeuristicIdeaDetector().detectSync(input(oneArc));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].contextSpan.startTurnId).toBe("t1");
    expect(result.candidates[0].contextSpan.endTurnId).toBe("t3");
  });

  test("a known candidate only matches (suppresses) its OWN cluster; the fresh cluster stays new", () => {
    const known = [{ id: "cand-1", pitch: "chrome extension", contextSpan: { startTurnId: "t1", endTurnId: "t1", quote: "q" } }];
    const [first, second] = new HeuristicIdeaDetector().detectSync(input(twoIdeas, known)).candidates;
    expect(first.matchId).toBe("cand-1");
    expect(second.matchId).toBeNull();
  });

  test("cluster gaps are env-overridable (via selectIdeaDetector too); invalid values throw", () => {
    const loose = new HeuristicIdeaDetector({ env: { VIBERSYN_HEURISTIC_CLUSTER_GAP_TURNS: "10", VIBERSYN_HEURISTIC_CLUSTER_GAP_MS: "600000" } });
    expect(loose.detectSync(input(twoIdeas)).candidates).toHaveLength(1);
    const sel = selectIdeaDetector({ VIBERSYN_IDEA_DETECTOR: "heuristic", VIBERSYN_HEURISTIC_CLUSTER_GAP_TURNS: "10", VIBERSYN_HEURISTIC_CLUSTER_GAP_MS: "600000" });
    expect((sel.detector as HeuristicIdeaDetector).detectSync(input(twoIdeas)).candidates).toHaveLength(1);
    expect(() => new HeuristicIdeaDetector({ env: { VIBERSYN_HEURISTIC_CLUSTER_GAP_MS: "nope" } })).toThrow(/VIBERSYN_HEURISTIC_CLUSTER_GAP_MS/u);
  });
});

describe("BUILDABLE_CUES artifact nouns (word-boundary matching)", () => {
  test("a verbatim chrome-extension idea is detectable and surfaceable", () => {
    const result = new HeuristicIdeaDetector().detectSync(input([turn("t1", "a chrome extension that puts a timer on every tab")]));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].judgment?.rubric.concreteness).toBe(2); // chrome + extension + timer
    expect(result.candidates[0].judgment?.assessment.surfaceable).toBe(true);
  });

  test("plugin / tracker / calculator each cue on their own; stems and inflections do NOT", () => {
    for (const text of ["ship the figma plugin", "a habit tracker maybe", "just a tip calculator"]) {
      expect(new HeuristicIdeaDetector().detectSync(input([turn("t1", text)])).candidates).toHaveLength(1);
    }
    // Whole-word matching: morphological variants must not fire the cue.
    for (const text of ["we could extend the deadline", "tracking the score by hand", "i calculated the rent already"]) {
      expect(new HeuristicIdeaDetector().detectSync(input([turn("t1", text)])).candidates).toHaveLength(0);
    }
  });
});

describe("BUILDABLE_CUES ASR verb forms", () => {
  test("'built' and 'building' cue like 'build' — Deepgram hears live speech in those forms", () => {
    for (const text of ["uber for cats built uber for cats", "we should be building a ride app for pets"]) {
      expect(new HeuristicIdeaDetector().detectSync(input([turn("t1", text)])).candidates).toHaveLength(1);
    }
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
