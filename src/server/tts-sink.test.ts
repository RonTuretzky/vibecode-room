import { describe, expect, test } from "bun:test";
import { drainTtsStream, noopTtsAudioSink, type TtsAudioSink } from "./tts-sink";

describe("ISSUE-0022 tts-sink — drains a synthesized audio stream to a sink", () => {
  test("[unit] reads every chunk of a synthetic stream and counts bytes/chunks", async () => {
    const synthetic = [
      Uint8Array.from([0x49, 0x44, 0x33]),
      Uint8Array.from([0x10, 0x20, 0x30, 0x40]),
      Uint8Array.from([0xff]),
    ];
    const written: Uint8Array[] = [];
    const sink: TtsAudioSink = { write: (chunk) => void written.push(chunk) };

    const result = await drainTtsStream(streamOf(synthetic), { sink });

    // Every chunk was routed to the sink, in order, with no bytes dropped.
    expect(written).toHaveLength(synthetic.length);
    expect(concat(written)).toEqual(Uint8Array.from([0x49, 0x44, 0x33, 0x10, 0x20, 0x30, 0x40, 0xff]));
    expect(result).toEqual({ bytes: 8, chunks: 3 });
  });

  test("[unit] drains a pull-based stream to completion (every produced chunk read)", async () => {
    const total = 5;
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (produced >= total) {
            controller.close();
            return;
          }
          produced += 1;
          controller.enqueue(Uint8Array.from([produced, produced]));
        },
      },
      { highWaterMark: 0 },
    );

    const result = await drainTtsStream(stream);

    // The lazy stream only emits when pulled; a full drain must pull all of it.
    expect(produced).toBe(total);
    expect(result).toEqual({ bytes: total * 2, chunks: total });
  });

  test("[unit] empty stream drains to zero and the default sink is a no-op", async () => {
    const result = await drainTtsStream(streamOf([]));
    expect(result).toEqual({ bytes: 0, chunks: 0 });
    // The exported default sink accepts bytes without throwing.
    await expect(Promise.resolve(noopTtsAudioSink.write(Uint8Array.from([1])))).resolves.toBeUndefined();
  });

  test("[unit] skips zero-length chunks but still drains the rest", async () => {
    const result = await drainTtsStream(
      streamOf([Uint8Array.from([1, 2]), new Uint8Array(0), Uint8Array.from([3])]),
    );
    expect(result).toEqual({ bytes: 3, chunks: 2 });
  });

  test("[unit] releases the reader lock on completion so the stream can be reused/cancelled", async () => {
    const stream = streamOf([Uint8Array.from([1])]);
    await drainTtsStream(stream);
    // A locked stream would throw here; a released lock lets getReader() succeed.
    expect(() => stream.getReader()).not.toThrow();
  });

  test("[unit] a sink error releases the lock and propagates (caller decides best-effort)", async () => {
    const stream = streamOf([Uint8Array.from([1, 2, 3])]);
    const sink: TtsAudioSink = {
      write() {
        throw new Error("device sink failure");
      },
    };

    await expect(drainTtsStream(stream, { sink })).rejects.toThrow(/device sink failure/u);
    // The lock is released even though draining threw mid-stream.
    expect(() => stream.getReader()).not.toThrow();
  });
});

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
