// GitHub Pages publisher for kickoff pitch decks — the "take it home" leg of
// the two-stage pivot. Every kicked-off idea's deck is published as a tiny
// public static site so a phone can scan a QR code on the wall and carry the
// pitch out of the room.
//
// Contract (all via the GitHub REST API — no `gh` CLI dependency; the PAT
// arrives ONLY through the environment, see resolveGitHubPat):
//   1. resolve the authenticated login (GET /user);
//   2. create a public repo named after the INFERRED PROJECT NAME: slugify the
//      process title ("Snow Sip Calculator" -> "snow-sip-calculator"); on a
//      422 name-already-exists retry with "-2", "-3", ... suffixes — the URL
//      must read as the project, never a random id (POST /user/repos);
//   3. upload a SELF-CONTAINED bundle via the contents API: index.html is the
//      pitch deck REWRITTEN for standalone life (mock iframes point at
//      RELATIVE bundled copies ./mocks/<backend>/index.html; the decision
//      buttons that POST to room-local APIs become a "this deck is a
//      take-home — the room is where you decide" note), plus .nojekyll IN THE
//      FIRST UPLOAD (without it the first Pages build can silently no-op);
//   4. enable Pages legacy (POST /repos/<login>/<repo>/pages,
//      source[branch]=main source[path]=/);
//   5. poll the PUBLIC https://<login>.github.io/<repo>/ URL until it serves
//      200 (first build takes 1-3 minutes; budget <= 5; the /pages/builds
//      endpoint alone is NOT trusted — only the public 200 counts).
//
// Everything effectful is injectable (fetch, sleep, env) so tests run with
// fakes and zero network. The composition wires publishDeck fire-and-forget
// after the first deck of a kickoff — publishing never blocks a kickoff.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const GITHUB_API_URL = "https://api.github.com";

// Repo-name suffix attempts before giving up on a colliding slug.
const MAX_NAME_ATTEMPTS = 30;
const DEFAULT_POLL_INTERVAL_MS = 8_000;
const DEFAULT_POLL_BUDGET_MS = 300_000; // <= 5 minutes, per the Pages contract
// A bundled mock file larger than this is skipped (the contents API takes
// base64 bodies; concept mocks are single self-contained HTML files).
const MAX_BUNDLED_FILE_BYTES = 2_000_000;

export interface PublishDeckInput {
  upid: string;
  // The spoken one-word handle (callsign); slug fallback when the title is empty.
  handle: string | null;
  // The inferred project name — the LLM-upgraded title when it has resolved by
  // publish time, else the deterministic one. The repo is named after THIS.
  title: string | null;
  // Absolute dir containing the local deck's index.html (…/slideshow).
  deckDir: string;
  // backend id -> absolute mock dir to bundle as ./mocks/<backend>/ (the
  // per-backend kickoff build dir; its slideshow/ subdir is excluded).
  mockDirs: Record<string, string>;
}

export interface PublishDeckOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollBudgetMs?: number;
  // Progress/trace hook (the composition logs these; tests observe ordering).
  onTrace?: (event: string, meta: Record<string, unknown>) => void;
}

export interface PublishedDeck {
  // The confirmed-200 public URL: https://<login>.github.io/<repo>/
  url: string;
  login: string;
  repo: string;
  repoUrl: string; // https://github.com/<login>/<repo>
  filesUploaded: number;
}

export type PublishDeckFn = (input: PublishDeckInput, options?: PublishDeckOptions) => Promise<PublishedDeck>;

