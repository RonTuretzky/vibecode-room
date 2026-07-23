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
