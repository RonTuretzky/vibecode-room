import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CandidateVerdict, DetectionInput, DetectionResult, IdeaDetector } from "../detect";
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

  test("dismiss() drops the candidate, emits, and suppresses the pitch for the cooldown", async () => {
    const detector = new ScriptedDetector([ideaResult("Build a dashboard", 0.9), ideaResult("Build a dashboard", 0.9)]);
    const updates: DetectionSnapshot[] = [];
    const runner = makeRunner(detector, { VIBERSYN_DETECT_MIN_NEW_TURNS: "1", VIBERSYN_DETECT_MIN_INTERVAL_MS: "0" }, (s) => updates.push(s));
    runner.ingestTurn({ speaker: null, text: "dashboard", atMs: 1000, correlationId: "c" });
    await runner.flush();

    const primary = runner.primary();
    expect(primary).not.toBeNull();
    const dismissed = runner.dismiss(primary!.id);
    expect(dismissed?.pitch).toBe("Build a dashboard");
    expect(runner.primary()).toBeNull();
    expect(updates.length).toBeGreaterThanOrEqual(2); // detect + dismiss

    // Unknown id → no-op, no extra emit.
    const emitsBefore = updates.length;
    expect(runner.dismiss("idea-unknown")).toBeNull();
    expect(updates.length).toBe(emitsBefore);

    // The dismissed pitch is suppressed: the next round re-detects it but the
    // engine drops it, so nothing resurfaces inside the cooldown window.
    runner.ingestTurn({ speaker: null, text: "dashboard again", atMs: 1000, correlationId: "c2" });
    await runner.flush();
    expect(detector.calls).toBe(2);
    expect(runner.candidates()).toHaveLength(0);
  });

  test("forceDetect is rate-limited: a force inside the window degrades to the passive schedule", async () => {
    let nowMs = 1_000;
    const clock = (): number => nowMs;
    const detector = new ScriptedDetector([ideaResult("A", 0.9), ideaResult("B", 0.9), ideaResult("C", 0.9)]);
    // minNewTurns=9 → the passive schedule never fires here; only forces run.
    const engine = new IdeaDetectionEngine({
      sessionId: "s",
      detector,
      clock,
      idFactory: sequenceIds("idea"),
      env: { VIBERSYN_DETECT_MIN_NEW_TURNS: "9", VIBERSYN_DETECT_MIN_INTERVAL_MS: "0" },
    });
    const runner = new DetectionRunner({ engine, clock, tickIntervalMs: 0 }); // default forceMinIntervalMs = 1500

    runner.ingestTurn({ speaker: null, text: "one", atMs: nowMs, correlationId: "c" });
    await runner.flush();
    expect(detector.calls).toBe(0);

    await runner.forceDetect("f1");
    expect(detector.calls).toBe(1);

    // Inside the 1500ms window: the force degrades to the (never-satisfied) schedule.
    runner.ingestTurn({ speaker: null, text: "two", atMs: nowMs, correlationId: "c" });
    await runner.forceDetect("f2");
    expect(detector.calls).toBe(1);

    // Past the window: forcing works again.
    nowMs += 1_600;
    await runner.forceDetect("f3");
    expect(detector.calls).toBe(2);
  });

  test("VIBERSYN_DETECT_FORCE_MIN_INTERVAL_MS=0 disables the force rate limit", async () => {
    const detector = new ScriptedDetector([ideaResult("A", 0.9), ideaResult("A", 0.9)]);
    const sel = selectDetectionRunner({
      sessionId: "s",
      detector,
      clock: fixedClock(1000),
      idFactory: sequenceIds("idea"),
      env: { VIBERSYN_DETECT_MIN_NEW_TURNS: "9", VIBERSYN_DETECT_MIN_INTERVAL_MS: "0", VIBERSYN_DETECT_FORCE_MIN_INTERVAL_MS: "0" },
      tickIntervalMs: 0,
    });
    sel.runner.ingestTurn({ speaker: null, text: "one", atMs: 1000, correlationId: "c" });
    await sel.runner.flush();
    await sel.runner.forceDetect("f1");
    await sel.runner.forceDetect("f2"); // same instant — allowed with the limit off
    expect(detector.calls).toBe(2);
  });

  test("an async verification verdict republishes via onUpdate (onLedgerChange wiring)", async () => {
    let settleVerify: (verdict: CandidateVerdict) => void = () => {};
    const detector: IdeaDetector = {
      detect: async () => ideaResult("Verified idea", 0.9),
      verify: () =>
        new Promise<CandidateVerdict>((resolve) => {
          settleVerify = resolve;
        }),
    };
    const updates: DetectionSnapshot[] = [];
    const sel = selectDetectionRunner({
      sessionId: "s",
      detector,
      clock: fixedClock(1000),
      idFactory: sequenceIds("idea"),
      env: { VIBERSYN_DETECT_MIN_NEW_TURNS: "1" },
      tickIntervalMs: 0,
      onUpdate: (s) => {
        updates.push(s);
      },
    });
    sel.runner.ingestTurn({ speaker: null, text: "an idea", atMs: 1000, correlationId: "c" });
    await sel.runner.flush();
    // The round finished but the verdict is pending: the ready-but-unverified
    // candidate is withheld from primary().
    expect(sel.runner.primary()).toBeNull();
    const updatesBeforeVerdict = updates.length;

    settleVerify({ uphold: true, reason: "grounded" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The settled verdict republished OUTSIDE any detection round, and the
    // upheld candidate now surfaces.
    expect(updates.length).toBeGreaterThan(updatesBeforeVerdict);
    expect(updates.at(-1)?.primary?.pitch).toBe("Verified idea");
    expect(sel.runner.primary()?.pitch).toBe("Verified idea");
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
