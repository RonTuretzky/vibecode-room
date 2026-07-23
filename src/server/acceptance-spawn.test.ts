import { describe, expect, test } from "bun:test";
import { AcceptanceClassifier } from "../acceptance/classifier";
import { PendingSuggestionOwner } from "../acceptance/pending";
import { AcceptanceController, AcceptanceSpawner, createProcessRegistryAcceptanceSeam } from "../acceptance/spawn";
import { ProcessRegistry } from "../process/registry";
import { MemorySmithersClient } from "../process/test-helpers";
import { HeuristicDecisionLLM } from "../providers";
import type { DecisionInput, DecisionLLM, DecisionOutput } from "../providers";
import { cueDecisionSchema, type CueDecision, type PendingSuggestion, type TranscriptObservation } from "../types";

// ISSUE-0019: prove and harden the acceptance path. A spoken affirmative while a
// suggestion is pending is classified by the AcceptanceClassifier (intent-gate)
// and routed through the AcceptanceController/AcceptanceSpawner to
// ProcessRegistry.spawn — exactly once, with the pending suggestion's seed. The
// negatives (non-affirmative, below-threshold, no-pending) must NOT spawn, and
// the intent-gate must route through the selected (pluggable) DecisionLLM.

// A DecisionLLM spy: records every gate input and returns a caller-fixed verdict
// so the semantic-intent threshold drives accept/reject deterministically while
// proving the gate actually consulted the selected decider.
class RecordingDecisionLLM implements DecisionLLM {
  readonly inputs: DecisionInput[] = [];

  constructor(private readonly verdict: "action" | "pass") {}

  async decide(input: DecisionInput): Promise<DecisionOutput> {
    this.inputs.push(input);
    return {
      id: `spy-${input.correlationId}`,
      model: input.model,
      temperature: 0,
      decision: spyDecision(input, this.verdict),
      raw: { spy: true, verdict: this.verdict },
    };
  }
}

describe("acceptance classifier gating (unit)", () => {
  test("a bare affirmative is accepted via the prefilter without consulting the DecisionLLM", async () => {
    const llm = new RecordingDecisionLLM("pass");
    const { classifier } = setupClassifier(llm);

    const result = await classifier.classify({
      observation: observation("yes", "utt-yes"),
      correlationId: "corr-yes",
    });

    expect(result.kind).toBe("accept");
    expect(result.kind === "accept" ? result.gate.accepted : false).toBe(true);
    expect(result.kind === "accept" ? result.gate.source : "").toBe("prefilter");
    // A clear, short affirmative short-circuits at the prefilter — the gate never
    // had to reach the model.
    expect(llm.inputs).toHaveLength(0);
  });

  test("a non-affirmative below the accept lexicon is ignored, never reaching accept", async () => {
    const llm = new RecordingDecisionLLM("action");
    const { classifier } = setupClassifier(llm);

    const result = await classifier.classify({
      observation: observation("the weather looks nice today", "utt-weather"),
      correlationId: "corr-weather",
    });

    expect(result.kind).toBe("ignored");
    expect(result.kind === "ignored" ? result.reason : "").toBe("no-question-open");
    expect(llm.inputs).toHaveLength(0);
  });

  test("a decline phrase classifies as decline, not accept", async () => {
    const { classifier } = setupClassifier(new RecordingDecisionLLM("action"));

    const result = await classifier.classify({
      observation: observation("skip", "utt-skip"),
      correlationId: "corr-skip",
    });

    expect(result.kind).toBe("decline");
  });

  test("an adversative affirmative routes through the DecisionLLM and accepts only when it returns action", async () => {
    const llm = new RecordingDecisionLLM("action");
    const { classifier } = setupClassifier(llm);

    const result = await classifier.classify({
      observation: observation("yes, but wait on the build", "utt-yes-but"),
      correlationId: "corr-yes-but-accept",
    });

    // The prefilter rejected the adversative, so the gate consulted the selected
    // decider; an `action` verdict clears the threshold and accepts.
    expect(llm.inputs).toHaveLength(1);
    expect(llm.inputs[0]?.metadata?.gate).toBe("cue.semantic-intent");
    expect(result.kind).toBe("accept");
    expect(result.kind === "accept" ? result.gate.source : "").toBe("llm");
  });

  test("an adversative affirmative below the DecisionLLM threshold is ignored as intent-gate", async () => {
    const llm = new RecordingDecisionLLM("pass");
    const { classifier } = setupClassifier(llm);

    const result = await classifier.classify({
      observation: observation("yes, but wait on the build", "utt-yes-but"),
      correlationId: "corr-yes-but-reject",
    });

    expect(llm.inputs).toHaveLength(1);
    expect(result.kind).toBe("ignored");
    expect(result.kind === "ignored" ? result.reason : "").toBe("intent-gate");
    expect(result.kind === "ignored" ? result.gate?.accepted : true).toBe(false);
  });

  test("an affirmative with no pending suggestion is ignored as not-suggestion-delivery", async () => {
    const llm = new RecordingDecisionLLM("action");
    const pending = new PendingSuggestionOwner();
    // No acceptSuggestion(): the owner is idle with nothing pending.
    const classifier = new AcceptanceClassifier({ pending, semanticIntentGate: { llm } });

    const result = await classifier.classify({
      observation: observation("yes", "utt-yes-orphan"),
      correlationId: "corr-orphan",
    });

    expect(result.kind).toBe("ignored");
    expect(result.kind === "ignored" ? result.reason : "").toBe("not-suggestion-delivery");
    expect(llm.inputs).toHaveLength(0);
  });
});

