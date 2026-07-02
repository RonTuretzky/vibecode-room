"""Map raw pointer coordinates onto the wall via a perspective homography.

The pose tracker reports a wrist position in the *camera image* frame. Because
the camera is rarely square-on to the user, and because a comfortable arm-reach
region is smaller than the full image, we warp the raw pointer through a 3x3
homography so that the four corners of the user's comfortable reach map to the
four corners of the wall. Calibration is a one-time "point at each corner" step
(see app.calibrate_pose); the result is saved to JSON and reloaded next run.

``apply`` is dependency-free (plain arithmetic) so it is unit-testable without
OpenCV. Computing a homography from point pairs uses OpenCV (a hard dependency
of the pose path anyway).
"""

from __future__ import annotations

import json
from pathlib import Path

# A homography (the wall corners, in normalized coords, that calibration targets
# map the user's reach onto). Slightly inset so corners are comfortably reachable.
WALL_CORNERS = [(0.05, 0.05), (0.95, 0.05), (0.95, 0.95), (0.05, 0.95)]
CORNER_NAMES = ["TOP-LEFT", "TOP-RIGHT", "BOTTOM-RIGHT", "BOTTOM-LEFT"]


class Homography:
    """A 3x3 perspective transform mapping (x, y) -> (x, y)."""

    def __init__(self, matrix: list[list[float]] | None = None):
        self.matrix = matrix or [[1.0, 0.0, 0.0],
                                 [0.0, 1.0, 0.0],
                                 [0.0, 0.0, 1.0]]

    @classmethod
    def identity(cls) -> "Homography":
        return cls()

    def apply(self, x: float, y: float) -> tuple[float, float]:
        m = self.matrix
        denom = m[2][0] * x + m[2][1] * y + m[2][2]
        if abs(denom) < 1e-12:
            return x, y
        u = (m[0][0] * x + m[0][1] * y + m[0][2]) / denom
        v = (m[1][0] * x + m[1][1] * y + m[1][2]) / denom
        return u, v

    # --- persistence -----------------------------------------------------
    def to_dict(self) -> dict:
        return {"matrix": self.matrix}

    @classmethod
    def from_dict(cls, d: dict) -> "Homography":
        return cls(matrix=[[float(v) for v in row] for row in d["matrix"]])

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_dict(), indent=2))

    @classmethod
    def load(cls, path: str | Path) -> "Homography":
        return cls.from_dict(json.loads(Path(path).read_text()))

    # --- construction from measured corner points ------------------------
    @classmethod
    def from_corner_points(cls, src_points: list[tuple[float, float]],
                           dst_points: list[tuple[float, float]] | None = None
                           ) -> "Homography":
        """Build a homography from 4 measured source points to the wall corners.

        src_points: the 4 raw pointer positions captured while the user pointed
                    at TOP-LEFT, TOP-RIGHT, BOTTOM-RIGHT, BOTTOM-LEFT (in order).
        """
        import cv2  # lazy: only needed when actually calibrating
        import numpy as np

        if len(src_points) != 4:
            raise ValueError("exactly 4 source points are required")
        # Reject collinear/coincident points up front rather than letting
        # cv2.getPerspectiveTransform return a wild, ill-conditioned matrix.
        area = 0.0
        for i in range(4):
            x1, y1 = src_points[i]
            x2, y2 = src_points[(i + 1) % 4]
            area += x1 * y2 - x2 * y1
        if abs(area) / 2.0 < 1e-6:
            raise ValueError("source points are degenerate (collinear/coincident)")
        dst = dst_points if dst_points is not None else WALL_CORNERS
        src = np.array(src_points, dtype=np.float32)
        dst_arr = np.array(dst, dtype=np.float32)
        m = cv2.getPerspectiveTransform(src, dst_arr)
        return cls(matrix=m.astype(float).tolist())
