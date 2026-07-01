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

- **Vibersyn projector:** `bun run start` (server on :8787), or `bun run dev` for the
  UI dev server. Open `/?live=1` for the live runtime.
- **Gesture wall + Vibersyn (2-wall):** `gesture-wall/run-2wall-vibersyn.sh` prints
  the exact services + URLs. Run Vibersyn with `VIBERSYN_CORS_ORIGIN=<wall web
  origin>` so the wall can drive it cross-origin.

## Test

- `bun test` — the Vibersyn TS suite.
- `node gesture-wall/web/_*_check.mjs` — the wall client's headless JS checks;
  `pytest` under `gesture-wall/` for the Python pipeline.
