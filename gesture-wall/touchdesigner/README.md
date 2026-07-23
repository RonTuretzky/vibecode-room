# TouchDesigner pinch-camera source (hands stream on :9980)

TouchDesigner is the **hand source for camera control** in the Vibersyn room
UI: a Web Server DAT streams per-hand pinch frames (30 Hz JSON — protocol
spec in [VIBERSYN.md](../VIBERSYN.md)) to the browser, which turns them into
orbit / flick / zoom / pan on the room camera. Everything is `?hands=` opt-in
on the browser side, and this stream is **fully independent of the :8770
fusion cursors/dwell stream** — nothing in the Python pipeline changes.

**No `.toe` file is committed** (binary); this README *is* the network spec,
and the two `.py` files beside it are drop-in DAT contents:

- [`webserver_callbacks.py`](webserver_callbacks.py) → the Web Server DAT's
  callbacks DAT
- [`hands_stream.py`](hands_stream.py) → an Execute DAT (Frame End)

---

## 1. Install the MediaPipe plugin

Download the **release.zip** of
[torinmb/mediapipe-touchdesigner](https://github.com/torinmb/mediapipe-touchdesigner)
**v0.5.2+** — the release zip, **not** `git clone` (the toxes reference
release-built assets that are not in the source tree). Tested with TD
**2023.11880 / 2025.x**, macOS + Windows, a plain UVC webcam — the **laptop's
built-in camera is all you need** (no depth camera; the Orbbec/:8770 rig is a
separate, independent pipeline); **GPU required**.

1. Drag **`MediaPipe.tox`** into a new project.
2. On the comp's **Webcam page**, pick your webcam (e.g. the built-in
   FaceTime HD camera).
