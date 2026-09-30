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


# ---- Windows disk counters (real output from this laptop, host name replaced) -------------

from collectors.diagnose import windows_disk_fields  # noqa: E402
from collectors.system import parse_typeperf_columns  # noqa: E402

DISK_IDLE = r""""(PDH-CSV 4.0)","\\LAPTOP\PhysicalDisk(_Total)\% Idle Time","\\LAPTOP\PhysicalDisk(_Total)\Avg. Disk sec/Transfer","\\LAPTOP\PhysicalDisk(_Total)\Disk Transfers/sec"
"09/30/2026 13:23:20.619","99.801251","0.000356","19.761118"
"09/30/2026 13:23:21.633","140.544977","0.000991","1.972166"
"09/30/2026 13:23:22.642","100.009072","0.000000","0.000000"
"09/30/2026 13:23:23.656","99.863453","0.000930","0.986506"
"09/30/2026 13:23:24.665","99.629143","0.000742","7.927399"
"""

DISK_LOADED = """"(PDH-CSV 4.0)","a","b","c"
"09/30/2026 13:23:28.984","75.476543","0.000256","1419.145958"
"09/30/2026 13:23:29.995","66.218771","0.000260","1913.402982"
"09/30/2026 13:23:30.998","79.444833","0.000267","1150.948490"
"09/30/2026 13:23:31.999","77.828371","0.000266","1218.888154"
"09/30/2026 13:23:33.010","23.456615","0.000648","3352.695339"
"09/30/2026 13:23:34.014","73.235427","0.000509","1184.566287"
"09/30/2026 13:23:35.028","73.658320","0.000249","1543.517738"
"09/30/2026 13:23:36.031","71.745825","0.000246","1656.186796"
"""


def test_parse_typeperf_columns_splits_each_counter():
    cols = parse_typeperf_columns(DISK_IDLE)
    assert len(cols) == 3
    assert [len(c) for c in cols] == [5, 5, 5]
    assert cols[0][1] == 140.544977


def test_windows_disk_under_real_load():
    idle, sec, tps = parse_typeperf_columns(DISK_LOADED)
    busy, latency = windows_disk_fields(idle, sec, tps)
    assert abs(busy - 32.4) <= 0.1
    assert abs(latency - 0.38) <= 0.01  # transfer-weighted ms


def test_windows_disk_idle_is_clamped_and_never_negative():
    busy, latency = windows_disk_fields(*parse_typeperf_columns(DISK_IDLE))
    assert 0.0 <= busy < 1.0
    assert latency is not None and latency > 0


def test_windows_disk_with_no_transfers_has_no_latency():
    busy, latency = windows_disk_fields([100.0, 99.9], [0.0, 0.0], [0.0, 0.0])
    assert latency is None
    assert busy is not None


def test_windows_disk_without_counters_is_null():
    assert windows_disk_fields([], [], []) == (None, None)


def test_diagnose_sample_on_windows_never_uses_psutil_disk_time():
    # psutil's Windows time counters gave "0.1% busy" while 40 GB was being written. Never use them there.
    base = dict(
        elapsed_s=10.0, cpu_pct=20.0, mem_pct=50.0,
        io0=NS(read_count=0, write_count=0, read_time=0, write_time=0, busy_time=None),
        io1=NS(read_count=500, write_count=500, read_time=10, write_time=0, busy_time=None),
        swap_io0=None, swap_io1=None, freq_current=None, freq_max=None, processes=[], is_windows=True,
    )
    assert build_diagnose_sample(**base)["diskBusyPct"] is None
    got = build_diagnose_sample(**base, windows_disk=(55.0, 2.5))
    assert got["diskBusyPct"] == 55.0 and got["diskLatencyMs"] == 2.5
