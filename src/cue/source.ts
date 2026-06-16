import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
  const root = cueSourceRoot();
  const entrypoint = join(root, "packages/core/dist/index.js");

  if (!existsSync(entrypoint)) {
    throw new Error(
      `Cue source build not found at ${entrypoint}. Run the P-CUE probe or set PANOP_CUE_SOURCE_DIR.`,
    );
  }

  return (await import(pathToFileURL(entrypoint).href)) as CueCoreModule;
}

export function cueSourceRoot(): string {
  return process.env.PANOP_CUE_SOURCE_DIR ?? join(tmpdir(), "panopticon-cue-src");
}
