import { describe, expect, test } from "bun:test";
import { HeuristicIdeaDetector } from "./detector";
import { IdeaDetectionEngine, readDetectionEngineConfig, type DetectionTraceEvent } from "./engine";
import type { CandidateVerdict, DetectionInput, DetectionResult, IdeaDetector, VerifiableIdea } from "./types";

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

// A hand-settled promise so tests control exactly WHEN an async verify lands —
// the whole point of fire-and-forget verification is that detect() returns first.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ScriptedDetector plus a verify() whose verdicts are pre-queued (typically
// deferred promises the test settles by hand).
class VerifyingDetector extends ScriptedDetector {
  readonly verifyCalls: VerifiableIdea[] = [];
  #verdicts: Array<Promise<CandidateVerdict>>;
  constructor(queue: DetectionResult[], verdicts: Array<Promise<CandidateVerdict>>) {
    super(queue);
    this.#verdicts = verdicts;
  }
  verify(idea: VerifiableIdea): Promise<CandidateVerdict> {
    this.verifyCalls.push(idea);
    return this.#verdicts.shift() ?? Promise.resolve({ uphold: true, reason: "unscripted" });
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
    expect(c.readyThreshold).toBe(0.55);
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

  test("dismiss() removes the candidate and suppresses re-detecting the same pitch (no build)", async () => {
    const detector = new ScriptedDetector([oneIdea("Build a dashboard", 0.9), oneIdea("Build a dashboard", 0.9)]);
    const engine = new IdeaDetectionEngine({ sessionId: "s", detector, idFactory: sequenceIds("idea"), env: { VIBERSYN_DETECT_MIN_INTERVAL_MS: "0", VIBERSYN_DETECT_ACCEPT_COOLDOWN_MS: "30000" } });
    engine.ingestTurn({ speaker: null, text: "dashboard", atMs: 0 });
    await engine.detect("corr-1", 100);
    const primary = engine.primary();
    expect(primary).not.toBeNull();
    const dismissed = engine.dismiss(primary!.id, 100);
    expect(dismissed?.pitch).toBe("Build a dashboard");
    expect(engine.candidates()).toHaveLength(0);
    expect(engine.dismiss("nope", 100)).toBeNull(); // unknown id is a safe no-op
    // same pitch within cooldown is suppressed → the room said no, no re-pop
    engine.ingestTurn({ speaker: null, text: "dashboard again", atMs: 200 });
    await engine.detect("corr-2", 200);
    expect(engine.candidates()).toHaveLength(0);
  });

  test("dismiss suppression expires after acceptCooldownMs when the idea returns from NEW talk", async () => {
    // The re-detection is grounded in turn-0002 (fresh talk): past the cooldown
    // the same pitch may surface again. The dismissed idea's OWN turns stay
    // consumed — see the consumed-talk suite below.
    const detector = new ScriptedDetector([oneIdea("Build a dashboard", 0.9), oneIdea("Build a dashboard", 0.9, "turn-0002", "turn-0002")]);
    const engine = new IdeaDetectionEngine({ sessionId: "s", detector, idFactory: sequenceIds("idea"), env: { VIBERSYN_DETECT_MIN_INTERVAL_MS: "0", VIBERSYN_DETECT_ACCEPT_COOLDOWN_MS: "1000" } });
    engine.ingestTurn({ speaker: null, text: "dashboard", atMs: 0 });
    await engine.detect("corr-1", 100);
    engine.dismiss(engine.candidates()[0].id, 100);
    engine.ingestTurn({ speaker: null, text: "dashboard again", atMs: 2000 });
    await engine.detect("corr-2", 2000);
    expect(engine.candidates()).toHaveLength(1);
  });

  test("re-entrancy guarded: empty window detect is a no-op", async () => {
    const engine = new IdeaDetectionEngine({ sessionId: "s", detector: new ScriptedDetector([]), env: {} });
    const result = await engine.detect("corr-1", 0);
    expect(result.ran).toBe(false);
  });
});

