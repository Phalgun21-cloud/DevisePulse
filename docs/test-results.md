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
| Diagnosis: disk busy / latency | **Real** (from 2b on) | Windows PhysicalDisk counters; psutil's are wrong on Windows |
| Storage Tier A (SMART) | **Simulated / fixtures only** | smartctl not installed |
| Storage Tier B (timed write/read) | **Real** (probe runs; findings need 3 days of baseline) | needs only a temp file |
| Storage free space | **Real** (10.1% at probe time) | shutil.disk_usage |
| Thermal (temperature at same load) | **Simulated only** | no temperature source |
| Thermal fallback (frequency drop under load) | Real frequency available | Windows performance counter |

## Task 2 leftovers (2b), 2026-09-30, same laptop

Built: processes grouped by name before ranking (with a `count`); `chaos/mem_hog.py` and `chaos/disk_hog.py`;
`chaos/e2e_diagnose.ps1 -Scenarios cpu,memory,disk`; diagnose results now also return the raw sample as evidence.
Tests: 72 server (Vitest), 67 agent (pytest). All new tests were seen failing first.

Real run of `chaos\e2e_diagnose.ps1` (all three scenarios): **23 checks: 22 PASS, 1 INFO, 0 FAIL.**

| Scenario | Result on this laptop |
| --- | --- |
| CPU (`cpu_hog`, 8 cores) | cpu_saturated ranked 1st, CPU 100%, "python.exe (10 processes) ... 86.1% of CPU" (8 workers + hog parent + agent) |
| Memory (`mem_hog`, target 93%) | memory_pressure found: memUsedPct 92.5, biggest user python.exe x2 = 2450 MB. Swap activity null (Windows). |
| Disk (`disk_hog`, 1 GB file, 42.8 GB written) | Readings are real: busy 28.8%, latency 0.25 ms. disk_saturated **did not fire**: this NVMe is not saturated by one sequential writer. Not a code failure; the rule could not be triggered on this laptop. |
| Cleanup | all hogs printed Done; disk temp file deleted; none left in %TEMP% |

Two more real-hardware findings, both fixed test-first (no thresholds changed):
1. **mem_hog first version was compressed away.** It held 1.75 GB of a repeated byte and reported 93% used, but the agent read
   88.5% 10 s later (Windows memory compression). Now filled with `os.urandom` chunks; the diagnosis then read 92.5%.
2. **psutil's Windows disk time counters are wrong, not just frozen.** While 40 GB was being written they gave `diskBusyPct 0.1`.
   On Windows the agent now uses the `PhysicalDisk(_Total)` counters (`% Idle Time`, `Avg. Disk sec/Transfer`,
   `Disk Transfers/sec`) via typeperf, no admin: idle about 0% busy, under disk_hog 21-77% busy (about 32% average).
   psutil disk time is no longer used on Windows at all. `% Idle Time` can read above 100 (seen 140.5), so it is clamped.

The e2e script itself needed two fixes during the run (shown as FAILs in earlier runs, not hidden): the `yes` stdin file was
held open by cpu_hog's worker processes, and force-stopping hogs skipped their cleanup. Hogs now each get their own stdin file
and are allowed to finish on their own.

## Task 3: storage health, 2026-09-30

Built: `server/src/detectors/storage.js` (5 rules), `evaluateStorage` in `evaluate.js` (2-to-show / 3-to-clear lifecycle,
run only when a new storage reading arrives), storage explanations, ingest validation (probe time must be > 0 or null,
free space 0-100 or null), `agent/collectors/storage.py` (smartctl JSON parser, timed 8 MB write+fsync+read, free space),
agent sends a storage sample every 15 min (`--storage-every 900`). Seeded storage scenarios in `simulator/generate.js`.
Tests: **server 106 passed (106)** (32 new in `storage.test.js`, 2 new in `api.test.js`), **agent 78 passed**.
Test-first: `storage.test.js` failed on the missing module, the 2 API tests failed (`expected [] to have a length of 1`,
`expected 400, got 200`), `test_storage.py` failed on import, before the code was written.

**Mutation check** (each change made the suite fail, code restored afterwards, 32/32 passing again):
recent median replaced by max -> the one-hour-spike test failed; slow disk alone forced to Attention -> 3 tests failed;
skipped rules treated as normal checks -> the "SMART went missing does not clear a finding" test failed.

| Scenario | Result |
| --- | --- |
| Healthy storage, 30 days | nothing above Information |
| NVMe wear 85% | Attention, not Urgent |
| NVMe critical warning / spare at threshold | Urgent, explanation says back up now |
| Media errors 0 -> 2 -> 6 over 3 weeks | Attention; a single weekly rise is Watch |
| SATA pending sectors | Attention |
| Slow disk 4x from day 7 | Watch by end of day 1 (lifecycle: active before day 8), **still Watch on day 3** |
| Slow disk 4x + free space 4% | Attention (co-moving), never Urgent |
| One-hour 10x spike | no finding at any point, no active finding through the real lifecycle |
| Free space 8% / 4% / 20% | Information / Watch / nothing |
| No SMART | SMART rules skipped, probe rule still runs |
| All null, no samples, probe times of 0 | no crash, no finding, zeros ignored |

