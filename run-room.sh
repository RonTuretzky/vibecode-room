#!/usr/bin/env bash
#
# Vibecode Room — one command to run the whole thing.
#
# Default = DESK MODE (no cameras, no Python): builds the UI, serves Vibersyn on
# all interfaces (HOST=0.0.0.0 so your phone can reach the QR-import page), and
# opens two fullscreen windows — wall A is the idea wall (?view=ideas), wall B
# the build wall (?view=builds). You drive it with mouse + keyboard (press "?"
# for the cheat sheet) + voice (say "Vibersyn").
#
# Camera (gesture) mode (--gesture) additionally starts the gesture fusion source —
# the real Python camera server, or a camera-free preview emitter with --fake —
# and binds each wall's gesture layer to it (&gesture=1&fusion=ws://…:8770).
# NOTE: on macOS an Orbbec (Gemini 335) camera can only be opened with elevated
# permissions, so the camera process runs under 'sudo -E' (password prompt).
#
# --calibrate skips Vibersyn entirely and runs the projector auto-calibration
# for this room instead (gesturewall.autocal): open autocal.html?wall=A and
# ?wall=B fullscreen on the projectors, step out of the camera's view, then
# POST /calib/start. Results are written back into the room config.
#
# Usage:
#   ./run-room.sh                 # desk mode: two walls, mouse/keyboard/voice
#   ./run-room.sh --single        # desk mode, one full-view window
#   ./run-room.sh --gesture       # legacy: real cameras (needs gesture-wall deps + room.json)
#   ./run-room.sh --fake          # legacy: gesture mode with synthetic cursors
#   ./run-room.sh --gesture --config=my.json
#   ./run-room.sh --calibrate     # projector auto-calibration (no Vibersyn)
#
# Env: VIBERSYN_PORT(8788) HOST(0.0.0.0) WS_PORT(8770) BROWSER("Google Chrome")
#      WALL_A_POS(0,0) WALL_B_POS(1920,0) ROOM_CONFIG(gesture-wall/room.json)
#      PYTHON(gesture-wall/.venv/bin/python if present, else python3)
#      WALL_A_M(2.3) WALL_B_M(2.5) AUTOCAL_PORT(8801)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

GESTURE=0
FAKE=0
SINGLE=0
CALIBRATE=0
CONFIG="${ROOM_CONFIG:-gesture-wall/room.json}"
VIBERSYN_PORT="${VIBERSYN_PORT:-8788}"
HOST="${HOST:-0.0.0.0}"               # bind all interfaces so phones reach /submit (QR import)
WS_PORT="${WS_PORT:-8770}"
BROWSER="${BROWSER:-Google Chrome}"
WALL_A_POS="${WALL_A_POS:-0,0}"
WALL_B_POS="${WALL_B_POS:-1920,0}"
WALL_A_M="${WALL_A_M:-2.3}"           # wall widths in metres (auto-calibration)
WALL_B_M="${WALL_B_M:-2.5}"
AUTOCAL_PORT="${AUTOCAL_PORT:-8801}"
GW_HTTP_PORT="${GW_HTTP_PORT:-8781}"   # gesture-wall's own static http (unused here; kept off :8000)

# Python: an explicit $PYTHON always wins; otherwise prefer the project venv.
if [ -z "${PYTHON:-}" ]; then
  if [ -x "$ROOT/gesture-wall/.venv/bin/python" ]; then
    PYTHON="$ROOT/gesture-wall/.venv/bin/python"
  else
    PYTHON="python3"
  fi
fi

for arg in "$@"; do
  case "$arg" in
    --gesture) GESTURE=1 ;;
    --fake) GESTURE=1; FAKE=1 ;;   # --fake implies gesture mode, minus the cameras
    --single) SINGLE=1 ;;
    --calibrate) CALIBRATE=1 ;;
    --config=*) CONFIG="${arg#*=}" ;;
    -h|--help)
      sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "[room] unknown arg: $arg" >&2; exit 2 ;;
  esac
done

