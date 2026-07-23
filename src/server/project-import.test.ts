import { describe, expect, test } from "bun:test";
import {
  callsignFromRepo,
  parseGitHubImportUrl,
  parseImportRequest,
  preferredLanIPv4,
  resolveImportInfo,
  type InterfaceAddresses,
} from "./project-import";

describe("parseImportRequest — the context+link phone contract", () => {
  test("context alone starts a project", () => {
    const parsed = parseImportRequest({ context: "  A synthwave ticket dashboard  " });
    expect(parsed).toEqual({ ok: true, kind: "context", context: "A synthwave ticket dashboard" });
  });

  test("a real github.com repo link gets the clone routine, with and without context", () => {
    const bare = parseImportRequest({ url: "https://github.com/RonTuretzky/vibersyn" });
    expect(bare).toEqual({
      ok: true,
      kind: "github",
      url: "https://github.com/RonTuretzky/vibersyn",
      owner: "RonTuretzky",
      repo: "vibersyn",
      context: null,
    });
    const steered = parseImportRequest({ url: "https://github.com/o/r", context: "port it to the wall" });
    expect(steered.ok).toBe(true);
    if (steered.ok && steered.kind === "github") {
      expect(steered.context).toBe("port it to the wall");
    }
  });

  test("any other http(s) link is a plain reference link — never a clone", () => {
    const parsed = parseImportRequest({ url: "https://example.com/spec", context: "make a viewer" });
    expect(parsed).toEqual({ ok: true, kind: "link", url: "https://example.com/spec", context: "make a viewer" });
  });

  test("github lookalike hosts degrade to reference links, not clones (anti-spoof)", () => {
    for (const url of [
      "https://github.com.evil.com/o/r",
      "https://github.com@evil.com/o/r",
      "https://sub.github.com/o/r",
      "https://evilgithub.com/o/r",
      "https://github.com/owner-only",
    ]) {
      const parsed = parseImportRequest({ url });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.kind).toBe("link");
      }
    }
  });

  test("rejects empty submissions, non-URLs, and non-http schemes", () => {
    expect(parseImportRequest({}).ok).toBe(false);
    expect(parseImportRequest({ context: "   " }).ok).toBe(false);
    expect(parseImportRequest({ url: "not a url" }).ok).toBe(false);
    expect(parseImportRequest({ url: "ftp://github.com/o/r" }).ok).toBe(false);
    expect(parseImportRequest({ url: "javascript:alert(1)" }).ok).toBe(false);
    expect(parseImportRequest({ url: 42, context: 42 }).ok).toBe(false);
  });

  test("clamps runaway context so a phone cannot stuff the prompt pipeline", () => {
    const parsed = parseImportRequest({ context: "x".repeat(50_000) });
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.kind === "context") {
      expect(parsed.context.length).toBe(2_000);
    }
  });
});

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

  test("phone listener bound → the QR advertises it via the LAN IPv4 even on a loopback main bind", () => {
    const info = resolveImportInfo({ host: "127.0.0.1", port: 8787, phonePort: 8788, interfaces: () => lan });
    expect(info).toEqual({ submitUrl: "http://192.168.1.42:8788/submit", host: "192.168.1.42", lanReachable: true });
  });

  test("phone listener bound but no LAN interface → loopback submit URL, honestly unreachable", () => {
    const info = resolveImportInfo({ host: "127.0.0.1", port: 8787, phonePort: 8788, interfaces: () => ({ lo0: lan.lo0 }) });
    expect(info).toEqual({ submitUrl: "http://127.0.0.1:8788/submit", host: "127.0.0.1", lanReachable: false });
  });
});

describe("preferredLanIPv4 — multi-homed machines pick the phone-reachable address", () => {
  test("prefers home/office private ranges over Docker-bridge 172.x and public addresses", () => {
    const table: InterfaceAddresses = {
      docker0: [{ family: "IPv4", internal: false, address: "172.17.0.1" }],
      utun3: [{ family: "IPv4", internal: false, address: "100.90.1.4" }],
      en0: [{ family: "IPv4", internal: false, address: "192.168.1.42" }],
    };
    expect(preferredLanIPv4(() => table)).toBe("192.168.1.42");
  });

  test("VPN utun with a 10.x address loses to a real en* interface", () => {
    const table: InterfaceAddresses = {
      utun3: [{ family: "IPv4", internal: false, address: "10.8.0.2" }],
      en0: [{ family: "IPv4", internal: false, address: "10.1.2.3" }],
    };
    expect(preferredLanIPv4(() => table)).toBe("10.1.2.3");
  });

  test("skips link-local 169.254 and internal/IPv6 entries; null when nothing is usable", () => {
    const table: InterfaceAddresses = {
      en1: [
        { family: "IPv4", internal: false, address: "169.254.10.10" },
        { family: "IPv6", internal: false, address: "fe80::1" },
      ],
      lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    };
    expect(preferredLanIPv4(() => table)).toBe(null);
  });
});
