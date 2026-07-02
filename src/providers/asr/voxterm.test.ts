import { describe, expect, test } from "bun:test";
import { transcriptObservationSchema, type TranscriptObservation } from "../../types";
import {
  arraySegmentSource,
  normalizeVoxTermSegment,
  VoxTermASRProvider,
  type VoxTermSegment,
  type VoxTermSegmentSource,
} from "./voxterm";

function emptyAudioStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

async function collect(provider: VoxTermASRProvider): Promise<TranscriptObservation[]> {
  const observations: TranscriptObservation[] = [];
  for await (const observation of provider.stream(emptyAudioStream())) {
    observations.push(observation);
  }
  return observations;
}

describe("VoxTermASRProvider — segment mapping (unit)", () => {
  test("maps synthetic interim + final segments to schema-valid observations", async () => {
    const segments: VoxTermSegment[] = [
      { utteranceId: 7, text: "hey", final: false, speaker: 0, startedAtMs: 1_000, emittedAtMs: 1_050 },
      { utteranceId: 7, text: "hey viber", final: false, speaker: 0, emittedAtMs: 1_120 },
      { utteranceId: 7, text: "hey viber build it", final: true, speaker: "speaker_1", emittedAtMs: 1_400 },
    ];
    const provider = new VoxTermASRProvider({
      sessionId: "vox-session",
      source: arraySegmentSource(segments),
      clock: () => 1_500,
    });

    const observations = await collect(provider);

    for (const observation of observations) {
      expect(transcriptObservationSchema.parse(observation)).toEqual(observation);
    }

    expect(observations.map((o) => o.isFinal)).toEqual([false, false, true]);
    expect(observations.map((o) => o.text)).toEqual(["hey", "hey viber", "hey viber build it"]);
    // utteranceId is stable across interims + the final commit of one utterance.
    expect(new Set(observations.map((o) => o.utteranceId))).toEqual(new Set(["vox-7"]));
    expect(observations[0].speaker).toBe("speaker_0");
    expect(observations[2].speaker).toBe("speaker_1");
    expect(observations.every((o) => o.latencyMs >= 0)).toBe(true);
    expect(observations[0].latencyMs).toBe(450); // 1500 - 1050
  });

  test("normalizes speaker variants and falls back to null", () => {
    const base = { utteranceId: "u", text: "x", final: true } satisfies VoxTermSegment;
    const opts = { sessionId: "s", receivedAtMs: 0, utteranceIdPrefix: "vox" };

    expect(normalizeVoxTermSegment({ ...base, speaker: 3 }, opts).speaker).toBe("speaker_3");
    expect(normalizeVoxTermSegment({ ...base, speaker: "speaker-2" }, opts).speaker).toBe("speaker_2");
    expect(normalizeVoxTermSegment({ ...base, speaker: "Alice" }, opts).speaker).toBe("Alice");
    expect(normalizeVoxTermSegment({ ...base, speaker: "   " }, opts).speaker).toBeNull();
    expect(normalizeVoxTermSegment({ ...base, speaker: null }, opts).speaker).toBeNull();
    expect(normalizeVoxTermSegment(base, opts).speaker).toBeNull();
  });

  test("derives a non-empty utteranceId even from messy raw ids", () => {
    const observation = normalizeVoxTermSegment(
      { utteranceId: "Utt #42!!", text: "hi", final: true },
      { sessionId: "s", receivedAtMs: 0, utteranceIdPrefix: "vox" },
    );
    expect(observation.utteranceId.length).toBeGreaterThan(0);
    expect(observation.utteranceId).toBe("vox-utt-42");
  });

  test("clamps latency to a non-negative integer", () => {
    const observation = normalizeVoxTermSegment(
      { utteranceId: 1, text: "hi", final: false, emittedAtMs: 2_000 },
      { sessionId: "s", receivedAtMs: 1_000, utteranceIdPrefix: "vox" },
    );
    expect(observation.latencyMs).toBe(0);
  });

  test("rejects an empty sessionId at construction", () => {
    expect(
      () => new VoxTermASRProvider({ sessionId: "", source: arraySegmentSource([]) }),
    ).toThrow("non-empty sessionId");
  });
});

describe("VoxTermASRProvider — streaming order (integration)", () => {
  test("streams observations in segment order and terminates when the feed closes", async () => {
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      throw new Error("network is forbidden in VoxTerm unit tests");
    }) as unknown as typeof fetch;

    try {
      const segments: VoxTermSegment[] = [
        { utteranceId: 1, text: "one", final: true, emittedAtMs: 10 },
        { utteranceId: 2, text: "tw", final: false, emittedAtMs: 20 },
        { utteranceId: 2, text: "two", final: true, emittedAtMs: 30 },
        { utteranceId: 3, text: "three", final: true, emittedAtMs: 40 },
      ];
      const provider = new VoxTermASRProvider({
        sessionId: "vox-order",
        source: arraySegmentSource(segments),
        clock: () => 100,
      });

      const observations = await collect(provider);

      expect(observations.map((o) => o.text)).toEqual(["one", "tw", "two", "three"]);
      expect(observations.map((o) => o.utteranceId)).toEqual(["vox-1", "vox-2", "vox-2", "vox-3"]);
      expect(observations.map((o) => o.isFinal)).toEqual([true, false, true, true]);
      expect(fetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an async transport that defers between frames preserves order and back-pressure", async () => {
    const lazySource: VoxTermSegmentSource = {
      async *open() {
        for (let index = 0; index < 3; index += 1) {
          await Promise.resolve();
          yield { utteranceId: index, text: `seg-${index}`, final: index === 2, emittedAtMs: index } satisfies VoxTermSegment;
        }
      },
    };
    const provider = new VoxTermASRProvider({ sessionId: "vox-lazy", source: lazySource, clock: () => 0 });

    const observations = await collect(provider);

    expect(observations.map((o) => o.text)).toEqual(["seg-0", "seg-1", "seg-2"]);
    expect(observations.at(-1)?.isFinal).toBe(true);
  });

  test("an empty feed yields no observations and terminates", async () => {
    const provider = new VoxTermASRProvider({ sessionId: "vox-empty", source: arraySegmentSource([]) });
    expect(await collect(provider)).toEqual([]);
  });
});
