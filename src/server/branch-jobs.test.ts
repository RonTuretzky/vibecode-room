import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BranchJobs, runBranchCommand, type BranchAgent } from "./branch-jobs";
import { TreeGitSubstrate } from "./tree-git";
const roots: string[] = [];
const controllers: BranchJobs[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((jobs) => jobs.stop()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(agent: BranchAgent) {
  const root = await mkdtemp(join(tmpdir(), "room-branch-test-"));
  roots.push(root);
  const repo = join(root, "project", "repo");
  await mkdir(repo, { recursive: true });
  const git = (args: string[]) =>
    runBranchCommand(["git", ...args], repo, new AbortController().signal, {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
    });
  await git(["init", "-b", "main"]);
  await writeFile(
    join(repo, "index.html"),
    "<!doctype html><title>Garden</title><h1>Garden</h1>",
  );
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-m",
    "seed",
  ]);
  await git(["branch", "room/change"]);
  await git(["branch", "room/other"]);
  const substrate = new TreeGitSubstrate({ buildsRoot: root });
  substrate.adopt("project", "https://github.com/test/garden");
  const jobs = new BranchJobs({
    root,
    git: substrate,
    env: {},
    agent,
    onUpdate() {},
  });
  controllers.push(jobs);
  return { root, repo, git, jobs, substrate };
}

test("agent changes commit to their branch, preserve another branch and the checkout, and serve a working preview", async () => {
  const { jobs, git, repo } = await fixture(async (dir) => {
    await writeFile(
      join(dir, "index.html"),
      "<!doctype html><title>Garden</title><button onclick=\"document.body.dataset.theme='dark'\">Dark mode</button>",
    );
  });
  const job = await jobs.run("project", "room/change", "Add dark mode");
  expect(job.status).toBe("ready");
  expect(job.files).toEqual(["index.html"]);
  expect(job.checks).toContain("git diff --check");
  expect(await git(["show", "room/change:index.html"])).toContain("Dark mode");
  expect(await git(["show", "room/other:index.html"])).not.toContain(
    "Dark mode",
  );
  expect(await readFile(join(repo, "index.html"), "utf8")).not.toContain(
    "Dark mode",
  );
  expect(await (await fetch(job.previewUrl!)).text()).toContain("Dark mode");
  expect((await fetch(new URL("/.git/config", job.previewUrl!))).status).toBe(
    404,
  );
  expect(
    (
      await fetch(new URL("/api/emergency-stop", job.previewUrl!), {
        method: "POST",
      })
    ).status,
  ).toBe(403);
}, 15_000);

test("a graft starts from the previous branch commit, not the original checkout", async () => {
  const { jobs, git } = await fixture(async (dir, request) => {
    await writeFile(join(dir, request + ".txt"), request);
  });
  await jobs.run("project", "room/change", "first");
  await jobs.run("project", "room/change", "second");
  expect(await git(["show", "room/change:first.txt"])).toBe("first");
  expect(await git(["show", "room/change:second.txt"])).toBe("second");
  expect(await git(["rev-list", "--count", "main..room/change"])).toBe("2\n");
}, 15_000);

test("failed validation leaves the branch unchanged and retry creates a separate successful attempt", async () => {
  let attempts = 0;
  const { jobs, git } = await fixture(async (dir) => {
    await writeFile(join(dir, "feature.txt"), "feature");
    await writeFile(join(dir, "bun.lock"), "");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: { test: ++attempts === 1 ? "exit 1" : "exit 0" },
      }),
    );
  });
  const before = await git(["rev-parse", "room/change"]);
  const failed = await jobs.run("project", "room/change", "Feature");
  expect(failed.status).toBe("failed");
  expect(await git(["rev-parse", "room/change"])).toBe(before);
  const retry = await jobs.retry(failed.id);
  expect(retry?.status).toBe("ready");
  expect(retry?.id).not.toBe(failed.id);
  expect(retry?.checks).toContain("bun run test");
}, 15_000);

test("no-op agents fail honestly without creating a notes commit", async () => {
  const { jobs, git } = await fixture(async () => {});
  const job = await jobs.run("project", "room/change", "Do something");
  expect(job.status).toBe("failed");
  expect(job.error).toContain("no changes");
  expect(await git(["rev-list", "--count", "main..room/change"])).toBe("0\n");
}, 15_000);

