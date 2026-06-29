# probe-streaming-tts

## Built

- Updated `poc/p-tts.test.ts`, the validate-before-build P-TTS probe for ElevenLabs Flash, Cartesia Sonic, PlayHT 3.0 Turbo, and OpenAI `/v1/audio/speech`.
- The probe uses the landed `poc/harness.ts` RBG harness and exercises candidate matrix coverage, deterministic 15-word guard before submission, once-per-session voice selection, `TTSProvider` stream contract, live time-to-first-audio-chunk measurement, selected-provider static pre-cache, and secret redaction.
- The selection artifact now distinguishes `fastestMeasured` from `selected`; no selected provider is recorded unless the measured provider is within the 200 ms budget and the candidate benchmark is complete.
- The pre-cache artifact now fails closed when no provider is selected. It no longer records synthetic one-byte clips as a green selected-provider pre-cache.
- No raw provider key is written to source, logs, trace, report, or probe artifacts.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| P-TTS | failed | `artifacts/smithering/build/probe-streaming-tts/evidence/P-TTS-rbg-red.log`, `artifacts/smithering/build/probe-streaming-tts/evidence/P-TTS-green.log` |

## Dependency Results

- `probe-suite-harness`: `artifacts/smithering/build/probe-suite-harness/RESULT.md`
- `subscription-credentials-redaction`: `artifacts/smithering/build/subscription-credentials-redaction/RESULT.md`
- Dependency verdict read from `artifacts/smithering/probes/probe-suite-harness/verdict.json`: green.

## Probe Result

- Verdict: `artifacts/smithering/probes/probe-streaming-tts/verdict.json`
- Selection record: `artifacts/smithering/probes/probe-streaming-tts/selection.json`
- Pre-cache record: `artifacts/smithering/probes/probe-streaming-tts/precache.json`
- Harness report: `artifacts/smithering/reports/probe-streaming-tts/report.json`

The only configured live provider was OpenAI `/v1/audio/speech`. It conformed to the stream contract and returned `audio/pcm`, but measured 490 ms time-to-first-audio-chunk in the final 200 ms run, above the P-TTS budget. ElevenLabs, Cartesia, and PlayHT credentials were not configured, so the required 2026 candidate benchmark is incomplete. No acceptable provider was selected, and selected-provider state phrase pre-cache remains blocked.

## Commands

- `VIBERSYN_TTS_FIRST_AUDIO_BUDGET_MS=20 bun test poc/p-tts.test.ts`
- `bun test poc/p-tts.test.ts`
- `bunx tsc --noEmit --pretty false --lib ESNext,DOM --module ESNext --target ESNext --moduleResolution bundler --moduleDetection force --verbatimModuleSyntax --strict --skipLibCheck --types bun poc/p-tts.test.ts poc/harness.ts src/providers/credentials.ts src/providers/types.ts src/security/secrets.ts`
- Secret scan over the P-TTS build, probe, and harness-report artifacts.

## Blockers

- P-TTS remains red. The final 200 ms evidence run measured OpenAI `/v1/audio/speech` above budget and found no selected provider.
- The benchmark could not cover ElevenLabs Flash, Cartesia Sonic, or PlayHT 3.0 Turbo because their credential env vars are absent from this worktree environment.
- The five state phrases cannot be pre-cached as real static clips until a selected provider exists.
