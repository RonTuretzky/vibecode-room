import { readFile as fsReadFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ghCommandRunner, type ForestCommandRunner } from "./github-org";

/**
 * Deployment resolver — an imported tree FINDS its live deployment.
 *
 * A GitHub import is more than its code: many repos are already deployed
 * somewhere, and the wall wants to show the LIVE app beside the tree (the
 * holo panel's /salem iframe). This module owns the resolution chain, kicked
 * fire-and-forget by the import routine after the clone settles:
 *
 *   (a) VIBERSYN_DEPLOY_MAP env override — "owner/repo=url[,owner2/repo2=url2]".
 *       An exact owner/repo match WINS UNCONDITIONALLY, no probe: this is the
 *       demo guarantee (the .env carries the convent-profile entry), and an
 *       operator-pinned URL must never lose to a scraped README link.
 *   (b) Clone scrape — README.md + deploy/ files in the checkout, mined for
 *       https URLs AND bare domains (valid TLD shape; github/badge/shields/
 *       localhost skipped), each HEAD-probed in order of appearance. The first
 *       2xx/3xx/401/403 wins — 401/403 means EXISTS-BUT-AUTHED, which is still
 *       the deployment (the /salem proxy carries the session).
 *   (c) gh garnish — the repo's homepageUrl and the latest deployments-API
 *       environment url, probed the same way. Cheap and ordered last.
 *
 * Everything is seam-injected (readFile/listDir for the clone, probeFetch for
 * HEAD probes, ghRunner for gh) so the chain is pure-testable: no test ever
 * touches the network or spawns a gh subprocess.
 */

export interface DeployResolution {
  url: string;
  source: "map" | "scrape" | "gh";
}

export interface DeployResolveInput {
  owner: string;
  repo: string;
  // The successful clone's checkout dir (builds/<upid>/repo), or null when no
  // checkout exists (clone failed): the scrape stage is skipped, but the map
  // override — the demo guarantee — and the gh garnish still run.
  repoDir: string | null;
}

export interface DeployResolverSeams {
  // Env source for VIBERSYN_DEPLOY_MAP. Defaults to process.env.
  env?: Record<string, string | undefined>;
  // HEAD-probe seam. Defaults to real fetch; tests inject scripted responses.
  probeFetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  // Clone-file seams. Default to real fs; tests inject in-memory maps.
  readFile?: (path: string) => Promise<string>;
  listDir?: (path: string) => Promise<string[]>;
  // gh seam (same runner contract as the forest loader / tree substrate).
  ghRunner?: ForestCommandRunner;
}

// Per-candidate HEAD budget: a deployment that cannot answer a HEAD in 3s is
// not demo material, and the whole chain must never wedge the import routine.
export const DEPLOY_PROBE_TIMEOUT_MS = 3_000;
// Scrape bounds: untrusted checkout content, so every read is capped.
const MAX_DEPLOY_DIR_FILES = 12;
const MAX_SCAN_CHARS = 65_536;
const MAX_PROBES = 8;

// Hosts that are never a deployment: the repo's own forge, badge/shield
// decorations, loopback, and the most common README doc-link hosts (a docs
// link answering 200 first would steal the win from the real app).
const SKIP_HOST_SUFFIXES = [
  "github.com",
  "githubusercontent.com",
  "localhost",
  "example.com",
  "example.org",
  "example.net",
  "npmjs.com",
  "nodejs.org",
  "bun.sh",
  "mozilla.org",
  "wikipedia.org",
  "w3.org",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
  "discord.com",
  "discord.gg",
  "opensource.org",
];

// Bare-domain false positives: README prose is full of file names whose
// extension is domain-shaped ("vite.config.js", "README.md" — .md IS a real
// ccTLD, but in a repo it is overwhelmingly a file). Full https:// URLs are
// trusted and never filtered by this list.
const NON_TLD_LABELS = new Set([
  "js", "ts", "tsx", "jsx", "mjs", "cjs", "json", "jsonc", "md", "txt", "yml", "yaml",
  "toml", "lock", "html", "htm", "css", "scss", "png", "jpg", "jpeg", "gif", "svg",
  "webp", "ico", "mp4", "mov", "py", "rb", "rs", "go", "java", "cpp", "wasm", "map",
  "env", "sql", "db", "log", "test", "spec", "config", "local", "min", "example",
]);

