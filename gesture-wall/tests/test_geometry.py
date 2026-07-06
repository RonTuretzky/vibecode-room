"""Unit tests for the pure 3D geometry foundation (gesturewall.geometry).

Every test is headless and camera-free. The module imports no cv2/mediapipe;
numpy is used only inside a couple of functions, so importing the module is
cheap and the vector math below is exercised with plain Python tuples.

Covers (per the CONTRACT test list):
  * deproject / project round-trip (pinhole, OpenCV camera frame),
  * Extrinsic identity + from_rt + inverse round-trip + apply vs apply_dir,
  * Ray/WallPlane intersection hits a known (u, v) for an axis-aligned wall,
  * a parallel ray -> None and a behind-camera (t <= 0) hit -> None,
  * sample_depth median ignoring 0/NaN,
  * plane_from_corners axes,
  * rigid_transform_from_points recovering a known (R, t).
"""

import math

import numpy as np
import pytest

from gesturewall.geometry import (
    CameraIntrinsics,
    Extrinsic,
    Ray,
    WallPlane,
    floor_xy,
    plane_from_corners,
    rigid_transform_from_points,
    sample_depth,
    v_add,
    v_cross,
    v_dot,
    v_norm,
    v_normalize,
    v_scale,
    v_sub,
)


def approx_vec(a, b, tol=1e-9):
    """True iff two 3-vectors agree component-wise to ``tol``."""
    return all(abs(a[i] - b[i]) <= tol for i in range(3))


# --------------------------------------------------------------------------- #
# vector helpers                                                               #
# --------------------------------------------------------------------------- #
def test_vector_helpers_basic():
    a = (1.0, 2.0, 3.0)
    b = (4.0, -5.0, 6.0)
    assert v_add(a, b) == (5.0, -3.0, 9.0)
    assert v_sub(a, b) == (-3.0, 7.0, -3.0)
    assert v_dot(a, b) == pytest.approx(1 * 4 + 2 * -5 + 3 * 6)
    assert v_scale(a, 2.0) == (2.0, 4.0, 6.0)


def test_cross_product_is_right_handed():
    x = (1.0, 0.0, 0.0)
    y = (0.0, 1.0, 0.0)
    # x cross y == z in a right-handed frame.
    assert approx_vec(v_cross(x, y), (0.0, 0.0, 1.0))
    # antisymmetry
    assert approx_vec(v_cross(y, x), (0.0, 0.0, -1.0))


def test_norm_and_normalize():
    v = (3.0, 4.0, 0.0)
    assert v_norm(v) == pytest.approx(5.0)
    u = v_normalize(v)
    assert v_norm(u) == pytest.approx(1.0)
    assert approx_vec(u, (0.6, 0.8, 0.0))


def test_normalize_zero_length_raises():
    with pytest.raises(ValueError):
        v_normalize((0.0, 0.0, 0.0))


def test_floor_xy_drops_y():
    # Room frame: +Y is up; the floor is the XZ plane.
    assert floor_xy((1.0, 9.9, -2.0)) == (1.0, -2.0)


# --------------------------------------------------------------------------- #
# CameraIntrinsics: deproject / project                                        #
# --------------------------------------------------------------------------- #
def make_intrinsics():
    # Plausible Kinect v2 IR intrinsics.
    return CameraIntrinsics(fx=365.0, fy=365.0, cx=256.0, cy=212.0,
                            width=512, height=424)


def test_deproject_project_round_trip():
    intr = make_intrinsics()
    for px, py, d in [(256.0, 212.0, 2.0), (300.0, 100.0, 1.5),
                      (10.0, 400.0, 3.3), (511.0, 0.0, 0.75)]:
        X, Y, Z = intr.deproject(px, py, d)
        assert Z == pytest.approx(d)
        rpx, rpy = intr.project(X, Y, Z)
        assert rpx == pytest.approx(px)
        assert rpy == pytest.approx(py)


def test_deproject_principal_point_is_on_axis():
    intr = make_intrinsics()
    # A pixel at the principal point deprojects to (0, 0, d): straight ahead.
    X, Y, Z = intr.deproject(256.0, 212.0, 2.5)
    assert approx_vec((X, Y, Z), (0.0, 0.0, 2.5))


def test_deproject_signs_match_opencv_frame():
    intr = make_intrinsics()
    # +X right (px > cx), +Y down (py > cy), +Z forward.
    X, Y, Z = intr.deproject(intr.cx + 36.5, intr.cy + 36.5, 1.0)
    assert X > 0  # right of centre
    assert Y > 0  # below centre (image y grows downward)
    assert Z == pytest.approx(1.0)


