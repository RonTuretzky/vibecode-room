#!/usr/bin/env python3
"""Standalone REAL-HAND MediaPipe -> pinch websocket bridge.

A drop-in replacement for the TouchDesigner Web Server DAT (`hands_stream.py`
+ `webserver_callbacks.py`): it opens the laptop camera, runs MediaPipe hand
tracking, and streams the *exact same* `vibersyn-pinch` wire protocol on the
same port (9980) that the browser client (`src/ui/gesture/hands-client.ts`)
already speaks. No TouchDesigner, no GPU plugin, no `.toe` file required.

This tracks REAL hands from the camera. There is no synthetic runtime mode:
`--selftest` is a headless CI check that pushes a synthetic-but-realistic
landmark set through the *same* encoding path and asserts the emitted JSON
matches the protocol; it never runs at serve time.

Wire protocol (JSON text frames, byte-compatible with hands-client.ts):

  client -> server (first msg):
      {"type":"hello","client":"vibersyn-pinch","wall":"A"}   (wall optional)

  server -> client (every tick, ~30-60 Hz):
      {"type":"hands","t":<seconds float>,"aspect":<w/h float>,
       "hands":[{"id":<int>,"hand":"Left"|"Right"|null,
                 "x":<0..1>,"y":<0..1>,
                 "pinch":<float ratio>,"pinching":<bool>,"conf":<0..1>}, ...]}

  * (x, y) are normalized [0, 1] with y DOWN (raw MediaPipe screen convention).
    x is MIRRORED (1 - x) by default (--flip) so a user-facing camera behaves
    like a mirror: moving your hand right moves the cursor right. The browser
    does NOT mirror; TouchDesigner mirrored x-side, so we do too.
  * An EMPTY `hands` array is sent EVERY tick when no hands are visible — the
    liveness contract the browser uses to detect a stalled stream.
  * `pinch` is the CONTINUOUS thumb-tip <-> index-tip distance normalized by a
    hand-scale reference (wrist <-> middle-finger-MCP distance). Smaller = more
    pinched. The browser runs its OWN hysteresis on this ratio; `pinching` is a
    latched fallback bool for clients that don't.

The pure encoding (landmarks -> frame dict, pinch math, mirroring, latching,
id assignment) lives at module top and imports NOTHING heavy, so it is unit
testable without cv2/mediapipe/a camera (see tests/test_hands_mediapipe.py).
cv2, mediapipe and websockets are imported lazily inside the runtime paths.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import pathlib
import sys
import threading
import time
import urllib.request
from typing import Optional, Sequence

# --------------------------------------------------------------------------- #
# MediaPipe Hands landmark indices (21-point hand model)                       #
# --------------------------------------------------------------------------- #
WRIST = 0
THUMB_TIP = 4
INDEX_MCP = 5          # index-finger base knuckle
INDEX_TIP = 8
MIDDLE_MCP = 9         # hand-scale reference partner with the wrist
RING_MCP = 13
PINKY_MCP = 17
# Rigid palm anchors: wrist + the four finger base knuckles. Averaging these
# gives the cursor point (see palm_center) — see the docstring on that fn for
# why this beats a single landmark or the thumb/index midpoint.
PALM_LANDMARKS = (WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP)

# Hysteresis thresholds on the hand-scale-normalized thumb-index ratio. These
# only feed the fallback `pinching` bool — the browser is ratio-authoritative
# and runs its own hysteresis on the continuous `pinch` value.
PINCH_ON = 0.30        # ratio below this: start pinching
PINCH_OFF = 0.45       # ratio above this while pinched: stop pinching
PINCH_CAP = 4.0        # the browser clamps pinch to [0, 4]; cap here too

DEFAULT_PORT = 9980
DEFAULT_FPS = 30
DEFAULT_MIN_DETECTION_CONFIDENCE = 0.6
DEFAULT_MIN_TRACKING_CONFIDENCE = 0.5

_THIS = pathlib.Path(__file__).resolve()
_GW_ROOT = _THIS.parent.parent                       # gesture-wall/
DEFAULT_MODEL_PATH = str(_GW_ROOT / "models" / "hand_landmarker.task")
# float16 HandLandmarker bundle (same host/layout the pose model uses).
HAND_MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/"
                  "hand_landmarker/hand_landmarker/float16/latest/"
                  "hand_landmarker.task")

# MediaPipe HandLandmarker reports handedness "assuming the input image is
# mirrored" (selfie). We feed cv2's RAW (non-mirrored) frame, so per Google's
# own guidance we swap Left<->Right to get the true physical hand. This label
# is cosmetic (the browser keys tracks on `id`, not handedness); flip this to
# False if it reads inverted on your rig.
SWAP_HANDEDNESS = True


# --------------------------------------------------------------------------- #
# Pure encoding math (no cv2 / mediapipe / camera — import-testable)           #
# --------------------------------------------------------------------------- #
def _xy(landmarks: Sequence, i: int) -> tuple[float, float]:
    """(x, y) for landmark ``i``.

    Accepts either MediaPipe NormalizedLandmark objects (``.x`` / ``.y``) or
    plain ``(x, y[, z])`` tuples, so tests can pass tuples and the runtime can
    pass MediaPipe objects through the identical code path.
    """
    lm = landmarks[i]
    x = getattr(lm, "x", None)
    if x is None:
        return float(lm[0]), float(lm[1])
    return float(x), float(lm.y)


def _dist(a: tuple[float, float], b: tuple[float, float], aspect: float) -> float:
    """Aspect-corrected 2D distance between two normalized points.

    MediaPipe normalizes x and y independently to [0, 1], so a raw hypot warps
    with the frame's aspect ratio. Multiplying the x delta by aspect (= w / h)
    restores square pixels. Both the pinch numerator AND the hand-scale
    denominator get corrected, and because the two vectors point in different
    directions the correction does NOT cancel out of the ratio — so it matters.
    """
    return math.hypot((a[0] - b[0]) * aspect, a[1] - b[1])


def palm_center(landmarks: Sequence) -> tuple[float, float]:
    """Cursor anchor: centroid of the wrist + four finger base knuckles.

    Chosen over the alternatives on purpose:
      * vs. a single landmark (e.g. index-finger-MCP): averaging five rigid
        palm points cancels per-landmark jitter, giving a steadier cursor.
      * vs. the thumb/index midpoint TouchDesigner used: those tips move as you
        open/close a pinch, dragging the cursor during the very gesture you're
        trying to hold still. Palm knuckles do NOT move when you pinch, so the
        cursor stays put while you pinch-and-drag to orbit.
    """
    sx = sy = 0.0
    for i in PALM_LANDMARKS:
        x, y = _xy(landmarks, i)
        sx += x
        sy += y
    n = len(PALM_LANDMARKS)
    return sx / n, sy / n


def hand_scale(landmarks: Sequence, aspect: float) -> float:
    """Reference length: wrist <-> middle-finger-MCP (aspect-corrected)."""
    return _dist(_xy(landmarks, WRIST), _xy(landmarks, MIDDLE_MCP), aspect)


def pinch_ratio(landmarks: Sequence, aspect: float) -> float:
    """Continuous pinch = |thumb_tip - index_tip| / hand_scale, capped.

    Scale-normalized so it's invariant to how close the hand is to the camera;
    smaller = more pinched. Degenerate hands (zero scale) return the cap.
    """
    scale = hand_scale(landmarks, aspect)
    d = _dist(_xy(landmarks, THUMB_TIP), _xy(landmarks, INDEX_TIP), aspect)
    if scale <= 1e-6:
        return PINCH_CAP
    return min(d / scale, PINCH_CAP)


def _clamp01(v: float) -> float:
    if v < 0.0:
        return 0.0
    if v > 1.0:
        return 1.0
    return v


def latch_pinch(prev: bool, ratio: float,
                on: float = PINCH_ON, off: float = PINCH_OFF) -> bool:
    """Hysteresis latch for the fallback `pinching` bool.

    Not yet pinched -> require ratio < ``on`` to engage; already pinched ->
    stay engaged until ratio > ``off``. The dead band between prevents chatter.
    """
    if prev:
        return ratio < off
    return ratio < on


def assign_hand_ids(labels: Sequence[Optional[str]]) -> list[int]:
    """Map per-hand handedness labels to stable small ids (1, 2, ...).

    Left prefers id 1, Right prefers id 2, so in the common two-hand-zoom case
    (one Left + one Right) each hand keeps a constant id across frames even when
    MediaPipe reorders its result list. Collisions (two same-handed hands, or an
    unknown label) fall back to the lowest free positive slot. The browser keys
    tracks on this id, so stability here is what keeps a hand from teleporting.
    """
    ids: list[Optional[int]] = []
    used: set[int] = set()
    prefer = {"Left": 1, "Right": 2}
    pending: list[int] = []
    for i, label in enumerate(labels):
        slot = prefer.get(label)
        if slot is not None and slot not in used:
            used.add(slot)
            ids.append(slot)
        else:
            ids.append(None)
            pending.append(i)
    for i in pending:
        slot = 1
        while slot in used:
            slot += 1
        used.add(slot)
        ids[i] = slot
    return [int(x) for x in ids]  # type: ignore[arg-type]


class PinchState:
    """Per-hand-id hysteresis memory for the fallback `pinching` bool."""

    def __init__(self) -> None:
        self._latched: dict[int, bool] = {}

    def update(self, hand_id: int, ratio: float) -> bool:
        now = latch_pinch(self._latched.get(hand_id, False), ratio)
        self._latched[hand_id] = now
        return now

    def retain(self, active_ids: set[int]) -> None:
        """Drop the latch for any id not present this tick.

        A hand that leaves and re-enters half-closed might never dip below
        PINCH_ON again; without this reset it would inherit ``pinching:true``
        forever (the same bug the TouchDesigner script guards against).
        """
        for hid in self._latched:
            if hid not in active_ids:
                self._latched[hid] = False


def encode_hand(landmarks: Sequence, hand_id: int, handedness: Optional[str],
                score: float, aspect: float, *, mirror: bool = True,
                pinching: bool = False) -> dict:
    """One protocol hand dict from a hand's landmarks (pure)."""
    cx, cy = palm_center(landmarks)
    if mirror:
        cx = 1.0 - cx
    ratio = pinch_ratio(landmarks, aspect)
    hand = handedness if handedness in ("Left", "Right") else None
    # Compact 21-point skeleton for the in-room debug HUD: [[x,y],...] in the
    # SAME mirrored, normalized [0,1] space as the cursor. Backward-compatible
    # extra field — cursor/pinch consumers ignore it.
    lm = []
    for i in range(21):
        lx, ly = _xy(landmarks, i)
        if mirror:
            lx = 1.0 - lx
        lm.append([round(_clamp01(lx), 3), round(_clamp01(ly), 3)])
    return {
        "id": int(hand_id),
        "hand": hand,
        "x": round(_clamp01(cx), 4),
        "y": round(_clamp01(cy), 4),
        "pinch": round(min(max(ratio, 0.0), PINCH_CAP), 4),
        "pinching": bool(pinching),
        "conf": round(_clamp01(float(score)), 4),
        "lm": lm,
    }


