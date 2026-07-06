"""Headless tests for the pure pose policy in gesturewall.multipose.

These drive ``people_from_landmarks`` with hand-built, duck-typed landmark
lists (simple objects exposing x/y/visibility) — no camera, no MediaPipe. We do
NOT instantiate MultiPoseSource here (that needs a webcam).
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from gesturewall.multipose import (
    Person,
    people_from_landmarks,
    person_from_landmarks,
)

# BlazePose indices used by the policy.
NOSE = 0
LEFT_SHOULDER, RIGHT_SHOULDER = 11, 12
LEFT_WRIST, RIGHT_WRIST = 15, 16
LEFT_HIP, RIGHT_HIP = 23, 24


@dataclass
class LM:
    """A duck-typed landmark: just x, y, visibility."""

    x: float
    y: float
    visibility: float = 1.0


def make_body(*, l_shoulder, r_shoulder, l_wrist, r_wrist, l_hip, r_hip,
              nose=(0.5, 0.05, 1.0)):
    """Build a 33-landmark body, filling unused slots with harmless defaults."""
    body = [LM(0.5, 0.5, 1.0) for _ in range(33)]
    body[NOSE] = LM(*nose)
    body[LEFT_SHOULDER] = LM(*l_shoulder)
    body[RIGHT_SHOULDER] = LM(*r_shoulder)
    body[LEFT_WRIST] = LM(*l_wrist)
    body[RIGHT_WRIST] = LM(*r_wrist)
    body[LEFT_HIP] = LM(*l_hip)
    body[RIGHT_HIP] = LM(*r_hip)
    return body


def test_single_person_engaged_right_wrist_raised():
    # Right wrist (x,y) high (small y) above its shoulder, fully visible.
    body = make_body(
        l_shoulder=(0.40, 0.40, 1.0),
        r_shoulder=(0.60, 0.40, 1.0),
        l_wrist=(0.35, 0.55, 1.0),    # lowered (y > shoulder.y)
        r_wrist=(0.65, 0.20, 1.0),    # raised (y < shoulder.y) -> pointing hand
        l_hip=(0.45, 0.80, 1.0),
        r_hip=(0.55, 0.80, 1.0),
    )
    [p] = people_from_landmarks([body], mirror=False)
    assert isinstance(p, Person)
    assert p.engaged is True
    # The higher (smaller-y) wrist is the right wrist.
    assert p.wrist == pytest.approx((0.65, 0.20))
    assert p.shoulder == pytest.approx((0.60, 0.40))


def test_mirror_flips_x_for_wrist_shoulder_anchor():
    body = make_body(
        l_shoulder=(0.40, 0.40, 1.0),
        r_shoulder=(0.60, 0.40, 1.0),
        l_wrist=(0.35, 0.55, 1.0),
        r_wrist=(0.65, 0.20, 1.0),    # pointing hand (raised)
        l_hip=(0.45, 0.80, 1.0),
        r_hip=(0.55, 0.80, 1.0),
    )
    plain = person_from_landmarks(body, mirror=False)
    flipped = person_from_landmarks(body, mirror=True)

    # x mirrored (1 - x) for every stored coordinate; y untouched.
    assert flipped.wrist == pytest.approx((1.0 - plain.wrist[0], plain.wrist[1]))
    assert flipped.shoulder == pytest.approx(
        (1.0 - plain.shoulder[0], plain.shoulder[1]))
    assert flipped.anchor == pytest.approx(
        (1.0 - plain.anchor[0], plain.anchor[1]))
    # Engagement (a raise test on y) is mirror-invariant.
    assert flipped.engaged == plain.engaged is True
    # Same pointing hand is chosen regardless of mirror.
    assert flipped.confidence == pytest.approx(plain.confidence)


def test_low_visibility_wrist_not_engaged():
    # Wrist is geometrically raised, but its visibility is below threshold.
    body = make_body(
        l_shoulder=(0.40, 0.40, 1.0),
        r_shoulder=(0.60, 0.40, 1.0),
        l_wrist=(0.35, 0.55, 1.0),
        r_wrist=(0.65, 0.20, 0.3),    # raised but barely visible (< 0.5)
        l_hip=(0.45, 0.80, 1.0),
        r_hip=(0.55, 0.80, 1.0),
    )
    [p] = people_from_landmarks([body], mirror=False)
    # The right wrist is still the pointing hand (smaller y) but not engaged.
    assert p.wrist == pytest.approx((0.65, 0.20))
    assert p.engaged is False


def test_wrist_below_shoulder_not_engaged():
    # Both wrists lowered (y greater than shoulder.y) -> not engaged.
    body = make_body(
        l_shoulder=(0.40, 0.40, 1.0),
        r_shoulder=(0.60, 0.40, 1.0),
        l_wrist=(0.35, 0.70, 1.0),
        r_wrist=(0.65, 0.60, 1.0),    # higher of the two, still below shoulder
        l_hip=(0.45, 0.80, 1.0),
        r_hip=(0.55, 0.80, 1.0),
    )
    [p] = people_from_landmarks([body], mirror=False)
    assert p.engaged is False


def test_two_people_yield_two_persons_in_order():
    a = make_body(
        l_shoulder=(0.20, 0.40, 1.0),
        r_shoulder=(0.30, 0.40, 1.0),
        l_wrist=(0.18, 0.20, 1.0),    # left wrist raised -> pointing hand
        r_wrist=(0.32, 0.55, 1.0),
        l_hip=(0.22, 0.80, 1.0),
        r_hip=(0.28, 0.80, 1.0),
    )
    b = make_body(
        l_shoulder=(0.70, 0.40, 1.0),
        r_shoulder=(0.80, 0.40, 1.0),
        l_wrist=(0.68, 0.55, 1.0),
        r_wrist=(0.82, 0.18, 1.0),    # right wrist raised -> pointing hand
        l_hip=(0.72, 0.80, 1.0),
        r_hip=(0.78, 0.80, 1.0),
    )
    people = people_from_landmarks([a, b], mirror=False)
    assert len(people) == 2
    # Order preserved; each picks the correct (raised) pointing hand.
    assert people[0].wrist == pytest.approx((0.18, 0.20))
    assert people[1].wrist == pytest.approx((0.82, 0.18))
    assert all(p.engaged for p in people)


def test_anchor_is_hip_midpoint():
    body = make_body(
        l_shoulder=(0.40, 0.40, 1.0),
        r_shoulder=(0.60, 0.40, 1.0),
        l_wrist=(0.35, 0.20, 1.0),
        r_wrist=(0.65, 0.55, 1.0),
        l_hip=(0.30, 0.70, 1.0),
        r_hip=(0.50, 0.90, 1.0),
    )
    [p] = people_from_landmarks([body], mirror=False)
    assert p.anchor == pytest.approx(((0.30 + 0.50) / 2.0, (0.70 + 0.90) / 2.0))


def test_confidence_is_mean_of_wrist_and_both_shoulders():
    # Pointing wrist visibility 0.6, shoulders 0.9 and 0.3 -> mean 0.6.
    body = make_body(
        l_shoulder=(0.40, 0.40, 0.9),
        r_shoulder=(0.60, 0.40, 0.3),
        l_wrist=(0.35, 0.55, 1.0),
        r_wrist=(0.65, 0.20, 0.6),    # raised -> pointing hand
        l_hip=(0.45, 0.80, 1.0),
        r_hip=(0.55, 0.80, 1.0),
    )
    [p] = people_from_landmarks([body], mirror=False)
    assert p.confidence == pytest.approx((0.6 + 0.9 + 0.3) / 3.0)


def test_missing_visibility_defaults_to_full():
    # Landmarks without a `.visibility` attribute count as fully visible (1.0).
    class Bare:
        def __init__(self, x, y):
            self.x = x
            self.y = y

    body = [Bare(0.5, 0.5) for _ in range(33)]
    body[LEFT_SHOULDER] = Bare(0.40, 0.40)
    body[RIGHT_SHOULDER] = Bare(0.60, 0.40)
    body[LEFT_WRIST] = Bare(0.35, 0.55)
    body[RIGHT_WRIST] = Bare(0.65, 0.20)   # raised -> pointing hand
    body[LEFT_HIP] = Bare(0.45, 0.80)
    body[RIGHT_HIP] = Bare(0.55, 0.80)

    [p] = people_from_landmarks([body], mirror=False)
    assert p.engaged is True
    assert p.confidence == pytest.approx(1.0)


def test_empty_frame_yields_no_people():
    assert people_from_landmarks([], mirror=True) == []
