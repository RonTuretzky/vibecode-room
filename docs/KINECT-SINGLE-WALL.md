# Single-wall Kinect rig — bring-up guide

One projector, one wall, one **Kinect v2 (Xbox One)** depth sensor, driving the
Vibecode Room gesture layer. This is the small sibling of the production rig
(two walls, one Orbbec Gemini 335); the whole Kinect depth path is already in
the vendored `gesture-wall/` tree — this doc is the end-to-end recipe for a
fresh machine.

Config used throughout: **`gesture-wall/room.kinect.json`** (single wall `A`,
one camera `cam0` of kind `kinect_v2`). If it does not exist yet on your
checkout, create it — the exact contents are in [§4](#4-calibration).

Deep background lives in [`gesture-wall/KINECT.md`](../gesture-wall/KINECT.md)
(protocol, geometry, manual calibration). This doc supersedes its install
section where they disagree (KINECT.md has some bit-rot, noted below).

---

## 1. Which Kinect do you have?

Only the **Kinect v2** is supported. Check before buying cables:

| | Kinect v2 (supported) | Kinect v1 (NOT supported) |
|---|---|---|
| Console branding | **XBOX** (Xbox One) | **XBOX 360** |
| Model number (bottom label) | 1520 (Xbox One), 1656 (Kinect for Windows v2) | 1414 / 1473 (Xbox 360), 1517 (K4W v1) |
| Shape | wide flat rectangular slab (~25 cm), no tilt motor | smaller bar on a motorized tilting pivot stand |
| Depth tech | time-of-flight, 512×424 | structured light, 640×480 |
| Cable | captive **proprietary plug** — useless without the adapter | USB-A + 12 V wall-wart splitter (or orange-tip combo plug) |
| Host port | **USB 3.0** (blue) | USB 2.0 |

**The v2 requires the "Kinect Adapter for Windows / Xbox One S/X"** — an
external power brick (12 V / ~3 A) that converts the proprietary plug into
powered USB 3.0. The sensor cannot be powered or connected without it.
Microsoft's original adapter (model 9J7-00007) is discontinued; second-hand
originals and third-party equivalents are widely sold and work.

Also needed: a **real USB 3.0 path** into the machine — direct port or a
quality dock. Avoid cheap passive hubs and VMs; libfreenect2's isochronous
USB 3 transfer is bandwidth-delicate.

Verify on macOS once plugged in and powered:

```bash
system_profiler SPUSBDataType | grep -i -A12 -E "kinect|xbox|microsoft|nui"
```

A v2 enumerates as an **"Xbox NUI Sensor"** USB 3 device (vendor 0x045e). A v1
shows up as three siblings ("Xbox NUI Motor/Camera/Audio") — if you see that,
stop: v1 support does not exist here. (For the record, adding it would mean a
new native bridge on libfreenect (not libfreenect2) speaking the same
K2IN/K2RG stdout protocol at 640×480 with registered depth, plus a
`kinect_v1` camera kind — the Python side is resolution-agnostic, but that is
new native code plus hardware validation, not a config change.)

---

## 2. Physical setup & camera placement

Topology is the same as the production Orbbec rig: the **camera faces the
wall from behind the interaction zone**. People stand between the camera and
the wall, backs to the camera, and point at the wall; the server casts a
shoulder→hand ray from the depth data and intersects it with the calibrated
wall plane. The camera IS the room origin — everything is measured in its
frame, so mount it rigidly.

```
        top-down view (not to scale)

  ==========================================   WALL A — the projected image
      ^                                        (width_m, e.g. ~2.1 m wide)
      |
      |      o          o     people: 0.8–2.5 m in front of the
      |     /|\        /|     camera, backs to it, pointing at
      |      |          |     the wall, ≥0.5 m from the lens
      |
      |   2.5–4.0 m camera-to-wall
      v
   [ Kinect v2 ]   centered on the projection, height 1.4–2.0 m,
    (cam0 = room    aimed square at the wall
     origin)

   projector: anywhere that fills the wall without
   shining into the Kinect's lens
```

Kinect v2 depth spec: 512×424, **70.6° × 60°** field of view, reliable range
**~0.5–4.5 m**. That FOV covers roughly:

- horizontal ≈ **1.41 × distance** (2·tan 35.3°)
- vertical ≈ **1.15 × distance** (2·tan 30°)

Placement numbers for a ~2.0–2.4 m wide projected image:

- **Camera 2.5–4.0 m from the wall.** At 2.5 m the depth frame spans
  ~3.5 × 2.9 m — comfortable margin around the projection. Hard ceiling
  ~4.5 m: auto-calibration samples **depth on the wall itself**, and ToF
  depth degrades beyond ~4.5 m (autocal rejects samples outside 0.4–8.0 m,
  but quality falls off well before 8).
- **Centered on the projection, height ~1.4–2.0 m**, aimed square at the
  wall. Roll/tilt need not be perfect — autocal fits the plane in camera
  coordinates — but the FULL projected image must sit inside the depth frame
  with margin.
- **Interaction zone:** people stand **0.8–2.5 m in front of the camera**,
  never closer than **0.5 m** (ToF minimum), fully in frame
  shoulders-to-hands.
- **Projection size:** autocal's sanity gates require the projected image to
  be **1.0–4.5 m wide and 0.7–3.5 m tall**, and the marker grid must span
  ≥1 m in 3D. A desk-scale test projection will fail calibration by design.

Environment:

- **Rigid mount.** Any bump to camera or projector invalidates the
  calibration — recalibrate (it's ~1 minute).
- **No direct sunlight** on the wall or the people (IR interference with the
  ToF depth).
- **Ambient light ON the people.** Pose tracking runs on the color image;
  depth works in the dark but pose does not. A fully dark projected room
  starves the tracker.
- Don't let the projector beam shine into the Kinect lens.

**Aim by eye with the live preview** (after §3 is done): it streams the
Kinect's registered color to the browser with a crosshair + thirds grid —
nudge the camera until the whole projected image sits inside the frame with
margin, then lock the mount down:

```bash
cd gesture-wall && .venv/bin/python -m gesturewall.preview \
  --kind kinect_v2 --serial 010289152747 --port 8802
# open http://localhost:8802/  — Ctrl-C before calibrating/running the room
# (only one process can hold the camera at a time)
```

---

## 3. New-machine install (macOS Apple Silicon)

Ordered; each step assumes the previous one worked. Keep everything **arm64**
— no Rosetta mixing (`uname -m` → `arm64`, `brew --prefix` →
`/opt/homebrew`).

**1. Xcode command-line tools**

```bash
xcode-select --install
```

**2. Homebrew dependencies**

```bash
brew install git cmake pkg-config libusb glfw jpeg-turbo
```

> KINECT.md and the bridge source say `glfw3`; that Homebrew formula was
> renamed — it is **`glfw`** now. (glfw is only needed by libfreenect2's
> OpenGL viewer, but its default cmake wants it.)

**3. Build libfreenect2 from source into `~/.local`**

```bash
git clone https://github.com/OpenKinect/libfreenect2.git
cd libfreenect2 && mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$HOME/.local"
cmake --build . -j"$(sysctl -n hw.ncpu)"
cmake --install .
```

The **`$HOME/.local` prefix is load-bearing**: `gesturewall/kinect.py`
auto-injects only `~/.local/lib` into the bridge's `DYLD_LIBRARY_PATH` when it
spawns it. Install anywhere else (brew, `/usr/local`) and the bridge dies
silently at dylib load unless you export `DYLD_LIBRARY_PATH` yourself in the
shell that runs `run-room.sh`. If cmake fails on a recent macOS, try adding
`-DENABLE_OPENGL=OFF`.

**4. Shell profile exports** (needed by the bridge build; add to `~/.zshrc`)

```bash
export PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig:$PKG_CONFIG_PATH"
export DYLD_LIBRARY_PATH="$HOME/.local/lib:$DYLD_LIBRARY_PATH"
```

**5. Protonect smoke test** — verify sensor + USB before touching this repo:

```bash
./bin/Protonect                    # from the libfreenect2 build dir: color + depth windows
LIBUSB_DEBUG=3 ./bin/Protonect     # if the device is not seen
```

**6. Build the Kinect bridge**

```bash
cd <repo>/gesture-wall
bash native/build_kinect_v2.sh     # produces gesture-wall/bin/kinect-v2-bridge
```

Smoke-test the raw stream (Ctrl+C after a second; the file must have bytes,
stderr shows logs):

```bash
./bin/kinect-v2-bridge > /tmp/k2.bin
ls -lh /tmp/k2.bin
```

**7. Python venv**

```bash
cd <repo>/gesture-wall
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt   # numpy, opencv-python, mediapipe, websockets
```

Python 3.10–3.13 with a mediapipe wheel; mediapipe 0.10.35 is verified on
3.13 / Apple Silicon.

**8. Pose model** — `gesture-wall/models/` ships empty. The server
**auto-downloads** `pose_landmarker_full.task` on first start (atomic
`.part`-rename, safe to interrupt and retry), so the first launch needs
internet. To pre-seed for an offline install (canonical MediaPipe URL, the
same one hardcoded in `gesturewall/sources.py`; ~9.4 MB):

```bash
curl -o gesture-wall/models/pose_landmarker_full.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
```

**9. The room itself**

```bash
cd <repo> && bun install
```

**10. Headless verification (no hardware needed)** — must be green:

```bash
cd gesture-wall && .venv/bin/python -m pytest -q    # full suite, all headless
```

### Linux notes (brief)

apt equivalents: `build-essential cmake pkg-config libusb-1.0-0-dev
libturbojpeg0-dev libglfw3-dev`. Install libfreenect2's udev rules
(`platform/linux/udev/90-kinect2.rules`) so the device opens unprivileged.
`kinect.py` only injects `DYLD_LIBRARY_PATH` (inert on Linux) — export
`LD_LIBRARY_PATH="$HOME/.local/lib:..."` or `ldconfig` the prefix yourself.
`build_kinect_v2.sh` hardcodes `clang++`; swap in `g++` if absent. No sudo is
needed for the Kinect on either OS (the `sudo -E` dance in `run-room.sh` is
Orbbec-only and will not trigger for a kinect config).

---

## 4. Calibration

### 4a. The config

`gesture-wall/room.kinect.json` — single wall `A` (the id **must** be `A`:
the single-window UI subscribes to wall A by default), one Kinect. The
shipped template is a **complete depth-mode config with placeholder
geometry**: a physically-sensible wall plane 2.5 m in front of the camera,
the nominal Kinect v2 IR intrinsics (fx=fy≈365, cx=256, cy=212, 512×424),
an identity extrinsic (this camera is the room origin), and
`serves: ["A"]`. It loads as `mode = depth` out of the box, so `--fake` and
the preview paths exercise the full pipeline immediately; autocal
**overwrites** the plane and intrinsics with measured values on your rig.
Until you calibrate, cursors are emitted against the placeholder plane —
they will NOT land where people point.

```json
{
  "walls": {
    "A": {
      "display": 1,
      "grid": {
        "rows": 2,
        "cols": 3
      },
      "plane": {
        "origin": [-1.05, -0.6, 2.5],
        "u_vec": [2.1, 0.0, 0.0],
        "v_vec": [0.0, 1.2, 0.0]
      },
      "width_m": 2.1,
      "edge_margin": 0.05
    }
  },
  "adjacency": [],
  "cameras": {
    "cam0": {
      "device": "010289152747",
      "kind": "kinect_v2",
      "serves": ["A"],
      "intrinsics": {
        "fx": 365.026,
        "fy": 365.026,
        "cx": 260.115,
        "cy": 202.704,
        "width": 512,
        "height": 424
      },
      "extrinsic": {
        "matrix": [
          [1.0, 0.0, 0.0, 0.0],
          [0.0, 1.0, 0.0, 0.0],
          [0.0, 0.0, 1.0, 0.0],
          [0.0, 0.0, 0.0, 1.0]
        ]
      }
    }
  },
  "calibration": {},
  "fusion": {
    "mode": "highest_confidence",
    "merge_radius": 0.5,
    "track_max_age": 0.5,
    "cross_camera": true
  },
  "server": {
    "ws_port": 8770,
    "http_port": 8000,
    "fps": 30,
    "num_poses": 2,
    "mirror": true,
    "min_confidence": 0.3,
    "model": "models/pose_landmarker_full.task",
    "pointing": "shoulder_hand",
    "smoothing": 2.0
  }
}
```

- **`width_m`**: tape-measure the **projected image's** physical width and
  put it here. Autocal pins its plane fit to this measurement (and refuses a
  fit more than 30% off it), so get it right to a few cm.
- **`device`**: the sensor's 12-digit serial as a string — stable across
  replugs, where an index (`0`) is not. The shipped template is pinned to
  **this project's own Kinect** (serial `010289152747`, read live from the
  sensor), and its intrinsics are that unit's measured `K2IN` values; with a
  different sensor, set its serial (or `0`) — autocal writes the real
  intrinsics on first calibration either way.
- **`edge_margin`**: sticky band at the wall border, as a fraction of wall
  size (`[0, 0.5)`). A single wall has no adjacent-wall seam band, so
  without it a pointing ray drifting a hair past the edge drops the cursor
  instead of clamping; `0.05` clamps within a 5% band. Sticky-only — no
  behavior change while the cursor is on-wall, and it never acquires a
  cursor out of bounds.
- The server block mirrors the production configs: `shoulder_hand` pointing
  (longer, steadier baseline — robust to noisy ToF depth of a thin wrist),
  the `full` pose model, `min_confidence 0.3`, `smoothing 2.0` (raise toward
  2.5 if the cursor is jittery; >4 lags).

An equally valid *minimal* pre-calibration shape is `serves: []` with no
`plane`/`intrinsics`/`extrinsic` at all — autocal fills in everything (the
config loads in homography mode until then, and the server emits no cursors
rather than misplaced ones). What validation rejects is the in-between:
`serves: ["A"]` with no matching geometry.

### 4b. Run autocal

Auto-calibration projects a sweep of magenta discs on the wall, detects each
one in the Kinect's registered color by OFF/ON frame differencing, reads its
3D position from the depth map, and fits the wall plane. ~30–45 s for one
wall, plus up to ~20 s of sensor warmup.

```bash
./run-room.sh --calibrate --config=gesture-wall/room.kinect.json
```

Then:

1. Open **fullscreen on the projector**:
   `http://localhost:8801/autocal.html?wall=A`
   (the page is black with one bright disc; the black background is the
   detection reference, so fullscreen matters).
2. **Step fully out of the camera's view.**
3. Start the sweep:

   ```bash
   curl -X POST http://localhost:8801/calib/start
   # progress: curl http://localhost:8801/calib/status
   ```

4. On success the page automatically becomes the wall client; Ctrl-C the
   script.

Leave `WALL_A_M`/`WALL_B_M` unset — widths come from the config's
`width_m`. (`run-room.sh` ignores a `WALL_B_M` pin that names a wall not in
the config, printing a NOTE.)

**What gets written back into the config:** `walls.A.plane` (the fitted wall
rectangle in the camera=room frame), `cameras.cam0.intrinsics` +
`extrinsic` (identity — this camera is the room origin) + `serves: ["A"]`,
and `fusion.cross_camera`. `width_m`, `display`, and `grid` are never
touched. Raw samples are dumped to `gesture-wall/autocal_samples.json` for
debugging.

**Intrinsics: nothing to do manually.** The runtime never deprojects with
config intrinsics — every frame carries the live per-unit values the bridge
reads from the sensor (`K2IN`, from `getIrCameraParams`), and autocal writes
those same live values into the config. Config intrinsics are effectively
documentation plus the "this camera has depth geometry" flag; the nominal
fx=fy≈365, cx=256, cy=212 you see in examples are replaced by your unit's
real numbers on the first successful calibration. No merge tool needed.

### 4c. Validate

The shipped template already loads as `mode = depth`, so checking the mode
alone cannot tell you calibration happened — check that autocal replaced
the placeholder plane:

```bash
cd gesture-wall && .venv/bin/python -c \
  "from gesturewall.room import RoomConfig; c = RoomConfig.load('room.kinect.json'); \
   print('mode =', c.mode, '| cam0 serves A =', c.serves('cam0','A')); \
   print('calibrated =', list(c.walls['A'].plane.origin) != [-1.05, -0.6, 2.5])"
# expected after autocal:
#   mode = depth | cam0 serves A = True
#   calibrated = True
# calibrated = False means the plane still equals the shipped placeholder —
# autocal has not written this config; run 4b.
```

### 4d. When to recalibrate

Any time the camera or projector moves (even a bump), the projection is
resized/refocused/keystone-adjusted, or you change `width_m`. The plane is a
rigid measurement of *this* camera-vs-wall arrangement; it does not drift on
its own.

Preconditions if calibration fails: projected image ≥1.0 m wide and ≥0.7 m
tall, camera 0.5–4.5 m from the wall and seeing the whole projection, nobody
in frame, no sunlight washing out the discs. A dark-ish room helps detection,
though the differencing cancels static ambient content.

---

## 5. Run

```bash
ROOM_CONFIG=gesture-wall/room.kinect.json ./run-room.sh --single --gesture
```

What happens: the script starts the Python gesture server (spawns the Kinect
bridge, cursors on `ws://localhost:8770`), builds and serves Vibersyn on
`:8788`, and opens ONE fullscreen Chrome window at
`http://localhost:8788/?live=1&view=full&gesture=1&fusion=ws://localhost:8770`.
The window's gesture layer subscribes to wall `A` (the default when no
`&wall=` is present — which is why the config's wall id must be `A`). No
password prompt: the `sudo` path is Orbbec-only, the Kinect needs no
elevation. First launch needs internet once for the pose model (§3 step 8).

Using it:

- **Raise a hand above your shoulder to engage** — a cursor appears where
  your shoulder→hand ray meets the wall.
- **Point** to move the cursor; **hold still ~0.8 s (dwell)** over a bubble
  or button to click it.
- **Guided demo:** dwell the "Guided Demo" HUD button, or add
  `&demo=guided` to the URL, for the coached visitor walkthrough.
- **Mouse fallback:** add `?dwell=mouse` to drive the same
  point→highlight→dwell mechanic with the mouse (no camera).
- **Camera-free test of the whole chain:** `./run-room.sh --fake --single`
  emits synthetic cursors over the same WebSocket protocol.

Voice control, keyboard cheat sheet (`?`), QR import, and the
model/detector env vars are unchanged from desk mode — see the
[README](../README.md) ("Control" and "Model" sections) rather than a copy
here.

---

## 6. Troubleshooting

**Bridge won't build** (`pkg-config --exists freenect2` fails inside
`build_kinect_v2.sh`): libfreenect2 isn't on `PKG_CONFIG_PATH` — install it
to `~/.local` (§3 step 3) and export the §3 step 4 variables in this shell.
The Homebrew formula is named `glfw` now; `glfw3` is a registered old name
that current Homebrew still resolves (upstream libfreenect2 docs and
KINECT.md use the old name).

