"""Tests for the camera-free part of the multi-wall server.

These exercise :func:`gesturewall.server.step_pipeline` / :class:`Pipeline`
(anchors -> room frame -> Tracker -> FusionEngine) plus the small pure helpers
(room-mapping, wire framing, ``hello`` parsing, the scripted FakeSource, the
LatestPersons store and CLI overrides). No camera, websockets-at-runtime or
asyncio loop is needed: importing the server is enough because all cv2/mediapipe
work is lazy.

The room used here is loaded from ``room.example.json`` (so the example stays a
valid, exercised instance): two walls A/B, cam0->A, cam1->A & B (with an
identity room_homography), cam2->B (null room map -> raw anchor as room_xy).
"""

import json
from pathlib import Path

import pytest

from gesturewall.fusion import Cursor
from gesturewall.multipose import Person
from gesturewall.room import RoomConfig
from gesturewall.server import (
    FakeSource,
    LatestPersons,
    Pipeline,
    apply_overrides,
    build_parser,
    cursor_to_wire,
    cursors_message,
    parse_hello,
    persons_to_room_obs,
    step_pipeline,
)

ROOM_EXAMPLE = Path(__file__).resolve().parent.parent / "room.example.json"


# --------------------------------------------------------------------------- #
# helpers                                                                      #
# --------------------------------------------------------------------------- #
def load_config() -> RoomConfig:
    return RoomConfig.load(ROOM_EXAMPLE)


def make_person(wrist, anchor, *, engaged=True, confidence=0.9) -> Person:
    """A Person with the fields the pipeline reads (wrist, anchor, conf)."""
    return Person(wrist=wrist, shoulder=(wrist[0], wrist[1] + 0.2),
                  anchor=anchor, engaged=engaged, confidence=confidence)


# --------------------------------------------------------------------------- #
# room.example.json is a valid, loadable instance                              #
# --------------------------------------------------------------------------- #
def test_room_example_loads():
    cfg = load_config()
    assert set(cfg.walls) == {"A", "B"}
    assert set(cfg.cameras) == {"cam0", "cam1", "cam2"}
    assert cfg.serves("cam0", "A") and not cfg.serves("cam0", "B")
    assert cfg.serves("cam2", "B") and not cfg.serves("cam2", "A")


# --------------------------------------------------------------------------- #
# persons_to_room_obs (anchor -> room frame)                                   #
# --------------------------------------------------------------------------- #
def test_room_mapping_uses_homography_and_null_fallback():
    cfg = load_config()
    # cam1 has an identity room_homography; cam2 has null -> raw anchor.
    persons = {
        "cam1": [make_person((0.5, 0.5), (0.30, 0.70))],
        "cam2": [make_person((0.5, 0.5), (0.80, 0.20))],
    }
    obs = persons_to_room_obs(persons, cfg)
    by_cam = {o.camera_id: o.room_xy for o in obs}
    assert by_cam["cam1"] == pytest.approx((0.30, 0.70))  # identity map
    assert by_cam["cam2"] == pytest.approx((0.80, 0.20))  # null -> raw anchor


def test_room_mapping_skips_unknown_camera():
    cfg = load_config()
    persons = {"ghostcam": [make_person((0.5, 0.5), (0.5, 0.5))]}
    assert persons_to_room_obs(persons, cfg) == []


# --------------------------------------------------------------------------- #
# step_pipeline: basic per-wall cursor output                                  #
# --------------------------------------------------------------------------- #
def test_step_pipeline_engaged_person_on_A():
    cfg = load_config()
    pipe = Pipeline(cfg)
    # Seen by cam0 (serves A). Wrist lands at (0.4, 0.3) on A via identity calib.
    persons = {"cam0": [make_person((0.4, 0.3), (0.5, 0.5))]}
    out = step_pipeline(cfg, persons, t=0.0, pipeline=pipe)

    assert set(out) == {"A", "B"}        # every wall key present
    assert out["B"] == []
    assert len(out["A"]) == 1
    cur = out["A"][0]
    assert isinstance(cur, Cursor)
    assert cur.engaged is True
    assert (cur.x, cur.y) == pytest.approx((0.4, 0.3))
    assert cur.confidence == pytest.approx(0.9)


