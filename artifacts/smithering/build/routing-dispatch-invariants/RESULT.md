# routing-dispatch-invariants

## Built

- Added `src/routing/` as the deterministic routing authority: env-tunable vocabulary defaults, priority comparator, dispatch guard, addressed/ambient pass distinction, and one handler per documented V0 command.
- Implemented fixed-command handling for wake, mute/unmute, panic, stop, accept/decline, select/select-and-steer, end steering, status, pause-all, and targeted pause/resume.
- Kept natural-language command parsing out of scope: per-process pause/resume require an in-utterance callsign or open steering window; free-form "pause the second one" is rejected at dispatch.
- Added routing traces for `command.recognize`, `route.pass`, `route.suggestion`, and `route.steer` with stable correlation ids and deterministic `CueDecision.addressed`.
- Extended the spine e2e with the routing slice: ambient never steers, one-breath Atlas steering works, undocumented ambient is silent, and "Atlas, pause" leaves Bravo running.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| AC12.2 | passed | `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC12.2-rbg-red.log`, `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC12.2-green.log` |
| AC6.1 | passed | `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC6.1-rbg-red.log`, `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC6.1-green.log` |
| AC6.5 | passed | `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC6.5-rbg-red.log`, `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC6.5-green.log` |
| AC7.4-yes-gating | passed | `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC7.4-yes-rbg-red.log`, `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC7.4-yes-green.log` |
| AC7.3 | passed | `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC7.3-rbg-red.log`, `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC7.3-green.log` |
| AC7.1 | passed | `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC7.1-rbg-red.log`, `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC7.1-green.log` |
| AC7.4-nl-out-of-scope | passed | `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC7.4-nl-rbg-red.log`, `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC7.4-nl-green.log` |
| AC6.4 | passed | `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC6.4-rbg-red.log`, `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC6.4-green.log` |
| AC8.3 | passed | `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC8.3-rbg-red.log`, `artifacts/smithering/build/routing-dispatch-invariants/evidence/AC8.3-green.log` |
| routing-e2e | passed | `artifacts/smithering/build/routing-dispatch-invariants/evidence/routing-e2e-rbg-red.log`, `artifacts/smithering/build/routing-dispatch-invariants/evidence/routing-e2e-green.log` |

## Dependency Results

- `cue-adapter-and-policies`: `artifacts/smithering/build/cue-adapter-and-policies/RESULT.md`
- `probe-cue-substrate`: `artifacts/smithering/build/probe-cue-substrate/RESULT.md`
- `probe-suite-harness`: `artifacts/smithering/build/probe-suite-harness/RESULT.md`

## Commands

- `bun test src/routing/dispatch.test.ts`
- `bun test test/e2e/spine.e2e.ts`
- `bun test src/routing/dispatch.test.ts test/e2e/spine.e2e.ts`
- `bun test`
- `NODE_OPTIONS=--max-old-space-size=16384 bunx tsc --noEmit --pretty false --strict --target ESNext --module ESNext --moduleResolution bundler --skipLibCheck src/routing/*.ts`

## Notes

- Full-repo `bun test` passed and is recorded in terminal history; the ticket bundle's `tests.log` records the required routing unit and e2e verification block.
- Full-project `bun run typecheck` exceeded the TypeScript process memory/time budget in this worktree before producing diagnostics; the routing-targeted typecheck passed and is recorded in `tsc.log`.

## Blockers

None surfaced.