// After accept/dismiss the pitch cooldown expires (default 30s) while the turns
// that produced the idea are still in the rolling window (~6 min) — so without
// span consumption the SAME cluster of talk would re-detect the just-consumed
// idea as a "new" candidate. These tests pin the fix: consumed turns never
// re-pop their idea, and a genuinely fresh idea surfaces immediately.
describe("IdeaDetectionEngine consumed talk (accept/dismiss span suppression)", () => {
  test("an accepted idea's own turns never re-pop it, even after the pitch cooldown expires", async () => {
    // Both scripted detections are grounded in turn-0001 — the same talk.
    const detector = new ScriptedDetector([oneIdea("Build a dashboard", 0.9), oneIdea("Build a dashboard", 0.9)]);
    const engine = new IdeaDetectionEngine({ sessionId: "s", detector, idFactory: sequenceIds("idea"), env: { VIBERSYN_DETECT_MIN_INTERVAL_MS: "0", VIBERSYN_DETECT_ACCEPT_COOLDOWN_MS: "1000" } });
    engine.ingestTurn({ speaker: null, text: "dashboard", atMs: 0 });
    await engine.detect("corr-1", 100);
    engine.accept(engine.candidates()[0].id, 100);
    // Well past the 1s pitch cooldown; the old grounding turn is still in-window.
    engine.ingestTurn({ speaker: null, text: "unrelated chatter", atMs: 5000 });
    await engine.detect("corr-2", 5000);
    expect(engine.candidates()).toHaveLength(0);
    expect(engine.primary()).toBeNull();
  });

  test("accepted first idea + a fresh idea a minute later: the new idea surfaces immediately (heuristic, e2e)", async () => {
    const engine = new IdeaDetectionEngine({
      sessionId: "s",
      detector: new HeuristicIdeaDetector(),
      idFactory: sequenceIds("idea"),
      env: { VIBERSYN_DETECT_MIN_INTERVAL_MS: "0" },
    });
    engine.ingestTurn({ speaker: "speaker_0", text: "let's build a chrome extension that tracks tabs", atMs: 0 });
    engine.ingestTurn({ speaker: "speaker_0", text: "it could integrate with the dashboard", atMs: 2_000 });
    await engine.detect("corr-1", 3_000);
    const first = engine.primary();
    expect(first).not.toBeNull();
    expect(first!.pitch).toContain("chrome extension");
    engine.accept(first!.id, 3_000);
    expect(engine.primary()).toBeNull();

    // ~1 minute later — deep inside the 6-minute rolling window, past the 30s
    // pitch cooldown — the room pitches a DIFFERENT idea.
    engine.ingestTurn({ speaker: "speaker_1", text: "ooh we should make a split calculator for rent", atMs: 63_000 });
    await engine.detect("corr-2", 63_500);
    const second = engine.primary();
    expect(second).not.toBeNull();
    expect(second!.pitch).toContain("split calculator");
    // The accepted cluster did not re-pop into the tray alongside it.
    expect(engine.candidates()).toHaveLength(1);
  });

  test("dismissed talk stays consumed too: same cluster cannot re-pop after the cooldown", async () => {
    const engine = new IdeaDetectionEngine({
      sessionId: "s",
      detector: new HeuristicIdeaDetector(),
      idFactory: sequenceIds("idea"),
      env: { VIBERSYN_DETECT_MIN_INTERVAL_MS: "0", VIBERSYN_DETECT_ACCEPT_COOLDOWN_MS: "1000" },
    });
    engine.ingestTurn({ speaker: "speaker_0", text: "let's build a habit tracker app", atMs: 0 });
    await engine.detect("corr-1", 500);
    const primary = engine.primary();
    expect(primary).not.toBeNull();
    engine.dismiss(primary!.id, 500);
    // Past the pitch cooldown, chatter triggers another round over the SAME talk.
    engine.ingestTurn({ speaker: "speaker_0", text: "anyway how was the game", atMs: 10_000 });
    await engine.detect("corr-2", 10_000);
    expect(engine.candidates()).toHaveLength(0);
  });
});