describe("pending suggestion + affirmative -> registry.spawn (integration)", () => {
  test("an affirmative spawns the pending suggestion's seed through the registry exactly once", async () => {
    const runtime = createRuntime();
    runtime.controller.acceptSuggestion(suggestion());

    const result = await runtime.controller.observe({
      observation: observation("yes", "utt-accept"),
      correlationId: "corr-accept",
    });

    expect(result.kind).toBe("spawned");
    // The registry got exactly one spawn carrying the pending suggestion's seed.
    expect(spawnCalls(runtime)).toBe(1);
    expect(runtime.registry.records()).toHaveLength(1);
    expect(result.kind === "spawned" ? result.spawn.accepted : false).toBe(true);
    expect(result.kind === "spawned" && result.spawn.accepted ? result.spawn.seed : null).toEqual({
      pitch: "Build a replay dashboard",
      mcqs: ["Which fixture?"],
      answers: [],
    });
    // Pending is cleared on accept, so the suggestion can never double-spawn.
    expect(runtime.pending.pending()).toBeNull();
  });

  test("the gate routes through the selected DecisionLLM on the spawn path", async () => {
    const llm = new RecordingDecisionLLM("action");
    const runtime = createRuntime(llm);
    runtime.controller.acceptSuggestion(suggestion());

    const result = await runtime.controller.observe({
      observation: observation("yes, but only once", "utt-accept-gated"),
      correlationId: "corr-accept-gated",
    });

    expect(llm.inputs).toHaveLength(1);
    expect(result.kind).toBe("spawned");
    expect(spawnCalls(runtime)).toBe(1);
  });

  test("a second affirmative after a spawn is a no-op — the registry is not touched again", async () => {
    const runtime = createRuntime();
    runtime.controller.acceptSuggestion(suggestion());

    await runtime.controller.observe({ observation: observation("yes", "utt-accept"), correlationId: "corr-accept" });
    const again = await runtime.controller.observe({
      observation: observation("yes", "utt-accept-again"),
      correlationId: "corr-accept-again",
    });

    expect(again.kind).toBe("ignored");
    expect(spawnCalls(runtime)).toBe(1);
    expect(runtime.registry.records()).toHaveLength(1);
  });

  test("a non-affirmative does not spawn and leaves the registry empty", async () => {
    const runtime = createRuntime();
    runtime.controller.acceptSuggestion(suggestion());

    const result = await runtime.controller.observe({
      observation: observation("skip", "utt-skip"),
      correlationId: "corr-skip",
    });

    expect(result.kind).toBe("declined");
    expect(spawnCalls(runtime)).toBe(0);
    expect(runtime.registry.records()).toHaveLength(0);
    expect(runtime.pending.pending()).toBeNull();
  });

  test("an affirmative with no pending suggestion is a traced no-op", async () => {
    const runtime = createRuntime();
    // Never delivered a suggestion: nothing is pending.

    const result = await runtime.controller.observe({
      observation: observation("yes", "utt-orphan"),
      correlationId: "corr-orphan",
    });

    expect(result.kind).toBe("ignored");
    expect(result.kind === "ignored" ? result.classification.reason : "").toBe("not-suggestion-delivery");
    expect(spawnCalls(runtime)).toBe(0);
    expect(runtime.registry.records()).toHaveLength(0);
  });
});

