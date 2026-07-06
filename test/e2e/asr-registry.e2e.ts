// e2e: a registry-selected ASR provider streams schema-valid observations for
// each local backend (replay + voxterm) over a fixture, with zero network.
//
// The registry is exercised exactly as a consumer would: through the providers
// barrel, by VIBERSYN_ASR_PROVIDER, returning only the ASRProvider seam. The
// concrete backend is injected a fixture-backed source so no mic, child
// process, or socket is opened.

import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import {
  arraySegmentSource,
  selectAsrProvider,
  type AsrProviderMode,
  type VoxTermSegment,
} from "../../src/providers";
import type { ASRProvider } from "../../src/providers";
import { readTranscriptObservationJsonl } from "../../src/replay/jsonl";
import { transcriptObservationSchema, type TranscriptObservation } from "../../src/types";

const replayFixturePath = "fixtures/smoke/transcript.jsonl";
const voxtermFixturePath = "fixtures/voxterm/session.jsonl";

function emptyAudioStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

async function loadVoxTermSegments(path: string): Promise<VoxTermSegment[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as VoxTermSegment);
}

// A boundary consumer that knows only the ASRProvider seam and asserts every
// observation is schema-valid as it arrives.
async function drain(asr: ASRProvider): Promise<TranscriptObservation[]> {
  const observations: TranscriptObservation[] = [];
  for await (const observation of asr.stream(emptyAudioStream())) {
    expect(transcriptObservationSchema.parse(observation)).toEqual(observation);
    observations.push(observation);
  }
  return observations;
}

describe("registry-selected ASR streams observations for each backend (e2e)", () => {
  test("replay selection streams schema-valid observations from a fixture with no network", async () => {
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      throw new Error("network is forbidden in the ASR registry e2e");
    }) as unknown as typeof fetch;

    try {
      const expected = await readTranscriptObservationJsonl(replayFixturePath);
      const selection = selectAsrProvider(
        { VIBERSYN_ASR_PROVIDER: "replay" },
        { sessionId: "asr-registry-replay", replaySource: replayFixturePath },
      );

      expect(selection.mode satisfies AsrProviderMode).toBe("replay");

      const observations = await drain(selection.provider);

      expect(observations).toEqual(expected);
      expect(observations.length).toBeGreaterThan(0);
      expect(observations.map((o) => o.text)).toEqual(expected.map((o) => o.text));
      expect(fetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("voxterm selection streams schema-valid observations from a fixture with no network", async () => {
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      throw new Error("network is forbidden in the ASR registry e2e");
    }) as unknown as typeof fetch;

    try {
      const segments = await loadVoxTermSegments(voxtermFixturePath);
      const selection = selectAsrProvider(
        { VIBERSYN_ASR_PROVIDER: "voxterm" },
        { sessionId: "asr-registry-voxterm", voxtermSource: arraySegmentSource(segments) },
      );

      expect(selection.mode satisfies AsrProviderMode).toBe("voxterm");

      const observations = await drain(selection.provider);

      expect(observations).toHaveLength(segments.length);
      expect(observations.every((o) => o.sessionId === "asr-registry-voxterm")).toBe(true);
      // utteranceId is stable across interims + the final commit of one utterance.
      expect(observations.map((o) => o.utteranceId)).toEqual(["vox-1", "vox-1", "vox-1", "vox-2", "vox-2"]);
      expect(observations.filter((o) => o.isFinal).map((o) => o.text)).toEqual([
        "hey viber spin up a runner",
        "and check the build status",
      ]);
      expect(fetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
