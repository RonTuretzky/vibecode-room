import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProjectorRuntime,
  type ProjectorRuntime,
  type ProjectorRuntimeOptions,
} from "./composition";
import { createProjectorApp } from "./app";
import { RoomStateFile } from "./room-state";
import type { BuildBackend } from "../buildloop/types";
const roots: string[] = [];
const runtimes: ProjectorRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.buildOrchestrator.abortEverything();
    await runtime.executionRegistry.stopAll();
    await runtime.ideaBuilds.stopAll();
  }
  for (const dir of roots.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const env = {
  VIBERSYN_INITIAL_MUTED: "1",
  VIBERSYN_ASR_PROVIDER: "replay",
  VIBERSYN_IDEA_DETECTOR: "heuristic",
  VIBERSYN_DECISION_LLM: "heuristic",
  VIBERSYN_RESEARCH_SUGGESTER: "heuristic",
  VIBERSYN_RESEARCH_AGENT: "stub",
  VIBERSYN_TREE_GIT: "0",
  VIBERSYN_DETECT_TICK_MS: "0",
};
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "room-recovery-test-"));
  roots.push(root);
  let builds = 0;
  const backend: BuildBackend = {
    id: "native",
    label: "Fixture",
    available: async () => ({ ok: true }),
    async build(req) {
      builds++;
      await writeFile(
        join(req.outDir, "index.html"),
        "<!doctype html><h1>Recovered concept</h1>",
      );
      return { ok: true, entrypoint: "index.html", summary: "Working concept" };
    },
  };
  const options: ProjectorRuntimeOptions = {
    stateFile: join(root, "state.json"),
    buildsRoot: join(root, "builds"),
    executionArtifactsRoot: join(root, "runs"),
    treeGitRunner: null,
    resolveDeployFn: null,
    buildBackends: [backend],
  };
  const boot = async () => {
    const runtime = await createProjectorRuntime(env, options);
    runtimes.push(runtime);
    return runtime;
  };
  return { root, boot, options, count: () => builds };
}

test("restart restores project identity, preview, shared placement and seed without launching more work", async () => {
  const { boot, root, count } = await setup();
  const first = await boot();
  const spawn = await first.registry.spawn({
    workflow: "vibersyn-process",
    prompt: "A garden",
    callsign: "garden",
    correlationId: "test",
  });
  if (!spawn.accepted) throw new Error("spawn refused");
  const upid = spawn.process.upid;
  await first.buildOrchestrator.start({
    upid,
    ideaId: "idea",
    prompt: "A garden",
    callsign: "garden",
  });
  expect(first.setPlantPosition(upid, { x: 3, z: 4 })).toBe(true);
  const saved = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
  expect(saved.registry.records[0].upid).toBe(upid);
  const before = count();
  const second = await boot();
  const snapshot = second.snapshot();
  expect(count()).toBe(before);
  expect(snapshot.processes[0]?.upid).toBe(upid);
  expect(snapshot.plantedPositions?.[upid]).toEqual({ x: 3, z: 4 });
  expect(snapshot.recovery?.error).toBeNull();
  expect(snapshot.recovery?.restoredAtMs).not.toBeNull();
  const preview = snapshot.processes[0]!.previewUrl!;
  expect(await (await fetch(preview)).text()).toContain("Recovered concept");
  const app = createProjectorApp(second);
  expect(
    (
      await app.request(`/api/process/${upid}/position`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"x":8,"z":9}',
      })
    ).status,
  ).toBe(200);
  expect(second.snapshot().plantedPositions?.[upid]).toEqual({ x: 8, z: 9 });
  expect(
    (
      await app.request(`/api/process/${upid}/position`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"x":99999,"z":9}',
      })
    ).status,
  ).toBe(400);
});

