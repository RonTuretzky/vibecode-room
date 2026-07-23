"""Unit tests for the pure pinch/frame-encoding math in the standalone
MediaPipe hand bridge (touchdesigner/hands_mediapipe.py).

The module is loaded by absolute path so these tests never import
cv2/mediapipe/websockets or touch a camera — the heavy deps are lazy-imported
only inside the runtime paths, which are not exercised here.
"""

import importlib.util
import json
import math
import pathlib

import pytest

_MOD_PATH = (pathlib.Path(__file__).resolve().parents[1]
             / "touchdesigner" / "hands_mediapipe.py")
_spec = importlib.util.spec_from_file_location("hands_mediapipe", _MOD_PATH)
hm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hm)


# --------------------------------------------------------------------------- #
# distance / scale / pinch                                                     #
# --------------------------------------------------------------------------- #
def test_dist_applies_aspect_to_x_only():
    # Pure horizontal separation is stretched by aspect; vertical is not.
    assert hm._dist((0.0, 0.5), (1.0, 0.5), aspect=2.0) == pytest.approx(2.0)
    assert hm._dist((0.5, 0.0), (0.5, 1.0), aspect=2.0) == pytest.approx(1.0)


def test_hand_scale_is_wrist_to_middle_mcp():
    lm = hm.synthetic_landmarks(pinched=False)
    expected = hm._dist(lm[hm.WRIST], lm[hm.MIDDLE_MCP], aspect=1.5)
    assert hm.hand_scale(lm, 1.5) == pytest.approx(expected)


def test_pinch_smaller_when_pinched():
    aspect = 640 / 480
    open_ratio = hm.pinch_ratio(hm.synthetic_landmarks(pinched=False), aspect)
    pinch_ratio = hm.pinch_ratio(hm.synthetic_landmarks(pinched=True), aspect)
    assert pinch_ratio < hm.PINCH_ON        # would engage the latch
    assert open_ratio > hm.PINCH_OFF        # would release the latch
    assert pinch_ratio < open_ratio


def test_pinch_ratio_is_capped():
    # Thumb and index flung to opposite corners -> huge raw ratio, capped.
    lm = list(hm.synthetic_landmarks(pinched=False))
    lm[hm.THUMB_TIP] = (0.0, 0.0)
    lm[hm.INDEX_TIP] = (1.0, 1.0)
    assert hm.pinch_ratio(lm, 1.0) == pytest.approx(hm.PINCH_CAP)


def test_pinch_ratio_zero_scale_returns_cap():
    # Wrist coincident with middle-MCP -> degenerate scale -> cap, no divide-by-0.
    lm = list(hm.synthetic_landmarks(pinched=False))
    lm[hm.MIDDLE_MCP] = lm[hm.WRIST]
    assert hm.pinch_ratio(lm, 1.0) == hm.PINCH_CAP


# --------------------------------------------------------------------------- #
# palm center / cursor anchor                                                  #
# --------------------------------------------------------------------------- #
def test_palm_center_is_centroid_of_palm_landmarks():
    lm = hm.synthetic_landmarks(pinched=False)
    xs = [lm[i][0] for i in hm.PALM_LANDMARKS]
    ys = [lm[i][1] for i in hm.PALM_LANDMARKS]
    cx, cy = hm.palm_center(lm)
    assert cx == pytest.approx(sum(xs) / len(xs))
    assert cy == pytest.approx(sum(ys) / len(ys))


def test_palm_center_unchanged_by_pinch():
    # The cursor anchor must NOT move when you pinch (palm knuckles are rigid).
    assert hm.palm_center(hm.synthetic_landmarks(False)) == \
        hm.palm_center(hm.synthetic_landmarks(True))


# --------------------------------------------------------------------------- #
# mirroring                                                                    #
# --------------------------------------------------------------------------- #
def test_mirror_flips_x():
    lm = hm.synthetic_landmarks(pinched=False)
    cx, _ = hm.palm_center(lm)
    mirrored = hm.encode_hand(lm, 1, "Right", 1.0, 1.5, mirror=True)
    assert mirrored["x"] == pytest.approx(round(1.0 - cx, 4))


