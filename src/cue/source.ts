import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const CUE_REPO = "https://github.com/jameslbarnes/cue.git";

export interface CueCoreModule {
  CueHarness: new (config: unknown) => CueHarnessInstance;
  TextCue: new (patterns: string[], options?: { cooldownSeconds?: number }) => unknown;
  WordCountCue: new (minWords: number) => unknown;
  IdleCue: new (options?: unknown) => unknown;
  IntervalCue: new (intervalSeconds: number) => unknown;
  MappedActionTool: new (config: unknown) => unknown;
  Triggers: {
    onCue(name: string): unknown;
  };
  transcriptObservation(text: string, options?: Record<string, unknown>): unknown;
}

export interface CueHarnessInstance {
  ingest(observation: unknown): Promise<CueIngestResult>;
}

export interface CueIngestResult {
  cues: Array<{ name?: string; metadata?: Record<string, unknown> }>;
  toolResults: Array<{ tool?: string; actions?: unknown[] }>;
}

export async function loadCueCore(): Promise<CueCoreModule> {
  ensureCueSourceBuild();
  const entrypoint = cueCoreEntrypoint();
  return (await import(pathToFileURL(entrypoint).href)) as CueCoreModule;
}

export function cueSourceRoot(): string {
  return process.env.VIBERSYN_CUE_SOURCE_DIR ?? join(tmpdir(), "vibersyn-cue-src");
}

export function cueCoreEntrypoint(): string {
  return join(cueSourceRoot(), "packages/core/dist/index.js");
}

export function cueServerEntrypoint(): string {
  return join(cueSourceRoot(), "packages/server/dist/index.js");
}

/** True once the upstream Cue substrate has been cloned and compiled locally. */
export function cueSourceBuildAvailable(): boolean {
  return existsSync(cueCoreEntrypoint()) && existsSync(cueServerEntrypoint());
}

/**
 * Make the upstream Cue substrate importable, building it from source on first
 * use and caching the result under {@link cueSourceRoot}. A cached build is
 * reused with no network access, so repeated test runs stay deterministic and
 * offline-safe. The build prefers the pnpm toolchain the upstream repo pins,
 * but falls back to a bun-driven compile when that toolchain is unavailable
 * (the upstream manifest pins exact pnpm/node engine versions that a given host
 * may not have, and the build itself is just `tsc`).
 */
export function ensureCueSourceBuild(): void {
  if (cueSourceBuildAvailable()) {
    return;
  }

  const root = cueSourceRoot();
  if (!existsSync(join(root, ".git"))) {
    execFileSync("git", ["clone", "--depth", "1", CUE_REPO, root], { stdio: "pipe" });
  }

  try {
    execFileSync("pnpm", ["install"], { cwd: root, stdio: "pipe" });
    execFileSync("pnpm", ["build"], { cwd: root, stdio: "pipe" });
  } catch {
    buildCueWithBun(root);
  }

  if (!cueSourceBuildAvailable()) {
    throw new Error(
      `Cue source build failed to produce ${cueCoreEntrypoint()}. Build the upstream repo manually or set VIBERSYN_CUE_SOURCE_DIR.`,
    );
  }
}

function buildCueWithBun(root: string): void {
  // bun ignores the upstream engines.pnpm/engines.node pins. It does not read
  // pnpm-workspace.yaml, so install the per-package dependency (ajv) and link
  // @cue/core by hand so packages/server can resolve it, then run plain tsc.
  execFileSync("bun", ["install"], { cwd: root, stdio: "pipe" });
  execFileSync("bun", ["add", "ajv@^8.17.1"], { cwd: root, stdio: "pipe" });

  const scope = join(root, "node_modules/@cue");
  mkdirSync(scope, { recursive: true });
  const coreLink = join(scope, "core");
  if (!existsSync(coreLink)) {
    symlinkSync(join(root, "packages/core"), coreLink);
  }

  execFileSync("bun", ["x", "tsc", "-b", "packages/core/tsconfig.json"], { cwd: root, stdio: "pipe" });
  execFileSync("bun", ["x", "tsc", "-b", "packages/server/tsconfig.json"], { cwd: root, stdio: "pipe" });
}
