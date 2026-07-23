"""Regression pins for the single-wall (one projector, one Kinect v2) room.

The single-wall rig runs ONE wall ``"A"`` with ONE ``kinect_v2`` camera and NO
adjacency. Nothing in the pipeline is allowed to assume two walls: these tests
pin the behaviours the single-wall bring-up depends on, so a future change
made with the two-wall production rig in mind cannot silently break them.

Everything here is headless and camera-free:

  * the minimal PRE-calibration config (``serves: []`` — required, because a
    served wall must be backed by geometry) parses and resolves to homography
    mode, which is exactly what autocal accepts as its input;
  * the POST-calibration shape (plane + intrinsics + extrinsic + serves)
    resolves to depth mode with ``serves("cam0", "A")`` true;
  * :class:`~gesturewall.depth_fusion.DepthFusionEngine` with a single wall
    emits correct cursors, always returns the wall key, and — with no
    adjacency — has a zero-width sticky band (the historical behaviour);
  * the optional per-wall ``edge_margin`` restores seam-style edge stickiness
    for an adjacency-less wall without affecting acquisition, and is maxed
    with adjacency seam margins on multi-wall configs;
  * the server's :func:`~gesturewall.server.frame_read_timeout` policy bounds
    Kinect reads (stalled-bridge protection) while leaving the Orbbec path on
    its self-managed no-timeout contract.

Geometry mirrors ``tests/test_depth_fusion.py``: wall A spans X in [0, 2],
Y in [0, 2] at Z = 3; a ray from (x0, y0, 0) along +Z lands at u = x0 / 2,
v = (2 - y0) / 2.
"""

from __future__ import annotations

import pytest

from gesturewall.depth_fusion import DepthFusionEngine
from gesturewall.fusion import FusionEngine
from gesturewall.geometry import Ray
from gesturewall.multipose import Person
from gesturewall.room import RoomConfig
from gesturewall.server import frame_read_timeout
from gesturewall.tracking import RoomObs, Track

PLANE_A = {"origin": [0.0, 2.0, 3.0],
           "u_vec": [2.0, 0.0, 0.0], "v_vec": [0.0, -2.0, 0.0]}
INTRINSICS = {"fx": 365.0, "fy": 365.0, "cx": 256.0, "cy": 212.0,
              "width": 512, "height": 424}
