"""Automatic projector-based calibration for the depth gesture wall.

The idea: the projectors *are* a controllable light source on the exact
surfaces we need to calibrate. ``web/autocal.html`` (one window per wall)
polls this module's tiny HTTP server and displays a single bright magenta
disc at a known wall coordinate ``(u, v)``. For each marker we capture
frames from every Kinect with the marker OFF and then ON; the difference
image localizes the disc in each camera, the aligned depth gives its 3D
position, and:

  * per wall, the labeled ``(u, v, point3)`` samples fit the wall plane
    (:func:`gesturewall.geometry.fit_wall_plane`) — in the reference
    camera's frame, which *defines* the room frame;
  * markers seen by BOTH cameras give correspondences that solve the
    second camera's CAMERA->ROOM extrinsic
    (:func:`gesturewall.geometry.rigid_transform_from_points`, Kabsch);
  * the second camera's samples, transformed into the room frame, are
    pooled into the plane fits so obliquely-seen walls still calibrate.

No clicking, no pointing: the operator just puts the two autocal pages on
the right projectors and stays out of view for ~90 seconds.

Usage:
    .venv/bin/python -m gesturewall.autocal --config room.json [--port 8801]
    # open http://localhost:8801/autocal.html?wall=A  (projector on wall A)
    #      http://localhost:8801/autocal.html?wall=B  (projector on wall B)
    # then: curl -X POST http://localhost:8801/calib/start
    # progress: curl http://localhost:8801/calib/status
"""
from __future__ import annotations

import argparse
import json
import math
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .calibrate import (load_config_dict, merge_camera_pose, merge_wall_plane,
                        save_config_dict)
from .geometry import (CameraIntrinsics, Extrinsic, fit_wall_plane,
                       rigid_transform_from_points, sample_depth)
from .room import RoomConfig

# 3x3 grid of marker positions per wall, inset from the edges so the disc
# stays fully on screen (and away from projector edge blending).
MARKER_GRID = [(u, v) for v in (0.15, 0.5, 0.85) for u in (0.12, 0.5, 0.88)]

# Marker disc radius as a fraction of the page's smaller dimension. The pages
# use the server-sent value, so dot size is tuned HERE, not in the frontends.
# The base size struggled on far/oblique wall stretches (3+ m at grazing
# angles: fewer camera pixels per dot, light spread over more wall), so the
# base is generous and missed markers get retried once even bigger.
DOT_R = 0.16
DOT_R_RETRY = 0.24

# Detection thresholds. Tuned on a 512x424 registered color image, but the
# area gates are FRAME FRACTIONS so the same disc still passes at higher
# resolutions (at the Gemini 335's 1280x720 it covers ~3.8x the pixels).
MIN_PEAK = 11.0        # min magenta-score delta at the blob peak, else "not seen"
MIN_AREA_FRAC = 16 / (512 * 424)     # min blob area as a frame fraction
                                     # (exactly the old 16 px at 512x424)
MAX_AREA_FRAC = 90000 / (512 * 424)  # ~41% of frame: reject only a whole-scene
                                     # flash, not a legitimately large disc seen
                                     # close/obliquely (old 90000 px at 512x424)
# A projected MAGENTA disc raises RED and BLUE by roughly equal amounts; a
# person (skin/clothing) raises red (and green) but little blue. Requiring the
# blue rise to be a real fraction of the red rise is what rejects people —
# robustly, and without an area/shape gate that also kills big oblique discs.
MAGENTA_BLUE_RATIO = 0.5
DEPTH_WINDOW_BASE = 9  # sample_depth window at 512 px frame width; scaled by
                       # W/512 so the window covers the same wall patch

# Sanity gates before we write anything into the config.
WIDTH_RANGE = (1.0, 4.5)     # metres
HEIGHT_RANGE = (0.7, 3.5)    # metres
ANGLE_RANGE = (55.0, 125.0)  # degrees between the two wall planes
MAX_RESIDUAL = 0.12          # metres, mean cam1 registration error


# --------------------------------------------------------------------------- #
# pure helpers (unit-testable without hardware)                                #
# --------------------------------------------------------------------------- #
def detect_marker(off_bgr, on_bgr):
    """Find the projected magenta disc as the centroid of the OFF->ON change.

    Works on the *difference* so static scene content (windows, projected
    grids, furniture) cancels out. The score weights the magenta channels
    (R + B) and subtracts green, so broad-spectrum changes (a person moving)
    score much lower than the disc. Returns ``(px, py, peak)`` or ``None``.
    """
    import cv2
    import numpy as np

    # Resolution-relative gates and kernel: tuned at 512x424, scaled here from
    # the actual frame so the same physical disc passes at e.g. 1280x720.
    frame_h, frame_w = off_bgr.shape[:2]
    min_area = MIN_AREA_FRAC * frame_h * frame_w
    max_area = MAX_AREA_FRAC * frame_h * frame_w
    k = max(3, int(round(9 * frame_w / 512)) | 1)  # odd blur kernel, 9 @ 512

    off = off_bgr.astype(np.int16)
    on = on_bgr.astype(np.int16)
    d_b = np.clip(on[:, :, 0] - off[:, :, 0], 0, 255)
    d_g = np.clip(on[:, :, 1] - off[:, :, 1], 0, 255)
    d_r = np.clip(on[:, :, 2] - off[:, :, 2], 0, 255)
    score = np.clip(d_r.astype(np.float32) + d_b.astype(np.float32)
                    - d_g.astype(np.float32), 0, None)
    score = cv2.GaussianBlur(score, (k, k), 0)

    peak = float(score.max())
    if peak < MIN_PEAK:
        return None
    py_peak, px_peak = np.unravel_index(int(score.argmax()), score.shape)
    mask = (score > 0.5 * peak).astype(np.uint8)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    # The disc is the blob CONTAINING the brightest point — NOT the largest by
    # area. A big oblique disc blooms and a dim reflection can out-area it, but
    # the score peak always sits on the real, directly-lit dot.
    peak_pt = (float(px_peak), float(py_peak))
    disc = max(contours, key=lambda c: cv2.pointPolygonTest(c, peak_pt, True))
    area = cv2.contourArea(disc)
    # Size gate: too small = noise/oblique sliver; too big = a whole-scene flash.
    if not (min_area <= area <= max_area):
        return None
    # Ambiguity gate: a SECOND blob nearly as bright as the peak means two
    # markers/objects changed at once (spill, two dots) — refuse rather than
    # guess which is the real one.
    for c in contours:
        if c is disc or cv2.contourArea(c) < min_area:
            continue
        m2 = np.zeros(mask.shape, np.uint8)
        cv2.drawContours(m2, [c], -1, 1, thickness=cv2.FILLED)
        if float(score[m2.astype(bool)].max()) > 0.8 * peak:
            return None
    # Magenta-balance gate (the real person-rejector): over the blob the BLUE
    # rise must be a real fraction of the RED rise. A projected magenta disc
    # lifts both; skin/clothing lifts red (and green) but little blue.
    blob = np.zeros(mask.shape, np.uint8)
    cv2.drawContours(blob, [disc], -1, 1, thickness=cv2.FILLED)
    sel = blob.astype(bool)
    mean_r = float(d_r[sel].mean())
    mean_b = float(d_b[sel].mean())
    if mean_b < 8.0 or mean_b < MAGENTA_BLUE_RATIO * mean_r:
        return None
    m = cv2.moments(disc)
    if m["m00"] == 0:
        return None
    return (m["m10"] / m["m00"], m["m01"] / m["m00"], peak)


