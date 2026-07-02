"""gesturewall - coarse mid-air select/deselect on a projected wall.

A small, composable prototype:
    sources  -> pointer (mouse for testing, or webcam + MediaPipe pose)
    calibration -> homography mapping the pointer onto the wall
    filters  -> 1-Euro smoothing of the cursor
    zones    -> large selectable tiles
    dwell    -> dwell-to-select state machine (toggle, hysteresis, cooldown)
    app      -> render loop tying it together
"""

from .calibration import Homography
from .dwell import DwellEvent, DwellSelector
from .filters import OneEuroFilter, Point2DFilter
from .zones import Zone, build_grid, zone_at

__all__ = [
    "Homography",
    "DwellEvent",
    "DwellSelector",
    "OneEuroFilter",
    "Point2DFilter",
    "Zone",
    "build_grid",
    "zone_at",
]