test("unfinished concept work is recoverable and no agent restarts before retry", async () => {
  const { boot, root, count } = await setup();
  const first = await boot();
  const spawned = await first.registry.spawn({
    workflow: "vibersyn-process",
    prompt: "A garden",
    callsign: "garden",
    correlationId: "test",
  });
  if (!spawned.accepted) throw new Error("spawn");
  const upid = spawned.process.upid;
  await first.buildOrchestrator.start({
    upid,
    ideaId: "idea",
    prompt: "A garden",
    callsign: "garden",
  });
  first.publishNow();
  const path = join(root, "state.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  saved.builds[0].builds[0].status = "building";
  await writeFile(path, JSON.stringify(saved));
  const before = count();
  const second = await boot();
  expect(count()).toBe(before);
  expect(second.snapshot().recovery?.interrupted).toContain(upid);
  expect(second.snapshot().processes[0]?.recovery).toBe("interrupted");
  expect(await second.retryProject(upid)).toBe(true);
  const deadline = Date.now() + 2000;
  while (count() === before && Date.now() < deadline) await Bun.sleep(10);
  expect(count()).toBe(before + 1);
});

test("malformed state is preserved and the recovery error is visible", async () => {
  const { boot, root } = await setup();
  const path = join(root, "state.json");
  await writeFile(path, '{"version":999}');
  const runtime = await boot();
  expect(runtime.snapshot().recovery?.error).toContain("malformed");
  runtime.publishNow();
  expect(await readFile(path, "utf8")).toBe('{"version":999}');
});

test("cancelling work preserves the project and seed for an explicit retry", async () => {
  const { boot, count } = await setup();
  const runtime = await boot();
  const spawned = await runtime.registry.spawn({
    workflow: "vibersyn-process",
    prompt: "A garden",
    callsign: "garden",
    correlationId: "cancel",
  });
  if (!spawned.accepted) throw new Error("spawn");
  const upid = spawned.process.upid;
  await runtime.buildOrchestrator.start({
    upid,
    ideaId: "idea",
    prompt: "A garden",
    callsign: "garden",
  });
  const before = count();
  const app = createProjectorApp(runtime);
  runtime.setSteeringTarget(upid);
  expect(
    (await app.request(`/api/process/${upid}/cancel-work`, { method: "POST" }))
      .status,
  ).toBe(200);
  expect(runtime.steeringTarget()).toBeNull();
  expect(
    runtime.snapshot().processes.find((process) => process.upid === upid)
      ?.recovery,
  ).toBe("interrupted");
  expect(await runtime.retryProject(upid)).toBe(true);
  const deadline = Date.now() + 2000;
  while (count() === before && Date.now() < deadline) await Bun.sleep(10);
  expect(count()).toBe(before + 1);
});

test("offline demo controls cannot change live work or placement", async () => {
  const { boot, count } = await setup();
  const runtime = await boot();
  const spawned = await runtime.registry.spawn({
    workflow: "vibersyn-process",
    prompt: "A garden",
    callsign: "garden",
    correlationId: "demo",
  });
  if (!spawned.accepted) throw new Error("spawn");
  const upid = spawned.process.upid;
  runtime.setSteeringTarget(upid);
  const app = createProjectorApp(runtime);
  const before = count();
  for (const path of [
    "/api/process/select/cancel",
    `/api/process/${upid}/position`,
    `/api/process/${upid}/change`,
    `/api/process/${upid}/cancel-work`,
    `/api/process/${upid}/retry`,
  ]) {
    expect(
      (
        await app.request(path, {
          method: "POST",
          headers: {
            referer: "http://localhost/?live=0",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ x: 2, z: 3, text: "Change the garden" }),
        })
      ).status,
    ).toBe(409);
  }
  expect(runtime.steeringTarget()).toBe(upid);
  expect(count()).toBe(before);
  expect(runtime.snapshot().plantedPositions?.[upid]).toBeUndefined();
});

test("atomic state writer leaves an unreadable original untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "room-state-test-"));
  roots.push(root);
  const path = join(root, "room.json");
  await writeFile(path, "broken");
  const file = new RoomStateFile(path, () => true);
  expect(file.read()).toBeNull();
  file.write({ version: 1 });
  expect(await readFile(path, "utf8")).toBe("broken");
});
