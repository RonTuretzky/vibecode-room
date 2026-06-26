import { describe, expect, test } from "bun:test";
import {
  createVoxTermSegmentSource,
  parseSegmentLine,
  VoxTermSpawnSource,
  type VoxTermChild,
  type VoxTermSpawn,
} from "./voxterm-source";
import type { VoxTermSegment } from "./voxterm";

function emptyAudioStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

// A synthetic VoxTerm child: emits the supplied byte chunks on stdout (allowing
// frames to be split arbitrarily across reads), then closes. Records stop() calls.
function stubChild(chunks: Array<Uint8Array | string>): { spawn: VoxTermSpawn; stops: () => number } {
  let stops = 0;
  const spawn: VoxTermSpawn = () => {
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
        }
        controller.close();
      },
    });
    return {
      stdout,
      stop() {
        stops += 1;
      },
    } satisfies VoxTermChild;
  };
  return { spawn, stops: () => stops };
}

async function collect(source: { open: (audio: ReadableStream<Uint8Array>) => AsyncIterable<VoxTermSegment> }): Promise<VoxTermSegment[]> {
  const segments: VoxTermSegment[] = [];
  for await (const segment of source.open(emptyAudioStream())) {
    segments.push(segment);
  }
  return segments;
}

describe("parseSegmentLine — NDJSON frame parsing (unit)", () => {
  test("parses a well-formed frame with all fields", () => {
    const segment = parseSegmentLine(
      JSON.stringify({ utteranceId: 7, text: "hey", final: false, speaker: 0, startedAtMs: 1, emittedAtMs: 2 }),
    );
    expect(segment).toEqual({ utteranceId: 7, text: "hey", final: false, speaker: 0, startedAtMs: 1, emittedAtMs: 2 });
  });

  test("keeps only the optional fields that are present and well-typed", () => {
    expect(parseSegmentLine(JSON.stringify({ utteranceId: "u", text: "x", final: true }))).toEqual({
      utteranceId: "u",
      text: "x",
      final: true,
    });
    // A non-numeric emittedAtMs / startedAtMs is dropped rather than carried through.
    expect(
      parseSegmentLine(JSON.stringify({ utteranceId: 1, text: "x", final: true, emittedAtMs: "nope" })),
    ).toEqual({ utteranceId: 1, text: "x", final: true });
    // speaker: null is preserved (an explicit "no diarization" signal).
    expect(parseSegmentLine(JSON.stringify({ utteranceId: 1, text: "x", final: true, speaker: null }))).toEqual({
      utteranceId: 1,
      text: "x",
      final: true,
      speaker: null,
    });
  });

  test("returns null for blank lines", () => {
    expect(parseSegmentLine("")).toBeNull();
    expect(parseSegmentLine("   ")).toBeNull();
    expect(parseSegmentLine("\t")).toBeNull();
  });

  test("returns null for non-JSON and malformed frames", () => {
    expect(parseSegmentLine("not json")).toBeNull();
    expect(parseSegmentLine("{")).toBeNull();
    expect(parseSegmentLine("[1,2,3]")).toBeNull();
    expect(parseSegmentLine("42")).toBeNull();
    expect(parseSegmentLine("null")).toBeNull();
  });

  test("returns null when a required field is missing or mistyped", () => {
    expect(parseSegmentLine(JSON.stringify({ text: "x", final: true }))).toBeNull(); // no utteranceId
    expect(parseSegmentLine(JSON.stringify({ utteranceId: 1, final: true }))).toBeNull(); // no text
    expect(parseSegmentLine(JSON.stringify({ utteranceId: 1, text: "x" }))).toBeNull(); // no final
    expect(parseSegmentLine(JSON.stringify({ utteranceId: 1, text: "x", final: "yes" }))).toBeNull(); // final not bool
    expect(parseSegmentLine(JSON.stringify({ utteranceId: { id: 1 }, text: "x", final: true }))).toBeNull();
  });
});

