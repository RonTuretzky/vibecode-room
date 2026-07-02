#!/usr/bin/env bash
# Serve the Gesture Wall web app on http://localhost:8000
# (localhost is a "secure context", so the browser will allow camera access).
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8000}"
echo "Gesture Wall  ->  http://localhost:${PORT}/"
echo "Open that URL in Chrome, click 'Start camera', allow access, then 'Fullscreen'."
exec python3 -m http.server "$PORT"
