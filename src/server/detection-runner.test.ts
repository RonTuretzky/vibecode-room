import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DetectionInput, DetectionResult, IdeaDetector } from "../detect";
import { DetectionRunner, selectDetectionRunner, type DetectionSnapshot } from "./detection-runner";
import { IdeaDetectionEngine } from "../detect";

class ScriptedDetector implements IdeaDetector {
  calls = 0;
  #queue: DetectionResult[];
  constructor(queue: DetectionResult[]) {
    this.#queue = queue;
  }
  async detect(_input: DetectionInput): Promise<DetectionResult> {
    this.calls += 1;
    return this.#queue.shift() ?? { candidates: [] };
  }
}

function ideaResult(pitch: string, confidence: number): DetectionResult {
  return {
    candidates: [{ matchId: null, pitch, confidence, questions: ["Build it?"], answers: ["Yes"], contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0001", quote: "q" }, rationale: "" }],
  };
}

function fixedClock(ms: number): () => number {
  return () => ms;
}

function sequenceIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function makeRunner(detector: IdeaDetector, env: Record<string, string | undefined>, onUpdate?: (s: DetectionSnapshot) => void): DetectionRunner {
  const engine = new IdeaDetectionEngine({ sessionId: "s", detector, clock: fixedClock(1000), idFactory: sequenceIds("idea"), env });
  return new DetectionRunner({ engine, clock: fixedClock(1000), onUpdate, tickIntervalMs: 0 });
}

describe("DetectionRunner", () => {
  test("ingest → schedule → detect → emit a ready primary", async () => {
    const detector = new ScriptedDetector([ideaResult("Crypto laundromat co-op", 0.85)]);
    const updates: DetectionSnapshot[] = [];
    const runner = makeRunner(detector, { VIBERSYN_DETECT_MIN_NEW_TURNS: "1" }, (s) => updates.push(s));
    runner.ingestTurn({ speaker: "speaker_0", text: "laundromat cooperative", atMs: 1000, correlationId: "corr-x" });
    await runner.flush();
    expect(detector.calls).toBe(1);
    expect(updates).toHaveLength(1);
    expect(runner.primary()?.pitch).toBe("Crypto laundromat co-op");
  });

  test("does not overlap detection rounds", async () => {
    let resolveDetect: () => void = () => {};
    const slow: IdeaDetector = {
      detect: () =>
        new Promise<DetectionResult>((resolve) => {
          resolveDetect = () => resolve(ideaResult("A", 0.9));
        }),
    };
    const runner = makeRunner(slow, { VIBERSYN_DETECT_MIN_NEW_TURNS: "1" });
    runner.ingestTurn({ speaker: null, text: "one", atMs: 1000, correlationId: "c" });
    runner.ingestTurn({ speaker: null, text: "two", atMs: 1000, correlationId: "c" }); // should NOT start a 2nd round
    resolveDetect();
    await runner.flush();
    expect(runner.candidates()).toHaveLength(1);
  });

  test("accept() consumes the candidate and emits", async () => {
    const detector = new ScriptedDetector([ideaResult("Build a dashboard", 0.9)]);
    const updates: DetectionSnapshot[] = [];
    const runner = makeRunner(detector, { VIBERSYN_DETECT_MIN_NEW_TURNS: "1" }, (s) => updates.push(s));
    runner.ingestTurn({ speaker: null, text: "dashboard", atMs: 1000, correlationId: "c" });
    await runner.flush();
    const primary = runner.primary();
    expect(primary).not.toBeNull();
    const accepted = runner.accept(primary!.id);
    expect(accepted?.pitch).toBe("Build a dashboard");
    expect(runner.primary()).toBeNull();
    expect(updates.length).toBeGreaterThanOrEqual(2); // detect + accept
  });

  test("forceDetect bypasses the scheduling policy (idea capture mode)", async () => {
    const detector = new ScriptedDetector([ideaResult("Forced idea", 0.9)]);
    const runner = makeRunner(detector, { VIBERSYN_DETECT_MIN_NEW_TURNS: "9" });
    runner.ingestTurn({ speaker: null, text: "one", atMs: 1000, correlationId: "c" });
    await runner.flush();
    expect(detector.calls).toBe(0); // minNewTurns=9 → passive schedule skips it

    await runner.forceDetect("c-force");
    expect(detector.calls).toBe(1); // forced regardless of schedule
    expect(runner.primary()?.pitch).toBe("Forced idea");
  });

  test("clear() drops candidates and emits", async () => {
    const detector = new ScriptedDetector([ideaResult("X", 0.9)]);
    const runner = makeRunner(detector, { VIBERSYN_DETECT_MIN_NEW_TURNS: "1" });
    runner.ingestTurn({ speaker: null, text: "x", atMs: 1000, correlationId: "c" });
    await runner.flush();
    runner.clear();
    expect(runner.candidates()).toHaveLength(0);
  });
});

describe("selectDetectionRunner", () => {
  // The detector-mode override falls back to process.env, so isolate these tests
  // from any ambient VIBERSYN_IDEA_DETECTOR (e.g. a CI kill-switch).
  let priorOverride: string | undefined;
  beforeEach(() => {
    priorOverride = process.env.VIBERSYN_IDEA_DETECTOR;
    delete process.env.VIBERSYN_IDEA_DETECTOR;
  });
  afterEach(() => {
    if (priorOverride === undefined) {
      delete process.env.VIBERSYN_IDEA_DETECTOR;
    } else {
      process.env.VIBERSYN_IDEA_DETECTOR = priorOverride;
    }
  });

  test("uses an injected detector verbatim (mode injected)", () => {
    const sel = selectDetectionRunner({ sessionId: "s", detector: new ScriptedDetector([]), env: {} });
    expect(sel.mode).toBe("injected");
  });

  test("defaults to host-claude with no gateway and no override", () => {
    const sel = selectDetectionRunner({ sessionId: "s", env: {} });
    expect(sel.mode).toBe("host-claude");
  });

  test("selects smithers when a gateway client is provided", () => {
    const client = { spawn: async () => ({ upid: "u", runId: "r", workflow: "idea-detection", parentId: null }), streamRunEvents: async function* () {} } as never;
    const sel = selectDetectionRunner({ sessionId: "s", env: {}, smithersClient: client });
    expect(sel.mode).toBe("smithers");
  });

  test("an explicit VIBERSYN_IDEA_DETECTOR override beats the gateway", () => {
    const client = { spawn: async () => ({}), streamRunEvents: async function* () {} } as never;
    const sel = selectDetectionRunner({ sessionId: "s", env: { VIBERSYN_IDEA_DETECTOR: "heuristic" }, smithersClient: client });
    expect(sel.mode).toBe("heuristic");
  });
});
