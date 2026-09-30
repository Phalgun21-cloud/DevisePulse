import os
import sys
from types import SimpleNamespace as NS

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import agent  # noqa: E402
from collectors.diagnose import build_diagnose_sample, pick_top_processes  # noqa: E402


def io(reads=0, writes=0, rtime=0, wtime=0, busy=None):
    return NS(read_count=reads, write_count=writes, read_time=rtime, write_time=wtime, busy_time=busy)


def proc(name, cpu, mb):
    return {"name": name, "cpuPct": cpu, "memMb": mb}


BASE = dict(
    elapsed_s=10.0,
    cpu_pct=30.0,
    mem_pct=50.0,
    io0=io(),
    io1=io(),
    swap_io0=(0, 0),
    swap_io1=(0, 0),
    freq_current=3000.0,
    freq_max=3600.0,
    processes=[],
    is_windows=False,
)


def sample(**over):
    return build_diagnose_sample(**{**BASE, **over})


# ---- disk ---------------------------------------------------------------------------


def test_disk_busy_and_latency_from_counter_deltas():
    # 100 operations took 500 ms total over a 10 s window: 5% busy, 5 ms each.
    s = sample(io0=io(10, 10, 100, 100), io1=io(60, 60, 350, 350))
    assert s["diskBusyPct"] == 5.0
    assert s["diskLatencyMs"] == 5.0


def test_disk_busy_is_capped_at_100():
    s = sample(io0=io(0, 0, 0, 0), io1=io(10, 10, 9000, 9000))
    assert s["diskBusyPct"] == 100.0


def test_linux_busy_time_is_preferred_when_present():
    s = sample(io0=io(0, 0, 0, 0, busy=0), io1=io(10, 10, 100, 100, busy=9000))
    assert s["diskBusyPct"] == 90.0


def test_idle_disk_has_no_latency_but_zero_busy():
    s = sample(io0=io(5, 5, 10, 10), io1=io(5, 5, 10, 10))
    assert s["diskBusyPct"] == 0.0
    assert s["diskLatencyMs"] is None  # no operations, so no latency; not 0


def test_frozen_time_counters_with_real_activity_are_unmeasurable_not_zero():
    # Seen on a real Windows 11 laptop: read_time/write_time never advance while the
    # operation counts do. Reporting 0% busy / 0 ms would be an invented reading.
    s = sample(io0=io(1000, 1000, 4793, 1069), io1=io(1004, 1170, 4793, 1069))
    assert s["diskBusyPct"] is None
    assert s["diskLatencyMs"] is None


def test_zero_latency_is_never_reported_even_for_a_handful_of_operations():
    # A baseline of 0 ms would make every later reading look "infinitely slower".
    s = sample(io0=io(100, 100, 50, 50), io1=io(103, 102, 50, 50))
    assert s["diskLatencyMs"] is None


def test_missing_disk_counters_give_none_not_zero():
    s = sample(io0=None, io1=None)
    assert s["diskBusyPct"] is None
    assert s["diskLatencyMs"] is None


def test_counter_that_went_backwards_is_ignored():
    s = sample(io0=io(100, 100, 500, 500), io1=io(10, 10, 5, 5))  # e.g. counter reset
    assert s["diskBusyPct"] is None
    assert s["diskLatencyMs"] is None


# ---- swap and frequency -------------------------------------------------------------


def test_swap_activity_is_bytes_paged_during_the_window():
    s = sample(swap_io0=(1000, 2000), swap_io1=(4000, 7000))
    assert s["swapActivityBytes"] == 8000


def test_swap_activity_is_none_on_windows_where_psutil_cannot_measure_it():
    s = sample(is_windows=True, swap_io0=(0, 0), swap_io1=(0, 0))
    assert s["swapActivityBytes"] is None


def test_frequency_ratio_and_missing_frequency():
    assert sample(freq_current=1800.0, freq_max=3600.0)["cpuFreqRatio"] == 0.5
    assert sample(freq_current=None)["cpuFreqRatio"] is None
    assert sample(freq_max=0)["cpuFreqRatio"] is None  # psutil reports 0 when unknown


def test_frequency_ratio_is_capped_so_turbo_does_not_exceed_limit():
    assert sample(freq_current=4200.0, freq_max=3600.0)["cpuFreqRatio"] <= 1.5


# ---- processes ----------------------------------------------------------------------


def test_top_processes_are_five_with_name_cpu_and_memory_only():
    procs = [proc(f"p{i}.exe", i, 100 + i) for i in range(10)]
    top = pick_top_processes(procs)
    assert len(top) == 5
    assert all(set(p) == {"name", "cpuPct", "memMb", "count"} for p in top)


def test_top_processes_include_a_memory_hog_that_is_not_busy():
    procs = [proc(f"busy{i}.exe", 50 - i, 100) for i in range(8)] + [proc("leak.exe", 0.1, 9000)]
    names = [p["name"] for p in pick_top_processes(procs)]
    assert names[0] == "busy0.exe"
    assert "leak.exe" in names


