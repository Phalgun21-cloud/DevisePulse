import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { detectThermal } from '../src/detectors/thermal.js';
import { evaluateThermalIfDue } from '../src/evaluate.js';
import { explainFinding } from '../src/explain/templates.js';
import { defaultSettings } from '../src/settings.js';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { thermalScenarios } from '../../simulator/generate.js';

const DAY_MS = 86_400_000;
const START = Date.parse('2026-01-01T00:00:00Z');
const at = (days) => new Date(START + days * DAY_MS);
const upTo = (samples, when) => samples.filter((s) => Date.parse(s.ts) <= when.getTime());
const run = (samples, when = at(14)) => detectThermal(upTo(samples, when), defaultSettings, when);
const thermal = (r) => r.findings.find((f) => f.rule === 'thermal');
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('scenario: healthy', () => {
  it('no thermal finding on any day after the baseline week', () => {
    const s = thermalScenarios.healthy();
    for (let d = 8; d <= 14; d++) expect(thermal(run(s, at(d)))).toBeUndefined();
  });
});

describe('scenario: hotter at the same load (+12 C from day 10)', () => {
  it('Watch, with the rise at similar load as evidence', () => {
    const f = thermal(run(thermalScenarios.hotterSameLoad()));
    expect(f.severity).toBe('Watch');
    expect(f.evidence.basis).toBe('temperature');
    expect(f.evidence.tempRiseC).toBeGreaterThan(10);
    expect(f.evidence.tempRiseC).toBeLessThan(14);
  });

  it('with a frequency drop under load: Attention, never Urgent', () => {
    const f = thermal(run(thermalScenarios.hotterWithFreqDrop()));
    expect(f.severity).toBe('Attention');
    expect(f.evidence.freqDropPct).toBeGreaterThanOrEqual(defaultSettings.thermal.freqDropWithHeatPct);
  });

  it('never Urgent in any thermal scenario', () => {
    for (const make of Object.values(thermalScenarios)) {
      expect(thermal(run(make()))?.severity).not.toBe('Urgent');
    }
  });
});

describe('scenario: hotter because busier', () => {
  it('runs hotter on average but raises no thermal finding', () => {
    const s = thermalScenarios.hotterBecauseBusier();
    const before = s.filter((x) => Date.parse(x.ts) < at(7).getTime()).map((x) => x.cpuTempC);
    const after = s.filter((x) => Date.parse(x.ts) > at(13).getTime()).map((x) => x.cpuTempC);
    // A real trap: a naive whole-day comparison would cross the Watch threshold.
    expect(mean(after) - mean(before)).toBeGreaterThan(defaultSettings.thermal.tempRiseWatchC);
    expect(thermal(run(s))).toBeUndefined();
  });
});

describe('scenario: missing temperature (Windows-like)', () => {
  it('falls back to frequency under sustained load: 25% drop is Watch', () => {
    const f = thermal(run(thermalScenarios.noTempFreqDrop()));
    expect(f.severity).toBe('Watch');
    expect(f.evidence.basis).toBe('frequency');
    expect(f.evidence.freqDropPct).toBeGreaterThanOrEqual(20);
  });

  it('frequency alone never goes above Watch, even for a large drop (rule 3)', () => {
    const s = thermalScenarios.noTempFreqDrop().map((x) => ({ ...x, cpuFreqRatio: x.cpuFreqRatio && Date.parse(x.ts) >= at(10).getTime() && x.cpuLoadPct > 80 ? x.cpuFreqRatio * 0.5 : x.cpuFreqRatio }));
    expect(thermal(run(s)).severity).toBe('Watch');
  });

  it('no change: no finding', () => {
    expect(thermal(run(thermalScenarios.noTempNoChange()))).toBeUndefined();
  });

  it('on battery the clock is slower by design: no finding (only like power states are compared)', () => {
    expect(thermal(run(thermalScenarios.onBattery()))).toBeUndefined();
  });

  it('no temperature and no frequency: rule skipped, no crash', () => {
    const r = run(thermalScenarios.nothingExposed());
    expect(r.findings).toEqual([]);
    expect(r.skippedRules).toContain('thermal');
  });

  it('no samples at all: no crash', () => {
    expect(detectThermal([], defaultSettings, at(1)).findings).toEqual([]);
  });
});

