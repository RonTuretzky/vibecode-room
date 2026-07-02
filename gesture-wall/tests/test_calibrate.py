"""Headless tests for the pure helpers in :mod:`gesturewall.calibrate`.

These cover only the camera-free math/merge logic: turning 4 captured corners
into a homography matrix, and merging a matrix into a room config dict so it
round-trips through JSON. cv2/mediapipe are imported lazily inside the capture
routine, so importing the module here requires no webcam — but
``corners4_to_matrix`` does use cv2 (via Homography.from_corner_points), exactly
like the real calibration path, so we skip if cv2 is unavailable.
"""

import copy
import json

import pytest

from gesturewall.calibration import WALL_CORNERS, Homography
from gesturewall.calibrate import (
    corners4_to_matrix,
    load_config_dict,
    merge_calibration,
    merge_room_homography,
    save_config_dict,
)
from gesturewall.room import RoomConfig

# corners4_to_matrix goes through cv2.getPerspectiveTransform.
cv2 = pytest.importorskip("cv2")


def _flat(matrix) -> list:
    """Flatten a 3x3 matrix so pytest.approx can compare it elementwise."""
    return [v for row in matrix for v in row]


def _base_config() -> dict:
    """A minimal, valid room config dict (one camera, one wall)."""
    identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    return {
        "walls": {"A": {"display": 1, "grid": {"rows": 2, "cols": 3}}},
        "adjacency": [],
        "cameras": {
            "cam0": {"device": 0, "serves": ["A"], "room_homography": None},
        },
        "calibration": {"cam0->A": {"matrix": identity}},
        "fusion": {"mode": "highest_confidence", "merge_radius": 0.35,
                   "track_max_age": 0.5},
        "server": {"ws_port": 8770, "http_port": 8000, "fps": 30,
                   "num_poses": 4, "mirror": True, "min_confidence": 0.5,
                   "model": "models/pose_landmarker_lite.task"},
    }


# --------------------------------------------------------------------------- #
# corners4_to_matrix                                                           #
# --------------------------------------------------------------------------- #
def test_corners4_to_matrix_returns_3x3_list_of_floats():
    src = [(0.2, 0.2), (0.8, 0.2), (0.8, 0.8), (0.2, 0.8)]
    matrix = corners4_to_matrix(src)
    assert isinstance(matrix, list) and len(matrix) == 3
    for row in matrix:
        assert isinstance(row, list) and len(row) == 3
        assert all(isinstance(v, float) for v in row)


def test_corners4_to_matrix_maps_captured_corners_onto_wall_corners():
    # Whatever 4 (non-degenerate) corners we capture must map onto the canonical
    # WALL_CORNERS, since that is the destination quad.
    src = [(0.15, 0.10), (0.85, 0.12), (0.82, 0.88), (0.18, 0.90)]
    h = Homography(matrix=corners4_to_matrix(src))
    for (sx, sy), (dx, dy) in zip(src, WALL_CORNERS):
        u, v = h.apply(sx, sy)
        assert (u, v) == pytest.approx((dx, dy), abs=1e-6)


def test_corners4_to_matrix_is_usable_via_homography():
    # The matrix can be wrapped in a Homography and applied to arbitrary points.
    src = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    h = Homography(matrix=corners4_to_matrix(src))
    # center maps to the center of the WALL_CORNERS quad.
    cx = sum(c[0] for c in WALL_CORNERS) / 4.0
    cy = sum(c[1] for c in WALL_CORNERS) / 4.0
    assert h.apply(0.5, 0.5) == pytest.approx((cx, cy), abs=1e-6)


def test_corners4_to_matrix_degenerate_collinear_raises():
    collinear = [(0.1, 0.1), (0.2, 0.2), (0.3, 0.3), (0.4, 0.4)]
    with pytest.raises(ValueError, match="degenerate"):
        corners4_to_matrix(collinear)


