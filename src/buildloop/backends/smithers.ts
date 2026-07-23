// The "smithers" BuildBackend: the EXISTING one-shot preview build (the host
// `claude` CLI writing a self-contained static app into a directory — see
// src/server/idea-builder.ts defaultClaudeBuilderAgent) adapted into the
// multi-backend BuildBackend seam. The durable gateway run is NOT owned here:
// the process registry keeps spawning its SmithersClient run as before — this
// backend owns only the app ARTIFACT under builds/<upid>/smithers/.
//
// Correction (steer) mode: the existing files' content is serialized INTO the
// prompt together with the spoken correction, and the CLI rewrites the app in
// place in the same directory.
//
// The claude subprocess is killable within the ~2s emergency-stop budget: the
// BuildRequest AbortSignal SIGKILLs it immediately (never a graceful drain).

import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildBackend, BuildBackendId, BuildRequest, BuildResult } from "../types";

export const SMITHERS_BACKEND_LABEL = "Smithers";
export const SMITHERS_ENTRYPOINT = "index.html";

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_PROMPT_FILE_CHARS = 20_000;
const MAX_READ_FILE_BYTES = 512 * 1024;
const SUMMARY_MAX_CHARS = 600;
const TEXT_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".md", ".xml"]);

// --- claude runner seam -----------------------------------------------------
// One CLI invocation: prompt in, stdout out. Injectable so the backend is
// unit-testable with a fake runner (no real `claude` spawn).

export interface ClaudeRunArgs {
  cli: string;
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ClaudeRunResult {
  exitCode: number;
  stdout: string;
}

export type ClaudeRunner = (args: ClaudeRunArgs) => Promise<ClaudeRunResult>;

export interface SmithersBuildBackendOptions {
  /** Explicit claude CLI path; default: VIBERSYN_CLAUDE_CLI, then the repo shim, then PATH. */
  cliPath?: string;
  /** Env source (tests inject; defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Injected CLI runner for tests; default spawns the real claude CLI. */
  runner?: ClaudeRunner;
  /** Per-invocation ceiling for unattended builds. Default 180s. */
  timeoutMs?: number;
}

export class SmithersBuildBackend implements BuildBackend {
  readonly id: BuildBackendId = "smithers";
  readonly label = SMITHERS_BACKEND_LABEL;
  readonly #options: SmithersBuildBackendOptions;
  readonly #env: Record<string, string | undefined>;

