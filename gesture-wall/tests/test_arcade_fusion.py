"""span_wall: the arcade-fusion bridge's stick→wall-strip mapping.

Pure math only — no pygame, no websockets (both are lazy inside run())."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from arcade_fusion import span_wall  # noqa: E402


def test_single_wall_passes_through():
    assert span_wall(0.0, ["A"]) == ("A", 0.0)
    assert span_wall(0.5, ["A"]) == ("A", 0.5)
    assert span_wall(1.0, ["A"]) == ("A", 1.0)


def test_two_walls_left_half_is_wall_a():
    wall, x = span_wall(0.0, ["A", "B"])
    assert wall == "A" and x == 0.0
    wall, x = span_wall(0.25, ["A", "B"])
    assert wall == "A" and abs(x - 0.5) < 1e-9
    # Just left of the seam: still wall A, near its right edge.
    wall, x = span_wall(0.499, ["A", "B"])
    assert wall == "A" and x > 0.99


def test_two_walls_right_half_is_wall_b():
    wall, x = span_wall(0.5, ["A", "B"])
    assert wall == "B" and abs(x) < 1e-9
    wall, x = span_wall(0.75, ["A", "B"])
    assert wall == "B" and abs(x - 0.5) < 1e-9


def test_full_push_stays_on_last_wall_edge():
    # x01=1.0 must NOT index past the strip: it is wall B's right edge.
    wall, x = span_wall(1.0, ["A", "B"])
    assert wall == "B"
    assert 0.99 < x <= 1.0


def test_crossing_the_seam_is_continuous():
    # Positions just either side of the seam map to adjacent wall edges —
    # the cursor slides off A's right edge onto B's left edge, no jump.
    wall_l, x_l = span_wall(0.5 - 1e-6, ["A", "B"])
    wall_r, x_r = span_wall(0.5 + 1e-6, ["A", "B"])
    assert (wall_l, wall_r) == ("A", "B")
    assert x_l > 0.999 and x_r < 0.001


def test_three_wall_strip():
    assert span_wall(0.1, ["A", "B", "C"])[0] == "A"
    assert span_wall(0.5, ["A", "B", "C"])[0] == "B"
    assert span_wall(0.9, ["A", "B", "C"])[0] == "C"