test("recovering an existing branch never rewinds its unrecorded commit", async () => {
  const { root, repo, jobs, git } = await fixture(async (dir) => {
    await writeFile(join(dir, "feature.txt"), "preserved");
  });
  await jobs.run("project", "room/change", "Feature");
  await git(["remote", "add", "origin", repo]);
  const before = await git(["rev-parse", "room/change"]);
  const restored = new TreeGitSubstrate({ buildsRoot: root });
  restored.adopt("project", "https://github.com/test/garden");
  expect((await restored.createBranch("project", "change")).ok).toBe(true);
  expect(await git(["rev-parse", "room/change"])).toBe(before);
}, 15_000);

test("an external branch update during implementation is preserved", async () => {
  let advance!: () => Promise<void>;
  const { jobs, git } = await fixture(async (dir) => {
    await writeFile(join(dir, "feature.txt"), "agent change");
    await advance();
  });
  let external = "";
  advance = async () => {
    external = (
      await git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit-tree",
        "main^{tree}",
        "-p",
        "main",
        "-m",
        "external update",
      ])
    ).trim();
    await git(["update-ref", "refs/heads/room/change", external]);
  };
  const job = await jobs.run("project", "room/change", "Feature");
  expect(job.status).toBe("failed");
  expect(job.error).toContain("branch changed");
  expect((await git(["rev-parse", "room/change"])).trim()).toBe(external);
}, 15_000);

test("a first concept branch can use main as its parent without replacing main", async () => {
  const { root, substrate } = await fixture(async () => {});
  await substrate.birth("concept", {
    ideaId: "idea",
    pitch: "Garden",
    callsign: "garden",
  });
  const lane = join(root, "concept", "native");
  await mkdir(lane, { recursive: true });
  await writeFile(join(lane, "index.html"), "<h1>New concept</h1>");
  await substrate.commitLane("concept", "native", lane, "concept ready");
  const dir = join(root, "concept", ".tree");
  const git = (args: string[]) =>
    runBranchCommand(["git", ...args], dir, new AbortController().signal);
  expect(await git(["show", "concept/native:index.html"])).toContain(
    "New concept",
  );
  expect(await git(["rev-parse", "concept/native^"])).toBe(
    await git(["rev-parse", "main"]),
  );
}, 15_000);

test("cancelling an active subprocess and a queued request never commits either", async () => {
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const { jobs, git } = await fixture(async (dir, request, signal) => {
    signalStarted();
    await runBranchCommand(
      ["sh", "-c", "sleep 30; echo late > late.txt"],
      dir,
      signal,
    );
  });
  const first = jobs.run("project", "room/change", "slow");
  await started;
  const second = jobs.run("project", "room/other", "queued");
  for (const job of jobs.snapshot()) expect(jobs.cancel(job.id)).toBe(true);
  expect((await first).status).toBe("cancelled");
  expect((await second).status).toBe("cancelled");
  expect(await git(["rev-list", "--count", "main..room/change"])).toBe("0\n");
}, 10_000);

test("restart restores completed previews and marks unfinished work interrupted without invoking the agent", async () => {
  const { root, substrate, jobs } = await fixture(async (dir) => {
    await writeFile(join(dir, "feature.txt"), "feature");
  });
  const ready = await jobs.run("project", "room/change", "Feature");
  await jobs.stop();
  let calls = 0;
  const restored = new BranchJobs({
    root,
    git: substrate,
    env: {},
    onUpdate() {},
    agent: async () => {
      calls++;
    },
  });
  controllers.push(restored);
  await restored.restore([
    ready,
    {
      ...ready,
      id: "pending",
      workspace: join(root, "project", ".branch-jobs", "pending"),
      previewDir: null,
      status: "implementing",
    },
  ]);
  expect(calls).toBe(0);
  expect(restored.jobs.get("pending")?.status).toBe("interrupted");
  expect((await fetch(restored.jobs.get(ready.id)!.previewUrl!)).status).toBe(
    200,
  );
}, 15_000);
