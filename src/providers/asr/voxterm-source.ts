// Production VoxTermSegmentSource (ISSUE-0028 / GAP-002).
//
// Binds the forked VoxTerm child (github.com/dmarzzz/VoxTerm @
// panopticon/realtime-segment-ipc) and turns its stdout — a stream of
// newline-delimited JSON segment frames, the contract documented in voxterm.ts —
// into the VoxTermSegment objects VoxTermASRProvider consumes.
//
// The spawn/transport is INJECTABLE: production spawns a real child via Bun.spawn,
// but tests pass a synthetic `spawn` hook whose stdout is an in-memory NDJSON byte
// stream — so no mic, process, or socket is ever touched in a test. The NDJSON
// parsing (partial-line buffering across reads, skipping blank/malformed lines)
// is identical on both paths.

import type { VoxTermSegment, VoxTermSegmentSource } from "./voxterm";
import type { AudioReadableStream } from "../types";

/**
 * A spawned/connected VoxTerm child as the source sees it: its stdout byte stream
 * of NDJSON frames plus a hook that terminates it. {@link stop} must be safe to
 * call more than once (the source calls it on clean shutdown).
 */
export interface VoxTermChild {
  /** Newline-delimited JSON segment frames, one frame per line. */
  readonly stdout: ReadableStream<Uint8Array>;
  /** Terminate the child/stream. Idempotent. */
  stop(): void | Promise<void>;
}

/**
 * Injectable transport hook: spawns/connects the VoxTerm child for a captured
 * audio stream and returns its stdout + stop handle. Production defaults to a
 * Bun.spawn-backed child; tests supply a synthetic NDJSON feed.
 */
export type VoxTermSpawn = (audio: AudioReadableStream) => VoxTermChild;

export interface VoxTermSourceOptions {
  /** Executable to run for the forked VoxTerm child. Defaults to `"voxterm"`. */
  command?: string;
  /** Arguments passed to {@link command}. Defaults to `[]`. */
  args?: string[];
  /**
   * Injectable spawn/transport. Defaults to a Bun.spawn-backed child reading the
   * configured command/args. Tests inject a synthetic NDJSON stream here.
   */
  spawn?: VoxTermSpawn;
}

/**
 * Production segment source: spawns the forked VoxTerm child and parses its
 * NDJSON stdout into {@link VoxTermSegment} frames. Spawns lazily — nothing is
 * touched until {@link open} is iterated — so binding it by default in the
 * registry opens no process until a session actually streams.
 */
export class VoxTermSpawnSource implements VoxTermSegmentSource {
  readonly #spawn: VoxTermSpawn;

  constructor(options: VoxTermSourceOptions = {}) {
    this.#spawn = options.spawn ?? defaultVoxTermSpawn(options.command, options.args);
  }

  async *open(audio: AudioReadableStream): AsyncIterable<VoxTermSegment> {
    const child = this.#spawn(audio);
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const segment = parseSegmentLine(line);
          if (segment !== null) {
            yield segment;
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }

      // Flush any trailing frame the child emitted without a final newline.
      buffer += decoder.decode();
      const tail = parseSegmentLine(buffer);
      if (tail !== null) {
        yield tail;
      }
    } finally {
      // Clean shutdown on natural end OR early break (consumer stopped): cancel
      // the read side and terminate the child so nothing is left hanging.
      await reader.cancel().catch(() => {});
      await child.stop();
    }
  }
}

/** Construct the production VoxTerm segment source (see {@link VoxTermSpawnSource}). */
export function createVoxTermSegmentSource(options: VoxTermSourceOptions = {}): VoxTermSegmentSource {
  return new VoxTermSpawnSource(options);
}

/**
 * Parse one NDJSON line into a {@link VoxTermSegment}, or `null` when the line is
 * blank, not JSON, or missing the required `utteranceId`/`text`/`final` fields.
 * Exported so the partial-line/malformed-line behavior is unit-tested directly.
 */
export function parseSegmentLine(line: string): VoxTermSegment | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  return toVoxTermSegment(parsed);
}

function toVoxTermSegment(value: unknown): VoxTermSegment | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const { utteranceId, text, final } = record;

  if (typeof utteranceId !== "string" && typeof utteranceId !== "number") {
    return null;
  }
  if (typeof text !== "string") {
    return null;
  }
  if (typeof final !== "boolean") {
    return null;
  }

  const segment: VoxTermSegment = { utteranceId, text, final };

  const { speaker } = record;
  if (typeof speaker === "string" || typeof speaker === "number" || speaker === null) {
    segment.speaker = speaker;
  }
  if (typeof record.startedAtMs === "number") {
    segment.startedAtMs = record.startedAtMs;
  }
  if (typeof record.emittedAtMs === "number") {
    segment.emittedAtMs = record.emittedAtMs;
  }

  return segment;
}

function defaultVoxTermSpawn(command?: string, args?: string[]): VoxTermSpawn {
  const cmd = command ?? "voxterm";
  const cmdArgs = args ?? [];
  return () => {
    // Bun.spawn is only reached on the production path; every test injects `spawn`.
    const child = Bun.spawn([cmd, ...cmdArgs], { stdout: "pipe", stdin: "ignore", stderr: "inherit" });
    return {
      stdout: child.stdout as ReadableStream<Uint8Array>,
      async stop() {
        child.kill();
        await child.exited;
      },
    };
  };
}
