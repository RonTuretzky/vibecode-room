"""Synthetic end-to-end tests for the projector-marker auto-calibration.

No hardware: we render fake camera frames with a magenta disc, give them a
synthetic depth map of a known planar wall, and check the pure pipeline
(detect -> deproject -> fit -> register) recovers the geometry.
"""
import math

import numpy as np
import pytest

from gesturewall.autocal import (MARKER_GRID, AutoCalibrator,
                                 _cross_camera_update, constrained_corner_fit,
                                 detect_marker, lateral_spread, marker_point3,
                                 median_frame, out_of_plane_spread,
                                 plane_angle_deg, plane_metrics, plane_point,
                                 reject_off_plane, robust_register)
from gesturewall.geometry import (CameraIntrinsics, Extrinsic, fit_wall_plane,
                                  rigid_transform_from_points)

INTR = CameraIntrinsics(fx=366.0, fy=366.0, cx=256.0, cy=212.0,
                        width=512, height=424)
# A Gemini 335-shaped color/depth frame (1280x720) for resolution parity.
INTR720 = CameraIntrinsics(fx=915.0, fy=915.0, cx=640.0, cy=360.0,
                           width=1280, height=720)


def scene(disc_at=None, radius=14, noise_seed=7):
    """A busy-ish BGR frame; optionally with a magenta disc at (px, py)."""
    rng = np.random.default_rng(noise_seed)
    img = rng.integers(30, 90, size=(424, 512, 3), dtype=np.uint8)
    img[100:200, 60:180] = (200, 210, 205)      # a bright "window"
    if disc_at is not None:
        yy, xx = np.mgrid[0:424, 0:512]
        m = (xx - disc_at[0]) ** 2 + (yy - disc_at[1]) ** 2 <= radius ** 2
        img[m] = (255, 40, 255)                  # magenta in BGR
    return img


def scene720(disc_at=None, radius=35, noise_seed=7):
    """The scene() fixture rendered at 1280x720 (disc radius x2.5)."""
    rng = np.random.default_rng(noise_seed)
    img = rng.integers(30, 90, size=(720, 1280, 3), dtype=np.uint8)
    img[170:340, 150:450] = (200, 210, 205)      # a bright "window"
    if disc_at is not None:
        yy, xx = np.mgrid[0:720, 0:1280]
        m = (xx - disc_at[0]) ** 2 + (yy - disc_at[1]) ** 2 <= radius ** 2
        img[m] = (255, 40, 255)                  # magenta in BGR
    return img


def test_detect_marker_finds_disc_center():
    off = scene()
    on = scene(disc_at=(300, 150))
    det = detect_marker(off, on)
    assert det is not None
    px, py, peak = det
    assert abs(px - 300) < 2 and abs(py - 150) < 2
    assert peak > 100


def test_detect_marker_none_when_no_change():
    off = scene()
    on = scene()
    assert detect_marker(off, on) is None


def test_detect_marker_ignores_green_change():
    off = scene()
    on = scene()
    on[200:260, 200:260, 1] = 255  # a big green change (not the disc)
    assert detect_marker(off, on) is None


def test_detect_marker_rejects_person_sized_blob():
    # A realistic person: a large SKIN-colored change (high R, some G, low B).
    # Bright and large, but blue barely rises -> magenta-balance gate rejects.
    off = scene()
    on = scene()
    on[60:360, 120:360] = (55, 150, 210)  # BGR skin-ish; not magenta
    assert detect_marker(off, on) is None


def test_detect_marker_accepts_large_oblique_disc():
    # The wall-B failure mode: a big magenta disc (blooming) must still pass.
    off = scene()
    on = scene(disc_at=(256, 212), radius=95)  # ~28k px, like the real bloom
    det = detect_marker(off, on)
    assert det is not None
    px, py, _ = det
    assert abs(px - 256) < 6 and abs(py - 212) < 6


def test_detect_marker_rejects_two_comparable_blobs():
    off = scene()
    on = scene(disc_at=(300, 150))
    yy, xx = np.mgrid[0:424, 0:512]
    m = (xx - 120) ** 2 + (yy - 300) ** 2 <= 14 ** 2  # a second equal disc
    on[m] = (255, 40, 255)
    assert detect_marker(off, on) is None


