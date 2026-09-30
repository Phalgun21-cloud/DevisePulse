# Test results

Run date: 2026-09-30 (cloud Linux workspace, Node 22, Python 3.11)
Commit: not recorded (files were written into the repo after this run; add the hash when you commit)

| Level | Tool | Result |
| --- | --- | --- |
| 1. Detector unit tests (battery) | Vitest | included in server total below |
| 2. Agent unit tests | pytest | 13 passed in 0.02s |
| 3. API integration and security | Vitest + supertest | included in server total below |
| Server total (levels 1 and 3) | Vitest | Tests  44 passed (44) |

## Task 2: slow-laptop diagnosis (added 2026-09-30, Windows 11, Node 22, Python 3.14)

| Level | Tool | Result |
| --- | --- | --- |
| Diagnose detector (17 tests: each rule, ranking, nulls, settings, wording) | Vitest | passed |
| Command channel API (9 tests: round trip, one open request, ownership 404s, 409 reuse, strict body, nulls, expiry, latency baseline) | Vitest + supertest | passed |
| Server total | Vitest | 70 passed (70) |
| Agent: diagnose sampler, command polling, chaos safety checks | pytest | 40 passed in 0.16s (total, incl. the earlier 13) |

Written test-first: the detector and API tests were run and seen failing before the code existed.

Run by hand on this Windows 11 laptop (real server + real agent, hidden windows, temp database):
- Diagnose request -> agent polled -> 10 s real sample posted -> result `done` in about 20 s (poll interval 15 s + 10 s sample).
  Machine was idle, so the verdict was `no_clear_cause`, which is the correct answer. `disk_saturated` was skipped (see below).

**Real-hardware finding (drove a fix):** on this laptop psutil's Windows `read_time` / `write_time` never advance
(4793 / 1069 before and after 174 disk operations). The first version therefore reported "0% busy, 0 ms latency",
which was an invented reading. The agent now sends `null` for disk busy and latency when operations happened but no
time was counted, and never sends a latency of 0. Consequence: on Windows the disk rule is usually skipped
until task 3 adds the timed write/read probe. Swap activity is also `null` on Windows (psutil cannot measure it there).

**Task 2 gate: PASSED** on 2026-09-30, this Windows 11 laptop (8 logical cores), with `chaos\e2e_diagnose.ps1`
(own API on port 4100, throwaway database, real agent, real `cpu_hog.py`). 11/11 checks passed:

| Check | Result |
| --- | --- |
| API starts, account and device created | PASS |
| Agent uploads a real CPU sample | PASS: cpuLoadPct 18, cpuFreqMHz 2496, cpuTempC null, memUsedPct 81.6, diskBusyMs null |
| Idle diagnosis | PASS: pending -> running -> done in 28 s, `no_clear_cause`, `disk_saturated` skipped |
| Another user reads the diagnosis | PASS: HTTP 404 |
| `cpu_hog.py` (90 s, all 8 cores) + diagnosis | PASS: done in 28 s, rank 1 `cpu_saturated`, cpuPct 100, process `python.exe` |
| Explanation | PASS: names python.exe, "consistent with", no banned phrases |

After the run: no python/agent/hog processes left, port 4100 free.
The first attempt of the script reported a false FAIL (its own `^Running` pattern missed text on the prompt line);
the pattern was fixed and the whole run repeated. The detector and agent were not changed between runs.

Limitation seen: the hog is 8 processes of about 11.6% each, so the explanation says python.exe used "11.6% of CPU"
even though together they used about 93%. The rule still named the right process. Grouping processes by name would
make this read correctly (it matters for Chrome too) and is not done yet.

Design choices recorded: disk latency baseline is the median of the device's own earlier completed diagnoses and needs
at least 3 (`diagnose.baselineMinDiagnoses`); until then only the busy-percent part of the disk rule can fire.
A diagnosis workers' process name shows as `python.exe`, because the agent sends names only (no command lines, rule 6).

## Probe of the first real laptop (2026-09-30)

Dell Inspiron 15 5510, Windows 11 (build 26200), Python 3.14, not elevated. Saved as `docs/probe-results/Phalgun.json`.

