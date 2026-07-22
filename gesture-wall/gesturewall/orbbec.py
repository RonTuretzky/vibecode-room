"""Orbbec Gemini 335 frame source via the pyorbbecsdk v2 Python bindings.

One Gemini 335 (serial ``CP0E8530002Y``) replaces the pair of Kinect v2s: it
watches BOTH walls A and B from the room's far corner, so the pipeline is back
to a single shared frame with joint single-camera autocal. This module speaks
the exact same source contract as :class:`gesturewall.kinect.KinectV2Source`:

  * light constructor — no SDK import, no device I/O;
  * ``start()`` — idempotent; opens the device and starts the pipeline;
  * ``read(timeout=None)`` — ``(color, depth_m, intr)`` or ``None`` on stall:
      - ``color``  : ``uint8`` (H, W, 3) **BGR** image,
      - ``depth_m``: ``float32`` (H, W) depth in **metres**, pixel-aligned to
        the color image via the SDK's :class:`AlignFilter`,
      - ``intr``   : the color camera's
        :class:`~gesturewall.geometry.CameraIntrinsics`;
  * ``intrinsics`` property — last-known intrinsics or ``None``;
  * ``close()`` — idempotent, safe pre-start; a later ``read()`` respawns.

Units: the SDK hands back ``uint16`` depth whose ``get_depth_scale()`` maps
RAW -> **millimetres**; we convert to metres (``raw * scale / 1000``) so
everything downstream keeps speaking metres, matching
:mod:`gesturewall.geometry` and the Kinect source.

Color order: the color stream is requested as ``OBFormat.RGB`` and flipped to
BGR with a numpy slice (no cv2 dependency), because the rest of the pipeline
(and OpenCV-based preview/autocal) expects BGR.

Laziness: ``pyorbbecsdk`` is only imported inside :meth:`OrbbecSource.start`.
Importing this module never needs the SDK or hardware — required because
un-sudo'd macOS processes currently fail ``uvc_open`` (-3), and tests stub the
SDK by planting a fake ``sys.modules["pyorbbecsdk"]`` before ``start()`` runs.

Probe CLI (verifies the hardware end-to-end)::

    sudo -E .venv/bin/python -m gesturewall.orbbec --serial CP0E8530002Y
"""

from __future__ import annotations

import os
import sys

import numpy as np

from .geometry import CameraIntrinsics

# Defaults for the Gemini 335 color stream (depth uses the sensor default and
# is aligned to color, so it comes out at the color resolution).
DEFAULT_WIDTH = 1280
DEFAULT_HEIGHT = 720
DEFAULT_FPS = 30

# ---- experimental knobs (opt-in via env; defaults = device behavior) ------- #
# Live A/B on this room: Orbbec's "recommended" trio (Hand preset + 1280x800
# depth + frame sync), enabled together, made pointing WORSE than the device
# defaults (wall B marker fill dropped 9/9 -> 7/9; the Hand preset trades fill
# for edge sharpness — the wrong tradeoff at 2.5-3.6 m). Each knob is therefore
# opt-in until individually proven on this hardware:
#   GESTUREWALL_ORBBEC_PRESET=Hand        depth preset (empty = device default)
#   GESTUREWALL_ORBBEC_DEPTH=1280x800     explicit native depth mode
#   GESTUREWALL_ORBBEC_SYNC=1             hardware color/depth frame sync
PRESET = os.environ.get("GESTUREWALL_ORBBEC_PRESET", "")
FRAME_SYNC = os.environ.get("GESTUREWALL_ORBBEC_SYNC", "") == "1"


def _env_depth_size() -> tuple[int, int] | None:
    raw = os.environ.get("GESTUREWALL_ORBBEC_DEPTH", "")
    if raw and "x" in raw:
        w, _, h = raw.partition("x")
        try:
            return (int(w), int(h))
        except ValueError:
            print(f"orbbec: bad GESTUREWALL_ORBBEC_DEPTH {raw!r}; using "
                  "device default", file=sys.stderr)
    return None

