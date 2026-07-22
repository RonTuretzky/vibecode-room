"""Headless tests for the Orbbec Gemini 335 source (gesturewall.orbbec).

No camera and no real SDK: a tiny fake ``pyorbbecsdk`` module is planted in
``sys.modules`` *before* ``OrbbecSource.start()`` ever runs, and the source's
imports are lazy (inside ``start()``), so the stub always wins. Note the real
``pyorbbecsdk`` wheel IS importable in this venv — the stub must still take
precedence, which is why every test that starts a pipeline goes through the
``stub`` fixture (``monkeypatch.setitem`` restores ``sys.modules`` on
teardown). ``gesturewall.orbbec`` itself caches nothing from the SDK at
module level, so patching ``sys.modules`` alone is sufficient.

Covered contract points:

  * light constructor — touches no SDK at all;
  * ``read()`` -> BGR uint8 (channel order actually flipped from the RGB
    wire bytes), float32 depth in METRES (uint16 raw * scale / 1000), and
    correct shapes;
  * intrinsics built once from ``pipeline.get_camera_param().rgb_intrinsic``
    with the aligned frame's width/height;
  * ``read(timeout=...)`` -> ``None`` when ``wait_for_frames`` always stalls;
  * ``close()`` safe pre-start; ``close()`` then ``read()`` restarts;
  * str device = serial match (unknown serial raises), permission errors from
    ``get_device_by_index`` surface as actionable RuntimeErrors.
"""

from __future__ import annotations

import sys
import types

import numpy as np
import pytest

from gesturewall.geometry import CameraIntrinsics
from gesturewall.orbbec import OrbbecSource

# Small frame keeps hand-built payloads tiny; decode uses the FRAME dims, not
# the requested profile size, so nothing needs to be 1280x720 here.
W, H = 4, 3
FX, FY, CX, CY = 640.5, 641.5, 320.25, 200.75


# --------------------------------------------------------------------------- #
# fake pyorbbecsdk: just enough surface for OrbbecSource                       #
# --------------------------------------------------------------------------- #
class FakeOBError(Exception):
    pass


class _Enum:
    """Cheap stand-in for the SDK's pybind enums (identity is all we need)."""

    def __init__(self, name: str):
        self.name = name

    def __repr__(self):  # pragma: no cover - debugging nicety
        return f"<enum {self.name}>"


class FakeVideoFrame:
    def __init__(self, width: int, height: int, data: bytes):
        self._width = width
        self._height = height
        self._data = data

    def get_width(self):
        return self._width

    def get_height(self):
        return self._height

    def get_data(self):
        return self._data


class FakeDepthFrame(FakeVideoFrame):
    def __init__(self, width, height, data, depth_scale=1.0):
        super().__init__(width, height, data)
        self._depth_scale = depth_scale

    def get_depth_scale(self):
        return self._depth_scale


class FakeFrameSet:
    def __init__(self, color, depth):
        self._color = color
        self._depth = depth

    def as_frame_set(self):
        return self

    def get_color_frame(self):
        return self._color

    def get_depth_frame(self):
        return self._depth


class FakeDeviceInfo:
    def __init__(self, serial: str):
        self._serial = serial

    def get_serial_number(self):
        return self._serial


class FakePresetList:
    def __init__(self, names):
        self._names = list(names)

    def get_count(self):
        return len(self._names)

    def get_name_by_index(self, i):
        return self._names[i]


class FakeDevice:
    def __init__(self, serial: str, presets=("Default", "Hand")):
        self._info = FakeDeviceInfo(serial)
        self.bool_props: list[tuple[object, bool]] = []
        self._presets = FakePresetList(presets)
        self.current_preset = "Default"

    def get_device_info(self):
        return self._info

    def set_bool_property(self, prop_id, value):
        self.bool_props.append((prop_id, value))

    def get_available_preset_list(self):
        return self._presets

    def get_current_preset_name(self):
        return self.current_preset

    def load_preset(self, name):
        self.current_preset = name