def test_step_pipeline_two_people_two_walls():
    cfg = load_config()
    pipe = Pipeline(cfg)
    persons = {
        "cam0": [make_person((0.30, 0.30), (0.20, 0.50))],   # serves A only
        "cam2": [make_person((0.70, 0.40), (0.80, 0.50))],   # serves B only
    }
    out = step_pipeline(cfg, persons, t=0.0, pipeline=pipe)

    assert len(out["A"]) == 1 and len(out["B"]) == 1
    assert (out["A"][0].x, out["A"][0].y) == pytest.approx((0.30, 0.30))
    assert (out["B"][0].x, out["B"][0].y) == pytest.approx((0.70, 0.40))
    # Two distinct people -> two distinct ids.
    assert out["A"][0].person_id != out["B"][0].person_id


def test_step_pipeline_non_engaged_emits_nothing():
    cfg = load_config()
    pipe = Pipeline(cfg)
    persons = {"cam0": [make_person((0.4, 0.3), (0.5, 0.5), engaged=False)]}
    out = step_pipeline(cfg, persons, t=0.0, pipeline=pipe)
    assert out == {"A": [], "B": []}


# --------------------------------------------------------------------------- #
# stable ids across ticks                                                      #
# --------------------------------------------------------------------------- #
def test_ids_stable_for_persistent_person_across_ticks():
    cfg = load_config()
    pipe = Pipeline(cfg)

    ids = []
    # The person drifts slowly; each step moves the anchor < merge_radius (0.35)
    # so the tracker keeps the same id frame to frame.
    for i in range(5):
        t = i * 0.05
        anchor = (0.30 + 0.02 * i, 0.50)
        wrist = (0.40 + 0.02 * i, 0.30)
        out = step_pipeline(
            cfg, {"cam0": [make_person(wrist, anchor)]}, t=t, pipeline=pipe)
        assert len(out["A"]) == 1
        ids.append(out["A"][0].person_id)

    assert len(set(ids)) == 1, f"id should be stable across ticks, got {ids}"
    assert ids[0] == 1, "first track id starts at 1"


def test_ids_distinct_for_two_persistent_people():
    cfg = load_config()
    pipe = Pipeline(cfg)

    left_ids, right_ids = [], []
    for i in range(4):
        t = i * 0.05
        persons = {
            "cam0": [make_person((0.25, 0.30), (0.15, 0.50))],   # left -> A
            "cam2": [make_person((0.75, 0.40), (0.85, 0.50))],   # right -> B
        }
        out = step_pipeline(cfg, persons, t=t, pipeline=pipe)
        assert len(out["A"]) == 1 and len(out["B"]) == 1
        left_ids.append(out["A"][0].person_id)
        right_ids.append(out["B"][0].person_id)

    assert len(set(left_ids)) == 1
    assert len(set(right_ids)) == 1
    assert set(left_ids).isdisjoint(right_ids), "two people keep distinct ids"


def test_cross_camera_same_person_fuses_to_one_track():
    cfg = load_config()
    pipe = Pipeline(cfg)
    # cam0 and cam1 both see the SAME physical person (anchors within
    # merge_radius). They must fuse into a single track -> one cursor on A.
    persons = {
        "cam0": [make_person((0.40, 0.30), (0.50, 0.50), confidence=0.7)],
        "cam1": [make_person((0.42, 0.31), (0.52, 0.50), confidence=0.95)],
    }
    out = step_pipeline(cfg, persons, t=0.0, pipeline=pipe)
    assert len(out["A"]) == 1, "the two camera views fuse to one cursor"
    # Highest-confidence member (cam1) drives the cursor.
    assert out["A"][0].confidence == pytest.approx(0.95)


def test_track_expires_after_max_age_and_new_id_issued():
    cfg = load_config()                # track_max_age = 0.5
    pipe = Pipeline(cfg)

    out1 = step_pipeline(
        cfg, {"cam0": [make_person((0.4, 0.3), (0.3, 0.5))]}, t=0.0,
        pipeline=pipe)
    first_id = out1["A"][0].person_id

    # A long gap with no observations expires the track.
    step_pipeline(cfg, {}, t=1.0, pipeline=pipe)

    out3 = step_pipeline(
        cfg, {"cam0": [make_person((0.4, 0.3), (0.3, 0.5))]}, t=1.1,
        pipeline=pipe)
    second_id = out3["A"][0].person_id
    assert second_id != first_id, "a re-appearing person gets a fresh, unused id"
    assert second_id > first_id, "ids are never reused"


