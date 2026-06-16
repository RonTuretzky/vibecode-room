import { describe, expect, test } from "bun:test";
import { TraceProcessor } from "../obs/trace";
import type { DecisionInput, DecisionLLM, DecisionOutput } from "../providers";
import type { CueDecision, PendingSuggestion, TranscriptObservation } from "../types";
import {
  DEFAULT_SUGGESTION_MODEL,
  SUGGESTION_ENGINE_ENV_DEFAULTS,
  SuggestionEngine,
  createSuggestionDecisionInput,
  readSuggestionEngineConfig,
} from "./engine";

describe("suggestion engine", () => {
  test("REQ-3 floor observe.pass blocks short early ambient speech before scoring", async () => {
    const llm = new RecordingDecisionLLM(() => suggestionOutput({ quality: 0.95 }));
    const engine = new SuggestionEngine({
      sessionId: "session-floor",
      llm,
      clock: manualClock(1_000),
      idFactory: sequenceIds("floor"),
    });

    const decision = await engine.observe({
      observation: observation("short ambient idea", "utt-floor"),
      correlationId: "corr-floor",
    });

    expect(decision.kind).toBe("pass");
    expect(decision.kind === "pass" ? decision.reason : "").toBe("req3-floor");
    expect(llm.calls).toHaveLength(0);
    expect(decision.events.map((event) => event.event)).toEqual(["observe.pass", "route.pass"]);
    expect(decision.events[0].meta).toEqual(
      expect.objectContaining({
        policy: "suggestion-engine.v0",
        wordCount: 3,
        elapsedS: 0,
        quality: 0,
        decision: "pass",
        decisionId: "decision-floor-001",
        correlationId: "corr-floor",
        passReason: "req3-floor",
      }),
    );
  });

  test("quality scoring uses the temp-0 DecisionLLM and fails closed on conversational filler", async () => {
    const text = words(60);
    const expectedInput = createSuggestionDecisionInput({
      observation: observation(text, "utt-filler"),
      correlationId: "corr-filler",
      decisionId: "decision-filler-001",
      model: DEFAULT_SUGGESTION_MODEL,
    });
    const llm = new RecordingDecisionLLM(() => passOutput());
    const engine = new SuggestionEngine({
      sessionId: "session-filler",
      llm,
      clock: manualClock(2_000),
      idFactory: sequenceIds("filler"),
    });

    const decision = await engine.observe({
      observation: observation(text, "utt-filler"),
      correlationId: "corr-filler",
    });

    expect(decision.kind).toBe("pass");
    expect(decision.kind === "pass" ? decision.reason : "").toBe("intent-gate-pass");
    expect(llm.calls).toEqual([expectedInput]);
    expect(llm.calls[0].temperature).toBe(0);
  });

  test("high quality and low interrupt cost fires immediately and hands PendingSuggestion to acceptance owner", async () => {
    const accepted: PendingSuggestion[] = [];
    const env = envWith({
      PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
      PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
      PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
    });
    const llm = new RecordingDecisionLLM(() =>
      suggestionOutput({
        quality: 0.92,
        pitch: "Build the replay assertion fixture now with extra words trimmed",
        mcqs: ["Fixture?", "Assertion?", "Owner?", "Ignored?"],
        answers: ["Replay", "Trace", "Smithers", "Ignored"],
      }),
    );
    const engine = new SuggestionEngine({
      sessionId: "session-fire",
      llm,
      env,
      clock: manualClock(3_000),
      idFactory: sequenceIds("fire"),
      acceptanceOwner: {
        acceptSuggestion(suggestion) {
          accepted.push(suggestion);
        },
      },
    });

    const decision = await engine.observe({
      observation: observation(words(60), "utt-fire"),
      correlationId: "corr-fire",
    });

    expect(decision.kind).toBe("fired");
    expect(decision.kind === "fired" ? decision.suggestion.pitch : "").toBe(
      "Build the replay assertion fixture now with extra words trimmed",
    );
    expect(decision.kind === "fired" ? decision.suggestion.mcqs : []).toEqual(["Fixture?", "Assertion?", "Owner?"]);
    expect(accepted).toHaveLength(1);
    expect(decision.kind === "fired" ? accepted[0] : undefined).toEqual(
      decision.kind === "fired" ? decision.suggestion : undefined,
    );
    expect(decision.events).toContainEqual(
      expect.objectContaining({
        event: "route.suggestion",
        correlationId: "corr-fire",
        meta: expect.objectContaining({
          policy: "suggestion-engine.v0",
          wordCount: 60,
          quality: 0.92,
          interruptCost: 0,
          decision: "fire",
          decisionId: "decision-fire-001",
          correlationId: "corr-fire",
          suggestionId: "suggestion-fire-002",
        }),
      }),
    );
  });

  test("high interrupt cost queues and delivers on the next IdleCue gap", async () => {
    const accepted: PendingSuggestion[] = [];
    const now = adjustableClock(10_000);
    const llm = new RecordingDecisionLLM(() =>
      suggestionOutput({
        quality: 0.9,
        pitch: "Add trace coverage",
        mcqs: ["Which trace?", "Which assertion?"],
      }),
    );
    const engine = new SuggestionEngine({
      sessionId: "session-queue",
      llm,
      clock: now.clock,
      idFactory: sequenceIds("queue"),
      acceptanceOwner: {
        acceptSuggestion(suggestion) {
          accepted.push(suggestion);
        },
      },
    });

    const queued = await engine.observe({
      observation: observation(words(60), "utt-queue"),
      correlationId: "corr-queue",
      pendingSteerings: 1,
    });
    expect(queued.kind).toBe("queued");
    expect(accepted).toEqual([]);

    now.advance(9_000);
    await expect(
      engine.observeIdleCue({ sessionId: "session-queue", idleForMs: 9_000, correlationId: "corr-idle-too-soon" }),
    ).resolves.toEqual({ kind: "idle", events: [] });

    now.advance(1_000);
    const fired = await engine.observeIdleCue({
      sessionId: "session-queue",
      idleForMs: 10_000,
      correlationId: "corr-idle-deliver",
    });

    expect(fired.kind).toBe("fired");
    expect(accepted).toHaveLength(1);
    expect(fired.events[0]).toEqual(
      expect.objectContaining({
        event: "route.suggestion",
        correlationId: "corr-idle-deliver",
        meta: expect.objectContaining({ decision: "fire", suggestionId: "suggestion-queue-002" }),
      }),
    );
    expect(engine.pending()).toBeNull();
  });

  test("queued suggestions expire after TTL with no idle gap and are never handed to acceptance", async () => {
    const accepted: PendingSuggestion[] = [];
    const now = adjustableClock(20_000);
    const env = envWith({ PANOP_SUGGEST_TTL_SECONDS: "1" });
    const engine = new SuggestionEngine({
      sessionId: "session-expire",
      llm: new RecordingDecisionLLM(() => suggestionOutput({ quality: 0.95 })),
      clock: now.clock,
      env,
      idFactory: sequenceIds("expire"),
      acceptanceOwner: {
        acceptSuggestion(suggestion) {
          accepted.push(suggestion);
        },
      },
    });

    const queued = await engine.observe({
      observation: observation(words(60), "utt-expire"),
      correlationId: "corr-expire",
      pendingSteerings: 1,
    });
    expect(queued.kind).toBe("queued");

    now.advance(1_001);
    const expired = await engine.observeIdleCue({
      sessionId: "session-expire",
      idleForMs: 0,
      correlationId: "corr-expire-idle",
    });

    expect(expired.kind).toBe("expired");
    expect(accepted).toEqual([]);
    expect(expired.events[0]).toEqual(
      expect.objectContaining({
        event: "suggestion.expired",
        correlationId: "corr-expire",
        meta: expect.objectContaining({
          decision: "expired",
          suggestionId: "suggestion-expire-002",
        }),
      }),
    );
  });

  test("delivery strips apologetic language and clamps spoken pitch to twelve words", async () => {
    const env = envWith({
      PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
      PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
      PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
    });
    const engine = new SuggestionEngine({
      sessionId: "session-format",
      env,
      clock: manualClock(30_000),
      idFactory: sequenceIds("format"),
      llm: new RecordingDecisionLLM(() =>
        suggestionOutput({
          quality: 0.9,
          pitch: "Sorry build the detailed replay fixture for traces before expanding the process scope tomorrow",
          mcqs: ["Sorry which fixture?", "Which scope?"],
          answers: ["Sorry replay", "Process"],
        }),
      ),
    });

    const decision = await engine.observe({
      observation: observation(words(60), "utt-format"),
      correlationId: "corr-format",
    });

    expect(decision.kind).toBe("fired");
    const suggestion = decision.kind === "fired" ? decision.suggestion : undefined;
    expect(suggestion?.pitch).toBe("build the detailed replay fixture for traces before expanding the process scope");
    expect(suggestion?.pitch.split(/\s+/u)).toHaveLength(12);
    expect(JSON.stringify(suggestion)).not.toMatch(/sorry|apolog/i);
  });

  test("env tunables are documented and live-patched without restart", async () => {
    expect(readSuggestionEngineConfig({})).toEqual({
      wordFloor: 60,
      timeFloorSeconds: 90,
      qualityThreshold: 0.7,
      interruptLowThreshold: 0.65,
      interruptVelocityWeight: 0.4,
      interruptRecencyWeight: 0.4,
      interruptPendingSteeringWeight: 0.2,
      interruptVelocityHighWpm: 160,
      cadenceCapSeconds: 180,
      ttlSeconds: 90,
      idleGapSeconds: 10,
    });
    expect(Object.values(SUGGESTION_ENGINE_ENV_DEFAULTS).every((entry) => entry.description.length > 0)).toBe(true);

    const env = envWith({ PANOP_SUGGEST_WORD_FLOOR: "60" });
    const engine = new SuggestionEngine({
      sessionId: "session-live",
      env,
      clock: manualClock(40_000),
      idFactory: sequenceIds("live"),
      llm: new RecordingDecisionLLM(() => suggestionOutput({ quality: 0.95 })),
    });

    const pass = await engine.observe({
      observation: observation(words(10), "utt-live-pass"),
      correlationId: "corr-live-pass",
    });
    env.PANOP_SUGGEST_WORD_FLOOR = "10";
    env.PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT = "0";
    env.PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT = "0";
    env.PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT = "0";
    const fired = await engine.observe({
      observation: observation(words(10), "utt-live-fire"),
      correlationId: "corr-live-fire",
    });

    expect(pass.kind).toBe("pass");
    expect(fired.kind).toBe("fired");
  });

  test("substantive elapsed floor can pass before word floor", async () => {
    const now = adjustableClock(50_000);
    const env = envWith({
      PANOP_SUGGEST_WORD_FLOOR: "60",
      PANOP_SUGGEST_TIME_FLOOR_SECONDS: "1",
      PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
      PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
      PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
    });
    const engine = new SuggestionEngine({
      sessionId: "session-time",
      env,
      clock: now.clock,
      idFactory: sequenceIds("time"),
      llm: new RecordingDecisionLLM(() => suggestionOutput({ quality: 0.95 })),
    });

    const first = await engine.observe({
      observation: observation(words(2), "utt-time-first"),
      correlationId: "corr-time-first",
    });
    now.advance(1_100);
    const second = await engine.observe({
      observation: observation(words(2), "utt-time-second"),
      correlationId: "corr-time-second",
    });

    expect(first.kind).toBe("pass");
    expect(second.kind).toBe("fired");
  });

  test("TraceProcessor receives structured route.suggestion decision metadata", async () => {
    const env = envWith({
      PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
      PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
      PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
    });
    const trace = new TraceProcessor({ clock: manualClock(60_000) });
    const engine = new SuggestionEngine({
      sessionId: "session-trace",
      env,
      trace,
      clock: manualClock(60_000),
      idFactory: sequenceIds("trace"),
      llm: new RecordingDecisionLLM(() => suggestionOutput({ quality: 0.85 })),
    });

    await engine.observe({ observation: observation(words(60), "utt-trace"), correlationId: "corr-trace" });

    expect(trace.events()).toContainEqual(
      expect.objectContaining({
        event: "route.suggestion",
        sessionId: "session-utt-trace",
        correlationId: "corr-trace",
        latencyMs: expect.any(Number),
        meta: expect.objectContaining({
          policy: "suggestion-engine.v0",
          wordCount: 60,
          elapsedS: 0,
          quality: 0.85,
          interruptCost: 0,
          decision: "fire",
          decisionId: "decision-trace-001",
          correlationId: "corr-trace",
        }),
      }),
    );
  });
});

