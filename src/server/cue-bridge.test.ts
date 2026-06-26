import { describe, expect, test } from "bun:test";
import { CueAdapter } from "../cue/adapter";
import type { PanopticonCueHarness } from "../cue/harness";
import { TraceProcessor } from "../obs/trace";
import type { TranscriptObservation } from "../types";
import { ReplayASRProvider } from "../providers/asr/replay";
import { ReplayDecisionLLM } from "../providers/llm/replay";
import { NoopTTSProvider } from "../providers/tts/noop";
import { createCueBridge, fallbackIngestResult } from "./cue-bridge";

function observation(text: string, overrides: Partial<TranscriptObservation> = {}): TranscriptObservation {
  return {
    text,
    isFinal: true,
    speaker: "speaker_0",
    sessionId: "session-cue-bridge",
    latencyMs: 12,
    utteranceId: "utt-cue-bridge",
    ...overrides,
  };
}

function fallbackAdapter(trace: TraceProcessor): CueAdapter {
  return new CueAdapter({
    sessionId: "session-cue-bridge",
    trace,
    clock: monotonicClock(100),
    idFactory: sequenceIds("bridge"),
    textCueWords: ["panop"],
  });
}

const providers = {
  transcription: new ReplayASRProvider([]),
  llm: new ReplayDecisionLLM([]),
  output: new NoopTTSProvider(),
};

describe("createCueBridge — path selection on build presence", () => {
  test("missing PANOP_CUE_SOURCE_DIR (no build) selects the fallback adapter without throwing", async () => {
    const trace = new TraceProcessor({ clock: monotonicClock(1) });
    const logs: string[] = [];
    const bridge = await createCueBridge({
      sessionId: "session-cue-bridge",
      providers,
      fallbackAdapter: fallbackAdapter(trace),
      trace,
      clock: monotonicClock(1),
      buildAvailable: () => false,
      onLog: (message) => logs.push(message),
    });

    expect(bridge.mode).toBe("fallback");
    expect(bridge.selection.reason).toContain("PANOP_CUE_SOURCE_DIR");
    // Selection is operator-visible.
    expect(logs.some((line) => line.includes("fallback"))).toBe(true);
  });

  test("a present Cue build attempts harness construction and selects the harness path", async () => {
    const trace = new TraceProcessor({ clock: monotonicClock(1) });
    const calls: number[] = [];
    const fakeHarness = makeFakeHarness();
    const logs: string[] = [];
    const bridge = await createCueBridge({
      sessionId: "session-cue-bridge",
      providers,
      fallbackAdapter: fallbackAdapter(trace),
      trace,
      clock: monotonicClock(1),
      buildAvailable: () => true,
      createHarness: async () => {
        calls.push(1);
        return fakeHarness;
      },
      onLog: (message) => logs.push(message),
    });

    expect(calls).toHaveLength(1);
    expect(bridge.mode).toBe("harness");
    expect(logs.some((line) => line.includes("harness"))).toBe(true);
  });

  test("a build that is present but whose harness fails to construct degrades to fallback (no throw)", async () => {
    const trace = new TraceProcessor({ clock: monotonicClock(1) });
    const bridge = await createCueBridge({
      sessionId: "session-cue-bridge",
      providers,
      fallbackAdapter: fallbackAdapter(trace),
      trace,
      clock: monotonicClock(1),
      buildAvailable: () => true,
      createHarness: async () => {
        throw new Error("dist missing");
      },
    });

    expect(bridge.mode).toBe("fallback");
    expect(bridge.selection.reason).toContain("dist missing");
  });
});

