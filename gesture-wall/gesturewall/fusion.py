"""Map fused multi-camera tracks onto wall cursors.

The :class:`~gesturewall.tracking.Tracker` gives us one :class:`Track` per real
person, each carrying the per-camera observations (:class:`RoomObs`) that were
fused to form it. This module turns those room-frame tracks into the *wall*
cursors a projected display actually renders.

For every engaged track we ask, for each wall the track could be pointing at:
*does the pointing wrist of one of this track's member observations land inside
that wall?* We take the member from a camera that **serves** the wall, push its
wrist through the ``cam->wall`` :class:`~gesturewall.calibration.Homography`,
and keep the mapped point only if it lands in ``[0, 1]^2``. Among the in-bounds
members for a wall we pick the **highest-confidence** one as that wall's
candidate. A track straddling a seam may produce a candidate on *both* walls.

**Seam hand-off (hysteresis).** Two adjacent walls share a physical seam, and a
person standing near it will flicker between the two displays frame to frame if
we naively pick "best candidate" every tick. So, mirroring
:class:`~gesturewall.dwell.DwellSelector`'s sticky-zone logic, the engine
remembers each track's *current* wall and keeps it as long as the track still
has a candidate there whose point is inside the wall **grown** by the seam
margin (a sticky outer band). Only when the track has no such sticky candidate
do we switch to the best fresh candidate (highest confidence; ties broken by
centrality). The decision is exposed as the pure helper :func:`choose_wall` so
it can be unit-tested in isolation.

This module is pure: no cv2/mediapipe/asyncio. It depends only on
:mod:`gesturewall.room`, :class:`~gesturewall.calibration.Homography`, and the
:class:`Track`/:class:`RoomObs`/:class:`Person` data carriers.
"""

from __future__ import annotations

from dataclasses import dataclass

from .room import RoomConfig

# Track/RoomObs (tracking) and Person (multipose) are the shared data carriers.
# The fusion engine only ever reads their contracted fields, so we import the
# real classes when their modules are present and otherwise fall back to local
# dataclasses with the identical field layout. This keeps fusion importable and
# its pure logic testable on its own, while integrating transparently once the
# sibling modules land.
try:  # pragma: no cover - exercised by integration, not unit, runs
    from .multipose import Person
except Exception:  # noqa: BLE001 - module may not exist yet during dev
    @dataclass
    class Person:  # type: ignore[no-redef]
        """One detected body in one camera frame (normalized image coords).

        Fallback mirror of :class:`gesturewall.multipose.Person`. See the
        project CONTRACT for field semantics.
        """

        wrist: tuple[float, float]
        shoulder: tuple[float, float]
        anchor: tuple[float, float]
        engaged: bool
        confidence: float


try:  # pragma: no cover - exercised by integration, not unit, runs
    from .tracking import RoomObs, Track
except Exception:  # noqa: BLE001 - module may not exist yet during dev
    @dataclass
    class RoomObs:  # type: ignore[no-redef]
        """One camera's view of a person, mapped into the room frame.

        Fallback mirror of :class:`gesturewall.tracking.RoomObs`.
        """

        camera_id: str
        person: Person
        room_xy: tuple[float, float]
        frame_id: str = "room"

    @dataclass
    class Track:  # type: ignore[no-redef]
        """A real person fused across cameras and time.

        Fallback mirror of :class:`gesturewall.tracking.Track`.
        """

        id: int
        room_xy: tuple[float, float]
        engaged: bool
        last_seen: float
        members: list[RoomObs]
        frame_id: str = "room"


@dataclass
class Cursor:
    """What a single wall renders for one person.

    ``x``/``y`` are in that wall's normalized coords, already gated to
    ``[0, 1]``. One cursor is emitted per (track, chosen wall).
    """

    person_id: int
    x: float
    y: float
    engaged: bool
    confidence: float