def test_corners4_to_matrix_degenerate_coincident_raises():
    coincident = [(0.5, 0.5)] * 4
    with pytest.raises(ValueError, match="degenerate"):
        corners4_to_matrix(coincident)


def test_corners4_to_matrix_wrong_count_raises():
    with pytest.raises(ValueError, match="4 source points"):
        corners4_to_matrix([(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)])


# --------------------------------------------------------------------------- #
# merge_calibration                                                            #
# --------------------------------------------------------------------------- #
def test_merge_calibration_writes_the_right_key():
    cfg = _base_config()
    matrix = [[2.0, 0.0, 0.1], [0.0, 2.0, 0.2], [0.0, 0.0, 1.0]]
    out = merge_calibration(cfg, "cam0->A", matrix)
    assert out["calibration"]["cam0->A"] == {"matrix": matrix}


def test_merge_calibration_does_not_mutate_input():
    cfg = _base_config()
    before = copy.deepcopy(cfg)
    merge_calibration(cfg, "cam0->A", [[9, 0, 0], [0, 9, 0], [0, 0, 1]])
    assert cfg == before  # original untouched


def test_merge_calibration_creates_missing_section():
    cfg = _base_config()
    del cfg["calibration"]
    out = merge_calibration(cfg, "cam0->A", [[1, 0, 0], [0, 1, 0], [0, 0, 1]])
    assert "cam0->A" in out["calibration"]


def test_merge_calibration_coerces_to_floats():
    cfg = _base_config()
    out = merge_calibration(cfg, "cam0->A", [[1, 0, 0], [0, 1, 0], [0, 0, 1]])
    row = out["calibration"]["cam0->A"]["matrix"][0]
    assert all(isinstance(v, float) for v in row)


def test_merge_calibration_round_trips_through_json(tmp_path):
    cfg = _base_config()
    src = [(0.2, 0.18), (0.82, 0.2), (0.8, 0.82), (0.18, 0.8)]
    matrix = corners4_to_matrix(src)
    out = merge_calibration(cfg, "cam0->A", matrix)

    path = tmp_path / "room.json"
    save_config_dict(path, out)
    reloaded = load_config_dict(path)
    assert _flat(reloaded["calibration"]["cam0->A"]["matrix"]) == pytest.approx(
        _flat(matrix))

    # And the merged config is still a valid RoomConfig.
    parsed = RoomConfig.from_dict(reloaded)
    h = parsed.cam_to_wall("cam0", "A")
    for (sx, sy), (dx, dy) in zip(src, WALL_CORNERS):
        assert h.apply(sx, sy) == pytest.approx((dx, dy), abs=1e-6)


# --------------------------------------------------------------------------- #
# merge_room_homography                                                        #
# --------------------------------------------------------------------------- #
def test_merge_room_homography_sets_camera_field():
    cfg = _base_config()
    matrix = [[1.0, 0.0, 0.3], [0.0, 1.0, -0.1], [0.0, 0.0, 1.0]]
    out = merge_room_homography(cfg, "cam0", matrix)
    assert out["cameras"]["cam0"]["room_homography"] == matrix


def test_merge_room_homography_does_not_mutate_input():
    cfg = _base_config()
    before = copy.deepcopy(cfg)
    merge_room_homography(cfg, "cam0", [[1, 0, 0], [0, 1, 0], [0, 0, 1]])
    assert cfg == before


def test_merge_room_homography_unknown_camera_raises():
    cfg = _base_config()
    with pytest.raises(KeyError):
        merge_room_homography(cfg, "camX", [[1, 0, 0], [0, 1, 0], [0, 0, 1]])


def test_merge_room_homography_round_trips_and_validates(tmp_path):
    cfg = _base_config()
    src = [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)]
    matrix = corners4_to_matrix(src)
    out = merge_room_homography(cfg, "cam0", matrix)

    path = tmp_path / "room.json"
    save_config_dict(path, out)
    reloaded = json.loads(path.read_text())
    assert _flat(reloaded["cameras"]["cam0"]["room_homography"]) == pytest.approx(
        _flat(matrix))

    parsed = RoomConfig.from_dict(reloaded)
    h = parsed.room_homography("cam0")
    assert h is not None
    assert isinstance(h, Homography)