PIDS=()
SUDO=""        # set to "sudo -E" when the camera needs root (macOS + Orbbec)
SUDO_PID=""    # pid of the root camera process, if any — needs `sudo kill`
cleanup() {
  echo
  echo "[room] shutting down…"
  for p in "${PIDS[@]:-}"; do
    [ -n "$p" ] || continue
    if [ "$p" = "${SUDO_PID:-}" ]; then
      # This child runs as root — a plain kill from the operator can't touch it.
      sudo -n kill "$p" 2>/dev/null \
        || echo "[room] couldn't stop the root camera process (pid $p) — run: sudo kill $p" >&2
    else
      kill "$p" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

# ── camera-mode helpers (shared by --gesture and --calibrate) ────────────────
config_uses_orbbec() { # cheap grep, no python needed
  grep -q '"kind": *"gemini' "$1" 2>/dev/null || grep -q '"orbbec"' "$1" 2>/dev/null
}

check_camera_deps() {
  if ! "$PYTHON" -c "import cv2" >/dev/null 2>&1; then
    echo "[room] ERROR: OpenCV not importable by $PYTHON. Install the camera deps:" >&2
    echo "         $PYTHON -m pip install -r gesture-wall/requirements.txt" >&2
    echo "       …or run camera-free with:  ./run-room.sh --fake" >&2
    exit 1
  fi
  if config_uses_orbbec "$CONFIG" && ! "$PYTHON" -c "import pyorbbecsdk" >/dev/null 2>&1; then
    echo "[room] ERROR: $CONFIG declares an Orbbec camera but pyorbbecsdk is not importable by $PYTHON." >&2
    echo "         $PYTHON -m pip install -r gesture-wall/requirements.txt" >&2
    exit 1
  fi
}

setup_sudo() { # macOS can't open an Orbbec camera unprivileged (uvc_open error -3)
  if [ "$(uname -s)" = "Darwin" ] && [ "$(id -u)" != "0" ] && config_uses_orbbec "$CONFIG"; then
    SUDO="sudo -E"
    echo "[room] $CONFIG uses an Orbbec camera: macOS only opens it as root, so the"
    echo "[room] camera process runs under 'sudo -E' — expect a password prompt now."
    sudo -v   # cache credentials up front so a backgrounded sudo never hangs on the tty
  fi
}

# ── 0) --calibrate: projector auto-calibration instead of Vibersyn ───────────
if [ "$CALIBRATE" = "1" ]; then
  if [ ! -f "$CONFIG" ]; then
    echo "[room] ERROR: room config '$CONFIG' not found — calibration needs the walls/cameras declared." >&2
    exit 1
  fi
  check_camera_deps
  setup_sudo
  CONFIG_ABS="$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")"
  echo "[room] auto-calibration: wall widths A=${WALL_A_M}m B=${WALL_B_M}m (override with WALL_A_M/WALL_B_M)"
  echo "[room] 1. Open FULLSCREEN on wall A's projector: http://localhost:$AUTOCAL_PORT/autocal.html?wall=A"
  echo "[room] 2. Open FULLSCREEN on wall B's projector: http://localhost:$AUTOCAL_PORT/autocal.html?wall=B"
  echo "[room] 3. Step out of the camera's view, then start the sweep:"
  echo "[room]      curl -X POST http://localhost:$AUTOCAL_PORT/calib/start"
  echo "[room] Results are written back into $CONFIG. Ctrl-C when done."
  # Foreground: the script waits on autocal; Ctrl-C reaches it even under sudo.
  ( cd gesture-wall && exec $SUDO "$PYTHON" -m gesturewall.autocal --config "$CONFIG_ABS" \
      --width "A=$WALL_A_M" --width "B=$WALL_B_M" --port "$AUTOCAL_PORT" )
  exit $?
fi

