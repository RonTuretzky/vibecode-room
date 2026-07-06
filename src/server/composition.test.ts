import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, liveProjectorSuggestion, type ProjectorRuntime } from "./composition";
import { DetectionRunner } from "./detection-runner";
import { HeuristicIdeaDetector, type DetectionInput, type DetectionResult, type IdeaDetector } from "../detect";
import { RecordingAudioSink, type AudioSink } from "./audio-device-sink";
import { PRERENDERED_EARCONS } from "../audio/earcons";
import { ElevenLabsFlashTTSProvider, NoopTTSProvider, arraySegmentSource, type TTSTransport, type VoxTermSegment } from "../providers";
import { AcceptanceController } from "../acceptance/spawn";
import { ProcessRegistry } from "../process/registry";
import { readSuggestionEngineConfig, SuggestionEngine, type SuggestionEngineDecision } from "../suggest/engine";
import type { LogEvent, OutputDecision, PendingSuggestion, TranscriptObservation } from "../types";
import { demoProjectorSnapshot, emptyProjectorSnapshot } from "../ui/demo-data";

// The live FINAL transcript now drives IDEA DETECTION (windowed model inference
// over the rolling conversation), not the old word/time gate. Tests inject a
// deterministic detector (the HeuristicIdeaDetector, or a recording fake) so no
// `claude` is spawned. A buildable utterance surfaces a grounded idea bubble; the
// downstream delivery/acceptance/build chain is unchanged.

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// A buildable utterance the HeuristicIdeaDetector grounds into a candidate (it
// contains the cues "build", "dashboard", "tool", "prototype").
const BUILDABLE = "let's build a dashboard tool to ship the replay prototype today";
const AMBIENT = "the weather has been really nice and the coffee was good this morning";

describe("LiveProjectorRuntime — live finals drive idea detection", () => {
  test("only FINAL observations reach the detector; interims never enter the window (spy)", async () => {
    const recorder = new RecordingDetector();
    const { runtime, drive } = await makeRuntime({ ideaDetector: recorder });
    await drive([
      interim("the weather is", "utt-1"),
      interim("the weather is really", "utt-1"),
      final("the weather is really nice and the coffee was good", "utt-1"),
      interim("we chatted about", "utt-2"),
      final("we chatted about weekend plans for a while today", "utt-2"),
    ]);

    // Detection ran over the window; the latest call saw exactly the two FINALs,
    // never an interim partial.
    expect(recorder.inputs.length).toBeGreaterThanOrEqual(1);
    const lastTurns = recorder.inputs.at(-1)!.turns.map((t) => t.text);
    expect(lastTurns).toEqual([
      "the weather is really nice and the coffee was good",
      "we chatted about weekend plans for a while today",
    ]);
  });

  test("a buildable utterance surfaces a grounded idea candidate (integration)", async () => {
    const { runtime, drive } = await makeRuntime();
    await drive([final(BUILDABLE, "utt-build")]);

    const primary = runtime.detection.primary();
    expect(primary).not.toBeNull();
    expect(primary!.pitch.length).toBeGreaterThan(0);
    // The idea is GROUNDED: it points back at the turn it came from with a quote.
    expect(primary!.contextSpan.startTurnId).toBe("turn-0001");
    expect(primary!.contextSpan.quote).toContain("dashboard");
    const events = runtime.trace.events().map((event) => event.event);
    expect(events).toContain("detect.candidate.new");
  });

  test("a non-buildable utterance surfaces no idea (integration)", async () => {
    const { runtime, drive } = await makeRuntime();
    await drive([final(AMBIENT, "utt-ambient")]);

    expect(runtime.detection.primary()).toBeNull();
    expect(runtime.detection.candidates()).toHaveLength(0);
    const events = runtime.trace.events().map((event) => event.event);
    expect(events).toContain("detect.run");
    expect(events).not.toContain("detect.candidate.new");
  });
});

