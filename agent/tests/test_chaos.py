import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "chaos"))

from cpu_hog import check_safe  # noqa: E402


def test_refuses_on_low_battery_unplugged():
    assert "Battery" in check_safe(30, 29, False)


def test_allows_low_battery_when_plugged_in():
    assert check_safe(30, 10, True) is None


def test_allows_when_battery_unknown_desktop():
    assert check_safe(30, None, None) is None


def test_allows_healthy_battery_unplugged():
    assert check_safe(30, 80, False) is None


def test_refuses_runaway_or_invalid_duration():
    assert check_safe(9999, 100, True) is not None
    assert check_safe(0, 100, True) is not None
    assert check_safe(-5, 100, True) is not None
