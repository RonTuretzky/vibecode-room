#!/usr/bin/env python3
"""Preflight for a Kinect v2 gesture-wall rig — no hardware, no server.

Run from the gesture-wall directory (the same CWD run-room.sh uses):

    .venv/bin/python tools/kinect_preflight.py --config room.kinect.json

Checks, in order:

  1. the room config parses (``RoomConfig``) and reports its mode,
  2. every ``kinect_v2`` camera has the native bridge built and executable
     (``bin/kinect-v2-bridge`` — see ``native/build_kinect_v2.sh``),
  3. the Python deps the server needs actually import
     (cv2, numpy, mediapipe, websockets),
  4. the pose model file exists (missing is a WARNING, not a failure: it
     auto-downloads on first server start, which needs network once).

Exit code 0 = ready to run; 1 = at least one blocking check failed. Every
failure line carries the fix (build command / pip install / config pointer),
because the alternative is discovering these one at a time as per-tick
"camera read error" log spam from a running-but-cursorless server.

The check functions are pure-ish and parameterised (paths / module lists in,
``(ok, message)`` out) so ``tests/test_kinect_preflight.py`` drives them
headlessly; only ``main()`` touches argv and the real environment.
"""

from __future__ import annotations

import argparse
import importlib
import os
import sys
from pathlib import Path

# Make ``gesturewall`` importable when run as a script from anywhere
# (sys.path[0] is tools/, not the gesture-wall root).
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from gesturewall.kinect import DEFAULT_BRIDGE_PATH  # noqa: E402
from gesturewall.room import RoomConfig  # noqa: E402
from gesturewall.sources import POSE_MODEL_URLS  # noqa: E402

# What gesturewall.server actually needs at runtime (requirements.txt).
SERVER_MODULES = ("numpy", "cv2", "mediapipe", "websockets")


def check_config(path: str | Path) -> tuple[bool, str, RoomConfig | None]:
    """Load and validate the room config; report its resolved mode."""
    try:
        cfg = RoomConfig.load(path)
    except ValueError as e:
        return False, f"config {path}: {e}", None
    mode = cfg.mode
    note = ""
    if mode == "homography" and any(
            c.kind == "kinect_v2" for c in cfg.cameras.values()):
        note = (" (kinect camera present but depth geometry incomplete — "
                "run the calibration, e.g. ./run-room.sh --calibrate)")
    return True, f"config {path}: OK, mode={mode}{note}", cfg


def kinect_camera_ids(cfg: RoomConfig) -> list[str]:
    """Ids of cameras that will spawn the Kinect bridge.

    Includes legacy ``"rgb"``-kind cameras only when the room resolves to
    depth mode, mirroring the server/autocal fallback that treats pre-kind
    depth configs as Kinect rooms.
    """
    out = [cid for cid, cam in cfg.cameras.items() if cam.kind == "kinect_v2"]
    if cfg.mode == "depth":
        out += [cid for cid, cam in cfg.cameras.items()
                if cam.kind == "rgb" and cid not in out]
    return out


def check_bridge(bridge_path: str | Path = DEFAULT_BRIDGE_PATH
                 ) -> tuple[bool, str]:
    """Is the native Kinect bridge built and executable?"""
    p = Path(bridge_path)
    if not p.exists():
        return False, (
            f"kinect bridge missing: {p}\n"
            f"    build it: cd {_ROOT} && bash native/build_kinect_v2.sh\n"
            f"    (needs libfreenect2 installed to $HOME/.local — see "
            f"KINECT.md)")
    if not os.access(p, os.X_OK):
        return False, f"kinect bridge not executable: {p} (chmod +x it)"
    return True, f"kinect bridge: OK ({p})"


def check_imports(modules: tuple[str, ...] = SERVER_MODULES
                  ) -> list[tuple[bool, str]]:
    """Actually import each runtime dep (find_spec would miss broken wheels)."""
    results: list[tuple[bool, str]] = []
    for name in modules:
        try:
            importlib.import_module(name)
        except Exception as e:  # noqa: BLE001 - any import failure is a finding
            results.append((False, (
                f"python module {name!r} failed to import: {e}\n"
                f"    fix: .venv/bin/pip install -r requirements.txt")))
        else:
            results.append((True, f"python module {name!r}: OK"))
    return results


def check_model(model_path: str, root: Path = _ROOT) -> tuple[bool, str]:
    """Is the pose model present? Missing is OK online (auto-download).

    Relative paths resolve against the gesture-wall root because run-room.sh
    cds there before starting the server. Always returns ``ok=True`` — a
    missing model is a warning (first start self-heals with network) unless
    the filename has no known download URL, which IS a failure.
    """
    p = Path(model_path)
    if not p.is_absolute():
        p = root / p
    if p.exists():
        return True, f"pose model: OK ({p})"
    url = POSE_MODEL_URLS.get(p.name)
    if url is None:
        return False, (
            f"pose model missing: {p} and its filename has no known download "
            f"URL (known: {sorted(POSE_MODEL_URLS)})")
    return True, (
        f"pose model missing: {p}\n"
        f"    WARNING: it will auto-download on first server start (needs "
        f"network once). Pre-seed offline machines with:\n"
        f"    curl -L -o {p} {url}")


def run_checks(config_path: str | Path,
               bridge_path: str | Path = DEFAULT_BRIDGE_PATH,
               modules: tuple[str, ...] = SERVER_MODULES) -> tuple[bool, list[str]]:
    """All checks against one config. Returns (all_ok, report_lines)."""
    lines: list[str] = []
    ok, msg, cfg = check_config(config_path)
    lines.append(msg)
    all_ok = ok

    if cfg is not None:
        kinects = kinect_camera_ids(cfg)
        if kinects:
            bok, bmsg = check_bridge(bridge_path)
            lines.append(f"{bmsg} (cameras: {', '.join(kinects)})"
                         if bok else bmsg)
            all_ok = all_ok and bok
        else:
            lines.append("no kinect_v2 cameras in this config — bridge check "
                         "skipped")

    for iok, imsg in check_imports(modules):
        lines.append(imsg)
        all_ok = all_ok and iok

    if cfg is not None:
        mok, mmsg = check_model(cfg.server.model)
        lines.append(mmsg)
        all_ok = all_ok and mok

    return all_ok, lines


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Preflight a Kinect v2 gesture-wall setup (headless).")
    ap.add_argument("--config", default=str(_ROOT / "room.json"),
                    help="room config JSON (default: gesture-wall/room.json)")
    ap.add_argument("--bridge", default=DEFAULT_BRIDGE_PATH,
                    help="path to the kinect-v2-bridge binary")
    args = ap.parse_args(argv)

    # SERVER_MODULES is looked up at call time so tests can monkeypatch it.
    ok, lines = run_checks(args.config, bridge_path=args.bridge,
                           modules=SERVER_MODULES)
    for line in lines:
        print(f"  - {line}")
    print(f"[kinect-preflight] {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
