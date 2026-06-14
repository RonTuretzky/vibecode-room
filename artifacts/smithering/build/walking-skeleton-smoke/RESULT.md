# walking-skeleton-smoke — Build Result

## What changed

Implemented the cheapest in-process walking skeleton for the Panopticon V0 spine:

- `src/types.ts` exports the minimal `TranscriptObservation`, `CueDecision`, and `LogEvent` contracts.
- `src/replay/harness.ts` reads transcript-observation JSONL fixtures without mic, network, Cue, or provider keys.
- `src/matcher.ts` is a deterministic TextCue-equivalent wake matcher for the `panopticon` wake word.
- `src/obs/trace.ts` emits one structured `spine.action` `LogEvent` for an action decision.
- `test/smoke/spine-skeleton.smoke.ts` reads the 2-line fixture, runs transcript -> decision -> trace, and asserts exactly one structured trace line with a non-empty `correlationId`.
- `.github/workflows/ci.yml` runs `bun run typecheck` and `bun test`.

The fixture's ambient line includes the word `unmute` so the smoke test proves that only the wake word, not mute-control vocabulary, can trigger this skeleton action path.

## Gate roll-up

| Gate | Tier | Status | RBG evidence |
|---|---|---|---|
| smoke-spine-skeleton | pre-merge | passed | `evidence/smoke-rbg-red.log`, `evidence/smoke-rbg-green.log` |
| bun-test-full-suite | pre-merge | passed | `evidence/bun-test-full-suite-rbg-red.log`, `evidence/bun-test-full-suite-rbg-green.log` |
| tsc-noEmit | pre-merge | passed | `evidence/tsc-rbg-red.log`, `evidence/tsc-rbg-green.log` |
| secret-scan | pre-merge | passed | `evidence/secret-scan-rbg-red.log`, `evidence/secret-scan-rbg-green.log` |

## Verification

- `bun test test/smoke/spine-skeleton.smoke.ts` passes headless.
- `bun test` passes headless.
- `bun run typecheck` passes.
- `trace/smoke-spine.jsonl` contains the emitted structured `LogEvent`.
- `secret-scan.json` reports zero key-shaped hits across source, tests, fixtures, CI config, and this evidence bundle.

## Dependencies and blockers

This ticket has no dependencies and no transitive blocking probes. No blockers surfaced.

`review.json` and `verify.json` are intentionally not written by the implementer; the cross-family reviewer and independent verifier own those files.