def encode_hands(detections: Sequence[tuple], aspect: float,
                 pinch_state: PinchState, *, mirror: bool = True) -> list[dict]:
    """Encode a frame's detections into protocol hand dicts.

    ``detections`` is a sequence of ``(landmarks, handedness_label, score)``.
    Assigns stable ids, updates the pinch latches, and resets latches for hands
    that vanished this tick.
    """
    labels = [d[1] for d in detections]
    ids = assign_hand_ids(labels)
    out: list[dict] = []
    active: set[int] = set()
    for (landmarks, label, score), hid in zip(detections, ids):
        active.add(hid)
        ratio = pinch_ratio(landmarks, aspect)
        pinching = pinch_state.update(hid, ratio)
        out.append(encode_hand(landmarks, hid, label, score, aspect,
                               mirror=mirror, pinching=pinching))
    pinch_state.retain(active)
    return out


def encode_frame(t: float, aspect: float, hands: Sequence[dict],
                 wall: Optional[str] = None) -> dict:
    """Wrap encoded hands in the top-level `hands` frame.

    ``wall`` is included only when set; the browser accepts a frame whose wall
    is absent, and rejects only when BOTH sides name a wall and they differ.
    """
    frame = {
        "type": "hands",
        "t": round(float(t), 4),
        "aspect": round(float(aspect), 4) if aspect and aspect > 0 else round(16 / 9, 4),
        "hands": list(hands),
    }
    if wall:
        frame["wall"] = wall
    return frame


