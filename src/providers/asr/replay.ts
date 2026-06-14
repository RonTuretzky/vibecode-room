import { readTranscriptObservationJsonl } from "../../replay/jsonl";
import { transcriptObservationSchema, type TranscriptObservation } from "../../types";
import type { ASRProvider, AudioReadableStream } from "../types";

export type ReplayASRSource = string | readonly TranscriptObservation[];

export class ReplayASRProvider implements ASRProvider {
  readonly streamCalls: AudioReadableStream[] = [];

  constructor(readonly source: ReplayASRSource) {}

  static fromFile(path: string): ReplayASRProvider {
    return new ReplayASRProvider(path);
  }

  async *stream(audio: AudioReadableStream): AsyncIterable<TranscriptObservation> {
    this.streamCalls.push(audio);
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
