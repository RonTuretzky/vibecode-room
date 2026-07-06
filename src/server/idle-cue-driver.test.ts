import { describe, expect, test } from "bun:test";
import { ttsDecision } from "../audio/output-policy";
import { SuggestionEngine } from "../suggest/engine";
import type { DecisionInput, DecisionLLM, DecisionOutput } from "../providers";
import type { CueDecision, OutputDecision, PendingSuggestion, TranscriptObservation } from "../types";
import { IdleCueDriver, type IdleCueObserver } from "./idle-cue-driver";

// ISSUE-0024 unit: the driver calls observeIdleCue exactly once after the
// configured silence, keyed off the injected clock — never before the gap, and
// never twice for the same silence window. A fresh utterance re-arms it.
describe("IdleCueDriver — idle tick fires observeIdleCue after the gap", () => {
  test("calls observeIdleCue exactly once once silence crosses the configured gap", async () => {
    const now = adjustableClock(10_000);
    let lastFinal: number | null = null;
    const engine = new RecordingIdleObserver();
    const driver = new IdleCueDriver({
      engine,
      sessionId: "session-idle",
      clock: now.clock,
      lastFinalAtMs: () => lastFinal,
      env: { VIBERSYN_SUGGEST_IDLE_GAP_SECONDS: "10" },
      idFactory: sequenceIds("idle"),
    });

    // No FINAL utterance yet: nothing to measure, no call.
    expect(await driver.tick()).toBeNull();
    expect(engine.calls).toHaveLength(0);

    // A FINAL utterance lands; the room then goes quiet but not yet a full gap.
    lastFinal = now.clock();
    now.advance(9_000);
    expect(await driver.tick()).toBeNull();
    expect(engine.calls).toHaveLength(0);

    // The gap elapses with no further utterance — deliver exactly once.
    now.advance(1_000);
    const fired = await driver.tick();
    expect(fired?.kind).toBe("fired");
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]).toEqual(
      expect.objectContaining({ sessionId: "session-idle", idleForMs: 10_000 }),
    );

    // Further ticks during the SAME silence window are no-ops.
    now.advance(30_000);
    expect(await driver.tick()).toBeNull();
    expect(engine.calls).toHaveLength(1);
  });

  test("a fresh utterance before the gap resets the idle timer and suppresses delivery", async () => {
    const now = adjustableClock(0);
    let lastFinal: number | null = now.clock();
    const engine = new RecordingIdleObserver();
    const driver = new IdleCueDriver({
      engine,
      sessionId: "session-reset",
      clock: now.clock,
      lastFinalAtMs: () => lastFinal,
      env: { VIBERSYN_SUGGEST_IDLE_GAP_SECONDS: "10" },
      idFactory: sequenceIds("reset"),
    });

    // Almost at the gap, then a fresh utterance moves last-final forward.
    now.advance(9_000);
    lastFinal = now.clock();
    now.advance(1_000); // 1s of silence since the new utterance — under the gap.
    expect(await driver.tick()).toBeNull();
    expect(engine.calls).toHaveLength(0);

    // A full gap after the fresh utterance now delivers, exactly once.
    now.advance(9_000);
    expect((await driver.tick())?.kind).toBe("fired");
    expect(engine.calls).toHaveLength(1);
  });

  test("the idle gap is configurable via VIBERSYN_SUGGEST_IDLE_GAP_SECONDS", async () => {
    const now = adjustableClock(0);
    const lastFinal = now.clock();
    const engine = new RecordingIdleObserver();
    const driver = new IdleCueDriver({
      engine,
      sessionId: "session-config",
      clock: now.clock,
      lastFinalAtMs: () => lastFinal,
      env: { VIBERSYN_SUGGEST_IDLE_GAP_SECONDS: "3" },
      idFactory: sequenceIds("config"),
    });

    now.advance(2_999);
    expect(await driver.tick()).toBeNull();
    now.advance(1);
    expect((await driver.tick())?.kind).toBe("fired");
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]?.idleForMs).toBe(3_000);
  });
});

