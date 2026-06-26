import { describe, expect, test } from "bun:test";
import { createSuggestionDecisionInput, SuggestionEngine } from "../../suggest/engine";
import { cueDecisionSchema, type TranscriptObservation } from "../../types";
import type { DecisionInput } from "../types";
import { HeuristicDecisionLLM, HEURISTIC_DECISION_POLICY } from "./heuristic";

const BUILDABLE: ReadonlyArray<{ label: string; text: string }> = [
  { label: "imperative build", text: "Let's build a dashboard to track our agent runs." },
  { label: "ship cue", text: "We should ship a prototype of the replay tool today." },
  { label: "prototype cue", text: "Can we prototype an API endpoint for the fixture service?" },
  { label: "scaffold cue", text: "Scaffold a small script that automates the deploy pipeline." },
];

const AMBIENT: ReadonlyArray<{ label: string; text: string }> = [
  { label: "greeting", text: "Hey, how was your weekend?" },
  { label: "weather", text: "The weather has been really nice this morning." },
  { label: "filler", text: "Yeah, totally, that makes sense to me." },
  { label: "status chatter", text: "I had two coffees and then read the news." },
];

describe("HeuristicDecisionLLM unit", () => {
  test("buildable utterances yield a spawn action that clears the quality threshold", async () => {
    const llm = new HeuristicDecisionLLM();
    for (const { label, text } of BUILDABLE) {
      const output = await llm.decide(inputFor(text, label));
      expect(output.temperature).toBe(0);
      expect(output.decision.kind).toBe("action");
      if (output.decision.kind !== "action") {
        throw new Error("expected action");
      }
      expect(output.decision.action.type).toBe("spawn");
      expect(output.decision.action.targetUPID).toBeNull();
      expect(output.decision.policy).toBe(HEURISTIC_DECISION_POLICY);
      const quality = (output.decision.meta as { quality?: number }).quality ?? 0;
      expect(quality).toBeGreaterThanOrEqual(0.7);
      expect(() => cueDecisionSchema.parse(output.decision)).not.toThrow();
    }
  });

  test("ambient speech yields a pass decision", async () => {
    const llm = new HeuristicDecisionLLM();
    for (const { label, text } of AMBIENT) {
      const output = await llm.decide(inputFor(text, label));
      expect(output.decision.kind).toBe("pass");
      if (output.decision.kind !== "pass") {
        throw new Error("expected pass");
      }
      expect(output.decision.reason).toBe("ambient");
      expect(output.decision.addressed).toBe(false);
      expect(() => cueDecisionSchema.parse(output.decision)).not.toThrow();
    }
  });

  test("is deterministic at temperature 0 with no key or network", async () => {
    const llm = new HeuristicDecisionLLM();
    const input = inputFor("Let's build a dashboard to track our agent runs.", "determinism");
    const first = await llm.decide(input);
    const second = await llm.decide(input);
    expect(second).toEqual(first);
  });

  test("rejects non-zero temperature inputs", async () => {
    const llm = new HeuristicDecisionLLM();
    const input = { ...inputFor("build a tool", "temp"), temperature: 0.7 } as unknown as DecisionInput;
    await expect(llm.decide(input)).rejects.toThrow(/temperature 0/u);
  });
});

describe("SuggestionEngine with HeuristicDecisionLLM integration", () => {
  test("fires a suggestion on a buildable utterance past the word/time floor", async () => {
    const engine = new SuggestionEngine({
      sessionId: "session-heuristic",
      llm: new HeuristicDecisionLLM(),
      env: fireEnv(),
      clock: () => 1_000,
      idFactory: sequenceIds("heuristic"),
    });

    const decision = await engine.observe({
      observation: observation("Let's build a dashboard tool to ship the replay prototype.", "utt-build"),
      correlationId: "corr-build",
    });

    expect(["queued", "fired"]).toContain(decision.kind);
    if (decision.kind === "fired") {
      expect(decision.suggestion.pitch.length).toBeGreaterThan(0);
    }
  });

  test("passes on ambient speech past the floor", async () => {
    const engine = new SuggestionEngine({
      sessionId: "session-heuristic-pass",
      llm: new HeuristicDecisionLLM(),
      env: fireEnv(),
      clock: () => 2_000,
      idFactory: sequenceIds("heuristic-pass"),
    });

    const decision = await engine.observe({
      observation: observation("The weather has been really nice this morning.", "utt-ambient"),
      correlationId: "corr-ambient",
    });

    expect(decision.kind).toBe("pass");
  });
});

function inputFor(text: string, utteranceId: string): DecisionInput {
  return createSuggestionDecisionInput({
    observation: observation(text, utteranceId),
    correlationId: `corr-${utteranceId}`,
    decisionId: `decision-${utteranceId}`,
  });
}

function observation(text: string, utteranceId: string): TranscriptObservation {
  return {
    text,
    isFinal: true,
    speaker: "speaker_0",
    sessionId: `session-${utteranceId}`,
    latencyMs: 10,
    utteranceId,
  };
}

function fireEnv(): Record<string, string | undefined> {
  return {
    PANOP_SUGGEST_WORD_FLOOR: "3",
    PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
  };
}

function sequenceIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${String(++next).padStart(3, "0")}`;
}