# --------------------------------------------------------------------------- #
# _most_engaged_person (pure selection over duck-typed people)                 #
# --------------------------------------------------------------------------- #
def test_most_engaged_person_prefers_engaged_then_confidence():
    from gesturewall.calibrate import _most_engaged_person
    from gesturewall.multipose import Person

    p_idle_hi = Person(wrist=(0.1, 0.1), shoulder=(0.1, 0.5),
                       anchor=(0.1, 0.7), engaged=False, confidence=0.99)
    p_eng_lo = Person(wrist=(0.4, 0.1), shoulder=(0.4, 0.5),
                      anchor=(0.4, 0.7), engaged=True, confidence=0.55)
    p_eng_hi = Person(wrist=(0.7, 0.1), shoulder=(0.7, 0.5),
                      anchor=(0.7, 0.7), engaged=True, confidence=0.80)

    chosen = _most_engaged_person([p_idle_hi, p_eng_lo, p_eng_hi])
    assert chosen is p_eng_hi  # engaged beats idle; higher conf breaks the tie


def test_most_engaged_person_empty_returns_none():
    from gesturewall.calibrate import _most_engaged_person

    assert _most_engaged_person([]) is None


# --------------------------------------------------------------------------- #
# Depth-mode helpers (pure geometry; no cv2/mediapipe/camera)                  #
# --------------------------------------------------------------------------- #
from gesturewall.calibrate import (  # noqa: E402  (grouped with depth tests)
    extrinsic_from_correspondences,
    merge_camera_pose,
    merge_wall_plane,
)
from gesturewall.geometry import (  # noqa: E402
    CameraIntrinsics,
    Extrinsic,
    WallPlane,
    plane_from_corners,
)


def _depth_base_config() -> dict:
    """A minimal depth-mode-ready room config (one camera, one wall).

    Walls/cameras are declared without depth geometry; the merge helpers add it.
    The wall is served with a placeholder homography so the bare config stays
    valid before the depth fields are merged in.
    """
    identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    return {
        "walls": {"A": {"display": 1, "grid": {"rows": 2, "cols": 3}}},
        "adjacency": [],
        "cameras": {
            "cam0": {"device": 0, "serves": ["A"], "room_homography": None},
        },
        "calibration": {"cam0->A": {"matrix": identity}},
    }


def _kinect_intrinsics() -> CameraIntrinsics:
    return CameraIntrinsics(fx=365.0, fy=365.0, cx=256.0, cy=212.0,
                            width=512, height=424)


# --- merge_wall_plane ------------------------------------------------------ #
def test_merge_wall_plane_writes_plane_section():
    cfg = _depth_base_config()
    plane = WallPlane(origin=(0.0, 0.0, 2.0), u_vec=(1.5, 0.0, 0.0),
                      v_vec=(0.0, 1.2, 0.0))
    out = merge_wall_plane(cfg, "A", plane)
    assert out["walls"]["A"]["plane"] == {
        "origin": [0.0, 0.0, 2.0],
        "u_vec": [1.5, 0.0, 0.0],
        "v_vec": [0.0, 1.2, 0.0],
    }


def test_merge_wall_plane_does_not_mutate_input():
    cfg = _depth_base_config()
    before = copy.deepcopy(cfg)
    plane = WallPlane(origin=(0, 0, 1), u_vec=(1, 0, 0), v_vec=(0, 1, 0))
    merge_wall_plane(cfg, "A", plane)
    assert cfg == before


def test_merge_wall_plane_unknown_wall_raises():
    cfg = _depth_base_config()
    plane = WallPlane(origin=(0, 0, 1), u_vec=(1, 0, 0), v_vec=(0, 1, 0))
    with pytest.raises(KeyError):
        merge_wall_plane(cfg, "Z", plane)


