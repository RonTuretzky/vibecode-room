# cue-adapter-and-policies

## Built

- Added `src/cue/` as the Cue-owned boundary: real Cue source loader, policy wiring, two Program setup, adapter normalization, route logging, mapped-action dispatch conversion, and harness provider-slot wiring.
- Kept command recognition authority in Cue `TextCue`; the adapter only emits the earcon from the Cue decision and enforces byte-equal parity for the optional D2 pre-matcher fallback.
- Recorded D2 owned-extension risks in code and tests: speaker-label-stability shim, `observe.pass` interception/logging, interval cooldown wrapping, and adapter-owned earcon emission.
- Added adapter verification and the spine recognition-latency slice.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| AC1.4 | passed | `artifacts/smithering/build/cue-adapter-and-policies/evidence/AC1.4-rbg-red.log`, `artifacts/smithering/build/cue-adapter-and-policies/evidence/AC1.4-green.log` |
| AC16.1 | passed | `artifacts/smithering/build/cue-adapter-and-policies/evidence/AC16.1-rbg-red.log`, `artifacts/smithering/build/cue-adapter-and-policies/evidence/AC16.1-green.log` |
| AC6.1 | passed | `artifacts/smithering/build/cue-adapter-and-policies/evidence/AC6.1-rbg-red.log`, `artifacts/smithering/build/cue-adapter-and-policies/evidence/AC6.1-green.log` |
| AC10.1-unit | passed | `artifacts/smithering/build/cue-adapter-and-policies/evidence/AC10.1-unit-rbg-red.log`, `artifacts/smithering/build/cue-adapter-and-policies/evidence/AC10.1-unit-green.log` |
| AC10.1-e2e | passed | `artifacts/smithering/build/cue-adapter-and-policies/evidence/AC10.1-e2e-rbg-red.log`, `artifacts/smithering/build/cue-adapter-and-policies/evidence/AC10.1-e2e-green.log` |

## Dependency Results

- `probe-cue-substrate`: `artifacts/smithering/build/probe-cue-substrate/RESULT.md`
- `shared-types-contract`: `artifacts/smithering/build/shared-types-contract/RESULT.md`
- `provider-interface-doubles`: `artifacts/smithering/build/provider-interface-doubles/RESULT.md`
- `record-replay-harness`: `artifacts/smithering/build/record-replay-harness/RESULT.md`

## Commands

- `bun test src/cue/adapter.test.ts`
- `bun test test/e2e/spine.e2e.ts`
- `bun test`
- Targeted typecheck for the Cue adapter suite recorded in `tsc.log`

## Decision Docs

- `artifacts/smithering/decisions/build/cue-adapter-owned-hot-path.html`

## Blockers

None surfaced.
