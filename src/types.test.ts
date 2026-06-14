import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import {
  ackIdSchema,
  cueDecisionSchema,
  dispatchedActionSchema,
  earconIdSchema,
  logEventSchema,
  outputDecisionSchema,
  pendingSuggestionSchema,
  runEventSchema,
  transcriptObservationSchema,
  type AckId,
  type CueDecision,
  type DispatchedAction,
  type EarconId,
  type LogEvent,
  type OutputDecision,
  type PendingSuggestion,
  type RunEvent,
  type TranscriptObservation,
} from "./types";

const runEventSamples: RunEvent[] = [
  { upid: "upid-atlas", runId: "run-001", kind: "state", text: "planning", seq: 0 },
  { upid: "upid-atlas", runId: "run-001", kind: "output", text: "header ready", seq: 1 },
  { upid: "upid-atlas", runId: "run-001", kind: "blocker", text: "needs fixture", seq: 2 },
  { upid: "upid-atlas", runId: "run-001", kind: "completed", text: "done", seq: 3 },
];

const logEventSamples: LogEvent[] = [
  {
    level: "info",
    event: "session.start",
    sessionId: "session-001",
    latencyMs: 1,
    meta: { consentSpoken: true },
  },
  {
    level: "debug",
    event: "route.pass",
    sessionId: "session-001",
    correlationId: "corr-pass",
    meta: { addressed: false, reason: "ambient" },
  },
  {
    level: "info",
    event: "route.action",
    sessionId: "session-001",
    correlationId: "corr-action",
    upid: "upid-atlas",
    latencyMs: 47,
    meta: { type: "steer" },
  },
  {
    level: "warn",
    event: "process.blocker",
    sessionId: "session-001",
    correlationId: "corr-blocker",
    upid: "upid-atlas",
    meta: { seq: 2 },
  },
  {
    level: "error",
    event: "output.failed",
    sessionId: "session-001",
    correlationId: "corr-output",
    meta: { channel: "tts" },
  },
];

