# Gesture Wall — coarse mid-air select/deselect on a projected wall

A small, composable prototype for **selecting/deselecting large targets on a
projected wall by gesturing at it from a distance** — no touch, no mouse, no
wearables. Point/raise your hand at a tile and **dwell** (hold ~0.8 s) to toggle
it. Built from open-source parts (MediaPipe + OpenCV), runs on a plain webcam
and a normal laptop CPU/GPU.

This is **Stack A** from the research report: a single RGB camera → MediaPipe
pose → homography → dwell-to-select, smoothed with a 1-Euro filter. It's
deliberately coarse (a few big tiles), which is the regime where you don't need
depth cameras or fine finger tracking.

> **Try it right now without a camera:** `python3 run.py` runs a **mouse test
> mode** that drives the exact same selection pipeline with your mouse.

---

## How you interact

- **Engage:** raise your hand above your shoulder → a cursor appears at your
  wrist. Drop your arm to disengage (no accidental selections — fights the
  "Midas touch" and arm fatigue).
- **Aim:** move your hand; the cursor follows (mirrored, so right = right).
- **Select / deselect:** hold the cursor over a tile; a ring fills over ~0.8 s,
  then the tile toggles. A short cooldown prevents accidental double-toggles.

These choices follow the HCI evidence in the research report: dwell is the most
*accurate (0% error) and least fatiguing* mid-air trigger, and it needs only the
cursor position — so it works at a distance where fingers can't be resolved.

## Architecture

```
gesturewall/
  sources.py      MouseSource (camera-free)  |  PoseSource (webcam + MediaPipe Tasks)
  calibration.py  Homography: map raw pointer -> wall coords (point-at-corners calibration)
  filters.py      OneEuroFilter / Point2DFilter: adaptive cursor smoothing
  zones.py        Zone + build_grid: large selectable tiles in normalized coords
  dwell.py        DwellSelector: dwell-to-select state machine (toggle, hysteresis, cooldown)
  app.py          render loop + drawing + corner calibration + CLI
run.py            entry point  (also: python3 -m gesturewall)
tests/            pure-logic unit tests (no camera needed)
```

Each layer is swappable: drop in a depth camera by writing a new `PointerSource`,
or change the UI by editing only `zones.py` + the draw helpers in `app.py`.

## Install

Requires Python 3.10+ (tested on 3.13, Apple Silicon).

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt        # numpy, opencv-python, mediapipe
pip install pytest                      # for the tests (optional)
```

## Quick start

**Mouse test mode (no camera, works anywhere):**
```bash
python3 run.py
```
Move your mouse over a tile and hold still — watch the ring fill and the tile
toggle. This exercises zones, dwell, smoothing, hysteresis and cooldown.

**Pose mode (webcam + MediaPipe):**
```bash
python3 run.py --source pose            # downloads the pose model on first run (~6 MB)
python3 run.py --source pose --calibrate   # do the corner calibration first
```
On first run with `--source pose`, the PoseLandmarker model is auto-downloaded
to `models/`. Calibration is a one-time "point at each of the 4 corners and press
SPACE" step; the result is saved to `calibration.json` and reused next time.

## Multi-wall / multi-user

The single-wall app above is one camera, one wall, one person. The
**multi-wall pipeline** fuses several cameras into a shared room frame, tracks
multiple people across cameras + time, and streams each projected wall **only
its own cursors** over websockets. Several people can point at several walls at
once.

```
cameras → MultiPoseSource → Persons → room-homography → RoomObs
       → Tracker (fuse bodies across cameras/time) → Tracks
       → FusionEngine (per-wall cursors, seam hysteresis) → websocket → wall.html
```

**1. Describe the room** — copy `room.example.json` to `room.json` and edit the
walls / displays / grid / cameras / fusion / server blocks. Each camera lists the
walls it `serves`; calibration matrices live under `calibration["<cam>-><wall>"]`.

**2. Calibrate (on the hardware with the cameras attached).** For every
`(camera, wall)` pair, point at the 4 wall corners and press **SPACE**:

```bash
.venv/bin/python -m gesturewall.calibrate --config room.json --camera cam0 --wall A
.venv/bin/python -m gesturewall.calibrate --config room.json --camera cam1 --wall A
.venv/bin/python -m gesturewall.calibrate --config room.json --camera cam1 --wall B
.venv/bin/python -m gesturewall.calibrate --config room.json --camera cam2 --wall B
# Optional per-camera floor reference (builds room_homography for cross-camera fusion):
.venv/bin/python -m gesturewall.calibrate --config room.json --floor cam1
```

Each run writes the resulting 3×3 matrix back into `room.json`. (Cameras with a
`null` room_homography fall back to using the hip anchor directly as the room
coordinate, which is fine for a single-camera-per-wall layout.)

**3. Run the server** (websocket fan-out + serves `web/` over http so clients
load from the same origin):

```bash
.venv/bin/python -m gesturewall.server --config room.json
# overrides: --ws-port 8770 --http-port 8000 --fps 30 --num-poses 4
```

**4. Open one wall client per projector** (from the http origin the server
serves, e.g. `http://localhost:8000`):

