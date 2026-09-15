import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { ZERO_HASH, chunkListDigest, contextDigest, encodePayload, sha256, toBase64, type StreamType } from "./format";
import { AttestationRegistry, type ChunkRecordInput } from "./registry";

// A stand-in for the phone: signs chunk records with a P-256 key the way
// attestable-recorder's ChunkSigner does (DER ECDSA over the v4 payload, per-stream hash chain).
class FakePhone {
  readonly recordingId = crypto.randomUUID();
  readonly spki: Uint8Array;
  readonly #private: KeyObject;
  readonly #last = new Map<StreamType, Uint8Array>();
  readonly #index = new Map<StreamType, number>();
  readonly signed: Array<{ type: StreamType; index: number; hash: Uint8Array }> = [];
  readonly startedAt = 1_789_000_000_000;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
    this.#private = privateKey;
  }

  chunk(sourceId: string, type: StreamType, data: Uint8Array, timestamp = this.startedAt): ChunkRecordInput {
    const index = this.#index.get(type) ?? 0;
    const prevHash = this.#last.get(type) ?? ZERO_HASH;
    const hash = sha256(data);
    const payload = encodePayload({ type, recordingId: this.recordingId, index, timestampMs: timestamp, durationMs: 1000, hash, prevHash });
    const signature = new Uint8Array(sign("sha256", payload, this.#private));
    this.#index.set(type, index + 1);
    this.#last.set(type, hash);
    this.signed.push({ type, index, hash });
    return {
      source_id: sourceId, type, index, timestamp, duration_ms: 1000, size: data.length,
      hash: toBase64(hash), prev_hash: toBase64(prevHash), signature: toBase64(signature),
    };
  }

  close(endedAt: number, context: Array<Record<string, unknown>>) {
    const payload = encodePayload({
      type: "session", recordingId: this.recordingId, index: this.signed.length, timestampMs: endedAt,
      durationMs: endedAt - this.startedAt, hash: chunkListDigest(this.signed), prevHash: contextDigest(context),
    });
    return {
      started_at: this.startedAt, ended_at: endedAt, context,
      chunks: this.signed.map((c) => ({ type: c.type, index: c.index, hash: toBase64(c.hash) })),
      session_signature: toBase64(new Uint8Array(sign("sha256", payload, this.#private))),
    };
  }
}

function setup() {
  let changes = 0;
  const registry = new AttestationRegistry({ clock: () => 1_789_000_010_000, onChange: () => { changes += 1; } });
  const phone = new FakePhone();
  const source = registry.createSource({
    recordingId: phone.recordingId, spki: phone.spki, verified: "hardware", streams: null, freshness: null,
    facts: { key_security_level: "STRONGBOX", bootloader_locked: true, verified_boot_device: "GrapheneOS Pixel 10a", packages: [{ name: "com.attestable.recorder.room", version_code: 1 }] },
  });
  return { registry, phone, source, changes: () => changes };
}

const bytes = (n: number, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * seed + 13) & 0xff);

describe("AttestationRegistry", () => {
  test("accepts a chunk whose bytes the room received, in order, with a valid signature", () => {
    const { registry, phone, source } = setup();
    const audio = bytes(1600);
    registry.recordBytes(source.id, "audio", audio.subarray(0, 1000));
    registry.recordBytes(source.id, "audio", audio.subarray(1000));
    expect(registry.verifyChunk(phone.chunk(source.id, "audio", audio))).toEqual({ ok: true, pending: false });
    const summary = registry.summary()[0]!;
    expect(summary.streams.audio).toMatchObject({ accepted: 1, rejected: 0, bytes: 1600, pendingBytes: 0 });
    expect(summary.label).toBe("GrapheneOS Pixel 10a");
  });

  test("a record that arrives before its bytes is parked and verified when they land", () => {
    const { registry, phone, source } = setup();
    const frames = new TextEncoder().encode('{"type":"cursors","cursors":[]}\n');
    const verdict = registry.verifyChunk(phone.chunk(source.id, "hands", frames));
    expect(verdict).toMatchObject({ ok: true, pending: true, need: frames.length });
    registry.recordBytes(source.id, "hands", frames);
    expect(registry.summary()[0]!.streams.hands).toMatchObject({ accepted: 1, pendingBytes: 0 });
  });

  test("rejects modified bytes, a broken hash chain, out-of-order indexes and foreign signatures", () => {
    const { registry, phone, source } = setup();
    const a = bytes(500, 3);
    const b = bytes(500, 5);
    registry.recordBytes(source.id, "audio", a);
    expect(registry.verifyChunk(phone.chunk(source.id, "audio", a))).toEqual({ ok: true, pending: false });

    // Out of order: the phone's next index is 1; a stale/replayed index 0 is refused.
    const second = phone.chunk(source.id, "audio", b);
    expect(registry.verifyChunk({ ...second, index: 0 })).toMatchObject({ ok: false, reason: expect.stringContaining("out of order") });
    // Chain: prev_hash must be the last accepted hash.
    expect(registry.verifyChunk({ ...second, prev_hash: toBase64(ZERO_HASH) })).toMatchObject({ ok: false, reason: expect.stringContaining("hash chain") });
    // Foreign signature.
    expect(registry.verifyChunk({ ...second, signature: second.signature.slice(0, -4) + "AAAA" })).toMatchObject({ ok: false, reason: expect.stringContaining("signature") });
    // Modified bytes on the wire: the room received something else.
    const tampered = b.slice(); tampered[10] ^= 1;
    registry.recordBytes(source.id, "audio", tampered);
    expect(registry.verifyChunk(second)).toMatchObject({ ok: false, reason: expect.stringContaining("content mismatch") });
    expect(registry.summary()[0]!.streams.audio).toMatchObject({ accepted: 1, broken: true });
  });

  test("seals a session whose signed chunk list matches what the room accepted, across streams", () => {
    const { registry, phone, source } = setup();
    const a = bytes(300, 2), h = new TextEncoder().encode('{"type":"hello","wall":"A"}\n');
    registry.recordBytes(source.id, "audio", a);
    registry.recordBytes(source.id, "hands", h);
    expect(registry.verifyChunk(phone.chunk(source.id, "audio", a)).ok).toBe(true);
    expect(registry.verifyChunk(phone.chunk(source.id, "hands", h)).ok).toBe(true);
    const context = [{ sampled_at: 1, phase: "start", debuggable: false, install_source: null }];
    expect(registry.closeSession(source.id, phone.close(phone.startedAt + 2000, context))).toEqual({ ok: true });
    expect(registry.summary()[0]!.session).toBe("sealed");
    // A sealed session takes no more chunks.
    expect(registry.verifyChunk(phone.chunk(source.id, "audio", a)).ok).toBe(false);
  });

  test("a truncated chunk list or edited context breaks the session record", () => {
    const { registry, phone, source } = setup();
    const a = bytes(300, 2), b = bytes(300, 9);
    registry.recordBytes(source.id, "audio", a); registry.recordBytes(source.id, "audio", b);
    registry.verifyChunk(phone.chunk(source.id, "audio", a));
    registry.verifyChunk(phone.chunk(source.id, "audio", b));
    const context = [{ sampled_at: 1, phase: "start", debuggable: false }];
    const close = phone.close(phone.startedAt + 2000, context);
    expect(registry.closeSession(source.id, { ...close, chunks: close.chunks.slice(0, 1) })).toMatchObject({ ok: false, reason: expect.stringContaining("count mismatch") });
    // A fresh registry/source for the context case (the previous close marked the session broken).
    const again = setup();
    again.registry.recordBytes(again.source.id, "audio", a);
    again.registry.verifyChunk(again.phone.chunk(again.source.id, "audio", a));
    const close2 = again.phone.close(again.phone.startedAt + 1000, context);
    expect(again.registry.closeSession(again.source.id, { ...close2, context: [{ ...context[0]!, debuggable: true }] })).toMatchObject({ ok: false, reason: expect.stringContaining("session signature") });
    expect(again.registry.summary()[0]!.session).toBe("broken");
  });

  test("ledger overflow flags the stream instead of growing without bound", () => {
    const registry = new AttestationRegistry({ maxPendingBytes: 1000 });
    const phone = new FakePhone();
    const source = registry.createSource({ recordingId: phone.recordingId, spki: phone.spki, verified: "leaf-only", streams: null, freshness: null, facts: {} });
    registry.recordBytes(source.id, "audio", bytes(600));
    registry.recordBytes(source.id, "audio", bytes(600));
    expect(registry.summary()[0]!.streams.audio).toMatchObject({ broken: true, lastError: expect.stringContaining("overflow") });
  });
});
