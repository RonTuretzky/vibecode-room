"""Arcade-stick pointer source for the 8BitDo Arcade Stick (model 80fe).

The gesture wall's whole selection pipeline (calibration-free wall coordinates,
1-Euro smoothing, dwell rings, hysteresis, cooldown) is driven by a single
per-frame pointer. This module lets an 8BitDo Arcade Stick drive that pointer,
so the wall can be operated with a physical stick and buttons instead of a
webcam + MediaPipe — handy for demos, accessibility, and testing on a machine
with no camera.

Interaction
-----------
  * The lever (8-way) moves an on-screen cursor. Because there is no absolute
    position on a stick, the cursor is *velocity integrated*: hold the lever and
    the cursor glides in that direction at ``speed`` (fraction of the wall per
    second), clamped to the wall bounds.
  * Holding a button engages the pointer (``engaged=True``), exactly like raising
    your hand in pose mode. Aim with the lever, hold a button over a tile, and
    the dwell ring fills and toggles it. Pair with a short ``--dwell`` (e.g.
    ``--dwell 0.2``) for a snappy, arcade-like feel.

The stick reports directly in wall ([0,1]) coordinates, so — like mouse mode —
it needs no camera calibration; the identity homography is used.

``ArcadeStickSource.read()`` matches the :class:`~gesturewall.sources.PointerSource`
contract: it returns ``(None, (x, y), engaged, info)``.

Device note: the 8BitDo Arcade Stick enumerates as a standard HID gamepad. Put
it in a mode your OS reads as a controller (on macOS the "D-input"/macOS mode
works well) and this source will find it by name. Reading is done through
``pygame`` (installed only for this source; see requirements.txt).
"""

from __future__ import annotations

import time

from .sources import PointerSource

# Names we treat as "very likely the arcade stick" when auto-selecting a device.
PREFERRED_DEVICE_HINTS = ("8bitdo", "arcade", "80fe")


# --------------------------------------------------------------------------- #
# Pure helpers (no pygame) — unit-testable without a physical device.
# --------------------------------------------------------------------------- #
def clamp01(v: float) -> float:
    return min(1.0, max(0.0, v))


def apply_deadzone(value: float, deadzone: float) -> float:
    """Zero out small analog readings so a resting stick does not drift."""
    return 0.0 if abs(value) < deadzone else value


def integrate_cursor(cursor: tuple[float, float], direction: tuple[float, float],
                     speed: float, dt: float) -> tuple[float, float]:
    """Advance the cursor by ``direction * speed * dt``, clamped to the wall.

    ``direction`` components are in [-1, 1] (screen convention: +y is down).
    """
    x, y = cursor
    dx, dy = direction
    return clamp01(x + dx * speed * dt), clamp01(y + dy * speed * dt)


def pick_joystick_index(names: list[str],
                        hints: tuple[str, ...] = PREFERRED_DEVICE_HINTS) -> int | None:
    """Choose which connected joystick to use.

    Prefer the first device whose name matches an arcade-stick hint; otherwise
    fall back to the first joystick. Returns ``None`` when none are connected.
    """
    for i, name in enumerate(names):
        low = name.lower()
        if any(h in low for h in hints):
            return i
    return 0 if names else None


# --------------------------------------------------------------------------- #
# The source
# --------------------------------------------------------------------------- #
class ArcadeStickSource(PointerSource):
    """8BitDo Arcade Stick (model 80fe) as a velocity-integrated pointer.

    Parameters
    ----------
    index:          joystick index to open. ``None`` auto-selects (prefers a
                    device whose name looks like an 8BitDo/arcade stick).
    speed:          cursor speed as a fraction of the wall per second when the
                    lever is fully pushed (default 0.9).
    deadzone:       analog readings with magnitude below this are ignored so a
                    centered stick does not creep (default 0.4).
    engage_button:  button index that engages the pointer. ``-1`` (default) means
                    *any* button engages, which is the most forgiving for a stick
                    with several equivalent buttons.
    start:          initial cursor position in wall coords (default center).
    """

    def __init__(self, index: int | None = None, speed: float = 0.9,
                 deadzone: float = 0.4, engage_button: int = -1,
                 start: tuple[float, float] = (0.5, 0.5)):
        try:
            import pygame  # lazy: only this source needs it
        except ImportError as e:  # pragma: no cover - environment dependent
            raise RuntimeError(
                "pygame is required for the arcade-stick source. Install it "
                "with `pip install pygame` (see requirements.txt)."
            ) from e

        self._pygame = pygame
        # init just the joystick subsystem; avoids opening a video window.
        pygame.init()
        pygame.joystick.init()

        count = pygame.joystick.get_count()
        if count == 0:
            raise RuntimeError(
                "no gamepad/joystick detected. Connect the 8BitDo Arcade Stick "
                "and put it in a controller mode your OS recognizes (macOS/"
                "D-input), then try again.")

        if index is None:
            names = [pygame.joystick.Joystick(i).get_name() for i in range(count)]
            index = pick_joystick_index(names)
        if index is None or not (0 <= index < count):
            raise RuntimeError(
                f"joystick index {index!r} is out of range (found {count} "
                f"device(s)).")

        self._js = pygame.joystick.Joystick(index)
        self._js.init()
        self._name = self._js.get_name()
        print(f"[gesturewall] arcade stick: using '{self._name}' "
              f"(joystick {index})")

        self._speed = float(speed)
        self._deadzone = float(deadzone)
        self._engage_button = int(engage_button)
        self._cursor = (clamp01(start[0]), clamp01(start[1]))
        self._last_t: float | None = None

    # -- lever & buttons ---------------------------------------------------- #
    def _read_lever(self) -> tuple[float, float]:
        """Combine the hat (d-pad) and analog axes into one direction vector.

        The 8-way lever may surface as a hat or as axes 0/1 depending on the
        stick's mode, so we read both and sum them, clamped to [-1, 1]. Screen
        convention has +y pointing down; pygame's hat has +y pointing up, so the
        hat's y is inverted here.
        """
        js = self._js
        ax = ay = 0.0
        if js.get_numhats() > 0:
            hx, hy = js.get_hat(0)
            ax += hx
            ay += -hy
        if js.get_numaxes() >= 2:
            ax += apply_deadzone(js.get_axis(0), self._deadzone)
            ay += apply_deadzone(js.get_axis(1), self._deadzone)
        ax = max(-1.0, min(1.0, ax))
        ay = max(-1.0, min(1.0, ay))
        return ax, ay

    def _read_engaged(self) -> bool:
        js = self._js
        n = js.get_numbuttons()
        if n == 0:
            return False
        if self._engage_button >= 0:
            return bool(self._engage_button < n
                        and js.get_button(self._engage_button))
        return any(js.get_button(i) for i in range(n))

    # -- PointerSource contract --------------------------------------------- #
    def read(self):
        self._pygame.event.pump()  # refresh the driver's view of the device

        now = time.perf_counter()
        dt = 0.0 if self._last_t is None else max(0.0, now - self._last_t)
        self._last_t = now

        direction = self._read_lever()
        self._cursor = integrate_cursor(self._cursor, direction, self._speed, dt)
        engaged = self._read_engaged()
        info = {"source": "arcade", "device": self._name, "engaged": engaged}
        return None, self._cursor, engaged, info

    def close(self) -> None:
        try:
            self._js.quit()
        finally:
            self._pygame.joystick.quit()
            self._pygame.quit()
