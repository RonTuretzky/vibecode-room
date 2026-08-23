import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime, type ProjectorRuntimeOptions } from "./composition";
import type { GitCommandRunner } from "./tree-git";

/**
 * PRUNE-EXCISE over REAL GIT — the one suite in the repo that spawns a real
 * `git`, deliberately: the temp-worktree revert machinery (worktree add
 * --detach → revert --no-edit → update-ref CAS → worktree remove) must be
 * proven against git's actual sequencer, not a scripted fake. Everything runs
 * in a SCRATCH repo in a tmpdir with its own bare "origin" — the injected
 * selfGitRunner doubles as the cwd redirect (production code paths run
 * verbatim, just rooted in the scratch checkout instead of process.cwd()).
 * app.test.ts's "no test may ever spawn a real git" rule is suite-local; this
 * file is the sanctioned exception.
 */

// Hermetic git: no user/system config (no gpg signing, no hooks), a fixed
// identity for the revert commits the excise creates.
const GIT_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Prune Excise",
  GIT_AUTHOR_EMAIL: "prune@excise.test",
  GIT_COMMITTER_NAME: "Prune Excise",
  GIT_COMMITTER_EMAIL: "prune@excise.test",
};

async function git(cwd: string, argv: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe", env: GIT_ENV });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  return { code: proc.exitCode ?? 1, out: (out + err).trim() };
}

