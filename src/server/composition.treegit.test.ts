import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime, type ProjectorRuntimeOptions } from "./composition";
import type { GitCommandRunner } from "./tree-git";
import type { ForestCommandRunner } from "./github-org";
import type { GatewayRpcTransport } from "../seam/smithers-client";
import type { BuildBackend, BuildRequest, BuildResult } from "../buildloop/types";
import type { TranscriptObservation } from "../types";

// End-to-end wiring of the GIT SUBSTRATE the composition owns:
//   - accept → orchestrator birth → `git init` under builds/<upid>/.tree and a
//     concept/<backend> lane commit once the mock lands, all surfaced as the
//     snapshot's processes[].treeRepo (branch → session commit count);
//   - VIBERSYN_TREE_GIT=0 kill-switch → substrate off, zero runner calls;
//   - executeProcess (commission) → the publish sequence (PRIVATE gh repo
//     create → push → draft PR per concept branch) and treeRepo.remoteUrl;
//   - GitHub import (fake clone creating repo/.git) → ADOPTED: zero init,
//     remoteUrl = the import's own URL;
//   - SELF mode → the pinned mirror process never touches the substrate.
// Runners are scripted fakes — NO test here ever spawns a real git or gh.

const BUILDABLE = "let's build a dashboard tool to ship the replay prototype today";

class FakeBackend implements BuildBackend {
  readonly id = "native" as const;
  readonly label = "Fake Native";
  async available(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }
  async build(req: BuildRequest): Promise<BuildResult> {
    await Bun.write(join(req.outDir, "index.html"), "<html><body>the mock</body></html>");
    req.onProgress({ label: "ready", percent: 100 });
    return { ok: true, entrypoint: "index.html", summary: "A fake mock, built instantly." };
  }
}

// Scripted git: enough plumbing semantics (refs for parent resolution, unique
// tree/commit shas) for birth + lane commits to succeed; records every argv.
function scriptedGit(): { calls: string[][]; run: GitCommandRunner } {
  const calls: string[][] = [];
  const refs = new Map<string, string>();
  let seq = 0;
  const run: GitCommandRunner = async (argv) => {
    calls.push(argv);
    const positional: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index]!;
      if (arg === "-c") {
        index += 1;
        continue;
      }
      if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
        continue;
      }
      positional.push(arg);
    }
    switch (positional[0]) {
      case "init":
      case "symbolic-ref":
      case "add":
      case "remote":
      case "push":
        return { ok: true, stdout: "", stderr: "" };
      case "write-tree":
        seq += 1;
        return { ok: true, stdout: `tree-${seq}`, stderr: "" };
      case "commit-tree":
        seq += 1;
        return { ok: true, stdout: `commit-${seq}`, stderr: "" };
      case "update-ref":
        refs.set(positional[1]!, positional[2]!);
        return { ok: true, stdout: "", stderr: "" };
      case "rev-parse": {
        const target = positional[positional.length - 1]!;
        if (target.endsWith("^{tree}")) {
          return { ok: true, stdout: `tree-of-${target}`, stderr: "" };
        }
        const sha = refs.get(target);
        return sha === undefined ? { ok: false, stdout: "", stderr: "" } : { ok: true, stdout: sha, stderr: "" };
      }
      case "for-each-ref":
        return { ok: true, stdout: "", stderr: "" };
      case "rev-list":
        return { ok: true, stdout: "1", stderr: "" };
      default:
        return { ok: false, stdout: "", stderr: `unscripted: ${positional[0]}` };
    }
  };
  return { calls, run };
}