**Decision recorded (user, 2026-09-30):** the scenario table said "Attention by day 3" for a persistent slow disk, which
conflicts with rule 3 (one signal never above Watch). The user chose to keep rule 3: slow disk alone stays Watch; the
table row in CLAUDE.md was changed to match. No threshold was changed to make a test pass.

**Real on this laptop:** Tier B only. Timed probe 17.98 / 20.47 / 28.96 ms in three runs; no probe file left in %TEMP%.
Free space on the system drive **10.1%** (just above the 10% Information line). A real agent `--once` upload stored the
storage sample with all SMART fields `null`; no finding (baseline needs 3 days, free space not below 10%).
**Tier A (SMART) is fixtures only:** smartctl is not installed and nothing was installed. The two fixtures
(`agent/tests/fixtures/smartctl_nvme.json`, `smartctl_sata.json`) are HAND-WRITTEN in smartmontools' JSON shape, not captured.

## Task 4: thermal detector, 2026-09-30

**On this laptop the thermal detector runs on simulated data only for temperature:** Windows exposes no CPU temperature
here (psutil none, thermal-zone counter "No valid counters", WMI "Not supported"). The frequency fallback has real input
(Windows `% Processor Performance` counter) but has not produced a finding on real hardware. Findings from simulator-fed
devices carry `data: "Simulated"` in the API (devices can be created with `simulated: true`); real devices carry `data: "Real"`.

Built: `server/src/detectors/thermal.js`, `evaluateThermalIfDue` (at most hourly, by data time; last run kept in a new
`evaluations` table), thermal explanations, `thermal` settings block, seeded `cpuSeries` / `thermalScenarios` in the simulator,
agent sends `pluggedIn` with every CPU sample. Tests: **server 125 passed (125)** (19 new in `thermal.test.js`),
**agent 80 passed**. `thermal.test.js` failed on the missing module before the code existed.

| Scenario | Result |
| --- | --- |
| Healthy, days 8-14 | no thermal finding |
| +12 C at the same load from day 10 | Watch (rise 10-14 C at like load), basis temperature |
| +12 C and 20% frequency drop at load >= 60% | Attention, never Urgent |
| Hotter because busier (whole-day mean rose more than 10 C) | no finding (compared within 20-point load bands) |
| No temperature, 25% frequency drop under sustained load > 80% | Watch, basis frequency |
| No temperature, 50% drop | still Watch (one signal never above Watch) |
| No temperature, no change / unplugged after day 10 | no finding |
| No temperature and no frequency / no samples | rule skipped, no crash |
| Before 7 days of baseline | collecting_baseline, no finding |
| API replay into a simulated device | active Attention with `data: "Simulated"` |

**Mutation check** (each broke at least one test; code restored, 19/19 again): no load bands -> 3 failed (incl. busier);
frequency alone allowed to Attention -> 1 failed; power state ignored -> the on-battery test failed; thermal on every CPU
sample -> the hourly test failed.

Design choices (mine, recorded): frequency drop that confirms a temperature rise needs 10% (`freqDropWithHeatPct`); frequency
alone needs 20% (`freqDropAlonePct`, from the plan). Temperature change is the recent-sample-weighted mean of per-band medians.
Only like power states are compared, because an unplugged laptop is slower by design (would otherwise be a false alarm).
Test data change, not a threshold change: the first "hotter because busier" scenario only warmed the laptop 6.1 C overall,
which would not have tripped even a naive detector; it was made busier all day so the trap is real (> 10 C overall).

**Flaky run seen once, not reproduced:** one full `npm test` right after the thermal mutation check reported
"Test Files 4 passed (5), Tests 97 passed (125)" and an unhandled-error warning. The output was cut off before the error
itself, so the cause is unknown. Six immediate reruns of the full server suite all gave 125 passed (125). Not fixed; watch for it.

## Task 6: web dashboard, 2026-09-30

React 19 + Vite 8 + React Router 8 + Tailwind 4 + Recharts 3 + Axios, served by the API from `web/dist` (one process).
New API: device summary (`GET /api/devices/:id`, forecasts as month ranges only, no dates), diagnose history,
`POST /api/demo/seed` (simulated devices replayed through the real detectors and lifecycle), `GET /api/fleet/demo`
(synthetic 200 laptops, planted Model A / BIOS 1.4.2 battery problem, groups under 10 hidden).
Tests: **server 135 passed (135)** (10 new in `dashboard.test.js`, written first; 8 failed before the code),
**agent 80 passed**. `npm run build` succeeds (bundle-size warning only).

