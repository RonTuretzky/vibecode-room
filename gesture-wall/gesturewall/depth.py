"""Depth-ray pose: turn a Kinect v2 color+depth frame into 3D-ray Persons.

This is the depth-mode sibling of :mod:`gesturewall.multipose`. Where
``MultiPoseSource`` reports a wrist's *image position* (for the 2D homography
path), this module lifts the body into the **room frame** and builds an
**eye->hand ray** that the fusion engine casts at a wall plane — so pointing is
invariant to where the person stands (they can roam the room).

On macOS the Kinect v2 has **no skeleton SDK** (see ``KINECT.md``), so the
"3D skeleton" is built from MediaPipe-on-color + the pixel-aligned depth map:

  1. :func:`keypoints_from_landmarks` — MediaPipe normalized landmarks ->
     pixel ``(px, py, visibility)`` for the keypoints we need.
  2. :func:`build_person3d` (**PURE**) — for each keypoint, sample the aligned
     depth map at its pixel, deproject to a 3D **camera**-frame point, then map
     to the **room** frame via the camera extrinsic. From those points it builds
     the eye->hand :class:`~gesturewall.geometry.Ray` and the floor ``room_xy``,
     returning a :class:`~gesturewall.multipose.Person` carrying both.
  3. :class:`KinectPoseSource` (**LAZY** mediapipe) — wraps a frame source +
     fixed extrinsic, runs ``PoseLandmarker`` on the color image, and applies
     ``build_person3d`` per detected pose.

Math conventions (LOCKED, see :mod:`gesturewall.geometry`): CAMERA frame is
OpenCV (+Z forward, +X right, +Y down); ROOM frame is right-handed +Y up with
floor = XZ plane; depth handed to geometry is in **metres**. ``build_person3d``
is **pure** (``depth_map`` is a numpy array; no cv2/mediapipe). Only
``KinectPoseSource.__init__`` imports mediapipe, mirroring
:class:`gesturewall.sources.PoseSource`, so importing this module never needs a
camera.
"""

from __future__ import annotations

import time

from .geometry import (
    CameraIntrinsics,
    Extrinsic,
    Ray,
    floor_xy,
    sample_depth,
    v_sub,
)
from .multipose import Person
from .sources import DEFAULT_MODEL_PATH, ensure_pose_model

# BlazePose 33-landmark indices used by the depth path.
NOSE = 0
LEFT_EYE, RIGHT_EYE = 2, 5
LEFT_SHOULDER, RIGHT_SHOULDER = 11, 12
LEFT_ELBOW, RIGHT_ELBOW = 13, 14
LEFT_WRIST, RIGHT_WRIST = 15, 16
LEFT_HIP, RIGHT_HIP = 23, 24

# The keypoints keypoints_from_landmarks emits, by name -> BlazePose index.
_KEYPOINTS = {
    "nose": NOSE,
    "left_eye": LEFT_EYE,
    "right_eye": RIGHT_EYE,
    "left_shoulder": LEFT_SHOULDER,
    "right_shoulder": RIGHT_SHOULDER,
    "left_elbow": LEFT_ELBOW,
    "right_elbow": RIGHT_ELBOW,
    "left_wrist": LEFT_WRIST,
    "right_wrist": RIGHT_WRIST,
    "left_hip": LEFT_HIP,
    "right_hip": RIGHT_HIP,
}

# Pointing models — how the ray ORIGIN is chosen (direction is always toward the
# wrist). 'eye_hand' is most accurate with clean tracking; 'forearm' (elbow) and
# 'shoulder_hand' have a longer, steadier baseline that is more robust to the
# noisy single-view depth of a thin wrist (the user can A/B them).
POINTING_MODELS = ("eye_hand", "forearm", "shoulder_hand")


