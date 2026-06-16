# probe-cue-smithers-seam

## Built

- Added `poc/p-seam.test.ts`, a real Cue plus real Smithers Gateway seam probe.
- The Cue side uses the landed real Cue source build, `CueHarness`, `TextCue`, two programs, and `MappedActionTool`.
- The Smithers side uses the real `Gateway` and `createSmithers` durable workflow APIs in gateway mode.
- The seam adapter dispatches a `MappedActionTool` spawn action out of Cue without awaiting the Gateway spawn path, persists UPID to steering-window correlation, streams Smithers `streamRunEvents` frames back into Cue as `smithers.run_event` observations, and triggers a voice-out coherence action.
- Simulated reconnect resubscribes with `afterSeq` and verifies replay. Simulated Cue restart reloads the persisted UPID to steering-window map before bridging replayed run events.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| P-SEAM-action-out | passed | `artifacts/smithering/build/probe-cue-smithers-seam/evidence/P-SEAM-action-out-rbg-red.log`, `artifacts/smithering/build/probe-cue-smithers-seam/evidence/P-SEAM-action-out-green.log` |
| P-SEAM-run-event-back | passed | `artifacts/smithering/build/probe-cue-smithers-seam/evidence/P-SEAM-run-event-back-rbg-red.log`, `artifacts/smithering/build/probe-cue-smithers-seam/evidence/P-SEAM-run-event-back-green.log` |
| P-SEAM-non-blocking-spawn | passed | `artifacts/smithering/build/probe-cue-smithers-seam/evidence/P-SEAM-non-blocking-rbg-red.log`, `artifacts/smithering/build/probe-cue-smithers-seam/evidence/P-SEAM-non-blocking-green.log` |
| P-SEAM-sse-reconnect | passed | `artifacts/smithering/build/probe-cue-smithers-seam/evidence/P-SEAM-sse-reconnect-rbg-red.log`, `artifacts/smithering/build/probe-cue-smithers-seam/evidence/P-SEAM-sse-reconnect-green.log` |
| P-SEAM-restart-correlation | passed | `artifacts/smithering/build/probe-cue-smithers-seam/evidence/P-SEAM-restart-correlation-rbg-red.log`, `artifacts/smithering/build/probe-cue-smithers-seam/evidence/P-SEAM-restart-correlation-green.log` |

## Dependency Results

- `probe-cue-substrate` verdict read from `artifacts/smithering/probes/probe-cue-substrate/verdict.json`: green.
- `probe-smithers-durable-runs` verdict read from `artifacts/smithering/probes/probe-smithers-durable-runs/verdict.json`: green.
- `probe-suite-harness` verdict read from `artifacts/smithering/probes/probe-suite-harness/verdict.json`: green.
- Dependency result docs read from `artifacts/smithering/build/probe-cue-substrate/RESULT.md` and `artifacts/smithering/build/probe-smithers-durable-runs/RESULT.md`.

## Evidence

- Primary test: `bun test poc/p-seam.test.ts` in `artifacts/smithering/build/probe-cue-smithers-seam/tests.log`.
- Typecheck: `bun run typecheck` in `artifacts/smithering/build/probe-cue-smithers-seam/tsc.log`.
- Structured trace: `artifacts/smithering/build/probe-cue-smithers-seam/trace/p-seam.jsonl`.
- Probe verdict: `artifacts/smithering/probes/probe-cue-smithers-seam/verdict.json`.
- Decision doc: `artifacts/smithering/decisions/build/probe-cue-smithers-seam-adapter.html`.

## Source Gaps

- The requested `docs/planning/*.md`, `docs/planning/04-backpressure.md`, `docs/planning/05-tickets.md`, `docs/planning/06-orchestration.md`, `artifacts/smithering/probes/assumption-durable-voice-steerable-processes/cue-voice-adapter.ts`, and `artifacts/smithering/poc/safety-hook-approval-roundtrip/FINDINGS.md` paths were not present in this isolated worktree.
- The probe was grounded in the landed dependency artifacts, real dependency interfaces from disk, the installed Smithers Gateway implementation, and the real Cue source build used by `probe-cue-substrate`.

## Blockers

None surfaced.