describe("createCueBridge — fallback wake word emits an earcon (integration)", () => {
  test("a 'panop' observation drives the CueAdapter to a textcue earcon trace with no Cue build", async () => {
    const trace = new TraceProcessor({ clock: monotonicClock(100) });
    const adapter = fallbackAdapter(trace);
    const bridge = await createCueBridge({
      sessionId: "session-cue-bridge",
      providers,
      fallbackAdapter: adapter,
      trace,
      clock: monotonicClock(100),
      buildAvailable: () => false,
      onLog: () => undefined,
    });

    const decision = await bridge.observeFinal(observation("Panop status"));
    if (decision === null) {
      throw new Error("expected a decision for a final observation");
    }

    expect(decision.earcons).toHaveLength(1);
    expect(decision.earcons[0]).toEqual(
      expect.objectContaining({ id: "E1", source: "cue-textcue", matchedWord: "panop" }),
    );
    const earconTrace = decision.events.filter((event) => event.event === "earcon.emit");
    expect(earconTrace).toHaveLength(1);
    expect(earconTrace[0]?.meta).toEqual(
      expect.objectContaining({ id: "E1", source: "cue-textcue", matchedWord: "panop" }),
    );
  });

  test("an ambient (no wake word) observation passes with no earcon", async () => {
    const trace = new TraceProcessor({ clock: monotonicClock(100) });
    const adapter = fallbackAdapter(trace);
    const bridge = await createCueBridge({
      sessionId: "session-cue-bridge",
      providers,
      fallbackAdapter: adapter,
      trace,
      clock: monotonicClock(100),
      buildAvailable: () => false,
      onLog: () => undefined,
    });

    const decision = await bridge.observeFinal(observation("the coffee was good this morning"));
    expect(decision?.earcons).toEqual([]);
    expect(decision?.events.some((event) => event.event === "earcon.emit")).toBe(false);
  });

  test("a non-final observation is ignored by both paths", async () => {
    const trace = new TraceProcessor({ clock: monotonicClock(100) });
    const bridge = await createCueBridge({
      sessionId: "session-cue-bridge",
      providers,
      fallbackAdapter: fallbackAdapter(trace),
      trace,
      clock: monotonicClock(100),
      buildAvailable: () => false,
      onLog: () => undefined,
    });

    expect(await bridge.observeFinal(observation("panop", { isFinal: false }))).toBeNull();
  });
});

describe("createCueBridge — harness path routes through ingest + adapter once", () => {
  test("observeFinal ingests through the harness and hands the result to the adapter", async () => {
    const trace = new TraceProcessor({ clock: monotonicClock(1) });
    const ingested: string[] = [];
    const handled: TranscriptObservation[] = [];
    const fakeHarness = makeFakeHarness({
      ingest: (frame) => {
        ingested.push((frame as { text: string }).text);
        return { cues: [{ name: "text", metadata: { pattern: "panop" } }], toolResults: [] };
      },
      handleResult: (obs) => {
        handled.push(obs);
        return { correlationId: "corr-x", decisionId: "dec-x", events: [], actions: [], earcons: [] };
      },
    });
    const bridge = await createCueBridge({
      sessionId: "session-cue-bridge",
      providers,
      fallbackAdapter: fallbackAdapter(trace),
      trace,
      clock: monotonicClock(1),
      buildAvailable: () => true,
      createHarness: async () => fakeHarness,
      onLog: () => undefined,
    });

    await bridge.observeFinal(observation("Panop status"));

    expect(ingested).toEqual(["Panop status"]);
    expect(handled).toHaveLength(1);
    expect(handled[0]?.text).toBe("Panop status");
  });
});

describe("fallbackIngestResult", () => {
  test("surfaces a Cue text decision when a wake word is present", () => {
    expect(fallbackIngestResult("hey panop go", ["panop"])).toEqual({
      cues: [{ name: "text", metadata: { pattern: "panop" } }],
      toolResults: [],
    });
  });

  test("returns an empty ambient result when no wake word is present", () => {
    expect(fallbackIngestResult("just chatter", ["panop"])).toEqual({ cues: [], toolResults: [] });
  });
});

function makeFakeHarness(
  overrides: {
    ingest?: (frame: unknown) => unknown;
    handleResult?: (observation: TranscriptObservation) => unknown;
  } = {},
): PanopticonCueHarness {
  return {
    cue: {
      transcriptObservation: (text: string, options?: Record<string, unknown>) => ({ text, ...options }),
    },
    harness: {
      ingest: async (frame: unknown) =>
        overrides.ingest?.(frame) ?? { cues: [], toolResults: [] },
    },
    adapter: {
      handleResult: async (obs: TranscriptObservation) =>
        overrides.handleResult?.(obs) ?? { correlationId: "c", decisionId: "d", events: [], actions: [], earcons: [] },
    },
    providers,
    risks: [],
  } as unknown as PanopticonCueHarness;
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
