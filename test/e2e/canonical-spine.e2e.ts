import { describe, expect, test } from "bun:test";
import { runReplayObservations, type DecisionInput, type DecisionLLM } from "../../src/replay/harness";
import { runCanonicalSpineScenario } from "../../src/spine/canonical";
import type { TranscriptObservation } from "../../src/types";

describe("deterministic replay canonical spine and no-screen harness e2e", () => {
  test("AC5.4 reconstructs wake to decision to action to spoken ack under one correlationId", async () => {
    const result = await runCanonicalSpineScenario({ sessionId: "canonical-spine-ac54" });

    expect(result.chain.complete).toBe(true);
    expect(result.chain.missingStages).toEqual([]);
    expect(new Set(result.chain.events.map((event) => event.correlationId))).toEqual(new Set([result.correlationId]));
    expect(result.chain.observation.map((event) => event.event)).toContain("observe.final");
    expect(result.chain.decision.map((event) => event.event)).toEqual(
      expect.arrayContaining(["command.wake", "route.suggestion", "route.acceptance"]),
    );
    expect(result.chain.action.map((event) => event.event)).toContain("process.spawn");
    expect(result.chain.outcome.map((event) => event.event)).toEqual(expect.arrayContaining(["ack.emit", "output.tts"]));
    expect(result.spawned).toEqual(expect.objectContaining({ selected: true, state: "planning" }));
    expect(result.tts.calls.at(-1)?.text).toMatch(/spawned\.$/u);
  });

  test("AC5.3 stage sequencer follows audibly-legible canonical transitions", async () => {
    const result = await runCanonicalSpineScenario({ sessionId: "canonical-spine-ac53" });

    expect(result.transitions.map((transition) => `${transition.from}->${transition.to}`)).toEqual([
      "IDLE->ACTIVE_LISTEN",
      "ACTIVE_LISTEN->SUGGESTION_DELIVERY",
      "SUGGESTION_DELIVERY->SPAWN",
      "SPAWN->ACK",
    ]);
    expect(result.transitions.every((transition) => transition.correlationId === result.correlationId)).toBe(true);
    expect(result.transitions.map((transition) => transition.audible?.channel)).toEqual(["earcon", "ack", "earcon", "tts"]);
    expect(result.audio.calls.map((call) => call.clip.id)).toEqual(expect.arrayContaining(["E1", "route-suggestion", "E3"]));
  });

  test("AC5.1 no-screen harness observes zero GUI or keyboard consumption across the loop", async () => {
    const result = await runCanonicalSpineScenario({ sessionId: "canonical-spine-noscreen" });

    expect(result.noScreen.consumedEvents()).toEqual([]);
    expect(() => result.noScreen.assertZeroConsumed()).not.toThrow();
  });

  test("AC13.4 degradation keeps REQ-5 scenario green when fleet routing is disabled", async () => {
    const result = await runCanonicalSpineScenario({
      sessionId: "canonical-spine-fleet-disabled",
      fleetEnabled: false,
    });

    expect(result.fleetEnabled).toBe(false);
    expect(result.chain.complete).toBe(true);
    expect(result.chain.action.map((event) => event.event)).toContain("process.spawn");
    expect(result.registry.records()).toHaveLength(1);
    expect(result.noScreen.consumedEvents()).toEqual([]);
  });

  test("record-replay canonical scenario is deterministic across repeated runs and is not the live release gate", async () => {
    const observations = canonicalReplayObservations("canonical-replay-determinism");
    const first = await runReplayObservations(observations, canonicalReplayDecision());
    const second = await runReplayObservations(observations, canonicalReplayDecision());

    expect(second.jsonl).toBe(first.jsonl);
    expect(first.records).toHaveLength(2);
    expect(first.records.every((record) => record.input.temperature === 0)).toBe(true);
    expect(first.records.at(-1)?.output).toEqual(expect.objectContaining({ complete: true, consumedScreenEvents: 0 }));
  });
});

function canonicalReplayDecision(): DecisionLLM<Record<string, unknown>> {
  return {
    async decide(input: DecisionInput): Promise<Record<string, unknown>> {
      const result = await runCanonicalSpineScenario({
        sessionId: input.observation.sessionId,
        observations: canonicalReplayObservations(input.observation.sessionId),
        fleetEnabled: false,
      });
      return {
        utteranceId: input.observation.utteranceId,
        correlationId: result.correlationId,
        complete: result.chain.complete,
        actionEvents: result.chain.action.map((event) => event.event),
        outcomeEvents: result.chain.outcome.map((event) => event.event),
        consumedScreenEvents: result.noScreen.consumedEvents().length,
        spawned: result.spawned.callsign,
      };
    },
  };
}

function canonicalReplayObservations(sessionId: string): TranscriptObservation[] {
  return [
    {
      text: "Viber build canonical replay coverage with a no screen harness",
      isFinal: true,
      speaker: "speaker-canonical",
      sessionId,
      latencyMs: 25,
      utteranceId: "utt-wake-build",
    },
    {
      text: "yes",
      isFinal: true,
      speaker: "speaker-canonical",
      sessionId,
      latencyMs: 20,
      utteranceId: "utt-accept",
    },
  ];
}