def test_merge_wall_plane_round_trips_into_roomconfig():
    cfg = _depth_base_config()
    plane = plane_from_corners(
        top_left=(0.0, 2.0, 3.0),
        top_right=(1.6, 2.0, 3.0),
        bottom_left=(0.0, 0.8, 3.0),
    )
    out = merge_wall_plane(cfg, "A", plane)
    reloaded = json.loads(json.dumps(out))  # through JSON, like a saved file

    parsed = RoomConfig.from_dict(reloaded)
    got = parsed.wall_plane("A")
    assert got.origin == pytest.approx(plane.origin)
    assert got.u_vec == pytest.approx(plane.u_vec)
    assert got.v_vec == pytest.approx(plane.v_vec)


# --- merge_camera_pose ----------------------------------------------------- #
def test_merge_camera_pose_writes_kind_intrinsics_extrinsic():
    cfg = _depth_base_config()
    intr = _kinect_intrinsics()
    extr = Extrinsic.identity()
    out = merge_camera_pose(cfg, "cam0", intr, extr)
    cam = out["cameras"]["cam0"]
    assert cam["kind"] == "kinect_v2"
    assert cam["intrinsics"] == {
        "fx": 365.0, "fy": 365.0, "cx": 256.0, "cy": 212.0,
        "width": 512, "height": 424,
    }
    assert cam["extrinsic"] == {"matrix": extr.matrix}


def test_merge_camera_pose_does_not_mutate_input():
    cfg = _depth_base_config()
    before = copy.deepcopy(cfg)
    merge_camera_pose(cfg, "cam0", _kinect_intrinsics(), Extrinsic.identity())
    assert cfg == before


def test_merge_camera_pose_unknown_camera_raises():
    cfg = _depth_base_config()
    with pytest.raises(KeyError):
        merge_camera_pose(cfg, "camX", _kinect_intrinsics(),
                          Extrinsic.identity())


def test_merge_camera_pose_round_trips_into_roomconfig():
    cfg = _depth_base_config()
    intr = _kinect_intrinsics()
    extr = Extrinsic.from_rt(
        R=[[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]],
        t=[2.0, 0.0, -1.0])
    out = merge_camera_pose(cfg, "cam0", intr, extr, kind="kinect_v2")
    reloaded = json.loads(json.dumps(out))

    parsed = RoomConfig.from_dict(reloaded)
    got_intr = parsed.intrinsics("cam0")
    assert (got_intr.fx, got_intr.fy, got_intr.cx, got_intr.cy,
            got_intr.width, got_intr.height) == (
        365.0, 365.0, 256.0, 212.0, 512, 424)
    got_extr = parsed.extrinsic("cam0")
    for r in range(4):
        assert got_extr.matrix[r] == pytest.approx(extr.matrix[r])


def test_merge_camera_pose_then_plane_makes_depth_mode():
    # Adding plane + intrinsics + extrinsic to the served (cam, wall) flips the
    # config into depth mode, and serves() holds without a cam->wall homography.
    cfg = _depth_base_config()
    del cfg["calibration"]  # depth mode needs no cam->wall homography
    plane = plane_from_corners((0, 2, 3), (1.6, 2, 3), (0, 0.8, 3))
    cfg = merge_wall_plane(cfg, "A", plane)
    cfg = merge_camera_pose(cfg, "cam0", _kinect_intrinsics(),
                            Extrinsic.identity())

    parsed = RoomConfig.from_dict(json.loads(json.dumps(cfg)))
    assert parsed.mode == "depth"
    assert parsed.serves("cam0", "A") is True