function scriptedGh(): { calls: string[][]; run: ForestCommandRunner } {
  const calls: string[][] = [];
  const run: ForestCommandRunner = async (argv) => {
    calls.push(argv);
    if (argv[1] === "repo" && argv[2] === "create") {
      return { ok: true, stdout: `https://github.com/roomowner/${argv[3]}\n`, stderr: "" };
    }
    if (argv[1] === "pr" && argv[2] === "create") {
      return { ok: true, stdout: "https://github.com/roomowner/x/pull/1\n", stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "unscripted gh" };
  };
  return { calls, run };
}

const tempDirs: string[] = [];
let runtimes: ProjectorRuntime[] = [];
let priorCapacityGuard: string | undefined;

beforeEach(() => {
  priorCapacityGuard = process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
  process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = "1";
});

afterEach(async () => {
  if (priorCapacityGuard === undefined) {
    delete process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
  } else {
    process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = priorCapacityGuard;
  }
  for (const runtime of runtimes) {
    await runtime.buildOrchestrator.abortEverything().catch(() => undefined);
    await runtime.ideaBuilds.stopAll().catch(() => undefined);
  }
  runtimes = [];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

async function makeRuntime(
  options: ProjectorRuntimeOptions & { env?: Record<string, string> } = {},
): Promise<{ runtime: ProjectorRuntime; buildsRoot: string }> {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-treegit-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, "", "utf8");
  const { env, ...runtimeOptions } = options;
  const buildsRoot = join(dir, "builds");
  const runtime = await createProjectorRuntime(
    {
      VIBERSYN_INITIAL_MUTED: "0",
      VIBERSYN_MIC_REPLAY_PATH: path,
      VIBERSYN_IDEA_DETECTOR: "heuristic",
      VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
      VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
      VIBERSYN_DETECT_TICK_MS: "0",
      ...env,
    },
    // resolveDeployFn defaults NULL here (same idiom as treeGitRunner): a
    // github import with the real resolver would HEAD-probe hosts / spawn gh.
    { buildsRoot, executionArtifactsRoot: join(dir, "vibersyn-runs"), resolveDeployFn: null, ...runtimeOptions },
  );
  runtimes.push(runtime);
  runtimePaths.set(runtime, path);
  return { runtime, buildsRoot };
}

const runtimePaths = new Map<ProjectorRuntime, string>();

async function drive(runtime: ProjectorRuntime, observations: TranscriptObservation[]): Promise<void> {
  const path = runtimePaths.get(runtime);
  if (path === undefined) {
    throw new Error("drive() called for a runtime makeRuntime did not create");
  }
  writeFileSync(path, observations.map((observation) => JSON.stringify(observation)).join("\n"), "utf8");
  const session = runtime.startMicSession("corr-treegit-mic");
  await session.stop();
  await runtime.detection.flush();
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "treegit-test", latencyMs: 0, utteranceId };
}

async function kickoff(runtime: ProjectorRuntime): Promise<string> {
  await drive(runtime, [final(BUILDABLE, "utt-build")]);
  await runtime.acceptPendingSuggestion("corr-treegit-accept");
  const upid = runtime.snapshot().processes[0]?.upid;
  if (upid === undefined) {
    throw new Error("kickoff spawned no process");
  }
  await waitFor(() => runtime.registry.builds(upid).some((build) => build.status === "ready"));
  return upid;
}

describe("git substrate wiring — birth + lane commits on accept", () => {
  test("an accepted idea inits builds/<upid>/.tree and the snapshot carries treeRepo (main + concept/native)", async () => {
    const git = scriptedGit();
    const { runtime, buildsRoot } = await makeRuntime({ buildBackends: [new FakeBackend()], treeGitRunner: git.run });
    const upid = await kickoff(runtime);

    // Birth ran against the tree's OWN gitdir — never the lane dirs, never repo/.
    await waitFor(() => git.calls.some((argv) => argv[0] === "init"));
    const init = git.calls.find((argv) => argv[0] === "init")!;
    expect(init[init.length - 1]).toBe(join(buildsRoot, upid, ".tree"));

    // The ready mock landed one commit on concept/native; the snapshot's
    // treeRepo (pure in-memory) reflects both branches with session counts.
    await waitFor(() => (runtime.snapshot().processes[0]?.treeRepo?.branches.length ?? 0) >= 2);
    const treeRepo = runtime.snapshot().processes[0]!.treeRepo!;
    expect(treeRepo).toEqual({
      branches: [
        { name: "main", commits: 1 },
        { name: "concept/native", commits: 1 },
      ],
      remoteUrl: null,
    });
  });

  test("VIBERSYN_TREE_GIT=0 kills the substrate: zero runner calls, treeRepo null", async () => {
    const git = scriptedGit();
    const { runtime } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      env: { VIBERSYN_TREE_GIT: "0" },
    });
    const upid = await kickoff(runtime);

    expect(git.calls).toHaveLength(0);
    expect(runtime.snapshot().processes.find((process) => process.upid === upid)?.treeRepo).toBeNull();
  });
});

