"""Multi-person pose extraction: many bodies per camera frame.

This is the multi-wall sibling of :mod:`gesturewall.sources`. Where PoseSource
tracks a single raised hand, MultiPoseSource asks MediaPipe for up to
``num_poses`` bodies and turns each into a :class:`Person` — a small bundle of
the wrist (where the cursor points), the shoulder (engage reference), an
``anchor`` (hip midpoint, used downstream as an identity/location handle for
cross-camera fusion), plus engaged/confidence flags.

The same engage rule as PoseSource applies: the pointing-hand wrist must be
above its shoulder *and* visible. We pick the higher (smaller-y) wrist as the
pointing hand because image y grows downward.

The landmark-to-Person decision is a *pure* function,
:func:`people_from_landmarks`, with no camera or MediaPipe dependency — it
accepts duck-typed landmarks (anything exposing ``.x``, ``.y``, ``.visibility``)
so the whole policy is unit-testable headless. cv2/mediapipe are imported
LAZILY inside MultiPoseSource, mirroring PoseSource, so importing this module
never requires a webcam.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from .geometry import Ray
from .sources import (
    DEFAULT_MODEL_PATH,
    LEFT_SHOULDER,
    LEFT_WRIST,
    RIGHT_SHOULDER,
    RIGHT_WRIST,
    ensure_pose_model,
)

# Hip landmarks; the rest of the BlazePose indices live in gesturewall.sources.
LEFT_HIP, RIGHT_HIP = 23, 24


@dataclass
class Person:
    """One detected body in ONE camera frame (normalized image coords).

    All coordinates are in normalized [0,1] image space with the mirror flip
    (if any) ALREADY applied — downstream code never re-mirrors.

    Fields:
      wrist:      (x, y) of the pointing-hand wrist (the cursor source).
      shoulder:   (x, y) of the pointing hand's shoulder (engage reference).
      anchor:     (x, y) midpoint of the two hips (landmarks 23, 24) — a stable
                  identity/location handle used to fuse this body across cameras.
      engaged:    True iff the pointing wrist is above its shoulder AND visible
                  (the same arm-raise rule as PoseSource).
      confidence: mean visibility of the pointing wrist + both shoulders.

    Depth-mode (3D ray) fields, both optional and defaulting to ``None`` so the
    2D homography path and all existing construction sites are unchanged. They
    are filled only by the depth source (:mod:`gesturewall.depth`):
      ray:        eye->hand :class:`~gesturewall.geometry.Ray` in the ROOM frame
                  (cast at the wall plane), or ``None`` for 2D-only Persons.
      room_xy:    the body's room-frame floor position ``(x, z)`` (hip centroid
                  projected onto the floor), or ``None`` for 2D-only Persons.
    """

    wrist: tuple[float, float]
    shoulder: tuple[float, float]
    anchor: tuple[float, float]
    engaged: bool
    confidence: float
    ray: "Ray | None" = None
    room_xy: "tuple[float, float] | None" = None


def _xy(landmark, mirror: bool) -> tuple[float, float]:
    """Read a landmark's (x, y), applying the mirror flip to x when requested."""
    x = float(landmark.x)
    y = float(landmark.y)
    if mirror:
        x = 1.0 - x
    return x, y


def _visibility(landmark) -> float:
    """A landmark's visibility, defaulting to 1.0 when the field is absent."""
    return float(getattr(landmark, "visibility", 1.0))