```
web/wall.html?wall=A&server=ws://localhost:8770&rows=2&cols=3   → projector 1
web/wall.html?wall=B&server=ws://localhost:8770&rows=2&cols=3   → projector 2
```

Each client subscribes to its wall, renders every active cursor in a distinct
color with its own dwell ring + id badge, and a **shared per-zone lock** stops
two people double-toggling the same tile. No camera handy? Move the mouse over a
wall client to inject a local `id=-1` test cursor; press `f` for fullscreen.

> The camera-free heart of the server is `gesturewall.server.step_pipeline`
> (room-map → `Tracker` → `FusionEngine`, no cv2/asyncio), exercised headless by
> `tests/test_server_pipeline.py` with a `FakeSource`.

### Vibersyn on wall B

The 2-wall setup can put the **Vibersyn** idea projector on wall B, driven by
gestures on wall A. Wall A stays `web/wall.html` (add `&vibersyn=<url>` so dwell
tiles POST to Vibersyn); wall B becomes `web/vibersyn.html?src=<vibersyn-url>`. See
[VIBERSYN.md](VIBERSYN.md) and `./run-2wall-vibersyn.sh`.

## Controls

| Key | Action |
|-----|--------|
| `q` / `Esc` | quit |
| `r` | reset all selections |
| `c` | (pose) run corner calibration |
| `SPACE` | (during calibration) capture the current corner |

## Useful options

```
--source {mouse,pose}     input (default: mouse)
--rows N --cols N         tile grid (default 2 x 3)
--labels A,B,C,D,E,F      custom tile labels
--dwell 0.8               seconds to hold for a selection
--cooldown 0.4            seconds locked out after a selection
--hysteresis 0.15         edge stickiness (fraction of a tile)
--min-cutoff 1.0 --beta 0.007   1-Euro smoothing (see Tuning)
--no-filter               disable smoothing
--camera 0 / --video FILE  pose input device or a video file
--no-mirror / --no-preview pose display options
--fullscreen              fullscreen (pose) — for the actual projector
--width 1280 --height 720 wall resolution
```

## Tuning

- **Too jittery?** lower `--min-cutoff` (e.g. 0.5) for more smoothing.
- **Feels laggy when you sweep?** raise `--beta` (e.g. 0.02).
- **Accidental selections?** raise `--dwell` (e.g. 1.0) and/or `--cooldown`.
- **Cursor flickers between two tiles at the seam?** raise `--hysteresis` or
  `--padding`.
- **Targets too small/precise?** that's the point of coarse mode — use fewer,
  bigger tiles (`--rows 2 --cols 2`).

## Testing

Pure-logic tests (filters, zones, dwell, calibration math) run without a camera:

```bash
python3 -m pytest -q
```

## Troubleshooting

- **macOS camera permission:** the first `--source pose` run may need Terminal
  (or your IDE) granted Camera access in *System Settings → Privacy & Security →
  Camera*. Restart the terminal after granting.
- **No window appears / headless:** `cv2.imshow` needs a desktop session. On a
  remote/headless box, run the logic tests (`python3 -m pytest`) instead —
  `--video FILE` still opens a GUI window, so it does **not** bypass this.
- **`mediapipe` won't install:** your Python may lack a wheel. The mouse mode
  and all tests still work; use a Python with a mediapipe wheel for the pose
  path (3.10–3.13 are well supported).
- **Low FPS:** the `lite` pose model is the default; performance is fine on a
  modern laptop. Close other camera apps; lower `--width/--height`.

## Limitations & upgrade path

This prototype maps the **wrist position in the image** onto the wall (absolute
pointing via a 2D homography) — simple and robust for coarse tiles. It is *not*
metric 3D ray-casting. To go further (per the research report):

- **True 3D "eye→hand" ray:** add a depth camera (OAK-D / RealSense) via a new
  `PointerSource`, intersect the ray with the wall plane.
- **Projector ↔ camera alignment:** for a real projector, calibrate with
  `procam-calibration` (structured light) or `ofxKinectProjectorToolkit`.
- **Multi-user / wide area:** track multiple poses (raise `num_poses`) or move
  to a body-pose engine like RTMPose.
- **Richer gestures:** swap in MediaPipe **Gesture Recognizer** (open-palm,
  fist, etc.) when the user is close enough for the hand to be resolved.

See the research report for the full landscape, licenses, and bill of materials.
```
