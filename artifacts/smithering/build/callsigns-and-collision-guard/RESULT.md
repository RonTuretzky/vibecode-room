# callsigns-and-collision-guard

## Built

- Added `src/routing/callsigns.ts` with a rare coined multi-syllable callsign pool, local deterministic double-Metaphone-style codes, phoneme-Levenshtein collision checks, and concatenated-STT callsign matching.
- Added `CallsignAllocator` with sequential assignment, active-call collision rejection, proposed-call rejection, and 60 s halted-call cooldown.
- Wired spawn dispatch to assign or validate callsigns before Smithers work starts and to emit structured `command.callsign` traces with correlation ids.
- Replaced default routing/cue test callsigns with the coined pool; no NATO subset remains in the shipped pool.

## Dependency / probe status

- `probe-cue-substrate` verdict re-read: green.
- `probe-suite-harness` verdict re-read: green.
- `routing-dispatch-invariants` RESULT.md was requested but is not present in this worktree; existing landed routing interfaces were read directly from `src/routing/`, `src/cue/`, and `src/seam/`.

## Gate roll-up

| Criterion | Status | Evidence |
|---|---|---|
| AC7.2 | passed | `artifacts/smithering/build/callsigns-and-collision-guard/evidence/AC7.2-rbg-red.log`, `artifacts/smithering/build/callsigns-and-collision-guard/evidence/AC7.2-green.log` |
| AC13.2 | passed | `artifacts/smithering/build/callsigns-and-collision-guard/evidence/AC13.2-rbg-red.log`, `artifacts/smithering/build/callsigns-and-collision-guard/evidence/AC13.2-green.log` |
| D-DD-18 | passed | `artifacts/smithering/build/callsigns-and-collision-guard/evidence/D-DD-18-rbg-red.log`, `artifacts/smithering/build/callsigns-and-collision-guard/evidence/D-DD-18-green.log` |
| A5.2 | passed | `artifacts/smithering/build/callsigns-and-collision-guard/evidence/A5.2-rbg-red.log`, `artifacts/smithering/build/callsigns-and-collision-guard/evidence/A5.2-green.log` |
| A5.4 | passed | `artifacts/smithering/build/callsigns-and-collision-guard/evidence/A5.4-rbg-red.log`, `artifacts/smithering/build/callsigns-and-collision-guard/evidence/A5.4-green.log` |
| P-PHONETIC | passed | `artifacts/smithering/build/callsigns-and-collision-guard/evidence/P-PHONETIC-rbg-red.log`, `artifacts/smithering/build/callsigns-and-collision-guard/evidence/P-PHONETIC-green.log` |

## Verification

- `bun test src/routing/callsigns.test.ts`: passed in every green gate log.
- `bun test`: passed, see `artifacts/smithering/build/callsigns-and-collision-guard/tests.log`.
- Scoped typecheck for changed TS files passed, see `artifacts/smithering/build/callsigns-and-collision-guard/tsc.log`.
- Full `bun run typecheck` was attempted but the current repo-wide TypeScript invocation OOMed under Node even with an 8 GB heap; the scoped typecheck is recorded because it covers changed files without the existing repo-wide heap failure.

## Blockers

- None for this ticket.
