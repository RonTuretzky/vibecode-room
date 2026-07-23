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
- **`gesture-wall/`** — vendored gesture-to-wall control software (a Python
  depth-camera fusion server + a vanilla-JS wall client), an **optional camera
  mode** (`./run-room.sh --gesture`, one Orbbec Gemini 335 serving both walls) —
  desk mode below is the zero-hardware default. See
  [`gesture-wall/VIBERSYN.md`](gesture-wall/VIBERSYN.md).

## Run

- **The whole room, one command:** `./run-room.sh` — builds + serves Vibersyn
  (bound to `0.0.0.0` so your phone can reach the QR-import page) and opens the
  UI fullscreen on two walls. **Both walls render the complete 3D room** — all
  ideas AND all builds — each window with its own independent camera (drag to
  orbit, scroll to zoom, `f` fit, `z` zen; `?wall=A|B` only labels the window
  and seeds a different default camera angle so the walls don't boot
  pixel-identical). The `?view=ideas|builds` params in the URLs are legacy and
  no longer filter content. No cameras, no Python — you drive it with mouse,
  keyboard, and voice. `./run-room.sh --single` opens one window instead — a
  laptop or single projector; `--single=ideas`/`--single=builds` only add the
  legacy view badge.
- **Vibersyn projector only:** `bun run start` (server on :8787), or `bun run dev`
  for the UI dev server. Open `/?live=1` for the live runtime.

## Control (desk mode — the default)

- **Mouse:** click bubbles and buttons directly.
- **Keyboard:** press `?` (or `h`) for the cheat-sheet overlay. Highlights:
  `b`/`Enter` build the top ready idea · `x` dismiss it · `c` toggle Idea
  Capture · `a` toggle Auto-Build · `q` QR import · `m` mic · `u` unmute ·
  `1–9` select/steer processes · `Esc` close overlays · `Shift+E` emergency stop.
- **Voice:** the wake word is **"Vibersyn"** (fuzzy-matched — "viber sin" or
  "vibersin" work too):
  - the bare name starts **Idea Capture**;
  - **"Vibersyn, build it"** builds the top ready idea;
  - **"Vibersyn, stop everything"** is the emergency stop;
  - also understood: "dismiss"/"skip"/"no", "auto build on/off", "stop capturing".
- **QR Import:** the **QR Import** status-bar button shows a QR code — scan it on
  your phone to open a page where you paste a GitHub repo URL; submitting adds it
  to the wall as a project in progress. (The phone needs to reach the server over
  the LAN; `./run-room.sh` binds `HOST=0.0.0.0` for exactly this.)

### Gesture wall (optional camera mode)

`./run-room.sh --gesture` runs the camera-driven room: a single Orbbec
**Gemini 335** depth camera in the room's far corner watches BOTH walls, and
the gesture wall's Python server turns its pose stream into per-wall cursor
streams over a WebSocket; each wall window opens with `&gesture=1&fusion=ws://…`
so the UI mounts its gesture layer (`src/ui/gesture/`) — a completed ~0.8s
dwell clicks the REAL bubble/button beneath the cursor. On macOS the camera
server must run under `sudo -E` (opening the camera needs elevated
permissions). Calibrate with `./run-room.sh --calibrate` (projector
auto-calibration; re-run after moving anything), and keep some ambient light on
people — pose reads the color image, and a dark projected room starves it
(depth is IR and doesn't care). No camera handy? `./run-room.sh --fake` uses
synthetic cursors so you can see it work. See
[`gesture-wall/GEMINI.md`](gesture-wall/GEMINI.md) for the hardware setup and
[`gesture-wall/VIBERSYN.md`](gesture-wall/VIBERSYN.md).

### Hand-pinch camera (optional, TouchDesigner)

An independent, opt-in gesture input for the CAMERA (composes with desk mode
and with `--gesture` dwell): a TouchDesigner rig (the laptop's built-in camera
+ MediaPipe hand tracking — no depth camera needed) streams per-hand pinch
frames over a WebSocket on **:9980**, and the
opted-in wall window steers its 3D camera with your hands — **pinch-hold one
hand and drag** to orbit (release with a flick to coast, exactly like a mouse
flick); **pinch BOTH hands and spread/squeeze** to zoom in/out (drifting both
hands pans). URL param: `?hands=1` connects to `ws://<page-host>:9980`,
`?hands=ws://td-mac:9980` names an explicit source, absent = off.

- **No hardware:** `./run-room.sh --fake-hands` — a scripted 12 s synthetic
  pinch choreography drives wall A (orbit → flick coast → zoom → pan), for
  tuning the feel with no TouchDesigner and no cameras.
- **Real rig:** `./run-room.sh --hands=ws://<td-host>:9980` — the TouchDesigner
  network described in
  [`gesture-wall/touchdesigner/README.md`](gesture-wall/touchdesigner/README.md)
  (MediaPipe plugin install, drop-in DAT scripts, channel verification, tuning).

## Model

The Cerebras decision path (`VIBERSYN_DECISION_LLM=cue-cerebras`, needs
`CEREBRAS_API_KEY`) defaults to **`gemma-4-31b`** — Cerebras's Gemma 4 (31B,
multimodal, ~1850 tok/s), currently **preview tier**. Set `CEREBRAS_MODEL` to
override, e.g. `CEREBRAS_MODEL=gpt-oss-120b` for the production-tier model.
(Idea *judging* itself defaults to the host `claude` CLI —
`VIBERSYN_IDEA_DETECTOR` selects the detector backend.)

## Test

- `bun test` — the Vibersyn TS suite.
- `node gesture-wall/web/_*_check.mjs` — the wall client's headless JS checks;
  `pytest` under `gesture-wall/` for the Python pipeline.
