// Tests inject model runners. Never discover a developer's authenticated AI
// CLI just because it is installed. Explicit fake executables still run.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const bin = mkdtempSync(join(tmpdir(), "room-test-no-cloud-"));
const hostCli = (value: unknown): value is string =>
  typeof value === "string" && ["claude", "codex"].includes(basename(value));
for (const name of ["claude", "codex"]) {
  writeFileSync(join(bin, name), '#!/bin/sh\necho "Host AI CLI disabled in room tests; inject a fake runner." >&2\nexit 1\n', { mode: 0o755 });
}
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
process.env.VIBERSYN_CLAUDE_CLI = join(bin, "unavailable");
for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CEREBRAS_API_KEY", "DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY"])
  delete process.env[key];

// Bun 1.3 caches the startup PATH for which/default spawn. Updating env alone
// leaves the installed Claude reachable, so guard both native lookup and spawn.
const which = Bun.which;
Bun.which = (...args) => hostCli(args[0]) ? null : which(...args);
function guarded(args: unknown[]): unknown[] {
  const first = args[0];
  const command = Array.isArray(first) ? first : (first as { cmd?: unknown[] })?.cmd;
  if (!Array.isArray(command) || !hostCli(command[0])) return args;
  const cmd = [join(bin, basename(command[0])), ...command.slice(1)];
  return [Array.isArray(first) ? cmd : { ...first as object, cmd }, ...args.slice(1)];
}
const spawn = Bun.spawn, spawnSync = Bun.spawnSync;
Bun.spawn = ((...args: unknown[]) => Reflect.apply(spawn, Bun, guarded(args))) as typeof Bun.spawn;
Bun.spawnSync = ((...args: unknown[]) => Reflect.apply(spawnSync, Bun, guarded(args))) as typeof Bun.spawnSync;