**Sensor not detected** (Protonect sees nothing / `system_profiler` shows no
"Xbox NUI Sensor"): check the adapter brick has power (the Kinect's own LED
lights), the host-side plug is in a **USB 3** port, no passive hub in the
path, not a VM. Debug USB with `LIBUSB_DEBUG=3 ./bin/Protonect`. Three "Xbox
NUI Motor/Camera/Audio" entries = you have a v1 (§1).

**Protonect works but the room has no cursors** — the failure is usually
silent, in order of likelihood:

- *Bridge binary missing* (`gesture-wall/bin/kinect-v2-bridge` was never
  built): the server log spams `camera 'cam0' read error: [Errno 2] No such
  file or directory` at frame rate. Run §3 step 6.
- *Bridge dies at startup* (dylib not found, device busy, "No Kinect v2
  device found"): it prints ONE stderr line and the server then runs
  cursor-less with no further errors. Run the bridge by hand and read
  stderr: `gesture-wall/bin/kinect-v2-bridge > /tmp/k2.bin`. "Library not
  loaded" ⇒ libfreenect2 isn't in `~/.local` (or export
  `DYLD_LIBRARY_PATH`).
- *Wall not calibrated*: with the shipped template the server DOES emit
  cursors before calibration — against the placeholder plane, so they
  appear but land nowhere near where people point. §4c's `calibrated` line
  distinguishes calibrated from placeholder. (A config stripped to
  `serves: []` / no `plane` instead runs cursor-less.)
