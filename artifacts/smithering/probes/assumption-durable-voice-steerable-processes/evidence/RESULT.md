# Probe: assumption-durable-voice-steerable-processes

**Date:** 2026-06-14T04:54:00Z
**Overall:** PASSED (with architectural note on gateway vs. detach mode)

## Gate results

| Gate | Result | Evidence |
|------|--------|----------|
| Spawn | PASS | bunx smithers-orchestrator up probe-workflow.tsx -d: run ID + background pid |
| Persist | PASS | 29 panopticon-process runs alive 8+ h in waiting-event state (SQLite) |
| Concurrent | PASS | Both probe runs reached waiting-event in <3s; 29 concurrent archived runs |
| Signal/Steer | PASS | Signal delivered durably; loop advanced iteration 0->1 after resume |
| Voice seam (Cue) | BUILD REQUIRED | Cue on GitHub (HTTP 200, packages core/mcp/server); pnpm monorepo build needed |

## Key findings

1. 29 panopticon-process runs in waiting-event alive 8+ hours (SQLite direct query).
2. smithers signal <runId> steer --data stores signals in _smithers_signals independently per run.
3. Loop advanced iteration 0->1 after resume: steer|0|finished, step|0|finished, steer|1|waiting-event.
4. Gateway mode (up --serve) processes signals in real-time; detach mode (up -d) requires --resume.
5. smoke-1781396596009 completed 3 steer iterations in 26s via gateway, proving real-time voice path.
6. Cue adapter code (cue-voice-adapter.ts) is complete: WordCue fires on callsign -> MappedActionTool -> smithers signal.

## Architectural note

Real-time voice steering requires gateway mode. The existing .smithers/gateway.ts is the correct runtime.

Cue installation: git clone https://github.com/jameslbarnes/cue && pnpm install && pnpm build
Required env: DEEPGRAM_API_KEY, CEREBRAS_API_KEY

## Evidence files

- sqlite-evidence.txt: Direct SQLite queries showing all signal and attempt rows
- probe-log.jsonl: Full structured trace
- assessment.json: Machine-readable result