export class PublishError extends Error {
  constructor(
    readonly stage:
      | "no-pat"
      | "deck-missing"
      | "resolve-login"
      | "create-repo"
      | "upload"
      | "enable-pages"
      | "poll-timeout",
    message: string,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

// The PAT arrives ONLY via the environment: VIBERSYN_GITHUB_PAT first, then
// the conventional GITHUB_PAT / GH_TOKEN fallbacks. Never read from disk or
// config — and never, ever written anywhere.
export function resolveGitHubPat(env: Record<string, string | undefined> = process.env): string | null {
  for (const key of ["VIBERSYN_GITHUB_PAT", "GITHUB_PAT", "GH_TOKEN"] as const) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

// 'Snow Sip Calculator' -> 'snow-sip-calculator': lowercase, alnum + hyphens
// only, no leading/trailing/doubled hyphens. Empty when nothing survives.
export function slugifyProjectName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

// The published index.html: the local deck rewritten for standalone life.
//   - Mock gallery iframes point at the RELATIVE bundled copies
//     (./mocks/<backend>/index.html); lanes that did not travel show the
//     template's own "missing" panel instead of a dead loopback URL.
//   - The decision buttons (room-local POSTs) become the take-home note. The
//     idea, title, concept copy, and mock gallery stay intact.
export function rewriteDeckForStandalone(html: string, bundledBackends: readonly string[]): string {
  const bundled = new Set(bundledBackends);
  let out = html.replace(
    /(<div class="mock-panel[^"]*" data-mock-panel="([^"]+)">)(?:<iframe class="mock-frame"[^>]*><\/iframe>|<div class="mock-frame mock-missing">[\s\S]*?<\/div>)/gu,
    (_whole: string, open: string, id: string) => {
      if (!bundled.has(id)) {
        return `${open}<div class="mock-frame mock-missing">this mock did not travel — see it live in the room</div>`;
      }
      return (
        `${open}<iframe class="mock-frame" src="./mocks/${id}/index.html" ` +
        `title="${id} concept mock" loading="lazy"></iframe>`
      );
    },
  );
  const start = out.indexOf('<div class="decisions" data-decisions>');
  const endMarker = '<p class="decision-status" data-decision-status role="status" aria-live="polite"></p>';
  const end = out.indexOf(endMarker, start);
  if (start !== -1 && end !== -1) {
    const note =
      '<div class="take-home-note" data-take-home-note>' +
      '<p class="para">This deck is a take-home — the room is where you decide.</p>' +
      '<p class="para">Back in the room, this idea can be commissioned into a real build, ' +
      "steered with a spoken correction, or parked for later. The idea, its concept, and " +
      "the mock gallery above travel with this page.</p>" +
      "</div>";
    out = out.slice(0, start) + note + out.slice(end + endMarker.length);
  }
  return out;
}

interface BundledFile {
  path: string; // repo-relative, forward slashes
  content: Uint8Array;
}

// Walk one mock dir into repo files under mocks/<backend>/ — skipping the
// slideshow/ subdir (the deck itself), dotfiles, and anything oversized. A
// lane bundles only when its index.html made it in.
async function collectMockFiles(
  backend: string,
  dir: string,
  onTrace: (event: string, meta: Record<string, unknown>) => void,
): Promise<BundledFile[] | null> {
  const files: BundledFile[] = [];
  const walk = async (current: string, relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      if (relative === "" && entry.name === "slideshow") {
        continue; // the deck rides at the repo root, not inside the mock copy
      }
      const absolute = join(current, entry.name);
      const relPath = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, relPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const info = await stat(absolute).catch(() => null);
      if (info === null || info.size > MAX_BUNDLED_FILE_BYTES) {
        onTrace("publish.bundle.skipped", { backend, file: relPath, reason: "oversized-or-unreadable" });
        continue;
      }
      files.push({ path: `mocks/${backend}/${relPath}`, content: new Uint8Array(await readFile(absolute)) });
    }
  };
  await walk(dir, "");
  const hasIndex = files.some((file) => file.path === `mocks/${backend}/index.html`);
  return hasIndex ? files : null;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

interface GitHubApi {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
}

function createApi(pat: string, fetchImpl: typeof fetch): GitHubApi {
  return {
    async request(method, path, body) {
      const response = await fetchImpl(`${GITHUB_API_URL}${path}`, {
        method,
        headers: {
          authorization: `token ${pat}`,
          accept: "application/vnd.github+json",
          "user-agent": "vibersyn-deck-publisher",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      return { status: response.status, json };
    },
  };
}

function apiMessage(json: unknown): string {
  if (typeof json === "object" && json !== null && typeof (json as Record<string, unknown>).message === "string") {
    return (json as Record<string, unknown>).message as string;
  }
  return "(no message)";
}

function isNameCollision(json: unknown): boolean {
  return JSON.stringify(json ?? "").toLowerCase().includes("already exists");
}

// Create the public repo, suffixing "-2", "-3", ... on name collisions so the
// URL still reads as the project.
async function createRepo(api: GitHubApi, baseName: string, description: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const name = attempt === 1 ? baseName : `${baseName}-${attempt}`;
    const { status, json } = await api.request("POST", "/user/repos", {
      name,
      description,
      private: false,
      has_issues: false,
      has_projects: false,
      has_wiki: false,
      auto_init: false,
    });
    if (status === 201) {
      const created = (json as Record<string, unknown> | null)?.name;
      return typeof created === "string" && created.length > 0 ? created : name;
    }
    if (status === 422 && isNameCollision(json)) {
      continue;
    }
    throw new PublishError("create-repo", `POST /user/repos ${status}: ${apiMessage(json)}`);
  }
  throw new PublishError("create-repo", `no free repo name after ${MAX_NAME_ATTEMPTS} attempts on '${baseName}'.`);
}

// Publish one kickoff deck to GitHub Pages. Resolves ONLY once the public
// github.io URL confirmed 200; throws PublishError on any failed leg.
export const publishDeck: PublishDeckFn = async (input, options = {}) => {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const onTrace = options.onTrace ?? (() => undefined);
  const pat = resolveGitHubPat(env);
  if (pat === null) {
    throw new PublishError("no-pat", "no GitHub PAT in the environment (VIBERSYN_GITHUB_PAT / GITHUB_PAT / GH_TOKEN).");
  }

  // The local deck must exist before anything network-shaped happens.
  let deckHtml: string;
  try {
    deckHtml = await readFile(join(input.deckDir, "index.html"), "utf8");
  } catch {
    throw new PublishError("deck-missing", `no deck at ${join(input.deckDir, "index.html")}.`);
  }

  // Bundle the mock lanes that actually have an entrypoint on disk.
  const mockFiles: BundledFile[] = [];
  const bundledBackends: string[] = [];
  for (const [backend, dir] of Object.entries(input.mockDirs)) {
    const files = await collectMockFiles(backend, dir, onTrace);
    if (files === null) {
      onTrace("publish.bundle.lane-skipped", { backend, reason: "no index.html" });
      continue;
    }
    bundledBackends.push(backend);
    mockFiles.push(...files);
  }
  const standalone = rewriteDeckForStandalone(deckHtml, bundledBackends);

  const api = createApi(pat, fetchImpl);

  // 1. Who owns the PAT — the login anchors both repo and Pages URLs.
  const user = await api.request("GET", "/user");
  const login = (user.json as Record<string, unknown> | null)?.login;
  if (user.status !== 200 || typeof login !== "string" || login.length === 0) {
    throw new PublishError("resolve-login", `GET /user ${user.status}: ${apiMessage(user.json)}`);
  }

  // 2. Public repo named after the inferred project.
  const slug =
    slugifyProjectName(input.title ?? "") ||
    slugifyProjectName(input.handle ?? "") ||
    slugifyProjectName(input.upid) ||
    "vibersyn-deck";
  const description = `Vibersyn pitch deck — ${input.title ?? input.handle ?? input.upid} (take-home from the room).`;
  const repo = await createRepo(api, slug, description);
  onTrace("publish.repo.created", { repo, login });

  // 3. Upload the bundle sequentially (parallel PUTs race the branch ref).
  //    .nojekyll rides in the FIRST upload — without it the first Pages build
  //    can silently no-op.
  const uploads: BundledFile[] = [
    { path: ".nojekyll", content: new Uint8Array(0) },
    { path: "index.html", content: new TextEncoder().encode(standalone) },
    ...mockFiles,
  ];
  for (const file of uploads) {
    const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");
    const put = await api.request("PUT", `/repos/${login}/${repo}/contents/${encodedPath}`, {
      message: `publish: ${file.path}`,
      content: toBase64(file.content),
      branch: "main",
    });
    if (put.status !== 201 && put.status !== 200) {
      throw new PublishError("upload", `PUT contents/${file.path} ${put.status}: ${apiMessage(put.json)}`);
    }
  }
  onTrace("publish.uploaded", { files: uploads.length });

  // 4. Enable Pages legacy (deploy-from-branch): main + /.
  const pages = await api.request("POST", `/repos/${login}/${repo}/pages`, {
    build_type: "legacy",
    source: { branch: "main", path: "/" },
  });
  // 409 = Pages already enabled for this repo — the goal state, not a failure.
  if (pages.status !== 201 && pages.status !== 204 && pages.status !== 409) {
    throw new PublishError("enable-pages", `POST /pages ${pages.status}: ${apiMessage(pages.json)}`);
  }
  onTrace("publish.pages.enabled", { status: pages.status });

  // 5. Poll the PUBLIC URL until it actually serves. /pages/builds alone is
  //    not trusted — only a 200 from github.io counts as published.
  const url = `https://${login}.github.io/${repo}/`;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollBudgetMs = options.pollBudgetMs ?? DEFAULT_POLL_BUDGET_MS;
  const startedAt = Date.now();
  for (;;) {
    let status = 0;
    try {
      const probe = await fetchImpl(url, {
        method: "GET",
        headers: { "user-agent": "vibersyn-deck-publisher", "cache-control": "no-cache" },
        redirect: "follow",
      });
      status = probe.status;
      // Drain so keep-alive sockets recycle cleanly during a long poll.
      await probe.arrayBuffer().catch(() => undefined);
    } catch {
      status = 0;
    }
    if (status === 200) {
      break;
    }
    if (Date.now() - startedAt + pollIntervalMs > pollBudgetMs) {
      throw new PublishError(
        "poll-timeout",
        `${url} never served 200 inside ${Math.round(pollBudgetMs / 1000)}s (last status ${status}); ` +
          `the repo ${login}/${repo} exists — the Pages build may still land late.`,
      );
    }
    await sleep(pollIntervalMs);
  }

  return {
    url,
    login,
    repo,
    repoUrl: `https://github.com/${login}/${repo}`,
    filesUploaded: uploads.length,
  };
};

// Best-effort cleanup for test publishes (DELETE /repos/:login/:repo — needs
// the delete_repo scope). Returns whether GitHub accepted the delete.
export async function deleteRepo(
  login: string,
  repo: string,
  options: PublishDeckOptions = {},
): Promise<boolean> {
  const pat = resolveGitHubPat(options.env ?? process.env);
  if (pat === null) {
    return false;
  }
  const api = createApi(pat, options.fetchImpl ?? fetch);
  const result = await api.request("DELETE", `/repos/${login}/${repo}`);
  return result.status === 204;
}