def test_project_behind_camera_raises():
    intr = make_intrinsics()
    with pytest.raises(ValueError):
        intr.project(0.1, 0.1, 0.0)
    with pytest.raises(ValueError):
        intr.project(0.1, 0.1, -1.0)


# --------------------------------------------------------------------------- #
# Extrinsic                                                                     #
# --------------------------------------------------------------------------- #
def test_extrinsic_identity_apply():
    e = Extrinsic.identity()
    p = (1.0, -2.0, 3.0)
    assert approx_vec(e.apply(p), p)
    assert approx_vec(e.apply_dir(p), p)


def test_extrinsic_from_rt_apply_vs_apply_dir():
    # 90 deg rotation about Z, then translate.
    R = [[0.0, -1.0, 0.0],
         [1.0, 0.0, 0.0],
         [0.0, 0.0, 1.0]]
    t = [10.0, 20.0, 30.0]
    e = Extrinsic.from_rt(R, t)
    p = (1.0, 0.0, 0.0)
    # Points get rotated AND translated.
    assert approx_vec(e.apply(p), (0.0 + 10.0, 1.0 + 20.0, 0.0 + 30.0))
    # Directions get rotated ONLY (no translation).
    assert approx_vec(e.apply_dir(p), (0.0, 1.0, 0.0))


def test_extrinsic_inverse_round_trip():
    R = [[0.0, -1.0, 0.0],
         [1.0, 0.0, 0.0],
         [0.0, 0.0, 1.0]]
    t = [10.0, 20.0, 30.0]
    e = Extrinsic.from_rt(R, t)
    inv = e.inverse()
    for p in [(1.0, 2.0, 3.0), (-4.0, 0.5, 7.0), (0.0, 0.0, 0.0)]:
        assert approx_vec(inv.apply(e.apply(p)), p)
        assert approx_vec(e.apply(inv.apply(p)), p)
    # Direction inverse round-trips with rotation only.
    d = (3.0, -1.0, 2.0)
    assert approx_vec(inv.apply_dir(e.apply_dir(d)), d)


# --------------------------------------------------------------------------- #
# Ray + WallPlane intersection                                                 #
# --------------------------------------------------------------------------- #
def axis_aligned_wall():
    """A 2m-wide x 1m-tall wall standing on the floor, facing -Z.

    origin = (-1, 1, 5) is the top-left corner; u spans right (+X, width 2);
    v spans down (-Y, height 1). Its normal points back toward -Z.
    """
    return WallPlane(origin=(-1.0, 1.0, 5.0),
                     u_vec=(2.0, 0.0, 0.0),
                     v_vec=(0.0, -1.0, 0.0))


def test_wallplane_normal_unit_and_perpendicular():
    wall = axis_aligned_wall()
    n = wall.normal()
    assert v_norm(n) == pytest.approx(1.0)
    # Normal perpendicular to both spanning vectors.
    assert v_dot(n, wall.u_vec) == pytest.approx(0.0)
    assert v_dot(n, wall.v_vec) == pytest.approx(0.0)
    # cross(u, v) = (2,0,0) x (0,-1,0) = (0, 0, -2) -> normalized (0,0,-1).
    assert approx_vec(n, (0.0, 0.0, -1.0))


def test_ray_hits_known_uv():
    wall = axis_aligned_wall()
    # Aim from the origin straight at the wall centre (u=0.5, v=0.5).
    # Centre point = origin + 0.5*u + 0.5*v = (0, 0.5, 5).
    ray = Ray(origin=(0.0, 0.5, 0.0), direction=(0.0, 0.0, 1.0))
    hit = wall.intersect(ray)
    assert hit is not None
    u, v, t = hit
    assert u == pytest.approx(0.5)
    assert v == pytest.approx(0.5)
    assert t == pytest.approx(5.0)


def test_ray_hits_corner_uv():
    wall = axis_aligned_wall()
    # Aim at the (u=0, v=0) corner = the wall origin (-1, 1, 5).
    ray = Ray(origin=(-1.0, 1.0, 0.0), direction=(0.0, 0.0, 1.0))
    hit = wall.intersect(ray)
    assert hit is not None
    u, v, t = hit
    assert u == pytest.approx(0.0, abs=1e-9)
    assert v == pytest.approx(0.0, abs=1e-9)


def test_ray_outside_bounds_still_returns_uv():
    wall = axis_aligned_wall()
    # Hits the plane but well to the right of the rectangle: u > 1.
    ray = Ray(origin=(5.0, 0.5, 0.0), direction=(0.0, 0.0, 1.0))
    hit = wall.intersect(ray)
    assert hit is not None
    u, v, t = hit
    assert u > 1.0  # plane hit, but outside the finite wall


