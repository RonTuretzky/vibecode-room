import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { matchWakeWord } from "../../src/cue/wake-matcher";
import { TraceProcessor } from "../../src/obs/trace";
import { readTranscriptObservationJsonl } from "../../src/replay/jsonl";
import { runSpineSmoke } from "../../src/spine/smoke";
import type { TranscriptObservation } from "../../src/types";

const fixturePath = "fixtures/smoke/transcript.jsonl";

describe("spine skeleton smoke", () => {
  test("reads replayed transcript, matches one wake decision, and traces pass plus action lines", async () => {
    const result = await runSpineSmoke(fixturePath);

    expect(result.observations).toHaveLength(2);
    expect(result.decisions.map((decision) => decision.kind)).toEqual(["pass", "action"]);
    expect(result.traceEvents).toHaveLength(3);

    expect(result.traceEvents.map((event) => event.event)).toEqual(["observe.pass", "route.pass", "route.action"]);

    const event = result.traceEvents[2];
    expect(event).toMatchObject({
      level: "info",
      event: "route.action",
      sessionId: "smoke-session",
      correlationId: "corr-smoke-session-utt-002",
      latencyMs: 47,
      meta: {
        action: "status",
        observationId: "utt-002",
        policy: "literal-wake",
      },
    });
    expect(event.correlationId ?? "").not.toBe("");
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  test("matcher is deterministic across replayed runs", async () => {
    const observations = await readTranscriptObservationJsonl(fixturePath);
    const first = observations.map((observation) => matchWakeWord(observation));
    const second = observations.map((observation) => matchWakeWord(observation));

    expect(second).toEqual(first);
  });

  test("wake matcher is case-insensitive but whole-token only", () => {
    const base = observation({ text: "PANOP can you hear this" });
    expect(matchWakeWord(base).kind).toBe("action");
    expect(matchWakeWord(observation({ text: "panoptic dashboards are unrelated" })).kind).toBe("pass");
  });

  test("non-final observations never produce actions but still produce pass trace events", () => {
    const trace = new TraceProcessor();
    const decision = matchWakeWord(observation({ text: "Panop while still partial", isFinal: false }));
    const events = trace.emitDecision(decision, observation({ text: "Panop while still partial", isFinal: false }));

    expect(decision).toMatchObject({ kind: "pass", reason: "dropped" });
    expect(events.map((event) => event.event)).toEqual(["observe.pass", "route.pass"]);
    expect(trace.events()).toHaveLength(2);
  });

  test("replay reader rejects invalid JSONL with line context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "panopticon-smoke-"));
    const path = join(dir, "bad.jsonl");
    await writeFile(path, "{\"text\":\"missing fields\"}\n", "utf8");

    try {
      await expect(readTranscriptObservationJsonl(path)).rejects.toThrow("line 1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("trace JSONL is structured LogEvent lines for pass and action decisions", async () => {
    const result = await runSpineSmoke(fixturePath);
    const trace = new TraceProcessor();
    for (const [index, decision] of result.decisions.entries()) {
      trace.emitDecision(decision, result.observations[index]);
    }

    const lines = trace.toJsonl().split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toEqual(result.traceEvents[0]);
    expect(JSON.parse(lines[1])).toEqual(result.traceEvents[1]);
    expect(JSON.parse(lines[2])).toEqual(result.traceEvents[2]);
  });
});

function observation(overrides: Partial<TranscriptObservation>): TranscriptObservation {
  return {
    text: "ambient room speech",
    isFinal: true,
    speaker: "speaker-1",
    sessionId: "unit-session",
    latencyMs: 1,
    utteranceId: "unit-utt",
    ...overrides,
  };
}
