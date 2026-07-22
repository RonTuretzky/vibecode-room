"""Headless tests for the cross-camera/-time person tracker.

Person/RoomObs inputs are built directly (no camera, no mediapipe), exercising
the pure clustering + matching + ageing logic.
"""

from __future__ import annotations

import pytest

from gesturewall.tracking import (
    Person, RoomObs, Track, Tracker, cluster_observations, distance,
    mean_point)


# --------------------------------------------------------------------------- #
# helpers                                                                       #
# --------------------------------------------------------------------------- #
def make_person(anchor: tuple[float, float], engaged: bool = False,
                confidence: float = 0.9) -> Person:
    """A minimal Person; only anchor/engaged/confidence matter for tracking."""
    return Person(
        wrist=anchor,
        shoulder=anchor,
        anchor=anchor,
        engaged=engaged,
        confidence=confidence,
    )


def obs(camera_id: str, room_xy: tuple[float, float], engaged: bool = False,
        confidence: float = 0.9, frame_id: str = "room") -> RoomObs:
    return RoomObs(
        camera_id=camera_id,
        person=make_person(room_xy, engaged=engaged, confidence=confidence),
        room_xy=room_xy,
        frame_id=frame_id,
    )


# --------------------------------------------------------------------------- #
# pure geometry helpers                                                         #
# --------------------------------------------------------------------------- #
def test_distance_is_euclidean():
    assert distance((0.0, 0.0), (3.0, 4.0)) == pytest.approx(5.0)


def test_mean_point_centroid():
    assert mean_point([(0.0, 0.0), (2.0, 4.0)]) == pytest.approx((1.0, 2.0))


def test_mean_point_empty_raises():
    with pytest.raises(ValueError):
        mean_point([])


# --------------------------------------------------------------------------- #
# clustering                                                                    #
# --------------------------------------------------------------------------- #
def test_two_cameras_one_person_clusters_together():
    clusters = cluster_observations(
        [obs("cam0", (0.50, 0.50)), obs("cam1", (0.52, 0.49))],
        merge_radius=0.35)
    assert len(clusters) == 1
    assert {o.camera_id for o in clusters[0]} == {"cam0", "cam1"}


def test_two_distant_people_stay_separate():
    clusters = cluster_observations(
        [obs("cam0", (0.10, 0.10)), obs("cam0", (0.90, 0.90))],
        merge_radius=0.35)
    assert len(clusters) == 2


def test_at_most_one_obs_per_camera_per_cluster():
    # Two observations from the SAME camera that are spatially close must NOT
    # share a cluster — one camera sees a person at most once.
    clusters = cluster_observations(
        [obs("cam0", (0.50, 0.50)), obs("cam0", (0.51, 0.50))],
        merge_radius=0.35)
    assert len(clusters) == 2
    for c in clusters:
        cams = [o.camera_id for o in c]
        assert len(cams) == len(set(cams))  # no repeated camera within a cluster


# --------------------------------------------------------------------------- #
# Tracker: fusion, identity, lifecycle                                          #
# --------------------------------------------------------------------------- #
def test_two_cameras_one_person_makes_one_track():
    tr = Tracker(merge_radius=0.35, max_age=0.5)
    tracks = tr.update(
        [obs("cam0", (0.50, 0.50)), obs("cam1", (0.52, 0.49))], t=0.0)
    assert len(tracks) == 1
    track = tracks[0]
    assert track.id == 1
    assert {o.camera_id for o in track.members} == {"cam0", "cam1"}
    # room_xy is the centroid of the two observations.
    assert track.room_xy == pytest.approx((0.51, 0.495))


def test_same_person_keeps_id_across_frames():
    tr = Tracker(merge_radius=0.35, max_age=0.5)
    t1 = tr.update([obs("cam0", (0.50, 0.50))], t=0.0)
    assert t1[0].id == 1
    # Person drifts a little between frames but stays within merge_radius.
    t2 = tr.update([obs("cam0", (0.55, 0.52))], t=0.1)
    assert len(t2) == 1
    assert t2[0].id == 1          # same identity
    assert t2[0].room_xy == pytest.approx((0.55, 0.52))
    assert t2[0].last_seen == pytest.approx(0.1)


def test_new_person_gets_new_id():
    tr = Tracker(merge_radius=0.20, max_age=0.5)
    tr.update([obs("cam0", (0.20, 0.20))], t=0.0)
    tracks = tr.update(
        [obs("cam0", (0.20, 0.20)), obs("cam0", (0.80, 0.80))], t=0.1)
    ids = sorted(t.id for t in tracks)
    assert ids == [1, 2]
    # The far observation is the newcomer.
    far = next(t for t in tracks if t.room_xy[0] > 0.5)
    assert far.id == 2


