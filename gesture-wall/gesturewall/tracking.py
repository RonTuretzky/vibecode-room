"""Cross-camera, cross-time person tracking ("who is who" in the room).

Several cameras can see the same physical person at once, and each camera
reports that person once per frame as a :class:`Person` (its hip-midpoint
``anchor`` already mapped into the shared room/floor frame by the server). This
module fuses those scattered observations into stable :class:`Track` objects —
one per real person — that keep a constant ``id`` across frames so a wall can
follow "user 7" even as they move between camera fields of view.

The algorithm is deliberately small and deterministic so it is fully
unit-testable headless (no cv2/mediapipe/camera):

  1. **Cluster** this frame's observations across cameras: greedily group
     observations whose ``room_xy`` lie within ``merge_radius`` of each other,
     with *at most one observation per camera per cluster* (a person is seen at
     most once by any single camera). Largest/closest groups form first.
  2. **Match** clusters to existing tracks by nearest ``room_xy`` within
     ``merge_radius`` (greedy, closest pair first). A matched track is updated
     in place, keeping its id.
  3. Unmatched clusters become **new tracks** with a fresh incrementing id
     (ids start at 1 and are never reused).
  4. Tracks not seen for longer than ``max_age`` are **dropped**.

Returned tracks are sorted by id.

This module is pure logic: it depends only on the standard library and on the
:class:`Person` data model. ``Person`` is imported from
:mod:`gesturewall.multipose`; if that module is not importable (it lazily pulls
in cv2/mediapipe only inside the camera class, so importing it is normally
safe), an identical fallback dataclass is used so tracking stays importable.
"""

from __future__ import annotations

from dataclasses import dataclass, field

try:  # Person lives in multipose; importing it must not require a camera.
    from .multipose import Person
except Exception:  # pragma: no cover - exercised only before multipose lands
    @dataclass
    class Person:  # type: ignore[no-redef]
        """One detected body in one camera frame (normalized image coords).

        Fallback definition, structurally identical to
        :class:`gesturewall.multipose.Person`. ``anchor`` is the hip midpoint
        used as the location/identity handle; ``engaged`` means the pointing
        wrist is raised above its shoulder and visible.
        """

        wrist: tuple[float, float]
        shoulder: tuple[float, float]
        anchor: tuple[float, float]
        engaged: bool
        confidence: float


@dataclass
class RoomObs:
    """One :class:`Person` observation lifted into the shared room frame.

    ``room_xy`` is the person's ``anchor`` mapped through the observing
    camera's room-homography (or the raw anchor when the camera has no floor
    calibration). ``camera_id`` identifies which camera produced it, so a
    cluster can enforce "at most one observation per camera".

    ``frame_id`` names the rigid coordinate frame ``room_xy`` lives in. In a
    registered room every camera shares one frame (the default ``"room"``); in
    a DECOUPLED room each camera keeps its own unregistered frame, so distances
    between observations from different frames are meaningless and must never
    be compared — clustering and track matching only happen within one frame.
    """

    camera_id: str
    person: Person
    room_xy: tuple[float, float]
    frame_id: str = "room"


@dataclass
class Track:
    """A real person, fused across cameras and time, with a stable id."""

    id: int
    room_xy: tuple[float, float]
    engaged: bool
    last_seen: float
    members: list[RoomObs] = field(default_factory=list)
    frame_id: str = "room"


