"""Arcade-stick input for the gesture wall (8BitDo Arcade Stick, model 80fe).

Why this is its own render loop
-------------------------------
The camera app renders with OpenCV's HighGUI window. On macOS that backend is
itself SDL2-based and collides with pygame's bundled SDL2 (duplicate Obj-C
classes), and — separately — pygame only receives controller input while it owns
a *focused* SDL video window. So the stick cannot be read from inside the
OpenCV app. Instead, arcade mode runs a self-contained **pygame** window that
both draws the wall and reads the stick, reusing the camera app's cv2-free
selection pipeline (:func:`~gesturewall.zones.build_grid`,
:class:`~gesturewall.dwell.DwellSelector`,
:class:`~gesturewall.filters.Point2DFilter`) unchanged.

Interaction
-----------
  * The 8-way lever moves an on-screen cursor. There is no absolute position on
    a stick, so the cursor is *velocity integrated*: hold the lever and it
    glides in that direction at ``speed`` (fraction of the wall per second).
  * Holding a button engages the pointer (like raising your hand in pose mode),
    so the dwell ring fills and toggles the tile under the cursor. Pair with a
    short ``--dwell`` (e.g. ``0.2``) for a snappy, arcade-like feel.

Device notes (discovered empirically on macOS)
----------------------------------------------
Put the stick's mode switch to **S** (Switch); macOS then exposes it via SDL as
a "Nintendo Switch Pro Controller". In that mapping the lever arrives as the
**D-pad buttons** (Up=11, Down=12, Left=13, Right=14) — not a hat or analog axes
— so the lever reader below reads those buttons (and still falls back to a hat
or axes 0/1 for other sticks). macOS also requires the app to be the frontmost
window for input to flow, which the pygame window satisfies.
"""

from __future__ import annotations

import time

from .dwell import DwellSelector
from .filters import Point2DFilter
from .sources import PointerSource
from .zones import build_grid

# Names we treat as "very likely the arcade stick" when auto-selecting a device.
# The 8BitDo stick in Switch mode enumerates as a Switch Pro Controller, so that
# name is included alongside the obvious 8BitDo/arcade hints.
PREFERRED_DEVICE_HINTS = ("8bitdo", "arcade", "80fe", "switch pro", "pro controller")

# Default D-pad button indices for the lever, as (up, down, left, right). Matches
# SDL's Nintendo Switch Pro Controller mapping (verified against the real stick).
DEFAULT_DPAD_BUTTONS = (11, 12, 13, 14)


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


def lever_direction(js, deadzone: float,
                    dpad_buttons: tuple[int, int, int, int] = DEFAULT_DPAD_BUTTONS
                    ) -> tuple[float, float]:
    """Read the lever as a direction vector in [-1, 1] (screen convention).

    Combines three possible encodings so the same code works across stick modes:
    a hat (d-pad), analog axes 0/1, and the four D-pad *buttons* (how the 8BitDo
    stick reports the lever in Switch mode). ``js`` is any object exposing the
    pygame Joystick reading API.
    """
    ax = ay = 0.0
    if js.get_numhats() > 0:
        hx, hy = js.get_hat(0)
        ax += hx
        ay -= hy  # pygame hat +y is up; screen +y is down
    if js.get_numaxes() >= 2:
        ax += apply_deadzone(js.get_axis(0), deadzone)
        ay += apply_deadzone(js.get_axis(1), deadzone)
    n = js.get_numbuttons()
    up, down, left, right = dpad_buttons

    def down_(b: int) -> bool:
        return b is not None and 0 <= b < n and bool(js.get_button(b))

    if down_(up):
        ay -= 1.0
    if down_(down):
        ay += 1.0
    if down_(left):
        ax -= 1.0
    if down_(right):
        ax += 1.0
    return max(-1.0, min(1.0, ax)), max(-1.0, min(1.0, ay))


