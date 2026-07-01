import pytest

from gesturewall.dwell import DwellSelector
from gesturewall.zones import build_grid


def _zones():
    # Two big tiles side by side, small gap.
    return build_grid(1, 2, padding=0.02)


def test_dwell_commits_after_threshold_and_toggles():
    zones = _zones()
    sel = DwellSelector(dwell_seconds=0.8, cooldown_seconds=0.4)
    center = zones[0].center()

    assert sel.update(zones, center, t=0.0) is None      # enter
    assert sel.update(zones, center, t=0.5) is None       # mid-dwell
    assert 0.5 < sel.progress < 0.7
    event = sel.update(zones, center, t=0.85)             # commit
    assert event is not None
    assert event.zone_id == zones[0].id
    assert event.selected is True
    assert zones[0].selected is True


def test_progress_resets_when_leaving_zone():
    zones = _zones()
    sel = DwellSelector(dwell_seconds=0.8)
    c0, c1 = zones[0].center(), zones[1].center()
    sel.update(zones, c0, t=0.0)
    sel.update(zones, c0, t=0.4)
    assert sel.progress > 0
    sel.update(zones, c1, t=0.45)        # jumped to the other tile
    assert sel.progress == 0.0
    assert sel.active_zone is zones[1]


def test_cooldown_prevents_immediate_refire():
    zones = _zones()
    sel = DwellSelector(dwell_seconds=0.5, cooldown_seconds=0.5)
    c = zones[0].center()
    sel.update(zones, c, t=0.0)
    assert sel.update(zones, c, t=0.55) is not None       # first commit
    # Immediately keep dwelling: cooldown should suppress a re-fire.
    assert sel.update(zones, c, t=0.6) is None
    assert sel.update(zones, c, t=0.9) is None            # still in cooldown
    assert sel.progress == 0.0


def test_second_dwell_deselects():
    zones = _zones()
    sel = DwellSelector(dwell_seconds=0.5, cooldown_seconds=0.3)
    c = zones[0].center()
    sel.update(zones, c, t=0.0)
    e1 = sel.update(zones, c, t=0.55)
    assert e1.selected is True
    # After cooldown, dwell again -> deselect.
    sel.update(zones, c, t=1.0)          # re-enter (past cooldown ~0.85)
    e2 = sel.update(zones, c, t=1.6)
    assert e2 is not None
    assert e2.selected is False
    assert zones[0].selected is False


def test_disengaged_resets_and_no_event():
    zones = _zones()
    sel = DwellSelector(dwell_seconds=0.5)
    c = zones[0].center()
    sel.update(zones, c, t=0.0)
    sel.update(zones, c, t=0.3)
    assert sel.progress > 0
    assert sel.update(zones, c, t=0.4, engaged=False) is None
    assert sel.progress == 0.0
    assert sel.active_zone is None


def test_none_cursor_resets():
    zones = _zones()
    sel = DwellSelector(dwell_seconds=0.5)
    sel.update(zones, zones[0].center(), t=0.0)
    assert sel.update(zones, None, t=0.1) is None
    assert sel.active_zone is None


def test_hysteresis_holds_zone_through_edge_jitter():
    zones = _zones()
    sel = DwellSelector(dwell_seconds=1.0, hysteresis=0.2)
    z = zones[0]
    sel.update(zones, z.center(), t=0.0)
    # Nudge just past the right edge of the tile; hysteresis should keep it.
    edge_x = z.x + z.w + 0.01 * z.w
    sel.update(zones, (edge_x, z.center()[1]), t=0.2)
    assert sel.active_zone is z
    assert sel.progress > 0


@pytest.mark.parametrize("bad", [
    {"dwell_seconds": 0},
    {"dwell_seconds": -1},
    {"cooldown_seconds": -1},
    {"hysteresis": 0.5},
    {"hysteresis": 0.9},
    {"hysteresis": -0.1},
])
def test_invalid_params_raise(bad):
    with pytest.raises(ValueError):
        DwellSelector(**bad)