# --- extrinsic_from_correspondences ---------------------------------------- #
def test_extrinsic_from_correspondences_recovers_known_transform():
    # A known CAMERA->ROOM transform: 90-degree yaw + translation. Generate
    # camera points, map them to room points with it, then recover it.
    R = [[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]]
    t = [1.0, -0.5, 2.0]
    truth = Extrinsic.from_rt(R, t)
    cam_pts = [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0),
               (0.0, 0.0, 1.0), (0.5, -0.5, 0.5)]
    room_pts = [truth.apply(p) for p in cam_pts]

    recovered = extrinsic_from_correspondences(room_pts, cam_pts)
    # The recovered transform maps the camera points back onto the room points.
    for cam_p, room_p in zip(cam_pts, room_pts):
        assert recovered.apply(cam_p) == pytest.approx(room_p, abs=1e-9)
    for r in range(4):
        assert recovered.matrix[r] == pytest.approx(truth.matrix[r], abs=1e-9)


def test_extrinsic_from_correspondences_too_few_points_raises():
    with pytest.raises(ValueError):
        extrinsic_from_correspondences([(0, 0, 0), (1, 0, 0)],
                                       [(0, 0, 0), (1, 0, 0)])


# --------------------------------------------------------------------------- #
# depth wall-plane calibration (pure pixel->3D->plane->merge path)            #
# --------------------------------------------------------------------------- #
def test_depth_corner3d_and_plane_and_merge():
    """corner3d_from_pixel + plane_from_corner3d + merge_wall_plane: the pure
    heart of the Kinect depth calibration, exercised with a synthetic depth map
    (no cv2, no camera)."""
    import numpy as np
    from gesturewall.calibrate import (corner3d_from_pixel, plane_from_corner3d,
                                        merge_wall_plane)
    from gesturewall.geometry import CameraIntrinsics, Extrinsic
    from gesturewall.room import RoomConfig

    intr = CameraIntrinsics(fx=366.0, fy=366.0, cx=256.0, cy=212.0,
                            width=512, height=424)
    extr = Extrinsic.identity()
    depth = np.full((424, 512), 3.0, dtype=np.float32)   # flat wall at 3 m

    # principal-point pixel deprojects to (0, 0, depth)
    pt = corner3d_from_pixel(256.0, 212.0, depth, intr, extr)
    assert pt is not None
    assert abs(pt[0]) < 1e-6 and abs(pt[1]) < 1e-6 and abs(pt[2] - 3.0) < 1e-6

    # no valid depth -> None (so the UI asks for another click)
    assert corner3d_from_pixel(100.0, 100.0,
                               np.zeros((424, 512), np.float32), intr, extr) is None

    # four corner pixels (TL, TR, BR, BL) -> a plane spanning right + down
    px = [(56, 42), (456, 42), (456, 382), (56, 382)]
    corners = [corner3d_from_pixel(x, y, depth, intr, extr) for (x, y) in px]
    assert all(c is not None for c in corners)
    plane = plane_from_corner3d(corners)
    assert plane.u_vec[0] > 0    # TR is right of TL
    assert plane.v_vec[1] > 0    # BL is below TL (image y grows down)

    # merge into a depth config and confirm it loads as depth mode with the plane
    cfg_dict = {
        "walls": {"A": {"display": 1, "grid": {"rows": 2, "cols": 3}}},
        "adjacency": [],
        "cameras": {"cam0": {"device": 0, "serves": ["A"], "kind": "kinect_v2",
                    "intrinsics": {"fx": 366, "fy": 366, "cx": 256, "cy": 212,
                                   "width": 512, "height": 424},
                    "extrinsic": {"matrix": [[1, 0, 0, 0], [0, 1, 0, 0],
                                             [0, 0, 1, 0], [0, 0, 0, 1]]}}},
        "calibration": {},
        "fusion": {"mode": "highest_confidence", "merge_radius": 0.5,
                   "track_max_age": 0.5},
        "server": {"ws_port": 8770, "http_port": 8000, "fps": 30, "num_poses": 4,
                   "mirror": True, "min_confidence": 0.5, "model": "m"},
    }
    updated = merge_wall_plane(cfg_dict, "A", plane)
    cfg = RoomConfig.from_dict(updated)
    assert cfg.mode == "depth"
    assert cfg.wall_plane("A") is not None