# --------------------------------------------------------------------------- #
# resolution parity: same scenes at 1280x720 (Gemini 335 color)                #
# --------------------------------------------------------------------------- #
def test_detect_marker_finds_disc_center_720p():
    off = scene720()
    on = scene720(disc_at=(750, 250))
    det = detect_marker(off, on)
    assert det is not None
    px, py, peak = det
    assert abs(px - 750) < 4 and abs(py - 250) < 4
    assert peak > 100


def test_detect_marker_accepts_large_oblique_disc_720p():
    # The wall-B bloom case scaled x2.5: ~178k px of disc — far beyond the
    # old fixed MAX_AREA_PX (90000) yet well under MAX_AREA_FRAC of a 720p
    # frame. The fixed gate would reject every big oblique disc at 720p.
    off = scene720()
    on = scene720(disc_at=(640, 360), radius=238)
    det = detect_marker(off, on)
    assert det is not None
    px, py, _ = det
    assert abs(px - 640) < 12 and abs(py - 360) < 12


def test_detect_marker_rejects_person_sized_blob_720p():
    # Same skin-colored change as the 512x424 case, scaled to 720p: the area
    # gate alone would PASS it, the magenta-balance gate must still reject.
    off = scene720()
    on = scene720()
    on[100:610, 300:900] = (55, 150, 210)  # BGR skin-ish; not magenta
    assert detect_marker(off, on) is None


def test_detect_marker_none_when_no_change_720p():
    assert detect_marker(scene720(), scene720()) is None


def test_marker_point3_median_depth_720p():
    depth = np.full((720, 1280), 2.5, dtype=np.float32)
    bad = np.zeros((720, 1280), dtype=np.float32)  # all-invalid frame
    p = marker_point3(750.0, 250.0, [depth, bad, depth], INTR720)
    assert p is not None
    assert abs(p[2] - 2.5) < 1e-6


def test_lateral_spread_collinear_vs_2d():
    col = [(0.0, y, 3.0) for y in (0.0, 0.8, 1.6)]         # a vertical line
    assert lateral_spread(col) < 1e-6
    grid = [(u * 2.3, -v * 1.9, 3.0) for (u, v) in MARKER_GRID]
    assert lateral_spread(grid) > 0.3


def test_reject_off_plane_drops_outlier():
    good = [(u, v, (u * 2.3, -v * 1.9, 3.0)) for (u, v) in MARKER_GRID]
    # distinct (u,v) not in the grid, 1 m off the wall plane in z
    outlier = (0.3, 0.7, (0.3 * 2.3, -0.7 * 1.9, 2.0))
    kept, dropped = reject_off_plane(good + [outlier])
    assert dropped == 1
    assert all(math.isclose(p[2], 3.0) for (_, _, p) in kept)


def test_median_frame_kills_flicker():
    base = scene()
    glitch = base.copy()
    glitch[:] = 255
    med = median_frame([base, base, glitch])
    assert np.array_equal(med, base)


def test_marker_point3_median_depth():
    depth = np.full((424, 512), 2.5, dtype=np.float32)
    bad = np.zeros((424, 512), dtype=np.float32)  # all-invalid frame
    p = marker_point3(300.0, 150.0, [depth, bad, depth], INTR)
    assert p is not None
    assert abs(p[2] - 2.5) < 1e-6


def synth_wall(origin, u_vec, v_vec):
    return origin, u_vec, v_vec


def test_full_pipeline_recovers_plane_and_extrinsic():
    # A wall 2.5 m wide, 1.6 m tall, 2.8 m in front of the reference camera.
    origin = np.array([-1.2, 0.9, 2.8])
    u_vec = np.array([2.5, 0.0, 0.4])
    v_vec = np.array([0.0, -1.6, 0.0])

    # A second camera rotated 35 deg about Y and offset.
    th = math.radians(35)
    R = np.array([[math.cos(th), 0, math.sin(th)],
                  [0, 1, 0],
                  [-math.sin(th), 0, math.cos(th)]])
    t = np.array([1.5, 0.1, 0.6])

    ref_samples, cam2_samples = [], []
    for (u, v) in MARKER_GRID:
        p_room = origin + u * u_vec + v * v_vec
        ref_samples.append((u, v, tuple(p_room)))
        p_cam2 = R.T @ (p_room - t)  # room -> cam2 frame
        cam2_samples.append((u, v, tuple(p_cam2)))

    plane = fit_wall_plane(ref_samples)
    w, h = plane_metrics(plane)
    assert abs(w - np.linalg.norm(u_vec)) < 1e-6
    assert abs(h - np.linalg.norm(v_vec)) < 1e-6

    ext = rigid_transform_from_points(
        [p for (_, _, p) in cam2_samples],
        [p for (_, _, p) in ref_samples])
    for (u, v, p_cam2), (_, _, p_room) in zip(cam2_samples, ref_samples):
        assert math.dist(ext.apply(p_cam2), p_room) < 1e-6

    # pooled fit (ref + transformed cam2) still recovers the same plane
    pooled = ref_samples + [(u, v, ext.apply(p)) for (u, v, p) in cam2_samples]
    plane2 = fit_wall_plane(pooled)
    for (u, v) in ((0, 0), (1, 0), (1, 1), (0, 1)):
        assert math.dist(plane_point(plane2, u, v),
                         tuple(origin + u * u_vec + v * v_vec)) < 1e-6


