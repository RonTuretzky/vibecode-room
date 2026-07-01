"""Headless tests for the depth-ray pose path (gesturewall.depth).

These drive the **pure** functions ``keypoints_from_landmarks`` and
``build_person3d`` with hand-built duck-typed landmarks + synthetic numpy depth
maps — no camera, no mediapipe. We do NOT instantiate ``KinectPoseSource`` (it
needs mediapipe); ``FakeFrameSource`` is exercised on its own.

Math conventions (LOCKED): CAMERA frame = OpenCV (+Z forward, +X right, +Y
down); ROOM frame right-handed, +Y up, floor = XZ plane, ``floor_xy(p) =
(p[0], p[2])``. With an identity extrinsic the room frame *is* the camera frame,
so a constant-depth map puts every keypoint at the same Z = depth.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pytest

from gesturewall.depth import (
    FakeFrameSource,
    build_person3d,
    keypoints_from_landmarks,
)
from gesturewall.geometry import CameraIntrinsics, Extrinsic, Ray
from gesturewall.multipose import Person

# BlazePose indices the depth path reads.
NOSE = 0
LEFT_EYE, RIGHT_EYE = 2, 5
LEFT_SHOULDER, RIGHT_SHOULDER = 11, 12
LEFT_WRIST, RIGHT_WRIST = 15, 16
LEFT_HIP, RIGHT_HIP = 23, 24

WIDTH, HEIGHT = 512, 424
# Kinect v2 IR-ish pinhole intrinsics for the 512x424 registered frame.
INTR = CameraIntrinsics(fx=365.0, fy=365.0, cx=256.0, cy=212.0,
                        width=WIDTH, height=HEIGHT)


@dataclass
class LM:
    """A duck-typed landmark: x, y normalized, optional visibility."""

    x: float
    y: float
    visibility: float = 1.0


def make_body(*, l_eye, r_eye, l_shoulder, r_shoulder, l_wrist, r_wrist,
              l_hip, r_hip, nose=(0.5, 0.04, 1.0)):
    """Build a 33-landmark body, filling unused slots with harmless defaults."""
    body = [LM(0.5, 0.5, 1.0) for _ in range(33)]
    body[NOSE] = LM(*nose)
    body[LEFT_EYE] = LM(*l_eye)
    body[RIGHT_EYE] = LM(*r_eye)
    body[LEFT_SHOULDER] = LM(*l_shoulder)
    body[RIGHT_SHOULDER] = LM(*r_shoulder)
    body[LEFT_WRIST] = LM(*l_wrist)
    body[RIGHT_WRIST] = LM(*r_wrist)
    body[LEFT_HIP] = LM(*l_hip)
    body[RIGHT_HIP] = LM(*r_hip)
    return body


# --------------------------------------------------------------------------- #
# keypoints_from_landmarks                                                     #
# --------------------------------------------------------------------------- #
def test_keypoints_pixel_math():
    body = make_body(
        l_eye=(0.45, 0.10, 1.0),
        r_eye=(0.55, 0.10, 0.9),
        l_shoulder=(0.40, 0.30, 1.0),
        r_shoulder=(0.60, 0.30, 1.0),
        l_wrist=(0.35, 0.50, 1.0),
        r_wrist=(0.65, 0.50, 0.8),
        l_hip=(0.45, 0.70, 1.0),
        r_hip=(0.55, 0.70, 1.0),
    )
    kps = keypoints_from_landmarks(body, WIDTH, HEIGHT)
    # px = x * width, py = y * height; visibility carried through.
    assert kps["left_eye"] == pytest.approx((0.45 * WIDTH, 0.10 * HEIGHT, 1.0))
    assert kps["right_eye"] == pytest.approx((0.55 * WIDTH, 0.10 * HEIGHT, 0.9))
    assert kps["right_wrist"] == pytest.approx(
        (0.65 * WIDTH, 0.50 * HEIGHT, 0.8))
    # All keypoints present (incl. elbows, used by the forearm pointing model).
    assert set(kps) == {
        "nose", "left_eye", "right_eye", "left_shoulder", "right_shoulder",
        "left_elbow", "right_elbow",
        "left_wrist", "right_wrist", "left_hip", "right_hip"}


def test_keypoints_missing_visibility_defaults_to_full():
    class Bare:
        def __init__(self, x, y):
            self.x = x
            self.y = y

    body = [Bare(0.5, 0.5) for _ in range(33)]
    body[LEFT_EYE] = Bare(0.4, 0.1)
    kps = keypoints_from_landmarks(body, WIDTH, HEIGHT)
    assert kps["left_eye"][2] == pytest.approx(1.0)


# --------------------------------------------------------------------------- #
# build_person3d                                                              #
# --------------------------------------------------------------------------- #
def _engaged_body(depth_const: float):
    """A body whose right wrist is raised above its shoulder (engaged)."""
    return make_body(
        l_eye=(0.45, 0.10, 1.0),
        r_eye=(0.55, 0.10, 1.0),
        l_shoulder=(0.40, 0.40, 1.0),
        r_shoulder=(0.60, 0.40, 1.0),
        l_wrist=(0.35, 0.55, 1.0),    # lowered
        r_wrist=(0.70, 0.20, 1.0),    # raised -> pointing hand (smaller y)
        l_hip=(0.45, 0.80, 1.0),
        r_hip=(0.55, 0.80, 1.0),
    )


def test_build_person3d_ray_points_eye_to_wrist_and_room_xy_on_floor():
    depth = 2.5  # metres, constant everywhere
    depth_map = np.full((HEIGHT, WIDTH), depth, dtype=float)
    body = _engaged_body(depth)
    kps = keypoints_from_landmarks(body, WIDTH, HEIGHT)

    person = build_person3d(kps, depth_map, INTR, Extrinsic.identity())
    assert isinstance(person, Person)
    assert person.ray is not None
    assert isinstance(person.ray, Ray)

    # Identity extrinsic => room frame == camera frame; constant depth => every
    # keypoint sits at Z = depth, so the eye->wrist direction lies in the
    # image plane (Zdir ~ 0) and the room_xy floor coord is (X, depth).
    ox, oy, oz = person.ray.origin
    assert oz == pytest.approx(depth)

    dx, dy, dz = person.ray.direction
    assert dz == pytest.approx(0.0, abs=1e-9)

    # The right wrist (x=0.70) is to the RIGHT of the eye midpoint (x=0.50), so
    # the ray's +X component is positive; image y of the wrist (0.20) is ABOVE
    # the eyes (0.10)? wrist py=0.20*H > eye py=0.10*H, so wrist is LOWER in the
    # image => +Y (down) component is positive in the camera frame.
    assert dx > 0.0
    assert dy > 0.0

    # room_xy = floor_xy(hip_centroid_room) = (X, Z=depth). Hips are centred on
    # x=0.50 == cx, so X ~ 0; Z == depth.
    assert person.room_xy is not None
    rxy_x, rxy_z = person.room_xy
    assert rxy_x == pytest.approx(0.0, abs=1e-6)
    assert rxy_z == pytest.approx(depth)


def test_build_person3d_2d_fields_and_mirror():
    depth_map = np.full((HEIGHT, WIDTH), 2.0, dtype=float)
    body = _engaged_body(2.0)
    kps = keypoints_from_landmarks(body, WIDTH, HEIGHT)

    plain = build_person3d(kps, depth_map, INTR, Extrinsic.identity(),
                           mirror=False)
    flipped = build_person3d(kps, depth_map, INTR, Extrinsic.identity(),
                             mirror=True)

    # 2D normalized coords match the original normalized landmark for the
    # pointing (right) wrist; mirror flips x -> 1 - x and leaves y.
    assert plain.wrist == pytest.approx((0.70, 0.20))
    assert flipped.wrist == pytest.approx((1.0 - 0.70, 0.20))
    # Anchor = hip centroid normalized; mirror flips its x too.
    assert plain.anchor == pytest.approx((0.50, 0.80))
    assert flipped.anchor == pytest.approx((1.0 - 0.50, 0.80))


def test_build_person3d_engaged_only_when_wrist_above_shoulder():
    depth_map = np.full((HEIGHT, WIDTH), 2.0, dtype=float)

    raised = build_person3d(
        keypoints_from_landmarks(_engaged_body(2.0), WIDTH, HEIGHT),
        depth_map, INTR, Extrinsic.identity())
    assert raised.engaged is True

    # Lower both wrists below their shoulders -> not engaged (the higher wrist
    # is still the pointing hand, but it is below the shoulder).
    lowered_body = make_body(
        l_eye=(0.45, 0.10, 1.0),
        r_eye=(0.55, 0.10, 1.0),
        l_shoulder=(0.40, 0.40, 1.0),
        r_shoulder=(0.60, 0.40, 1.0),
        l_wrist=(0.35, 0.70, 1.0),
        r_wrist=(0.65, 0.60, 1.0),    # higher of the two, still below shoulder
        l_hip=(0.45, 0.80, 1.0),
        r_hip=(0.55, 0.80, 1.0),
    )
    lowered = build_person3d(
        keypoints_from_landmarks(lowered_body, WIDTH, HEIGHT),
        depth_map, INTR, Extrinsic.identity())
    assert lowered.engaged is False


def test_build_person3d_missing_depth_returns_none():
    # An all-zeros depth map has no valid samples (sample_depth ignores <= 0),
    # so neither the wrist nor the eye origin gets depth -> None.
    depth_map = np.zeros((HEIGHT, WIDTH), dtype=float)
    body = _engaged_body(2.0)
    kps = keypoints_from_landmarks(body, WIDTH, HEIGHT)
    assert build_person3d(kps, depth_map, INTR, Extrinsic.identity()) is None


def test_build_person3d_missing_wrist_depth_returns_none():
    # Valid depth everywhere EXCEPT a hole over the pointing (right) wrist.
    depth_map = np.full((HEIGHT, WIDTH), 2.0, dtype=float)
    body = _engaged_body(2.0)
    kps = keypoints_from_landmarks(body, WIDTH, HEIGHT)
    wpx, wpy, _ = kps["right_wrist"]
    # Punch out a generous window around the wrist pixel so sample_depth's
    # 5x5 median box finds nothing valid.
    r = int(wpy)
    c = int(wpx)
    depth_map[r - 6:r + 7, c - 6:c + 7] = 0.0
    assert build_person3d(kps, depth_map, INTR, Extrinsic.identity()) is None


def test_build_person3d_extrinsic_translates_into_room():
    # An extrinsic that translates the camera origin by (10, 0, 0) in the room
    # shifts every room point's X by +10; room_xy.x reflects that.
    depth_map = np.full((HEIGHT, WIDTH), 2.0, dtype=float)
    body = _engaged_body(2.0)
    kps = keypoints_from_landmarks(body, WIDTH, HEIGHT)

    extr = Extrinsic.from_rt(
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        [10.0, 0.0, 0.0])
    person = build_person3d(kps, depth_map, INTR, extr)
    # Hips centred on cx => camera X ~ 0 => room X ~ 10 after the +10 shift.
    assert person.room_xy[0] == pytest.approx(10.0, abs=1e-6)
    # Direction (a pure rotation of the camera-frame vector) is unchanged by a
    # translation-only extrinsic: still +X, +Y, ~0 Z.
    dx, dy, dz = person.ray.direction
    assert dx > 0.0 and dy > 0.0
    assert dz == pytest.approx(0.0, abs=1e-9)


def test_build_person3d_reduced_confidence_on_missing_shoulder_depth():
    # Full depth gives the plain mean-visibility confidence; punching a hole
    # over the pointing-side shoulder halves it (one missing required sample).
    body = _engaged_body(2.0)
    kps = keypoints_from_landmarks(body, WIDTH, HEIGHT)

    full = np.full((HEIGHT, WIDTH), 2.0, dtype=float)
    p_full = build_person3d(kps, full, INTR, Extrinsic.identity())
    assert p_full.confidence == pytest.approx(1.0)

    holed = np.full((HEIGHT, WIDTH), 2.0, dtype=float)
    spx, spy, _ = kps["right_shoulder"]
    r, c = int(spy), int(spx)
    holed[r - 6:r + 7, c - 6:c + 7] = 0.0
    p_holed = build_person3d(kps, holed, INTR, Extrinsic.identity())
    # Ray + room_xy still built (wrist + eye still have depth), but confidence
    # is reduced because the shoulder depth is missing.
    assert p_holed is not None
    assert p_holed.confidence < p_full.confidence


# --------------------------------------------------------------------------- #
# FakeFrameSource                                                             #
# --------------------------------------------------------------------------- #
def test_fake_frame_source_yields_scripted_frames_then_none():
    color = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    depth = np.full((HEIGHT, WIDTH), 2.0, dtype=np.float32)
    src = FakeFrameSource([(color, depth, INTR)])
    item = src.read()
    assert item is not None
    got_color, got_depth, got_intr = item
    assert got_color.shape == (HEIGHT, WIDTH, 3)
    assert got_depth.shape == (HEIGHT, WIDTH)
    assert got_intr is INTR
    # Exhausted -> None, and close() is a no-op.
    assert src.read() is None
    src.close()


def test_pointing_model_selects_ray_origin():
    """eye_hand / forearm / shoulder_hand pick the right ray origin; all aim at
    the wrist."""
    import numpy as np
    from gesturewall.depth import build_person3d
    from gesturewall.geometry import CameraIntrinsics, Extrinsic

    intr = CameraIntrinsics(fx=400.0, fy=400.0, cx=256.0, cy=212.0,
                            width=512, height=424)
    extr = Extrinsic.identity()
    depth = np.full((424, 512), 3.0, dtype=np.float32)     # flat 3 m
    kps = {
        "nose": (256.0, 80.0, 1.0),
        "left_eye": (246.0, 80.0, 1.0), "right_eye": (266.0, 80.0, 1.0),
        "left_shoulder": (220.0, 140.0, 1.0), "right_shoulder": (292.0, 140.0, 1.0),
        "left_elbow": (210.0, 180.0, 1.0), "right_elbow": (320.0, 170.0, 1.0),
        "left_wrist": (200.0, 230.0, 1.0), "right_wrist": (360.0, 120.0, 1.0),
        "left_hip": (236.0, 250.0, 1.0), "right_hip": (276.0, 250.0, 1.0),
    }

    def deproj_x(px):
        return (px - 256.0) * 3.0 / 400.0

    pe = build_person3d(kps, depth, intr, extr, pointing="eye_hand")
    pf = build_person3d(kps, depth, intr, extr, pointing="forearm")
    ps = build_person3d(kps, depth, intr, extr, pointing="shoulder_hand")
    assert pe and pf and ps
    assert pe.ray.origin[0] == pytest.approx(deproj_x(256.0))   # eye midpoint
    assert pf.ray.origin[0] == pytest.approx(deproj_x(320.0))   # right elbow
    assert ps.ray.origin[0] == pytest.approx(deproj_x(292.0))   # right shoulder
    # All three point at the (right) wrist.
    for p in (pe, pf, ps):
        assert p.ray.origin[0] + p.ray.direction[0] == pytest.approx(deproj_x(360.0))