interface Runtime {
  registry: ProcessRegistry;
  client: MemorySmithersClient;
  pending: PendingSuggestionOwner;
  controller: AcceptanceController;
}

function createRuntime(llm: DecisionLLM = new HeuristicDecisionLLM()): Runtime {
  const client = new MemorySmithersClient();
  const registry = new ProcessRegistry({ client, sessionId: "acceptance-spawn-test" });
  const pending = new PendingSuggestionOwner();
  const classifier = new AcceptanceClassifier({ pending, semanticIntentGate: { llm } });
  const spawner = new AcceptanceSpawner({
    seam: createProcessRegistryAcceptanceSeam(registry),
    sessionId: "acceptance-spawn-test",
    activeProcessCount: () => registry.activeRecords().length,
  });
  const controller = new AcceptanceController({ pending, classifier, spawner });
  return { registry, client, pending, controller };
}

function setupClassifier(llm: DecisionLLM): { classifier: AcceptanceClassifier; pending: PendingSuggestionOwner } {
  const pending = new PendingSuggestionOwner();
  // No MCQs: a non-affirmative has no open question to answer, so it falls
  // through to a clean "ignored", isolating the accept/decline gating.
  pending.acceptSuggestion({ ...suggestion(), mcqs: [] });
  const classifier = new AcceptanceClassifier({ pending, semanticIntentGate: { llm } });
  return { classifier, pending };
}

// TWO-STAGE PIVOT: an accept is KICKOFF only — registry.spawn no longer calls
// the smithers client (the durable run launches at the separate commission
// stage), so "how many spawns happened" is the registry's record count. The
// no-gateway-launch-at-accept invariant is asserted once explicitly below.
function spawnCalls(runtime: Runtime): number {
  expect(runtime.client.calls.filter((call) => call.name === "spawn")).toHaveLength(0);
  return runtime.registry.records().length;
}

function suggestion(): PendingSuggestion {
  return {
    suggestionId: "suggestion-0019",
    pitch: "Build a replay dashboard",
    mcqs: ["Which fixture?"],
    answers: [],
    correlationId: "corr-suggestion",
    expiresAt: 99_000,
  };
}

function observation(text: string, utteranceId: string): TranscriptObservation {
  return {
    text,
    isFinal: true,
    speaker: "Room",
    sessionId: "acceptance-spawn-test",
    latencyMs: 20,
    utteranceId,
  };
}

function spyDecision(input: DecisionInput, verdict: "action" | "pass"): CueDecision {
  const base = { policy: "spy.v0", decisionId: `spy-${input.correlationId}`, correlationId: input.correlationId, meta: {} };
  const decision =
    verdict === "action"
      ? {
          kind: "action" as const,
          action: { type: "spawn" as const, targetUPID: null, payload: { source: "spy" }, correlationId: input.correlationId },
          ...base,
        }
      : { kind: "pass" as const, addressed: false, reason: "ambient" as const, ...base };
  return cueDecisionSchema.parse(decision);
}
