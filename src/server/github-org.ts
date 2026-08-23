// ── GitHub org loader for the forest (Phase 5) ──────────────────────────────
// Given an org (or user) name, assembles the /api/forest payload the grove
// window renders: the ~30 most recently pushed repos, each with its OPEN PRs
// (number/title/draft/CI from statusCheckRollup/base+head refs, with stacked
// PRs linked: baseRef == another open PR's headRef) and OPEN issues
// (number/title/label names). Everything goes through the `gh` CLI — the
// operator's auth (gh login or VIBERSYN_GITHUB_PAT) rides along, no bespoke
// REST client. Contracts:
//   • the command runner and the clock are constructor-injected — tests script
//     gh outputs and drive the refresh cadence with a fake clock, no network;
//   • while an org is loaded it refreshes every ~5 minutes (a real interval
//     timer calls tick(); tick() itself is clock-gated and public for tests);
//   • every successful fetch is cached to artifacts/forest/<org>.json, and a
//     failed fetch serves the stale cache (memory first, disk on a cold start)
//     instead of blanking the wall;
//   • a fetch failure NEVER throws out of the loader — the current payload
//     (or {org:null}) simply stays.
// The payload/type source of truth lives in src/ui/forest-spec.ts (the same
// server→ui type import direction app.ts already uses for ProjectorSnapshot).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import type { ForestCi, ForestIssue, ForestPayload, ForestPr, ForestRepo, ForestState } from "../ui/forest-spec";

export type { ForestCi, ForestIssue, ForestPayload, ForestPr, ForestRepo, ForestState } from "../ui/forest-spec";

const REPO_CAP = 30;
const PR_CAP = 40;
const ISSUE_CAP = 40;
const REFRESH_MS = 5 * 60_000;
// The real interval checks dueness once a minute; tick() only refetches when
// the injected clock says the last attempt is REFRESH_MS old.
const TICK_MS = 60_000;
const GH_TIMEOUT_MS = 30_000;

export interface ForestCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type ForestCommandRunner = (argv: string[]) => Promise<ForestCommandResult>;

// The default runner: a real `gh` subprocess with a hard timeout (gh must
// never wedge the loader), non-interactive, VIBERSYN_GITHUB_PAT forwarded as
// GH_TOKEN when no gh auth is present. Never throws — a missing binary comes
// back as { ok: false } like any other failure.
export const ghCommandRunner: ForestCommandRunner = async (argv) => {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const env: Record<string, string | undefined> = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
    if (env.GH_TOKEN === undefined && env.GITHUB_TOKEN === undefined && env.VIBERSYN_GITHUB_PAT !== undefined) {
      env.GH_TOKEN = env.VIBERSYN_GITHUB_PAT;
    }
    proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
    killTimer = setTimeout(() => proc?.kill(9), GH_TIMEOUT_MS);
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout instanceof ReadableStream ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : Promise.resolve(""),
      proc.exited,
    ]);
    return { ok: exitCode === 0, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  } finally {
    if (killTimer !== null) {
      clearTimeout(killTimer);
    }
  }
};

// Accepts "org", "@org", or a github.com URL/path prefix; returns the bare
// GitHub login (1-39 chars, alphanumeric + hyphens, no leading hyphen) or
// null. The result is filesystem-safe by construction (cache filenames).
export function normalizeOrgName(raw: string): string | null {
  let text = raw.trim();
  if (text.startsWith("@")) {
    text = text.slice(1);
  }
  const urlMatch = /^https?:\/\/(?:www\.)?github\.com\/([^/?#\s]+)/iu.exec(text);
  if (urlMatch !== null) {
    text = urlMatch[1];
  }
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(text) ? text : null;
}

// statusCheckRollup (gh pr list --json) → the forest's four-way CI verdict.
// Handles both context shapes: CheckRun {status, conclusion} and StatusContext
// {state}. Any failure wins; else any incomplete check reads pending; an empty
// /missing rollup is "none" (no CI configured — a resting state, not an error).
export function ciFromStatusCheckRollup(rollup: unknown): ForestCi {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return "none";
  }
  let pending = false;
  for (const entry of rollup) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const state = typeof record.state === "string" ? record.state : null;
    const status = typeof record.status === "string" ? record.status : null;
    const conclusion = typeof record.conclusion === "string" ? record.conclusion : null;
    if (state === "FAILURE" || state === "ERROR") {
      return "fail";
    }
    if (
      conclusion === "FAILURE" ||
      conclusion === "TIMED_OUT" ||
      conclusion === "CANCELLED" ||
      conclusion === "ACTION_REQUIRED" ||
      conclusion === "STARTUP_FAILURE"
    ) {
      return "fail";
    }
    if (state === "PENDING" || state === "EXPECTED") {
      pending = true;
    }
    if (status !== null && status !== "COMPLETED") {
      pending = true;
    }
  }
  return pending ? "pending" : "pass";
}

