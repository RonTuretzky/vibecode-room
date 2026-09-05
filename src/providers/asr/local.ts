import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ASRProvider } from "../types";
import type { TranscriptObservation } from "../../types";
import type { RoomEnv } from "../../config/profiles";
import { runCommand } from "../../process/run-command";

const healthCache = new WeakMap<
  RoomEnv,
  { expires: number; result: Promise<string | null> }
>();
/** Check installation without loading weights or capturing microphone audio. */
export function probeLocalWhisper(env: RoomEnv): Promise<string | null> {
  const cached = healthCache.get(env);
  if (cached && cached.expires > Date.now()) return cached.result;
  const result = (async () => {
    try {
      await runCommand(
        [
          whisperPython(env),
          "-c",
          `import importlib.util, os
from pathlib import Path
assert importlib.util.find_spec("whisper"), "Whisper is not installed in this Python environment"
name = os.environ.get("VIBERSYN_LOCAL_WHISPER_MODEL", "base.en")
cache = Path(os.environ.get("VIBERSYN_LOCAL_WHISPER_CACHE", str(Path.home() / ".cache" / "whisper")))
assert Path(name).is_file() or (cache / (name + ".pt")).is_file(), "Whisper weights are missing; run bun run local:setup"`,
        ],
        process.cwd(),
        AbortSignal.timeout(3000),
        env,
        3000,
      );
      return null;
    } catch (error) {
      return `Local Whisper unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  })();
  healthCache.set(env, { expires: Date.now() + 30_000, result });
  return result;
}

export function whisperPython(env: RoomEnv): string {
  if (env.VIBERSYN_LOCAL_WHISPER_PYTHON)
    return env.VIBERSYN_LOCAL_WHISPER_PYTHON;
  const cli = Bun.which("whisper");
  if (cli) {
    const match = readFileSync(cli, "utf8")
      .split("\n")[0]
      ?.match(/^#!(\/\S*python\S*)$/);
    if (match) return match[1]!;
  }
  return "python3";
}

/** Browser PCM is segmented by silence and transcribed by a resident Whisper
 * process. No device capture in the child and no audio sent to a cloud service. */
export class LocalWhisperASR implements ASRProvider {
  constructor(
    readonly env: RoomEnv,
    readonly sessionId: string,
  ) {}
  async *stream(
    audio: ReadableStream<Uint8Array>,
  ): AsyncIterable<TranscriptObservation> {
    const child = Bun.spawn(
      [
        whisperPython(this.env),
        "-u",
        fileURLToPath(
          new URL("../../../scripts/local-whisper.py", import.meta.url),
        ),
      ],
      {
        env: { ...process.env, ...this.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reader = audio.getReader();
    const errors = new Response(child.stderr).text();
    const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    const queue: Uint8Array[] = [];
    let ended = false,
      failure: unknown,
      notify: (() => void) | undefined;
    void child.exited.then(async (code) => {
      if (code !== 0 && !ended) {
        failure = new Error(
          `Local Whisper stopped: ${(await errors).slice(-1200)}`,
        );
        ended = true;
        notify?.();
      }
    });
    let active = false,
      silence = 0,
      total = 0,
      parts: Uint8Array[] = [],
      pending = Buffer.alloc(0);
    const push = () => {
      if (total >= 3200) queue.push(Buffer.concat(parts));
      parts = [];
      total = 0;
      silence = 0;
      active = false;
      if (queue.length > 6)
        throw new Error(
          "Local transcription cannot keep up. Stop the microphone and choose a faster Whisper model.",
        );
      notify?.();
    };
    const pump = (async () => {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          pending = Buffer.concat([pending, next.value]);
          // Stable 20 ms frames regardless of websocket chunk boundaries.
          while (pending.length >= 640) {
            const frame = Buffer.from(pending.subarray(0, 640));
            pending = pending.subarray(640);
            let power = 0;
            for (let i = 0; i < 640; i += 2) power += frame.readInt16LE(i) ** 2;
            const voiced =
              Math.sqrt(power / 320) >
              Number(this.env.VIBERSYN_LOCAL_VAD_THRESHOLD || 220);
            if (voiced) {
              active = true;
              silence = 0;
            }
            if (active) {
              parts.push(frame);
              total += frame.length;
              if (!voiced) silence += 640;
              if (silence >= 22400 || total >= 320000) push();
            }
          }
        }
        if (active) push();
      } catch (error) {
        failure = error;
      } finally {
        ended = true;
        notify?.();
      }
    })();
    let buffer = "";
    try {
      while (!ended || queue.length) {
        if (failure) throw failure;
        const pcm = queue.shift();
        if (!pcm) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = undefined;
          continue;
        }
        const start = performance.now();
        child.stdin.write(
          JSON.stringify({ pcm: Buffer.from(pcm).toString("base64") }) + "\n",
        );
        await child.stdin.flush();
        const timeout = setTimeout(() => child.kill(), 30_000);
        try {
          while (!buffer.includes("\n")) {
            const next = await lines.read();
            if (next.done)
              throw new Error(
                `Local Whisper stopped or timed out: ${(await errors).slice(-1200)}`,
              );
            buffer += next.value;
          }
        } finally {
          clearTimeout(timeout);
        }
        const split = buffer.indexOf("\n");
        const reply = JSON.parse(buffer.slice(0, split));
        buffer = buffer.slice(split + 1);
        if (reply.error) throw new Error(`Local Whisper: ${reply.error}`);
        if (reply.text)
          yield {
            text: reply.text,
            isFinal: true,
            speaker: "speaker-1",
            sessionId: this.sessionId,
            latencyMs: Math.round(performance.now() - start),
            utteranceId: `local-${crypto.randomUUID()}`,
          };
      }
      if (failure) throw failure;
    } finally {
      await reader.cancel().catch(() => {});
      child.kill();
      await lines.cancel().catch(() => {});
      await pump;
      reader.releaseLock();
    }
  }
}
