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

  test("infers stack, language mix, entrypoint, and 'appears to be' for a framework repo", async () => {
    const dir = tempDir("vibersyn-digest-stack-");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "cool-app",
        description: "a cool app",
        dependencies: { react: "^18", "react-dom": "^18" },
        devDependencies: { vite: "^5", typescript: "^5" },
      }),
    );
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    writeFileSync(join(dir, "vite.config.ts"), "export default {};\n");
    writeFileSync(join(dir, "index.html"), "<!doctype html>\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.tsx"), "export const App = () => null;\n");
    writeFileSync(join(dir, "src", "styles.css"), "body{}\n");

    const digest = await repoDigest(dir);
    expect(digest).not.toBe(null);
    const text = digest!;
    expect(text).toContain("This project appears to be: a React web front-end (Vite).");
    expect(text).toContain("Stack: ");
    expect(text).toContain("React");
    expect(text).toContain("Vite");
    expect(text).toContain("TypeScript");
    expect(text).toContain("Languages: ");
    expect(text).toContain("TypeScript (2)");
    expect(text).toContain("Entrypoint: src/index.tsx");
    expect(text).toContain("Dependencies: ");
    expect(text).toContain("cool-app — a cool app");
  });

  test("detects a non-npm stack (Rust/Cargo) from marker files", async () => {
    const dir = tempDir("vibersyn-digest-rust-");
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"widget\"\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "main.rs"), "fn main() {}\n");

    const digest = await repoDigest(dir);
    expect(digest).not.toBe(null);
    const text = digest!;
    expect(text).toContain("This project appears to be: a Rust project (Cargo).");
    expect(text).toContain("Stack: Rust (Cargo)");
    expect(text).toContain("Rust (1)");
    expect(text).toContain("Entrypoint: src/main.rs");
  });

  test("a near-empty repo still yields a minimal, non-null digest", async () => {
    const dir = tempDir("vibersyn-digest-empty-");
    writeFileSync(join(dir, "README.md"), "# Just an idea\n");
    const digest = await repoDigest(dir);
    expect(digest).not.toBe(null);
    expect(digest!).toContain("This project appears to be: a software project.");
    expect(digest!).not.toContain("Stack:");
    expect(digest!).not.toContain("Dependencies:");
  });
});
