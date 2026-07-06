"""Main application: render loop, drawing, calibration and CLI wiring.

Pipeline each frame:
    source.read() -> raw pointer -> homography (calibration) -> 1-Euro smoothing
    -> DwellSelector -> zone toggle, with on-screen cursor + dwell progress ring.

Run `python run.py --help` for options. Defaults to the camera-free mouse mode
so it works anywhere; pass `--source pose` for the real webcam + MediaPipe path.
"""

from __future__ import annotations

import argparse
import time

from .calibration import CORNER_NAMES, WALL_CORNERS, Homography
from .dwell import DwellSelector
from .filters import Point2DFilter
from .sources import MouseSource, PointerSource, PoseSource
from .zones import Zone, build_grid

WINDOW = "Gesture Wall"

# BGR colors
BG = (24, 24, 28)
ZONE_IDLE = (90, 90, 96)
ZONE_SELECTED = (70, 170, 70)
ZONE_ACTIVE = (60, 200, 220)
TEXT = (235, 235, 235)
CURSOR = (60, 200, 220)
RING_BG = (70, 70, 76)
RING_FG = (60, 220, 240)


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #
def _draw(canvas, zones, cursor, engaged, selector, fps, mode, preview=None):
    import cv2

    h, w = canvas.shape[:2]
    canvas[:] = BG

    for z in zones:
        x1, y1 = int(z.x * w), int(z.y * h)
        x2, y2 = int((z.x + z.w) * w), int((z.y + z.h) * h)
        is_active = selector.active_zone is z
        if z.selected:
            cv2.rectangle(canvas, (x1, y1), (x2, y2), ZONE_SELECTED, cv2.FILLED)
        border = ZONE_ACTIVE if is_active else (
            ZONE_SELECTED if z.selected else ZONE_IDLE)
        cv2.rectangle(canvas, (x1, y1), (x2, y2), border,
                      4 if is_active else 2)
        # Centered label.
        font, scale, thick = cv2.FONT_HERSHEY_SIMPLEX, 1.0, 2
        (tw, th), _ = cv2.getTextSize(z.label, font, scale, thick)
        cv2.putText(canvas, z.label,
                    (int((x1 + x2) / 2 - tw / 2), int((y1 + y2) / 2 + th / 2)),
                    font, scale, TEXT, thick, cv2.LINE_AA)

    if engaged and cursor is not None:
        cx, cy = int(cursor[0] * w), int(cursor[1] * h)
        _draw_cursor(cv2, canvas, cx, cy, selector.progress)

    # HUD
    status = "ENGAGED" if engaged else "idle (raise hand / move mouse in)"
    cv2.putText(canvas, f"{mode} | {status} | {fps:4.1f} fps",
                (16, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, TEXT, 2, cv2.LINE_AA)
    cv2.putText(canvas, "q quit   r reset   c calibrate (pose)",
                (16, h - 16), cv2.FONT_HERSHEY_SIMPLEX, 0.6, TEXT, 1, cv2.LINE_AA)

    if preview is not None:
        _embed_preview(cv2, canvas, preview)
    return canvas


def _draw_cursor(cv2, canvas, cx, cy, progress):
    radius = 26
    cv2.circle(canvas, (cx, cy), radius, RING_BG, 3, cv2.LINE_AA)
    if progress > 0:
        cv2.ellipse(canvas, (cx, cy), (radius, radius), -90, 0,
                    int(360 * progress), RING_FG, 5, cv2.LINE_AA)
    cv2.circle(canvas, (cx, cy), 5, CURSOR, cv2.FILLED, cv2.LINE_AA)


def _embed_preview(cv2, canvas, preview, target_w=240, margin=8):
    ph, pw = preview.shape[:2]
    if ph == 0 or pw == 0:
        return
    H, W = canvas.shape[:2]
    # Fit within the target width AND the available canvas area, so a tall
    # (portrait) frame or a small window can never produce a negative slice.
    max_w = max(1, min(target_w, W - 2 * margin))
    max_h = max(1, H - 2 * margin)
    scale = min(max_w / pw, max_h / ph)
    sw, sh = max(1, int(pw * scale)), max(1, int(ph * scale))
    y0, x0 = H - sh - margin, W - sw - margin
    if y0 < 0 or x0 < 0:
        return
    canvas[y0:y0 + sh, x0:x0 + sw] = cv2.resize(preview, (sw, sh))


# --------------------------------------------------------------------------- #
# Pose calibration ("point at each corner")
# --------------------------------------------------------------------------- #
def _quad_area(points: list[tuple[float, float]]) -> float:
    """Shoelace area of a polygon; ~0 means the points are collinear/coincident."""
    area = 0.0
    n = len(points)
    for i in range(n):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % n]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2.0