def _rigid(th, t):
    import numpy as np
    R = np.array([[math.cos(th), 0, math.sin(th)],
                  [0, 1, 0], [-math.sin(th), 0, math.cos(th)]])
    return R, np.asarray(t, float)


def test_robust_register_drops_reflection_correspondences():
    # Good correspondences span TWO perpendicular walls (a real corner rig ->
    # non-coplanar, well-conditioned) plus 3 bad "reflection" ones tens of cm
    # wrong. Must register from the good ones, dropping the reflections.
    import numpy as np
    R, t = _rigid(math.radians(28), [1.2, 0.05, 0.4])
    good_room = [(u * 2.3, -v * 1.6, 2.9) for (u, v) in [(0, 0), (1, 0), (0, 1)]]
    good_room += [(2.3, -v * 1.6, 2.9 - u * 2.6)      # perpendicular wall B
                  for (u, v) in [(0.3, 0), (0.8, 0.5), (0.6, 1)]]
    src = [tuple(R.T @ (np.array(p) - t)) for p in good_room]
    dst = list(good_room)
    for k in range(3):                                 # reflections
        src.append(tuple(R.T @ (np.array([0.3 + 0.2 * k, -0.5, 2.6]) - t)))
        dst.append((0.3 + 0.2 * k, -0.5, 2.0))
    reg = robust_register(src, dst)
    assert reg is not None
    ext, kept, max_r = reg
    assert kept == 6 and max_r < 0.02
    for s, d in zip(src[:6], dst[:6]):
        assert math.dist(ext.apply(s), d) < 0.02


def test_robust_register_refuses_coplanar_single_wall():
    # All correspondences on ONE wall (coplanar) -> ill-conditioned rotation ->
    # must REFUSE (return None) rather than emit a tilted extrinsic.
    import numpy as np
    R, t = _rigid(math.radians(20), [0.8, 0.1, 0.3])
    room = [(u * 2.4, -v * 1.5, 3.0)
            for (u, v) in [(0, 0), (1, 0), (0.5, 0.5), (0, 1), (1, 1), (0.5, 1)]]
    src = [tuple(R.T @ (np.array(p) - t)) for p in room]
    assert robust_register(src, list(room)) is None


def test_robust_register_rejects_all_bad():
    # No consistent subset -> returns None rather than a garbage extrinsic.
    import numpy as np
    rng = np.random.default_rng(3)
    src = [tuple(rng.normal(size=3)) for _ in range(6)]
    dst = [tuple(rng.normal(size=3)) for _ in range(6)]
    assert robust_register(src, dst) is None


def test_constrained_corner_fit_recovers_true_wall():
    # Anchor wall A: 2.46 m wide, 1.38 m tall, facing +z-ish.
    from gesturewall.geometry import fit_wall_plane as _fit
    import numpy as np
    a_samples = [(u, v, (u * 2.46, -v * 1.38, 3.0)) for (u, v) in MARKER_GRID]
    plane_a = _fit(a_samples)
    # True wall B: perpendicular, shares the corner at x=2.46, 2.6 m along -z.
    def b_true(u, v):
        return (2.46, -v * 1.38, 3.0 - u * 2.6)
    # cam sees B obliquely: add structured noise pushing points off-plane
    rng = np.random.default_rng(11)
    b_samples = []
    for (u, v) in [(0.12, 0.15), (0.5, 0.15), (0.88, 0.5), (0.12, 0.85),
                   (0.5, 0.85), (0.88, 0.85), (0.5, 0.5)]:
        p = np.array(b_true(u, v)) + rng.normal(scale=0.04, size=3)
        b_samples.append((u, v, tuple(p)))
    plane_b = constrained_corner_fit(plane_a, b_samples)
    w, h = plane_metrics(plane_b)
    assert abs(w - 2.6) < 0.15          # width recovered
    assert abs(h - 1.38) < 0.15         # height recovered
    assert abs(plane_angle_deg(plane_a, plane_b) - 90.0) < 1e-6  # exact corner
    # corners land near truth
    for (u, v) in ((0, 0), (1, 0), (0, 1), (1, 1)):
        assert math.dist(plane_point(plane_b, u, v), b_true(u, v)) < 0.12


