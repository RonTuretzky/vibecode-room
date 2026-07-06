// ISSUE-0024 e2e: a suggestion deferred at fire time because the room is mid-
// utterance (high interrupt cost) is later SPOKEN once the room falls quiet.
//
// The runtime selects the ElevenLabs streaming TTS provider but is handed a
// stubbed transport, so no network or audio device is touched. A buildable
// utterance arrives while interrupt cost is high (recency weight pinned to 1),
// so the SuggestionEngine QUEUES rather than fires — no audio yet. Then the
// injected clock advances past VIBERSYN_SUGGEST_IDLE_GAP_SECONDS with no further
// utterance and the idle-cue driver ticks: the queued suggestion fires and is
// drained through the stubbed TTS end-to-end.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime } from "../../src/server/composition";
import type { TTSTransport } from "../../src/providers";
import type { TranscriptObservation } from "../../src/types";

describe("deferred suggestion is spoken on room silence (e2e)", () => {
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
      throw new Error(`unexpected network fetch in the offline idle-cue loop: ${String(args[0])}`);
    }) as unknown as typeof fetch;
    priorAsrProvider = process.env.VIBERSYN_ASR_PROVIDER;
    priorDeepgramKey = process.env.DEEPGRAM_API_KEY;
    priorTtsProvider = process.env.VIBERSYN_TTS_PROVIDER;
    delete process.env.VIBERSYN_ASR_PROVIDER;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.VIBERSYN_TTS_PROVIDER;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreEnv("VIBERSYN_ASR_PROVIDER", priorAsrProvider);
    restoreEnv("DEEPGRAM_API_KEY", priorDeepgramKey);
    restoreEnv("VIBERSYN_TTS_PROVIDER", priorTtsProvider);
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // SuggestionEngine deferred-on-silence delivery was replaced by idea detection; re-evaluate.
  test.skip("a queued idea fires and drains through TTS once the idle gap elapses", async () => {
    const path = writeReplayFixture(tempDirs, [
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
    ]);

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

    // Frozen, manually-advanced clock so the room silence is deterministic.
    let nowMs = 1_000_000;
    const clock = () => nowMs;

    const runtime = await createProjectorRuntime(
      {
        VIBERSYN_INITIAL_MUTED: "0",
        VIBERSYN_MIC_REPLAY_PATH: path,
        VIBERSYN_TTS_PROVIDER: "elevenlabs",
        ELEVENLABS_API_KEY: fakeElevenLabsKey(),
        VIBERSYN_SUGGEST_WORD_FLOOR: "3",
        VIBERSYN_SUGGEST_IDLE_GAP_SECONDS: "10",
        // Pin interrupt cost above the low threshold so the buildable utterance
        // QUEUES at observe time instead of firing immediately.
        VIBERSYN_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "1",
        VIBERSYN_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
        VIBERSYN_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
      },
      { ttsTransport: transport, clock },
    );

    // Drive the buildable utterance through the live mic loop.
    const session = runtime.startMicSession("corr-idle-e2e");
    await session.stop();

    // It deferred (queued), so nothing has been spoken yet.
    expect(runtime.lastSuggestionDecision?.kind).toBe("queued");
    expect(runtime.pendingSuggestion()).not.toBeNull();
    expect(speakCalls).toBe(0);

    // A tick before the gap elapses must not deliver.
    nowMs += 9_000;
    expect(await runtime.idleCueDriver.tick()).toBeNull();
    expect(speakCalls).toBe(0);

    // The idle gap elapses with no further utterance — deliver + speak.
    nowMs += 1_000;
    const fired = await runtime.idleCueDriver.tick();

    expect(fired?.kind).toBe("fired");
    expect(runtime.lastSuggestionDecision?.kind).toBe("fired");
    expect(runtime.pendingSuggestion()).toBeNull();

    // The deferred idea was spoken: the whole synthesized stream was drained.
    expect(speakCalls).toBe(1);
    expect(pulledChunks).toBe(synthetic.length);

    const ttsEvents = runtime.trace.events().filter((event) => event.event === "output.tts");
    expect(ttsEvents).toHaveLength(1);
    expect(ttsEvents[0]?.meta.bytes).toBe(expectedBytes);
    expect(ttsEvents[0]?.meta.chunks).toBe(synthetic.length);

    // The published snapshot reflects the spoken delivery.
    expect(runtime.snapshot().suggestion.state).toBe("speaking");

    // Fully offline: synthesis ran through the stub transport, no real fetch.
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
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-idle-cue-"));
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