class FakeDeviceList:
    def __init__(self, devices, error_on_open=None):
        self._devices = list(devices)
        self._error_on_open = error_on_open  # raised by device-OPENING calls

    def get_count(self):
        return len(self._devices)

    def get_device_by_index(self, index):
        if self._error_on_open is not None:
            raise self._error_on_open
        return self._devices[index]

    # Enumeration-data serial read: never opens a device (matches the wheel).
    def get_device_serial_number_by_index(self, index):
        return self._devices[index].get_device_info().get_serial_number()

    def get_device_by_serial_number(self, serial):
        if self._error_on_open is not None:
            raise self._error_on_open
        for dev in self._devices:
            if dev.get_device_info().get_serial_number() == serial:
                return dev
        raise KeyError(serial)


class FakeStreamProfile:
    def __init__(self, kind: str, args=()):
        self.kind = kind
        self.args = tuple(args)


class FakeStreamProfileList:
    """Offers BGR + RGB color profiles by default (like the real G335, whose
    frame processor enumerates converted profiles from the native MJPG)."""

    offered_formats: set[str] | None = None  # None = any format accepted

    def __init__(self, sensor_type):
        self.sensor_type = sensor_type

    def get_video_stream_profile(self, width, height, fmt, fps):
        name = getattr(fmt, "name", str(fmt))
        if (self.offered_formats is not None
                and name not in self.offered_formats
                and name != "UNKNOWN_FORMAT"):
            raise FakeOBError(f"no {name} profile")
        return FakeStreamProfile("video", (width, height, fmt, fps))

    def get_default_video_stream_profile(self):
        return FakeStreamProfile("default")


class FakeConfig:
    def __init__(self):
        self.enabled: list[FakeStreamProfile] = []
        self.aggregate_mode = None

    def enable_stream(self, profile):
        self.enabled.append(profile)

    def set_frame_aggregate_output_mode(self, mode):
        self.aggregate_mode = mode


class FakeAlignFilter:
    def __init__(self, align_to_stream):
        self.align_to_stream = align_to_stream

    def process(self, frames):
        return frames  # already a FakeFrameSet; .as_frame_set() is identity


class FakeCameraParam:
    def __init__(self, rgb_intrinsic):
        self.rgb_intrinsic = rgb_intrinsic


class FakePipeline:
    """Records lifecycle; serves framesets from the shared ``state`` dict."""

    def __init__(self, device, state):
        self.device = device
        self._state = state
        self.started = False
        self.stopped = False
        self.config = None
        self.frame_sync = False
        state["pipelines"].append(self)

    def enable_frame_sync(self):
        self.frame_sync = True

    def get_stream_profile_list(self, sensor_type):
        return FakeStreamProfileList(sensor_type)

    def start(self, config):
        self.started = True
        self.config = config

    def stop(self):
        self.stopped = True

    def wait_for_frames(self, timeout_ms):
        self._state["waits"].append(timeout_ms)
        return self._state["frameset_factory"](timeout_ms)

    def get_camera_param(self):
        self._state["camera_param_calls"] += 1
        return FakeCameraParam(self._state["rgb_intrinsic"])


def build_stub(devices, frameset_factory, error_on_open=None):
    """Build a fake ``pyorbbecsdk`` module plus its shared ``state`` dict."""
    state = {
        "pipelines": [],
        "waits": [],
        "frameset_factory": frameset_factory,
        "camera_param_calls": 0,
        "rgb_intrinsic": types.SimpleNamespace(
            fx=FX, fy=FY, cx=CX, cy=CY, width=W, height=H),
        "device_list": FakeDeviceList(devices, error_on_open=error_on_open),
    }

    mod = types.ModuleType("pyorbbecsdk")
    mod.OBError = FakeOBError
    mod.Context = lambda: types.SimpleNamespace(
        query_devices=lambda: state["device_list"])
    mod.Pipeline = lambda device: FakePipeline(device, state)
    mod.Config = FakeConfig
    mod.AlignFilter = FakeAlignFilter
    mod.OBSensorType = types.SimpleNamespace(
        COLOR_SENSOR=_Enum("COLOR_SENSOR"), DEPTH_SENSOR=_Enum("DEPTH_SENSOR"))
    mod.OBFormat = types.SimpleNamespace(
        RGB=_Enum("RGB"), BGR=_Enum("BGR"),
        UNKNOWN_FORMAT=_Enum("UNKNOWN_FORMAT"))
    mod.OBStreamType = types.SimpleNamespace(
        COLOR_STREAM=_Enum("COLOR_STREAM"))
    mod.OBFrameAggregateOutputMode = types.SimpleNamespace(
        FULL_FRAME_REQUIRE=_Enum("FULL_FRAME_REQUIRE"))
    mod.OBPropertyID = types.SimpleNamespace(
        OB_PROP_COLOR_AUTO_WHITE_BALANCE_BOOL=_Enum("AUTO_WB"),
        OB_PROP_COLOR_AUTO_EXPOSURE_BOOL=_Enum("AUTO_EXPOSURE"))
    return mod, state


