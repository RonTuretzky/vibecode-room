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
| `test/smoke/spine-skeleton.smoke.ts.test.ts` | Auto-discovery shim — `import "./spine-skeleton.smoke.ts"` so `bun test ./src ./test` discovers it |
| `.github/workflows/ci.yml` | CI: `bun test ./src ./test` + `tsc --noEmit` |
| `bunfig.toml` | Notes directory-scoped test discovery approach |

### Critical fix in this pass (v4)

Previous attempts used bare `bun test` in CI. That command also discovers
`artifacts/smithering/poc/safety-hook-approval-roundtrip/poc.test.ts` which starts
HTTP servers on fixed ports (7779, 7780, 7781). Those ports are unavailable in some
review environments — making the gate non-reproducible.

**Fix**: CI now runs `bun test ./src ./test` — scoped to production source dirs.
This command is deterministic and port-free. The POC experiments remain runnable
via `bun test artifacts/smithering/poc/safety-hook-approval-roundtrip/poc.test.ts`.

The smoke test verification command `bun test test/smoke/spine-skeleton.smoke.ts`
works via substring filter matching on the shim filename.

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
| `bun-test-full-suite` (`bun test ./src ./test` — 42 pass, 0 fail) | pre-merge | ✅ passed | n/a (per-gate RBG covers this) |

All pre-merge gates GREEN. RBG evidence archived under `evidence/`.

## Verification commands

```bash
# Smoke test (ticket verification gate)
bun test test/smoke/spine-skeleton.smoke.ts     # → 1 pass, 12 assertions

# Full suite CI gate — reproducible, port-free
bun test ./src ./test                           # → 42 pass, 0 fail, 8 files

# Type check
bun run typecheck                               # → exit 0

# RBG demo: red then green
BREAK_MATCHER=1 bun test test/smoke/spine-skeleton.smoke.ts  # → 0 pass, 1 fail
bun test test/smoke/spine-skeleton.smoke.ts                  # → 1 pass
```

## Dependencies

None — this is the root ticket.

## Blockers

None.
