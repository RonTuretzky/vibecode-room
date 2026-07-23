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