def frame_to_json(frame: dict) -> str:
    """Compact JSON (no spaces), matching the TouchDesigner DAT's output."""
    return json.dumps(frame, separators=(",", ":"))


def synthetic_landmarks(pinched: bool = False) -> list[tuple[float, float]]:
    """A realistic 21-point right-hand landmark set for --selftest and tests.

    Normalized [0, 1], y-down. Open-hand thumb/index are well separated; when
    ``pinched`` the thumb tip is moved onto the index tip. Only the palm anchors
    (0, 5, 9, 13, 17) and pinch points (0, 4, 8, 9) are load-bearing, but all 21
    are filled so the set is a faithful stand-in for a MediaPipe result.
    """
    pts = [
        (0.50, 0.90),   # 0  wrist
        (0.42, 0.83),   # 1  thumb cmc
        (0.37, 0.77),   # 2  thumb mcp
        (0.34, 0.72),   # 3  thumb ip
        (0.32, 0.68),   # 4  thumb tip
        (0.47, 0.60),   # 5  index mcp
        (0.46, 0.50),   # 6  index pip
        (0.455, 0.43),  # 7  index dip
        (0.45, 0.38),   # 8  index tip
        (0.52, 0.59),   # 9  middle mcp
        (0.52, 0.48),   # 10 middle pip
        (0.52, 0.41),   # 11 middle dip
        (0.52, 0.36),   # 12 middle tip
        (0.57, 0.60),   # 13 ring mcp
        (0.58, 0.50),   # 14 ring pip
        (0.585, 0.44),  # 15 ring dip
        (0.59, 0.39),   # 16 ring tip
        (0.61, 0.63),   # 17 pinky mcp
        (0.63, 0.55),   # 18 pinky pip
        (0.64, 0.50),   # 19 pinky dip
        (0.65, 0.46),   # 20 pinky tip
    ]
    if pinched:
        # Thumb tip meets the index tip -> tiny thumb/index distance.
        pts[THUMB_TIP] = (0.445, 0.385)
    return pts


