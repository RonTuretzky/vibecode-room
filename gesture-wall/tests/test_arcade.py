"""Offline tests for the arcade-stick source (no pygame / no physical device).

The pure helpers are tested directly; the source's read() logic is exercised by
constructing an instance without running __init__ (which would require pygame)
and injecting a fake joystick + fake pygame module.
"""

from gesturewall.arcade import (
    ArcadeStickSource,
    apply_deadzone,
    clamp01,
    integrate_cursor,
    pick_joystick_index,
)


# --------------------------------------------------------------------------- #
# Pure helpers
# --------------------------------------------------------------------------- #
def test_clamp01_bounds():
    assert clamp01(-0.5) == 0.0
    assert clamp01(1.5) == 1.0
    assert clamp01(0.3) == 0.3


def test_apply_deadzone():
    assert apply_deadzone(0.1, 0.4) == 0.0
    assert apply_deadzone(-0.1, 0.4) == 0.0
    assert apply_deadzone(0.9, 0.4) == 0.9
    assert apply_deadzone(-0.9, 0.4) == -0.9


def test_integrate_cursor_moves_and_clamps():
    # Pushing right for 1s at speed 0.9 advances x by 0.9.
    assert integrate_cursor((0.0, 0.5), (1.0, 0.0), 0.9, 1.0) == (0.9, 0.5)
    # Down is +y (screen convention).
    assert integrate_cursor((0.5, 0.0), (0.0, 1.0), 0.5, 1.0) == (0.5, 0.5)
    # Cannot leave the wall.
    assert integrate_cursor((0.95, 0.5), (1.0, 0.0), 0.9, 1.0) == (1.0, 0.5)
    assert integrate_cursor((0.05, 0.5), (-1.0, 0.0), 0.9, 1.0) == (0.0, 0.5)
    # Zero dt is a no-op.
    assert integrate_cursor((0.4, 0.6), (1.0, -1.0), 0.9, 0.0) == (0.4, 0.6)


def test_pick_joystick_index():
    assert pick_joystick_index(["Some Controller", "8BitDo Arcade Stick"]) == 1
    assert pick_joystick_index(["Xbox Pad", "Generic 80fe Stick"]) == 1
    # No hint match -> first device.
    assert pick_joystick_index(["Xbox Pad", "PS4 Controller"]) == 0
    # Nothing connected -> None.
    assert pick_joystick_index([]) is None


# --------------------------------------------------------------------------- #
# read() logic via a fake joystick
# --------------------------------------------------------------------------- #
class _FakeJoystick:
    def __init__(self, hat=(0, 0), axes=(0.0, 0.0), buttons=()):
        self._hat = hat
        self._axes = list(axes)
        self._buttons = list(buttons)

    def get_numhats(self):
        return 1

    def get_hat(self, _i):
        return self._hat

    def get_numaxes(self):
        return len(self._axes)

    def get_axis(self, i):
        return self._axes[i]

    def get_numbuttons(self):
        return len(self._buttons)

    def get_button(self, i):
        return self._buttons[i]


class _FakePygame:
    class event:  # noqa: N801 - mimic pygame.event.pump
        @staticmethod
        def pump():
            pass


def _make_source(js, *, speed=0.9, deadzone=0.4, engage_button=-1,
                 cursor=(0.5, 0.5)):
    src = ArcadeStickSource.__new__(ArcadeStickSource)  # skip __init__ (no pygame)
    src._pygame = _FakePygame
    src._js = js
    src._name = "fake"
    src._speed = speed
    src._deadzone = deadzone
    src._engage_button = engage_button
    src._cursor = cursor
    src._last_t = None
    return src


def test_read_first_call_has_zero_dt_and_no_frame():
    src = _make_source(_FakeJoystick(hat=(1, 0)))
    frame, pointer, engaged, info = src.read()
    # No camera frame; pointer at the start position (first call dt == 0).
    assert frame is None
    assert pointer == (0.5, 0.5)
    assert engaged is False
    assert info["source"] == "arcade"


def test_hat_up_moves_cursor_up_after_time_passes():
    # Hat "up" is (0, +1) in pygame; screen y should decrease.
    src = _make_source(_FakeJoystick(hat=(0, 1)))
    src.read()                 # first call seeds the clock (dt == 0)
    src._last_t -= 1.0         # simulate 1 second having elapsed
    _, pointer, _, _ = src.read()
    assert pointer[0] == 0.5
    assert pointer[1] < 0.5    # moved up the wall


def test_axis_within_deadzone_is_ignored():
    src = _make_source(_FakeJoystick(axes=(0.2, 0.0)))  # below 0.4 deadzone
    src.read()
    src._last_t -= 1.0
    _, pointer, _, _ = src.read()
    assert pointer == (0.5, 0.5)


def test_any_button_engages_by_default():
    src = _make_source(_FakeJoystick(buttons=(0, 0, 1)))
    _, _, engaged, _ = src.read()
    assert engaged is True

    src = _make_source(_FakeJoystick(buttons=(0, 0, 0)))
    _, _, engaged, _ = src.read()
    assert engaged is False


def test_specific_engage_button():
    js = _FakeJoystick(buttons=(0, 1, 0))
    src = _make_source(js, engage_button=1)
    _, _, engaged, _ = src.read()
    assert engaged is True

    src = _make_source(js, engage_button=0)
    _, _, engaged, _ = src.read()
    assert engaged is False

    # Out-of-range engage button never engages.
    src = _make_source(js, engage_button=9)
    _, _, engaged, _ = src.read()
    assert engaged is False
