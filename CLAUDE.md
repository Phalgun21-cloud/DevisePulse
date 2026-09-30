# DevicePulse: instructions for Claude

DevicePulse is a hackathon project: predictive health monitoring for laptops. A Python agent reads real
numbers, an Express API stores them and runs detectors, and a React dashboard shows findings with evidence.
Theme: Decision Intelligence. Target user: schools, clinics and small offices running old laptops.

Read `README.md` for setup and `docs/test-results.md` for what has and has not been verified.

## Commands (Windows PowerShell, from the repo root)

```powershell
npm run install:all      # server dependencies
npm test                 # server (Vitest) + agent (pytest); must pass before you say a task is done
npm run test:server
npm run test:agent       # if `python` is missing, use: py -m pytest agent -q
npm run dev:server       # API on http://localhost:4000 (needs server\.env with JWT_SECRET)
python agent\probe.py --save
```

## Layout

- `agent/` Python agent. `collect()` talks to the OS; `build_payload()` and buffer helpers are pure and tested.
- `server/src/detectors/` pure functions `(samples, settings, now) -> result`. No database, network or clock inside.
- `server/src/settings.js` ALL thresholds live here. Never hard-code a threshold in a detector.
- `server/src/evaluate.js` runs detectors and manages finding lifecycle (pending, active, cleared).
- `server/src/explain/templates.js` deterministic explanation text. Works with no AI key.
- `simulator/generate.js` seeded synthetic data. Fixed seeds so tests repeat.
- `chaos/` (empty) safe stress scripts for real-device tests. `web/` (empty) React dashboard.

## Rules that must not be broken

1. **Never predict an exact failure date.** Say "elevated risk", "may reach", "consistent with", always with a
   range and a confidence label. Tests check explanations for banned phrases; keep them passing.
2. **Missing sensors are `null`, never zero.** A detector skips rules whose inputs are missing. The UI shows
   "Not available on this device". Never invent a reading.
3. **One signal alone never exceeds Watch.** Attention needs two co-moving signals or a hard SMART warning.
4. **Anti-false-alarm lifecycle:** a finding needs 2 consecutive detections to show and 3 normal checks to clear.
   Trend detectors run only when a NEW battery/relevant reading arrives, not on every one-minute CPU sample.
5. **Label data honestly.** Every screen marks data Real (measured) or Simulated. Never present simulated data as measured.
6. **The agent collects numbers only.** No file contents, browsing data, screen content or personal data.
   Only structured evidence ever goes to an LLM, never raw logs. The AI key lives only in backend env vars.
7. **Chaos scripts must be safe:** ask for confirmation, cap resource use (memory at most 80% of RAM, disk test only
   with 5 GB free), clean up temp files, refuse to run on battery below 30%. Never damage hardware, disable cooling
   or delete user files.
8. **Tests first for detectors.** Write the scenario test from the table below, watch it fail, then implement.
   Do not change a threshold to make a test pass without recording why in `docs/test-results.md`.
9. **Do not claim what was not run.** Update `docs/test-results.md` with real output. Keep the "NOT yet run" list honest.

## Decisions already made (do not silently reverse)

- SQLite via built-in `node:sqlite` (Node >= 22.13, no native build). It is loaded with `createRequire` because
  Vite/Vitest does not recognise the `node:sqlite` import.
- Express 4: async handlers must be wrapped so rejections reach the error handler (see `routes/auth.js`).
- Battery forecast range is slope +/- 2 standard errors (about 95%). When the decline is accelerating, the early
  bound uses the RECENT decline rate, because a straight line over all history falsely reassured (9 months vs about 3.6).
- Battery readings are collapsed to one median point per UTC day before fitting. A forecast needs at least 5 days
  spanning at least 14 days; otherwise report "collecting data" and no forecast.
- Device tokens and passwords are stored only as hashes. Foreign and missing device ids both return 404.
- LLM layer is optional polish. Detection and explanations must work without any AI key.
- Disk busy % and latency on Windows come from the `PhysicalDisk(_Total)` performance counters, never psutil (whose
  Windows time counters read 0.1% busy during a 40 GB write). Elsewhere psutil deltas; `null` when operations were counted
  but no time was. A latency of 0 is never sent. Swap activity is `null` on Windows.
- Top processes are grouped by name (summed CPU and memory, with a `count`) before ranking.
- The agent sends process NAMES only (top 5, with CPU % and memory MB), never command lines, paths or arguments.
  The server's diagnose schema is `.strict()` and rejects any extra field.
- CPU frequency on Windows comes from the `% Processor Performance` counter (typeperf, built in, no admin), never
  from psutil, whose value there is the fixed base clock. Counter unreadable -> `null`. Battery `CycleCount` 0 -> `null`.
- Diagnose disk-latency baseline is the median of the device's own earlier completed diagnoses (at least 3);
  until then only the busy-percent half of the disk rule can fire.

## Scenario table (each row needs a passing test)