// A freshly-booted LIVE runtime shows NO fixtures: the seeded demo fleet is off by
// default, the transcript is empty, and the idea bubble is the neutral idle state.
describe("LiveProjectorRuntime — fixture-free idle boot", () => {
  test("a freshly-booted live runtime has zero processes, an empty transcript, and an idle suggestion", async () => {
    const { runtime } = await makeRuntime();

    const snapshot = runtime.snapshot();
    expect(snapshot.processes).toHaveLength(0);
    expect(runtime.registry.activeRecords()).toHaveLength(0);
    expect(snapshot.processes.some((process) => process.callsign === "Atlas")).toBe(false);
    expect(snapshot.processes.some((process) => process.callsign === "Cobalt")).toBe(false);
    expect(snapshot.transcript).toHaveLength(0);
    expect(snapshot.suggestion.state).toBe("idle");
    expect(snapshot.suggestion.pitch).toBe("");
    expect(snapshot.suggestion).not.toEqual(demoProjectorSnapshot.suggestion);
    expect(snapshot.audio.lastSpoken).toBe("");
    expect(snapshot.audio.earcon).toBe("");
    expect(snapshot.trace).not.toEqual(demoProjectorSnapshot.trace);
  });

  test("opting into VIBERSYN_SEED_DEMO_FLEET=1 restores the seeded Atlas/Cobalt fleet", async () => {
    const { runtime } = await makeRuntime({ env: { VIBERSYN_SEED_DEMO_FLEET: "1" } });
    const callsigns = runtime.snapshot().processes.map((process) => process.callsign);
    expect(callsigns).toContain("Atlas");
    expect(callsigns).toContain("Cobalt");
    expect(runtime.registry.activeRecords().length).toBe(2);
  });
});

// buildSnapshot.suggestion reflects the live DETECTION primary candidate, carrying
// its grounding span, and stays the neutral idle bubble before any idea surfaces.
describe("LiveProjectorRuntime — snapshot.suggestion reflects live detection", () => {
  test("before any idea is detected, the neutral idle bubble is shown (no demo fixture)", async () => {
    const { runtime } = await makeRuntime();
    const suggestion = runtime.snapshot().suggestion;
    expect(suggestion).toEqual(emptyProjectorSnapshot.suggestion);
    expect(suggestion.state).toBe("idle");
    expect(suggestion.pitch).toBe("");
    expect(suggestion).not.toEqual(demoProjectorSnapshot.suggestion);
  });

  test("a buildable utterance maps the detected candidate into the bubble with provenance (unit)", async () => {
    const { runtime, drive } = await makeRuntime();
    await drive([final(BUILDABLE, "utt-build")]);

    const suggestion = runtime.snapshot().suggestion;
    expect(suggestion.state).toBe("queued");
    expect(suggestion.pitch.length).toBeGreaterThan(0);
    expect(suggestion.confidence).toBeGreaterThan(0);
    // Provenance: the bubble carries the span of conversation it was grounded in.
    expect(suggestion.contextSpan?.startTurnId).toBe("turn-0001");
    expect(suggestion.contextSpan?.quote.length ?? 0).toBeGreaterThan(0);
    expect(suggestion).not.toEqual(demoProjectorSnapshot.suggestion);
  });

  test("a non-buildable utterance keeps the idle bubble (no idea surfaced)", async () => {
    const { runtime, drive } = await makeRuntime();
    await drive([final(AMBIENT, "utt-ambient")]);

    const suggestion = runtime.snapshot().suggestion;
    expect(suggestion.state).toBe("idle");
    expect(suggestion.pitch).toBe("");
    expect(suggestion).not.toEqual(demoProjectorSnapshot.suggestion);
  });

  test("a subscriber's bubble transitions from idle -> live as a buildable idea is detected (integration)", async () => {
    const { runtime, drive } = await makeRuntime();
    const states: string[] = [];
    const pitches: string[] = [];
    const unsubscribe = runtime.subscribe((snapshot) => {
      states.push(snapshot.suggestion.state);
      pitches.push(snapshot.suggestion.pitch);
    });
    expect(states[0]).toBe(emptyProjectorSnapshot.suggestion.state);
    expect(pitches[0]).toBe(emptyProjectorSnapshot.suggestion.pitch);

    await drive([final(BUILDABLE, "utt-build")]);
    unsubscribe();

    const finalSuggestion = runtime.snapshot().suggestion;
    expect(finalSuggestion.state).toBe("queued");
    expect(finalSuggestion.pitch).not.toBe(demoProjectorSnapshot.suggestion.pitch);
  });
});

