# walking-skeleton-smoke — RESULT

## What was built

Ticket `walking-skeleton-smoke` establishes the minimal project scaffold and the single cheapest
end-to-end slice (ENG-T-06) that becomes the repo smoke test.

### Files created / modified

| File | Role |
|---|---|
| `src/types.ts` | Shared data contract stub — `TranscriptObservation`, `CueDecision`, `LogEvent`, and all supporting types |
| `src/replay/harness.ts` | Record-replay reader — loads a JSONL fixture from disk and yields `TranscriptObservation` objects |
| `src/matcher.ts` | Trivial deterministic matcher — TextCue-equivalent wake-word match; authority is in deterministic code, never the LLM |
| `src/obs/trace.ts` | `TraceProcessor` stub — every event emits one structured `LogEvent` with verb-noun event name and `correlationId` |
| `fixtures/smoke/transcript.jsonl` | 2-line fixture: one ambient utterance, one "daybreak" wake-word utterance |
| `test/smoke/spine-skeleton.smoke.test.ts` | Headless smoke test — exercises transcript → decision → trace seams with in-process doubles only |

### Fix log (v2 — addressing cross-family reviewer rejections)

| Issue | Fix |
|---|---|
| `bun test test/smoke/spine-skeleton.smoke.ts` failed (no `.test` suffix) | Renamed to `spine-skeleton.smoke.test.ts` — Bun now discovers it as a filter without `./` prefix |
| Secret scan too narrow, no RBG | Broadened to `src/** test/** fixtures/**`; added red/green RBG runs in evidence/ |
| `bun test` full suite archived log was stale | Re-ran and archived fresh: 106 pass, 2 skip, 0 fail |

### What the smoke test covers

The 6-test suite in `spine-skeleton.smoke.test.ts` covers:
- Core gate: exactly one action decision from a 2-line fixture (the RBG anchor)
- LogEvent schema validation on every emitted line
- Fixture loads exactly 2 observations
- Pass decision carries no action field (correct negative)
- Action decision carries utterance text in payload
- No secret-shaped strings appear in any trace line

## Gate roll-up

| Gate | Status | RBG |
|---|---|---|
| `smoke-spine-skeleton` (`bun test test/smoke/spine-skeleton.smoke.test.ts`) | ✅ passed | ✅ red+green archived |
| `tsc-noEmit` | ✅ passed | ✅ red+green archived |
| `bun-test-full-suite` (108 tests) | ✅ passed | — (per-test gates carry RBG) |
| `secret-scan` (src/ test/ fixtures/ excl. intentional test data) | ✅ clean | ✅ red+green archived |

## Dependencies

This ticket has no dependencies (it is the root of the build graph).

## Blockers

None.
