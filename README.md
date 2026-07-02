# Vibecode Room — Vibersyn

Vibersyn is an ambient **idea room**: people talk, the room detects concrete
*buildable* ideas via windowed model inference — passively, or on demand via
**Idea Capture** mode — grounds each idea to the span of conversation it came from,
and turns it into a running app. A projector UI shows the ideas forming and the
agents building them.

## Layout

- **`src/`** — the Vibersyn app:
  - `src/detect/` — windowed idea detection (transcript window, `IdeaDetector`,
    reconciler, engine) + eval scorers.
  - `src/server/` — the projector server (Bun + Hono), detection runner, idea
    builder, and the HTTP/SSE API.
  - `src/ui/` — the projector UI (React).
- **`.smithers/`** — Smithers workflows + evals for the idea loop
  (`workflows/idea-detection.tsx`, `evals/`).
- **`gesture-wall/`** — vendored gesture-to-wall control software (a Python camera
  fusion server + a vanilla-JS wall client). It was built **expressly to drive this
  Vibersyn UI via gestures on walls**: wall A is a gesture control surface whose
  dwell tiles POST actions to Vibersyn (Idea Capture, Build, Auto-Build, Emergency),
  and wall B shows the Vibersyn projector. See
  [`gesture-wall/VIBERSYN.md`](gesture-wall/VIBERSYN.md).

## Run

- **The whole room, one command:** `./run-room.sh` — starts the camera fusion
  server, builds + serves Vibersyn, and opens the UI fullscreen on two walls
  (`?wall=A` / `?wall=B`). Point at a wall and hold ~0.8s over a bubble/button to
  click it. No cameras handy? `./run-room.sh --fake` uses synthetic cursors so you
  can see the whole thing work (and you can always drive it with the mouse — hold
  still over a target).
- **Vibersyn projector only:** `bun run start` (server on :8787), or `bun run dev`
  for the UI dev server. Open `/?live=1` for the live runtime.

### Gesture control (cameras → walls → the UI)

The gesture wall's Python server turns camera pose into per-wall cursor streams
over a WebSocket. Opening the Vibersyn UI with `?wall=A` mounts a **gesture layer**
(`src/ui/gesture/`) that connects to that stream, overlays each cursor, and runs
dwell-to-select against the REAL UI elements — a completed dwell fires a click on
the bubble/button beneath it. So you drive the actual Vibersyn UI by pointing at
the wall; two walls each run the UI bound to their own wall id. See
[`gesture-wall/VIBERSYN.md`](gesture-wall/VIBERSYN.md).

## Test

- `bun test` — the Vibersyn TS suite.
- `node gesture-wall/web/_*_check.mjs` — the wall client's headless JS checks;
  `pytest` under `gesture-wall/` for the Python pipeline.