def test_step_pipeline_stateless_when_no_pipeline_passed():
    cfg = load_config()
    # Two independent one-shot calls each start tracking from scratch at id 1.
    out_a = step_pipeline(cfg, {"cam0": [make_person((0.4, 0.3), (0.3, 0.5))]},
                          t=0.0)
    out_b = step_pipeline(cfg, {"cam0": [make_person((0.4, 0.3), (0.3, 0.5))]},
                          t=0.0)
    assert out_a["A"][0].person_id == 1
    assert out_b["A"][0].person_id == 1


# --------------------------------------------------------------------------- #
# seam hand-off survives the full pipeline (cam1 serves both walls)            #
# --------------------------------------------------------------------------- #
def test_seam_handoff_through_full_pipeline():
    cfg = load_config()                # seam_margin 0.06, cam1 serves A & B
    pipe = Pipeline(cfg)

    # Frame 1: clearly on A (wrist 0.5,0.5 via cam1's identity A calib).
    out1 = step_pipeline(
        cfg, {"cam1": [make_person((0.5, 0.5), (0.5, 0.5))]}, t=0.0,
        pipeline=pipe)
    assert len(out1["A"]) == 1 and out1["B"] == []
    pid = out1["A"][0].person_id

    # Frame 2: A view drifts to x=1.04 (inside A's sticky band); B view is a
    # better landing. Hysteresis keeps the cursor on A, gated to x=1.0.
    out2 = step_pipeline(cfg, {"cam1": [
        Person(wrist=(1.04, 0.5), shoulder=(1.04, 0.7), anchor=(0.5, 0.5),
               engaged=True, confidence=0.8),
    ], "cam2": [
        Person(wrist=(0.20, 0.5), shoulder=(0.20, 0.7), anchor=(0.52, 0.5),
               engaged=True, confidence=0.95),
    ]}, t=0.05, pipeline=pipe)
    assert len(out2["A"]) == 1 and out2["B"] == []
    # Hysteresis holds the cursor on A; the fusion gates the raw landing to x=1.0,
    # but the server's 1-Euro smoothing lags it (so x moves toward the seam from
    # frame 1's 0.5, not all the way to 1.0 in one tick). The exact gating-to-1.0
    # is asserted at the fusion level (test_fusion / test_depth_fusion).
    assert 0.5 < out2["A"][0].x <= 1.0
    assert out2["A"][0].person_id == pid, "same person id through the hand-off"


# --------------------------------------------------------------------------- #
# FakeSource                                                                   #
# --------------------------------------------------------------------------- #
def test_fake_source_scripts_frames_then_repeats_last():
    p0 = [make_person((0.1, 0.1), (0.1, 0.5))]
    p1 = [make_person((0.2, 0.2), (0.2, 0.5)),
          make_person((0.3, 0.3), (0.3, 0.5))]
    src = FakeSource(frames=[p0, p1])

    f0, persons0, info0 = src.read()
    assert f0 is None and persons0 == p0 and info0["count"] == 1
    _f1, persons1, info1 = src.read()
    assert persons1 == p1 and info1["count"] == 2
    # Script exhausted -> last frame repeats.
    _f2, persons2, _ = src.read()
    assert persons2 == p1

    src.close()
    assert src.closed is True


def test_fake_source_empty_script():
    src = FakeSource()
    frame, persons, info = src.read()
    assert frame is None and persons == [] and info["status"] == "no_frame"


# --------------------------------------------------------------------------- #
# LatestPersons store (snapshot freshness)                                     #
# --------------------------------------------------------------------------- #
def test_latest_persons_snapshot_drops_stale_cameras():
    store = LatestPersons()
    fresh = [make_person((0.1, 0.1), (0.1, 0.5))]
    stale = [make_person((0.9, 0.9), (0.9, 0.5))]
    store.set("cam0", fresh, t=10.0)
    store.set("cam1", stale, t=5.0)

    snap = store.snapshot(now=10.2, max_age=0.5)
    assert set(snap) == {"cam0"}              # cam1 is older than max_age
    assert snap["cam0"] == fresh


