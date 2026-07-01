#!/usr/bin/env bash
# 2-wall setup with the Vibersyn idea projector on wall B, driven by the gesture
# wall on wall A.
#
#   Wall A (projector 1): the gesture control surface — web/wall.html. A dwell on a
#                         tile POSTs a mapped action to Vibersyn (opt-in via the
#                         ?vibersyn= param).
#   Wall B (projector 2): the Vibersyn projector — web/vibersyn.html iframes the
#                         running Vibersyn service.
#
# This script only PRINTS the two URLs + the services to start; open each URL in a
# fullscreen browser window and point it at its projector (display routing is
# manual — see room.example.json / README).
set -euo pipefail

VIBERSYN_URL="${VIBERSYN_URL:-http://localhost:8788}"   # the running Vibersyn service
GW_WS="${GW_WS:-ws://localhost:8770}"                    # gesture-wall fusion server (ws)
GW_HTTP="${GW_HTTP:-http://localhost:8000}"              # gesture-wall static web server
ROWS="${ROWS:-2}"; COLS="${COLS:-3}"

cat <<EOF
Gesture Wall × Vibersyn — 2-wall setup
======================================

1) Start the gesture fusion + web server (from this gesture-wall/ dir):
     python -m gesturewall.server --config room.json

2) Start the Vibersyn projector with CORS allowing this web origin (from the repo
   ROOT — Vibersyn lives in the same repo, one level up from gesture-wall/):
     VIBERSYN_CORS_ORIGIN=$GW_HTTP VIBERSYN_PORT=8788 bun run start

3) Open each URL in its own browser window and fullscreen it onto its projector:

   Wall A — gesture control (projector 1):
     $GW_HTTP/wall.html?wall=A&server=$GW_WS&rows=$ROWS&cols=$COLS&vibersyn=$VIBERSYN_URL

   Wall B — Vibersyn projector (projector 2):
     $GW_HTTP/vibersyn.html?src=$VIBERSYN_URL/?live=1

Dwell-tile → Vibersyn action map (wall A, 2x3 grid; override with &vibersynmap=):
   r0c0  Idea Capture   (toggle)   POST /api/capture
   r0c1  Build idea      (oneshot)  POST /api/suggestion/accept
   r0c2  Auto-Build      (toggle)   POST /api/auto-accept
   r1c2  Emergency stop  (oneshot)  POST /api/emergency-stop

See VIBERSYN.md for details.
EOF
