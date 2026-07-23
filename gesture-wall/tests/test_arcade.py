"""Offline tests for the arcade-stick source (no pygame / no physical device).

The pure helpers and the lever/engage readers are tested with a fake joystick;
read() is exercised by constructing an instance without running __init__ (which
would require pygame) and injecting the fake.
"""

from gesturewall.arcade import (
    DEFAULT_DPAD_BUTTONS,
    ArcadeStickSource,
    apply_deadzone,
    clamp01,
    integrate_cursor,
    is_engaged,
    lever_direction,
    pick_joystick_index,
)


# --------------------------------------------------------------------------- #
# Fake joystick (mimics the pygame Joystick reading API)
# --------------------------------------------------------------------------- #
class _FakeJoystick:
    def __init__(self, hat=None, axes=(), pressed=(), nbuttons=20):
        self._hat = hat
        self._axes = list(axes)
        self._buttons = [1 if i in set(pressed) else 0 for i in range(nbuttons)]

    def get_numhats(self):
        return 1 if self._hat is not None else 0

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


UP, DOWN, LEFT, RIGHT = DEFAULT_DPAD_BUTTONS  # 11, 12, 13, 14


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


def test_integrate_cursor_moves_and_clamps():
    assert integrate_cursor((0.0, 0.5), (1.0, 0.0), 0.9, 1.0) == (0.9, 0.5)
    assert integrate_cursor((0.5, 0.0), (0.0, 1.0), 0.5, 1.0) == (0.5, 0.5)
    assert integrate_cursor((0.95, 0.5), (1.0, 0.0), 0.9, 1.0) == (1.0, 0.5)
    assert integrate_cursor((0.05, 0.5), (-1.0, 0.0), 0.9, 1.0) == (0.0, 0.5)
    assert integrate_cursor((0.4, 0.6), (1.0, -1.0), 0.9, 0.0) == (0.4, 0.6)


def test_pick_joystick_index():
    assert pick_joystick_index(["Some Controller", "8BitDo Arcade Stick"]) == 1
    # The stick enumerates as a Switch Pro Controller in S mode.
    assert pick_joystick_index(["Keyboard", "Nintendo Switch Pro Controller"]) == 1
    assert pick_joystick_index(["Xbox Pad", "PS4 Controller"]) == 0
    assert pick_joystick_index([]) is None


# --------------------------------------------------------------------------- #
# Lever direction (D-pad buttons are how the 8BitDo lever reports in S mode)
# --------------------------------------------------------------------------- #
def test_lever_from_dpad_buttons():
    assert lever_direction(_FakeJoystick(pressed=[UP]), 0.4) == (0.0, -1.0)
    assert lever_direction(_FakeJoystick(pressed=[DOWN]), 0.4) == (0.0, 1.0)
    assert lever_direction(_FakeJoystick(pressed=[LEFT]), 0.4) == (-1.0, 0.0)
    assert lever_direction(_FakeJoystick(pressed=[RIGHT]), 0.4) == (1.0, 0.0)
    # Diagonal: up + right.
    assert lever_direction(_FakeJoystick(pressed=[UP, RIGHT]), 0.4) == (1.0, -1.0)


def test_lever_from_analog_axes_with_deadzone():
    # Below deadzone -> ignored.
    assert lever_direction(_FakeJoystick(axes=(0.2, 0.0)), 0.4) == (0.0, 0.0)
    # Above deadzone -> passes through.
    assert lever_direction(_FakeJoystick(axes=(0.9, -0.8)), 0.4) == (0.9, -0.8)


def test_lever_from_hat_is_y_inverted():
    # pygame hat up is +1; screen y should be negative (up).
    assert lever_direction(_FakeJoystick(hat=(0, 1)), 0.4) == (0.0, -1.0)
    assert lever_direction(_FakeJoystick(hat=(-1, 0)), 0.4) == (-1.0, 0.0)


# --------------------------------------------------------------------------- #
# Engagement
# --------------------------------------------------------------------------- #
def test_dpad_buttons_do_not_engage_by_default():
    # Moving the lever (a D-pad button) must NOT engage.
    assert is_engaged(_FakeJoystick(pressed=[UP]), -1) is False
    assert is_engaged(_FakeJoystick(pressed=[LEFT, DOWN]), -1) is False


def test_any_non_lever_button_engages_by_default():
    assert is_engaged(_FakeJoystick(pressed=[0]), -1) is True       # face button
    assert is_engaged(_FakeJoystick(pressed=[9]), -1) is True       # shoulder
    assert is_engaged(_FakeJoystick(pressed=[]), -1) is False
    # A lever button plus a face button still engages (face button counts).
    assert is_engaged(_FakeJoystick(pressed=[UP, 0]), -1) is True


def test_specific_engage_button():
    assert is_engaged(_FakeJoystick(pressed=[1]), 1) is True
    assert is_engaged(_FakeJoystick(pressed=[0]), 1) is False
    assert is_engaged(_FakeJoystick(pressed=[9]), 99) is False  # out of range


# --------------------------------------------------------------------------- #
# read() logic via the fake joystick
# --------------------------------------------------------------------------- #
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
    src._dpad_buttons = DEFAULT_DPAD_BUTTONS
    src._cursor = cursor
    src._last_t = None
    return src


def test_read_first_call_no_frame_and_zero_dt():
    src = _make_source(_FakeJoystick(pressed=[RIGHT]))
    frame, pointer, engaged, info = src.read()
    assert frame is None
    assert pointer == (0.5, 0.5)      # first call dt == 0, no movement yet
    assert engaged is False           # only the lever is pressed
    assert info["source"] == "arcade"


def test_read_dpad_up_moves_cursor_up_over_time():
    src = _make_source(_FakeJoystick(pressed=[UP]))
    src.read()             # seed the clock
    src._last_t -= 1.0     # pretend 1s elapsed
    _, pointer, _, _ = src.read()
    assert pointer[0] == 0.5
    assert pointer[1] < 0.5


def test_read_reports_engaged_on_face_button():
    _, _, engaged, _ = _make_source(_FakeJoystick(pressed=[0])).read()
    assert engaged is True
