import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import agent  # noqa: E402
from collectors.storage import (  # noqa: E402
    free_space,
    parse_smartctl_json,
    read_smart,
    storage_values,
    time_io_probe,
)

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def load(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as fh:
        return json.load(fh)


NULL_SMART = {
    "smartPassed": None,
    "criticalWarning": None,
    "availableSparePct": None,
    "availableSpareThresholdPct": None,
    "percentageUsed": None,
    "mediaErrors": None,
    "reallocatedSectors": None,
    "pendingSectors": None,
}

# ---- smartctl JSON --------------------------------------------------------------------


def test_parse_nvme():
    assert parse_smartctl_json(load("smartctl_nvme.json")) == {
        "smartPassed": True,
        "criticalWarning": 0,
        "availableSparePct": 100,
        "availableSpareThresholdPct": 10,
        "percentageUsed": 85,
        "mediaErrors": 3,
        "reallocatedSectors": None,
        "pendingSectors": None,
    }


def test_parse_sata():
    got = parse_smartctl_json(load("smartctl_sata.json"))
    assert got["reallocatedSectors"] == 16
    assert got["pendingSectors"] == 2
    assert got["percentageUsed"] is None  # NVMe-only field stays null, never 0
    assert got["smartPassed"] is True


def test_parse_garbage_gives_all_null():
    assert parse_smartctl_json({}) == NULL_SMART
    assert parse_smartctl_json({"nvme_smart_health_information_log": {"percentage_used": "n/a"}}) == NULL_SMART


def test_read_smart_without_smartctl_is_none_and_never_elevates(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda name: None)
    assert read_smart() is None


# ---- Tier B timed probe ---------------------------------------------------------------


def test_io_probe_times_and_cleans_up(tmp_path):
    ms = time_io_probe(str(tmp_path), size=256 * 1024)
    assert ms is not None and ms > 0
    assert os.listdir(tmp_path) == []  # temp file removed


def test_io_probe_never_reports_zero(tmp_path):
    ticks = iter([5.0, 5.0])  # a clock that did not advance
    assert time_io_probe(str(tmp_path), size=4096, clock=lambda: next(ticks)) is None
    assert os.listdir(tmp_path) == []


def test_io_probe_failure_is_none_and_cleans_up(tmp_path):
    missing = str(tmp_path / "does-not-exist")
    assert time_io_probe(missing, size=4096) is None


def test_free_space_is_a_percentage(tmp_path):
    pct = free_space(str(tmp_path))
    assert pct is not None and 0 <= pct <= 100


# ---- sample assembly ------------------------------------------------------------------


def test_storage_values_without_smart_keeps_nulls():
    got = storage_values(io_ms=41.2, free_pct=37.5, smart=None)
    assert got == {"ioProbeMs": 41.2, "freeSpacePct": 37.5, **NULL_SMART}


def test_build_payload_adds_storage_sample():
    samples = agent.build_payload(None, {"cpuLoadPct": 1.0}, ts="2026-09-30T10:00:00Z", storage={"ioProbeMs": 40.0})
    assert [s["kind"] for s in samples] == ["cpu", "storage"]


def test_build_payload_skips_missing_storage():
    assert [s["kind"] for s in agent.build_payload(None, {"cpuLoadPct": 1.0}, ts="2026-09-30T10:00:00Z")] == ["cpu"]
