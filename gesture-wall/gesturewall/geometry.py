"""Pure 3D geometry for the depth-ray pointing path.

This module is **pure**: ``numpy`` is allowed (always available) but no ``cv2``
or ``mediapipe``. Importing it never needs a camera.

Coordinate conventions (LOCKED):

* 3D points/vectors are Python tuples ``(float, float, float)``.
* **Camera** frame = OpenCV: ``+Z`` forward into the scene, ``+X`` right,
  ``+Y`` down; depth is ``+Z``.
* **Room** frame = right-handed, ``+Y`` up, floor = ``XZ`` plane;
  ``floor_xy(p) = (p[0], p[2])``.
* Depth values handed to geometry are in **meters**.
* Pinhole deproject: ``X=(px-cx)*d/fx``, ``Y=(py-cy)*d/fy``, ``Z=d``.

It provides the small vector helpers, :class:`CameraIntrinsics`,
:class:`Extrinsic`, :class:`Ray`, :class:`WallPlane`, depth sampling, and the
calibration helpers :func:`plane_from_corners` and
:func:`rigid_transform_from_points`.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite, sqrt

Vec3 = "tuple[float, float, float]"


# --------------------------------------------------------------------------- #
# pure 3-vector helpers (tuples)                                               #
# --------------------------------------------------------------------------- #
def v_add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def v_sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def v_dot(a, b) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def v_cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def v_scale(a, s: float):
    return (a[0] * s, a[1] * s, a[2] * s)


def v_norm(a) -> float:
    return sqrt(v_dot(a, a))


def v_normalize(a):
    n = v_norm(a)
    if n < 1e-12:
        raise ValueError("cannot normalize a zero-length vector")
    return (a[0] / n, a[1] / n, a[2] / n)


def floor_xy(p):
    """Project a room-frame 3D point onto the floor (XZ) plane."""
    return (p[0], p[2])


# --------------------------------------------------------------------------- #
# CameraIntrinsics                                                             #
# --------------------------------------------------------------------------- #
@dataclass
class CameraIntrinsics:
    """Pinhole intrinsics for a depth/IR camera (OpenCV camera frame)."""

    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int

    def deproject(self, px: float, py: float, depth_m: float):
        """Pixel + metric depth -> 3D point in the **camera** frame."""
        x = (px - self.cx) * depth_m / self.fx
        y = (py - self.cy) * depth_m / self.fy
        z = depth_m
        return (x, y, z)

    def project(self, x: float, y: float, z: float):
        """3D camera-frame point -> pixel ``(px, py)``.

        Raises :class:`ValueError` when ``z <= 0`` (behind / on the camera).
        """
        if z <= 0:
            raise ValueError(f"cannot project a point with z={z!r} <= 0")
        px = x * self.fx / z + self.cx
        py = y * self.fy / z + self.cy
        return (px, py)


# --------------------------------------------------------------------------- #
# Extrinsic (CAMERA -> ROOM)                                                   #
# --------------------------------------------------------------------------- #
@dataclass
class Extrinsic:
    """A 4x4 row-major homogeneous transform mapping CAMERA -> ROOM."""

    matrix: list  # 4x4 list of lists

    @classmethod
    def identity(cls) -> "Extrinsic":
        return cls(matrix=[[1.0, 0.0, 0.0, 0.0],
                           [0.0, 1.0, 0.0, 0.0],
                           [0.0, 0.0, 1.0, 0.0],
                           [0.0, 0.0, 0.0, 1.0]])

    @classmethod
    def from_rt(cls, R, t) -> "Extrinsic":
        """Build from a 3x3 rotation ``R`` and a 3-vector translation ``t``."""
        return cls(matrix=[
            [float(R[0][0]), float(R[0][1]), float(R[0][2]), float(t[0])],
            [float(R[1][0]), float(R[1][1]), float(R[1][2]), float(t[1])],
            [float(R[2][0]), float(R[2][1]), float(R[2][2]), float(t[2])],
            [0.0, 0.0, 0.0, 1.0],
        ])

    def apply(self, p):
        """Transform a 3D **point** (homogeneous, w=1)."""
        m = self.matrix
        x = m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + m[0][3]
        y = m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + m[1][3]
        z = m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + m[2][3]
        return (x, y, z)

    def apply_dir(self, v):
        """Transform a 3D **direction** (rotation only, no translation)."""
        m = self.matrix
        x = m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2]
        y = m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2]
        z = m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]
        return (x, y, z)

    def inverse(self) -> "Extrinsic":
        import numpy as np
        inv = np.linalg.inv(np.array(self.matrix, dtype=float))
        return Extrinsic(matrix=inv.tolist())


# --------------------------------------------------------------------------- #
# Ray                                                                          #
# --------------------------------------------------------------------------- #
@dataclass
class Ray:
    """A half-line: ``origin`` + t * ``direction`` (t >= 0)."""

    origin: tuple
    direction: tuple

    def unit_direction(self):
        return v_normalize(self.direction)


# --------------------------------------------------------------------------- #
# WallPlane (finite rectangle)                                                 #
# --------------------------------------------------------------------------- #
@dataclass
class WallPlane:
    """A finite rectangular wall.

    ``origin`` is the ``(u=0, v=0)`` corner; ``u_vec`` spans to ``(u=1, v=0)``
    and ``v_vec`` spans to ``(u=0, v=1)``. ``(u, v) in [0,1]^2`` is inside.
    """

    origin: tuple
    u_vec: tuple
    v_vec: tuple

    def normal(self):
        return v_normalize(v_cross(self.u_vec, self.v_vec))

    def intersect(self, ray: "Ray"):
        """Intersect ``ray`` with this plane.

        Returns ``(u, v, t)`` for a hit in front of the ray origin (``t > 0``),
        or ``None`` for a parallel ray or a hit behind the origin.
        """
        n = self.normal()
        denom = v_dot(ray.direction, n)
        if abs(denom) < 1e-9:
            return None
        t = v_dot(v_sub(self.origin, ray.origin), n) / denom
        if t <= 0:
            return None
        hit = v_add(ray.origin, v_scale(ray.direction, t))
        d = v_sub(hit, self.origin)
        u = v_dot(d, self.u_vec) / v_dot(self.u_vec, self.u_vec)
        v = v_dot(d, self.v_vec) / v_dot(self.v_vec, self.v_vec)
        return (u, v, t)


# --------------------------------------------------------------------------- #
# depth sampling                                                              #
# --------------------------------------------------------------------------- #
def sample_depth(depth_map, px, py, window: int = 5,
                 prefer_near: bool = False, near_band: float = 0.20):
    """Robustly sample depth in a ``window`` x ``window`` box around a pixel.

    ``depth_map`` is a 2D array (H rows x W cols) indexed ``[row=py, col=px]``;
    lists are accepted too. By default returns the median of valid (finite, > 0)
    depths. Returns ``None`` if no valid sample exists.

    With ``prefer_near=True`` it returns the median of just the **nearest
    cluster** — values within ``near_band`` metres of the closest valid depth in
    the box. This rejects background "flying pixels" that a small window over a
    thin, fast joint (a wrist) catches *behind* the hand, which would otherwise
    drag a plain median toward the far wall and throw the pointing ray off. The
    body is always the nearest surface at a body-joint pixel, so this is the
    right estimator for the wrist/eye/shoulder/hip.
    """
    import numpy as np

    arr = np.asarray(depth_map, dtype=float)
    if arr.ndim != 2:
        raise ValueError("depth_map must be a 2D array")
    h, w = arr.shape
    cx = int(px)
    cy = int(py)
    half = window // 2
    r0 = max(0, cy - half)
    r1 = min(h, cy + half + 1)
    c0 = max(0, cx - half)
    c1 = min(w, cx + half + 1)
    if r0 >= r1 or c0 >= c1:
        return None
    box = arr[r0:r1, c0:c1]
    valid = box[np.isfinite(box) & (box > 0)]
    if valid.size == 0:
        return None
    if prefer_near:
        near = float(valid.min())
        valid = valid[valid <= near + near_band]
    return float(np.median(valid))


# --------------------------------------------------------------------------- #
# calibration helpers                                                         #
# --------------------------------------------------------------------------- #
def plane_from_corners(top_left, top_right, bottom_left) -> "WallPlane":
    """Build a :class:`WallPlane` from three measured corners."""
    return WallPlane(
        origin=(float(top_left[0]), float(top_left[1]), float(top_left[2])),
        u_vec=v_sub(top_right, top_left),
        v_vec=v_sub(bottom_left, top_left),
    )


def fit_wall_plane(samples) -> "WallPlane":
    """Least-squares fit a :class:`WallPlane` from labeled samples.

    ``samples`` is an iterable of ``(u, v, point3)`` — each measured 3D
    ``point3`` together with its KNOWN plane coordinates ``(u, v)`` in
    ``[0, 1]^2`` (``(0,0)`` = the wall's origin/top-left corner, ``(1,0)`` =
    top-right, ``(0,1)`` = bottom-left). Solves for the plane's origin ``O`` and
    span vectors ``U, V`` that minimise ``sum ||O + u*U + v*V - point||^2`` — an
    independent linear regression per spatial axis (features ``[1, u, v]``).

    This generalises :func:`plane_from_corners`: any set of >= 3 points whose
    ``(u, v)`` are not collinear pins the whole plane, so you can calibrate from
    points that are NOT the four corners — e.g. the two seam corners plus the
    top/bottom edge midpoints when a close camera can't see the far corners. A
    flat wall is reconstructed exactly; with noise it is the best-fit plane.

    Raises :class:`ValueError` for < 3 samples or a degenerate (collinear ``uv``,
    or zero-span) configuration.
    """
    import numpy as np

    rows = list(samples)
    if len(rows) < 3:
        raise ValueError("need at least 3 samples to fit a wall plane")
    A = np.array([[1.0, float(u), float(v)] for (u, v, _p) in rows])
    B = np.array([[float(p[0]), float(p[1]), float(p[2])]
                  for (_u, _v, p) in rows])
    if np.linalg.matrix_rank(A) < 3:
        raise ValueError("samples are degenerate (collinear u/v); cannot fit a plane")
    coeffs, *_ = np.linalg.lstsq(A, B, rcond=None)  # rows: [O; U; V], each (x,y,z)
    origin = (float(coeffs[0][0]), float(coeffs[0][1]), float(coeffs[0][2]))
    u_vec = (float(coeffs[1][0]), float(coeffs[1][1]), float(coeffs[1][2]))
    v_vec = (float(coeffs[2][0]), float(coeffs[2][1]), float(coeffs[2][2]))
    if v_norm(u_vec) < 1e-9 or v_norm(v_vec) < 1e-9:
        raise ValueError("samples produced a zero-span plane (degenerate)")
    return WallPlane(origin=origin, u_vec=u_vec, v_vec=v_vec)


def rigid_transform_from_points(src, dst) -> "Extrinsic":
    """Best-fit rigid transform mapping ``src`` points onto ``dst`` points.

    Kabsch/Umeyama via SVD with a reflection (det) correction. Requires at
    least 3 non-collinear correspondences. Returns the CAMERA->ROOM
    :class:`Extrinsic` (when ``src`` are camera points and ``dst`` room points).
    """
    import numpy as np

    P = np.asarray(src, dtype=float)
    Q = np.asarray(dst, dtype=float)
    if P.shape != Q.shape or P.shape[0] < 3 or P.shape[1] != 3:
        raise ValueError(
            "need >=3 matching 3D correspondences (src and dst same shape)")
    cp = P.mean(axis=0)
    cq = Q.mean(axis=0)
    Pc = P - cp
    Qc = Q - cq
    H = Pc.T @ Qc
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    D = np.diag([1.0, 1.0, d])
    R = Vt.T @ D @ U.T
    t = cq - R @ cp
    return Extrinsic.from_rt(R.tolist(), t.tolist())