# --------------------------------------------------------------------------- #
# Camera + MediaPipe runtime (lazy heavy imports; NEVER touched by tests)      #
# --------------------------------------------------------------------------- #
class CameraOpenError(RuntimeError):
    """Raised when cv2.VideoCapture cannot open the requested camera index."""


def _macos_permission_hint(camera: int) -> str:
    return (
        f"\n  Could not read frames from camera {camera}.\n"
        "  On macOS this almost always means the app running this script\n"
        "  (Terminal / iTerm / VS Code / your IDE) does NOT have Camera access.\n"
        "  Fix:\n"
        "    1. System Settings > Privacy & Security > Camera\n"
        "    2. Enable the terminal/IDE app you launched this from.\n"
        "    3. FULLY QUIT that app and reopen it — macOS only applies the\n"
        "       grant on relaunch.\n"
        "  Also check no other app (Zoom, Photo Booth, FaceTime, another run of\n"
        "  this script) is holding the camera, and try a different --camera index."
    )


def _open_fail_message(camera: int, tried: Sequence[str]) -> str:
    return (
        f"Could not OPEN camera {camera} (cv2.VideoCapture failed via "
        f"{', '.join(tried)}). Is the index right? Try --camera 1."
        + _macos_permission_hint(camera)
    )


def ensure_hand_model(path: str = DEFAULT_MODEL_PATH,
                      url: str = HAND_MODEL_URL) -> str:
    """Download the HandLandmarker .task model on first use; return its path.

    Mirrors gesturewall.sources.ensure_pose_model: atomic download to a
    ``.part`` file, renamed into place only on success so an interrupted
    download never caches a truncated model.
    """
    p = pathlib.Path(path)
    if p.exists():
        return str(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".part")
    print(f"[hands] downloading hand model -> {p} ...", flush=True)
    try:
        urllib.request.urlretrieve(url, tmp)  # noqa: S310 (trusted Google URL)
        tmp.replace(p)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    print("[hands] model download complete.", flush=True)
    return str(p)


def _open_capture(camera: int):
    """Open the camera, preferring AVFoundation on macOS. Raises CameraOpenError."""
    import cv2  # lazy
    tried: list[str] = []
    if sys.platform == "darwin" and hasattr(cv2, "CAP_AVFOUNDATION"):
        cap = cv2.VideoCapture(camera, cv2.CAP_AVFOUNDATION)
        tried.append("AVFoundation")
        if cap.isOpened():
            return cap
        cap.release()
    cap = cv2.VideoCapture(camera)
    tried.append("default")
    if cap.isOpened():
        return cap
    cap.release()
    raise CameraOpenError(_open_fail_message(camera, tried))


def open_camera_blocking(camera: int, probe_seconds: float = 6.0):
    """Open + probe the camera; return ``(cap, first_frame)``. Main-thread only.

    MUST run on the process's MAIN thread on macOS: the AVFoundation backend
    requests/applies camera authorization on the main run loop, and opening from
    a worker thread trips OpenCV's "can not spin main run loop from other thread"
    (capture then silently fails even when permission is granted). We therefore
    open here, before the asyncio loop starts, and hand the live capture to the
    inference thread (frame *reads* from another thread are fine).

    A denied camera on macOS can report ``isOpened()`` yet never deliver a frame,
    so we also probe real frames and raise :class:`CameraOpenError` with the
    permission hint if none arrive.
    """
    cap = _open_capture(camera)
    first = None
    deadline = time.monotonic() + probe_seconds
    while time.monotonic() < deadline:
        ok, frame = cap.read()
        if ok and frame is not None and getattr(frame, "size", 0):
            first = frame
            break
        time.sleep(0.03)
    if first is None:
        cap.release()
        raise CameraOpenError(_macos_permission_hint(camera))
    return cap, first


def _detections_from_result(result) -> list[tuple]:
    """MediaPipe HandLandmarkerResult -> [(landmarks, label, score), ...]."""
    out: list[tuple] = []
    hand_landmarks = getattr(result, "hand_landmarks", None) or []
    handedness = getattr(result, "handedness", None) or []
    for i, landmarks in enumerate(hand_landmarks):
        label: Optional[str] = None
        score = 1.0
        if i < len(handedness) and handedness[i]:
            cat = handedness[i][0]
            label = cat.category_name
            score = float(cat.score)
            if SWAP_HANDEDNESS and label in ("Left", "Right"):
                label = "Right" if label == "Left" else "Left"
        out.append((landmarks, label, score))
    return out


