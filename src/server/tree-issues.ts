// ── ADOPTED-TREE ISSUES (GET /api/process/:upid/issues) ─────────────────────
// The origin repo's open issues for an ADOPTED tree, fetched via the same gh
// seam every other GitHub surface uses (ghRunner — tests inject a scripted
// fake, no test ever spawns a real gh). CONTRACT (the parallel UI agent
// builds against exactly this shape):
//   {issues: [{number: number, title: string, labels: string[]}]}
// Failure posture: [] on ANY failure (gh missing, non-JSON, network) — never
// a 500, never a throw. Results are cached in-memory per upid for 60s so the
// wall's polling never hammers the GitHub API.

import { ghCommandRunner, type ForestCommandRunner } from "./github-org";

export interface TreeIssue {
  number: number;
  title: string;
  labels: string[];
}

export const TREE_ISSUES_CACHE_MS = 60_000;
const ISSUES_PER_PAGE = 10;

export interface TreeIssuesCacheOptions {
  // Seam — tests inject a scripted fake; default is the real gh subprocess
  // runner (GH_TOKEN env pattern, hard timeout, never throws).
  runGh?: ForestCommandRunner;
  now?: () => number;
}

export class TreeIssuesCache {
  readonly #runGh: ForestCommandRunner;
  readonly #now: () => number;
  readonly #cache = new Map<string, { atMs: number; issues: TreeIssue[] }>();

  constructor(options: TreeIssuesCacheOptions = {}) {
    this.#runGh = options.runGh ?? ghCommandRunner;
    this.#now = options.now ?? Date.now;
  }

  // Open issues for the tree's recorded origin. origin null (local/self trees,
  // unadopted imports) short-circuits to [] without a cache entry — a later
  // adopt must not be masked by a cached empty.
  async issuesFor(upid: string, origin: string | null): Promise<TreeIssue[]> {
    if (origin === null) {
      return [];
    }
    const repoRef = ownerRepoFromOrigin(origin);
    if (repoRef === null) {
      return [];
    }
    const cached = this.#cache.get(upid);
    const nowMs = this.#now();
    if (cached !== undefined && nowMs - cached.atMs < TREE_ISSUES_CACHE_MS) {
      return cached.issues;
    }
    const issues = await this.#fetch(repoRef);
    this.#cache.set(upid, { atMs: nowMs, issues });
    return issues;
  }

  async #fetch(repoRef: string): Promise<TreeIssue[]> {
    try {
      const result = await this.#runGh(["gh", "api", `repos/${repoRef}/issues?state=open&per_page=${ISSUES_PER_PAGE}`]);
      if (!result.ok) {
        return [];
      }
      return parseIssues(result.stdout);
    } catch {
      return []; // the seam contract says runners never throw — belt and braces
    }
  }
}

// "https://github.com/<owner>/<repo>[.git]" → "owner/repo", else null.
export function ownerRepoFromOrigin(origin: string): string | null {
  const match = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/u.exec(origin);
  if (match === null) {
    return null;
  }
  return `${match[1]}/${match[2]!.replace(/\.git$/u, "")}`;
}

// Tolerant parse of gh's JSON: keep only entries with a numeric number and a
// string title; labels normalize to their names ([] otherwise). The issues
// endpoint also returns PRs (they carry pull_request) — those are dropped so
// the wall's issue fruit never shows a PR twice.
function parseIssues(stdout: string): TreeIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const issues: TreeIssue[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as { number?: unknown; title?: unknown; labels?: unknown; pull_request?: unknown };
    if (record.pull_request !== undefined || typeof record.number !== "number" || typeof record.title !== "string") {
      continue;
    }
    const labels = Array.isArray(record.labels)
      ? record.labels
          .map((label) => (typeof label === "string" ? label : (label as { name?: unknown } | null)?.name))
          .filter((name): name is string => typeof name === "string")
      : [];
    issues.push({ number: record.number, title: record.title, labels });
  }
  return issues;
}
