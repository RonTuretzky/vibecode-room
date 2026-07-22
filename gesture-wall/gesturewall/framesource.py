"""Depth frame-source factory: one seam where camera kinds become sources.

Every depth-mode construction site (the server's pose source, the calibration
CLI's capture flows, the aiming preview) dispatches through
:func:`make_frame_source` instead of naming a concrete class, so adding a new
depth camera kind lands in exactly ONE place: teach this factory the kind and
every tool that reads ``(color, depth_m, intr)`` frames picks it up.

Supported kinds (see :data:`gesturewall.room.DEPTH_KINDS`):

  * ``"kinect_v2"``               -> :class:`gesturewall.kinect.KinectV2Source`
                                     (libfreenect2 bridge subprocess).
  * ``"gemini_335"`` / ``"orbbec"`` -> :class:`gesturewall.orbbec.OrbbecSource`
                                     (Orbbec SDK, depth aligned to color).

Every returned source honours the same contract as ``KinectV2Source``: a light
constructor (no device access), idempotent ``start()``, ``read(timeout=None)``
returning ``(color_bgr uint8 HxWx3, depth_m float32 HxW, CameraIntrinsics)`` or
``None`` on timeout/end-of-stream, and an idempotent ``close()``.

``"rgb"`` is deliberately REJECTED here: plain webcams have no depth stream and
belong to the 2D homography path (:class:`gesturewall.multipose.MultiPoseSource`),
never to a depth frame source. Imports are lazy inside the function, so
importing this module never touches libfreenect2 or the Orbbec SDK.
"""

from __future__ import annotations


def make_frame_source(kind: str, device):
    """Build the depth frame source for a camera ``kind`` (lazy imports).

    ``device`` selects the physical camera: an ``int`` is an enumeration
    index, a ``str`` is a stable serial (the Kinect's 12-digit serial, or an
    Orbbec alphanumeric serial like ``"CP0E8530002Y"``). Construction is
    side-effect-free for every kind — the device is only opened on the
    source's first ``read()``/``start()``.

    Raises :class:`ValueError` for any non-depth ``kind`` (including
    ``"rgb"``), naming the offending kind.
    """
    if kind == "kinect_v2":
        from .kinect import KinectV2Source  # lazy: bridge spawns on start()

        return KinectV2Source(device_index=device)
    if kind in ("gemini_335", "orbbec"):
        from .orbbec import OrbbecSource  # lazy: SDK imports on start()

        # Device-default depth mode. Orbbec's "recommended" 1280x800 (plus the
        # Hand preset and frame sync) measurably WORSENED pointing on the live
        # rig when enabled together, so the experiment knobs live behind env
        # vars in gesturewall.orbbec — see GESTUREWALL_ORBBEC_* there.
        return OrbbecSource(device_index=device)
    raise ValueError(
        f"no depth frame source for camera kind {kind!r}: expected one of "
        f"'kinect_v2', 'gemini_335', 'orbbec' (kind 'rgb' is the 2D webcam "
        f"path and has no depth stream)")