class HandTracker(threading.Thread):
    """Background thread: read frames from an ALREADY-OPEN camera -> MediaPipe
    -> latest encoded hands.

    The camera is opened on the main thread (see :func:`open_camera_blocking`)
    and handed in live, because macOS AVFoundation authorization must happen on
    the main run loop. This thread only does the blocking ``cap.read()`` +
    MediaPipe inference (both thread-safe once the capture exists). The asyncio
    broadcast loop reads :meth:`snapshot`. Building the MediaPipe landmarker can
    still fail; that is reported via :attr:`error` / :meth:`wait_ready`.
    """

    def __init__(self, cap, first_frame, model_path: str, *,
                 max_hands: int, min_detection_confidence: float,
                 min_tracking_confidence: float, mirror: bool,
                 preview: bool = False) -> None:
        super().__init__(name="mediapipe-hands", daemon=True)
        self._cap = cap
        self._first = first_frame
        self._model_path = model_path
        self._max_hands = max_hands
        self._min_det = min_detection_confidence
        self._min_trk = min_tracking_confidence
        self._mirror = mirror
        # Debug preview: when on, every frame is annotated (skeleton, pinch
        # ratio, PINCH badge) and JPEG-encoded into _preview_jpeg for the MJPEG
        # HTTP server. cv2.imshow is NOT used — macOS forbids Cocoa windows off
        # the main thread; a browser tab renders the stream instead.
        self._preview = preview
        self._preview_jpeg: Optional[bytes] = None

        self._lock = threading.Lock()
        self._hands: list[dict] = []
        self._aspect = 16 / 9
        self._stamp = 0.0
        self._pinch = PinchState()

        self._stop = threading.Event()
        self._ready = threading.Event()
        self._ready_ok = False
        self.error: Optional[str] = None

    # -- consumer API (called from the asyncio loop) ------------------------ #
    def snapshot(self) -> tuple[list[dict], float, float]:
        with self._lock:
            return list(self._hands), self._aspect, self._stamp

    def preview_jpeg(self) -> Optional[bytes]:
        with self._lock:
            return self._preview_jpeg

    def wait_ready(self, timeout: float) -> bool:
        self._ready.wait(timeout)
        return self._ready_ok

    def stop(self) -> None:
        self._stop.set()

    # -- worker ------------------------------------------------------------- #
    def run(self) -> None:
        try:
            import cv2
            import mediapipe as mp
            from mediapipe.tasks.python import BaseOptions
            from mediapipe.tasks.python.vision import (
                HandLandmarker, HandLandmarkerOptions, RunningMode)
        except Exception as e:  # noqa: BLE001
            self.error = f"failed to import cv2/mediapipe: {e}"
            self._ready.set()
            return

        try:
            options = HandLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=self._model_path),
                running_mode=RunningMode.VIDEO,
                num_hands=self._max_hands,
                min_hand_detection_confidence=self._min_det,
                min_hand_presence_confidence=self._min_det,
                min_tracking_confidence=self._min_trk,
            )
            landmarker = HandLandmarker.create_from_options(options)
        except Exception as e:  # noqa: BLE001
            self.error = f"failed to create HandLandmarker: {e}"
            self._ready.set()
            return

        # Landmarker built; camera already live — release the server to serve.
        self._ready_ok = True
        self._ready.set()

        last_ts_ms = -1
        frame = self._first
        try:
            while not self._stop.is_set():
                if frame is None:
                    ok, frame = self._cap.read()
                    if not ok or frame is None:
                        time.sleep(0.01)
                        continue
                h, w = frame.shape[0], frame.shape[1]
                aspect = (w / h) if h else self._aspect
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                ts_ms = int(time.perf_counter() * 1000)
                if ts_ms <= last_ts_ms:      # detect_for_video needs strictly ++
                    ts_ms = last_ts_ms + 1
                last_ts_ms = ts_ms
                result = landmarker.detect_for_video(mp_image, ts_ms)
                detections = _detections_from_result(result)
                encoded = encode_hands(detections, aspect, self._pinch,
                                       mirror=self._mirror)
                jpeg = None
                if self._preview:
                    # The debug overlay must NEVER kill tracking — a bug here
                    # once crashed the whole thread (and stopped the wall).
                    try:
                        jpeg = _annotate_preview(cv2, frame, detections, encoded,
                                                 mirror=self._mirror)
                    except Exception as e:  # noqa: BLE001
                        print(f"[hands] preview annotate error (tracking "
                              f"unaffected): {e}", flush=True)
                with self._lock:
                    self._hands = encoded
                    self._aspect = aspect
                    self._stamp = time.monotonic()
                    if jpeg is not None:
                        self._preview_jpeg = jpeg
                frame = None
        finally:
            try:
                landmarker.close()
            except Exception:  # noqa: BLE001
                pass
            self._cap.release()


