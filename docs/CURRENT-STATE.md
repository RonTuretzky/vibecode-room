# Current state (honest)

This doc supersedes the stale claims in `PROMPT.md`. `PROMPT.md` is the original
build prompt — keep it for history, but do not trust it as a description of what
runs. The hardening audit (2026-07) flagged four stale claims and three
tested-but-unwired subsystems; both lists are resolved below.

## Stale PROMPT.md claims vs. what actually exists

| PROMPT.md claim | Reality |
| --- | --- |
| "Living garden" wall UI — processes as growing plants (§5.8) | Not built. The wall is a projector **board** (`src/ui/App.tsx`): process panel, live transcript, idea bubble + tray, trace, build chips. No garden/plant aesthetic. |
| Built on the **Cue** realtime harness | The upstream Cue repo was **deleted**; there is no Cue build in this tree. The runtime uses the in-repo fallback `CueAdapter` (`src/cue/adapter.ts`) via `src/server/cue-bridge.ts`; the harness fast-path only activates if `VIBERSYN_CUE_SOURCE_DIR` points at a build, which in practice it never does. ~10 cue-substrate tests fail environmentally on every branch for this reason — do not chase them as regressions. |
| Local inference via `plugin-local-inference` (§5.7, whisper-on-device, etc.) | No local inference exists. Every model leg is cloud (Deepgram ASR, Cerebras `gemma-4-31b`, host `claude` CLI, ElevenLabs TTS) or a deterministic stub. `GET /api/health` reports exactly which legs are stubbed. |
| Phone as a **roaming per-process mic** (§5.9, QR pairs a phone to one process) | Not built. `public/mic.html` pairs a phone/browser as the **room** mic over the `/api/mic` WebSocket (see `docs/phone-mic.md`) — it feeds the shared session, not one process's input queue. The QR flow that does exist imports GitHub projects (`POST /api/projects/import`); it is not mic pairing. |

## Audit: tested-but-unwired subsystems (now fixed)

- **Hot-loop summarizer** (`src/audio/output-policy.ts:67`): the ">15 words →
  summarize" guard existed but no production caller ever supplied a summarizer,
  so overlong spoken updates were silently clamped mid-sentence. Fixed:
  `src/audio/summarizer.ts` — `selectSummarizer(env)` gives a Cerebras one-shot
  summarize-to-N-words (`CEREBRAS_API_KEY` / `VIBERSYN_SUMMARIZER=cerebras`)
  with a deterministic `clampWords` fallback that can never wedge or throw.
- **Degradation honesty** (`src/server/degradation-notice.ts:40`): `/api/health`
  could claim `allReal` while the summarizer was stubbed and while the in-memory
  Smithers client was faking run telemetry. Fixed: both legs are reported, and an
  *absent* summarizer selection counts as degraded (`mode: "unwired"`) — the
  notice cannot claim `allReal` until the leg is both wired and real.
- **Onboarding modules** (`src/onboarding/*`): `consent.ts` (REQ-1 disclosure),
  `listening-indicator.ts` (authoritative mic state), and
  `persistence-guard.ts` (transcripts only, never raw audio) were fully tested
  and never constructed by anything. Fixed: `src/server/onboarding-glue.ts` is
  the thin seam composition calls at session start (consent → trace +
  transcript), mic open/close (authoritative `listening` flag, E2 earcon), and
  every transcript fold (raw-audio writes throw).

## What does run today

Talk → detect → accept → build → preview: live mic (Deepgram or replay) feeds
idea detection; accepted ideas spawn registry processes and scaffold served
builds under `builds/<upid>/`. Desk mode (mouse/keyboard/voice commands), QR
GitHub import, idea tray, emergency stop, mute, and the SSE-driven projector
snapshot all work. Degraded legs are explicit at boot and on `GET /api/health`.
