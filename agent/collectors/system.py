"""CPU, memory and disk activity collector (psutil). Missing values are None.

CPU frequency: on Windows psutil reports the fixed base clock (seen on a Windows 11 laptop: 2496 MHz idle and at
100% load), so it is NOT used there. Windows' built-in "% Processor Performance" counter (typeperf, no admin
needed) gives the real effective speed as a percentage of the base clock. If that cannot be read, frequency is None.
"""

from __future__ import annotations

import subprocess
import sys
from typing import Optional

PERF_COUNTER = r"\Processor Information(_Total)\% Processor Performance"
MAX_FREQ_RATIO = 2.5  # turbo reads above base; anything higher is a bad reading


def parse_typeperf_csv(text: str) -> Optional[float]:
    """Pure. Average of the numeric samples in typeperf CSV output, or None if there are none."""
    values = []
    for line in text.splitlines()[1:]:  # first line is the header
        parts = [p.strip().strip('"').strip() for p in line.split('","')]
        if len(parts) < 2:
            continue
        try:
            v = float(parts[-1].strip('"'))
        except ValueError:
            continue  # blank sample, or a status line
        if v >= 0:
            values.append(v)
    return round(sum(values) / len(values), 2) if values else None


def typeperf_command(samples: int) -> list[str]:
    return ["typeperf", PERF_COUNTER, "-si", "1", "-sc", str(max(1, int(samples)))]


def read_perf_pct(samples: int = 1) -> Optional[float]:
    """Windows only. Effective CPU speed as % of base clock, averaged over `samples` seconds."""
    try:
        proc = subprocess.run(
            typeperf_command(samples), capture_output=True, text=True, timeout=samples + 10, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_typeperf_csv(proc.stdout) if proc.returncode == 0 else None


def freq_fields(is_windows: bool, psutil_freq, perf_pct: Optional[float]) -> dict:
    """Pure. {"cpuFreqMHz", "cpuFreqRatio"}; ratio is current speed / base (Windows) or / max (elsewhere)."""
    base = getattr(psutil_freq, "max", None) if psutil_freq is not None else None
    base = base if base else None  # psutil reports 0 when unknown

    if is_windows:
        if perf_pct is None:
            return {"cpuFreqMHz": None, "cpuFreqRatio": None}
        ratio = min(perf_pct / 100.0, MAX_FREQ_RATIO)
        mhz = round(base * ratio, 0) if base else None
        return {"cpuFreqMHz": mhz, "cpuFreqRatio": round(ratio, 2)}

    current = getattr(psutil_freq, "current", None) if psutil_freq is not None else None
    if not current:
        return {"cpuFreqMHz": None, "cpuFreqRatio": None}
    ratio = round(min(current / base, MAX_FREQ_RATIO), 2) if base else None
    return {"cpuFreqMHz": round(float(current), 0), "cpuFreqRatio": ratio}


def read_system() -> dict:
    import psutil

    is_windows = sys.platform == "win32"
    cpu_load = psutil.cpu_percent(interval=None if is_windows else 1.0)
    # On Windows the 1 s typeperf sample doubles as the CPU-load measuring window.
    perf_pct = read_perf_pct(1) if is_windows else None
    if is_windows:
        cpu_load = psutil.cpu_percent(interval=None)

    try:
        psutil_freq = psutil.cpu_freq()
    except Exception:
        psutil_freq = None
    freq = freq_fields(is_windows, psutil_freq, perf_pct)

    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()

    disk_busy_ms: Optional[int] = None
    try:
        io = psutil.disk_io_counters()
        if io is not None:
            # busy_time exists on Linux only; on Windows we leave it None.
            disk_busy_ms = getattr(io, "busy_time", None)
    except Exception:
        pass

    cpu_temp_c: Optional[float] = None
    try:
        sensors = getattr(psutil, "sensors_temperatures", None)
        temps = sensors() if sensors else {}
        for readings in temps.values():
            if readings:
                cpu_temp_c = round(float(readings[0].current), 1)
                break
    except Exception:
        pass

    return {
        "cpuLoadPct": round(float(cpu_load), 1),
        "cpuFreqMHz": freq["cpuFreqMHz"],
        "cpuFreqRatio": freq["cpuFreqRatio"],
        "cpuTempC": cpu_temp_c,
        "memUsedPct": round(float(mem.percent), 1),
        "swapUsedPct": round(float(swap.percent), 1),
        "diskBusyMs": disk_busy_ms,
    }
