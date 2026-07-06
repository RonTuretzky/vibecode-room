"""Unit tests for the depth-mode (3D ray/plane) fusion engine.

Everything here is headless and camera-free. We build a tiny *depth-mode*
:class:`~gesturewall.room.RoomConfig` whose two walls (A, B) carry coplanar,
axis-aligned 3D :class:`~gesturewall.geometry.WallPlane` rectangles and whose
cameras carry intrinsics + an extrinsic. Then we drive
:class:`~gesturewall.depth_fusion.DepthFusionEngine` with hand-built tracks
whose member :class:`Person`s carry a room-frame pointing :class:`Ray`, and
assert that ray/plane intersection lands the cursor on the right wall pixel.

Geometry (room frame, +Y up, floor = XZ):

  * Wall A: origin (0, 2, 3), u_vec (2, 0, 0), v_vec (0, -2, 0)
            -> X in [0, 2], Y in [0, 2], Z = 3 ; (u, v) = ((X)/2, (2 - Y)/2).
  * Wall B: origin (2, 2, 3), same vectors -> X in [2, 4], Z = 3.

Both planes face -Z, so a ray pointing toward +Z hits the front of the wall.
A ray from (x0, y0, 0) along (0, 0, 1) lands at (x0, y0, 3): on A when
0 <= x0 <= 2, with u = x0 / 2 and v = (2 - y0) / 2.
"""

import pytest

from gesturewall.depth_fusion import DepthFusionEngine
from gesturewall.fusion import Cursor, WallCandidate
from gesturewall.geometry import Ray
from gesturewall.multipose import Person
from gesturewall.room import RoomConfig
from gesturewall.tracking import RoomObs, Track

# --- shared depth geometry --------------------------------------------------- #
PLANE_A = {"origin": [0.0, 2.0, 3.0],
           "u_vec": [2.0, 0.0, 0.0], "v_vec": [0.0, -2.0, 0.0]}
PLANE_B = {"origin": [2.0, 2.0, 3.0],
           "u_vec": [2.0, 0.0, 0.0], "v_vec": [0.0, -2.0, 0.0]}
INTRINSICS = {"fx": 365.0, "fy": 365.0, "cx": 256.0, "cy": 212.0,
              "width": 512, "height": 424}