# --------------------------------------------------------------------------- #
# frame builders                                                              #
# --------------------------------------------------------------------------- #
def sample_rgb() -> np.ndarray:
    """(H, W, 3) uint8 with a distinctive pixel to catch channel swaps."""
    rgb = np.arange(H * W * 3, dtype=np.int64).reshape(H, W, 3)
    rgb = (rgb % 200).astype(np.uint8)
    rgb[0, 0] = (10, 20, 30)  # R=10 G=20 B=30 on the RGB wire
    return rgb


def sample_depth_raw() -> np.ndarray:
    raw = (np.arange(H * W, dtype=np.int64).reshape(H, W) * 100 + 500)
    raw = raw.astype(np.uint16)
    raw[0, 0] = 1234  # scale 1.0 -> exactly 1.234 m
    raw[2, 3] = 0     # invalid pixel stays 0.0 m
    return raw


def make_frameset(depth_scale: float = 1.0) -> FakeFrameSet:
    color = FakeVideoFrame(W, H, sample_rgb().tobytes())
    depth = FakeDepthFrame(
        W, H, sample_depth_raw().tobytes(), depth_scale=depth_scale)
    return FakeFrameSet(color, depth)


def install_stub(monkeypatch, devices=None, frameset_factory=None,
                 error_on_open=None):
    """Plant the stub as ``sys.modules['pyorbbecsdk']`` (auto-restored)."""
    if devices is None:
        devices = [FakeDevice("CP0E8530002Y")]
    if frameset_factory is None:
        frameset_factory = lambda ms: make_frameset()
    mod, state = build_stub(devices, frameset_factory,
                            error_on_open=error_on_open)
    monkeypatch.setitem(sys.modules, "pyorbbecsdk", mod)
    return state


# --------------------------------------------------------------------------- #
# laziness: construction must not touch the SDK                               #
# --------------------------------------------------------------------------- #
def test_constructor_touches_no_sdk(monkeypatch):
    # Remove any previously-imported pyorbbecsdk; if the constructor imported
    # or used the SDK, it would reappear in sys.modules (or blow up).
    monkeypatch.delitem(sys.modules, "pyorbbecsdk", raising=False)
    src = OrbbecSource(device_index="CP0E8530002Y")
    assert "pyorbbecsdk" not in sys.modules
    assert src._pipe is None
    assert src.intrinsics is None
    src.close()  # pre-start close is a safe no-op
    assert "pyorbbecsdk" not in sys.modules


