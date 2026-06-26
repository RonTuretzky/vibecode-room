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

export interface BuildIdeaPreviewOptions {
  // Root the per-UPID build directories live under. Defaults to <cwd>/builds.
  // Tests point this at a temp dir so the repo tree stays clean.
  buildsRoot?: string;
  // Hostname to bind the static server to. Always loopback in practice.
  host?: string;
}

const DEFAULT_HOST = "127.0.0.1";

function defaultBuildsRoot(): string {
  return resolve(process.cwd(), "builds");
}

// A minimal static file server bound to an ephemeral loopback port. Returns the
// listening port plus a stop() that closes the socket. Uses Bun.serve when
// available (the project runtime), else a node:http fallback so the module is
// usable from any test harness.
interface StaticServer {
  port: number;
  stop(): Promise<void>;
}

async function serveDirectory(dir: string, host: string): Promise<StaticServer> {
  const bun = (globalThis as { Bun?: typeof import("bun") }).Bun;
  if (bun !== undefined && typeof bun.serve === "function") {
    const server = bun.serve({
      hostname: host,
      port: 0, // ephemeral
      async fetch(request) {
        const file = resolveRequestedFile(dir, new URL(request.url).pathname);
        const handle = bun.file(file);
        if (!(await handle.exists())) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(handle);
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

async function serveDirectoryNode(dir: string, host: string): Promise<StaticServer> {
  const http = await import("node:http");
  const { readFile, stat } = await import("node:fs/promises");
  const server = http.createServer((request, response) => {
    void (async () => {
      try {
        const file = resolveRequestedFile(dir, request.url ?? "/");
        const info = await stat(file).catch(() => null);
        if (info === null || !info.isFile()) {
          response.statusCode = 404;
          response.end("Not found");
          return;
        }
        const body = await readFile(file);
        response.statusCode = 200;
        response.setHeader("content-type", contentTypeFor(file));
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

// Map a request path to a file inside the build directory, defaulting "/" to
// index.html and refusing to escape the directory (no "..").
function resolveRequestedFile(dir: string, pathname: string): string {
  const clean = pathname.split("?")[0]?.split("#")[0] ?? "/";
  const relative = clean === "/" || clean === "" ? "index.html" : clean.replace(/^\/+/u, "");
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

// Scaffold a fresh build directory + start a real preview server for one accepted
// idea. The page content is a deterministic function of the pitch — same pitch,
// same artifact — so no external LLM call is needed on the hot accept path.
export async function buildIdeaPreview(
  pitch: string,
  upid: string,
  options: BuildIdeaPreviewOptions = {},
): Promise<IdeaPreview> {
  const root = options.buildsRoot ?? defaultBuildsRoot();
  const host = options.host ?? DEFAULT_HOST;
  const dir = join(root, safeSegment(upid));

  // Fresh directory: an accept always starts the artifact from scratch.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const title = pitchTitle(pitch);
  await writeFile(join(dir, "index.html"), renderIndexHtml(title, pitch, upid), "utf8");
  await writeFile(join(dir, "styles.css"), renderStyles(), "utf8");
  await writeFile(join(dir, "app.js"), renderScript(upid), "utf8");

  const server = await serveDirectory(dir, host);
  const previewUrl = `http://${host}:${server.port}/`;

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
    void this.stop(upid);
    this.#states.set(upid, { upid, status: "building", previewUrl: null, pitch });
    const task = (async () => {
      try {
        const preview = await buildIdeaPreview(pitch, upid, this.#options);
        this.#previews.set(upid, preview);
        this.#states.set(upid, { upid, status: "ready", previewUrl: preview.previewUrl, pitch });
      } catch (error) {
        this.#states.set(upid, {
          upid,
          status: "failed",
          previewUrl: null,
          pitch,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.#inflight.delete(upid);
      }
    })();
    this.#inflight.set(upid, task);
    return task;
  }

  // Await an in-flight build for a UPID (no-op once it has resolved).
  async settle(upid: string): Promise<void> {
    await this.#inflight.get(upid);
  }

  // Stop and forget one build's preview server (process halt).
  async stop(upid: string): Promise<void> {
    await this.#inflight.get(upid)?.catch(() => undefined);
    const preview = this.#previews.get(upid);
    if (preview !== undefined) {
      this.#previews.delete(upid);
      await preview.stop().catch(() => undefined);
    }
    this.#states.delete(upid);
  }

  // Stop every live preview server (emergency stop / shutdown).
  async stopAll(): Promise<void> {
    const upids = [...this.#previews.keys(), ...this.#inflight.keys()];
    await Promise.all([...new Set(upids)].map((upid) => this.stop(upid)));
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
      <p class="eyebrow">Panopticon prototype</p>
      <h1 class="title" data-testid="prototype-title">${safeTitle}</h1>
      <p class="pitch" data-testid="prototype-pitch">${safePitch}</p>
      <section class="card">
        <h2>What this is</h2>
        <p>
          The room accepted this idea out loud. Panopticon scaffolded this page
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
  return `// Live prototype for ${JSON.stringify(upid)}, scaffolded by Panopticon on accept.
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