def test_parallel_ray_returns_none():
    wall = axis_aligned_wall()
    # Direction lies in the plane (perpendicular to the normal) -> parallel.
    ray = Ray(origin=(0.0, 0.5, 0.0), direction=(1.0, 0.0, 0.0))
    assert wall.intersect(ray) is None


def test_behind_camera_returns_none():
    wall = axis_aligned_wall()
    # Origin is in FRONT of the wall (z=10 > 5) aiming further forward (+Z):
    # the wall is behind the ray, so t would be negative -> None.
    ray = Ray(origin=(0.0, 0.5, 10.0), direction=(0.0, 0.0, 1.0))
    assert wall.intersect(ray) is None


def test_ray_unit_direction():
    ray = Ray(origin=(0.0, 0.0, 0.0), direction=(0.0, 0.0, 4.0))
    assert approx_vec(ray.unit_direction(), (0.0, 0.0, 1.0))


# --------------------------------------------------------------------------- #
# sample_depth                                                                  #
# --------------------------------------------------------------------------- #
def test_sample_depth_median_ignores_zero_and_nan():
    nan = float("nan")
    # A 5x5 box around (px=2, py=2): valid values are 1,2,3,4 ; zeros/NaN ignored.
    depth = [
        [0.0, 0.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, nan, 2.0, 0.0],
        [0.0, 0.0, 3.0, 0.0, 0.0],
        [0.0, 4.0, 0.0, nan, 0.0],
        [0.0, 0.0, 0.0, 0.0, 0.0],
    ]
    # median of {1,2,3,4} == 2.5
    assert sample_depth(depth, 2, 2, window=5) == pytest.approx(2.5)


def test_sample_depth_accepts_numpy_and_clamps_bounds():
    arr = np.full((10, 10), 2.0, dtype=float)
    arr[0, 0] = 7.0
    # Centre at the corner; the window clamps to the array, all valid -> median.
    val = sample_depth(arr, 0, 0, window=5)
    assert val is not None
    # The box around (0,0) is mostly 2.0 with a single 7.0; median is 2.0.
    assert val == pytest.approx(2.0)


def test_sample_depth_single_pixel_window():
    arr = np.full((4, 4), 5.0, dtype=float)
    arr[1, 3] = 9.0  # row=1 (py), col=3 (px)
    assert sample_depth(arr, 3, 1, window=1) == pytest.approx(9.0)


def test_sample_depth_all_invalid_returns_none():
    nan = float("nan")
    depth = [
        [0.0, 0.0, 0.0],
        [0.0, nan, 0.0],
        [0.0, 0.0, 0.0],
    ]
    assert sample_depth(depth, 1, 1, window=3) is None


def test_sample_depth_indexing_is_row_py_col_px():
    # Build a map where only (row=3, col=1) is valid; sampling that pixel with a
    # 1x1 window must read [py=3][px=1]. Confirms the [row=py, col=px] contract.
    arr = np.zeros((6, 6), dtype=float)
    arr[3, 1] = 1.23
    assert sample_depth(arr, 1, 3, window=1) == pytest.approx(1.23)
    # The transposed pixel is invalid -> None.
    assert sample_depth(arr, 3, 1, window=1) is None


# --------------------------------------------------------------------------- #
# plane_from_corners                                                            #
# --------------------------------------------------------------------------- #
def test_plane_from_corners_axes():
    tl = (-1.0, 1.0, 5.0)
    tr = (1.0, 1.0, 5.0)
    bl = (-1.0, 0.0, 5.0)
    wall = plane_from_corners(tl, tr, bl)
    assert approx_vec(wall.origin, tl)
    # u spans top-left -> top-right; v spans top-left -> bottom-left.
    assert approx_vec(wall.u_vec, (2.0, 0.0, 0.0))
    assert approx_vec(wall.v_vec, (0.0, -1.0, 0.0))
    # The three named corners land at the expected (u, v) parameters.
    n = wall.normal()
    # A ray from in front, through the top-right corner, lands at (u=1, v=0).
    ray = Ray(origin=v_add(tr, v_scale(n, -3.0)), direction=n)
    hit = wall.intersect(ray)
    assert hit is not None
    u, v, _t = hit
    assert u == pytest.approx(1.0)
    assert v == pytest.approx(0.0, abs=1e-9)


# --------------------------------------------------------------------------- #
# rigid_transform_from_points (Kabsch / Umeyama)                               #
# --------------------------------------------------------------------------- #
def rot_z(theta):
    c, s = math.cos(theta), math.sin(theta)
    return [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]


