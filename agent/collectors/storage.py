"""Storage collector: Tier A SMART (smartctl, optional) and Tier B timed probe. Numbers only; missing = None.

Tier A: `smartctl -j -a <device>` when smartctl is installed and allowed. The agent never installs it and never
        elevates; without it every SMART field is None and the server skips those rules.
Tier B: time an 8 MB write + fsync + read of a temp file the agent creates itself, then delete it. A time that
        could not be measured is None, never 0.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from typing import Optional

PROBE_BYTES = 8 * 1024 * 1024

SMART_KEYS = (
    "smartPassed",
    "criticalWarning",
    "availableSparePct",
    "availableSpareThresholdPct",
    "percentageUsed",
    "mediaErrors",
    "reallocatedSectors",
    "pendingSectors",
)


def _int(v) -> Optional[int]:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def parse_smartctl_json(obj: dict) -> dict:
    """Pure. smartctl -j output -> SMART fields. Anything absent or malformed is None."""
    out = dict.fromkeys(SMART_KEYS)
    status = obj.get("smart_status") if isinstance(obj, dict) else None
    if isinstance(status, dict) and isinstance(status.get("passed"), bool):
        out["smartPassed"] = status["passed"]

    nvme = obj.get("nvme_smart_health_information_log") if isinstance(obj, dict) else None
    if isinstance(nvme, dict):
        out["criticalWarning"] = _int(nvme.get("critical_warning"))
        out["availableSparePct"] = _int(nvme.get("available_spare"))
        out["availableSpareThresholdPct"] = _int(nvme.get("available_spare_threshold"))
        out["percentageUsed"] = _int(nvme.get("percentage_used"))
        out["mediaErrors"] = _int(nvme.get("media_errors"))

    ata = obj.get("ata_smart_attributes") if isinstance(obj, dict) else None
    table = ata.get("table") if isinstance(ata, dict) else None
    if isinstance(table, list):
        for attr in table:
            if not isinstance(attr, dict):
                continue
            raw = attr.get("raw", {}).get("value") if isinstance(attr.get("raw"), dict) else None
            if attr.get("id") == 5:
                out["reallocatedSectors"] = _int(raw)
            elif attr.get("id") == 197:
                out["pendingSectors"] = _int(raw)
    return out


def read_smart() -> Optional[dict]:
    """Run smartctl if it is installed. None when missing, not permitted, or unparseable. Never elevates."""
    exe = shutil.which("smartctl")
    if not exe:
        return None
    try:
        scan = subprocess.run([exe, "--scan", "-j"], capture_output=True, text=True, timeout=20, check=False)
        devices = json.loads(scan.stdout or "{}").get("devices") or []
        if not devices:
            return None
        info = subprocess.run(
            [exe, "-j", "-a", devices[0]["name"]], capture_output=True, text=True, timeout=30, check=False
        )
        parsed = parse_smartctl_json(json.loads(info.stdout or "{}"))
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        return None
    return parsed if any(v is not None for v in parsed.values()) else None


def time_io_probe(directory: Optional[str] = None, size: int = PROBE_BYTES, clock=time.perf_counter) -> Optional[float]:
    """Time write + fsync + read of `size` random bytes in a temp file in `directory`. ms, or None."""
    path = None
    try:
        fd, path = tempfile.mkstemp(prefix="devicepulse-probe-", suffix=".tmp", dir=directory)
        data = os.urandom(size)
        start = clock()
        with os.fdopen(fd, "wb", buffering=0) as fh:
            fh.write(data)
            os.fsync(fh.fileno())
        with open(path, "rb", buffering=0) as fh:
            while fh.read(1024 * 1024):
                pass
        elapsed_ms = (clock() - start) * 1000.0
    except OSError:
        return None
    finally:
        if path and os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
    return round(elapsed_ms, 2) if elapsed_ms > 0 else None


def free_space(path: Optional[str] = None) -> Optional[float]:
    try:
        usage = shutil.disk_usage(path or tempfile.gettempdir())
    except OSError:
        return None
    return round(usage.free / usage.total * 100.0, 1) if usage.total else None


def storage_values(io_ms: Optional[float], free_pct: Optional[float], smart: Optional[dict]) -> dict:
    """Pure. The storage sample's values; SMART fields are None when smartctl was not available."""
    return {"ioProbeMs": io_ms, "freeSpacePct": free_pct, **(smart or dict.fromkeys(SMART_KEYS))}


def read_storage() -> dict:
    tmp = tempfile.gettempdir()
    return storage_values(time_io_probe(tmp), free_space(tmp), read_smart())
