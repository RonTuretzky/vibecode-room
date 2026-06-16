# shared-types-contract

## Built

- Promoted `src/types.ts` from the walking-skeleton stub to the ENG-T-01 shared contract.
- Added zod mirrors for transcript observations, Cue decisions, dispatched actions, credential sources, pending suggestions, run events, log events, output decisions, earcon ids, and ack ids.
- Added `src/types.test.ts` covering JSONL round-trips, loop-event id presence, V0 action coverage, timeout ack coverage, and absence of cut subsystem contracts.
- Updated the walking-skeleton smoke path to import and satisfy the promoted contract.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| ENG-T-01 | passed | `evidence/ENG-T-01-rbg-red.log` and `evidence/ENG-T-01-green.log` |

## Dependency Results

- `walking-skeleton-smoke`: `artifacts/smithering/build/walking-skeleton-smoke/RESULT.md`

## Commands

- `bun test src/types.test.ts`
- `bun test`
- `bunx tsc --noEmit`

## Blockers

None surfaced.
