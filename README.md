# DevicePulse

Predictive health monitoring for laptops. A small Python **agent** reads real battery and system
numbers, an Express **API** stores them and runs **detectors**, and (next) a React **dashboard**
shows findings with evidence. Detection is transparent, tested rules; an AI layer only rewords the
explanations later. DevicePulse reports *elevated risk with a confidence label*, never an exact failure date.

## Status

| Part | State |
| --- | --- |
| Agent: probe, battery reader (Windows powercfg / Linux sysfs), CPU and memory, offline buffer | Built, unit-tested |
| API: register, login, devices, ingest, findings, samples | Built, tested |
| Battery wear + forecast detector, anti-false-alarm rules | Built, tested |
| Slow-laptop diagnosis: command channel, 10 s sample, ranked causes | Built, tested, real CPU-load gate passed on Windows 11 |
| Storage, thermal detectors | Next |
| React dashboard, simulator replay, fleet demo | Next |

See `docs/test-results.md` for what has and has not been verified.

## Requirements

- Node.js 22.13 or newer (uses the built-in `node:sqlite`, no native build step)
- Python 3.10 or newer
- Optional: smartmontools (`smartctl`) for SMART storage data, needs Administrator rights

## Setup (Windows PowerShell)

```powershell
# 1. API
cd server
npm install
copy ..\.env.example .env      # then edit .env: set JWT_SECRET to a long random string
npm run dev                    # http://localhost:4000

# 2. Agent (new terminal, from the repo root)
pip install -r agent\requirements.txt
python agent\probe.py --save   # reports which signals YOUR laptop exposes
```

Commit the file the probe writes to `docs/probe-results/`. It decides which detectors run on live data.

## Connect your laptop to your API

There is no web UI yet, so create an account and device with PowerShell:

```powershell
$b = "http://localhost:4000"
$cred = '{"email":"me@example.com","password":"use a long password"}'
Invoke-RestMethod -Method Post "$b/api/auth/register" -ContentType application/json -Body $cred
$jwt = (Invoke-RestMethod -Method Post "$b/api/auth/login" -ContentType application/json -Body $cred).token
$dev = Invoke-RestMethod -Method Post "$b/api/devices" -ContentType application/json `
        -Headers @{ Authorization = "Bearer $jwt" } -Body '{"name":"my-laptop"}'
$dev.deviceToken     # shown ONCE: copy it now

python agent\agent.py --server $b --token $dev.deviceToken
```

The agent sends CPU/memory every 60 seconds and battery capacity every hour. If the network drops it
buffers locally and sends everything, in order, when it returns.

Look at results:

```powershell
Invoke-RestMethod "$b/api/devices" -Headers @{ Authorization = "Bearer $jwt" }
Invoke-RestMethod "$b/api/devices/1/findings?status=all" -Headers @{ Authorization = "Bearer $jwt" }
```

A battery forecast needs at least 5 distinct days spanning 14 days of readings. Until then the
API reports no finding rather than guessing.

## Diagnose a slow laptop

With the agent running, ask for a 10-second sample (the agent checks for requests every 15 seconds):

```powershell
$req = Invoke-RestMethod -Method Post "$b/api/devices/1/diagnose" -Headers @{ Authorization = "Bearer $jwt" }
Invoke-RestMethod "$b/api/devices/1/diagnose/$($req.id)" -Headers @{ Authorization = "Bearer $jwt" }   # repeat until status is done
```

To test it, create load with `python chaos\cpu_hog.py` (asks first, 120 s cap, refuses on battery below 30%) and diagnose while it runs.
The agent sends numbers and the names of the top 5 processes only, never command lines or paths.

To run the whole check automatically (tests, a throwaway API on port 4100, the real agent, an idle diagnosis,
then `cpu_hog.py` with a diagnosis under load), which prints PASS/FAIL per step:

```powershell
powershell -ExecutionPolicy Bypass -File chaos\e2e_diagnose.ps1
```

## Tests

```powershell
npm run test:server    # Vitest: detectors, API, security, lifecycle
npm run test:agent     # pytest: parser, payload, buffer, upload
npm test               # both
```

Thresholds for every detector live in `server/src/settings.js`. Change them there and re-run the tests.

## Layout

```text
agent/       Python agent, probe, collectors, pytest tests
server/      Express API, SQLite, detectors, explanations, Vitest tests
simulator/   Seeded synthetic telemetry (used by tests, later by the demo)
chaos/       Safe fault-injection scripts for real-device tests (cpu_hog.py so far)
web/         React dashboard (coming)
docs/        probe-results/, test-results.md
```

## What the agent collects

Numbers only: battery capacity and percent, CPU load/frequency/temperature when exposed, memory and swap
usage. It never reads files, browsing data or screen content. Missing sensors are sent as `null`,
never as zero.

## Known limits

- Fan speed and CPU temperature are usually not exposed on Windows laptops; those checks are skipped, not faked.
- The Windows battery parser follows the documented `powercfg /batteryreport /xml` format but has only been
  tested against a sample, so confirm it on your machine with the probe.
