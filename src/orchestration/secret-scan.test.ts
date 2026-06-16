// §8 invariant: zero secrets in the build tree (SEC-1).
// Key-shaped test strings are assembled from segments at runtime — no single source token
// matches the scanner pattern, and assertion styles avoid revealing runtime key values
// in failure output (SEC-1: no raw provider key in source/log/artifact).
import { describe, expect, test } from "bun:test";
import { redact, scanForSecrets } from "./core.ts";

// Segments assembled at runtime so the scanner pattern never fires on the source file.
// Each fragment alone is too short or wrongly-shaped to trigger detection.
const T = {
  sk: "sk-" + "ABCDEF0123456789ghijkl",        // runtime: sk- + 22-char body → matches /sk-[A-Za-z0-9_-]{16,}/
  akia: "AKIA" + "IOSFODNN7EXAMPLE",            // runtime: AKIA + 16-char [0-9A-Z] body → matches /AKIA[0-9A-Z]{16}/
  bearer: "Bearer " + "abcdefghijklmnopqrstuvwx", // runtime: 24-char body → matches /Bearer\s+[A-Za-z0-9._-]{16,}/
};

describe("secret-scan", () => {
  test("a clean bundle has zero key-shaped strings", () => {
    expect(scanForSecrets("just some logs, ticketId=walking-skeleton-smoke latencyMs=12")).toEqual([]);
  });

  test("RBG — fake OpenAI key is caught", () => {
    // Failure shows: Expected > 0, Received 0 — no key value in assertion output
    const hits = scanForSecrets('meta: { token: "' + T.sk + '" }');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatch(/^sk-/);
  });

  test("RBG — fake AWS access key id is caught", () => {
    // Failure shows: Expected > 0, Received 0 — no key value in assertion output
    expect(scanForSecrets(T.akia).length).toBeGreaterThan(0);
  });

  test("Bearer token is caught", () => {
    // Failure shows: Expected > 0, Received 0 — no key value in assertion output
    expect(scanForSecrets("Authorization: " + T.bearer).length).toBeGreaterThan(0);
  });

  test("redact() removes the key so it never reaches the trace, and the result scans clean", () => {
    const dirty = 'level=info key="' + T.sk + '" msg=ok';
    const clean = redact(dirty);
    // Use length-based assertions so failure messages don't reveal key-shaped values (SEC-1)
    expect(scanForSecrets(clean).length, "clean output must have zero key-shaped hits").toBe(0);
    expect(clean.includes("«red"), "clean output must contain redaction marker").toBe(true);
    expect(clean.length, "redacted string must be shorter than original").toBeLessThan(dirty.length);
  });
});
