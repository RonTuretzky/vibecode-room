import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, liveProjectorSuggestion, type ProjectorRuntime } from "./composition";
import { ElevenLabsFlashTTSProvider, NoopTTSProvider, arraySegmentSource, type TTSTransport, type VoxTermSegment } from "../providers";
import { AcceptanceController } from "../acceptance/spawn";
import { ProcessRegistry } from "../process/registry";
import { readSuggestionEngineConfig, SuggestionEngine, type SuggestionEngineDecision } from "../suggest/engine";
import type { LogEvent, OutputDecision, PendingSuggestion, TranscriptObservation } from "../types";
import { demoProjectorSnapshot } from "../ui/demo-data";

// ISSUE-0008: live FINAL observations must reach SuggestionEngine.observe with a
// real (heuristic-by-default) decider; interim partials must not drive the engine.

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("LiveProjectorRuntime — live final observations drive the SuggestionEngine", () => {
  test("ingestTranscript forwards only final observations to the engine (spy)", async () => {
    // Ambient (non-buildable) utterances so neither final fires a suggestion: a
    // fired suggestion enters pending and (ISSUE-0010) redirects the next final to
    // acceptance instead of the engine. This test isolates the interim/final gate.
    const path = writeReplayFixture([
      interim("the weather is", "utt-1"),
      interim("the weather is really", "utt-1"),
      final("the weather is really nice and the coffee was good", "utt-1"),
      interim("we chatted about", "utt-2"),
      final("we chatted about weekend plans for a while today", "utt-2"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));
    const observeSpy = spyOn(runtime.suggestionEngine, "observe");

    await driveMic(runtime);

    // Two finals in the fixture → exactly two observe() calls, both final.
    expect(observeSpy.mock.calls.length).toBe(2);
    for (const call of observeSpy.mock.calls) {
      expect(call[0]?.observation.isFinal).toBe(true);
    }
  });

  test("live runtime queues/fires a suggestion from a buildable utterance (integration)", async () => {
    const path = writeReplayFixture([
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    await driveMic(runtime);

    const events = runtime.trace.events().map((event) => event.event);
    expect(events.some((event) => event === "suggestion.queued" || event === "route.suggestion")).toBe(true);
    const decision = runtime.lastSuggestionDecision;
    if (decision === null) {
      throw new Error("expected a suggestion decision from a buildable utterance");
    }
    expect(["queued", "fired"]).toContain(decision.kind);
  });

  test("a non-buildable utterance passes with no queued suggestion (integration)", async () => {
    const path = writeReplayFixture([
      final("the weather has been really nice and the coffee was good this morning", "utt-ambient"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    await driveMic(runtime);

    expect(runtime.lastSuggestionDecision?.kind).toBe("pass");
    expect(runtime.pendingSuggestion()).toBeNull();
    const events = runtime.trace.events().map((event) => event.event);
    expect(events.some((event) => event === "suggestion.queued" || event === "route.suggestion")).toBe(false);
  });
});

// ISSUE-0009: buildSnapshot.suggestion must reflect the live SuggestionEngine
// verdict (state/pitch/confidence/gate/questions) once a final has been scored,
// and keep the demo fixture before any live suggestion exists.
describe("LiveProjectorRuntime — snapshot.suggestion reflects live engine state", () => {
  test("before any live suggestion, the demo bubble is shown (fallback)", async () => {
    const path = writeReplayFixture([]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    // No mic driven yet → no decision → demo fixture verbatim.
    expect(runtime.snapshot().suggestion).toEqual(demoProjectorSnapshot.suggestion);
    expect(runtime.lastSuggestionDecision).toBeNull();
  });

  test("a buildable utterance maps the fired/queued engine state into the bubble (unit)", async () => {
    const path = writeReplayFixture([
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    await driveMic(runtime);

    const decision = runtime.lastSuggestionDecision;
    if (decision === null) {
      throw new Error("expected a suggestion decision from a buildable utterance");
    }
    const suggestion = runtime.snapshot().suggestion;
    // fired -> "speaking", queued -> "queued"; never the demo "queued" pitch.
    const expectedState = decision.kind === "fired" ? "speaking" : "queued";
    expect(suggestion.state).toBe(expectedState);
    expect(suggestion.pitch.length).toBeGreaterThan(0);
    expect(suggestion).not.toEqual(demoProjectorSnapshot.suggestion);
    // Gate floors come from the engine config (WORD_FLOOR=3 in baseEnv), not the
    // static fixture (which uses minWords 60 / minSeconds 90).
    expect(suggestion.gate.minWords).toBe(3);
    expect(suggestion.gate.minSeconds).toBe(90);
    expect(suggestion.gate.words).toBeGreaterThanOrEqual(suggestion.gate.minWords);
    expect(suggestion.confidence).toBeGreaterThan(0);
  });

  test("a non-buildable (pass) utterance maps to an idle bubble with live gate counters (unit)", async () => {
    const path = writeReplayFixture([
      final("the weather has been really nice and the coffee was good this morning", "utt-ambient"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    await driveMic(runtime);

    expect(runtime.lastSuggestionDecision?.kind).toBe("pass");
    const suggestion = runtime.snapshot().suggestion;
    expect(suggestion.state).toBe("idle");
    expect(suggestion.questions).toEqual([]);
    // Gate counters come from the engine, not the demo fixture.
    expect(suggestion.gate.minWords).toBe(3);
    expect(suggestion.gate.words).toBeGreaterThan(0);
    expect(suggestion).not.toEqual(demoProjectorSnapshot.suggestion);
  });

  test("a subscriber's bubble transitions from demo -> live as observations arrive (integration)", async () => {
    const path = writeReplayFixture([
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    const states: string[] = [];
    const pitches: string[] = [];
    const unsubscribe = runtime.subscribe((snapshot) => {
      states.push(snapshot.suggestion.state);
      pitches.push(snapshot.suggestion.pitch);
    });

    // The very first push (on subscribe) is the demo bubble.
    expect(states[0]).toBe(demoProjectorSnapshot.suggestion.state);
    expect(pitches[0]).toBe(demoProjectorSnapshot.suggestion.pitch);

    await driveMic(runtime);
    unsubscribe();

    // After a buildable utterance, the latest published bubble is a live state.
    const finalSuggestion = runtime.snapshot().suggestion;
    expect(["queued", "speaking"]).toContain(finalSuggestion.state);
    expect(finalSuggestion.pitch).not.toBe(demoProjectorSnapshot.suggestion.pitch);
  });
});

// ISSUE-0010: once a suggestion is delivered and pending, a subsequent FINAL
// utterance is an accept/decline candidate — the ingest path routes it to the
// AcceptanceController (GAP-003), and an affirmative spawns through the registry.
describe("LiveProjectorRuntime — spoken acceptance after a delivered suggestion", () => {
  // The pre-spawn resource check reads PANOP_RBG_DISABLE_CAPACITY_CHECK from the
  // global process.env (not the runtime env). The demo fleet seeds two processes
  // against the default cap of two, so give the acceptance spawn headroom here.
  let priorCapacityGuard: string | undefined;
  beforeEach(() => {
    priorCapacityGuard = process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK;
    process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK = "1";
  });
  afterEach(() => {
    if (priorCapacityGuard === undefined) {
      delete process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK;
    } else {
      process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK = priorCapacityGuard;
    }
  });

  test("ingest routes finals to acceptance only while a suggestion is pending (unit, spy)", async () => {
    const path = writeReplayFixture([
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
      final("yes", "utt-yes"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));
    const observeSpy = spyOn(runtime.acceptanceController, "observe");

    await driveMic(runtime);

    // The buildable utterance fired a suggestion (driving the engine, NOT
    // acceptance); only the following "yes" — observed while pending — routes to
    // acceptance. So observe() is called exactly once, with the affirmative.
    expect(runtime.lastSuggestionDecision?.kind).toBe("fired");
    expect(observeSpy.mock.calls.length).toBe(1);
    expect(observeSpy.mock.calls[0]?.[0]?.observation.text).toBe("yes");
    expect(observeSpy.mock.calls[0]?.[0]?.observation.isFinal).toBe(true);
  });

  test("an affirmative after a delivered suggestion spawns a registry process (integration)", async () => {
    const path = writeReplayFixture([
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
      final("yes", "utt-yes"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));
    const before = runtime.registry.activeRecords().length;
    const spawnsBefore = spawnTraceCount(runtime);

    await driveMic(runtime);

    // route.acceptance -> process.spawn: one more live registry record, and the
    // acceptance was routed (trace) before classification spawned it. (The demo
    // fleet also spawns on seed, so compare spawn-trace deltas, not raw presence.)
    expect(runtime.registry.activeRecords().length).toBe(before + 1);
    const events = runtime.trace.events().map((event) => event.event);
    expect(events).toContain("route.acceptance");
    expect(spawnTraceCount(runtime)).toBe(spawnsBefore + 1);
    expect(runtime.snapshot().processes.length).toBe(before + 1);
  });

  test("a decline after a delivered suggestion clears pending without spawning (integration)", async () => {
    const path = writeReplayFixture([
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
      final("no", "utt-no"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));
    const before = runtime.registry.activeRecords().length;
    const spawnsBefore = spawnTraceCount(runtime);

    await driveMic(runtime);

    expect(runtime.registry.activeRecords().length).toBe(before);
    expect(runtime.acceptanceController.awaitingAcceptance()).toBe(false);
    const events = runtime.trace.events().map((event) => event.event);
    expect(events).toContain("route.acceptance");
    // No spawn beyond the demo seed: a decline clears pending without spawning.
    expect(spawnTraceCount(runtime)).toBe(spawnsBefore);
  });
});

// ISSUE-0013: the live loop must drive canonical stage transitions and audible
// feedback — a fired suggestion speaks a TTS summary (SUGGESTION_DELIVERY), and a
// spoken accept earcons + speaks a confirmation (SPAWN E3 + ACK). The earcon/tts
// OutputDecisions land in #outputs so audioSnapshot reflects lastSpoken/earcon
// (GAP-005 speak path + GAP-008 earcons/stage transitions on the live loop).
describe("LiveProjectorRuntime — stage transitions + audible feedback on the live loop", () => {
  let priorCapacityGuard: string | undefined;
  beforeEach(() => {
    priorCapacityGuard = process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK;
    process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK = "1";
  });
  afterEach(() => {
    if (priorCapacityGuard === undefined) {
      delete process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK;
    } else {
      process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK = priorCapacityGuard;
    }
  });

  test("suggestion delivery and spawn drive StageSequencer.transition + spoken outputs (unit, spy)", async () => {
    const path = writeReplayFixture([
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
      final("yes", "utt-yes"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));
    const transitionSpy = spyOn(runtime.stageSequencer, "transition");
    const speakSpy = spyOn(runtime.tts, "speak");

    await driveMic(runtime);

    const transitionFor = (stage: string): OutputDecision | null | undefined =>
      transitionSpy.mock.calls.find((call) => call[0] === stage)?.[1]?.audible;

    // The fired suggestion opens SUGGESTION_DELIVERY with a spoken (tts) summary.
    expect(transitionSpy.mock.calls.some((call) => call[0] === "SUGGESTION_DELIVERY")).toBe(true);
    expect(transitionFor("SUGGESTION_DELIVERY")?.channel).toBe("tts");
    // The spoken accept earcons (SPAWN E3) and speaks a confirmation (ACK tts).
    expect(transitionFor("SPAWN")).toEqual({ channel: "earcon", id: "E3" });
    expect(transitionFor("ACK")?.channel).toBe("tts");
    // The TTS path was actually invoked: at least the summary + the spawn ack.
    expect(speakSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("audioSnapshot reflects the spoken ack and the E3 earcon after suggestion + spawn (integration)", async () => {
    const path = writeReplayFixture([
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
      final("yes", "utt-yes"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    await driveMic(runtime);

    const audio = runtime.snapshot().audio;
    // The spawn earcon (E3) and the spoken spawn ack both surface on the snapshot.
    expect(audio.earcon).toBe("E3");
    expect(audio.lastSpoken).toContain("spawned");

    // No-key (replay) mode: this.tts is the NoopTTSProvider and it recorded the
    // expected phrases — the suggestion summary and the spawn confirmation.
    expect(runtime.tts).toBeInstanceOf(NoopTTSProvider);
    const calls = (runtime.tts as NoopTTSProvider).calls.map((call) => call.text);
    expect(calls.some((text) => text.includes("spawned"))).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // The audible OutputDecisions reach the trace via the canonical emit path.
    const events = runtime.trace.events();
    expect(events.some((event) => event.event === "output.tts")).toBe(true);
    expect(events.some((event) => event.event === "earcon.emit" && event.meta.id === "E3")).toBe(true);
  });
});

// ISSUE-0014 (GAP-009): the assembled end-to-end loop on the REAL composition —
// not the canonical hand-wired harness. createProjectorRuntime wires the live
// SuggestionEngine/AcceptanceController/registry/TTS from the registries, and one
// audio drive walks the full chain (transcript -> suggestion fired -> spoken ->
// acceptance -> registry spawn -> tts/earcon output), verifiable on one
// correlation chain via trace.query. This is the binding measurable for M2/M4 and
// guards against the false assurance the canonical test gives.
describe("LiveProjectorRuntime — assembled ambient loop end to end (ISSUE-0014)", () => {
  let priorCapacityGuard: string | undefined;
  beforeEach(() => {
    priorCapacityGuard = process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK;
    process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK = "1";
  });
  afterEach(() => {
    if (priorCapacityGuard === undefined) {
      delete process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK;
    } else {
      process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK = priorCapacityGuard;
    }
  });

  test("runtime exposes the assembled components for the e2e harness (unit)", async () => {
    const path = writeReplayFixture([]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    // The live runtime exposes the real components selected from the provider/
    // process registries — not canonical hand-wired doubles. A harness drives the
    // loop entirely through these objects.
    expect(runtime.suggestionEngine).toBeInstanceOf(SuggestionEngine);
    expect(runtime.acceptanceController).toBeInstanceOf(AcceptanceController);
    expect(runtime.registry).toBeInstanceOf(ProcessRegistry);
    // No key in baseEnv -> the TTS registry selects the silent-but-recorded Noop
    // provider and the ASR registry selects replay; the loop runs fully offline.
    expect(runtime.tts).toBeInstanceOf(NoopTTSProvider);
    expect(runtime.asrMode).toBe("replay");
    expect(runtime.micMode).toBe("replay");
  });

  test("ambient loop chain on the live runtime — one correlation chain via trace.query (integration)", async () => {
    const path = writeReplayFixture([
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
      final("yes", "utt-yes"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));
    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));

    const session = runtime.startMicSession("corr-loop");
    await session.stop();

    // The buildable utterance fired a suggestion that went live on the snapshot.
    expect(runtime.lastSuggestionDecision?.kind).toBe("fired");
    expect(runtime.snapshot().suggestion.state).toBe("speaking");
    expect(runtime.snapshot().suggestion).not.toEqual(demoProjectorSnapshot.suggestion);

    // The ordered chain across the trace: the suggestion fired (utt-build), then the
    // affirmative routed to acceptance and spawned (utt-yes), then the spoken ack.
    const events = runtime.trace.events();
    const acceptanceCorrelationId = "corr-loop-utt-yes";
    const firstIndex = (event: string, correlationId?: string): number =>
      events.findIndex((entry) => entry.event === event && (correlationId === undefined || entry.correlationId === correlationId));
    const suggestionIndex = firstIndex("route.suggestion");
    const acceptanceIndex = firstIndex("route.acceptance", acceptanceCorrelationId);
    const spawnIndex = firstIndex("process.spawn", acceptanceCorrelationId);
    const ackIndex = firstIndex("output.tts", acceptanceCorrelationId);
    expect(suggestionIndex).toBeGreaterThanOrEqual(0);
    expect(suggestionIndex).toBeLessThan(acceptanceIndex);
    expect(acceptanceIndex).toBeLessThan(spawnIndex);
    expect(spawnIndex).toBeLessThan(ackIndex);

    // One correlation chain (the acceptance spawn) reconstructs decision -> action
    // -> outcome: route.acceptance -> process.spawn -> tts/earcon output.
    const chain = runtime.trace.query(acceptanceCorrelationId);
    expect(chain.decision.map((entry) => entry.event)).toContain("route.acceptance");
    expect(chain.action.map((entry) => entry.event)).toContain("process.spawn");
    expect(chain.outcome.some((entry) => entry.event === "output.tts")).toBe(true);
    expect(chain.outcome.some((entry) => entry.event === "earcon.emit" && entry.meta.id === "E3")).toBe(true);

    // snapshot.processes gained exactly the spawned process.
    const spawned = runtime.snapshot().processes.filter((process) => !upidsBefore.has(process.upid));
    expect(spawned.length).toBe(1);
    expect(runtime.snapshot().processes.length).toBe(upidsBefore.size + 1);
  });
});

// ISSUE-0016: the live runtime selects its ambient + mic ASR backend through the
// providers ASR registry (selectAsrProvider), so PANOP_ASR_PROVIDER picks the
// backend, Deepgram stays the key-present default, and tests inject a synthetic
// ASR source. The local shadowing selectors are gone.
describe("LiveProjectorRuntime — ASR backend selection through the providers registry (ISSUE-0016)", () => {
  let priorAsrProvider: string | undefined;
  let priorDeepgramKey: string | undefined;
  beforeEach(() => {
    priorAsrProvider = process.env.PANOP_ASR_PROVIDER;
    priorDeepgramKey = process.env.DEEPGRAM_API_KEY;
    delete process.env.PANOP_ASR_PROVIDER;
    delete process.env.DEEPGRAM_API_KEY;
  });
  afterEach(() => {
    restoreEnv("PANOP_ASR_PROVIDER", priorAsrProvider);
    restoreEnv("DEEPGRAM_API_KEY", priorDeepgramKey);
  });

  test("PANOP_ASR_PROVIDER=voxterm selects voxterm for both ambient + mic (unit)", async () => {
    const runtime = await createProjectorRuntime(
      { PANOP_INITIAL_MUTED: "0", PANOP_ASR_PROVIDER: "voxterm" },
      { voxtermSource: arraySegmentSource([]) },
    );

    expect(runtime.asrMode).toBe("voxterm");
    expect(runtime.micMode).toBe("voxterm");
    expect(runtime.snapshot().mic?.mode).toBe("voxterm");
  });

  test("unset PANOP_ASR_PROVIDER + DEEPGRAM_API_KEY present selects deepgram (unit)", async () => {
    const runtime = await createProjectorRuntime({
      PANOP_INITIAL_MUTED: "0",
      DEEPGRAM_API_KEY: "dg-test-key",
    });

    expect(runtime.asrMode).toBe("deepgram");
    expect(runtime.micMode).toBe("deepgram");
  });

  test("unset PANOP_ASR_PROVIDER + no key falls back to replay (unit)", async () => {
    const runtime = await createProjectorRuntime({ PANOP_INITIAL_MUTED: "0" });

    expect(runtime.asrMode).toBe("replay");
    expect(runtime.micMode).toBe("replay");
  });

  test("explicit PANOP_ASR_PROVIDER=replay overrides a present DEEPGRAM_API_KEY (unit)", async () => {
    const runtime = await createProjectorRuntime({
      PANOP_INITIAL_MUTED: "0",
      PANOP_ASR_PROVIDER: "replay",
      DEEPGRAM_API_KEY: "dg-test-key",
    });

    expect(runtime.asrMode).toBe("replay");
    expect(runtime.micMode).toBe("replay");
  });

  test("an injected voxterm source flows a synthetic segment into the runtime transcript (integration)", async () => {
    const segments: VoxTermSegment[] = [
      { utteranceId: 1, text: "hey panop", final: false, speaker: 0 },
      { utteranceId: 1, text: "hey panop spin up a runner", final: true, speaker: 0 },
    ];
    const runtime = await createProjectorRuntime(
      { PANOP_INITIAL_MUTED: "0", PANOP_ASR_PROVIDER: "voxterm" },
      { voxtermSource: arraySegmentSource(segments) },
    );

    await driveMic(runtime);

    // The registry-selected voxterm provider normalized the synthetic segment and
    // it reached the runtime's transcript handling: the committed final surfaced on
    // the published snapshot's transcript region.
    const transcript = runtime.snapshot().transcript;
    expect(transcript.some((line) => line.text === "hey panop spin up a runner")).toBe(true);
    expect(transcript.some((line) => line.text === "hey panop")).toBe(false);
  });
});

// ISSUE-0018: the wired path from a real-speech-shaped FINAL transcript through
// SuggestionEngine.observe to a populated snapshot.suggestion idea bubble. The
// projection (decision -> bubble) is unit-testable in isolation, and the engine's
// pending suggestion is the live state the runtime consumes to drive the bubble.
describe("LiveProjectorRuntime — live final -> SuggestionEngine.observe -> snapshot.suggestion (ISSUE-0018)", () => {
  test("liveProjectorSuggestion maps a fired decision to the bubble (unit)", () => {
    const suggestion: PendingSuggestion = {
      suggestionId: "sg-build-1",
      pitch: "Spin up a replay dashboard runner",
      mcqs: ["Want me to kick that off now?"],
      answers: [],
      correlationId: "corr-unit-fired",
      expiresAt: 0,
    };
    // A `fired` verdict carries its gate counters only on its trace events, so the
    // projection pulls words/seconds/quality from the first event whose meta has them.
    const events: LogEvent[] = [
      {
        event: "suggestion.fired",
        level: "info",
        sessionId: "test-session",
        correlationId: "corr-unit-fired",
        meta: { wordCount: 12, elapsedS: 95, quality: 0.82 },
      },
    ];
    const decision: SuggestionEngineDecision = { kind: "fired", suggestion, events };

    const config = readSuggestionEngineConfig({ PANOP_SUGGEST_WORD_FLOOR: "3" });
    const bubble = liveProjectorSuggestion(decision, config);
    if (bubble === null) {
      throw new Error("a fired decision must project to a populated bubble, not null");
    }

    // A fired suggestion surfaces as the live "speaking" idea bubble: the pitch and
    // its lead question come straight off the suggestion, confidence + gate counters
    // off the decision meta, and the floors off the engine config (not the demo).
    expect(bubble.state).toBe("speaking");
    expect(bubble.pitch).toBe("Spin up a replay dashboard runner");
    expect(bubble.questions).toEqual(["Want me to kick that off now?"]);
    expect(bubble.confidence).toBe(0.82);
    expect(bubble.gate).toEqual({ words: 12, minWords: 3, seconds: 95, minSeconds: 90 });
    expect(bubble).not.toEqual(demoProjectorSnapshot.suggestion);
  });

  test("observe of a buildable final populates the engine pending suggestion consumed by the runtime (integration)", async () => {
    const path = writeReplayFixture([
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    // Before any final is observed there is no pending suggestion and the runtime
    // shows the demo bubble.
    expect(runtime.acceptanceController.awaitingAcceptance()).toBe(false);

    await driveMic(runtime);

    // SuggestionEngine.observe on the buildable final produced a suggestion that
    // fired and is now pending acceptance — the live state the runtime consumes.
    const decision = runtime.lastSuggestionDecision;
    if (decision === null || decision.kind !== "fired") {
      throw new Error("expected the buildable final to fire a suggestion");
    }
    expect(decision.suggestion.pitch.length).toBeGreaterThan(0);
    expect(runtime.acceptanceController.awaitingAcceptance()).toBe(true);

    // The runtime consumed that fired verdict into the published idea bubble:
    // a live "speaking" pitch + lead question, not the idle/demo baseline.
    const bubble = runtime.snapshot().suggestion;
    expect(bubble.state).toBe("speaking");
    expect(bubble.pitch).toBe(decision.suggestion.pitch);
    expect(bubble.questions.length).toBeGreaterThan(0);
    expect(bubble).not.toEqual(demoProjectorSnapshot.suggestion);
  });
});

// ISSUE-0022: emitOutput must consume the AudioReadableStream returned by
// tts.speak to completion via the sink. With PANOP_TTS_PROVIDER=elevenlabs and a
// stubbed transport, a fired suggestion's tts OutputDecision drains the whole
// synthesized stream and records byte/chunk totals on the trace; an unset
// provider keeps the silent-but-recorded NoopTTSProvider.
describe("LiveProjectorRuntime — emitOutput drains the synthesized TTS stream (ISSUE-0022)", () => {
  test("a fired suggestion drains a stubbed ElevenLabs stream and records bytes/chunks on the trace (integration)", async () => {
    const path = writeReplayFixture([
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
    ]);
    const synthetic = [
      Uint8Array.from([0x49, 0x44, 0x33]),
      Uint8Array.from([0x10, 0x20, 0x30, 0x40]),
      Uint8Array.from([0xaa, 0xbb]),
    ];
    const expectedBytes = synthetic.reduce((sum, chunk) => sum + chunk.byteLength, 0);

    let speakCalls = 0;
    let pulledChunks = 0;
    const transport: TTSTransport = async () => {
      speakCalls += 1;
      let index = 0;
      // A pull-based (lazy) stream: a chunk is produced only when the drain pulls
      // it, so `pulledChunks === synthetic.length` proves the whole stream was read.
      return new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (index >= synthetic.length) {
              controller.close();
              return;
            }
            controller.enqueue(synthetic[index]);
            index += 1;
            pulledChunks += 1;
          },
        },
        { highWaterMark: 0 },
      );
    };

    const runtime = await createProjectorRuntime(
      baseEnv(path, { PANOP_TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: fakeElevenLabsKey() }),
      { ttsTransport: transport },
    );
    expect(runtime.tts).toBeInstanceOf(ElevenLabsFlashTTSProvider);

    await driveMic(runtime);

    // The fired suggestion produced exactly one spoken (tts) OutputDecision, and
    // emitOutput drained its stream to completion through the stub transport.
    expect(runtime.lastSuggestionDecision?.kind).toBe("fired");
    expect(speakCalls).toBe(1);
    expect(pulledChunks).toBe(synthetic.length);

    // The trace records the drained byte/chunk totals on the output.tts event.
    const ttsEvents = runtime.trace.events().filter((event) => event.event === "output.tts");
    expect(ttsEvents).toHaveLength(1);
    expect(ttsEvents[0]?.meta.bytes).toBe(expectedBytes);
    expect(ttsEvents[0]?.meta.chunks).toBe(synthetic.length);
    // No drain error was recorded — the stream was consumed cleanly.
    expect(runtime.trace.events().some((event) => event.event === "output.tts.drain.error")).toBe(false);
  });

  test("PANOP_TTS_PROVIDER unset keeps the NoopTTSProvider (silent, records text only) (integration)", async () => {
    const path = writeReplayFixture([
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
    ]);
    const runtime = await createProjectorRuntime(baseEnv(path));

    await driveMic(runtime);

    // Default selection is the silent-but-recorded Noop provider: it records the
    // spoken phrase and returns an immediately-closed (zero-byte) stream that the
    // sink still drains to completion.
    expect(runtime.tts).toBeInstanceOf(NoopTTSProvider);
    expect((runtime.tts as NoopTTSProvider).calls.length).toBeGreaterThanOrEqual(1);
    const ttsEvents = runtime.trace.events().filter((event) => event.event === "output.tts");
    expect(ttsEvents.length).toBeGreaterThanOrEqual(1);
    expect(ttsEvents[0]?.meta.bytes).toBe(0);
    expect(ttsEvents[0]?.meta.chunks).toBe(0);
  });
});

// Built at runtime (never a literal) so the source tree stays free of key-shaped
// strings, matching the audio credential seam's accepted token shape.
function fakeElevenLabsKey(): string {
  return ["xi", `${"a".repeat(18)}1${"b".repeat(18)}`].join("-");
}

function restoreEnv(key: string, prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = prior;
  }
}

function spawnTraceCount(runtime: ProjectorRuntime): number {
  return runtime.trace.events().filter((event) => event.event === "process.spawn").length;
}

function baseEnv(replayPath: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    // Start unmuted so the (mute-protected) replay mic actually streams.
    PANOP_INITIAL_MUTED: "0",
    PANOP_MIC_REPLAY_PATH: replayPath,
    // Lower the REQ-3 floors so a single short utterance is eligible, and zero the
    // interrupt weights so a buildable utterance fires deterministically.
    PANOP_SUGGEST_WORD_FLOOR: "3",
    PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
    ...overrides,
  };
}

async function driveMic(runtime: ProjectorRuntime): Promise<void> {
  const session = runtime.startMicSession("corr-test-mic");
  // stop() awaits the background drain loop, so every replayed observation has
  // been fully processed (including the awaited engine.observe) once it resolves.
  await session.stop();
}

function writeReplayFixture(observations: TranscriptObservation[]): string {
  const dir = mkdtempSync(join(tmpdir(), "panop-mic-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, observations.map((observation) => JSON.stringify(observation)).join("\n"), "utf8");
  return path;
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return observation(text, true, utteranceId);
}

function interim(text: string, utteranceId: string): TranscriptObservation {
  return observation(text, false, utteranceId);
}

function observation(text: string, isFinal: boolean, utteranceId: string): TranscriptObservation {
  return { text, isFinal, speaker: "Room", sessionId: "test-session", latencyMs: 20, utteranceId };
}
