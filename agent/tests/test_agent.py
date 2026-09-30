import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import agent  # noqa: E402
from collectors.battery import parse_powercfg_xml  # noqa: E402

# Shape follows `powercfg /batteryreport /xml` (namespaced, capacities in mWh).
# Confirm on a real Windows laptop with: python agent/probe.py
POWERCFG_XML = """<?xml version="1.0" encoding="UTF-8"?>
<BatteryReport xmlns="http://schemas.microsoft.com/battery/2012">
  <ReportInformation><ComputerName>LAPTOP-142</ComputerName></ReportInformation>
  <Batteries>
    <Battery>
      <Id>DELL 4XKCC12</Id>
      <Manufacturer>SMP</Manufacturer>
      <DesignCapacity>60000</DesignCapacity>
      <FullChargeCapacity>46000</FullChargeCapacity>
      <CycleCount>512</CycleCount>
    </Battery>
  </Batteries>
</BatteryReport>
"""


# ---- powercfg parser ----------------------------------------------------------------


def test_parse_powercfg_xml_reads_capacity_in_wh():
    got = parse_powercfg_xml(POWERCFG_XML)
    assert got == {"designWh": 60.0, "fullChargeWh": 46.0, "cycles": 512}


def test_parse_powercfg_xml_handles_missing_cycle_count():
    xml = POWERCFG_XML.replace("<CycleCount>512</CycleCount>", "")
    got = parse_powercfg_xml(xml)
    assert got["cycles"] is None
    assert got["fullChargeWh"] == 46.0


REAL_XML_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "powercfg_inspiron_5510.xml")


def test_parse_real_powercfg_xml_from_windows_11_laptop():
    with open(REAL_XML_PATH, encoding="utf-8") as fh:
        got = parse_powercfg_xml(fh.read())
    assert got["designWh"] == 54.0
    assert abs(got["fullChargeWh"] - 29.9) < 0.01


def test_cycle_count_zero_means_not_reported_not_zero_cycles():
    # Real Dell firmware reports <CycleCount>0</CycleCount> on a battery at 55% health.
    with open(REAL_XML_PATH, encoding="utf-8") as fh:
        assert parse_powercfg_xml(fh.read())["cycles"] is None


def test_parse_powercfg_xml_returns_none_for_garbage():
    assert parse_powercfg_xml("not xml at all") is None
    assert parse_powercfg_xml("<BatteryReport/>") is None


def test_parse_powercfg_xml_rejects_zero_capacity():
    xml = POWERCFG_XML.replace("<FullChargeCapacity>46000<", "<FullChargeCapacity>0<")
    assert parse_powercfg_xml(xml) is None


# ---- build_payload ------------------------------------------------------------------


def test_build_payload_with_both_readings():
    samples = agent.build_payload(
        {"designWh": 60.0, "fullChargeWh": 46.0}, {"cpuLoadPct": 12.0}, ts="2026-09-30T10:00:00Z"
    )
    assert [s["kind"] for s in samples] == ["battery", "cpu"]
    assert all(s["ts"] == "2026-09-30T10:00:00Z" for s in samples)


def test_build_payload_skips_missing_sensors_instead_of_zero():
    assert agent.build_payload(None, None) == []
    only_cpu = agent.build_payload(None, {"cpuLoadPct": 5.0}, ts="2026-09-30T10:00:00Z")
    assert [s["kind"] for s in only_cpu] == ["cpu"]


# ---- buffer -------------------------------------------------------------------------


def test_buffer_roundtrip_and_torn_line(tmp_path):
    path = str(tmp_path / "buf.jsonl")
    agent.buffer_append(path, [{"ts": "a", "kind": "cpu", "values": {}}])
    with open(path, "a", encoding="utf-8") as fh:
        fh.write('{"ts": "torn"')  # simulated crash mid-write
    assert len(agent.buffer_read(path)) == 1
    agent.buffer_clear(path)
    assert agent.buffer_read(path) == []


# ---- upload / flush with a fake HTTP session ----------------------------------------


class FakeResp:
    def __init__(self, code):
        self.status_code = code


class FakeSession:
    def __init__(self, codes):
        self.codes = list(codes)
        self.calls = []

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"url": url, "json": json, "headers": headers})
        code = self.codes.pop(0)
        if code == "boom":
            raise ConnectionError("offline")
        return FakeResp(code)


def _sample(n):
    return {"ts": f"2026-09-30T10:{n:02d}:00Z", "kind": "cpu", "values": {"cpuLoadPct": n}}


def test_upload_sends_bearer_token_and_returns_true_on_200():
    sess = FakeSession([200])
    assert agent.upload("http://x", "tok", [_sample(1)], session=sess) is True
    assert sess.calls[0]["headers"]["Authorization"] == "Bearer tok"
    assert sess.calls[0]["url"] == "http://x/api/ingest"


def test_upload_returns_false_when_offline_or_unauthorized():
    assert agent.upload("http://x", "t", [_sample(1)], session=FakeSession(["boom"])) is False
    assert agent.upload("http://x", "t", [_sample(1)], session=FakeSession([401])) is False


def test_flush_keeps_buffer_when_offline_then_sends_in_order(tmp_path):
    path = str(tmp_path / "buf.jsonl")
    agent.buffer_append(path, [_sample(1), _sample(2), _sample(3)])

    # network down: nothing sent, everything kept
    assert agent.flush("http://x", "t", path, session=FakeSession(["boom"])) == 0
    assert len(agent.buffer_read(path)) == 3

    # network back: all sent in original order, buffer emptied
    sess = FakeSession([200])
    assert agent.flush("http://x", "t", path, session=sess) == 3
    sent_ts = [s["ts"] for s in sess.calls[0]["json"]["samples"]]
    assert sent_ts == sorted(sent_ts)
    assert agent.buffer_read(path) == []


def test_flush_splits_large_backlog_into_batches(tmp_path):
    path = str(tmp_path / "buf.jsonl")
    agent.buffer_append(path, [_sample(i % 60) for i in range(250)])
    sess = FakeSession([200, 200, 200])
    assert agent.flush("http://x", "t", path, session=sess) == 250
    assert [len(c["json"]["samples"]) for c in sess.calls] == [100, 100, 50]


def test_flush_keeps_unsent_remainder_after_partial_failure(tmp_path):
    path = str(tmp_path / "buf.jsonl")
    agent.buffer_append(path, [_sample(i % 60) for i in range(150)])
    assert agent.flush("http://x", "t", path, session=FakeSession([200, "boom"])) == 100
    assert len(agent.buffer_read(path)) == 50


def test_run_once_survives_missing_sensors(tmp_path, monkeypatch):
    path = str(tmp_path / "buf.jsonl")
    monkeypatch.setattr(agent, "collect", lambda include_battery: (None, None))
    sess = FakeSession([])
    assert agent.run_once("http://x", "t", path, include_battery=True, session=sess) == 0
    assert sess.calls == []  # nothing collected, nothing uploaded, no crash
