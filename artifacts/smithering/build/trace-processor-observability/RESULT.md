# trace-processor-observability

## Built

- Replaced the skeleton trace stub with `src/obs/trace.ts` as a first-class pipeline stage: `record()` and `process()` emit validated `LogEvent` rows before downstream work runs.
- Added stable, queryable trace records with verb-noun event names, required `sessionId`/`correlationId`, required `upid` for process events, and measured `latencyMs` from input timestamps.
- Added pass tracing so every `observe.pass` produces a corresponding `route.pass` line.
- Added JSONL serialize/parse helpers and a correlation-id query API that reconstructs observation -> decision -> action -> outcome chains from persisted traces alone.
- Added a redaction-filter seam over `LogEvent.meta` for the follow-on subscription credentials ticket.
- Updated the smoke test to reflect that pass decisions are now logged instead of silently dropped.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| AC16.1 | passed | `evidence/AC16.1-rbg-red.log` and `evidence/AC16.1-green.log` |
| AC16.3 | passed | `evidence/AC16.3-rbg-red.log` and `evidence/AC16.3-green.log` |
| ENG-T-03-pass-logging | passed | `evidence/ENG-T-03-pass-logging-rbg-red.log` and `evidence/ENG-T-03-pass-logging-green.log` |
| ENG-T-03-roundtrip | passed | `evidence/ENG-T-03-roundtrip-rbg-red.log` and `evidence/ENG-T-03-roundtrip-green.log` |

## Dependency Results

- `shared-types-contract`: `artifacts/smithering/build/shared-types-contract/RESULT.md`

## Commands

- `bun test src/obs/trace.test.ts`
- `bun test`
- `bunx tsc --noEmit`

## Blockers

None surfaced.
