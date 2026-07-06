// ISSUE-0026 e2e: a fired spoken suggestion is audible on a real sink. The runtime
// selects the ElevenLabs streaming TTS provider but is handed a stubbed transport
// AND an injected RecordingAudioSink, so no network or audio device is touched —
// any real fetch fails the test. A buildable utterance fires a suggestion,
// emitOutput synthesizes through the stub, and the drained PCM is RETAINED by the
// injected recording sink end to end (asserted byte/chunk count). This closes the
// no-op output gap: the synthesized audio actually lands somewhere observable.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime } from "../../src/server/composition";
import { RecordingAudioSink } from "../../src/server/audio-device-sink";
import type { TTSTransport } from "../../src/providers";
import type { TranscriptObservation } from "../../src/types";

describe("fired suggestion is audible on a real sink (e2e)", () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  const tempDirs: string[] = [];
  let priorAsrProvider: string | undefined;
  let priorDeepgramKey: string | undefined;
  let priorTtsProvider: string | undefined;
  let priorAudioSink: string | undefined;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch in the offline audible-output loop: ${String(args[0])}`);
    }) as unknown as typeof fetch;
    priorAsrProvider = process.env.VIBERSYN_ASR_PROVIDER;
    priorDeepgramKey = process.env.DEEPGRAM_API_KEY;
    priorTtsProvider = process.env.VIBERSYN_TTS_PROVIDER;
    priorAudioSink = process.env.VIBERSYN_AUDIO_SINK;
    delete process.env.VIBERSYN_ASR_PROVIDER;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.VIBERSYN_TTS_PROVIDER;
    delete process.env.VIBERSYN_AUDIO_SINK;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreEnv("VIBERSYN_ASR_PROVIDER", priorAsrProvider);
    restoreEnv("DEEPGRAM_API_KEY", priorDeepgramKey);
    restoreEnv("VIBERSYN_TTS_PROVIDER", priorTtsProvider);
    restoreEnv("VIBERSYN_AUDIO_SINK", priorAudioSink);
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("a fired suggestion drives non-empty synthesized PCM into an injected recording sink", async () => {
    const path = writeReplayFixture(tempDirs, [
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
    ]);

    // A multi-chunk synthetic MP3-ish payload, produced lazily so the chunk counter
    // only advances when the drain pulls — proving an end-to-end read into the sink.
    const synthetic = [
      Uint8Array.from([0x49, 0x44, 0x33, 0x04]),
      Uint8Array.from([0x00, 0x11, 0x22]),
      Uint8Array.from([0x33, 0x44, 0x55, 0x66, 0x77]),
    ];
    const expectedBytes = synthetic.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    let speakCalls = 0;
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
          },
        },
        { highWaterMark: 0 },
      );
    };

    const sink = new RecordingAudioSink();
    const runtime = await createProjectorRuntime(
      {
        VIBERSYN_INITIAL_MUTED: "0",
        VIBERSYN_MIC_REPLAY_PATH: path,
        VIBERSYN_TTS_PROVIDER: "elevenlabs",
        ELEVENLABS_API_KEY: fakeElevenLabsKey(),
        // Deterministic idea detection: heuristic detector, eager scheduling, no tick.
        VIBERSYN_IDEA_DETECTOR: "heuristic",
        VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
        VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
        VIBERSYN_DETECT_TICK_MS: "0",
      },
      { ttsTransport: transport, audioSink: sink },
    );

    const session = runtime.startMicSession("corr-audible-output");
    await session.stop();
    await runtime.detection.flush();

    // End to end: an idea was detected and spoken through the elevenlabs stub.
    expect(runtime.detection.primary()).not.toBeNull();
    expect(speakCalls).toBe(1);

    // The whole synthesized stream was retained by the injected recording sink —
    // not read-and-dropped. Every chunk of non-empty PCM is observable on the sink.
    expect(sink.chunkCount).toBe(synthetic.length);
    expect(sink.bytes).toBe(expectedBytes);
    expect(sink.bytes).toBeGreaterThan(0);

    // The trace records the same drained totals on the output.tts outcome.
    const ttsEvents = runtime.trace.events().filter((event) => event.event === "output.tts");
    expect(ttsEvents).toHaveLength(1);
    expect(ttsEvents[0]?.meta.bytes).toBe(expectedBytes);
    expect(ttsEvents[0]?.meta.chunks).toBe(synthetic.length);

    // Fully offline: the stub transport carried synthesis, so no real fetch ran.
    expect(fetchCalls).toBe(0);
  });
});

function restoreEnv(key: string, prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = prior;
  }
}

function writeReplayFixture(tempDirs: string[], observations: TranscriptObservation[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-audible-output-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, observations.map((observation) => JSON.stringify(observation)).join("\n"), "utf8");
  return path;
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "test-session", latencyMs: 20, utteranceId };
}

// Built at runtime (never a literal) so the source tree stays free of key-shaped
// strings, matching the audio credential seam's accepted token shape.
function fakeElevenLabsKey(): string {
  return ["xi", `${"a".repeat(18)}1${"b".repeat(18)}`].join("-");
}
