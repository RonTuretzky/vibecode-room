// ISSUE-0028 e2e (GAP-002): a synthetic NDJSON byte stream — the exact wire shape
// the forked VoxTerm child emits on stdout — driven through the PRODUCTION
// VoxTermSpawnSource (with only the spawn hook stubbed), selected by the ASR
// registry, yields exactly ONE committed TranscriptObservation per utterance.
//
// Fully offline: the "child" is an in-memory ReadableStream of NDJSON bytes (no
// mic, process, or socket) and any network fetch fails the test. This exercises
// the real NDJSON parser + partial-line buffering + provider normalization +
// schema validation end-to-end, not an array shortcut.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createVoxTermSegmentSource,
  selectAsrProvider,
  type VoxTermSpawn,
} from "../../src/providers";
import { transcriptObservationSchema, type TranscriptObservation } from "../../src/types";
import type { ASRProvider } from "../../src/providers/types";

function emptyAudioStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

// A stub VoxTerm child whose stdout streams the given NDJSON wire bytes, chopped
// into jagged chunks so frames land across read boundaries — proving the source's
// partial-line buffering, not just whole-line parsing.
function ndjsonSpawn(wire: string, chunkSize = 9): VoxTermSpawn {
  return () => {
    const bytes = new TextEncoder().encode(wire);
    return {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += chunkSize) {
            controller.enqueue(bytes.slice(i, i + chunkSize));
          }
          controller.close();
        },
      }),
      stop() {
        /* no child to terminate in the stub */
      },
    };
  };
}

// Mirror of the live transcript fold: keep the latest hypothesis per utterance,
// commit exactly once — when that utterance's final frame arrives.
class CommitCollector {
  readonly committed: TranscriptObservation[] = [];
  constructor(private readonly asr: ASRProvider) {}

  async drain(audio: ReadableStream<Uint8Array>): Promise<void> {
    for await (const observation of this.asr.stream(audio)) {
      expect(transcriptObservationSchema.parse(observation)).toEqual(observation);
      if (observation.isFinal) {
        this.committed.push(observation);
      }
    }
  }
}

describe("VoxTerm NDJSON stub stream drives observations end-to-end (e2e)", () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetchCalls += 1;
      throw new Error(`network is forbidden in the VoxTerm source e2e: ${String(input)}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("one committed observation per utterance through the registry-selected provider", async () => {
    // Utterance 42: three interims then the committed final. Utterance 43: a single
    // committed frame. Plus a blank line and a malformed line that must be ignored.
    const lines = [
      JSON.stringify({ utteranceId: 42, text: "spin", final: false, speaker: 0, startedAtMs: 1_000, emittedAtMs: 1_040 }),
      "",
      JSON.stringify({ utteranceId: 42, text: "spin up", final: false, speaker: 0, emittedAtMs: 1_120 }),
      "{ this is not valid json",
      JSON.stringify({ utteranceId: 42, text: "spin up a", final: false, speaker: 0, emittedAtMs: 1_220 }),
      JSON.stringify({ utteranceId: 42, text: "spin up a runner", final: true, speaker: 0, emittedAtMs: 1_480 }),
      JSON.stringify({ utteranceId: 43, text: "ship it", final: true, speaker: 1, emittedAtMs: 2_000 }),
    ];
    const wire = `${lines.join("\n")}\n`;

    // The registry selects the VoxTerm provider; the source is the PRODUCTION
    // spawn-backed source with only its spawn hook stubbed to the NDJSON stream.
    const selection = selectAsrProvider(
      { PANOP_ASR_PROVIDER: "voxterm" },
      {
        sessionId: "vox-source-e2e",
        voxtermSource: createVoxTermSegmentSource({ spawn: ndjsonSpawn(wire) }),
      },
    );
    expect(selection.mode).toBe("voxterm");

    const collector = new CommitCollector(selection.provider);
    await collector.drain(emptyAudioStream());

    // Exactly one commit per utterance: #42's interims collapsed onto a single
    // committed observation; #43 committed once on its own. Order preserved.
    expect(collector.committed.map((o) => o.utteranceId)).toEqual(["vox-42", "vox-43"]);
    expect(collector.committed.filter((o) => o.utteranceId === "vox-42")).toHaveLength(1);

    const final42 = collector.committed.find((o) => o.utteranceId === "vox-42");
    expect(final42?.isFinal).toBe(true);
    expect(final42?.text).toBe("spin up a runner"); // the FINAL hypothesis, not an interim
    expect(final42?.speaker).toBe("speaker_0");
    expect(final42?.sessionId).toBe("vox-source-e2e");

    const final43 = collector.committed.find((o) => o.utteranceId === "vox-43");
    expect(final43?.text).toBe("ship it");
    expect(final43?.speaker).toBe("speaker_1");

    // The blank + malformed lines never surfaced as observations, and the whole
    // loop ran offline.
    expect(fetchCalls).toBe(0);
  });
});