// Stacked-PR linking: a PR whose base ref IS another open PR's head ref sits
// on top of that PR — the forest grows its branch from the parent's tip.
export function linkStackedPrs(prs: ForestPr[]): ForestPr[] {
  const byHead = new Map<string, ForestPr>();
  for (const pr of prs) {
    if (pr.headRef.length > 0 && !byHead.has(pr.headRef)) {
      byHead.set(pr.headRef, pr);
    }
  }
  return prs.map((pr) => {
    const parent = byHead.get(pr.baseRef);
    return parent !== undefined && parent.number !== pr.number ? { ...pr, stackedOn: parent.number } : pr;
  });
}

export interface ForestLoaderOptions {
  run?: ForestCommandRunner;
  now?: () => number;
  // Disk cache root; default <cwd>/artifacts/forest.
  cacheDir?: string;
  refreshMs?: number;
  // Real-timer cadence for tick(); null = no timer (tests drive tick() by hand).
  intervalMs?: number | null;
}

export class ForestLoader {
  readonly #run: ForestCommandRunner;
  readonly #now: () => number;
  readonly #cacheDir: string;
  readonly #refreshMs: number;
  readonly #intervalMs: number | null;
  #org: string | null = null;
  #payload: ForestPayload | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight: Promise<void> | null = null;
  #lastAttemptMs = Number.NEGATIVE_INFINITY;

  constructor(options: ForestLoaderOptions = {}) {
    this.#run = options.run ?? ghCommandRunner;
    this.#now = options.now ?? Date.now;
    this.#cacheDir = options.cacheDir ?? resolve(process.cwd(), "artifacts", "forest");
    this.#refreshMs = options.refreshMs ?? REFRESH_MS;
    this.#intervalMs = options.intervalMs === undefined ? TICK_MS : options.intervalMs;
  }

  // Start (or re-kick) loading an org. Serves the disk cache immediately when
  // switching to an org with one, then fetches fresh in the same call. The
  // returned promise settles when the fetch attempt is done — the HTTP route
  // fires-and-forgets it (202).
  async load(org: string): Promise<void> {
    const normalized = normalizeOrgName(org);
    if (normalized === null) {
      return;
    }
    if (this.#org !== normalized) {
      this.#org = normalized;
      this.#payload = null;
      // Cold start / org switch: stale cache beats an empty wall.
      const cached = await this.#readCache(normalized);
      if (cached !== null && this.#org === normalized) {
        this.#payload = cached;
      }
    }
    this.#armTimer();
    await this.#refresh();
  }

  current(): ForestState {
    if (this.#payload !== null) {
      return this.#payload;
    }
    return this.#org === null ? { org: null } : { org: null, loading: this.#org };
  }

  // Clock-gated refresh check — the interval calls this every TICK_MS; tests
  // call it directly with an injected clock.
  async tick(): Promise<void> {
    if (this.#org === null || this.#now() - this.#lastAttemptMs < this.#refreshMs) {
      return;
    }
    await this.#refresh();
  }

  dispose(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #armTimer(): void {
    if (this.#timer !== null || this.#intervalMs === null) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#intervalMs);
    // Never hold the process open for a background poll.
    (this.#timer as unknown as { unref?: () => void }).unref?.();
  }

  // Coalesced fetch: one in-flight refresh at a time; failures keep whatever
  // is currently served (memory payload or the disk-cache stale copy).
  #refresh(): Promise<void> {
    if (this.#inFlight !== null) {
      return this.#inFlight;
    }
    const org = this.#org;
    if (org === null) {
      return Promise.resolve();
    }
    this.#lastAttemptMs = this.#now();
    this.#inFlight = this.#fetchOrg(org)
      .then(async (payload) => {
        if (payload !== null && this.#org === org) {
          this.#payload = payload;
          await this.#writeCache(payload);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.#inFlight = null;
      });
    return this.#inFlight;
  }

  async #fetchOrg(org: string): Promise<ForestPayload | null> {
    const list = await this.#run(["gh", "repo", "list", org, "--limit", String(REPO_CAP), "--json", "name,pushedAt"]);
    if (!list.ok) {
      return null;
    }
    const refs = parseRepoList(list.stdout);
    if (refs === null) {
      return null;
    }
    refs.sort((a, b) => b.pushedAtMs - a.pushedAtMs);
    const repos: ForestRepo[] = [];
    for (const ref of refs.slice(0, REPO_CAP)) {
      const target = `${org}/${ref.name}`;
      // Per-repo degradation: a failed pr/issue listing empties that repo's
      // lists instead of failing the whole org fetch.
      const [prsResult, issuesResult] = await Promise.all([
        this.#run([
          "gh", "pr", "list", "-R", target, "--state", "open", "--limit", String(PR_CAP),
          "--json", "number,title,isDraft,statusCheckRollup,baseRefName,headRefName",
        ]),
        this.#run([
          "gh", "issue", "list", "-R", target, "--state", "open", "--limit", String(ISSUE_CAP),
          "--json", "number,title,labels",
        ]),
      ]);
      repos.push({
        name: ref.name,
        pushedAtMs: ref.pushedAtMs,
        prs: prsResult.ok ? linkStackedPrs(parsePrList(prsResult.stdout)) : [],
        issues: issuesResult.ok ? parseIssueList(issuesResult.stdout) : [],
      });
    }
    return { org, fetchedAtMs: this.#now(), repos };
  }

  #cachePath(org: string): string {
    return join(this.#cacheDir, `${org}.json`);
  }

  async #readCache(org: string): Promise<ForestPayload | null> {
    try {
      const raw = await readFile(this.#cachePath(org), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" && parsed !== null &&
        (parsed as { org?: unknown }).org === org &&
        typeof (parsed as { fetchedAtMs?: unknown }).fetchedAtMs === "number" &&
        Array.isArray((parsed as { repos?: unknown }).repos)
      ) {
        return parsed as ForestPayload;
      }
      return null;
    } catch {
      return null;
    }
  }

  async #writeCache(payload: ForestPayload): Promise<void> {
    try {
      await mkdir(this.#cacheDir, { recursive: true });
      await writeFile(this.#cachePath(payload.org), JSON.stringify(payload), "utf8");
    } catch {
      // Cache is best-effort — a read-only disk never breaks the live payload.
    }
  }
}

