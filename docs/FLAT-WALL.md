# Flat wall, two projections, two Kinect v2 cameras

The rig this doc covers: ONE flat wall carrying TWO side-by-side projections
(no 90° corner), the left half (wall A) watched by one Kinect v2 and the right
half (wall B) by the other. Config: `gesture-wall/room.flat-2kinect.json` —
wall A ← serial `010289152747` (verified by aiming preview 2026-08-05), wall
B ← serial `072843433747`. If the units ever swap sides, swap each camera's
`device` AND `intrinsics` together (intrinsics are per-unit).

Wall ids keep their usual meaning — "A" and "B" are the two *projections*
(display 1 and display 2), they just happen to be coplanar. Runtime geometry is
angle-agnostic: rays intersect each wall's own plane and land via that wall's
(u, v) bounds, so coplanar wall rects work exactly like a corner does
(`gesturewall/geometry.py`, `gesturewall/depth_fusion.py`).

An all-Kinect rig needs **no sudo anywhere** — the `sudo -E` dance in
run-room.sh is Orbbec-only and never triggers for this config.

## Why this config is shaped the way it is

- **One camera per wall, disjoint (`cam0`→A, `cam1`→B).** This is what makes
  auto-calibration pick DECOUPLED mode automatically (inferred from the
  one-camera-per-wall partition, `gesturewall/autocal.py`). The joint autocal
  path hard-codes the 90° corner (`ANGLE_RANGE`, "wall angle not corner-like")
  and would abort on a flat layout; decoupled mode has no inter-wall angle
  gates.
- **`fusion.cross_camera: false`.** Each wall's plane lives in its own
  camera's frame with an identity extrinsic; the two frames are never
  registered against each other. With that declared, tracking never merges
  observations across cameras, and the validator requires exactly one serving
  camera per wall — which this rig satisfies by construction.
- **Empty `adjacency`, `edge_margin: 0.05` per wall.** Seam handoff can't work
  across unregistered frames, so instead each wall gets its own sticky edge
  band: a cursor near the seam clamps to the edge rather than dying instantly.
  A person drives whichever half their own camera watches.
- **The filename contains "kinect" on purpose** — `run-room.sh` refuses to
  seed a missing `*kinect*`/`*depth*` config from the legacy 2D webcam
  example, so a typo'd path hard-errors instead of silently running the
  homography pipeline.

## Bring-up

Deps: same as KINECT-SINGLE-WALL.md — `requirements.txt` into a venv (or point
`PYTHON=` at an existing one) plus the bridge:

```sh
cd gesture-wall
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
bash native/build_kinect_v2.sh   # needs libfreenect2 under $HOME/.local
```

USB topology matters: TWO Kinect v2 streams need two real USB 3 controllers —
separate buses, no cheap passive hubs (KINECT.md §hardware). One starved
stream looks like "one wall dead", not an error. Verify both sensors are
visible before calibrating:

```sh
system_profiler SPUSBDataType | grep -c "Xbox NUI Sensor"   # want: 2
```

## Calibrate (per-wall, decoupled — runs automatically)

Tape-measure the LIT width of each projected image, then (no sudo prompt):

```sh
WALL_A_M=<left width in m> WALL_B_M=<right width in m> \
  ./run-room.sh --calibrate --config=gesture-wall/room.flat-2kinect.json
```

Then, as usual: open `autocal.html?wall=A` and `?wall=B` fullscreen on their
projectors, step out of view, `curl -X POST http://localhost:8801/calib/start`.
Autocal logs "decoupled: per-camera frames" on success and writes planes +
`serves` + identity extrinsics + `cross_camera: false` back into the config.

The shipped planes in the config are placeholders from earlier rigs: cursors
appear before calibration but land WRONG until autocal overwrites them (same
placeholder-plane trap as the Kinect template, KINECT-SINGLE-WALL.md).

## Run

```sh
./run-room.sh --flat --gesture --config=gesture-wall/room.flat-2kinect.json
```

Double wall mode is the default (two fullscreen windows, wall A + wall B).
`WALL_A_POS`/`WALL_B_POS` place the windows (defaults `0,0` / `1920,0` —
adjust to your display arrangement).

**`--flat` makes the pair ONE continuous picture.** Without it each window
renders the full room from its own camera — two disconnected copies, which
reads fine on the old corner rig but looks broken side by side. With `--flat`
(`&flat=1` on the wall URLs) the windows lock into halves of a single wide
frustum — shared eye, one view direction, per-window `setViewOffset` — so
content slides seamlessly from wall A onto wall B (`src/ui/flat-lock.ts`; the
corner rig's yawed-pair equivalent is `src/ui/corner-lock.ts`). It works in
desk mode too (`./run-room.sh --flat`), where it also disables per-window
drag/zoom/fit — a rigid pair may not move. Framing knobs live in
`flat-lock.ts`: `FLAT_TOTAL_HORIZONTAL_FOV_DEG` (110°),
`FLAT_EYE_DISTANCE`/`FLAT_EYE_HEIGHT` (20 m / 4.6 m).

## History

This rig replaced two earlier ones: the 90° corner pair (one camera seeing
both walls — `room.json`/`room.2cam.json`, GEMINI.md/KINECT.md) and a briefly
planned mixed Gemini 335 + Kinect variant of this same flat wall
(`room.flat-kinect-gemini.json`, dropped before ever being calibrated — going
all-Kinect removed the macOS sudo requirement entirely).
