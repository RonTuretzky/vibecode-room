import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CueAdapter } from "../cue/adapter";
import type { VibersynCueHarness } from "../cue/harness";
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
    textCueWords: ["viber"],
    earconPath: "fallback",
  });
}

// The committed pre-built Cue fixture; pointing VIBERSYN_CUE_SOURCE_DIR here makes
// cueSourceBuildAvailable() report a build so the bridge selects the harness path.
const CUE_BUILD_FIXTURE = join(import.meta.dir, "../../fixtures/cue-build");

const providers = {
  transcription: new ReplayASRProvider([]),
  llm: new ReplayDecisionLLM([]),
  output: new NoopTTSProvider(),
};

describe("createCueBridge — path selection on build presence", () => {
  test("missing VIBERSYN_CUE_SOURCE_DIR (no build) selects the fallback adapter without throwing", async () => {
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
    expect(bridge.selection.reason).toContain("VIBERSYN_CUE_SOURCE_DIR");
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

describe("createCueBridge — harness path against a real Cue build (integration)", () => {
  const priorSourceDir = process.env.VIBERSYN_CUE_SOURCE_DIR;

  afterEach(() => {
    if (priorSourceDir === undefined) {
      delete process.env.VIBERSYN_CUE_SOURCE_DIR;
    } else {
      process.env.VIBERSYN_CUE_SOURCE_DIR = priorSourceDir;
    }
  });

  test("a fixture build dir yields mode 'harness' and a harness-tagged earcon trace", async () => {
    // Point at the committed pre-built Cue substrate: no override of
    // buildAvailable/createHarness, so this exercises the real cueSourceBuildAvailable
    // detector, loadCueCore import, and createVibersynCueHarness factory.
    process.env.VIBERSYN_CUE_SOURCE_DIR = CUE_BUILD_FIXTURE;

    const trace = new TraceProcessor({ clock: monotonicClock(100) });
    const logs: string[] = [];
    const bridge = await createCueBridge({
      sessionId: "session-cue-bridge",
      providers,
      fallbackAdapter: fallbackAdapter(trace),
      textCueWords: ["viber"],
      trace,
      clock: monotonicClock(100),
      onLog: (message) => logs.push(message),
    });

    expect(bridge.mode).toBe("harness");
    expect(bridge.selection.reason).toContain(CUE_BUILD_FIXTURE);
    expect(logs.some((line) => line.includes("harness"))).toBe(true);

    const decision = await bridge.observeFinal(observation("Viber status"));
    if (decision === null) {
      throw new Error("expected a decision for a final observation");
    }

    // The wake word drove the upstream harness ingest to a TextCue decision, and
    // the harness-owned adapter emitted the earcon.
    expect(decision.earcons).toHaveLength(1);
    expect(decision.earcons[0]).toEqual(
      expect.objectContaining({ id: "E1", source: "cue-textcue", matchedWord: "viber" }),
    );
    const earconTrace = decision.events.filter((event) => event.event === "earcon.emit");
    expect(earconTrace).toHaveLength(1);
    // Distinguishable from the fallback adapter trace via the `path` tag.
    expect(earconTrace[0]?.meta).toEqual(
      expect.objectContaining({ id: "E1", source: "cue-textcue", matchedWord: "viber", path: "harness" }),
    );
  });

  test("the fallback adapter tags its earcon trace 'fallback', distinct from the harness path", async () => {
    const trace = new TraceProcessor({ clock: monotonicClock(100) });
    const bridge = await createCueBridge({
      sessionId: "session-cue-bridge",
      providers,
      fallbackAdapter: fallbackAdapter(trace),
      textCueWords: ["viber"],
      trace,
      clock: monotonicClock(100),
      buildAvailable: () => false,
      onLog: () => undefined,
    });

    expect(bridge.mode).toBe("fallback");
    const decision = await bridge.observeFinal(observation("Viber status"));
    const earconTrace = (decision?.events ?? []).filter((event) => event.event === "earcon.emit");
    expect(earconTrace).toHaveLength(1);
    expect(earconTrace[0]?.meta).toEqual(expect.objectContaining({ source: "cue-textcue", path: "fallback" }));
  });
});

describe("createCueBridge — fallback wake word emits an earcon (integration)", () => {
  test("a 'viber' observation drives the CueAdapter to a textcue earcon trace with no Cue build", async () => {
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

    const decision = await bridge.observeFinal(observation("Viber status"));
    if (decision === null) {
      throw new Error("expected a decision for a final observation");
    }

    expect(decision.earcons).toHaveLength(1);
    expect(decision.earcons[0]).toEqual(
      expect.objectContaining({ id: "E1", source: "cue-textcue", matchedWord: "viber" }),
    );
    const earconTrace = decision.events.filter((event) => event.event === "earcon.emit");
    expect(earconTrace).toHaveLength(1);
    expect(earconTrace[0]?.meta).toEqual(
      expect.objectContaining({ id: "E1", source: "cue-textcue", matchedWord: "viber" }),
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

    expect(await bridge.observeFinal(observation("viber", { isFinal: false }))).toBeNull();
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
        return { cues: [{ name: "text", metadata: { pattern: "viber" } }], toolResults: [] };
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

    await bridge.observeFinal(observation("Viber status"));

    expect(ingested).toEqual(["Viber status"]);
    expect(handled).toHaveLength(1);
    expect(handled[0]?.text).toBe("Viber status");
  });
});

describe("fallbackIngestResult", () => {
  test("surfaces a Cue text decision when a wake word is present", () => {
    expect(fallbackIngestResult("hey viber go", ["viber"])).toEqual({
      cues: [{ name: "text", metadata: { pattern: "viber" } }],
      toolResults: [],
    });
  });

  test("returns an empty ambient result when no wake word is present", () => {
    expect(fallbackIngestResult("just chatter", ["viber"])).toEqual({ cues: [], toolResults: [] });
  });
});

function makeFakeHarness(
  overrides: {
    ingest?: (frame: unknown) => unknown;
    handleResult?: (observation: TranscriptObservation) => unknown;
  } = {},
): VibersynCueHarness {
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
  } as unknown as VibersynCueHarness;
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
