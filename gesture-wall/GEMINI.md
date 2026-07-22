# Orbbec Gemini 335 single-camera rig (macOS)

This is the **current** Gesture Wall rig: **one** Orbbec **Gemini 335** depth
camera in the room's far corner watches **both** projected walls — wall A
(2.3 m) and wall B (2.5 m), meeting at a 90° corner — so the pipeline runs on
a single shared frame: joint auto-calibration, one camera `serves` both walls,
and seam handoff between walls comes for free. It supersedes the two-Kinect
rig ([KINECT.md](KINECT.md), which remains fully supported for cameras with
`kind: "kinect_v2"`).

Everything geometric is unchanged from the depth path KINECT.md describes —
eye→hand ray, wall-plane intersection, roaming invariance. Only the *frame
source* changed: `gesturewall/orbbec.py` (`OrbbecSource`) speaks the exact same
`(color_bgr, depth_m, intrinsics)` contract as the Kinect source, selected by
`kind: "gemini_335"` through the `gesturewall/framesource.py` factory. The
calibrated room lives in `room.json`: wall planes for A and B, one camera
(`cam0`, identity extrinsic — its frame *is* the room frame) serving `["A","B"]`,
and `fusion.cross_camera: true`.

---

## 0. What you need (hardware)

- An **Orbbec Gemini 335** (this rig's serial: `CP0E8530002Y`). Depth FOV is
  90°×65°; the **color** camera is ~**86°** horizontal — and color is the
  binding constraint, because pose tracking runs on the color image.
- A real **USB 3** path into the Mac. The camera *will* enumerate on USB 2 and
  then starve mid-stream — `OrbbecSource` prints a warning when it detects a
  USB 2 connection. Use a known-good USB 3 port and cable.
- Two projectors (one per wall). Auto-calibration uses them as its light
  source, so no chessboards or tape measures are needed.

Quick visibility check once it is plugged in:

```bash
system_profiler SPUSBDataType | grep -i -B2 -A8 orbbec
```

---

## 1. Install

Python 3.10+ (tested on 3.13, Apple Silicon). From `gesture-wall/`:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

`requirements.txt` includes the Orbbec SDK bindings. Mind the name split: the
**PyPI package is `pyorbbecsdk2`** (the v2 SDK), but the **import name stays
`pyorbbecsdk`**. Sanity check (no camera or sudo needed — importing never
touches the device):

```bash
.venv/bin/python -c "import pyorbbecsdk; print('sdk ok')"
```

---

## 2. macOS: every camera command needs `sudo -E`

On macOS, **opening** the camera (USB/UVC access) needs elevated permissions.
An un-sudo'd process dies with **`uvc_open` error -3** the moment it touches
the device. So every camera-touching command — probe, preview, autocal, the
live server — must run under **`sudo -E`** (`-E` preserves your environment,
including the `GESTUREWALL_ORBBEC_*` knobs below).

Probe the hardware end-to-end (resolution, fps, center depth, intrinsics):

```bash
sudo -E .venv/bin/python -m gesturewall.orbbec --serial CP0E8530002Y
```

---

## 3. Physical placement

The camera goes **flush in the room's far corner** — the corner diagonally
opposite the wall seam — roughly **2.5 m along each wall** from the seam:

- **Height:** 2.0–2.2 m (above heads, so bodies don't occlude each other).
- **Pitch:** ~10° down.
- **Aim:** straight at the wall seam (the A/B corner).

From that corner the two walls together span **83.5°**, and the color camera
has **86°** to give — a margin of only ~2.5°. **Every 10 cm the camera sits
away from the corner costs ~4° of that margin**, so "roughly near the corner"
does not work: mount it flush, and verify that **both far wall edges are
visible in the preview** (next section) before calibrating. If an edge is cut
off, that wall's outer tiles are simply invisible to the system.

---

## 4. Aim it (live preview)

Stream the camera's color view to a browser and adjust until both walls (and
both far edges) are in frame:

```bash
sudo -E .venv/bin/python -m gesturewall.preview --kind gemini_335 \
    --serial CP0E8530002Y --port 8802
# then open http://localhost:8802/
```

A thirds grid + centre crosshair are drawn to help leveling; put the crosshair
on the wall seam. Only **one process can hold the camera** at a time — stop
the gesture server or autocal before starting the preview (and vice versa).

---

## 5. Calibrate (projector auto-calibration)

Calibration is fully automatic: `gesturewall.autocal` flashes magenta discs at
known wall coordinates through the projectors, finds them in the camera's
color+depth, and writes the fitted wall planes back into the config. One joint
run calibrates both walls from the single camera. From `gesture-wall/`:

```bash
sudo -E .venv/bin/python -m gesturewall.autocal --config room.json \
    --width A=2.3 --width B=2.5 --port 8801
```

`--width WALL=METRES` pins each fitted plane to the measured physical wall
width — measure once with a tape measure, then reuse forever.

Then:

1. Open **`http://localhost:8801/autocal.html?wall=A`** fullscreen on wall A's
   projector, and **`...?wall=B`** fullscreen on wall B's projector.
2. Start it, stay out of the camera's view for ~90 seconds:

   ```bash
   curl -X POST http://localhost:8801/calib/start
   curl http://localhost:8801/calib/status     # progress / result
   ```

On success the wall planes are written into `room.json` (guarded by sanity
gates on wall width, height, and the angle between the planes — a bad run
writes nothing). From the repo root, `./run-room.sh --calibrate` wraps this
whole flow.

**When to recalibrate:** after moving *anything* — the camera, either
projector, or the projected image size/keystone — and prefer calibrating a
**warm** camera (give it a few minutes of streaming first; depth drifts
slightly as the module warms up).

---

## 6. Run

From the repo root, the room script starts everything (Vibersyn + the gesture
server + the wall windows):

```bash
./run-room.sh --gesture
```

Or by hand, from `gesture-wall/` (the server auto-downloads its MediaPipe pose
model into `models/` on first run, relative to the cwd — so run it from here):

```bash
sudo -E .venv/bin/python -m gesturewall.server --config room.json
#   overrides: --ws-port 8770 --http-port 8000 --fps 30 --num-poses 4
```

Raise a hand above the shoulder to **engage**, aim, **dwell** ~0.8 s to
select — identical interaction, WS protocol, and wall clients as the Kinect
depth path.

---

## 7. Lighting — keep some ambient light ON

**Live-proven on this rig, and the single biggest quality lever.** The two
halves of the pipeline see light very differently:

- **Depth is immune to room lighting** — the Gemini carries its own IR
  emitter; a pitch-black room measures depth perfectly.
- **Pose is not** — MediaPipe runs on the **color** image, and a dark room lit
  only by the projectors starves the landmarks. In live testing, turning
  ambient light on made pointing **much** better.

So: keep some ambient light on the *people* (not washing out the projection).
Two opt-in env levers can additionally bias the camera's auto-exposure toward
brighter people (best-effort — unsupported firmwares just warn):

```bash
GESTUREWALL_ORBBEC_BRIGHTNESS=<int>   # AE target brightness
GESTUREWALL_ORBBEC_BACKLIGHT=<0-6>    # backlight compensation
```

If you change either, **re-run autocal** — the color response changes, and the
marker detector diffs color frames.

---

## 8. Experimental camera knobs (off by default — on purpose)

Orbbec's official G335 guidance for hand tracking is the "Hand" depth preset +
1280x800 native depth + hardware frame sync. **Enabled together on this rig,
they made pointing measurably WORSE** (wall B autocal marker fill dropped from
9/9 to 7/9 — the Hand preset trades depth fill for edge sharpness, the wrong
tradeoff at this room's 2.5–3.6 m ranges). The defaults are therefore the
proven-good device behavior, and each knob is opt-in for individual A/B runs:

```bash
GESTUREWALL_ORBBEC_PRESET=Hand        # named depth preset (empty = device default)
GESTUREWALL_ORBBEC_DEPTH=1280x800    # explicit native depth mode
GESTUREWALL_ORBBEC_SYNC=1            # hardware color/depth frame sync
```

Set them in the environment of the camera process (this is why the sudo
requirement is `sudo -E`). Test one at a time, and re-run autocal after any
change that alters the depth or color response.

---

## 9. Troubleshooting

- **`uvc_open` error -3 / "enumeration failed" mentioning permissions** — you
  are not running under sudo. Re-run the command with `sudo -E` (§2).
- **"camera on USB2.x, not USB 3" warning** — streams will start and then
  starve. Move to a real USB 3 port / better cable; avoid cheap hubs.
- **Frames stop mid-session** — `OrbbecSource` auto-recovers: after **5 s** of
  consecutive empty waits it logs the pipeline status (which says whether the
  problem sits in the SDK, driver, firmware, or hardware), closes the device,
  and transparently re-enumerates on the next read. If it recovers repeatedly,
  reseat the USB cable (driver/hardware issue) or power-cycle the camera
  (firmware issue) per the logged status.
- **Blank preview / dead autocal page** — another process is holding the
  camera (only one can). Stop the gesture server first.
- **Firmware** — this unit runs **1.4.60**. Orbbec ships **1.8.10**; updating
  is a *documented future maintenance step*, not yet performed or validated on
  this rig — don't update in the middle of an install, and expect to re-check
  the preset/sync behavior (§8) afterwards.

## Testing

The Orbbec source is covered headless — tests plant a fake `pyorbbecsdk` in
`sys.modules` before `start()` runs, so no SDK or hardware is needed:

```bash
.venv/bin/python -m pytest -q                       # whole suite (must stay green)
.venv/bin/python -m pytest -q tests/test_orbbec.py      # source contract, decode, stall
.venv/bin/python -m pytest -q tests/test_framesource.py # kind dispatch
.venv/bin/python -m pytest -q tests/test_autocal.py     # marker detection, plane fits
```