// Once an idea is surfaced and pending, a subsequent FINAL utterance is an
// accept/decline candidate — the ingest path routes it to the AcceptanceController,
// and an affirmative spawns through the registry.
describe("LiveProjectorRuntime — spoken acceptance after a surfaced idea", () => {
  let priorCapacityGuard: string | undefined;
  beforeEach(() => {
    priorCapacityGuard = process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
    process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = "1";
  });
  afterEach(() => {
    restoreEnv("VIBERSYN_RBG_DISABLE_CAPACITY_CHECK", priorCapacityGuard);
  });

  test("a surfaced idea sets the acceptance pending; an affirmative routes to acceptance (unit, spy)", async () => {
    const { runtime, drive } = await makeRuntime();
    await drive([final(BUILDABLE, "utt-build")]);
    // The surfaced idea fed the acceptance pending.
    expect(runtime.acceptanceController.awaitingAcceptance()).toBe(true);

    const observeSpy = spyOn(runtime.acceptanceController, "observe");
    await drive([final("yes", "utt-yes")]);
    // Only the "yes" — observed while pending — routes to acceptance.
    expect(observeSpy.mock.calls.length).toBe(1);
    expect(observeSpy.mock.calls[0]?.[0]?.observation.text).toBe("yes");
  });

  test("an affirmative after a surfaced idea spawns a registry process (integration)", async () => {
    const { runtime, drive } = await makeRuntime();
    const before = runtime.registry.activeRecords().length;
    const spawnsBefore = spawnTraceCount(runtime);

    await drive([final(BUILDABLE, "utt-build")]);
    await drive([final("yes", "utt-yes")]);

    expect(runtime.registry.activeRecords().length).toBe(before + 1);
    const events = runtime.trace.events().map((event) => event.event);
    expect(events).toContain("route.acceptance");
    expect(spawnTraceCount(runtime)).toBe(spawnsBefore + 1);
    expect(runtime.snapshot().processes.length).toBe(before + 1);
  });

  test("a decline after a surfaced idea clears pending without spawning (integration)", async () => {
    const { runtime, drive } = await makeRuntime();
    const before = runtime.registry.activeRecords().length;
    const spawnsBefore = spawnTraceCount(runtime);

    await drive([final(BUILDABLE, "utt-build")]);
    await drive([final("no", "utt-no")]);

    expect(runtime.registry.activeRecords().length).toBe(before);
    expect(runtime.acceptanceController.awaitingAcceptance()).toBe(false);
    expect(runtime.trace.events().map((event) => event.event)).toContain("route.acceptance");
    expect(spawnTraceCount(runtime)).toBe(spawnsBefore);
  });
});