def keypoints_from_landmarks(landmarks, width: int, height: int) -> dict:
    """Convert one body's normalized landmarks into pixel keypoints.

    ``landmarks`` is a sequence indexable by BlazePose indices, each item
    duck-typed with ``.x`` / ``.y`` (normalized to ``[0, 1]``) and optionally
    ``.visibility``. Returns a dict mapping each keypoint name (nose, left_eye,
    right_eye, left/right shoulder/wrist/hip) to ``(px, py, visibility)`` where
    ``px = x * width`` and ``py = y * height`` (pixel coordinates).
    """
    out: dict[str, tuple[float, float, float]] = {}
    for name, idx in _KEYPOINTS.items():
        lm = landmarks[idx]
        px = float(lm.x) * width
        py = float(lm.y) * height
        vis = float(getattr(lm, "visibility", 1.0))
        out[name] = (px, py, vis)
    return out


def _room_point(kp, depth_map, intr: CameraIntrinsics, extr: Extrinsic,
                window: int = 7, prefer_near: bool = True):
    """Sample depth at a keypoint pixel and lift it into the ROOM frame.

    Uses ``prefer_near`` (the body is the nearest surface at a body-joint pixel)
    so background flying-pixels behind a thin/fast joint don't pull the depth
    toward the far wall. Returns the room-frame 3D point ``(X, Y, Z)`` or
    ``None`` if the depth map has no valid sample at that pixel.
    """
    px, py, _vis = kp
    depth_m = sample_depth(depth_map, px, py, window=window, prefer_near=prefer_near)
    if depth_m is None:
        return None
    cam_pt = intr.deproject(px, py, depth_m)
    return extr.apply(cam_pt)


