"""Headless tests for the Kinect v2 frame source (gesturewall.kinect).

These drive the **pure** byte-level parser :func:`parse_frames` with hand-built
``K2IN`` + ``K2RG`` bytes — no Kinect, no libfreenect2, no subprocess. We never
spawn the bridge: ``KinectV2Source`` is only constructed to confirm that doing so
does NOT start a process. ``FakeFrameSource`` is exercised on its own as the
test double the rest of the depth pipeline consumes.

Wire protocol under test (all little-endian)::

    K2IN  magic "K2IN" | fx,fy,cx,cy float32 | width,height uint32
    K2RG  magic "K2RG" | timestamp,width,height uint32
          | width*height*3 uint8 BGR color | width*height float32 depth (mm)

The source converts native millimetre depth to **metres** (mm/1000).
"""

from __future__ import annotations

import struct

import numpy as np
import pytest

from gesturewall.geometry import CameraIntrinsics
from gesturewall.kinect import (
    FakeFrameSource,
    KinectV2Source,
    MAGIC_FRAME,
    MAGIC_INTRINSICS,
    parse_frames,
)

# A small frame size keeps hand-built byte payloads tiny while exercising the
# exact same layout the 512x424 bridge uses.
W, H = 4, 3
FX, FY, CX, CY = 365.0, 365.0, 256.0, 212.0


# --------------------------------------------------------------------------- #
# byte builders (mirror native/kinect_v2_bridge.cc exactly)                   #
# --------------------------------------------------------------------------- #
def make_intrinsics_bytes(fx=FX, fy=FY, cx=CX, cy=CY, width=W, height=H) -> bytes:
    return MAGIC_INTRINSICS + struct.pack(
        "<ffffII", fx, fy, cx, cy, width, height)


def make_frame_bytes(timestamp: int, color: np.ndarray,
                     depth_mm: np.ndarray) -> bytes:
    """Pack one K2RG frame from an (H,W,3) uint8 color + (H,W) float32 depth."""
    height, width, _ = color.shape
    header = MAGIC_FRAME + struct.pack("<III", timestamp, width, height)
    color_bytes = np.ascontiguousarray(color, dtype=np.uint8).tobytes()
    depth_bytes = np.ascontiguousarray(depth_mm, dtype="<f4").tobytes()
    return header + color_bytes + depth_bytes


def sample_color(seed: int = 0) -> np.ndarray:
    base = np.arange(H * W * 3, dtype=np.int64).reshape(H, W, 3)
    return ((base + seed) % 256).astype(np.uint8)


def sample_depth_mm(seed: float = 0.0) -> np.ndarray:
    # Distinct, finite millimetre values; include a 0 (invalid) to be realistic.
    d = (np.arange(H * W, dtype=np.float32).reshape(H, W) * 100.0) + 1000.0
    d[0, 0] = 0.0
    return (d + seed).astype("<f4")


# --------------------------------------------------------------------------- #
# parse_frames: intrinsics                                                    #
# --------------------------------------------------------------------------- #
def test_parse_intrinsics_only():
    frames, left = parse_frames(make_intrinsics_bytes())
    assert left == b""
    assert len(frames) == 1
    rec = frames[0]
    assert rec["type"] == "intrinsics"
    intr = rec["intrinsics"]
    assert isinstance(intr, CameraIntrinsics)
    assert intr.fx == pytest.approx(FX)
    assert intr.fy == pytest.approx(FY)
    assert intr.cx == pytest.approx(CX)
    assert intr.cy == pytest.approx(CY)
    assert intr.width == W
    assert intr.height == H
    # width/height come back as plain ints, not numpy/float.
    assert isinstance(intr.width, int)
    assert isinstance(intr.height, int)


# --------------------------------------------------------------------------- #
# parse_frames: a full K2IN + K2RG stream                                     #
# --------------------------------------------------------------------------- #
def test_parse_intrinsics_then_frame():
    color = sample_color()
    depth_mm = sample_depth_mm()
    stream = make_intrinsics_bytes() + make_frame_bytes(7, color, depth_mm)

    frames, left = parse_frames(stream)
    assert left == b""
    assert [f["type"] for f in frames] == ["intrinsics", "frame"]

    frame = frames[1]
    assert frame["timestamp"] == 7

    # Color: right shape, dtype, BGR bytes round-trip unchanged.
    assert frame["color"].shape == (H, W, 3)
    assert frame["color"].dtype == np.uint8
    np.testing.assert_array_equal(frame["color"], color)

    # Depth: right shape, float32, and converted mm -> metres (mm / 1000).
    assert frame["depth_m"].shape == (H, W)
    assert frame["depth_m"].dtype == np.float32
    np.testing.assert_allclose(frame["depth_m"], depth_mm / 1000.0, rtol=1e-6)
    # The invalid 0-mm pixel stays 0 metres (not converted to anything spurious).
    assert frame["depth_m"][0, 0] == 0.0


def test_parse_multiple_frames():
    stream = make_intrinsics_bytes()
    for ts in (1, 2, 3):
        stream += make_frame_bytes(ts, sample_color(ts), sample_depth_mm(ts))

    frames, left = parse_frames(stream)
    assert left == b""
    frame_recs = [f for f in frames if f["type"] == "frame"]
    assert [f["timestamp"] for f in frame_recs] == [1, 2, 3]


