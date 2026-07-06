"""Signal smoothing for a jittery mid-air cursor.

Implements the **1-Euro filter** (Casiez, Roussel & Vogel, CHI 2012,
https://gery.casiez.net/1euro/): an adaptive low-pass filter that removes
jitter when the input is slow/still (low cutoff) but cuts lag when the input
moves fast (high cutoff). This is the recommended smoother for freehand
pointing — it keeps the cursor calm on a held hand without feeling laggy when
you sweep across the wall.

Pure-Python, no third-party dependencies, so this module is unit-testable
without OpenCV/MediaPipe installed.
"""

from __future__ import annotations

import math


class LowPassFilter:
    """Exponential low-pass filter with a settable smoothing factor `alpha`."""

    def __init__(self, alpha: float):
        self._set_alpha(alpha)
        self._y: float | None = None      # last raw value
        self._s: float | None = None      # last smoothed value

    def _set_alpha(self, alpha: float) -> None:
        if not (0.0 < alpha <= 1.0):
            raise ValueError(f"alpha must be in (0, 1], got {alpha}")
        self._alpha = alpha

    def __call__(self, value: float, alpha: float | None = None) -> float:
        if alpha is not None:
            self._set_alpha(alpha)
        if self._s is None:
            s = value                      # first sample: pass through
        else:
            s = self._alpha * value + (1.0 - self._alpha) * self._s
        self._y = value
        self._s = s
        return s

    def last(self) -> float | None:
        return self._s


class OneEuroFilter:
    """1-Euro filter for a single scalar channel.

    Parameters
    ----------
    freq:       initial sampling frequency (Hz). Refined automatically from the
                timestamps you pass to ``__call__``.
    mincutoff:  minimum cutoff frequency (Hz). Lower = more smoothing of a still
                hand (more jitter removed) but more lag. Start ~1.0.
    beta:       speed coefficient. Higher = less lag on fast motion (cutoff
                rises with speed). Start ~0.0 then raise until fast motion is
                responsive. Typical 0.001 - 0.05 for normalized [0,1] signals.
    dcutoff:    cutoff for the derivative used to estimate speed. Usually 1.0.
    """

    def __init__(self, freq: float = 60.0, mincutoff: float = 1.0,
                 beta: float = 0.0, dcutoff: float = 1.0):
        if freq <= 0:
            raise ValueError("freq must be > 0")
        if mincutoff <= 0:
            raise ValueError("mincutoff must be > 0")
        if dcutoff <= 0:
            raise ValueError("dcutoff must be > 0")
        self._freq = float(freq)
        self._mincutoff = float(mincutoff)
        self._beta = float(beta)
        self._dcutoff = float(dcutoff)
        self._x = LowPassFilter(self._alpha(self._mincutoff))
        self._dx = LowPassFilter(self._alpha(self._dcutoff))
        self._lasttime: float | None = None

    def _alpha(self, cutoff: float) -> float:
        te = 1.0 / self._freq
        tau = 1.0 / (2.0 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / te)

    def __call__(self, x: float, timestamp: float | None = None) -> float:
        # Update the sampling frequency from the elapsed wall-clock time.
        if (self._lasttime is not None and timestamp is not None
                and timestamp > self._lasttime):
            self._freq = 1.0 / (timestamp - self._lasttime)
        self._lasttime = timestamp

        prev = self._x.last()
        dx = 0.0 if prev is None else (x - prev) * self._freq
        edx = self._dx(dx, self._alpha(self._dcutoff))
        cutoff = self._mincutoff + self._beta * abs(edx)
        return self._x(x, self._alpha(cutoff))


class Point2DFilter:
    """Convenience wrapper: an independent 1-Euro filter per axis (x, y)."""

    def __init__(self, freq: float = 60.0, mincutoff: float = 1.0,
                 beta: float = 0.007, dcutoff: float = 1.0):
        self._fx = OneEuroFilter(freq, mincutoff, beta, dcutoff)
        self._fy = OneEuroFilter(freq, mincutoff, beta, dcutoff)

    def __call__(self, x: float, y: float,
                 timestamp: float | None = None) -> tuple[float, float]:
        return self._fx(x, timestamp), self._fy(y, timestamp)