def test_no_mirror_keeps_x():
    lm = hm.synthetic_landmarks(pinched=False)
    cx, _ = hm.palm_center(lm)
    plain = hm.encode_hand(lm, 1, "Right", 1.0, 1.5, mirror=False)
    assert plain["x"] == pytest.approx(round(cx, 4))


def test_y_is_never_flipped():
    lm = hm.synthetic_landmarks(pinched=False)
    _, cy = hm.palm_center(lm)
    for mirror in (True, False):
        assert hm.encode_hand(lm, 1, "Right", 1.0, 1.5, mirror=mirror)["y"] == \
            pytest.approx(round(cy, 4))


# --------------------------------------------------------------------------- #
# hysteresis latch                                                             #
# --------------------------------------------------------------------------- #
def test_latch_engages_below_on_threshold():
    assert hm.latch_pinch(False, hm.PINCH_ON - 0.01) is True
    assert hm.latch_pinch(False, hm.PINCH_ON + 0.01) is False


def test_latch_stays_in_dead_band():
    # Between ON and OFF: keep whatever the previous state was.
    mid = (hm.PINCH_ON + hm.PINCH_OFF) / 2
    assert hm.latch_pinch(True, mid) is True
    assert hm.latch_pinch(False, mid) is False


def test_latch_releases_above_off_threshold():
    assert hm.latch_pinch(True, hm.PINCH_OFF + 0.01) is False
    assert hm.latch_pinch(True, hm.PINCH_OFF - 0.01) is True


def test_pinch_state_resets_latch_when_hand_leaves():
    state = hm.PinchState()
    # Hand 1 pinches...
    assert state.update(1, hm.PINCH_ON - 0.05) is True
    # ...then leaves this tick (only hand 2 active) -> its latch must reset.
    state.retain({2})
    # A half-open re-entry (dead band) must NOT inherit the old latched True.
    assert state.update(1, (hm.PINCH_ON + hm.PINCH_OFF) / 2) is False


# --------------------------------------------------------------------------- #
# id assignment                                                                #
# --------------------------------------------------------------------------- #
def test_assign_ids_left_prefers_1_right_prefers_2():
    assert hm.assign_hand_ids(["Right", "Left"]) == [2, 1]
    assert hm.assign_hand_ids(["Left", "Right"]) == [1, 2]


def test_assign_ids_single_hand_is_stable_by_handedness():
    assert hm.assign_hand_ids(["Right"]) == [2]
    assert hm.assign_hand_ids(["Left"]) == [1]


def test_assign_ids_collision_falls_back_to_free_slot():
    ids = hm.assign_hand_ids(["Left", "Left"])
    assert ids[0] == 1
    assert ids[1] != ids[0]           # distinct so the browser sees two hands
    assert len(set(ids)) == 2


def test_assign_ids_unknown_label_gets_free_slot():
    ids = hm.assign_hand_ids([None, "Right"])
    assert ids[1] == 2
    assert ids[0] == 1                # lowest free slot
    assert len(set(ids)) == 2


# --------------------------------------------------------------------------- #
# per-hand encode: shape, ranges, clamping                                     #
# --------------------------------------------------------------------------- #
def test_encode_hand_shape_and_types():
    hnd = hm.encode_hand(hm.synthetic_landmarks(False), 1, "Right", 0.9, 1.5,
                         mirror=True, pinching=True)
    assert set(hnd) == {"id", "hand", "x", "y", "pinch", "pinching", "conf"}
    assert isinstance(hnd["id"], int)
    assert hnd["hand"] == "Right"
    assert isinstance(hnd["pinching"], bool) and hnd["pinching"] is True
    assert 0.0 <= hnd["x"] <= 1.0 and 0.0 <= hnd["y"] <= 1.0
    assert 0.0 <= hnd["pinch"] <= hm.PINCH_CAP
    assert 0.0 <= hnd["conf"] <= 1.0


def test_encode_hand_null_handedness_for_unknown_label():
    hnd = hm.encode_hand(hm.synthetic_landmarks(False), 1, None, 1.0, 1.5)
    assert hnd["hand"] is None
    hnd2 = hm.encode_hand(hm.synthetic_landmarks(False), 1, "banana", 1.0, 1.5)
    assert hnd2["hand"] is None