# --------------------------------------------------------------------------- #
# parse_frames: incomplete records are carried over as `left`                 #
# --------------------------------------------------------------------------- #
def test_partial_intrinsics_is_left():
    full = make_intrinsics_bytes()
    frames, left = parse_frames(full[:-3])  # truncated mid-intrinsics
    assert frames == []
    assert left == full[:-3]


def test_partial_frame_header_is_left():
    color = sample_color()
    depth_mm = sample_depth_mm()
    frame = make_frame_bytes(9, color, depth_mm)
    # Cut inside the K2RG header (after magic, before all 3 uint32 are present).
    cut = make_intrinsics_bytes() + frame[:6]
    frames, left = parse_frames(cut)
    assert [f["type"] for f in frames] == ["intrinsics"]
    assert left == frame[:6]


def test_partial_frame_payload_is_left():
    color = sample_color()
    depth_mm = sample_depth_mm()
    frame = make_frame_bytes(9, color, depth_mm)
    # Keep the full header but chop the color/depth payload in half.
    cut_len = 4 + 12 + (color.size // 2)
    chunk = frame[:cut_len]
    frames, left = parse_frames(chunk)
    assert frames == []
    assert left == chunk


def test_streaming_resumes_with_carried_left():
    """Split a full stream at an arbitrary byte; feeding both halves works."""
    color = sample_color()
    depth_mm = sample_depth_mm()
    stream = make_intrinsics_bytes() + make_frame_bytes(42, color, depth_mm)

    split = len(stream) // 2
    frames1, left1 = parse_frames(stream[:split])
    frames2, left2 = parse_frames(left1 + stream[split:])

    assert left2 == b""
    all_frames = frames1 + frames2
    types = [f["type"] for f in all_frames]
    assert types == ["intrinsics", "frame"]
    frame = all_frames[1]
    assert frame["timestamp"] == 42
    np.testing.assert_array_equal(frame["color"], color)
    np.testing.assert_allclose(frame["depth_m"], depth_mm / 1000.0, rtol=1e-6)


def test_byte_by_byte_streaming():
    """Feeding the stream one byte at a time still yields exactly one frame."""
    color = sample_color(5)
    depth_mm = sample_depth_mm(5)
    stream = make_intrinsics_bytes() + make_frame_bytes(11, color, depth_mm)

    buf = b""
    out: list[dict] = []
    for b in stream:
        buf += bytes([b])
        recs, buf = parse_frames(buf)
        out.extend(recs)

    assert buf == b""
    assert [r["type"] for r in out] == ["intrinsics", "frame"]
    np.testing.assert_array_equal(out[1]["color"], color)


# --------------------------------------------------------------------------- #
# parse_frames: resynchronisation on garbage / desync                         #
# --------------------------------------------------------------------------- #
def test_resync_skips_leading_garbage():
    color = sample_color()
    depth_mm = sample_depth_mm()
    good = make_intrinsics_bytes() + make_frame_bytes(3, color, depth_mm)
    stream = b"\x00\x01junkbytes" + good

    frames, left = parse_frames(stream)
    assert left == b""
    assert [f["type"] for f in frames] == ["intrinsics", "frame"]
    assert frames[1]["timestamp"] == 3


def test_trailing_garbage_without_magic_is_dropped():
    color = sample_color()
    depth_mm = sample_depth_mm()
    good = make_intrinsics_bytes() + make_frame_bytes(3, color, depth_mm)
    # Trailing bytes that contain no further magic are discarded (no infinite
    # loop, nothing carried that can never complete).
    stream = good + b"\xaa\xbb\xcc\xdd\xee"
    frames, left = parse_frames(stream)
    assert [f["type"] for f in frames] == ["intrinsics", "frame"]
    assert left == b""


def test_empty_buffer():
    frames, left = parse_frames(b"")
    assert frames == []
    assert left == b""


# --------------------------------------------------------------------------- #
# FakeFrameSource                                                             #
# --------------------------------------------------------------------------- #
def test_fake_frame_source_yields_then_stops():
    intr = CameraIntrinsics(fx=FX, fy=FY, cx=CX, cy=CY, width=W, height=H)
    color = sample_color()
    depth_m = (sample_depth_mm() / 1000.0).astype(np.float32)
    src = FakeFrameSource([(color, depth_m, intr)])

    item = src.read()
    assert item is not None
    c, d, i = item
    np.testing.assert_array_equal(c, color)
    np.testing.assert_array_equal(d, depth_m)
    assert i is intr
    # Exhausted -> None (end of stream), repeatedly.
    assert src.read() is None
    assert src.read() is None
    src.close()  # close is a no-op and must not raise


# --------------------------------------------------------------------------- #
# KinectV2Source: laziness — construction must NOT spawn the bridge            #
# --------------------------------------------------------------------------- #
def test_kinectv2source_construction_does_not_spawn():
    # Point at a bogus binary; since construction must not start a process, an
    # invalid path is harmless until start()/read() is called.
    src = KinectV2Source(bridge_path="/nonexistent/kinect-v2-bridge")
    assert src._proc is None
    assert src.intrinsics is None
    # Internal byte-decode helper threads frames through the pure parser.
    src._ingest(make_intrinsics_bytes())
    assert isinstance(src.intrinsics, CameraIntrinsics)
    src.close()  # no process was started; close must be safe