def test_plane_from_corner3d_needs_three():
    import pytest
    from gesturewall.calibrate import plane_from_corner3d
    with pytest.raises(ValueError):
        plane_from_corner3d([(0, 0, 3), (1, 0, 3)])


def _two_wall_depth_cfg():
    from gesturewall.room import RoomConfig
    return RoomConfig.from_dict({
        "walls": {
            "A": {"display": 1, "grid": {"rows": 2, "cols": 3},
                  "plane": {"origin": [-2, 0, 3], "u_vec": [2, 0, 0], "v_vec": [0, 2, 0]}},
            "B": {"display": 2, "grid": {"rows": 2, "cols": 3},
                  "plane": {"origin": [0, 0, 3], "u_vec": [2, 0, 0], "v_vec": [0, 2, 0]}},
        },
        "adjacency": [{"left": "A", "right": "B", "seam_margin": 0.06}],
        "cameras": {"cam0": {"device": 0, "serves": ["A", "B"], "kind": "kinect_v2",
                    "intrinsics": {"fx": 366, "fy": 366, "cx": 256, "cy": 212,
                                   "width": 512, "height": 424},
                    "extrinsic": {"matrix": [[1, 0, 0, 0], [0, 1, 0, 0],
                                             [0, 0, 1, 0], [0, 0, 0, 1]]}}},
        "calibration": {},
        "fusion": {"mode": "highest_confidence", "merge_radius": 0.5, "track_max_age": 0.5},
        "server": {"ws_port": 8770, "http_port": 8000, "fps": 30, "num_poses": 4,
                   "mirror": True, "min_confidence": 0.5, "model": "m"},
    })


def test_seam_side_and_pattern_targets():
    from gesturewall.calibrate import (_seam_side, _targets_for, CORNER_TARGETS)
    cfg = _two_wall_depth_cfg()
    # A is the left-of-seam wall -> seam on its right (u=1); B mirror.
    assert _seam_side(cfg, "A") == "right"
    assert _seam_side(cfg, "B") == "left"

    tA = _targets_for("seam-half", cfg, "A")
    assert sorted(u for (lbl, u, v) in tA if "SEAM" in lbl) == [1.0, 1.0]
    assert sorted(u for (lbl, u, v) in tA if "MIDPOINT" in lbl) == [0.5, 0.5]
    tB = _targets_for("seam-half", cfg, "B")
    assert sorted(u for (lbl, u, v) in tB if "SEAM" in lbl) == [0.0, 0.0]

    assert _targets_for("corners", cfg, "A") is CORNER_TARGETS


def test_seam_half_samples_reconstruct_and_merge():
    """End-to-end math: seam-half samples (from a known plane) -> fit -> merge ->
    the config loads as depth mode with the recovered plane."""
    from gesturewall.geometry import fit_wall_plane
    from gesturewall.calibrate import merge_wall_plane
    from gesturewall.room import RoomConfig

    O, U, V = (-2.0, 0.0, 3.0), (4.0, 0.0, 0.0), (0.0, 2.5, 0.0)

    def pt(u, v):
        return tuple(O[i] + u * U[i] + v * V[i] for i in range(3))

    # seam on the right (u=1) + midline (u=0.5)
    samples = [(0.5, 0, pt(0.5, 0)), (0.5, 1, pt(0.5, 1)),
               (1.0, 0, pt(1.0, 0)), (1.0, 1, pt(1.0, 1))]
    plane = fit_wall_plane(samples)
    cfg = _two_wall_depth_cfg()
    updated = merge_wall_plane(
        # start from the dict form of a fresh config
        __import__("json").loads(__import__("json").dumps({
            "walls": {"A": {"display": 1, "grid": {"rows": 2, "cols": 3}}},
            "adjacency": [],
            "cameras": {"cam0": {"device": 0, "serves": ["A"], "kind": "kinect_v2",
                        "intrinsics": {"fx": 366, "fy": 366, "cx": 256, "cy": 212,
                                       "width": 512, "height": 424},
                        "extrinsic": {"matrix": [[1, 0, 0, 0], [0, 1, 0, 0],
                                                 [0, 0, 1, 0], [0, 0, 0, 1]]}}},
            "calibration": {},
            "fusion": {"mode": "highest_confidence", "merge_radius": 0.5, "track_max_age": 0.5},
            "server": {"ws_port": 8770, "http_port": 8000, "fps": 30, "num_poses": 4,
                       "mirror": True, "min_confidence": 0.5, "model": "m"},
        })), "A", plane)
    rc = RoomConfig.from_dict(updated)
    assert rc.mode == "depth"
    wp = rc.wall_plane("A")
    # far corner (u=0) recovered even though only the seam half was 'clicked'
    assert all(abs(wp.origin[i] - O[i]) < 1e-9 for i in range(3))


