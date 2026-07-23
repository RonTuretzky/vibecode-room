"""Regression: border registration-fringe flicker must not trip the ambiguity gate.

Live failure (single-wall Kinect rig, camera ~2.9 m from the wall): the disc
blob scored ~88 while 6-11 px flicker blobs on the extreme frame edges scored
89-97% of peak — detect_marker returned None for EVERY marker even though the
disc was plainly the dominant blob. The fix zeros a resolution-scaled border
band of the score map before blob analysis.
"""
import numpy as np

from gesturewall.autocal import detect_marker


def _disc(img, cx, cy, r, bgr):
    yy, xx = np.mgrid[:img.shape[0], :img.shape[1]]
    m = (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r
    img[m] = bgr


def test_edge_fringe_blobs_do_not_kill_the_disc():
    h, w = 424, 512
    off = np.full((h, w, 3), 10, np.uint8)
    on = off.copy()
    # The real marker: a magenta disc lifting R+B by ~90 over a 30 px radius.
    _disc(on, 300, 200, 30, (100, 10, 100))
    # Border fringe: small bright flickers hugging the frame edges, scoring
    # near (even slightly above) the disc's per-pixel delta.
    for (fx, fy) in [(2, 100), (3, 300), (509, 80), (508, 350), (200, 2), (400, 421)]:
        _disc(on, fx, fy, 4, (115, 10, 115))
    res = detect_marker(off, on)
    assert res is not None, "edge fringe blobs tripped the ambiguity gate"
    px, py, _peak = res
    assert abs(px - 300) < 10 and abs(py - 200) < 10


def test_two_real_interior_blobs_still_ambiguous():
    h, w = 424, 512
    off = np.full((h, w, 3), 10, np.uint8)
    on = off.copy()
    _disc(on, 150, 200, 30, (100, 10, 100))
    _disc(on, 380, 220, 30, (98, 10, 98))  # second, nearly-as-bright interior blob
    assert detect_marker(off, on) is None


def test_speck_just_inside_border_band_is_not_a_rival():
    # The live killer: a ~7 px flicker blob at x=8-14 (just past the masked
    # border band) scoring ~92% of the disc's peak. Area-comparability must
    # reject it as a competitor.
    h, w = 424, 512
    off = np.full((h, w, 3), 10, np.uint8)
    on = off.copy()
    _disc(on, 300, 200, 30, (100, 10, 100))
    # ~94% of the disc's per-pixel delta, like the live 89-97% fringe scores.
    _disc(on, 12, 150, 4, (95, 10, 95))
    res = detect_marker(off, on)
    assert res is not None
    assert abs(res[0] - 300) < 10
