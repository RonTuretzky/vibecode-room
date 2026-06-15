# cue-smithers-seam-dispatcher

## Built

- Added `src/seam/` as the single owned Cue to Smithers integration module:
  - `dispatcher.ts`: Hono HTTP/WebSocket action endpoint plus async `DispatchedAction` dispatch for `spawn`, `steer`, `pause`, `resume`, `halt`, `pauseAll`, and `status`.
  - `smithers-client.ts`: Gateway RPC client for durable run launch, signal steering, resume, cancel/halt, and event streaming, including an official Gateway WebSocket/RPC transport. No CLI or detach path is used.
  - `run-events.ts`: Smithers Gateway run-event normalization to `RunEvent`, <=15-word voice summaries before Cue observation output, reconnect, and duplicate suppression.
  - `correlation-store.ts`: persisted UPID, runId, callsign, steering-window, state, and last-seq correlation that survives Cue restarts.
  - `index.ts`: a single export surface for the seam module.
- Added seam unit/integration coverage in `src/seam/seam.test.ts`.
- Added the requested seam e2e slices:
  - `bun test test/e2e/spine.e2e.ts`: real Gateway durable spawn to confirmation under 3 seconds.
  - `bun test test/e2e/fleet.e2e.ts`: real Gateway restart recovery from the last checkpoint.
- Added Bun test-discovery wrappers so the exact requested e2e command paths match test files.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| SEAM-ACTION-SCHEMA | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-ACTION-SCHEMA-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-ACTION-SCHEMA-green.log` |
| SEAM-ASYNC-DISPATCH | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-ASYNC-DISPATCH-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-ASYNC-DISPATCH-green.log` |
| SEAM-SSE-RECONNECT | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-SSE-RECONNECT-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-SSE-RECONNECT-green.log` |
| SEAM-RESTART-CORRELATION | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-RESTART-CORRELATION-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/SEAM-RESTART-CORRELATION-green.log` |
| AC4.3 | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/AC4.3-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/AC4.3-green.log` |
| AC15.3 | passed | `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/AC15.3-rbg-red.log`, `artifacts/smithering/build/cue-smithers-seam-dispatcher/evidence/AC15.3-green.log` |

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
- `bun run typecheck`

## Blockers

None surfaced.
