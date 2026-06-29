// Selectable real audio sink (ISSUE-0026).
//
// Closes GAP-001: the live loop previously bound a no-op earcon output and a
// no-op TTS sink, so both prerendered earcon PCM and drained TTS bytes were read
// and discarded. This module exposes a real device sink that RETAINS the bytes it
// is handed, plus a `selectAudioSink(env)` factory so the runtime can opt into it.
//
//   noop   -> noopTtsAudioSink   (default; bytes are read then dropped — silent)
//   device -> RecordingAudioSink (explicit; bytes are retained and observable)
//
// The selected sink backs BOTH the earcon playPcm path and the TTS drain sink, so
// a single injectable seam makes the whole audible output of one accept turn
// observable to tests and substitutable by the browser-broadcast path (ISSUE-0027).

import { noopTtsAudioSink, type TtsAudioSink } from "./tts-sink";

// The audible-output sink the runtime routes both earcon PCM and drained TTS
// bytes into. It is exactly a TtsAudioSink so it can back drainTtsStream directly;
// the earcon path adapts each PcmClip's bytes onto the same write().
export type AudioSink = TtsAudioSink;

export type AudioSinkMode = "noop" | "device";

export interface AudioSinkSelectionEnv {
  VIBERSYN_AUDIO_SINK?: string;
  [key: string]: string | undefined;
}

export interface AudioSinkSelection {
  mode: AudioSinkMode;
  sink: AudioSink;
}

// A real device sink that retains every (non-empty) chunk it is given. Unlike the
// no-op sink, the bytes survive the write so they can be inspected (tests) or
// streamed onward (the browser-broadcast sink swaps in here, ISSUE-0027). Each
// chunk is copied on write so a reused backing buffer can't mutate the retained
// audio after the fact.
export class RecordingAudioSink implements AudioSink {
  readonly chunks: Uint8Array[] = [];
  #bytes = 0;

  write(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) {
      return;
    }
    this.chunks.push(new Uint8Array(chunk));
    this.#bytes += chunk.byteLength;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get chunkCount(): number {
    return this.chunks.length;
  }
}

// Resolve the audible-output sink from the environment. VIBERSYN_AUDIO_SINK=device
// retains bytes through a RecordingAudioSink; anything else (including unset) keeps
// the silent-but-read no-op sink, so the offline default never reaches for a
// device. Case/whitespace insensitive to match the other VIBERSYN_* selectors.
export function selectAudioSink(env: AudioSinkSelectionEnv = process.env): AudioSinkSelection {
  const mode = resolveAudioSinkMode(env);
  switch (mode) {
    case "device":
      return { mode, sink: new RecordingAudioSink() };
    case "noop":
      return { mode, sink: noopTtsAudioSink };
  }
}

function resolveAudioSinkMode(env: AudioSinkSelectionEnv): AudioSinkMode {
  const explicit = env.VIBERSYN_AUDIO_SINK?.trim().toLowerCase();
  if (explicit === "device") {
    return "device";
  }
  // Unset, blank, "noop", or any unrecognized value: the silent no-op sink. The
  // offline path stays silent-but-recorded by default — only an explicit "device"
  // opts into a byte-retaining sink.
  return "noop";
}
