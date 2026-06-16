import { describe, expect, test } from "bun:test";
import { ReplayASRProvider } from "../providers/asr/replay";
import { ReplayDecisionLLM } from "../providers/llm/replay";
import { NoopTTSProvider } from "../providers/tts/noop";
import type { CueDecision, DispatchedAction, TranscriptObservation } from "../types";
import { DEFAULT_CALLSIGN_POOL } from "../routing/callsigns";
import { CueAdapter, mapCueAction } from "./adapter";
import { createPanopticonCueHarness } from "./harness";
import { createSemanticIntentDecisionInput } from "./intent-gate";
import { DEFAULT_TEXT_CUE_WORDS, assertPrematcherParity, createCuePolicies } from "./policies";
import { assertTwoProgramIsolation } from "./programs";
import { loadCueCore } from "./source";

describe("Cue adapter and policies", () => {
  test("adapter-normalization maps Cue frames to the exact TranscriptObservation shape", () => {
    const adapter = new CueAdapter({
      sessionId: "session-normalize",
      clock: () => 100,
      idFactory: sequenceIds("normalize"),
    });

    const normalized = adapter.normalizeObservation({
      transcript: "Panop build the replay tests",
      isFinal: true,
      speaker: process.env.PANOP_RBG_DROP_SPEAKER === "1" ? undefined : "speaker_0",
      sessionId: "session-normalize",
      latencyMs: 42,
      utteranceId: "utt-normalize-001",
    });

    expect(normalized).toEqual({
      text: "Panop build the replay tests",
      isFinal: true,
      speaker: "speaker_0",
      sessionId: "session-normalize",
      latencyMs: 42,
      utteranceId: "utt-normalize-001",
    } satisfies TranscriptObservation);
    expect(Object.keys(normalized).sort()).toEqual([
      "isFinal",
      "latencyMs",
      "sessionId",
      "speaker",
      "text",
      "utteranceId",
    ]);
  });

  test("pass-logging turns every observe.pass into a route.pass line with the same correlation id", async () => {
    const cue = await loadCueCore();
    const { CueHarness, TextCue, Triggers, transcriptObservation } = cue;
    const adapter = new CueAdapter({
      sessionId: "session-pass",
      clock: monotonicClock(10),
      idFactory: sequenceIds("pass"),
    });
    const harness = new CueHarness({
      sessionId: "session-pass",
      cues: [new TextCue(["ambient"])],
      programs: [
        {
          name: "ambient-pass",
          triggers: [Triggers.onCue("text")],
          allowedTools: [],
          llmProvider: {
            infer() {
              return [{ tool: "observe.pass", arguments: { reason: "ambient-no-action" } }];
            },
          },
        },
      ],
    });

    const observation = adapter.normalizeObservation({
      text: "ambient chatter",
      isFinal: true,
      speaker: "speaker_1",
      sessionId: "session-pass",
      latencyMs: 9,
      utteranceId: "utt-pass-001",
    });
    const result = await harness.ingest(transcriptObservation(observation.text, { speaker: observation.speaker }));
    const decision =
      process.env.PANOP_RBG_SKIP_ROUTE_PASS === "1"
        ? {
            events: [
              {
                level: "info" as const,
                event: "observe.pass",
                sessionId: observation.sessionId,
                correlationId: "corr-broken-pass",
                latencyMs: 1,
                meta: { utteranceId: observation.utteranceId },
              },
            ],
          }
        : await adapter.handleResult(observation, result);

    const observePasses = decision.events.filter((event) => event.event === "observe.pass");
    const routePasses = decision.events.filter((event) => event.event === "route.pass");
    expect(observePasses).toHaveLength(1);
    expect(routePasses).toHaveLength(observePasses.length);
    expect(routePasses[0].correlationId).toBe(observePasses[0].correlationId);
    expect((routePasses[0].meta as Record<string, unknown>).observeEvent).toBe("observe.pass");
  });

  test("two independent Programs keep ambient C2 out of steering C3 and steering C3 out of ambient C2", async () => {
    const cue = await loadCueCore();
    const { CueHarness, TextCue, Triggers, MappedActionTool, transcriptObservation } = cue;
    const adapter = new CueAdapter({
      sessionId: "session-isolation",
      clock: monotonicClock(20),
      idFactory: sequenceIds("isolation"),
    });
    const tools = [
      new MappedActionTool({
        name: "panopticon.suggest",
        description: "ambient",
        mapper: () => [{ type: "suggestion.queue", payload: { concept: "build a test" } }],
      }),
      new MappedActionTool({
        name: "panopticon.steer",
        description: "steering",
        mapper: () => [{ type: "smithers.steer", payload: { upid: `upid-${DEFAULT_CALLSIGN_POOL[0]}`, instruction: "focus tests" } }],
      }),
    ];
    const ambientAllowedTools =
      process.env.PANOP_RBG_ROUTE_AMBIENT_TO_STEERING === "1"
        ? ["panopticon.suggest", "panopticon.steer"]
        : ["panopticon.suggest"];
    const harness = new CueHarness({
      sessionId: "session-isolation",
      cues: [new TextCue(["build"]), new TextCue([DEFAULT_CALLSIGN_POOL[0]])],
      programs: [
        {
          name: "ambient-C2",
          triggers: [Triggers.onCue("text")],
          allowedTools: ambientAllowedTools,
          llmProvider: {
            infer({ cue: cueEvent, tools: eligibleTools }: { cue?: { metadata?: Record<string, unknown> }; tools: Array<{ name: string }> }) {
              if (cueEvent?.metadata?.pattern !== "build") return [];
              if (eligibleTools.some((tool) => tool.name === "panopticon.steer")) {
                return [{ tool: "panopticon.steer", arguments: { upid: `upid-${DEFAULT_CALLSIGN_POOL[0]}`, instruction: "leak" } }];
              }
              return [{ tool: "panopticon.suggest", arguments: { concept: "add replay tests" } }];
            },
          },
        },
        {
          name: "steering-C3",
          triggers: [Triggers.onCue("text")],
          allowedTools: ["panopticon.steer"],
          llmProvider: {
            infer({ cue: cueEvent }: { cue?: { metadata?: Record<string, unknown> } }) {
              if (cueEvent?.metadata?.pattern !== DEFAULT_CALLSIGN_POOL[0]) return [];
              return [{ tool: "panopticon.steer", arguments: { upid: `upid-${DEFAULT_CALLSIGN_POOL[0]}`, instruction: "focus tests" } }];
            },
          },
        },
      ],
      tools,
    });

    const ambientObservation = adapter.normalizeObservation({
      text: "build a small replay test",
      speaker: "speaker_0",
      utteranceId: "utt-ambient",
    });
    const steeringObservation = adapter.normalizeObservation({
      text: `${DEFAULT_CALLSIGN_POOL[0]} focus tests`,
      speaker: "speaker_0",
      utteranceId: "utt-steer",
    });
    const ambient = await adapter.handleResult(
      ambientObservation,
      await harness.ingest(transcriptObservation(ambientObservation.text, { speaker: ambientObservation.speaker })),
    );
    const steering = await adapter.handleResult(
      steeringObservation,
      await harness.ingest(transcriptObservation(steeringObservation.text, { speaker: steeringObservation.speaker })),
    );

    const probe = {
      ambientProgram: "ambient-C2",
      steeringProgram: "steering-C3",
      ambientTools: ambientAllowedTools,
      steeringTools: ["panopticon.steer"],
      ambientActions: ambient.actions,
      steeringActions: steering.actions,
    };

    expect(() => assertTwoProgramIsolation(probe)).not.toThrow();
    expect(ambient.actions.map((action) => action.type)).toEqual(["spawn"]);
    expect(steering.actions.map((action) => action.type)).toEqual(["steer"]);
  });

  test("recognition-source feeds earcons from Cue TextCue decisions or a byte-equal adapter pre-matcher mirror", async () => {
    const cue = await loadCueCore();
    const policies = createCuePolicies(cue, { textCueWords: ["panop"], cooldownSeconds: 1 });
    const adapter = new CueAdapter({
      sessionId: "session-earcon",
      clock: monotonicClock(30),
      idFactory: sequenceIds("earcon"),
      textCueWords: policies.textCueWords,
      usePrematcher: true,
      prematcherWords:
        process.env.PANOP_RBG_PREMATCH_WORD_DRIFT === "1" ? [...policies.textCueWords, "shadow"] : policies.textCueWords,
    });
    const { CueHarness, MappedActionTool, Triggers, transcriptObservation } = cue;
    const emitted: unknown[] = [];
    const harness = new CueHarness({
      sessionId: "session-earcon",
      cues: policies.cues,
      programs: [
        {
          name: "wake-program",
          triggers: [Triggers.onCue("text")],
          allowedTools: ["panopticon.status"],
          llmProvider: {
            infer() {
              return [{ tool: "panopticon.status", arguments: { upid: "upid-status" } }];
            },
          },
        },
      ],
      tools: [
        new MappedActionTool({
          name: "panopticon.status",
          description: "status",
          mapper: (call: { arguments?: Record<string, unknown> }) => [
            { type: "smithers.status", payload: call.arguments ?? {} },
          ],
        }),
      ],
    });

    assertPrematcherParity(policies.textCueWords, policies.textCueWords);
    const observation = adapter.normalizeObservation({
      text: "Panop status",
      speaker: "speaker_0",
      latencyMs: 18,
      utteranceId: "utt-earcon",
    });
    const decision = await adapter.handleResult(
      observation,
      await harness.ingest(transcriptObservation(observation.text, { speaker: observation.speaker })),
    );
    emitted.push(...decision.earcons);

    expect(emitted).toHaveLength(1);
    expect(decision.earcons[0]).toEqual(
      expect.objectContaining({
        id: "E1",
        source: "cue-textcue",
        matchedWord: "panop",
      }),
    );
    expect(decision.actions).toEqual([
      expect.objectContaining({ type: "status", targetUPID: "upid-status" }) as DispatchedAction,
    ]);
  });

  test("semantic gate accepts a short standalone TextCue command without calling the DecisionLLM", async () => {
    const cue = await loadCueCore();
    const { TextCue, Triggers, MappedActionTool, transcriptObservation } = cue;
    const llm = new ReplayDecisionLLM([]);
    const adapter = new CueAdapter({
      sessionId: "session-intent-direct",
      clock: monotonicClock(40),
      idFactory: sequenceIds("intent-direct"),
      semanticIntentGate: { llm },
    });
    const harness = textCueActionHarness(cue, {
      sessionId: "session-intent-direct",
      textCue: new TextCue(["yes"]),
      trigger: Triggers.onCue("text"),
      tool: new MappedActionTool({
        name: "panopticon.suggest",
        description: "suggest",
        mapper: () => [{ type: "suggestion.queue", payload: { concept: "continue" } }],
      }),
    });
    const observation = adapter.normalizeObservation({
      text: "Yes",
      speaker: "speaker_0",
      utteranceId: "utt-intent-direct",
    });

    const decision = await adapter.handleResult(
      observation,
      await harness.ingest(transcriptObservation(observation.text, { speaker: observation.speaker })),
    );

    expect(decision.actions.map((action) => action.type)).toEqual(["spawn"]);
    expect(llm.calls).toHaveLength(0);
    expect(decision.events).toContainEqual(
      expect.objectContaining({
        event: "decision.intent",
        meta: expect.objectContaining({ accepted: true, source: "prefilter", reason: "bare-cue-command" }),
      }),
    );
  });

  test("semantic gate blocks contextual yes-but false positives through replayed DecisionLLM", async () => {
    const cue = await loadCueCore();
    const { TextCue, Triggers, MappedActionTool, transcriptObservation } = cue;
    const observation = transcriptObservationForGate("Yes, but I'm not sure we should do that.", "utt-yes-but");
    const candidate = mapCueAction({ type: "suggestion.queue", payload: { concept: "continue" } }, "corr-intent-001");
    const llm = new ReplayDecisionLLM([
      {
        input: createSemanticIntentDecisionInput({
          observation,
          cueDecision: { name: "text", metadata: { pattern: "yes" } },
          action: candidate,
          correlationId: "corr-intent-001",
          decisionId: "decision-intent-002",
          options: { model: "intent-gate-temp-0" },
        }),
        output: intentGatePassOutput("yes-but", "corr-intent-001", "decision-intent-002"),
      },
    ]);
    const adapter = new CueAdapter({
      sessionId: observation.sessionId,
      clock: monotonicClock(50),
      idFactory: sequenceIds("intent"),
      semanticIntentGate: { llm },
    });
    const harness = textCueActionHarness(cue, {
      sessionId: observation.sessionId,
      textCue: new TextCue(["yes"]),
      trigger: Triggers.onCue("text"),
      tool: new MappedActionTool({
        name: "panopticon.suggest",
        description: "suggest",
        mapper: () => [{ type: "suggestion.queue", payload: { concept: "continue" } }],
      }),
    });

    const decision = await adapter.handleResult(
      observation,
      await harness.ingest(transcriptObservation(observation.text, { speaker: observation.speaker })),
    );

    expect(decision.actions).toEqual([]);
    expect(llm.calls).toHaveLength(1);
    expect(decision.events).toContainEqual(
      expect.objectContaining({
        event: "decision.intent",
        meta: expect.objectContaining({ accepted: false, source: "llm", reason: "llm-conversational-filler" }),
      }),
    );
    expect(decision.events).toContainEqual(
      expect.objectContaining({
        event: "route.pass",
        meta: expect.objectContaining({ policy: "cue.semantic-intent-gate", gateReason: "llm-conversational-filler" }),
      }),
    );
  });

  test("semantic gate sends natural conversational affirmative mentions to replay before accepting", async () => {
    const cue = await loadCueCore();
    const { TextCue, Triggers, MappedActionTool, transcriptObservation } = cue;
    const observation = transcriptObservationForGate("I said yes earlier because the context was different.", "utt-natural-yes");
    const candidate = mapCueAction({ type: "suggestion.queue", payload: { concept: "continue" } }, "corr-natural-001");
    const llm = new ReplayDecisionLLM([
      {
        input: createSemanticIntentDecisionInput({
          observation,
          cueDecision: { name: "text", metadata: { pattern: "yes" } },
          action: candidate,
          correlationId: "corr-natural-001",
          decisionId: "decision-natural-002",
          options: { model: "intent-gate-temp-0" },
        }),
        output: intentGatePassOutput("natural-yes", "corr-natural-001", "decision-natural-002"),
      },
    ]);
    const adapter = new CueAdapter({
      sessionId: observation.sessionId,
      clock: monotonicClock(60),
      idFactory: sequenceIds("natural"),
      semanticIntentGate: { llm },
    });
    const harness = textCueActionHarness(cue, {
      sessionId: observation.sessionId,
      textCue: new TextCue(["yes"]),
      trigger: Triggers.onCue("text"),
      tool: new MappedActionTool({
        name: "panopticon.suggest",
        description: "suggest",
        mapper: () => [{ type: "suggestion.queue", payload: { concept: "continue" } }],
      }),
    });

    const decision = await adapter.handleResult(
      observation,
      await harness.ingest(transcriptObservation(observation.text, { speaker: observation.speaker })),
    );

    expect(decision.actions).toEqual([]);
    expect(llm.calls).toHaveLength(1);
    expect(decision.events).toContainEqual(
      expect.objectContaining({
        event: "decision.intent",
        meta: expect.objectContaining({ accepted: false, source: "llm" }),
      }),
    );
  });

  test("harness wires transcription, decision LLM, and output provider slots without constructing concrete providers", async () => {
    const providers = {
      transcription: new ReplayASRProvider([]),
      llm: new ReplayDecisionLLM([]),
      output: new NoopTTSProvider(),
    };

    const harness = await createPanopticonCueHarness({
      sessionId: "session-harness",
      providers,
      textCueWords: [...DEFAULT_TEXT_CUE_WORDS],
    });

    expect(harness.providers).toBe(providers);
    expect(harness.risks).toEqual(expect.arrayContaining([expect.stringContaining("speaker-label-stability")]));
    expect(harness.risks).toEqual(expect.arrayContaining([expect.stringContaining("observe.pass")]));
    expect(harness.risks).toEqual(expect.arrayContaining([expect.stringContaining("earcon")]));
  });
});

