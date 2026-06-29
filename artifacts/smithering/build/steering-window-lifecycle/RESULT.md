# steering-window-lifecycle

## Built

- Added `src/routing/steering-window.ts`, a deterministic per-process steering window manager.
- Opens on callsign detection, including one-breath select-and-steer.
- Routes open-window speech to the selected UPID only and emits `route-steer` Layer-B ack metadata for each routed utterance.
- Closes on `Done`, `Back`, `Abort`, or the configured `VIBERSYN_STEER_IDLE_SECONDS` default of 20 seconds of mic-level idle.
- Gates state-scoped `Done`/`Back` and low-confidence steer handling in deterministic code.
- Added `src/routing/steering-window.test.ts` and a `test/e2e/fleet.e2e.ts` window slice.

## Gate Roll-Up

| Criterion | Method | Status | Evidence |
|---|---|---|---|
| AC6.2 | unit_test | passed | `evidence/AC6.2-rbg-red.log`, `evidence/AC6.2-green.log` |
| AC6.3 | unit_test | passed | `evidence/AC6.3-rbg-red.log`, `evidence/AC6.3-green.log` |
| AC6.5 | integration_test | passed | `evidence/AC6.5-rbg-red.log`, `evidence/AC6.5-green.log` |
| AC8.1 | e2e_test | passed | `evidence/AC8.1-rbg-red.log`, `evidence/AC8.1-green.log` |
| AC8.2 | unit_test | passed | `evidence/AC8.2-rbg-red.log`, `evidence/AC8.2-green.log` |
| AC8.3 | unit_test | passed | `evidence/AC8.3-rbg-red.log`, `evidence/AC8.3-green.log` |

## Verification

- `bun test src/routing/steering-window.test.ts test/e2e/fleet.e2e.ts` recorded in `tests.log`.
- Targeted TypeScript check for the new steering-window source and unit tests recorded in `tsc.log`.
- Structured trace written to `trace/steering-window.jsonl`.
- Secret scan passed in `secret-scan.json`.

## Dependency Results

- `probe-cue-substrate` verdict: `artifacts/smithering/probes/probe-cue-substrate/verdict.json` green.
- `probe-suite-harness` verdict: `artifacts/smithering/probes/probe-suite-harness/verdict.json` green.
- `probe-cue-smithers-seam` verdict: `artifacts/smithering/probes/probe-cue-smithers-seam/verdict.json` green.
- `routing-dispatch-invariants` landed on the integration branch at `c4d3830`; the built source interfaces were read from `src/routing/handlers.ts` and `src/routing/vocabulary.ts`.
- The requested dependency result path `artifacts/smithering/build/routing-dispatch-invariants/RESULT.md` was absent in this isolated worktree, so this ticket used the landed dependency code and commit history as the authoritative interface.

## Blockers

None.
