"""Unit tests for the cross-camera -> per-wall cursor fusion engine.

Everything here is headless and camera-free: we build a tiny in-memory
:class:`~gesturewall.room.RoomConfig` with two walls (A, B) and three cameras
(cam0 serves A; cam1 serves A and B; cam2 serves B), wire up simple
homographies (identity and a couple of known affines), then drive
:class:`~gesturewall.fusion.FusionEngine` with hand-built tracks.
"""

import pytest

from gesturewall.fusion import (
    Cursor, FusionEngine, Person, RoomObs, Track, WallCandidate, choose_wall)
from gesturewall.room import RoomConfig

IDENTITY = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]


# --------------------------------------------------------------------------- #
# config / data-builder helpers                                                #
# --------------------------------------------------------------------------- #
def make_config(calib_overrides: dict | None = None,
                seam_margin: float = 0.06) -> RoomConfig:
    """A 2-wall / 3-camera room. By default every calibration is identity.

    Pass ``calib_overrides`` to swap specific ``"<cam>-><wall>"`` matrices.
    """
    calibration = {
        "cam0->A": {"matrix": IDENTITY},
        "cam1->A": {"matrix": IDENTITY},
        "cam1->B": {"matrix": IDENTITY},
        "cam2->B": {"matrix": IDENTITY},
    }
    if calib_overrides:
        for key, matrix in calib_overrides.items():
            calibration[key] = {"matrix": matrix}
    data = {
        "walls": {
            "A": {"display": 1, "grid": {"rows": 2, "cols": 3}},
            "B": {"display": 2, "grid": {"rows": 2, "cols": 3}},
        },
        "adjacency": [{"left": "A", "right": "B", "seam_margin": seam_margin}],
        "cameras": {
            "cam0": {"device": 0, "serves": ["A"], "room_homography": None},
            "cam1": {"device": 1, "serves": ["A", "B"],
                     "room_homography": IDENTITY},
            "cam2": {"device": 2, "serves": ["B"], "room_homography": None},
        },
        "calibration": calibration,
        "fusion": {"mode": "highest_confidence", "merge_radius": 0.35,
                   "track_max_age": 0.5},
        "server": {"ws_port": 8770, "http_port": 8000, "fps": 30,
                   "num_poses": 4, "mirror": True, "min_confidence": 0.5,
                   "model": "models/pose_landmarker_lite.task"},
    }
    return RoomConfig.from_dict(data)


def make_person(wrist: tuple[float, float], *, engaged: bool = True,
                confidence: float = 0.9) -> Person:
    """A Person whose only field that matters to fusion is the wrist + conf."""
    return Person(wrist=wrist, shoulder=(wrist[0], wrist[1] + 0.2),
                  anchor=(0.5, 0.8), engaged=engaged, confidence=confidence)


def make_obs(camera_id: str, wrist: tuple[float, float], *,
             confidence: float = 0.9,
             room_xy: tuple[float, float] = (0.5, 0.5)) -> RoomObs:
    return RoomObs(camera_id=camera_id,
                   person=make_person(wrist, confidence=confidence),
                   room_xy=room_xy)


def make_track(track_id: int, members: list[RoomObs], *,
               engaged: bool = True,
               room_xy: tuple[float, float] = (0.5, 0.5),
               last_seen: float = 0.0) -> Track:
    return Track(id=track_id, room_xy=room_xy, engaged=engaged,
                 last_seen=last_seen, members=members)


# --------------------------------------------------------------------------- #
# basic mapping                                                                #
# --------------------------------------------------------------------------- #
def test_engaged_track_maps_inside_A_yields_one_cursor():
    cfg = make_config()
    eng = FusionEngine(cfg)
    track = make_track(7, [make_obs("cam0", (0.4, 0.3))])

    cursors = eng.update([track], t=0.0)

    assert set(cursors) == {"A", "B"}          # every wall key present
    assert cursors["B"] == []
    assert len(cursors["A"]) == 1
    cur = cursors["A"][0]
    assert isinstance(cur, Cursor)
    assert cur.person_id == 7
    assert cur.engaged is True
    assert cur.x == pytest.approx(0.4)
    assert cur.y == pytest.approx(0.3)
    assert cur.confidence == pytest.approx(0.9)


