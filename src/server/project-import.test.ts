import { describe, expect, test } from "bun:test";
import { callsignFromRepo, parseGitHubImportUrl, resolveImportInfo, type InterfaceAddresses } from "./project-import";

describe("parseGitHubImportUrl — valid URLs", () => {
  test("accepts the canonical https://github.com/<owner>/<repo>", () => {
    const parsed = parseGitHubImportUrl("https://github.com/RonTuretzky/vibersyn");
    expect(parsed).toEqual({ ok: true, url: "https://github.com/RonTuretzky/vibersyn", owner: "RonTuretzky", repo: "vibersyn" });
  });

  test("accepts www.github.com, http, extra path segments, and a trailing .git", () => {
    expect(parseGitHubImportUrl("https://www.github.com/o/r").ok).toBe(true);
    expect(parseGitHubImportUrl("http://github.com/o/r").ok).toBe(true);
    expect(parseGitHubImportUrl("https://github.com/o/r/tree/main/src").ok).toBe(true);
    const cloned = parseGitHubImportUrl("https://github.com/o/repo.git");
    expect(cloned.ok).toBe(true);
    if (cloned.ok) {
      expect(cloned.repo).toBe("repo");
    }
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseGitHubImportUrl("  https://github.com/o/r  ").ok).toBe(true);
  });
});

describe("parseGitHubImportUrl — invalid URLs", () => {
  const INVALID: Array<[string, unknown]> = [
    ["not a URL", "definitely not a url"],
    ["empty string", ""],
    ["non-string body value", 42],
    ["missing repo segment", "https://github.com/owner-only"],
    ["bare origin", "https://github.com/"],
    ["non-http scheme", "ftp://github.com/o/r"],
    ["javascript scheme", "javascript:alert(1)"],
    ["wrong host", "https://gitlab.com/o/r"],
    // decodeURIComponent throws URIError on these — must be a clean 400, not a 500.
    ["malformed percent-encoding in repo", "https://github.com/owner/%zz"],
    ["malformed percent-encoding in owner", "https://github.com/%E0%A4%A/repo"],
  ];
  for (const [name, input] of INVALID) {
    test(`rejects ${name}`, () => {
      const parsed = parseGitHubImportUrl(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.length).toBeGreaterThan(0);
      }
    });
  }

  test("rejects host spoofs (exact-host rule, parsed not string-matched)", () => {
    expect(parseGitHubImportUrl("https://evilgithub.com/o/r").ok).toBe(false);
    expect(parseGitHubImportUrl("https://github.com.evil.com/o/r").ok).toBe(false);
    // userinfo spoof: the real host here is evil.com
    expect(parseGitHubImportUrl("https://github.com@evil.com/o/r").ok).toBe(false);
    expect(parseGitHubImportUrl("https://sub.github.com/o/r").ok).toBe(false);
  });
});

describe("callsignFromRepo", () => {
  test("uppercases, strips separators, and truncates to a short callsign", () => {
    expect(callsignFromRepo("gesture-wall")).toBe("GESTUREW");
    expect(callsignFromRepo("vibersyn")).toBe("VIBERSYN");
    expect(callsignFromRepo("a")).toBe("A");
  });

  test("falls back when the repo name has no usable characters", () => {
    expect(callsignFromRepo("---")).toBe("IMPORT");
  });
});

describe("resolveImportInfo", () => {
  const lan: InterfaceAddresses = {
    lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    en0: [
      { family: "IPv6", internal: false, address: "fe80::1" },
      { family: "IPv4", internal: false, address: "192.168.1.42" },
    ],
  };

  test("loopback bind (default HOST) → lanReachable false, loopback submit URL", () => {
    const info = resolveImportInfo({ host: "127.0.0.1", port: 8787, interfaces: () => lan });
    expect(info).toEqual({ submitUrl: "http://127.0.0.1:8787/submit", host: "127.0.0.1", lanReachable: false });
  });

  test("wildcard bind → first non-internal IPv4 from the interface table", () => {
    const info = resolveImportInfo({ host: "0.0.0.0", port: 9000, interfaces: () => lan });
    expect(info).toEqual({ submitUrl: "http://192.168.1.42:9000/submit", host: "192.168.1.42", lanReachable: true });
  });

  test("wildcard bind with no LAN interface up falls back to loopback, unreachable", () => {
    const info = resolveImportInfo({ host: "0.0.0.0", port: 9000, interfaces: () => ({ lo0: lan.lo0 }) });
    expect(info.lanReachable).toBe(false);
    expect(info.submitUrl).toBe("http://127.0.0.1:9000/submit");
  });

  test("a concrete non-loopback bind address is used verbatim", () => {
    const info = resolveImportInfo({ host: "10.0.0.7", port: 8787, interfaces: () => lan });
    expect(info).toEqual({ submitUrl: "http://10.0.0.7:8787/submit", host: "10.0.0.7", lanReachable: true });
  });
});
