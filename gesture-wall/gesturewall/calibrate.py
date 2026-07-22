"""Calibration CLI: capture homographies and merge them into ``room.json``.

A multi-wall room needs two kinds of perspective maps (see
:mod:`gesturewall.room`):

  * one ``"<cam>-><wall>"`` calibration per (camera, wall) pair, mapping that
    camera's image onto that wall's normalized coordinates;
  * an optional per-camera ``room_homography`` mapping the camera image into the
    shared room/floor frame.

This module produces both with the same "point at each corner, press SPACE"
flow used by the single-wall app (:func:`gesturewall.app.calibrate_pose`), then
writes the resulting 3x3 matrix back into the room config JSON in place:

    .venv/bin/python -m gesturewall.calibrate --config room.json \\
        --camera cam0 --wall A      # writes calibration["cam0->A"]
    .venv/bin/python -m gesturewall.calibrate --config room.json \\
        --floor cam0                # writes cameras["cam0"]["room_homography"]

The camera/cv2/mediapipe pieces are imported LAZILY inside the capture routine,
so importing this module (and unit-testing its math) never needs a webcam. The
pure logic — turning 4 captured corners into a matrix, and merging a matrix into
the config dict — lives in standalone functions that are fully tested headless:

  * :func:`corners4_to_matrix`     - 4 corner points -> 3x3 matrix (list form).
  * :func:`merge_calibration`      - put a matrix at ``calibration["<cam>-><wall>"]``.
  * :func:`merge_room_homography`  - put a matrix at ``cameras[cam]["room_homography"]``.

For the depth-ray path (see :mod:`gesturewall.geometry` and the depth fields in
:mod:`gesturewall.room`) there are three more pure helpers that write/derive the
3D geometry — a wall's 3D plane, a camera's intrinsics+extrinsic pose, and a
CAMERA->ROOM extrinsic recovered from measured correspondences:

  * :func:`merge_wall_plane`              - put a plane at ``walls[wall]["plane"]``.
  * :func:`merge_camera_pose`             - put intrinsics+extrinsic on a camera.
  * :func:`extrinsic_from_correspondences` - 3D point matches -> CAMERA->ROOM extrinsic.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path

from . import geometry
from .calibration import CORNER_NAMES, WALL_CORNERS, Homography
from .geometry import CameraIntrinsics, Extrinsic, WallPlane
from .room import DEPTH_KINDS, RoomConfig, _calib_key

Matrix = list[list[float]]

# Floor reference targets: the 4 corners of the shared room frame the user (or a
# helper marker) points at, in the same TL, TR, BR, BL order as WALL_CORNERS.
FLOOR_CORNERS = WALL_CORNERS
FLOOR_CORNER_NAMES = CORNER_NAMES


# --------------------------------------------------------------------------- #
# Pure math / config-merge helpers (no cv2, no camera, fully unit-testable)    #
# --------------------------------------------------------------------------- #
def corners4_to_matrix(corners: list[tuple[float, float]]) -> Matrix:
    """Turn 4 captured corner points into a 3x3 homography matrix (list form).

    ``corners`` are the 4 raw pointer positions captured while pointing at
    TOP-LEFT, TOP-RIGHT, BOTTOM-RIGHT, BOTTOM-LEFT (in that order), exactly as
    :func:`gesturewall.app.calibrate_pose` collects them. The points are mapped
    onto :data:`gesturewall.calibration.WALL_CORNERS` via
    :meth:`Homography.from_corner_points`, which rejects degenerate
    (collinear/coincident) quads with a :class:`ValueError`.

    Returns the matrix as a plain list of lists so it can be JSON-serialized
    directly into the room config.
    """
    return Homography.from_corner_points(list(corners)).matrix


def merge_calibration(config_dict: dict, key: str, matrix: Matrix) -> dict:
    """Return a copy of ``config_dict`` with ``calibration[key] = {matrix}``.

    ``key`` is a ``"<cam>-><wall>"`` calibration key. The input dict is not
    mutated; a deep copy is returned so callers can validate or diff before
    saving. A missing ``"calibration"`` section is created.
    """
    out = copy.deepcopy(config_dict)
    out.setdefault("calibration", {})[key] = {
        "matrix": _matrix_as_floats(matrix)}
    return out


def merge_room_homography(config_dict: dict, camera_id: str,
                          matrix: Matrix) -> dict:
    """Return a copy of ``config_dict`` with the camera's ``room_homography`` set.

    Writes ``cameras[camera_id]["room_homography"] = matrix``. The input dict is
    not mutated. Raises :class:`KeyError` if the camera is not declared in the
    config (we never invent cameras here — only floor-calibrate existing ones).
    """
    out = copy.deepcopy(config_dict)
    cameras = out.get("cameras")
    if not isinstance(cameras, dict) or camera_id not in cameras:
        raise KeyError(
            f"camera {camera_id!r} is not declared in the config; add it before "
            f"floor-calibrating it")
    cameras[camera_id]["room_homography"] = _matrix_as_floats(matrix)
    return out


# --------------------------------------------------------------------------- #
# Depth-mode config-merge helpers (geometry is PURE; cv2 stays lazy)           #
# --------------------------------------------------------------------------- #
def merge_wall_plane(config_dict: dict, wall_id: str,
                     plane: WallPlane) -> dict:
    """Return a copy of ``config_dict`` with ``walls[wall_id]["plane"]`` set.

    Writes the depth-mode 3D :class:`~gesturewall.geometry.WallPlane` for a wall
    as ``{"origin": [...], "u_vec": [...], "v_vec": [...]}``, the shape
    :func:`gesturewall.room._parse_plane` reads back. The input dict is not
    mutated. Raises :class:`KeyError` if the wall is not declared in the config
    (we never invent walls here — only plane-calibrate existing ones).
    """
    out = copy.deepcopy(config_dict)
    walls = out.get("walls")
    if not isinstance(walls, dict) or wall_id not in walls:
        raise KeyError(
            f"wall {wall_id!r} is not declared in the config; add it before "
            f"plane-calibrating it")
    walls[wall_id]["plane"] = {
        "origin": _vec3_as_floats(plane.origin),
        "u_vec": _vec3_as_floats(plane.u_vec),
        "v_vec": _vec3_as_floats(plane.v_vec),
    }
    return out


def merge_camera_pose(config_dict: dict, camera_id: str,
                      intrinsics: CameraIntrinsics, extrinsic: Extrinsic,
                      kind: str = "kinect_v2") -> dict:
    """Return a copy of ``config_dict`` with a camera's depth pose written.

    Sets ``cameras[camera_id]`` ``"kind"``, ``"intrinsics"`` (fx, fy, cx, cy,
    width, height) and ``"extrinsic"`` (a 4x4 ``"matrix"``), the shapes
    :func:`gesturewall.room._parse_intrinsics` / ``_parse_extrinsic`` read back.
    The input dict is not mutated. Raises :class:`KeyError` if the camera is not
    declared in the config (we never invent cameras here — only pose-calibrate
    existing ones).
    """
    out = copy.deepcopy(config_dict)
    cameras = out.get("cameras")
    if not isinstance(cameras, dict) or camera_id not in cameras:
        raise KeyError(
            f"camera {camera_id!r} is not declared in the config; add it before "
            f"pose-calibrating it")
    cam = cameras[camera_id]
    cam["kind"] = kind
    cam["intrinsics"] = {
        "fx": float(intrinsics.fx),
        "fy": float(intrinsics.fy),
        "cx": float(intrinsics.cx),
        "cy": float(intrinsics.cy),
        "width": int(intrinsics.width),
        "height": int(intrinsics.height),
    }
    cam["extrinsic"] = {"matrix": _matrix4_as_floats(extrinsic.matrix)}
    return out


def extrinsic_from_correspondences(src_room_pts, observed_cam_pts) -> Extrinsic:
    """Recover a CAMERA->ROOM :class:`Extrinsic` from 3D correspondences.

    ``observed_cam_pts`` are points measured in the camera frame and
    ``src_room_pts`` their known positions in the room frame; the returned
    transform maps camera points onto room points (Kabsch/Umeyama via
    :func:`gesturewall.geometry.rigid_transform_from_points`). Needs >= 3
    non-collinear correspondences (raises :class:`ValueError` otherwise).
    """
    return geometry.rigid_transform_from_points(observed_cam_pts, src_room_pts)


def corner3d_from_pixel(px, py, depth_map, intrinsics: CameraIntrinsics,
                        extrinsic: Extrinsic, *, window: int = 7):
    """Turn a clicked pixel + the aligned depth into a 3D ROOM point (PURE).

    Samples the depth at ``(px, py)`` (median of a small window, ignoring
    invalid/zero readings), deprojects it to a 3D camera point via
    ``intrinsics``, then lifts it into the room frame via ``extrinsic``. Returns
    ``None`` when there is no valid depth at that pixel (e.g. a gap, an edge, or
    out of range) so the caller can ask for another click. No cv2/camera.
    """
    d = geometry.sample_depth(depth_map, px, py, window=window)
    if d is None or d <= 0:
        return None
    cam_pt = intrinsics.deproject(px, py, d)
    return extrinsic.apply(cam_pt)


def plane_from_corner3d(corners3d) -> WallPlane:
    """Build a wall :class:`WallPlane` from captured corner 3D points (PURE).

    ``corners3d`` are the corners in TOP-LEFT, TOP-RIGHT, BOTTOM-RIGHT,
    BOTTOM-LEFT order (BOTTOM-RIGHT is optional). Uses TL, TR, BL — the same
    spanning trio :func:`gesturewall.geometry.plane_from_corners` expects.
    """
    if len(corners3d) < 3:
        raise ValueError("need at least 3 corner points to define a plane")
    top_left, top_right = corners3d[0], corners3d[1]
    bottom_left = corners3d[3] if len(corners3d) >= 4 else corners3d[2]
    return geometry.plane_from_corners(top_left, top_right, bottom_left)


def _depth_kind(config_dict: dict, cam_id: str) -> str:
    """The camera's configured depth kind, defaulting to ``"kinect_v2"``.

    Read from the RAW config dict (not :class:`CameraCfg`, whose absent-kind
    default is ``"rgb"``): depth configs written before the ``kind`` field
    existed are all Kinect v2 rooms, so an absent kind at a depth-capture site
    means the original Kinect v2. The kind is what
    :func:`gesturewall.framesource.make_frame_source` dispatches on.
    """
    kind = config_dict.get("cameras", {}).get(cam_id, {}).get("kind")
    return kind if kind is not None else "kinect_v2"


def _ensure_dyld_path() -> None:
    """Prepend ``~/.local/lib`` to DYLD_LIBRARY_PATH so the spawned bridge finds
    libfreenect2 even if the user's shell didn't export it."""
    local_lib = str(Path.home() / ".local" / "lib")
    current = os.environ.get("DYLD_LIBRARY_PATH", "")
    if local_lib not in current.split(":"):
        os.environ["DYLD_LIBRARY_PATH"] = (
            f"{local_lib}:{current}" if current else local_lib)


def _matrix_as_floats(matrix: Matrix) -> Matrix:
    """Coerce a 3x3 matrix into plain floats so JSON round-trips cleanly."""
    return [[float(v) for v in row] for row in matrix]


def _matrix4_as_floats(matrix) -> list[list[float]]:
    """Coerce a 4x4 matrix into plain floats so JSON round-trips cleanly."""
    return [[float(v) for v in row] for row in matrix]


def _vec3_as_floats(vec) -> list[float]:
    """Coerce a 3-vector into a plain list of floats for JSON."""
    return [float(vec[0]), float(vec[1]), float(vec[2])]


def load_config_dict(path: str | Path) -> dict:
    """Read a room config JSON file into a plain dict (no validation)."""
    return json.loads(Path(path).read_text())


def save_config_dict(path: str | Path, config_dict: dict) -> None:
    """Write a room config dict back to JSON, atomically.

    Writes a sibling temp file then ``os.replace`` (atomic on the same
    filesystem), so a crash mid-write can never leave the live config — which
    every other tool loads — truncated or half-written.
    """
    import os
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(config_dict, indent=2) + "\n")
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# Camera capture (lazy cv2/mediapipe) — the "point and press SPACE" flow       #
# --------------------------------------------------------------------------- #
# Reused BGR colors / window name, mirroring app.calibrate_pose's look.
WINDOW = "Gesture Wall — calibrate"
BG = (24, 24, 28)
TEXT = (235, 235, 235)
CURSOR = (60, 200, 220)
RING_FG = (60, 220, 240)


def _most_engaged_person(people):
    """Pick the body to calibrate against: the most-engaged, highest-confidence.

    Prefers engaged people (arm raised); among ties, the highest confidence.
    Returns ``None`` when nobody is present.
    """
    if not people:
        return None
    return max(people, key=lambda p: (1 if p.engaged else 0, p.confidence))


def capture_corners(source, width: int, height: int, *,
                    targets: list[tuple[float, float]] = WALL_CORNERS,
                    names: list[str] = CORNER_NAMES,
                    prompt: str = "corner") -> list[tuple[float, float]] | None:
    """Run the interactive 4-corner capture against a :class:`MultiPoseSource`.

    For each target corner, draws the target, shows the most-engaged person's
    wrist as a live cursor, and waits for SPACE (only accepted while that person
    is engaged). ESC cancels and returns ``None``. cv2 is imported lazily here so
    this module imports without a display.

    Returns the 4 captured ``(x, y)`` points in target order, clamped to [0,1].
    """
    import cv2  # lazy: only needed when actually capturing
    import numpy as np

    captured: list[tuple[float, float]] = []
    canvas = np.zeros((height, width, 3), dtype=np.uint8)

    for i, (corner, name) in enumerate(zip(targets, names)):
        while True:
            frame, people, _info = source.read()
            person = _most_engaged_person(people)
            pointer = person.wrist if person is not None else None
            engaged = bool(person is not None and person.engaged)
            ready = pointer is not None and engaged

            canvas[:] = BG
            tx, ty = int(corner[0] * width), int(corner[1] * height)
            cv2.circle(canvas, (tx, ty), 22, RING_FG, 3, cv2.LINE_AA)
            cv2.circle(canvas, (tx, ty), 6, RING_FG, cv2.FILLED, cv2.LINE_AA)
            cv2.putText(canvas, f"Point at the {name} {prompt}, then press SPACE "
                        f"({i + 1}/4)", (20, 40), cv2.FONT_HERSHEY_SIMPLEX,
                        0.8, TEXT, 2, cv2.LINE_AA)
            hint = "ready - press SPACE" if ready else "raise your pointing hand"
            cv2.putText(canvas, hint, (20, 74), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                        RING_FG if ready else (120, 120, 200), 2, cv2.LINE_AA)
            cv2.putText(canvas, "ESC to cancel", (20, height - 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, TEXT, 1, cv2.LINE_AA)
            if pointer is not None:
                px, py = int(pointer[0] * width), int(pointer[1] * height)
                cv2.circle(canvas, (px, py), 8, CURSOR, cv2.FILLED, cv2.LINE_AA)
            if frame is not None:
                _embed_preview(cv2, canvas, frame)
            cv2.imshow(WINDOW, canvas)

            key = cv2.waitKey(1) & 0xFF
            if key == 27:  # ESC
                print("[gesturewall] calibration cancelled.")
                return None
            if key == 32 and ready:  # SPACE — only capture an engaged pointer
                captured.append((min(1.0, max(0.0, pointer[0])),
                                 min(1.0, max(0.0, pointer[1]))))
                break

    return captured


# Calibration point patterns. Each target is ``(label, u, v)`` in wall
# coordinates: (0,0)=top-left, (1,0)=top-right, (1,1)=bottom-right, (0,1)=bottom-left.
CORNER_TARGETS = [
    ("TOP-LEFT corner", 0.0, 0.0),
    ("TOP-RIGHT corner", 1.0, 0.0),
    ("BOTTOM-RIGHT corner", 1.0, 1.0),
    ("BOTTOM-LEFT corner", 0.0, 1.0),
]


def _seam_side(cfg: RoomConfig, wall_id: str):
    """Which edge of ``wall_id`` is the seam: 'right' (u=1), 'left' (u=0), or None.

    Read from the room ``adjacency``: a wall declared as the ``left`` of a seam
    has the seam on its right edge; a ``right`` wall has it on its left.
    """
    for adj in cfg.adjacency:
        if adj.left == wall_id:
            return "right"
        if adj.right == wall_id:
            return "left"
    return None


def _seam_half_targets(side: str):
    """The 'close camera' pattern: top/bottom edge MIDPOINTS + the two SEAM corners.

    Use when the camera is too close to see the far corners — these four points
    all sit on the seam half of the wall (``u`` in [0.5, 1] or [0, 0.5]) yet still
    pin the full flat plane via :func:`gesturewall.geometry.fit_wall_plane`.
    """
    seam_u = 1.0 if side == "right" else 0.0
    return [
        ("TOP edge MIDPOINT", 0.5, 0.0),
        ("BOTTOM edge MIDPOINT", 0.5, 1.0),
        ("SEAM TOP corner", seam_u, 0.0),
        ("SEAM BOTTOM corner", seam_u, 1.0),
    ]


def _targets_for(pattern: str, cfg: RoomConfig, wall_id: str):
    """Resolve the ``--pattern`` name to a list of ``(label, u, v)`` targets."""
    if pattern == "corners":
        return CORNER_TARGETS
    if pattern == "seam-half":
        side = _seam_side(cfg, wall_id)
        if side is None:
            raise SystemExit(
                f"wall {wall_id!r} has no seam (it is not in any adjacency), so "
                f"--pattern seam-half has no seam corner to click. Either add an "
                f"adjacency for it or use --pattern corners.")
        return _seam_half_targets(side)
    raise SystemExit(f"unknown --pattern {pattern!r} (use corners or seam-half)")


def capture_points(source, intrinsics: CameraIntrinsics, extrinsic: Extrinsic,
                   labels, title: str, *, scale: int | None = None,
                   window: int = 7):
    """Interactive depth-camera capture of a list of labelled points (lazy cv2).

    Shows the camera's live depth-aligned color feed, upscaled by ``scale``.
    ``scale=None`` (the default) adapts to the frame: ``max(1, round(1024 /
    frame_width))``, so the Kinect's 512-wide frame is doubled to 1024 px while
    a 1280-wide Gemini 335 frame is shown 1:1 (not blown up to 2560 px). For
    each label in ``labels`` the operator CLICKS where that point on the wall
    appears; the aligned depth there is turned into a 3D room point by
    :func:`corner3d_from_pixel`. ESC cancels. cv2 is imported lazily.

    Returns the list of captured 3D ROOM points (one per label, in order), or
    ``None`` if the operator cancelled or the camera stream ended.
    """
    import cv2  # lazy: only needed when actually capturing

    points: list = []
    captured_px: list[tuple[int, int]] = []
    pending = {"pt": None}

    def _on_mouse(event, x, y, _flags, _param):
        if event == cv2.EVENT_LBUTTONDOWN:
            pending["pt"] = (x, y)

    cv2.namedWindow(title)
    cv2.setMouseCallback(title, _on_mouse)
    try:
        latest_depth = None
        while len(points) < len(labels):
            item = source.read()
            if item is None:
                print("[gesturewall] camera stream ended before calibration "
                      "finished.")
                return None
            color, depth_m, intrinsics = item   # intr refreshed from the stream
            latest_depth = depth_m

            if scale is None:  # adapt to the frame: target a ~1024-px display
                scale = max(1, round(1024 / color.shape[1]))
            disp = cv2.resize(
                color, (color.shape[1] * scale, color.shape[0] * scale),
                interpolation=cv2.INTER_NEAREST)
            for (cx, cy) in captured_px:
                cv2.circle(disp, (cx, cy), 7, (70, 220, 90), 2, cv2.LINE_AA)
            label = labels[len(points)]
            cv2.putText(disp, f"Click: {label}   ({len(points) + 1}/{len(labels)})",
                        (16, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                        (235, 235, 235), 2, cv2.LINE_AA)
            cv2.putText(disp, "click that point on the wall  |  Esc cancels",
                        (16, disp.shape[0] - 16), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                        (200, 200, 210), 1, cv2.LINE_AA)
            cv2.imshow(title, disp)

            key = cv2.waitKey(1) & 0xFF
            if key == 27:  # ESC
                print("[gesturewall] calibration cancelled.")
                return None
            if pending["pt"] is not None:
                wx, wy = pending["pt"]
                pending["pt"] = None
                pt3 = corner3d_from_pixel(wx / scale, wy / scale, latest_depth,
                                          intrinsics, extrinsic, window=window)
                if pt3 is None:
                    print("[gesturewall] no depth reading there - click on the wall "
                          "surface (not a gap/edge or out of range), then try again.")
                else:
                    points.append(pt3)
                    captured_px.append((int(wx), int(wy)))
                    print(f"[gesturewall] captured {label} at "
                          f"({pt3[0]:.2f}, {pt3[1]:.2f}, {pt3[2]:.2f}) m")
        return points
    finally:
        cv2.destroyWindow(title)


def capture_plane_points(source, intrinsics: CameraIntrinsics,
                         extrinsic: Extrinsic, targets, title: str, *,
                         scale: int | None = None, window: int = 7):
    """Capture ``(label, u, v)`` targets and zip the clicks with their ``(u, v)``.

    Returns a list of ``(u, v, point3)`` samples for
    :func:`gesturewall.geometry.fit_wall_plane`, or ``None`` if cancelled.
    """
    pts = capture_points(source, intrinsics, extrinsic, [t[0] for t in targets],
                         title, scale=scale, window=window)
    if pts is None:
        return None
    return [(u, v, p) for (_lbl, u, v), p in zip(targets, pts)]


def _seam_pair_planes(points):
    """Fit both walls of a seam from the 6 shared captured points (PURE).

    ``points`` are, in order: left-wall top-mid, left-wall bottom-mid,
    right-wall top-mid, right-wall bottom-mid, seam-top corner, seam-bottom
    corner. The two seam corners are SHARED, so each wall is fit from its two
    edge midpoints plus the same two seam corners — guaranteeing the walls meet
    exactly at the seam. Returns ``(left_plane, right_plane)``.
    """
    ltm, lbm, rtm, rbm, seam_top, seam_bot = points
    left = geometry.fit_wall_plane([
        (0.5, 0.0, ltm), (0.5, 1.0, lbm), (1.0, 0.0, seam_top), (1.0, 1.0, seam_bot)])
    right = geometry.fit_wall_plane([
        (0.5, 0.0, rtm), (0.5, 1.0, rbm), (0.0, 0.0, seam_top), (0.0, 1.0, seam_bot)])
    return left, right


def calibrate_seam_pair(args) -> int:
    """Calibrate BOTH walls of a seam at once from 6 shared points.

    Captures (in order): each wall's top + bottom edge MIDPOINTS, then the two
    SEAM corners shared by both walls. Fits both planes with the shared seam
    corners so the walls line up exactly at the corner — fewer clicks than two
    separate ``--pattern seam-half`` passes (6 vs 8) and no seam mismatch.
    """
    config_dict = load_config_dict(args.config)
    cfg = RoomConfig.from_dict(config_dict)
    cam_id = args.camera
    if cam_id is None:
        raise SystemExit("--seam needs --camera (e.g. --camera cam0)")
    if cam_id not in cfg.cameras:
        raise SystemExit(f"camera {cam_id!r} is not declared in {args.config}")
    if not cfg.adjacency:
        raise SystemExit(
            "--seam needs an 'adjacency' (a seam between two walls) in the config.")
    if len(cfg.adjacency) > 1:
        raise SystemExit(
            "config has more than one seam; calibrate each wall with "
            "--wall <W> --pattern seam-half instead.")
    left, right = cfg.adjacency[0].left, cfg.adjacency[0].right

    labels = [
        f"{left}: TOP edge MIDPOINT (middle of the top edge)",
        f"{left}: BOTTOM edge MIDPOINT (middle of the bottom edge)",
        f"{right}: TOP edge MIDPOINT (middle of the top edge)",
        f"{right}: BOTTOM edge MIDPOINT (middle of the bottom edge)",
        "SEAM TOP corner (where the two walls meet, at the top)",
        "SEAM BOTTOM corner (where the two walls meet, at the bottom)",
    ]

    _ensure_dyld_path()
    from .framesource import make_frame_source

    kind = _depth_kind(config_dict, cam_id)
    source = make_frame_source(kind, cfg.cameras[cam_id].device)
    try:
        extrinsic = cfg.extrinsic(cam_id)
    except (KeyError, ValueError):
        extrinsic = Extrinsic.identity()

    intr = None
    try:
        first = source.read()
        if first is None:
            raise SystemExit(
                f"Could not read from camera {cam_id!r} (kind {kind!r}). "
                f"Check it is connected + powered and free (stop the live "
                f"server); for kinect_v2 also check bin/kinect-v2-bridge is "
                f"built and DYLD_LIBRARY_PATH includes ~/.local/lib "
                f"(see KINECT.md).")
        _, _, intr = first
        pts = capture_points(source, intr, extrinsic, labels,
                             f"Depth calibrate - seam {left}|{right}")
    finally:
        _close_quietly(source)

    if pts is None:
        return 1

    left_plane, right_plane = _seam_pair_planes(pts)
    updated = merge_wall_plane(config_dict, left, left_plane)
    updated = merge_wall_plane(updated, right, right_plane)
    if intr is not None:
        updated = merge_camera_pose(updated, cam_id, intr, extrinsic, kind=kind)
    RoomConfig.from_dict(updated)  # re-validate before persisting
    save_config_dict(args.config, updated)
    print(f"[gesturewall] wrote walls[{left!r}].plane + walls[{right!r}].plane "
          f"from 6 shared points -> {args.config}")
    return 0


def calibrate_wall_plane_depth(args) -> int:
    """Capture a wall's 3D plane from the Kinect depth and merge it into the config.

    The captured points are chosen by ``--pattern``: ``corners`` (the four wall
    corners) or ``seam-half`` (top/bottom edge midpoints + the two seam corners,
    for a camera too close to see the far corners). Either way the plane is fit
    with :func:`gesturewall.geometry.fit_wall_plane`.
    """
    config_dict = load_config_dict(args.config)
    cfg = RoomConfig.from_dict(config_dict)
    cam_id, wall_id = args.camera, args.wall
    targets = _targets_for(args.pattern, cfg, wall_id)

    _ensure_dyld_path()
    from .framesource import make_frame_source

    kind = _depth_kind(config_dict, cam_id)
    source = make_frame_source(kind, cfg.cameras[cam_id].device)
    try:
        extrinsic = cfg.extrinsic(cam_id)
    except (KeyError, ValueError):
        extrinsic = Extrinsic.identity()  # single camera defines the room frame

    intr = None
    try:
        first = source.read()
        if first is None:
            raise SystemExit(
                f"Could not read from camera {cam_id!r} (kind {kind!r}). "
                f"Check it is connected + powered and free (stop the live "
                f"server); for kinect_v2 also check bin/kinect-v2-bridge is "
                f"built and DYLD_LIBRARY_PATH includes ~/.local/lib "
                f"(see KINECT.md).")
        _, _, intr = first
        samples = capture_plane_points(source, intr, extrinsic, targets,
                                       f"Depth calibrate - wall {wall_id}")
    finally:
        _close_quietly(source)

    if samples is None:
        return 1

    plane = geometry.fit_wall_plane(samples)
    updated = merge_wall_plane(config_dict, wall_id, plane)
    if intr is not None:  # also store the sensor's REAL intrinsics + the pose used
        updated = merge_camera_pose(updated, cam_id, intr, extrinsic, kind=kind)
    RoomConfig.from_dict(updated)  # re-validate before persisting
    save_config_dict(args.config, updated)
    print(f"[gesturewall] wrote walls[{wall_id!r}].plane (+ cam pose) from "
          f"{len(samples)} points [{args.pattern}] -> {args.config}")
    return 0


def _embed_preview(cv2, canvas, preview, target_w=240, margin=8):
    """Blit a shrunk camera preview into the canvas's bottom-right corner."""
    ph, pw = preview.shape[:2]
    if ph == 0 or pw == 0:
        return
    H, W = canvas.shape[:2]
    max_w = max(1, min(target_w, W - 2 * margin))
    max_h = max(1, H - 2 * margin)
    scale = min(max_w / pw, max_h / ph)
    sw, sh = max(1, int(pw * scale)), max(1, int(ph * scale))
    y0, x0 = H - sh - margin, W - sw - margin
    if y0 < 0 or x0 < 0:
        return
    canvas[y0:y0 + sh, x0:x0 + sw] = cv2.resize(preview, (sw, sh))


