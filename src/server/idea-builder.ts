// Real accept->build->preview scaffolding (replaces the fixture spawn behavior on
// the accept path). When a voice-accepted idea spawns a process, the runtime asks
// this module to turn the idea's pitch into a REAL, runnable artifact:
//
//   1. create a fresh directory  builds/<upid>/
//   2. write a self-contained index.html (+ css/js) whose content reflects the
//      pitch — a titled prototype page, from a deterministic template (no LLM)
//   3. start a tiny static file server bound to 127.0.0.1 on an ephemeral port
//      serving that directory, and return the real preview URL.
//
// `stop()` shuts the server down. An IdeaBuildRegistry tracks one build per UPID
// (status: building -> ready | failed) so the projector snapshot can surface a
// clickable "Preview ->" once the page is live, and lifecycle events (halt /
// emergency stop) can tear the servers down.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type BuildStatus = "building" | "ready" | "failed";

export interface IdeaPreview {
  upid: string;
  previewUrl: string;
  dir: string;
  stop(): Promise<void>;
}

// A real coding-agent invocation: given the accepted idea's pitch, the build
// directory (already holding the deterministic scaffold + live server), and the
// UPID, build the actual app by writing files directly into `dir` (index.html as
// the entry). Resolves on success; rejects/throws on failure so the caller can
// degrade. Injectable so tests pass a synthetic builder with no real `claude`
// spawn; the production default spawns the host `claude` CLI. The optional
// `signal` is the emergency-stop path: when it aborts, the builder MUST kill its
// subprocess immediately (SIGKILL) instead of running out its timeout.
export type BuilderAgent = (pitch: string, dir: string, upid: string, signal?: AbortSignal) => Promise<void>;

export interface BuildIdeaPreviewOptions {
  // Root the per-UPID build directories live under. Defaults to <cwd>/builds.
  // Tests point this at a temp dir so the repo tree stays clean.
  buildsRoot?: string;
  // Hostname to bind the static server to. Always loopback in practice.
  host?: string;
  // The real coding agent that turns the scaffold into a working app. Defaults
  // to the host `claude` CLI builder. Tests inject a synthetic builder.
  builderAgent?: BuilderAgent;
  // Emergency-stop seam: aborting kills the in-flight builder subprocess
  // immediately (never waits out the builder timeout).
  signal?: AbortSignal;
}

const DEFAULT_HOST = "127.0.0.1";

function defaultBuildsRoot(): string {
  return resolve(process.cwd(), "builds");
}

// A minimal static file server bound to an ephemeral loopback port. Returns the
// listening port plus a stop() that closes the socket. Uses Bun.serve when
// available (the project runtime), else a node:http fallback so the module is
// usable from any test harness. Every response carries no-cache headers so a
// rebuilt (or steer-corrected) artifact is what the wall's iframe fetches — a
// cached stale index.html would silently hide a live rewrite.
export interface PreviewServer {
  port: number;
  stop(): Promise<void>;
}

// Headers for every preview response: the artifact is rewritten in place on
// steer corrections, so intermediaries and the wall's iframe must never cache.
const NO_CACHE_HEADERS: Record<string, string> = {
  "cache-control": "no-store, no-cache, must-revalidate",
  pragma: "no-cache",
  expires: "0",
};

// Serve a build directory tree (per-backend subdirs included: "/smithers/"
// resolves to smithers/index.html) with no-cache headers. This is the seam the
// multi-backend orchestrator uses to give each builds/<upid>/<backendId>/ its
// own previewUrl off one per-UPID server.
export function servePreviewDirectory(dir: string, host: string = DEFAULT_HOST): Promise<PreviewServer> {
  return serveDirectory(dir, host);
}

