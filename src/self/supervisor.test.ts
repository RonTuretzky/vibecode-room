// The SELF-HOSTING supervisor loop (scripts/self-supervisor.sh): server exit
// 87 → rebuild → relaunch (same env); any other exit ends the loop with that
// code. The repo has no dedicated shell-test harness, so this drives the real
// script under bun:test through its documented command seams
// (VIBERSYN_SELF_SERVER_CMD / VIBERSYN_SELF_BUILD_CMD).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts", "self-supervisor.sh");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function runSupervisor(env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", SCRIPT], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe("self-supervisor.sh", () => {
  test("the script parses (bash -n)", async () => {
    const proc = Bun.spawn(["bash", "-n", SCRIPT], { stdout: "ignore", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
  });

  test("exit 87 → rebuild → relaunch; a normal exit ends the loop with its code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vibersyn-selfsup-"));
    tempDirs.push(dir);
    const marker = join(dir, "state");
    writeFileSync(marker, "", "utf8");
    // First server run exits 87 (reload requested); the relaunched run exits 0.
    const serverCmd = `
      echo run >> ${JSON.stringify(marker)}
      runs=$(grep -c run ${JSON.stringify(marker)})
      if [ "$runs" -eq 1 ]; then exit 87; else exit 0; fi
    `;
    const buildCmd = `echo build >> ${JSON.stringify(marker)}`;
    const result = await runSupervisor({
      VIBERSYN_SELF_SERVER_CMD: serverCmd,
      VIBERSYN_SELF_BUILD_CMD: buildCmd,
    });
    expect(result.exitCode).toBe(0);
    const state = readFileSync(marker, "utf8").trim().split("\n");
    // run(87) → build → run(0): the rebuild happened BETWEEN the two launches.
    expect(state).toEqual(["run", "build", "run"]);
    expect(result.stdout).toContain("rebuilding");
  });

  test("a non-87 exit is passed through untouched and never rebuilds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vibersyn-selfsup-"));
    tempDirs.push(dir);
    const marker = join(dir, "state");
    writeFileSync(marker, "", "utf8");
    const result = await runSupervisor({
      VIBERSYN_SELF_SERVER_CMD: "exit 3",
      VIBERSYN_SELF_BUILD_CMD: `echo build >> ${JSON.stringify(marker)}`,
    });
    expect(result.exitCode).toBe(3);
    expect(readFileSync(marker, "utf8").trim()).toBe("");
  });

  test("a failed rebuild still relaunches (warns, keeps the wall alive)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vibersyn-selfsup-"));
    tempDirs.push(dir);
    const marker = join(dir, "state");
    writeFileSync(marker, "", "utf8");
    const serverCmd = `
      echo run >> ${JSON.stringify(marker)}
      runs=$(grep -c run ${JSON.stringify(marker)})
      if [ "$runs" -eq 1 ]; then exit 87; else exit 0; fi
    `;
    const result = await runSupervisor({
      VIBERSYN_SELF_SERVER_CMD: serverCmd,
      VIBERSYN_SELF_BUILD_CMD: "exit 1",
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual(["run", "run"]);
    expect(result.stderr).toContain("rebuild FAILED");
  });

  test("the supervisor exports VIBERSYN_SELF_MODE=1 into the server env", async () => {
    const result = await runSupervisor({
      VIBERSYN_SELF_SERVER_CMD: 'echo "mode=$VIBERSYN_SELF_MODE"; exit 0',
      VIBERSYN_SELF_BUILD_CMD: "exit 0",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mode=1");
  });
});

test("failed version builds restore the previous source and frontend without deleting the rejected branch", async () => {
  const { mkdirSync, copyFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "selfsup-rollback-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "scripts")); mkdirSync(join(dir, "dist"));
  copyFileSync(SCRIPT, join(dir, "scripts/self-supervisor.sh"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "-b", "main"); git("config", "user.name", "Supervisor test"); git("config", "user.email", "test@example.test");
  writeFileSync(join(dir, ".gitignore"), "dist/\nstate\n");
  writeFileSync(join(dir, "source.txt"), "good");
  writeFileSync(join(dir, "dist/index.html"), "working frontend");
  git("add", "."); git("commit", "-m", "good");
  const good = git("rev-parse", "HEAD");
  git("checkout", "-b", "room/broken");
  writeFileSync(join(dir, "source.txt"), "broken"); git("commit", "-am", "broken");
  const broken = git("rev-parse", "HEAD"); git("checkout", "main");
  const proc = Bun.spawn(["bash", "scripts/self-supervisor.sh"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: {
    ...process.env,
    VIBERSYN_SELF_SERVER_CMD: 'if [ ! -f state ]; then touch state; git checkout room/broken; exit 87; fi; test "$(cat source.txt)" = good && test "$(cat dist/index.html)" = "working frontend"',
    VIBERSYN_SELF_BUILD_CMD: "rm -rf dist; exit 1",
  } });
  const output = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);
  expect(output).toContain("rebuild FAILED");
  expect(git("rev-parse", "HEAD")).toBe(good);
  expect(git("rev-parse", "room/broken")).toBe(broken);
  expect(readFileSync(join(dir, "dist/index.html"), "utf8")).toBe("working frontend");
});
