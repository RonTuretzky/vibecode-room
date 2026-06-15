# observability-trace-and-board

## Built

- Added cross-component causal-chain reconstruction that joins Cue `observations.jsonl`, `decisions.jsonl`, `actions.jsonl`, and Smithers-side traces by `correlationId` and `upid`.
- Added the read-only Hono board surface in `src/obs/board.ts`, rendered with React 19 and streamed over SSE. The board exposes only `GET /`, `GET /health`, `GET /state`, and `GET /events`; it has no operational or mutating endpoint.
- Added `src/obs/otel.ts` to emit GenAI semantic-convention OTLP trace payloads for Smithers agent calls to a Langfuse-compatible OTLP endpoint. The exporter is optional and off the voice critical path.
- Added `test/e2e/board.e2e.ts` proving the board-down voice-flow path still passes and that a board-up run can be reconstructed from persisted traces only.
- Added `poc/p-otel.test.ts` as the informational OTLP export probe.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| AC16.1 | passed | `artifacts/smithering/build/observability-trace-and-board/evidence/AC16.1-rbg-red.log`, `artifacts/smithering/build/observability-trace-and-board/evidence/AC16.1-green.log` |
| AC16.2 | passed | `artifacts/smithering/build/observability-trace-and-board/evidence/AC16.2-rbg-red.log`, `artifacts/smithering/build/observability-trace-and-board/evidence/AC16.2-green.log` |
| AC16.2-read-only | passed | `artifacts/smithering/build/observability-trace-and-board/evidence/BOARD-READONLY-rbg-red.log`, `artifacts/smithering/build/observability-trace-and-board/evidence/BOARD-READONLY-green.log` |
| AC16.3 | passed | `artifacts/smithering/build/observability-trace-and-board/evidence/AC16.3-rbg-red.log`, `artifacts/smithering/build/observability-trace-and-board/evidence/AC16.3-green.log` |
| P-OTEL | passed | `artifacts/smithering/build/observability-trace-and-board/evidence/P-OTEL-rbg-red.log`, `artifacts/smithering/build/observability-trace-and-board/evidence/P-OTEL-green.log` |

## Dependency Results Read

- `trace-processor-observability`: `artifacts/smithering/build/trace-processor-observability/RESULT.md`
- `cue-smithers-seam-dispatcher`: `artifacts/smithering/build/cue-smithers-seam-dispatcher/RESULT.md`
- `probe-cue-smithers-seam`: `artifacts/smithering/probes/probe-cue-smithers-seam/verdict.json`
- `probe-cue-substrate`: `artifacts/smithering/probes/probe-cue-substrate/verdict.json`
- `probe-smithers-durable-runs`: `artifacts/smithering/probes/probe-smithers-durable-runs/verdict.json`
- `probe-suite-harness`: `artifacts/smithering/probes/probe-suite-harness/verdict.json`

## Commands

- `bun test src/obs/trace.test.ts`
- `bun test test/e2e/board.e2e.ts`
- `bun test poc/p-otel.test.ts`
- `bun test`
- `bunx tsc --noEmit`

## Blockers

None surfaced.