# --------------------------------------------------------------------------- #
# read(): shapes, BGR flip, metres conversion, intrinsics                     #
# --------------------------------------------------------------------------- #
def test_read_returns_bgr_metres_and_intrinsics(monkeypatch):
    state = install_stub(monkeypatch)
    # Offer only RGB so the BGR-preferred request falls back and the source
    # must channel-flip (the native-BGR path is pinned separately below).
    monkeypatch.setattr(FakeStreamProfileList, "offered_formats", {"RGB"})
    src = OrbbecSource(device_index=0)
    item = src.read(timeout=1.0)
    assert item is not None
    color, depth_m, intr = item

    # Color: uint8 (H, W, 3), and the RGB wire pixel (10, 20, 30) must come
    # back channel-flipped to BGR (30, 20, 10).
    assert color.shape == (H, W, 3)
    assert color.dtype == np.uint8
    np.testing.assert_array_equal(color[0, 0], [30, 20, 10])
    np.testing.assert_array_equal(color, sample_rgb()[:, :, ::-1])

    # Depth: float32 (H, W) in METRES — raw uint16 1234 @ scale 1.0 -> 1.234.
    assert depth_m.shape == (H, W)
    assert depth_m.dtype == np.float32
    assert depth_m[0, 0] == pytest.approx(1.234)
    assert depth_m[2, 3] == 0.0
    np.testing.assert_allclose(
        depth_m, sample_depth_raw().astype(np.float32) / 1000.0, rtol=1e-6)

    # Intrinsics: from get_camera_param().rgb_intrinsic, sized to the aligned
    # frame; fetched once and cached (property agrees with the tuple).
    assert isinstance(intr, CameraIntrinsics)
    assert intr.fx == pytest.approx(FX)
    assert intr.fy == pytest.approx(FY)
    assert intr.cx == pytest.approx(CX)
    assert intr.cy == pytest.approx(CY)
    assert intr.width == W and intr.height == H
    assert src.intrinsics is intr
    assert state["camera_param_calls"] == 1
    src.read(timeout=1.0)
    assert state["camera_param_calls"] == 1  # cached, not re-queried
    src.close()


def test_depth_scale_is_raw_to_millimetres(monkeypatch):
    # A 0.5 raw->mm scale halves the metres: 1234 * 0.5 / 1000 = 0.617 m.
    install_stub(monkeypatch,
                 frameset_factory=lambda ms: make_frameset(depth_scale=0.5))
    src = OrbbecSource()
    _, depth_m, _ = src.read(timeout=1.0)
    assert depth_m[0, 0] == pytest.approx(0.617)
    src.close()


def test_color_is_a_writable_copy(monkeypatch):
    install_stub(monkeypatch)
    src = OrbbecSource()
    color, _, _ = src.read(timeout=1.0)
    color[0, 0, 0] = 99  # must not raise (frombuffer views are read-only)
    src.close()


# --------------------------------------------------------------------------- #
# read(timeout): None-on-stall                                                #
# --------------------------------------------------------------------------- #
def test_read_timeout_returns_none_when_stalled(monkeypatch):
    state = install_stub(monkeypatch, frameset_factory=lambda ms: None)
    src = OrbbecSource()
    assert src.read(timeout=0.05) is None
    assert state["pipelines"][0].started  # it did start and try to read
    assert len(state["waits"]) >= 1
    assert all(ms >= 1 for ms in state["waits"])  # SDK gets whole ms >= 1
    src.close()


def test_read_timeout_none_components_returns_none(monkeypatch):
    # FULL_FRAME_REQUIRE notwithstanding, missing components keep us waiting
    # inside the budget and time out cleanly.
    empty = FakeFrameSet(None, None)
    install_stub(monkeypatch, frameset_factory=lambda ms: empty)
    src = OrbbecSource()
    assert src.read(timeout=0.05) is None
    src.close()


# --------------------------------------------------------------------------- #
# lifecycle: close pre-start, restart after close                             #
# --------------------------------------------------------------------------- #
def test_close_prestart_and_idempotent(monkeypatch):
    monkeypatch.delitem(sys.modules, "pyorbbecsdk", raising=False)
    src = OrbbecSource()
    src.close()
    src.close()  # double close is fine, and still no SDK import
    assert "pyorbbecsdk" not in sys.modules


def test_close_then_read_restarts(monkeypatch):
    state = install_stub(monkeypatch)
    src = OrbbecSource(device_index=0)

    assert src.read(timeout=1.0) is not None
    assert len(state["pipelines"]) == 1

    src.close()
    assert state["pipelines"][0].stopped
    assert src._pipe is None
    assert src.intrinsics is None  # stale intrinsics dropped on close

    # read() after close() lazily start()s again -> a brand-new pipeline.
    item = src.read(timeout=1.0)
    assert item is not None
    assert len(state["pipelines"]) == 2
    assert state["pipelines"][1].started
    src.close()
    assert state["pipelines"][1].stopped
    src.close()  # idempotent post-stop too