# ── 1) gesture fusion source (legacy; cursors over ws://…:WS_PORT) ───────────
if [ "$GESTURE" = "1" ]; then
  if [ "$FAKE" = "1" ]; then
    echo "[room] fusion: camera-free preview (fake) on ws://localhost:$WS_PORT"
    FAKE_WS_PORT="$WS_PORT" bun gesture-wall/tools/fake-fusion.mjs &
    PIDS+=($!)
  else
    if [ ! -f "$CONFIG" ]; then
      if [ -f gesture-wall/room.example.json ]; then
        echo "[room] no $CONFIG — created it from gesture-wall/room.example.json."
        cp gesture-wall/room.example.json "$CONFIG"
        echo "[room] EDIT $CONFIG for your cameras/walls (calibration), then re-run. (Or: ./run-room.sh --fake)" >&2
        exit 0
      else
        echo "[room] ERROR: room config '$CONFIG' not found." >&2; exit 1
      fi
    fi
    check_camera_deps
    setup_sudo
    # Absolute config path so it resolves after we cd into gesture-wall (where the
    # pose model + web/ are relative). `exec` replaces the subshell with python so
    # $! is python's own pid — the cleanup trap kills it on every shell (a plain
    # cd-subshell orphans python under bash 3.2, leaking the WS port + cameras).
    CONFIG_ABS="$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")"
    echo "[room] fusion: camera server (${SUDO:+$SUDO }$PYTHON -m gesturewall.server --config $CONFIG_ABS)"
    ( cd gesture-wall && exec $SUDO "$PYTHON" -m gesturewall.server --config "$CONFIG_ABS" --ws-port "$WS_PORT" --http-port "$GW_HTTP_PORT" ) &
    PIDS+=($!)
    if [ -n "$SUDO" ]; then SUDO_PID=$!; fi
  fi
fi

# ── 2) build + serve Vibersyn ────────────────────────────────────────────────
echo "[room] building Vibersyn UI…"
bun run build >/dev/null 2>&1 || { echo "[room] ERROR: UI build failed (run 'bun run build' to see why)." >&2; exit 1; }
echo "[room] Vibersyn server on http://localhost:$VIBERSYN_PORT (bound to $HOST)"
HOST="$HOST" VIBERSYN_PORT="$VIBERSYN_PORT" bun src/server/index.ts &
PIDS+=($!)

# ── 3) wait for Vibersyn to be healthy ───────────────────────────────────────
printf "[room] waiting for Vibersyn"
HEALTHY=0
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$VIBERSYN_PORT/api/health" >/dev/null 2>&1; then HEALTHY=1; echo " — ready."; break; fi
  printf "."; sleep 0.5
done

# ── 4) open the wall windows ─────────────────────────────────────────────────
GESTURE_QS=""
if [ "$GESTURE" = "1" ]; then
  GESTURE_QS="&gesture=1&fusion=ws://localhost:$WS_PORT"
fi
URL_A="http://localhost:$VIBERSYN_PORT/?live=1&wall=A&view=ideas$GESTURE_QS"
URL_B="http://localhost:$VIBERSYN_PORT/?live=1&wall=B&view=builds$GESTURE_QS"
URL_SINGLE="http://localhost:$VIBERSYN_PORT/?live=1&view=full$GESTURE_QS"

open_wall() { # $1=window-position  $2=url
  if command -v open >/dev/null 2>&1; then
    open -na "$BROWSER" --args --new-window --start-fullscreen --window-position="$1" "$2" 2>/dev/null \
      || open "$2" 2>/dev/null \
      || echo "[room] open manually on its projector (fullscreen): $2"
  else
    echo "[room] open manually on its projector (fullscreen): $2"
  fi
}

if [ "$SINGLE" = "1" ]; then
  echo "[room] Window  → $URL_SINGLE"
else
  echo "[room] Wall A  → $URL_A"
  echo "[room] Wall B  → $URL_B"
fi
if [ "$HEALTHY" != "1" ]; then
  echo "[room] WARNING: Vibersyn never became healthy — not opening windows. Check the server log above." >&2
  echo "[room] (services are still running; open the URLs above manually once it's up.)" >&2
elif [ "$SINGLE" = "1" ]; then
  open_wall "$WALL_A_POS" "$URL_SINGLE"
else
  open_wall "$WALL_A_POS" "$URL_A"; sleep 1
  open_wall "$WALL_B_POS" "$URL_B"
fi

if [ "$GESTURE" = "1" ]; then
  echo "[room] running (gesture mode). Point at a wall and hold ~0.8s over a bubble/button to click it."
  echo "[room] LIGHTING: keep some ambient light on the players — the depth camera doesn't need it, but pose tracking reads the color image."
  echo "[room] (tip: the mouse works too — hold still over a target.)  Ctrl-C to stop."
else
  echo "[room] running. Say \"Vibersyn\" to start Idea Capture; \"Vibersyn, build it\" builds; press ? for the keyboard cheat sheet."
  echo "[room] (tip: the QR Import button adds a GitHub repo to the wall from your phone.)  Ctrl-C to stop."
fi
wait
