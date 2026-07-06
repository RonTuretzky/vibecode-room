import { describe, expect, test } from "bun:test";
import { MemoryCheckpointStore, MemoryContextArchiveStore, ProcessLifecycle } from "./lifecycle";

describe("process lifecycle", () => {
  test("AC15.2 enforces planning -> active <-> paused -> dead edges", async () => {
    const checkpoints = new MemoryCheckpointStore();
    const archive = new MemoryContextArchiveStore();
    const lifecycle = new ProcessLifecycle({
      upid: "upid-life",
      runId: "run-life",
      checkpoints,
      archive,
      context: { seed: "start" },
      now: () => 1_000,
    });

    expect(lifecycle.snapshot()).toEqual(expect.objectContaining({ state: "planning" }));
    await expect(lifecycle.pause()).rejects.toThrow(/Invalid process lifecycle edge planning -> paused/u);

    await lifecycle.activate({ phase: "work" });
    expect(lifecycle.snapshot()).toEqual(expect.objectContaining({ state: "active" }));

    await lifecycle.pause({ reason: "voice" });
    expect(lifecycle.snapshot()).toEqual(expect.objectContaining({ state: "paused" }));

    await lifecycle.resume({ reason: "voice" });
    expect(lifecycle.snapshot()).toEqual(expect.objectContaining({ state: "active" }));

    await lifecycle.kill({ reason: "panic" });
    expect(lifecycle.snapshot()).toEqual(expect.objectContaining({ state: "dead" }));
    await expect(lifecycle.resume()).rejects.toThrow(/Invalid process lifecycle edge dead -> active/u);
  });

  test("AC15.2 archives context before kill", async () => {
    const archive = new MemoryContextArchiveStore();
    const lifecycle = new ProcessLifecycle({
      upid: "upid-archive",
      runId: "run-archive",
      archive,
      context: { currentFile: "src/process/registry.ts", intent: "preserve before kill" },
    });

    await lifecycle.activate();
    const preKill = lifecycle.snapshot();
    await lifecycle.kill({ killed: true });

    const archived = await archive.load("upid-archive");
    expect(archived).toEqual(
      expect.objectContaining({
        upid: "upid-archive",
        runId: "run-archive",
        snapshot: preKill,
      }),
    );
    expect(archived?.snapshot.state).toBe("active");
  });

  test("AC15.3 recovery reloads exactly the last durable checkpoint", async () => {
    const checkpoints = new MemoryCheckpointStore();
    const initial = new ProcessLifecycle({
      upid: "upid-recover",
      runId: "run-recover",
      checkpoints,
      context: { seed: "recoverable" },
      now: () => 2_000,
    });

    await initial.activate();
    const beforeRestart = await initial.checkpoint({ durable: true, value: 42 });

    const recovered = new ProcessLifecycle({
      upid: "upid-recover",
      runId: "run-recover",
      checkpoints,
      context: { seed: "lost local memory" },
      now: () => 9_000,
    });
    const afterRestart = await recovered.recover();

    expect(afterRestart).toEqual(beforeRestart);
    expect(recovered.snapshot()).toEqual(beforeRestart);
  });
});
