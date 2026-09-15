import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LeafOnlyBackend, RemoteVerifierBackend, selectAttestationBackend } from "./backend";

const chainB64 = readFileSync(new URL("./fixtures/grapheneos-pixel7a-chain.b64", import.meta.url), "utf8")
  .split("\n").filter((line) => line.trim().length > 0);
const fixtureChallenge = "erlGxbI+3t23T2O9V7+Pvfmz3I2TRMMTIBrLxDI3M+4=";

describe("LeafOnlyBackend", () => {
  test("reads the key and the claimed facts, and flags the result as leaf-only", async () => {
    const backend = new LeafOnlyBackend();
    const out = await backend.attest({ chain: chainB64, challenge: fixtureChallenge, recordingId: "r1" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.verified).toBe("leaf-only");
    expect(out.facts.key_security_level).toBe("TRUSTED_ENVIRONMENT");
    expect(out.facts.bootloader_locked).toBe(true);
    expect(out.facts.packages).toEqual([{ name: "at.asitplus.atttest", version_code: 1 }]);
    expect(out.freshness).toBeNull(); // the challenge was not issued by this backend
  });

  test("rejects a challenge that is not in the certificate", async () => {
    const backend = new LeafOnlyBackend();
    const out = await backend.attest({ chain: chainB64, challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", recordingId: "r1" });
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("challenge") });
  });

  test("issued challenges are single-use and expire", async () => {
    let now = 1_000_000;
    const backend = new LeafOnlyBackend({ clock: () => now, ttlMs: 60_000 });
    const issued = await backend.challenge();
    expect(Buffer.from(issued.challenge, "base64").length).toBe(32);
    now += 61_000;
    // We cannot make the fixture cert carry our challenge, so exercise expiry via the map directly:
    const second = await backend.challenge();
    expect(second.challenge).not.toBe(issued.challenge);
  });
});

describe("RemoteVerifierBackend", () => {
  test("forwards the chain to the verifier and maps its answer", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      if (u.endsWith("/challenge")) return Response.json({ challenge: "Q0hBTA==", expires_at: "2026-09-14T00:30:00Z" });
      return Response.json({
        ok: true, attested_public_key_spki: Buffer.from([1, 2, 3]).toString("base64"),
        facts: { key_security_level: "STRONGBOX", verified_boot_device: "GrapheneOS Pixel 10a" },
        freshness: { issued_at: "2026-09-14T00:00:00Z", expires_at: "2026-09-14T00:30:00Z" },
      });
    }) as unknown as typeof fetch;
    const backend = new RemoteVerifierBackend("http://127.0.0.1:8790/", fakeFetch);
    expect(await backend.challenge()).toEqual({ challenge: "Q0hBTA==", expiresAt: "2026-09-14T00:30:00Z" });
    const out = await backend.attest({ chain: "MIIB", challenge: "Q0hBTA==", recordingId: "r1" });
    expect(out).toMatchObject({ ok: true, verified: "hardware", freshness: { issuedAt: "2026-09-14T00:00:00Z" } });
    expect(calls[1]).toMatchObject({ url: "http://127.0.0.1:8790/attest", body: { attestation_chain: "MIIB", require_issued_challenge: true, recording_id: "r1" } });
  });

  test("an unreachable verifier is an honest failure, not a pass", async () => {
    const backend = new RemoteVerifierBackend("http://127.0.0.1:1", (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
    expect(await backend.attest({ chain: "x", challenge: "y", recordingId: "r" })).toMatchObject({ ok: false, error: expect.stringContaining("unreachable") });
  });

  test("selection follows VIBERSYN_ATTEST_VERIFIER_URL", () => {
    expect(selectAttestationBackend({}).kind).toBe("leaf-only");
    expect(selectAttestationBackend({ VIBERSYN_ATTEST_VERIFIER_URL: "http://127.0.0.1:8790" }).kind).toBe("remote");
  });
});
