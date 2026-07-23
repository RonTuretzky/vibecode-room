#!/usr/bin/env bash
#
# Vibecode Room — one command to run the whole thing.
#
# Default = DESK MODE (no cameras, no Python): builds the UI, serves Vibersyn on
# all interfaces (HOST=0.0.0.0 so your phone can reach the QR-import page), and
# opens two fullscreen windows — wall A AND wall B each render the COMPLETE 3D
# room (all ideas + all builds). The ?view=/?wall= URL params are legacy labels
# that no longer split content: ?wall= only badges the window and seeds a
# different default camera angle, and every window owns its camera (drag/zoom/
# fit/zen are per-window; live state is shared over the same SSE stream). You
# drive it with mouse + keyboard (press "?" for the cheat sheet) + voice (say
# "Vibersyn").
#
# Camera (gesture) mode (--gesture) additionally starts the gesture fusion source —
# the real Python camera server, or a camera-free preview emitter with --fake —
# and binds each wall's gesture layer to it (&gesture=1&fusion=ws://…:8770).
# NOTE: on macOS an Orbbec (Gemini 335) camera can only be opened with elevated
# permissions, so Orbbec configs run the camera under 'sudo -E' (password
# prompt). Kinect v2 configs need no elevation — no prompt appears.
#
# --calibrate skips Vibersyn entirely and runs the projector auto-calibration
# for this room instead (gesturewall.autocal): open autocal.html?wall=<id>
# fullscreen on each configured wall's projector, step out of the camera's
# view, then POST /calib/start. Results are written back into the room config.
#
# Usage:
#   ./run-room.sh                 # desk mode: two walls, EACH the full room
#   ./run-room.sh --single        # desk mode, ONE window — a laptop or
#                                 # single projector, no cameras, no Python
#   ./run-room.sh --single=ideas  # same window with a legacy view badge (=builds,
#                                 # =full); the view no longer filters content
#   ./run-room.sh --gesture       # legacy: real cameras (needs gesture-wall deps + room.json)
#   ./run-room.sh --fake          # legacy: gesture mode with synthetic cursors
#   ./run-room.sh --arcade        # joystick drives the dwell cursors (gesture-mode
#                                 # XL UI, no cameras); combine: --single --arcade --real-hands
#   ./run-room.sh --fake-hands    # pinch camera with synthetic hands (no TD, no cameras)
#   ./run-room.sh --real-hands    # pinch camera from the REAL laptop camera via the
#                                 # standalone MediaPipe bridge — the NO-TOUCHDESIGNER
#                                 # path (needs macOS Camera permission on the Terminal/IDE)
#   ./run-room.sh --hands=ws://td-mac:9980   # pinch camera fed by a TouchDesigner rig
#   ./run-room.sh --gesture --config=my.json
#   ./run-room.sh --single --gesture --config=gesture-wall/room.kinect.json
#                                 # ONE wall + ONE Kinect v2 (docs/KINECT-SINGLE-WALL.md)
#   ./run-room.sh --calibrate     # projector auto-calibration (no Vibersyn)
#   ./run-room.sh --self          # SELF-HOSTING: pins the "Vibersyn Room" mirror
#                                 # project (VIBERSYN_SELF_MODE=1) and wraps the
#                                 # server in scripts/self-supervisor.sh — exit 87
#                                 # (green self-commit) → bun run build → relaunch
#
# Env: VIBERSYN_PORT(8788) HOST(0.0.0.0) WS_PORT(8770) BROWSER("Google Chrome")
#      WALL_A_POS(0,0) WALL_B_POS(1920,0) ROOM_CONFIG(gesture-wall/room.json)
#      PYTHON(gesture-wall/.venv/bin/python if present, else python3)
#      WALL_A_M / WALL_B_M (unset = tape-measured widths stored in the room
#      config as walls.<id>.width_m; set to override) AUTOCAL_PORT(8801)
#      HANDS_PORT(9980) HANDS_URL(unset = ws://localhost:$HANDS_PORT)
#      HANDS_WALLS(A — set A,B to drive BOTH wall cameras from one hands stream)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

