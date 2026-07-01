"""Selectable target zones laid out on the wall.

Coarse selection means a small number of *large* tiles (Fitts' law: bigger,
closer targets are faster and more reliable for distant pointing). Everything
here is in normalized wall coordinates in [0, 1] x [0, 1] (origin = top-left),
so it is resolution-independent and trivially unit-testable.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Zone:
    id: str
    label: str
    x: float          # top-left, normalized [0,1]
    y: float
    w: float          # width, normalized
    h: float          # height, normalized
    selected: bool = False

    def contains(self, px: float, py: float, margin: float = 0.0) -> bool:
        """Point-in-rect test with an optional fractional `margin`.

        margin > 0 shrinks the rect (an inner "core" — used to *acquire* a zone),
        margin < 0 grows it (an outer band — used as hysteresis to *hold* a zone).
        """
        mx, my = margin * self.w, margin * self.h
        return (self.x + mx <= px <= self.x + self.w - mx
                and self.y + my <= py <= self.y + self.h - my)

    def center(self) -> tuple[float, float]:
        return (self.x + self.w / 2.0, self.y + self.h / 2.0)


def build_grid(rows: int, cols: int, padding: float = 0.06,
               labels: list[str] | None = None) -> list[Zone]:
    """Build a rows x cols grid of zones with a gap (`padding`) between tiles.

    `padding` is a fraction of each cell; the gap between tiles doubles as a
    natural dead-band so the cursor isn't ambiguously over two tiles at once.
    """
    if rows < 1 or cols < 1:
        raise ValueError("rows and cols must be >= 1")
    if not (0.0 <= padding < 0.5):
        raise ValueError("padding must be in [0, 0.5)")

    zones: list[Zone] = []
    cell_w, cell_h = 1.0 / cols, 1.0 / rows
    idx = 0
    for r in range(rows):
        for c in range(cols):
            x = c * cell_w + padding * cell_w
            y = r * cell_h + padding * cell_h
            w = cell_w * (1.0 - 2.0 * padding)
            h = cell_h * (1.0 - 2.0 * padding)
            label = (labels[idx] if labels and idx < len(labels)
                     else str(idx + 1))
            zones.append(Zone(id=f"r{r}c{c}", label=label, x=x, y=y, w=w, h=h))
            idx += 1
    return zones


def zone_at(zones: list[Zone], px: float, py: float,
            margin: float = 0.0) -> Zone | None:
    """Return the first zone containing the point, or None."""
    for z in zones:
        if z.contains(px, py, margin):
            return z
    return None
