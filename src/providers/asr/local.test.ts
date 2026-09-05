import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWhisperASR } from "./local";
import { MuteController } from "../../audio/mute-controller";

test("Stop flushes unsilenced local audio and waits until its final is consumed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "room-asr-flush-"));
  const python = join(dir, "fake-python");
  await writeFile(python, '#!/usr/bin/env python3\nimport sys, json, time\nfor line in sys.stdin:\n time.sleep(0.1)\n print(json.dumps({"text":"local mirror ready"}), flush=True)\n', { mode: 0o755 });
  const local = new LocalWhisperASR({ VIBERSYN_LOCAL_WHISPER_PYTHON: python }, "test");
  const mute = new MuteController({ sessionId: "test" });
  const provider = mute.protectCloudAsr(local);
  let input!: ReadableStreamDefaultController<Uint8Array>;
  const audio = new ReadableStream<Uint8Array>({ start(controller) { input = controller; } });
  const iterator = provider.stream(audio)[Symbol.asyncIterator]();
  try {
    const next = iterator.next();
    const pcm = Buffer.alloc(6400);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
    input.enqueue(pcm);
    await Bun.sleep(30);
    let settled = false;
    const flushed = provider.finishUtterance!().then(() => { settled = true; });
    const observed = await next;
    expect(observed.value?.text).toBe("local mirror ready");
    expect(settled).toBe(false); // a yielded final still needs ingestion
    input.close();
    await iterator.next();
    await flushed;
    expect(settled).toBe(true);
  } finally {
    await iterator.return?.();
    mute.close();
    await rm(dir, { recursive: true, force: true });
  }
});
