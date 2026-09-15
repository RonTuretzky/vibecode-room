// Credible-sensor wire format (attestable-recorder manifest_version 4), the
// parts a room needs to check a chunk it RECEIVED against the record the phone
// SIGNED. Mirrors attestable-recorder's app/SignedChunk.kt + server/Manifest.kt;
// the three must stay byte-identical.
//
// Signed payload (103 bytes, big-endian):
//   "ATREC" | version=0x04 | type | recording_id[16] | index:i32 | timestamp_ms:i64
//           | duration_ms:i32 | sha256[32] | prev_sha256[32]
//
// `prev_sha256` is the previous chunk's hash in the same stream (zeros for the
// first) — a per-stream hash chain. The SESSION record (type 0) signs the ordered
// chunk-list digest with prev = digest of the app's OS-context snapshots.
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

export const MANIFEST_VERSION = 4;
export const PAYLOAD_SIZE = 5 + 1 + 1 + 16 + 4 + 8 + 4 + 32 + 32;
const MAGIC = new TextEncoder().encode("ATREC");

export const CHUNK_TYPES = { session: 0, audio: 1, video: 2, hands: 3, gesture: 4 } as const;
export type ChunkTypeName = keyof typeof CHUNK_TYPES;
export type StreamType = Exclude<ChunkTypeName, "session">;
export const STREAM_TYPES: readonly StreamType[] = ["audio", "video", "hands", "gesture"];

export function isStreamType(value: unknown): value is StreamType {
  return typeof value === "string" && (STREAM_TYPES as readonly string[]).includes(value);
}

export const ZERO_HASH: Uint8Array = new Uint8Array(32);

export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

// RFC 4122 text → 16 bytes, the same bytes Java's UUID.mostSignificantBits /
// leastSignificantBits write big-endian.
export function uuidBytes(id: string): Uint8Array {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`recording_id is not a UUID: ${id}`);
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export interface PayloadFields {
  type: ChunkTypeName;
  recordingId: string;
  index: number;
  timestampMs: number;
  durationMs: number;
  hash: Uint8Array;
  prevHash: Uint8Array;
}

export function encodePayload(f: PayloadFields): Uint8Array {
  if (f.hash.length !== 32 || f.prevHash.length !== 32) throw new Error("hashes must be SHA-256");
  const out = new Uint8Array(PAYLOAD_SIZE);
  const view = new DataView(out.buffer);
  let o = 0;
  out.set(MAGIC, o); o += 5;
  out[o++] = MANIFEST_VERSION;
  out[o++] = CHUNK_TYPES[f.type];
  out.set(uuidBytes(f.recordingId), o); o += 16;
  view.setInt32(o, f.index); o += 4;
  view.setBigInt64(o, BigInt(Math.trunc(f.timestampMs))); o += 8;
  view.setInt32(o, f.durationMs); o += 4;
  out.set(f.hash, o); o += 32;
  out.set(f.prevHash, o);
  return out;
}

// Digest over the ordered chunk list: for each chunk `type | index:i32 | sha256[32]`.
export function chunkListDigest(chunks: ReadonlyArray<{ type: ChunkTypeName; index: number; hash: Uint8Array }>): Uint8Array {
  const h = createHash("sha256");
  for (const c of chunks) {
    const head = new Uint8Array(5);
    head[0] = CHUNK_TYPES[c.type];
    new DataView(head.buffer).setInt32(1, c.index);
    h.update(head);
    h.update(c.hash);
  }
  return new Uint8Array(h.digest());
}

// The app's OS-context snapshot, canonicalised exactly as RecordingContext does:
// `key=value` lines in this fixed order joined by "\n"; snapshots joined by "\n\n".
export const CONTEXT_FIELDS = [
  "sampled_at", "phase", "debuggable", "install_source", "accessibility_services",
  "other_active_recorders", "device_model", "os_release", "os_build", "security_patch",
] as const;

export function contextCanonical(snapshot: Record<string, unknown>): string {
  return CONTEXT_FIELDS.map((k) => {
    const v = snapshot[k];
    return `${k}=${v === null || v === undefined ? "" : String(v)}`;
  }).join("\n");
}

export function contextDigest(snapshots: ReadonlyArray<Record<string, unknown>>): Uint8Array {
  return sha256(new TextEncoder().encode(snapshots.map(contextCanonical).join("\n\n")));
}

// The attested public key as a SubjectPublicKeyInfo (DER). Android StrongBox keys
// are EC P-256; Warden's test fixtures include RSA — both verify with SHA-256 and
// the signature encoding Android emits (DER ECDSA / PKCS#1 v1.5).
export interface AttestedKey {
  readonly spki: Uint8Array;
  readonly algorithm: "ec" | "rsa";
  readonly keyObject: KeyObject;
}

export function importAttestedKey(spki: Uint8Array): AttestedKey {
  const keyObject = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
  const type = keyObject.asymmetricKeyType;
  if (type !== "ec" && type !== "rsa") throw new Error(`unsupported attested key type: ${String(type)}`);
  return { spki, algorithm: type, keyObject };
}

export function verifySignature(key: AttestedKey, payload: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length === 0) return false;
  try {
    return cryptoVerify("sha256", payload, key.keyObject, signature);
  } catch {
    return false;
  }
}