def test_start_is_idempotent(monkeypatch):
    state = install_stub(monkeypatch)
    src = OrbbecSource()
    src.start()
    src.start()
    assert len(state["pipelines"]) == 1
    src.close()


# --------------------------------------------------------------------------- #
# device selection: serial strings, indices, failures                         #
# --------------------------------------------------------------------------- #
def test_serial_selection_picks_matching_device(monkeypatch):
    devices = [FakeDevice("AAAA0000"), FakeDevice("CP0E8530002Y")]
    state = install_stub(monkeypatch, devices=devices)
    src = OrbbecSource(device_index="CP0E8530002Y")
    src.start()
    picked = state["pipelines"][0].device
    assert picked.get_device_info().get_serial_number() == "CP0E8530002Y"
    src.close()


def test_unknown_serial_raises(monkeypatch):
    install_stub(monkeypatch, devices=[FakeDevice("AAAA0000")])
    src = OrbbecSource(device_index="NOPE")
    with pytest.raises(RuntimeError, match="NOPE"):
        src.start()


def test_int_index_selection(monkeypatch):
    devices = [FakeDevice("AAAA0000"), FakeDevice("BBBB1111")]
    state = install_stub(monkeypatch, devices=devices)
    src = OrbbecSource(device_index=1)
    src.start()
    picked = state["pipelines"][0].device
    assert picked.get_device_info().get_serial_number() == "BBBB1111"
    src.close()


def test_int_index_out_of_range_raises(monkeypatch):
    install_stub(monkeypatch, devices=[FakeDevice("AAAA0000")])
    src = OrbbecSource(device_index=5)
    with pytest.raises(RuntimeError, match="out of range"):
        src.start()


def test_no_devices_raises(monkeypatch):
    install_stub(monkeypatch, devices=[])
    src = OrbbecSource()
    with pytest.raises(RuntimeError, match="no Orbbec devices"):
        src.start()


def test_permission_oberror_becomes_actionable_runtimeerror(monkeypatch):
    # macOS un-sudo'd: get_device_by_index itself raises OBError (uvc_open -3).
    install_stub(
        monkeypatch, devices=[FakeDevice("AAAA0000")],
        error_on_open=FakeOBError("uvc_open failed: -3"))
    src = OrbbecSource(device_index=0)
    with pytest.raises(RuntimeError, match="sudo -E"):
        src.start()


# --------------------------------------------------------------------------- #
# start(): pipeline wiring                                                    #
# --------------------------------------------------------------------------- #
def test_start_wires_profiles_aggregate_mode_and_color_tuning(monkeypatch):
    state = install_stub(monkeypatch)
    src = OrbbecSource(device_index=0, width=1280, height=720, fps=30)
    src.start()

    pipe = state["pipelines"][0]
    assert pipe.started
    cfg = pipe.config
    # Color: exact 1280x720 @30 profile, native BGR preferred (no host flip);
    # depth: the sensor default.
    kinds = [(p.kind, p.args) for p in cfg.enabled]
    assert kinds[0][0] == "video"
    w, h, fmt, fps = kinds[0][1]
    assert (w, h, fps) == (1280, 720, 30)
    assert fmt.name == "BGR"
    assert src._color_is_bgr is True
    assert kinds[1][0] == "default"
    assert cfg.aggregate_mode.name == "FULL_FRAME_REQUIRE"
    # Align filter targets the color stream.
    assert src._align.align_to_stream.name == "COLOR_STREAM"
    # Color pipeline stays on firmware AUTO exposure/WB: the Gemini's manual
    # defaults are green-cast/badly exposed and kill magenta marker detection.
    assert pipe.device.bool_props == []
    src.close()


def test_native_bgr_profile_skips_flip(monkeypatch):
    # Default stub offers BGR: the wire bytes must come back UNFLIPPED
    # (they are already BGR on the wire in this mode).
    install_stub(monkeypatch)
    src = OrbbecSource(device_index=0)
    color, _, _ = src.read(timeout=1.0)
    np.testing.assert_array_equal(color, sample_rgb())  # same bytes, no flip
    src.close()


