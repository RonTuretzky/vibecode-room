import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreviewServer } from "../server/idea-builder";
import { ExecutionRegistry } from "./execution";

// Commission-stage execution lanes: executing (percent/label from run events)
// -> built with the artifacts preview once the durable run completes, failed
// when the run left no artifacts. Preview serving is a fake seam — no port.

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
  tempDirs.length = 0;
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vibersyn-exec-"));
  tempDirs.push(dir);
  return dir;
}

function fakeServe(): { serve: (dir: string) => Promise<PreviewServer>; served: string[]; stops: number } {
  const state = {
    served: [] as string[],
    stops: 0,
    serve: async (dir: string): Promise<PreviewServer> => {
      state.served.push(dir);
      return {
        port: 4242,
        stop: async () => {
          state.stops += 1;
        },
      };
    },
  };
  return state;
}

describe("ExecutionRegistry", () => {
  test("start opens an executing lane; progress folds run-event percent/label, capped below built", async () => {
    const root = await tempRoot();
    const updates: number[] = [];
    let tick = 0;
    const registry = new ExecutionRegistry({
      artifactsRoot: root,
      serve: fakeServe().serve,
      now: () => 1_000,
      onUpdate: () => updates.push(++tick),
    });

    expect(registry.snapshot("upid-1")).toBeNull();
    const lane = registry.start("upid-1", "vibersyn-upid-1");
    expect(lane).toEqual({
      status: "executing",
      runId: "vibersyn-upid-1",
      percent: 0,
      label: "commissioned",
      previewUrl: null,
      startedAtMs: 1_000,
      error: null,
    });

    registry.progress("upid-1", { percent: 36, label: "writing index.html" });
    expect(registry.snapshot("upid-1")).toMatchObject({ percent: 36, label: "writing index.html" });
    // Progress never claims done while executing, and never regresses.
    registry.progress("upid-1", { percent: 200 });
    expect(registry.snapshot("upid-1")?.percent).toBe(99);
    registry.progress("upid-1", { percent: 10 });
    expect(registry.snapshot("upid-1")?.percent).toBe(99);
    expect(updates.length).toBeGreaterThanOrEqual(3);
  });

  test("complete with artifacts serves the run directory and flips to built with a previewUrl", async () => {
    const root = await tempRoot();
    const serving = fakeServe();
    const registry = new ExecutionRegistry({ artifactsRoot: root, serve: serving.serve });
    await mkdir(join(root, "upid-2"), { recursive: true });
    await writeFile(join(root, "upid-2", "index.html"), "<html>the real app</html>", "utf8");

    registry.start("upid-2", "run-2");
    const lane = await registry.complete("upid-2");

    expect(lane).toMatchObject({ status: "built", percent: 100, label: "built", error: null });
    expect(lane?.previewUrl).toBe("http://127.0.0.1:4242/?v=1");
    expect(serving.served).toEqual([join(root, "upid-2")]);
    expect(registry.isExecuting("upid-2")).toBe(false);

    // Idempotent: a replayed completion frame never starts a second server.
    await registry.complete("upid-2");
    expect(serving.served).toHaveLength(1);
  });

  test("complete with no artifacts fails the lane honestly", async () => {
    const root = await tempRoot();
    const serving = fakeServe();
    const registry = new ExecutionRegistry({ artifactsRoot: root, serve: serving.serve });

    registry.start("upid-3", "run-3");
    const lane = await registry.complete("upid-3");

    expect(lane?.status).toBe("failed");
    expect(lane?.previewUrl).toBeNull();
    expect(lane?.error).toContain("index.html");
    expect(serving.served).toHaveLength(0);
  });

  test("stop tears the preview down and forgets the lane (halt / emergency semantics)", async () => {
    const root = await tempRoot();
    const serving = fakeServe();
    const registry = new ExecutionRegistry({ artifactsRoot: root, serve: serving.serve });
    await mkdir(join(root, "upid-4"), { recursive: true });
    await writeFile(join(root, "upid-4", "index.html"), "<html>x</html>", "utf8");
    registry.start("upid-4", "run-4");
    await registry.complete("upid-4");

    await registry.stop("upid-4");
    expect(serving.stops).toBe(1);
    expect(registry.snapshot("upid-4")).toBeNull();

    // stopAll covers whatever lanes remain.
    registry.start("upid-5", "run-5");
    await registry.stopAll();
    expect(registry.snapshot("upid-5")).toBeNull();
  });

  test("fail marks an executing lane failed and progress stops folding in", async () => {
    const root = await tempRoot();
    const registry = new ExecutionRegistry({ artifactsRoot: root, serve: fakeServe().serve });
    registry.start("upid-6", "run-6");
    registry.fail("upid-6", "gateway stream died");
    expect(registry.snapshot("upid-6")).toMatchObject({ status: "failed", error: "gateway stream died" });
    registry.progress("upid-6", { percent: 50 });
    expect(registry.snapshot("upid-6")?.percent).toBe(0);
  });

  test("artifactsDir sanitizes the UPID into a safe path segment", async () => {
    const root = await tempRoot();
    const registry = new ExecutionRegistry({ artifactsRoot: root, serve: fakeServe().serve });
    expect(registry.artifactsDir("upid-7")).toBe(join(root, "upid-7"));
    expect(registry.artifactsDir("../evil")).toBe(join(root, "---evil"));
  });
});
