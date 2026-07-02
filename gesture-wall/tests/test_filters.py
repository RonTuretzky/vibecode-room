import statistics

import pytest

from gesturewall.filters import OneEuroFilter, Point2DFilter


def test_constant_input_converges_to_constant():
    f = OneEuroFilter(freq=60.0, mincutoff=1.0, beta=0.0)
    out = None
    for i in range(60):
        out = f(5.0, timestamp=i / 60.0)
    assert out == pytest.approx(5.0, abs=1e-6)


def test_first_sample_passes_through():
    f = OneEuroFilter(freq=60.0)
    assert f(3.14, timestamp=0.0) == pytest.approx(3.14)


def test_reduces_jitter_variance():
    # A noisy signal around a constant should come out much smoother.
    import random

    rng = random.Random(0)
    raw, filtered = [], []
    f = OneEuroFilter(freq=60.0, mincutoff=0.5, beta=0.0)
    for i in range(300):
        noisy = 0.5 + rng.uniform(-0.05, 0.05)
        raw.append(noisy)
        filtered.append(f(noisy, timestamp=i / 60.0))
    # Compare the tail (after warm-up).
    assert statistics.pstdev(filtered[50:]) < statistics.pstdev(raw[50:]) * 0.5


def test_tracks_a_ramp():
    # On a steady ramp the output should follow, lagging only slightly.
    f = OneEuroFilter(freq=60.0, mincutoff=1.0, beta=0.01)
    out = 0.0
    for i in range(120):
        out = f(i * 0.01, timestamp=i / 60.0)
    assert out == pytest.approx(1.19, abs=0.1)


def test_point2d_returns_pair():
    f = Point2DFilter()
    x, y = f(0.2, 0.8, timestamp=0.0)
    assert (x, y) == pytest.approx((0.2, 0.8))


@pytest.mark.parametrize("kwargs", [
    {"freq": 0},
    {"freq": -1},
    {"mincutoff": 0},
    {"dcutoff": 0},
])
def test_invalid_params_raise(kwargs):
    with pytest.raises(ValueError):
        OneEuroFilter(**kwargs)