def build_person3d(kps, depth_map, intr: CameraIntrinsics, extr: Extrinsic,
                   mirror: bool = False, pointing: str = "eye_hand") -> Person | None:
    """Lift one body's pixel keypoints into a 3D-ray :class:`Person` (PURE).

    ``kps`` is the dict from :func:`keypoints_from_landmarks`. ``depth_map`` is
    the pixel-aligned depth map (a 2D numpy array, metres, indexed
    ``[row=py, col=px]``). ``intr``/``extr`` are this camera's pinhole
    intrinsics and CAMERA->ROOM extrinsic.

    The higher (smaller ``py``) wrist is the pointing hand. The ray origin is the
    midpoint of the two eyes (fallback nose, fallback that-side shoulder). Each
    of {eye-origin, wrist, hip-centroid, shoulder} is sampled, deprojected and
    mapped to the room frame. The result carries:

      * ``ray``     = ``Ray(origin = eye_room (fallback shoulder_room),
                            direction = wrist_room - origin)``;
      * ``room_xy`` = ``floor_xy(hip_centroid_room)``;
      * ``wrist`` / ``shoulder`` / ``anchor`` filled with the 2D **normalized**
        image coords (``px/width``, ``py/height``) for compatibility, with the
        ``mirror`` flip applied to x (``x -> 1 - x``) exactly as multipose does;
      * ``engaged`` = the pointing wrist is above its shoulder **in the image**
        (``wrist.py < shoulder.py``) AND a ray was built;
      * ``confidence`` = mean visibility of wrist + both shoulders, reduced when
        any required depth sample was missing.

    Returns ``None`` when the wrist or the ray origin has no valid depth (no ray
    rather than a wrong ray).
    """
    width = intr.width
    height = intr.height

    rw = kps["right_wrist"]
    lw = kps["left_wrist"]
    # Higher (more raised) wrist is the pointing hand; image y grows downward so
    # "higher" = smaller py. The mirror flip only touches x, so it never changes
    # which wrist is chosen.
    if rw[1] <= lw[1]:
        wrist_kp = rw
        shoulder_kp = kps["right_shoulder"]
        eye_kp = kps["right_eye"]
        side_shoulder_kp = kps["right_shoulder"]
        elbow_kp = kps["right_elbow"]
    else:
        wrist_kp = lw
        shoulder_kp = kps["left_shoulder"]
        eye_kp = kps["left_eye"]
        side_shoulder_kp = kps["left_shoulder"]
        elbow_kp = kps["left_elbow"]

    l_shoulder = kps["left_shoulder"]
    r_shoulder = kps["right_shoulder"]
    l_hip = kps["left_hip"]
    r_hip = kps["right_hip"]
    nose = kps["nose"]
    l_eye = kps["left_eye"]
    r_eye = kps["right_eye"]

    # Pixel of the eye origin: midpoint of the two eyes (fallback nose, fallback
    # the pointing-side shoulder). We pick the pixel first, then sample depth.
    eye_px = ((l_eye[0] + r_eye[0]) / 2.0, (l_eye[1] + r_eye[1]) / 2.0)
    eye_origin_kp = (eye_px[0], eye_px[1], 1.0)

    # --- room-frame 3D points -------------------------------------------- #
    # The wrist is the thin/fast joint whose depth matters most and is noisiest,
    # so sample it with a larger near-preferring window.
    wrist_room = _room_point(wrist_kp, depth_map, intr, extr, window=11)

    shoulder_room = _room_point(shoulder_kp, depth_map, intr, extr)

    # Ray ORIGIN depends on the pointing model (direction is always toward the
    # wrist). Each origin falls back to progressively coarser-but-steadier joints
    # if its depth is missing, so we still emit a (less ideal) ray when possible.
    if pointing == "forearm":
        origin_room = (_room_point(elbow_kp, depth_map, intr, extr)
                       or shoulder_room
                       or _room_point(eye_origin_kp, depth_map, intr, extr))
    elif pointing == "shoulder_hand":
        origin_room = (shoulder_room
                       or _room_point(elbow_kp, depth_map, intr, extr)
                       or _room_point(eye_origin_kp, depth_map, intr, extr))
    else:  # "eye_hand" (default)
        origin_room = (_room_point(eye_origin_kp, depth_map, intr, extr)
                       or _room_point(nose, depth_map, intr, extr)
                       or _room_point(eye_kp, depth_map, intr, extr)
                       or shoulder_room)

    # Hip centroid pixel -> room (for the floor room_xy).
    hip_px = ((l_hip[0] + r_hip[0]) / 2.0, (l_hip[1] + r_hip[1]) / 2.0)
    hip_kp = (hip_px[0], hip_px[1], 1.0)
    hip_room = _room_point(hip_kp, depth_map, intr, extr)

    # The pointing wrist and the ray origin MUST have valid depth; otherwise the
    # ray would be wrong, so we drop the Person entirely.
    if wrist_room is None or origin_room is None:
        return None

    direction = v_sub(wrist_room, origin_room)
    ray = Ray(origin=origin_room, direction=direction)

    # Floor room_xy from the hip centroid (fallback the origin if hips missing).
    if hip_room is not None:
        room_xy = floor_xy(hip_room)
    else:
        room_xy = floor_xy(origin_room)

    # --- 2D normalized coords (mirror applies to x), for compatibility ---- #
    def _norm(kp):
        x = kp[0] / width
        y = kp[1] / height
        if mirror:
            x = 1.0 - x
        return (x, y)

    wrist_2d = _norm(wrist_kp)
    shoulder_2d = _norm(shoulder_kp)
    anchor_2d = _norm(hip_kp)

    # Engaged: pointing wrist above its shoulder in the IMAGE (py grows down) and
    # a ray was built (always true here, since we returned None above otherwise).
    engaged = bool(wrist_kp[1] < shoulder_kp[1])

    # Confidence: mean visibility of wrist + both shoulders, reduced if any
    # required depth sample was missing (a missing shoulder/hip depth means a
    # less-trustworthy 3D body even though the ray still exists).
    base_conf = (wrist_kp[2] + l_shoulder[2] + r_shoulder[2]) / 3.0
    missing = sum(1 for p in (shoulder_room, hip_room) if p is None)
    if missing:
        base_conf *= 0.5 ** missing
    confidence = base_conf

    return Person(
        wrist=wrist_2d,
        shoulder=shoulder_2d,
        anchor=anchor_2d,
        engaged=engaged,
        confidence=confidence,
        ray=ray,
        room_xy=room_xy,
    )