# --------------------------------------------------------------------------- #
# Debug preview (--preview): annotated MJPEG served over HTTP                  #
# --------------------------------------------------------------------------- #
# 21-point hand skeleton edges (MediaPipe hand connections).
_HAND_EDGES = (
    (0, 1), (1, 2), (2, 3), (3, 4),          # thumb
    (0, 5), (5, 6), (6, 7), (7, 8),          # index
    (5, 9), (9, 10), (10, 11), (11, 12),     # middle
    (9, 13), (13, 14), (14, 15), (15, 16),   # ring
    (13, 17), (17, 18), (18, 19), (19, 20),  # pinky
    (0, 17),                                  # palm base
)


def _annotate_preview(cv2, frame, detections, encoded, *, mirror: bool):
    """Draw the debug overlay and return a JPEG, or None on encode failure.

    Drawn on a MIRRORED copy when mirror=True so the preview behaves like a
    mirror (matches the wall's cursor mapping — move right, see right).
    """
    img = cv2.flip(frame, 1) if mirror else frame.copy()
    h, w = img.shape[0], img.shape[1]

    def px(lm) -> tuple[int, int]:
        x = 1.0 - lm[0] if mirror else lm[0]
        return int(x * w), int(lm[1] * h)

    for det, enc in zip(detections, encoded):
        landmarks = det[0]  # detection is (landmarks, label, score)
        pts = [px(_xy(landmarks, i)) for i in range(21)]
        for a, b in _HAND_EDGES:
            cv2.line(img, pts[a], pts[b], (90, 220, 90), 2, cv2.LINE_AA)
        for p in pts:
            cv2.circle(img, p, 3, (60, 180, 255), -1, cv2.LINE_AA)
        # Thumb-tip <-> index-tip: the pinch pair, highlighted.
        cv2.line(img, pts[THUMB_TIP], pts[INDEX_TIP], (0, 90, 255), 3, cv2.LINE_AA)
        # Cursor = palm center (what the wall tracks).
        cx = int(enc["x"] * w)
        cy = int(enc["y"] * h)
        cv2.circle(img, (cx, cy), 11, (255, 200, 0), 2, cv2.LINE_AA)
        pinching = bool(enc.get("pinching"))
        ratio = enc.get("pinch")
        label = f'{enc.get("hand") or "?"} #{enc["id"]}  pinch={ratio:.2f}' if isinstance(ratio, float) else f'{enc.get("hand") or "?"} #{enc["id"]}'
        anchor = (max(8, pts[0][0] - 40), max(24, pts[0][1] - 14))
        cv2.putText(img, label, anchor, cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                    (255, 255, 255), 2, cv2.LINE_AA)
        if pinching:
            cv2.putText(img, "PINCH", (cx - 34, cy - 18),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 90, 255), 3, cv2.LINE_AA)

    if not detections:
        cv2.putText(img, "no hand detected - raise a hand, palm to camera",
                    (16, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                    (40, 40, 230), 2, cv2.LINE_AA)
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 72])
    return buf.tobytes() if ok else None


_PREVIEW_PAGE = b"""<!doctype html><meta charset="utf-8"><title>hands preview</title>
<style>body{margin:0;background:#0b0f1a;display:grid;place-items:center;min-height:100vh;font:14px system-ui;color:#9fb3d1}
img{max-width:100vw;max-height:92vh}p{margin:6px}</style>
<p>vibersyn hands debug &mdash; mirror view, skeleton + pinch. Close this tab anytime; it never affects the wall.</p>
<img src="/stream" alt="camera preview">"""


def start_preview_server(worker, port: int) -> None:
    """Serve the annotated feed: '/' = viewer page, '/stream' = MJPEG.

    Plain http.server in a daemon thread — no Cocoa windows (macOS forbids
    cv2.imshow off the main thread), no extra deps, multiple viewers fine.
    """
    import http.server
    import socketserver

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:  # keep the terminal quiet
            pass

        def do_GET(self) -> None:  # noqa: N802 (http.server API)
            if self.path.rstrip("/") in ("", "/preview"):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(_PREVIEW_PAGE)
                return
            if self.path != "/stream":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type",
                             "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                while True:
                    jpeg = worker.preview_jpeg()
                    if jpeg is not None:
                        self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n")
                        self.wfile.write(f"Content-Length: {len(jpeg)}\r\n\r\n".encode())
                        self.wfile.write(jpeg)
                        self.wfile.write(b"\r\n")
                    time.sleep(1 / 15)  # ~15fps preview is plenty
            except (BrokenPipeError, ConnectionResetError):
                return  # viewer tab closed

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    srv = Server(("", port), Handler)
    threading.Thread(target=srv.serve_forever, name="hands-preview",
                     daemon=True).start()
    print(f"[hands] debug preview -> http://localhost:{port}/  (mirror view, "
          f"skeleton + pinch overlay)", flush=True)