def test_plane_angle_corner():
    a = fit_wall_plane([(u, v, (u * 2.3, -v * 1.9, 3.0))
                        for (u, v) in MARKER_GRID])
    b = fit_wall_plane([(u, v, (2.3, -v * 1.9, 3.0 - u * 2.6))
                        for (u, v) in MARKER_GRID])
    assert abs(plane_angle_deg(a, b) - 90.0) < 1e-6


class FakeSource:
    """Replays scripted (color, depth, intr) frames like KinectV2Source."""

    def __init__(self, frames):
        self.frames = list(frames)

    def read(self, timeout=None):
        if not self.frames:
            return None
        return self.frames.pop(0)

    def close(self):
        pass


def test_cam_walls_default_and_restriction():
    cams = {"cam0": FakeSource([]), "cam1": FakeSource([])}
    c = AutoCalibrator("x", ["A", "B"], cams, cam_walls={"cam0": ["A"]})
    assert c.cam_walls["cam0"] == {"A"}         # restricted to its own wall
    assert c.cam_walls["cam1"] == {"A", "B"}    # unspecified -> sees all
    c2 = AutoCalibrator("x", ["A", "B"], cams, cam_walls=None)
    assert c2.cam_walls["cam0"] == {"A", "B"}   # None -> every camera sees all


def test_capture_stall_returns_none():
    calib = AutoCalibrator.__new__(AutoCalibrator)
    calib.cameras = {"cam0": FakeSource([None])}
    calib._lock = __import__("threading").Lock()
    got = calib._capture("cam0", n_frames=2, deadline_s=0.2)
    assert got is None


# --------------------------------------------------------------------------- #
# fusion.cross_camera truth maintenance                                        #
# --------------------------------------------------------------------------- #
def _cc_cfg(serves, cross_camera=None):
    cfg = {"walls": {"A": {}, "B": {}},
           "cameras": {c: {"serves": list(s)} for c, s in serves.items()}}
    if cross_camera is not None:
        cfg["fusion"] = {"cross_camera": cross_camera}
    return cfg


def test_cross_camera_single_cam_all_walls_true():
    # ONE camera serving BOTH walls, no bystander serving: one camera is one
    # registered frame — must clear a stale decoupled-era False.
    cfg = _cc_cfg({"cam0": ["A", "B"], "cam1": []}, cross_camera=False)
    got = _cross_camera_update(cfg, ["cam0"], {"cam0": Extrinsic.identity()},
                               {"cam0": ["A", "B"]})
    assert got is True


def test_cross_camera_single_cam_partial_walls_untouched():
    # A --wall run serving only A must not touch the flag (None).
    cfg = _cc_cfg({"cam0": ["A"], "cam1": []})
    got = _cross_camera_update(cfg, ["cam0"], {"cam0": Extrinsic.identity()},
                               {"cam0": ["A"]})
    assert got is None


def test_cross_camera_single_cam_beside_serving_other_false():
    # A single-camera run next to ANOTHER serving camera: identity frame,
    # unregistered against the other's -> False.
    cfg = _cc_cfg({"cam0": ["A"], "cam1": ["B"]})
    got = _cross_camera_update(cfg, ["cam0"], {"cam0": Extrinsic.identity()},
                               {"cam0": ["A"]})
    assert got is False


def test_cross_camera_joint_registered_true():
    cfg = _cc_cfg({"cam0": ["A", "B"], "cam1": ["A", "B"]})
    ident = Extrinsic.identity()
    got = _cross_camera_update(cfg, ["cam0", "cam1"],
                               {"cam0": ident, "cam1": ident},
                               {"cam0": ["A", "B"], "cam1": ["A", "B"]})
    assert got is True


