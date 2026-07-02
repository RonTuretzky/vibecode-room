import copy
import json
from pathlib import Path

import pytest

from gesturewall.calibration import Homography
from gesturewall.geometry import CameraIntrinsics, Extrinsic, WallPlane
from gesturewall.room import (
    Adjacency, CameraCfg, FusionCfg, RoomConfig, ServerCfg, WallCfg)

EXAMPLE_PATH = Path(__file__).resolve().parent.parent / "room.example.json"
DEPTH_EXAMPLE_PATH = (
    Path(__file__).resolve().parent.parent / "room.example.depth.json")


@pytest.fixture
def example_dict() -> dict:
    return json.loads(EXAMPLE_PATH.read_text())


@pytest.fixture
def depth_dict() -> dict:
    return json.loads(DEPTH_EXAMPLE_PATH.read_text())


# --------------------------------------------------------------------------- #
# loading the shipped example                                                  #
# --------------------------------------------------------------------------- #
def test_example_file_loads():
    cfg = RoomConfig.load(EXAMPLE_PATH)
    assert isinstance(cfg, RoomConfig)
    assert set(cfg.walls) == {"A", "B"}
    assert isinstance(cfg.walls["A"], WallCfg)
    assert cfg.walls["A"].display == 1
    assert (cfg.walls["A"].rows, cfg.walls["A"].cols) == (2, 3)
    assert set(cfg.cameras) == {"cam0", "cam1", "cam2"}
    assert isinstance(cfg.cameras["cam0"], CameraCfg)
    assert cfg.cameras["cam1"].serves == ["A", "B"]
    assert isinstance(cfg.fusion, FusionCfg)
    assert isinstance(cfg.server, ServerCfg)
    assert len(cfg.adjacency) == 1
    assert isinstance(cfg.adjacency[0], Adjacency)


def test_example_defaults_match_contract(example_dict):
    cfg = RoomConfig.from_dict(example_dict)
    assert cfg.fusion.mode == "highest_confidence"
    assert cfg.fusion.merge_radius == pytest.approx(0.35)
    assert cfg.fusion.track_max_age == pytest.approx(0.5)
    assert cfg.server.ws_port == 8770
    assert cfg.server.http_port == 8000
    assert cfg.server.fps == 30
    assert cfg.server.num_poses == 4
    assert cfg.server.mirror is True
    assert cfg.server.min_confidence == pytest.approx(0.5)
    assert cfg.server.model == "models/pose_landmarker_lite.task"


def test_load_missing_file_raises_valueerror(tmp_path):
    with pytest.raises(ValueError, match="not found"):
        RoomConfig.load(tmp_path / "nope.json")


