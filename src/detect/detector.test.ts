import { describe, expect, test } from "bun:test";
import type { ClaudeCliRunner } from "./claude-cli";
import {
  HeuristicIdeaDetector,
  HostClaudeIdeaDetector,
  buildDetectionPrompt,
  parseDetectionReply,
  selectIdeaDetector,
} from "./detector";
import type { DetectionInput, TranscriptTurn } from "./types";

function turn(id: string, text: string, atMs = 0, speaker: string | null = "speaker_0"): TranscriptTurn {
  return { id, speaker, text, atMs };
}

function input(turns: TranscriptTurn[], known: DetectionInput["known"] = []): DetectionInput {
  return { sessionId: "session-x", correlationId: "corr-x", turns, known };
}

const laundromat = [
  turn("turn-0001", "so i have this idea for a crypto laundromat cooperative", 0),
  turn("turn-0002", "where all consumers get revenue share", 1),
  turn("turn-0003", "you can buy liquid ownership in the laundromat network", 2),
];

describe("buildDetectionPrompt", () => {
  test("includes labelled turns and known-candidate ids", () => {
    const prompt = buildDetectionPrompt(
      input(laundromat, [
        { id: "cand-1", pitch: "Crypto laundromat co-op", contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0001", quote: "x" } },
      ]),
    );
    expect(prompt).toContain("[turn-0001] speaker_0: so i have this idea");
    expect(prompt).toContain("id=cand-1");
    expect(prompt).toContain('{"ideas":[]}');
  });
});

describe("parseDetectionReply", () => {
  test("grounds the cited span to verbatim turn text (repairs a drifted quote)", () => {
    const reply = JSON.stringify({
      ideas: [
        {
          matchId: null,
          pitch: "Build a crypto laundromat co-op app",
          confidence: 0.88,
          questions: ["Token-gated membership?", "Revenue share on-chain?"],
          answers: ["Yes", "Yes"],
          startTurn: "turn-0001",
          endTurn: "turn-0003",
          quote: "model paraphrase that should be replaced",
          rationale: "concrete buildable product",
        },
      ],
    });
    const result = parseDetectionReply(reply, input(laundromat));
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0];
    expect(c.pitch).toBe("Build a crypto laundromat co-op app");
    expect(c.confidence).toBe(0.88);
    expect(c.contextSpan.startTurnId).toBe("turn-0001");
    expect(c.contextSpan.endTurnId).toBe("turn-0003");
    expect(c.contextSpan.quote).toBe(
      "so i have this idea for a crypto laundromat cooperative where all consumers get revenue share you can buy liquid ownership in the laundromat network",
    );
  });

  test("tolerates prose/fences around the JSON and clamps confidence", () => {
    const reply = "Sure!\n```json\n" + JSON.stringify({ ideas: [{ pitch: "Make a tool", confidence: 5, startTurn: "x", endTurn: "y" }] }) + "\n```";
    const result = parseDetectionReply(reply, input(laundromat));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].confidence).toBe(1);
    // unknown turn ids fall back to window bounds
    expect(result.candidates[0].contextSpan.startTurnId).toBe("turn-0001");
    expect(result.candidates[0].contextSpan.endTurnId).toBe("turn-0003");
  });

  test("empty ideas and malformed replies yield zero candidates", () => {
    expect(parseDetectionReply('{"ideas":[]}', input(laundromat)).candidates).toHaveLength(0);
    expect(parseDetectionReply("not json at all", input(laundromat)).candidates).toHaveLength(0);
    expect(parseDetectionReply(JSON.stringify({ ideas: [{ pitch: "", confidence: 0.9 }] }), input(laundromat)).candidates).toHaveLength(0);
  });

  test("preserves a model-supplied matchId for reconciliation", () => {
    const reply = JSON.stringify({ ideas: [{ matchId: "cand-7", pitch: "Add on-chain dividends", confidence: 0.7, startTurn: "turn-0002", endTurn: "turn-0002" }] });
    expect(parseDetectionReply(reply, input(laundromat)).candidates[0].matchId).toBe("cand-7");
  });
});

describe("HostClaudeIdeaDetector", () => {
  test("runs the injected CLI runner and returns grounded candidates", async () => {
    const runner: ClaudeCliRunner = async () =>
      JSON.stringify({ ideas: [{ pitch: "Crypto laundromat co-op", confidence: 0.9, startTurn: "turn-0001", endTurn: "turn-0002" }] });
    const detector = new HostClaudeIdeaDetector({ runner });
    const result = await detector.detect(input(laundromat));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].pitch).toBe("Crypto laundromat co-op");
  });

  test("fails soft (zero candidates) when the runner throws", async () => {
    const runner: ClaudeCliRunner = async () => {
      throw new Error("spawn failed");
    };
    const result = await new HostClaudeIdeaDetector({ runner }).detect(input(laundromat));
    expect(result.candidates).toHaveLength(0);
    expect(result.raw).toMatchObject({ error: "spawn failed" });
  });

  test("returns nothing for an empty window without calling the runner", async () => {
    let called = false;
    const runner: ClaudeCliRunner = async () => {
      called = true;
      return "{}";
    };
    const result = await new HostClaudeIdeaDetector({ runner }).detect(input([]));
    expect(result.candidates).toHaveLength(0);
    expect(called).toBe(false);
  });
});

describe("HeuristicIdeaDetector", () => {
  test("grounds one candidate to the contiguous buildable-cue turns", () => {
    const result = new HeuristicIdeaDetector().detectSync(input(laundromat));
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0];
    expect(c.contextSpan.startTurnId).toBe("turn-0001"); // "cooperative"
    expect(c.contextSpan.endTurnId).toBe("turn-0003"); // "network"
    expect(c.confidence).toBeGreaterThan(0.5);
  });

  test("emits nothing for pure chatter", () => {
    const chatter = [turn("turn-0001", "did you see the game last night"), turn("turn-0002", "yeah it was wild")];
    expect(new HeuristicIdeaDetector().detectSync(input(chatter)).candidates).toHaveLength(0);
  });

  test("sets matchId when a known candidate overlaps the cue span", () => {
    const known = [{ id: "cand-9", pitch: "x", contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0002", quote: "x" } }];
    const result = new HeuristicIdeaDetector().detectSync(input(laundromat, known));
    expect(result.candidates[0].matchId).toBe("cand-9");
  });
});

describe("selectIdeaDetector", () => {
  test("defaults to host-claude", () => {
    expect(selectIdeaDetector({}).mode).toBe("host-claude");
  });
  test("honors VIBERSYN_IDEA_DETECTOR=heuristic", () => {
    const sel = selectIdeaDetector({ VIBERSYN_IDEA_DETECTOR: "heuristic" });
    expect(sel.mode).toBe("heuristic");
    expect(sel.detector).toBeInstanceOf(HeuristicIdeaDetector);
  });
  test("throws on an unknown mode", () => {
    expect(() => selectIdeaDetector({ VIBERSYN_IDEA_DETECTOR: "gpt" })).toThrow(/Unknown VIBERSYN_IDEA_DETECTOR/u);
  });
});