| Signal | Status on this laptop | How |
| --- | --- | --- |
| CPU load, memory | available | psutil |
| Battery capacity | **available**: design 54.0 Wh, full 29.89 Wh, health 55.4% | `powercfg /batteryreport /xml`, no admin needed |
| Battery cycle count | not reported (firmware writes `0`) | now sent as `null`, see below |
| Battery percent / plugged in | available | psutil |
| CPU frequency | available via Windows counter only | `typeperf "\Processor Information(_Total)\% Processor Performance"`, no admin |
| CPU temperature | **not available** | psutil: none; `Thermal Zone Information` counter: "No valid counters"; WMI `MSAcpi_ThermalZoneTemperature`: "Not supported" |
| Fan speed | not available | psutil: none |
| Disk busy / latency (psutil) | not usable | Windows `read_time`/`write_time` do not advance (task 2 finding) |
| SMART | not available | smartctl not installed (nothing installed, per instructions) |

**powercfg parser on real Windows: CONFIRMED.** The real XML (sanitised copy in `agent/tests/fixtures/powercfg_inspiron_5510.xml`)
parses to 54.0 / 29.9 Wh. One bug found and fixed test-first: `<CycleCount>0</CycleCount>` was sent as 0 cycles on a
battery at 55% health. A cycle count of 0 is now `null` (test `test_cycle_count_zero_means_not_reported_not_zero_cycles`,
seen failing with `assert 0 is None` before the fix).

**Real-hardware finding (drove a fix): psutil CPU frequency is a constant on Windows.** `psutil.cpu_freq()` gave
current=2496, max=2496 both idle and with all 8 cores at 100%. The Windows `% Processor Performance` counter over the same
load read 142-149% of base (turbo) and about 61-76% at idle. So every `cpuFreqMHz` sent before this change was the base clock
presented as a measurement, and `cpuFreqRatio` was always 1.0, meaning the throttling rule could never fire on Windows.
Now: on Windows the agent uses the counter (effective MHz = base x counter%, ratio = counter% / 100), and sends `null` if the
counter cannot be read (it is a localised counter name, so non-English Windows will likely get `null`). psutil's value is never used on
Windows. After the change, real readings: ratio 1.28 (1 s sample) and 1.40 (5 s diagnose window). 9 new tests in `test_system.py`,
seen failing on import before the code existed.

### Real vs Simulated, per detector, on this laptop

| Detector | Data on this laptop | Why |
| --- | --- | --- |
| Battery wear + forecast | **Real** (needs 14 days of readings before any forecast) | powercfg capacity reads |
| Slow-laptop diagnosis: CPU, memory % | **Real** | psutil |
| Diagnosis: throttling | **Real** (from this change on) | Windows performance counter |
| Diagnosis: swap activity | Not available (rule uses memory % only) | psutil cannot measure paging on Windows |
| Diagnosis: disk busy / latency | Not available from psutil; task 3's timed probe is the replacement | time counters frozen |
| Storage Tier A (SMART) | **Simulated / fixtures only** | smartctl not installed |
| Storage Tier B (timed write/read) | Real once built (task 3) | needs only a temp file |
| Thermal (temperature at same load) | **Simulated only** | no temperature source |
| Thermal fallback (frequency drop under load) | Real frequency available | Windows performance counter |

## Also verified by hand
- Real server + real agent, one upload: sample stored, missing CPU temperature kept as null (not zero).
- Wrong device token: server answers 401, agent keeps the sample buffered.
- Mutation check: deliberately breaking (a) the device ownership check, (b) the two-detection rule, (c) duplicate protection made the suite fail each time; code restored afterwards.

## NOT yet run (do not claim these)
- Probe on any laptop other than the Dell Inspiron 15 5510 (task 1 asks for every demo laptop).
- The throttling rule against a laptop that actually throttles (only the counter reading was verified, not a throttle event).
- Task 2: memory, throttling and disk-busy rules against real load (unit-tested only; no mem_hog/disk_hog yet). Request expiry was tested only in Vitest, not by waiting 10 minutes on the real agent.
- Storage and thermal detectors: not built yet.
- Real-device fault injection (chaos/), 48-hour soak, web dashboard, end-to-end browser test.
- Scenario accuracy over 200 healthy simulated devices (only the battery scenarios exist so far).

## Design decision recorded
Forecast range uses slope +/- 2 standard errors (about 95%), not 1 as first drafted, because 1 SE only covers about 68%.
When the decline is accelerating, the early bound uses the recent decline rate; otherwise a straight line over all history
gave a falsely reassuring 9 months when the recent rate implied about 3.6.
