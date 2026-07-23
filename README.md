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
  Capture · `a` toggle Auto-Build · `r` toggle Research mode · `q` QR import ·
  `m` mic · `u` unmute · `1–9` select/steer processes · `Esc` close overlays ·
  `Shift+E` emergency stop.
- **Voice:** the wake word is **"Vibersyn"** (fuzzy-matched — "viber sin" or
  "vibersin" work too):
  - the bare name starts **Idea Capture**;
  - **"Vibersyn, build it"** builds the top ready idea;
  - **"Vibersyn, research it"** (or "fact check") researches the top suggested
    quest; "research on/off" toggles the mode;
  - **"Vibersyn, stop everything"** is the emergency stop;
  - also understood: "dismiss"/"skip"/"no", "auto build on/off", "stop capturing".
- **QR Import:** the **QR Import** status-bar button shows a QR code — scan it on
  your phone to open a page where you describe what the fleet should build
  (context is the primary field) plus an optional link. A `github.com/<owner>/<repo>`
  link is shallow-cloned into `builds/<upid>/repo/` and a digest of it grounds the
  build; any other http(s) link rides along as reference. Every submission spawns a
  REAL fleet project — the same accept→build→preview fan-out accepted ideas get.
  The server always binds a dedicated phone listener on `0.0.0.0:<port+1>` serving
  only the import surface, so the QR works even when the main server is loopback-
  bound (override the port with `VIBERSYN_PHONE_PORT`, disable the listener with
  `VIBERSYN_PHONE_LISTENER=0`). Note: like the rest of the room API, the import
  surface is unauthenticated — anyone on the room LAN can add projects; that's the
  point, but run it on a network you trust.

## Research mode

Toggle **🔍 Research** (or press `r`, or say *"Vibersyn, research on"*) and the
room's conversation grows a **3D dialogue tree** next to the idea garden — a
rising helix of speaker-colored turn nodes (VoxTerm's flat transcript,
re-imagined in space) — while a suggester agent watches the talk and proposes
**research quests**: claims to *fact-check*, topics to *deep-dive*, framings to
*bias-scan*. Each quest buds off the exact turn it was grounded in as a
clickable crystal (blue = proposed). Nothing researches itself: click the
crystal (or the tray's **Research** button, or say *"Vibersyn, research it"* /
*"fact check"*) and a research agent spawns — it web-searches for sources, an
adversarial second pass tries to **refute** every finding, and a third pass
flags **bias and blind spots**. The finished crystal (mint) opens a
self-contained **dossier slideshow**: findings with supported/refuted/mixed
verdicts, bias notes, and a **QR code per source** so anyone in the room can
scan a citation straight to their phone (`GET /api/research/:id/deck`).

- `src/research/` — suggester, three-stage agent, quest ledger/loop, deck
  renderer. Backends mirror idea detection: host-`claude` inference is the
  no-config default (the agent gets real web search via the CLI);
  `VIBERSYN_RESEARCH_SUGGESTER=heuristic` and `VIBERSYN_RESEARCH_AGENT=stub`
  run deterministic offline versions (CI/tests). Models/timeouts:
  `VIBERSYN_RESEARCH_SUGGESTER_MODEL`, `VIBERSYN_RESEARCH_AGENT_MODEL`,
  `VIBERSYN_RESEARCH_STAGE_TIMEOUT_MS`.
- API: `POST /api/research-mode {on}` · `POST /api/research/:id/accept` ·
  `POST /api/research/:id/dismiss` · `GET /api/research/:id/deck`.

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

### Single-wall Kinect rig

The one-projector variant: a single wall driven by an old **Kinect v2
(Xbox One)** instead of the Orbbec — same gesture layer, no sudo, runs with
`ROOM_CONFIG=gesture-wall/room.kinect.json ./run-room.sh --single --gesture`.
Full bring-up (which Kinect you have, camera placement, libfreenect2 +
bridge build, calibration, troubleshooting):
[`docs/KINECT-SINGLE-WALL.md`](docs/KINECT-SINGLE-WALL.md).

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
- **Real hands, no TouchDesigner (recommended):** `./run-room.sh --real-hands`
  — launches the **standalone MediaPipe bridge**
  ([`gesture-wall/touchdesigner/hands_mediapipe.py`](gesture-wall/touchdesigner/hands_mediapipe.py))
  alongside the room: it opens the laptop camera, runs MediaPipe hand tracking,
  and streams the *exact same* `vibersyn-pinch` protocol on **:9980** that the
  TouchDesigner DAT did — no `.toe` file, no GPU plugin. The wall opens with
  `&hands=1`. First run downloads the ~7.8 MB `hand_landmarker.task` model
  (cached). Needs macOS **Camera permission** granted to the launching
  Terminal/IDE (a sandboxed shell fails auth). Run the bridge by hand with
  `gesture-wall/.venv/bin/python gesture-wall/touchdesigner/hands_mediapipe.py --port 9980 --wall A`
  and connect any room with `--hands=ws://localhost:9980` (or `?hands=1`).
- **Real rig (TouchDesigner):** `./run-room.sh --hands=ws://<td-host>:9980` — the
  TouchDesigner network described in
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
