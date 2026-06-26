// e2e: a registry-selected DecisionLLM drives the SuggestionEngine to a fired
// suggestion, end to end, for each local backend (heuristic + replay) over a
// buildable utterance, with zero network.
//
// The registry is exercised exactly as a consumer would: through the providers
// barrel, by PANOP_DECISION_LLM, returning only the DecisionLLM seam. Both local
// backends are no-key and deterministic, so no mic, child process, or socket is
// opened.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ReplayASRProvider,
  selectDecisionLLM,
  type DecisionLLM,
  type DecisionLLMMode,
  type ReplayDecisionRecord,
} from "../../src/providers";
import {
  createSuggestionDecisionInput,
  DEFAULT_SUGGESTION_MODEL,
  SuggestionEngine,
  type SuggestionEngineDecision,
} from "../../src/suggest/engine";
import { cueDecisionSchema, type CueDecision, type TranscriptObservation } from "../../src/types";

const FIRING_ENV = {
  PANOP_SUGGEST_WORD_FLOOR: "3",
  PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
  PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
  PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
} as const;

describe("registry-selected decider drives a fired suggestion e2e", () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch in no-key registry e2e: ${String(args[0])}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("PANOP_DECISION_LLM=heuristic fires a suggestion with zero fetch calls", async () => {
    const selection = selectDecisionLLM({ PANOP_DECISION_LLM: "heuristic" });
    expect(selection.mode satisfies DecisionLLMMode).toBe("heuristic");

    const observation = buildableObservation("decision-registry-heuristic");
    const decisions = await runConsumer(selection.llm, [observation], sequenceIds("heur"));

    expect(fetchCalls).toBe(0);
    expect(decisions.some((decision) => decision.kind === "fired")).toBe(true);
  });

  test("PANOP_DECISION_LLM=replay fires the fixtured suggestion with zero fetch calls", async () => {
    const observation = buildableObservation("decision-registry-replay");
    const correlationId = `corr-${observation.utteranceId}`;
    // The replay decider is keyed on the exact DecisionInput the SuggestionEngine
    // builds, so reproduce it with the deterministic decisionId the idFactory
    // below will mint first (decisionId is the engine's first id call).
    const decisionId = "decision-rep-001";
    const record: ReplayDecisionRecord = {
      input: createSuggestionDecisionInput({ observation, correlationId, decisionId, model: DEFAULT_SUGGESTION_MODEL }),
      output: {
        id: `decision-${correlationId}`,
        model: DEFAULT_SUGGESTION_MODEL,
        temperature: 0,
        decision: firedActionDecision(correlationId, decisionId),
        raw: { replay: true },
      },
    };

    const selection = selectDecisionLLM({ PANOP_DECISION_LLM: "replay" }, { replayRecords: [record] });
    expect(selection.mode satisfies DecisionLLMMode).toBe("replay");

    const decisions = await runConsumer(selection.llm, [observation], sequenceIds("rep"), correlationId);

    expect(fetchCalls).toBe(0);
    expect(decisions.some((decision) => decision.kind === "fired")).toBe(true);
  });
});

async function runConsumer(
  llm: DecisionLLM,
  observations: TranscriptObservation[],
  idFactory: () => string,
  correlationId?: string,
): Promise<SuggestionEngineDecision[]> {
  const asr = new ReplayASRProvider(observations);
  const engine = new SuggestionEngine({
    sessionId: observations[0]?.sessionId ?? "decision-registry-e2e",
    llm,
    env: { ...FIRING_ENV },
    clock: () => 1_000,
    idFactory,
  });

  const decisions: SuggestionEngineDecision[] = [];
  for await (const observation of asr.stream(emptyAudioStream())) {
    decisions.push(
      await engine.observe({ observation, correlationId: correlationId ?? `corr-${observation.utteranceId}` }),
    );
  }
  return decisions;
}

function buildableObservation(sessionId: string): TranscriptObservation {
  return {
    text: "Let's build a dashboard tool to ship the replay prototype today.",
    isFinal: true,
    speaker: "speaker_0",
    sessionId,
    latencyMs: 20,
    utteranceId: "utt-build",
  };
}

function firedActionDecision(correlationId: string, decisionId: string): CueDecision {
  return cueDecisionSchema.parse({
    kind: "action",
    action: {
      type: "spawn",
      targetUPID: null,
      correlationId,
      payload: {
        quality: 0.92,
        pitch: "Build a dashboard tool to ship the replay prototype",
        mcqs: ["Scope it as one task?", "Spawn an agent now?"],
        answers: ["Yes, scope it", "Yes, spawn it"],
      },
    },
    policy: "replay-decider-e2e",
    decisionId,
    correlationId,
    meta: { quality: 0.92 },
  });
}

function emptyAudioStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function sequenceIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${String(++next).padStart(3, "0")}`;
}
