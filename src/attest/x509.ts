// Just enough X.509 / DER to read what an Android Key Attestation certificate
// CLAIMS — the subject public key and the attestation extension (OID
// 1.3.6.1.4.1.11129.2.1.17) — without validating anything. Chain validation,
// revocation, trust anchors and policy belong to Warden (attestable-verifier
// serve); this file exists so a room with no JVM can still (a) get the key the
// per-chunk signatures must verify against and (b) display, clearly labelled as
// unverified, the security level / package / boot state the phone asserts.
import { X509Certificate } from "node:crypto";
import { fromBase64, toHex } from "./format";

interface Tlv {
  tagClass: number; // 0 universal, 1 application, 2 context, 3 private
  constructed: boolean;
  tagNumber: number;
  start: number; // first content byte
  end: number; // one past last content byte
  next: number; // offset of the next TLV
}

function readTlv(buf: Uint8Array, offset: number): Tlv {
  if (offset >= buf.length) throw new Error("DER: truncated");
  const first = buf[offset]!;
  const tagClass = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let tagNumber = first & 0x1f;
  let o = offset + 1;
  if (tagNumber === 0x1f) {
    tagNumber = 0;
    for (;;) {
      const b = buf[o++];
      if (b === undefined) throw new Error("DER: truncated tag");
      tagNumber = (tagNumber << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
  }
  let len = buf[o++];
  if (len === undefined) throw new Error("DER: truncated length");
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("DER: unsupported length");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[o++]!;
  }
  const end = o + len;
  if (end > buf.length) throw new Error("DER: length overflows buffer");
  return { tagClass, constructed, tagNumber, start: o, end, next: end };
}

function children(buf: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let o = t.start;
  while (o < t.end) {
    const c = readTlv(buf, o);
    out.push(c);
    o = c.next;
  }
  return out;
}

function content(buf: Uint8Array, t: Tlv): Uint8Array {
  return buf.subarray(t.start, t.end);
}

function readInt(buf: Uint8Array, t: Tlv): number {
  let v = 0;
  for (const b of content(buf, t)) v = v * 256 + b;
  return v;
}

const ATTESTATION_EXT_OID = Uint8Array.from([0x2b, 0x06, 0x01, 0x04, 0x01, 0xd6, 0x79, 0x02, 0x01, 0x11]);

// Splits a base64 string of concatenated DER certificates (what the app exports)
// or accepts an array of base64 certificates. Leaf first.
export function parseChain(input: unknown): Uint8Array[] {
  if (Array.isArray(input)) {
    return input.map((c) => {
      if (typeof c !== "string") throw new Error("attestation_chain entries must be base64 strings");
      return fromBase64(c);
    });
  }
  if (typeof input !== "string" || input.length === 0) throw new Error("attestation_chain must be a base64 string or array");
  const all = fromBase64(input);
  const certs: Uint8Array[] = [];
  let o = 0;
  while (o < all.length) {
    const t = readTlv(all, o);
    certs.push(all.slice(o, t.next));
    o = t.next;
  }
  return certs;
}

export function subjectPublicKeyInfo(certDer: Uint8Array): Uint8Array {
  const cert = new X509Certificate(Buffer.from(certDer));
  return new Uint8Array(cert.publicKey.export({ type: "spki", format: "der" }));
}

export const SECURITY_LEVELS = ["SOFTWARE", "TRUSTED_ENVIRONMENT", "STRONGBOX"] as const;
export const VERIFIED_BOOT_STATES = ["Verified", "SelfSigned", "Unverified", "Failed"] as const;

export interface AttestationExtension {
  attestationVersion: number;
  attestationSecurityLevel: string;
  keymintSecurityLevel: string;
  challenge: Uint8Array;
  packages: Array<{ name: string; versionCode: number }>;
  signerDigests: string[]; // hex
  rootOfTrust: { verifiedBootKey: string; deviceLocked: boolean; verifiedBootState: string } | null;
  osVersion: number | null;
  osPatchLevel: number | null;
}

// Finds the attestation extension in a certificate, or null when absent.
export function parseAttestationExtension(certDer: Uint8Array): AttestationExtension | null {
  const cert = readTlv(certDer, 0);
  const tbs = children(certDer, cert)[0];
  if (tbs === undefined) return null;
  const extensionsWrapper = children(certDer, tbs).find((t) => t.tagClass === 2 && t.tagNumber === 3);
  if (extensionsWrapper === undefined) return null;
  const extensions = children(certDer, extensionsWrapper)[0];
  if (extensions === undefined) return null;
  for (const ext of children(certDer, extensions)) {
    const parts = children(certDer, ext);
    const oid = parts[0];
    if (oid === undefined || !equalBytes(content(certDer, oid), ATTESTATION_EXT_OID)) continue;
    const octet = parts[parts.length - 1]!;
    return parseKeyDescription(content(certDer, octet));
  }
  return null;
}

function parseKeyDescription(buf: Uint8Array): AttestationExtension {
  const seq = readTlv(buf, 0);
  const f = children(buf, seq);
  if (f.length < 8) throw new Error("KeyDescription: too few fields");
  const attestationVersion = readInt(buf, f[0]!);
  const attSec = readInt(buf, f[1]!);
  const kmSec = readInt(buf, f[3]!);
  const challenge = content(buf, f[4]!).slice();
  const sw = parseAuthorizationList(buf, f[6]!);
  const hw = parseAuthorizationList(buf, f[7]!);
  return {
    attestationVersion,
    attestationSecurityLevel: SECURITY_LEVELS[attSec] ?? `UNKNOWN(${attSec})`,
    keymintSecurityLevel: SECURITY_LEVELS[kmSec] ?? `UNKNOWN(${kmSec})`,
    challenge,
    packages: sw.packages ?? hw.packages ?? [],
    signerDigests: sw.signerDigests ?? hw.signerDigests ?? [],
    rootOfTrust: hw.rootOfTrust ?? sw.rootOfTrust ?? null,
    osVersion: hw.osVersion ?? sw.osVersion ?? null,
    osPatchLevel: hw.osPatchLevel ?? sw.osPatchLevel ?? null,
  };
}

interface AuthList {
  packages?: Array<{ name: string; versionCode: number }>;
  signerDigests?: string[];
  rootOfTrust?: AttestationExtension["rootOfTrust"];
  osVersion?: number;
  osPatchLevel?: number;
}

const TAG_OS_VERSION = 705;
const TAG_OS_PATCH_LEVEL = 706;
const TAG_ROOT_OF_TRUST = 704;
const TAG_ATTESTATION_APPLICATION_ID = 709;

function parseAuthorizationList(buf: Uint8Array, seq: Tlv): AuthList {
  const out: AuthList = {};
  for (const tagged of children(buf, seq)) {
    if (tagged.tagClass !== 2) continue;
    const inner = children(buf, tagged)[0];
    if (inner === undefined) continue;
    switch (tagged.tagNumber) {
      case TAG_OS_VERSION:
        out.osVersion = readInt(buf, inner);
        break;
      case TAG_OS_PATCH_LEVEL:
        out.osPatchLevel = readInt(buf, inner);
        break;
      case TAG_ROOT_OF_TRUST: {
        const r = children(buf, inner);
        if (r.length >= 3) {
          out.rootOfTrust = {
            verifiedBootKey: toHex(content(buf, r[0]!)),
            deviceLocked: content(buf, r[1]!)[0] !== 0,
            verifiedBootState: VERIFIED_BOOT_STATES[readInt(buf, r[2]!)] ?? "Unknown",
          };
        }
        break;
      }
      case TAG_ATTESTATION_APPLICATION_ID: {
        // OCTET STRING wrapping SEQUENCE { SET OF SEQUENCE { OCTET name, INTEGER version }, SET OF OCTET digest }
        const wrapped = content(buf, inner);
        const appSeq = readTlv(wrapped, 0);
        const [pkgSet, digestSet] = children(wrapped, appSeq);
        if (pkgSet !== undefined) {
          out.packages = children(wrapped, pkgSet).map((p) => {
            const [name, version] = children(wrapped, p);
            return {
              name: name === undefined ? "" : new TextDecoder().decode(content(wrapped, name)),
              versionCode: version === undefined ? 0 : readInt(wrapped, version),
            };
          });
        }
        if (digestSet !== undefined) {
          out.signerDigests = children(wrapped, digestSet).map((d) => toHex(content(wrapped, d)));
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
