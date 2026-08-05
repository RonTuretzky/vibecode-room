// The SELF-HOSTING supervisor loop (scripts/self-supervisor.sh): server exit
// 87 → rebuild → relaunch (same env); exit 0 / signals end the loop; any other
// exit hits the CRASH GUARD (bounded quick-crash retries, then revert-to-last-
// good when new commits are the suspect). The repo has no dedicated shell-test
// harness, so this drives the real script under bun:test through its
// documented command seams (VIBERSYN_SELF_SERVER_CMD / VIBERSYN_SELF_BUILD_CMD
// / VIBERSYN_SELF_ROOT / the crash-guard knobs).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

  test("a clean exit 0 ends the loop immediately — no rebuild, no retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vibersyn-selfsup-"));
    tempDirs.push(dir);
    const marker = join(dir, "state");
    writeFileSync(marker, "", "utf8");
    const result = await runSupervisor({
      VIBERSYN_SELF_SERVER_CMD: `echo run >> ${JSON.stringify(marker)}; exit 0`,
      VIBERSYN_SELF_BUILD_CMD: `echo build >> ${JSON.stringify(marker)}`,
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual(["run"]);
  });

  test("a persistent boot crash with nothing to revert gives up with the server's code and never rebuilds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vibersyn-selfsup-"));
    tempDirs.push(dir);
    const marker = join(dir, "state");
    writeFileSync(marker, "", "utf8");
    const result = await runSupervisor({
      VIBERSYN_SELF_SERVER_CMD: "exit 3",
      VIBERSYN_SELF_BUILD_CMD: `echo build >> ${JSON.stringify(marker)}`,
      VIBERSYN_SELF_CRASH_RETRIES: "0",
    });
    expect(result.exitCode).toBe(3);
    expect(readFileSync(marker, "utf8").trim()).toBe("");
    expect(result.stderr).toContain("giving up");
  });

  test("CRASH GUARD: a quick boot crash is retried (bounded) and a healthy relaunch ends the flap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vibersyn-selfsup-"));
    tempDirs.push(dir);
    const marker = join(dir, "state");
    writeFileSync(marker, "", "utf8");
    // Crashes on the first two boots, then comes up clean.
    const serverCmd = `
      echo run >> ${JSON.stringify(marker)}
      runs=$(grep -c run ${JSON.stringify(marker)})
      if [ "$runs" -le 2 ]; then exit 5; else exit 0; fi
    `;
    const result = await runSupervisor({
      VIBERSYN_SELF_SERVER_CMD: serverCmd,
      VIBERSYN_SELF_BUILD_CMD: `echo build >> ${JSON.stringify(marker)}`,
      VIBERSYN_SELF_CRASH_RETRIES: "2",
      VIBERSYN_SELF_CRASH_BACKOFF_S: "0",
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual(["run", "run", "run"]);
    expect(result.stderr).toContain("retry 1/2");
    expect(result.stderr).toContain("retry 2/2");
  });

  test("CRASH GUARD: a crash-loop on a fresh self-commit reverts to the last good source, rebuilds, and relaunches", async () => {
    // A real throwaway git repo (VIBERSYN_SELF_ROOT) so the restore path drives
    // real `git revert` — the room's repo is never touched.
    const repo = mkdtempSync(join(tmpdir(), "vibersyn-selfsup-git-"));
    tempDirs.push(repo);
    const git = (...args: string[]) => {
      const proc = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
      }
      return proc.stdout.toString();
    };
    git("init", "-q");
    git("config", "user.email", "self@test");
    git("config", "user.name", "self-test");
    git("config", "commit.gpgsign", "false"); // never depend on the host signing key
    writeFileSync(join(repo, "ok.txt"), "ok\n", "utf8");
    git("add", "ok.txt");
    git("commit", "-qm", "base");
    const marker = join(repo, "state");
    writeFileSync(marker, "", "utf8");
    // Run 1: lands a "self:" commit that crashes the boot, exits 87 (green).
    // Later runs: crash (exit 9) while the bad file exists; healthy once the
    // supervisor's revert removed it.
    const serverCmd = `
      echo run >> ${JSON.stringify(marker)}
      runs=$(grep -c run ${JSON.stringify(marker)})
      if [ "$runs" -eq 1 ]; then
        echo broken > crash.txt
        git add crash.txt
        git commit -qm "self: bad change"
        exit 87
      fi
      if [ -f crash.txt ]; then exit 9; fi
      exit 0
    `;
    const result = await runSupervisor({
      VIBERSYN_SELF_ROOT: repo,
      VIBERSYN_SELF_SERVER_CMD: serverCmd,
      VIBERSYN_SELF_BUILD_CMD: `echo build >> ${JSON.stringify(marker)}`,
      VIBERSYN_SELF_CRASH_RETRIES: "0",
      VIBERSYN_SELF_CRASH_BACKOFF_S: "0",
    });
    // run(87) → build → run(crash 9) → revert → build → run(0).
    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual(["run", "build", "run", "build", "run"]);
    expect(result.stderr).toContain("reverting to the last good build");
    // The bad commit is PRESERVED in history and its tree change undone.
    const log = git("log", "--format=%s");
    expect(log).toContain('Revert "self: bad change"');
    expect(log).toContain("self: bad change");
    expect(existsSync(join(repo, "crash.txt"))).toBe(false);
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
