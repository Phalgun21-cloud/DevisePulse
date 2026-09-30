import os
import sys
from types import SimpleNamespace as NS

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from collectors.system import freq_fields, parse_typeperf_csv  # noqa: E402
from collectors.diagnose import build_diagnose_sample  # noqa: E402

# Real output captured on a Windows 11 laptop (host name replaced).
TYPEPERF_REAL = (
    '"(PDH-CSV 4.0)","\\\\LAPTOP\\Processor Information(_Total)\\% Processor Performance"\n'
    '"09/30/2026 13:11:45.491","140.925800"\n'
    '"09/30/2026 13:11:46.505","127.956975"\n'
    "Exiting, please wait...\n"
    "The command completed successfully.\n"
)

STATIC_PSUTIL = NS(current=2496.0, min=0.0, max=2496.0)  # what psutil reports on Windows, idle or loaded


def test_parse_typeperf_averages_real_samples():
    assert abs(parse_typeperf_csv(TYPEPERF_REAL) - 134.44) < 0.01


def test_parse_typeperf_skips_blank_samples_and_handles_errors():
    blank = '"(PDH-CSV 4.0)","\\\\X\\c"\n"09/30/2026 13:00:00.000"," "\n"09/30/2026 13:00:01.000","80.0"\n'
    assert parse_typeperf_csv(blank) == 80.0
    assert parse_typeperf_csv("Error: No valid counters.\n") is None
    assert parse_typeperf_csv("") is None


def test_windows_never_reports_psutils_static_frequency():
    # psutil's fixed base clock is not a measurement: without the counter, send null.
    assert freq_fields(True, STATIC_PSUTIL, None) == {"cpuFreqMHz": None, "cpuFreqRatio": None}


def test_windows_uses_the_performance_counter():
    got = freq_fields(True, STATIC_PSUTIL, 60.0)
    assert got == {"cpuFreqMHz": 1498.0, "cpuFreqRatio": 0.6}


def test_windows_turbo_above_base_is_kept_not_clipped_to_one():
    assert freq_fields(True, STATIC_PSUTIL, 148.7)["cpuFreqRatio"] == 1.49


def test_windows_counter_without_a_known_base_gives_ratio_only():
    assert freq_fields(True, None, 60.0) == {"cpuFreqMHz": None, "cpuFreqRatio": 0.6}


def test_linux_uses_psutil_current_over_max():
    got = freq_fields(False, NS(current=1800.0, min=400.0, max=3600.0), None)
    assert got == {"cpuFreqMHz": 1800.0, "cpuFreqRatio": 0.5}


def test_linux_unknown_frequency_is_null():
    assert freq_fields(False, None, None) == {"cpuFreqMHz": None, "cpuFreqRatio": None}
    assert freq_fields(False, NS(current=1800.0, min=0.0, max=0.0), None)["cpuFreqRatio"] is None


def test_diagnose_sample_on_windows_uses_counter_not_psutil():
    base = dict(
        elapsed_s=10.0, cpu_pct=90.0, mem_pct=50.0, io0=None, io1=None, swap_io0=None, swap_io1=None,
        freq_current=2496.0, freq_max=2496.0, processes=[], is_windows=True,
    )
    assert build_diagnose_sample(**base)["cpuFreqRatio"] is None
    assert build_diagnose_sample(**base, perf_pct=55.0)["cpuFreqRatio"] == 0.55