GESTURE=0
FAKE=0
SELF_MODE=0
HANDS=0                               # TouchDesigner hand-pinch camera (--hands / --hands=URL / --fake-hands / --real-hands)
FAKE_HANDS=0
REAL_HANDS=0                          # --real-hands: launch the standalone MediaPipe bridge (real laptop camera, no TD)
SINGLE=0
SINGLE_VIEW="${SINGLE_VIEW:-full}"   # full | ideas | builds (--single=<view>; legacy badge, never filters)
CALIBRATE=0
CONFIG="${ROOM_CONFIG:-gesture-wall/room.json}"
VIBERSYN_PORT="${VIBERSYN_PORT:-8788}"
HOST="${HOST:-0.0.0.0}"               # bind all interfaces so phones reach /submit (QR import)
WS_PORT="${WS_PORT:-8770}"
HANDS_PORT="${HANDS_PORT:-9980}"      # hands WS (TD or fake-hands); the default --hands URL uses it
HANDS_URL="${HANDS_URL:-}"            # explicit hands source; empty = ws://localhost:$HANDS_PORT
HANDS_WALLS="${HANDS_WALLS:-A}"       # walls that get &hands= — one stream driving BOTH cameras is opt-in (A,B)
BROWSER="${BROWSER:-Google Chrome}"
WALL_A_POS="${WALL_A_POS:-0,0}"
WALL_B_POS="${WALL_B_POS:-1920,0}"
WALL_A_M="${WALL_A_M:-}"              # wall widths in metres (auto-calibration).
WALL_B_M="${WALL_B_M:-}"              # Empty = pin to walls.<id>.width_m from the
                                      # room config (autocal stores the measured
                                      # widths there); set only to override.
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
    --arcade) GESTURE=1; ARCADE=1 ;;   # joystick as THE fusion cursor source (gesture-mode XL UI, no cameras)
    --hands) HANDS=1 ;;
    --hands=*) HANDS=1; HANDS_URL="${arg#*=}" ;;   # explicit TD source, e.g. ws://td-mac:9980
    --fake-hands) HANDS=1; FAKE_HANDS=1 ;;   # pinch camera minus TouchDesigner (synthetic hands)
    --real-hands) HANDS=1; REAL_HANDS=1 ;;   # pinch camera from the REAL laptop camera via the standalone MediaPipe bridge (no TD)
    --single) SINGLE=1 ;;
    --single=*) SINGLE=1; SINGLE_VIEW="${arg#*=}" ;;
    --self) SELF_MODE=1 ;;   # self-hosting: VIBERSYN_SELF_MODE=1 + supervisor loop
    --calibrate) CALIBRATE=1 ;;
    --config=*) CONFIG="${arg#*=}" ;;
    -h|--help)
      sed -n '2,55p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "[room] unknown arg: $arg" >&2; exit 2 ;;
  esac
done

case "$SINGLE_VIEW" in
  full|ideas|builds) : ;;
  *) echo "[room] ERROR: --single=<view> must be full, ideas or builds (got '$SINGLE_VIEW')" >&2; exit 2 ;;
esac

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

config_uses_kinect() { # cheap grep, no python needed (matches "kind": "kinect_v2")
  grep -q '"kind": *"kinect' "$1" 2>/dev/null
}