IDENTITY4 = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0],
             [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


# --------------------------------------------------------------------------- #
# config builders                                                              #
# --------------------------------------------------------------------------- #
def precal_config_dict() -> dict:
    """The minimal PRE-calibration single-wall Kinect config.

    ``serves: []`` is load-bearing: a wall listed in ``serves`` must be backed
    by a homography or full depth geometry, and before calibration there is
    neither. Autocal treats a camera with empty ``serves`` as seeing ALL walls
    and writes plane/intrinsics/extrinsic/serves back itself.
    """
    return {
        "walls": {"A": {"display": 1, "grid": {"rows": 2, "cols": 3},
                        "width_m": 2.1}},
        "cameras": {"cam0": {"device": "012843433747", "kind": "kinect_v2",
                             "serves": []}},
    }


def make_single_wall_depth_config(edge_margin: float | None = None
                                  ) -> RoomConfig:
    """The POST-calibration single-wall shape: 1 wall, 1 kinect, no adjacency."""
    wall_a: dict = {"display": 1, "grid": {"rows": 2, "cols": 3},
                    "plane": PLANE_A, "width_m": 2.0}
    if edge_margin is not None:
        wall_a["edge_margin"] = edge_margin
    data = {
        "walls": {"A": wall_a},
        "cameras": {
            "cam0": {"device": "012843433747", "kind": "kinect_v2",
                     "serves": ["A"], "intrinsics": INTRINSICS,
                     "extrinsic": {"matrix": IDENTITY4}},
        },
    }
    return RoomConfig.from_dict(data)


def make_person(ray: Ray | None, *, engaged: bool = True,
                confidence: float = 0.9) -> Person:
    p = Person(wrist=(0.5, 0.4), shoulder=(0.5, 0.6), anchor=(0.5, 0.8),
               engaged=engaged, confidence=confidence)
    p.ray = ray
    return p


def ray_toward(x0: float, y0: float) -> Ray:
    """A ray from (x0, y0, 0) pointing straight at the wall plane (+Z)."""
    return Ray(origin=(x0, y0, 0.0), direction=(0.0, 0.0, 1.0))


def make_track(track_id: int, ray: Ray, *, confidence: float = 0.9) -> Track:
    obs = RoomObs(camera_id="cam0",
                  person=make_person(ray, confidence=confidence),
                  room_xy=(1.0, 0.0))
    return Track(id=track_id, room_xy=(1.0, 0.0), engaged=True,
                 last_seen=0.0, members=[obs])


# --------------------------------------------------------------------------- #
# config shapes                                                                #
# --------------------------------------------------------------------------- #
def test_precal_minimal_single_wall_config_loads():
    cfg = RoomConfig.from_dict(precal_config_dict())
    assert list(cfg.walls) == ["A"]
    assert cfg.adjacency == []                      # omitted key defaults []
    assert cfg.cameras["cam0"].kind == "kinect_v2"
    assert cfg.mode == "homography"                 # nothing served yet
    assert cfg.serves("cam0", "A") is False


def test_postcal_single_wall_config_is_depth_mode():
    cfg = make_single_wall_depth_config()
    assert cfg.mode == "depth"
    assert cfg.serves("cam0", "A") is True
    assert cfg.walls["A"].plane is not None


# --------------------------------------------------------------------------- #
# single-wall depth fusion                                                     #
# --------------------------------------------------------------------------- #
def test_single_wall_center_hit_emits_one_cursor():
    eng = DepthFusionEngine(make_single_wall_depth_config())
    out = eng.update([make_track(7, ray_toward(1.0, 1.0))], t=0.0)
    assert set(out) == {"A"}                        # the ONLY wall key
    assert len(out["A"]) == 1
    cur = out["A"][0]
    assert cur.person_id == 7
    assert (cur.x, cur.y) == pytest.approx((0.5, 0.5))


def test_single_wall_update_always_returns_wall_key():
    eng = DepthFusionEngine(make_single_wall_depth_config())
    assert eng.update([], t=0.0) == {"A": []}


def test_single_wall_no_adjacency_means_no_sticky_band():
    # Historical behaviour pinned: without adjacency (and without edge_margin)
    # the wall's band is 0, so a ray a hair past the edge emits NOTHING —
    # there is no seam-margin stickiness to inherit from a second wall.
    eng = DepthFusionEngine(make_single_wall_depth_config())
    assert eng._seam_margin == {"A": 0.0}

    eng.update([make_track(5, ray_toward(1.0, 1.0))], t=0.0)   # acquire A
    out = eng.update([make_track(5, ray_toward(2.04, 1.0))], t=0.05)  # u=1.02
    assert out == {"A": []}


def test_edge_margin_gives_sticky_clamped_edge_on_single_wall():
    # With edge_margin 0.06 the same just-past-the-edge ray (u=1.02) stays
    # sticky on the current wall and renders clamped to the border, exactly
    # like the two-wall seam band behaves.
    eng = DepthFusionEngine(make_single_wall_depth_config(edge_margin=0.06))
    assert eng._seam_margin == {"A": 0.06}

    eng.update([make_track(5, ray_toward(1.0, 1.0))], t=0.0)   # acquire A
    out = eng.update([make_track(5, ray_toward(2.04, 1.0))], t=0.05)  # u=1.02
    assert len(out["A"]) == 1
    assert out["A"][0].x == pytest.approx(1.0)      # clamped to the edge

    # Clearly past the grown band (u=1.2 > 1.06) the cursor drops as before.
    out2 = eng.update([make_track(5, ray_toward(2.4, 1.0))], t=0.10)
    assert out2 == {"A": []}


def test_edge_margin_does_not_allow_fresh_acquisition_out_of_bounds():
    # The band is sticky-only: a NEW track landing outside the plain [0,1]^2
    # (u=1.02) cannot acquire the wall, mirroring seam semantics.
    eng = DepthFusionEngine(make_single_wall_depth_config(edge_margin=0.06))
    out = eng.update([make_track(9, ray_toward(2.04, 1.0))], t=0.0)
    assert out == {"A": []}


def test_edge_margin_maxes_with_adjacency_seam_margin():
    # On a multi-wall config the per-wall band is max(edge_margin, seam):
    # wall A's explicit 0.10 wins over the 0.06 seam; wall B keeps the seam.
    identity3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    data = {
        "walls": {
            "A": {"display": 1, "grid": {"rows": 2, "cols": 3},
                  "edge_margin": 0.10},
            "B": {"display": 2, "grid": {"rows": 2, "cols": 3}},
        },
        "adjacency": [{"left": "A", "right": "B", "seam_margin": 0.06}],
        "cameras": {
            "cam0": {"device": 0, "serves": ["A", "B"]},
        },
        "calibration": {
            "cam0->A": {"matrix": identity3},
            "cam0->B": {"matrix": identity3},
        },
    }
    eng = FusionEngine(RoomConfig.from_dict(data))
    assert eng._seam_margin == {"A": 0.10, "B": 0.06}


# --------------------------------------------------------------------------- #
# server read-timeout policy                                                   #
# --------------------------------------------------------------------------- #
def test_frame_read_timeout_bounds_kinect_reads():
    assert frame_read_timeout("kinect_v2", 30) == pytest.approx(2.0 / 30.0)
    assert frame_read_timeout("kinect_v2", 0) == pytest.approx(2.0)  # fps guard


def test_frame_read_timeout_leaves_other_kinds_unbounded():
    # OrbbecSource recovers a dead pipeline ONLY on its no-timeout path, and
    # plain webcams never had a timeout: both must stay None.
    assert frame_read_timeout("gemini_335", 30) is None
    assert frame_read_timeout("orbbec", 30) is None
    assert frame_read_timeout("rgb", 30) is None