def person_from_landmarks(landmarks, mirror: bool) -> Person:
    """Turn one body's 33 landmarks into a :class:`Person`.

    ``landmarks`` is a sequence indexable by the BlazePose indices, each item
    exposing ``.x``, ``.y`` and (optionally) ``.visibility``. The higher
    (smaller-y) wrist is the pointing hand; engaged = that wrist is visible
    (>= 0.5) and above its shoulder; anchor = hip midpoint; if ``mirror`` then
    x -> 1 - x for every stored coordinate.
    """
    rw, lw = landmarks[RIGHT_WRIST], landmarks[LEFT_WRIST]
    # Pick the higher (more raised) wrist as the pointing hand. Image y grows
    # downward, so "more raised" = smaller y. Compare in RAW image space; the
    # mirror flip only affects x, so it never changes which wrist is higher.
    if rw.y <= lw.y:
        wrist_lm, shoulder_lm = rw, landmarks[RIGHT_SHOULDER]
    else:
        wrist_lm, shoulder_lm = lw, landmarks[LEFT_SHOULDER]

    l_shoulder, r_shoulder = landmarks[LEFT_SHOULDER], landmarks[RIGHT_SHOULDER]
    l_hip, r_hip = landmarks[LEFT_HIP], landmarks[RIGHT_HIP]

    # Engaged when the pointing hand is raised above its shoulder and visible.
    # The raise test uses RAW y (mirror leaves y untouched), so it is invariant.
    visible = _visibility(wrist_lm) >= 0.5
    engaged = bool(visible and wrist_lm.y < shoulder_lm.y)

    wrist = _xy(wrist_lm, mirror)
    shoulder = _xy(shoulder_lm, mirror)

    lhx, lhy = _xy(l_hip, mirror)
    rhx, rhy = _xy(r_hip, mirror)
    anchor = ((lhx + rhx) / 2.0, (lhy + rhy) / 2.0)

    confidence = (
        _visibility(wrist_lm) + _visibility(l_shoulder) + _visibility(r_shoulder)
    ) / 3.0

    return Person(
        wrist=wrist,
        shoulder=shoulder,
        anchor=anchor,
        engaged=engaged,
        confidence=confidence,
    )


def people_from_landmarks(pose_landmarks_list, mirror: bool) -> list[Person]:
    """Convert MediaPipe's per-frame list of bodies into :class:`Person`s.

    ``pose_landmarks_list`` is exactly what PoseLandmarker returns for a frame:
    a list where each item is a body's list of 33 landmarks. Each landmark only
    needs ``.x``, ``.y`` and (optionally) ``.visibility``, so tests can pass
    plain namedtuples/objects. Returns one Person per body, in input order.
    """
    return [person_from_landmarks(lm, mirror) for lm in pose_landmarks_list]


class MultiPoseSource:
    """Webcam + MediaPipe PoseLandmarker tracking up to ``num_poses`` bodies.

    Mirrors :class:`gesturewall.sources.PoseSource`: VIDEO running mode, lazy
    cv2/mediapipe imports, strictly increasing integer ms timestamps, and the
    same model-download bootstrap. ``read()`` returns
    ``(frame_bgr|None, list[Person], info_dict)``.
    """

    def __init__(self, camera: int = 0, video: str | None = None,
                 num_poses: int = 4, mirror: bool = True,
                 min_confidence: float = 0.5,
                 model_path: str = DEFAULT_MODEL_PATH):
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
            num_poses=num_poses,
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
        """Return (frame_bgr|None, list[Person], info: dict)."""
        cv2 = self._cv2
        ok, frame = self._cap.read()
        if not ok:
            if self._is_video_file:  # loop video files for easy testing
                self._cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = self._cap.read()
            if not ok:
                return None, [], {"status": "no_frame"}

        if self._mirror:
            frame = cv2.flip(frame, 1)  # mirror so moving right -> cursor right

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = self._mp.Image(
            image_format=self._mp.ImageFormat.SRGB, data=rgb)
        result = self._landmarker.detect_for_video(
            mp_image, self._next_timestamp_ms())

        # The frame is already mirrored, so landmark coords are in mirrored image
        # space — pass mirror=False to people_from_landmarks to avoid flipping
        # twice. (Mirroring the frame is what flips the rendered video; the
        # landmarks come back relative to that mirrored frame.)
        people = people_from_landmarks(result.pose_landmarks or [], mirror=False)
        return frame, people, {"status": "ok", "count": len(people)}

    def close(self) -> None:
        try:
            self._cap.release()
        finally:
            self._landmarker.close()
