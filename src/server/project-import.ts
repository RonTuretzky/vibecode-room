import { networkInterfaces } from "node:os";

// GitHub project import (QR flow): a phone scans the wall's QR overlay, lands on
// GET /submit, and POSTs a repository URL to /api/projects/import. These are the
// pure pieces: strict URL validation (the input arrives from an unauthenticated
// LAN phone, so host spoofs like github.com.evil.com must be rejected), the
// repo→callsign derivation, and the LAN-reachable submit URL for the QR code.

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

// The URL a phone must open to reach GET /submit. Bound to loopback (the default
// HOST) the server is unreachable from a phone, so lanReachable is false and the
// URL falls back to loopback — the QR overlay warns to restart with HOST=0.0.0.0.
// Bound to a wildcard, the first non-internal IPv4 is the reachable address;
// bound to a concrete non-loopback address, that address itself is.
export function resolveImportInfo(options: {
  host: string;
  port: number;
  interfaces?: () => InterfaceAddresses;
}): ImportInfo {
  const { host, port } = options;
  const loopbackInfo: ImportInfo = {
    submitUrl: `http://127.0.0.1:${port}/submit`,
    host: "127.0.0.1",
    lanReachable: false,
  };
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return loopbackInfo;
  }
  const wildcard = host === "0.0.0.0" || host === "::";
  const resolved = wildcard ? firstNonInternalIPv4(options.interfaces ?? networkInterfaces) : host;
  if (resolved === null) {
    // Wildcard-bound but no LAN interface is up — loopback is all that exists.
    return loopbackInfo;
  }
  return { submitUrl: `http://${resolved}:${port}/submit`, host: resolved, lanReachable: true };
}

function firstNonInternalIPv4(interfaces: () => InterfaceAddresses): string | null {
  for (const addresses of Object.values(interfaces())) {
    for (const entry of addresses ?? []) {
      if (!entry.internal && (entry.family === "IPv4" || entry.family === 4)) {
        return entry.address;
      }
    }
  }
  return null;
}