# --------------------------------------------------------------------------- #
# Websocket server (lazy websockets import)                                    #
# --------------------------------------------------------------------------- #
async def run_server(args: argparse.Namespace, cap, first_frame,
                     model: str) -> int:
    from websockets.asyncio.server import serve as ws_serve

    tracker = HandTracker(
        cap, first_frame, model,
        max_hands=args.max_hands,
        min_detection_confidence=args.min_detection_confidence,
        min_tracking_confidence=args.min_tracking_confidence,
        mirror=args.flip,
        preview=args.preview,
    )
    tracker.start()

    loop = asyncio.get_running_loop()
    ready = await loop.run_in_executor(None, tracker.wait_ready, 30.0)
    if not ready:
        print(tracker.error or "hand tracker failed to start",
              file=sys.stderr, flush=True)
        tracker.stop()
        return 2

    if args.preview:
        start_preview_server(tracker, args.preview_port)

    clients: set = set()

    async def handler(websocket) -> None:
        # Wait for the client's hello (informational — the browser sends
        # {"type":"hello",...}), then stream. Reading it also detects an
        # instantly-dropped connection.
        try:
            await websocket.recv()
        except Exception:  # noqa: BLE001
            return
        clients.add(websocket)
        try:
            async for _ in websocket:   # drain further chatter; keep socket live
                pass
        except Exception:  # noqa: BLE001
            pass
        finally:
            clients.discard(websocket)

    stop = asyncio.Event()
    start = time.monotonic()
    period = 1.0 / max(1, args.fps)
    # If the camera thread stalls entirely (no fresh frame), emit EMPTY hands
    # rather than freezing the last pose — honoring the liveness contract.
    stale_after = max(3 * period, 0.25)

    async def broadcast() -> None:
        while not stop.is_set():
            tick = time.monotonic()
            hands, aspect, stamp = tracker.snapshot()
            if stamp == 0.0 or (tick - stamp) > stale_after:
                hands = []
            payload = frame_to_json(
                encode_frame(tick - start, aspect, hands, wall=args.wall))
            if clients:
                await asyncio.gather(
                    *(_safe_send(ws, payload) for ws in list(clients)),
                    return_exceptions=True,
                )
            rest = period - (time.monotonic() - tick)
            try:
                await asyncio.wait_for(stop.wait(), timeout=max(0.0, rest))
            except asyncio.TimeoutError:
                pass

    print(f"[hands] ws     streaming vibersyn-pinch on "
          f"ws://localhost:{args.port}"
          + (f"  wall={args.wall}" if args.wall else ""), flush=True)
    print(f"[hands] fps={args.fps}  max_hands={args.max_hands}  "
          f"mirror={args.flip}  min_det={args.min_detection_confidence}",
          flush=True)
    print(f"[hands] open the room with "
          f"?hands=ws://localhost:{args.port}", flush=True)

    try:
        async with ws_serve(handler, args.host, args.port):
            await broadcast()
    finally:
        stop.set()
        tracker.stop()
    return 0


async def _safe_send(websocket, payload: str) -> None:
    try:
        await websocket.send(payload)
    except Exception:  # noqa: BLE001 - drop handled by handler()
        pass


# --------------------------------------------------------------------------- #
# Self-test (headless CI check — NOT a runtime fake-hands mode)                #
# --------------------------------------------------------------------------- #
def run_selftest() -> bool:
    """Push synthetic-but-realistic landmarks through the real encoding path
    and assert the emitted JSON matches the protocol. No camera, no mediapipe.
    """
    ok = True

    def check(cond: bool, msg: str) -> None:
        nonlocal ok
        if not cond:
            ok = False
            print(f"  FAIL: {msg}", file=sys.stderr)

    aspect = 640 / 480
    detections = [
        (synthetic_landmarks(pinched=False), "Right", 0.98),  # open hand
        (synthetic_landmarks(pinched=True), "Left", 0.93),    # pinched hand
    ]
    hands = encode_hands(detections, aspect, PinchState(), mirror=True)
    payload = frame_to_json(encode_frame(1.5, aspect, hands, wall="A"))
    parsed = json.loads(payload)

    check(parsed.get("type") == "hands", "top-level type == 'hands'")
    check(isinstance(parsed.get("t"), (int, float)), "t is numeric")
    check(isinstance(parsed.get("aspect"), (int, float)) and parsed["aspect"] > 0,
          "aspect is a positive number")
    check(parsed.get("wall") == "A", "wall tag present when --wall set")
    check(isinstance(parsed.get("hands"), list) and len(parsed["hands"]) == 2,
          "exactly two hands emitted")
    check(" " not in payload, "JSON is compact (no whitespace)")

    required = {"id", "hand", "x", "y", "pinch", "pinching", "conf"}
    for hnd in parsed.get("hands", []):
        check(required <= set(hnd), f"hand has all keys {sorted(required)}")
        check(isinstance(hnd.get("id"), int), "id is int")
        check(hnd.get("hand") in ("Left", "Right", None), "hand label valid")
        check(0.0 <= hnd.get("x", -1) <= 1.0, "x in [0,1]")
        check(0.0 <= hnd.get("y", -1) <= 1.0, "y in [0,1]")
        check(0.0 <= hnd.get("pinch", -1) <= PINCH_CAP, f"pinch in [0,{PINCH_CAP}]")
        check(isinstance(hnd.get("pinching"), bool), "pinching is bool")
        check(0.0 <= hnd.get("conf", -1) <= 1.0, "conf in [0,1]")

    open_h, pinch_h = parsed["hands"][0], parsed["hands"][1]
    check(pinch_h["pinch"] < open_h["pinch"],
          "pinched hand's ratio is smaller than the open hand's")
    check(pinch_h["pinching"] is True, "pinched hand latches pinching=true")
    check(open_h["pinching"] is False, "open hand is not pinching")

    cx, _ = palm_center(synthetic_landmarks(False))
    check(abs(open_h["x"] - round(1.0 - cx, 4)) < 1e-9,
          "x is mirrored (1 - palm_center_x)")

    if ok:
        print("[hands] selftest PASS — emitted a protocol-valid frame:")
        print("  " + payload)
    else:
        print("[hands] selftest FAILED.", file=sys.stderr)
    return ok


