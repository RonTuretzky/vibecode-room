# Credible sensors: attested phones as room inputs

A phone running [attestable-recorder](https://github.com/Greenpoint-Compute-Cooperative/attestable-recorder)
in **room mode** can be this room's microphone, hand camera, or gesture camera — and the room can
*prove* what it heard and saw came from that phone, unmodified, from a hardware-backed key on a
locked-bootloader GrapheneOS device.

This is the Track A/B → Track C seam of the Credible Sensors roadmap (C4 #76): the credible sensor
presents as a **standard room input** (the existing `/api/mic` PCM socket and `/hands/ws` guest
cursor socket), plus an **attestation sidecar** the wall can display.

![Wall badge: two attested Pixel sources, StrongBox, locked, fresh, per-stream accepted counts, one sealed](credible-sensors-badge.png)

## What the room checks

For every attested source the room keeps a **byte ledger** per stream: the raw PCM frames it
consumed on `/api/mic`, or the newline-terminated JSON frames it consumed on `/hands/ws`. The phone
signs every ~1–5 s of what it sent, inside its Titan M2, and posts the record here. The room then
checks, per chunk:

1. the record's index is the next one for that stream (no gaps, no replays);
2. `prev_hash` equals the last accepted chunk's hash (per-stream hash chain);
3. the ECDSA signature verifies with the **attested** public key;
4. SHA-256 of the next `size` ledgered bytes equals the record's `hash` — i.e. *the bytes the room
   transcribed / used as cursors are the bytes that were signed*.

When the phone stops it posts a **session record** signing the ordered list of all chunks and a
digest of the OS context it observed (debuggable build? install source? accessibility services?
other recorders?). A list that was truncated or reordered, or context edited after the fact, fails.

## Two levels of verification

| Level | When | What is proven |
|---|---|---|
| **hardware** (green) | `VIBERSYN_ATTEST_VERIFIER_URL` points at `attestable-verifier serve` | Warden validated the certificate chain to Google's hardware attestation roots + revocation list and enforced the policy: StrongBox key, package + APK signer, bootloader locked, verified-boot key is Google's or a published GrapheneOS key, verifier-issued challenge. The facts on the badge are proven. |
| **leaf-only** (amber, "unverified") | no verifier configured | The key and the facts are read straight from the leaf certificate. Chunk signatures still bind the bytes to that key and the challenge is still checked, but nothing proves the key is in hardware or the OS is genuine. |

Run the verifier (JVM 17) next to the room:

```bash
# from the attestable-recorder repo, or the attestable-verifier-*.zip release asset
bin/attestable-verifier serve --port 8790 \
  --package com.attestable.recorder.room \
  --signer <release signer sha256>          # printed in the app's release notes
# then
VIBERSYN_ATTEST_VERIFIER_URL=http://127.0.0.1:8790 bun run dev
```

## The wire flow

```
phone  POST /api/attest/challenge                 → { challenge, expires_at }
phone  generates a StrongBox key with that challenge
phone  POST /api/attest/session { recording_id, attestation_chain, attestation_challenge, streams }
                                                  → { source_id, verified, facts, freshness }
phone  WS  /api/mic?source=<id>                   binary 16 kHz mono Int16 PCM frames (as mic.html)
phone  WS  /hands/ws?source=<id>&stream=hands     {"type":"hello"…} then {"type":"cursors"…} frames
phone  WS  /hands/ws?source=<id>&stream=gesture   same protocol, cursors from body-pose tracking
phone  POST /api/attest/chunk { source_id, type, index, timestamp, duration_ms, size, hash, prev_hash, signature }
                                                  → 200 ok · 202 pending (bytes still in flight) · 400 rejected
phone  POST /api/attest/session/<id>/close { started_at, ended_at, context, chunks, session_signature }
wall   GET  /api/attest/sources                   → per-source summary (also in the snapshot as attestedSources)
```

Chunk bytes are exactly what was sent on the socket: for audio, the PCM bytes; for hands/gesture,
each text frame followed by `\n`, including the `hello`. The signed payload (103 bytes) is
`"ATREC" | 0x04 | type | recording_id | index | timestamp_ms | duration_ms | sha256 | prev_sha256`
with types audio=1, video=2, hands=3, gesture=4, session=0 — see `src/attest/format.ts`.

## What it does not prove

- That the sound was a live human or the camera saw a real scene. Attestation proves *which device
  and app* produced the bytes, never the physics in front of the sensor.
- Anything at all about a source without the Warden verifier: leaf-only is a claim, labelled as such.
- Alignment between a phone's audio and its cursors beyond their signed timestamps.

## Code map

- `src/attest/format.ts` — payload encoding, hash chain, context digest, signature verification
- `src/attest/x509.ts` — leaf SPKI + attestation-extension reader (no validation)
- `src/attest/ledger.ts` — bounded per-stream byte ledgers
- `src/attest/registry.ts` — sources, chunk verification, session sealing, snapshot summary
- `src/attest/backend.ts` — Warden verifier client / leaf-only fallback
- `src/attest/routes.ts` — the `/api/attest/*` endpoints
- `src/server/index.ts`, `src/server/lan-listener.ts` — `?source=` binding on the mic and hands sockets
- `src/ui/AttestedSources.tsx` — the wall badge
