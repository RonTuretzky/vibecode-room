import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../process/run-command";
import type { AudioSink } from "./audio-device-sink";

/** Plays complete local TTS WAV clips on the room computer's speakers. */
export class LocalAudioSink implements AudioSink {
  async write(bytes: Uint8Array): Promise<void> {
    if (Buffer.from(bytes.subarray(0, 4)).toString() !== "RIFF") {
      const wav = Buffer.alloc(44 + bytes.length);
      wav.write("RIFF", 0);
      wav.writeUInt32LE(36 + bytes.length, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(24000, 24);
      wav.writeUInt32LE(48000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(bytes.length, 40);
      wav.set(bytes, 44);
      bytes = wav;
    }
    const dir = await mkdtemp(join(tmpdir(), "room-playback-"));
    try {
      const file = join(dir, "speech.wav");
      await writeFile(file, bytes);
      await runCommand(
        ["/usr/bin/afplay", file],
        dir,
        AbortSignal.timeout(60_000),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