# --------------------------------------------------------------------------- #
# pure geometry helpers (unit-testable in isolation)                           #
# --------------------------------------------------------------------------- #
def distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Euclidean distance between two room-frame points."""
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    return (dx * dx + dy * dy) ** 0.5


def mean_point(points: list[tuple[float, float]]) -> tuple[float, float]:
    """Centroid of a non-empty list of points."""
    if not points:
        raise ValueError("mean_point requires at least one point")
    n = float(len(points))
    return (sum(p[0] for p in points) / n, sum(p[1] for p in points) / n)


def cluster_observations(obs: list[RoomObs],
                         merge_radius: float) -> list[list[RoomObs]]:
    """Greedily group observations of (presumably) the same person.

    Two observations may share a cluster only when their ``room_xy`` are within
    ``merge_radius`` AND they come from different cameras — a single camera
    sees a given person at most once, so two observations from the same camera
    are necessarily two different people. They must also share a ``frame_id``:
    coordinates from unregistered frames are incommensurable, so two nearby
    numbers from different frames say nothing about being the same person.

    Deterministic: seeds are tried in input order; for each seed the nearest
    eligible observation (closest first) from each not-yet-used camera is
    absorbed, measuring distance to the seed. Returns one list of members per
    cluster, in the order clusters were seeded.
    """
    remaining = list(obs)
    clusters: list[list[RoomObs]] = []

    while remaining:
        seed = remaining.pop(0)
        cluster = [seed]
        used_cameras = {seed.camera_id}

        # Candidates: close enough to the seed and from an unused camera.
        # Sort by distance so the closest observation wins each camera slot.
        candidates = sorted(
            (o for o in remaining
             if o.camera_id not in used_cameras
             and o.frame_id == seed.frame_id
             and distance(o.room_xy, seed.room_xy) <= merge_radius),
            key=lambda o: distance(o.room_xy, seed.room_xy),
        )
        for cand in candidates:
            if cand.camera_id in used_cameras:
                continue  # an earlier (closer) candidate already took this camera
            cluster.append(cand)
            used_cameras.add(cand.camera_id)
            remaining.remove(cand)

        clusters.append(cluster)

    return clusters


def cluster_centroid(cluster: list[RoomObs]) -> tuple[float, float]:
    """Mean ``room_xy`` of a cluster's member observations."""
    return mean_point([o.room_xy for o in cluster])


# --------------------------------------------------------------------------- #
# the tracker                                                                  #
# --------------------------------------------------------------------------- #
class Tracker:
    """Fuse per-frame :class:`RoomObs` into persistent :class:`Track` objects.

    Parameters
    ----------
    merge_radius:
        Maximum room-frame distance for two observations to be the same person,
        and for a cluster to bind to an existing track.
    max_age:
        A track is dropped once ``t - last_seen`` exceeds this (seconds).
    """

    def __init__(self, merge_radius: float, max_age: float):
        if merge_radius <= 0:
            raise ValueError("merge_radius must be > 0")
        if max_age <= 0:
            raise ValueError("max_age must be > 0")
        self.merge_radius = float(merge_radius)
        self.max_age = float(max_age)
        self._tracks: dict[int, Track] = {}
        self._next_id = 1            # ids start at 1 and are never reused

    def update(self, obs: list[RoomObs], t: float) -> list[Track]:
        """Advance tracking by one frame and return the active tracks (by id)."""
        clusters = cluster_observations(obs, self.merge_radius)

        # --- match clusters to existing tracks (greedy, closest pair first) --
        existing = list(self._tracks.values())
        centroids = [cluster_centroid(c) for c in clusters]

        pairs: list[tuple[float, int, int]] = []  # (dist, cluster_idx, track_id)
        for ci, centroid in enumerate(centroids):
            frame = clusters[ci][0].frame_id
            for track in existing:
                if track.frame_id != frame:
                    continue  # distances across unregistered frames mean nothing
                d = distance(centroid, track.room_xy)
                if d <= self.merge_radius:
                    pairs.append((d, ci, track.id))
        pairs.sort(key=lambda p: (p[0], p[1], p[2]))

        matched_clusters: set[int] = set()
        matched_tracks: set[int] = set()
        for d, ci, track_id in pairs:
            if ci in matched_clusters or track_id in matched_tracks:
                continue
            self._absorb(self._tracks[track_id], clusters[ci], centroids[ci], t)
            matched_clusters.add(ci)
            matched_tracks.add(track_id)

        # --- unmatched clusters become brand-new tracks ----------------------
        for ci, cluster in enumerate(clusters):
            if ci in matched_clusters:
                continue
            track = Track(
                id=self._next_id,
                room_xy=centroids[ci],
                engaged=any(o.person.engaged for o in cluster),
                last_seen=t,
                members=list(cluster),
                frame_id=cluster[0].frame_id,
            )
            self._tracks[track.id] = track
            self._next_id += 1

        # --- expire stale tracks --------------------------------------------
        for track_id in [tid for tid, tr in self._tracks.items()
                         if t - tr.last_seen > self.max_age]:
            del self._tracks[track_id]

        return sorted(self._tracks.values(), key=lambda tr: tr.id)

    @staticmethod
    def _absorb(track: Track, cluster: list[RoomObs],
                centroid: tuple[float, float], t: float) -> None:
        track.room_xy = centroid
        track.engaged = any(o.person.engaged for o in cluster)
        track.members = list(cluster)
        track.last_seen = t

    @property
    def tracks(self) -> list[Track]:
        """Currently-live tracks, sorted by id (without advancing time)."""
        return sorted(self._tracks.values(), key=lambda tr: tr.id)