function textCueActionHarness(
  cue: Awaited<ReturnType<typeof loadCueCore>>,
  options: {
    sessionId: string;
    textCue: unknown;
    trigger: unknown;
    tool: unknown;
  },
) {
  const { CueHarness } = cue;
  return new CueHarness({
    sessionId: options.sessionId,
    cues: [options.textCue],
    programs: [
      {
        name: "intent-gate-test",
        triggers: [options.trigger],
        allowedTools: ["panopticon.suggest"],
        llmProvider: {
          infer() {
            return [{ tool: "panopticon.suggest", arguments: { concept: "continue" } }];
          },
        },
      },
    ],
    tools: [options.tool],
  });
}

function transcriptObservationForGate(text: string, utteranceId: string): TranscriptObservation {
  return {
    text,
    isFinal: true,
    speaker: "speaker_0",
    sessionId: `session-${utteranceId}`,
    latencyMs: 12,
    utteranceId,
  };
}

function intentGatePassOutput(label: string, correlationId: string, decisionId: string): {
  id: string;
  model: string;
  temperature: 0;
  decision: CueDecision;
} {
  return {
    id: `intent-gate-${label}`,
    model: "intent-gate-temp-0",
    temperature: 0,
    decision: {
      kind: "pass",
      addressed: true,
      reason: "dropped",
      policy: "cue.semantic-intent-gate",
      decisionId,
      correlationId,
      meta: { label },
    },
  };
}

function sequenceIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${String(++next).padStart(3, "0")}`;
}

function monotonicClock(start: number): () => number {
  let now = start;
  return () => {
    now += 1;
    return now;
  };
}