def test_stall_exhaust_closes_for_respawn(monkeypatch):
    # With timeout=None, ~20 empty wait slices must (a) return None and
    # (b) CLOSE the pipeline so the next read() can respawn — without the
    # close, the server path waits on a dead pipeline forever.
    import gesturewall.orbbec as orbbec_mod

    silent = {"on": False}
    state = install_stub(
        monkeypatch,
        frameset_factory=lambda ms: None if silent["on"] else make_frameset())
    monkeypatch.setattr(orbbec_mod, "_WAIT_SLICE_MS", 1)
    monkeypatch.setattr(orbbec_mod, "_MAX_STALL_SLICES", 3)
    src = OrbbecSource(device_index=0)
    assert src.read(timeout=1.0) is not None      # healthy first
    silent["on"] = True                           # device goes silent
    assert src.read() is None                     # stall-exhaust
    assert src._pipe is None                      # closed -> respawnable
    assert state["pipelines"][0].stopped
    silent["on"] = False                          # device back
    assert src.read(timeout=1.0) is not None      # respawned transparently
    assert len(state["pipelines"]) == 2
    src.close()


def test_explicit_depth_size_selects_profile(monkeypatch):
    install_stub(monkeypatch)
    src = OrbbecSource(device_index=0, depth_size=(1280, 800))
    src.start()
    depth_args = src._pipe.config.enabled[1]
    assert depth_args.kind == "video"
    w, h, fmt, fps = depth_args.args
    assert (w, h, fps) == (1280, 800, 30)
    assert fmt.name == "UNKNOWN_FORMAT"           # any native depth format
    src.close()


def test_experimental_knobs_default_off(monkeypatch):
    # Live A/B: the "recommended" trio (Hand preset + 1280x800 + frame sync)
    # made pointing WORSE enabled together, so the defaults are the device's
    # own behavior — no preset load, no frame sync, default depth profile.
    state = install_stub(monkeypatch)
    src = OrbbecSource(device_index=0)
    src.start()
    pipe = state["pipelines"][0]
    assert pipe.device.current_preset == "Default"   # untouched
    assert pipe.frame_sync is False
    assert pipe.config.enabled[1].kind == "default"  # sensor-default depth
    assert pipe.started
    src.close()


def test_experimental_knobs_opt_in_via_env(monkeypatch):
    # GESTUREWALL_ORBBEC_PRESET / _SYNC / _DEPTH re-enable each knob alone.
    import importlib

    import gesturewall.orbbec as orbbec_mod

    monkeypatch.setenv("GESTUREWALL_ORBBEC_PRESET", "Hand")
    monkeypatch.setenv("GESTUREWALL_ORBBEC_SYNC", "1")
    monkeypatch.setenv("GESTUREWALL_ORBBEC_DEPTH", "1280x800")
    importlib.reload(orbbec_mod)  # PRESET/FRAME_SYNC bind at import
    try:
        state = install_stub(monkeypatch)
        src = orbbec_mod.OrbbecSource(device_index=0)
        src.start()
        pipe = state["pipelines"][0]
        assert pipe.device.current_preset == "Hand"
        assert pipe.frame_sync is True
        w, h, fmt, fps = pipe.config.enabled[1].args
        assert (w, h) == (1280, 800)
        src.close()
    finally:
        monkeypatch.delenv("GESTUREWALL_ORBBEC_PRESET")
        monkeypatch.delenv("GESTUREWALL_ORBBEC_SYNC")
        monkeypatch.delenv("GESTUREWALL_ORBBEC_DEPTH")
        importlib.reload(orbbec_mod)


def test_missing_preset_support_falls_back(monkeypatch):
    # Firmware without "Hand" (or without presets at all) stays on default.
    state = install_stub(
        monkeypatch,
        devices=[FakeDevice("CP0E8530002Y", presets=("Default",))])
    src = OrbbecSource(device_index=0)
    src.start()
    assert state["pipelines"][0].device.current_preset == "Default"
    src.close()
