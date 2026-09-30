"""Safe disk load for testing diagnosis and the storage latency probe on a REAL laptop.

    python chaos/disk_hog.py                 # 45 s of write + fsync + read on one 1 GB temp file, asks first
    python chaos/disk_hog.py --seconds 60

Safety (CLAUDE.md rule 7): asks first; runs only with at least 5 GB free on the temp drive; uses ONE temp file of
at most 1 GB that it created itself in the system temp folder and deletes on exit, Ctrl+C or error; refuses on
battery below 30% (unplugged); hard 120 s cap. It never touches any other file.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
import time
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cpu_hog import check_safe  # noqa: E402  (battery + duration checks)

GB = 1024**3
MIN_FREE_BYTES = 5 * GB
FILE_BYTES = 1 * GB
BLOCK = 8 * 1024 * 1024


def check_disk_safe(free_bytes: float) -> Optional[str]:
    """Pure. Reason to refuse, or None."""
    if free_bytes < MIN_FREE_BYTES:
        return f"only {free_bytes / GB:.1f} GB free; the disk test needs at least 5 GB free."
    return None


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Safe disk load for DevicePulse tests")
    parser.add_argument("--seconds", type=float, default=45)
    args = parser.parse_args(argv)

    battery_pct = plugged = None
    try:
        import psutil

        b = psutil.sensors_battery()
        if b is not None:
            battery_pct, plugged = b.percent, b.power_plugged
    except Exception:  # noqa: BLE001
        pass

    tmp_dir = tempfile.gettempdir()
    reason = check_safe(args.seconds, battery_pct, plugged) or check_disk_safe(shutil.disk_usage(tmp_dir).free)
    if reason:
        print(f"Refusing to run: {reason}")
        return 2

    print(f"This will write and read one 1 GB temp file in {tmp_dir} for {args.seconds:.0f} seconds, then delete it.")
    if input("Type yes to continue: ").strip().lower() != "yes":
        print("Cancelled.")
        return 1

    fd, path = tempfile.mkstemp(prefix="devicepulse-disk-hog-", suffix=".tmp", dir=tmp_dir)
    block = os.urandom(BLOCK)  # incompressible, so the drive really works
    written = read = 0
    try:
        print(f"Running on {path}. Start a diagnosis now. Ctrl+C stops early.")
        deadline = time.monotonic() + args.seconds
        with os.fdopen(fd, "r+b", buffering=0) as fh:
            while time.monotonic() < deadline:
                fh.seek(0)
                for _ in range(FILE_BYTES // BLOCK):
                    fh.write(block)
                    written += BLOCK
                    if written % (64 * 1024 * 1024) == 0:
                        os.fsync(fh.fileno())
                    if time.monotonic() >= deadline:
                        break
                os.fsync(fh.fileno())
                fh.seek(0)
                while time.monotonic() < deadline and fh.read(BLOCK):
                    read += BLOCK
    except KeyboardInterrupt:
        print("Stopping early.")
    finally:
        try:
            os.remove(path)
            removed = not os.path.exists(path)
        except OSError as exc:
            removed = False
            print(f"WARNING: could not delete {path}: {exc}. Delete it by hand.")
    print(f"Done. Wrote {written / GB:.1f} GB, read {read / GB:.1f} GB. Temp file deleted: {removed}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
