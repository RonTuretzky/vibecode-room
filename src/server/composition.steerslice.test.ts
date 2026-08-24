import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorApp } from "./app";
import { createProjectorRuntime, type ProjectorRuntime, type ProjectorRuntimeOptions, STEER_GRACE_MS, slugFromSpeech } from "./composition";
import type { GitCommandRunner } from "./tree-git";
import type { ForestCommandRunner } from "./github-org";
import type { BuildBackend, BuildRequest, BuildResult } from "../buildloop/types";
import type { TranscriptObservation } from "../types";

// The record-toggle demo beat, end to end over seams (NO real git/gh ever):
//   - POST /api/process/:upid/select {branch} → steeringBranch on the snapshot,
//     cleared with the target;
//   - steering an ADOPTED tree collects the FINAL transcript slice
//     (toggle-on→toggle-off exactly, trailing 60s) and the CLEAR fires the
//     steer applier: ROOM-NOTES.md + a REAL commit on the room/<slug> branch
//     (explicit steeringBranch → latest room/* → fresh room/spoken-changes);
//   - the pre-existing per-final registry.steer routing stays untouched;
//   - VIBERSYN_STEER_APPLIER=0 disables the pipeline; local trees never fire;
//   - GET /api/process/:upid/issues serves the adopted origin's open issues in
//     the exact UI contract shape, cached, {issues: []} on everything else.

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

// Scripted git covering the adopted-tree branch rails: fetch/FETCH_HEAD for
// createBranch, refs + detached-index plumbing for commitBranch.
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
      case "fetch":
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
        if (target === "FETCH_HEAD") {
          return { ok: true, stdout: "origin-main-sha", stderr: "" };
        }
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

const ISSUES_JSON = JSON.stringify([
  { number: 7, title: "Fix the welcome banner", labels: [{ name: "bug" }] },
  { number: 12, title: "Dark mode", labels: [] },
]);