# --------------------------------------------------------------------------- #
# CLI orchestration                                                            #
# --------------------------------------------------------------------------- #
def _open_source(cfg: RoomConfig, camera_id: str, args):
    """Open a :class:`MultiPoseSource` for ``camera_id`` using the config's device.

    Imported here so the (camera-free) pure helpers above stay importable.
    """
    from .multipose import MultiPoseSource

    cam = cfg.cameras[camera_id]
    return MultiPoseSource(
        camera=cam.device,
        video=args.video,
        num_poses=args.num_poses,
        mirror=cfg.server.mirror,
        min_confidence=cfg.server.min_confidence,
        model_path=cfg.server.model,
    )


def calibrate_wall(args) -> int:
    """Capture a (camera -> wall) homography and merge it into the config."""
    config_dict = load_config_dict(args.config)
    cfg = RoomConfig.from_dict(config_dict)  # validate before touching a camera

    if args.camera not in cfg.cameras:
        raise SystemExit(
            f"camera {args.camera!r} is not declared in {args.config}")
    if args.wall not in cfg.walls:
        raise SystemExit(f"wall {args.wall!r} is not declared in {args.config}")

    # A depth camera (Kinect v2, Gemini 335) calibrates a 3D wall PLANE from
    # its depth stream — not a 2D homography off a regular webcam.
    if cfg.cameras[args.camera].kind in DEPTH_KINDS:
        return calibrate_wall_plane_depth(args)

    source = _open_source(cfg, args.camera, args)
    try:
        corners = capture_corners(source, args.width, args.height,
                                  prompt=f"corner of wall {args.wall}")
    finally:
        _close_quietly(source)
    if corners is None:
        return 1

    matrix = corners4_to_matrix(corners)
    key = _calib_key(args.camera, args.wall)
    updated = merge_calibration(config_dict, key, matrix)
    RoomConfig.from_dict(updated)  # re-validate before persisting
    save_config_dict(args.config, updated)
    print(f"[gesturewall] wrote calibration[{key!r}] -> {args.config}")
    return 0


