"""Live MJPEG preview of one depth camera — for aiming a camera by eye.

Streams a single camera's color frames to the browser so you can position/tilt
it until it sees what it needs (e.g. both projected walls in one view).
Addressed by SERIAL so it always grabs the physical camera you mean,
regardless of USB enumeration order. ``--kind`` picks the sensor (via
:func:`gesturewall.framesource.make_frame_source`): the default ``kinect_v2``,
or ``gemini_335``/``orbbec`` for an Orbbec Gemini 335.

Usage:
    .venv/bin/python -m gesturewall.preview --serial 072843433747 --port 8802
    .venv/bin/python -m gesturewall.preview --kind gemini_335 \\
        --serial CP0E8530002Y --port 8802
    # then open http://localhost:8802/

Notes:
  * Only ONE process can hold a given camera at a time — stop the gesture-wall
    server for that camera first (or drop it from the running config).
  * A faint centre crosshair + thirds grid help you level and centre the view.
"""
from __future__ import annotations

import argparse
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PAGE = b"""<!DOCTYPE html><html><head><meta charset=utf-8>
<title>Camera preview</title>
<style>html,body{margin:0;background:#111;color:#ccc;font-family:system-ui;
text-align:center}img{max-width:100vw;max-height:88vh;object-fit:contain}
p{margin:8px}</style></head><body>
<p><b>Aim the camera so BOTH projected walls are in view.</b>
Green tint is normal (projector light). This updates live.</p>
<img src="/mjpeg"></body></html>"""


class _Latest:
    def __init__(self):
        self._lock = threading.Lock()
        self._jpeg: bytes | None = None
        self.frames = 0

    def set(self, jpeg: bytes):
        with self._lock:
            self._jpeg = jpeg
            self.frames += 1

    def get(self) -> bytes | None:
        with self._lock:
            return self._jpeg


def _annotate(cv2, frame):
    """Draw a thirds grid + centre crosshair to help leveling (in place)."""
    h, w = frame.shape[:2]
    g = (60, 60, 60)
    for k in (1, 2):
        cv2.line(frame, (w * k // 3, 0), (w * k // 3, h), g, 1)
        cv2.line(frame, (0, h * k // 3), (w, h * k // 3), g, 1)
    cv2.drawMarker(frame, (w // 2, h // 2), (0, 220, 220),
                   cv2.MARKER_CROSS, 26, 1)
    return frame


def _grabber(kind: str, device: int | str, latest: _Latest,
             stop: threading.Event):
    import cv2

    from .framesource import make_frame_source
    src = make_frame_source(kind, device)
    try:
        while not stop.is_set():
            item = src.read(timeout=2.0)
            if item is None:
                continue
            color = item[0]
            if color is None:
                continue
            _annotate(cv2, color)
            ok, buf = cv2.imencode(".jpg", color,
                                   [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ok:
                latest.set(buf.tobytes())
    except Exception as e:  # noqa: BLE001 - fail LOUD, not as a dead thread
        # (e.g. Orbbec open needs 'sudo -E' on macOS). Without this, the page
        # would just stay blank while the traceback hides in a dead thread.
        print(f"[preview] camera failed: {e}", flush=True)
    finally:
        try:
            src.close()
        except Exception:  # noqa: BLE001
            pass


def _make_handler(latest: _Latest):
    class H(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path == "/mjpeg":
                self.send_response(200)
                self.send_header(
                    "Content-Type",
                    "multipart/x-mixed-replace; boundary=frame")
                self.end_headers()
                try:
                    while True:
                        jpeg = latest.get()
                        if jpeg is None:
                            time.sleep(0.05)
                            continue
                        self.wfile.write(b"--frame\r\n")
                        self.wfile.write(b"Content-Type: image/jpeg\r\n")
                        self.wfile.write(
                            f"Content-Length: {len(jpeg)}\r\n\r\n".encode())
                        self.wfile.write(jpeg)
                        self.wfile.write(b"\r\n")
                        time.sleep(1 / 20)
                except (BrokenPipeError, ConnectionResetError):
                    return
            else:
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(PAGE)))
                self.end_headers()
                self.wfile.write(PAGE)

        def log_message(self, *a):  # quiet
            pass

    H.timeout = 5
    return H


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--kind", choices=["kinect_v2", "gemini_335", "orbbec"],
                    default="kinect_v2",
                    help="depth camera kind (default kinect_v2)")
    ap.add_argument("--serial", required=True,
                    help="camera serial (or an index like 0)")
    ap.add_argument("--port", type=int, default=8802)
    args = ap.parse_args(argv)

    # A short all-digit --serial is an enumeration INDEX (real serials are
    # long: Kinect v2 serials are 12 digits, Orbbec serials alphanumeric);
    # OrbbecSource needs int indices, and KinectV2Source accepts either.
    device: int | str = (int(args.serial)
                         if args.serial.isdigit() and len(args.serial) <= 3
                         else args.serial)

    latest = _Latest()
    stop = threading.Event()
    threading.Thread(target=_grabber,
                     args=(args.kind, device, latest, stop),
                     daemon=True).start()
    httpd = ThreadingHTTPServer(("", args.port), _make_handler(latest))
    print(f"[preview] camera {args.serial} -> http://localhost:{args.port}/",
          flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