function scriptedGh(): { calls: string[][]; run: ForestCommandRunner } {
  const calls: string[][] = [];
  const run: ForestCommandRunner = async (argv) => {
    calls.push(argv);
    if (argv[1] === "api" && (argv[2] ?? "").includes("/issues")) {
      return { ok: true, stdout: ISSUES_JSON, stderr: "" };
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

const runtimePaths = new Map<ProjectorRuntime, string>();

async function makeRuntime(
  options: ProjectorRuntimeOptions & { env?: Record<string, string> } = {},
): Promise<{ runtime: ProjectorRuntime; buildsRoot: string }> {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-steerslice-"));
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
    { buildsRoot, executionArtifactsRoot: join(dir, "vibersyn-runs"), resolveDeployFn: null, ...runtimeOptions },
  );
  runtimes.push(runtime);
  runtimePaths.set(runtime, path);
  return { runtime, buildsRoot };
}

async function drive(runtime: ProjectorRuntime, observations: TranscriptObservation[]): Promise<void> {
  const path = runtimePaths.get(runtime);
  if (path === undefined) {
    throw new Error("drive() called for a runtime makeRuntime did not create");
  }
  writeFileSync(path, observations.map((observation) => JSON.stringify(observation)).join("\n"), "utf8");
  const session = runtime.startMicSession("corr-steerslice-mic");
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
  return { text, isFinal: true, speaker: "Room", sessionId: "steerslice-test", latencyMs: 0, utteranceId };
}

// Import an adopted tree (fake clone creates repo/.git; substrate adopts).
async function importAdopted(runtime: ProjectorRuntime): Promise<string> {
  const imported = await runtime.importProject("https://github.com/acme/widget", "corr-steerslice-import");
  if (!imported.ok) {
    throw new Error(`import refused: ${imported.error}`);
  }
  await waitFor(() => runtime.snapshot().processes.find((entry) => entry.upid === imported.upid)?.treeRepo?.remoteUrl != null);
  return imported.upid;
}

const fakeClone: ProjectorRuntimeOptions["cloneRepoFn"] = async ({ dir }) => {
  await mkdir(join(dir, ".git"), { recursive: true });
  return { ok: true, dir };
};

function steerApplierEvents(runtime: ProjectorRuntime): string[] {
  return runtime.trace
    .events()
    .map((event) => event.event)
    .filter((event) => event.startsWith("steer.applier."));
}

describe("branch-scoped select — POST /api/process/:upid/select {branch}", () => {
  test("the branch rides the snapshot as steeringBranch and clears with the target", async () => {
    const git = scriptedGit();
    const { runtime } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      cloneRepoFn: fakeClone,
      repoDigestFn: async () => "digest: fake repo",
    });
    const upid = await importAdopted(runtime);
    const app = createProjectorApp(runtime);

    const selected = await app.request(`/api/process/${upid}/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "room/demo" }),
    });
    const snapshot = (await selected.json()) as { steeringUpid?: string | null; steeringBranch?: string | null };
    expect(snapshot.steeringUpid).toBe(upid);
    expect(snapshot.steeringBranch).toBe("room/demo");
    expect(runtime.steeringBranch()).toBe("room/demo");

    const cleared = await app.request("/api/process/select/clear", { method: "POST" });
    const clearedSnapshot = (await cleared.json()) as { steeringUpid?: string | null; steeringBranch?: string | null };
    expect(clearedSnapshot.steeringUpid).toBeNull();
    expect(clearedSnapshot.steeringBranch).toBeNull();
    expect(runtime.steeringBranch()).toBeNull();
  });

  test("a bodyless select keeps the pre-existing unscoped contract (branch null)", async () => {
    const git = scriptedGit();
    const { runtime } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      cloneRepoFn: fakeClone,
      repoDigestFn: async () => "digest: fake repo",
    });
    const upid = await importAdopted(runtime);
    const app = createProjectorApp(runtime);

    const selected = await app.request(`/api/process/${upid}/select`, { method: "POST" });
    const snapshot = (await selected.json()) as { steeringUpid?: string | null; steeringBranch?: string | null };
    expect(snapshot.steeringUpid).toBe(upid);
    expect(snapshot.steeringBranch).toBeNull();
  });
});

describe("steer slice → applier — the record-toggle commit", () => {
  test("toggle on → speak → toggle off lands ROOM-NOTES.md + a commit on a SMART-NAMED room branch", async () => {
    const git = scriptedGit();
    const { runtime, buildsRoot } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      cloneRepoFn: fakeClone,
      repoDigestFn: async () => "digest: fake repo",
    });
    const upid = await importAdopted(runtime);

    runtime.setSteeringTarget(upid, "corr-steerslice-on");
    await drive(runtime, [final("make the header cobalt blue", "utt-steer-1"), final("and round the corners", "utt-steer-2")]);
    // RECORD WINDOW = COLLECT ONLY: nothing dispatches until STOP.
    expect(runtime.trace.events().some((event) => event.event === "process.steer" && event.upid === upid)).toBe(false);
    runtime.clearSteeringTarget("corr-steerslice-off");

    const notesPath = join(buildsRoot, upid, "repo", "ROOM-NOTES.md");
    await waitFor(() => existsSync(notesPath));
    const notes = readFileSync(notesPath, "utf8");
    expect(notes).toContain("spoken in the room");
    expect(notes).toContain("make the header cobalt blue and round the corners");

    await waitFor(() => steerApplierEvents(runtime).includes("steer.applier.applied"));
    // No explicit branch, no prior room/* branch → a SMART-NAMED branch (slug
    // from the spoken words) was cut off the fetched origin/main tip and
    // carries the commit.
    await waitFor(
      () =>
        runtime
          .snapshot()
          .processes.find((entry) => entry.upid === upid)
          ?.treeRepo?.branches.some((branch) => branch.name === "room/header-cobalt-blue-round" && branch.commits === 1) === true,
    );
    const commitMessage = git.calls.find((argv) => argv.includes("commit-tree"))!;
    expect(commitMessage[commitMessage.length - 1]).toBe("room: make the header cobalt blue and round the corners");
  });

  test("an explicit steeringBranch scopes the commit to that room branch", async () => {
    const git = scriptedGit();
    const { runtime, buildsRoot } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      cloneRepoFn: fakeClone,
      repoDigestFn: async () => "digest: fake repo",
    });
    const upid = await importAdopted(runtime);

    runtime.setSteeringTarget(upid, "corr-steerslice-on", "room/demo");
    await drive(runtime, [final("swap the hero image", "utt-steer-scope")]);
    runtime.clearSteeringTarget("corr-steerslice-off");

    await waitFor(() => existsSync(join(buildsRoot, upid, "repo", "ROOM-NOTES.md")));
    await waitFor(
      () =>
        runtime
          .snapshot()
          .processes.find((entry) => entry.upid === upid)
          ?.treeRepo?.branches.some((branch) => branch.name === "room/demo" && branch.commits === 1) === true,
    );
  });

  test("with no explicit branch the most recently created room/* branch wins", async () => {
    const git = scriptedGit();
    const { runtime } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      cloneRepoFn: fakeClone,
      repoDigestFn: async () => "digest: fake repo",
    });
    const upid = await importAdopted(runtime);
    expect((await runtime.createTreeBranch(upid, "feature-x")).ok).toBe(true);

    runtime.setSteeringTarget(upid, "corr-steerslice-on");
    await drive(runtime, [final("tune the copy on the landing page", "utt-steer-latest")]);
    runtime.clearSteeringTarget("corr-steerslice-off");

    await waitFor(
      () =>
        runtime
          .snapshot()
          .processes.find((entry) => entry.upid === upid)
          ?.treeRepo?.branches.some((branch) => branch.name === "room/feature-x" && branch.commits === 1) === true,
    );
    // No second room branch was invented.
    const branches = runtime.snapshot().processes.find((entry) => entry.upid === upid)!.treeRepo!.branches;
    expect(branches.some((branch) => branch.name === "room/spoken-changes")).toBe(false);
  });

  test("only finals from the trailing 60s make the commit (stale narration is excluded)", async () => {
    let nowMs = 1_000_000;
    const git = scriptedGit();
    const { runtime, buildsRoot } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      cloneRepoFn: fakeClone,
      repoDigestFn: async () => "digest: fake repo",
      clock: () => nowMs,
    });
    const upid = await importAdopted(runtime);

    runtime.setSteeringTarget(upid, "corr-steerslice-on");
    await drive(runtime, [final("this stale line must not commit", "utt-stale")]);
    nowMs += 70_000; // the toggle stayed on through a long demo segment
    await drive(runtime, [final("ship the fresh change", "utt-fresh")]);
    runtime.clearSteeringTarget("corr-steerslice-off");

    const notesPath = join(buildsRoot, upid, "repo", "ROOM-NOTES.md");
    await waitFor(() => existsSync(notesPath));
    const notes = readFileSync(notesPath, "utf8");
    expect(notes).toContain("ship the fresh change");
    expect(notes).not.toContain("this stale line must not commit");
  });

  test("VIBERSYN_STEER_APPLIER=0 disables the pipeline entirely", async () => {
    const git = scriptedGit();
    const { runtime, buildsRoot } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      cloneRepoFn: fakeClone,
      repoDigestFn: async () => "digest: fake repo",
      env: { VIBERSYN_STEER_APPLIER: "0" },
    });
    const upid = await importAdopted(runtime);

    runtime.setSteeringTarget(upid, "corr-steerslice-on");
    await drive(runtime, [final("make the header cobalt blue", "utt-steer-gated")]);
    runtime.clearSteeringTarget("corr-steerslice-off");

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(join(buildsRoot, upid, "repo", "ROOM-NOTES.md"))).toBe(false);
    expect(steerApplierEvents(runtime)).toEqual([]);
  });

  test("a LOCAL tree never fires the applier (rails are adopted-only)", async () => {
    const git = scriptedGit();
    const { runtime, buildsRoot } = await makeRuntime({ buildBackends: [new FakeBackend()], treeGitRunner: git.run });
    await drive(runtime, [final(BUILDABLE, "utt-build")]);
    await runtime.acceptPendingSuggestion("corr-steerslice-accept");
    const upid = runtime.snapshot().processes[0]?.upid;
    expect(upid).toBeDefined();
    if (upid === undefined) return;
    await waitFor(() => runtime.registry.builds(upid).some((build) => build.status === "ready"));

    runtime.setSteeringTarget(upid, "corr-steerslice-on");
    await drive(runtime, [final("make the header cobalt blue", "utt-steer-local")]);
    runtime.clearSteeringTarget("corr-steerslice-off");

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(steerApplierEvents(runtime)).toEqual([]);
    expect(existsSync(join(buildsRoot, upid, "repo", "ROOM-NOTES.md"))).toBe(false);
  });
});

describe("GET /api/process/:upid/issues — the UI contract", () => {
  test("an adopted tree serves its origin's open issues in the exact shape, cached per upid", async () => {
    const git = scriptedGit();
    const gh = scriptedGh();
    const { runtime } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      treeGhRunner: gh.run,
      cloneRepoFn: fakeClone,
      repoDigestFn: async () => "digest: fake repo",
    });
    const upid = await importAdopted(runtime);
    const app = createProjectorApp(runtime);

    const first = await app.request(`/api/process/${upid}/issues`);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      issues: [
        // updatedAtMs rides the contract now: the fruit card says how stale an
        // issue is rather than implying every open issue is live work. This
        // fixture's gh stub carries no updated_at, so both come back null —
        // unknown is its own state, never silently "fresh".
        { number: 7, title: "Fix the welcome banner", labels: ["bug"], updatedAtMs: null },
        { number: 12, title: "Dark mode", labels: [], updatedAtMs: null },
      ],
    });
    const issueCalls = () => gh.calls.filter((argv) => argv[1] === "api").length;
    expect(issueCalls()).toBe(1);
    expect(gh.calls.find((argv) => argv[1] === "api")![2]).toBe("repos/acme/widget/issues?state=open&per_page=10");

    // Second GET inside the 60s window: served from the cache, no new gh call.
    const second = await app.request(`/api/process/${upid}/issues`);
    expect(((await second.json()) as { issues: unknown[] }).issues).toHaveLength(2);
    expect(issueCalls()).toBe(1);
  });

  test("unknown upids and LOCAL trees answer {issues: []} without touching gh", async () => {
    const git = scriptedGit();
    const gh = scriptedGh();
    const { runtime } = await makeRuntime({ buildBackends: [new FakeBackend()], treeGitRunner: git.run, treeGhRunner: gh.run });
    const app = createProjectorApp(runtime);

    const unknown = await app.request("/api/process/upid-nope/issues");
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ issues: [] });

    await drive(runtime, [final(BUILDABLE, "utt-build")]);
    await runtime.acceptPendingSuggestion("corr-steerslice-issues-accept");
    const upid = runtime.snapshot().processes[0]?.upid;
    expect(upid).toBeDefined();
    if (upid === undefined) return;
    const local = await app.request(`/api/process/${upid}/issues`);
    expect(await local.json()).toEqual({ issues: [] });
    expect(gh.calls.filter((argv) => argv[1] === "api")).toHaveLength(0);
  });

  test("a gh failure degrades to {issues: []} — never a 500", async () => {
    const git = scriptedGit();
    const failingGh: ForestCommandRunner = async () => ({ ok: false, stdout: "", stderr: "gh exploded" });
    const { runtime } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      treeGhRunner: failingGh,
      cloneRepoFn: fakeClone,
      repoDigestFn: async () => "digest: fake repo",
    });
    const upid = await importAdopted(runtime);
    const app = createProjectorApp(runtime);

    const response = await app.request(`/api/process/${upid}/issues`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ issues: [] });
  });
});

// ── endpointing grace — finals that trail the toggle-off ─────────────────────
// Live-room finding: ASR finals land 1-2s AFTER the speaker stops, so
// "record → speak → tap stop" used to lose the whole window. For
// STEER_GRACE_MS after clear, trailing finals still steer the released
// target and join the adopted slice the delayed drain commits.

describe("steering endpointing grace", () => {
  test("a final arriving JUST after toggle-off still steers the released target and joins the commit", async () => {
    let nowMs = 1_000_000;
    const git = scriptedGit();
    const { runtime, buildsRoot } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      cloneRepoFn: fakeClone,
      repoDigestFn: async () => "digest: fake repo",
      clock: () => nowMs,
    });
    const upid = await importAdopted(runtime);

    runtime.setSteeringTarget(upid, "corr-grace-on");
    runtime.clearSteeringTarget("corr-grace-off"); // stop tapped before the final lands
    nowMs += 1_500; // within STEER_GRACE_MS
    await drive(runtime, [final("add a welcome note for the residents", "utt-grace-1")]);
    // The trailing final still reached the released target's agent loop…
    // …and joins the applier commit once the (lazy or timed) drain runs: a
    // later out-of-window final drains lazily and flows ambient.
    nowMs += STEER_GRACE_MS + 1_000;
    await drive(runtime, [final("unrelated ambient chatter", "utt-after")]);
    const notesPath = join(buildsRoot, upid, "repo", "ROOM-NOTES.md");
    await waitFor(() => existsSync(notesPath));
    const notes = readFileSync(notesPath, "utf8");
    expect(notes).toContain("add a welcome note for the residents");
    expect(notes).not.toContain("unrelated ambient chatter");
  });

  test("a final AFTER the grace window flows ambient — nothing steers, nothing commits", async () => {
    let nowMs = 2_000_000;
    const git = scriptedGit();
    const { runtime, buildsRoot } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      cloneRepoFn: fakeClone,
      repoDigestFn: async () => "digest: fake repo",
      clock: () => nowMs,
    });
    const upid = await importAdopted(runtime);

    runtime.setSteeringTarget(upid, "corr-grace2-on");
    runtime.clearSteeringTarget("corr-grace2-off");
    nowMs += STEER_GRACE_MS + 500; // window lapsed
    await drive(runtime, [final("too late to steer", "utt-late")]);
    expect(runtime.trace.events().some((event) => event.event === "process.steer" && event.upid === upid)).toBe(false);
    const notesPath = join(buildsRoot, upid, "repo", "ROOM-NOTES.md");
    expect(existsSync(notesPath)).toBe(false);
  });

  test("re-arming a NEW target preempts the previous grace (windows never merge)", async () => {
    let nowMs = 3_000_000;
    const git = scriptedGit();
    const { runtime, buildsRoot } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      treeGitRunner: git.run,
      cloneRepoFn: fakeClone,
      repoDigestFn: async () => "digest: fake repo",
      clock: () => nowMs,
    });
    const upid = await importAdopted(runtime);

    runtime.setSteeringTarget(upid, "corr-grace3-on");
    await drive(runtime, [final("first window words", "utt-w1")]);
    runtime.clearSteeringTarget("corr-grace3-off");
    nowMs += 500;
    runtime.setSteeringTarget(upid, "corr-grace3-on2"); // re-arm preempts → first window drains NOW
    const notesPath = join(buildsRoot, upid, "repo", "ROOM-NOTES.md");
    await waitFor(() => existsSync(notesPath));
    expect(readFileSync(notesPath, "utf8")).toContain("first window words");
    // The fresh window is clean: a final now belongs to window two only.
    await drive(runtime, [final("second window words", "utt-w2")]);
    runtime.clearSteeringTarget("corr-grace3-off2");
    nowMs += STEER_GRACE_MS + 1_000;
    await drive(runtime, [final("flush tick", "utt-flush")]);
    await waitFor(() => readFileSync(notesPath, "utf8").includes("second window words"));
  });
});

describe("slugFromSpeech — smart branch naming", () => {
  test("meaningful words, kebab-cased, stopwords dropped, bounded", () => {
    expect(slugFromSpeech("make a dancing cat under each tree")).toBe("dancing-cat-under-each");
    expect(slugFromSpeech("please add night mode to the board")).toBe("night-mode-board");
    expect(slugFromSpeech("!!!")).toBe("spoken-changes");
    expect(slugFromSpeech("the a to of and").length).toBeGreaterThan(0);
  });
});