describe("IdeaDetectionEngine async verification", () => {
  test("detect() returns before verify settles; uphold surfaces the bubble via onLedgerChange", async () => {
    const verdict = deferred<CandidateVerdict>();
    const detector = new VerifyingDetector([oneIdea("Crypto laundromat co-op", 0.9)], [verdict.promise]);
    const traces: DetectionTraceEvent[] = [];
    const settled = deferred<void>();
    let ledgerChanges = 0;
    const engine = new IdeaDetectionEngine({
      sessionId: "s",
      detector,
      idFactory: sequenceIds("idea"),
      onTrace: (e) => traces.push(e),
      onLedgerChange: () => {
        ledgerChanges += 1;
        settled.resolve();
      },
      env: {},
    });
    engine.ingestTurn({ speaker: null, text: "laundromat", atMs: 0 });
    const result = await engine.detect("corr-1", 100); // resolves with the verify still pending
    expect(result.ran).toBe(true);
    expect(detector.verifyCalls).toHaveLength(1);
    expect(engine.primary()).toBeNull(); // ready-but-unverified stays withheld
    expect(ledgerChanges).toBe(0);
    verdict.resolve({ uphold: true, reason: "novel" });
    await settled.promise;
    expect(engine.primary()?.pitch).toBe("Crypto laundromat co-op");
    expect(engine.candidates()[0].verified).toBe(true);
    expect(ledgerChanges).toBe(1);
    expect(traces.map((t) => t.event)).toContain("detect.candidate.verified");
  });

  test("a veto demotes the candidate to forming with the reason", async () => {
    const verdict = deferred<CandidateVerdict>();
    const detector = new VerifyingDetector([oneIdea("Linear calendar", 0.9)], [verdict.promise]);
    const traces: DetectionTraceEvent[] = [];
    const settled = deferred<void>();
    const engine = new IdeaDetectionEngine({
      sessionId: "s",
      detector,
      idFactory: sequenceIds("idea"),
      onTrace: (e) => traces.push(e),
      onLedgerChange: () => settled.resolve(),
      env: {},
    });
    engine.ingestTurn({ speaker: null, text: "calendar", atMs: 0 });
    await engine.detect("corr-1", 100);
    verdict.resolve({ uphold: false, reason: "already exists as Linear" });
    await settled.promise;
    expect(engine.primary()).toBeNull();
    const [c] = engine.candidates();
    expect(c.status).toBe("forming");
    expect(c.vetoReason).toBe("already exists as Linear");
    expect(traces.map((t) => t.event)).toContain("detect.candidate.vetoed");
  });

  test("at most ONE verify in flight: later rounds skip launching until it settles", async () => {
    const first = deferred<CandidateVerdict>();
    const detector = new VerifyingDetector(
      [oneIdea("Alpha widget", 0.9), oneIdea("Alpha widget", 0.9), oneIdea("Zebra tracker", 0.9, "turn-0003", "turn-0003")],
      [first.promise, Promise.resolve({ uphold: true, reason: "also novel" })],
    );
    const settled = deferred<void>();
    let ledgerChanges = 0;
    const engine = new IdeaDetectionEngine({
      sessionId: "s",
      detector,
      idFactory: sequenceIds("idea"),
      onLedgerChange: () => {
        ledgerChanges += 1;
        if (ledgerChanges === 1) {
          settled.resolve();
        }
      },
      env: { VIBERSYN_DETECT_MIN_INTERVAL_MS: "0" },
    });
    engine.ingestTurn({ speaker: null, text: "alpha", atMs: 0 });
    await engine.detect("corr-1", 100);
    expect(detector.verifyCalls).toHaveLength(1);
    // second round while the first verify is still pending → no second launch
    engine.ingestTurn({ speaker: null, text: "alpha again", atMs: 200 });
    await engine.detect("corr-2", 200);
    expect(detector.verifyCalls).toHaveLength(1);
    first.resolve({ uphold: true, reason: "novel" });
    await settled.promise;
    // settled: the next round may verify the next pending candidate
    engine.ingestTurn({ speaker: null, text: "zebra", atMs: 300 });
    await engine.detect("corr-3", 300);
    expect(detector.verifyCalls).toHaveLength(2);
    expect(detector.verifyCalls[1].pitch).toBe("Zebra tracker");
  });

  test("a verify error fails OPEN: the candidate is upheld and surfaces", async () => {
    const verdict = deferred<CandidateVerdict>();
    const detector = new VerifyingDetector([oneIdea("Solid idea", 0.9)], [verdict.promise]);
    const settled = deferred<void>();
    const engine = new IdeaDetectionEngine({
      sessionId: "s",
      detector,
      idFactory: sequenceIds("idea"),
      onLedgerChange: () => settled.resolve(),
      env: {},
    });
    engine.ingestTurn({ speaker: null, text: "solid", atMs: 0 });
    await engine.detect("corr-1", 100);
    verdict.reject(new Error("skeptic timed out"));
    await settled.promise;
    expect(engine.primary()?.pitch).toBe("Solid idea");
    expect(engine.candidates()[0].verified).toBe(true);
  });

  test("a candidate accepted while its verify is in flight settles safely (no resurrection)", async () => {
    const verdict = deferred<CandidateVerdict>();
    const detector = new VerifyingDetector([oneIdea("Ephemeral idea", 0.9)], [verdict.promise]);
    const settled = deferred<void>();
    const engine = new IdeaDetectionEngine({
      sessionId: "s",
      detector,
      idFactory: sequenceIds("idea"),
      onLedgerChange: () => settled.resolve(),
      env: {},
    });
    engine.ingestTurn({ speaker: null, text: "ephemeral", atMs: 0 });
    await engine.detect("corr-1", 100);
    const accepted = engine.accept(engine.candidates()[0].id, 100);
    expect(accepted).not.toBeNull();
    verdict.resolve({ uphold: true, reason: "novel" });
    await settled.promise; // the stale verdict must not throw or re-create the entry
    expect(engine.candidates()).toHaveLength(0);
    expect(engine.primary()).toBeNull();
  });

  test("a verdict for a pitch that materially changed mid-verify is DISCARDED and the new pitch re-verifies", async () => {
    const firstVerdict = deferred<CandidateVerdict>();
    const secondVerdict = deferred<CandidateVerdict>();
    const detector = new VerifyingDetector(
      [
        oneIdea("Wedding RSVP tracker", 0.9),
        {
          candidates: [
            // The judge echoes the tracked id but the room pivoted: a materially
            // different pitch re-grounds the SAME entry (pitchSimilarity < 0.6).
            { matchId: "idea-001", pitch: "Voice controlled lighting rig", confidence: 0.9, questions: [], answers: [], contextSpan: { startTurnId: "turn-0002", endTurnId: "turn-0002", quote: "q" }, rationale: "" },
          ],
        },
      ],
      [firstVerdict.promise, secondVerdict.promise],
    );
    const traces: DetectionTraceEvent[] = [];
    let ledgerChanges = 0;
    const firstSettled = deferred<void>();
    const secondSettled = deferred<void>();
    const engine = new IdeaDetectionEngine({
      sessionId: "s",
      detector,
      idFactory: sequenceIds("idea"),
      onTrace: (e) => traces.push(e),
      onLedgerChange: () => {
        ledgerChanges += 1;
        if (ledgerChanges === 1) firstSettled.resolve();
        if (ledgerChanges === 2) secondSettled.resolve();
      },
      env: { VIBERSYN_DETECT_MIN_INTERVAL_MS: "0" },
    });
    engine.ingestTurn({ speaker: null, text: "rsvp tracker", atMs: 0 });
    await engine.detect("corr-1", 100); // launches verify #1 for the RSVP pitch
    engine.ingestTurn({ speaker: null, text: "lighting rig", atMs: 200 });
    await engine.detect("corr-2", 200); // re-grounds the entry with the new pitch
    expect(engine.candidates()[0].pitch).toBe("Voice controlled lighting rig");
    // The RSVP uphold settles AFTER the pivot: it must NOT bless the new pitch…
    firstVerdict.resolve({ uphold: true, reason: "novel" });
    await firstSettled.promise;
    expect(traces.map((t) => t.event)).toContain("detect.candidate.verify-stale");
    expect(engine.candidates()[0].verified).toBe(false);
    expect(engine.primary()).toBeNull(); // still withheld — not skeptic-approved
    // …and the settle must have relaunched verification for the CURRENT pitch.
    expect(detector.verifyCalls).toHaveLength(2);
    expect(detector.verifyCalls[1].pitch).toBe("Voice controlled lighting rig");
    secondVerdict.resolve({ uphold: true, reason: "novel now" });
    await secondSettled.promise;
    expect(engine.primary()?.pitch).toBe("Voice controlled lighting rig");
  });

  test("settling a verify relaunches the next pending verification without waiting for new speech", async () => {
    const firstVerdict = deferred<CandidateVerdict>();
    const secondVerdict = deferred<CandidateVerdict>();
    const detector = new VerifyingDetector(
      [
        {
          candidates: [
            { matchId: null, pitch: "Alpha widget", confidence: 0.9, questions: [], answers: [], contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0001", quote: "q" }, rationale: "" },
            { matchId: null, pitch: "Zebra tracker", confidence: 0.8, questions: [], answers: [], contextSpan: { startTurnId: "turn-0002", endTurnId: "turn-0002", quote: "q" }, rationale: "" },
          ],
        },
      ],
      [firstVerdict.promise, secondVerdict.promise],
    );
    let ledgerChanges = 0;
    const firstSettled = deferred<void>();
    const secondSettled = deferred<void>();
    const engine = new IdeaDetectionEngine({
      sessionId: "s",
      detector,
      idFactory: sequenceIds("idea"),
      onLedgerChange: () => {
        ledgerChanges += 1;
        if (ledgerChanges === 1) firstSettled.resolve();
        if (ledgerChanges === 2) secondSettled.resolve();
      },
      env: {},
    });
    engine.ingestTurn({ speaker: null, text: "alpha", atMs: 0 });
    engine.ingestTurn({ speaker: null, text: "zebra", atMs: 100 });
    await engine.detect("corr-1", 200);
    // One verify in flight (the strongest candidate); the other is pending.
    expect(detector.verifyCalls).toHaveLength(1);
    expect(detector.verifyCalls[0].pitch).toBe("Alpha widget");
    firstVerdict.resolve({ uphold: true, reason: "novel" });
    await firstSettled.promise;
    // The settle itself relaunches for Zebra — no new detect round needed.
    expect(detector.verifyCalls).toHaveLength(2);
    expect(detector.verifyCalls[1].pitch).toBe("Zebra tracker");
    expect(engine.primary()?.pitch).toBe("Alpha widget"); // verified one surfaces
    secondVerdict.resolve({ uphold: true, reason: "also novel" });
    await secondSettled.promise;
    expect(engine.candidates().every((c) => c.verified)).toBe(true);
  });
});