| Scenario | Expected | Must not happen |
| --- | --- | --- |
| Healthy device | No finding above Information | Any Watch or higher |
| Battery slow decline | Watch; forecast range contains true 70% date | Attention |
| Battery accelerating | Attention; confidence Moderate or Low | High confidence, or a falsely late forecast |
| Battery little data | "Collecting data", no forecast | Any date shown |
| NVMe wear 85% used | Attention | Urgent |
| NVMe critical warning or spare at threshold | Urgent, back up now | Only Watch |
| Media errors rising week over week | Attention | No finding |
| Slow disk, persistent (4x baseline for 3 days) | Watch by day 1, Attention by day 3 | Urgent |
| Slow disk, one-hour spike | No finding | Any active finding |
| Hotter at same load (+12 C) | Watch; with frequency drop Attention | Urgent |
| Hotter because busier | No finding | Any thermal finding |
| Missing sensors | Related detectors skip; others run | Crash, zeros, error responses |
| Duplicate and out-of-order uploads | One copy, correct order | Duplicate rows |

Aggregate targets: 200 healthy simulated devices for 30 days each give zero Attention or Urgent findings and at most
2% of device-months with a Watch; across planted-fault runs the first finding appears before the planted worst day in
at least 90% of runs.

## Status

DONE and tested (Linux cloud workspace and Windows 11): agent (probe, powercfg/sysfs battery reader, system reader,
offline buffer), API (auth, devices, ingest, findings, samples, rate limit, validation), battery detector with forecast,
finding lifecycle, battery explanation template, simulator for battery scenarios.
Task 2 (slow-laptop diagnosis) DONE: command channel, 10 s sample, ranked causes, `chaos/cpu_hog.py`,
`chaos/e2e_diagnose.ps1`; gate passed on a real Windows 11 laptop (CPU ranked first, python.exe named).
70 server tests + 40 agent tests at the end of task 2.

## Remaining tasks, in order (each ends with a gate)

1. **Probe results.** (Gate met on 1 laptop, a Dell Inspiron 15 5510: powercfg capacity reads and the parser is confirmed; other demo laptops not probed yet.) Run the probe on every demo laptop, commit `docs/probe-results/*.json`. Gate: battery capacity reads on at least one laptop. Confirm the powercfg parser on real Windows.
2. **DONE: Slow-laptop diagnosis.** Agent samples 10 s of CPU, memory, disk busy and top 5 processes. Add a command channel: server creates a pending diagnose request, agent polls `GET /api/agent/commands` every 15 s and posts the sample, page polls for ranked causes. Rules: CPU >= 85%, memory >= 90% or swap activity, disk busy > 80% or latency 3x baseline, throttling (frequency ratio < 0.75 at high load), else "no clear cause". Gate: unit tests, then `chaos/cpu_hog.py` on a real laptop names the hog process.
3. **Storage health.** Tier A: `smartctl -j -a` (NVMe critical warning, spare at threshold, percentage used >= 80, media errors rising; SATA reallocated/pending sectors). Tier B: agent times an 8 MB write + fsync + read every 15 min, compare 24 h median with the device's own first-3-days baseline (3x). Free space < 10% Information, < 5% Watch. Wording never says the drive will fail. Gate: scenario rows for storage pass.
4. **Thermal detector.** Temperature at similar load (20-point load buckets) versus first-7-day baseline, +10 C Watch; add frequency drop for Attention. Windows usually does not expose temperature or fans, so expect simulated data only and say so in the UI.
5. **Simulator scenarios and accuracy run.** Add every scenario above plus the 200-healthy-device run. Save results to `docs/test-results.md`. Gate: aggregate targets met.
6. **Web dashboard** (React, Vite, React Router, Tailwind, Recharts, Axios). Screens: login/register, devices (with one-time token and agent command), device detail (component cards, battery chart with baseline and forecast range, findings with evidence expander), diagnose, fleet demo (banner "Synthetic data", planted model+BIOS correlation with sample size). Gate: browser end-to-end test passes.
7. **Postgres support.** Free hosts wipe local files, so SQLite will not persist when deployed. Add a Postgres adapter (Neon or Supabase) behind the same queries, keep SQLite for tests. Do this right after task 6.
8. **Explanations for every finding type**, optional LLM rewording with Zod-validated JSON and template fallback. Tests: numbers in LLM output must appear in the evidence; banned phrases fail the test.
9. **Real-device validation.** `chaos/` scripts (cpu_hog, mem_hog, disk_hog), unplug test, network-cut test, no-admin test, agent-restart test, then a 48-hour soak on 2 laptops (95% of samples arrive, agent under 2% CPU and 100 MB). Save results and screenshots.
10. **Deploy and submit.** Frontend Vercel or Netlify, backend Render, Railway or Fly.io, database Neon or Supabase. README, 3-minute demo video (segments labeled Real or Simulated), evaluation slide with real numbers. The AI key must exist only in backend environment variables.

## Working style

- Small steps, run `npm test` after each. Show real output; do not summarise a failure away.
- Prefer editing existing files to adding new ones. Keep detectors pure so they stay unit-testable.
- If a sensor is unavailable on this machine, use the simulator and label it. Do not fake live data.
- Ask before adding a dependency or changing a rule in the "Rules" or "Decisions" sections.