3. Check the camera's actual **capture resolution** on the same page.
   `hands_stream.py` derives the frame aspect from the webcam TOP named by
   its `CAM_OP` constant (`videodevin1`); if your webcam TOP is named
   differently, point `CAM_OP` at it — or, if it can't be found, set the
   `ASPECT` fallback to `width/height` (a 640×480 camera left at the 16:9
   default skews the pinch ratio AND the browser's two-hand zoom).
4. Enable **hand tracking** and set **numHands = 2**.
5. Drag **`toxes/hand_tracking.tox`** in beside it and wire MediaPipe's
   output into it.

---

## 2. Network layout

```
[MediaPipe COMP] → [hand_tracking.tox] → (optional Lag CHOP,      → [Null CHOP
 webcam page,       per-hand landmark      lag 0.05 0.05 —            renamed
 hands ON,          channels               belt+braces; the            "mp_hands"]
 numHands=2                                browser runs its
                                           own 1-Euro filter)

Unconnected — found by NAME, no wires:

[Web Server DAT "handserver"]            [Execute DAT "hands_stream_exec"]
  Port 9980, Active On                     Frame End ON
  Callbacks DAT "handserver_callbacks"     contents ← hands_stream.py
    contents ← webserver_callbacks.py
```

`hands_stream.py` finds `handserver` and `mp_hands` by name (`WS_OP` /
`HANDS_OP` at the top of the script) — rename either operator and the stream
silently sends nothing, so keep the names or edit the constants together.

---

## 3. CHANNEL VERIFICATION (do not skip)

The plugin's CHOP channel names have drifted between releases, so verify
yours before trusting the stream: **middle-click the `mp_hands` Null** and
confirm its channels match the `CHAN` patterns at the top of
`hands_stream.py`. Expected v0.5.x names:

```
h1:thumb_tip:x           (landmark 4)
h1:index_finger_tip:x    (landmark 8)
h1:wrist:x               (landmark 0)
h1:middle_finger_mcp:x   (landmark 9 — hand-scale reference)
h1:hand_active
h1:Leftness              (optional handedness helper)
```

(…and the `:y` siblings, and `h2:*` for the second hand.) If your build
differs — pre-v0.4.3 builds used `Left_hand_*` names — **edit ONLY the
`CHAN` dict** in `hands_stream.py`: every channel read goes through it, and
the script prints **one** `debug()` warning per missing channel group
instead of failing.

---

## 4. Mirroring (10-second sign test)

`MIRROR_X = True` is the default in `hands_stream.py` — a user-facing camera
should behave like a mirror, so moving your hand to **your** right increases
`x`. (`y` is intentionally never flipped; the protocol is y-down, raw
MediaPipe screen convention.)

The test: **pinch and move your hand right — the room should rotate as if
you dragged the mouse right; if inverted, flip `MIRROR_X`.**

---

## 5. Port

**9980** — clear of 8770 (fusion WS), 8781 (gesture-wall http), 8788
(Vibersyn), 8801 (autocal), and it must also differ from the MediaPipe
comp's **internal** web server port (the plugin runs its own). Plain `ws://`
is fine — the room runs over localhost http; the Web Server DAT's **Secure**
parameter (wss) is only needed if the app is ever served over https.

---

## 6. Tuning

All knobs are top-of-file constants in `hands_stream.py`:

- **`PINCH_ON` / `PINCH_OFF`** (0.30 / 0.45) — hysteresis on the
  hand-scale-normalized thumb–index ratio, feeding the `pinching` bool. Note
  the browser is **ratio-authoritative**: it runs its own hysteresis on the
  continuous `pinch` value and only falls back to this bool, so pinch *feel*
  is tuned browser-side (`src/ui/gesture/pinch-cam.ts`); these values only
  matter for fallback clients.
- **`TARGET_HZ`** (30) — send rate, derived from the project cook rate
  (frame-skip, so a 60 fps project still sends ~30 Hz). The browser
  tolerates 10–60 Hz.
- **`CAM_OP`** (`videodevin1`) / **`ASPECT`** (16/9) — the camera frame's
  w/h, used to aspect-correct the pinch ratio and sent on every frame so the
  browser corrects inter-hand distance the same way. Derived live from the
  `CAM_OP` webcam TOP when it exists; `ASPECT` is the fallback — set it to
  your webcam's real aspect if it isn't 16:9 (install step 3).

Empty `hands` frames ARE sent every tick — that is the liveness contract the
browser uses to detect a stalled stream, not a bug.

---

## 7. Smoke test

1. **HTTP status:** open `http://<td-host>:9980/` — the handler returns a
   live one-liner including the WS client count
   (`vibersyn hands stream: N ws client(s)`).
2. **Raw frames:** `bunx wscat -c ws://<td-host>:9980` — you should see one
   `{"type":"hands",...}` frame per tick at ~30 Hz (empty `hands` array with
   no hands in view; per-hand `pinch` ratio dropping below ~0.3 as you
   pinch).
3. **The room:** open Vibersyn with `?hands=ws://<td-host>:9980` (or, from
   the repo root, `./run-room.sh --hands=ws://<td-host>:9980`) — pinch-hold
   one hand and drag to orbit (release with a flick to coast); pinch BOTH
   hands and spread/squeeze to zoom.

No TouchDesigner handy? `./run-room.sh --fake-hands` drives the same browser
path with synthetic hands speaking this exact protocol.

---

## 8. Standalone (no TouchDesigner) — real laptop-camera hands

[`hands_mediapipe.py`](hands_mediapipe.py) is a **drop-in replacement for the
Web Server DAT**: it opens the laptop camera, runs MediaPipe hand tracking
(Python, CPU — no GPU plugin, no `.toe`), and streams the **exact same
`vibersyn-pinch` protocol on the same port 9980** that the browser already
speaks. This tracks **REAL hands from the camera** — it is *not* the
`--fake-hands` synthetic path and not TouchDesigner.

Everything runs from the pre-provisioned venv at `gesture-wall/.venv`
(python3.13; mediapipe, opencv, websockets, numpy already installed).

### Launch

```bash
# from the repo root (cwd doesn't matter — the script uses absolute paths)
gesture-wall/.venv/bin/python \
  gesture-wall/touchdesigner/hands_mediapipe.py \
  --port 9980 --camera 0 --fps 30
```

First run downloads the HandLandmarker model (~7.8 MB) to
`gesture-wall/models/hand_landmarker.task` (auto, cached, gitignored). Then
open the room exactly as with TouchDesigner:

```bash
./run-room.sh --hands=ws://localhost:9980
# or append ?hands=ws://localhost:9980 to the room URL
```

The bridge prints its ws URL on start and streams `{"type":"hands",...}` at
`--fps` (empty `hands` array every tick when no hand is in view — the same
liveness contract). Pinch-hold + drag to orbit; pinch both hands to zoom.

### Flags

| flag | default | notes |
|------|---------|-------|
| `--port` | `9980` | matches the TD DAT / browser default |
| `--camera` | `0` | cv2 index; try `--camera 1` for an external cam |
| `--fps` | `30` | ws send rate (browser tolerates 10–60) |
| `--max-hands` | `2` | matches the two-hand zoom gesture |
| `--min-detection-confidence` | `0.6` | MediaPipe detection/presence gate |
| `--min-tracking-confidence` | `0.5` | MediaPipe tracking gate |
| `--wall A` | *(off)* | tag every frame with a wall id |
| `--flip` / `--no-flip` | on | mirror x (selfie view); see §4 sign test |
| `--model PATH` | `models/hand_landmarker.task` | auto-downloaded if missing |
| `--selftest` | — | headless protocol check, no camera; exits 0/1 |

### What it computes (and why)

- **Cursor `x,y` = palm center** — the centroid of the wrist + four finger
  base knuckles (landmarks 0, 5, 9, 13, 17). These are rigid palm points that
  do **not** move when you pinch, so the cursor holds still while you
  pinch-and-drag; averaging five points also cancels per-landmark jitter.
  (This deliberately differs from the TD plugin's thumb/index midpoint, which
  drifts as the pinch opens and closes.)
- **`pinch`** = aspect-corrected `dist(thumb_tip, index_tip)` divided by the
  hand-scale reference `dist(wrist, middle_finger_mcp)` — scale-invariant,
  smaller = more pinched. The browser runs its own hysteresis on this
  continuous value; `pinching` is the latched fallback bool.
- **`x` is mirrored** (`1 - x`) by default so moving your hand right moves the
  cursor right (the browser does not mirror). `y` is never flipped (protocol
  is y-down).
- **`id`** is assigned by handedness (Left→1, Right→2, collisions fall back to
  the lowest free slot) so a hand keeps a stable id across frames — the
  browser keys its tracks on `id`. `hand` (Left/Right) is cosmetic; because we
  feed cv2's non-mirrored frame, MediaPipe's handedness is swapped to report
  the true physical hand (flip `SWAP_HANDEDNESS` in the script if it reads
  inverted on your rig).

### macOS camera permission (READ THIS if it won't open)

The camera is opened on the **main thread** (AVFoundation authorization must
run on the main run loop). If the camera can't open, the script prints a clear
error and exits non-zero. The usual cause on macOS is that the **app you
launched from** (Terminal / iTerm / VS Code) lacks Camera access:

> System Settings → Privacy & Security → **Camera** → enable your terminal/IDE
> app, then **fully quit and reopen it** (macOS only applies the grant on
> relaunch). Also make sure no other app (Zoom, Photo Booth, another run of
> this script) is holding the camera; try a different `--camera` index.

### Verify without a camera

```bash
# unit tests for the pure pinch/frame-encoding math (no cv2/mediapipe/camera):
gesture-wall/.venv/bin/python -m pytest gesture-wall/tests/test_hands_mediapipe.py

# headless protocol self-check — pushes a synthetic-but-realistic landmark set
# through the SAME encoding path and asserts the emitted JSON matches the
# protocol. This is a CI/verification check only, NOT a runtime fake-hands mode
# (the real runtime always uses the camera):
gesture-wall/.venv/bin/python gesture-wall/touchdesigner/hands_mediapipe.py --selftest
```