@dataclass
class WallCandidate:
    """A track's best landing on one wall this frame.

    ``x``/``y`` are the *raw* mapped coordinates (may sit just outside
    ``[0, 1]`` when the person is near the seam). ``in_bounds`` records whether
    the point is strictly inside the wall; only in-bounds candidates are
    eligible to *acquire* a wall, while a slightly-out one may still be *sticky*
    enough to hold the current wall (see :func:`choose_wall`).
    """

    wall: str
    x: float
    y: float
    confidence: float
    in_bounds: bool = True

    def centrality(self) -> float:
        """How central the point is, in [0, 0.5]; larger = more central.

        Used only as a deterministic tie-break between equally-confident
        candidates: the more centered landing wins over an edge-hugging one.
        """
        return min(self.x, 1.0 - self.x, self.y, 1.0 - self.y)

    def clamped(self) -> tuple[float, float]:
        """The landing gated into ``[0, 1]^2`` (what a wall actually renders)."""
        return (min(1.0, max(0.0, self.x)), min(1.0, max(0.0, self.y)))


# --------------------------------------------------------------------------- #
# pure helpers                                                                 #
# --------------------------------------------------------------------------- #
def _in_unit_square(x: float, y: float, margin: float = 0.0) -> bool:
    """True iff (x, y) is inside [0,1]^2 expanded by ``margin`` on each side.

    ``margin > 0`` grows the square (a sticky outer band); ``margin == 0`` is
    the plain wall bounds; ``margin < 0`` would shrink it.
    """
    return (-margin <= x <= 1.0 + margin) and (-margin <= y <= 1.0 + margin)


def _better(a: WallCandidate, b: WallCandidate) -> WallCandidate:
    """Return the preferred of two candidates: higher conf, then more central."""
    if a.confidence != b.confidence:
        return a if a.confidence > b.confidence else b
    if a.centrality() != b.centrality():
        return a if a.centrality() > b.centrality() else b
    # Fully deterministic final tie-break on wall id so results are stable.
    return a if a.wall <= b.wall else b


def choose_wall(current: str | None,
                candidates: dict[str, WallCandidate],
                seam_margin: float) -> str | None:
    """Pick which wall a track's cursor belongs on this frame (with hysteresis).

    ``current`` is the wall the track was on last frame (``None`` if new).
    ``candidates`` maps wall id -> that wall's best candidate this frame (raw
    mapped point; ``in_bounds`` flags whether it is strictly inside the wall).
    ``seam_margin`` is the sticky band width (a fraction of wall size).

    Rule (mirrors :class:`~gesturewall.dwell.DwellSelector`'s sticky zone):

      * **Sticky:** if the track still has a candidate on its ``current`` wall
        and that candidate's point is inside the wall *grown* by ``seam_margin``
        (i.e. it has not clearly crossed past the seam), keep ``current`` --
        even if it is fractionally past the wall's plain edge and even if
        another wall now has a marginally better candidate.
      * **Switch / acquire:** otherwise choose the best *strictly in-bounds*
        candidate -- highest confidence, ties broken by most-central landing,
        then by wall id. A candidate only sticky (out of plain bounds) cannot
        be acquired fresh.
      * **None:** if no candidate is in-bounds and none is sticky, the track
        maps onto no wall and emits nothing.

    Returns the chosen wall id, or ``None``.
    """
    if not candidates:
        return None

    if current is not None and current in candidates:
        cand = candidates[current]
        # Still within the grown (sticky) band -> hold the current wall even if
        # another wall now has a marginally better candidate, and even if this
        # point has crept just past the plain wall edge near the seam.
        if _in_unit_square(cand.x, cand.y, margin=seam_margin):
            return current

    best: WallCandidate | None = None
    for cand in candidates.values():
        if not cand.in_bounds:
            continue  # only strictly in-bounds landings can acquire a wall
        best = cand if best is None else _better(best, cand)
    return best.wall if best is not None else None


