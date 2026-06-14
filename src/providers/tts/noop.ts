import type { AudioReadableStream, TTSOptions, TTSProvider } from "../types";

export interface NoopTTSCall {
  text: string;
  opts?: TTSOptions;
}

export class NoopTTSProvider implements TTSProvider {
  readonly calls: NoopTTSCall[] = [];

  async speak(text: string, opts?: TTSOptions): Promise<AudioReadableStream> {
    this.calls.push(opts === undefined ? { text } : { text, opts: { ...opts } });

    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  }
}
