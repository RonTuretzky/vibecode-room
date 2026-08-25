#!/usr/bin/env bash
#
# Vibersyn SELF-HOSTING supervisor (run-room.sh --self runs this instead of a
# bare `bun src/server/index.ts`).
#
# Contract (docs: the self-hosting reload loop):
#   - Runs the Vibersyn server with VIBERSYN_SELF_MODE=1 in the SAME env it was
#     started with (HOST / VIBERSYN_PORT / keys all pass through).
#   - Server exit code 87 = "I committed a green self-change, rebuild me":
#       bun run build  →  relaunch the server (loop).
#     A failed rebuild still relaunches (the previous dist/ keeps the wall
#     alive) with a loud warning — the committed source was green-gated, so a
#     red rebuild here means an environment problem, not a red commit.
#   - ANY other exit code ends the loop normally with that code (Ctrl-C, crash,
#     clean shutdown — the supervisor never resurrects those).
#
# Test seams (used by src/self/supervisor.test.ts; leave unset in production):
#   VIBERSYN_SELF_SERVER_CMD  command run as the server (default: bun src/server/index.ts)
#   VIBERSYN_SELF_BUILD_CMD   command run to rebuild    (default: bun run build)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SERVER_CMD="${VIBERSYN_SELF_SERVER_CMD:-bun src/server/index.ts}"
BUILD_CMD="${VIBERSYN_SELF_BUILD_CMD:-bun run build}"

export VIBERSYN_SELF_MODE=1
# NOTE: the transcript archive is no longer exported here. It is ON BY DEFAULT
# at the boot entry (src/server/index.ts -> builds/transcripts/YYYY-MM-DD.jsonl),
# so every launch keeps a permanent record, not just a supervised one. Set
# VIBERSYN_TRANSCRIPT_ARCHIVE to relocate it, or to "off" to keep no record.

# Deliberate-stop marker: `touch /tmp/vibersyn-stop` (or Ctrl-C, which kills
# THIS script) ends the loop. A bare SIGTERM to the SERVER alone does not —
# twice now a stray broad pkill from tooling took the projection down and the
# room stayed dark until a human noticed. The walls deserve better.
STOP_MARKER="/tmp/vibersyn-stop"
rm -f "$STOP_MARKER"

code=0
while true; do
  bash -c "$SERVER_CMD"
  code=$?
  if [ "$code" -eq 87 ]; then
    echo "[self] server exited 87 (green self-change committed) — rebuilding…"
    if bash -c "$BUILD_CMD"; then
      echo "[self] rebuilt — relaunching the server."
    else
      echo "[self] WARNING: rebuild FAILED — relaunching on the previous build." >&2
    fi
    continue
  fi
  if [ -f "$STOP_MARKER" ]; then
    echo "[self] stop marker present — shutting down (code $code)."
    break
  fi
  if [ "$code" -eq 143 ] || [ "$code" -eq 137 ]; then
    echo "[self] WARNING: server was killed (exit $code) with no stop marker — resurrecting in 2s. (touch /tmp/vibersyn-stop to stop for real)" >&2
    sleep 2
    continue
  fi
  break
done

exit "$code"