def test_encode_hand_clamps_position_out_of_frame():
    lm = [(9.0, -9.0)] * 21     # everything way off-frame
    hnd = hm.encode_hand(lm, 1, "Left", 5.0, 1.0, mirror=False)
    assert hnd["x"] == 1.0 and hnd["y"] == 0.0     # clamped to [0,1]
    assert hnd["conf"] == 1.0                       # conf clamped to [0,1]


def test_encode_hand_accepts_object_landmarks():
    # Runtime passes MediaPipe NormalizedLandmark objects (.x/.y), not tuples.
    class LM:
        def __init__(self, x, y):
            self.x, self.y, self.z = x, y, 0.0

    tup = hm.synthetic_landmarks(False)
    objs = [LM(x, y) for (x, y) in tup]
    a = hm.encode_hand(tup, 1, "Right", 1.0, 1.5)
    b = hm.encode_hand(objs, 1, "Right", 1.0, 1.5)
    assert a == b


# --------------------------------------------------------------------------- #
# whole-frame encode + wire format                                            #
# --------------------------------------------------------------------------- #
def test_encode_hands_assigns_ids_and_two_entries():
    detections = [
        (hm.synthetic_landmarks(False), "Right", 0.97),
        (hm.synthetic_landmarks(True), "Left", 0.91),
    ]
    hands = hm.encode_hands(detections, 1.5, hm.PinchState(), mirror=True)
    assert [h["id"] for h in hands] == [2, 1]
    assert hands[0]["pinching"] is False    # open (Right)
    assert hands[1]["pinching"] is True     # pinched (Left)


def test_encode_frame_structure_and_empty_hands():
    frame = hm.encode_frame(12.5, 1.7778, [])
    assert frame["type"] == "hands"
    assert frame["t"] == pytest.approx(12.5)
    assert frame["aspect"] == pytest.approx(1.7778)
    assert frame["hands"] == []
    assert "wall" not in frame              # wall omitted when unset


def test_encode_frame_tags_wall_when_set():
    assert hm.encode_frame(0.0, 1.5, [], wall="A")["wall"] == "A"
    assert "wall" not in hm.encode_frame(0.0, 1.5, [], wall=None)


def test_encode_frame_bad_aspect_falls_back_to_16_9():
    assert hm.encode_frame(0.0, 0.0, [])["aspect"] == pytest.approx(round(16 / 9, 4))
    assert hm.encode_frame(0.0, -3.0, [])["aspect"] == pytest.approx(round(16 / 9, 4))


def test_frame_to_json_is_compact_and_roundtrips():
    frame = hm.encode_frame(
        1.0, 1.5,
        hm.encode_hands([(hm.synthetic_landmarks(True), "Left", 0.9)],
                        1.5, hm.PinchState()),
        wall="B")
    payload = hm.frame_to_json(frame)
    assert " " not in payload               # compact (separators without spaces)
    assert json.loads(payload) == frame     # lossless


def test_frame_matches_browser_contract_ranges():
    # Mirror what src/ui/gesture/hands-client.ts coerceHand() requires.
    detections = [
        (hm.synthetic_landmarks(False), "Right", 0.98),
        (hm.synthetic_landmarks(True), "Left", 0.93),
    ]
    frame = hm.encode_frame(
        2.0, 640 / 480,
        hm.encode_hands(detections, 640 / 480, hm.PinchState()), wall="A")
    parsed = json.loads(hm.frame_to_json(frame))
    assert parsed["type"] == "hands"
    assert isinstance(parsed["t"], (int, float))
    assert math.isfinite(parsed["aspect"]) and parsed["aspect"] > 0
    for h in parsed["hands"]:
        assert isinstance(h["id"], int)
        assert h["hand"] in ("Left", "Right", None)
        assert 0.0 <= h["x"] <= 1.0 and 0.0 <= h["y"] <= 1.0
        assert 0.0 <= h["pinch"] <= 4.0     # browser clamps to [0,4]
        assert isinstance(h["pinching"], bool)
        assert 0.0 <= h["conf"] <= 1.0


# --------------------------------------------------------------------------- #
# the in-module selftest passes                                               #
# --------------------------------------------------------------------------- #
def test_run_selftest_passes():
    assert hm.run_selftest() is True