def calibrate_pose(source: PoseSource, width: int, height: int,
                   save_path: str, min_area: float = 0.05) -> Homography | None:
    import cv2
    import numpy as np

    captured: list[tuple[float, float]] = []
    canvas = np.zeros((height, width, 3), dtype=np.uint8)

    for i, (corner, name) in enumerate(zip(WALL_CORNERS, CORNER_NAMES)):
        while True:
            frame, pointer, engaged, _ = source.read()
            ready = pointer is not None and engaged
            canvas[:] = BG
            tx, ty = int(corner[0] * width), int(corner[1] * height)
            cv2.circle(canvas, (tx, ty), 22, RING_FG, 3, cv2.LINE_AA)
            cv2.circle(canvas, (tx, ty), 6, RING_FG, cv2.FILLED, cv2.LINE_AA)
            cv2.putText(canvas, f"Point at the {name} corner, then press SPACE "
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

    if _quad_area(captured) < min_area:
        print("[gesturewall] calibration points are too close together / "
              "collinear; keeping the previous calibration. Re-run and move "
              "your hand clearly to each corner.")
        return None

    homography = Homography.from_corner_points(captured)
    homography.save(save_path)
    print(f"[gesturewall] calibration saved -> {save_path}")
    return homography


# --------------------------------------------------------------------------- #
# Run loop
# --------------------------------------------------------------------------- #
def _build_source(args) -> PointerSource:
    if args.source == "mouse":
        return MouseSource()
    return PoseSource(camera=args.camera, video=args.video,
                      model_path=args.model, mirror=not args.no_mirror,
                      min_confidence=args.min_confidence)


def run(args) -> None:
    import cv2
    import numpy as np

    zones = build_grid(args.rows, args.cols, padding=args.padding,
                       labels=args.labels.split(",") if args.labels else None)
    selector = DwellSelector(dwell_seconds=args.dwell,
                             cooldown_seconds=args.cooldown,
                             hysteresis=args.hysteresis)
    pfilter = (None if args.no_filter else
               Point2DFilter(mincutoff=args.min_cutoff, beta=args.beta))

    source = _build_source(args)
    is_mouse = isinstance(source, MouseSource)

    # Load calibration for the pose path if present.
    homography = Homography.identity()
    if not is_mouse:
        try:
            homography = Homography.load(args.calibration)
            print(f"[gesturewall] loaded calibration from {args.calibration}")
        except (OSError, ValueError):
            print("[gesturewall] no calibration found; using identity. "
                  "Press 'c' to calibrate.")

    flags = cv2.WINDOW_AUTOSIZE if is_mouse else cv2.WINDOW_NORMAL
    cv2.namedWindow(WINDOW, flags)
    if not is_mouse and args.fullscreen:
        cv2.setWindowProperty(WINDOW, cv2.WND_PROP_FULLSCREEN,
                              cv2.WINDOW_FULLSCREEN)

    if is_mouse:
        def _on_mouse(event, mx, my, flags_, _param):
            if event == cv2.EVENT_MOUSEMOVE:
                source.set_pointer(mx / max(1, args.width - 1),
                                   my / max(1, args.height - 1), engaged=True)
        cv2.setMouseCallback(WINDOW, _on_mouse)

    # Run a calibration pass first if requested.
    if args.calibrate and not is_mouse:
        result = calibrate_pose(source, args.width, args.height, args.calibration)
        if result is not None:
            homography = result

    canvas = np.zeros((args.height, args.width, 3), dtype=np.uint8)
    fps, prev = 0.0, time.perf_counter()
    mode = "MOUSE TEST" if is_mouse else "POSE"

    try:
        while True:
            t = time.perf_counter()
            frame, pointer, engaged, _info = source.read()

            cursor = None
            if pointer is not None:
                wx, wy = homography.apply(pointer[0], pointer[1])
                if pfilter is not None:
                    wx, wy = pfilter(wx, wy, t)
                cursor = (min(1.0, max(0.0, wx)), min(1.0, max(0.0, wy)))

            event = selector.update(zones, cursor, t, engaged=engaged)
            if event is not None:
                print(f"[gesturewall] {'SELECT' if event.selected else 'DESELECT'}"
                      f" zone {event.zone_id}")

            preview = frame if (frame is not None and not args.no_preview) else None
            _draw(canvas, zones, cursor, engaged, selector, fps, mode, preview)
            cv2.imshow(WINDOW, canvas)

            key = cv2.waitKey(1) & 0xFF
            if key in (27, ord("q")):
                break
            if key == ord("r"):
                for z in zones:
                    z.selected = False
                selector.reset()
            if key == ord("c") and not is_mouse:
                result = calibrate_pose(source, args.width, args.height,
                                        args.calibration)
                if result is not None:
                    homography = result

            dt = t - prev
            prev = t
            if dt > 0:
                fps = 0.9 * fps + 0.1 * (1.0 / dt)
    finally:
        source.close()
        cv2.destroyAllWindows()


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="gesturewall",
        description="Coarse mid-air select/deselect on a projected wall.")
    p.add_argument("--source", choices=["mouse", "pose"], default="mouse",
                   help="input source (default: mouse, camera-free test mode)")
    p.add_argument("--camera", type=int, default=0, help="webcam index (pose)")
    p.add_argument("--video", default=None, help="video file instead of webcam")
    p.add_argument("--model", default="models/pose_landmarker_lite.task",
                   help="path to the PoseLandmarker .task model (auto-downloaded)")
    p.add_argument("--rows", type=int, default=2)
    p.add_argument("--cols", type=int, default=3)
    p.add_argument("--labels", default=None,
                   help="comma-separated zone labels, e.g. 'A,B,C,D,E,F'")
    p.add_argument("--padding", type=float, default=0.06,
                   help="gap between tiles, fraction of a cell (default 0.06)")
    p.add_argument("--width", type=int, default=1280)
    p.add_argument("--height", type=int, default=720)
    p.add_argument("--dwell", type=float, default=0.8,
                   help="dwell time to select, seconds (default 0.8)")
    p.add_argument("--cooldown", type=float, default=0.4,
                   help="cooldown after a selection, seconds (default 0.4)")
    p.add_argument("--hysteresis", type=float, default=0.15,
                   help="edge stickiness, fraction of zone size (default 0.15)")
    p.add_argument("--min-cutoff", dest="min_cutoff", type=float, default=1.0,
                   help="1-Euro filter min cutoff Hz (lower = smoother)")
    p.add_argument("--beta", type=float, default=0.007,
                   help="1-Euro filter speed coefficient (higher = less lag)")
    p.add_argument("--no-filter", action="store_true",
                   help="disable cursor smoothing")
    p.add_argument("--no-mirror", action="store_true",
                   help="do not mirror the camera image (pose)")
    p.add_argument("--no-preview", action="store_true",
                   help="hide the camera preview thumbnail (pose)")
    p.add_argument("--min-confidence", dest="min_confidence", type=float,
                   default=0.5, help="MediaPipe detection/tracking confidence")
    p.add_argument("--calibration", default="calibration.json",
                   help="calibration file to load/save (pose)")
    p.add_argument("--calibrate", action="store_true",
                   help="run corner calibration on startup (pose)")
    p.add_argument("--fullscreen", action="store_true",
                   help="fullscreen window (pose)")
    return p


def main(argv=None) -> None:
    args = build_parser().parse_args(argv)
    run(args)


if __name__ == "__main__":
    main()