# --------------------------------------------------------------------------- #
# fusion engine                                                                #
# --------------------------------------------------------------------------- #
class FusionEngine:
    """Turn room-frame tracks into per-wall cursors, with seam hand-off.

    Stateful only in the per-track "current wall" memory used for hysteresis;
    everything else is recomputed each :meth:`update`.
    """

    def __init__(self, config: RoomConfig):
        self.config = config
        # Walls in declaration order; every update returns a list for each.
        self._walls: list[str] = list(config.walls.keys())
        # Per-wall seam margin: the largest seam_margin of any adjacency the
        # wall participates in (its sticky outer band). Walls with no seam get
        # 0.0, so they never "stick" beyond their plain bounds.
        self._seam_margin: dict[str, float] = {w: 0.0 for w in self._walls}
        for adj in config.adjacency:
            for side in (adj.left, adj.right):
                if side in self._seam_margin:
                    self._seam_margin[side] = max(
                        self._seam_margin[side], adj.seam_margin)
        # track id -> wall it currently maps onto (for hysteresis).
        self._current_wall: dict[int, str] = {}

    # --- candidate gathering --------------------------------------------- #
    def _candidates_for_track(self, track: Track) -> dict[str, WallCandidate]:
        """Best landing per wall for one (engaged) track.

        For each wall, look at the track's member observations from cameras
        that SERVE the wall, map each member's wrist through the cam->wall
        homography, and keep mapped points that fall inside the wall grown by
        its seam margin (so a near-seam point survives for the sticky check).
        Each kept candidate records ``in_bounds`` = strictly inside ``[0,1]^2``.
        The highest-confidence kept observation becomes that wall's candidate.
        """
        candidates: dict[str, WallCandidate] = {}
        for wall in self._walls:
            band = self._seam_margin.get(wall, 0.0)
            best: WallCandidate | None = None
            for obs in track.members:
                cam_id = obs.camera_id
                if not self.config.serves(cam_id, wall):
                    continue
                hom = self.config.cam_to_wall(cam_id, wall)
                wx, wy = obs.person.wrist
                ux, uy = hom.apply(wx, wy)
                if not _in_unit_square(ux, uy, margin=band):
                    continue  # past even the sticky band -> not a candidate
                conf = float(obs.person.confidence)
                cand = WallCandidate(
                    wall=wall, x=ux, y=uy, confidence=conf,
                    in_bounds=_in_unit_square(ux, uy))
                if best is None or conf > best.confidence:
                    best = cand
            if best is not None:
                candidates[wall] = best
        return candidates

    # --- main entry ------------------------------------------------------ #
    def update(self, tracks: list[Track], t: float) -> dict[str, list[Cursor]]:
        """Map ``tracks`` to per-wall cursors. Always returns every wall key."""
        out: dict[str, list[Cursor]] = {w: [] for w in self._walls}
        live_ids: set[int] = set()

        for track in tracks:
            live_ids.add(track.id)
            if not track.engaged:
                # An idle/lowered-arm track emits nothing, but we keep its
                # remembered wall so it re-acquires the same display on return.
                continue

            candidates = self._candidates_for_track(track)
            current = self._current_wall.get(track.id)
            seam = self._seam_margin.get(current, 0.0) if current else 0.0
            chosen = choose_wall(current, candidates, seam)
            if chosen is None:
                # No in-bounds candidate this frame: emit nothing. Keep the
                # remembered wall so a brief drop-out doesn't lose the seam state.
                continue

            self._current_wall[track.id] = chosen
            cand = candidates[chosen]
            cx, cy = cand.clamped()  # gate near-seam landings into [0,1]^2
            out[chosen].append(Cursor(
                person_id=track.id,
                x=cx,
                y=cy,
                engaged=True,
                confidence=cand.confidence,
            ))

        # Forget hysteresis state for tracks that have disappeared, so a reused
        # id (the tracker never reuses, but be defensive) starts fresh.
        stale = [tid for tid in self._current_wall if tid not in live_ids]
        for tid in stale:
            del self._current_wall[tid]

        return out