def test_rigid_transform_recovers_known_rt():
    R = rot_z(0.6)
    t = (1.5, -2.0, 0.75)
    known = Extrinsic.from_rt(R, t)
    src = [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0),
           (0.0, 0.0, 1.0), (1.0, 2.0, -1.0)]
    dst = [known.apply(p) for p in src]

    recovered = rigid_transform_from_points(src, dst)
    # The recovered transform reproduces dst from src.
    for p, q in zip(src, dst):
        assert approx_vec(recovered.apply(p), q, tol=1e-7)
    # And its matrix matches the known transform.
    for r in range(4):
        for col in range(4):
            assert recovered.matrix[r][col] == pytest.approx(
                known.matrix[r][col], abs=1e-7)


def test_rigid_transform_pure_rotation_no_translation():
    R = rot_z(-1.1)
    known = Extrinsic.from_rt(R, [0.0, 0.0, 0.0])
    src = [(1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), (2.0, -3.0, 4.0)]
    dst = [known.apply(p) for p in src]
    recovered = rigid_transform_from_points(src, dst)
    for p, q in zip(src, dst):
        assert approx_vec(recovered.apply(p), q, tol=1e-7)


def test_rigid_transform_no_reflection():
    # Even if the points could be matched by a reflection, the solver must
    # return a proper rotation (det == +1).
    R = rot_z(0.3)
    known = Extrinsic.from_rt(R, [2.0, 0.0, -1.0])
    src = [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (1.0, 1.0, 0.0),
           (0.5, 0.5, 1.0)]
    dst = [known.apply(p) for p in src]
    recovered = rigid_transform_from_points(src, dst)
    M = np.array(recovered.matrix, dtype=float)
    rot = M[:3, :3]
    assert np.linalg.det(rot) == pytest.approx(1.0, abs=1e-7)


def test_rigid_transform_too_few_points_raises():
    with pytest.raises(ValueError):
        rigid_transform_from_points([(0.0, 0.0, 0.0), (1.0, 0.0, 0.0)],
                                    [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0)])


def test_fit_wall_plane_recovers_known_plane_from_corners_and_seam_half():
    """fit_wall_plane recovers O, U, V exactly from the 4 corners AND from the
    'seam-half' point set (midpoints + seam corners), extrapolating the far
    half of a flat wall it never sampled."""
    from gesturewall.geometry import fit_wall_plane

    O, U, V = (1.0, 2.0, 3.0), (4.0, 0.0, 0.0), (0.0, 5.0, 0.0)

    def pt(u, v):
        return tuple(O[i] + u * U[i] + v * V[i] for i in range(3))

    for samples in (
        [(0, 0, pt(0, 0)), (1, 0, pt(1, 0)), (1, 1, pt(1, 1)), (0, 1, pt(0, 1))],   # corners
        [(0.5, 0, pt(0.5, 0)), (0.5, 1, pt(0.5, 1)),                                # seam-half
         (1, 0, pt(1, 0)), (1, 1, pt(1, 1))],
    ):
        pl = fit_wall_plane(samples)
        assert all(abs(pl.origin[i] - O[i]) < 1e-9 for i in range(3))
        assert all(abs(pl.u_vec[i] - U[i]) < 1e-9 for i in range(3))
        assert all(abs(pl.v_vec[i] - V[i]) < 1e-9 for i in range(3))


def test_fit_wall_plane_errors():
    import pytest
    from gesturewall.geometry import fit_wall_plane
    with pytest.raises(ValueError):                       # < 3 samples
        fit_wall_plane([(0, 0, (0, 0, 0)), (1, 0, (1, 0, 0))])
    with pytest.raises(ValueError):                       # collinear u/v (all v=0)
        fit_wall_plane([(0, 0, (0, 0, 0)), (0.5, 0, (.5, 0, 0)), (1, 0, (1, 0, 0))])


def test_sample_depth_prefer_near_rejects_far_background():
    """prefer_near returns the nearest cluster (the hand), not a median pulled
    toward far background/flying pixels behind a thin joint."""
    import numpy as np
    from gesturewall.geometry import sample_depth
    box = np.full((11, 11), 3.0, dtype=np.float32)        # mostly the far wall
    box[5, 5] = 1.0; box[5, 4] = 1.0; box[4, 5] = 1.0      # a few near "hand" pixels
    assert sample_depth(box, 5, 5, window=11) == 3.0                       # plain median
    assert sample_depth(box, 5, 5, window=11, prefer_near=True) == 1.0     # near cluster
