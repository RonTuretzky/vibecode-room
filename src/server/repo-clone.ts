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
const DIGEST_MAX_DEPS = 14;
const DIGEST_MAX_LANGUAGES = 6;
const DIGEST_MAX_SUBDIRS = 16; // one level deep, bounded so a huge monorepo can't blow the budget
const DIGEST_MAX_DIR_FILES = 400; // filenames only (no reads) per scanned subdir

// Directories that are never the project's own source — skipped when scanning one
// level deep for language mix / entrypoints so vendored/build output can't skew
// the "what this project is" inference.
const DIGEST_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  "vendor",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode",
]);

const README_RE = /^readme(\.(md|markdown|txt|rst))?$/iu;

// Source-file extension → language label. Only code-ish extensions are counted so
// the "Languages" line reflects what the project is written in, not its docs.
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rb: "Ruby",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  hpp: "C++",
  cs: "C#",
  php: "PHP",
  scala: "Scala",
  clj: "Clojure",
  ex: "Elixir",
  exs: "Elixir",
  vue: "Vue",
  svelte: "Svelte",
  css: "CSS",
  scss: "CSS",
  sass: "CSS",
  less: "CSS",
  html: "HTML",
  sh: "Shell",
  lua: "Lua",
  dart: "Dart",
  zig: "Zig",
};

// npm dependency name → stack label (framework/tooling the code is built on).
const STACK_BY_DEP: Array<[RegExp, string]> = [
  [/^next$/u, "Next.js"],
  [/^nuxt$/u, "Nuxt"],
  [/^@sveltejs\/kit$/u, "SvelteKit"],
  [/^astro$/u, "Astro"],
  [/^@angular\/core$/u, "Angular"],
  [/^react$/u, "React"],
  [/^react-dom$/u, "React"],
  [/^vue$/u, "Vue"],
  [/^svelte$/u, "Svelte"],
  [/^solid-js$/u, "SolidJS"],
  [/^vite$/u, "Vite"],
  [/^webpack$/u, "Webpack"],
  [/^express$/u, "Express"],
  [/^fastify$/u, "Fastify"],
  [/^hono$/u, "Hono"],
  [/^koa$/u, "Koa"],
  [/^@nestjs\/core$/u, "NestJS"],
  [/^tailwindcss$/u, "Tailwind"],
  [/^electron$/u, "Electron"],
  [/^three$/u, "Three.js"],
  [/^typescript$/u, "TypeScript"],
  [/^prisma$/u, "Prisma"],
  [/^@prisma\/client$/u, "Prisma"],
  [/^drizzle-orm$/u, "Drizzle"],
];

// Top-level config/marker file (lowercased) → stack label. Catches non-npm
// ecosystems (Rust/Go/Python/etc.) the package.json can't speak to.
const STACK_BY_FILE: Array<[RegExp, string]> = [
  [/^next\.config\./u, "Next.js"],
  [/^nuxt\.config\./u, "Nuxt"],
  [/^svelte\.config\./u, "Svelte"],
  [/^astro\.config\./u, "Astro"],
  [/^vite\.config\./u, "Vite"],
  [/^tailwind\.config\./u, "Tailwind"],
  [/^tsconfig\.json$/u, "TypeScript"],
  [/^cargo\.toml$/u, "Rust (Cargo)"],
  [/^go\.mod$/u, "Go"],
  [/^pyproject\.toml$/u, "Python"],
  [/^requirements\.txt$/u, "Python"],
  [/^setup\.py$/u, "Python"],
  [/^pipfile$/u, "Python"],
  [/^gemfile$/u, "Ruby"],
  [/^pom\.xml$/u, "Java (Maven)"],
  [/^build\.gradle/u, "Gradle"],
  [/^composer\.json$/u, "PHP"],
  [/^dockerfile$/u, "Docker"],
  [/^docker-compose\./u, "Docker Compose"],
  [/^deno\.json/u, "Deno"],
];

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

// Package metadata, the parts of package.json that shape the digest.
interface PackageInfo {
  name: string | null;
  description: string | null;
  deps: string[]; // dependency names across dependencies/devDependencies/peerDependencies
  main: string | null; // main/module entry, when declared
  bin: string | null; // first bin target, when declared
}

// A structural view of a cloned repo, assembled from cheap IO (top-level listing,
// one level of subdir filenames, package.json, README). Everything downstream —
// stack detection, language mix, entrypoint, the "what this is" inference — is a
// PURE function of this profile, so it is testable without a real checkout.
interface RepoProfile {
  names: string[]; // sorted top-level entries (dirs suffixed with "/")
  fileNames: string[]; // top-level file names (no dirs)
  subdirFiles: Map<string, string[]>; // scanned subdir → its file names (one level deep)
  pkg: PackageInfo | null;
  configFiles: string[]; // lowercased top-level file names (for stack markers)
  readme: string | null; // trimmed README contents, when present
}

