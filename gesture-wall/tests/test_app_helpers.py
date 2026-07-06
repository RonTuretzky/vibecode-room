"""Tests for app drawing helpers that touch real arrays (needs numpy + cv2)."""

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from gesturewall.app import _embed_preview, _quad_area  # noqa: E402


def test_embed_preview_tall_frame_no_crash():
    canvas = np.zeros((240, 320, 3), np.uint8)
    tall = np.full((1280, 200, 3), 200, np.uint8)   # ~6.4:1 portrait
    _embed_preview(cv2, canvas, tall)               # must not raise


def test_embed_preview_small_canvas_no_crash():
    canvas = np.zeros((80, 120, 3), np.uint8)       # narrower than target_w=240
    frame = np.full((480, 640, 3), 200, np.uint8)
    _embed_preview(cv2, canvas, frame)              # must not raise


def test_embed_preview_zero_size_is_noop():
    canvas = np.zeros((240, 320, 3), np.uint8)
    _embed_preview(cv2, canvas, np.zeros((0, 0, 3), np.uint8))
    assert canvas.max() == 0


def test_embed_preview_draws_when_it_fits():
    canvas = np.zeros((480, 640, 3), np.uint8)
    frame = np.full((240, 320, 3), 255, np.uint8)
    _embed_preview(cv2, canvas, frame)
    assert canvas.max() > 0                         # something was embedded


def test_quad_area():
    assert _quad_area([(0, 0), (1, 0), (1, 1), (0, 1)]) == pytest.approx(1.0)
    assert _quad_area([(0.5, 0.5)] * 4) == pytest.approx(0.0)