// Parse "owner/repo=url[,owner2/repo2=url2]" into a lowercase-keyed map.
// Malformed entries (no "=", empty halves, key without a "/") are skipped —
// a typo in one entry must never break the others.
export function parseDeployMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (raw === undefined || raw.trim().length === 0) {
    return map;
  }
  for (const entry of raw.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = entry.slice(0, separator).trim().toLowerCase();
    const url = entry.slice(separator + 1).trim();
    if (key.length === 0 || url.length === 0 || !key.includes("/")) {
      continue;
    }
    map.set(key, url);
  }
  return map;
}

function skipHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "127.0.0.1" || lower === "0.0.0.0" || lower === "[::1]") {
    return true;
  }
  if (lower.includes("badge") || lower.includes("shields")) {
    return true;
  }
  return SKIP_HOST_SUFFIXES.some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`));
}

// Mine a text blob for deployment candidates: full https URLs first (order of
// appearance), then bare domains promoted to https://<domain>/. Deduped by
// host; trailing prose punctuation stripped; skip-list + TLD-shape filtered.
export function extractDeployCandidates(text: string): string[] {
  const bounded = text.slice(0, MAX_SCAN_CHARS);
  const candidates: string[] = [];
  const seenHosts = new Set<string>();
  const push = (url: string): void => {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return;
    }
    if (host.length === 0 || seenHosts.has(host) || skipHost(host)) {
      return;
    }
    seenHosts.add(host);
    candidates.push(url);
  };

  const urlPattern = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/[^\s"'<>()[\]{}`]*)?/gi;
  for (const match of bounded.matchAll(urlPattern)) {
    push(match[0].replace(/[.,;:!?'")\]]+$/, ""));
  }

  const domainPattern = /[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
  for (const match of bounded.matchAll(domainPattern)) {
    const domain = match[0].toLowerCase();
    // Not part of a larger token: the char before must not glue this to an
    // email local part, a path segment, or a longer host the URL pass took.
    const before = match.index > 0 ? bounded[match.index - 1] : "";
    if (before !== undefined && /[@/\w.-]/.test(before)) {
      continue;
    }
    const labels = domain.split(".");
    const tld = labels[labels.length - 1] ?? "";
    // Valid TLD shape: all-alpha, 2+ chars, and not a file-extension label.
    if (!/^[a-z]{2,24}$/.test(tld) || NON_TLD_LABELS.has(tld)) {
      continue;
    }
    push(`https://${domain}/`);
  }
  return candidates;
}

// A live deployment answers a HEAD: 2xx/3xx obviously, and 401/403 count too —
// exists-but-authed IS the deployment (the /salem proxy holds the session).
function deployStatusHits(status: number): boolean {
  return (status >= 200 && status < 400) || status === 401 || status === 403;
}

async function probeFirstLive(
  candidates: string[],
  probe: NonNullable<DeployResolverSeams["probeFetch"]>,
): Promise<string | null> {
  for (const candidate of candidates.slice(0, MAX_PROBES)) {
    try {
      const response = await probe(candidate, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(DEPLOY_PROBE_TIMEOUT_MS),
      });
      if (deployStatusHits(response.status)) {
        return candidate;
      }
    } catch {
      // Down/DNS-dead/timed out — the next candidate gets its turn.
    }
  }
  return null;
}

async function scrapeCloneText(repoDir: string, seams: DeployResolverSeams): Promise<string> {
  const readFile = seams.readFile ?? ((path: string) => fsReadFile(path, "utf8"));
  const listDir = seams.listDir ?? (async (path: string) => (await readdir(path)) as string[]);
  const chunks: string[] = [];
  try {
    chunks.push((await readFile(join(repoDir, "README.md"))).slice(0, MAX_SCAN_CHARS));
  } catch {
    // No README — deploy/ may still name the host.
  }
  let deployFiles: string[] = [];
  try {
    deployFiles = (await listDir(join(repoDir, "deploy"))).slice(0, MAX_DEPLOY_DIR_FILES);
  } catch {
    // No deploy/ dir.
  }
  for (const name of deployFiles) {
    try {
      chunks.push((await readFile(join(repoDir, "deploy", name))).slice(0, MAX_SCAN_CHARS));
    } catch {
      // Unreadable (subdir/binary) — skip.
    }
  }
  return chunks.join("\n");
}

// The gh garnish: homepageUrl + the latest deployment's environment_url.
// Ordered last because both are empty for most repos — but they are cheap,
// and a repo that DOES fill them in deserves the win over nothing.
async function ghDeployCandidates(owner: string, repo: string, runGh: ForestCommandRunner): Promise<string[]> {
  const candidates: string[] = [];
  const slug = `${owner}/${repo}`;
  try {
    const view = await runGh(["gh", "repo", "view", slug, "--json", "homepageUrl", "--jq", ".homepageUrl"]);
    const homepage = view.ok ? view.stdout.trim() : "";
    if (homepage.length > 0 && homepage !== "null") {
      candidates.push(homepage.startsWith("http") ? homepage : `https://${homepage}`);
    }
  } catch {
    // Runner contract says it never throws; belt and braces anyway.
  }
  try {
    const deployments = await runGh(["gh", "api", `repos/${slug}/deployments?per_page=1`]);
    if (deployments.ok) {
      const parsed = JSON.parse(deployments.stdout) as Array<{ id?: number }>;
      const latestId = Array.isArray(parsed) ? parsed[0]?.id : undefined;
      if (typeof latestId === "number") {
        const statuses = await runGh(["gh", "api", `repos/${slug}/deployments/${latestId}/statuses?per_page=5`]);
        if (statuses.ok) {
          const parsedStatuses = JSON.parse(statuses.stdout) as Array<{ environment_url?: string }>;
          const environmentUrl = Array.isArray(parsedStatuses)
            ? parsedStatuses.find((status) => typeof status.environment_url === "string" && status.environment_url.length > 0)
                ?.environment_url
            : undefined;
          if (environmentUrl !== undefined) {
            candidates.push(environmentUrl);
          }
        }
      }
    }
  } catch {
    // Malformed JSON / gh missing — the garnish just yields nothing.
  }
  return candidates;
}

// The whole chain. Never throws; null = no deployment found (most repos).
export async function resolveDeployUrl(
  input: DeployResolveInput,
  seams: DeployResolverSeams = {},
): Promise<DeployResolution | null> {
  const env = seams.env ?? process.env;
  // (a) The operator's map override wins unconditionally — no probe. The demo
  // must not hinge on a README scrape or GitHub metadata being right tonight.
  const mapped = parseDeployMap(env.VIBERSYN_DEPLOY_MAP).get(`${input.owner}/${input.repo}`.toLowerCase());
  if (mapped !== undefined) {
    return { url: mapped, source: "map" };
  }
  const probe = seams.probeFetch ?? fetch;
  // (b) Scrape the checkout (when one exists) and probe in order of appearance.
  if (input.repoDir !== null) {
    try {
      const scraped = await probeFirstLive(extractDeployCandidates(await scrapeCloneText(input.repoDir, seams)), probe);
      if (scraped !== null) {
        return { url: scraped, source: "scrape" };
      }
    } catch {
      // Scrape must never sink the chain — fall through to the garnish.
    }
  }
  // (c) gh garnish, probed the same way.
  try {
    const garnished = await probeFirstLive(await ghDeployCandidates(input.owner, input.repo, seams.ghRunner ?? ghCommandRunner), probe);
    if (garnished !== null) {
      return { url: garnished, source: "gh" };
    }
  } catch {
    // gh unavailable — honestly nothing found.
  }
  return null;
}