// The live loop drives canonical stage transitions and audible feedback: a
// surfaced idea speaks a TTS summary (SUGGESTION_DELIVERY), and a spoken accept
// earcons + speaks a confirmation (SPAWN E3 + ACK).
describe("LiveProjectorRuntime — stage transitions + audible feedback on the live loop", () => {
  let priorCapacityGuard: string | undefined;
  beforeEach(() => {
    priorCapacityGuard = process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
    process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = "1";
  });
  afterEach(() => {
    restoreEnv("VIBERSYN_RBG_DISABLE_CAPACITY_CHECK", priorCapacityGuard);
  });

  test("idea delivery and spawn drive StageSequencer.transition + spoken outputs (unit, spy)", async () => {
    const { runtime, drive } = await makeRuntime();
    const transitionSpy = spyOn(runtime.stageSequencer, "transition");
    const speakSpy = spyOn(runtime.tts, "speak");

    await drive([final(BUILDABLE, "utt-build")]);
    await drive([final("yes", "utt-yes")]);

    const transitionFor = (stage: string): OutputDecision | null | undefined =>
      transitionSpy.mock.calls.find((call) => call[0] === stage)?.[1]?.audible;

    expect(transitionSpy.mock.calls.some((call) => call[0] === "SUGGESTION_DELIVERY")).toBe(true);
    expect(transitionFor("SUGGESTION_DELIVERY")?.channel).toBe("tts");
    expect(transitionFor("SPAWN")).toEqual({ channel: "earcon", id: "E3" });
    expect(transitionFor("ACK")?.channel).toBe("tts");
    expect(speakSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("audioSnapshot reflects the spoken ack and the E3 earcon after idea + spawn (integration)", async () => {
    const { runtime, drive } = await makeRuntime();

    await drive([final(BUILDABLE, "utt-build")]);
    await drive([final("yes", "utt-yes")]);

    const audio = runtime.snapshot().audio;
    expect(audio.earcon).toBe("E3");
    expect(audio.lastSpoken).toContain("spawned");
    expect(runtime.tts).toBeInstanceOf(NoopTTSProvider);
    const calls = (runtime.tts as NoopTTSProvider).calls.map((call) => call.text);
    expect(calls.some((text) => text.includes("spawned"))).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const events = runtime.trace.events();
    expect(events.some((event) => event.event === "output.tts")).toBe(true);
    expect(events.some((event) => event.event === "earcon.emit" && event.meta.id === "E3")).toBe(true);
  });
});

// The assembled end-to-end loop on the REAL composition: detection surfaces an
// idea, a spoken affirmative spawns through the registry, and the spawn ack speaks.
describe("LiveProjectorRuntime — assembled ambient loop end to end", () => {
  let priorCapacityGuard: string | undefined;
  beforeEach(() => {
    priorCapacityGuard = process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
    process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = "1";
  });
  afterEach(() => {
    restoreEnv("VIBERSYN_RBG_DISABLE_CAPACITY_CHECK", priorCapacityGuard);
  });

  test("runtime exposes the assembled components for the e2e harness (unit)", async () => {
    const { runtime } = await makeRuntime();
    expect(runtime.suggestionEngine).toBeInstanceOf(SuggestionEngine);
    expect(runtime.detection).toBeInstanceOf(DetectionRunner);
    expect(runtime.acceptanceController).toBeInstanceOf(AcceptanceController);
    expect(runtime.registry).toBeInstanceOf(ProcessRegistry);
    expect(runtime.tts).toBeInstanceOf(NoopTTSProvider);
    expect(runtime.asrMode).toBe("replay");
    expect(runtime.micMode).toBe("replay");
  });

  test("ambient loop chain on the live runtime — detect -> deliver -> accept -> spawn -> ack (integration)", async () => {
    const { runtime, drive } = await makeRuntime();
    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));

    await drive([final(BUILDABLE, "utt-build")]);
    expect(runtime.detection.primary()).not.toBeNull();
    expect(runtime.snapshot().suggestion.state).toBe("queued");

    await drive([final("yes", "utt-yes")]);

    // Ordered chain across the trace: acceptance routed (utt-yes), then spawned,
    // then the spoken ack.
    const events = runtime.trace.events();
    const firstIndex = (event: string): number => events.findIndex((entry) => entry.event === event);
    const acceptanceIndex = firstIndex("route.acceptance");
    const spawnIndex = firstIndex("process.spawn");
    const ackIndex = events.map((e) => e.event).lastIndexOf("output.tts");
    expect(acceptanceIndex).toBeGreaterThanOrEqual(0);
    expect(acceptanceIndex).toBeLessThan(spawnIndex);
    expect(spawnIndex).toBeLessThan(ackIndex);

    expect(events.some((event) => event.event === "earcon.emit" && event.meta.id === "E3")).toBe(true);
    const spawned = runtime.snapshot().processes.filter((process) => !upidsBefore.has(process.upid));
    expect(spawned.length).toBe(1);
    expect(runtime.snapshot().processes.length).toBe(upidsBefore.size + 1);
  });
});

// ASR backend selection is unchanged by detection (VIBERSYN_ASR_PROVIDER picks the
// backend; tests inject a synthetic source). Detection is forced to the heuristic
// so no model spawns even when a synthetic segment flows through.
describe("LiveProjectorRuntime — ASR backend selection through the providers registry", () => {
  let priorAsrProvider: string | undefined;
  let priorDeepgramKey: string | undefined;
  beforeEach(() => {
    priorAsrProvider = process.env.VIBERSYN_ASR_PROVIDER;
    priorDeepgramKey = process.env.DEEPGRAM_API_KEY;
    delete process.env.VIBERSYN_ASR_PROVIDER;
    delete process.env.DEEPGRAM_API_KEY;
  });
  afterEach(() => {
    restoreEnv("VIBERSYN_ASR_PROVIDER", priorAsrProvider);
    restoreEnv("DEEPGRAM_API_KEY", priorDeepgramKey);
  });

  test("VIBERSYN_ASR_PROVIDER=voxterm selects voxterm for both ambient + mic (unit)", async () => {
    const runtime = await createProjectorRuntime(
      { VIBERSYN_INITIAL_MUTED: "0", VIBERSYN_ASR_PROVIDER: "voxterm", VIBERSYN_IDEA_DETECTOR: "heuristic" },
      { voxtermSource: arraySegmentSource([]) },
    );
    expect(runtime.asrMode).toBe("voxterm");
    expect(runtime.micMode).toBe("voxterm");
    expect(runtime.snapshot().mic?.mode).toBe("voxterm");
  });

  test("unset VIBERSYN_ASR_PROVIDER + DEEPGRAM_API_KEY present selects deepgram (unit)", async () => {
    const runtime = await createProjectorRuntime({ VIBERSYN_INITIAL_MUTED: "0", DEEPGRAM_API_KEY: "dg-test-key", VIBERSYN_IDEA_DETECTOR: "heuristic" });
    expect(runtime.asrMode).toBe("deepgram");
    expect(runtime.micMode).toBe("deepgram");
  });

  test("unset VIBERSYN_ASR_PROVIDER + no key falls back to replay (unit)", async () => {
    const runtime = await createProjectorRuntime({ VIBERSYN_INITIAL_MUTED: "0", VIBERSYN_IDEA_DETECTOR: "heuristic" });
    expect(runtime.asrMode).toBe("replay");
    expect(runtime.micMode).toBe("replay");
  });

  test("explicit VIBERSYN_ASR_PROVIDER=replay overrides a present DEEPGRAM_API_KEY (unit)", async () => {
    const runtime = await createProjectorRuntime({ VIBERSYN_INITIAL_MUTED: "0", VIBERSYN_ASR_PROVIDER: "replay", DEEPGRAM_API_KEY: "dg-test-key", VIBERSYN_IDEA_DETECTOR: "heuristic" });
    expect(runtime.asrMode).toBe("replay");
    expect(runtime.micMode).toBe("replay");
  });

  test("an injected voxterm source flows a synthetic segment into the runtime transcript (integration)", async () => {
    const segments: VoxTermSegment[] = [
      { utteranceId: 1, text: "hey viber", final: false, speaker: 0 },
      { utteranceId: 1, text: "hey viber spin up a runner", final: true, speaker: 0 },
    ];
    const runtime = await createProjectorRuntime(
      { VIBERSYN_INITIAL_MUTED: "0", VIBERSYN_ASR_PROVIDER: "voxterm", VIBERSYN_IDEA_DETECTOR: "heuristic" },
      { voxtermSource: arraySegmentSource(segments) },
    );
    const session = runtime.startMicSession("corr-test-mic");
    await session.stop();
    await runtime.detection.flush();

    const transcript = runtime.snapshot().transcript;
    expect(transcript.some((line) => line.text === "hey viber spin up a runner")).toBe(true);
    expect(transcript.some((line) => line.text === "hey viber")).toBe(false);
  });
});

// liveProjectorSuggestion (the legacy gate→bubble projection) remains a pure,
// independently-tested function even though the live path no longer drives it.
describe("liveProjectorSuggestion (legacy projection, still unit-tested)", () => {
  test("maps a fired decision to the bubble (unit)", () => {
    const suggestion: PendingSuggestion = {
      suggestionId: "sg-build-1",
      pitch: "Spin up a replay dashboard runner",
      mcqs: ["Want me to kick that off now?"],
      answers: [],
      correlationId: "corr-unit-fired",
      expiresAt: 0,
    };
    const events: LogEvent[] = [
      { event: "suggestion.fired", level: "info", sessionId: "test-session", correlationId: "corr-unit-fired", meta: { wordCount: 12, elapsedS: 95, quality: 0.82 } },
    ];
    const decision: SuggestionEngineDecision = { kind: "fired", suggestion, events };
    const config = readSuggestionEngineConfig({ VIBERSYN_SUGGEST_WORD_FLOOR: "3" });
    const bubble = liveProjectorSuggestion(decision, config);
    if (bubble === null) {
      throw new Error("a fired decision must project to a populated bubble, not null");
    }
    expect(bubble.state).toBe("speaking");
    expect(bubble.pitch).toBe("Spin up a replay dashboard runner");
    expect(bubble.questions).toEqual(["Want me to kick that off now?"]);
    expect(bubble.confidence).toBe(0.82);
    expect(bubble.gate).toEqual({ words: 12, minWords: 3, seconds: 95, minSeconds: 90 });
  });
});

// emitOutput consumes the AudioReadableStream returned by tts.speak to completion
// via the sink: a surfaced idea's delivery drains the whole synthesized stream.
describe("LiveProjectorRuntime — emitOutput drains the synthesized TTS stream", () => {
  test("a surfaced idea drains a stubbed ElevenLabs stream and records bytes/chunks on the trace (integration)", async () => {
    const synthetic = [Uint8Array.from([0x49, 0x44, 0x33]), Uint8Array.from([0x10, 0x20, 0x30, 0x40]), Uint8Array.from([0xaa, 0xbb])];
    const expectedBytes = synthetic.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    let speakCalls = 0;
    let pulledChunks = 0;
    const transport: TTSTransport = async () => {
      speakCalls += 1;
      let index = 0;
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
    const { runtime, drive } = await makeRuntime({
      env: { VIBERSYN_TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: fakeElevenLabsKey() },
      options: { ttsTransport: transport },
    });
    expect(runtime.tts).toBeInstanceOf(ElevenLabsFlashTTSProvider);

    await drive([final(BUILDABLE, "utt-build")]);

    expect(speakCalls).toBe(1);
    expect(pulledChunks).toBe(synthetic.length);
    const ttsEvents = runtime.trace.events().filter((event) => event.event === "output.tts");
    expect(ttsEvents).toHaveLength(1);
    expect(ttsEvents[0]?.meta.bytes).toBe(expectedBytes);
    expect(ttsEvents[0]?.meta.chunks).toBe(synthetic.length);
    expect(runtime.trace.events().some((event) => event.event === "output.tts.drain.error")).toBe(false);
  });

  test("VIBERSYN_TTS_PROVIDER unset keeps the NoopTTSProvider (silent, records text only) (integration)", async () => {
    const { runtime, drive } = await makeRuntime();
    await drive([final(BUILDABLE, "utt-build")]);

    expect(runtime.tts).toBeInstanceOf(NoopTTSProvider);
    expect((runtime.tts as NoopTTSProvider).calls.length).toBeGreaterThanOrEqual(1);
    const ttsEvents = runtime.trace.events().filter((event) => event.event === "output.tts");
    expect(ttsEvents.length).toBeGreaterThanOrEqual(1);
    expect(ttsEvents[0]?.meta.bytes).toBe(0);
    expect(ttsEvents[0]?.meta.chunks).toBe(0);
  });
});

// The real device sink path (selectAudioSink) and the startup degradation notice.
describe("LiveProjectorRuntime — real device audio sink via VIBERSYN_AUDIO_SINK (env-selected)", () => {
  let priorCapacityGuard: string | undefined;
  beforeEach(() => {
    priorCapacityGuard = process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
    process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = "1";
  });
  afterEach(() => {
    restoreEnv("VIBERSYN_RBG_DISABLE_CAPACITY_CHECK", priorCapacityGuard);
  });

  test("VIBERSYN_AUDIO_SINK=device selects the real device sink and the loop drives audible output through it (integration)", async () => {
    const { runtime, drive } = await makeRuntime({ env: { VIBERSYN_AUDIO_SINK: "device" } });
    expect(runtime.degradation.degraded.map((leg) => leg.leg)).not.toContain("sink");

    await drive([final(BUILDABLE, "utt-build")]);
    await drive([final("yes", "utt-yes")]);

    expect(runtime.snapshot().audio.earcon).toBe("E3");
    expect(runtime.snapshot().audio.lastSpoken).toContain("spawned");
  });

  test("VIBERSYN_AUDIO_SINK unset -> the no-op sink leg is reported degraded", async () => {
    const { runtime } = await makeRuntime();
    expect(runtime.degradation.degraded.map((leg) => leg.leg)).toContain("sink");
  });

  test("an ELEVENLABS_API_KEY auto-selects real TTS so the tts leg is not degraded", async () => {
    const { runtime } = await makeRuntime({
      env: { ELEVENLABS_API_KEY: fakeElevenLabsKey() },
      options: { ttsTransport: async () => streamOf([Uint8Array.from([1, 2, 3])]) },
    });
    expect(runtime.tts).toBeInstanceOf(ElevenLabsFlashTTSProvider);
    expect(runtime.degradation.degraded.map((leg) => leg.leg)).not.toContain("tts");
  });

  test("no TTS credential -> Noop, and the tts leg is reported degraded", async () => {
    const { runtime } = await makeRuntime();
    expect(runtime.tts).toBeInstanceOf(NoopTTSProvider);
    expect(runtime.degradation.degraded.map((leg) => leg.leg)).toContain("tts");
  });
});

// An injected audio sink backs BOTH the earcon playPcm path and the TTS drain sink.
describe("LiveProjectorRuntime — injected audio sink receives earcon + tts bytes", () => {
  let priorCapacityGuard: string | undefined;
  beforeEach(() => {
    priorCapacityGuard = process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
    process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = "1";
  });
  afterEach(() => {
    restoreEnv("VIBERSYN_RBG_DISABLE_CAPACITY_CHECK", priorCapacityGuard);
  });

  test("playPcm and drainTtsStream both write non-empty chunks to the injected sink during one accept turn (integration)", async () => {
    const synthetic = [Uint8Array.from([0x49, 0x44, 0x33]), Uint8Array.from([0x10, 0x20, 0x30, 0x40]), Uint8Array.from([0xaa, 0xbb])];
    const sink = new RecordingAudioSink();
    const { runtime, drive } = await makeRuntime({
      env: { VIBERSYN_TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: fakeElevenLabsKey() },
      options: { ttsTransport: async () => streamOf(synthetic), audioSink: sink },
    });

    await drive([final(BUILDABLE, "utt-build")]);
    await drive([final("yes", "utt-yes")]);

    const earconBytes = PRERENDERED_EARCONS.E3.pcm.byteLength;
    const earconChunks = sink.chunks.filter((chunk) => chunk.byteLength === earconBytes);
    const ttsBytes = sink.bytes - earconChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    expect(earconBytes).toBeGreaterThan(0);
    expect(earconChunks.length).toBeGreaterThanOrEqual(1);
    expect(ttsBytes).toBeGreaterThan(0);
    expect(sink.bytes).toBe(earconChunks.length * earconBytes + ttsBytes);
  });

  test("VIBERSYN_AUDIO_SINK unset keeps the silent no-op sink (audible path still runs) (integration)", async () => {
    const { runtime, drive } = await makeRuntime();
    await drive([final(BUILDABLE, "utt-build")]);
    await drive([final("yes", "utt-yes")]);
    expect(runtime.snapshot().audio.earcon).toBe("E3");
    expect(runtime.snapshot().audio.lastSpoken).toContain("spawned");
  });

  test("an injected sink whose write throws is best-effort and does not abort the stage transition (integration)", async () => {
    const throwing: AudioSink = {
      write() {
        throw new Error("device sink write failure");
      },
    };
    const { runtime, drive } = await makeRuntime({
      env: { VIBERSYN_TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: fakeElevenLabsKey() },
      options: { ttsTransport: async () => streamOf([Uint8Array.from([1, 2, 3])]), audioSink: throwing },
    });
    const before = runtime.registry.activeRecords().length;

    await drive([final(BUILDABLE, "utt-build")]);
    await drive([final("yes", "utt-yes")]);

    expect(runtime.registry.activeRecords().length).toBe(before + 1);
    expect(runtime.snapshot().audio.earcon).toBe("E3");
    expect(runtime.snapshot().audio.lastSpoken).toContain("spawned");
  });
});

// IDEA CAPTURE mode: the explicit alternative to passive auto-detect. Toggling it
// on flags the runtime + snapshot, and makes detection run EAGERLY (bypassing the
// word/turn schedule) so a deliberately-captured idea surfaces on the next final.
describe("LiveProjectorRuntime — IDEA CAPTURE mode", () => {
  test("toggles captureMode on the runtime and the snapshot", async () => {
    const { runtime } = await makeRuntime();
    expect(runtime.captureMode()).toBe(false);
    expect(runtime.snapshot().captureMode).toBe(false);

    runtime.setCaptureMode(true);
    expect(runtime.captureMode()).toBe(true);
    expect(runtime.snapshot().captureMode).toBe(true);
    expect(runtime.trace.events().map((e) => e.event)).toContain("capture.mode.set");

    runtime.setCaptureMode(false);
    expect(runtime.captureMode()).toBe(false);
    expect(runtime.snapshot().captureMode).toBe(false);
  });

  test("capture mode forces a detection round on a single final the schedule would skip", async () => {
    const recorder = new RecordingDetector();
    // minNewTurns=5 → the passive schedule would NOT detect after one final.
    const { runtime, drive } = await makeRuntime({ ideaDetector: recorder, env: { VIBERSYN_DETECT_MIN_NEW_TURNS: "5" } });

    // Baseline: without capture mode, one final does not trigger detection.
    await drive([final(AMBIENT, "utt-0")]);
    expect(recorder.inputs).toHaveLength(0);

    // With capture mode on, the same single final forces a detection round.
    runtime.setCaptureMode(true);
    await drive([final(BUILDABLE, "utt-1")]);
    expect(recorder.inputs.length).toBeGreaterThanOrEqual(1);
  });

  test("emergency stop clears capture mode", async () => {
    const { runtime } = await makeRuntime();
    runtime.setCaptureMode(true);
    expect(runtime.captureMode()).toBe(true);
    await runtime.emergencyStop("corr-e");
    expect(runtime.captureMode()).toBe(false);
    expect(runtime.snapshot().captureMode).toBe(false);

    // ...and cannot be re-enabled after the sticky emergency stop.
    runtime.setCaptureMode(true);
    expect(runtime.captureMode()).toBe(false);
    expect(runtime.snapshot().captureMode).toBe(false);
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

// A detector that records every DetectionInput and returns a fixed (default empty)
// result — used to assert WHAT reaches detection without surfacing a bubble.
class RecordingDetector implements IdeaDetector {
  readonly inputs: DetectionInput[] = [];
  constructor(private readonly result: DetectionResult = { candidates: [] }) {}
  async detect(input: DetectionInput): Promise<DetectionResult> {
    this.inputs.push(input);
    return this.result;
  }
}

interface MakeRuntimeArgs {
  env?: Record<string, string>;
  options?: Parameters<typeof createProjectorRuntime>[1];
  ideaDetector?: IdeaDetector;
}

// Build a live runtime over a writable replay file, plus a `drive()` that feeds a
// batch of observations through one mic session and flushes detection so the round
// (and its bubble delivery) has completed by the time it resolves.
async function makeRuntime(args: MakeRuntimeArgs = {}): Promise<{ runtime: ProjectorRuntime; path: string; drive: (obs: TranscriptObservation[]) => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-mic-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, "", "utf8");
  const runtime = await createProjectorRuntime(baseEnv(path, args.env), {
    ...args.options,
    ideaDetector: args.ideaDetector ?? args.options?.ideaDetector,
  });
  const drive = async (obs: TranscriptObservation[]): Promise<void> => {
    writeFileSync(path, obs.map((o) => JSON.stringify(o)).join("\n"), "utf8");
    const session = runtime.startMicSession("corr-test-mic");
    await session.stop();
    await runtime.detection.flush();
  };
  return { runtime, path, drive };
}

function fakeElevenLabsKey(): string {
  return ["xi", `${"a".repeat(18)}1${"b".repeat(18)}`].join("-");
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
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
    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_MIC_REPLAY_PATH: replayPath,
    // Deterministic detection: the heuristic detector (no model spawn), eager
    // scheduling (detect on the first new turn, no throttle), and no background tick.
    VIBERSYN_IDEA_DETECTOR: "heuristic",
    VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
    VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
    VIBERSYN_DETECT_TICK_MS: "0",
    ...overrides,
  };
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
