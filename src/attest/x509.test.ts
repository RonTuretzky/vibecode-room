import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { toBase64 } from "./format";
import { parseAttestationExtension, parseChain, subjectPublicKeyInfo } from "./x509";

// Warden Supreme's own GrapheneOS Pixel 7a fixture (TEE key, locked bootloader).
const chainB64 = readFileSync(new URL("./fixtures/grapheneos-pixel7a-chain.b64", import.meta.url), "utf8")
  .split("\n").filter((line) => line.trim().length > 0);

describe("x509 attestation extension reader", () => {
  test("splits a concatenated-DER chain and reads the leaf SPKI", () => {
    const concatenated = toBase64(new Uint8Array(Buffer.concat(chainB64.map((c) => Buffer.from(c, "base64")))));
    const certs = parseChain(concatenated);
    expect(certs.length).toBe(chainB64.length);
    expect(parseChain(chainB64).length).toBe(chainB64.length);
    const spki = subjectPublicKeyInfo(certs[0]!);
    expect(spki.length).toBeGreaterThan(100);
  });

  test("reads challenge, security levels, package, signer and root of trust from the leaf", () => {
    const leaf = parseChain(chainB64)[0]!;
    const ext = parseAttestationExtension(leaf);
    expect(ext).not.toBeNull();
    expect(toBase64(ext!.challenge)).toBe("erlGxbI+3t23T2O9V7+Pvfmz3I2TRMMTIBrLxDI3M+4=");
    expect(ext!.keymintSecurityLevel).toBe("TRUSTED_ENVIRONMENT");
    expect(ext!.attestationVersion).toBe(400);
    expect(ext!.packages).toEqual([{ name: "at.asitplus.atttest", versionCode: 1 }]);
    expect(ext!.signerDigests).toEqual(["34b9762c4d6c90d48431940c57bde7314258b26420efe16ac7f7274f0d330ad5"]);
    expect(ext!.rootOfTrust).toEqual({
      verifiedBootKey: "508d75dea10c5cbc3e7632260fc0b59f6055a8a49dd84e693b6d8899edbb01e4",
      deviceLocked: true,
      verifiedBootState: "SelfSigned",
    });
    expect(ext!.osVersion).toBe(160000);
    expect(ext!.osPatchLevel).toBe(202603);
  });

  test("returns null for a certificate without the extension", () => {
    const root = parseChain(chainB64).at(-1)!;
    expect(parseAttestationExtension(root)).toBeNull();
  });
});