def test_track_drops_after_max_age():
    tr = Tracker(merge_radius=0.35, max_age=0.5)
    tr.update([obs("cam0", (0.50, 0.50))], t=0.0)
    # Just within max_age: still alive (boundary is exclusive on >).
    alive = tr.update([], t=0.5)
    assert [t.id for t in alive] == [1]
    # Past max_age: gone.
    gone = tr.update([], t=0.6)
    assert gone == []


def test_ids_are_never_reused():
    tr = Tracker(merge_radius=0.20, max_age=0.4)
    tr.update([obs("cam0", (0.30, 0.30))], t=0.0)   # -> id 1
    # Let id 1 expire.
    tr.update([], t=1.0)
    assert tr.tracks == []
    # A brand-new person must NOT reclaim id 1.
    tracks = tr.update([obs("cam0", (0.30, 0.30))], t=1.1)
    assert len(tracks) == 1
    assert tracks[0].id == 2


def test_engaged_is_or_of_members():
    tr = Tracker(merge_radius=0.35, max_age=0.5)
    tracks = tr.update(
        [obs("cam0", (0.50, 0.50), engaged=False),
         obs("cam1", (0.51, 0.50), engaged=True)],
        t=0.0)
    assert len(tracks) == 1
    assert tracks[0].engaged is True


def test_tracks_returned_sorted_by_id():
    tr = Tracker(merge_radius=0.15, max_age=0.5)
    # Three well-separated people in one frame.
    tracks = tr.update(
        [obs("cam0", (0.10, 0.10)),
         obs("cam0", (0.50, 0.50)),
         obs("cam0", (0.90, 0.90))],
        t=0.0)
    assert [t.id for t in tracks] == [1, 2, 3]


def test_persistent_and_new_person_coexist():
    tr = Tracker(merge_radius=0.20, max_age=0.5)
    tr.update([obs("cam0", (0.20, 0.20))], t=0.0)            # id 1
    # Frame 2: person 1 persists, a second person appears.
    tracks = tr.update(
        [obs("cam0", (0.22, 0.21)), obs("cam0", (0.80, 0.80))], t=0.1)
    by_id = {t.id: t for t in tracks}
    assert set(by_id) == {1, 2}
    assert by_id[1].room_xy == pytest.approx((0.22, 0.21))
    assert by_id[2].room_xy == pytest.approx((0.80, 0.80))


def test_dataclass_shapes():
    p = make_person((0.5, 0.5), engaged=True, confidence=0.8)
    o = RoomObs(camera_id="cam0", person=p, room_xy=(0.5, 0.5))
    t = Track(id=1, room_xy=(0.5, 0.5), engaged=True, last_seen=0.0,
              members=[o])
    assert t.members[0].person.confidence == pytest.approx(0.8)
    assert t.members[0].camera_id == "cam0"


# --------------------------------------------------------------------------- #
# frame separation (decoupled per-camera frames)                               #
# --------------------------------------------------------------------------- #
def test_cluster_never_crosses_frames():
    # Two DIFFERENT people at numerically identical coordinates, but each in
    # its own camera's unregistered frame: must stay two clusters. (With one
    # shared frame these would rightly merge — see the test above.)
    clusters = cluster_observations(
        [obs("cam0", (0.50, 0.50), frame_id="cam0"),
         obs("cam1", (0.50, 0.50), frame_id="cam1")],
        merge_radius=0.35)
    assert len(clusters) == 2


def test_track_matching_never_crosses_frames():
    # Identity theft scenario: cam0's person leaves; within max_age a DIFFERENT
    # person appears to cam1 at numerically nearby coordinates in cam1's OWN
    # frame. The cam1 cluster must get a NEW id, not inherit cam0's track.
    tr = Tracker(merge_radius=0.8, max_age=0.5)
    tracks = tr.update([obs("cam0", (0.5, 2.0), frame_id="cam0")], t=0.0)
    assert [t.id for t in tracks] == [1]
    tracks = tr.update([obs("cam1", (0.5, 2.1), frame_id="cam1")], t=0.2)
    by_id = {t.id: t for t in tracks}
    assert set(by_id) == {1, 2}                  # old track still alive, NEW id
    assert by_id[2].frame_id == "cam1"
    assert by_id[1].frame_id == "cam0"


def test_same_frame_tracking_unchanged_by_frame_id():
    # Within one frame the frame_id is invisible: same person keeps their id.
    tr = Tracker(merge_radius=0.35, max_age=0.5)
    tr.update([obs("cam0", (0.20, 0.20), frame_id="cam0")], t=0.0)
    tracks = tr.update([obs("cam0", (0.25, 0.22), frame_id="cam0")], t=0.1)
    assert [t.id for t in tracks] == [1]
