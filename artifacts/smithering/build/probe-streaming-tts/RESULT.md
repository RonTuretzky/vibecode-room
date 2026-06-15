# probe-streaming-tts

## Built

- Added `poc/p-tts.test.ts`, a validate-before-build P-TTS probe for ElevenLabs, Cartesia, PlayHT, and OpenAI `/v1/audio/speech` candidates.
- The probe uses the landed `poc/harness.ts` RBG harness and exercises candidate matrix coverage, deterministic 15-word guard before submission, once-per-session voice selection, `TTSProvider` stream contract, live time-to-first-audio-byte measurement, static pre-cache playback mechanics, and secret redaction.
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

The only configured live provider was OpenAI `/v1/audio/speech`. It conformed to the stream contract but measured 1875.98 ms time-to-first-audio-byte, above the 200 ms P-TTS gate. ElevenLabs, Cartesia, and PlayHT credentials were not configured, so no acceptable provider was selected. The five fixed state phrases are recorded as pre-cache blocked against a selected provider; the static cache playback mechanics measured below 100 ms with synthetic clips.

## Commands

- `PANOP_TTS_FIRST_AUDIO_BUDGET_MS=20 bun test poc/p-tts.test.ts`
- `bun test poc/p-tts.test.ts`
- `NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck`

## Blockers

- P-TTS remains red. Dependent output-policy/latency tickets must stay unscheduled until a configured real TTS candidate streams first audio byte within 200 ms and selected-provider pre-cache can be generated from that provider.
- Typecheck retried with an 8 GB Node heap and still exited 134 from repository-wide TypeScript memory exhaustion. The edited probe file is outside `tsconfig.json`'s `include`; the P-TTS blocker is the live provider budget failure.
