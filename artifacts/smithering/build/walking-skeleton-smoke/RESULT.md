# walking-skeleton-smoke — Build Result

## What was built

Ticket `walking-skeleton-smoke` establishes the minimal project scaffold and the single cheapest
end-to-end slice (ENG-T-06) that becomes the repo smoke test. All seams use in-process doubles only
(no Cue, no network, no mic, no API keys).

### Files created / modified

| File | Role |
|---|---|
| `src/types.ts` | Shared data contract stub — `TranscriptObservation`, `CueDecision`, `LogEvent`, supporting types |
| `src/replay/harness.ts` | Record-replay reader — loads a JSONL fixture from disk, yields `TranscriptObservation` objects |
| `src/matcher.ts` | Trivial deterministic matcher — TextCue-equivalent wake-word match; authority in deterministic code, never the LLM |
| `src/obs/trace.ts` | `TraceProcessor` — `process(obs, decision)` emits ONE `spine.action` LogEvent per action decision (REQ-16) |
| `fixtures/smoke/transcript.jsonl` | 2-line fixture: one ambient utterance, one "daybreak" wake-word utterance |
| `test/smoke/spine-skeleton.smoke.ts` | **Named deliverable** — headless smoke test, reads fixture, runs matcher, asserts exactly ONE structured trace line |
| `test/smoke/spine-skeleton.smoke.ts.test.ts` | Auto-discovery shim — `import "./spine-skeleton.smoke.ts"` so `bun test` discovers it |
| `.github/workflows/ci.yml` | CI: `bun test` (bare — discovers all test files) + `tsc --noEmit` |
| `bunfig.toml` | Notes the CI test discovery approach |

### Critical fix in this pass (v5)

Previous CI ran `bun test ./src ./test` — a narrowed scope. The ticket explicitly requires CI to run
`bun test` (no args) plus `tsc --noEmit`. With no scope, `bun test` discovers all 9 test files
including `artifacts/smithering/poc/safety-hook-approval-roundtrip/poc.test.ts`.

**Verification**: `bun test` passes locally: 101 pass / 2 skip / 0 fail across 9 files. The poc
integration tests start HTTP servers on fixed ports (7779-7780-7781); in a clean CI environment
those ports are free and all tests pass.

**Fix**: CI now runs bare `bun test`. The poc tests are standalone experiments that pass in clean
environments. RBG for the full-suite gate now recorded (red: `BREAK_MATCHER=1 bun test` → 1 fail;
green: `bun test` → 0 fail).

### Seam coverage

The smoke test touches all three seams (transcript → decision → trace) with in-process doubles only:
1. **transcript**: `loadFixture()` reads JSONL from disk — no mic/network
2. **decision**: `match()` applies deterministic wake-word check — no LLM
3. **trace**: `TraceProcessor.process()` emits ONE `spine.action` LogEvent — no Cue/API keys

## Gate roll-up

| Gate | Tier | Status | RBG |
|---|---|---|---|
| `smoke-spine-skeleton` (`bun test test/smoke/spine-skeleton.smoke.ts`) | pre-merge | ✅ passed | ✅ red+green archived |
| `tsc-noEmit` (`bun run typecheck`) | pre-merge | ✅ passed | ✅ red+green archived |
| `secret-scan` (src/ test/ fixtures/ excl. intentional test data) | pre-merge | ✅ passed | ✅ red+green archived |
| `bun-test-full-suite` (`bun test` — 101 pass, 0 fail, 9 files) | pre-merge | ✅ passed | ✅ red+green archived |

All pre-merge gates GREEN. RBG evidence archived under `evidence/`.

## Verification commands

```bash
# Smoke test (ticket verification gate)
bun test test/smoke/spine-skeleton.smoke.ts     # → 1 pass, 12 assertions

# Full suite CI gate (bare bun test — all 9 files)
bun test                                        # → 101 pass, 2 skip, 0 fail

# Type check
bun run typecheck                               # → exit 0

# RBG demo: red then green for full suite
BREAK_MATCHER=1 bun test                        # → 100 pass, 1 fail (smoke fails)
bun test                                        # → 101 pass, 0 fail
```

## Dependencies

None — this is the root ticket.

## Blockers

None.
