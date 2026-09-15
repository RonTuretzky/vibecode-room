import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { Hono } from "hono";
import type { AttestationBackend } from "./backend";
import { ZERO_HASH, encodePayload, sha256, toBase64 } from "./format";
import { AttestationRegistry } from "./registry";
import { registerAttestationRoutes } from "./routes";

// A backend that accepts any chain and hands back the SPKI we generated — the
// routes are what is under test here, not the certificate logic.
function fakeBackend(spki: Uint8Array): AttestationBackend {
  return {
    kind: "remote",
    description: "fake",
    challenge: async () => ({ challenge: "Q0hBTA==", expiresAt: "2026-09-14T00:30:00Z" }),
    attest: async (input) =>
      input.challenge === "Q0hBTA=="
        ? { ok: true, spki, facts: { key_security_level: "STRONGBOX" }, freshness: { issuedAt: "a", expiresAt: "b" }, verified: "hardware" }
        : { ok: false, error: "challenge mismatch" },
  };
}

describe("/api/attest routes", () => {
  test("challenge → session → chunk (pending, then accepted) → close", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
    const registry = new AttestationRegistry();
    const app = new Hono();
    registerAttestationRoutes(app, { registry, backend: fakeBackend(spki) });
    const post = (path: string, body: unknown) =>
      app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const challenge = await (await post("/api/attest/challenge", {})).json();
    expect(challenge).toEqual({ challenge: "Q0hBTA==", expires_at: "2026-09-14T00:30:00Z" });

    const recordingId = crypto.randomUUID();
    const rejected = await post("/api/attest/session", { recording_id: recordingId, attestation_chain: "x", attestation_challenge: "bad" });
    expect(rejected.status).toBe(403);
    const session = await post("/api/attest/session", { recording_id: recordingId, attestation_chain: "x", attestation_challenge: "Q0hBTA==", streams: { audio: {} } });
    expect(session.status).toBe(200);
    const { source_id: sourceId } = (await session.json()) as { source_id: string };

    const data = new Uint8Array(400).fill(9);
    const hash = sha256(data);
    const payload = encodePayload({ type: "audio", recordingId, index: 0, timestampMs: 1_789_000_000_000, durationMs: 1000, hash, prevHash: ZERO_HASH });
    const record = {
      source_id: sourceId, type: "audio", index: 0, timestamp: 1_789_000_000_000, duration_ms: 1000, size: data.length,
      hash: toBase64(hash), prev_hash: toBase64(ZERO_HASH), signature: toBase64(new Uint8Array(sign("sha256", payload, privateKey))),
    };
    const pending = await post("/api/attest/chunk", record);
    expect(pending.status).toBe(202);
    registry.recordBytes(sourceId, "audio", data);
    const sources = (await (await app.request("/api/attest/sources")).json()) as Array<{ streams: { audio: { accepted: number } } }>;
    expect(sources[0]!.streams.audio.accepted).toBe(1);

    const malformed = await post("/api/attest/chunk", { source_id: sourceId, type: "audio" });
    expect(malformed.status).toBe(400);

    const closePayload = encodePayload({
      type: "session", recordingId, index: 1, timestampMs: 1_789_000_005_000, durationMs: 5000,
      hash: sha256(new Uint8Array([])) /* placeholder replaced below */, prevHash: ZERO_HASH,
    });
    void closePayload;
    const { chunkListDigest, contextDigest } = await import("./format");
    const sessionPayload = encodePayload({
      type: "session", recordingId, index: 1, timestampMs: 1_789_000_005_000, durationMs: 5000,
      hash: chunkListDigest([{ type: "audio", index: 0, hash }]), prevHash: contextDigest([]),
    });
    const closed = await post(`/api/attest/session/${sourceId}/close`, {
      started_at: 1_789_000_000_000, ended_at: 1_789_000_005_000, context: [],
      chunks: [{ type: "audio", index: 0, hash: toBase64(hash) }],
      session_signature: toBase64(new Uint8Array(sign("sha256", sessionPayload, privateKey))),
    });
    expect(closed.status).toBe(200);
    expect(registry.summary()[0]!.session).toBe("sealed");
    const info = (await (await app.request("/api/attest/info")).json()) as { backend: string; description: string; sources: number };
    expect(info).toEqual({ backend: "remote", description: "fake", sources: 1 });
  });
});
