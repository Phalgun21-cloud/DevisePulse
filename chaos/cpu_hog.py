"""Safe CPU stress for testing slow-laptop diagnosis on a REAL laptop.

    python chaos/cpu_hog.py                 # 45 s, asks for confirmation first
    python chaos/cpu_hog.py --seconds 60

While it runs, click "Diagnose" in the dashboard (or POST /api/devices/:id/diagnose).
DevicePulse should rank CPU first and name the busiest process. The workers show up as
"python.exe" (the script name is not visible, because the agent reads process names only).

Safety (CLAUDE.md rule 7): asks first, hard time cap, refuses on a low battery, pure busy
loops only (no files written, nothing to clean up), stops on Ctrl+C. It does not touch cooling,
power settings or any file.
"""

from __future__ import annotations

import argparse
import multiprocessing
import sys
import time
from typing import Optional

MAX_SECONDS = 120
MIN_BATTERY_PCT = 30


def check_safe(seconds: float, battery_pct: Optional[float], plugged_in: Optional[bool]) -> Optional[str]:
    """Pure. Returns the reason to refuse, or None if it is safe to run."""
    if seconds <= 0 or seconds > MAX_SECONDS:
        return f"--seconds must be between 1 and {MAX_SECONDS}."
    on_battery = plugged_in is False
    if on_battery and battery_pct is not None and battery_pct < MIN_BATTERY_PCT:
        return f"Battery is at {battery_pct:.0f}% and unplugged. Plug in (or charge above {MIN_BATTERY_PCT}%) first."
    return None


def _spin(deadline: float) -> None:
    x = 0
    while time.monotonic() < deadline:
        x = (x * 31 + 7) % 1_000_003


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Safe CPU stress for DevicePulse diagnosis tests")
    parser.add_argument("--seconds", type=float, default=45)
    args = parser.parse_args(argv)

    battery_pct = plugged = None
    try:
        import psutil

        b = psutil.sensors_battery()
        if b is not None:
            battery_pct, plugged = b.percent, b.power_plugged
    except Exception:  # noqa: BLE001 - no battery info: proceed, nothing to protect
        pass

    reason = check_safe(args.seconds, battery_pct, plugged)
    if reason:
        print(f"Refusing to run: {reason}")
        return 2

    workers = multiprocessing.cpu_count()
    print(f"This will keep all {workers} CPU cores busy for {args.seconds:.0f} seconds. The laptop may get warm and loud.")
    if input("Type yes to continue: ").strip().lower() != "yes":
        print("Cancelled.")
        return 1

    deadline = time.monotonic() + args.seconds
    procs = [multiprocessing.Process(target=_spin, args=(deadline,)) for _ in range(workers)]
    try:
        for p in procs:
            p.start()
        print("Running. Start a diagnosis now. Ctrl+C stops early.")
        for p in procs:
            p.join()
    except KeyboardInterrupt:
        print("Stopping early.")
    finally:
        for p in procs:
            if p.is_alive():
                p.terminate()
    print("Done. Nothing was written to disk.")
    return 0


if __name__ == "__main__":
    multiprocessing.freeze_support()
    raise SystemExit(main(sys.argv[1:]))
