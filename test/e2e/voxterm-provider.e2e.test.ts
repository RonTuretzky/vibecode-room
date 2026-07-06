// ISSUE-0017 e2e: a sequence of interim + final VoxTerm segment frames for a
// single utterance, streamed through VoxTermASRProvider, yields exactly ONE
// committed observation downstream — proving the interim hypotheses collapse onto
// the final commit rather than leaking as separate committed transcripts.
//
// Fully offline: the segment source is an injected in-memory feed (no mic, child
// process, or socket) and any network fetch fails the test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  arraySegmentSource,
  VoxTermASRProvider,
  type VoxTermSegment,
} from "../../src/providers/asr/voxterm";
import { transcriptObservationSchema, type TranscriptObservation } from "../../src/types";
import type { ASRProvider } from "../../src/providers/types";

function emptyAudioStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

// A minimal downstream that knows only the ASRProvider seam. It mirrors how the
// live transcript store folds a stream: keep the latest hypothesis per utterance,
// and commit exactly once — when the final frame for that utterance arrives.
class CommitCollector {
  readonly committed: TranscriptObservation[] = [];
  readonly #latestByUtterance = new Map<string, TranscriptObservation>();

  constructor(private readonly asr: ASRProvider) {}

  async drain(audio: ReadableStream<Uint8Array>): Promise<void> {
    for await (const observation of this.asr.stream(audio)) {
      // The provider promises schema-valid observations; assert at the boundary.
      expect(transcriptObservationSchema.parse(observation)).toEqual(observation);
      this.#latestByUtterance.set(observation.utteranceId, observation);
      if (observation.isFinal) {
        this.committed.push(observation);
      }
    }
  }

  latest(utteranceId: string): TranscriptObservation | undefined {
    return this.#latestByUtterance.get(utteranceId);
  }
}

describe("VoxTerm provider streams a multi-segment utterance end-to-end (e2e)", () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetchCalls += 1;
      throw new Error(`network is forbidden in the VoxTerm provider e2e: ${String(input)}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("interim + final frames of one utterance collapse to exactly one committed observation", async () => {
    // Three interims revising the same hypothesis, then the committed final — all
    // sharing utteranceId 42 — followed by a separate single-shot utterance.
    const segments: VoxTermSegment[] = [
      { utteranceId: 42, text: "spin", final: false, speaker: 0, startedAtMs: 1_000, emittedAtMs: 1_040 },
      { utteranceId: 42, text: "spin up", final: false, speaker: 0, emittedAtMs: 1_120 },
      { utteranceId: 42, text: "spin up a", final: false, speaker: 0, emittedAtMs: 1_220 },
      { utteranceId: 42, text: "spin up a runner", final: true, speaker: 0, emittedAtMs: 1_480 },
      { utteranceId: 43, text: "ship it", final: true, speaker: 1, emittedAtMs: 2_000 },
    ];
    const provider = new VoxTermASRProvider({
      sessionId: "vox-provider-e2e",
      source: arraySegmentSource(segments),
      clock: () => 2_500,
    });
    const collector = new CommitCollector(provider);

    await collector.drain(emptyAudioStream());

    // Exactly one commit per utterance: the three interims of #42 collapsed onto a
    // single committed observation; #43 committed once on its own.
    expect(collector.committed.map((o) => o.utteranceId)).toEqual(["vox-42", "vox-43"]);
    const committedFor42 = collector.committed.filter((o) => o.utteranceId === "vox-42");
    expect(committedFor42).toHaveLength(1);

    // That single commit carries the FINAL hypothesis text, the final flag, the
    // diarized speaker, and a non-negative latency derived from its emit timestamp.
    const [final42] = committedFor42;
    expect(final42.isFinal).toBe(true);
    expect(final42.text).toBe("spin up a runner");
    expect(final42.speaker).toBe("speaker_0");
    expect(final42.sessionId).toBe("vox-provider-e2e");
    expect(final42.latencyMs).toBe(1_020); // 2500 - 1480
    expect(final42.latencyMs).toBeGreaterThanOrEqual(0);

    // The committed text equals the latest hypothesis the stream ever held for #42
    // (the interims were superseded, not committed alongside).
    expect(collector.latest("vox-42")?.text).toBe("spin up a runner");

    // The second utterance is the other committed observation, with its own speaker.
    const final43 = collector.committed.find((o) => o.utteranceId === "vox-43");
    expect(final43?.text).toBe("ship it");
    expect(final43?.speaker).toBe("speaker_1");

    // The whole loop ran offline.
    expect(fetchCalls).toBe(0);
  });
});