describe("ENG-T-01 shared type contract", () => {
  test("LogEvent samples serialize to JSONL and deserialize byte-identically", () => {
    const samples = maybeDropCorrelationForRbg(logEventSamples);
    const jsonl = samples.map((event) => JSON.stringify(event)).join("\n");
    const roundTripped = jsonl
      .split("\n")
      .map((line) => JSON.stringify(logEventSchema.parse(JSON.parse(line))))
      .join("\n");

    expect(roundTripped).toBe(jsonl);
  });

  test("RunEvent samples serialize to JSONL and deserialize byte-identically", () => {
    const jsonl = runEventSamples.map((event) => JSON.stringify(event)).join("\n");
    const roundTripped = jsonl
      .split("\n")
      .map((line) => JSON.stringify(runEventSchema.parse(JSON.parse(line))))
      .join("\n");

    expect(roundTripped).toBe(jsonl);
  });

  test("schema presence enforces sessionId and loop-event correlationId", () => {
    expect(
      logEventSchema.safeParse({
        level: "info",
        event: "route.action",
        sessionId: "",
        correlationId: "corr-001",
        meta: {},
      }).success,
    ).toBe(false);

    expect(
      logEventSchema.safeParse({
        level: "info",
        event: "route.action",
        sessionId: "session-001",
        meta: {},
      }).success,
    ).toBe(false);

    expect(
      logEventSchema.safeParse({
        level: "info",
        event: "session.start",
        sessionId: "session-001",
        meta: {},
      }).success,
    ).toBe(true);
  });

  test("TranscriptObservation mirrors the normalized ASR shape", () => {
    const observation: TranscriptObservation = {
      text: "Panop status",
      isFinal: true,
      speaker: null,
      sessionId: "session-001",
      latencyMs: 33,
      utteranceId: "utt-001",
    };

    expect(transcriptObservationSchema.parse(observation)).toEqual(observation);
    expect(transcriptObservationSchema.safeParse({ ...observation, sessionId: "" }).success).toBe(false);
  });

  test("CueDecision includes pass and action variants with addressed/reason metadata", () => {
    const passDecision: CueDecision = {
      kind: "pass",
      addressed: true,
      reason: "near-miss",
      policy: "literal-command",
      decisionId: "decision-pass",
      correlationId: "corr-pass",
      meta: { utteranceId: "utt-001" },
    };
    const actionDecision: CueDecision = {
      kind: "action",
      action: {
        type: "pause",
        targetUPID: "upid-atlas",
        payload: { source: "voice" },
        correlationId: "corr-action",
      },
      policy: "literal-command",
      decisionId: "decision-action",
      correlationId: "corr-action",
      meta: { utteranceId: "utt-002" },
    };

    expect(cueDecisionSchema.parse(passDecision)).toEqual(passDecision);
    expect(cueDecisionSchema.parse(actionDecision)).toEqual(actionDecision);
    expect(cueDecisionSchema.safeParse({ ...passDecision, reason: "non-final" }).success).toBe(false);
  });

  test("DispatchedAction covers every V0 command and rejects cut actions", () => {
    const actions: DispatchedAction[] = [
      { type: "spawn", targetUPID: null, payload: { seed: "idea" }, correlationId: "corr-spawn" },
      { type: "steer", targetUPID: "upid-atlas", payload: { text: "make it faster" }, correlationId: "corr-steer" },
      { type: "pause", targetUPID: "upid-atlas", payload: {}, correlationId: "corr-pause" },
      { type: "resume", targetUPID: "upid-atlas", payload: {}, correlationId: "corr-resume" },
      { type: "halt", targetUPID: "upid-atlas", payload: { trigger: "stop" }, correlationId: "corr-halt" },
      { type: "pauseAll", targetUPID: null, payload: {}, correlationId: "corr-pause-all" },
      { type: "status", targetUPID: null, payload: {}, correlationId: "corr-status" },
    ];

    for (const action of actions) {
      expect(dispatchedActionSchema.parse(action)).toEqual(action);
    }

    for (const type of ["setMode", "approve", "deny"]) {
      expect(dispatchedActionSchema.safeParse({ ...actions[0], type }).success).toBe(false);
    }
  });

  test("PendingSuggestion and output decision schemas mirror the V0 voice flow", () => {
    const suggestion: PendingSuggestion = {
      suggestionId: "suggestion-001",
      pitch: "Add the settings page",
      mcqs: ["Which route?", "Which theme?"],
      answers: ["Settings", "System"],
      correlationId: "corr-suggestion",
      expiresAt: 1781416030,
    };
    const outputs: OutputDecision[] = [
      { channel: "silent" },
      { channel: "earcon", id: "E3" },
      { channel: "ack", id: "working" },
      { channel: "tts", text: "Atlas is paused", wordCount: 3, summarized: false },
    ];

    expect(pendingSuggestionSchema.parse(suggestion)).toEqual(suggestion);
    for (const output of outputs) {
      expect(outputDecisionSchema.parse(output)).toEqual(output);
    }
    expect(outputDecisionSchema.safeParse({ channel: "ack", id: "E3" }).success).toBe(false);
  });

  test("EarconId and AckId unions are disjoint and include the timeout ack", () => {
    const earcon: EarconId = "E5";
    const ack: AckId = "working";

    expect(earconIdSchema.parse(earcon)).toBe("E5");
    expect(ackIdSchema.parse(ack)).toBe("working");
    expect(earconIdSchema.safeParse(ack).success).toBe(false);
    expect(ackIdSchema.safeParse(earcon).success).toBe(false);
  });

  test("cut subsystem contracts are absent from src/types.ts", async () => {
    const source = await readFile(new URL("./types.ts", import.meta.url), "utf8");
    const cutSymbols = [
      "ExecutionMode",
      "ToolCallContext",
      "ShellVerdict",
      "ApprovalRequest",
      "ApprovalResolution",
    ];

    for (const symbol of cutSymbols) {
      expect(source).not.toContain(symbol);
    }
  });
});

function maybeDropCorrelationForRbg(samples: LogEvent[]): LogEvent[] {
  if (process.env.PANOPTICON_RBG_DROP_CORRELATION !== "1") {
    return samples;
  }

  return samples.map((event) => {
    if (event.event !== "route.action") {
      return event;
    }

    const { correlationId: _correlationId, ...withoutCorrelationId } = event;
    return withoutCorrelationId;
  });
}