def test_idle_pseudo_process_is_dropped():
    procs = [proc("System Idle Process", 90, 0), proc("hog.py", 40, 50)]
    assert [p["name"] for p in pick_top_processes(procs)] == ["hog.py"]


def test_processes_with_the_same_name_are_grouped_before_ranking():
    # Real case from the task 2 gate: cpu_hog.py runs as 8 python.exe workers at about 11.6% each.
    procs = [proc("python.exe", 11.6, 12) for _ in range(8)] + [proc("chrome.exe", 20.0, 900)]
    top = pick_top_processes(procs)
    assert top[0] == {"name": "python.exe", "cpuPct": 92.8, "memMb": 96.0, "count": 8}
    assert top[1]["name"] == "chrome.exe" and top[1]["count"] == 1


def test_grouping_ignores_case_and_caps_cpu_at_100():
    procs = [proc("Chrome.exe", 60.0, 100), proc("chrome.exe", 55.0, 100)]
    top = pick_top_processes(procs)
    assert len(top) == 1
    assert top[0]["cpuPct"] == 100.0
    assert top[0]["count"] == 2


def test_sample_contains_no_extra_keys():
    assert set(sample()) == {
        "cpuPct",
        "memUsedPct",
        "swapActivityBytes",
        "diskBusyPct",
        "diskLatencyMs",
        "cpuFreqRatio",
        "topProcesses",
    }


# ---- command channel with a fake HTTP session ---------------------------------------


class Resp:
    def __init__(self, code, body=None):
        self.status_code = code
        self._body = body

    def json(self):
        return self._body


class Session:
    def __init__(self, get_responses=(), post_codes=()):
        self.get_responses = list(get_responses)
        self.post_codes = list(post_codes)
        self.gets = []
        self.posts = []

    def get(self, url, headers=None, timeout=None):
        self.gets.append({"url": url, "headers": headers})
        r = self.get_responses.pop(0)
        if r == "boom":
            raise ConnectionError("offline")
        return r

    def post(self, url, json=None, headers=None, timeout=None):
        self.posts.append({"url": url, "json": json, "headers": headers})
        code = self.post_codes.pop(0)
        if code == "boom":
            raise ConnectionError("offline")
        return Resp(code)


def test_poll_commands_returns_commands_with_bearer_token():
    sess = Session([Resp(200, {"commands": [{"id": 7, "type": "diagnose", "durationSec": 10}]})])
    cmds = agent.poll_commands("http://x", "tok", session=sess)
    assert cmds == [{"id": 7, "type": "diagnose", "durationSec": 10}]
    assert sess.gets[0]["url"] == "http://x/api/agent/commands"
    assert sess.gets[0]["headers"]["Authorization"] == "Bearer tok"


def test_poll_commands_is_quiet_when_offline_or_rejected():
    assert agent.poll_commands("http://x", "t", session=Session(["boom"])) == []
    assert agent.poll_commands("http://x", "t", session=Session([Resp(401)])) == []
    assert agent.poll_commands("http://x", "t", session=Session([Resp(200, {"oops": 1})])) == []


def test_handle_diagnose_command_samples_and_posts_result():
    sess = Session(post_codes=[200])
    fake = {"cpuPct": 97.0, "topProcesses": [{"name": "cpu_hog.py", "cpuPct": 88.0, "memMb": 40.0}]}
    ok = agent.handle_command(
        {"id": 7, "type": "diagnose", "durationSec": 10}, "http://x", "tok", session=sess, sampler=lambda secs: fake
    )
    assert ok is True
    assert sess.posts[0]["url"] == "http://x/api/agent/commands/7/result"
    assert sess.posts[0]["json"] == {"sample": fake}


def test_handle_command_passes_the_requested_duration_but_caps_it():
    seen = []
    sess = Session(post_codes=[200, 200])
    agent.handle_command({"id": 1, "type": "diagnose", "durationSec": 10}, "http://x", "t", session=sess, sampler=lambda s: seen.append(s) or {})
    agent.handle_command({"id": 2, "type": "diagnose", "durationSec": 9999}, "http://x", "t", session=sess, sampler=lambda s: seen.append(s) or {})
    assert seen == [10, 30]


def test_handle_command_ignores_unknown_types():
    sess = Session()
    assert agent.handle_command({"id": 1, "type": "format_disk"}, "http://x", "t", session=sess, sampler=lambda s: {}) is False
    assert sess.posts == []


def test_handle_command_survives_a_failing_sampler_and_a_failed_post():
    def broken(_):
        raise RuntimeError("psutil exploded")

    assert agent.handle_command({"id": 1, "type": "diagnose"}, "http://x", "t", session=Session(), sampler=broken) is False
    assert agent.handle_command({"id": 1, "type": "diagnose"}, "http://x", "t", session=Session(post_codes=["boom"]), sampler=lambda s: {}) is False


def test_sample_carries_the_power_source():
    assert sample(plugged_in=False)["pluggedIn"] is False
    assert sample(plugged_in=None)["pluggedIn"] is None
