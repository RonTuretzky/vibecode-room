"""Kinect v2 frame source: spawn the native bridge and parse its binary stream.

On macOS the Kinect v2 has no skeleton SDK, so we run a tiny libfreenect2 C++
bridge (``native/kinect_v2_bridge.cc``, built to ``bin/kinect-v2-bridge``) that
uses ``Registration::apply`` to produce a **pixel-aligned** 512x424 registered
color image and undistorted depth map, then emits them on **stdout** as a small
binary protocol. This module spawns that bridge as a subprocess, parses the
protocol into frames, and hands ``(color, depth_m, intr)`` tuples to
:class:`gesturewall.depth.KinectPoseSource`.

Wire protocol (all multi-byte integers/floats little-endian)::

    K2IN  (intrinsics control frame, emitted once at start)
      magic   4 bytes  ASCII "K2IN"
      fx      float32   IR/registered-camera focal x      (from getIrCameraParams)
      fy      float32   IR/registered-camera focal y
      cx      float32   principal point x
      cy      float32   principal point y
      width   uint32    512
      height  uint32    424

    K2RG  (per registered frame)
      magic     4 bytes  ASCII "K2RG"
      timestamp uint32
      width     uint32   512
      height    uint32   424
      color     width*height*3 bytes  uint8 BGR registered color
      depth     width*height          float32 depth in MILLIMETRES (native)

:class:`KinectV2Source` converts the native millimetre depth to **metres**
(``mm / 1000``) so everything downstream of it speaks metres, matching the math
conventions in :mod:`gesturewall.geometry`.

Laziness: ``numpy`` is fine at module top (always available). The subprocess is
only spawned in :meth:`KinectV2Source.start`; importing this module never needs
a camera, libfreenect2, or the bridge binary. The byte-level parser
:func:`parse_frames` is a **pure** function so it is unit-testable with
hand-built bytes (see ``tests/test_kinect.py``) without spawning anything.
"""

from __future__ import annotations

import os
import struct
import subprocess
from pathlib import Path

import numpy as np

from .geometry import CameraIntrinsics

# Magic tags (4 ASCII bytes each).
MAGIC_INTRINSICS = b"K2IN"
MAGIC_FRAME = b"K2RG"

# K2IN body: 4 float32 (fx, fy, cx, cy) + 2 uint32 (width, height).
_INTRINSICS_STRUCT = struct.Struct("<ffffII")
# K2RG header (after the magic): 3 uint32 (timestamp, width, height).
_FRAME_HEADER_STRUCT = struct.Struct("<III")

# Default path to the compiled bridge, relative to the repo root (this file lives
# in ``<root>/gesturewall/kinect.py``, so the binary is ``<root>/bin/...``).
DEFAULT_BRIDGE_PATH = str(Path(__file__).resolve().parent.parent
                          / "bin" / "kinect-v2-bridge")


def parse_frames(buffer: bytes):
    """Parse as many whole records as possible from ``buffer`` (PURE).

    Walks the byte stream record-by-record, decoding ``K2IN`` intrinsics frames
    and ``K2RG`` color+depth frames. Returns ``(frames, left)`` where ``frames``
    is a list of parsed records in stream order and ``left`` is the trailing
    bytes that did not yet form a complete record (carry these forward and
    prepend the next chunk). Each parsed record is a dict:

      * intrinsics: ``{"type": "intrinsics", "intrinsics": CameraIntrinsics}``
      * frame: ``{"type": "frame", "timestamp": int,
                  "color": uint8 ndarray (H, W, 3) BGR,
                  "depth_m": float32 ndarray (H, W) metres}``

    The depth is converted from the native **millimetres** to **metres**
    (``mm / 1000``) here, so callers receive metres directly.

    Unrecognised leading bytes (e.g. a stream that started mid-record, or a
    desync) are skipped by resynchronising to the next known magic tag; if no
    magic remains, everything is treated as ``left`` so a future chunk can
    complete it. This function imports nothing heavy and never touches a camera.
    """
    frames: list[dict] = []
    mv = memoryview(buffer)
    pos = 0
    n = len(mv)

    while True:
        # Need at least a 4-byte magic to decide what comes next.
        if n - pos < 4:
            break
        magic = bytes(mv[pos:pos + 4])

        if magic == MAGIC_INTRINSICS:
            end = pos + 4 + _INTRINSICS_STRUCT.size
            if end > n:
                break  # incomplete; wait for more bytes
            fx, fy, cx, cy, width, height = _INTRINSICS_STRUCT.unpack(
                mv[pos + 4:end])
            frames.append({
                "type": "intrinsics",
                "intrinsics": CameraIntrinsics(
                    fx=float(fx), fy=float(fy), cx=float(cx), cy=float(cy),
                    width=int(width), height=int(height)),
            })
            pos = end
            continue

        if magic == MAGIC_FRAME:
            header_end = pos + 4 + _FRAME_HEADER_STRUCT.size
            if header_end > n:
                break  # incomplete header; wait for more bytes
            timestamp, width, height = _FRAME_HEADER_STRUCT.unpack(
                mv[pos + 4:header_end])
            color_bytes = width * height * 3
            depth_bytes = width * height * 4  # float32
            body_end = header_end + color_bytes + depth_bytes
            if body_end > n:
                break  # incomplete payload; wait for more bytes

            color_start = header_end
            color_stop = color_start + color_bytes
            color = np.frombuffer(
                mv[color_start:color_stop], dtype=np.uint8
            ).reshape(height, width, 3).copy()

            depth_stop = color_stop + depth_bytes
            depth_mm = np.frombuffer(
                mv[color_stop:depth_stop], dtype="<f4"
            ).reshape(height, width)
            depth_m = (depth_mm.astype(np.float32) / 1000.0)

            frames.append({
                "type": "frame",
                "timestamp": int(timestamp),
                "color": color,
                "depth_m": depth_m,
            })
            pos = body_end
            continue

        # Unknown bytes at `pos`: resynchronise to the next known magic tag.
        nxt_in = buffer.find(MAGIC_INTRINSICS, pos + 1)
        nxt_rg = buffer.find(MAGIC_FRAME, pos + 1)
        candidates = [c for c in (nxt_in, nxt_rg) if c != -1]
        if not candidates:
            # No further magic; drop the unknown lead, keep nothing to retry.
            pos = n
            break
        pos = min(candidates)

    left = bytes(mv[pos:])
    return frames, left


