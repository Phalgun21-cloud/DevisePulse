"""Battery collector.

Reads design capacity and full-charge capacity (the two numbers needed for
battery health = full / design) plus percent and plugged-in state.

Windows: `powercfg /batteryreport /xml` (values are in mWh).
Linux:   /sys/class/power_supply/BAT*  (energy_* in uWh, or charge_* in uAh).
Anything missing is returned as None; callers must never treat None as zero.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from glob import glob
from typing import Optional


def _local(tag: str) -> str:
    """Strip an XML namespace: '{ns}Name' -> 'Name'."""
    return tag.rsplit("}", 1)[-1]


def parse_powercfg_xml(text: str) -> Optional[dict]:
    """Pure function. Parse a powercfg battery report (XML) into Wh values.

    Returns {"designWh", "fullChargeWh", "cycles"} or None if no battery data.
    """
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return None

    for node in root.iter():
        if _local(node.tag) != "Battery":
            continue
        fields = {_local(child.tag): (child.text or "").strip() for child in node}
        try:
            design_mwh = float(fields["DesignCapacity"])
            full_mwh = float(fields["FullChargeCapacity"])
        except (KeyError, ValueError):
            continue
        if design_mwh <= 0 or full_mwh <= 0:
            continue
        cycles = None
        raw_cycles = fields.get("CycleCount")
        # Firmware that does not track cycles reports 0 (seen on a Dell at 55% health): treat as unknown.
        if raw_cycles and raw_cycles.isdigit() and int(raw_cycles) > 0:
            cycles = int(raw_cycles)
        return {
            "designWh": round(design_mwh / 1000.0, 2),
            "fullChargeWh": round(full_mwh / 1000.0, 2),
            "cycles": cycles,
        }
    return None


def _read_windows_capacity() -> Optional[dict]:
    """Run powercfg and parse its XML output. Does not need admin rights."""
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "battery.xml")
        try:
            subprocess.run(
                ["powercfg", "/batteryreport", "/xml", "/output", out],
                capture_output=True,
                timeout=30,
                check=False,
            )
            with open(out, "r", encoding="utf-8", errors="replace") as fh:
                return parse_powercfg_xml(fh.read())
        except (OSError, subprocess.SubprocessError):
            return None


def _read_number(path: str) -> Optional[float]:
    try:
        with open(path, "r", encoding="ascii") as fh:
            return float(fh.read().strip())
    except (OSError, ValueError):
        return None


def _read_linux_capacity() -> Optional[dict]:
    for base in sorted(glob("/sys/class/power_supply/BAT*")):
        full = _read_number(os.path.join(base, "energy_full"))
        design = _read_number(os.path.join(base, "energy_full_design"))
        if full is None or design is None:
            # Some laptops report charge (uAh) and voltage (uV) instead.
            volt = _read_number(os.path.join(base, "voltage_min_design"))
            cf = _read_number(os.path.join(base, "charge_full"))
            cd = _read_number(os.path.join(base, "charge_full_design"))
            if volt and cf and cd:
                full = cf * volt / 1e6
                design = cd * volt / 1e6
        if full and design and design > 0:
            cycles = _read_number(os.path.join(base, "cycle_count"))
            return {
                "designWh": round(design / 1e6, 2),
                "fullChargeWh": round(full / 1e6, 2),
                "cycles": int(cycles) if cycles and cycles > 0 else None,
            }
    return None


def read_capacity() -> Optional[dict]:
    if sys.platform.startswith("win"):
        return _read_windows_capacity()
    if sys.platform.startswith("linux"):
        return _read_linux_capacity()
    return None  # macOS support is on the roadmap


def read_battery() -> Optional[dict]:
    """Return the battery reading, or None when this device has no battery data."""
    capacity = read_capacity()
    if capacity is None:
        return None

    percent = None
    plugged = None
    try:
        import psutil

        batt = psutil.sensors_battery()
        if batt is not None:
            percent = round(float(batt.percent), 1)
            plugged = bool(batt.power_plugged) if batt.power_plugged is not None else None
    except Exception:  # psutil missing or platform quirk: leave as None
        pass

    return {**capacity, "percent": percent, "pluggedIn": plugged}
