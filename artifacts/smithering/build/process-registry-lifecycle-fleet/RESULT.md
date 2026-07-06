# process-registry-lifecycle-fleet

## Built

- Added `src/process/` with a UPID registry, lifecycle state machine, and pre-spawn resource check.
- Registry enforces the V0 max of two live processes, sequential callsign assignment, 60 s reuse cooldown through the landed callsign allocator, per-UPID pause/resume, pause-all as iteration over per-UPID pause, and a <=15-word status summary.
- Lifecycle covers `planning -> active <-> paused -> dead`, archives context before kill, and recovers to the last durable checkpoint.
- Fleet tests prove two live processes stay isolated, unselected processes keep advancing, host headroom refusal logs `spawn.refused`, and capacity refusal speaks `At capacity — stop a process first.`
- Updated seam/e2e type issues so `bunx --bun tsc --noEmit` passes.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| AC8.2 | passed | `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/AC8.2-rbg-red.log`, `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/AC8.2-green.log` |
| AC13.1 | passed | `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/AC13.1-rbg-red.log`, `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/AC13.1-green.log` |
| AC13.3 | passed | `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/AC13.3-rbg-red.log`, `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/AC13.3-green.log` |
| AC15.2-LIFECYCLE | passed | `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/AC15.2-LIFECYCLE-rbg-red.log`, `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/AC15.2-LIFECYCLE-green.log` |
| AC15.2-ARCHIVE | passed | `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/AC15.2-ARCHIVE-rbg-red.log`, `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/AC15.2-ARCHIVE-green.log` |
| AC15.2-RESOURCE | passed | `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/AC15.2-RESOURCE-rbg-red.log`, `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/AC15.2-RESOURCE-green.log` |
| HOST-HEADROOM | passed | `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/HOST-HEADROOM-rbg-red.log`, `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/HOST-HEADROOM-green.log` |
| AC15.3 | passed | `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/AC15.3-rbg-red.log`, `artifacts/smithering/build/process-registry-lifecycle-fleet/evidence/AC15.3-green.log` |

## Dependency Results Read

- `cue-smithers-seam-dispatcher`: `artifacts/smithering/build/cue-smithers-seam-dispatcher/RESULT.md`
- `callsigns-and-collision-guard`: dependency code read from landed `src/routing/callsigns.ts`; RESULT.md was absent in this worktree.
- Blocking probe verdicts re-read: P-SEAM, P-CUE, P-SMITHERS, probe-suite harness all green.

## Commands

- `bun test src/process/registry.test.ts src/process/lifecycle.test.ts src/process/resource-check.test.ts`
- `bun test test/e2e/fleet.e2e.ts`
- `bun test`
- `bunx --bun tsc --noEmit`

## Blockers

None surfaced.
