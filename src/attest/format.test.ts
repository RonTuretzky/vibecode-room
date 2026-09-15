import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  CONTEXT_FIELDS, PAYLOAD_SIZE, ZERO_HASH, chunkListDigest, contextCanonical, contextDigest, encodePayload,
  importAttestedKey, sha256, toHex, uuidBytes, verifySignature,
} from "./format";

describe("credible-sensor wire format (manifest v4)", () => {
  const recordingId = "6b204ccd-44ea-4150-8507-1f28d41f46b7";

  test("payload is 103 bytes with the ATREC magic, version 4 and the type byte", () => {
    const hash = sha256(new Uint8Array([1, 2, 3]));
    const p = encodePayload({ type: "video", recordingId, index: 4, timestampMs: 1_789_229_781_000, durationMs: 5000, hash, prevHash: ZERO_HASH });
    expect(p.length).toBe(PAYLOAD_SIZE);
    expect(new TextDecoder().decode(p.subarray(0, 5))).toBe("ATREC");
    expect(p[5]).toBe(4);
    expect(p[6]).toBe(2);
    expect(toHex(p.subarray(7, 23))).toBe("6b204ccd44ea41508507" + "1f28d41f46b7");
    const view = new DataView(p.buffer);
    expect(view.getInt32(23)).toBe(4);
    expect(view.getBigInt64(27)).toBe(1_789_229_781_000n);
    expect(view.getInt32(35)).toBe(5000);
    expect(toHex(p.subarray(39, 71))).toBe(toHex(hash));
    expect(toHex(p.subarray(71, 103))).toBe(toHex(ZERO_HASH));
  });

  test("uuid bytes match Java's most/least significant bits layout", () => {
    expect(toHex(uuidBytes("00000000-0000-0000-0000-000000000001"))).toBe("00000000000000000000000000000001");
    expect(() => uuidBytes("not-a-uuid")).toThrow();
  });

  test("chunk-list digest depends on order", () => {
    const a = { type: "audio" as const, index: 0, hash: sha256(new Uint8Array([1])) };
    const b = { type: "video" as const, index: 0, hash: sha256(new Uint8Array([2])) };
    expect(toHex(chunkListDigest([a, b]))).not.toBe(toHex(chunkListDigest([b, a])));
    expect(toHex(chunkListDigest([a, b]))).toBe(toHex(chunkListDigest([a, b])));
  });

  test("context canonicalisation follows the fixed field order and blanks nulls", () => {
    const canonical = contextCanonical({ phase: "start", sampled_at: 5, debuggable: false, install_source: null, extra: "ignored" });
    const lines = canonical.split("\n");
    expect(lines.length).toBe(CONTEXT_FIELDS.length);
    expect(lines[0]).toBe("sampled_at=5");
    expect(lines[1]).toBe("phase=start");
    expect(lines[3]).toBe("install_source=");
    expect(contextDigest([]).length).toBe(32);
  });

  test("DER ECDSA signatures from an EC P-256 key verify against the SPKI", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
    const key = importAttestedKey(spki);
    expect(key.algorithm).toBe("ec");
    const payload = encodePayload({ type: "audio", recordingId, index: 0, timestampMs: 1, durationMs: 1, hash: ZERO_HASH, prevHash: ZERO_HASH });
    const signature = new Uint8Array(sign("sha256", payload, privateKey));
    expect(verifySignature(key, payload, signature)).toBe(true);
    payload[40] ^= 1;
    expect(verifySignature(key, payload, signature)).toBe(false);
    expect(verifySignature(key, payload, new Uint8Array())).toBe(false);
  });
});