describe("git substrate wiring — commission publish", () => {
  test("executeProcess fires the publish sequence; the snapshot carries treeRepo.remoteUrl + one draft PR per lane", async () => {
    const git = scriptedGit();
    const gh = scriptedGh();
    const { runtime } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      treeGhRunner: gh.run,
    });
    const upid = await kickoff(runtime);
    // The lane commit must land before commission so publish sees the branch.
    await waitFor(() => (runtime.snapshot().processes[0]?.treeRepo?.branches.length ?? 0) >= 2);

    const executed = await runtime.executeProcess(upid, "corr-treegit-commission");
    expect(executed.ok).toBe(true);

    await waitFor(() => gh.calls.some((argv) => argv[1] === "pr" && argv[2] === "create"));
    const create = gh.calls.find((argv) => argv[1] === "repo" && argv[2] === "create")!;
    expect(create).toContain("--private");
    const slug = create[3]!;
    // The push went through gh's credential helper — never a PAT in argv.
    const push = git.calls.find((argv) => argv.includes("push"))!;
    expect(push).toContain("credential.helper=!gh auth git-credential");
    const pr = gh.calls.find((argv) => argv[1] === "pr" && argv[2] === "create")!;
    expect(pr.join(" ")).toContain("--head concept/native");
    expect(pr).toContain("--draft");

    await waitFor(() => runtime.snapshot().processes[0]?.treeRepo?.remoteUrl !== null);
    expect(runtime.snapshot().processes[0]!.treeRepo!.remoteUrl).toBe(`https://github.com/roomowner/${slug}`);
  });

  test("publishTreeRepo is the explicit path: refuses when disabled, publishes when wired", async () => {
    const disabled = await makeRuntime({ buildBackends: [new FakeBackend()], treeGitRunner: null });
    const refused = await disabled.runtime.publishTreeRepo("upid-1");
    expect(refused).toEqual({ ok: false, error: "tree git substrate is disabled" });

    const git = scriptedGit();
    const gh = scriptedGh();
    const { runtime } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      treeGhRunner: gh.run,
    });
    const upid = await kickoff(runtime);
    const result = await runtime.publishTreeRepo(upid);
    if (!result.ok) {
      throw new Error(`publish refused: ${result.error}`);
    }
    expect(result.url).toMatch(/^https:\/\/github\.com\/roomowner\//u);
  });
});

describe("git substrate wiring — GitHub imports adopt their clone", () => {
  test("a cloned import records its origin as remoteUrl and NEVER git-inits", async () => {
    const git = scriptedGit();
    const { runtime } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      // The fake clone creates repo/.git exactly like a real checkout would.
      cloneRepoFn: async ({ dir }) => {
        await mkdir(join(dir, ".git"), { recursive: true });
        return { ok: true, dir };
      },
      repoDigestFn: async () => "digest: fake repo",
    });

    const imported = await runtime.importProject("https://github.com/acme/widget", "corr-treegit-import");
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    // The post-clone fan-out births — and the substrate self-detects the
    // clone, flips to ADOPTED, and refuses all local git work.
    await waitFor(() => runtime.snapshot().processes[0]?.treeRepo?.remoteUrl != null);
    const process = runtime.snapshot().processes.find((entry) => entry.upid === imported.upid)!;
    expect(process.treeRepo!.remoteUrl).toContain("github.com/acme/widget");
    expect(process.treeRepo!.branches).toEqual([]);
    await waitFor(() => runtime.registry.builds(imported.upid).some((build) => build.status === "ready"));
    expect(git.calls.filter((argv) => argv[0] === "init")).toHaveLength(0);
    // Adopted mode also refuses the commission publish (origin IS the remote).
    const published = await runtime.publishTreeRepo(imported.upid);
    expect(published.ok).toBe(false);
  });
});

describe("git substrate wiring — SELF exclusion", () => {
  test("the pinned mirror process never touches the substrate (pin + steer → zero runner calls)", async () => {
    const git = scriptedGit();
    const gh = scriptedGh();
    const transport: GatewayRpcTransport = {
      async request() {
        return {};
      },
    };
    const { runtime } = await makeRuntime({
      buildBackends: [],
      treeGitRunner: git.run,
      treeGhRunner: gh.run,
      smithersTransport: transport,
      publishDeck: null,
      selfGitHead: async () => ({ sha: "sha-prior", subject: "prior commit" }),
      exitProcess: () => undefined,
      env: { VIBERSYN_SELF_MODE: "1", VIBERSYN_RUN_POLL_MS: "1000" },
    });

    const self = runtime.snapshot().processes.find((process) => process.upid === "self");
    expect(self).toBeDefined();
    expect(self!.treeRepo).toBeNull();

    await runtime.registry.steer("self", { text: "tighten the deck copy" }, "corr-treegit-self-steer");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(git.calls).toHaveLength(0);
    expect(gh.calls).toHaveLength(0);
  });
});
