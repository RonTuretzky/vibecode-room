"""Pointer sources: where the cursor position comes from each frame.

Two implementations share one interface so the rest of the app (filtering,
dwell selection, rendering) is identical regardless of input:

  * MouseSource - drives the cursor from the mouse over the window. Needs no
    camera and no MediaPipe, so you can exercise the *entire* selection
    pipeline (zones, dwell, ring, smoothing, hysteresis, cooldown) on any
    machine. Use this to develop and demo.

  * PoseSource - the real thing: a webcam + MediaPipe Tasks PoseLandmarker.
    It tracks the body, picks the raised hand, and reports the wrist position.
    "Engaged" = hand raised above the shoulder (arm-raise to engage, arm-drop
    to disengage), matching the recommended low-fatigue interaction.

A source's read() returns: (frame_bgr_or_None, pointer_or_None, engaged, info)
where `pointer` is (x, y) in normalized [0,1] *source* coordinates, before the
calibration homography is applied.
"""

from __future__ import annotations

import time
import urllib.request
from pathlib import Path

# BlazePose 33-landmark indices (the Tasks API returns a flat list in this order).
NOSE = 0
LEFT_SHOULDER, RIGHT_SHOULDER = 11, 12
LEFT_WRIST, RIGHT_WRIST = 15, 16

_POSE_MODEL_URL_TMPL = ("https://storage.googleapis.com/mediapipe-models/"
                        "pose_landmarker/{name}/float16/latest/{name}.task")
# Known PoseLandmarker variants (increasing accuracy/stability, decreasing speed).
# 'full' is the recommended balance; 'heavy' is the most landmark-stable.
POSE_MODEL_URLS = {
    "pose_landmarker_lite.task": _POSE_MODEL_URL_TMPL.format(name="pose_landmarker_lite"),
    "pose_landmarker_full.task": _POSE_MODEL_URL_TMPL.format(name="pose_landmarker_full"),
    "pose_landmarker_heavy.task": _POSE_MODEL_URL_TMPL.format(name="pose_landmarker_heavy"),
}
POSE_MODEL_URL = POSE_MODEL_URLS["pose_landmarker_lite.task"]  # back-compat default
DEFAULT_MODEL_PATH = "models/pose_landmarker_lite.task"


class PointerSource:
    """Interface for a per-frame pointer provider."""

    def read(self):
        """Return (frame_bgr|None, pointer|None, engaged: bool, info: dict)."""
        raise NotImplementedError

    def close(self) -> None:
        pass


class MouseSource(PointerSource):
    """Cursor driven by the window's mouse position (set via a cv2 callback).

    Becomes engaged once the mouse moves over the window. Note: OpenCV/HighGUI
    does not deliver an event when the pointer *leaves* the window, so mouse
    mode stays engaged after the first move — it's a convenience for developing
    and demoing the selection pipeline on any machine. The real engage/disengage
    gating (raise/lower your arm) lives in PoseSource.
    """

    def __init__(self):
        self._pointer: tuple[float, float] | None = None
        self._engaged = False

    def set_pointer(self, x: float, y: float, engaged: bool = True) -> None:
        self._pointer = (x, y)
        self._engaged = engaged

    def read(self):
        return None, self._pointer, self._engaged, {"source": "mouse"}


def ensure_pose_model(path: str = DEFAULT_MODEL_PATH,
                      url: str | None = None) -> str:
    """Download the PoseLandmarker .task model on first use; return its path.

    When ``url`` is omitted it is inferred from the model's filename via
    :data:`POSE_MODEL_URLS` (so pointing ``server.model`` at
    ``pose_landmarker_full.task`` or ``..._heavy.task`` auto-downloads the
    better, more landmark-stable model). Downloads to a temporary ``.part`` file
    and atomically renames it into place only on success, so an interrupted
    download never leaves a truncated, silently-cached model.
    """
    p = Path(path)
    if p.exists():
        return str(p)
    if url is None:
        url = POSE_MODEL_URLS.get(p.name)
        if url is None:
            raise ValueError(
                f"no known download URL for pose model {p.name!r}; known: "
                f"{sorted(POSE_MODEL_URLS)} (or pass an explicit url)")
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".part")
    print(f"[gesturewall] downloading pose model -> {p} ...")
    try:
        urllib.request.urlretrieve(url, tmp)  # noqa: S310 (trusted Google URL)
        tmp.replace(p)
    except BaseException:  # incl. KeyboardInterrupt — clean up the partial file
        tmp.unlink(missing_ok=True)
        raise
    print("[gesturewall] model download complete.")
    return str(p)


