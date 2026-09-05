import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../process/run-command";
import type { TTSProvider } from "../types";
import type { RoomEnv } from "../../config/profiles";

export class LocalSystemTTS implements TTSProvider {
  constructor(readonly env: RoomEnv) {}
  async speak(text: string): Promise<ReadableStream<Uint8Array>> {
    if (process.platform !== "darwin")
      throw new Error(
        "Local system speech currently requires macOS (say and afplay).",
      );
    const dir = await mkdtemp(join(tmpdir(), "room-speech-"));
    try {
      const file = join(dir, "speech.wav");
      await runCommand(
        [
          "/usr/bin/say",
          ...(this.env.VIBERSYN_LOCAL_VOICE
            ? ["-v", this.env.VIBERSYN_LOCAL_VOICE]
            : []),
          "-o",
          file,
          "--file-format=WAVE",
          "--data-format=LEI16@24000",
          "--",
          text,
        ],
        dir,
        AbortSignal.timeout(30_000),
      );
      const bytes = await readFile(file);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
