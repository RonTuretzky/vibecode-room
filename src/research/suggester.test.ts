import { describe, expect, test } from "bun:test";
import {
  HeuristicResearchSuggester,
  HostClaudeResearchSuggester,
  buildSuggestPrompt,
  parseSuggestions,
  selectResearchSuggester,
} from "./suggester";
import type { ResearchSuggestInput } from "./types";

function input(turnTexts: string[], known: ResearchSuggestInput["known"] = []): ResearchSuggestInput {
  return {
    sessionId: "test",
    correlationId: "corr-test",
    turns: turnTexts.map((text, index) => ({
      id: `rturn-${index + 1}`,
      speaker: `speaker-${(index % 2) + 1}`,
      text,
      atMs: 1000 + index * 1000,
    })),
    known,
  };
}

describe("HeuristicResearchSuggester", () => {
  test("claim-shaped turns (reported speech + numbers) become fact-checks", async () => {
    const suggester = new HeuristicResearchSuggester();
    const suggestions = await suggester.suggest(
      input(["I read that 80 percent of standups miss blockers entirely."]),
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.kind).toBe("fact-check");
    // Two signal categories (reported speech + numeric) → higher confidence.
    expect(suggestions[0]!.confidence).toBeCloseTo(0.7);
    expect(suggestions[0]!.contextSpan.startTurnId).toBe("rturn-1");
  });

  test("question-shaped turns become deep-dives; short chatter is ignored", async () => {
    const suggester = new HeuristicResearchSuggester();
    const suggestions = await suggester.suggest(
      input(["ok sounds good", "how does speaker diarization actually work under the hood"]),
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.kind).toBe("deep-dive");
  });

  test("claims already covered by known quests are not re-proposed", async () => {
    const suggester = new HeuristicResearchSuggester();
    const claim = "I read that 80 percent of standups miss blockers entirely.";
    const suggestions = await suggester.suggest(
      input([claim], [{ id: "rq-1", kind: "fact-check", topic: "standups", claim }]),
    );
    expect(suggestions).toHaveLength(0);
  });

  test("caps suggestions per round", async () => {
    const suggester = new HeuristicResearchSuggester();
    const texts = Array.from({ length: 6 }, (_, i) => `I read that ${70 + i} percent of teams always miss deadline number ${i}.`);
    const suggestions = await suggester.suggest(input(texts));
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });
});

describe("parseSuggestions", () => {
  test("parses a fenced JSON array and drops malformed elements", () => {
    const reply = [
      "Here is what I found:",
      "```json",
      JSON.stringify([
        {
          matchId: null,
          kind: "fact-check",
          topic: "EU AI Act timeline",
          claim: "The EU AI Act bans all facial recognition from 2026.",
          rationale: "Specific legal claim.",
          confidence: 0.8,
          contextSpan: { startTurnId: "rturn-1", endTurnId: "rturn-2", quote: "bans all facial recognition" },
        },
        { kind: "nonsense" },
      ]),
      "```",
    ].join("\n");
    const suggestions = parseSuggestions(reply);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.topic).toBe("EU AI Act timeline");
    expect(suggestions[0]!.matchId).toBeNull();
  });

  test("returns [] for prose with no array", () => {
    expect(parseSuggestions("nothing researchable here")).toEqual([]);
  });
});

describe("HostClaudeResearchSuggester", () => {
  test("feeds the turn window + known quests to the runner and validates output", async () => {
    let seenPrompt = "";
    const suggester = new HostClaudeResearchSuggester({
      runner: async (prompt) => {
        seenPrompt = prompt;
        return JSON.stringify([
          {
            matchId: "rq-known",
            kind: "deep-dive",
            topic: "Diarization",
            claim: "How does diarization work?",
            rationale: "",
            confidence: 0.6,
            contextSpan: { startTurnId: "rturn-1", endTurnId: "rturn-1", quote: "diarization" },
          },
        ]);
      },
    });
    const suggestions = await suggester.suggest(
      input(["how does diarization work"], [{ id: "rq-known", kind: "deep-dive", topic: "Diarization", claim: "old" }]),
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.matchId).toBe("rq-known");
    expect(seenPrompt).toContain("rq-known");
    expect(seenPrompt).toContain("how does diarization work");
  });

  test("empty window short-circuits without a model call", async () => {
    let calls = 0;
    const suggester = new HostClaudeResearchSuggester({
      runner: async () => {
        calls += 1;
        return "[]";
      },
    });
    expect(await suggester.suggest(input([]))).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("selectResearchSuggester", () => {
  test("defaults to host-claude; explicit heuristic wins", () => {
    expect(selectResearchSuggester({}).mode).toBe("host-claude");
    expect(selectResearchSuggester({ VIBERSYN_RESEARCH_SUGGESTER: "heuristic" }).mode).toBe("heuristic");
  });
});

describe("buildSuggestPrompt", () => {
  test("includes the JSON contract and the turns", () => {
    const prompt = buildSuggestPrompt(input(["a turn about something substantive"]));
    expect(prompt).toContain('"kind": "fact-check"|"deep-dive"|"bias-scan"');
    expect(prompt).toContain("a turn about something substantive");
  });
});