# --------------------------------------------------------------------------- #
# wire framing + hello parsing (pure)                                          #
# --------------------------------------------------------------------------- #
def test_cursor_to_wire_shape():
    cur = Cursor(person_id=7, x=0.42, y=0.31, engaged=True, confidence=0.88)
    assert cursor_to_wire(cur) == {
        "id": 7, "x": 0.42, "y": 0.31, "engaged": True, "conf": 0.88}


def test_cursors_message_is_per_wall_json():
    cur = Cursor(person_id=3, x=0.5, y=0.6, engaged=True, confidence=0.7)
    msg = json.loads(cursors_message("B", 12.5, [cur]))
    assert msg["type"] == "cursors"
    assert msg["wall"] == "B"
    assert msg["t"] == pytest.approx(12.5)
    assert msg["cursors"] == [
        {"id": 3, "x": 0.5, "y": 0.6, "engaged": True, "conf": 0.7}]


def test_cursors_message_empty():
    msg = json.loads(cursors_message("A", 0.0, []))
    assert msg["cursors"] == []


def test_parse_hello_ok():
    assert parse_hello('{"type": "hello", "wall": "A"}') == "A"


@pytest.mark.parametrize("raw", [
    "not json",
    "{}",
    '{"type": "bye", "wall": "A"}',
    '{"type": "hello"}',
    '{"type": "hello", "wall": ""}',
    '{"type": "hello", "wall": 3}',
])
def test_parse_hello_rejects_bad(raw):
    with pytest.raises(ValueError):
        parse_hello(raw)


# --------------------------------------------------------------------------- #
# CLI overrides                                                                #
# --------------------------------------------------------------------------- #
def test_cli_overrides_apply():
    cfg = load_config()
    args = build_parser().parse_args([
        "--config", "room.json", "--ws-port", "9999", "--http-port", "8080",
        "--fps", "15", "--num-poses", "2"])
    apply_overrides(cfg, args)
    assert cfg.server.ws_port == 9999
    assert cfg.server.http_port == 8080
    assert cfg.server.fps == 15
    assert cfg.server.num_poses == 2


def test_cli_overrides_none_keep_config_values():
    cfg = load_config()
    before = (cfg.server.ws_port, cfg.server.http_port,
              cfg.server.fps, cfg.server.num_poses)
    args = build_parser().parse_args(["--config", "room.json"])
    apply_overrides(cfg, args)
    after = (cfg.server.ws_port, cfg.server.http_port,
             cfg.server.fps, cfg.server.num_poses)
    assert before == after


def test_full_dropout_does_not_coast_a_frozen_cursor():
    """A track kept alive by max_age but seen by NO camera this frame must emit
    no cursor — otherwise a frozen cursor would let the client's dwell
    ghost-complete a selection during a full-body drop-out (Midas touch)."""
    from gesturewall.room import RoomConfig
    from gesturewall.multipose import Person
    from gesturewall.server import Pipeline

    ident = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    cfg = RoomConfig.from_dict({
        "walls": {"A": {"display": 1, "grid": {"rows": 2, "cols": 3}}},
        "adjacency": [],
        "cameras": {"cam0": {"device": 0, "serves": ["A"], "room_homography": None}},
        "calibration": {"cam0->A": {"matrix": ident}},
        "fusion": {"mode": "highest_confidence", "merge_radius": 0.35,
                   "track_max_age": 0.5},
        "server": {"ws_port": 8770, "http_port": 8000, "fps": 30, "num_poses": 4,
                   "mirror": True, "min_confidence": 0.5, "model": "m"},
    })
    pipe = Pipeline(cfg)
    person = Person(wrist=(0.5, 0.5), shoulder=(0.5, 0.7), anchor=(0.5, 0.5),
                    engaged=True, confidence=0.9)

    # t=0.0: person seen -> one cursor, id 1.
    out0 = pipe.step({"cam0": [person]}, t=0.0)
    assert len(out0["A"]) == 1 and out0["A"][0].person_id == 1

    # t=0.1: NO camera sees anyone (full drop-out). Track 1 is still alive
    # (0.1 < max_age 0.5) for identity, but must NOT emit a coasting cursor.
    out1 = pipe.step({"cam0": []}, t=0.1)
    assert out1["A"] == [], "a fully-dropped-out track must not coast a cursor"

    # t=0.2: person reappears -> same id 1 (identity bridged), cursor returns.
    out2 = pipe.step({"cam0": [person]}, t=0.2)
    assert len(out2["A"]) == 1 and out2["A"][0].person_id == 1


