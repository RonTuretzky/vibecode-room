import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../types";
import {
  TraceProcessor,
  parseTraceJsonl,
  reconstructCausalChain,
  serializeTraceJsonl,
  type TraceInput,
} from "./trace";

const sessionId = "session-trace-001";
const correlationId = "corr-utterance-001";
const upid = "upid-atlas-001";

describe("ENG-T-03 TraceProcessor", () => {
  test("trace-schema records required ids, verb-noun event names, and measured latency on every record", () => {
    const processor = new TraceProcessor();
    const events = sampleFullChainInputs().map((input) => processor.record(maybeDropCorrelation(input)));

    expect(events).toHaveLength(4);
    for (const event of events) {
      expect(event.sessionId).toBe(sessionId);
      expect(event.correlationId).toBe(correlationId);
      expect(event.event).toMatch(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u);
      expect(event.latencyMs).toBeGreaterThanOrEqual(0);
      expect(event.meta).toBeObject();
    }

    expect(events[0].latencyMs).toBe(7);
    expect(events[2].upid).toBe(upid);
    expect(() =>
      processor.record({
        level: "info",
        event: "process.spawn",
        sessionId,
        correlationId,
        startedAtMs: 1,
        endedAtMs: 2,
        meta: {},
      }),
    ).toThrow(/upid/u);
  });

  test("the processor is a first-class stage: it records before downstream and keeps the trace if downstream fails", async () => {
    const processor = new TraceProcessor();
    const seenCounts: number[] = [];

    await processor.process(sampleFullChainInputs()[0], () => {
      seenCounts.push(processor.events().length);
    });

    expect(seenCounts).toEqual([1]);

    await expect(
      processor.process(sampleFullChainInputs()[1], () => {
        expect(processor.events()).toHaveLength(2);
        throw new Error("downstream failed");
      }),
    ).rejects.toThrow("downstream failed");

    expect(processor.events().map((event) => event.event)).toEqual(["observe.final", "route.suggestion"]);
  });

  test("pass-logging emits a route.pass line for every observe.pass", () => {
    const processor = new TraceProcessor();

    if (process.env.PANOPTICON_RBG_SKIP_ROUTE_PASS === "1") {
      processor.record({
        event: "observe.pass",
        sessionId,
        correlationId,
        startedAtMs: 10,
        endedAtMs: 12,
        meta: { addressed: false, reason: "ambient", utteranceId: "utt-pass-001", policy: "ambient" },
      });
    } else {
      processor.recordObservationPass({
        sessionId,
        correlationId,
        startedAtMs: 10,
        endedAtMs: 12,
        meta: { addressed: false, reason: "ambient", utteranceId: "utt-pass-001", policy: "ambient" },
      });
    }

    const events = processor.events();
    const observePasses = events.filter((event) => event.event === "observe.pass");
    const routePasses = events.filter((event) => event.event === "route.pass");

    expect(observePasses).toHaveLength(1);
    expect(routePasses).toHaveLength(observePasses.length);
    expect(routePasses[0].correlationId).toBe(observePasses[0].correlationId);
    expect(routePasses[0].meta.utteranceId).toBe("utt-pass-001");
  });

  test("causal-chain reconstruction rebuilds observation to decision to action to outcome from traces alone", () => {
    const processor = new TraceProcessor();
    for (const input of sampleFullChainInputs()) {
      processor.record(maybeDropCorrelation(input));
    }

    const persistedOnly = parseTraceJsonl(processor.toJsonl());
    const chain = reconstructCausalChain(persistedOnly, correlationId);

    expect(chain.complete).toBe(true);
    expect(chain.missingStages).toEqual([]);
    expect(chain.observation.map((event) => event.event)).toEqual(["observe.final"]);
    expect(chain.decision.map((event) => event.event)).toEqual(["route.suggestion"]);
    expect(chain.action.map((event) => event.event)).toEqual(["process.spawn"]);
    expect(chain.outcome.map((event) => event.event)).toEqual(["process.completed"]);
    expect(chain.events.map((event) => event.meta.utteranceId)).toEqual([
      "utt-001",
      "utt-001",
      "utt-001",
      "utt-001",
    ]);

    const processorQuery = TraceProcessor.fromJsonl(processor.toJsonl()).query(correlationId);
    expect(processorQuery.complete).toBe(true);
  });

  test("causal-chain reconstruction reports missing stages when a join key is absent", () => {
    const chain = reconstructCausalChain(
      sampleFullChainEvents().map((event) => {
        if (event.event !== "process.spawn") {
          return event;
        }
        const { correlationId: _correlationId, ...withoutCorrelationId } = event;
        return withoutCorrelationId as LogEvent;
      }),
      correlationId,
    );

    expect(chain.complete).toBe(false);
    expect(chain.missingStages).toContain("action");
  });

  test("trace-roundtrip serializes and deserializes every event byte-identically", () => {
    const events = sampleFullChainEvents().map((event) => {
      if (process.env.PANOPTICON_RBG_UNSERIALIZABLE === "1" && event.event === "route.suggestion") {
        return { ...event, meta: { ...event.meta, bad: BigInt(1) } } as unknown as LogEvent;
      }
      return event;
    });

    const jsonl = serializeTraceJsonl(events);
    const roundTripped = serializeTraceJsonl(parseTraceJsonl(jsonl));

    expect(roundTripped).toBe(jsonl);
  });

  test("redaction-filter seam transforms meta before persistence without changing stable ids", () => {
    const processor = new TraceProcessor({
      redactionFilters: [
        (value, context) => (context.path.at(-1) === "credential" ? "[redacted]" : value),
      ],
    });

    const event = processor.record({
      event: "safety.intercept",
      sessionId,
      correlationId,
      startedAtMs: 20,
      endedAtMs: 23,
      meta: { credential: "fixture-sensitive-value", nested: { keep: "visible" } },
    });

    expect(event.correlationId).toBe(correlationId);
    expect(event.latencyMs).toBe(3);
    expect(event.meta).toEqual({ credential: "[redacted]", nested: { keep: "visible" } });
    expect(processor.toJsonl()).not.toContain("fixture-sensitive-value");
  });
});

