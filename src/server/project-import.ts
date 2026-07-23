import { networkInterfaces } from "node:os";

// Phone project import (QR flow): a phone scans the wall's QR overlay, lands on
// GET /submit, and POSTs { context, url } to /api/projects/import. These are the
// pure pieces: request validation (context is the primary field; the link is
// optional and may be ANY http(s) URL — but the GitHub CLONE routine only fires
// on an exact-host github.com/<owner>/<repo> match, so host spoofs like
// github.com.evil.com can never be cloned), the repo→callsign derivation, and
// the LAN-reachable submit URL for the QR code.

export type GitHubImportUrl = { ok: true; url: string; owner: string; repo: string };
export type GitHubImportError = { ok: false; error: string };

// Validate a GitHub repository URL. Accepted shape (contract-fixed):
// http(s)://github.com/<owner>/<repo> (www.github.com also allowed, extra path
// segments tolerated). Host must be EXACTLY github.com/www.github.com — URL
// parsing (not string matching) so userinfo/subdomain spoofs cannot pass.
export function parseGitHubImportUrl(raw: unknown): GitHubImportUrl | GitHubImportError {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "Provide a GitHub repository URL." };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, error: "Not a valid URL." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "Only http(s) GitHub URLs are accepted." };
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return { ok: false, error: "Host must be exactly github.com." };
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  const [owner, repoSegment] = segments;
  if (owner === undefined || repoSegment === undefined) {
    return { ok: false, error: "URL must be https://github.com/<owner>/<repo>." };
  }
  // Malformed percent-encoding (e.g. "%zz") makes decodeURIComponent throw —
  // that's a caller input problem, not a server fault: map it to a clean 400.
  const decodedOwner = safeDecode(owner);
  const decodedRepo = safeDecode(repoSegment);
  if (decodedOwner === null || decodedRepo === null) {
    return { ok: false, error: "URL must be https://github.com/<owner>/<repo>." };
  }
  const repo = decodedRepo.replace(/\.git$/u, "");
  if (repo.length === 0) {
    return { ok: false, error: "URL must be https://github.com/<owner>/<repo>." };
  }
  return { ok: true, url: parsed.toString(), owner: decodedOwner, repo };
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

// The refactored phone-import contract: CONTEXT is the primary field (free text
// steering what the fleet should build), the LINK is optional and may be any
// http(s) URL. Exactly one of three shapes comes back:
//   - "github": the link is a real github.com/<owner>/<repo> — the server runs
//     the clone routine and grounds the build in the repository;
//   - "link": any other http(s) URL — attached to the project as reference;
//   - "context": no link at all — the context alone seeds the project.
// Context and link are clamped so an unauthenticated LAN phone cannot stuff
// megabytes into the prompt pipeline or the SSE snapshot broadcast.
const MAX_CONTEXT_CHARS = 2_000;
const MAX_URL_CHARS = 2_048;

export type ImportRequest =
  | { ok: true; kind: "github"; url: string; owner: string; repo: string; context: string | null }
  | { ok: true; kind: "link"; url: string; context: string | null }
  | { ok: true; kind: "context"; context: string }
  | { ok: false; error: string };

export function parseImportRequest(raw: { url?: unknown; context?: unknown }): ImportRequest {
  const context = typeof raw.context === "string" ? raw.context.trim().slice(0, MAX_CONTEXT_CHARS) : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (url.length === 0 && context.length === 0) {
    return { ok: false, error: "Add some context or a link." };
  }
  if (url.length === 0) {
    return { ok: true, kind: "context", context };
  }
  if (url.length > MAX_URL_CHARS) {
    return { ok: false, error: "The link is too long." };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "The link is not a valid URL." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "Only http(s) links are accepted." };
  }
  // Exact-host github.com with an <owner>/<repo> path gets the clone routine.
  // Anything else — including github.com spoofs and github.com URLs without a
  // repo path — degrades to a plain reference link, never a clone.
  const github = parseGitHubImportUrl(url);
  if (github.ok) {
    return { ok: true, kind: "github", url: github.url, owner: github.owner, repo: github.repo, context: context.length > 0 ? context : null };
  }
  return { ok: true, kind: "link", url: parsed.toString(), context: context.length > 0 ? context : null };
}