IDENTITY4 = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0],
             [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


# --------------------------------------------------------------------------- #
# config / data-builder helpers                                                #
# --------------------------------------------------------------------------- #
def make_depth_config(seam_margin: float = 0.06) -> RoomConfig:
    """A depth-mode 2-wall / 1-camera room (cam0, a kinect_v2, serves A and B).

    A single camera serving both walls keeps the test focused on ray/plane
    landing (not cross-camera serving); ``calibration`` is empty, which is
    valid in depth mode.
    """
    data = {
        "walls": {
            "A": {"display": 1, "grid": {"rows": 2, "cols": 3}, "plane": PLANE_A},
            "B": {"display": 2, "grid": {"rows": 2, "cols": 3}, "plane": PLANE_B},
        },
        "adjacency": [{"left": "A", "right": "B", "seam_margin": seam_margin}],
        "cameras": {
            "cam0": {"device": 0, "kind": "kinect_v2", "serves": ["A", "B"],
                     "intrinsics": INTRINSICS, "extrinsic": {"matrix": IDENTITY4}},
        },
        "calibration": {},
        "fusion": {"mode": "highest_confidence", "merge_radius": 0.35,
                   "track_max_age": 0.5},
        "server": {"ws_port": 8770, "http_port": 8000, "fps": 30,
                   "num_poses": 4, "mirror": True, "min_confidence": 0.5,
                   "model": "models/pose_landmarker_lite.task"},
    }
    return RoomConfig.from_dict(data)


def make_person(ray: Ray | None, *, engaged: bool = True,
                confidence: float = 0.9) -> Person:
    """A real :class:`Person` carrying a room-frame pointing ``ray``.

    The depth engine reads only ``person.ray`` and ``person.confidence``; the
    2D normalized fields are filled with plausible placeholders. ``ray`` is set
    via attribute (the optional field added by the depth path); ``None`` models
    a member without a usable pointing ray.
    """
    p = Person(wrist=(0.5, 0.4), shoulder=(0.5, 0.6), anchor=(0.5, 0.8),
               engaged=engaged, confidence=confidence)
    p.ray = ray
    return p


def ray_toward(x0: float, y0: float) -> Ray:
    """A ray from (x0, y0, 0) pointing straight at the wall plane (+Z)."""
    return Ray(origin=(x0, y0, 0.0), direction=(0.0, 0.0, 1.0))


def make_obs(ray: Ray | None, *, confidence: float = 0.9,
             camera_id: str = "cam0",
             room_xy: tuple[float, float] = (1.0, 0.0)) -> RoomObs:
    return RoomObs(camera_id=camera_id,
                   person=make_person(ray, confidence=confidence),
                   room_xy=room_xy)


def make_track(track_id: int, members: list[RoomObs], *,
               engaged: bool = True,
               room_xy: tuple[float, float] = (1.0, 0.0),
               last_seen: float = 0.0) -> Track:
    return Track(id=track_id, room_xy=room_xy, engaged=engaged,
                 last_seen=last_seen, members=members)


# --------------------------------------------------------------------------- #
# mode / config sanity                                                          #
# --------------------------------------------------------------------------- #
def test_config_is_depth_mode():
    assert make_depth_config().mode == "depth"


# --------------------------------------------------------------------------- #
# basic ray/plane landing                                                       #
# --------------------------------------------------------------------------- #
def test_ray_hitting_wall_A_yields_one_cursor_with_correct_uv():
    # Ray from (1, 1, 0) along +Z hits A at X=1 (u=0.5), Y=1 (v=0.5).
    cfg = make_depth_config()
    eng = DepthFusionEngine(cfg)
    track = make_track(7, [make_obs(ray_toward(1.0, 1.0))])

    cursors = eng.update([track], t=0.0)

    assert set(cursors) == {"A", "B"}        # every wall key present
    assert cursors["B"] == []
    assert len(cursors["A"]) == 1
    cur = cursors["A"][0]
    assert isinstance(cur, Cursor)
    assert cur.person_id == 7
    assert cur.engaged is True
    assert cur.x == pytest.approx(0.5)
    assert cur.y == pytest.approx(0.5)
    assert cur.confidence == pytest.approx(0.9)


def test_uv_reflects_pointing_target_on_A():
    # Ray landing near A's top-left corner: X=0.4 -> u=0.2, Y=1.6 -> v=0.2.
    cfg = make_depth_config()
    eng = DepthFusionEngine(cfg)
    track = make_track(1, [make_obs(ray_toward(0.4, 1.6))])

    cur = eng.update([track], t=0.0)["A"][0]
    assert (cur.x, cur.y) == pytest.approx((0.2, 0.2))


def test_ray_hitting_wall_B_lands_on_B_only():
    # Ray at X=3 hits B (B spans X in [2, 4]); u = (3 - 2) / 2 = 0.5.
    cfg = make_depth_config()
    eng = DepthFusionEngine(cfg)
    track = make_track(2, [make_obs(ray_toward(3.0, 1.0))])

    cursors = eng.update([track], t=0.0)
    assert cursors["A"] == []
    assert len(cursors["B"]) == 1
    assert cursors["B"][0].person_id == 2
    assert cursors["B"][0].x == pytest.approx(0.5)


def test_every_wall_key_present_even_when_empty():
    cfg = make_depth_config()
    eng = DepthFusionEngine(cfg)
    assert eng.update([], t=0.0) == {"A": [], "B": []}


# --------------------------------------------------------------------------- #
# misses / out-of-bounds / no-ray gating                                       #
# --------------------------------------------------------------------------- #
def test_ray_missing_all_planes_yields_no_cursor():
    # Ray at X=10 is far off both rectangles (A: [0,2], B: [2,4]); even the
    # sticky band cannot rescue it -> no cursor anywhere.
    cfg = make_depth_config()
    eng = DepthFusionEngine(cfg)
    track = make_track(3, [make_obs(ray_toward(10.0, 1.0))])

    assert eng.update([track], t=0.0) == {"A": [], "B": []}


def test_ray_parallel_to_plane_yields_no_cursor():
    # A ray travelling within the wall's plane (along +X, never crossing Z=3)
    # is parallel: plane.intersect returns None -> no candidate.
    cfg = make_depth_config()
    eng = DepthFusionEngine(cfg)
    parallel = Ray(origin=(1.0, 1.0, 0.0), direction=(1.0, 0.0, 0.0))
    track = make_track(4, [make_obs(parallel)])

    assert eng.update([track], t=0.0) == {"A": [], "B": []}


def test_ray_pointing_away_from_wall_yields_no_cursor():
    # Origin already past the wall (Z=5) pointing further +Z: t <= 0, behind.
    cfg = make_depth_config()
    eng = DepthFusionEngine(cfg)
    behind = Ray(origin=(1.0, 1.0, 5.0), direction=(0.0, 0.0, 1.0))
    track = make_track(5, [make_obs(behind)])

    assert eng.update([track], t=0.0) == {"A": [], "B": []}


def test_member_without_ray_is_ignored():
    cfg = make_depth_config()
    eng = DepthFusionEngine(cfg)
    track = make_track(6, [make_obs(None)])  # person.ray is None

    assert eng.update([track], t=0.0) == {"A": [], "B": []}


def test_non_engaged_track_yields_no_cursor():
    cfg = make_depth_config()
    eng = DepthFusionEngine(cfg)
    track = make_track(8, [make_obs(ray_toward(1.0, 1.0))], engaged=False)

    assert eng.update([track], t=0.0) == {"A": [], "B": []}


# --------------------------------------------------------------------------- #
# multi-member selection                                                        #
# --------------------------------------------------------------------------- #
def test_higher_confidence_member_wins_on_same_wall():
    # Two members both land on A (X=0.4 and X=1.6); the higher-confidence one
    # drives the cursor.
    cfg = make_depth_config()
    eng = DepthFusionEngine(cfg)
    track = make_track(9, [
        make_obs(ray_toward(0.4, 1.0), confidence=0.55),  # u=0.2
        make_obs(ray_toward(1.6, 1.0), confidence=0.95),  # u=0.8, wins
    ])

    cur = eng.update([track], t=0.0)["A"][0]
    assert cur.confidence == pytest.approx(0.95)
    assert cur.x == pytest.approx(0.8)


# --------------------------------------------------------------------------- #
# seam hand-off / hysteresis (inherited from FusionEngine)                      #
# --------------------------------------------------------------------------- #
def test_track_near_seam_sticks_to_current_wall():
    # Frame 1: ray clearly on A (X=1 -> u=0.5). Frame 2: A's ray lands just past
    # A's right edge (X=2.08 -> u=1.04, inside the 0.06 sticky band) while B has
    # a better, fully-in-bounds candidate. Hysteresis keeps the cursor on A.
    cfg = make_depth_config(seam_margin=0.06)
    eng = DepthFusionEngine(cfg)

    out1 = eng.update(
        [make_track(5, [make_obs(ray_toward(1.0, 1.0), confidence=0.9)])],
        t=0.0)
    assert len(out1["A"]) == 1 and out1["B"] == []

    t2 = make_track(5, [
        make_obs(ray_toward(2.08, 1.0), confidence=0.80),  # A: u=1.04, sticky
        make_obs(ray_toward(3.0, 1.0), confidence=0.95),   # B: u=0.5, better
    ])
    out2 = eng.update([t2], t=0.05)
    assert len(out2["A"]) == 1, "should stay on A inside the sticky band"
    assert out2["B"] == []
    assert out2["A"][0].x == pytest.approx(1.0)  # near-seam landing clamped


def test_track_switches_wall_once_clearly_past_margin():
    # Establish current wall = A, then push A's ray well past the grown band
    # (X=2.4 -> u=1.2 > 1.06) while B has a clean in-bounds candidate.
    cfg = make_depth_config(seam_margin=0.06)
    eng = DepthFusionEngine(cfg)
    eng.update([make_track(5, [make_obs(ray_toward(1.0, 1.0))])], t=0.0)

    # The X=2.4 ray pushes A's candidate to u=1.2 (past A's grown band, 1.06).
    # The X=3.0 ray is the intended, higher-confidence B candidate (u=0.5); it
    # outranks the X=2.4 ray's incidental B landing (u=0.2).
    t2 = make_track(5, [
        make_obs(ray_toward(2.4, 1.0), confidence=0.80),  # A: u=1.2, not sticky
        make_obs(ray_toward(3.0, 1.0), confidence=0.95),  # B: u=0.5, wins B
    ])
    out2 = eng.update([t2], t=0.05)
    assert out2["A"] == [], "must leave A once clearly past the seam margin"
    assert len(out2["B"]) == 1
    assert out2["B"][0].person_id == 5
    assert out2["B"][0].x == pytest.approx(0.5)


def test_stable_ids_across_frames():
    # The same track id keeps producing a cursor with that id frame to frame.
    cfg = make_depth_config()
    eng = DepthFusionEngine(cfg)
    out1 = eng.update([make_track(42, [make_obs(ray_toward(1.0, 1.0))])], t=0.0)
    out2 = eng.update([make_track(42, [make_obs(ray_toward(1.2, 1.0))])], t=0.1)
    assert out1["A"][0].person_id == 42
    assert out2["A"][0].person_id == 42


# --------------------------------------------------------------------------- #
# candidate gathering directly                                                  #
# --------------------------------------------------------------------------- #
def test_candidates_for_track_returns_in_bounds_flag():
    cfg = make_depth_config()
    eng = DepthFusionEngine(cfg)
    # In-bounds on A, and a near-seam (sticky-band) landing recorded out of
    # plain bounds.
    in_bounds = make_track(1, [make_obs(ray_toward(1.0, 1.0))])
    cands = eng._candidates_for_track(in_bounds)
    assert isinstance(cands["A"], WallCandidate)
    assert cands["A"].in_bounds is True
    assert "B" not in cands

    near_seam = make_track(2, [make_obs(ray_toward(2.08, 1.0))])  # u=1.04 on A
    cands2 = eng._candidates_for_track(near_seam)
    assert cands2["A"].in_bounds is False  # inside band, outside plain [0,1]
    assert cands2["A"].x == pytest.approx(1.04)
