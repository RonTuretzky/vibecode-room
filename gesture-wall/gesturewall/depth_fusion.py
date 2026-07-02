"""Map fused multi-camera tracks onto wall cursors via 3D ray/plane pointing.

This is the depth-mode sibling of :mod:`gesturewall.fusion`. Where
:class:`~gesturewall.fusion.FusionEngine` lands each track on a wall by pushing
its pointing wrist through a location-locked ``cam->wall``
:class:`~gesturewall.calibration.Homography`,
:class:`DepthFusionEngine` instead casts the track member's **3D pointing ray**
(eye-origin -> wrist, already in the room frame) at every wall's 3D
:class:`~gesturewall.geometry.WallPlane` and reads off the hit's ``(u, v)``.
Because the ray lives in the room frame, the mapping is *invariant to where the
person stands* — they can roam the room and still point at the same wall pixel.

Only candidate gathering changes. We override
:meth:`FusionEngine._candidates_for_track`; the seam hand-off
(:func:`~gesturewall.fusion.choose_wall` hysteresis), :meth:`update`,
:class:`~gesturewall.fusion.Cursor` emission and near-seam clamping are all
inherited from :class:`FusionEngine` unchanged, and we reuse its
:class:`~gesturewall.fusion.WallCandidate`.

For each wall and each member observation whose :class:`Person` carries a 3D
``ray``, we intersect the ray with that wall's plane. A hit ``(u, v, t)`` with
``t > 0`` that lands inside ``[0, 1]^2`` grown by the wall's seam band becomes a
:class:`~gesturewall.fusion.WallCandidate` (``in_bounds`` records whether it is
strictly inside the unit square); the highest-confidence such candidate wins the
wall. A ray that misses every plane (parallel, behind, or off the rectangle even
with the sticky band) yields no candidate for that wall.

This module is pure: it depends only on :mod:`gesturewall.fusion`,
:mod:`gesturewall.geometry` (via the rays/planes it is handed) and the
:class:`Track`/:class:`Person` data carriers. No cv2/mediapipe/asyncio.
"""

from __future__ import annotations

from .fusion import FusionEngine, WallCandidate, _in_unit_square
from .tracking import Track


class DepthFusionEngine(FusionEngine):
    """A :class:`FusionEngine` that lands tracks via 3D ray/plane pointing.

    Drop-in for the homography engine in depth mode: construct it with a
    depth-mode :class:`~gesturewall.room.RoomConfig` (every served wall has a
    :class:`~gesturewall.geometry.WallPlane`) and feed it tracks whose member
    :class:`Person`s carry a room-frame ``ray``. All of the seam-hysteresis and
    cursor-emission behaviour is inherited from :class:`FusionEngine`.
    """

    def _candidates_for_track(self, track: Track) -> dict[str, WallCandidate]:
        """Best ray/plane landing per wall for one (engaged) track.

        For each wall we intersect every member's pointing ray with the wall's
        3D plane. A hit in front of the eye (``t > 0``) whose ``(u, v)`` falls
        inside the wall grown by its seam margin is kept (so a near-seam point
        survives for the sticky check), recording ``in_bounds`` = strictly
        inside ``[0, 1]^2``. The highest-confidence kept hit becomes the wall's
        candidate. Members without a ray, and walls without a plane, contribute
        nothing.
        """
        candidates: dict[str, WallCandidate] = {}
        for wall in self._walls:
            plane = self.config.walls[wall].plane
            if plane is None:
                continue  # no 3D plane for this wall -> nothing to point at
            band = self._seam_margin.get(wall, 0.0)
            best: WallCandidate | None = None
            for obs in track.members:
                person = obs.person
                ray = getattr(person, "ray", None)
                if ray is None:
                    continue  # this observation has no pointing ray
                hit = plane.intersect(ray)
                if hit is None:
                    continue  # ray is parallel to / behind this wall
                u, v, _t = hit
                if not _in_unit_square(u, v, margin=band):
                    continue  # past even the sticky band -> not a candidate
                conf = float(person.confidence)
                cand = WallCandidate(
                    wall=wall, x=u, y=v, confidence=conf,
                    in_bounds=_in_unit_square(u, v))
                if best is None or conf > best.confidence:
                    best = cand
            if best is not None:
                candidates[wall] = best
        return candidates
