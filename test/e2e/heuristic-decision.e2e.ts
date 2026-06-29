import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ReplayASRProvider } from "../../src/providers";
import { HeuristicDecisionLLM } from "../../src/providers/llm/heuristic";
import { SuggestionEngine, type SuggestionEngineDecision } from "../../src/suggest/engine";
import type { TranscriptObservation } from "../../src/types";

describe("heuristic decider drives a no-key suggestion path e2e", () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch in no-key path: ${String(args[0])}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("replay ASR + heuristic LLM consumer fires a suggestion with zero fetch calls", async () => {
    const decisions = await runConsumer(buildableObservations("heuristic-e2e"));

    expect(fetchCalls).toBe(0);
    expect(decisions.some((decision) => decision.kind === "fired")).toBe(true);
  });

  test("ambient-only replay produces no fired suggestion and still no fetch", async () => {
    const decisions = await runConsumer(ambientObservations("heuristic-e2e-ambient"));

    expect(fetchCalls).toBe(0);
    expect(decisions.some((decision) => decision.kind === "fired")).toBe(false);
    expect(decisions.every((decision) => decision.kind === "pass")).toBe(true);
  });
});

async function runConsumer(observations: TranscriptObservation[]): Promise<SuggestionEngineDecision[]> {
  const asr = new ReplayASRProvider(observations);
  const engine = new SuggestionEngine({
    sessionId: observations[0]?.sessionId ?? "heuristic-e2e",
    llm: new HeuristicDecisionLLM(),
    env: {
      VIBERSYN_SUGGEST_WORD_FLOOR: "3",
      VIBERSYN_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
      VIBERSYN_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
      VIBERSYN_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
    },
    clock: () => 1_000,
    idFactory: sequenceIds("e2e"),
  });

  const decisions: SuggestionEngineDecision[] = [];
  for await (const observation of asr.stream(emptyAudioStream())) {
    decisions.push(await engine.observe({ observation, correlationId: `corr-${observation.utteranceId}` }));
  }
  return decisions;
}

function buildableObservations(sessionId: string): TranscriptObservation[] {
  return [
    {
      text: "Let's build a dashboard tool to ship the replay prototype today.",
      isFinal: true,
      speaker: "speaker_0",
      sessionId,
      latencyMs: 20,
      utteranceId: "utt-build",
    },
  ];
}

function ambientObservations(sessionId: string): TranscriptObservation[] {
  return [
    {
      text: "The weather has been really nice and the coffee was good this morning.",
      isFinal: true,
      speaker: "speaker_0",
      sessionId,
      latencyMs: 20,
      utteranceId: "utt-ambient",
    },
  ];
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