class FakeFrameSource:
    """A scripted ``(color, depth_m, intr)`` source for tests (no subprocess).

    Yields the scripted tuples in order via :meth:`read`; once exhausted it
    returns ``None`` (end of stream), mirroring how :class:`KinectV2Source`
    signals that the bridge has stopped producing frames. This lets the depth
    pipeline be exercised end-to-end without libfreenect2 or hardware.
    """

    def __init__(self, frames):
        self._frames = list(frames)
        self._i = 0

    def read(self):
        if self._i >= len(self._frames):
            return None
        item = self._frames[self._i]
        self._i += 1
        return item

    def close(self) -> None:
        pass


class KinectV2Source:
    """Live Kinect v2 frames via the native bridge subprocess.

    Spawns ``bin/kinect-v2-bridge`` (a libfreenect2 process) and parses its
    ``K2IN`` + ``K2RG`` binary stream into frames. :meth:`read` returns
    ``(color, depth_m, intr)`` — a ``uint8`` 512x424x3 BGR image, a ``float32``
    512x424 depth map in **metres** (mm/1000), and the camera's
    :class:`~gesturewall.geometry.CameraIntrinsics` — or ``None`` once the bridge
    has stopped. :meth:`close` terminates the subprocess.

    Laziness: nothing heavy is imported at module top and the subprocess is only
    started in :meth:`start` (called lazily on the first :meth:`read`). The
    byte-level decoding is delegated to the pure :func:`parse_frames`.
    """

    def __init__(self, bridge_path: str = DEFAULT_BRIDGE_PATH,
                 device_index: int = 0, read_chunk: int = 1 << 16):
        self._bridge_path = bridge_path
        self._device_index = device_index
        self._read_chunk = read_chunk
        self._proc: subprocess.Popen | None = None
        self._buffer = b""
        self._intrinsics: CameraIntrinsics | None = None
        self._pending: list[dict] = []  # decoded but not-yet-returned frames

    def start(self) -> None:
        """Spawn the bridge subprocess (idempotent).

        Passes an env with ``~/.local/lib`` on ``DYLD_LIBRARY_PATH`` so the
        bridge finds the libfreenect2 dylib even if the caller's shell didn't
        export it (e.g. a server launched outside an interactive zsh).
        """
        if self._proc is not None:
            return
        env = dict(os.environ)
        local_lib = str(Path.home() / ".local" / "lib")
        dyld = env.get("DYLD_LIBRARY_PATH", "")
        if local_lib not in dyld.split(":"):
            env["DYLD_LIBRARY_PATH"] = f"{local_lib}:{dyld}" if dyld else local_lib
        self._proc = subprocess.Popen(
            [self._bridge_path, str(self._device_index)],
            stdout=subprocess.PIPE,
            stderr=None,  # let the bridge's logs flow to our stderr
            bufsize=0,
            env=env,
        )

    @property
    def intrinsics(self) -> CameraIntrinsics | None:
        """The intrinsics from the latest ``K2IN`` frame, or ``None`` yet."""
        return self._intrinsics

    def _ingest(self, chunk: bytes) -> None:
        """Append raw bytes, decode whole records, and queue frame records."""
        self._buffer += chunk
        records, self._buffer = parse_frames(self._buffer)
        for rec in records:
            if rec["type"] == "intrinsics":
                self._intrinsics = rec["intrinsics"]
            else:  # "frame"
                self._pending.append(rec)

    def read(self, timeout: float | None = None):
        """Return the next ``(color, depth_m, intr)`` tuple, or ``None``.

        Blocks reading bridge stdout until a full color+depth frame (and the
        intrinsics it needs) is available, or until the bridge closes its
        stdout / exits — in which case ``None`` is returned. With ``timeout``
        (seconds), also returns ``None`` if no complete frame arrives in time —
        a live-but-stalled bridge (USB hiccup) then can't hang the caller.
        """
        import select
        import time as _time

        if self._proc is None:
            self.start()
        assert self._proc is not None and self._proc.stdout is not None

        deadline = None if timeout is None else _time.monotonic() + timeout
        while True:
            # Serve a buffered frame as soon as we also know the intrinsics.
            if self._pending and self._intrinsics is not None:
                rec = self._pending.pop(0)
                return rec["color"], rec["depth_m"], self._intrinsics

            if deadline is not None:
                remaining = deadline - _time.monotonic()
                if remaining <= 0:
                    return None
                ready, _, _ = select.select([self._proc.stdout], [], [],
                                            remaining)
                if not ready:
                    return None
            chunk = self._proc.stdout.read(self._read_chunk)
            if not chunk:  # bridge closed stdout / exited
                return None
            self._ingest(chunk)

    def close(self) -> None:
        """Terminate the bridge subprocess and release its pipe."""
        proc = self._proc
        self._proc = None
        if proc is None:
            return
        try:
            proc.terminate()
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:  # pragma: no cover - rare
                proc.kill()
                proc.wait(timeout=2.0)
        finally:
            if proc.stdout is not None:
                try:
                    proc.stdout.close()
                except Exception:  # pragma: no cover - best effort
                    pass
