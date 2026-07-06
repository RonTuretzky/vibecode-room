import type { AudioDispatchMeta, AudioOutput, PcmClip } from "./earcons";

export interface RecordedAudioOutputCall {
  clip: PcmClip;
  meta?: AudioDispatchMeta;
}

export class RecordingAudioOutput implements AudioOutput {
  readonly calls: RecordedAudioOutputCall[] = [];

  async playPcm(clip: PcmClip, meta?: AudioDispatchMeta): Promise<void> {
    this.calls.push({ clip, meta });
  }
}