// Setup steps must not fail silently — a broken scratch stack would make
// every assertion below lie.
async function mustGit(cwd: string, argv: string[]): Promise<string> {
  const result = await git(cwd, argv);
  if (result.code !== 0) {
    throw new Error(`git ${argv.join(" ")} failed: ${result.out}`);
  }
  return result.out;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const tempDirs: string[] = [];
let runtimes: ProjectorRuntime[] = [];

afterEach(async () => {
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

// The runtime whose self rails run REAL git rooted in the scratch checkout.
async function makeScratchRuntime(dir: string): Promise<{ runtime: ProjectorRuntime; exits: number[] }> {
  const buildsRoot = mkdtempSync(join(tmpdir(), "prune-excise-builds-"));
  tempDirs.push(buildsRoot);
  const exits: number[] = [];
  const runner: GitCommandRunner = async (argv) => {
    const result = await git(dir, argv);
    return { ok: result.code === 0, stdout: result.out, stderr: "" };
  };
  const options: ProjectorRuntimeOptions = {
    buildsRoot,
    executionArtifactsRoot: join(buildsRoot, "vibersyn-runs"),
    // The git substrate + deploy resolver stay OFF — only the SELF rails may
    // touch git here, and only through the scratch-rooted runner above.
    treeGitRunner: null,
    resolveDeployFn: null,
    selfGitRunner: runner,
    selfGhRunner: async () => ({ ok: true, stdout: "", stderr: "" }),
    selfGitHead: async () => ({ sha: "sha-test", subject: "scratch" }),
    exitProcess: (code) => {
      exits.push(code);
    },
  };
  const runtime = await createProjectorRuntime(
    { VIBERSYN_INITIAL_MUTED: "0", VIBERSYN_SELF_MODE: "1" },
    options,
  );
  runtimes.push(runtime);
  return { runtime, exits };
}

describe("prune-excise over real git (scratch stack)", () => {
  test("excise the bottom graft everywhere: descendants gain reverts, the live checkout reverts in place, origin advances", async () => {
    // ── the scratch stack: main ← room/a (graft A) ← room/b ← room/c, the
    // room standing on room/c, everything pushed to a bare origin. ─────────
    const root = mkdtempSync(join(tmpdir(), "prune-excise-git-"));
    tempDirs.push(root);
    const origin = join(root, "origin.git");
    const dir = join(root, "room");
    await mustGit(root, ["init", "--bare", origin]);
    await mustGit(root, ["init", "-b", "main", dir]);
    writeFileSync(join(dir, "f.txt"), "base line\n");
    await mustGit(dir, ["add", "."]);
    await mustGit(dir, ["commit", "-m", "base"]);
    await mustGit(dir, ["remote", "add", "origin", origin]);
    await mustGit(dir, ["push", "-u", "origin", "main"]);
    await mustGit(dir, ["checkout", "-b", "room/a"]);
    writeFileSync(join(dir, "f.txt"), "base line\nalpha line\n");
    await mustGit(dir, ["commit", "-am", "graft A: the alpha line"]);
    await mustGit(dir, ["push", "-u", "origin", "room/a"]);
    await mustGit(dir, ["checkout", "-b", "room/b"]);
    writeFileSync(join(dir, "g.txt"), "beta\n");
    await mustGit(dir, ["add", "."]);
    await mustGit(dir, ["commit", "-m", "graft B"]);
    await mustGit(dir, ["push", "-u", "origin", "room/b"]);
    await mustGit(dir, ["checkout", "-b", "room/c"]);
    writeFileSync(join(dir, "h.txt"), "gamma\n");
    await mustGit(dir, ["add", "."]);
    await mustGit(dir, ["commit", "-m", "graft C"]);
    await mustGit(dir, ["push", "-u", "origin", "room/c"]);
    const tipMain = await mustGit(dir, ["rev-parse", "refs/heads/main"]);
    const tipB = await mustGit(dir, ["rev-parse", "refs/heads/room/b"]);

    const { runtime, exits } = await makeScratchRuntime(dir);
    const result = await runtime.manageSelfBranch("room/a", "delete", "everywhere");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Own commits of room/a = exactly graft A (nearest ancestor origin/main);
    // room/b (temp worktree) and room/c (the current branch, in place) both
    // carried it and both lost it — reported per-branch, no conflicts.
    expect(result.conflicts).toEqual([]);
    expect(result.reloading).toBe(true);
    expect(result.excised).toEqual([
      { branch: "room/b", reverted: 1 },
      { branch: "room/c", reverted: 1 },
    ]);
    // room/b: one revert commit on top of the old tip; A's line gone from its
    // f.txt while its own graft (g.txt) survives.
    const newTipB = await mustGit(dir, ["rev-parse", "refs/heads/room/b"]);
    expect(newTipB).not.toBe(tipB);
    expect(await mustGit(dir, ["rev-parse", "refs/heads/room/b~1"])).toBe(tipB);
    expect(await mustGit(dir, ["log", "--format=%s", "-1", "refs/heads/room/b"])).toContain("Revert");
    expect(await mustGit(dir, ["show", "refs/heads/room/b:f.txt"])).not.toContain("alpha");
    expect(await mustGit(dir, ["show", "refs/heads/room/b:g.txt"])).toContain("beta");
    // room/c — the CURRENT branch: reverted IN the live checkout, so the
    // working tree itself lost the line (this is what the rebuild projects).
    expect(await mustGit(dir, ["show", "refs/heads/room/c:f.txt"])).not.toContain("alpha");
    expect(readFileSync(join(dir, "f.txt"), "utf8")).not.toContain("alpha");
    expect(await mustGit(dir, ["branch", "--show-current"])).toBe("room/c");
    // The trunk never moved.
    expect(await mustGit(dir, ["rev-parse", "refs/heads/main"])).toBe(tipMain);
    // Origin advanced for the excised branches (their PRs would update)…
    expect(await mustGit(origin, ["rev-parse", "refs/heads/room/b"])).toBe(newTipB);
    expect(await mustGit(origin, ["rev-parse", "refs/heads/room/c"])).toBe(
      await mustGit(dir, ["rev-parse", "refs/heads/room/c"]),
    );
    // …and the pruned label fell locally AND on origin.
    expect((await git(dir, ["rev-parse", "--verify", "--quiet", "refs/heads/room/a"])).code).not.toBe(0);
    expect((await git(origin, ["rev-parse", "--verify", "--quiet", "refs/heads/room/a"])).code).not.toBe(0);
    // No stray temp worktrees remain — the live checkout is the only one.
    expect((await mustGit(dir, ["worktree", "list"])).split("\n").length).toBe(1);
    // The current branch lost the graft → the supervisor exit fires.
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual([87]);
  }, 30_000);

  test("a conflicting descendant is reported by name and left untouched; the clean sibling still loses the graft", async () => {
    // ── fresh scratch: main ← room/a (A edits line two) with TWO children —
    // room/b amends the SAME line (revert of A conflicts there) and room/c
    // (the current branch) leaves it alone (revert lands clean). No remote:
    // the push legs are best-effort and must not turn honesty into failure. ─
    const root = mkdtempSync(join(tmpdir(), "prune-excise-git-"));
    tempDirs.push(root);
    const dir = join(root, "room");
    await mustGit(root, ["init", "-b", "main", dir]);
    writeFileSync(join(dir, "f.txt"), "line one\nline two\n");
    await mustGit(dir, ["add", "."]);
    await mustGit(dir, ["commit", "-m", "base"]);
    await mustGit(dir, ["checkout", "-b", "room/a"]);
    writeFileSync(join(dir, "f.txt"), "line one\nalpha two\n");
    await mustGit(dir, ["commit", "-am", "graft A: alpha two"]);
    await mustGit(dir, ["checkout", "-b", "room/b"]);
    writeFileSync(join(dir, "f.txt"), "line one\nbeta two\n");
    await mustGit(dir, ["commit", "-am", "graft B: amends A's line"]);
    await mustGit(dir, ["checkout", "room/a"]);
    await mustGit(dir, ["checkout", "-b", "room/c"]);
    writeFileSync(join(dir, "h.txt"), "gamma\n");
    await mustGit(dir, ["add", "."]);
    await mustGit(dir, ["commit", "-m", "graft C"]);
    const tipB = await mustGit(dir, ["rev-parse", "refs/heads/room/b"]);

    const { runtime, exits } = await makeScratchRuntime(dir);
    const result = await runtime.manageSelfBranch("room/a", "delete", "everywhere");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Partial success, spoken per-branch: room/b conflicted (untouched),
    // room/c — the current branch — still lost the graft.
    expect(result.conflicts).toEqual(["room/b"]);
    expect(result.excised).toEqual([{ branch: "room/c", reverted: 1 }]);
    expect(result.reloading).toBe(true);
    expect(await mustGit(dir, ["rev-parse", "refs/heads/room/b"])).toBe(tipB);
    expect(await mustGit(dir, ["show", "refs/heads/room/b:f.txt"])).toContain("beta two");
    expect(await mustGit(dir, ["show", "refs/heads/room/c:f.txt"])).not.toContain("alpha");
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toContain("line two");
    // The pruned label fell; the conflicted temp worktree was still removed.
    expect((await git(dir, ["rev-parse", "--verify", "--quiet", "refs/heads/room/a"])).code).not.toBe(0);
    expect((await mustGit(dir, ["worktree", "list"])).split("\n").length).toBe(1);
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual([87]);
  }, 30_000);

  test("scope 'branch' (the default) leaves every descendant alone — the label alone falls", async () => {
    const root = mkdtempSync(join(tmpdir(), "prune-excise-git-"));
    tempDirs.push(root);
    const dir = join(root, "room");
    await mustGit(root, ["init", "-b", "main", dir]);
    writeFileSync(join(dir, "f.txt"), "base line\n");
    await mustGit(dir, ["add", "."]);
    await mustGit(dir, ["commit", "-m", "base"]);
    await mustGit(dir, ["checkout", "-b", "room/a"]);
    writeFileSync(join(dir, "f.txt"), "base line\nalpha line\n");
    await mustGit(dir, ["commit", "-am", "graft A"]);
    await mustGit(dir, ["checkout", "-b", "room/b"]);
    writeFileSync(join(dir, "g.txt"), "beta\n");
    await mustGit(dir, ["add", "."]);
    await mustGit(dir, ["commit", "-m", "graft B"]);
    const tipB = await mustGit(dir, ["rev-parse", "refs/heads/room/b"]);

    const { runtime, exits } = await makeScratchRuntime(dir);
    const result = await runtime.manageSelfBranch("room/a", "delete");
    expect(result.ok).toBe(true);
    // Today's prune exactly: the descendant keeps A's commits and its tip.
    expect(await mustGit(dir, ["rev-parse", "refs/heads/room/b"])).toBe(tipB);
    expect(await mustGit(dir, ["show", "refs/heads/room/b:f.txt"])).toContain("alpha");
    expect((await git(dir, ["rev-parse", "--verify", "--quiet", "refs/heads/room/a"])).code).not.toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(exits).toEqual([]);
  }, 30_000);
});
