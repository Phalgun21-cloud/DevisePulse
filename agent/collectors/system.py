"""CPU, memory and disk activity collector (psutil). Missing values are None."""

from __future__ import annotations

from typing import Optional


def read_system() -> dict:
    import psutil

    cpu_load = psutil.cpu_percent(interval=1.0)

    freq_mhz: Optional[float] = None
    try:
        freq = psutil.cpu_freq()
        if freq is not None:
            freq_mhz = round(float(freq.current), 0)
    except Exception:
        pass

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
        "cpuFreqMHz": freq_mhz,
        "cpuTempC": cpu_temp_c,
        "memUsedPct": round(float(mem.percent), 1),
        "swapUsedPct": round(float(swap.percent), 1),
        "diskBusyMs": disk_busy_ms,
    }