class PoseSource(PointerSource):
    """Webcam + MediaPipe Tasks PoseLandmarker (verified against mediapipe 0.10.x)."""

    def __init__(self, camera: int = 0, video: str | None = None,
                 model_path: str = DEFAULT_MODEL_PATH, mirror: bool = True,
                 min_confidence: float = 0.5):
        import cv2  # lazy
        try:
            import mediapipe as mp
            from mediapipe.tasks.python import BaseOptions
            from mediapipe.tasks.python.vision import (
                PoseLandmarker, PoseLandmarkerOptions, RunningMode)
        except ImportError as e:  # pragma: no cover - environment dependent
            raise RuntimeError(
                "mediapipe is required for the pose source. Install it with "
                "`pip install mediapipe` (see README for Python-version notes)."
            ) from e

        self._cv2 = cv2
        self._mp = mp
        self._mirror = mirror

        model = ensure_pose_model(model_path)
        options = PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=model),
            running_mode=RunningMode.VIDEO,
            num_poses=1,
            min_pose_detection_confidence=min_confidence,
            min_pose_presence_confidence=min_confidence,
            min_tracking_confidence=min_confidence,
        )
        self._landmarker = PoseLandmarker.create_from_options(options)

        src = video if video is not None else camera
        self._cap = cv2.VideoCapture(src)
        if not self._cap.isOpened():
            raise RuntimeError(f"could not open video source: {src!r}")
        self._is_video_file = video is not None
        self._last_ts_ms = -1

    def _next_timestamp_ms(self) -> int:
        # detect_for_video requires strictly increasing integer ms timestamps.
        ts = int(time.perf_counter() * 1000)
        if ts <= self._last_ts_ms:
            ts = self._last_ts_ms + 1
        self._last_ts_ms = ts
        return ts

    def read(self):
        cv2 = self._cv2
        ok, frame = self._cap.read()
        if not ok:
            if self._is_video_file:  # loop video files for easy testing
                self._cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = self._cap.read()
            if not ok:
                return None, None, False, {"status": "no_frame"}

        if self._mirror:
            frame = cv2.flip(frame, 1)  # mirror so moving right -> cursor right

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = self._mp.Image(
            image_format=self._mp.ImageFormat.SRGB, data=rgb)
        result = self._landmarker.detect_for_video(
            mp_image, self._next_timestamp_ms())

        if not result.pose_landmarks:
            return frame, None, False, {"status": "no_pose"}

        lm = result.pose_landmarks[0]
        rw, lw = lm[RIGHT_WRIST], lm[LEFT_WRIST]
        # Pick the higher (more raised) wrist as the pointing hand. Image y grows
        # downward, so "more raised" = smaller y.
        if rw.y <= lw.y:
            wrist, shoulder = rw, lm[RIGHT_SHOULDER]
        else:
            wrist, shoulder = lw, lm[LEFT_SHOULDER]

        # Engaged when the pointing hand is raised above its shoulder and the
        # landmark is confidently present.
        visible = getattr(wrist, "visibility", 1.0) >= 0.5
        engaged = bool(visible and wrist.y < shoulder.y)

        pointer = (float(wrist.x), float(wrist.y))
        return frame, pointer, engaged, {"status": "ok", "engaged": engaged}

    def close(self) -> None:
        try:
            self._cap.release()
        finally:
            self._landmarker.close()
