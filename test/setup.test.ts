import { expect, test } from "bun:test";

test("the test harness cannot discover or invoke host AI CLIs", async () => {
  expect(Bun.which("claude")).toBeNull();
  expect(Bun.which("codex")).toBeNull();
  for (const command of ["claude", "/host/claude", "/host/codex"]) {
    const proc = Bun.spawn([command, "--version"], { stdout: "pipe", stderr: "pipe" });
    expect(await new Response(proc.stderr).text()).toContain("Host AI CLI disabled");
    expect(await proc.exited).toBe(1);
  }
  expect(Bun.spawnSync({ cmd: ["codex", "--version"], stderr: "pipe" }).exitCode).toBe(1);
});
