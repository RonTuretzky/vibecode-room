// ISSUE-0022 e2e: a fired spoken suggestion produces a fully-drained audio
// stream. The runtime selects the ElevenLabs streaming TTS provider
// (PANOP_TTS_PROVIDER=elevenlabs) but is handed a stubbed transport, so no
// network or audio device is touched — any real fetch fails the test. A
// buildable utterance fires a suggestion, emitOutput synthesizes through the
// stub, and the sink drains the whole stream end-to-end; the trace records the
// byte/chunk totals on the output.tts event.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime } from "../../src/server/composition";
import type { TTSTransport } from "../../src/providers";
import type { TranscriptObservation } from "../../src/types";

describe("spoken suggestion produces a drained audio stream (e2e)", () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  const tempDirs: string[] = [];
  let priorAsrProvider: string | undefined;
  let priorDeepgramKey: string | undefined;
  let priorTtsProvider: string | undefined;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch in the offline tts-drain loop: ${String(args[0])}`);
    }) as unknown as typeof fetch;
    priorAsrProvider = process.env.PANOP_ASR_PROVIDER;
    priorDeepgramKey = process.env.DEEPGRAM_API_KEY;
    priorTtsProvider = process.env.PANOP_TTS_PROVIDER;
    delete process.env.PANOP_ASR_PROVIDER;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.PANOP_TTS_PROVIDER;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreEnv("PANOP_ASR_PROVIDER", priorAsrProvider);
    restoreEnv("DEEPGRAM_API_KEY", priorDeepgramKey);
    restoreEnv("PANOP_TTS_PROVIDER", priorTtsProvider);
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("elevenlabs-selected fired suggestion reads the whole synthesized stream", async () => {
    const path = writeReplayFixture(tempDirs, [
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
    ]);

    // A multi-chunk synthetic MP3-ish payload, produced lazily so the chunk
    // counter only advances when the sink pulls — proving an end-to-end drain.
    const synthetic = [
      Uint8Array.from([0x49, 0x44, 0x33, 0x04]),
      Uint8Array.from([0x00, 0x11, 0x22]),
      Uint8Array.from([0x33, 0x44, 0x55, 0x66, 0x77]),
    ];
    const expectedBytes = synthetic.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    let pulledChunks = 0;
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
            pulledChunks += 1;
          },
        },
        { highWaterMark: 0 },
      );
    };

    const runtime = await createProjectorRuntime(
      {
        PANOP_INITIAL_MUTED: "0",
        PANOP_MIC_REPLAY_PATH: path,
        PANOP_TTS_PROVIDER: "elevenlabs",
        ELEVENLABS_API_KEY: fakeElevenLabsKey(),
        PANOP_SUGGEST_WORD_FLOOR: "3",
        PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
        PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
        PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
      },
      { ttsTransport: transport },
    );

    const session = runtime.startMicSession("corr-tts-drain");
    await session.stop();

    // End to end: a suggestion fired and was spoken through the elevenlabs stub.
    expect(runtime.lastSuggestionDecision?.kind).toBe("fired");
    expect(speakCalls).toBe(1);
    // The whole stream was read — every lazily-produced chunk was pulled.
    expect(pulledChunks).toBe(synthetic.length);

    // The trace records the drained byte/chunk totals on the output.tts outcome.
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
  const dir = mkdtempSync(join(tmpdir(), "panop-tts-drain-"));
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
