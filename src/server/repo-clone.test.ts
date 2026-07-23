import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneRepo, repoDigest } from "./repo-clone";

// Real-git coverage against LOCAL fixture repos only (file:// paths built with
// `git init` in a temp dir) — the suite never touches the network. The github
// host restriction lives upstream in parseImportRequest; cloneRepo itself is
// URL-agnostic, which is exactly what lets these tests stay local.

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFixtureRepo(): string {
  const dir = tempDir("vibersyn-fixture-repo-");
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(args, { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (result.exitCode !== 0) {
      throw new Error(`fixture git command failed: ${args.join(" ")} — ${result.stderr.toString()}`);
    }
  };
  run("git", "init", "--initial-branch=main");
  writeFileSync(join(dir, "README.md"), "# Fixture project\n\nA tiny repo for clone tests.\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-project", description: "clone-test fixture" }));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "main.ts"), "export const answer = 42;\n");
  run("git", "add", ".");
  run("git", "-c", "user.email=test@vibersyn.local", "-c", "user.name=Vibersyn Test", "commit", "-m", "fixture");
  return dir;
}

describe("cloneRepo", () => {
  test("shallow-clones a repo and reports the target dir", async () => {
    const fixture = makeFixtureRepo();
    const target = join(tempDir("vibersyn-clone-out-"), "repo");
    const result = await cloneRepo({ url: fixture, dir: target });
    expect(result.ok).toBe(true);
    expect(existsSync(join(target, "README.md"))).toBe(true);
    expect(existsSync(join(target, "src", "main.ts"))).toBe(true);
  });

  test("a nonexistent source fails cleanly and leaves no partial directory", async () => {
    const target = join(tempDir("vibersyn-clone-out-"), "repo");
    const result = await cloneRepo({ url: join(tmpdir(), "definitely-not-a-repo-xyz"), dir: target });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
    expect(existsSync(target)).toBe(false);
  });

  test("an already-aborted signal short-circuits to a clean failure", async () => {
    const fixture = makeFixtureRepo();
    const target = join(tempDir("vibersyn-clone-out-"), "repo");
    const controller = new AbortController();
    controller.abort();
    const result = await cloneRepo({ url: fixture, dir: target, signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
  });
});

describe("repoDigest", () => {
  test("digests listing + package.json + README, prompt-bounded", async () => {
    const fixture = makeFixtureRepo();
    const digest = await repoDigest(fixture);
    expect(digest).not.toBe(null);
    expect(digest).toContain("Top-level files:");
    expect(digest).toContain("src/");
    expect(digest).toContain("fixture-project — clone-test fixture");
    expect(digest).toContain("README excerpt:");
    expect(digest).toContain("Fixture project");
    expect(digest).not.toContain(".git");
  });

  test("returns null for a directory that does not exist", async () => {
    expect(await repoDigest(join(tmpdir(), "vibersyn-nope-xyz"))).toBe(null);
  });
});
