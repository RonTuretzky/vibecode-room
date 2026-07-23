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

code=0
while true; do
  bash -c "$SERVER_CMD"
  code=$?
  if [ "$code" -ne 87 ]; then
    break
  fi
  echo "[self] server exited 87 (green self-change committed) — rebuilding…"
  if bash -c "$BUILD_CMD"; then
    echo "[self] rebuilt — relaunching the server."
  else
    echo "[self] WARNING: rebuild FAILED — relaunching on the previous build." >&2
  fi
done

exit "$code"
