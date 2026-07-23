// GitHub clone routine for phone imports: a validated github.com/<owner>/<repo>
// link gets a REAL shallow clone on disk (builds/<upid>/repo/) so the imported
// project is grounded in the actual code, plus a small digest (README excerpt +
// package.json + top-level listing) that seeds the build prompt. Contracts:
//   - the clone subprocess is killed on abort (emergency-stop wiring) and on a
//     hard timeout — git must never hang the room on a slow/huge/private repo;
//   - GIT_TERMINAL_PROMPT=0 so a private repo fails fast instead of prompting;
//   - a failed clone removes the partial directory (never leave half a tree
//     inside the preview-served builds/<upid>/).

import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_CLONE_TIMEOUT_MS = 90_000;
const DIGEST_README_CHARS = 1_800;
const DIGEST_MAX_FILES = 30;

export type CloneRepoResult = { ok: true; dir: string } | { ok: false; error: string };

export async function cloneRepo(options: {
  url: string; // clone URL built from parsed owner/repo upstream — never raw phone input
  dir: string; // absolute target directory (must not already exist)
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CloneRepoResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
  if (options.signal?.aborted === true) {
    return { ok: false, error: "Clone aborted." };
  }
  // NEVER throws: Bun.spawn throws synchronously when `git` is not on PATH
  // (minimal launchd/systemd envs), and the import routine relies on every
  // failure mode coming back as { ok: false } so a fallback build still starts.
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    proc?.kill(9);
  };
  try {
    proc = Bun.spawn(["git", "clone", "--depth", "1", "--single-branch", options.url, options.dir], {
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
    });
    killTimer = setTimeout(() => {
      timedOut = true;
      proc?.kill(9);
    }, timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const stderrPromise = proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : Promise.resolve("");
    const exitCode = await proc.exited;
    const stderr = await stderrPromise.catch(() => "");
    if (exitCode === 0 && !timedOut && !aborted) {
      return { ok: true, dir: options.dir };
    }
    await rm(options.dir, { recursive: true, force: true }).catch(() => undefined);
    if (aborted) {
      return { ok: false, error: "Clone aborted." };
    }
    if (timedOut) {
      return { ok: false, error: `Clone timed out after ${Math.round(timeoutMs / 1000)}s.` };
    }
    return { ok: false, error: cloneErrorLine(stderr, exitCode) };
  } catch (error) {
    await rm(options.dir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (killTimer !== null) {
      clearTimeout(killTimer);
    }
    options.signal?.removeEventListener("abort", onAbort);
  }
}

// The last meaningful stderr line — git puts the actionable message ("Repository
// not found", "could not resolve host") at the end of its output.
function cloneErrorLine(stderr: string, exitCode: number): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("Cloning into"));
  const last = lines.at(-1);
  return last !== undefined ? last : `git clone exited with code ${exitCode}.`;
}

// A compact, prompt-safe digest of a cloned repo: top-level listing, package
// metadata when present, README excerpt. Everything is best-effort — a missing
// README just drops that section. The result is bounded (~2.5k chars) so it can
// ride inside a build prompt without flooding the model.
export async function repoDigest(dir: string): Promise<string | null> {
  const sections: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return null;
  }
  const names = entries
    .filter((entry) => entry.name !== ".git")
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort((a, b) => a.localeCompare(b));
  if (names.length > 0) {
    const listed = names.slice(0, DIGEST_MAX_FILES);
    const suffix = names.length > listed.length ? `, … (${names.length - listed.length} more)` : "";
    sections.push(`Top-level files: ${listed.join(", ")}${suffix}`);
  }
  const packageJson = await readFile(join(dir, "package.json"), "utf8").catch(() => null);
  if (packageJson !== null) {
    try {
      const parsed = JSON.parse(packageJson) as { name?: unknown; description?: unknown };
      const name = typeof parsed.name === "string" ? parsed.name : null;
      const description = typeof parsed.description === "string" ? parsed.description : null;
      if (name !== null || description !== null) {
        sections.push(`package.json: ${[name, description].filter((part) => part !== null).join(" — ")}`);
      }
    } catch {
      // Unparseable package.json — skip the section.
    }
  }
  const readmeName = names
    .map((name) => name.replace(/\/$/u, ""))
    .find((name) => /^readme(\.(md|markdown|txt|rst))?$/iu.test(name));
  if (readmeName !== undefined) {
    const readme = await readFile(join(dir, readmeName), "utf8").catch(() => null);
    if (readme !== null && readme.trim().length > 0) {
      const excerpt = readme.trim().slice(0, DIGEST_README_CHARS);
      sections.push(`README excerpt:\n${excerpt}${readme.trim().length > excerpt.length ? "\n…" : ""}`);
    }
  }
  return sections.length === 0 ? null : sections.join("\n\n");
}
