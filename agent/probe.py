"""DevicePulse probe: reports which signals THIS laptop actually exposes.

Run it on every demo laptop and commit the output to docs/probe-results/.
Its result decides which detectors run on live data and which use the simulator.

    python agent/probe.py            # print a table
    python agent/probe.py --save     # also write docs/probe-results/<hostname>.json

Status values: available | needs_admin | not_available
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import subprocess
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from collectors import battery as battery_collector  # noqa: E402

AVAILABLE = "available"
NEEDS_ADMIN = "needs_admin"
NOT_AVAILABLE = "not_available"


def _result(status: str, detail: str = "") -> dict:
    return {"status": status, "detail": detail}


def probe_psutil() -> dict:
    try:
        import psutil  # noqa: F401
    except ImportError:
        return {
            "cpu_load": _result(NOT_AVAILABLE, "psutil not installed: pip install psutil"),
            "cpu_freq": _result(NOT_AVAILABLE, "psutil not installed"),
            "memory": _result(NOT_AVAILABLE, "psutil not installed"),
            "disk_io": _result(NOT_AVAILABLE, "psutil not installed"),
            "battery_state": _result(NOT_AVAILABLE, "psutil not installed"),
            "cpu_temp": _result(NOT_AVAILABLE, "psutil not installed"),
            "fan_rpm": _result(NOT_AVAILABLE, "psutil not installed"),
        }

    import psutil

    out: dict = {}
    out["cpu_load"] = _result(AVAILABLE, f"{psutil.cpu_percent(interval=0.5)}%")

    try:
        from collectors.system import read_perf_pct

        freq = psutil.cpu_freq()
        if sys.platform == "win32":
            # psutil reports the fixed base clock on Windows; the performance counter is the real speed.
            pct = read_perf_pct(2)
            out["cpu_freq"] = (
                _result(AVAILABLE, f"Windows counter: {pct:.0f}% of base clock (psutil fixed at {freq.current:.0f} MHz, not used)")
                if pct is not None
                else _result(NOT_AVAILABLE, "'% Processor Performance' counter unreadable; psutil value is a fixed base clock")
            )
        else:
            out["cpu_freq"] = (
                _result(AVAILABLE, f"{freq.current:.0f} MHz (max {freq.max:.0f})")
                if freq
                else _result(NOT_AVAILABLE)
            )
    except Exception as exc:  # noqa: BLE001
        out["cpu_freq"] = _result(NOT_AVAILABLE, str(exc))

    out["memory"] = _result(AVAILABLE, f"{psutil.virtual_memory().percent}% used")

    io = psutil.disk_io_counters()
    out["disk_io"] = _result(AVAILABLE, "counters readable") if io else _result(NOT_AVAILABLE)

    batt = psutil.sensors_battery()
    out["battery_state"] = (
        _result(AVAILABLE, f"{batt.percent:.0f}%, plugged={batt.power_plugged}")
        if batt
        else _result(NOT_AVAILABLE, "no battery reported")
    )

    temps_fn = getattr(psutil, "sensors_temperatures", None)
    temps = temps_fn() if temps_fn else {}
    out["cpu_temp"] = (
        _result(AVAILABLE, ", ".join(temps.keys()))
        if temps
        else _result(NOT_AVAILABLE, "not exposed on this OS/laptop (expected on Windows)")
    )

    fans_fn = getattr(psutil, "sensors_fans", None)
    fans = fans_fn() if fans_fn else {}
    out["fan_rpm"] = (
        _result(AVAILABLE, ", ".join(fans.keys()))
        if fans
        else _result(NOT_AVAILABLE, "not exposed on this OS/laptop (expected on Windows)")
    )
    return out


def probe_battery_capacity() -> dict:
    reading = battery_collector.read_capacity()
    if reading is None:
        return _result(
            NOT_AVAILABLE,
            "could not read design/full capacity (desktop, or powercfg/sysfs unavailable)",
        )
    health = reading["fullChargeWh"] / reading["designWh"] * 100
    return _result(
        AVAILABLE,
        f"design {reading['designWh']} Wh, full {reading['fullChargeWh']} Wh, "
        f"health {health:.1f}%, cycles {reading['cycles']}",
    )


def probe_smartctl() -> dict:
    exe = shutil.which("smartctl")
    if not exe:
        return _result(
            NOT_AVAILABLE,
            "smartctl not installed (optional): install smartmontools for SMART data",
        )
    try:
        proc = subprocess.run(
            [exe, "--scan"], capture_output=True, text=True, timeout=20, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return _result(NOT_AVAILABLE, f"smartctl failed to run: {exc}")

    devices = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    if not devices:
        return _result(NEEDS_ADMIN, "no devices listed: rerun the probe as Administrator/root")

    first = devices[0].split()[0]
    try:
        info = subprocess.run(
            [exe, "-H", first], capture_output=True, text=True, timeout=20, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return _result(NOT_AVAILABLE, f"smartctl -H failed: {exc}")

    text = (info.stdout + info.stderr).lower()
    if "permission denied" in text or "administrator" in text or "access is denied" in text:
        return _result(NEEDS_ADMIN, f"found {first} but need elevated rights")
    if "smart" in text and ("passed" in text or "ok" in text or "failed" in text):
        return _result(AVAILABLE, f"{len(devices)} device(s); first: {first}")
    return _result(NOT_AVAILABLE, f"smartctl ran on {first} but returned no SMART health")


def run_probe() -> dict:
    signals = probe_psutil()
    signals["battery_capacity"] = probe_battery_capacity()
    signals["smart_storage"] = probe_smartctl()

    ready = {
        "battery_detector_live": signals["battery_capacity"]["status"] == AVAILABLE,
        "root_cause_live": signals["cpu_load"]["status"] == AVAILABLE
        and signals["memory"]["status"] == AVAILABLE,
        "storage_tier": (
            "A (SMART)" if signals["smart_storage"]["status"] == AVAILABLE else "B (latency probe)"
        ),
        "thermal_live": (
            "temperature"
            if signals["cpu_temp"]["status"] == AVAILABLE
            else "frequency only (no temperature: thermal rule uses simulator)"
            if signals["cpu_freq"]["status"] == AVAILABLE
            else "no (simulator only)"
        ),
        "throttling_rule_live": signals["cpu_freq"]["status"] == AVAILABLE,
        "disk_time_counters": "see docs/test-results.md (Windows counters did not advance on the first laptop)",
    }

    return {
        "host": socket.gethostname(),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "probedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "signals": signals,
        "ready": ready,
    }


def render_table(report: dict) -> str:
    lines = [
        f"DevicePulse probe for {report['host']} ({report['platform']})",
        "",
        f"{'Signal':<20}{'Status':<15}Detail",
        "-" * 78,
    ]
    for name, res in report["signals"].items():
        lines.append(f"{name:<20}{res['status']:<15}{res['detail']}")
    lines += ["", "Ready to demo live:"]
    for key, value in report["ready"].items():
        lines.append(f"  {key}: {value}")
    if not report["ready"]["battery_detector_live"]:
        lines.append("")
        lines.append("WARNING: battery detector cannot run live here. Use another laptop or the simulator.")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    report = run_probe()
    print(render_table(report))
    if "--save" in argv:
        out_dir = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "probe-results"
        )
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, f"{report['host']}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
        print(f"\nSaved {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
