// The room's memory of every attested source: which phone (attested public key +
// facts), what it streamed (per-stream byte ledgers), which signed chunks were
// checked against those bytes, and whether the session was sealed.
//
// Pure by design — no sockets, no HTTP; the clock is injectable and change
// notifications are a callback — so it is unit-testable end to end with a key
// generated in the test.
import { ByteLedger } from "./ledger";
import {
  type AttestedKey,
  type ChunkTypeName,
  type StreamType,
  ZERO_HASH,
  bytesEqual,
  chunkListDigest,
  contextDigest,
  encodePayload,
  fromBase64,
  importAttestedKey,
  isStreamType,
  sha256,
  toBase64,
  verifySignature,
} from "./format";

export interface AttestedFacts {
  attestation_security_level?: string;
  key_security_level?: string;
  packages?: Array<{ name: string; version_code: number }>;
  signer_digests?: string[];
  bootloader_locked?: boolean;
  verified_boot_state?: string;
  verified_boot_key?: string;
  verified_boot_device?: string | null;
  os_version?: string;
  os_patch_level?: string;
  [key: string]: unknown;
}

export interface Freshness {
  issuedAt: string;
  expiresAt: string;
}

// "hardware": Warden validated the chain to Google's roots and enforced the
// policy (the facts are proven). "leaf-only": no JVM verifier configured — the
// key came straight from the leaf certificate and the facts are what the phone
// CLAIMS. The wall must show the difference.
export type VerificationLevel = "hardware" | "leaf-only";

export interface CreateSourceInput {
  recordingId: string;
  spki: Uint8Array;
  facts: AttestedFacts;
  freshness: Freshness | null;
  verified: VerificationLevel;
  streams: Record<string, unknown> | null;
  label?: string | null;
}

export interface ChunkRecordInput {
  source_id: string;
  type: string;
  index: number;
  timestamp: number;
  duration_ms: number;
  size: number;
  hash: string; // base64
  prev_hash: string; // base64
  signature: string; // base64
}

export type ChunkVerdict =
  | { ok: true; pending: false }
  | { ok: true; pending: true; have: number; need: number }
  | { ok: false; reason: string };

export interface CloseSessionInput {
  started_at: number;
  ended_at: number;
  context: Array<Record<string, unknown>>;
  chunks: Array<{ type: string; index: number; hash: string }>;
  session_signature: string;
}

interface AcceptedChunk {
  type: StreamType;
  index: number;
  hash: Uint8Array;
}

interface StreamState {
  ledger: ByteLedger;
  nextIndex: number;
  lastHash: Uint8Array;
  accepted: number;
  rejected: number;
  bytesAccepted: number;
  lastChunkAt: number | null;
  lastError: string | null;
  pending: ChunkRecordInput | null;
  broken: boolean;
}

export interface StreamSummary {
  accepted: number;
  rejected: number;
  bytes: number;
  pendingBytes: number;
  lastChunkAt: number | null;
  lastError: string | null;
  broken: boolean;
}

export interface AttestedSourceSummary {
  id: string;
  recordingId: string;
  label: string;
  verified: VerificationLevel;
  keySecurityLevel: string | null;
  bootloaderLocked: boolean | null;
  verifiedBootState: string | null;
  verifiedBootDevice: string | null;
  packageName: string | null;
  fresh: boolean;
  freshness: Freshness | null;
  createdAt: number;
  streams: Partial<Record<StreamType, StreamSummary>>;
  session: "open" | "sealed" | "broken";
  sessionError: string | null;
}

export class AttestedSource {
  readonly streams = new Map<StreamType, StreamState>();
  readonly accepted: AcceptedChunk[] = [];
  session: "open" | "sealed" | "broken" = "open";
  sessionError: string | null = null;

  constructor(
    readonly id: string,
    readonly recordingId: string,
    readonly key: AttestedKey,
    readonly facts: AttestedFacts,
    readonly freshness: Freshness | null,
    readonly verified: VerificationLevel,
    readonly declaredStreams: Record<string, unknown> | null,
    readonly label: string,
    readonly createdAt: number,
    private readonly maxPendingBytes: number,
  ) {}

  stream(type: StreamType): StreamState {
    let s = this.streams.get(type);
    if (s === undefined) {
      s = {
        ledger: new ByteLedger(this.maxPendingBytes),
        nextIndex: 0,
        lastHash: ZERO_HASH,
        accepted: 0,
        rejected: 0,
        bytesAccepted: 0,
        lastChunkAt: null,
        lastError: null,
        pending: null,
        broken: false,
      };
      this.streams.set(type, s);
    }
    return s;
  }
}

