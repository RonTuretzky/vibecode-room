"""Headless tests for the depth frame-source factory (gesturewall.framesource).

:func:`make_frame_source` is the ONE seam every depth-mode construction site
(server, calibrate CLI, preview) dispatches through, so these tests pin its
contract: ``"kinect_v2"`` -> :class:`KinectV2Source` (device_index forwarded),
``"gemini_335"``/``"orbbec"`` -> :class:`OrbbecSource`, and anything else —
including the 2D ``"rgb"`` webcam kind — a :class:`ValueError` naming the
kind. Constructors are light by contract (no subprocess spawn, no SDK import
before the first ``read()``/``start()``), so constructing here needs no
hardware, no libfreenect2 and no Orbbec SDK.
"""

from __future__ import annotations

import sys

import pytest

from gesturewall.framesource import make_frame_source


# --------------------------------------------------------------------------- #
# kinect_v2 -> KinectV2Source                                                  #
# --------------------------------------------------------------------------- #
def test_kinect_v2_returns_kinect_source_with_serial_device():
    from gesturewall.kinect import KinectV2Source

    src = make_frame_source("kinect_v2", "072843433747")
    assert type(src) is KinectV2Source
    assert src._device_index == "072843433747"
    # Light constructor: the bridge subprocess only spawns on the first read.
    assert src._proc is None


def test_kinect_v2_accepts_int_index():
    from gesturewall.kinect import KinectV2Source

    src = make_frame_source("kinect_v2", 1)
    assert type(src) is KinectV2Source
    assert src._device_index == 1
    assert src._proc is None


# --------------------------------------------------------------------------- #
# gemini_335 / orbbec -> OrbbecSource                                          #
# --------------------------------------------------------------------------- #
def test_gemini_335_returns_orbbec_source():
    from gesturewall.orbbec import OrbbecSource

    sdk_loaded_before = "pyorbbecsdk" in sys.modules
    src = make_frame_source("gemini_335", "CP0E8530002Y")
    assert type(src) is OrbbecSource
    # Side-effect-free constructor: building the source must not pull in the
    # Orbbec SDK (it imports lazily inside start(), per the source contract).
    assert ("pyorbbecsdk" in sys.modules) == sdk_loaded_before


def test_orbbec_alias_returns_orbbec_source():
    from gesturewall.orbbec import OrbbecSource

    src = make_frame_source("orbbec", 0)
    assert type(src) is OrbbecSource


# --------------------------------------------------------------------------- #
# rejected kinds: 'rgb' and anything unknown, ValueError naming the kind       #
# --------------------------------------------------------------------------- #
def test_rgb_kind_raises_valueerror_naming_the_kind():
    with pytest.raises(ValueError, match="rgb"):
        make_frame_source("rgb", 0)


def test_unknown_kind_raises_valueerror_naming_the_kind():
    with pytest.raises(ValueError, match="realsense_d455"):
        make_frame_source("realsense_d455", 0)