def calibrate_floor(args) -> int:
    """Capture a camera's room/floor homography and merge it into the config."""
    config_dict = load_config_dict(args.config)
    cfg = RoomConfig.from_dict(config_dict)

    if args.floor not in cfg.cameras:
        raise SystemExit(
            f"camera {args.floor!r} is not declared in {args.config}")

    source = _open_source(cfg, args.floor, args)
    try:
        corners = capture_corners(source, args.width, args.height,
                                  targets=FLOOR_CORNERS,
                                  names=FLOOR_CORNER_NAMES,
                                  prompt="floor reference point")
    finally:
        _close_quietly(source)
    if corners is None:
        return 1

    matrix = corners4_to_matrix(corners)
    updated = merge_room_homography(config_dict, args.floor, matrix)
    RoomConfig.from_dict(updated)  # re-validate before persisting
    save_config_dict(args.config, updated)
    print(f"[gesturewall] wrote cameras[{args.floor!r}].room_homography "
          f"-> {args.config}")
    return 0


def _close_quietly(source) -> None:
    try:
        source.close()
    except Exception:  # pragma: no cover - best-effort cleanup
        pass


# --------------------------------------------------------------------------- #
# Second-camera registration (depth): align a new camera to the room frame    #
# --------------------------------------------------------------------------- #
def _room_reference_points(cfg: RoomConfig):
    """Reference points with KNOWN room-frame positions, for registering a camera.

    Once the first camera's walls are calibrated, the wall planes give us
    distinctive 3D points whose ROOM coordinates are known: the two seam corners
    and each wall's far-top corner. A new camera clicks these same physical
    points; matching its observed (camera-frame) positions to these known room
    positions yields its CAMERA->ROOM extrinsic. Returns ``[(label, room_xyz)]``.
    """
    if not cfg.adjacency:
        raise SystemExit(
            "registration needs an 'adjacency' (a seam) so the reference points "
            "are defined; calibrate the walls first.")
    adj = cfg.adjacency[0]
    left = cfg.wall_plane(adj.left)
    right = cfg.wall_plane(adj.right)

    def corner(plane, u, v):
        return tuple(plane.origin[i] + u * plane.u_vec[i] + v * plane.v_vec[i]
                     for i in range(3))

    return [
        (f"SEAM TOP corner (where {adj.left} & {adj.right} meet, top)",
         corner(left, 1.0, 0.0)),
        (f"SEAM BOTTOM corner (where {adj.left} & {adj.right} meet, bottom)",
         corner(left, 1.0, 1.0)),
        (f"{adj.left}: FAR-TOP corner (its outer top corner)",
         corner(left, 0.0, 0.0)),
        (f"{adj.right}: FAR-TOP corner (its outer top corner)",
         corner(right, 1.0, 0.0)),
    ]


