import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import {
  arraySegmentSource,
  VoxTermASRProvider,
  type VoxTermSegment,
} from "../../src/providers/asr/voxterm";
import { transcriptObservationSchema, type TranscriptObservation } from "../../src/types";
import type { ASRProvider } from "../../src/providers/types";

const fixturePath = "fixtures/voxterm/session.jsonl";

async function loadSegments(path: string): Promise<VoxTermSegment[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as VoxTermSegment);
}

function emptyAudioStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

// A boundary-style consumer that knows only the ASRProvider seam — it reads the
// stream and keeps the latest text per utterance, committing on the final frame.
class TranscriptConsumer {
  readonly finals: { utteranceId: string; text: string; speaker: string | null }[] = [];
  readonly observations: TranscriptObservation[] = [];

  constructor(private readonly asr: ASRProvider) {}

  async run(audio: ReadableStream<Uint8Array>): Promise<void> {
    for await (const observation of this.asr.stream(audio)) {
      // The provider promises schema-valid observations; assert at the boundary.
      expect(transcriptObservationSchema.parse(observation)).toEqual(observation);
      this.observations.push(observation);
      if (observation.isFinal) {
        this.finals.push({
          utteranceId: observation.utteranceId,
          text: observation.text,
          speaker: observation.speaker,
        });
      }
    }
  }
}

describe("VoxTerm ASR provider drives a consumer end to end", () => {
  test("a boundary consumer over a fixture feed produces the expected final transcripts with zero fetch calls", async () => {
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      throw new Error("network is forbidden in the VoxTerm e2e");
    }) as unknown as typeof fetch;

    try {
      const segments = await loadSegments(fixturePath);
      const provider = new VoxTermASRProvider({
        sessionId: "vox-e2e-session",
        source: arraySegmentSource(segments),
        clock: () => 5_000,
      });
      const consumer = new TranscriptConsumer(provider);

      await consumer.run(emptyAudioStream());

      // Every observation belongs to the e2e session and is ordered by the feed.
      expect(consumer.observations.every((o) => o.sessionId === "vox-e2e-session")).toBe(true);
      expect(consumer.observations.map((o) => o.utteranceId)).toEqual([
        "vox-1",
        "vox-1",
        "vox-1",
        "vox-2",
        "vox-2",
      ]);

      // Only committed segments surface as final transcripts.
      expect(consumer.finals).toEqual([
        { utteranceId: "vox-1", text: "hey panop spin up a runner", speaker: "speaker_0" },
        { utteranceId: "vox-2", text: "and check the build status", speaker: "speaker_1" },
      ]);

      expect(fetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
