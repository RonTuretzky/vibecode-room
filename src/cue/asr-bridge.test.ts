import { describe, expect, test } from "bun:test";
import type { ASRProvider, AudioReadableStream } from "../providers";
import type { TranscriptObservation } from "../types";
import {
  AudioCaptureAsrBridge,
  EnergyVadReplayASRProvider,
  LIVE_CAPTURE_SKIPPED_MARKER,
  ReplayPcmAudioCapture,
  assertTranscriptOnlyCueEvent,
  createGatedAudioCaptureAsrBridge,
  detectEnergyTurns,
  readPcmFrameJsonl,
  transcriptObservationToCueEvent,
  type AudioCapture,
  type CueTranscriptEvent,
  type CueTranscriptionIngress,
  type MuteGate,
} from "./asr-bridge";

const TRANSCRIPT_FIXTURE = "fixtures/asr/nova3-observations.jsonl";
const PCM_FIXTURE = "fixtures/asr/pcm-frames.jsonl";

describe("ENG-T-10 audio capture ASR bridge", () => {
  test("no-key record-replay path drives PCM through VAD fallback, normalizes events, and pushes Cue ingress", async () => {
    const ingress = new RecordingIngress();
    const selected = await createGatedAudioCaptureAsrBridge({
      sessionId: "bridge-session",
      env: {},
      replayTranscriptPath: TRANSCRIPT_FIXTURE,
      replayPcmFramesPath: PCM_FIXTURE,
      ingress,
      clock: sequenceClock(1_000),
      idFactory: sequenceIds(),
    });

    const result = await selected.bridge.run();

    expect(selected.mode).toBe("record-replay");
    expect(result.marker).toBe(LIVE_CAPTURE_SKIPPED_MARKER);
    expect(result.framesRead).toBe(4);
    expect(result.framesForwarded).toBe(4);
    expect(result.bytesRead).toBeGreaterThan(0);
    expect(result.observations).toBe(4);
    expect(result.ingressEvents).toBe(4);
    expect(result.correlationIds).toEqual([
      "corr-asr-bridge-001",
      "corr-asr-bridge-002",
      "corr-asr-bridge-003",
      "corr-asr-bridge-004",
    ]);

    expect(ingress.events[0]).toEqual({
      type: "qwen_asr.transcript",
      transcript: "Panop",
      text: "Panop",
      isFinal: false,
      speaker: null,
      rawInferenceMs: 100,
      sentAtMs: 1_000,
      sessionId: "probe-asr-deepgram-fixture",
      utteranceId: "vad-1-2-0",
      correlationId: "corr-asr-bridge-001",
    } satisfies CueTranscriptEvent);
    expect(ingress.events.every((event) => event.speaker === null)).toBe(true);
    expect(ingress.events.map((event) => event.transcript)).toEqual([
      "Panop",
      "Panop status.",
      "I can take notes.",
      "Let's ship it.",
    ]);
    expect(JSON.stringify(ingress.events)).not.toContain("UPuwBFD7");
    for (const event of ingress.events) {
      expect(() => assertTranscriptOnlyCueEvent(event)).not.toThrow();
    }

    const asr = selected.asr as EnergyVadReplayASRProvider;
    expect(asr.lastTurns).toEqual([
      expect.objectContaining({ startFrame: 1, endFrame: 2, speaker: null }),
    ]);
  });

  test("muted start suppresses capture, ASR, and Cue ingress", async () => {
    const capture: AudioCapture = {
      open() {
        throw new Error("capture should not open while muted");
      },
    };
    const asr: ASRProvider = {
      async *stream() {
        throw new Error("ASR should not start while muted");
      },
    };
    const ingress = new RecordingIngress();
    const bridge = new AudioCaptureAsrBridge({
      sessionId: "muted-session",
      capture,
      asr,
      ingress,
      mute: { isMuted: () => true },
      idFactory: sequenceIds(),
    });

    const result = await bridge.run();

    expect(result).toMatchObject({
      mode: "muted-skip",
      marker: "capture skipped - muted",
      framesRead: 0,
      observations: 0,
      ingressEvents: 0,
    });
    expect(ingress.events).toEqual([]);
  });

  test("dynamic mute drops PCM frames before ASR and suppresses muted observations", async () => {
    const frames = await readPcmFrameJsonl(PCM_FIXTURE);
    const forwarded: Uint8Array[] = [];
    let isMutedCalls = 0;
    const isMuted = () => {
      isMutedCalls += 1;
      return isMutedCalls >= 3;
    };
    const mute: MuteGate = {
      isMuted,
      acceptPipelineObservation(observation) {
        return isMuted() ? null : observation;
      },
    };
    const capture: AudioCapture = {
      open() {
        let index = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            const frame = frames[index++];
            if (frame === undefined) {
              controller.close();
              return;
            }
            controller.enqueue(frame.data);
          },
        });
      },
    };
    const asr: ASRProvider = {
      async *stream(audio: AudioReadableStream): AsyncIterable<TranscriptObservation> {
        const reader = audio.getReader();
        try {
          while (true) {
            const read = await reader.read();
            if (read.done) break;
            forwarded.push(read.value);
          }
        } finally {
          reader.releaseLock();
        }
        yield observation("muted text");
      },
    };
    const ingress = new RecordingIngress();
    const bridge = new AudioCaptureAsrBridge({
      sessionId: "dynamic-mute",
      capture,
      asr,
      ingress,
      mute,
      idFactory: sequenceIds(),
    });

    const result = await bridge.run();

    expect(result.framesRead).toBe(4);
    expect(result.framesForwarded).toBe(1);
    expect(forwarded).toHaveLength(1);
    expect(result.observations).toBe(0);
    expect(ingress.events).toEqual([]);
  });

  test("transcript-only persistence guard rejects raw audio fields and binary values", () => {
    const event = transcriptObservationToCueEvent(observation("Panop status"), {
      correlationId: "corr-asr-bridge-test",
      sentAtMs: 10,
    });
    expect(() => assertTranscriptOnlyCueEvent(event)).not.toThrow();
    expect(() => assertTranscriptOnlyCueEvent({ ...event, pcm: "AAAA" })).toThrow(/raw-audio field pcm/u);
    expect(() => assertTranscriptOnlyCueEvent({ ...event, payload: { frameBytes: new Uint8Array([1, 2]) } })).toThrow(
      /raw-audio field payload.frameBytes/u,
    );
  });

  test("energy VAD detects speech turns without speaker labels", async () => {
    const frames = await readPcmFrameJsonl(PCM_FIXTURE);
    const turns = detectEnergyTurns(frames.map((frame) => frame.data));
    expect(turns).toEqual([expect.objectContaining({ startFrame: 1, endFrame: 2, speaker: null })]);
  });
});

class RecordingIngress implements CueTranscriptionIngress {
  readonly events: CueTranscriptEvent[] = [];

  async send(event: CueTranscriptEvent) {
    this.events.push(event);
    return { event, response: { type: event.type, transcript: event.transcript } };
  }
}

function observation(text: string): TranscriptObservation {
  return {
    text,
    isFinal: true,
    speaker: "speaker_0",
    sessionId: "bridge-session",
    latencyMs: 12,
    utteranceId: "utt-bridge",
  };
}

function sequenceIds(): () => string {
  let next = 0;
  return () => String(++next).padStart(3, "0");
}

function sequenceClock(start: number): () => number {
  let now = start - 1;
  return () => {
    now += 1;
    return now;
  };
}
