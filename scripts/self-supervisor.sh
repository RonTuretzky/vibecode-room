#!/usr/bin/env bash
#
# Vibersyn SELF-HOSTING supervisor. run-room.sh --self runs this instead of a
# bare `bun src/server/index.ts`; starting it DIRECTLY with the full launch env
# also works — it cd's to the repo root, exports VIBERSYN_SELF_MODE=1 itself,
# and builds dist/ once when it is missing (run-room.sh builds before starting
# the supervisor, a direct start has no such step).
#
# Contract (docs/SELF-HOSTING.md — the self-hosting reload loop):
#   - Runs the Vibersyn server in the SAME env it was started with (HOST /
#     VIBERSYN_PORT / keys all pass through: the env lives in this process and
#     every relaunch inherits it).
#   - Server exit code 87 = "I committed a green self-change, rebuild me":
#       bun install && bun run build  →  relaunch the server (loop).
#     (`bun install` first: a self-commit may add a dependency; it is a fast
#     no-op otherwise.) A failed rebuild still relaunches (the previous dist/
#     keeps the wall alive) with a loud warning.
#   - Exit 0, SIGINT and SIGTERM end the loop with that code — an operator stop
#     is never resurrected. Stops are forwarded to the server child so a killed
#     supervisor never orphans a server holding the port.
#   - CRASH GUARD — the room must never die mid-demo: any OTHER exit relaunches
#     the server. A quick crash (uptime < VIBERSYN_SELF_CRASH_WINDOW_S) is
#     bounded: after VIBERSYN_SELF_CRASH_RETRIES relaunches, if commits landed
#     since the last boot known good, the supervisor `git revert`s them (the
#     bad commits STAY in history — nothing is lost), rebuilds, and relaunches
#     the restored source. Still crash-looping with nothing left to revert is
#     an environment problem: exit with the server's code.
#
# Test seams (used by src/self/supervisor.test.ts; leave unset in production):
#   VIBERSYN_SELF_SERVER_CMD       server command  (default: bun src/server/index.ts)
#   VIBERSYN_SELF_BUILD_CMD        rebuild command (default: bun install && bun run build)
#   VIBERSYN_SELF_ROOT             repo root       (default: this script's parent)
#   VIBERSYN_SELF_CRASH_WINDOW_S   below this uptime an exit is a boot crash (default 30)
#   VIBERSYN_SELF_CRASH_RETRIES    quick relaunches before restore/give-up (default 2)
#   VIBERSYN_SELF_CRASH_BACKOFF_S  base sleep between quick relaunches (default 1)
set -uo pipefail

ROOT="${VIBERSYN_SELF_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

SERVER_CMD="${VIBERSYN_SELF_SERVER_CMD:-bun src/server/index.ts}"
BUILD_CMD="${VIBERSYN_SELF_BUILD_CMD:-bun install && bun run build}"
CRASH_WINDOW_S="${VIBERSYN_SELF_CRASH_WINDOW_S:-30}"
CRASH_RETRIES="${VIBERSYN_SELF_CRASH_RETRIES:-2}"
CRASH_BACKOFF_S="${VIBERSYN_SELF_CRASH_BACKOFF_S:-1}"

export VIBERSYN_SELF_MODE=1

head_sha() { git rev-parse HEAD 2>/dev/null || true; }

rebuild() {
  if bash -c "$BUILD_CMD"; then
    echo "[self] rebuilt — relaunching the server."
  else
    echo "[self] WARNING: rebuild FAILED — relaunching on the previous build." >&2
  fi
}

# Cold start straight into the supervisor: without dist/ the walls would 404
# their bundles until the first self-reload. Production default commands only —
# an injected server command (test seam) skips this.
if [ -z "${VIBERSYN_SELF_SERVER_CMD:-}" ] && [ ! -f dist/index.html ]; then
  echo "[self] no dist/ build found — building once before the first launch…"
  bash -c "$BUILD_CMD" || echo "[self] WARNING: initial build failed — launching anyway." >&2
fi

# Forward operator stops (Ctrl-C / kill) to the server child, then exit the
# loop with the resulting code — a stop is never treated as a crash.
interrupted=0
child=""
on_stop() {
  interrupted=1
  [ -n "$child" ] && kill "$child" 2>/dev/null
}
trap on_stop INT TERM

code=0
retries=0
last_good_sha="$(head_sha)" # newest source known to boot healthy
while true; do
  boot_sha="$(head_sha)"
  started_at=$SECONDS
  bash -c "$SERVER_CMD" &
  child=$!
  wait "$child"
  code=$?
  if [ "$interrupted" -eq 1 ]; then
    wait "$child" 2>/dev/null
    echo "[self] stopped by signal — supervisor exiting."
    break
  fi
  child=""
  uptime=$((SECONDS - started_at))

  if [ "$code" -eq 87 ]; then
    # Green self-change committed: the build that just exited was healthy, so
    # ITS source is the restore point if the new commit turns out to crash.
    last_good_sha="$boot_sha"
    retries=0
    echo "[self] server exited 87 (green self-change committed) — rebuilding…"
    rebuild
    continue
  fi
  if [ "$code" -eq 0 ] || [ "$code" -eq 130 ] || [ "$code" -eq 143 ]; then
    break # clean shutdown / operator stop — the supervisor never resurrects those
  fi
  if [ "$uptime" -ge "$CRASH_WINDOW_S" ]; then
    # Ran healthy for a while, then died: not a bad boot. Relaunch; the source
    # that ran this long is the new known-good restore point.
    echo "[self] WARNING: server crashed (exit $code) after ${uptime}s — relaunching." >&2
    retries=0
    last_good_sha="$boot_sha"
    continue
  fi
  # Crash ON BOOT. Bounded retries first (transient: port not freed yet, …).
  if [ "$retries" -lt "$CRASH_RETRIES" ]; then
    retries=$((retries + 1))
    echo "[self] WARNING: server crashed on boot (exit $code) — retry $retries/$CRASH_RETRIES." >&2
    sleep $((CRASH_BACKOFF_S * retries))
    continue
  fi
  # Retries exhausted. Commits since the last good boot are the prime suspect:
  # revert them (git history keeps the bad commits for the post-mortem),
  # rebuild, relaunch — the room comes back on the last good source.
  if [ -n "$last_good_sha" ] && [ -n "$boot_sha" ] && [ "$boot_sha" != "$last_good_sha" ]; then
    echo "[self] WARNING: crash-loop on commits after ${last_good_sha} — reverting to the last good build (bad commits stay in git history)." >&2
    if git revert --no-edit "$last_good_sha..HEAD"; then
      echo "[self] reverted to the last good source — rebuilding."
    else
      git revert --abort 2>/dev/null
      echo "[self] WARNING: git revert failed — relaunching as-is." >&2
    fi
    last_good_sha="$(head_sha)" # restored tree = best known good; never revert twice
    retries=0
    rebuild
    continue
  fi
  echo "[self] ERROR: server keeps crashing on boot (exit $code) with nothing left to revert — giving up." >&2
  break
done

exit "$code"
