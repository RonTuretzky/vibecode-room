import { describe, expect, test } from "bun:test";
import type { TranscriptObservation } from "../types";
import {
  WholeSessionPersistenceGuard,
  assertTranscriptOnlyPersistence,
  createGuardedPersistenceWriter,
  transcriptPersistencePayload,
} from "./persistence-guard";

const observation: TranscriptObservation = {
  text: "Viber status",
  isFinal: true,
  speaker: null,
  sessionId: "session-persistence",
  latencyMs: 12,
  utteranceId: "utt-persistence",
};

describe("whole-session raw-audio persistence guard", () => {
  test("allows transcript-only writes in any session phase", () => {
    for (const phase of ["starting", "streaming", "muted", "ended"] as const) {
      expect(
        assertTranscriptOnlyPersistence({
          sessionId: "session-persistence",
          sink: "disk",
          target: "transcripts/session-persistence.jsonl",
          phase,
          payload: transcriptPersistencePayload(observation),
        }),
      ).toEqual({
        ok: true,
        sessionId: "session-persistence",
        invariant: "whole-session-transcript-only",
      });
    }
  });

  test("blocks raw audio for the entire session, not only while muted", () => {
    for (const phase of ["streaming", "muted"] as const) {
      expect(() =>
        assertTranscriptOnlyPersistence({
          sessionId: "session-persistence",
          sink: "disk",
          target: "transcripts/session-persistence.jsonl",
          phase,
          payload: { rawAudio: new Uint8Array([1, 2, 3]) },
        }),
      ).toThrow("Whole-session raw-audio persistence blocked");
    }
  });

  test("guarded writer never receives an audio buffer or raw-audio target", async () => {
    const calls: unknown[] = [];
    const writer = createGuardedPersistenceWriter("session-persistence", (attempt) => {
      calls.push(attempt.payload);
    });

    await expect(
      writer({
        sessionId: "session-persistence",
        sink: "log",
        target: "logs/session-persistence.wav",
        payload: { text: "not audio" },
      }),
    ).rejects.toThrow("Only transcripts may be written");
    await expect(
      writer({
        sessionId: "session-persistence",
        sink: "trace",
        target: "trace.jsonl",
        payload: new Int16Array([1, 2]),
      }),
    ).rejects.toThrow("audio buffer value");

    expect(calls).toEqual([]);
  });

  test("class chokepoint rejects nested pcm data before disk/log/trace persistence", () => {
    const guard = new WholeSessionPersistenceGuard("session-persistence");

    expect(() =>
      guard.assertSafeWrite({
        sink: "trace",
        target: "trace.jsonl",
        payload: { meta: { pcmSamples: [0, 1, 2] } },
      }),
    ).toThrow("raw-audio field pcmSamples");
  });
});
