import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalExecutionTransport } from "./local-execution";
import { runCommand } from "../process/run-command";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function root() {
  const dir = await mkdtemp(join(tmpdir(), "room-local-execution-"));
  dirs.push(dir);
  return dir;
}
const launch = (t: LocalExecutionTransport) =>
  t.request("launchRun", {
    workflow: "vibersyn-process",
    input: { upid: "test", prompt: "Build an app" },
    options: { runId: "run-test" },
  });
async function settled(t: LocalExecutionTransport) {
  for (let i = 0; i < 100; i++) {
    const r = (await t.request("getRun", { runId: "run-test" })) as any;
    if (!["running", "paused"].includes(r.status)) return r;
    await Bun.sleep(10);
  }
  throw new Error("Run did not settle");
}

test("commission creates real artifacts and durable, replayable completion events", async () => {
  const dir = await root();
  let calls = 0;
  const t = new LocalExecutionTransport(
    {},
    {
      artifactsRoot: dir,
      agent: async (out) => {
        calls++;
        await writeFile(join(out, "index.html"), "<h1>Working app</h1>");
        return "Built app";
      },
    },
  );
  await launch(t);
  await launch(t);
  expect((await settled(t)).status).toBe("completed");
  expect(calls).toBe(1);
  expect(await readFile(join(dir, "test/index.html"), "utf8")).toContain(
    "Working app",
  );
  const frames = [];
  for await (const frame of t.streamRunEvents("run-test")) frames.push(frame);
  expect(frames.at(-1)?.event).toBe("run.completed");
  const restored = new LocalExecutionTransport({}, { artifactsRoot: dir });
  expect(
    ((await restored.request("getRun", { runId: "run-test" })) as any).status,
  ).toBe("completed");
});

test("partial files never turn a failed local agent into a successful commission", async () => {
  const dir = await root();
  const t = new LocalExecutionTransport(
    {},
    {
      artifactsRoot: dir,
      agent: async (out) => {
        await writeFile(join(out, "index.html"), "partial");
        throw new Error("Model disconnected");
      },
    },
  );
  await launch(t);
  const run = await settled(t);
  expect(run.status).toBe("failed");
  expect(run.error).toContain("Model disconnected");
});

test("cancel aborts the local agent and restores as a cancelled run", async () => {
  const dir = await root();
  let aborted = false;
  const t = new LocalExecutionTransport(
    {},
    {
      artifactsRoot: dir,
      agent: async (_out, _request, options) => {
        await new Promise<void>((_, reject) => {
          const stop = () => {
            aborted = true;
            reject(new Error("aborted"));
          };
          if (options.signal.aborted) stop();
          else options.signal.addEventListener("abort", stop, { once: true });
        });
        return "unreachable";
      },
    },
  );
  await launch(t);
  await Bun.sleep(20);
  await t.request("cancelRun", { runId: "run-test" });
  await Bun.sleep(20);
  expect(aborted).toBe(true);
  expect((await settled(t)).status).toBe("cancelled");
});

test("pause/resume and steering reach the agent at its checkpoint", async () => {
  const dir = await root();
  let enter!: () => void;
  const gate = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let messages: string[] = [];
  const t = new LocalExecutionTransport(
    {},
    {
      artifactsRoot: dir,
      agent: async (out, _request, opts) => {
        await gate;
        messages = await opts.checkpoint!();
        await writeFile(join(out, "index.html"), "done");
        return "done";
      },
    },
  );
  await launch(t);
  await t.request("submitSignal", { runId: "run-test", signalName: "pause" });
  await t.request("submitSignal", {
    runId: "run-test",
    signalName: "steer",
    payload: "Make it blue",
  });
  enter();
  expect(
    ((await t.request("getRun", { runId: "run-test" })) as any).status,
  ).toBe("paused");
  await t.request("submitSignal", { runId: "run-test", signalName: "resume" });
  expect((await settled(t)).status).toBe("completed");
  expect(messages).toEqual(["Make it blue"]);
});

test("an interrupted journal restores as failed with a retry explanation", async () => {
  const dir = await root();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, ".local-runs"));
  await writeFile(
    join(dir, ".local-runs/run-test.json"),
    JSON.stringify({
      id: "run-test",
      status: "running",
      error: null,
      frames: [],
    }),
  );
  const t = new LocalExecutionTransport({}, { artifactsRoot: dir });
  const run = (await t.request("getRun", { runId: "run-test" })) as any;
  expect(run.status).toBe("failed");
  expect(run.error).toContain("restart");
});

test("local self-edit checks out isolated work and commits new files before advancing the clean room", async () => {
  const repo = await root();
  const artifacts = await root();
  const signal = AbortSignal.timeout(15_000);
  const git = (args: string[]) =>
    runCommand(["git", "-c", "commit.gpgsign=false", ...args], repo, signal);
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Room test"]);
  await git(["config", "user.email", "room-test@example.test"]);
  await writeFile(join(repo, "index.html"), "before");
  await git(["add", "."]);
  await git(["commit", "-m", "seed"]);
  const t = new LocalExecutionTransport(
    {},
    {
      roomRoot: repo,
      artifactsRoot: artifacts,
      agent: async (out) => {
        expect(out).not.toBe(repo);
        expect(await readFile(join(repo, "index.html"), "utf8")).toBe("before");
        await writeFile(join(out, "index.html"), "after");
        await writeFile(join(out, "new.js"), "console.log('new')");
        return "Updated";
      },
    },
  );
  await t.request("launchRun", {
    workflow: "vibersyn-self",
    input: { upid: "self", instruction: "Add a helper" },
    options: { runId: "run-test" },
  });
  expect((await settled(t)).status).toBe("completed");
  expect(await git(["status", "--porcelain"])).toBe("");
  expect(await git(["show", "HEAD:new.js"])).toContain("new");
  expect(await git(["log", "-1", "--format=%s"])).toContain("self:");
});