// ISSUE-0024 integration: a suggestion that QUEUES at observe time (interrupt
// cost too high to barge in) becomes a fired OutputDecision once the driver's
// idle tick delivers it after the configured gap.
describe("IdleCueDriver — deferred suggestion delivered on idle", () => {
  test("a queued suggestion becomes a fired, spoken OutputDecision after the idle tick", async () => {
    const now = adjustableClock(50_000);
    const accepted: PendingSuggestion[] = [];
    const engine = new SuggestionEngine({
      sessionId: "session-deferred",
      llm: new StubDecisionLLM(0.9),
      clock: now.clock,
      idFactory: sequenceIds("deferred"),
      env: { VIBERSYN_SUGGEST_WORD_FLOOR: "5", VIBERSYN_SUGGEST_IDLE_GAP_SECONDS: "10" },
      acceptanceOwner: {
        acceptSuggestion(suggestion) {
          accepted.push(suggestion);
        },
      },
    });

    // High interrupt cost (pending steering + fresh recency) forces a queue, not
    // an immediate fire, even though the quality clears the threshold.
    const queued = await engine.observe({
      observation: finalObservation(words(40), "utt-defer"),
      correlationId: "corr-defer",
      pendingSteerings: 1,
    });
    expect(queued.kind).toBe("queued");
    expect(accepted).toHaveLength(0);

    // Wire the driver against the live engine and a spoken-delivery hook. The
    // room's last-final time is the moment the buildable utterance was observed.
    const spoken: OutputDecision[] = [];
    const lastFinal = now.clock();
    const driver = new IdleCueDriver({
      engine,
      sessionId: "session-deferred",
      clock: now.clock,
      lastFinalAtMs: () => lastFinal,
      env: { VIBERSYN_SUGGEST_IDLE_GAP_SECONDS: "10" },
      idFactory: sequenceIds("driver"),
      onDecision: async (decision) => {
        if (decision.kind === "fired") {
          spoken.push(await ttsDecision(`${decision.suggestion.pitch}. ${decision.suggestion.mcqs[0]}`, { fallback: "I have a suggestion." }));
        }
      },
    });

    // Under the gap: no delivery.
    now.advance(9_000);
    expect(await driver.tick()).toBeNull();
    expect(spoken).toHaveLength(0);

    // The gap elapses with no further utterance — the queued suggestion fires.
    now.advance(1_000);
    const fired = await driver.tick();
    expect(fired?.kind).toBe("fired");
    expect(accepted).toHaveLength(1);

    // The fired suggestion produced a spoken OutputDecision through the hook.
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.channel).toBe("tts");
    expect(spoken[0]?.channel === "tts" && spoken[0].text.length).toBeGreaterThan(0);
    expect(engine.pending()).toBeNull();
  });
});

class RecordingIdleObserver implements IdleCueObserver {
  readonly calls: { sessionId: string; idleForMs: number }[] = [];

  async observeIdleCue(input: { sessionId: string; idleForMs: number }) {
    this.calls.push({ sessionId: input.sessionId, idleForMs: input.idleForMs });
    return {
      kind: "fired" as const,
      suggestion: {
        suggestionId: "suggestion-stub",
        pitch: "Build a focused replay test",
        mcqs: ["Which fixture?"],
        answers: ["Replay"],
        correlationId: "corr-stub",
        expiresAt: 0,
      },
      events: [],
    };
  }
}

class StubDecisionLLM implements DecisionLLM {
  constructor(private readonly quality: number) {}

  async decide(input: DecisionInput): Promise<DecisionOutput> {
    const payload = { quality: this.quality, pitch: "Add trace coverage now", mcqs: ["Which trace?"], answers: ["Coverage"] };
    return {
      id: "idle-decision",
      model: input.model,
      temperature: 0,
      decision: {
        kind: "action",
        action: { type: "spawn", targetUPID: null, payload, correlationId: input.correlationId },
        policy: "suggestion-engine.v0",
        decisionId: "decision-idle",
        correlationId: input.correlationId,
        meta: { quality: this.quality },
      } satisfies CueDecision,
    };
  }
}

function finalObservation(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "session-deferred", latencyMs: 10, utteranceId };
}

function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");
}

function sequenceIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${String(++next).padStart(3, "0")}`;
}

function adjustableClock(start: number): { clock: () => number; advance: (ms: number) => void } {
  let now = start;
  return {
    clock: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}