class FakeFrameSource:
    """A scripted frame source for tests (no Kinect, no subprocess).

    Yields ``(color_bgr, depth_m, intr)`` tuples from a list in order; once
    exhausted it returns ``None`` (end of stream), mirroring how a real source
    signals no more frames.
    """

    def __init__(self, frames):
        self._frames = list(frames)
        self._i = 0

    def read(self):
        if self._i >= len(self._frames):
            return None
        frame = self._frames[self._i]
        self._i += 1
        return frame

    def close(self) -> None:
        pass


class KinectPoseSource:
    """MediaPipe pose on Kinect v2 color + aligned depth -> 3D-ray Persons.

    Wraps a frame source that yields ``(color_bgr ndarray 512x424x3,
    depth_m ndarray 512x424 float metres, intr CameraIntrinsics)`` plus a fixed
    CAMERA->ROOM ``extr``. Mirrors :class:`gesturewall.multipose.MultiPoseSource`:
    a ``RunningMode.VIDEO`` ``PoseLandmarker`` with ``num_poses`` bodies, lazy
    cv2/mediapipe imports, strictly-increasing integer-ms timestamps, and the
    same model-download bootstrap. Construction (which imports mediapipe) is the
    only heavy part.

    ``read()`` returns ``(color | None, list[Person], info: dict)``. Pass a
    :class:`FakeFrameSource` to exercise everything but the live sensor; tests do
    NOT instantiate this class (it needs mediapipe).
    """

    def __init__(self, frame_source, extrinsic: Extrinsic,
                 num_poses: int = 4, mirror: bool = False,
                 min_confidence: float = 0.5,
                 model_path: str = DEFAULT_MODEL_PATH,
                 pointing: str = "eye_hand"):
        import cv2  # lazy
        try:
            import mediapipe as mp
            from mediapipe.tasks.python import BaseOptions
            from mediapipe.tasks.python.vision import (
                PoseLandmarker, PoseLandmarkerOptions, RunningMode)
        except ImportError as e:  # pragma: no cover - environment dependent
            raise RuntimeError(
                "mediapipe is required for the Kinect pose source. Install it "
                "with `pip install mediapipe` (see README for Python-version "
                "notes)."
            ) from e

        self._cv2 = cv2
        self._mp = mp
        self._source = frame_source
        self._extr = extrinsic
        self._mirror = mirror
        self._pointing = pointing if pointing in POINTING_MODELS else "eye_hand"

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
        self._last_ts_ms = -1

    def _next_timestamp_ms(self) -> int:
        # detect_for_video requires strictly increasing integer ms timestamps.
        ts = int(time.perf_counter() * 1000)
        if ts <= self._last_ts_ms:
            ts = self._last_ts_ms + 1
        self._last_ts_ms = ts
        return ts

    def read(self):
        """Return (color_bgr|None, list[Person], info: dict)."""
        cv2 = self._cv2
        item = self._source.read()
        if item is None:
            return None, [], {"status": "no_frame"}
        color, depth_m, intr = item

        rgb = cv2.cvtColor(color, cv2.COLOR_BGR2RGB)
        mp_image = self._mp.Image(
            image_format=self._mp.ImageFormat.SRGB, data=rgb)
        result = self._landmarker.detect_for_video(
            mp_image, self._next_timestamp_ms())

        people: list[Person] = []
        for landmarks in (result.pose_landmarks or []):
            kps = keypoints_from_landmarks(landmarks, intr.width, intr.height)
            person = build_person3d(
                kps, depth_m, intr, self._extr, mirror=self._mirror,
                pointing=self._pointing)
            if person is not None:
                people.append(person)
        return color, people, {"status": "ok", "count": len(people)}

    def close(self) -> None:
        try:
            self._source.close()
        finally:
            self._landmarker.close()