def test_homography_is_applied_to_wrist():
    # cam0->A shifts +0.1 in x and -0.2 in y; the cursor reflects that.
    cfg = make_config(calib_overrides={
        "cam0->A": [[1.0, 0.0, 0.1], [0.0, 1.0, -0.2], [0.0, 0.0, 1.0]]})
    eng = FusionEngine(cfg)
    track = make_track(1, [make_obs("cam0", (0.5, 0.5))])

    cur = eng.update([track], t=0.0)["A"][0]
    assert (cur.x, cur.y) == pytest.approx((0.6, 0.3))


def test_every_wall_key_present_even_when_empty():
    cfg = make_config()
    eng = FusionEngine(cfg)
    cursors = eng.update([], t=0.0)
    assert cursors == {"A": [], "B": []}


# --------------------------------------------------------------------------- #
# multi-camera selection                                                       #
# --------------------------------------------------------------------------- #
def test_highest_confidence_camera_wins_on_same_wall():
    # Both cam0 and cam1 serve A and both see this person in-bounds; the
    # higher-confidence observation must drive the cursor.
    cfg = make_config()
    eng = FusionEngine(cfg)
    track = make_track(3, [
        make_obs("cam0", (0.20, 0.20), confidence=0.55),
        make_obs("cam1", (0.80, 0.80), confidence=0.95),
    ])

    cur = eng.update([track], t=0.0)["A"][0]
    assert cur.confidence == pytest.approx(0.95)
    assert (cur.x, cur.y) == pytest.approx((0.80, 0.80))


def test_member_from_non_serving_camera_is_ignored():
    # cam2 does NOT serve A, so its observation must not produce an A cursor
    # even though, mapped through identity, it would land in-bounds.
    cfg = make_config()
    eng = FusionEngine(cfg)
    track = make_track(4, [make_obs("cam2", (0.5, 0.5))])

    cursors = eng.update([track], t=0.0)
    # cam2 serves B, so this maps to B, not A.
    assert cursors["A"] == []
    assert len(cursors["B"]) == 1
    assert cursors["B"][0].person_id == 4


# --------------------------------------------------------------------------- #
# engagement / out-of-bounds gating                                            #
# --------------------------------------------------------------------------- #
def test_non_engaged_track_yields_no_cursor():
    cfg = make_config()
    eng = FusionEngine(cfg)
    track = make_track(9, [make_obs("cam0", (0.4, 0.3))], engaged=False)

    cursors = eng.update([track], t=0.0)
    assert cursors == {"A": [], "B": []}


def test_out_of_bounds_mapping_yields_no_cursor():
    # cam0->A pushes the point well outside [0,1]^2 -> no cursor anywhere.
    cfg = make_config(calib_overrides={
        "cam0->A": [[1.0, 0.0, 2.0], [0.0, 1.0, 2.0], [0.0, 0.0, 1.0]]})
    eng = FusionEngine(cfg)
    track = make_track(2, [make_obs("cam0", (0.5, 0.5))])

    cursors = eng.update([track], t=0.0)
    assert cursors == {"A": [], "B": []}


def test_negative_mapping_is_also_out_of_bounds():
    cfg = make_config(calib_overrides={
        "cam0->A": [[1.0, 0.0, -1.0], [0.0, 1.0, -1.0], [0.0, 0.0, 1.0]]})
    eng = FusionEngine(cfg)
    track = make_track(2, [make_obs("cam0", (0.5, 0.5))])
    assert eng.update([track], t=0.0) == {"A": [], "B": []}


# --------------------------------------------------------------------------- #
# seam hand-off / hysteresis                                                   #
# --------------------------------------------------------------------------- #
def test_track_near_seam_sticks_to_current_wall():
    # Track is first clearly on A, becoming A's cursor. Then it drifts so that
    # A's candidate sits just past A's right edge (x = 1.04) -- still inside the
    # sticky band (seam_margin 0.06) -- while B simultaneously has a slightly
    # better candidate. Hysteresis must keep it on A.
    cfg = make_config(seam_margin=0.06)
    eng = FusionEngine(cfg)

    # frame 1: clearly on A via cam1 (which serves both walls).
    t1 = make_track(5, [make_obs("cam1", (0.5, 0.5), confidence=0.9)])
    out1 = eng.update([t1], t=0.0)
    assert len(out1["A"]) == 1 and out1["B"] == []

    # frame 2: cam1 (A view) lands at x=1.04 (inside A's grown band); cam2 (B
    # view) lands comfortably inside B with higher confidence.
    t2 = make_track(5, [
        make_obs("cam1", (1.04, 0.5), confidence=0.80),  # A candidate, sticky
        make_obs("cam2", (0.20, 0.5), confidence=0.95),  # B candidate, better
    ])
    out2 = eng.update([t2], t=0.05)
    assert len(out2["A"]) == 1, "should stay on A inside the sticky band"
    assert out2["B"] == []
    # The near-seam landing (raw x=1.04) is gated into the wall's [0,1] range.
    assert out2["A"][0].x == pytest.approx(1.0)


