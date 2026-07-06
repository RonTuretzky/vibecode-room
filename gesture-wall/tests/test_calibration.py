import pytest

from gesturewall.calibration import Homography


def test_identity_passthrough():
    h = Homography.identity()
    assert h.apply(0.3, 0.7) == pytest.approx((0.3, 0.7))


def test_translation_matrix():
    # Homogeneous translation by (+0.1, -0.2).
    h = Homography(matrix=[[1, 0, 0.1], [0, 1, -0.2], [0, 0, 1]])
    assert h.apply(0.5, 0.5) == pytest.approx((0.6, 0.3))


def test_roundtrip_save_load(tmp_path):
    h = Homography(matrix=[[2, 0, 0], [0, 3, 0], [0, 0, 1]])
    p = tmp_path / "calib.json"
    h.save(p)
    loaded = Homography.load(p)
    assert loaded.apply(0.1, 0.1) == pytest.approx(h.apply(0.1, 0.1))


def test_from_corner_points_maps_to_wall_corners():
    cv2 = pytest.importorskip("cv2")  # needs OpenCV
    _ = cv2
    # Source square (0.2..0.8) should map onto the inset wall corners.
    src = [(0.2, 0.2), (0.8, 0.2), (0.8, 0.8), (0.2, 0.8)]
    dst = [(0.05, 0.05), (0.95, 0.05), (0.95, 0.95), (0.05, 0.95)]
    h = Homography.from_corner_points(src, dst)
    for s, d in zip(src, dst):
        assert h.apply(*s) == pytest.approx(d, abs=1e-4)
    # Center maps to center.
    assert h.apply(0.5, 0.5) == pytest.approx((0.5, 0.5), abs=1e-4)


def test_from_corner_points_requires_four():
    pytest.importorskip("cv2")
    with pytest.raises(ValueError):
        Homography.from_corner_points([(0, 0), (1, 0)])


def test_from_corner_points_rejects_degenerate():
    pytest.importorskip("cv2")
    with pytest.raises(ValueError):
        Homography.from_corner_points([(0.5, 0.5)] * 4)        # coincident
    with pytest.raises(ValueError):
        Homography.from_corner_points([(0, 0), (0.3, 0.3),
                                       (0.6, 0.6), (0.9, 0.9)])  # collinear