def missed_markers(samples, walls, cam_walls):
    """Grid points with NO detection from any camera meant to see that wall.

    Pure and order-preserving (wall-major, grid order) so the retry pass
    walks the walls the same way the main pass did.
    """
    out = []
    for wall in walls:
        cams = [c for c in samples[wall] if wall in cam_walls.get(c, ())]
        got = {(u, v) for c in cams for (u, v, _p) in samples[wall][c]}
        for (u, v) in MARKER_GRID:
            if (u, v) not in got:
                out.append((wall, u, v))
    return out


def median_frame(frames):
    """Per-pixel median of a list of uint8 images (robust to flicker)."""
    import numpy as np
    return np.median(np.stack(frames), axis=0).astype(frames[0].dtype)


def marker_point3(px, py, depth_frames, intr: CameraIntrinsics):
    """Median-of-frames 3D point (CAMERA frame) at a detected blob centroid."""
    depths = []
    for dm in depth_frames:
        # Resolution-relative window (odd, 9 @ 512 px wide) so the sampled
        # wall patch stays the same physical size at 1280x720.
        window = max(3, int(round(DEPTH_WINDOW_BASE * len(dm[0]) / 512)) | 1)
        d = sample_depth(dm, px, py, window=window)
        if d is not None and 0.4 < d < 8.0:
            depths.append(d)
    if not depths:
        return None
    depths.sort()
    d = depths[len(depths) // 2]
    return intr.deproject(px, py, d)


def plane_metrics(plane):
    """(width, height) of a fitted plane's u/v spans, in metres."""
    w = math.sqrt(sum(c * c for c in plane.u_vec))
    h = math.sqrt(sum(c * c for c in plane.v_vec))
    return w, h


def plane_angle_deg(pa, pb):
    """Angle between two wall planes' normals, folded into [0, 90]."""
    na, nb = pa.normal(), pb.normal()
    dot = abs(sum(a * b for a, b in zip(na, nb)))
    return math.degrees(math.acos(min(1.0, max(-1.0, dot))))


def plane_point(plane, u, v):
    return tuple(plane.origin[i] + u * plane.u_vec[i] + v * plane.v_vec[i]
                 for i in range(3))


def lateral_spread(points):
    """Second singular value of a point cloud ≈ its off-line spread (metres).

    ~0 for collinear points; a genuine 2D marker patch on a wall is > 0.3 m.
    Guards Kabsch against a degenerate (rotation-unconstrained) fit.
    """
    import numpy as np
    if len(points) < 3:
        return 0.0
    P = np.asarray(points, dtype=float)
    s = np.linalg.svd(P - P.mean(axis=0), compute_uv=False)
    return float(s[1])


def constrained_corner_fit(anchor_plane, samples):
    """Fit a wall plane CONSTRAINED to form a true 90° corner with ``anchor_plane``.

    For a wall seen only obliquely by one camera, free least-squares tilts and
    stretches the plane (depth noise grows steeply with grazing angle). But
    physically we know more: the two walls meet at a right angle and both
    projected images hang level. So fix the orientation from the well-measured
    anchor wall — ``v̂`` parallel to the anchor's, ``û`` the anchor's û rotated
    90° about v̂ — and estimate only origin, width and height from ``samples``
    (linear least squares, 5 unknowns). Returns a :class:`WallPlane`.
    """
    import numpy as np

    from .geometry import WallPlane

    uA = np.asarray(anchor_plane.u_vec, dtype=float)
    vA = np.asarray(anchor_plane.v_vec, dtype=float)
    v_hat = vA / np.linalg.norm(vA)
    u_hat_A = uA / np.linalg.norm(uA)
    # Rotate û_A by ±90° about v̂ (Rodrigues); pick the sign that best matches
    # the data's own u-direction so we never flip the wall left-for-right.
    def rot(sign):
        return (np.cross(v_hat, u_hat_A) * sign
                + v_hat * np.dot(v_hat, u_hat_A))
    pts = np.array([p for (_u, _v, p) in samples], dtype=float)
    us = np.array([u for (u, _v, _p) in samples], dtype=float)
    if len(pts) >= 2 and (us.max() - us.min()) > 1e-6:
        # data's own u-direction: regress points against u
        du_dir = pts[us.argmax()] - pts[us.argmin()]
        u_hat_B = max((rot(+1), rot(-1)),
                      key=lambda c: float(np.dot(c, du_dir)))
    else:
        u_hat_B = rot(+1)
    u_hat_B = u_hat_B / np.linalg.norm(u_hat_B)

    # PIN the plane to the anchor's seam corner: the fitted plane must PASS
    # THROUGH the anchor wall's far-u top corner (the physical seam line), so
    # a coherent depth/extrinsic bias can never survive as a seam gap or a
    # normal offset. Only in-plane freedom remains: solve
    #   p_i = seam + (du + w*u_i) û_B + (dv + h*v_i) v̂
    # for (w, h, du, dv) — du/dv absorb where B's image starts vs the corner.
    o_anchor = np.asarray(anchor_plane.origin, dtype=float)
    centroid = pts.mean(axis=0)
    seam = min((o_anchor, o_anchor + uA),
               key=lambda e: float(np.linalg.norm(centroid - e)))
    vs = np.array([v for (_u, v, _p) in samples], dtype=float)
    r = (pts - seam)
    A = np.zeros((3 * len(pts), 4))
    b = r.reshape(-1)
    for i in range(len(pts)):
        A[3 * i:3 * i + 3, 0] = us[i] * u_hat_B   # w
        A[3 * i:3 * i + 3, 1] = vs[i] * v_hat     # h
        A[3 * i:3 * i + 3, 2] = u_hat_B           # du
        A[3 * i:3 * i + 3, 3] = v_hat             # dv
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    w, h, du, dv = (float(x) for x in sol)
    origin = seam + du * u_hat_B + dv * v_hat
    return WallPlane(origin=tuple(origin),
                     u_vec=tuple(u_hat_B * w),
                     v_vec=tuple(v_hat * h))


def out_of_plane_spread(points):
    """Third singular value of a point cloud ≈ its out-of-plane thickness (m).

    ~0 for coplanar points. A rigid transform anchored on coplanar
    correspondences is ill-conditioned about the in-plane axes, so a small value
    here means the registration would be a badly-tilted (unreliable) extrinsic.
    """
    import numpy as np
    if len(points) < 4:
        return 0.0
    P = np.asarray(points, dtype=float)
    s = np.linalg.svd(P - P.mean(axis=0), compute_uv=False)
    return float(s[2])


def robust_register(src_pts, dst_pts, max_residual=None, min_spread=0.15,
                    inlier_tol=0.05, min_inliers=4, min_out_of_plane=0.10):
    """Kabsch (CAMERA->ROOM) via exhaustive-minimal-sample RANSAC.

    The reference camera can contribute SPURIOUS shared markers — e.g. it sees
    a *reflection* of a wall it can't view directly, a correspondence tens of cm
    wrong. With several such outliers a plain least-squares fit is so corrupted
    that iterative worst-dropping can discard the GOOD markers first, so instead
    we search: fit from every 3-correspondence minimal sample, keep the one with
    the most inliers (residual <= ``inlier_tol``), then refit on that consensus.
    Correspondence counts here are small (<= ~18), so all C(n,3) samples is cheap
    and fully deterministic. Returns ``(Extrinsic, kept, max_resid)`` or ``None``.
    """
    import itertools

    if max_residual is None:
        max_residual = MAX_RESIDUAL
    src, dst = list(src_pts), list(dst_pts)
    n = len(src)
    if n < 3 or lateral_spread(dst) < min_spread:
        return None

    best = None  # (inlier index list)
    for combo in itertools.islice(itertools.combinations(range(n), 3), 2000):
        d3 = [dst[i] for i in combo]
        if lateral_spread(d3) < min_spread * 0.5:  # collinear minimal sample
            continue
        try:
            ext = rigid_transform_from_points([src[i] for i in combo], d3)
        except Exception:  # noqa: BLE001 - degenerate sample
            continue
        inliers = [i for i in range(n)
                   if math.dist(ext.apply(src[i]), dst[i]) <= inlier_tol]
        if best is None or len(inliers) > len(best):
            best = inliers

    if best is None or len(best) < min_inliers:
        return None
    d_in = [dst[i] for i in best]
    if lateral_spread(d_in) < min_spread:
        return None
    # Refuse a registration anchored on (near-)coplanar correspondences: the
    # out-of-plane rotation is unconstrained, so the extrinsic would be tilted
    # and every live point systematically displaced (the merge-bias failure).
    # Better to leave the camera OUT of fusion than register it badly.
    if out_of_plane_spread(d_in) < min_out_of_plane:
        return None
    ext = rigid_transform_from_points([src[i] for i in best], d_in)
    max_r = max(math.dist(ext.apply(src[i]), dst[i]) for i in best)
    if max_r > max_residual:
        return None
    return ext, len(best), max_r


def reject_off_plane(samples, tol=0.05):
    """Drop (u,v,point3) samples lying > ``tol`` m off their best-fit plane.

    Catches reflections / wrong-wall / person-in-frame points before they skew
    the pooled fit. Removes the SINGLE worst point per iteration and refits, so
    one gross outlier can't tilt a plain least-squares fit into flagging the
    good points instead. Returns (kept, n_dropped); a no-op below 4 samples.
    """
    kept = list(samples)
    dropped = 0
    while len(kept) >= 4:
        plane = fit_wall_plane(kept)
        n, o = plane.normal(), plane.origin
        dists = [abs(sum(n[i] * (p[i] - o[i]) for i in range(3)))
                 for (_u, _v, p) in kept]
        worst = max(range(len(kept)), key=dists.__getitem__)
        if dists[worst] <= tol:
            break
        kept.pop(worst)
        dropped += 1
    return kept, dropped


def _depth_kind_of(cfg: dict, cam_id: str) -> str:
    """The kind to stamp on a depth pose write: never the webcam \"rgb\".

    Pre-kind Kinect configs omit kind (or carry the parsed \"rgb\" default);
    a depth calibration through this module always captured via a depth
    source, so normalize to \"kinect_v2\" exactly like the capture fallback.
    """
    kind = cfg["cameras"][cam_id].get("kind", "kinect_v2")
    return "kinect_v2" if kind == "rgb" else kind


def _cross_camera_update(cfg, cam_ids, extrinsics, walls_served):
    """New ``fusion.cross_camera`` value implied by THIS run, or ``None``.

    ``cam_ids``/``extrinsics``/``walls_served`` describe the run just solved
    (``walls_served``: cam_id -> walls it now serves); ``cfg`` is the config
    about to be written. Three cases change the flag:

      * a full multi-camera registration (every run camera got an extrinsic,
        no bystander camera serving) proves ONE shared frame -> ``True``;
      * a single-camera run beside OTHER serving cameras installed an
        identity frame UNREGISTERED against theirs -> ``False``;
      * a single-camera run whose camera serves EVERY configured wall while
        no other camera serves anything -> ``True``: one camera IS one
        registered frame, and this clears the stale ``False`` a decoupled-era
        config leaves behind.

    Anything else (partial runs) leaves the setting untouched (``None``).
    """
    registered_all = all(c in extrinsics for c in cam_ids)
    others_serving = any(cam.get("serves")
                         for cid, cam in cfg.get("cameras", {}).items()
                         if cid not in cam_ids)
    if len(cam_ids) > 1 and registered_all and not others_serving:
        return True
    if len(cam_ids) == 1 and others_serving:
        return False
    all_walls = set(cfg.get("walls", {}))
    if (len(cam_ids) == 1 and registered_all and not others_serving
            and all_walls
            and all_walls <= set(walls_served.get(cam_ids[0], ()))):
        return True
    return None


# --------------------------------------------------------------------------- #
# capture orchestration                                                        #
# --------------------------------------------------------------------------- #
class AutoCalibrator:
    """Drives the marker sequence and computes planes + extrinsics."""

    def __init__(self, config_path: str, walls, cameras: dict,
                 cam_walls: dict | None = None,
                 wall_width: float | dict | None = None,
                 decoupled: bool | None = None):
        # cameras: cam_id -> KinectV2Source-like with .read() -> (color, depth, intr)
        # cam_walls: cam_id -> set of wall ids that camera can actually SEE. A
        #   camera mounted right beside its own wall sees the OTHER wall only as
        #   reflections; restricting it here keeps those phantoms out of the fit.
        self.config_path = config_path
        self.walls = list(walls)
        self.cameras = cameras
        self.cam_walls = ({c: set(walls) for c in cameras}
                          if cam_walls is None else
                          {c: set(cam_walls.get(c, walls)) for c in cameras})
        # Optional ground-truth physical wall widths (m). When the operator
        # measures them, we pin each fitted plane's u_vec to the exact length so
        # the horizontal mapping is correct even if the camera can't quite see
        # the far edge (the near edge / origin is the well-seen anchor). A bare
        # float (legacy single-wall form) applies to every calibrated wall.
        if wall_width is None:
            self.wall_widths: dict[str, float] = {}
        elif isinstance(wall_width, dict):
            self.wall_widths = {w: float(m) for w, m in wall_width.items()}
        else:
            self.wall_widths = {w: float(wall_width) for w in self.walls}
        # DECOUPLED mode: every wall is owned by exactly ONE camera and no
        # camera claims two walls — the physical reality when no camera can see
        # both walls (70° FOV vs a 90° corner). Each wall's plane is then fit
        # in its owner camera's OWN frame with an identity extrinsic; the two
        # frames are never registered or compared. ``decoupled=True`` asserts
        # the mode explicitly (--pair); ``None`` infers it from a disjoint
        # multi-camera partition (e.g. a re-run over a decoupled config).
        owners = {w: [c for c in self.cameras if w in self.cam_walls[c]]
                  for w in self.walls}
        partition = (all(len(cs) == 1 for cs in owners.values())
                     and len({cs[0] for cs in owners.values()})
                     == len(self.walls))
        if decoupled and not partition:
            raise ValueError("decoupled calibration needs a one-camera-per-"
                             f"wall partition; got owners {owners}")
        self.decoupled = (partition and len(self.cameras) > 1
                          if decoupled is None else bool(decoupled))
        self.wall_owner = ({w: cs[0] for w, cs in owners.items()}
                           if self.decoupled else {})
        self.state = {"phase": "idle", "marker": None, "msg": "waiting"}
        self.status = {"progress": 0.0, "detections": {}, "report": []}
        self._lock = threading.Lock()

    # -- state served to the browser page -------------------------------- #
    def get_state(self):
        with self._lock:
            return dict(self.state)

    def get_status(self):
        with self._lock:
            return json.loads(json.dumps(self.status))

    def _set(self, **kw):
        with self._lock:
            self.state.update(kw)

    def try_begin(self) -> bool:
        """Atomically claim the run (compare-and-set on phase).

        Prevents two POSTs racing past a check-then-spawn and running two
        marker sequences over the same (non-thread-safe) Kinect sources.
        """
        with self._lock:
            if self.state["phase"] == "running":
                return False
            self.state.update(phase="running", marker=None, msg="starting")
            return True

    def _log(self, msg):
        print(f"[autocal] {msg}", flush=True)
        with self._lock:
            self.status["report"].append(msg)

    # -- frame capture ----------------------------------------------------- #
    def _capture(self, cam_id, n_frames=4, deadline_s=4.0):
        """Grab ``n_frames`` fresh (color, depth) pairs; None on stall.

        Reads with a per-call timeout so a live-but-stalled bridge cannot
        block past the deadline (read() without one blocks indefinitely).
        """
        src = self.cameras[cam_id]
        colors, depths, intr = [], [], None
        t0 = time.monotonic()
        while len(colors) < n_frames:
            remaining = deadline_s - (time.monotonic() - t0)
            if remaining <= 0:
                break
            r = src.read(timeout=remaining)
            if r is None:
                continue  # timed out or no frame yet; deadline check exits
            color, depth, intr = r
            if color is not None and depth is not None:
                colors.append(color.copy())
                depths.append(depth.copy())
        if not colors:
            return None
        return colors, depths, intr

    def _drain(self, seconds):
        """Keep reading (and discarding) frames while the scene settles.

        The bridge streams continuously; if we simply sleep, we'd resume on
        stale buffered frames from *before* the marker changed. Bounded reads
        so one stalled camera can't starve draining the others.
        """
        t0 = time.monotonic()
        while time.monotonic() - t0 < seconds:
            for src in self.cameras.values():
                src.read(timeout=0.1)

    # -- the sequence ------------------------------------------------------- #
    def run(self):
        try:
            self._run_inner()
        except Exception as e:  # noqa: BLE001 - report, don't die silently
            import traceback
            traceback.print_exc()
            self._set(phase="error", marker=None, msg=str(e))
            self._log(f"FAILED: {e}")
        finally:
            # Release the Kinects after every run, success or failure: a
            # bridge that died mid-run can only recover via a fresh spawn
            # (read() restarts a closed source), and holding the USB open
            # after "done" would block the gesture server from starting.
            for src in self.cameras.values():
                try:
                    src.close()
                except Exception:  # noqa: BLE001 - best-effort release
                    pass

    def _run_inner(self):
        self._set(phase="running", msg="warming up cameras")
        cam_ids = list(self.cameras)
        # First read spawns each bridge; allow a generous first-frame window so
        # marker #1 doesn't read as a "stall" while the Kinects boot.
        # Two warmup attempts: the first open after a process handoff often
        # delivers nothing until the source's auto-recovery (close/reboot)
        # kicks in — retrying here makes every run self-healing instead of
        # requiring the operator to fire twice.
        for attempt in (1, 2):
            stalled = None
            for c in cam_ids:
                got = self._capture(c, n_frames=1, deadline_s=20.0)
                if got is None:
                    stalled = c
                    break
                self._log(f"{c}: streaming")
            if stalled is None:
                break
            if attempt == 1:
                self._log(f"camera {stalled} silent — cycling sources and "
                          f"retrying warmup")
                self._set(msg="camera silent; retrying")
                for src_ in self.cameras.values():
                    try:
                        src_.close()
                    except Exception:  # noqa: BLE001
                        pass
                time.sleep(8)
            else:
                raise RuntimeError(
                    f"camera {stalled} produced no frames in two warmup "
                    f"attempts — is it plugged in and powered?")
        self._set(msg="capturing")
        # samples[wall][cam_id] = list of (u, v, point3-in-that-camera-frame)
        samples = {w: {c: [] for c in cam_ids} for w in self.walls}
        intrinsics: dict = {}
        total = len(self.walls) * len(MARKER_GRID)
        done = 0

        def capture_marker(wall, u, v, r, on_drain=1.1, on_frames=6):
            """One OFF/ON cycle for a marker; appends detections to samples."""
            self._set(marker=None)
            self._drain(0.7)
            off = {c: self._capture(c, n_frames=4) for c in cam_ids}
            # ON — longer settle + more frames so a dim/distant dot is caught
            self._set(marker={"wall": wall, "u": u, "v": v, "r": r})
            self._drain(on_drain)
            on = {c: self._capture(c, n_frames=on_frames) for c in cam_ids}

            for c in cam_ids:
                if off[c] is None or on[c] is None:
                    self._log(f"{wall}({u:.2f},{v:.2f}) {c}: camera stalled")
                    continue
                off_med = median_frame(off[c][0])
                on_med = median_frame(on[c][0])
                intrinsics[c] = on[c][2]
                # A camera that can't see this wall would only detect a
                # REFLECTION of its dot — skip so phantoms never enter the fit.
                if wall not in self.cam_walls[c]:
                    continue
                det = detect_marker(off_med, on_med)
                if det is None:
                    continue
                px, py, peak = det
                p3 = marker_point3(px, py, on[c][1], intrinsics[c])
                if p3 is None:
                    self._log(f"{wall}({u:.2f},{v:.2f}) {c}: blob but no depth")
                    continue
                samples[wall][c].append((u, v, p3))

        def publish_progress():
            with self._lock:
                self.status["progress"] = min(1.0, done / total)
                self.status["detections"] = {
                    w: {c: len(samples[w][c]) for c in cam_ids}
                    for w in self.walls}

        for wall in self.walls:
            for (u, v) in MARKER_GRID:
                capture_marker(wall, u, v, DOT_R)
                done += 1
                publish_progress()

        # Retry pass: every missed marker gets ONE more chance with a much
        # bigger disc and a longer settle — far/oblique stretches (wall B's
        # seam side at 3+ m) sit right at the detection threshold, and a
        # single missed flash should not cost the run.
        retries = missed_markers(samples, self.walls, self.cam_walls)
        if retries:
            self._log(f"retrying {len(retries)} missed marker(s) with "
                      f"bigger discs")
            self._set(msg="retrying missed markers")
            for (wall, u, v) in retries:
                capture_marker(wall, u, v, DOT_R_RETRY,
                               on_drain=1.4, on_frames=8)
                publish_progress()

        self._set(marker=None, msg="solving")
        counts = {w: {c: len(samples[w][c]) for c in cam_ids} for w in self.walls}
        self._log(f"detections: {counts}")

        if self.decoupled:
            return self._solve_decoupled(samples, intrinsics)

        # Reference camera = the one that sees the walls most SQUARELY, judged
        # by the 3D SPREAD of its markers (robust to sample count). A camera
        # viewing a wall edge-on still detects its dots but they collapse into a
        # thin sliver (small span) — such a view must never anchor the room
        # frame. Count walls a camera spans well (>= 1 m), tie-broken by markers.
        def _span(pts):
            if len(pts) < 3:
                return 0.0
            import numpy as np
            P = np.asarray([p for (_u, _v, p) in pts], dtype=float)
            return float(np.linalg.norm(P.max(axis=0) - P.min(axis=0)))
        cam_spans = {c: {w: _span(samples[w][c]) for w in self.walls}
                     for c in cam_ids}
        def _walls_seen(c):
            return sum(1 for w in self.walls if cam_spans[c][w] >= 1.0)
        ref_cam = max(cam_ids,
                      key=lambda c: (_walls_seen(c),
                                     sum(cam_spans[c].values())))
        self._log(f"reference camera (room frame): {ref_cam} "
                  f"(spans: {', '.join(f'{w}={cam_spans[ref_cam][w]:.1f}m' for w in self.walls)})")

        # --- per-camera per-wall outlier rejection ------------------------- #
        # tol=0.10: reflections/persons sit MUCH further off-plane than this,
        # while honest oblique-view depth noise at 4 m can reach ~8 cm — a
        # tighter tol throws away real markers a sole camera can't spare.
        for wall in self.walls:
            for c in cam_ids:
                kept, dropped = reject_off_plane(samples[wall][c], tol=0.10)
                if dropped:
                    self._log(f"wall {wall} {c}: dropped {dropped} off-plane "
                              f"(reflection/person/wrong-wall) sample(s)")
                samples[wall][c] = kept

        # --- second camera extrinsic via shared markers -------------------- #
        extrinsics = {ref_cam: Extrinsic.identity()}
        second = [c for c in cam_ids if c != ref_cam]
        for c in second:
            src_pts, dst_pts = [], []
            for wall in self.walls:
                ref_by_uv = {(u, v): p for (u, v, p) in samples[wall][ref_cam]}
                for (u, v, p_cam) in samples[wall][c]:
                    if (u, v) in ref_by_uv:
                        src_pts.append(p_cam)
                        dst_pts.append(ref_by_uv[(u, v)])
            reg = robust_register(src_pts, dst_pts)
            if reg is None:
                self._log(f"{c}: {len(src_pts)} shared markers — too few, "
                          f"(near-)collinear, or residual too high after "
                          f"dropping reflections; leaving it out of fusion")
                continue
            ext, kept, max_r = reg
            self._log(f"{c}: registered from {kept}/{len(src_pts)} markers "
                      f"(dropped {len(src_pts) - kept} outlier/reflection), "
                      f"max residual {max_r * 100:.1f} cm")
            extrinsics[c] = ext

        def pooled_for(wall):
            # Pool a camera's samples for a wall ONLY if that camera sees the
            # wall WELL (>= 1 m of 3D spread). A registered camera that views a
            # wall edge-on still detected its dots, but they collapse into a
            # sliver whose transformed points would poison the plane — exactly
            # what turned wall A into 0.02 m. The reference camera (identity
            # extrinsic) is included on the same footing.
            pool = []
            for c in cam_ids:
                if c in extrinsics and cam_spans[c][wall] >= 1.0:
                    pool.extend((u, v, extrinsics[c].apply(p))
                                for (u, v, p) in samples[wall][c])
            return pool

        # --- save raw samples for offline debugging / refits ---------------- #
        self._dump_samples(samples)

        # --- plane fits: anchor on the best-seen wall ---------------------- #
        # Free-fit every wall. A wall seen edge-on collapses to ~0 width, so we
        # classify fits as SANE or degenerate. The best-seen sane wall anchors
        # the corner; each other wall keeps its own free fit ONLY if it agrees
        # independently (sane, ~90° to the anchor, small seam gap), otherwise it
        # is re-fit CONSTRAINED to the anchor at exactly 90°. A good wall is
        # thus never wrecked by a degenerate neighbour.
        def _sane(plane):
            pw, ph = plane_metrics(plane)
            return (WIDTH_RANGE[0] <= pw <= WIDTH_RANGE[1]
                    and HEIGHT_RANGE[0] <= ph <= HEIGHT_RANGE[1])

        def _seam_gap(pa, pb):
            return min(math.dist(plane_point(pa, ea, 0.5),
                                 plane_point(pb, eb, 0.5))
                       for ea in (0.0, 1.0) for eb in (0.0, 1.0))

        # tol=0.10 as in the per-camera pass: oblique seam-end noise is ~5 cm.
        pools = {w: reject_off_plane(pooled_for(w), tol=0.10)[0]
                 for w in self.walls}
        free = {w: fit_wall_plane(pools[w])
                for w in self.walls if len(pools[w]) >= 4}
        sane = {w: p for w, p in free.items() if _sane(p)}
        if not sane:
            raise RuntimeError(
                "no wall produced a sane plane — a camera is probably seeing "
                "its wall edge-on; nudge it to face the wall more squarely")
        anchor_wall = max(sane, key=lambda w: len(pools[w]))
        planes = {anchor_wall: sane[anchor_wall]}
        aw, ah = plane_metrics(planes[anchor_wall])
        self._log(f"anchor wall {anchor_wall}: {len(pools[anchor_wall])} "
                  f"markers -> width {aw:.2f} m, height {ah:.2f} m")
        # Pin the anchor's width NOW, before other walls are corner-constrained
        # to its far-u seam corner — the constraint must use the measured
        # width, not the fitted one. (The later _pin_widths call is a no-op
        # for the anchor and pins the remaining walls after their fits.)
        self._pin_widths(planes)

        for wall in self.walls:
            if wall == anchor_wall:
                continue
            pool, anchor = pools[wall], planes[anchor_wall]
            if (wall in sane
                    and 85.0 <= plane_angle_deg(sane[wall], anchor) <= 95.0
                    and _seam_gap(sane[wall], anchor) <= 0.15):
                planes[wall] = sane[wall]
                w, h = plane_metrics(planes[wall])
                self._log(f"wall {wall}: {len(pool)} markers -> width {w:.2f} m,"
                          f" height {h:.2f} m (free fit agrees with corner)")
                continue
            if len(pool) < 3:
                raise RuntimeError(
                    f"wall {wall}: only {len(pool)} usable markers — check the "
                    f"autocal page is fullscreen on that projector and faces a "
                    f"camera")
            plane0 = constrained_corner_fit(anchor, pool)
            n, o = plane0.normal(), plane0.origin
            kept = [(u, v, p) for (u, v, p) in pool
                    if abs(sum(n[i] * (p[i] - o[i]) for i in range(3))) <= 0.10]
            if 3 <= len(kept) < len(pool):
                self._log(f"wall {wall}: dropped {len(pool) - len(kept)} "
                          f"sample(s) off the constrained plane")
                plane0 = constrained_corner_fit(anchor, kept)
            planes[wall] = plane0
            w, h = plane_metrics(plane0)
            self._log(f"wall {wall}: corner-constrained to {anchor_wall} at 90° "
                      f"-> width {w:.2f} m, height {h:.2f} m")

        self._pin_widths(planes)

        # --- sanity gates --------------------------------------------------- #
        problems = []
        for wall, plane in planes.items():
            w, h = plane_metrics(plane)
            if not (WIDTH_RANGE[0] <= w <= WIDTH_RANGE[1]):
                problems.append(f"wall {wall} width {w:.2f} m out of range")
            if not (HEIGHT_RANGE[0] <= h <= HEIGHT_RANGE[1]):
                problems.append(f"wall {wall} height {h:.2f} m out of range")
        if len(planes) == 2:
            a, b = (planes[w] for w in self.walls[:2])
            ang = plane_angle_deg(a, b)
            self._log(f"angle between walls: {ang:.1f} deg")
            if not (ANGLE_RANGE[0] <= ang <= ANGLE_RANGE[1]):
                problems.append(f"wall angle {ang:.1f} deg not corner-like")
        if problems:
            raise RuntimeError("; ".join(problems))

        # --- write the config ------------------------------------------------ #
        cfg = load_config_dict(self.config_path)
        full_run = set(cfg.get("walls", {})) <= set(self.walls)
        for wall, plane in planes.items():
            cfg = merge_wall_plane(cfg, wall, plane)
        for c in cam_ids:
            if c in extrinsics and c in intrinsics:
                # Preserve the configured sensor kind (kinect_v2/gemini_335):
                # autocal fixes poses, it never changes what the camera IS.
                cfg = merge_camera_pose(
                    cfg, c, intrinsics[c], extrinsics[c],
                    kind=_depth_kind_of(cfg, c))
                # serve only the walls this camera sees WELL (>= 1 m of 3D
                # marker spread) and that got calibrated — a camera never drives
                # a wall it sees edge-on/by reflection, where its live pointing
                # rays would be depth-noisy garbage.
                cfg["cameras"][c]["serves"] = [
                    w for w in self.walls
                    if w in planes and cam_spans[c][w] >= 1.0]
            elif c not in extrinsics and full_run:
                # Unregistered camera in a FULL calibration: keep it out of
                # fusion. A partial (--wall) run must NOT wipe a camera it
                # wasn't asked about — its other-wall calibration stays intact.
                cfg["cameras"][c]["serves"] = []
        # Keep fusion.cross_camera consistent with what THIS run established
        # (the three cases are spelled out on _cross_camera_update).
        walls_served = {c: cfg["cameras"][c].get("serves", [])
                        for c in cam_ids if c in cfg.get("cameras", {})}
        cc = _cross_camera_update(cfg, cam_ids, extrinsics, walls_served)
        if cc is False:
            cfg.setdefault("fusion", {})["cross_camera"] = False
            self._log("frames unregistered across cameras -> "
                      "fusion.cross_camera=false")
        elif cc is True:
            cfg.setdefault("fusion", {})["cross_camera"] = True
            if len(cam_ids) == 1:
                self._log("one camera serves every wall (one registered "
                          "frame) -> fusion.cross_camera=true")
        RoomConfig.from_dict(cfg)  # validate before persisting
        save_config_dict(self.config_path, cfg)
        self._log(f"wrote {self.config_path}")
        with self._lock:
            self.status["progress"] = 1.0
        self._set(phase="done", marker=None, msg="ok")

    def _dump_samples(self, samples) -> None:
        """Save raw samples for offline debugging / refits (best-effort)."""
        try:
            dump = {w: {c: [[u, v, list(p)] for (u, v, p) in samples[w][c]]
                        for c in samples[w]} for w in self.walls}
            Path("autocal_samples.json").write_text(json.dumps(dump, indent=1))
            self._log("raw samples saved to autocal_samples.json")
        except Exception:  # noqa: BLE001 - debugging aid only
            pass

    def _pin_widths(self, planes) -> None:
        """Rescale each plane's u_vec to the operator-measured width (in place).

        The camera nails a plane's orientation/position but may under-read its
        width when it can't see the far edge. Pinning to the tape-measured
        value, anchored at the well-seen origin edge, makes horizontal tile
        selection dead-on. Walls without a measurement keep their fitted width.

        A fit whose width is FAR from the measurement is refused rather than
        rescued: when the fitted width collapses (grazing view, clustered
        detections) the u direction itself is noise-dominated, and pinning it
        would launder exactly the degenerate fits the sanity gates exist to
        block. Idempotent: re-pinning an already-pinned plane is a no-op.
        """
        import dataclasses
        for wall in list(planes):
            target = self.wall_widths.get(wall)
            if target is None:
                continue
            p = planes[wall]
            cur = math.sqrt(sum(c * c for c in p.u_vec))
            if cur <= 1e-6:
                continue
            if abs(cur - target) / target > 0.30:
                raise RuntimeError(
                    f"wall {wall}: fitted width {cur:.2f} m is >30% off the "
                    f"measured {target:.2f} m — bad aim/lighting, refusing to "
                    f"pin (re-aim the camera and re-run)")
            s = target / cur
            planes[wall] = dataclasses.replace(
                p, u_vec=tuple(c * s for c in p.u_vec))
            self._log(f"wall {wall}: pinned width {cur:.2f} m -> "
                      f"{target:.2f} m (operator measurement)")

    def _solve_decoupled(self, samples, intrinsics) -> None:
        """Per-wall solve for the decoupled architecture: one camera per wall,
        each wall's plane fit in its OWNER camera's own frame, identity
        extrinsics, no cross-camera registration.

        Every cross-frame step of the joint solve (reference-camera pick,
        Kabsch registration, sample pooling, corner-constrained fits, the
        inter-wall angle/seam gates) is skipped — each presumes one shared
        frame, and with two unregistered frames even a PERFECT calibration
        would misfire them (both squarely-faced walls have normal ~ -Z in
        their own frames, so the apparent inter-plane angle is ~0°, not 90°).
        """
        self._log("DECOUPLED solve: " + ", ".join(
            f"{w}<-{c}" for w, c in sorted(self.wall_owner.items())))
        # Dump BEFORE fitting: failed runs are the ones that need debugging.
        self._dump_samples(samples)

        planes = {}
        for wall in self.walls:
            owner = self.wall_owner[wall]
            kept, dropped = reject_off_plane(samples[wall][owner], tol=0.10)
            if dropped:
                self._log(f"wall {wall} {owner}: dropped {dropped} off-plane "
                          f"(reflection/person) sample(s)")
            if len(kept) < 4:
                raise RuntimeError(
                    f"wall {wall}: only {len(kept)} usable markers from "
                    f"{owner} — is its autocal page fullscreen on that "
                    f"projector and facing the camera?")
            planes[wall] = fit_wall_plane(kept)
            w, h = plane_metrics(planes[wall])
            self._log(f"wall {wall}: {len(kept)} markers ({owner}'s frame) "
                      f"-> width {w:.2f} m, height {h:.2f} m")

        self._pin_widths(planes)

        # Frame-local sanity only — no inter-wall angle/seam gates here.
        problems = []
        for wall, plane in planes.items():
            w, h = plane_metrics(plane)
            if not (WIDTH_RANGE[0] <= w <= WIDTH_RANGE[1]):
                problems.append(f"wall {wall} width {w:.2f} m out of range")
            if not (HEIGHT_RANGE[0] <= h <= HEIGHT_RANGE[1]):
                problems.append(f"wall {wall} height {h:.2f} m out of range")
        if problems:
            raise RuntimeError("; ".join(problems))

        cfg = load_config_dict(self.config_path)
        for wall, plane in planes.items():
            cfg = merge_wall_plane(cfg, wall, plane)
        for c in self.cameras:
            if c not in intrinsics:
                continue
            # Preserve the configured sensor kind (kinect_v2/gemini_335).
            cfg = merge_camera_pose(
                cfg, c, intrinsics[c], Extrinsic.identity(),
                kind=_depth_kind_of(cfg, c))
            # Ownership is the operator's assertion (--pair), not inferred
            # from marker spread: each camera serves exactly its own wall.
            cfg["cameras"][c]["serves"] = sorted(self.cam_walls[c])
        # Declare the frames unregistered so tracking never merges or matches
        # observations across the two cameras (inter-frame distances are
        # meaningless; see FusionCfg.cross_camera).
        cfg.setdefault("fusion", {})["cross_camera"] = False
        RoomConfig.from_dict(cfg)  # validate before persisting
        save_config_dict(self.config_path, cfg)
        self._log(f"wrote {self.config_path} (decoupled: per-camera frames)")
        with self._lock:
            self.status["progress"] = 1.0
        self._set(phase="done", marker=None, msg="ok")


# --------------------------------------------------------------------------- #
# HTTP plumbing                                                                #
# --------------------------------------------------------------------------- #
def make_handler(web_dir: str, calib: AutoCalibrator):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=web_dir, **kw)

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            # The unified wall pages are served from the GESTURE server's
            # origin (:8000) and poll this server cross-origin — without CORS
            # the browser silently drops every response and the pages never
            # flip into calibration mode.
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path.startswith("/calib/state"):
                return self._json(calib.get_state())
            if self.path.startswith("/calib/status"):
                return self._json(calib.get_status())
            # --- debug: manually hold/clear a marker (diagnostics only) ------ #
            if self.path.startswith("/calib/hold"):
                from urllib.parse import parse_qs, urlparse
                q = parse_qs(urlparse(self.path).query)
                calib._set(phase="running", marker={
                    "wall": q["wall"][0],
                    "u": float(q["u"][0]), "v": float(q["v"][0])})
                return self._json({"ok": True})
            if self.path.startswith("/calib/clear"):
                calib._set(phase="running", marker=None)
                return self._json({"ok": True})
            if self.path.startswith("/calib/idle"):
                calib._set(phase="idle", marker=None)
                return self._json({"ok": True})
            return super().do_GET()

        def do_POST(self):  # noqa: N802
            if self.path.startswith("/calib/start"):
                if not calib.try_begin():  # atomic compare-and-set
                    return self._json({"ok": False, "msg": "already running"})
                threading.Thread(target=calib.run, daemon=True).start()
                return self._json({"ok": True})
            return self._json({"ok": False, "msg": "unknown endpoint"}, 404)

        def log_message(self, fmt, *args):  # quiet the per-poll request noise
            pass

    Handler.timeout = 5  # a dead client can't pin a handler thread forever
    return Handler


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", required=True)
    ap.add_argument("--port", type=int, default=8801)
    ap.add_argument("--web-dir", default=str(Path(__file__).parent.parent / "web"))
    ap.add_argument("--wall", default=None,
                    help="calibrate ONE wall only (e.g. A) — for a room where "
                         "no single camera can see both walls; each camera owns "
                         "the wall it can see, no cross-camera registration")
    ap.add_argument("--camera", default=None,
                    help="with --wall, use ONLY this camera (identity frame). "
                         "It defines the room frame for the wall it serves.")
    ap.add_argument("--pair", action="append", metavar="CAM=WALL",
                    help="DECOUPLED mode, one flag per camera (e.g. "
                         "--pair cam0=A --pair cam1=B): each camera owns "
                         "exactly one wall in its OWN frame (identity "
                         "extrinsic); both projector pages run in ONE pass, "
                         "no cross-camera registration")
    ap.add_argument("--width", action="append", metavar="[WALL=]METRES",
                    help="ground-truth physical wall width: repeatable "
                         "WALL=METRES (e.g. --width A=2.3 --width B=2.5), or "
                         "a single bare METRES with --wall; pins the fitted "
                         "plane's width to this exact value")
    args = ap.parse_args(argv)

    cfg = RoomConfig.from_dict(load_config_dict(args.config))
    from .framesource import make_frame_source  # lazy: may spawn bridges/SDKs

    if args.pair and (args.wall or args.camera):
        ap.error("--pair cannot be combined with --wall/--camera")

    if args.pair:
        # Decoupled mode: an explicit operator-asserted CAM=WALL partition.
        pairs: dict[str, str] = {}
        for spec in args.pair:
            cam, sep, wall = spec.partition("=")
            if not sep or not cam or not wall:
                ap.error(f"--pair {spec!r}: expected CAM=WALL (e.g. cam0=A)")
            if cam not in cfg.cameras:
                ap.error(f"--pair {spec!r}: unknown camera {cam!r} "
                         f"(config has {list(cfg.cameras)})")
            if wall not in cfg.walls:
                ap.error(f"--pair {spec!r}: unknown wall {wall!r} "
                         f"(config has {list(cfg.walls)})")
            if cam in pairs or wall in pairs.values():
                ap.error(f"--pair {spec!r}: camera or wall given twice")
            pairs[cam] = wall
        cam_ids = list(pairs)
        walls = [pairs[c] for c in cam_ids]
        cam_walls = {c: {w} for c, w in pairs.items()}
        print("[autocal] DECOUPLED mode: "
              + ", ".join(f"{c}->{pairs[c]}" for c in cam_ids)
              + " (identity frames, no cross-camera registration)")
    elif args.wall or args.camera:
        # Single-wall mode: restrict to one wall (+ optionally one camera) so
        # only that wall's projector page and that camera matter — the config
        # write only touches that wall/camera, leaving the other wall intact.
        if args.camera and args.camera not in cfg.cameras:
            ap.error(f"--camera {args.camera!r}: unknown camera "
                     f"(config has {list(cfg.cameras)})")
        if args.wall and args.wall not in cfg.walls:
            ap.error(f"--wall {args.wall!r}: unknown wall "
                     f"(config has {list(cfg.walls)})")
        cam_ids = [args.camera] if args.camera else list(cfg.cameras)
        walls = [args.wall] if args.wall else list(cfg.walls)
        cam_walls = {cid: set(walls) for cid in cam_ids}
        print(f"[autocal] SINGLE mode: wall(s) {walls} from camera(s) "
              f"{cam_ids} (no cross-camera registration)")
    else:
        # Joint mode. A camera's `serves` doubles as "which walls it can SEE"
        # (empty = sees all), so its edge-on view of the other wall is excluded.
        # Note: after a decoupled run serves is [A]/[B], so a plain re-run
        # auto-infers decoupled again inside AutoCalibrator — by design.
        cam_ids = list(cfg.cameras)
        walls = list(cfg.walls)
        cam_walls = {cid: (set(cfg.cameras[cid].serves)
                           if cfg.cameras[cid].serves else set(walls))
                     for cid in cam_ids}
        for cid, ws in cam_walls.items():
            print(f"[autocal] {cid} calibrates walls: {sorted(ws)}")

    widths: dict | float | None = None
    if args.width:
        try:
            if all("=" in v for v in args.width):
                widths = {}
                for spec in args.width:
                    wall, _, metres = spec.partition("=")
                    if wall not in walls:
                        ap.error(f"--width {spec!r}: wall {wall!r} is not in "
                                 f"this run (walls: {walls})")
                    if wall in widths:
                        ap.error(f"--width {spec!r}: wall given twice")
                    widths[wall] = float(metres)
            elif len(args.width) == 1 and args.wall:
                widths = float(args.width[0])
            else:
                ap.error("--width: use WALL=METRES (repeatable), or a single "
                         "bare METRES together with --wall")
        except ValueError:
            ap.error(f"--width: {args.width!r} is not a number")
        vals = widths.values() if isinstance(widths, dict) else [widths]
        if any(v <= 0 for v in vals):
            ap.error("--width: widths must be positive metres")
    else:
        # No --width on the command line: pin to the operator-measured widths
        # stored in the room config (walls.<id>.width_m), where present.
        cfg_w = {w: cfg.walls[w].width_m for w in walls
                 if cfg.walls[w].width_m is not None}
        if cfg_w:
            widths = cfg_w
            print("[autocal] width pins from config: "
                  + ", ".join(f"{w}={m}m" for w, m in sorted(cfg_w.items())))

    # Pre-kind Kinect configs parse as the "rgb" default; autocal historically
    # always built a Kinect source, so keep that as the fallback.
    def _src(cam_id):
        kind = cfg.cameras[cam_id].kind
        return make_frame_source("kinect_v2" if kind == "rgb" else kind,
                                 cfg.cameras[cam_id].device)
    cameras = {cam_id: _src(cam_id) for cam_id in cam_ids}
    calib = AutoCalibrator(args.config, walls, cameras, cam_walls=cam_walls,
                           wall_width=widths, decoupled=bool(args.pair) or None)

    httpd = ThreadingHTTPServer(("", args.port),
                                make_handler(args.web_dir, calib))
    # Also serve the web dir on the gesture server's HTTP port while it is
    # down for calibration: the projector wall pages load from that origin,
    # and a mid-calibration refresh must not dead-end on "site can't be
    # reached". Skipped silently if something already holds the port.
    try:
        from .server import start_http_server
        start_http_server(args.web_dir, cfg.server.http_port)
        print(f"[autocal] also serving wall pages on "
              f"http://localhost:{cfg.server.http_port}")
    except OSError:
        pass
    print(f"[autocal] serving on http://localhost:{args.port}")
    for w in walls:
        print(f"[autocal]   open http://localhost:{args.port}/autocal.html?wall={w}")
    print(f"[autocal] then: curl -X POST http://localhost:{args.port}/calib/start")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for src in cameras.values():
            try:
                src.close()
            except Exception:  # noqa: BLE001
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