config_walls() { # space-separated wall ids from the config; empty if the parse fails
  "$PYTHON" -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["walls"]))' "$1" 2>/dev/null || true
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
    echo "         $PYTHON -m pip install 'pyorbbecsdk2>=2.1.1'   # PyPI name; imports as pyorbbecsdk" >&2
    exit 1
  fi
  if config_uses_kinect "$CONFIG"; then
    if ! "$PYTHON" -c "import mediapipe, websockets" >/dev/null 2>&1; then
      echo "[room] ERROR: $CONFIG declares a Kinect v2 camera but mediapipe/websockets are not importable by $PYTHON." >&2
      echo "         $PYTHON -m pip install -r gesture-wall/requirements.txt" >&2
      exit 1
    fi
    if [ ! -x gesture-wall/bin/kinect-v2-bridge ]; then
      echo "[room] ERROR: $CONFIG declares a Kinect v2 camera but gesture-wall/bin/kinect-v2-bridge is missing." >&2
      echo "       Build it (needs libfreenect2 installed under \$HOME/.local):" >&2
      echo "         cd gesture-wall && bash native/build_kinect_v2.sh" >&2
      echo "       Full bring-up: docs/KINECT-SINGLE-WALL.md" >&2
      exit 1
    fi
    # Pose model: missing is fine ONLINE (gesturewall auto-downloads it on first
    # start), but say so up front — an offline first boot dies in the camera worker.
    MODEL_REL="$("$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1])).get("server",{}).get("model","models/pose_landmarker_lite.task"))' "$CONFIG" 2>/dev/null || true)"
    MODEL_PATH=""
    case "$MODEL_REL" in
      "") : ;;                                # config parse failed — skip the note
      /*) MODEL_PATH="$MODEL_REL" ;;          # absolute path in the config
      *)  MODEL_PATH="gesture-wall/$MODEL_REL" ;;  # relative to gesture-wall/ (server CWD)
    esac
    if [ -n "$MODEL_PATH" ] && [ ! -f "$MODEL_PATH" ]; then
      echo "[room] NOTE: pose model $MODEL_PATH is missing — it auto-downloads on first start"
      echo "       (needs internet once). Offline? Pre-seed it from the MediaPipe model bucket:"
      echo "       see docs/KINECT-SINGLE-WALL.md."
    fi
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
  # Instructions + width pins are driven by the walls actually declared in the
  # config (a single-wall Kinect room has only wall A — hardcoding A+B would
  # send the operator chasing a projector page that doesn't exist).
  WALLS="$(config_walls "$CONFIG")"
  [ -n "$WALLS" ] || WALLS="A B"   # config parse failed — assume the classic two walls
  wall_in_config() { case " $WALLS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
  # Wall-width pins: an explicit WALL_A_M/WALL_B_M wins; otherwise autocal pins
  # to the measured widths stored in the config (walls.<id>.width_m) — passing
  # CLI --width unconditionally would stomp them with stale defaults. A pin for
  # a wall the config doesn't declare is dropped (autocal hard-errors on it).
  WIDTH_ARGS=()
  if [ -n "$WALL_A_M" ]; then
    if wall_in_config A; then WIDTH_ARGS+=(--width "A=$WALL_A_M")
    else echo "[room] NOTE: WALL_A_M is set but wall 'A' is not in $CONFIG — ignoring it."; fi
  fi
  if [ -n "$WALL_B_M" ]; then
    if wall_in_config B; then WIDTH_ARGS+=(--width "B=$WALL_B_M")
    else echo "[room] NOTE: WALL_B_M is set but wall 'B' is not in $CONFIG — ignoring it."; fi
  fi
  if [ "${#WIDTH_ARGS[@]}" -gt 0 ]; then
    echo "[room] auto-calibration: wall width overrides ${WIDTH_ARGS[*]} (from WALL_A_M/WALL_B_M)"
  else
    echo "[room] auto-calibration: wall widths pinned from $CONFIG (walls.<id>.width_m; override with WALL_A_M/WALL_B_M)"
  fi
  STEP=1
  for W in $WALLS; do
    echo "[room] $STEP. Open FULLSCREEN on wall $W's projector: http://localhost:$AUTOCAL_PORT/autocal.html?wall=$W"
    STEP=$((STEP + 1))
  done
  echo "[room]    (unified pages: each transforms into its wall client when calibration completes)"
  echo "[room] $STEP. Step out of the camera's view, then start the sweep:"
  echo "[room]      curl -X POST http://localhost:$AUTOCAL_PORT/calib/start"
  echo "[room] Results are written back into $CONFIG. Ctrl-C when done."
  # Foreground: the script waits on autocal; Ctrl-C reaches it even under sudo.
  # (bash 3.2 + set -u: expand the array with the ${arr[@]+...} guard.)
  ( cd gesture-wall && exec $SUDO "$PYTHON" -m gesturewall.autocal --config "$CONFIG_ABS" \
      ${WIDTH_ARGS[@]+"${WIDTH_ARGS[@]}"} --port "$AUTOCAL_PORT" )
  exit $?
fi

# ── 1) gesture fusion source (legacy; cursors over ws://…:WS_PORT) ───────────
if [ "$GESTURE" = "1" ]; then
  if [ "${ARCADE:-0}" = "1" ]; then
    # Physical joystick (8BitDo/any pygame stick) as the ONLY cursor source,
    # serving the fusion protocol on WS_PORT so the standard &gesture=1 wall
    # URL picks it up — this is what turns on the gesture-mode XL button UI
    # without any cameras. Plain HID: no TCC/camera permission needed.
    if ! "$PYTHON" -c "import pygame" >/dev/null 2>&1; then
      echo "[room] ERROR: pygame not importable by $PYTHON (the joystick bridge needs it):" >&2
      echo "         $PYTHON -m pip install -r gesture-wall/requirements.txt" >&2
      exit 1
    fi
    echo "[room] fusion: arcade joystick bridge on ws://localhost:$WS_PORT"
    "$PYTHON" gesture-wall/tools/arcade_fusion.py --port "$WS_PORT" --wall A &
    PIDS+=($!)
  elif [ "$FAKE" = "1" ]; then
    echo "[room] fusion: camera-free preview (fake) on ws://localhost:$WS_PORT"
    FAKE_WS_PORT="$WS_PORT" bun gesture-wall/tools/fake-fusion.mjs &
    PIDS+=($!)
  else
    if [ ! -f "$CONFIG" ]; then
      # Never seed a kinect/depth-named config from the legacy webcam example —
      # that would silently drive the 2D homography pipeline under a depth name.
      case "$(basename "$CONFIG")" in
        *kinect*|*depth*)
          echo "[room] ERROR: room config '$CONFIG' not found. For the single-wall Kinect rig" >&2
          echo "       start from gesture-wall/room.kinect.json (see docs/KINECT-SINGLE-WALL.md)." >&2
          exit 1 ;;
      esac
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

# Hand-pinch camera source: --fake-hands runs the synthetic choreography emitter
# (the real path is an external TouchDesigner rig — see gesture-wall/touchdesigner/).
if [ "$FAKE_HANDS" = "1" ]; then
  echo "[room] hands: camera-free preview (fake) on ws://localhost:$HANDS_PORT"
  FAKE_HANDS_PORT="$HANDS_PORT" bun gesture-wall/tools/fake-hands.mjs &
  PIDS+=($!)
fi

# --real-hands: the NO-TOUCHDESIGNER path. Launch the standalone MediaPipe bridge
# (real laptop camera → MediaPipe hand tracking → the exact vibersyn-pinch wire
# protocol on :9980, same as the old TD Web Server DAT). First run downloads the
# ~7.8 MB hand_landmarker model (cached). Needs macOS Camera permission granted
# to the launching Terminal/IDE — a sandboxed shell will fail auth (exit 2).
if [ "$REAL_HANDS" = "1" ]; then
  echo "[room] hands: standalone MediaPipe bridge (REAL camera) on ws://localhost:$HANDS_PORT"
  "$PYTHON" gesture-wall/touchdesigner/hands_mediapipe.py --port "$HANDS_PORT" --wall A &
  PIDS+=($!)
fi

# ── 2) build + serve Vibersyn ────────────────────────────────────────────────
echo "[room] building Vibersyn UI…"
bun run build >/dev/null 2>&1 || { echo "[room] ERROR: UI build failed (run 'bun run build' to see why)." >&2; exit 1; }
if [ "$SELF_MODE" = "1" ]; then
  # SELF-HOSTING: the supervisor loop owns the server — exit 87 (a green
  # "self:" commit landed) → bun run build → relaunch, same env; any other
  # exit ends the loop normally. The walls reload themselves on the new bootId.
  echo "[room] Vibersyn server (SELF-HOSTING supervisor) on http://localhost:$VIBERSYN_PORT (bound to $HOST)"
  HOST="$HOST" VIBERSYN_PORT="$VIBERSYN_PORT" VIBERSYN_SELF_MODE=1 bash scripts/self-supervisor.sh &
else
  echo "[room] Vibersyn server on http://localhost:$VIBERSYN_PORT (bound to $HOST)"
  HOST="$HOST" VIBERSYN_PORT="$VIBERSYN_PORT" bun src/server/index.ts &
fi
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
# Hand-pinch camera stream: wall A (and --single) always; wall B only when
# HANDS_WALLS opts in — one hands stream driving two cameras at once is deliberate.
HANDS_QS=""
HANDS_QS_B=""
if [ "$HANDS" = "1" ]; then
  if [ "$FAKE_HANDS" = "1" ]; then
    # --fake-hands must drive the server it just launched — a leftover
    # HANDS_URL (real-rig session) would point the walls at an absent TD host.
    HANDS_QS="&hands=ws://localhost:$HANDS_PORT"
  elif [ "$REAL_HANDS" = "1" ]; then
    # --real-hands launched the local MediaPipe bridge on :9980; hands=1 resolves
    # to ws://<host>:9980 in the browser (parity with the running wall URL).
    HANDS_QS="&hands=1"
  else
    HANDS_QS="&hands=${HANDS_URL:-ws://localhost:$HANDS_PORT}"
  fi
  case ",$HANDS_WALLS," in *,B,*) HANDS_QS_B="$HANDS_QS" ;; esac
fi
# Mock Room (fixture decks) is HIDDEN from the default UI (no-mocks audit);
# VIBERSYN_MOCK_ROOM=1 in the env opts the toggle back in via ?mock=1.
MOCK_QS=""
if [ "${VIBERSYN_MOCK_ROOM:-}" = "1" ]; then
  MOCK_QS="&mock=1"
fi
URL_A="http://localhost:$VIBERSYN_PORT/?live=1&wall=A&view=ideas$GESTURE_QS$HANDS_QS$MOCK_QS"
URL_B="http://localhost:$VIBERSYN_PORT/?live=1&wall=B&view=builds$GESTURE_QS$HANDS_QS_B$MOCK_QS"
URL_SINGLE="http://localhost:$VIBERSYN_PORT/?live=1&view=$SINGLE_VIEW$GESTURE_QS$HANDS_QS$MOCK_QS"

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
if [ "$HANDS" = "1" ]; then
  echo "[room] hand camera: pinch-hold-drag one hand to orbit (flick to coast); pinch BOTH hands and spread/squeeze to zoom."
fi
echo "[room] (tip: dwell/click \"Guided Demo\" — or add &demo=guided to a wall URL — for the coached visitor walkthrough.)"
wait
