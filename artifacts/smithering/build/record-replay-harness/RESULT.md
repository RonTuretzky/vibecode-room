# record-replay-harness

## Built

- Added `src/replay/harness.ts`, the ENG-T-02 replay seam for transcript-observation JSONL input, temperature-0 `DecisionLLM` doubles, canonical decision streams, input/output hashing, in-memory replay caching, and structured replay trace events.
- Added invariant helpers for AI-output surfaces so tests assert shape and limits rather than exact LLM prose: MCQ count, spoken word count, and budget timing.
- Added `src/replay/harness.test.ts` covering deterministic cold replays, cached re-runs, stable hashes, trace rows, empty input, and over-limit invariant rejection.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| ENG-T-02-determinism | passed | `evidence/ENG-T-02-determinism-rbg-red.log` and `evidence/ENG-T-02-determinism-green.log` |
| ENG-T-02-invariants | passed | `evidence/ENG-T-02-invariants-rbg-red.log` and `evidence/ENG-T-02-invariants-green.log` |

## Dependency Results

- `shared-types-contract`: `artifacts/smithering/build/shared-types-contract/RESULT.md`

## Commands

- `bun test src/replay/harness.test.ts`
- `bun test`
- `bunx tsc --noEmit`

## Blockers

None surfaced.