def test_track_switches_wall_once_clearly_past_margin():
    cfg = make_config(seam_margin=0.06)
    eng = FusionEngine(cfg)

    # Establish current wall = A.
    eng.update([make_track(5, [make_obs("cam1", (0.5, 0.5))])], t=0.0)

    # Now A's candidate is at x=1.20 -- clearly OUTSIDE A's grown band (1.06),
    # so it no longer sticks. B has a clean in-bounds candidate -> switch to B.
    t2 = make_track(5, [
        make_obs("cam1", (1.20, 0.5), confidence=0.9),   # out of A even grown
        make_obs("cam2", (0.30, 0.5), confidence=0.9),   # solid B candidate
    ])
    out2 = eng.update([t2], t=0.05)
    assert out2["A"] == [], "must leave A once clearly past the seam margin"
    assert len(out2["B"]) == 1
    assert out2["B"][0].person_id == 5
    assert out2["B"][0].x == pytest.approx(0.30)


def test_new_track_with_candidates_on_both_walls_picks_best():
    # No prior wall -> no stickiness -> highest confidence wins.
    cfg = make_config()
    eng = FusionEngine(cfg)
    track = make_track(8, [
        make_obs("cam1", (0.5, 0.5), confidence=0.70),   # A candidate
        make_obs("cam2", (0.5, 0.5), confidence=0.95),   # B candidate, better
    ])
    out = eng.update([track], t=0.0)
    assert out["A"] == []
    assert len(out["B"]) == 1
    assert out["B"][0].confidence == pytest.approx(0.95)


def test_disappeared_track_state_is_forgotten():
    cfg = make_config()
    eng = FusionEngine(cfg)
    eng.update([make_track(5, [make_obs("cam1", (0.5, 0.5))])], t=0.0)
    assert 5 in eng._current_wall
    eng.update([], t=0.1)            # track 5 gone
    assert 5 not in eng._current_wall


# --------------------------------------------------------------------------- #
# pure choose_wall helper                                                      #
# --------------------------------------------------------------------------- #
def test_choose_wall_no_candidates_returns_none():
    assert choose_wall("A", {}, seam_margin=0.06) is None
    assert choose_wall(None, {}, seam_margin=0.06) is None


def test_choose_wall_sticky_holds_current_inside_band():
    cands = {
        # x=1.04 is past A's plain edge (not in-bounds) but inside A grown by
        # 0.06 -> sticky, so we hold A despite B being a much better landing.
        "A": WallCandidate("A", x=1.04, y=0.5, confidence=0.5, in_bounds=False),
        "B": WallCandidate("B", x=0.2, y=0.5, confidence=0.99),
    }
    assert choose_wall("A", cands, seam_margin=0.06) == "A"


def test_choose_wall_switches_when_current_out_of_band():
    cands = {
        # x=1.20 is past A grown by 0.06 (1.06): not sticky, not in-bounds.
        "A": WallCandidate("A", x=1.20, y=0.5, confidence=0.9, in_bounds=False),
        "B": WallCandidate("B", x=0.3, y=0.5, confidence=0.8),
    }
    # A is neither sticky nor acquirable -> switch to the in-bounds B candidate.
    assert choose_wall("A", cands, seam_margin=0.06) == "B"


def test_choose_wall_new_track_picks_highest_confidence():
    cands = {
        "A": WallCandidate("A", x=0.5, y=0.5, confidence=0.6),
        "B": WallCandidate("B", x=0.5, y=0.5, confidence=0.9),
    }
    assert choose_wall(None, cands, seam_margin=0.06) == "B"


def test_choose_wall_tie_breaks_on_centrality():
    # Equal confidence: the more central landing wins.
    cands = {
        "A": WallCandidate("A", x=0.5, y=0.5, confidence=0.8),   # central
        "B": WallCandidate("B", x=0.02, y=0.5, confidence=0.8),  # edge
    }
    assert choose_wall(None, cands, seam_margin=0.06) == "A"