export interface AttestationRegistryOptions {
  clock?: () => number;
  maxSources?: number;
  maxPendingBytes?: number;
  onChange?: () => void;
}

export class AttestationRegistry {
  readonly #sources = new Map<string, AttestedSource>();
  readonly #clock: () => number;
  readonly #maxSources: number;
  readonly #maxPendingBytes: number;
  readonly #onChange: () => void;

  constructor(options: AttestationRegistryOptions = {}) {
    this.#clock = options.clock ?? (() => Date.now());
    this.#maxSources = options.maxSources ?? 32;
    this.#maxPendingBytes = options.maxPendingBytes ?? 32 * 1024 * 1024;
    this.#onChange = options.onChange ?? (() => undefined);
  }

  createSource(input: CreateSourceInput): AttestedSource {
    if (this.#sources.size >= this.#maxSources) {
      // Evict the oldest sealed/broken source first, then the oldest of all.
      const victim =
        [...this.#sources.values()].filter((s) => s.session !== "open").sort((a, b) => a.createdAt - b.createdAt)[0] ??
        [...this.#sources.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (victim !== undefined) this.#sources.delete(victim.id);
    }
    const id = `src-${crypto.randomUUID().slice(0, 8)}`;
    const label =
      input.label?.trim() ||
      input.facts.verified_boot_device ||
      input.facts.packages?.[0]?.name ||
      input.recordingId.slice(0, 8);
    const source = new AttestedSource(
      id,
      input.recordingId,
      importAttestedKey(input.spki),
      input.facts,
      input.freshness,
      input.verified,
      input.streams,
      label,
      this.#clock(),
      this.#maxPendingBytes,
    );
    this.#sources.set(id, source);
    this.#onChange();
    return source;
  }

  get(id: string): AttestedSource | undefined {
    return this.#sources.get(id);
  }

  remove(id: string): boolean {
    const removed = this.#sources.delete(id);
    if (removed) this.#onChange();
    return removed;
  }

  // Bytes the room received on a stream bound to this source. Re-tries a chunk
  // record that arrived before its bytes did.
  recordBytes(sourceId: string, type: StreamType, bytes: Uint8Array): void {
    const source = this.#sources.get(sourceId);
    if (source === undefined) return;
    const stream = source.stream(type);
    stream.ledger.append(bytes);
    if (stream.ledger.overflowed && !stream.broken) {
      stream.broken = true;
      stream.lastError = "ledger overflow: bytes streamed without chunk records";
      this.#onChange();
    }
    if (stream.pending !== null) {
      const pending = stream.pending;
      stream.pending = null;
      this.verifyChunk(pending);
    }
  }

  verifyChunk(input: ChunkRecordInput): ChunkVerdict {
    const source = this.#sources.get(input.source_id);
    if (source === undefined) return { ok: false, reason: "unknown source" };
    if (!isStreamType(input.type)) return { ok: false, reason: `unknown chunk type '${input.type}'` };
    const stream = source.stream(input.type);
    const reject = (reason: string): ChunkVerdict => {
      stream.rejected += 1;
      stream.lastError = reason;
      this.#onChange();
      return { ok: false, reason };
    };
    if (source.session !== "open") return reject(`session is ${source.session}`);
    if (stream.broken) return reject(stream.lastError ?? "stream broken");
    if (!Number.isInteger(input.index) || input.index !== stream.nextIndex) {
      return reject(`out of order: expected index ${stream.nextIndex}, got ${input.index}`);
    }
    let hash: Uint8Array;
    let prevHash: Uint8Array;
    let signature: Uint8Array;
    try {
      hash = fromBase64(input.hash);
      prevHash = fromBase64(input.prev_hash);
      signature = fromBase64(input.signature);
    } catch {
      return reject("hash/prev_hash/signature must be base64");
    }
    if (hash.length !== 32 || prevHash.length !== 32) return reject("hash and prev_hash must be SHA-256");
    if (!bytesEqual(prevHash, stream.lastHash)) return reject("hash chain broken: prev_hash does not match the last accepted chunk");
    if (!Number.isInteger(input.size) || input.size <= 0 || input.size > stream.ledger.maxPendingBytes) return reject("size out of range");
    const payload = encodePayload({
      type: input.type,
      recordingId: source.recordingId,
      index: input.index,
      timestampMs: input.timestamp,
      durationMs: input.duration_ms,
      hash,
      prevHash,
    });
    if (!verifySignature(source.key, payload, signature)) return reject("signature does not verify with the attested key");
    if (stream.ledger.available < input.size) {
      // Bytes still in flight on the socket: park the record, recordBytes() re-tries.
      stream.pending = input;
      return { ok: true, pending: true, have: stream.ledger.available, need: input.size };
    }
    const received = stream.ledger.take(input.size)!;
    if (!bytesEqual(sha256(received), hash)) {
      stream.broken = true;
      return reject("content mismatch: the bytes the room received are not the bytes that were signed");
    }
    stream.nextIndex += 1;
    stream.lastHash = hash;
    stream.accepted += 1;
    stream.bytesAccepted += input.size;
    stream.lastChunkAt = this.#clock();
    stream.lastError = null;
    source.accepted.push({ type: input.type, index: input.index, hash });
    this.#onChange();
    return { ok: true, pending: false };
  }

  closeSession(sourceId: string, input: CloseSessionInput): { ok: true } | { ok: false; reason: string } {
    const source = this.#sources.get(sourceId);
    if (source === undefined) return { ok: false, reason: "unknown source" };
    const fail = (reason: string) => {
      source.session = "broken";
      source.sessionError = reason;
      this.#onChange();
      return { ok: false as const, reason };
    };
    if (source.session !== "open") return { ok: false, reason: `session is already ${source.session}` };
    if (!Array.isArray(input.chunks)) return fail("chunks list missing");
    if (input.chunks.length !== source.accepted.length) {
      return fail(`chunk count mismatch: phone lists ${input.chunks.length}, room accepted ${source.accepted.length}`);
    }
    const listed: Array<{ type: ChunkTypeName; index: number; hash: Uint8Array }> = [];
    for (const c of input.chunks) {
      if (!isStreamType(c.type)) return fail(`chunk list has unknown type '${String(c.type)}'`);
      let hash: Uint8Array;
      try {
        hash = fromBase64(c.hash);
      } catch {
        return fail("chunk list hash must be base64");
      }
      const match = source.accepted.find((a) => a.type === c.type && a.index === c.index && bytesEqual(a.hash, hash));
      if (match === undefined) return fail(`chunk list names ${c.type} ${c.index} which the room did not accept with that hash`);
      listed.push({ type: c.type, index: c.index, hash });
    }
    const payload = encodePayload({
      type: "session",
      recordingId: source.recordingId,
      index: listed.length,
      timestampMs: input.ended_at,
      durationMs: input.ended_at - input.started_at,
      hash: chunkListDigest(listed),
      prevHash: contextDigest(Array.isArray(input.context) ? input.context : []),
    });
    let signature: Uint8Array;
    try {
      signature = fromBase64(input.session_signature);
    } catch {
      return fail("session_signature must be base64");
    }
    if (!verifySignature(source.key, payload, signature)) return fail("session signature does not verify");
    source.session = "sealed";
    source.sessionError = null;
    this.#onChange();
    return { ok: true };
  }

  summary(): AttestedSourceSummary[] {
    const now = this.#clock();
    return [...this.#sources.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => {
        const streams: Partial<Record<StreamType, StreamSummary>> = {};
        for (const [type, st] of s.streams) {
          streams[type] = {
            accepted: st.accepted,
            rejected: st.rejected,
            bytes: st.bytesAccepted,
            pendingBytes: st.ledger.available,
            lastChunkAt: st.lastChunkAt,
            lastError: st.lastError,
            broken: st.broken,
          };
        }
        const fresh = s.freshness !== null && Date.parse(s.freshness.expiresAt) >= now - 0;
        return {
          id: s.id,
          recordingId: s.recordingId,
          label: s.label,
          verified: s.verified,
          keySecurityLevel: s.facts.key_security_level ?? null,
          bootloaderLocked: s.facts.bootloader_locked ?? null,
          verifiedBootState: s.facts.verified_boot_state ?? null,
          verifiedBootDevice: s.facts.verified_boot_device ?? null,
          packageName: s.facts.packages?.[0]?.name ?? null,
          fresh: s.freshness !== null && fresh,
          freshness: s.freshness,
          createdAt: s.createdAt,
          streams,
          session: s.session,
          sessionError: s.sessionError,
        };
      });
  }
}

export { toBase64 };
