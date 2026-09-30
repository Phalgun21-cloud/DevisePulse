# Test results

Run date: 2026-09-30 (cloud Linux workspace, Node 22, Python 3.11)
Commit: not recorded (files were written into the repo after this run; add the hash when you commit)

| Level | Tool | Result |
| --- | --- | --- |
| 1. Detector unit tests (battery) | Vitest | included in server total below |
| 2. Agent unit tests | pytest | 13 passed in 0.02s |
| 3. API integration and security | Vitest + supertest | included in server total below |
| Server total (levels 1 and 3) | Vitest | Tests  44 passed (44) |

## Also verified by hand
- Real server + real agent, one upload: sample stored, missing CPU temperature kept as null (not zero).
- Wrong device token: server answers 401, agent keeps the sample buffered.
- Mutation check: deliberately breaking (a) the device ownership check, (b) the two-detection rule, (c) duplicate protection made the suite fail each time; code restored afterwards.

## NOT yet run (do not claim these)
- Anything on real Windows 11 hardware: run `python agent/probe.py --save` and check `powercfg` battery parsing.
- Storage, thermal and root-cause detectors: not built yet.
- Real-device fault injection (chaos/), 48-hour soak, web dashboard, end-to-end browser test.
- Scenario accuracy over 200 healthy simulated devices (only the battery scenarios exist so far).

## Design decision recorded
Forecast range uses slope +/- 2 standard errors (about 95%), not 1 as first drafted, because 1 SE only covers about 68%.
When the decline is accelerating, the early bound uses the recent decline rate; otherwise a straight line over all history
gave a falsely reassuring 9 months when the recent rate implied about 3.6.