- *Person/lighting*: standing closer than 0.5 m or out of frame, or no
  ambient light on the people (pose reads the color image — the projector
  glow alone is usually not enough).
- *Wall id mismatch*: the single window subscribes to wall `A`; a config
  whose wall is named anything else connects and silently receives nothing.

**Pose model missing** (`camera 'cam0' failed to start` once, mentioning the
model, then silence): first launch was offline. Pre-seed per §3 step 8.

**Cursor lands offset from where people point**: the camera or projector got
bumped, or the projection was resized — recalibrate (§4). A wrong `width_m`
skews the horizontal scale specifically.

**Cursor flickers off at the extreme wall edges**: a single wall has no
adjacent wall providing a sticky seam band, so with `edge_margin: 0.0` rays
fractionally past the edge emit nothing rather than clamping. The shipped
config sets `walls.A.edge_margin: 0.05`, which clamps an already-acquired
cursor to the border within a 5% band — raise it (must stay below 0.5) if
flicker persists. Sticky-only: it never acquires a cursor out of bounds.

**Low frame rate / laggy cursor**: the bridge intentionally uses
libfreenect2's CPU pipeline for portability. Apple Silicon generally sustains
the full 30 fps; older Intel machines historically ran ~15–20. The knobs, in
order: `server.model` → `models/pose_landmarker_lite.task` (markedly faster,
auto-downloads by name), `num_poses` → 1, `fps` → 24. MediaPipe pose on the
512×424 color frame is the real cost, not the bridge.