# --------------------------------------------------------------------------- #
# depth mode: scripted ray-Persons through step_pipeline -> per-wall cursors   #
# --------------------------------------------------------------------------- #
# A tiny depth-mode room mirroring tests/test_depth_fusion.py: two axis-aligned
# walls A/B at Z=3 (A spans X in [0,2], B spans X in [2,4]) and one Kinect cam
# with identity extrinsic. A ray from (x0, y0, 0) along +Z lands at (x0, y0, 3):
# on A when 0<=x0<=2 with u = x0/2, v = (2 - y0)/2.
_PLANE_A = {"origin": [0.0, 2.0, 3.0],
            "u_vec": [2.0, 0.0, 0.0], "v_vec": [0.0, -2.0, 0.0]}
_PLANE_B = {"origin": [2.0, 2.0, 3.0],
            "u_vec": [2.0, 0.0, 0.0], "v_vec": [0.0, -2.0, 0.0]}
_INTRINSICS = {"fx": 365.0, "fy": 365.0, "cx": 256.0, "cy": 212.0,
               "width": 512, "height": 424}
_IDENTITY4 = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0],
              [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


def make_depth_config() -> RoomConfig:
    """A depth-mode 2-wall / 1-camera (kinect_v2 cam0 serving A and B) room.

    ``calibration`` is empty, which is valid in depth mode; the cam carries
    intrinsics + an identity extrinsic and both walls carry a 3D plane, so
    ``RoomConfig.mode`` is ``"depth"``.
    """
    return RoomConfig.from_dict({
        "walls": {
            "A": {"display": 1, "grid": {"rows": 2, "cols": 3},
                  "plane": _PLANE_A},
            "B": {"display": 2, "grid": {"rows": 2, "cols": 3},
                  "plane": _PLANE_B},
        },
        "adjacency": [{"left": "A", "right": "B", "seam_margin": 0.06}],
        "cameras": {
            "cam0": {"device": 0, "kind": "kinect_v2", "serves": ["A", "B"],
                     "intrinsics": _INTRINSICS,
                     "extrinsic": {"matrix": _IDENTITY4}},
        },
        "calibration": {},
        "fusion": {"mode": "highest_confidence", "merge_radius": 0.35,
                   "track_max_age": 0.5},
        "server": {"ws_port": 8770, "http_port": 8000, "fps": 30,
                   "num_poses": 4, "mirror": True, "min_confidence": 0.5,
                   "model": "models/pose_landmarker_lite.task"},
    })


def make_ray_person(x0: float, y0: float, room_xy, *,
                    engaged=True, confidence=0.9) -> Person:
    """A Person carrying a +Z pointing ray from (x0, y0, 0) and a floor room_xy.

    The depth fuser reads ``person.ray``; the server's room mapping prefers
    ``person.room_xy`` (already room-frame floor coords). The 2D image fields are
    plausible placeholders the depth path never consults here.
    """
    from gesturewall.geometry import Ray

    p = Person(wrist=(0.5, 0.4), shoulder=(0.5, 0.6), anchor=(0.5, 0.8),
               engaged=engaged, confidence=confidence)
    p.ray = Ray(origin=(x0, y0, 0.0), direction=(0.0, 0.0, 1.0))
    p.room_xy = room_xy
    return p


def test_pipeline_uses_depth_engine_in_depth_mode():
    from gesturewall.depth_fusion import DepthFusionEngine
    pipe = Pipeline(make_depth_config())
    assert isinstance(pipe.fusion, DepthFusionEngine)


def test_persons_to_room_obs_prefers_depth_room_xy():
    cfg = make_depth_config()
    # anchor (0.1, 0.9) would map to (0.1, 0.9) via the null room map, but the
    # depth room_xy (4.0, 2.0) must win since it is set.
    person = make_ray_person(1.0, 1.0, room_xy=(4.0, 2.0))
    person.anchor = (0.1, 0.9)
    obs = persons_to_room_obs({"cam0": [person]}, cfg)
    assert len(obs) == 1
    assert obs[0].room_xy == pytest.approx((4.0, 2.0))


def test_step_pipeline_depth_mode_ray_lands_on_wall_A():
    cfg = make_depth_config()
    assert cfg.mode == "depth"
    pipe = Pipeline(cfg)
    # Ray from (1, 1, 0) along +Z hits A at X=1 (u=0.5), Y=1 (v=0.5).
    persons = {"cam0": [make_ray_person(1.0, 1.0, room_xy=(1.0, 0.0))]}
    out = step_pipeline(cfg, persons, t=0.0, pipeline=pipe)

    assert set(out) == {"A", "B"}
    assert out["B"] == []
    assert len(out["A"]) == 1
    cur = out["A"][0]
    assert isinstance(cur, Cursor)
    assert cur.engaged is True
    assert (cur.x, cur.y) == pytest.approx((0.5, 0.5))
    assert cur.confidence == pytest.approx(0.9)


def test_step_pipeline_depth_mode_two_walls_distinct_ids():
    cfg = make_depth_config()
    pipe = Pipeline(cfg)
    # Two people far apart on the floor (> merge_radius 0.35) so they stay two
    # tracks: one points at A (X=1 -> u=0.5), one at B (X=3 -> u=0.5).
    persons = {"cam0": [
        make_ray_person(1.0, 1.0, room_xy=(0.0, 0.0)),
        make_ray_person(3.0, 1.0, room_xy=(4.0, 0.0)),
    ]}
    out = step_pipeline(cfg, persons, t=0.0, pipeline=pipe)

    assert len(out["A"]) == 1 and len(out["B"]) == 1
    assert out["A"][0].x == pytest.approx(0.5)
    assert out["B"][0].x == pytest.approx(0.5)
    assert out["A"][0].person_id != out["B"][0].person_id


def test_step_pipeline_depth_mode_ray_missing_planes_emits_nothing():
    cfg = make_depth_config()
    pipe = Pipeline(cfg)
    # X=10 is far off both rectangles -> no cursor anywhere.
    persons = {"cam0": [make_ray_person(10.0, 1.0, room_xy=(1.0, 0.0))]}
    out = step_pipeline(cfg, persons, t=0.0, pipeline=pipe)
    assert out == {"A": [], "B": []}


def test_step_pipeline_depth_mode_ids_stable_across_ticks():
    cfg = make_depth_config()
    pipe = Pipeline(cfg)
    ids = []
    # The person roams the floor (room_xy drifts < merge_radius each tick) while
    # always pointing at A; the ray is invariant to where they stand, so the
    # cursor stays on A with a stable id.
    for i in range(5):
        t = i * 0.05
        room_xy = (0.1 * i, 0.0)
        person = make_ray_person(1.0, 1.0, room_xy=room_xy)
        out = step_pipeline(cfg, {"cam0": [person]}, t=t, pipeline=pipe)
        assert len(out["A"]) == 1
        assert out["A"][0].x == pytest.approx(0.5)
        ids.append(out["A"][0].person_id)
    assert len(set(ids)) == 1, f"id should be stable across ticks, got {ids}"
    assert ids[0] == 1


# --------------------------------------------------------------------------- #
# end-to-end depth smoke against the SHIPPED room.example.depth.json           #
# --------------------------------------------------------------------------- #
# The synthetic make_depth_config() above exercises the engine; this one proves
# the *shipped example config* (cam0 kinect serving A, cam1 kinect serving B,
# both walls with 3D planes) drives the depth pipeline end to end. Two roaming
# users each point a room-frame ray at a different wall and must land as two
# stable cursors on A and B.
_EXAMPLE_DEPTH = (
    Path(__file__).resolve().parent.parent / "room.example.depth.json")


def test_step_pipeline_example_depth_two_users_two_walls():
    cfg = RoomConfig.load(str(_EXAMPLE_DEPTH))
    assert cfg.mode == "depth"
    pipe = Pipeline(cfg)

    # Wall A plane: origin (0,2,3) u=(2,0,0) v=(0,-2,0) -> a +Z ray from
    # (1,1,0) hits A at u = 1/2 = 0.5, v = (2-1)/2 = 0.5.
    # Wall B plane: origin (2,2,3) -> a +Z ray from (3,1,0) hits B at u=0.5.
    # The two users stand far apart on the floor (> merge_radius) so the
    # Tracker keeps them as two distinct ids, regardless of which camera the
    # mediapipe pose came from (the ray is already room-frame, camera-invariant).
    alice = make_ray_person(1.0, 1.0, room_xy=(0.5, 0.0))   # points at A
    bob = make_ray_person(3.0, 1.0, room_xy=(3.5, 0.0))     # points at B
    persons = {"cam0": [alice], "cam1": [bob]}

    out = step_pipeline(cfg, persons, t=0.0, pipeline=pipe)
    assert set(out) == {"A", "B"}
    assert len(out["A"]) == 1 and len(out["B"]) == 1
    assert out["A"][0].x == pytest.approx(0.5) and out["A"][0].y == pytest.approx(0.5)
    assert out["B"][0].x == pytest.approx(0.5) and out["B"][0].y == pytest.approx(0.5)
    assert out["A"][0].engaged is True and out["B"][0].engaged is True
    id_a, id_b = out["A"][0].person_id, out["B"][0].person_id
    assert id_a != id_b

    # Both users roam the floor for several ticks while still pointing at their
    # wall; the room-frame rays are invariant to where they stand, so the two
    # cursors stay on A and B with stable ids (the roaming guarantee).
    for i in range(1, 5):
        t = i * 0.05
        alice = make_ray_person(1.0, 1.0, room_xy=(0.5 + 0.05 * i, 0.1 * i))
        bob = make_ray_person(3.0, 1.0, room_xy=(3.5 - 0.05 * i, 0.1 * i))
        out = step_pipeline(cfg, {"cam0": [alice], "cam1": [bob]}, t=t,
                            pipeline=pipe)
        assert len(out["A"]) == 1 and len(out["B"]) == 1
        assert out["A"][0].person_id == id_a
        assert out["B"][0].person_id == id_b
        assert out["A"][0].x == pytest.approx(0.5)
        assert out["B"][0].x == pytest.approx(0.5)


def test_cursor_smoother_passthrough_converge_and_evict():
    """Server-side CursorSmoother: first sample passes through, a steady input
    converges, per-(wall,id) state is independent, and stale ids are evicted."""
    from gesturewall.server import CursorSmoother
    from gesturewall.fusion import Cursor

    sm = CursorSmoother(freq=30.0)
    # First sample passes through unchanged.
    out0 = sm.apply({"A": [Cursor(person_id=1, x=0.40, y=0.60, engaged=True, confidence=0.9)]}, t=0.0)
    assert out0["A"][0].x == 0.40 and out0["A"][0].y == 0.60
    assert out0["A"][0].person_id == 1 and out0["A"][0].engaged is True  # other fields preserved

    # Holding the same input converges to it; a second person is independent.
    last = None
    for i in range(1, 30):
        out = sm.apply({"A": [
            Cursor(person_id=1, x=0.40, y=0.60, engaged=True, confidence=0.9),
            Cursor(person_id=2, x=0.10, y=0.10, engaged=True, confidence=0.9),
        ]}, t=i / 30.0)
        last = out
    assert abs(last["A"][0].x - 0.40) < 1e-3 and abs(last["A"][1].x - 0.10) < 1e-3

    # Person 1 disappears -> its filter is evicted (so a reused id starts fresh).
    sm.apply({"A": [Cursor(person_id=2, x=0.10, y=0.10, engaged=True, confidence=0.9)]}, t=1.0)
    assert (("A", 1) not in sm._filters) and (("A", 2) in sm._filters)


def test_ray_smoother_passthrough_converge_evict():
    """RaySmoother: first sample passes through, a held ray converges (origin and
    wrist endpoint stay consistent), and stale track ids are evicted."""
    from gesturewall.server import RaySmoother
    from gesturewall.geometry import Ray
    from gesturewall.multipose import Person
    from gesturewall.tracking import Track, RoomObs

    def track(tid, origin, direction):
        p = Person(wrist=(.5, .4), shoulder=(.5, .6), anchor=(.5, .5),
                   engaged=True, confidence=.9,
                   ray=Ray(origin=origin, direction=direction), room_xy=(0.0, 0.0))
        obs = RoomObs(camera_id="cam0", person=p, room_xy=(0.0, 0.0))
        return Track(id=tid, room_xy=(0.0, 0.0), engaged=True, last_seen=0.0,
                     members=[obs])

    sm = RaySmoother(freq=30.0)
    out0 = sm.apply([track(1, (0.0, 0.0, 0.0), (0.0, 0.0, 3.0))], t=0.0)
    r0 = out0[0].members[0].person.ray
    assert r0.origin == pytest.approx((0.0, 0.0, 0.0))
    assert r0.direction == pytest.approx((0.0, 0.0, 3.0))      # first-sample passthrough

    last = None
    for i in range(1, 25):
        last = sm.apply([track(1, (0.0, 0.0, 0.0), (0.0, 0.0, 3.0))], t=i / 30.0)
    rl = last[0].members[0].person.ray
    assert rl.origin == pytest.approx((0.0, 0.0, 0.0), abs=1e-3)
    assert rl.origin[2] + rl.direction[2] == pytest.approx(3.0, abs=1e-3)  # endpoint held

    # A short hole (< HOLD_S) must NOT evict: a single-frame wrist depth
    # dropout would otherwise reset the 1-Euro state and make the returning
    # cursor jump. Only sustained absence evicts.
    sm.apply([], t=1.0)                    # 0.2 s since last seen: held
    assert sm._origin and sm._end
    sm.apply([], t=1.1)                    # 0.3 s > HOLD_S: evicted
    assert not sm._origin and not sm._end and not sm._last_seen


# --------------------------------------------------------------------------- #
# decoupled per-camera frames (fusion.cross_camera = false)                    #
# --------------------------------------------------------------------------- #
def load_decoupled_config() -> RoomConfig:
    d = json.loads(ROOM_EXAMPLE.read_text())
    # Unregistered frames: exactly one serving camera per wall.
    d["cameras"]["cam0"]["serves"] = ["A"]
    d["cameras"]["cam1"]["serves"] = []
    d["cameras"]["cam2"]["serves"] = ["B"]
    d["fusion"]["cross_camera"] = False
    return RoomConfig.from_dict(d)


def test_persons_to_room_obs_frame_ids():
    persons = {"cam0": [make_person((0.4, 0.3), (0.5, 0.5))]}
    # Registered room (default): every observation shares the "room" frame.
    assert [o.frame_id for o in persons_to_room_obs(persons, load_config())] \
        == ["room"]
    # Decoupled room: each camera's coordinates stay in its own frame.
    assert [o.frame_id
            for o in persons_to_room_obs(persons, load_decoupled_config())] \
        == ["cam0"]


def test_decoupled_two_people_same_coords_stay_distinct():
    # Two DIFFERENT people whose room_xy are numerically identical — but each
    # in its own camera's unregistered frame. Registered logic would merge
    # them into one track and choose_wall would starve one wall; decoupled
    # tracking must keep two tracks and drive BOTH walls.
    cfg = load_decoupled_config()
    pipe = Pipeline(cfg)
    persons = {
        "cam0": [make_person((0.30, 0.30), (0.50, 0.50))],   # serves A
        "cam2": [make_person((0.70, 0.40), (0.50, 0.50))],   # serves B
    }
    out = step_pipeline(cfg, persons, t=0.0, pipeline=pipe)
    assert len(out["A"]) == 1 and len(out["B"]) == 1
    assert out["A"][0].person_id != out["B"][0].person_id


# --------------------------------------------------------------------------- #
# broadcast snapshot freshness uses the workers' raw clock                     #
# --------------------------------------------------------------------------- #
def test_broadcast_snapshot_uses_raw_clock():
    # CameraWorker stamps entries with the RAW clock; broadcast_tick must
    # snapshot with the same epoch. (Mixing in the server-relative clock made
    # `now - t` hugely negative, so staleness never fired and a dead camera
    # ghosted its last Persons forever.)
    import asyncio

    from gesturewall.server import GestureServer

    cfg = load_config()
    store = LatestPersons()
    now = {"t": 1100.0}                       # raw monotonic, far from zero
    server = GestureServer(cfg, store, clock=lambda: now["t"])

    seen = {}

    def spy_step(persons, t):
        seen["persons"] = persons
        return {w: [] for w in cfg.walls}

    server.pipeline.step = spy_step
    store.set("cam0", [make_person((0.4, 0.3), (0.5, 0.5))], now["t"] - 0.05)
    store.set("cam2", [make_person((0.7, 0.4), (0.8, 0.5))], now["t"] - 10.0)
    asyncio.run(server.broadcast_tick())

    assert "cam0" in seen["persons"], "fresh camera stays in the snapshot"
    assert "cam2" not in seen["persons"], "stale camera must drop out"