async function serveDirectory(dir: string, host: string): Promise<PreviewServer> {
  const bun = (globalThis as { Bun?: typeof import("bun") }).Bun;
  if (bun !== undefined && typeof bun.serve === "function") {
    const server = bun.serve({
      hostname: host,
      port: 0, // ephemeral
      async fetch(request) {
        const file = resolveRequestedFile(dir, new URL(request.url).pathname);
        let handle = bun.file(file);
        if (!(await handle.exists())) {
          // Subdirectory index: "/smithers" or "/smithers/" -> smithers/index.html.
          const indexFallback = bun.file(join(file, "index.html"));
          if (!(await indexFallback.exists())) {
            return new Response("Not found", { status: 404, headers: NO_CACHE_HEADERS });
          }
          handle = indexFallback;
        }
        return new Response(handle, {
          headers: { ...NO_CACHE_HEADERS, "content-type": contentTypeFor(handle.name ?? file) },
        });
      },
    });
    return {
      port: server.port ?? 0,
      async stop() {
        server.stop(true);
      },
    };
  }
  return serveDirectoryNode(dir, host);
}

async function serveDirectoryNode(dir: string, host: string): Promise<PreviewServer> {
  const http = await import("node:http");
  const { readFile, stat } = await import("node:fs/promises");
  const server = http.createServer((request, response) => {
    void (async () => {
      try {
        let file = resolveRequestedFile(dir, request.url ?? "/");
        let info = await stat(file).catch(() => null);
        if (info !== null && info.isDirectory()) {
          // Subdirectory index: "/smithers" or "/smithers/" -> smithers/index.html.
          file = join(file, "index.html");
          info = await stat(file).catch(() => null);
        }
        if (info === null || !info.isFile()) {
          response.statusCode = 404;
          for (const [name, value] of Object.entries(NO_CACHE_HEADERS)) {
            response.setHeader(name, value);
          }
          response.end("Not found");
          return;
        }
        const body = await readFile(file);
        response.statusCode = 200;
        response.setHeader("content-type", contentTypeFor(file));
        for (const [name, value] of Object.entries(NO_CACHE_HEADERS)) {
          response.setHeader(name, value);
        }
        response.end(body);
      } catch {
        response.statusCode = 500;
        response.end("Build preview error");
      }
    })();
  });
  await new Promise<void>((resolveListen) => server.listen(0, host, resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    async stop() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

// Map a request path to a file inside the build directory, defaulting "/" (and
// any trailing-slash directory path) to its index.html and refusing to escape
// the directory (no "..").
function resolveRequestedFile(dir: string, pathname: string): string {
  const clean = pathname.split("?")[0]?.split("#")[0] ?? "/";
  let relative = clean === "/" || clean === "" ? "index.html" : clean.replace(/^\/+/u, "");
  if (relative.endsWith("/")) {
    relative = `${relative}index.html`;
  }
  const target = resolve(dir, relative);
  const root = resolve(dir);
  if (target !== root && !target.startsWith(root + "/")) {
    return join(root, "index.html");
  }
  return target;
}

function contentTypeFor(file: string): string {
  if (file.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (file.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (file.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  return "application/octet-stream";
}

const DEFAULT_BUILDER_TIMEOUT_MS = 180_000;

// Build a prompt instructing the host `claude` CLI to turn the pitch into a real,
// self-contained static web app written directly into the cwd.
function builderPrompt(pitch: string): string {
  const idea = pitch.trim().length > 0 ? pitch.trim() : "A small useful web tool.";
  return [
    "You are a coding agent building a real, working web app from a one-line idea.",
    "",
    `IDEA: ${idea}`,
    "",
    "Build a SELF-CONTAINED static web app that implements this idea:",
    "- Plain HTML/CSS/JavaScript only. NO build step, NO frameworks requiring compilation, NO package install.",
    "- The app must run by simply serving this directory over HTTP — opening index.html must work.",
    "- Write index.html as the entry file. Prefer inlining CSS and JS inside index.html to avoid MIME issues.",
    "- Make it actually functional and interactive, not a description of the idea — implement the real behavior.",
    "- Write the files directly into the current working directory. Overwrite any existing scaffold files.",
    "",
    "Do not ask questions. Build the app now.",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Default production builder: spawn the host `claude` CLI in the build directory
// so it edits files in place, turning the deterministic scaffold into a real app.
// The JSON envelope is parsed only for logging; the agent's effect is on disk.
// The abort signal (emergency stop) SIGKILLs the subprocess immediately — the
// 180s timeout is a ceiling for unattended builds, never a stop() stall.
export const defaultClaudeBuilderAgent: BuilderAgent = async (pitch, dir, _upid, signal) => {
  const bun = (globalThis as { Bun?: typeof import("bun") }).Bun;
  if (bun === undefined || typeof bun.spawn !== "function") {
    throw new Error("claude builder requires the Bun runtime");
  }
  if (signal?.aborted === true) {
    throw new Error("claude builder aborted before spawn");
  }
  const proc = bun.spawn(
    [
      "claude",
      "-p",
      builderPrompt(pitch),
      "--model",
      "sonnet",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ],
    { cwd: dir, stdout: "pipe", stderr: "ignore", stdin: "ignore" },
  );
  const timer = setTimeout(() => proc.kill(), DEFAULT_BUILDER_TIMEOUT_MS);
  const killHard = () => {
    try {
      proc.kill(9); // SIGKILL: the emergency-stop budget is ~2s, no graceful drain.
    } catch {
      // Already exited.
    }
  };
  signal?.addEventListener("abort", killHard, { once: true });
  try {
    const out = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    // Aborted mid-build (killHard already SIGKILLed the subprocess): surface the
    // abort instead of reporting the kill as a plain non-zero exit.
    signal?.throwIfAborted();
    if (exit !== 0) {
      throw new Error(`claude builder exited ${exit}`);
    }
    try {
      const envelope: unknown = JSON.parse(out);
      if (isRecord(envelope) && typeof envelope.result === "string") {
        // Parsed for logging only — the agent already edited files in cwd.
        void envelope.result;
      }
    } catch {
      // Non-JSON stdout is fine; the agent's effect is the files it wrote.
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", killHard);
  }
};

// Scaffold a fresh build directory + start a real preview server for one accepted
// idea, then run a real coding agent that rebuilds the directory into a working
// app. The deterministic scaffold (index.html/css/js) is written FIRST so the
// preview is reachable immediately while the agent runs; the static server reads
// files from disk per-request, so once the agent overwrites index.html the live
// URL serves the real app with no restart. The builder runs inside a try/catch
// that DEGRADES (keeps the scaffold) on failure/timeout — this function never
// throws from the builder path, so the build always resolves to a reachable
// preview rather than a stuck 'building' or 'failed' state.
export async function buildIdeaPreview(
  pitch: string,
  upid: string,
  options: BuildIdeaPreviewOptions = {},
): Promise<IdeaPreview> {
  const root = options.buildsRoot ?? defaultBuildsRoot();
  const host = options.host ?? DEFAULT_HOST;
  const builder = options.builderAgent ?? defaultClaudeBuilderAgent;
  const dir = join(root, safeSegment(upid));

  // Fresh directory: an accept always starts the artifact from scratch.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  // Instant placeholder: write the deterministic scaffold and start the server
  // BEFORE the real agent runs so the preview is never empty.
  const title = pitchTitle(pitch);
  await writeFile(join(dir, "index.html"), renderIndexHtml(title, pitch, upid), "utf8");
  await writeFile(join(dir, "styles.css"), renderStyles(), "utf8");
  await writeFile(join(dir, "app.js"), renderScript(upid), "utf8");

  const server = await serveDirectory(dir, host);
  const previewUrl = `http://${host}:${server.port}/`;

  // Real build: run the coding agent to overwrite the scaffold with a working
  // app. Degrade to the scaffold on any failure/timeout — never throw here.
  // The emergency-stop signal is FORWARDED to the builder: aborting SIGKILLs the
  // in-flight subprocess immediately instead of waiting out its 180s ceiling.
  try {
    await builder(pitch, dir, upid, options.signal);
  } catch {
    // Degraded path: keep the deterministic scaffold already on disk + served.
  }

  return {
    upid,
    previewUrl,
    dir,
    async stop() {
      await server.stop();
    },
  };
}

// Tracks the live build per UPID so the runtime can surface status/previewUrl on
// the snapshot and tear servers down on halt / emergency stop. A new build for an
// existing UPID stops the prior server first.
export interface IdeaBuildState {
  upid: string;
  status: BuildStatus;
  previewUrl: string | null;
  pitch: string;
  error?: string;
}

export class IdeaBuildRegistry {
  readonly #options: BuildIdeaPreviewOptions;
  readonly #states = new Map<string, IdeaBuildState>();
  readonly #previews = new Map<string, IdeaPreview>();
  readonly #inflight = new Map<string, Promise<void>>();
  // Per-UPID emergency-stop seam: stop() aborts the in-flight builder (SIGKILL
  // via the forwarded signal) instead of waiting out the 180s builder ceiling.
  readonly #aborts = new Map<string, AbortController>();

  constructor(options: BuildIdeaPreviewOptions = {}) {
    this.#options = options;
  }

  state(upid: string): IdeaBuildState | undefined {
    const state = this.#states.get(upid);
    return state === undefined ? undefined : { ...state };
  }

  // Start a real build for one accepted idea. Marks the UPID 'building'
  // immediately (so the snapshot reflects in-flight work), then resolves the
  // status to 'ready' (with previewUrl) or 'failed'. Returns the build promise so
  // a caller/test can await completion; the runtime fires-and-forgets it.
  start(pitch: string, upid: string): Promise<void> {
    // Tear down any prior build for this UPID without racing the fresh state:
    // abort + forget it synchronously, drain its server in the background.
    this.#teardown(upid);
    const controller = new AbortController();
    this.#aborts.set(upid, controller);
    const signal =
      this.#options.signal === undefined ? controller.signal : AbortSignal.any([this.#options.signal, controller.signal]);
    this.#states.set(upid, { upid, status: "building", previewUrl: null, pitch });
    const task = (async () => {
      try {
        const preview = await buildIdeaPreview(pitch, upid, { ...this.#options, signal });
        if (signal.aborted) {
          // Torn down mid-build (halt / emergency stop / superseding start): the
          // state is owned elsewhere now — just make sure no server leaks.
          await preview.stop().catch(() => undefined);
          return;
        }
        this.#previews.set(upid, preview);
        this.#states.set(upid, { upid, status: "ready", previewUrl: preview.previewUrl, pitch });
      } catch (error) {
        if (!signal.aborted) {
          this.#states.set(upid, {
            upid,
            status: "failed",
            previewUrl: null,
            pitch,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        // Only clean up if THIS build is still the registered one — controller
        // and inflight entry are registered together, so the controller check
        // covers both (a superseding start()/stop() already replaced them).
        if (this.#aborts.get(upid) === controller) {
          this.#aborts.delete(upid);
          this.#inflight.delete(upid);
        }
      }
    })();
    this.#inflight.set(upid, task);
    return task;
  }

  // Await an in-flight build for a UPID (no-op once it has resolved).
  async settle(upid: string): Promise<void> {
    await this.#inflight.get(upid);
  }

  // Stop and forget one build's preview server (process halt / emergency stop).
  // Aborting FIRST is the emergency-stop fix: an in-flight builder subprocess is
  // SIGKILLed immediately, so awaiting the build settle is quick — this never
  // stalls behind the builder's 180s unattended-build ceiling.
  async stop(upid: string): Promise<void> {
    const controller = this.#aborts.get(upid);
    this.#aborts.delete(upid);
    controller?.abort();
    const inflight = this.#inflight.get(upid);
    await inflight?.catch(() => undefined);
    if (inflight !== undefined && this.#inflight.get(upid) === inflight) {
      this.#inflight.delete(upid);
    }
    const preview = this.#previews.get(upid);
    if (preview !== undefined) {
      this.#previews.delete(upid);
      await preview.stop().catch(() => undefined);
    }
    this.#states.delete(upid);
  }

  // Stop every live preview server (emergency stop / shutdown).
  async stopAll(): Promise<void> {
    const upids = [...this.#previews.keys(), ...this.#inflight.keys(), ...this.#aborts.keys()];
    await Promise.all([...new Set(upids)].map((upid) => this.stop(upid)));
  }

  // Synchronous teardown used by start(): abort + unregister the prior build so
  // the caller can immediately register a fresh one, then drain the old preview
  // server in the background (stop() would race the new state's registration).
  #teardown(upid: string): void {
    const controller = this.#aborts.get(upid);
    this.#aborts.delete(upid);
    controller?.abort();
    const inflight = this.#inflight.get(upid);
    this.#inflight.delete(upid);
    const preview = this.#previews.get(upid);
    this.#previews.delete(upid);
    this.#states.delete(upid);
    void (async () => {
      await inflight?.catch(() => undefined);
      await preview?.stop().catch(() => undefined);
    })();
  }
}

function safeSegment(upid: string): string {
  const cleaned = upid.replace(/[^a-zA-Z0-9_-]/gu, "-");
  return cleaned.length > 0 ? cleaned : "build";
}

// First sentence / clause of the pitch, capped, used as the prototype title.
function pitchTitle(pitch: string): string {
  const trimmed = pitch.trim();
  if (trimmed.length === 0) {
    return "Untitled prototype";
  }
  const firstClause = trimmed.split(/[.!?\n]/u)[0]?.trim() ?? trimmed;
  const words = firstClause.split(/\s+/u).slice(0, 10).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function renderIndexHtml(title: string, pitch: string, upid: string): string {
  const safeTitle = escapeHtml(title);
  const safePitch = escapeHtml(pitch.trim().length > 0 ? pitch.trim() : "An accepted idea, scaffolded live.");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="prototype" data-upid="${escapeHtml(upid)}">
      <p class="eyebrow">Vibersyn prototype</p>
      <h1 class="title" data-testid="prototype-title">${safeTitle}</h1>
      <p class="pitch" data-testid="prototype-pitch">${safePitch}</p>
      <section class="card">
        <h2>What this is</h2>
        <p>
          The room accepted this idea out loud. Vibersyn scaffolded this page
          on the spot and is serving it live so you can see the idea take shape.
        </p>
      </section>
      <footer class="foot">
        <span class="upid">${escapeHtml(upid)}</span>
        <span class="status" data-testid="prototype-status">ready</span>
      </footer>
    </main>
    <script src="app.js"></script>
  </body>
</html>
`;
}

function renderStyles(): string {
  return `:root {
  color-scheme: dark;
  --bg: #05070d;
  --fg: #e6f0ff;
  --accent: #5ad1ff;
  --muted: #8aa0c0;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: radial-gradient(circle at 50% 0%, #0b1426, var(--bg) 70%);
  color: var(--fg);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
.prototype { width: min(680px, 90vw); padding: 3rem 2rem; }
.eyebrow { text-transform: uppercase; letter-spacing: 0.2em; font-size: 0.7rem; color: var(--accent); margin: 0 0 0.5rem; }
.title { font-size: clamp(1.8rem, 5vw, 3rem); margin: 0 0 1rem; line-height: 1.1; }
.pitch { font-size: 1.15rem; color: var(--fg); margin: 0 0 2rem; }
.card { background: rgba(90, 209, 255, 0.06); border: 1px solid rgba(90, 209, 255, 0.18); border-radius: 14px; padding: 1.25rem 1.5rem; }
.card h2 { margin: 0 0 0.5rem; font-size: 1rem; color: var(--accent); }
.card p { margin: 0; color: var(--muted); }
.foot { display: flex; justify-content: space-between; margin-top: 2rem; font-size: 0.8rem; color: var(--muted); }
.status { color: var(--accent); }
`;
}

function renderScript(upid: string): string {
  return `// Live prototype for ${JSON.stringify(upid)}, scaffolded by Vibersyn on accept.
document.addEventListener("DOMContentLoaded", () => {
  const status = document.querySelector('[data-testid="prototype-status"]');
  if (status) {
    status.textContent = "live";
  }
});
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