def test_seam_pair_six_points_reconstruct_both_walls_and_share_seam():
    """The 6-point seam calibration: each wall fit from its 2 edge-midpoints +
    the 2 SHARED seam corners reconstructs both planes AND makes them meet
    exactly at the seam (left's u=1 edge == right's u=0 edge)."""
    from gesturewall.calibrate import _seam_pair_planes

    # left wall: origin far-left, seam on its right edge (u=1)
    Ol, Ul, Vl = (-2.0, 0.0, 3.0), (2.0, 0.0, 0.0), (0.0, 2.5, 0.0)
    # right wall: its origin (u=0) IS left's seam-top corner; extends further right
    Or_, Ur, Vr = (0.0, 0.0, 3.0), (2.0, 0.0, 0.0), (0.0, 2.5, 0.0)

    def L(u, v): return tuple(Ol[i] + u * Ul[i] + v * Vl[i] for i in range(3))
    def R(u, v): return tuple(Or_[i] + u * Ur[i] + v * Vr[i] for i in range(3))

    seam_top, seam_bot = L(1, 0), L(1, 1)          # shared corners (== R(0,0), R(0,1))
    points = [L(0.5, 0), L(0.5, 1), R(0.5, 0), R(0.5, 1), seam_top, seam_bot]

    left_plane, right_plane = _seam_pair_planes(points)
    assert all(abs(left_plane.origin[i] - Ol[i]) < 1e-9 for i in range(3))
    assert all(abs(right_plane.origin[i] - Or_[i]) < 1e-9 for i in range(3))
    # seam continuity: left's far-right edge (u=1) coincides with right's u=0 edge
    left_seam_top = tuple(left_plane.origin[i] + left_plane.u_vec[i] for i in range(3))
    assert all(abs(left_seam_top[i] - right_plane.origin[i]) < 1e-9 for i in range(3))


def test_register_camera_recovers_known_extrinsic():
    """_room_reference_points + extrinsic_from_correspondences recover a known
    CAMERA->ROOM extrinsic for a second camera from the shared wall references."""
    from gesturewall.calibrate import (_room_reference_points,
                                        extrinsic_from_correspondences)
    from gesturewall.geometry import Extrinsic

    cfg = _two_wall_depth_cfg()                      # walls A,B have planes + seam
    refs = _room_reference_points(cfg)
    room_pts = [p for (_lbl, p) in refs]
    assert len(room_pts) >= 4

    # A known CAMERA->ROOM extrinsic (rotate 90 deg about Y + translate).
    E = Extrinsic.from_rt([[0, 0, 1], [0, 1, 0], [-1, 0, 0]], [0.5, -0.2, 1.0])
    cam_pts = [E.inverse().apply(p) for p in room_pts]   # room -> camera observations
    recovered = extrinsic_from_correspondences(room_pts, cam_pts)  # solve cam->room
    for cp, rp in zip(cam_pts, room_pts):
        assert recovered.apply(cp) == pytest.approx(rp, abs=1e-6)