**Verified by hand in the built-in browser against the real server on this laptop (NOT an automated browser test):**
registered and signed in through the form; loaded the demo devices (4 simulated, 3 at Attention, all labelled
SIMULATED); added a real device in the UI, ran the exact agent command the page showed, and the device page showed
live readings (battery 55.4% "collecting 1 of 5 days", CPU, speed 0.58x, probe 18.9 ms, free 10.2%, SMART and
temperature "Not available on this device"); ran Diagnose from the UI with the live agent: pending -> sampling -> done,
"No clear cause" (idle laptop), grouped processes, disk 0.1% / 0.29 ms; LAB-07 showed the forecast band and
"roughly 3.6 to 8.4 months (confidence: Moderate)". No console errors.
Bugs found this way and fixed: header links and the white-on-teal Diagnose button were unreadable (unlayered CSS
overrode Tailwind utilities); chart axis showed "100.1%".
Animations, cursor effects and transitions are CSS/JS only and switch off under prefers-reduced-motion.

## MySQL 8.0 and app shell, 2026-09-30

Database access moved to one async adapter (SQLite + MySQL 8.0 via mysql2). Tests: **server 136 passed, 1 skipped**
(`mysql.test.js`, skipped because no `TEST_MYSQL_URL`), agent 80 passed. The existing local SQLite file migrated in place
(column `"values"` -> `vals`): after restart the real device still showed all earlier readings, and the live agent kept
uploading. Device rename/delete (API + settings panel with a confirmation dialog), toasts, sidebar with account and
database indicator. Saving the device model in the browser: `PATCH /api/devices/6 -> 200`.

**NOT verified against a real MySQL server:** MySQL 8.0 is installed here (service MySQL80, running) but no DevicePulse
database user exists yet, and the root password was not used. Run `tests/mysql.test.js` with `TEST_MYSQL_URL` to verify.

**Intermittent crash, now reproduced:** the full server suite with test files in parallel ended with "Worker exited
unexpectedly" (103 of 135 run); each file passed alone (39, 17, 18, 32, 19, 10). Mitigation: `fileParallelism: false`.
The root cause (likely memory in parallel workers holding large in-memory databases) is not confirmed.

## Device dashboard with date ranges, 2026-09-30

New `GET /api/devices/:id/timeseries?kind=cpu|storage|battery&range=24h|7d|30d|90d|1y|all` (or `from`/`to`): readings
bucketed so a chart has at most ~240 points (1 min to 30 days per bucket), avg/min/max per bucket, range statistics
(avg, min, peak, latest, count), missing sensors null with count 0, gaps in time break the line. Raw samples accept
`from`/`to`. Tests: **server 146 passed, 1 skipped (MySQL)** (10 new in `timeseries.test.js`, seen failing first).

Device page is now a tabbed dashboard (Overview, Performance, Storage, Battery, Findings timeline, Diagnoses, Raw data
with CSV export, Settings), with a date-range picker (24 h / 7 d / 30 d / 90 d / all / custom dates) kept in the URL,
and auto-refresh every minute for real devices. Checked by hand in the browser (not an automated test): real laptop
Overview over 24 h (29 readings, avg CPU 22.6%, peak memory 88.8%, disk test avg 24.7 ms); LAB-21 Performance over 30 d
(4,032 readings in 3-hour buckets); LAB-12 Storage (960 disk tests) and Findings timeline; LAB-07 Battery over all time
(181 days, forecast band); real Raw data (30 rows, blanks for unmeasured). No console errors. Two display bugs found
and fixed during the check (KPI "no readings" hint shown under real values; "0.0%" axis labels).

## Also verified by hand
- Real server + real agent, one upload: sample stored, missing CPU temperature kept as null (not zero).
- Wrong device token: server answers 401, agent keeps the sample buffered.
- Mutation check: deliberately breaking (a) the device ownership check, (b) the two-detection rule, (c) duplicate protection made the suite fail each time; code restored afterwards.

## NOT yet run (do not claim these)
- Probe on any laptop other than the Dell Inspiron 15 5510 (task 1 asks for every demo laptop).
- The throttling rule against a laptop that actually throttles (only the counter reading was verified, not a throttle event).
- Task 2: disk_saturated firing on real hardware (this NVMe could not be saturated), and the throttling rule firing (no throttle event produced). Request expiry was tested only in Vitest, not by waiting 10 minutes on the real agent.
- Storage Tier A on a real drive: the smartctl parser has only seen hand-written fixtures. Needs smartctl (and usually Administrator) on a demo laptop.
- Storage Tier B over days on a real laptop: the 3-day baseline, the 24 h median and a real slow-disk finding have only run on simulated data.
- Thermal on real hardware: no temperature exists on the first laptop; the frequency fallback has never fired on a real device.
- The unhandled-error flake seen once in the full server suite (see Task 4).
- 48-hour soak; an AUTOMATED end-to-end browser test (the dashboard was only checked by hand); Postgres (task 7); deployment (task 10).
- Scenario accuracy over 200 healthy simulated devices (only the battery scenarios exist so far).

## Design decision recorded
Forecast range uses slope +/- 2 standard errors (about 95%), not 1 as first drafted, because 1 SE only covers about 68%.
When the decline is accelerating, the early bound uses the recent decline rate; otherwise a straight line over all history
gave a falsely reassuring 9 months when the recent rate implied about 3.6.
