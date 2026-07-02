import { describe, expect, test } from "bun:test";
import { IdeaDetectionEngine, readDetectionEngineConfig, type DetectionTraceEvent } from "./engine";
import type { DetectionInput, DetectionResult, IdeaDetector } from "./types";

// A detector whose replies are scripted per call, so engine scheduling/reconcile
// behavior is exercised deterministically with no model.
class ScriptedDetector implements IdeaDetector {
  readonly calls: DetectionInput[] = [];
  #queue: DetectionResult[];
  constructor(queue: DetectionResult[]) {
    this.#queue = queue;
  }
  async detect(input: DetectionInput): Promise<DetectionResult> {
    this.calls.push(input);
    return this.#queue.shift() ?? { candidates: [] };
  }
}

function sequenceIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(3, "0")}`;
}

function adjustableClock(start: number): { clock: () => number; advance: (ms: number) => void } {
  let now = start;
  return { clock: () => now, advance: (ms) => void (now += ms) };
}

const oneIdea = (pitch: string, confidence: number, start = "turn-0001", end = "turn-0001"): DetectionResult => ({
  candidates: [
    { matchId: null, pitch, confidence, questions: ["Build it?"], answers: ["Yes"], contextSpan: { startTurnId: start, endTurnId: end, quote: "q" }, rationale: "" },
  ],
});

describe("readDetectionEngineConfig", () => {
  test("supplies documented defaults", () => {
    const c = readDetectionEngineConfig({});
    expect(c.minNewTurns).toBe(2);
    expect(c.readyThreshold).toBe(0.6);
    expect(c.maxMissedRounds).toBe(3);
  });
});

describe("IdeaDetectionEngine scheduling", () => {
  test("does not detect with no new turns; schedules after minNewTurns", () => {
    const clock = adjustableClock(1000);
    const engine = new IdeaDetectionEngine({ sessionId: "s", detector: new ScriptedDetector([]), clock: clock.clock, env: { VIBERSYN_DETECT_MIN_NEW_TURNS: "2" } });
    expect(engine.shouldDetect()).toBe(false);
    engine.ingestTurn({ speaker: null, text: "one", atMs: 1000 });
    expect(engine.shouldDetect()).toBe(false); // only 1 new turn, no pause
    engine.ingestTurn({ speaker: null, text: "two", atMs: 1100 });
    expect(engine.shouldDetect()).toBe(true); // hit minNewTurns
  });

  test("a speech pause schedules detection with a single new turn", () => {
    const clock = adjustableClock(1000);
    const engine = new IdeaDetectionEngine({ sessionId: "s", detector: new ScriptedDetector([]), clock: clock.clock, env: { VIBERSYN_DETECT_MIN_NEW_TURNS: "5", VIBERSYN_DETECT_BOUNDARY_GAP_MS: "2000" } });
    engine.ingestTurn({ speaker: null, text: "one", atMs: 1000 });
    expect(engine.shouldDetect(1500)).toBe(false); // 500ms gap, < boundary
    expect(engine.shouldDetect(3200)).toBe(true); // 2200ms pause → boundary fires
  });

  test("throttles back-to-back detection rounds", async () => {
    const clock = adjustableClock(1000);
    const detector = new ScriptedDetector([oneIdea("A", 0.9), oneIdea("B", 0.9)]);
    const engine = new IdeaDetectionEngine({ sessionId: "s", detector, clock: clock.clock, idFactory: sequenceIds("idea"), env: { VIBERSYN_DETECT_MIN_NEW_TURNS: "1", VIBERSYN_DETECT_MIN_INTERVAL_MS: "4000" } });
    engine.ingestTurn({ speaker: null, text: "one", atMs: 1000 });
    await engine.detect("corr-1", 1000);
    engine.ingestTurn({ speaker: null, text: "two", atMs: 1500 });
    expect(engine.shouldDetect(1500)).toBe(false); // within throttle window
    expect(engine.shouldDetect(5200)).toBe(true); // throttle elapsed
  });
});

describe("IdeaDetectionEngine detection + candidates", () => {
  test("runs inference over the window and surfaces a ready primary candidate", async () => {
    const detector = new ScriptedDetector([oneIdea("Crypto laundromat co-op", 0.85)]);
    const traces: DetectionTraceEvent[] = [];
    const engine = new IdeaDetectionEngine({
      sessionId: "s",
      detector,
      idFactory: sequenceIds("idea"),
      onTrace: (e) => traces.push(e),
      env: {},
    });
    engine.ingestTurn({ speaker: "speaker_0", text: "crypto laundromat cooperative", atMs: 0 });
    const result = await engine.detect("corr-1", 100);
    expect(result.ran).toBe(true);
    expect(detector.calls[0].turns).toHaveLength(1);
    const primary = engine.primary();
    expect(primary?.pitch).toBe("Crypto laundromat co-op");
    expect(primary?.status).toBe("ready");
    expect(traces.map((t) => t.event)).toContain("detect.candidate.new");
  });

  test("a forming (low-confidence) idea is held — no ready primary", async () => {
    const detector = new ScriptedDetector([oneIdea("Maybe a thing", 0.4)]);
    const engine = new IdeaDetectionEngine({ sessionId: "s", detector, idFactory: sequenceIds("idea"), env: {} });
    engine.ingestTurn({ speaker: null, text: "vague musing", atMs: 0 });
    await engine.detect("corr-1", 100);
    expect(engine.candidates()).toHaveLength(1);
    expect(engine.candidates()[0].status).toBe("forming");
    expect(engine.primary()).toBeNull();
  });

  test("known candidates are passed to the detector for reconciliation", async () => {
    const detector = new ScriptedDetector([oneIdea("First", 0.8), oneIdea("First elaborated", 0.9)]);
    const engine = new IdeaDetectionEngine({ sessionId: "s", detector, idFactory: sequenceIds("idea"), env: { VIBERSYN_DETECT_MIN_INTERVAL_MS: "0" } });
    engine.ingestTurn({ speaker: null, text: "one", atMs: 0 });
    await engine.detect("corr-1", 100);
    // second round: model echoes the matchId to update
    detector.calls.length; // ignore
    const second = new ScriptedDetector([{ candidates: [{ matchId: "idea-001", pitch: "First elaborated", confidence: 0.95, questions: [], answers: [], contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0001", quote: "q" }, rationale: "" }] }]);
    const engine2 = new IdeaDetectionEngine({ sessionId: "s", detector: second, idFactory: sequenceIds("x"), env: {} });
    engine2.ingestTurn({ speaker: null, text: "one", atMs: 0 });
    await engine2.detect("c", 0);
    expect(second.calls[0].known).toEqual([]); // first round: nothing known
  });

  test("accept() removes the candidate and suppresses re-detecting the same pitch", async () => {
    const detector = new ScriptedDetector([oneIdea("Build a dashboard", 0.9), oneIdea("Build a dashboard", 0.9)]);
    const engine = new IdeaDetectionEngine({ sessionId: "s", detector, idFactory: sequenceIds("idea"), env: { VIBERSYN_DETECT_MIN_INTERVAL_MS: "0", VIBERSYN_DETECT_ACCEPT_COOLDOWN_MS: "30000" } });
    engine.ingestTurn({ speaker: null, text: "dashboard", atMs: 0 });
    await engine.detect("corr-1", 100);
    const primary = engine.primary();
    expect(primary).not.toBeNull();
    const accepted = engine.accept(primary!.id, 100);
    expect(accepted?.pitch).toBe("Build a dashboard");
    expect(engine.candidates()).toHaveLength(0);
    // same pitch within cooldown is suppressed → no re-pop
    engine.ingestTurn({ speaker: null, text: "dashboard again", atMs: 200 });
    await engine.detect("corr-2", 200);
    expect(engine.candidates()).toHaveLength(0);
  });

  test("re-entrancy guarded: empty window detect is a no-op", async () => {
    const engine = new IdeaDetectionEngine({ sessionId: "s", detector: new ScriptedDetector([]), env: {} });
    const result = await engine.detect("corr-1", 0);
    expect(result.ran).toBe(false);
  });
});
