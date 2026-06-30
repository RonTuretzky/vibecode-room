// TTS audio-stream sink (ISSUE-0022).
//
// ElevenLabsFlashTTSProvider.speak (and any streaming TTSProvider) returns an
// AudioReadableStream whose bytes must be pulled to completion for synthesis to
// run and the connection to release. The live loop previously awaited the
// `speak()` promise and discarded the stream, so the synthesized audio was never
// read. `drainTtsStream` fully consumes that stream — routing every chunk to a
// device sink (a no-op in production, which has no audio device) and returning
// the byte/chunk totals so the caller can record them on the trace.

import type { AudioReadableStream } from "../providers";

export interface TtsDrainResult {
  // Total bytes read across every chunk of the synthesized stream.
  bytes: number;
  // Number of chunks pulled off the stream before it closed.
  chunks: number;
}

// Where drained PCM/audio bytes are routed. Production has no audio device, so
// the default sink absorbs the bytes after they are read off the stream.
export interface TtsAudioSink {
  write(chunk: Uint8Array): void | Promise<void>;
}

// No-op device sink: bytes are read (so synthesis completes and the stream
// releases) and then dropped, mirroring the BufferedAudioOutput earcon sink.
export const noopTtsAudioSink: TtsAudioSink = {
  write() {
    // Intentionally empty — see TtsAudioSink doc.
  },
};

export interface DrainTtsStreamOptions {
  // Device sink for the drained bytes. Defaults to the no-op sink.
  sink?: TtsAudioSink;
}

// Read an AudioReadableStream to completion, routing each chunk to the sink and
// counting bytes/chunks. The reader lock is always released, even on error, so
// a partially-read stream can still be cancelled by the caller.
export async function drainTtsStream(
  stream: AudioReadableStream,
  options: DrainTtsStreamOptions = {},
): Promise<TtsDrainResult> {
  const sink = options.sink ?? noopTtsAudioSink;
  const reader = stream.getReader();
  let bytes = 0;
  let chunks = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined || value.byteLength === 0) {
        continue;
      }
      bytes += value.byteLength;
      chunks += 1;
      await sink.write(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes, chunks };
}
