import { describe, expect, test } from "bun:test";
import { noopTtsAudioSink } from "./tts-sink";
import { RecordingAudioSink, selectAudioSink } from "./audio-device-sink";

// ISSUE-0026: selectAudioSink maps VIBERSYN_AUDIO_SINK onto a concrete audible-output
// sink. `device` retains bytes through a RecordingAudioSink; anything else keeps
// the silent no-op sink so the offline default never reaches for a device.
describe("selectAudioSink — sink selection by env (unit)", () => {
  test("VIBERSYN_AUDIO_SINK=device selects a byte-retaining RecordingAudioSink", () => {
    const selection = selectAudioSink({ VIBERSYN_AUDIO_SINK: "device" });
    expect(selection.mode).toBe("device");
    expect(selection.sink).toBeInstanceOf(RecordingAudioSink);
  });

  test("VIBERSYN_AUDIO_SINK=noop selects the silent no-op sink", () => {
    const selection = selectAudioSink({ VIBERSYN_AUDIO_SINK: "noop" });
    expect(selection.mode).toBe("noop");
    expect(selection.sink).toBe(noopTtsAudioSink);
  });

  test("unset VIBERSYN_AUDIO_SINK defaults to the no-op sink", () => {
    const selection = selectAudioSink({});
    expect(selection.mode).toBe("noop");
    expect(selection.sink).toBe(noopTtsAudioSink);
  });

  test("case/whitespace are normalized when resolving the device sink", () => {
    const selection = selectAudioSink({ VIBERSYN_AUDIO_SINK: "  Device  " });
    expect(selection.mode).toBe("device");
    expect(selection.sink).toBeInstanceOf(RecordingAudioSink);
  });

  test("an unrecognized value falls back to the no-op sink (silent default)", () => {
    const selection = selectAudioSink({ VIBERSYN_AUDIO_SINK: "speaker" });
    expect(selection.mode).toBe("noop");
    expect(selection.sink).toBe(noopTtsAudioSink);
  });

  test("a blank value falls back to the no-op sink", () => {
    const selection = selectAudioSink({ VIBERSYN_AUDIO_SINK: "   " });
    expect(selection.mode).toBe("noop");
    expect(selection.sink).toBe(noopTtsAudioSink);
  });

  test("each device selection yields a fresh, independent recording sink", () => {
    const first = selectAudioSink({ VIBERSYN_AUDIO_SINK: "device" }).sink;
    const second = selectAudioSink({ VIBERSYN_AUDIO_SINK: "device" }).sink;
    expect(first).not.toBe(second);
  });
});

describe("RecordingAudioSink — retains the bytes it is given (unit)", () => {
  test("retains non-empty chunks and accumulates bytes/chunk counts", () => {
    const sink = new RecordingAudioSink();
    sink.write(Uint8Array.from([1, 2, 3]));
    sink.write(Uint8Array.from([4, 5]));

    expect(sink.chunkCount).toBe(2);
    expect(sink.bytes).toBe(5);
    expect(sink.chunks.map((chunk) => [...chunk])).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
  });

  test("drops zero-length chunks without recording a chunk", () => {
    const sink = new RecordingAudioSink();
    sink.write(new Uint8Array(0));
    expect(sink.chunkCount).toBe(0);
    expect(sink.bytes).toBe(0);
  });

  test("copies on write so a reused backing buffer can't mutate retained audio", () => {
    const sink = new RecordingAudioSink();
    const reused = Uint8Array.from([9, 9]);
    sink.write(reused);
    reused[0] = 0;
    expect([...sink.chunks[0]!]).toEqual([9, 9]);
  });

  test("byte-capped ring: the oldest chunks are evicted once retained bytes exceed the cap", () => {
    const sink = new RecordingAudioSink({ maxRetainedBytes: 5 });
    sink.write(Uint8Array.from([1, 2, 3]));
    sink.write(Uint8Array.from([4, 5]));
    // Exactly at the cap: nothing evicted yet.
    expect(sink.bytes).toBe(5);
    expect(sink.chunkCount).toBe(2);

    sink.write(Uint8Array.from([6]));
    // Over the cap: the OLDEST chunk goes; the newest audio stays inspectable.
    expect(sink.chunks.map((chunk) => [...chunk])).toEqual([[4, 5], [6]]);
    expect(sink.bytes).toBe(3);
    expect(sink.chunkCount).toBe(2);
  });

  test("the default cap retains a long session's worth of small chunks unchanged", () => {
    const sink = new RecordingAudioSink();
    for (let index = 0; index < 100; index += 1) {
      sink.write(new Uint8Array(1_000));
    }
    // 100 KB is far below the ~16 MB default — nothing evicted.
    expect(sink.chunkCount).toBe(100);
    expect(sink.bytes).toBe(100_000);
  });
});
