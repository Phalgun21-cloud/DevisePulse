"""Safe memory pressure for testing slow-laptop diagnosis on a REAL laptop.

    python chaos/mem_hog.py                     # raise system memory use to 93% for 45 s, asks first
    python chaos/mem_hog.py --target 92 --seconds 60

While it holds the memory, start a diagnosis. DevicePulse should report memory_pressure and name python.exe.

Safety (CLAUDE.md rule 7): asks first; the hog itself never allocates more than 80% of RAM; system use is never
pushed above 95%; it stops allocating if less than 300 MB would stay free; refuses on battery below 30% (unplugged);
hard 120 s cap; memory only (no files written), all released on exit or Ctrl+C.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cpu_hog import check_safe  # noqa: E402  (battery + duration checks)

MAX_SHARE_OF_RAM = 0.80
MAX_TARGET_PCT = 95.0
MIN_FREE_BYTES = 300 * 1024 * 1024
CHUNK = 64 * 1024 * 1024


def make_chunk(size: int) -> bytes:
    """Random bytes: Windows compresses and combines memory, so a repeated byte would shrink back to almost nothing."""
    return os.urandom(size)


def plan_allocation(total_bytes: float, used_pct: float, target_pct: float) -> tuple[int, Optional[str]]:
    """Pure. Bytes to allocate to lift system memory use to target_pct, or (0, reason to refuse)."""
    if target_pct > MAX_TARGET_PCT:
        return 0, f"--target must be at most {MAX_TARGET_PCT:.0f}%."
    if used_pct >= target_pct:
        return 0, f"memory is already at {used_pct:.0f}%, at or above the {target_pct:.0f}% target."
    wanted = (target_pct - used_pct) / 100.0 * total_bytes
    return int(min(wanted, MAX_SHARE_OF_RAM * total_bytes)), None


def main(argv: list[str]) -> int:
    import psutil

    parser = argparse.ArgumentParser(description="Safe memory pressure for DevicePulse diagnosis tests")
    parser.add_argument("--target", type=float, default=93.0, help="system memory use to reach, percent")
    parser.add_argument("--seconds", type=float, default=45)
    args = parser.parse_args(argv)

    battery_pct = plugged = None
    try:
        b = psutil.sensors_battery()
        if b is not None:
            battery_pct, plugged = b.percent, b.power_plugged
    except Exception:  # noqa: BLE001
        pass
    reason = check_safe(args.seconds, battery_pct, plugged)
    vm = psutil.virtual_memory()
    alloc, mem_reason = plan_allocation(vm.total, vm.percent, args.target)
    reason = reason or mem_reason
    if reason:
        print(f"Refusing to run: {reason}")
        return 2

    print(
        f"Memory is {vm.percent:.0f}% used. This will hold up to {alloc / 1024**3:.1f} GB for {args.seconds:.0f} seconds "
        f"to reach about {args.target:.0f}%. Other programs may slow down while it runs."
    )
    if input("Type yes to continue: ").strip().lower() != "yes":
        print("Cancelled.")
        return 1

    held: list[bytes] = []
    try:
        got = 0
        while got < alloc:
            if psutil.virtual_memory().available - CHUNK < MIN_FREE_BYTES:
                print("Stopping allocation early: keeping at least 300 MB free.")
                break
            size = min(CHUNK, alloc - got)
            held.append(make_chunk(size))  # incompressible and unique, so the pages stay really used
            got += size
        print(f"Holding {got / 1024**3:.2f} GB; system memory {psutil.virtual_memory().percent:.0f}% used. Start a diagnosis now.")
        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline:
            time.sleep(0.5)
    except (KeyboardInterrupt, MemoryError) as exc:
        print(f"Stopping early ({type(exc).__name__}).")
    finally:
        held.clear()
    print("Done. Memory released; nothing was written to disk.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