// A compact, prompt-safe digest of a cloned repo. Beyond the original listing +
// package metadata + README excerpt, it now leads with an inference of WHAT the
// project is (detected stack, language mix, entrypoint, and a one-line "appears
// to be" summary) so an import-plan prompt can reason about ADDING to the repo
// rather than rebuilding it. Everything is best-effort and bounded (~3k chars).
export async function repoDigest(dir: string): Promise<string | null> {
  const profile = await readRepoProfile(dir);
  if (profile === null) {
    return null;
  }
  return formatDigest(profile);
}

async function readRepoProfile(dir: string): Promise<RepoProfile | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return null;
  }
  const visible = entries.filter((entry) => entry.name !== ".git");
  const names = visible
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort((a, b) => a.localeCompare(b));
  const fileNames = visible.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
  const dirNames = visible.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  // One level deep: filenames only (no file reads), skipping vendored/build dirs.
  const subdirFiles = new Map<string, string[]>();
  const scannable = dirNames.filter((name) => !DIGEST_SKIP_DIRS.has(name.toLowerCase())).slice(0, DIGEST_MAX_SUBDIRS);
  for (const sub of scannable) {
    const subEntries = await readdir(join(dir, sub), { withFileTypes: true }).catch(() => null);
    if (subEntries === null) {
      continue;
    }
    subdirFiles.set(
      sub,
      subEntries
        .filter((entry) => !entry.isDirectory())
        .map((entry) => entry.name)
        .slice(0, DIGEST_MAX_DIR_FILES),
    );
  }

  const packageJson = await readFile(join(dir, "package.json"), "utf8").catch(() => null);
  const pkg = packageJson !== null ? parsePackage(packageJson) : null;

  const readmeName = names.map((name) => name.replace(/\/$/u, "")).find((name) => README_RE.test(name));
  let readme: string | null = null;
  if (readmeName !== undefined) {
    const raw = await readFile(join(dir, readmeName), "utf8").catch(() => null);
    if (raw !== null && raw.trim().length > 0) {
      readme = raw.trim();
    }
  }

  return { names, fileNames, subdirFiles, pkg, configFiles: fileNames.map((name) => name.toLowerCase()), readme };
}

function parsePackage(raw: string): PackageInfo | null {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) {
      return null;
    }
    parsed = value;
  } catch {
    return null;
  }
  const deps = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const table = parsed[key];
    if (isRecord(table)) {
      for (const name of Object.keys(table)) {
        deps.add(name);
      }
    }
  }
  const main = typeof parsed.main === "string" ? parsed.main : typeof parsed.module === "string" ? parsed.module : null;
  let bin: string | null = null;
  if (typeof parsed.bin === "string") {
    bin = parsed.bin;
  } else if (isRecord(parsed.bin)) {
    const first = Object.values(parsed.bin)[0];
    bin = typeof first === "string" ? first : null;
  }
  return {
    name: typeof parsed.name === "string" ? parsed.name : null,
    description: typeof parsed.description === "string" ? parsed.description : null,
    deps: [...deps],
    main,
    bin,
  };
}

// --- Pure digest formatting -------------------------------------------------

function formatDigest(profile: RepoProfile): string | null {
  const sections: string[] = [];
  const languages = languageCounts(profile);
  const stack = detectStack(profile);

  sections.push(`This project appears to be: ${inferProjectKind(stack, languages, profile.pkg !== null)}.`);

  const tech: string[] = [];
  if (stack.length > 0) {
    tech.push(`Stack: ${stack.join(", ")}`);
  }
  if (languages.length > 0) {
    tech.push(
      `Languages: ${languages
        .slice(0, DIGEST_MAX_LANGUAGES)
        .map((lang) => `${lang.name} (${lang.count})`)
        .join(", ")}`,
    );
  }
  const entrypoint = detectEntrypoint(profile);
  if (entrypoint !== null) {
    tech.push(`Entrypoint: ${entrypoint}`);
  }
  if (tech.length > 0) {
    sections.push(tech.join("\n"));
  }

  if (profile.names.length > 0) {
    const listed = profile.names.slice(0, DIGEST_MAX_FILES);
    const suffix = profile.names.length > listed.length ? `, … (${profile.names.length - listed.length} more)` : "";
    sections.push(`Top-level files: ${listed.join(", ")}${suffix}`);
  }

  if (profile.pkg !== null && (profile.pkg.name !== null || profile.pkg.description !== null)) {
    sections.push(`package.json: ${[profile.pkg.name, profile.pkg.description].filter((part) => part !== null).join(" — ")}`);
  }
  if (profile.pkg !== null && profile.pkg.deps.length > 0) {
    const deps = profile.pkg.deps.slice(0, DIGEST_MAX_DEPS);
    const suffix = profile.pkg.deps.length > deps.length ? `, … (+${profile.pkg.deps.length - deps.length})` : "";
    sections.push(`Dependencies: ${deps.join(", ")}${suffix}`);
  }

  if (profile.readme !== null) {
    const excerpt = profile.readme.slice(0, DIGEST_README_CHARS);
    sections.push(`README excerpt:\n${excerpt}${profile.readme.length > excerpt.length ? "\n…" : ""}`);
  }

  return sections.length === 0 ? null : sections.join("\n\n");
}

