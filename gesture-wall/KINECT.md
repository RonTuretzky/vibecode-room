# Kinect v2 depth-ray pointing on macOS

This is the **depth-mode** path for Gesture Wall. Where the default 2D path maps a
wrist's *image position* onto a wall through a per-(camera, wall) homography, the
depth path casts a **ray from the eye through the hand** and intersects it with
the **physical wall plane in the room frame**. Where the ray pierces the wall is
where you are pointing — and that is **invariant to where you stand** (see
[Why ray pointing enables roaming](#why-ray-pointing-enables-roaming)). A person
can roam the room and still point at a tile.

Depth mode is **opt-in**: it activates when the room config is in depth mode (every
camera that serves a wall has `intrinsics` + `extrinsic`, and every served wall has
a `plane`). The default homography path is unchanged, and the same
`gesturewall.server`, the same `Track`/`Cursor`, and the same `web/wall.html`
clients serve both modes.

> **Hardware/SDK reality.** On macOS there is **no** Microsoft skeleton/body-tracking
> SDK. `libfreenect2` gives us registered color + undistorted depth (both 512×424,
> pixel-aligned) and the IR camera intrinsics — that is all we rely on. We run
> **MediaPipe PoseLandmarker on the registered color** for 2D keypoints, then read
> each keypoint's depth from the aligned depth map and deproject it to 3D. The
> native C++ bridge (`native/kinect_v2_bridge.cc`) **cannot be compiled or tested
> without `libfreenect2` and the physical sensor.**

---

## 0. What you need (hardware)

- A **Kinect v2 / Xbox One Kinect** sensor.
- The **Kinect Adapter for Windows / Xbox One S/X** (power brick + USB 3.0). This
  is required — the Kinect v2 plug is proprietary and needs the adapter to provide
  power and a standard USB 3 connection.
- A real **USB 3.0** path into the Mac. Connect direct to the machine or through a
  high-quality USB-C dock; **avoid cheap passive hubs and VMs** — libfreenect2's
  USB 3.0 isochronous transfer is bandwidth-delicate.
- For two-Kinect rooms (one per wall), two sensors + two adapters + two free USB 3
  controllers. Bandwidth is the limiting factor; prefer separate USB buses.

Quick visibility check once it is plugged in and powered:

```bash
system_profiler SPUSBDataType | grep -i -A12 -E "kinect|xbox|microsoft|nui"
```

---

## 1. Install libfreenect2 (macOS)

Install the toolchain and libfreenect2's dependencies, then build it from source.

```bash
# Xcode command-line tools (once):
xcode-select --install

# Homebrew dependencies:
brew update
brew install git cmake pkg-config libusb glfw3 jpeg-turbo

# Build + install libfreenect2 into ~/.local:
git clone https://github.com/OpenKinect/libfreenect2.git
cd libfreenect2
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$HOME/.local"
cmake --build . -j"$(sysctl -n hw.ncpu)"
cmake --install .
```

Put libfreenect2 on your library + pkg-config paths (add these to your shell
profile so the bridge build and run can find it):

```bash
export PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig:$PKG_CONFIG_PATH"
export DYLD_LIBRARY_PATH="$HOME/.local/lib:$DYLD_LIBRARY_PATH"
```

Verify the sensor end-to-end with libfreenect2's own viewer before touching this
project:

```bash
./bin/Protonect            # from the libfreenect2 build dir; shows color + depth
# If the device is not seen, report USB details with:
LIBUSB_DEBUG=3 ./bin/Protonect
```

**Apple Silicon note:** keep one architecture throughout. `uname -m` should be
`arm64`, `brew --prefix` should be `/opt/homebrew`, and your Python/Node should be
arm64 too — mixing Rosetta x86_64 with arm64 Homebrew libraries breaks native
linking.

---

## 2. Build the Kinect v2 bridge

The bridge (`native/kinect_v2_bridge.cc`) opens the default Kinect (CPU pipeline
for portability), runs `libfreenect2::Registration::apply` to produce a 512×424
**registered color** and **undistorted depth** that are pixel-aligned, and emits a
binary protocol on **stdout** (logs go to **stderr**):

- **`K2IN`** once at start: `fx, fy, cx, cy` (`float32` LE, from
  `getIrCameraParams`) then `width=512, height=424` (`uint32` LE).
- **`K2RG`** per frame: `uint32` LE `timestamp, width(512), height(424)`; then
  `512*424*3` bytes `uint8` BGR registered color; then `512*424` `float32` LE depth
  in **millimetres** (libfreenect2's native unit).

Build it (the script wraps `clang++ -std=c++17 ... $(pkg-config --cflags --libs
freenect2)` and writes `bin/kinect-v2-bridge`):

```bash
bash native/build_kinect_v2.sh
# produces ./bin/kinect-v2-bridge
```

Smoke-test the raw stream (Ctrl+C after a second; it must produce bytes):

```bash
./bin/kinect-v2-bridge > /tmp/k2.bin   # stderr shows logs; stdout is binary
ls -lh /tmp/k2.bin
```

> The bridge requires `libfreenect2` and a connected Kinect v2; it cannot be built
> or run on a machine without both. Everything downstream (Python parsing, geometry,
> fusion) is unit-tested headless with hand-built bytes and synthetic frames — see
> [Testing](#9-testing).

The Python side (`gesturewall.kinect.KinectV2Source`) spawns `bin/kinect-v2-bridge`,
parses `K2IN` + `K2RG` into frames, and converts depth **mm → metres** at the
boundary so all geometry downstream is metric:

```
color   : numpy uint8   512×424×3 BGR (registered)
depth_m : numpy float32 512×424     metres (= bridge mm / 1000)
intr    : CameraIntrinsics(fx, fy, cx=256, cy=212, width=512, height=424)
```

---

## 3. Write the depth `room.json`

A depth-mode config differs from the homography schema only in: each camera
declares `kind: "kinect_v2"` + `intrinsics` + `extrinsic`, each wall declares a
`plane`, and the `calibration` block may be empty. Start from the shipped instance:

```bash
cp room.example.depth.json room.depth.json
```

`room.example.depth.json` is a valid 2-wall (A, B) / 2-Kinect (cam0 serves A,
cam1 serves B) depth-mode room:

```json
{
  "walls": {
    "A": { "display": 1, "grid": { "rows": 2, "cols": 3 },
           "plane": { "origin": [0.0, 2.0, 3.0],
                      "u_vec":  [2.0, 0.0, 0.0],
                      "v_vec":  [0.0, -2.0, 0.0] } },
    "B": { "display": 2, "grid": { "rows": 2, "cols": 3 },
           "plane": { "origin": [2.0, 2.0, 3.0],
                      "u_vec":  [2.0, 0.0, 0.0],
                      "v_vec":  [0.0, -2.0, 0.0] } }
  },
  "adjacency": [ { "left": "A", "right": "B", "seam_margin": 0.06 } ],
  "cameras": {
    "cam0": { "device": 0, "kind": "kinect_v2", "serves": ["A"],
              "intrinsics": { "fx": 365.0, "fy": 365.0, "cx": 256.0, "cy": 212.0,
                              "width": 512, "height": 424 },
              "extrinsic": { "matrix": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]] } },
    "cam1": { "device": 1, "kind": "kinect_v2", "serves": ["B"],
              "intrinsics": { "fx": 365.0, "fy": 365.0, "cx": 256.0, "cy": 212.0,
                              "width": 512, "height": 424 },
              "extrinsic": { "R": [[0,0,1],[0,1,0],[-1,0,0]], "t": [4.0, 0.0, 1.0] } }
  },
  "calibration": {},
  "fusion": { "mode": "highest_confidence", "merge_radius": 0.35, "track_max_age": 0.5 },
  "server": { "ws_port": 8770, "http_port": 8000, "fps": 30, "num_poses": 4,
              "mirror": true, "min_confidence": 0.5,
              "model": "models/pose_landmarker_lite.task" }
}
```

What each block means (all distances are **metres in the room frame**):

- **Room frame** is right-handed, **+Y up**, floor = the XZ plane. The first Kinect
  is the origin (identity extrinsic), so the room frame *is* cam0's camera frame.
- **`walls.<id>.plane`** is a finite rectangle: `origin` is the **top-left** corner
  `(u=0, v=0)`, `u_vec` spans to the **top-right** `(u=1, v=0)`, `v_vec` spans to
  the **bottom-left** `(u=0, v=1)`. A ray hit returns `(u, v)` which are exactly
  the wall-normalized cursor coords (`Cursor.x`/`.y`) the rest of the pipeline and
  the wall clients already speak. In the example, `v_vec` is negative-Y because
  `+Y` is up and the wall's `v` axis grows **downward**.
- **`cameras.<id>.intrinsics`** are the Kinect v2 IR pinhole params for the 512×424
  registered frame (`fx=fy≈365`, `cx=256`, `cy=212`).
- **`cameras.<id>.extrinsic`** maps **CAMERA → ROOM** and accepts either a full
  `4×4 "matrix"` (row-major) **or** `R` (3×3) + `t` (3), which `Extrinsic.from_rt`
  assembles. cam0 is identity; cam1 carries a rotated/translated pose so the two
  Kinects agree on one room.
- **`calibration`** may be `{}` (or omitted) in depth mode — no `cam->wall`
  homography is required.
- **`kind: "kinect_v2"`** on a camera is what selects the depth source at runtime.

Camera coordinate convention (must match how you measure points for calibration):
**CAMERA frame is OpenCV** — `+Z` forward into the scene, `+X` right, `+Y` down;
depth is `+Z`. Pinhole deproject: `X = (px−cx)·d/fx`, `Y = (py−cy)·d/fy`, `Z = d`.

Validate the config loads in depth mode:

```bash
.venv/bin/python -c "from gesturewall.room import RoomConfig; \
  c = RoomConfig.load('room.depth.json'); print('mode =', c.mode)"
# expected: mode = depth
```

---

## 4. Calibrate the room (two measurements)

Depth mode needs two metric measurements, both written through pure config-merge
helpers in `gesturewall.calibrate` that round-trip through `room.json` (and are
unit-tested without a camera). Unlike the homography path, 3D corner/point probing
is application-specific, so these are driven from a tiny Python script rather than
the interactive `--camera/--wall` capture loop (which remains the homography flow).

### 4a. Wall planes (corners → plane)

For each wall, measure the room-frame 3D coordinates of three corners —
**top-left, top-right, bottom-left** — then build a `WallPlane` and merge it:

```python
from gesturewall import geometry, calibrate

cfg = calibrate.load_config_dict("room.depth.json")

# Three measured room-frame corners of wall A (metres):
plane_A = geometry.plane_from_corners(
    top_left =( 0.0, 2.0, 3.0),
    top_right=( 2.0, 2.0, 3.0),
    bottom_left=(0.0, 0.0, 3.0),
)
cfg = calibrate.merge_wall_plane(cfg, "A", plane_A)   # writes walls.A.plane

calibrate.save_config_dict("room.depth.json", cfg)
```

`plane_from_corners` sets `origin = top_left`, `u_vec = top_right − top_left`,
`v_vec = bottom_left − top_left`. It round-trips straight back through
`RoomConfig.wall_plane("A")`.

> **How to get room-frame corners.** With cam0 = room origin, point the sensor at
> the wall and read the registered depth at each corner pixel, deproject with the
> IR intrinsics, and (since cam0's extrinsic is identity) that camera point *is* the
> room point. For walls only seen by another camera, deproject in that camera's
> frame and apply its extrinsic (`RoomConfig.extrinsic(cam).apply(p)`).

### 4b. Second-camera pose (correspondences → extrinsic)

The first Kinect is the room origin (identity extrinsic). Register each additional
Kinect by capturing **≥3 non-collinear** point correspondences — the same physical
points expressed both in the room frame and in that camera's frame — and solving
for its CAMERA→ROOM transform:

```python
from gesturewall import geometry, calibrate
from gesturewall.geometry import CameraIntrinsics

cfg = calibrate.load_config_dict("room.depth.json")

# Same physical markers, measured two ways:
room_pts = [( 4.0, 0.0, 1.0), ( 4.0, 2.0, 1.0), ( 2.0, 0.0, 3.0), ( 2.0, 2.0, 3.0)]
cam1_pts = [( 2.0, 0.0, 0.0), ( 2.0, 2.0, 0.0), ( 0.0, 0.0, 2.0), ( 0.0, 2.0, 2.0)]

extr = calibrate.extrinsic_from_correspondences(room_pts, cam1_pts)  # Kabsch/Umeyama
intr = CameraIntrinsics(fx=365.0, fy=365.0, cx=256.0, cy=212.0, width=512, height=424)

cfg = calibrate.merge_camera_pose(cfg, "cam1", intr, extr, kind="kinect_v2")
calibrate.save_config_dict("room.depth.json", cfg)
```

`extrinsic_from_correspondences(src_room_pts, observed_cam_pts)` wraps
`geometry.rigid_transform_from_points` (Kabsch/Umeyama via SVD, det-correction for
reflection) and recovers the rigid transform that maps the camera points onto the
room points. `merge_camera_pose` writes `kind` + `intrinsics` + a 4×4 `extrinsic`
matrix; both round-trip through `RoomConfig.intrinsics("cam1")` /
`RoomConfig.extrinsic("cam1")`.

> **Why this matters.** Two sensors only share a room frame as well as their
> registered extrinsics. A sloppy second-camera registration shifts that camera's
> rays and the cursor lands on the wrong tile — register carefully, with well-spread
> non-collinear points.

After both measurements, re-validate:

```bash
.venv/bin/python -c "from gesturewall.room import RoomConfig; \
  c = RoomConfig.load('room.depth.json'); \
  print('mode =', c.mode, '| serves cam1->B =', c.serves('cam1','B'))"
```

---

## 5. Run

Start the server against the depth config (mode-aware: it builds the
`DepthFusionEngine` and a `KinectPoseSource` per camera automatically when
`config.mode == "depth"`), then open one wall client per projector:

```bash
# 1) Build the bridge once (needs libfreenect2 + the sensor):
bash native/build_kinect_v2.sh

# 2) Server: spawns the Kinect bridge per camera, fuses rays, serves web/ + WS:
.venv/bin/python -m gesturewall.server --config room.depth.json
#   overrides: --ws-port 8770 --http-port 8000 --fps 30 --num-poses 4

# 3) Wall clients (one fullscreen browser per projector), from the http origin:
#   http://localhost:8000/wall.html?wall=A&server=ws://localhost:8770&rows=2&cols=3
#   http://localhost:8000/wall.html?wall=B&server=ws://localhost:8770&rows=2&cols=3
```

To use it: raise a hand above the shoulder to **engage** (a cursor appears where
the eye→hand ray meets the wall), aim by moving the hand, and **dwell** (~0.8 s) to
toggle the tile. Press `f` in a wall client for fullscreen. The WebSocket protocol,
per-cursor smoothing + dwell, and the shared per-zone lock are identical to the 2D
path — only the *source of the cursor coordinate* changed.

> **No camera?** The whole decision core is camera-free. A depth-mode config plus
> scripted `Person`s carrying rays driven through `gesturewall.server.step_pipeline`
> yields the same per-wall cursors with no sensor — that is exactly what
> `tests/test_server_pipeline.py` exercises.

---

## 6. End-to-end data flow

```
Kinect v2 ──libfreenect2 Registration::apply──▶ registered color 512×424 BGR
  (USB3)                                         undistorted depth 512×424 (mm)
     │ native/kinect_v2_bridge.cc  (K2IN once, then K2RG per frame, stdout)
     ▼ gesturewall/kinect.py : KinectV2Source.parse_frames
   (color uint8 512×424×3 BGR, depth_m float32 512×424 = mm/1000, intr)
     │  + fixed extrinsic from room.json (per camera)
     ▼ gesturewall/depth.py : KinectPoseSource (LAZY mediapipe)
   MediaPipe PoseLandmarker(VIDEO, num_poses) on color ──▶ per-pose landmarks
     ▼ keypoints_from_landmarks(landmarks, 512, 424)   → pixel (px,py,vis) dict
     ▼ build_person3d(kps, depth_m, intr, extr, mirror)               [PURE]
        for each of {eye-origin, wrist, hip-centroid, shoulder}:
           sample_depth → metres → intr.deproject → extr.apply  → ROOM 3D
        ray     = Ray(origin = eye_room (fallback shoulder_room),
                      direction = wrist_room − origin)
        room_xy = floor_xy(hip_centroid_room) = (x, z)
        Person(..., ray=ray, room_xy=room_xy)
     ▼ gesturewall/server.py : step_pipeline (MODE-AWARE)
   persons_to_room_obs: prefer person.room_xy (already room floor coords)
   Tracker.update                              → list[Track]  (stable ids)
   DepthFusionEngine.update (subclass of FusionEngine):
       _candidates_for_track: intersect each member.person.ray with
           config.wall_plane(wall) → (u,v,t); in-bounds if 0≤u,v≤1
       choose_wall (INHERITED hysteresis) · clamp · emit         → Cursor
     ▼ WS broadcast (unchanged protocol)  →  wall.html?wall=A / wall=B
```

The only genuinely new geometry is `build_person3d` (pixel + depth → room ray) and
`WallPlane.intersect` (ray → wall hit). Everything downstream of `Track` —
clustering, identity, seam hysteresis, clamping, `Cursor` emission, the WS protocol,
and the wall clients — is reused unchanged.

---

## 7. Why ray pointing enables roaming

A homography `H: image → wall` is a **fixed** 2D→2D map, solved once by asking one
person standing in one spot to point at the four wall corners. It encodes a single
answer to "where on the wall does *this* image pixel mean?" — an answer that is only
correct for a body in roughly that calibration pose and place. Move the pointer two
metres sideways and the same arm gesture lands on a different image pixel, which `H`
faithfully maps to the **wrong** tile. The map has no notion of the person's 3D
position, so it cannot compensate for it. This is the "2D absolute pointing,
location-locked" limitation of the default path.

The fix is what a laser pointer already does: cast a **ray from the eye through the
hand** and intersect it with the **physical wall plane**. Where the ray pierces the
wall is where you are pointing — and that is invariant to standing position, because
**both endpoints (eye, hand) are measured in the same room-frame metric space as the
wall**. Walk anywhere; as long as the eye→hand line still crosses the wall rectangle,
the hit `(u, v)` is the tile you mean. This needs 3D positions of the eye and the
hand, which a plain RGB camera cannot give — but a depth camera does.

```
 homography path (location-locked)        depth-ray path (roaming-invariant)
 ───────────────────────────────         ──────────────────────────────────
  wrist image px ──H──▶ wall (u,v)         eye_room ─┐
       ▲                                             ├─ Ray ─▶ WallPlane.intersect ─▶ (u,v,t)
  one fixed 2D map, valid only             hand_room ┘        (u,v) on the physical wall,
  near the calibration spot                          same room metric as the wall =>
                                                      answer independent of where you stand
```

---

## 8. Limitations (depth path)

- **No skeleton on macOS** — pose comes from MediaPipe-on-color, so depth quality
  rides on color-pose quality. Missing/zeroed depth at a keypoint reduces confidence;
  if the **wrist or eye origin** has no valid depth, the `Person` is dropped (no ray
  rather than a wrong ray).
- **Extrinsic accuracy gates multi-Kinect agreement** — two sensors share a room
  frame only as well as their registered extrinsics; a sloppy second-camera
  registration shifts its rays.
- **Sensor reality** — Kinect v2 needs USB 3.0 and is bandwidth-delicate; the CPU
  pipeline trades frame-rate for portability. The bridge cannot be built or tested
  without `libfreenect2` + hardware.
- **Identity is still position-only** — the `Tracker` is unchanged, so two people
  crossing within `merge_radius` can swap ids, and a fully occluded body drops out
  until re-seen.

---

## 9. Testing

The full suite runs headless — no camera, no `cv2`/`mediapipe`/`libfreenect2` at
runtime for the pure logic. The depth path is exercised with hand-built bytes and
synthetic constant-depth maps:

```bash
.venv/bin/python -m pytest -q                          # whole suite (must stay green)
.venv/bin/python -m pytest -q tests/test_geometry.py    # deproject/project, ray/plane, Kabsch
.venv/bin/python -m pytest -q tests/test_room.py        # depth-mode load, mode, accessors, serves
.venv/bin/python -m pytest -q tests/test_depth.py       # keypoints, build_person3d ray, engage
.venv/bin/python -m pytest -q tests/test_depth_fusion.py # ray/plane candidates, seam hysteresis
.venv/bin/python -m pytest -q tests/test_kinect.py      # K2IN/K2RG parser, shapes + units
.venv/bin/python -m pytest -q tests/test_calibrate.py   # plane/pose merge round-trips, extrinsic
.venv/bin/python -m pytest -q tests/test_server_pipeline.py # depth-mode step_pipeline -> cursors
```

The native bridge (`native/kinect_v2_bridge.cc`) and the live sources
(`KinectV2Source`, `KinectPoseSource`) are **not** tested here — they need
`libfreenect2` + the sensor + mediapipe — but every byte-parsing and geometry seam
beneath them is covered by the tests above.