def is_engaged(js, engage_button: int,
               dpad_buttons: tuple[int, int, int, int] = DEFAULT_DPAD_BUTTONS
               ) -> bool:
    """Whether the pointer is engaged.

    With ``engage_button < 0`` (default) *any* button except the four lever
    (D-pad) buttons engages — forgiving for a stick with many equivalent
    buttons, while making sure moving the lever never counts as engaging.
    Otherwise only the given button index engages.
    """
    n = js.get_numbuttons()
    if n == 0:
        return False
    if engage_button >= 0:
        return bool(engage_button < n and js.get_button(engage_button))
    lever = {b for b in dpad_buttons if b is not None}
    return any(js.get_button(i) for i in range(n) if i not in lever)


# --------------------------------------------------------------------------- #
# The source
# --------------------------------------------------------------------------- #
class ArcadeStickSource(PointerSource):
    """8BitDo Arcade Stick (model 80fe) as a velocity-integrated pointer.

    Reads the stick and returns a wall-coordinate cursor. It does *not* create
    the display window — :func:`run_arcade` owns the pygame window (required on
    macOS for the stick to deliver input). ``read()`` matches the
    :class:`~gesturewall.sources.PointerSource` contract.

    Parameters
    ----------
    index:          joystick index to open. ``None`` auto-selects (prefers a
                    device whose name looks like an 8BitDo/arcade/Switch stick).
    speed:          cursor speed as a fraction of the wall per second when the
                    lever is fully pushed (default 0.9).
    deadzone:       analog readings below this magnitude are ignored (default 0.4).
    engage_button:  button that engages the pointer; ``-1`` (default) = any
                    non-lever button.
    dpad_buttons:   (up, down, left, right) button indices the lever reports on.
    start:          initial cursor position in wall coords (default center).
    """

    def __init__(self, index: int | None = None, speed: float = 0.9,
                 deadzone: float = 0.4, engage_button: int = -1,
                 dpad_buttons: tuple[int, int, int, int] = DEFAULT_DPAD_BUTTONS,
                 start: tuple[float, float] = (0.5, 0.5)):
        try:
            import pygame  # lazy: only this source needs it
        except ImportError as e:  # pragma: no cover - environment dependent
            raise RuntimeError(
                "pygame is required for the arcade-stick source. Install it "
                "with `pip install pygame` (see requirements.txt)."
            ) from e

        self._pygame = pygame
        pygame.init()
        pygame.joystick.init()

        count = pygame.joystick.get_count()
        if count == 0:
            raise RuntimeError(
                "no gamepad/joystick detected. Connect the 8BitDo Arcade Stick "
                "and set its mode switch to S (Switch); on macOS it then appears "
                "as a controller. Then try again.")

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
        self._dpad_buttons = dpad_buttons
        self._cursor = (clamp01(start[0]), clamp01(start[1]))
        self._last_t: float | None = None

    def read(self):
        self._pygame.event.pump()  # refresh the driver's view of the device

        now = time.perf_counter()
        dt = 0.0 if self._last_t is None else max(0.0, now - self._last_t)
        self._last_t = now

        direction = lever_direction(self._js, self._deadzone, self._dpad_buttons)
        self._cursor = integrate_cursor(self._cursor, direction, self._speed, dt)
        engaged = is_engaged(self._js, self._engage_button, self._dpad_buttons)
        info = {"source": "arcade", "device": self._name, "engaged": engaged}
        return None, self._cursor, engaged, info

    def close(self) -> None:
        try:
            self._js.quit()
        finally:
            self._pygame.joystick.quit()


# --------------------------------------------------------------------------- #
# Pygame render loop (arcade mode's self-contained app)
# --------------------------------------------------------------------------- #
# RGB colors (pygame is RGB, unlike the cv2 app's BGR).
_BG = (28, 24, 24)
_ZONE_IDLE = (96, 90, 90)
_ZONE_SELECTED = (70, 170, 70)
_ZONE_ACTIVE = (220, 200, 60)
_TEXT = (235, 235, 235)
_CURSOR = (240, 200, 60)
_RING_BG = (76, 70, 70)
_RING_FG = (240, 220, 60)