// Language mix across the top-level files and one level of source dirs (filenames
// only). Sorted by count desc, then name for stable output.
function languageCounts(profile: RepoProfile): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  const tally = (fileName: string) => {
    const dot = fileName.lastIndexOf(".");
    if (dot <= 0) {
      return;
    }
    const language = LANGUAGE_BY_EXT[fileName.slice(dot + 1).toLowerCase()];
    if (language !== undefined) {
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  };
  for (const name of profile.fileNames) {
    tally(name);
  }
  for (const files of profile.subdirFiles.values()) {
    for (const name of files) {
      tally(name);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// Stack labels from package.json dependencies then top-level marker files, in a
// stable, framework-first order, deduped and bounded.
function detectStack(profile: RepoProfile): string[] {
  const stack: string[] = [];
  const add = (label: string) => {
    if (!stack.includes(label)) {
      stack.push(label);
    }
  };
  if (profile.pkg !== null) {
    for (const dep of profile.pkg.deps) {
      for (const [pattern, label] of STACK_BY_DEP) {
        if (pattern.test(dep)) {
          add(label);
        }
      }
    }
  }
  for (const file of profile.configFiles) {
    for (const [pattern, label] of STACK_BY_FILE) {
      if (pattern.test(file)) {
        add(label);
      }
    }
  }
  return stack.slice(0, 10);
}

// One-line "what this project appears to be" from the detected stack, language
// mix, and whether it is an npm project. Ordered most-specific-first.
function inferProjectKind(stack: string[], languages: Array<{ name: string; count: number }>, hasPackage: boolean): string {
  const has = (label: string) => stack.includes(label);
  if (has("Next.js")) return "a Next.js web app";
  if (has("Nuxt")) return "a Nuxt web app";
  if (has("SvelteKit")) return "a SvelteKit web app";
  if (has("Astro")) return "an Astro site";
  if (has("Angular")) return "an Angular web app";
  const ui = has("React") ? "React" : has("Vue") ? "Vue" : has("Svelte") ? "Svelte" : has("SolidJS") ? "SolidJS" : null;
  if (ui !== null) {
    return `a ${ui} web front-end${has("Vite") ? " (Vite)" : ""}`;
  }
  const server = has("Express")
    ? "Express"
    : has("Fastify")
      ? "Fastify"
      : has("Hono")
        ? "Hono"
        : has("Koa")
          ? "Koa"
          : has("NestJS")
            ? "NestJS"
            : null;
  if (server !== null) return `a Node.js ${server} server/API`;
  if (has("Electron")) return "an Electron desktop app";
  if (has("Rust (Cargo)")) return "a Rust project (Cargo)";
  if (has("Go")) return "a Go project";
  if (has("Python")) return "a Python project";
  if (has("Ruby")) return "a Ruby project";
  if (has("PHP")) return "a PHP project";
  if (has("Java (Maven)") || has("Gradle")) return "a JVM project";
  const topLang = languages[0]?.name ?? null;
  if (hasPackage) {
    return topLang === "TypeScript" ? "a TypeScript/Node.js project" : "a Node.js/JavaScript project";
  }
  return topLang !== null ? `a ${topLang} project` : "a software project";
}

// Best-effort entrypoint: an explicit package.json main/bin, else a conventional
// entry file at the top level, else inside a common source dir.
function detectEntrypoint(profile: RepoProfile): string | null {
  if (profile.pkg !== null) {
    if (profile.pkg.bin !== null) return profile.pkg.bin;
    if (profile.pkg.main !== null) return profile.pkg.main;
  }
  const topCandidates = [
    "index.ts",
    "index.tsx",
    "index.js",
    "index.mjs",
    "main.ts",
    "main.tsx",
    "main.js",
    "main.py",
    "main.go",
    "main.rs",
    "server.ts",
    "server.js",
    "app.ts",
    "app.js",
    "app.py",
    "mod.rs",
  ];
  for (const candidate of topCandidates) {
    if (profile.fileNames.includes(candidate)) {
      return candidate;
    }
  }
  const subCandidates = ["index.ts", "index.tsx", "index.js", "main.ts", "main.tsx", "main.js", "main.rs", "app.tsx", "app.ts", "app.py"];
  for (const sub of ["src", "app", "lib", "cmd", "source"]) {
    const files = profile.subdirFiles.get(sub);
    if (files === undefined) {
      continue;
    }
    for (const candidate of subCandidates) {
      if (files.includes(candidate)) {
        return `${sub}/${candidate}`;
      }
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