def calibrate_register_camera(args) -> int:
    """Register a second camera into the EXISTING room frame (depth mode).

    The first camera (cam0) defines the room frame and has calibrated wall
    planes. This opens the new camera, has the operator click the shared
    reference points (seam corners + far-top corners) in ITS view, then solves
    its CAMERA->ROOM extrinsic from the correspondence and writes it (plus its
    real intrinsics, and ``serves`` for both walls) into the config. No
    re-clicking the walls per camera — they share the same physical references,
    so the two cameras line up automatically.
    """
    config_dict = load_config_dict(args.config)
    cfg = RoomConfig.from_dict(config_dict)
    cam_id = args.register
    if cam_id not in cfg.cameras:
        raise SystemExit(f"camera {cam_id!r} is not declared in {args.config}; "
                         f"add it (device index/serial + a depth kind, e.g. "
                         f"kinect_v2 or gemini_335) first.")

    refs = _room_reference_points(cfg)
    labels = [lbl for (lbl, _p) in refs]
    room_pts = [p for (_lbl, p) in refs]

    _ensure_dyld_path()
    from .framesource import make_frame_source

    kind = _depth_kind(config_dict, cam_id)
    source = make_frame_source(kind, cfg.cameras[cam_id].device)
    intr = None
    try:
        first = source.read()
        if first is None:
            raise SystemExit(
                f"Could not read from camera {cam_id!r} (kind {kind!r}, device "
                f"{cfg.cameras[cam_id].device}). Check it's connected/powered on "
                f"its own USB-3 controller, and stop the live server first so the "
                f"device is free.")
        _, _, intr = first
        # Capture in the NEW camera's own frame (identity extrinsic during capture).
        cam_pts = capture_points(source, intr, Extrinsic.identity(), labels,
                                 f"Register {cam_id} - click the room reference points")
    finally:
        _close_quietly(source)
    if cam_pts is None:
        return 1

    extrinsic = extrinsic_from_correspondences(room_pts, cam_pts)  # cam -> room
    updated = merge_camera_pose(config_dict, cam_id, intr, extrinsic,
                                kind=kind)
    # Registered -> let it serve every wall of the seam (depth rays hit any plane).
    served = sorted({adj.left for adj in cfg.adjacency}
                    | {adj.right for adj in cfg.adjacency})
    updated["cameras"][cam_id]["serves"] = served or list(cfg.walls)
    RoomConfig.from_dict(updated)  # re-validate before persisting
    save_config_dict(args.config, updated)
    print(f"[gesturewall] registered {cam_id} into the room frame from "
          f"{len(cam_pts)} points; it now serves "
          f"{updated['cameras'][cam_id]['serves']} -> {args.config}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="gesturewall.calibrate",
        description="Capture and store homographies into a room config.")
    p.add_argument("--config", required=True,
                   help="room config JSON to read and write in place")
    p.add_argument("--camera", default=None,
                   help="camera id (e.g. cam0) to calibrate onto a wall")
    p.add_argument("--wall", default=None,
                   help="wall id (e.g. A) to calibrate the camera onto")
    p.add_argument("--floor", default=None, metavar="CAMERA",
                   help="camera id whose room/floor homography to capture")
    p.add_argument("--pattern", choices=["corners", "seam-half"], default="corners",
                   help="depth wall calibration points: 'corners' (4 wall corners) "
                        "or 'seam-half' (top/bottom edge midpoints + the 2 seam "
                        "corners, for a close camera that can't see the far corners)")
    p.add_argument("--seam", action="store_true",
                   help="calibrate BOTH walls of the seam at once from 6 SHARED "
                        "points (each wall's top+bottom edge midpoints + the 2 "
                        "shared seam corners); needs --camera + an adjacency")
    p.add_argument("--register", default=None, metavar="CAMERA",
                   help="register a SECOND camera into the existing room frame: "
                        "click the shared seam/far-top reference points in its "
                        "view to solve its extrinsic (walls must already be "
                        "calibrated by the first camera)")
    p.add_argument("--video", default=None,
                   help="video file instead of the live webcam (testing)")
    p.add_argument("--num-poses", dest="num_poses", type=int, default=4,
                   help="max bodies MediaPipe tracks per frame (default 4)")
    p.add_argument("--width", type=int, default=1280)
    p.add_argument("--height", type=int, default=720)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)

    if args.register is not None:
        if any(x is not None for x in (args.camera, args.wall, args.floor)) or args.seam:
            raise SystemExit("--register cannot be combined with "
                             "--camera/--wall/--floor/--seam")
        return calibrate_register_camera(args)

    if args.seam:
        if args.floor is not None or args.wall is not None:
            raise SystemExit("--seam cannot be combined with --floor/--wall")
        return calibrate_seam_pair(args)

    if args.floor is not None:
        if args.camera is not None or args.wall is not None:
            raise SystemExit(
                "--floor cannot be combined with --camera/--wall; "
                "calibrate the floor separately")
        return calibrate_floor(args)

    if args.camera is None or args.wall is None:
        raise SystemExit(
            "specify either --camera CAM --wall WALL (wall calibration) or "
            "--floor CAM (room/floor calibration)")
    return calibrate_wall(args)


if __name__ == "__main__":
    raise SystemExit(main())
