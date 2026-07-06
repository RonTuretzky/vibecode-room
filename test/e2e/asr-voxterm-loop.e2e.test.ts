// ISSUE-0016 e2e: with VIBERSYN_ASR_PROVIDER=voxterm, the live runtime selects the
// VoxTerm backend through the providers ASR registry, and a fed segment drives a
// transcript observation that is reflected on the published projector snapshot.
//
// Fully offline: the voxterm transport is an injected in-memory segment source
// (no mic, child process, or socket) and the decider/TTS default to the offline
// heuristic/Noop providers. Any network fetch fails the test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createProjectorRuntime, type ProjectorRuntime } from "../../src/server/composition";
import { arraySegmentSource, type VoxTermSegment } from "../../src/providers";

describe("voxterm-selected live runtime drives a transcript to the snapshot (e2e)", () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  let priorAsrProvider: string | undefined;
  let priorDeepgramKey: string | undefined;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch in the offline voxterm loop: ${String(args[0])}`);
    }) as unknown as typeof fetch;
    // The registry resolves the backend off VIBERSYN_ASR_PROVIDER / DEEPGRAM_API_KEY
    // read from the runtime env, but isolate the test from any ambient settings.
    priorAsrProvider = process.env.VIBERSYN_ASR_PROVIDER;
    priorDeepgramKey = process.env.DEEPGRAM_API_KEY;
    delete process.env.VIBERSYN_ASR_PROVIDER;
    delete process.env.DEEPGRAM_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreEnv("VIBERSYN_ASR_PROVIDER", priorAsrProvider);
    restoreEnv("DEEPGRAM_API_KEY", priorDeepgramKey);
  });

  test("VIBERSYN_ASR_PROVIDER=voxterm: a fed segment becomes a transcript observation on the snapshot", async () => {
    // A two-frame utterance: an interim revision then the committed final. Only the
    // committed text is a transcript observation that should surface on the snapshot.
    const segments: VoxTermSegment[] = [
      { utteranceId: 7, text: "let's build", final: false, speaker: 0, emittedAtMs: 1000 },
      { utteranceId: 7, text: "let's build a dashboard tool today", final: true, speaker: 0, emittedAtMs: 1400 },
    ];
    const runtime = await createProjectorRuntime(
      voxtermEnv(),
      { voxtermSource: arraySegmentSource(segments) },
    );

    // The registry selected the voxterm backend for both the ambient + mic paths.
    expect(runtime.asrMode).toBe("voxterm");
    expect(runtime.micMode).toBe("voxterm");
    expect(runtime.snapshot().mic?.mode).toBe("voxterm");

    const session = runtime.startMicSession("corr-voxterm-loop");
    // stop() awaits the background drain loop, so every fed segment has been folded
    // into the transcript by the time it resolves.
    await session.stop();
    await runtime.detection.flush();

    // The committed final reached the runtime's transcript handling and is on the
    // published snapshot; the interim revision was cleared (not committed).
    const transcript = runtime.snapshot().transcript;
    expect(transcript.some((line) => line.text === "let's build a dashboard tool today")).toBe(true);
    expect(transcript.some((line) => line.text === "let's build")).toBe(false);

    // The committed (buildable) utterance reached idea DETECTION and surfaced a
    // grounded candidate, and the mic counted as active during stream.
    expect(runtime.detection.primary()).not.toBeNull();
    expect(runtime.snapshot().mic?.active).toBe(false);

    // The whole loop ran offline: no network fetch.
    expect(fetchCalls).toBe(0);
  });
});

function voxtermEnv(): Record<string, string> {
  return {
    // Start unmuted so the (mute-protected) voxterm mic actually streams.
    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_ASR_PROVIDER: "voxterm",
    // Deterministic idea detection: heuristic detector, eager scheduling, no tick.
    VIBERSYN_IDEA_DETECTOR: "heuristic",
    VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
    VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
    VIBERSYN_DETECT_TICK_MS: "0",
  };
}

function restoreEnv(key: string, prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = prior;
  }
}
