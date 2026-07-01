# Gesture Wall — web version (projector-ready)

A browser port of the Stack A pipeline you can **project on a wall and test**.
Everything runs client-side: webcam → MediaPipe Tasks **PoseLandmarker** (in the
browser, WebGL/GPU) → mirror → homography → 1-Euro smoothing → dwell-to-select.
The selection logic (`OneEuroFilter`, `Zone`, `DwellSelector`, `Homography`) is a
direct port of the Python modules, so behaviour matches the desktop app.

**Why the browser?** Camera access in a browser is a one-click in-page prompt and
`localhost` is a secure context — so it sidesteps the macOS native-app camera
permission problem that blocked `python3 run.py --source pose`.

## Run

```bash
./web/serve.sh                 # serves http://localhost:8000
# or:  python3 -m http.server 8000 -d web
```

Open **http://localhost:8000** in Chrome (best WebGL support), then:

1. Click **Start camera** and allow access when the browser asks.
2. Raise a hand above your shoulder → a cursor appears at your wrist.
3. Hold the cursor over a tile ~0.8 s → the ring fills and the tile toggles.
4. Click **Fullscreen** (or press `f`) and project. The control panel auto-hides;
   hover the top edge of the screen to bring it back.

> No camera handy? Click **Mouse test** to drive the exact same pipeline with the
> mouse — move over a tile and hold still.

## Projector calibration

The cursor maps your wrist position in the camera image onto the wall. If the
camera isn't square-on, run **Calibrate** (button or `c`). The flow is fully
interactive:

- The corner you should point at **pulses and is labelled** (e.g. `TOP-LEFT`);
  the remaining corners are dim/numbered and captured ones show a green ✓.
- A line connects your live cursor to the active target, and the **reach quad**
  draws itself as you go.
- **Hold steady at the corner** and the ring around your cursor fills — at full
  it captures automatically (hands-free, so you don't need to reach the
  keyboard). You can still press **SPACE** to capture immediately.

After all 4 corners the homography is saved to `localStorage` and reused.
**Reset calib** returns to identity (1:1) mapping. You can also run calibration in
**Mouse test** mode to preview the flow without a camera.

## Controls

| Key | Action |
|-----|--------|
| `r` | reset all tile selections |
| `c` | run corner calibration |
| `f` | toggle fullscreen |
| `SPACE` | capture the current corner (during calibration) |
| `Esc` | cancel calibration |

Panel sliders: grid **rows/cols**, **dwell** time, 1-Euro **smooth** (min-cutoff)
and **beta**, plus **Mirror / Filter / Preview** toggles — same tuning knobs as
the Python CLI flags.

## Multi-wall / multi-user

`index.html` is the standalone single-wall app (pose runs **in the browser**).
For **several cameras / several walls / several people**, the heavy lifting moves
to the Python server (`gesturewall.server`), and each projector loads the thin
networked client **`wall.html`** instead. It does no camera work — it just
subscribes to one wall's cursor stream and renders it.

```
Python: cameras → Tracker → FusionEngine → websocket (port 8770)
Browser: wall.html?wall=A  ──ws──►  per-wall cursor stream
```

The shared pure-logic classes live in **`core.js`** (named exports:
`OneEuroFilter`, `Point2DFilter`, `Zone`, `buildGrid`, `DwellSelector`,
`Homography`, `WALL_CORNERS`, `CORNER_NAMES`). Both `gesturewall.js` (the
single-wall app) and `wall.js` (the networked client) import from it, so their
behaviour is identical.

**Run it:**

```bash
# 1) fill room.json + calibrate on the hardware (see the repo root README), then:
.venv/bin/python -m gesturewall.server --config room.json
# serves this web/ dir over http AND the websocket fan-out.
```

**Open one client per projector** (same origin the server serves):

```
http://localhost:8000/wall.html?wall=A&server=ws://localhost:8770&rows=2&cols=3
http://localhost:8000/wall.html?wall=B&server=ws://localhost:8770&rows=2&cols=3
```

URL params: `wall` (default `A`), `server` (default `ws://<host>:8770`), `rows`
(default 2), `cols` (default 3). Each cursor gets a distinct color (hue from id),
its own smoothing + dwell ring + id badge; a **shared per-zone lock (~0.4 s)**
prevents two people double-toggling the same tile. The HUD shows the user count
and connection state, and the socket auto-reconnects.

- **Mouse test:** move the mouse over the canvas to inject a local `id=-1` cursor
  with no server connected. **`f`** toggles fullscreen.

> Node checks for the pure logic: `node _core_check.mjs` (shared core —
> Homography round-trip, 1-Euro steady-state, dwell toggle) and
> `node _wall_check.mjs` (wall.js helpers + the shared zone-lock conflict rule).

## Notes

- The pose model (~6 MB) and MediaPipe WASM load from a CDN on first run, so the
  first launch needs internet. Subsequent loads are cached by the browser.
- Requires `localhost` or `https://` — opening `index.html` via `file://` will
  block the camera.
- Chrome gives the most reliable WebGL/GPU path; Safari works but is slower.