class RecordingDecisionLLM implements DecisionLLM {
  readonly calls: DecisionInput[] = [];

  constructor(private readonly respond: (input: DecisionInput) => DecisionOutput) {}

  async decide(input: DecisionInput): Promise<DecisionOutput> {
    this.calls.push(structuredClone(input));
    return this.respond(input);
  }
}

function suggestionOutput(options: {
  quality: number;
  pitch?: string;
  mcqs?: string[];
  answers?: string[];
}): DecisionOutput {
  const payload = {
    quality: options.quality,
    pitch: options.pitch ?? "Build a focused replay test",
    mcqs: options.mcqs ?? ["Which fixture?"],
    answers: options.answers ?? ["Replay"],
  };
  return {
    id: "suggestion-decision",
    model: DEFAULT_SUGGESTION_MODEL,
    temperature: 0,
    decision: {
      kind: "action",
      action: {
        type: "spawn",
        targetUPID: null,
        payload,
        correlationId: "corr-output",
      },
      policy: "suggestion-engine.v0",
      decisionId: "decision-output",
      correlationId: "corr-output",
      meta: { quality: options.quality },
    } satisfies CueDecision,
  };
}

function passOutput(): DecisionOutput {
  return {
    id: "suggestion-pass",
    model: DEFAULT_SUGGESTION_MODEL,
    temperature: 0,
    decision: {
      kind: "pass",
      addressed: false,
      reason: "ambient",
      policy: "suggestion-engine.v0",
      decisionId: "decision-output-pass",
      correlationId: "corr-output-pass",
      meta: { quality: 0.1 },
    },
  };
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

function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");
}

function sequenceIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${String(++next).padStart(3, "0")}`;
}

function manualClock(now: number): () => number {
  return () => now;
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

function envWith(overrides: Record<string, string>): Record<string, string | undefined> {
  return { ...overrides };
}