def _draw(pygame, screen, font, small, zones, cursor, engaged, selector, fps):
    import math

    w, h = screen.get_size()
    screen.fill(_BG)

    for z in zones:
        rect = pygame.Rect(int(z.x * w), int(z.y * h),
                           int(z.w * w), int(z.h * h))
        is_active = selector.active_zone is z
        if z.selected:
            pygame.draw.rect(screen, _ZONE_SELECTED, rect)
        border = _ZONE_ACTIVE if is_active else (
            _ZONE_SELECTED if z.selected else _ZONE_IDLE)
        pygame.draw.rect(screen, border, rect, 4 if is_active else 2)
        label = font.render(z.label, True, _TEXT)
        screen.blit(label, label.get_rect(center=rect.center))

    # Always draw the cursor so the lever visibly moves it while aiming; the
    # dwell ring only appears while engaged (a button held).
    if cursor is not None:
        cx, cy = int(cursor[0] * w), int(cursor[1] * h)
        if engaged:
            pygame.draw.circle(screen, _RING_BG, (cx, cy), 26, 3)
            if selector.progress > 0:
                ring = pygame.Rect(cx - 26, cy - 26, 52, 52)
                start = math.pi / 2 - 2 * math.pi * selector.progress
                pygame.draw.arc(screen, _RING_FG, ring, start, math.pi / 2, 5)
            pygame.draw.circle(screen, _CURSOR, (cx, cy), 6)
        else:
            # Hollow, dimmer dot when idle (aiming, not yet selecting).
            pygame.draw.circle(screen, (150, 150, 160), (cx, cy), 7, 2)

    status = "ENGAGED" if engaged else "idle - aim with lever, hold a button to select"
    screen.blit(small.render(f"ARCADE STICK | {status} | {fps:4.1f} fps",
                             True, _TEXT), (16, 12))
    screen.blit(small.render("lever = move   hold button = engage   "
                             "q quit   r reset", True, _TEXT), (16, h - 28))


def run_arcade(args) -> None:
    """Self-contained pygame wall driven by the arcade stick."""
    import pygame

    dpad = DEFAULT_DPAD_BUTTONS
    if getattr(args, "stick_dpad", None):
        parts = tuple(int(x) for x in args.stick_dpad.split(","))
        if len(parts) != 4:
            raise SystemExit("--stick-dpad needs four indices: 'up,down,left,right'")
        dpad = parts

    source = ArcadeStickSource(index=args.stick_index, speed=args.stick_speed,
                               deadzone=args.stick_deadzone,
                               engage_button=args.stick_button, dpad_buttons=dpad)

    # The focused SDL window is what lets the stick deliver input on macOS.
    flags = pygame.FULLSCREEN if args.fullscreen else 0
    screen = pygame.display.set_mode((args.width, args.height), flags)
    pygame.display.set_caption("Gesture Wall - Arcade Stick")
    pygame.font.init()
    font = pygame.font.SysFont(None, 40)
    small = pygame.font.SysFont(None, 26)

    zones = build_grid(args.rows, args.cols, padding=args.padding,
                       labels=args.labels.split(",") if args.labels else None)
    selector = DwellSelector(dwell_seconds=args.dwell,
                             cooldown_seconds=args.cooldown,
                             hysteresis=args.hysteresis)
    pfilter = (None if args.no_filter else
               Point2DFilter(mincutoff=args.min_cutoff, beta=args.beta))

    clock = pygame.time.Clock()
    fps = 0.0
    running = True
    try:
        while running:
            for e in pygame.event.get():
                if e.type == pygame.QUIT:
                    running = False
                elif e.type == pygame.KEYDOWN:
                    if e.key in (pygame.K_q, pygame.K_ESCAPE):
                        running = False
                    elif e.key == pygame.K_r:
                        for z in zones:
                            z.selected = False
                        selector.reset()

            t = time.perf_counter()
            _, pointer, engaged, _ = source.read()

            cursor = None
            if pointer is not None:
                wx, wy = pointer
                if pfilter is not None:
                    wx, wy = pfilter(wx, wy, t)
                cursor = (clamp01(wx), clamp01(wy))

            event = selector.update(zones, cursor, t, engaged=engaged)
            if event is not None:
                print(f"[gesturewall] {'SELECT' if event.selected else 'DESELECT'}"
                      f" zone {event.zone_id}")

            _draw(pygame, screen, font, small, zones, cursor, engaged,
                  selector, fps)
            pygame.display.flip()
            clock.tick(60)
            fps = clock.get_fps()
    finally:
        source.close()
        pygame.quit()
