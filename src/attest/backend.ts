// Where the room sends a phone's attestation certificate chain to be judged.
//
//   RemoteVerifierBackend — attestable-verifier's `serve` mode (Warden): the chain
//     is validated to Google's hardware attestation roots, checked against the
//     revocation list and the room's policy (package, APK signer, StrongBox,
//     bootloader lock, GrapheneOS verified-boot keys). Facts are PROVEN.
//   LeafOnlyBackend — no JVM configured: the key and the facts are read straight
//     out of the leaf certificate. Per-chunk signatures still bind the bytes to
//     that key, and the challenge is still checked, but nothing proves the key is
//     in hardware or the OS is genuine. The wall labels such sources "unverified".
import { fromBase64, toBase64 } from "./format";
import { parseAttestationExtension, parseChain, subjectPublicKeyInfo } from "./x509";
import type { AttestedFacts, Freshness, VerificationLevel } from "./registry";

export interface AttestInput {
  chain: unknown; // base64 string (concatenated DER) or array of base64 certificates, leaf first
  challenge: string; // base64
  recordingId: string;
}

export type AttestOutcome =
  | { ok: true; spki: Uint8Array; facts: AttestedFacts; freshness: Freshness | null; verified: VerificationLevel }
  | { ok: false; error: string };

export interface AttestationBackend {
  readonly kind: "remote" | "leaf-only";
  readonly description: string;
  challenge(): Promise<{ challenge: string; expiresAt: string }>;
  attest(input: AttestInput): Promise<AttestOutcome>;
}

export class RemoteVerifierBackend implements AttestationBackend {
  readonly kind = "remote";
  readonly description: string;
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(url: string, fetchImpl: typeof fetch = fetch) {
    this.#url = url.replace(/\/+$/, "");
    this.#fetch = fetchImpl;
    this.description = `Warden verifier at ${this.#url}`;
  }

  async challenge(): Promise<{ challenge: string; expiresAt: string }> {
    const res = await this.#fetch(`${this.#url}/challenge`, { method: "POST" });
    if (!res.ok) throw new Error(`verifier /challenge returned ${res.status}`);
    const body = (await res.json()) as { challenge: string; expires_at: string };
    return { challenge: body.challenge, expiresAt: body.expires_at };
  }

  async attest(input: AttestInput): Promise<AttestOutcome> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#url}/attest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attestation_chain: input.chain,
          attestation_challenge: input.challenge,
          recording_id: input.recordingId,
          require_issued_challenge: true,
        }),
      });
    } catch (error) {
      return { ok: false, error: `verifier unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
    const body = (await res.json().catch(() => null)) as
      | { ok: true; attested_public_key_spki: string; facts: AttestedFacts; freshness: { issued_at: string; expires_at: string } | null }
      | { ok: false; error: string }
      | null;
    if (body === null) return { ok: false, error: `verifier returned ${res.status} with a non-JSON body` };
    if (!body.ok) return { ok: false, error: body.error };
    return {
      ok: true,
      spki: fromBase64(body.attested_public_key_spki),
      facts: body.facts,
      freshness: body.freshness === null ? null : { issuedAt: body.freshness.issued_at, expiresAt: body.freshness.expires_at },
      verified: "hardware",
    };
  }
}

export class LeafOnlyBackend implements AttestationBackend {
  readonly kind = "leaf-only";
  readonly description = "no Warden verifier configured (VIBERSYN_ATTEST_VERIFIER_URL): keys are taken from the leaf certificate, facts are unverified claims";
  readonly #issued = new Map<string, { issuedAt: number; expiresAt: number; used: boolean }>();
  readonly #clock: () => number;
  readonly #ttlMs: number;

  constructor(options: { clock?: () => number; ttlMs?: number } = {}) {
    this.#clock = options.clock ?? (() => Date.now());
    this.#ttlMs = options.ttlMs ?? 30 * 60 * 1000;
  }

  async challenge(): Promise<{ challenge: string; expiresAt: string }> {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const challenge = toBase64(bytes);
    const now = this.#clock();
    this.#issued.set(challenge, { issuedAt: now, expiresAt: now + this.#ttlMs, used: false });
    if (this.#issued.size > 1000) {
      const oldest = [...this.#issued.entries()].sort((a, b) => a[1].issuedAt - b[1].issuedAt)[0];
      if (oldest !== undefined) this.#issued.delete(oldest[0]);
    }
    return { challenge, expiresAt: new Date(now + this.#ttlMs).toISOString() };
  }

  async attest(input: AttestInput): Promise<AttestOutcome> {
    let certs: Uint8Array[];
    try {
      certs = parseChain(input.chain);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (certs.length === 0) return { ok: false, error: "attestation_chain is empty" };
    let spki: Uint8Array;
    try {
      spki = subjectPublicKeyInfo(certs[0]!);
    } catch (error) {
      return { ok: false, error: `leaf certificate unreadable: ${error instanceof Error ? error.message : String(error)}` };
    }
    let ext = null;
    for (const cert of certs) {
      try {
        ext = parseAttestationExtension(cert);
      } catch {
        ext = null;
      }
      if (ext !== null) break;
    }
    if (ext === null) return { ok: false, error: "no Android key attestation extension in the chain" };
    const expected = fromBase64(input.challenge);
    if (expected.length === 0 || Buffer.compare(Buffer.from(expected), Buffer.from(ext.challenge)) !== 0) {
      return { ok: false, error: "attestation challenge does not match the certificate" };
    }
    const issued = this.#issued.get(input.challenge);
    let freshness: Freshness | null = null;
    if (issued !== undefined) {
      if (issued.used) return { ok: false, error: "challenge was already used" };
      if (issued.expiresAt < this.#clock()) return { ok: false, error: "challenge expired" };
      issued.used = true;
      freshness = { issuedAt: new Date(issued.issuedAt).toISOString(), expiresAt: new Date(issued.expiresAt).toISOString() };
    }
    const facts: AttestedFacts = {
      attestation_security_level: ext.attestationSecurityLevel,
      key_security_level: ext.keymintSecurityLevel,
      packages: ext.packages.map((p) => ({ name: p.name, version_code: p.versionCode })),
      signer_digests: ext.signerDigests,
      ...(ext.rootOfTrust === null
        ? {}
        : {
            bootloader_locked: ext.rootOfTrust.deviceLocked,
            verified_boot_state: ext.rootOfTrust.verifiedBootState,
            verified_boot_key: ext.rootOfTrust.verifiedBootKey,
            verified_boot_device: null,
          }),
      ...(ext.osVersion === null ? {} : { os_version: String(ext.osVersion) }),
      ...(ext.osPatchLevel === null ? {} : { os_patch_level: String(ext.osPatchLevel) }),
    };
    return { ok: true, spki, facts, freshness, verified: "leaf-only" };
  }
}

export function selectAttestationBackend(env: Record<string, string | undefined>): AttestationBackend {
  const url = env.VIBERSYN_ATTEST_VERIFIER_URL?.trim();
  return url !== undefined && url.length > 0 ? new RemoteVerifierBackend(url) : new LeafOnlyBackend();
}
