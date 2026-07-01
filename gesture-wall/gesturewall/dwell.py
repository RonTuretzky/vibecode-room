"""Dwell-to-select state machine with hysteresis and a cooldown.

Why dwell? In a head-to-head of mid-air selection triggers (push / tap / dwell /
pinch), dwell was the *slowest but most accurate (0% error) and least fatiguing*
method (MacKenzie et al., ISS 2022). Crucially it needs no finger detail — only
the cursor position — so it works at a distance where individual fingers can't
be resolved. We use it as the primary select/deselect trigger.

Design points baked in here:
  * **Toggle** semantics: dwelling on a zone flips its selected state, so the
    same gesture both selects and deselects (what the user asked for).
  * **Hysteresis**: once a zone is being dwelt on it "sticks" until the cursor
    leaves a slightly larger outer band, so edge jitter doesn't reset progress.
  * **Cooldown** after a commit prevents an immediate accidental re-fire
    (debouncing the Midas-touch problem).
  * **Engagement gating**: when the user isn't engaged (e.g. arm lowered) the
    machine resets — no hovering = no accidental selection.
"""

from __future__ import annotations

from dataclasses import dataclass

from .zones import Zone


@dataclass
class DwellEvent:
    zone_id: str
    selected: bool      # the zone's NEW state after the toggle


class DwellSelector:
    def __init__(self, dwell_seconds: float = 0.8,
                 cooldown_seconds: float = 0.4,
                 hysteresis: float = 0.15):
        if dwell_seconds <= 0:
            raise ValueError("dwell_seconds must be > 0")
        if cooldown_seconds < 0:
            raise ValueError("cooldown_seconds must be >= 0")
        # >= 0.5 would invert a zone's inner core (never acquirable) and grow the
        # sticky band past neighbouring tiles. Mirrors build_grid's padding check.
        if not (0.0 <= hysteresis < 0.5):
            raise ValueError("hysteresis must be in [0, 0.5)")
        self.dwell_seconds = dwell_seconds
        self.cooldown_seconds = cooldown_seconds
        self.hysteresis = hysteresis      # fraction of a zone's size

        self.active_zone: Zone | None = None
        self.progress: float = 0.0        # 0..1, for the UI ring
        self._enter_time: float | None = None
        self._cooldown_until: float = 0.0

    def reset(self) -> None:
        self.active_zone = None
        self.progress = 0.0
        self._enter_time = None

    def _resolve_target(self, zones: list[Zone], x: float, y: float) -> Zone | None:
        # Sticky: keep the current zone while still within its grown outer band.
        if self.active_zone is not None and \
                self.active_zone.contains(x, y, margin=-self.hysteresis):
            return self.active_zone
        # Otherwise acquire a new zone, preferring its shrunk inner core...
        core = next((z for z in zones if z.contains(x, y, margin=self.hysteresis)),
                    None)
        if core is not None:
            return core
        # ...falling back to plain containment.
        return next((z for z in zones if z.contains(x, y)), None)

    def update(self, zones: list[Zone], cursor: tuple[float, float] | None,
               t: float, engaged: bool = True) -> DwellEvent | None:
        """Advance the machine by one frame.

        cursor: (x, y) in normalized wall coords, or None if unavailable.
        t:      current time in seconds (monotonic, e.g. time.perf_counter()).
        Returns a DwellEvent on the frame a selection commits, else None.
        """
        if not engaged or cursor is None:
            self.reset()
            return None

        # During the post-selection cooldown we hold everything idle.
        if t < self._cooldown_until:
            self.active_zone = None
            self.progress = 0.0
            self._enter_time = None
            return None

        target = self._resolve_target(zones, cursor[0], cursor[1])
        if target is None:
            self.reset()
            return None

        if target is not self.active_zone:
            # Newly entered a zone: (re)start the dwell timer.
            self.active_zone = target
            self._enter_time = t
            self.progress = 0.0
            return None

        # Same zone as last frame: accumulate dwell time.
        assert self._enter_time is not None
        elapsed = t - self._enter_time
        self.progress = max(0.0, min(1.0, elapsed / self.dwell_seconds))

        if elapsed >= self.dwell_seconds:
            target.selected = not target.selected
            event = DwellEvent(zone_id=target.id, selected=target.selected)
            self._cooldown_until = t + self.cooldown_seconds
            self.reset()
            return event

        return None
