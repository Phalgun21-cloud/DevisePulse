import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "chaos"))

from cpu_hog import check_safe  # noqa: E402
from disk_hog import FILE_BYTES, check_disk_safe  # noqa: E402
from mem_hog import plan_allocation  # noqa: E402

GB = 1024**3


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


# ---- mem_hog ------------------------------------------------------------------------


def test_mem_hog_allocates_only_the_gap_to_the_target():
    alloc, reason = plan_allocation(total_bytes=16 * GB, used_pct=83.0, target_pct=93.0)
    assert reason is None
    assert abs(alloc - 1.6 * GB) < 1024**2


def test_mem_hog_never_allocates_more_than_80_percent_of_ram():
    alloc, reason = plan_allocation(total_bytes=8 * GB, used_pct=5.0, target_pct=95.0)
    assert reason is None
    assert alloc <= 0.8 * 8 * GB


def test_mem_hog_refuses_a_target_above_95_percent():
    assert plan_allocation(total_bytes=8 * GB, used_pct=50.0, target_pct=99.0)[1] is not None


def test_mem_hog_refuses_when_already_at_target():
    alloc, reason = plan_allocation(total_bytes=8 * GB, used_pct=94.0, target_pct=93.0)
    assert alloc == 0 and "already" in reason


# ---- disk_hog -----------------------------------------------------------------------


def test_disk_hog_refuses_below_5_gb_free():
    assert "5 GB" in check_disk_safe(free_bytes=4.9 * GB)


def test_disk_hog_allows_with_enough_space():
    assert check_disk_safe(free_bytes=50 * GB) is None


def test_disk_hog_temp_file_is_at_most_1_gb():
    assert FILE_BYTES <= 1 * GB


def test_mem_hog_chunks_are_incompressible():
    # A repeated byte was compressed away by Windows: 93% used shrank to 88.5% within 10 s.
    import zlib

    from mem_hog import make_chunk

    chunk = make_chunk(1024 * 1024)
    assert len(chunk) == 1024 * 1024
    assert len(zlib.compress(chunk)) > 0.99 * len(chunk)
    assert make_chunk(4096) != make_chunk(4096)  # no identical pages for Windows to combine
