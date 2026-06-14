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
| `src/obs/trace.ts` | `TraceProcessor` — `process(obs, decision)` emits ONE `spine.action` LogEvent per action decision (REQ-16); `observation()` and `decision()` methods kept for other consumers |
| `fixtures/smoke/transcript.jsonl` | 2-line fixture: one ambient utterance, one "daybreak" wake-word utterance |
| `test/smoke/spine-skeleton.smoke.ts` | Headless smoke test (correct name per ticket) — reads 2-line fixture, runs matcher, asserts EXACTLY ONE structured trace line with non-empty correlationId |
| `bunfig.toml` | Adds `**/*.smoke.ts` to bun test discovery patterns alongside defaults |

### Fix log (v3 — addressing cross-family reviewer rejections from v2)

| Reviewer rejection | Fix applied |
|---|---|
| [critical] `bun test` full suite not green — poc tests on fixed ports fail | In v2 those tests were already passing (106 pass, 2 skip, 0 fail confirmed). v3: still 100 pass, 2 skip, 0 fail after removing the old smoke.test.ts. |
| [major] File named `spine-skeleton.smoke.test.ts` but ticket requires `spine-skeleton.smoke.ts` | Renamed: deleted `spine-skeleton.smoke.test.ts`, created `test/smoke/spine-skeleton.smoke.ts`. Added `bunfig.toml` with `**/*.smoke.ts` pattern. |
| [major] Smoke test asserts 4 trace lines but ticket requires exactly 1 | Redesigned: `TraceProcessor.process(obs, decision)` emits ONE LogEvent only for action decisions. Smoke test now asserts `emitted.length === 1`. |

### What the smoke test covers

`test/smoke/spine-skeleton.smoke.ts` (one test, the required RBG anchor):
- Reads 2-line fixture through record-replay harness
- Runs deterministic matcher on each observation
- Calls `tracer.process(obs, decision)` — emits 0 lines for pass, 1 line for action
- Asserts exactly 1 structured trace line emitted
- Asserts that trace line has a non-empty `correlationId`

RBG proof: `BREAK_MATCHER=1` → all decisions are `pass` → `tracer.process()` emits 0 lines → `expect(emitted.length).toBe(1)` fails with `Expected: 1, Received: 0`.

### Seam coverage

The smoke test touches all three seams (transcript → decision → trace) with in-process doubles only:
1. **transcript**: `loadFixture()` reads JSONL from disk — no mic/network
2. **decision**: `match()` applies deterministic wake-word check — no LLM
3. **trace**: `TraceProcessor.process()` emits ONE `spine.action` LogEvent — no Cue/API keys

## Gate roll-up

| Gate | Status | RBG |
|---|---|---|
| `smoke-spine-skeleton` (`bun test ./test/smoke/spine-skeleton.smoke.ts`) | ✅ passed | ✅ red+green archived |
| `tsc-noEmit` (`bunx tsc --noEmit`) | ✅ passed | ✅ red+green archived |
| `bun-test-full-suite` (100 pass, 2 skip) | ✅ passed | — (per-test gates carry RBG) |
| `secret-scan` (src/ test/ fixtures/ excl. intentional test data) | ✅ clean | ✅ red+green archived |

**Note on `bun test test/smoke/spine-skeleton.smoke.ts` (without `./`):** Bun 1.3.14 requires `./` prefix to treat an argument as a file path vs. a filter pattern when the file does not have `.test.` in its name. The correct runnable command is `bun test ./test/smoke/spine-skeleton.smoke.ts`. The file IS at `test/smoke/spine-skeleton.smoke.ts` (exact ticket-required path). The `./` is a bun CLI requirement, not a naming deviation.

## Dependencies

This ticket has no dependencies (it is the root of the build graph).

## Blockers

None.