describe("VoxTermSpawnSource — stream parsing & buffering (unit)", () => {
  test("reassembles frames split across reads and skips blank/malformed lines", async () => {
    // The same three frames, but chopped at arbitrary byte boundaries — including
    // mid-frame and mid-field — plus interleaved blank and malformed lines.
    const frame1 = JSON.stringify({ utteranceId: 1, text: "open the", final: false, emittedAtMs: 10 });
    const frame2 = JSON.stringify({ utteranceId: 1, text: "open the dashboard", final: true, emittedAtMs: 20 });
    const frame3 = JSON.stringify({ utteranceId: 2, text: "ship it", final: true, emittedAtMs: 30 });
    const wire = `${frame1}\n\n  \nthis is not json\n${frame2}\n{bad\n${frame3}\n`;

    // Split the wire bytes into jagged chunks so newlines AND frame interiors land
    // across read boundaries.
    const bytes = new TextEncoder().encode(wire);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) {
      chunks.push(bytes.slice(i, i + 7));
    }

    const { spawn } = stubChild(chunks);
    const segments = await collect(new VoxTermSpawnSource({ spawn }));

    expect(segments).toEqual([
      { utteranceId: 1, text: "open the", final: false, emittedAtMs: 10 },
      { utteranceId: 1, text: "open the dashboard", final: true, emittedAtMs: 20 },
      { utteranceId: 2, text: "ship it", final: true, emittedAtMs: 30 },
    ]);
  });

  test("flushes a trailing frame emitted without a final newline", async () => {
    const frame = JSON.stringify({ utteranceId: 5, text: "no newline", final: true });
    const { spawn } = stubChild([frame]); // note: no "\n"
    const segments = await collect(new VoxTermSpawnSource({ spawn }));
    expect(segments).toEqual([{ utteranceId: 5, text: "no newline", final: true }]);
  });

  test("an empty stdout stream yields nothing and stops the child", async () => {
    const { spawn, stops } = stubChild([]);
    const segments = await collect(new VoxTermSpawnSource({ spawn }));
    expect(segments).toEqual([]);
    expect(stops()).toBe(1);
  });

  test("stops the child after the stream is fully drained", async () => {
    const { spawn, stops } = stubChild([`${JSON.stringify({ utteranceId: 1, text: "a", final: true })}\n`]);
    await collect(new VoxTermSpawnSource({ spawn }));
    expect(stops()).toBe(1);
  });

  test("createVoxTermSegmentSource returns a VoxTermSpawnSource", () => {
    expect(createVoxTermSegmentSource()).toBeInstanceOf(VoxTermSpawnSource);
    expect(createVoxTermSegmentSource({ command: "voxterm", args: [] })).toBeInstanceOf(VoxTermSpawnSource);
  });
});

describe("VoxTermSpawnSource — clean stop (unit)", () => {
  test("a clean stop terminates the child and ends the iterable without hanging", async () => {
    // A stdout stream that NEVER closes on its own: it yields one frame then blocks
    // forever. A clean stop (breaking the for-await) must still run the finally,
    // cancel the reader, stop the child, and let the loop end.
    let stops = 0;
    let cancelled = false;
    const spawn: VoxTermSpawn = () => {
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`${JSON.stringify({ utteranceId: 1, text: "hi", final: false })}\n`),
          );
          // Intentionally never closes — emulates a live child still streaming.
        },
        cancel() {
          cancelled = true;
        },
      });
      return {
        stdout,
        stop() {
          stops += 1;
        },
      };
    };

    const source = new VoxTermSpawnSource({ spawn });
    const iterator = source.open(emptyAudioStream())[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ utteranceId: 1, text: "hi", final: false });

    // Early termination (as `break` would do) — must resolve, not hang.
    const ended = await iterator.return?.();
    expect(ended?.done).toBe(true);
    expect(stops).toBe(1);
    expect(cancelled).toBe(true);
  });
});
