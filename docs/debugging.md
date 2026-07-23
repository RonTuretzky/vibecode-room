# Debugging tools

**Replay harness** — `bun scripts/replay-harness.ts [observations.jsonl] [--jsonl] [--quiet]`
CLI over `src/replay/harness.ts` (ENG-T-02). Replays a transcript-observation JSONL
(`fixtures/asr/*.jsonl` works; default `nova3-observations.jsonl`) through a fresh
`SuggestionEngine` + `HeuristicDecisionLLM` composition at temperature 0 (no network, no keys),
prints each decision plus the structured trace, then runs the stream twice and byte-compares
the canonical JSONL output — exiting non-zero if determinism breaks.

**Observability board** — `PORT=8790 bun scripts/obs-board.ts` (`VIBERSYN_ROOM_URL` defaults to `http://127.0.0.1:8788`)
CLI over `src/obs/board.ts` (REQ-16), otherwise only mounted by e2e tests. Serves the read-only
board standalone (`/`, `/health`, `/state`, `/events`), seeded from the live room's `GET /api/state`
and following its SSE `GET /api/events`. Refuses reserved ports 8788/7331 and keeps serving its
last snapshot if the room drops — the board is never on the critical path.