  constructor(options: SmithersBuildBackendOptions = {}) {
    this.#options = options;
    this.#env = options.env ?? process.env;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    if (this.#options.runner !== undefined) {
      return { ok: true };
    }
    if (resolveClaudeCli({ cliPath: this.#options.cliPath, env: this.#env }) !== null) {
      return { ok: true };
    }
    return { ok: false, reason: "smithers backend needs a claude CLI (repo shim or PATH)" };
  }

  async build(req: BuildRequest): Promise<BuildResult> {
    const { signal, onProgress } = req;
    try {
      signal.throwIfAborted();
      const cli = resolveClaudeCli({ cliPath: this.#options.cliPath, env: this.#env });
      const runner = this.#options.runner ?? defaultClaudeRunner;
      if (this.#options.runner === undefined && cli === null) {
        throw new Error("no claude CLI found (repo shim or PATH)");
      }
      await mkdir(req.outDir, { recursive: true });

      const correction = typeof req.correction === "string" && req.correction.trim().length > 0 ? req.correction.trim() : null;
      let prompt: string;
      if (correction === null) {
        onProgress({ label: "building with claude", percent: 10 });
        prompt = smithersBuildPrompt(req.prompt);
      } else {
        onProgress({ label: "reading app", percent: 10 });
        const files = await readProjectFiles(req.outDir);
        if (files.size === 0) {
          return { ok: false, entrypoint: null, summary: "", error: "steer requested but the build directory has no app to correct" };
        }
        signal.throwIfAborted();
        onProgress({ label: "applying correction", percent: 30, detail: truncate(correction, 120) });
        prompt = smithersCorrectionPrompt(req.prompt, files, correction);
      }

      const run = await runner({
        cli: cli ?? "claude",
        prompt,
        cwd: req.outDir,
        signal,
        timeoutMs: this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      signal.throwIfAborted();
      if (run.exitCode !== 0) {
        throw new Error(`claude builder exited ${run.exitCode}`);
      }

      if (!existsSync(join(req.outDir, SMITHERS_ENTRYPOINT))) {
        return {
          ok: false,
          entrypoint: null,
          summary: "",
          error: `the claude build produced no ${SMITHERS_ENTRYPOINT} entrypoint`,
        };
      }
      onProgress({ label: "ready", percent: 100 });
      return {
        ok: true,
        entrypoint: SMITHERS_ENTRYPOINT,
        summary: summaryFromClaudeOutput(run.stdout, req.prompt, correction),
      };
    } catch (error) {
      const aborted = signal.aborted;
      return {
        ok: false,
        entrypoint: null,
        summary: aborted ? "Build aborted by emergency stop." : "Smithers build failed before completion.",
        error: aborted ? "aborted" : error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// --- prompts (pure; unit-tested) --------------------------------------------

// Fresh build: same shape as the existing one-shot preview build's prompt
// (idea-builder builderPrompt) — a self-contained static app written into cwd.
export function smithersBuildPrompt(pitch: string): string {
  const idea = pitch.trim().length > 0 ? pitch.trim() : "A small useful web tool.";
  return [
    "You are a coding agent building a real, working web app from a one-line idea.",
    "",
    `IDEA: ${idea}`,
    "",
    "Build a SELF-CONTAINED static web app that implements this idea:",
    "- Plain HTML/CSS/JavaScript only. NO build step, NO frameworks requiring compilation, NO package install.",
    "- The app must run by simply serving this directory over HTTP — opening index.html must work.",
    `- Write ${SMITHERS_ENTRYPOINT} as the entry file. Prefer inlining CSS and JS inside ${SMITHERS_ENTRYPOINT} to avoid MIME issues.`,
    "- Make it actually functional and interactive, not a description of the idea — implement the real behavior.",
    "- Write the files directly into the current working directory. Overwrite any existing scaffold files.",
    "",
    "Do not ask questions. Build the app now.",
  ].join("\n");
}

// Steer mode: the existing files' content + the spoken correction, and the CLI
// rewrites the app in place (same directory, same entrypoint).
export function smithersCorrectionPrompt(pitch: string, files: ReadonlyMap<string, string>, correction: string): string {
  return [
    "You are a coding agent CORRECTING an existing, working web app in the current working directory.",
    "",
    `ORIGINAL IDEA: ${pitch.trim().length > 0 ? pitch.trim() : "A small useful web tool."}`,
    "",
    "CURRENT FILES (JSON map of path -> content — these are already on disk in the cwd):",
    serializeFiles(files),
    "",
    `SPOKEN CORRECTION FROM THE ROOM — apply it faithfully: ${correction}`,
    "",
    "Rewrite the app IN PLACE:",
    "- Overwrite the existing files in the current working directory with the corrected versions.",
    `- Keep it a SELF-CONTAINED static app: plain HTML/CSS/JS, ${SMITHERS_ENTRYPOINT} stays the entry file, no build step, no CDN.`,
    "- Preserve everything that already works; change only what the correction requires.",
    "",
    "Do not ask questions. Apply the correction now.",
  ].join("\n");
}

// The 1-paragraph human summary for the snapshot: the claude JSON envelope's
// `result` text when parseable, else a deterministic line from the pitch.
export function summaryFromClaudeOutput(stdout: string, pitch: string, correction: string | null): string {
  const fallback =
    correction === null
      ? `A self-contained web app built by the claude CLI from the pitch: ${truncate(pitch.trim(), 200)}`
      : `Applied spoken correction: "${truncate(correction, 200)}".`;
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  try {
    const envelope: unknown = JSON.parse(trimmed);
    if (isRecord(envelope) && typeof envelope.result === "string" && envelope.result.trim().length > 0) {
      return firstParagraph(envelope.result.trim());
    }
  } catch {
    // Non-JSON stdout — the agent's effect is the files it wrote; use the fallback.
  }
  return fallback;
}

function firstParagraph(text: string): string {
  const paragraph = text.split(/\n\s*\n/u)[0] ?? text;
  return truncate(paragraph.replace(/\s+/gu, " ").trim(), SUMMARY_MAX_CHARS);
}

// --- claude CLI plumbing ----------------------------------------------------

// Resolve the claude CLI: explicit path (or VIBERSYN_CLAUDE_CLI) must exist;
// otherwise prefer the repo shim, then whatever is on PATH.
export function resolveClaudeCli(options: { cliPath?: string; env?: Record<string, string | undefined> } = {}): string | null {
  const env = options.env ?? process.env;
  const explicit = options.cliPath ?? env.VIBERSYN_CLAUDE_CLI;
  if (explicit !== undefined && explicit.length > 0) {
    return existsSync(explicit) ? explicit : null;
  }
  const shim = fileURLToPath(new URL("../../../.context/claude-shim/claude", import.meta.url));
  if (existsSync(shim)) {
    return shim;
  }
  return Bun.which("claude");
}

// Default production runner: spawn the claude CLI in the build directory so it
// edits files in place. The abort signal SIGKILLs the subprocess immediately
// (emergency-stop budget ~2s); the timeout is a ceiling for unattended builds.
export const defaultClaudeRunner: ClaudeRunner = async ({ cli, prompt, cwd, signal, timeoutMs }) => {
  signal.throwIfAborted();
  const proc = Bun.spawn([cli, "-p", prompt, "--output-format", "json", "--dangerously-skip-permissions"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const killHard = (): void => {
    try {
      proc.kill(9); // SIGKILL: no graceful drain inside the emergency-stop budget.
    } catch {
      // Already exited.
    }
  };
  signal.addEventListener("abort", killHard, { once: true });
  const timer = setTimeout(killHard, timeoutMs);
  try {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    signal.throwIfAborted();
    return { exitCode, stdout };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", killHard);
  }
};

// Read the existing app's text files (for the correction prompt). Depth-safe:
// skips binaries, oversized files, and anything unreadable.
async function readProjectFiles(outDir: string): Promise<Map<string, string>> {
  const project = new Map<string, string>();
  let names: string[];
  try {
    names = (await readdir(outDir, { recursive: true })) as string[];
  } catch {
    return project;
  }
  for (const name of names) {
    const rel = name.split(sep).join("/");
    if (!TEXT_EXTENSIONS.has(extname(rel).toLowerCase())) {
      continue;
    }
    const abs = join(outDir, name);
    try {
      const info = await stat(abs);
      if (!info.isFile() || info.size > MAX_READ_FILE_BYTES) {
        continue;
      }
      project.set(rel, await Bun.file(abs).text());
    } catch {
      // unreadable entry — skip
    }
  }
  return project;
}

function serializeFiles(files: ReadonlyMap<string, string>): string {
  const record: Record<string, string> = {};
  for (const [path, content] of files) {
    record[path] =
      content.length > MAX_PROMPT_FILE_CHARS ? `${content.slice(0, MAX_PROMPT_FILE_CHARS)}\n/* …truncated… */` : content;
  }
  return JSON.stringify(record, null, 1);
}

// --- small helpers ----------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
