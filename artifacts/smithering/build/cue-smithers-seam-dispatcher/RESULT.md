# cue-smithers-seam-dispatcher

## Built

- `src/seam/` remains the single owned Cue to Smithers integration module.
- `dispatcher.ts` now returns async dispatch acknowledgements, surfaces `status` as a registry-derived <=15-word summary, and rejects targetless `steer`/`pause`/`resume`/`halt` before off-path Smithers work starts.
- `smithers-client.ts` continues to use the Gateway RPC/signal path for launch, steer, pause, resume, halt, and SSE events. No CLI or detach path is used.
- `run-events.ts` normalizes Gateway SSE frames to `RunEvent`, summarizes before voice-out, reconnects with `afterSeq`, suppresses duplicates, and preserves UPID to steering-window correlation after a Cue restart.
- `test/e2e/fleet.e2e.ts` now proves the seam slice for live steering and per-process pause isolation across two durable Gateway runs, plus the existing restart recovery proof.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| SEAM-ACTION-SCHEMA | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-ACTION-SCHEMA-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-ACTION-SCHEMA-green.log` |
| SEAM-STATUS-SUMMARY | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-STATUS-SUMMARY-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-STATUS-SUMMARY-green.log` |
| SEAM-TARGET-GUARD | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-TARGET-GUARD-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-TARGET-GUARD-green.log` |
| SEAM-ASYNC-DISPATCH | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-ASYNC-DISPATCH-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-ASYNC-DISPATCH-green.log` |
| SEAM-SSE-RECONNECT | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-SSE-RECONNECT-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-SSE-RECONNECT-green.log` |
| SEAM-RESTART-CORRELATION | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-RESTART-CORRELATION-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-RESTART-CORRELATION-green.log` |
| AC4.3 | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/AC4.3-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/AC4.3-green.log` |
| AC8.1 | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/AC8.1-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/AC8.1-green.log` |
| AC13.1 | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/AC13.1-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/AC13.1-green.log` |
| AC13.3 | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/AC13.3-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/AC13.3-green.log` |
| AC15.3 | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/AC15.3-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/AC15.3-green.log` |
| TSC-NO-EMIT | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/TSC-NO-EMIT-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/TSC-NO-EMIT-green.log` |

## Dependency Results Read

- `probe-cue-smithers-seam`: `artifacts/smithering/build/probe-cue-smithers-seam/RESULT.md`
- `probe-smithers-durable-runs`: `artifacts/smithering/build/probe-smithers-durable-runs/RESULT.md`
- `shared-types-contract`: `artifacts/smithering/build/shared-types-contract/RESULT.md`

## Commands

- `bun test src/seam/seam.test.ts`
- `bun test test/e2e/spine.e2e.ts`
- `bun test test/e2e/fleet.e2e.ts`
- `bun test src/seam/seam.test.ts test/e2e/spine.e2e.ts test/e2e/fleet.e2e.ts`
- `bun test`
- `bunx tsc --noEmit`

## Blockers

None surfaced.
