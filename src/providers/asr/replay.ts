import { readTranscriptObservationJsonl } from "../../replay/jsonl";
import { transcriptObservationSchema, type TranscriptObservation } from "../../types";
import type { ASRProvider, AudioReadableStream } from "../types";

export type ReplayASRSource = string | readonly TranscriptObservation[];

export interface ReplayASRStreamCall {
  bytesDiscarded: number;
}

export class ReplayASRProvider implements ASRProvider {
  // Test seam: bounded per-call metadata only. Retaining the audio streams
  // themselves pinned every mic session's queued PCM for the lifetime of this
  // provider — the default no-DEEPGRAM_API_KEY server mic ASR.
  readonly streamCalls: ReplayASRStreamCall[] = [];

  constructor(readonly source: ReplayASRSource) {}

  static fromFile(path: string): ReplayASRProvider {
    return new ReplayASRProvider(path);
  }

  async *stream(audio: AudioReadableStream): AsyncIterable<TranscriptObservation> {
    const call: ReplayASRStreamCall = { bytesDiscarded: 0 };
    this.streamCalls.push(call);
    // Consume and discard the mic audio like a real ASR would (replay only
    // reads its transcript source), so queued and future PCM is released
    // instead of accumulating for the life of the mic session. A background
    // drain rather than a cancel(): the server runtime intentionally keeps the
    // mic stream open (byte accounting, stop() bookkeeping) after the replay
    // observations run out.
    void drainAndDiscard(audio, call);
    const observations = await this.load();

    for (const observation of observations) {
      yield transcriptObservationSchema.parse(observation);
    }
  }

  private async load(): Promise<TranscriptObservation[]> {
    if (typeof this.source === "string") {
      return readTranscriptObservationJsonl(this.source);
    }

    return this.source.map((observation) => transcriptObservationSchema.parse(observation));
  }
}

async function drainAndDiscard(audio: AudioReadableStream, call: ReplayASRStreamCall): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = audio.getReader();
  } catch {
    // Already locked by another consumer; that consumer owns the drain.
    return;
  }

  try {
    while (true) {
      const read = await reader.read();
      if (read.done) {
        return;
      }
      call.bytesDiscarded += read.value.byteLength;
    }
  } catch {
    // Cancelled or errored elsewhere; nothing further queues.
  } finally {
    reader.releaseLock();
  }
}