def test_load_invalid_json_raises_valueerror(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text("{not valid json")
    with pytest.raises(ValueError, match="not valid JSON"):
        RoomConfig.load(p)


# --------------------------------------------------------------------------- #
# cam_to_wall / room_homography accessors                                      #
# --------------------------------------------------------------------------- #
def test_cam_to_wall_returns_working_homography(example_dict):
    cfg = RoomConfig.from_dict(example_dict)
    h = cfg.cam_to_wall("cam0", "A")
    assert isinstance(h, Homography)
    # The example uses identity matrices, so a point passes through unchanged.
    assert h.apply(0.42, 0.31) == pytest.approx((0.42, 0.31))


def test_cam_to_wall_reflects_matrix(example_dict):
    # A non-identity calibration must be honoured by the returned Homography.
    example_dict["calibration"]["cam0->A"]["matrix"] = [
        [1.0, 0.0, 0.1], [0.0, 1.0, -0.2], [0.0, 0.0, 1.0]]
    cfg = RoomConfig.from_dict(example_dict)
    assert cfg.cam_to_wall("cam0", "A").apply(0.5, 0.5) == pytest.approx(
        (0.6, 0.3))


def test_cam_to_wall_missing_raises_keyerror(example_dict):
    cfg = RoomConfig.from_dict(example_dict)
    # cam0 does not serve B and has no cam0->B calibration entry.
    with pytest.raises(KeyError):
        cfg.cam_to_wall("cam0", "B")


def test_room_homography_null_returns_none(example_dict):
    cfg = RoomConfig.from_dict(example_dict)
    assert cfg.room_homography("cam0") is None
    assert cfg.room_homography("cam2") is None


def test_room_homography_present_returns_homography(example_dict):
    cfg = RoomConfig.from_dict(example_dict)
    h = cfg.room_homography("cam1")
    assert isinstance(h, Homography)
    assert h.apply(0.25, 0.75) == pytest.approx((0.25, 0.75))


def test_room_homography_unknown_camera_raises_keyerror(example_dict):
    cfg = RoomConfig.from_dict(example_dict)
    with pytest.raises(KeyError):
        cfg.room_homography("camX")


# --------------------------------------------------------------------------- #
# serves() logic                                                               #
# --------------------------------------------------------------------------- #
def test_serves_requires_listed_and_calibrated(example_dict):
    cfg = RoomConfig.from_dict(example_dict)
    assert cfg.serves("cam0", "A") is True
    assert cfg.serves("cam1", "A") is True
    assert cfg.serves("cam1", "B") is True
    assert cfg.serves("cam2", "B") is True
    # Not served: cam0/cam2 do not cover the opposite wall.
    assert cfg.serves("cam0", "B") is False
    assert cfg.serves("cam2", "A") is False
    assert cfg.serves("camX", "A") is False


def test_cam0_to_B_and_cam2_to_A_absence_is_valid(example_dict):
    # A camera need not serve every wall: this is a valid config and loads fine.
    cfg = RoomConfig.from_dict(example_dict)
    assert "cam0->B" not in cfg.calibration
    assert "cam2->A" not in cfg.calibration
    assert "B" not in cfg.cameras["cam0"].serves
    assert "A" not in cfg.cameras["cam2"].serves


# --------------------------------------------------------------------------- #
# validation failure modes                                                     #
# --------------------------------------------------------------------------- #
def test_missing_calibration_for_served_wall_raises(example_dict):
    # cam0 now claims to serve B, but there is no cam0->B calibration entry.
    example_dict["cameras"]["cam0"]["serves"] = ["A", "B"]
    with pytest.raises(ValueError, match="no calibration entry"):
        RoomConfig.from_dict(example_dict)


def test_serves_unknown_wall_raises(example_dict):
    example_dict["cameras"]["cam0"]["serves"] = ["A", "Z"]
    with pytest.raises(ValueError, match="unknown wall"):
        RoomConfig.from_dict(example_dict)


def test_unknown_wall_in_adjacency_raises(example_dict):
    example_dict["adjacency"][0]["right"] = "Z"
    with pytest.raises(ValueError, match="unknown wall"):
        RoomConfig.from_dict(example_dict)


def test_bad_seam_margin_too_large_raises(example_dict):
    example_dict["adjacency"][0]["seam_margin"] = 0.5
    with pytest.raises(ValueError, match="seam_margin"):
        RoomConfig.from_dict(example_dict)


def test_bad_seam_margin_negative_raises(example_dict):
    example_dict["adjacency"][0]["seam_margin"] = -0.01
    with pytest.raises(ValueError, match="seam_margin"):
        RoomConfig.from_dict(example_dict)


def test_dangling_camera_in_calibration_key_raises(example_dict):
    example_dict["calibration"]["camX->A"] = {
        "matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]]}
    with pytest.raises(ValueError, match="unknown camera"):
        RoomConfig.from_dict(example_dict)


def test_dangling_wall_in_calibration_key_raises(example_dict):
    example_dict["calibration"]["cam0->Z"] = {
        "matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]]}
    with pytest.raises(ValueError, match="unknown wall"):
        RoomConfig.from_dict(example_dict)


def test_no_walls_raises(example_dict):
    example_dict["walls"] = {}
    with pytest.raises(ValueError, match="wall"):
        RoomConfig.from_dict(example_dict)


def test_no_cameras_raises(example_dict):
    example_dict["cameras"] = {}
    with pytest.raises(ValueError, match="camera"):
        RoomConfig.from_dict(example_dict)


def test_bad_grid_dimensions_raise(example_dict):
    example_dict["walls"]["A"]["grid"]["rows"] = 0
    with pytest.raises(ValueError, match="rows/cols"):
        RoomConfig.from_dict(example_dict)


def test_malformed_calibration_matrix_raises(example_dict):
    example_dict["calibration"]["cam0->A"]["matrix"] = [[1, 0], [0, 1]]
    with pytest.raises(ValueError, match="3x3"):
        RoomConfig.from_dict(example_dict)


def test_non_numeric_matrix_entry_raises(example_dict):
    example_dict["calibration"]["cam0->A"]["matrix"] = [
        [1, 0, 0], [0, "x", 0], [0, 0, 1]]
    with pytest.raises(ValueError, match="number"):
        RoomConfig.from_dict(example_dict)


def test_bad_fps_raises(example_dict):
    example_dict["server"]["fps"] = 0
    with pytest.raises(ValueError, match="fps"):
        RoomConfig.from_dict(example_dict)


def test_bad_merge_radius_raises(example_dict):
    example_dict["fusion"]["merge_radius"] = 0
    with pytest.raises(ValueError, match="merge_radius"):
        RoomConfig.from_dict(example_dict)


def test_bad_min_confidence_raises(example_dict):
    example_dict["server"]["min_confidence"] = 1.5
    with pytest.raises(ValueError, match="min_confidence"):
        RoomConfig.from_dict(example_dict)


def test_bool_is_not_a_valid_int_device(example_dict):
    example_dict["cameras"]["cam0"]["device"] = True
    with pytest.raises(ValueError, match="device"):
        RoomConfig.from_dict(example_dict)


def test_deepcopy_fixture_isolation(example_dict):
    # Sanity: mutating the dict for one test does not leak into the file.
    before = copy.deepcopy(example_dict)
    example_dict["walls"]["A"]["display"] = 99
    assert before["walls"]["A"]["display"] == 1


# --------------------------------------------------------------------------- #
# depth mode: loading the shipped depth example                                #
# --------------------------------------------------------------------------- #
def test_depth_example_file_loads():
    cfg = RoomConfig.load(DEPTH_EXAMPLE_PATH)
    assert isinstance(cfg, RoomConfig)
    assert set(cfg.walls) == {"A", "B"}
    assert set(cfg.cameras) == {"cam0", "cam1"}
    assert cfg.cameras["cam0"].kind == "kinect_v2"
    assert cfg.cameras["cam1"].kind == "kinect_v2"
    assert cfg.cameras["cam0"].serves == ["A"]
    assert cfg.cameras["cam1"].serves == ["B"]
    assert cfg.server.num_poses == 4
    # The depth example carries an empty/absent homography calibration block.
    assert cfg.calibration == {}


def test_depth_example_is_depth_mode():
    cfg = RoomConfig.load(DEPTH_EXAMPLE_PATH)
    assert cfg.mode == "depth"


def test_homography_example_is_homography_mode():
    cfg = RoomConfig.load(EXAMPLE_PATH)
    assert cfg.mode == "homography"


def test_mode_falls_back_to_homography_when_a_served_wall_lacks_plane(
        depth_dict):
    # Drop wall A's plane: now a served wall has no plane -> not depth mode.
    depth_dict["walls"]["A"].pop("plane")
    # cam0 serves A only by depth geometry; with no plane it must fall back to
    # homography, where the served wall now needs a calibration entry.
    depth_dict["calibration"]["cam0->A"] = {
        "matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]]}
    cfg = RoomConfig.from_dict(depth_dict)
    assert cfg.mode == "homography"


def test_mode_falls_back_when_a_serving_camera_lacks_extrinsic(depth_dict):
    depth_dict["cameras"]["cam0"].pop("extrinsic")
    # cam0 now serves A with no mapping at all -> validation error.
    depth_dict["calibration"]["cam0->A"] = {
        "matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]]}
    cfg = RoomConfig.from_dict(depth_dict)
    assert cfg.mode == "homography"


# --------------------------------------------------------------------------- #
# depth-mode accessors: wall_plane / intrinsics / extrinsic                     #
# --------------------------------------------------------------------------- #
def test_wall_plane_accessor(depth_dict):
    cfg = RoomConfig.from_dict(depth_dict)
    plane = cfg.wall_plane("A")
    assert isinstance(plane, WallPlane)
    assert plane.origin == (0.0, 2.0, 3.0)
    assert plane.u_vec == (2.0, 0.0, 0.0)
    assert plane.v_vec == (0.0, -2.0, 0.0)


def test_wall_plane_unknown_wall_raises_keyerror(depth_dict):
    cfg = RoomConfig.from_dict(depth_dict)
    with pytest.raises(KeyError):
        cfg.wall_plane("Z")


def test_wall_plane_missing_plane_raises_valueerror(example_dict):
    # Homography example walls have no plane.
    cfg = RoomConfig.from_dict(example_dict)
    with pytest.raises(ValueError, match="no 3D plane"):
        cfg.wall_plane("A")


def test_intrinsics_accessor(depth_dict):
    cfg = RoomConfig.from_dict(depth_dict)
    intr = cfg.intrinsics("cam0")
    assert isinstance(intr, CameraIntrinsics)
    assert (intr.fx, intr.fy) == (365.0, 365.0)
    assert (intr.cx, intr.cy) == (256.0, 212.0)
    assert (intr.width, intr.height) == (512, 424)


def test_intrinsics_unknown_camera_raises_keyerror(depth_dict):
    cfg = RoomConfig.from_dict(depth_dict)
    with pytest.raises(KeyError):
        cfg.intrinsics("camX")


def test_intrinsics_missing_raises_valueerror(example_dict):
    cfg = RoomConfig.from_dict(example_dict)
    with pytest.raises(ValueError, match="no intrinsics"):
        cfg.intrinsics("cam0")


def test_extrinsic_accessor_identity(depth_dict):
    cfg = RoomConfig.from_dict(depth_dict)
    extr = cfg.extrinsic("cam0")
    assert isinstance(extr, Extrinsic)
    # cam0 is an identity pose.
    assert extr.apply((1.0, 2.0, 3.0)) == (1.0, 2.0, 3.0)


def test_extrinsic_from_rt_json(depth_dict):
    # cam1 was specified with R + t; it should round-trip into a usable pose.
    cfg = RoomConfig.from_dict(depth_dict)
    extr = cfg.extrinsic("cam1")
    assert isinstance(extr, Extrinsic)
    # R = [[0,0,1],[0,1,0],[-1,0,0]], t = [4,0,1].
    # apply((1,0,0)) = R@(1,0,0) + t = (0,0,-1) + (4,0,1) = (4,0,0)
    assert extr.apply((1.0, 0.0, 0.0)) == pytest.approx((4.0, 0.0, 0.0))


def test_extrinsic_missing_raises_valueerror(example_dict):
    cfg = RoomConfig.from_dict(example_dict)
    with pytest.raises(ValueError, match="no extrinsic"):
        cfg.extrinsic("cam0")


# --------------------------------------------------------------------------- #
# depth-mode serves()                                                          #
# --------------------------------------------------------------------------- #
def test_serves_in_depth_mode(depth_dict):
    cfg = RoomConfig.from_dict(depth_dict)
    assert cfg.mode == "depth"
    # Listed + camera has intrinsics+extrinsic + wall has plane.
    assert cfg.serves("cam0", "A") is True
    assert cfg.serves("cam1", "B") is True
    # Not listed -> not served, even though depth geometry exists.
    assert cfg.serves("cam0", "B") is False
    assert cfg.serves("cam1", "A") is False
    # Unknown camera.
    assert cfg.serves("camX", "A") is False


def test_serves_depth_mode_needs_no_homography(depth_dict):
    # The depth example has no cam->wall homography at all, yet serves() is True.
    cfg = RoomConfig.from_dict(depth_dict)
    assert "cam0->A" not in cfg.calibration
    assert cfg.serves("cam0", "A") is True


# --------------------------------------------------------------------------- #
# depth-mode validation failures                                              #
# --------------------------------------------------------------------------- #
def test_malformed_intrinsics_missing_field_raises(depth_dict):
    del depth_dict["cameras"]["cam0"]["intrinsics"]["fx"]
    with pytest.raises(ValueError, match="intrinsics"):
        RoomConfig.from_dict(depth_dict)


def test_malformed_intrinsics_non_numeric_raises(depth_dict):
    depth_dict["cameras"]["cam0"]["intrinsics"]["fy"] = "wide"
    with pytest.raises(ValueError, match="intrinsics"):
        RoomConfig.from_dict(depth_dict)


def test_malformed_extrinsic_wrong_matrix_shape_raises(depth_dict):
    depth_dict["cameras"]["cam0"]["extrinsic"] = {
        "matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]]}
    with pytest.raises(ValueError, match="4x4"):
        RoomConfig.from_dict(depth_dict)


def test_malformed_extrinsic_missing_rt_raises(depth_dict):
    depth_dict["cameras"]["cam0"]["extrinsic"] = {"R": [[1, 0, 0], [0, 1, 0],
                                                        [0, 0, 1]]}
    with pytest.raises(ValueError, match="extrinsic"):
        RoomConfig.from_dict(depth_dict)


def test_malformed_plane_missing_vector_raises(depth_dict):
    del depth_dict["walls"]["A"]["plane"]["u_vec"]
    with pytest.raises(ValueError, match="plane"):
        RoomConfig.from_dict(depth_dict)


def test_malformed_plane_wrong_length_vector_raises(depth_dict):
    depth_dict["walls"]["A"]["plane"]["origin"] = [0.0, 1.0]
    with pytest.raises(ValueError, match="3"):
        RoomConfig.from_dict(depth_dict)


def test_served_wall_without_any_mapping_raises(depth_dict):
    # Strip cam0's depth geometry AND give no homography -> served wall A is
    # unmapped: a clear validation error.
    del depth_dict["cameras"]["cam0"]["extrinsic"]
    del depth_dict["cameras"]["cam0"]["intrinsics"]
    with pytest.raises(ValueError, match="no calibration entry"):
        RoomConfig.from_dict(depth_dict)


def test_depth_fields_are_optional_for_homography_configs(example_dict):
    # The homography example has none of the depth fields and loads fine.
    cfg = RoomConfig.from_dict(example_dict)
    assert cfg.cameras["cam0"].kind == "rgb"
    assert cfg.cameras["cam0"].intrinsics is None
    assert cfg.cameras["cam0"].extrinsic is None
    assert cfg.walls["A"].plane is None


def test_depth_deepcopy_fixture_isolation(depth_dict):
    before = copy.deepcopy(depth_dict)
    depth_dict["walls"]["A"]["display"] = 99
    assert before["walls"]["A"]["display"] == 1


def test_server_pointing_validation():
    import json as _json
    import pytest
    from pathlib import Path
    from gesturewall.room import RoomConfig
    base = _json.loads(Path("room.example.json").read_text())
    base["server"]["pointing"] = "forearm"
    assert RoomConfig.from_dict(base).server.pointing == "forearm"   # valid
    base["server"]["pointing"] = "nope"
    with pytest.raises(ValueError):
        RoomConfig.from_dict(base)                                   # invalid