function sampleFullChainInputs(): TraceInput[] {
  return [
    {
      level: "info",
      event: "observe.final",
      sessionId,
      correlationId,
      startedAtMs: 100,
      endedAtMs: 107,
      meta: { seq: 1, utteranceId: "utt-001", speaker: "speaker-0", text: "Yes, build the settings page" },
    },
    {
      level: "info",
      event: "route.suggestion",
      sessionId,
      correlationId,
      startedAtMs: 108,
      endedAtMs: 113,
      meta: { seq: 2, utteranceId: "utt-001", decisionId: "decision-001", policy: "suggestion-gate" },
    },
    {
      level: "info",
      event: "process.spawn",
      sessionId,
      correlationId,
      upid,
      startedAtMs: 114,
      endedAtMs: 151,
      meta: { seq: 3, utteranceId: "utt-001", runId: "run-001", seedHash: "seed-hash-001" },
    },
    {
      level: "info",
      event: "process.completed",
      sessionId,
      correlationId,
      upid,
      startedAtMs: 152,
      endedAtMs: 161,
      meta: { seq: 4, utteranceId: "utt-001", runId: "run-001", summary: "settings page ready" },
    },
  ];
}

function sampleFullChainEvents(): LogEvent[] {
  const processor = new TraceProcessor();
  for (const input of sampleFullChainInputs()) {
    processor.record(input);
  }
  return processor.events();
}

function maybeDropCorrelation(input: TraceInput): TraceInput {
  if (process.env.PANOPTICON_RBG_DROP_CORRELATION !== "1") {
    return input;
  }

  if (input.event !== "process.spawn" && input.event !== "route.suggestion") {
    return input;
  }

  const { correlationId: _correlationId, ...withoutCorrelationId } = input;
  return withoutCorrelationId as TraceInput;
}
