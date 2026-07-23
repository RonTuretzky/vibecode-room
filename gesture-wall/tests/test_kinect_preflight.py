"""Headless tests for tools/kinect_preflight.py (no hardware, no server).

The preflight tool is a plain script (not part of the ``gesturewall``
package), so it is loaded from its file path. Its check functions are
parameterised — paths and module lists in, ``(ok, message)`` out — which lets
every branch (missing bridge, broken import, invalid config, missing model)
be driven with tmp_path fixtures and harmless module names. The heavyweight
real deps (cv2/mediapipe) are never imported here.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

TOOL_PATH = (Path(__file__).resolve().parent.parent
             / "tools" / "kinect_preflight.py")


def _load_tool():
    spec = importlib.util.spec_from_file_location("kinect_preflight", TOOL_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


pf = _load_tool()

MINIMAL_KINECT_CONFIG = {
    "walls": {"A": {"display": 1, "grid": {"rows": 2, "cols": 3},
                    "width_m": 2.1}},
    "cameras": {"cam0": {"device": "012843433747", "kind": "kinect_v2",
                         "serves": []}},
}


def write_config(tmp_path: Path, data: dict) -> Path:
    p = tmp_path / "room.kinect.json"
    p.write_text(json.dumps(data))
    return p


def write_bridge(tmp_path: Path, executable: bool = True) -> Path:
    p = tmp_path / "kinect-v2-bridge"
    p.write_text("#!/bin/sh\nexit 0\n")
    p.chmod(0o755 if executable else 0o644)
    return p


# --------------------------------------------------------------------------- #
# check_bridge                                                                #
# --------------------------------------------------------------------------- #
def test_check_bridge_missing_names_the_build_script(tmp_path):
    ok, msg = pf.check_bridge(tmp_path / "kinect-v2-bridge")
    assert ok is False
    assert "build_kinect_v2.sh" in msg


def test_check_bridge_not_executable(tmp_path):
    bridge = write_bridge(tmp_path, executable=False)
    ok, msg = pf.check_bridge(bridge)
    assert ok is False
    assert "not executable" in msg


def test_check_bridge_ok(tmp_path):
    bridge = write_bridge(tmp_path)
    ok, msg = pf.check_bridge(bridge)
    assert ok is True
    assert "OK" in msg


# --------------------------------------------------------------------------- #
# check_imports                                                               #
# --------------------------------------------------------------------------- #
def test_check_imports_reports_ok_and_missing():
    results = pf.check_imports(("json", "definitely_not_a_module_xyz"))
    assert results[0][0] is True
    assert results[1][0] is False
    assert "requirements.txt" in results[1][1]


# --------------------------------------------------------------------------- #
# check_config / kinect_camera_ids                                            #
# --------------------------------------------------------------------------- #
def test_check_config_valid_precal_kinect(tmp_path):
    cfg_path = write_config(tmp_path, MINIMAL_KINECT_CONFIG)
    ok, msg, cfg = pf.check_config(cfg_path)
    assert ok is True
    assert "mode=homography" in msg
    # Pre-calibration kinect configs get a run-the-calibration nudge.
    assert "calibrat" in msg
    assert cfg is not None
    assert pf.kinect_camera_ids(cfg) == ["cam0"]


def test_check_config_invalid(tmp_path):
    cfg_path = write_config(tmp_path, {"walls": {}})
    ok, msg, cfg = pf.check_config(cfg_path)
    assert ok is False
    assert cfg is None


def test_check_config_missing_file(tmp_path):
    ok, msg, cfg = pf.check_config(tmp_path / "nope.json")
    assert ok is False
    assert cfg is None


def test_kinect_camera_ids_ignores_plain_webcams(tmp_path):
    data = {
        "walls": {"A": {"display": 1, "grid": {"rows": 2, "cols": 3}}},
        "cameras": {"cam0": {"device": 0, "serves": []}},  # kind rgb (default)
    }
    _, _, cfg = pf.check_config(write_config(tmp_path, data))
    assert pf.kinect_camera_ids(cfg) == []


def test_kinect_camera_ids_includes_legacy_rgb_depth_config(tmp_path):
    # Pre-kind depth configs (kind absent -> "rgb" + full depth geometry) are
    # historically Kinect rooms; server/autocal fall back to the kinect
    # source, so the preflight must check the bridge for them too.
    data = {
        "walls": {"A": {"display": 1, "grid": {"rows": 2, "cols": 3},
                        "plane": {"origin": [0.0, 2.0, 3.0],
                                  "u_vec": [2.0, 0.0, 0.0],
                                  "v_vec": [0.0, -2.0, 0.0]}}},
        "cameras": {"cam0": {
            "device": 0, "serves": ["A"],
            "intrinsics": {"fx": 365.0, "fy": 365.0, "cx": 256.0, "cy": 212.0,
                           "width": 512, "height": 424},
            "extrinsic": {"matrix": [[1.0, 0.0, 0.0, 0.0],
                                     [0.0, 1.0, 0.0, 0.0],
                                     [0.0, 0.0, 1.0, 0.0],
                                     [0.0, 0.0, 0.0, 1.0]]}}},
    }
    _, _, cfg = pf.check_config(write_config(tmp_path, data))
    assert cfg.mode == "depth"
    assert pf.kinect_camera_ids(cfg) == ["cam0"]


# --------------------------------------------------------------------------- #
# check_model                                                                 #
# --------------------------------------------------------------------------- #
def test_check_model_present(tmp_path):
    model = tmp_path / "models" / "pose_landmarker_full.task"
    model.parent.mkdir()
    model.write_bytes(b"fake-model")
    ok, msg = pf.check_model(str(model))
    assert ok is True
    assert "OK" in msg


def test_check_model_missing_known_name_warns_with_url(tmp_path):
    ok, msg = pf.check_model("models/pose_landmarker_full.task",
                             root=tmp_path)
    assert ok is True  # auto-downloads on first start: warning, not failure
    assert "storage.googleapis.com" in msg
    assert "network" in msg


def test_check_model_missing_unknown_name_fails(tmp_path):
    ok, msg = pf.check_model("models/not_a_pose_model.task", root=tmp_path)
    assert ok is False


# --------------------------------------------------------------------------- #
# run_checks / main                                                           #
# --------------------------------------------------------------------------- #
def test_run_checks_pass(tmp_path):
    cfg_path = write_config(tmp_path, MINIMAL_KINECT_CONFIG)
    bridge = write_bridge(tmp_path)
    ok, lines = pf.run_checks(cfg_path, bridge_path=bridge, modules=("json",))
    assert ok is True
    assert any("mode=homography" in ln for ln in lines)
    assert any("kinect bridge: OK" in ln for ln in lines)


def test_run_checks_fails_without_bridge(tmp_path):
    cfg_path = write_config(tmp_path, MINIMAL_KINECT_CONFIG)
    ok, lines = pf.run_checks(cfg_path,
                              bridge_path=tmp_path / "missing-bridge",
                              modules=("json",))
    assert ok is False
    assert any("build_kinect_v2.sh" in ln for ln in lines)


def test_run_checks_skips_bridge_for_non_kinect_config(tmp_path):
    data = {
        "walls": {"A": {"display": 1, "grid": {"rows": 2, "cols": 3}}},
        "cameras": {"cam0": {"device": 0, "serves": []}},
    }
    cfg_path = write_config(tmp_path, data)
    ok, lines = pf.run_checks(cfg_path,
                              bridge_path=tmp_path / "missing-bridge",
                              modules=("json",))
    assert ok is True  # a missing bridge cannot fail a bridge-less rig
    assert any("skipped" in ln for ln in lines)


def test_main_exit_codes(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(pf, "SERVER_MODULES", ("json",))
    cfg_path = write_config(tmp_path, MINIMAL_KINECT_CONFIG)
    bridge = write_bridge(tmp_path)

    assert pf.main(["--config", str(cfg_path), "--bridge", str(bridge)]) == 0
    assert "PASS" in capsys.readouterr().out

    missing = tmp_path / "missing-bridge"
    assert pf.main(["--config", str(cfg_path), "--bridge", str(missing)]) == 1
    assert "FAIL" in capsys.readouterr().out