describe('baseline and settings', () => {
  it('nothing before the 7-day baseline is complete', () => {
    const r = run(thermalScenarios.hotterSameLoad(), at(6));
    expect(thermal(r)).toBeUndefined();
    expect(r.status).toBe('collecting_baseline');
  });

  it('thresholds come from settings', () => {
    const s = { ...defaultSettings, thermal: { ...defaultSettings.thermal, tempRiseWatchC: 15 } };
    const samples = thermalScenarios.hotterSameLoad();
    expect(thermal(detectThermal(samples, s, at(14)))).toBeUndefined();
  });
});

describe('thermal explanations', () => {
  const banned = [/will fail/i, /going to fail/i, /\bdie\b/i, /guarantee/i, /\bon \d{4}-\d{2}-\d{2}/, /definitely/i];
  const cases = {
    temp: thermal(run(thermalScenarios.hotterSameLoad())),
    tempAndFreq: thermal(run(thermalScenarios.hotterWithFreqDrop())),
    freqOnly: thermal(run(thermalScenarios.noTempFreqDrop())),
  };
  for (const [name, f] of Object.entries(cases)) {
    it(`${name}: hedged, specific, no banned phrases`, () => {
      const text = explainFinding(f);
      expect(text).not.toBe(f.title);
      expect(text).toMatch(/consistent with|may/i);
      for (const b of banned) expect(text).not.toMatch(b);
    });
  }
  it('frequency-only wording says temperature is not available', () => {
    expect(explainFinding(cases.freqOnly)).toMatch(/temperature is not available/i);
  });
});

// ---- lifecycle and API --------------------------------------------------------------

describe('thermal lifecycle', () => {
  it('runs at most once per hour of data, not on every CPU sample', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO users (email, password_hash, created_at) VALUES ('t@example.com', 'x', '2026-01-01')`).run();
    db.prepare(`INSERT INTO devices (user_id, name, token_hash, created_at) VALUES (1, 'x', 'h', '2026-01-01')`).run();
    const ran = [0, 5, 30, 59, 60, 61, 125].map((min) =>
      evaluateThermalIfDue(db, 1, defaultSettings, new Date(START + min * 60_000)),
    );
    expect(ran).toEqual([true, false, false, false, true, false, true]);
  });
});

describe('thermal through the API, labelled Simulated', () => {
  const SECRET = 'test-secret-that-is-long-enough';
  const NOW = new Date('2026-01-15T00:00:00Z');

  it('a simulated device replaying "hotter + frequency drop" gets an active Attention labelled Simulated', async () => {
    const db = openDb(':memory:');
    const app = createApp({ db, jwtSecret: SECRET, now: () => NOW, ingestLimit: { windowMs: 60_000, limit: 1000 } });
    const cred = { email: 'sim@example.com', password: 'correct horse battery' };
    await request(app).post('/api/auth/register').send(cred).expect(201);
    const jwt = (await request(app).post('/api/auth/login').send(cred)).body.token;
    const auth = { Authorization: `Bearer ${jwt}` };
    const sim = (await request(app).post('/api/devices').set(auth).send({ name: 'LAB-07', simulated: true }).expect(201)).body;
    const real = (await request(app).post('/api/devices').set(auth).send({ name: 'mine' }).expect(201)).body;

    const samples = thermalScenarios.hotterWithFreqDrop().map(({ ts, ...values }) => ({ ts, kind: 'cpu', values }));
    for (let i = 0; i < samples.length; i += 200) {
      await request(app).post('/api/ingest').set('Authorization', `Bearer ${sim.deviceToken}`).send({ samples: samples.slice(i, i + 200) }).expect(200);
    }
    const res = await request(app).get(`/api/devices/${sim.id}/findings`).set(auth).expect(200);
    const f = res.body.findings.find((x) => x.rule === 'thermal');
    expect(f).toMatchObject({ severity: 'Attention', status: 'active', data: 'Simulated' });

    const list = (await request(app).get('/api/devices').set(auth).expect(200)).body.devices;
    expect(list.find((d) => d.id === sim.id).isSimulated).toBe(true);
    expect(list.find((d) => d.id === real.id).isSimulated).toBe(false);
  });
});
