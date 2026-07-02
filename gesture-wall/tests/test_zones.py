import pytest

from gesturewall.zones import Zone, build_grid, zone_at


def test_grid_count_and_bounds():
    zones = build_grid(2, 3)
    assert len(zones) == 6
    for z in zones:
        assert 0.0 <= z.x <= 1.0 and 0.0 <= z.y <= 1.0
        assert z.x + z.w <= 1.0 + 1e-9 and z.y + z.h <= 1.0 + 1e-9


def test_labels_default_and_custom():
    assert [z.label for z in build_grid(1, 3)] == ["1", "2", "3"]
    custom = build_grid(1, 2, labels=["YES", "NO"])
    assert [z.label for z in custom] == ["YES", "NO"]


def test_contains_basic_and_margins():
    z = Zone(id="z", label="z", x=0.2, y=0.2, w=0.4, h=0.4)  # spans .2-.6
    assert z.contains(0.4, 0.4)              # center
    assert not z.contains(0.1, 0.4)          # outside left
    # Positive margin shrinks: a point just inside the edge is now excluded.
    assert z.contains(0.21, 0.4)
    assert not z.contains(0.21, 0.4, margin=0.1)   # inner core excludes near-edge
    # Negative margin grows: a point just outside is now included.
    assert not z.contains(0.62, 0.4)
    assert z.contains(0.62, 0.4, margin=-0.1)


def test_zone_at_hits_center_and_misses_gap():
    zones = build_grid(1, 2, padding=0.1)
    # First tile center.
    z = zone_at(zones, *zones[0].center())
    assert z is zones[0]
    # The seam at x=0.5 falls in the padding gap -> no zone.
    assert zone_at(zones, 0.5, 0.5) is None


def test_center():
    z = Zone(id="z", label="z", x=0.0, y=0.0, w=0.5, h=0.5)
    assert z.center() == pytest.approx((0.25, 0.25))


@pytest.mark.parametrize("rows,cols", [(0, 1), (1, 0), (-1, 2)])
def test_invalid_grid_raises(rows, cols):
    with pytest.raises(ValueError):
        build_grid(rows, cols)


def test_invalid_padding_raises():
    with pytest.raises(ValueError):
        build_grid(1, 1, padding=0.6)