// Derive a short, uppercase-ish display callsign from the repo name (matching
// the existing callsign feel — "ATLAS"-like, not a full slug).
export function callsignFromRepo(repo: string): string {
  const compact = repo.replace(/[^a-z0-9]+/giu, "").toUpperCase();
  return compact.length === 0 ? "IMPORT" : compact.slice(0, 8);
}

// A minimal structural view of os.networkInterfaces() so tests can inject
// deterministic interface tables (node reports family as "IPv4" or 4).
export type InterfaceAddresses = Record<
  string,
  Array<{ family: string | number; internal: boolean; address: string }> | undefined
>;

export interface ImportInfo {
  submitUrl: string;
  host: string;
  lanReachable: boolean;
}

// The URL a phone must open to reach GET /submit.
//
// With the dedicated phone listener bound (phonePort non-null — the default in
// index.ts: a second 0.0.0.0 listener serving ONLY the import surface), the QR
// always points at it via the best LAN IPv4, regardless of how the main server
// is bound. lanReachable is then only false when the machine has no LAN
// interface at all.
//
// Legacy fallback (phonePort null — listener disabled or its bind failed):
// bound to loopback the server is unreachable from a phone, so lanReachable is
// false and the URL falls back to loopback; bound to a wildcard, the preferred
// LAN IPv4 is the reachable address; bound to a concrete non-loopback address,
// that address itself is.
export function resolveImportInfo(options: {
  host: string;
  port: number;
  phonePort?: number | null;
  interfaces?: () => InterfaceAddresses;
}): ImportInfo {
  const { host, port } = options;
  const interfaces = options.interfaces ?? networkInterfaces;
  const phonePort = options.phonePort ?? null;
  if (phonePort !== null) {
    const lan = preferredLanIPv4(interfaces);
    return {
      submitUrl: `http://${lan ?? "127.0.0.1"}:${phonePort}/submit`,
      host: lan ?? "127.0.0.1",
      lanReachable: lan !== null,
    };
  }
  const loopbackInfo: ImportInfo = {
    submitUrl: `http://127.0.0.1:${port}/submit`,
    host: "127.0.0.1",
    lanReachable: false,
  };
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return loopbackInfo;
  }
  const wildcard = host === "0.0.0.0" || host === "::";
  const resolved = wildcard ? preferredLanIPv4(interfaces) : host;
  if (resolved === null) {
    // Wildcard-bound but no LAN interface is up — loopback is all that exists.
    return loopbackInfo;
  }
  return { submitUrl: `http://${resolved}:${port}/submit`, host: resolved, lanReachable: true };
}

// Pick the LAN IPv4 a phone on the room Wi-Fi is most likely able to reach.
// Multi-homed machines (VPN utun, Docker bridges) often list an unreachable
// address FIRST in os.networkInterfaces(), so ordering alone is not enough:
// prefer home/office private ranges (192.168/10.x) over 172.16-31 (Docker's
// default bridge range) over public addresses, skip link-local 169.254, and
// tie-break toward en* interfaces (macOS Wi-Fi/Ethernet).
export function preferredLanIPv4(interfaces: () => InterfaceAddresses): string | null {
  let best: { address: string; score: number } | null = null;
  for (const [name, addresses] of Object.entries(interfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.internal || (entry.family !== "IPv4" && entry.family !== 4)) {
        continue;
      }
      const address = entry.address;
      if (address.startsWith("169.254.")) {
        continue; // link-local — never phone-reachable
      }
      let score = 1; // public / unrecognized: reachable in principle, least likely
      if (address.startsWith("192.168.") || address.startsWith("10.")) {
        score = 7;
      } else if (/^172\.(1[6-9]|2\d|3[01])\./u.test(address)) {
        score = 4;
      }
      if (name.startsWith("en")) {
        score += 2;
      }
      if (best === null || score > best.score) {
        best = { address, score };
      }
    }
  }
  return best?.address ?? null;
}