// ── scripted-JSON parsing (tolerant: gh's shapes, junk skipped) ─────────────

function parseJsonArray(stdout: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseRepoList(stdout: string): Array<{ name: string; pushedAtMs: number }> | null {
  const items = parseJsonArray(stdout);
  if (items === null) {
    return null;
  }
  const refs: Array<{ name: string; pushedAtMs: number }> = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) {
      continue;
    }
    const pushedAtMs = typeof record.pushedAt === "string" ? Date.parse(record.pushedAt) : Number.NaN;
    refs.push({ name: record.name, pushedAtMs: Number.isNaN(pushedAtMs) ? 0 : pushedAtMs });
  }
  return refs;
}

function parsePrList(stdout: string): ForestPr[] {
  const items = parseJsonArray(stdout) ?? [];
  const prs: ForestPr[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.number !== "number" || typeof record.title !== "string") {
      continue;
    }
    prs.push({
      number: record.number,
      title: record.title,
      draft: record.isDraft === true,
      ci: ciFromStatusCheckRollup(record.statusCheckRollup),
      baseRef: typeof record.baseRefName === "string" ? record.baseRefName : "",
      headRef: typeof record.headRefName === "string" ? record.headRefName : "",
    });
  }
  return prs;
}

function parseIssueList(stdout: string): ForestIssue[] {
  const items = parseJsonArray(stdout) ?? [];
  const issues: ForestIssue[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.number !== "number" || typeof record.title !== "string") {
      continue;
    }
    const labels: string[] = [];
    if (Array.isArray(record.labels)) {
      for (const label of record.labels) {
        if (typeof label === "object" && label !== null && typeof (label as { name?: unknown }).name === "string") {
          labels.push((label as { name: string }).name);
        }
      }
    }
    issues.push({ number: record.number, title: record.title, labels });
  }
  return issues;
}

// ── HTTP surface ────────────────────────────────────────────────────────────

// The structural seam the routes need — app.test.ts injects a fake.
export interface ForestSurfaceLoader {
  load(org: string): Promise<void>;
  current(): ForestState;
}

// POST /api/org/import {org} → 202 (loading kicked in the background; bad org
// names are a 400) · GET /api/forest → the current payload or {org:null}.
export function registerForestSurface(app: Hono, options: { loader: ForestSurfaceLoader }): void {
  app.post("/api/org/import", async (context) => {
    const body = (await context.req.json().catch(() => null)) as { org?: unknown } | null;
    const org = body !== null && typeof body.org === "string" ? normalizeOrgName(body.org) : null;
    if (org === null) {
      return context.json({ ok: false, error: "body must be {org: <github org or user name>}" }, 400);
    }
    void options.loader.load(org).catch(() => undefined);
    return context.json({ ok: true, org }, 202);
  });
  app.get("/api/forest", (context) => context.json(options.loader.current()));
}

// The process-wide loader instance createProjectorApp registers: every app
// (and any future listener) shares one org state, and nothing spawns until
// the first /api/org/import.
let sharedLoader: ForestLoader | null = null;
export function sharedForestLoader(): ForestLoader {
  sharedLoader ??= new ForestLoader();
  return sharedLoader;
}