# --------------------------------------------------------------------------- #
# CLI                                                                          #
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="hands_mediapipe",
        description="Standalone real-hand MediaPipe -> pinch websocket bridge; "
                    "a drop-in for the TouchDesigner Web Server DAT. Streams "
                    "the vibersyn-pinch protocol the room's browser client "
                    "already speaks.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--port", type=int, default=DEFAULT_PORT,
                   help="websocket port (matches the TD DAT default)")
    p.add_argument("--host", default="",
                   help="bind address ('' = all interfaces)")
    p.add_argument("--camera", type=int, default=0,
                   help="cv2 camera index")
    p.add_argument("--fps", type=int, default=DEFAULT_FPS,
                   help="websocket send rate (browser tolerates 10-60)")
    p.add_argument("--min-detection-confidence", type=float,
                   dest="min_detection_confidence",
                   default=DEFAULT_MIN_DETECTION_CONFIDENCE,
                   help="MediaPipe hand detection/presence confidence")
    p.add_argument("--min-tracking-confidence", type=float,
                   dest="min_tracking_confidence",
                   default=DEFAULT_MIN_TRACKING_CONFIDENCE,
                   help="MediaPipe hand tracking confidence")
    p.add_argument("--max-hands", type=int, dest="max_hands", default=2,
                   help="max simultaneous hands")
    p.add_argument("--wall", default=None,
                   help="tag every frame with this wall id (optional)")
    p.add_argument("--flip", action=argparse.BooleanOptionalAction, default=True,
                   help="mirror x (selfie view: hand-right -> cursor-right)")
    p.add_argument("--preview", action="store_true",
                   help="serve an annotated debug camera feed (see yourself, the "
                        "hand skeleton, pinch ratio + PINCH badge) at "
                        "http://localhost:<preview-port>/ — open it in a browser "
                        "tab; never affects the wall")
    p.add_argument("--preview-port", type=int, dest="preview_port", default=9990,
                   help="http port for the --preview debug feed")
    p.add_argument("--model", default=DEFAULT_MODEL_PATH,
                   help="HandLandmarker .task path (auto-downloaded if missing)")
    p.add_argument("--selftest", action="store_true",
                   help="headless protocol self-check (no camera); exits 0/1")
    return p


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.selftest:
        return 0 if run_selftest() else 1

    # Open the camera on the MAIN thread (macOS AVFoundation authorization needs
    # the main run loop), THEN hand the live capture to the inference thread.
    print(f"[hands] opening camera {args.camera} "
          f"(AVFoundation on macOS)...", flush=True)
    try:
        cap, first = open_camera_blocking(args.camera)
    except CameraOpenError as e:
        print(str(e), file=sys.stderr, flush=True)
        return 2
    print(f"[hands] camera {args.camera} live "
          f"({first.shape[1]}x{first.shape[0]}).", flush=True)

    # Fetch the model (download once) before serving.
    try:
        model = ensure_hand_model(args.model)
    except Exception as e:  # noqa: BLE001
        cap.release()
        print(f"[hands] failed to obtain HandLandmarker model: {e}\n"
              f"  Expected at {args.model}\n"
              f"  Download manually:\n"
              f"    curl -L -o '{args.model}' '{HAND_MODEL_URL}'",
              file=sys.stderr, flush=True)
        return 3

    try:
        return asyncio.run(run_server(args, cap, first, model))
    except KeyboardInterrupt:
        print("\n[hands] shutting down.", file=sys.stderr)
        return 0
    finally:
        try:
            cap.release()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    sys.exit(main())