def test_cross_camera_joint_unregistered_camera_untouched():
    # A camera that failed registration keeps the flag as-is (None).
    cfg = _cc_cfg({"cam0": ["A", "B"], "cam1": []})
    got = _cross_camera_update(cfg, ["cam0", "cam1"],
                               {"cam0": Extrinsic.identity()},
                               {"cam0": ["A", "B"]})
    assert got is None


# --------------------------------------------------------------------------- #
# decoupled mode (one camera per wall, per-camera frames)                      #
# --------------------------------------------------------------------------- #
def test_decoupled_inference():
    cams = {"cam0": FakeSource([]), "cam1": FakeSource([])}
    # Disjoint one-camera-per-wall partition -> decoupled.
    c = AutoCalibrator("x", ["A", "B"], cams,
                       cam_walls={"cam0": ["A"], "cam1": ["B"]})
    assert c.decoupled is True
    assert c.wall_owner == {"A": "cam0", "B": "cam1"}
    # Joint (both cameras see both walls) -> not decoupled.
    j = AutoCalibrator("x", ["A", "B"], cams, cam_walls=None)
    assert j.decoupled is False
    # Single camera (single-wall mode) -> not decoupled.
    s = AutoCalibrator("x", ["A"], {"cam0": FakeSource([])},
                       cam_walls={"cam0": ["A"]})
    assert s.decoupled is False


def test_wall_widths_normalization():
    cams = {"cam0": FakeSource([])}
    assert AutoCalibrator("x", ["A"], cams).wall_widths == {}
    assert AutoCalibrator("x", ["A", "B"], {"cam0": FakeSource([]),
                                            "cam1": FakeSource([])},
                          wall_width=2.3).wall_widths \
        == {"A": 2.3, "B": 2.3}
    assert AutoCalibrator("x", ["A", "B"], cams,
                          wall_width={"A": 2.3, "B": 2.5}).wall_widths \
        == {"A": 2.3, "B": 2.5}


def _decoupled_calibrator(tmp_path, widths=None):
    """An AutoCalibrator over a minimal 2-wall/2-camera temp config."""
    import json as _json
    cfg = {
        "walls": {
            "A": {"display": 1, "grid": {"rows": 2, "cols": 3}},
            "B": {"display": 2, "grid": {"rows": 2, "cols": 3}},
        },
        "cameras": {
            "cam0": {"device": "072843433747", "serves": []},
            "cam1": {"device": "010289152747", "serves": []},
        },
    }
    path = tmp_path / "room.json"
    path.write_text(_json.dumps(cfg))
    cams = {"cam0": FakeSource([]), "cam1": FakeSource([])}
    return AutoCalibrator(str(path), ["A", "B"], cams,
                          cam_walls={"cam0": ["A"], "cam1": ["B"]},
                          wall_width=widths), path


def test_solve_decoupled_writes_identity_frames(tmp_path, monkeypatch):
    import json as _json

    monkeypatch.chdir(tmp_path)  # autocal_samples.json dump lands here
    calib, path = _decoupled_calibrator(tmp_path,
                                        widths={"A": 2.3, "B": 2.5})
    # Wall A flat in cam0's frame at z=2.0 (2.0 m wide, 1.4 m tall); wall B
    # flat in cam1's frame at z=2.5 (2.4 m wide, 2.0 m tall). Coordinates are
    # deliberately reused across frames — they must never be compared.
    samples = {
        "A": {"cam0": [(u, v, (u * 2.0 - 1.0, 0.7 - v * 1.4, 2.0))
                       for (u, v) in MARKER_GRID],
              "cam1": []},
        "B": {"cam0": [],
              "cam1": [(u, v, (u * 2.4 - 1.2, 1.0 - v * 2.0, 2.5))
                       for (u, v) in MARKER_GRID]},
    }
    intr = {"cam0": INTR, "cam1": INTR}
    calib._solve_decoupled(samples, intr)

    out = _json.loads(path.read_text())
    ident = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0],
             [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]
    for cam, wall in (("cam0", "A"), ("cam1", "B")):
        assert out["cameras"][cam]["serves"] == [wall]
        assert out["cameras"][cam]["extrinsic"]["matrix"] == ident
        assert out["cameras"][cam]["kind"] == "kinect_v2"
    assert out["fusion"]["cross_camera"] is False

    pa, pb = out["walls"]["A"]["plane"], out["walls"]["B"]["plane"]
    wa = math.sqrt(sum(c * c for c in pa["u_vec"]))
    wb = math.sqrt(sum(c * c for c in pb["u_vec"]))
    assert wa == pytest.approx(2.3, abs=1e-6)   # operator pin, not the 2.0 fit
    assert wb == pytest.approx(2.5, abs=1e-6)
    ha = math.sqrt(sum(c * c for c in pa["v_vec"]))
    assert ha == pytest.approx(1.4, abs=0.02)   # height keeps the fitted value
    assert calib.get_state()["phase"] == "done"