# With ``read(timeout=None)`` we still bound each native wait to this slice so
# a stalled pipeline can never hang the caller inside a single SDK call.
_WAIT_SLICE_MS = 1000

# With ``read(timeout=None)`` this many CONSECUTIVE empty wait slices count as
# end-of-stream and read() returns None — the Kinect source signals a dead
# bridge the same way, and the no-timeout callers (the live server, calibrate)
# rely on None to recover instead of blocking forever. A healthy pipeline
# delivers at 30 fps, so even 5 s of nothing means the device is gone; a
# false trigger just costs one transparent re-enumeration.
_MAX_STALL_SLICES = 5


class OrbbecSource:
    """Live Gemini 335 frames: aligned color+depth via pyorbbecsdk v2.

    ``device_index`` selects the camera: a ``str`` is matched against device
    serial numbers (e.g. ``"CP0E8530002Y"``), an ``int`` indexes the SDK's
    enumeration order. Construction has **no side effects**; the SDK is
    imported and the pipeline started lazily in :meth:`start` (called from the
    first :meth:`read`).
    """

    def __init__(self, device_index: int | str = 0,
                 width: int = DEFAULT_WIDTH, height: int = DEFAULT_HEIGHT,
                 fps: int = DEFAULT_FPS,
                 depth_size: tuple[int, int] | None = None):
        # depth_size: explicit native depth resolution, e.g. (1280, 800) for
        # the G335's full IR resolution. None (the default) = the env knob
        # GESTUREWALL_ORBBEC_DEPTH if set, else the sensor's default profile
        # (848x480 on the G335, upsampled to color by the align filter). The
        # full-res mode puts ~1 native depth sample under each color pixel —
        # more real measurements on a thin wrist — at higher USB bandwidth
        # and possibly higher per-pixel noise; A/B before making it default.
        self._device_index = device_index
        self._width = width
        self._height = height
        self._fps = fps
        self._depth_size = depth_size or _env_depth_size()
        self._ctx = None            # keep the SDK Context alive with the device
        self._device = None
        self._pipe = None
        self._align = None
        self._color_is_bgr = False  # set in start() from the chosen profile
        self._delivered = False     # any frame decoded since the last start()
        self._dry_reads = 0         # consecutive read()s that returned None
        self._intrinsics: CameraIntrinsics | None = None
        self._warned_color_tuning = False

    # ----------------------------------------------------------------- #
    # lifecycle                                                          #
    # ----------------------------------------------------------------- #
    def start(self) -> None:
        """Open the device and start the aligned color+depth pipeline.

        Idempotent. Imports ``pyorbbecsdk`` lazily; ``self._pipe`` is only
        committed once the pipeline actually started, so a failed start can
        simply be retried.
        """
        if self._pipe is not None:
            return
        from pyorbbecsdk import (
            AlignFilter,
            Config,
            Context,
            OBError,
            OBFormat,
            OBFrameAggregateOutputMode,
            OBSensorType,
            OBStreamType,
            Pipeline,
        )

        device = self._open_device(Context, OBError)
        self._tune_color(device)
        self._warn_if_usb2(device)
        self._load_preset(device)

        pipe = Pipeline(device)
        # Optional (GESTUREWALL_ORBBEC_SYNC=1): pair color+depth by hardware
        # timestamp so a moving wrist reads depth from ITS color frame. Kept
        # opt-in: enabled together with the other "recommended" knobs it made
        # pointing worse on this rig (see the knob comment at the top).
        if FRAME_SYNC:
            try:
                pipe.enable_frame_sync()
            except Exception as exc:  # noqa: BLE001 - firmware-dependent
                print(f"orbbec: frame sync unavailable ({exc})",
                      file=sys.stderr)
        cfg = Config()
        colors = pipe.get_stream_profile_list(OBSensorType.COLOR_SENSOR)
        # Prefer a native BGR profile (saves a full-frame channel flip per
        # frame); the camera streams MJPG either way and the SDK's frame
        # processor decodes host-side, so BGR vs RGB is free to request.
        try:
            color_profile = colors.get_video_stream_profile(
                self._width, self._height, OBFormat.BGR, self._fps)
            self._color_is_bgr = True
        except OBError:
            color_profile = colors.get_video_stream_profile(
                self._width, self._height, OBFormat.RGB, self._fps)
            self._color_is_bgr = False
        depths = pipe.get_stream_profile_list(OBSensorType.DEPTH_SENSOR)
        if self._depth_size is not None:
            dw, dh = self._depth_size
            depth_profile = depths.get_video_stream_profile(
                dw, dh, OBFormat.UNKNOWN_FORMAT, self._fps)
        else:
            depth_profile = depths.get_default_video_stream_profile()
        cfg.enable_stream(color_profile)
        cfg.enable_stream(depth_profile)
        # Only emit framesets that contain BOTH streams; read() still guards
        # against missing components defensively.
        cfg.set_frame_aggregate_output_mode(
            OBFrameAggregateOutputMode.FULL_FRAME_REQUIRE)

        align = AlignFilter(align_to_stream=OBStreamType.COLOR_STREAM)
        pipe.start(cfg)

        self._device = device
        self._align = align
        self._pipe = pipe

    def _load_preset(self, device) -> None:
        """Best-effort: load the "Hand" depth preset before streaming.

        "Hand" is Orbbec's named G330 preset for gesture recognition ("clear
        hand and finger edges") — exactly this pipeline's workload. Presets
        may only be switched BEFORE the depth/IR streams start ("must be
        avoided under any conditions" while streaming), which is why this
        runs in start() before the pipeline exists. Firmwares without preset
        support (or without "Hand") just stay on their default.
        """
        if not PRESET:
            return  # default: leave the device on its own preset
        try:
            plist = device.get_available_preset_list()
            names = [plist.get_name_by_index(i)
                     for i in range(plist.get_count())]
            if PRESET in names and device.get_current_preset_name() != PRESET:
                device.load_preset(PRESET)
                print(f"orbbec: loaded depth preset {PRESET!r}",
                      file=sys.stderr)
            elif PRESET not in names:
                print(f"orbbec: preset {PRESET!r} not offered by this "
                      f"firmware (has: {names})", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001 - depends on firmware
            print(f"orbbec: depth presets unavailable ({exc}); "
                  "using device default", file=sys.stderr)

    def _warn_if_usb2(self, device) -> None:
        """Warn once if the camera enumerated on USB 2 — the classic silent
        failure mode (streams start, then starve). Best-effort: older
        firmwares may not report a connection type."""
        try:
            info = device.get_device_info()
            conn = str(info.get_connection_type())
            if "2." in conn and "3" not in conn:
                print(f"orbbec: WARNING - camera on {conn}, not USB 3; "
                      "expect stream starvation (use a USB 3 port/cable)",
                      file=sys.stderr)
        except Exception:  # noqa: BLE001 - diagnostics only
            pass

    def _open_device(self, Context, OBError):
        """Enumerate devices and pick by serial (str) or index (int).

        The serial path reads serials from ENUMERATION data (no device open)
        and only opens the matching device — so a second Orbbec held by
        another process can never abort selecting this one.
        """
        try:
            self._ctx = Context()
            devices = self._ctx.query_devices()
            count = devices.get_count()
        except OBError as exc:
            raise RuntimeError(
                f"Orbbec device enumeration failed: {exc}. On macOS USB/UVC "
                "access needs elevated permissions - try re-running with "
                "'sudo -E'.") from exc
        if count == 0:
            raise RuntimeError(
                "no Orbbec devices found; is the Gemini 335 plugged in?")

        sel = self._device_index
        if isinstance(sel, str):
            serials = [devices.get_device_serial_number_by_index(i)
                       for i in range(count)]
            if sel not in serials:
                raise RuntimeError(
                    f"no Orbbec device with serial {sel!r}; "
                    f"found serial(s): {serials}")
            try:
                return devices.get_device_by_serial_number(sel)
            except OBError as exc:
                raise RuntimeError(
                    f"failed to open Orbbec device {sel!r}: {exc}. On macOS "
                    "USB/UVC access needs elevated permissions - try "
                    "re-running with 'sudo -E' (uvc_open error -3 is the "
                    "permission failure).") from exc

        idx = int(sel)
        if not 0 <= idx < count:
            raise RuntimeError(
                f"Orbbec device index {idx} out of range "
                f"({count} device(s) found)")
        return self._get_device(devices, idx, OBError)

    @staticmethod
    def _get_device(devices, index: int, OBError):
        """Open one enumerated device, translating SDK permission errors.

        On macOS an un-sudo'd process gets ``uvc_open`` error -3 right here
        (opening the device is what needs USB permission), so wrap it with an
        actionable message rather than a bare pybind exception.
        """
        try:
            return devices.get_device_by_index(index)
        except OBError as exc:
            raise RuntimeError(
                f"failed to open Orbbec device #{index}: {exc}. On macOS "
                "USB/UVC access needs elevated permissions - try re-running "
                "with 'sudo -E' (uvc_open error -3 is the permission "
                "failure).") from exc

    def _tune_color(self, device) -> None:
        """Color pipeline: firmware auto-exposure/auto-WB, optionally biased.

        Full-manual was tried and reverted: the Gemini's MANUAL defaults
        produce a green-cast, badly exposed image that guts the red/blue
        channels autocal's magenta detector needs (live result: 0-2 of 18
        markers, all garbage). Auto everything is the baseline.

        The remaining problem is DARK rooms: depth doesn't care (the IR
        stereo carries its own emitter) but MediaPipe pose runs on the COLOR
        image, and a dark projected scene starves the landmarks — live
        experiment: turning the room light on made pointing "much better".
        The operational fix is keeping some ambient light on people. The
        code-side levers (opt-in, applied WITHIN auto exposure so autocal's
        diffing keeps working) bias the AE toward brighter people:

          GESTUREWALL_ORBBEC_BRIGHTNESS=<int>  AE target brightness
          GESTUREWALL_ORBBEC_BACKLIGHT=<0-6>   backlight compensation

        Both are best-effort; unsupported firmwares just warn once. If a
        value is changed, re-run autocal (color response changes).
        """
        wanted = []
        raw_b = os.environ.get("GESTUREWALL_ORBBEC_BRIGHTNESS", "")
        raw_bl = os.environ.get("GESTUREWALL_ORBBEC_BACKLIGHT", "")
        if raw_b.lstrip("-").isdigit():
            wanted.append(("OB_PROP_COLOR_BRIGHTNESS_INT", int(raw_b)))
        if raw_bl.isdigit():
            wanted.append(("OB_PROP_COLOR_BACKLIGHT_COMPENSATION_INT",
                           int(raw_bl)))
        if not wanted:
            return
        try:
            from pyorbbecsdk import OBPropertyID
            for prop_name, value in wanted:
                device.set_int_property(getattr(OBPropertyID, prop_name),
                                        value)
                print(f"orbbec: color {prop_name} = {value}", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001 - depends on firmware
            if not self._warned_color_tuning:
                self._warned_color_tuning = True
                print(f"orbbec: color tuning unavailable ({exc}); "
                      "staying on firmware defaults", file=sys.stderr)

    def _log_pipeline_status(self) -> None:
        """Best-effort: say WHERE a stall sits (SDK/driver/firmware/hardware).

        ``Pipeline.get_status()`` classifies the problem source, which tells
        an operator whether to reseat USB (driver/hw) or power-cycle the
        camera (firmware) instead of guessing.
        """
        try:
            status = self._pipe.get_status()
            print(f"orbbec: pipeline stalled - status issue={status.issue} "
                  f"sdk={status.sdk_status} drv={status.drv_status} "
                  f"dev={status.dev_status}", file=sys.stderr)
        except Exception:  # noqa: BLE001 - diagnostics only
            print("orbbec: pipeline stalled (no status available)",
                  file=sys.stderr)

    def _note_dry(self) -> None:
        """Track fruitless reads; reboot a wedged device as a last resort.

        A pipeline that was hard-killed mid-stream can leave the camera in a
        state where every fresh open succeeds but never delivers a frame —
        process restarts don't help, only a device reset does. When a STARTED
        pipeline has delivered nothing across several consecutive dry reads,
        fire the SDK's software ``reboot()`` (the equivalent of replugging the
        USB cable) and close; the device re-enumerates within ~10 s and the
        next read()'s open finds it fresh.
        """
        self._dry_reads += 1
        if self._delivered or self._pipe is None or self._dry_reads < 3:
            return
        print("orbbec: pipeline delivers nothing after fresh open - "
              "rebooting the device (re-enumerates in ~10 s)", file=sys.stderr)
        try:
            self._device.reboot()
        except Exception as exc:  # noqa: BLE001 - best effort
            print(f"orbbec: device reboot failed ({exc})", file=sys.stderr)
        self._dry_reads = 0
        self.close()

    def close(self) -> None:
        """Stop the pipeline and drop all SDK refs (idempotent, pre-start ok).

        After ``close()`` the source is back to its constructed state, so a
        later :meth:`read` transparently restarts the pipeline.
        """
        pipe = self._pipe
        self._pipe = None
        self._align = None
        self._device = None
        self._ctx = None
        self._intrinsics = None
        if pipe is None:
            return
        try:
            pipe.stop()
        except Exception:  # pragma: no cover - best effort
            pass

    # ----------------------------------------------------------------- #
    # frames                                                             #
    # ----------------------------------------------------------------- #
    @property
    def intrinsics(self) -> CameraIntrinsics | None:
        """Color-camera intrinsics from the running pipeline, or ``None``."""
        return self._intrinsics

    def read(self, timeout: float | None = None):
        """Return the next aligned ``(color, depth_m, intr)``, or ``None``.

        Blocks until a frameset with both color and depth arrives. With
        ``timeout`` (seconds), returns ``None`` if none arrives in time —
        mirroring :meth:`KinectV2Source.read`'s None-on-stall semantics. With
        ``timeout=None`` it waits in bounded ``_WAIT_SLICE_MS`` native slices
        and returns ``None`` after ``_MAX_STALL_SLICES`` consecutive empty
        ones — the Kinect source's end-of-stream signal, which the no-timeout
        callers (server, calibrate) rely on to recover from a dead camera.
        """
        import time as _time

        if self._pipe is None:
            self.start()
        assert self._pipe is not None and self._align is not None

        deadline = None if timeout is None else _time.monotonic() + timeout
        stalls = 0
        while True:
            if deadline is None:
                wait_ms = _WAIT_SLICE_MS
            else:
                remaining = deadline - _time.monotonic()
                if remaining <= 0:
                    self._note_dry()
                    return None
                wait_ms = max(1, min(_WAIT_SLICE_MS, int(remaining * 1000)))

            frames = self._pipe.wait_for_frames(wait_ms)
            if frames is None:
                stalls += 1
                if deadline is None and stalls >= _MAX_STALL_SLICES:
                    # stall budget exhausted: treat as end-of-stream. CLOSE so the
                    # next read() re-enumerates and respawns the pipeline —
                    # without this the dead pipeline is waited on forever and
                    # the camera never recovers (the server's no-timeout path
                    # relies on exactly this contract).
                    self._log_pipeline_status()
                    self._note_dry()
                    self.close()
                    return None
                continue  # bounded wait: deadline check at loop top decides
            stalls = 0
            aligned = self._align.process(frames)
            if aligned is None:
                continue
            frameset = aligned.as_frame_set()
            color = frameset.get_color_frame()
            depth = frameset.get_depth_frame()
            if color is None or depth is None:
                continue  # partial set despite FULL_FRAME_REQUIRE; keep going
            try:
                item = self._decode(color, depth)
                self._delivered = True
                self._dry_reads = 0
                return item
            except ValueError:
                # Transiently malformed frame (buffer size != WxH) — the
                # SDK's own aligned example skips these; so do we.
                continue

    def _decode(self, color, depth):
        """SDK frames -> (BGR uint8, metres float32, CameraIntrinsics).

        ``get_data()`` returns a numpy uint8 array in this wheel (raw bytes in
        tests/stubs); ``np.frombuffer`` accepts both via the buffer protocol
        with zero copies — the only copies are the deliberate BGR flip and the
        float32 conversion.
        """
        cw, ch = int(color.get_width()), int(color.get_height())
        pix = np.frombuffer(
            color.get_data(), dtype=np.uint8).reshape(ch, cw, 3)
        if self._color_is_bgr:
            bgr = pix.copy()          # native BGR profile: no channel flip
        else:
            bgr = pix[:, :, ::-1].copy()  # RGB -> BGR without needing cv2

        dw, dh = int(depth.get_width()), int(depth.get_height())
        raw = np.frombuffer(
            depth.get_data(), dtype=np.uint16).reshape(dh, dw)
        # get_depth_scale() maps RAW -> MILLIMETRES; /1000 lands in metres.
        depth_m = raw.astype(np.float32) * (
            float(depth.get_depth_scale()) / 1000.0)

        if self._intrinsics is None:
            rgb_i = self._pipe.get_camera_param().rgb_intrinsic
            # Width/height are taken from the actual aligned frames (depth is
            # aligned to color, so both share the color geometry).
            self._intrinsics = CameraIntrinsics(
                fx=float(rgb_i.fx), fy=float(rgb_i.fy),
                cx=float(rgb_i.cx), cy=float(rgb_i.cy),
                width=cw, height=ch)
        return bgr, depth_m, self._intrinsics


# --------------------------------------------------------------------------- #
# probe CLI: sudo -E python -m gesturewall.orbbec --serial CP0E8530002Y        #
# --------------------------------------------------------------------------- #
def _main(argv=None) -> int:
    """Read a few frames off the real camera and print vital signs."""
    import argparse
    import time

    parser = argparse.ArgumentParser(
        description="Probe an Orbbec Gemini 335: read frames, print "
                    "resolution, fps, center depth, and intrinsics.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--serial", help="match device by serial number")
    group.add_argument("--index", type=int, default=0,
                       help="device enumeration index (default 0)")
    parser.add_argument("--frames", type=int, default=30,
                        help="number of frames to read (default 30)")
    args = parser.parse_args(argv)

    device: int | str = args.serial if args.serial is not None else args.index
    src = OrbbecSource(device_index=device)
    try:
        got = 0
        t_first = t_last = None
        depth_m = intr = None
        for i in range(args.frames):
            item = src.read(timeout=5.0)
            if item is None:
                print(f"timed out waiting for frame {i}", file=sys.stderr)
                break
            color, depth_m, intr = item
            t_last = time.monotonic()
            if t_first is None:
                t_first = t_last
                print(f"color {color.shape[1]}x{color.shape[0]} BGR, "
                      f"depth {depth_m.shape[1]}x{depth_m.shape[0]} m")
            got += 1

        if got == 0:
            print("no frames received", file=sys.stderr)
            return 1
        if got > 1 and t_last > t_first:
            print(f"{got} frames, ~{(got - 1) / (t_last - t_first):.1f} fps")
        h, w = depth_m.shape
        patch = depth_m[h // 2 - 10:h // 2 + 10, w // 2 - 10:w // 2 + 10]
        valid = patch[patch > 0]
        center = float(np.median(valid)) if valid.size else float("nan")
        print(f"center median depth: {center:.3f} m")
        print(f"intrinsics: fx={intr.fx:.2f} fy={intr.fy:.2f} "
              f"cx={intr.cx:.2f} cy={intr.cy:.2f} "
              f"{intr.width}x{intr.height}")
        return 0
    finally:
        src.close()


if __name__ == "__main__":  # pragma: no cover - hardware probe
    raise SystemExit(_main())
