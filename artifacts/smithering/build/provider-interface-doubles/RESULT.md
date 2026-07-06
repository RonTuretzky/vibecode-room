# provider-interface-doubles

## Built

- Added the ENG-T-04 provider boundary in `src/providers/`: `ASRProvider`, `TTSProvider`, and `DecisionLLM`.
- Added provider doubles: `asr/replay.ts`, `tts/noop.ts`, and `llm/replay.ts`.
- Added `src/providers/boundary.test.ts` covering boundary substitution, ASR shape conformance, noop TTS behavior, replay LLM temp-0 caching, concrete-provider import linting, and absence of a bespoke keyword spotter provider.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| ENG-T-04 | passed | `evidence/ENG-T-04-rbg-red.log` and `evidence/ENG-T-04-green.log` |

## Dependency Results

- `shared-types-contract`: `artifacts/smithering/build/shared-types-contract/RESULT.md`

## Commands

- `bun test src/providers/boundary.test.ts`
- `bunx tsc --noEmit`

## Blockers

None surfaced.
