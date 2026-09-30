"""10-second "why is it slow" sample: CPU, memory, disk busy, frequency, top 5 processes.

Numbers and process NAMES only (no command lines, paths or arguments).
build_diagnose_sample() and pick_top_processes() are pure and unit-tested;
take_sample() is the part that talks to the OS through psutil.
"""

from __future__ import annotations

import sys
import time
from typing import Optional

TOP_N = 5
TOP_BY_CPU = 3  # the rest of the slots go to the biggest memory users not already listed
MAX_FREQ_RATIO = 1.5  # turbo can read above "max"; keep the number sane
MIN_OPS_TO_TRUST_ZERO = 20  # below this, zero time spent on disk is believable
IDLE_NAMES = {"system idle process", "idle"}


def _delta(a, b) -> Optional[float]:
    """b - a, or None if either is missing or the counter went backwards (reset)."""
    if a is None or b is None or b < a:
        return None
    return float(b - a)


def _disk(io0, io1, elapsed_s: float) -> tuple[Optional[float], Optional[float]]:
    if io0 is None or io1 is None or elapsed_s <= 0:
        return None, None
    reads = _delta(io0.read_count, io1.read_count)
    writes = _delta(io0.write_count, io1.write_count)
    read_ms = _delta(io0.read_time, io1.read_time)
    write_ms = _delta(io0.write_time, io1.write_time)
    if None in (reads, writes, read_ms, write_ms):
        return None, None

    # busy_time exists on Linux only and is the truest measure; otherwise use time spent in I/O.
    linux_busy = _delta(getattr(io0, "busy_time", None), getattr(io1, "busy_time", None))
    busy_ms = linux_busy if linux_busy is not None else read_ms + write_ms

    # Some systems (seen on Windows 11) never advance the time counters. Plenty of operations
    # with zero time spent is not "an idle disk", it is an unmeasured one: report None, not 0.
    if busy_ms == 0 and reads + writes >= MIN_OPS_TO_TRUST_ZERO:
        return None, None

    busy_pct = round(min(100.0, busy_ms / (elapsed_s * 1000.0) * 100.0), 1)

    ops = reads + writes
    latency = round((read_ms + write_ms) / ops, 1) if ops > 0 else None
    if latency is not None and latency <= 0:
        latency = None  # a zero latency is an unmeasured one, never a real reading
    return busy_pct, latency


def pick_top_processes(processes: list[dict]) -> list[dict]:
    """Pure. Top 3 by CPU, then the biggest memory users, at most 5, name/cpu/memory only."""
    usable = [p for p in processes if p["name"].strip().lower() not in IDLE_NAMES]
    chosen: list[dict] = sorted(usable, key=lambda p: p["cpuPct"], reverse=True)[:TOP_BY_CPU]
    for p in sorted(usable, key=lambda p: p["memMb"], reverse=True):
        if len(chosen) >= TOP_N:
            break
        if p not in chosen:
            chosen.append(p)
    return [{"name": p["name"][:80], "cpuPct": p["cpuPct"], "memMb": p["memMb"]} for p in chosen]


def build_diagnose_sample(
    *,
    elapsed_s: float,
    cpu_pct: Optional[float],
    mem_pct: Optional[float],
    io0,
    io1,
    swap_io0: Optional[tuple],
    swap_io1: Optional[tuple],
    freq_current: Optional[float],
    freq_max: Optional[float],
    processes: list[dict],
    is_windows: bool,
) -> dict:
    """Pure. Missing readings stay None; nothing is ever filled in with zero."""
    busy_pct, latency_ms = _disk(io0, io1, elapsed_s)

    swap_bytes: Optional[float] = None
    if not is_windows and swap_io0 is not None and swap_io1 is not None:  # Windows always reports 0
        d_in = _delta(swap_io0[0], swap_io1[0])
        d_out = _delta(swap_io0[1], swap_io1[1])
        if d_in is not None and d_out is not None:
            swap_bytes = d_in + d_out

    freq_ratio: Optional[float] = None
    if freq_current and freq_max:  # psutil gives 0 when it does not know
        freq_ratio = round(min(freq_current / freq_max, MAX_FREQ_RATIO), 2)

    return {
        "cpuPct": None if cpu_pct is None else round(float(cpu_pct), 1),
        "memUsedPct": None if mem_pct is None else round(float(mem_pct), 1),
        "swapActivityBytes": swap_bytes,
        "diskBusyPct": busy_pct,
        "diskLatencyMs": latency_ms,
        "cpuFreqRatio": freq_ratio,
        "topProcesses": pick_top_processes(processes),
    }


def take_sample(duration_s: float = 10.0) -> dict:
    """Talk to the OS for duration_s seconds. Individual sensor failures become None."""
    import psutil

    cores = psutil.cpu_count(logical=True) or 1

    procs = []
    for p in psutil.process_iter(["name"]):
        try:
            p.cpu_percent(None)  # prime: the next call reports usage since this one
            procs.append(p)
        except (psutil.Error, OSError):
            continue

    def disk_counters():
        try:
            return psutil.disk_io_counters()
        except Exception:  # noqa: BLE001
            return None

    def swap_counters():
        try:
            s = psutil.swap_memory()
            return (s.sin, s.sout)
        except Exception:  # noqa: BLE001
            return None

    io0, swap0 = disk_counters(), swap_counters()
    psutil.cpu_percent(None)
    start = time.monotonic()
    time.sleep(duration_s)
    elapsed = time.monotonic() - start
    cpu_pct = psutil.cpu_percent(None)
    io1, swap1 = disk_counters(), swap_counters()

    try:
        mem_pct = psutil.virtual_memory().percent
    except Exception:  # noqa: BLE001
        mem_pct = None

    freq_cur = freq_max = None
    try:
        f = psutil.cpu_freq()
        if f is not None:
            freq_cur, freq_max = f.current, f.max
    except Exception:  # noqa: BLE001
        pass

    rows = []
    for p in procs:
        try:
            # per-process cpu_percent is per-core (can exceed 100); scale to share of the whole machine
            rows.append(
                {
                    "name": p.info.get("name") or p.name(),
                    "cpuPct": round(min(100.0, p.cpu_percent(None) / cores), 1),
                    "memMb": round(p.memory_info().rss / (1024 * 1024), 1),
                }
            )
        except (psutil.Error, OSError):
            continue  # process ended or access denied

    return build_diagnose_sample(
        elapsed_s=elapsed,
        cpu_pct=cpu_pct,
        mem_pct=mem_pct,
        io0=io0,
        io1=io1,
        swap_io0=swap0,
        swap_io1=swap1,
        freq_current=freq_cur,
        freq_max=freq_max,
        processes=rows,
        is_windows=sys.platform == "win32",
    )