def test_solve_decoupled_preserves_configured_kind(tmp_path, monkeypatch):
    # Autocal fixes poses; it must never rewrite what a camera IS. A config
    # already declaring cam0 as a Gemini 335 keeps that kind, while a camera
    # with no kind still gets the kinect_v2 default.
    import json as _json

    monkeypatch.chdir(tmp_path)
    calib, path = _decoupled_calibrator(tmp_path)
    cfg = _json.loads(path.read_text())
    cfg["cameras"]["cam0"]["kind"] = "gemini_335"
    path.write_text(_json.dumps(cfg))
    samples = {
        "A": {"cam0": [(u, v, (u * 2.0 - 1.0, 0.7 - v * 1.4, 2.0))
                       for (u, v) in MARKER_GRID],
              "cam1": []},
        "B": {"cam0": [],
              "cam1": [(u, v, (u * 2.4 - 1.2, 1.0 - v * 2.0, 2.5))
                       for (u, v) in MARKER_GRID]},
    }
    calib._solve_decoupled(samples, {"cam0": INTR, "cam1": INTR})
    out = _json.loads(path.read_text())
    assert out["cameras"]["cam0"]["kind"] == "gemini_335"
    assert out["cameras"]["cam1"]["kind"] == "kinect_v2"


def test_solve_decoupled_too_few_markers_raises(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    calib, _ = _decoupled_calibrator(tmp_path)
    samples = {
        "A": {"cam0": [(u, v, (u * 2.0 - 1.0, 0.7 - v * 1.4, 2.0))
                       for (u, v) in list(MARKER_GRID)[:3]],   # only 3
              "cam1": []},
        "B": {"cam0": [],
              "cam1": [(u, v, (u * 2.4 - 1.2, 1.0 - v * 2.0, 2.5))
                       for (u, v) in MARKER_GRID]},
    }
    with pytest.raises(RuntimeError, match="wall A.*usable markers"):
        calib._solve_decoupled(samples, {"cam0": INTR, "cam1": INTR})


def test_explicit_decoupled_single_pair():
    # A lone --pair must take the decoupled path (not silently run joint).
    c = AutoCalibrator("x", ["A"], {"cam0": FakeSource([])},
                       cam_walls={"cam0": ["A"]}, decoupled=True)
    assert c.decoupled is True
    assert c.wall_owner == {"A": "cam0"}
    # Forcing decoupled without a 1:1 partition is refused.
    with pytest.raises(ValueError, match="partition"):
        AutoCalibrator("x", ["A", "B"],
                       {"cam0": FakeSource([]), "cam1": FakeSource([])},
                       cam_walls={"cam0": ["A", "B"], "cam1": ["A", "B"]},
                       decoupled=True)


def test_pin_widths_refuses_degenerate_fit(tmp_path, monkeypatch):
    # A collapsed 0.4 m fit must NOT be laundered to 2.5 m by the pin — the
    # u direction of a degenerate fit is noise, so rescaling it would write a
    # confidently wrong horizontal mapping.
    monkeypatch.chdir(tmp_path)
    calib, _ = _decoupled_calibrator(tmp_path, widths={"A": 2.3, "B": 2.5})
    samples = {
        "A": {"cam0": [(u, v, (u * 2.0 - 1.0, 0.7 - v * 1.4, 2.0))
                       for (u, v) in MARKER_GRID],
              "cam1": []},
        "B": {"cam0": [],
              "cam1": [(u, v, (u * 0.4 - 0.2, 1.0 - v * 2.0, 2.5))
                       for (u, v) in MARKER_GRID]},   # 0.4 m sliver
    }
    with pytest.raises(RuntimeError, match="wall B.*refusing to pin"):
        calib._solve_decoupled(samples, {"cam0": INTR, "cam1": INTR})
    # The raw-sample dump still happened (failed runs need debugging most).
    assert (tmp_path / "autocal_samples.json").exists()
