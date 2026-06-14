// §8 invariant: zero secrets in the build tree (SEC-1). RBG move: plant a fake sk-… → the
// scan fails. redact() is the fail-closed companion the trace stream uses.
import { describe, expect, test } from "bun:test";
import { redact, scanForSecrets } from "./core.ts";

describe("secret-scan", () => {
  test("a clean bundle has zero key-shaped strings", () => {
    expect(scanForSecrets("just some logs, ticketId=walking-skeleton-smoke latencyMs=12")).toEqual([]);
  });

  test("RBG — plant a fake OpenAI key → the scan catches it", () => {
    const hits = scanForSecrets('meta: { token: "sk-ABCDEF0123456789ghijkl" }');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatch(/^sk-/);
  });

  test("RBG — plant a fake AWS access key id → caught", () => {
    expect(scanForSecrets("AKIAIOSFODNN7EXAMPLE").length).toBeGreaterThan(0);
  });

  test("a Bearer token is caught", () => {
    expect(scanForSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwx").length).toBeGreaterThan(0);
  });

  test("redact() removes the key so it never reaches the trace, and the result scans clean", () => {
    const dirty = 'level=info key="sk-ABCDEF0123456789ghijkl" msg=ok';
    const clean = redact(dirty);
    expect(clean).toContain("«redacted»");
    expect(clean).not.toContain("sk-ABCDEF0123456789ghijkl");
    expect(scanForSecrets(clean)).toEqual([]);
  });
});
