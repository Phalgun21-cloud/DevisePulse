import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { evaluateBattery } from '../src/evaluate.js';
import { defaultSettings } from '../src/settings.js';
import { scenarios, batterySeries } from '../../simulator/generate.js';

const SECRET = 'test-secret-that-is-long-enough';
const NOW = new Date('2026-07-05T00:00:00Z');

function makeApp(opts = {}) {
  const db = openDb(':memory:');
  const app = createApp({ db, jwtSecret: SECRET, now: () => NOW, ...opts });
  return { db, app };
}

async function signup(app, email = 'a@example.com', password = 'correct horse battery') {
  await request(app).post('/api/auth/register').send({ email, password }).expect(201);
  const res = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return res.body.token;
}

async function addDevice(app, jwt, name = 'LAPTOP-142') {
  const res = await request(app).post('/api/devices').set('Authorization', `Bearer ${jwt}`).send({ name }).expect(201);
  return res.body; // { id, name, deviceToken }
}

const batteryToApi = (s) => ({
  ts: s.ts,
  kind: 'battery',
  values: { designWh: s.designWh, fullChargeWh: s.fullChargeWh },
});

const ingest = (app, token, samples) =>
  request(app).post('/api/ingest').set('Authorization', `Bearer ${token}`).send({ samples });

const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;

describe('auth', () => {
  it('registers, logs in, and rejects a wrong password with the same error as an unknown email', async () => {
    const { app } = makeApp();
    await signup(app);
    const wrong = await request(app).post('/api/auth/login').send({ email: 'a@example.com', password: 'nope-nope-nope' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'x@example.com', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('returns 400 (not a hang) for a malformed login body', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('rejects a duplicate email with 409', async () => {
    const { app } = makeApp();
    await signup(app);
    await request(app).post('/api/auth/register').send({ email: 'A@Example.com', password: 'correct horse battery' }).expect(409);
  });

  it('refuses to start with a weak JWT secret', () => {
    expect(() => createApp({ db: openDb(':memory:'), jwtSecret: 'short' })).toThrow(/JWT_SECRET/);
  });
});

describe('security', () => {
  it('request without a JWT gets 401', async () => {
    const { app } = makeApp();
    await request(app).get('/api/devices').expect(401);
    await request(app).post('/api/devices').send({ name: 'x' }).expect(401);
  });

  it('a garbage JWT gets 401', async () => {
    const { app } = makeApp();
    await request(app).get('/api/devices').set('Authorization', 'Bearer not.a.jwt').expect(401);
  });

  it('ingest with a missing, wrong or revoked device token gets 401', async () => {
    const { app } = makeApp();
    const sample = [{ ts: '2026-07-01T00:00:00Z', kind: 'cpu', values: { cpuLoadPct: 3 } }];
    await request(app).post('/api/ingest').send({ samples: sample }).expect(401);
    await ingest(app, 'dp_wrong', sample).expect(401);
  });

  it("a user cannot read another user's device (404, same as a missing one)", async () => {
    const { app } = makeApp();
    const alice = await signup(app, 'alice@example.com');
    const bob = await signup(app, 'bob@example.com');
    const dev = await addDevice(app, alice);
    await request(app).get(`/api/devices/${dev.id}/findings`).set('Authorization', `Bearer ${bob}`).expect(404);
    await request(app).get(`/api/devices/${dev.id}/samples?kind=battery`).set('Authorization', `Bearer ${bob}`).expect(404);
    await request(app).get('/api/devices/99999/findings').set('Authorization', `Bearer ${bob}`).expect(404);
    const list = await request(app).get('/api/devices').set('Authorization', `Bearer ${bob}`).expect(200);
    expect(list.body.devices).toEqual([]);
  });

  it('stores passwords and device tokens only as hashes', async () => {
    const { app, db } = makeApp();
    const jwt = await signup(app, 'a@example.com', 'correct horse battery');
    const dev = await addDevice(app, jwt);
    const user = db.prepare('SELECT password_hash FROM users').get();
    const device = db.prepare('SELECT token_hash FROM devices').get();
    expect(user.password_hash).not.toContain('correct horse battery');
    expect(user.password_hash.startsWith('$2')).toBe(true); // bcrypt
    expect(device.token_hash).not.toBe(dev.deviceToken);
    expect(device.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(db.prepare('SELECT * FROM devices').all())).not.toContain(dev.deviceToken);
  });

  it('stores injection strings in a device name as plain text, with no side effects', async () => {
    const { app, db } = makeApp();
    const jwt = await signup(app);
    const evil = `x'); DROP TABLE users;-- <script>alert(1)</script>`;
    const dev = await addDevice(app, jwt, evil);
    expect(count(db, 'SELECT COUNT(*) AS n FROM users')).toBe(1); // table still there
    const list = await request(app).get('/api/devices').set('Authorization', `Bearer ${jwt}`).expect(200);
    expect(list.body.devices[0].name).toBe(evil);
    expect(dev.id).toBeGreaterThan(0);
  });

  it('rate-limits a burst of ingest calls with 429', async () => {
    const { app } = makeApp({ ingestLimit: { windowMs: 60_000, limit: 3 } });
    const jwt = await signup(app);
    const dev = await addDevice(app, jwt);
    const sample = [{ ts: '2026-07-01T00:00:00Z', kind: 'cpu', values: { cpuLoadPct: 3 } }];
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await ingest(app, dev.deviceToken, sample)).status);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });
});

describe('ingest validation', () => {
  let app, db, token;
  beforeEach(async () => {
    ({ app, db } = makeApp());
    const jwt = await signup(app);
    token = (await addDevice(app, jwt)).deviceToken;
  });

  const stored = () => count(db, 'SELECT COUNT(*) AS n FROM samples');

  it('rejects malformed payloads with 400 and stores nothing', async () => {
    for (const bad of [
      [],
      [{ ts: 'yesterday', kind: 'cpu', values: {} }],
      [{ ts: '2026-07-01T00:00:00Z', kind: 'nope', values: {} }],
      [{ ts: '2026-07-01T00:00:00Z', kind: 'cpu' }],
      [{ ts: '2026-07-01T00:00:00Z', kind: 'battery', values: { designWh: 60, fullChargeWh: 0 } }],
      [{ ts: '2026-07-01T00:00:00Z', kind: 'battery', values: { designWh: -5, fullChargeWh: 50 } }],
      [{ ts: '2026-07-01T00:00:00Z', kind: 'battery', values: {} }],
    ]) {
      const res = await ingest(app, token, bad);
      expect(res.status).toBe(400);
    }
    expect(stored()).toBe(0);
  });

  it('rejects a batch with a timestamp in the far future', async () => {
    const res = await ingest(app, token, [{ ts: '2030-01-01T00:00:00Z', kind: 'cpu', values: { cpuLoadPct: 1 } }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('timestamp_in_future');
    expect(stored()).toBe(0);
  });

  it('rejects more than 200 samples per batch', async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      ts: new Date(Date.parse('2026-06-01T00:00:00Z') + i * 60_000).toISOString(),
      kind: 'cpu',
      values: { cpuLoadPct: 1 },
    }));
    expect((await ingest(app, token, many)).status).toBe(400);
    expect(stored()).toBe(0);
  });

  it('rejects an oversized body with 413 and stores nothing', async () => {
    const res = await request(app)
      .post('/api/ingest')
      .set('Authorization', `Bearer ${token}`)
      .send({ samples: [{ ts: '2026-07-01T00:00:00Z', kind: 'cpu', values: {} }], pad: 'x'.repeat(200_000) });
    expect(res.status).toBe(413);
    expect(stored()).toBe(0);
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await request(app)
      .post('/api/ingest')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send('{"samples": [');
    expect(res.status).toBe(400);
  });

  it('accepts nulls for missing sensors (no zeros invented) and stores them as null', async () => {
    const res = await ingest(app, token, [
      { ts: '2026-07-01T00:00:00Z', kind: 'cpu', values: { cpuLoadPct: 4.5, cpuTempC: null, cpuFreqMHz: null } },
    ]);
    expect(res.status).toBe(200);
    const row = db.prepare(`SELECT "values" AS v FROM samples`).get();
    expect(JSON.parse(row.v).cpuTempC).toBeNull();
  });

  it('stores the same batch sent twice only once (duplicate upload)', async () => {
    const batch = [
      { ts: '2026-07-01T00:00:00Z', kind: 'cpu', values: { cpuLoadPct: 4 } },
      { ts: '2026-07-01T00:01:00Z', kind: 'cpu', values: { cpuLoadPct: 5 } },
    ];
    const first = await ingest(app, token, batch).expect(200);
    const second = await ingest(app, token, batch).expect(200);
    expect(first.body).toEqual({ received: 2, stored: 2, duplicates: 0 });
    expect(second.body).toEqual({ received: 2, stored: 0, duplicates: 2 });
    expect(stored()).toBe(2);
  });

  it('returns samples in timestamp order even when uploaded out of order', async () => {
    const jwt = await signup(app, 'b@example.com');
    const dev = await addDevice(app, jwt);
    await ingest(app, dev.deviceToken, [
      { ts: '2026-07-01T00:03:00Z', kind: 'cpu', values: { cpuLoadPct: 3 } },
      { ts: '2026-07-01T00:01:00Z', kind: 'cpu', values: { cpuLoadPct: 1 } },
      { ts: '2026-07-01T00:02:00Z', kind: 'cpu', values: { cpuLoadPct: 2 } },
    ]).expect(200);
    const res = await request(app).get(`/api/devices/${dev.id}/samples?kind=cpu`).set('Authorization', `Bearer ${jwt}`).expect(200);
    expect(res.body.samples.map((s) => s.values.cpuLoadPct)).toEqual([1, 2, 3]);
  });

  it('updates last_seen on every accepted upload', async () => {
    await ingest(app, token, [{ ts: '2026-07-01T00:00:00Z', kind: 'cpu', values: { cpuLoadPct: 1 } }]).expect(200);
    expect(db.prepare('SELECT last_seen FROM devices').get().last_seen).toBe(NOW.toISOString());
  });
});

describe('end to end: battery findings', () => {
  it('shows a finding only after two consecutive detections, with a hedged explanation', async () => {
    const { app } = makeApp();
    const jwt = await signup(app);
    const dev = await addDevice(app, jwt);
    const series = scenarios.slowDecline(); // 181 daily readings, ends at ~80% health
    const findings = async () =>
      (await request(app).get(`/api/devices/${dev.id}/findings`).set('Authorization', `Bearer ${jwt}`).expect(200)).body.findings;

    // first 100 days (health ~89%): nothing to report yet
    await ingest(app, dev.deviceToken, series.slice(0, 100).map(batteryToApi)).expect(200);
    expect(await findings()).toEqual([]);

    // remaining days push health to ~80%: detected ONCE -> still pending, not shown to the user
    await ingest(app, dev.deviceToken, series.slice(100).map(batteryToApi)).expect(200);
    expect(await findings()).toEqual([]);

    // a new daily reading = second consecutive detection -> now active
    const next = { ...series.at(-1), ts: new Date(Date.parse(series.at(-1).ts) + 86_400_000).toISOString(), fullChargeWh: 47.9 };
    await ingest(app, dev.deviceToken, [batteryToApi(next)]).expect(200);
    const active = await findings();
    expect(active).toHaveLength(1);

    const f = active[0];
    expect(f.rule).toBe('battery_wear');
    expect(f.severity).toBe('Watch');
    expect(f.evidence.healthPct).toBeGreaterThan(78);
    expect(f.evidence.healthPct).toBeLessThan(82);
    expect(f.evidence.forecast.confidence).toBe('High');

    // wording rules: hedged, cites its own numbers, never promises a failure date
    expect(f.explanation).toMatch(/may reach 70%/);
    expect(f.explanation).toMatch(/confidence: High/);
    expect(f.explanation).not.toMatch(/will fail|will die|guarantee|failure date/i);
    expect(f.explanation).toContain(String(f.evidence.healthPct));

    // device list reflects the worst active severity
    const list = await request(app).get('/api/devices').set('Authorization', `Bearer ${jwt}`).expect(200);
    expect(list.body.devices[0].worstSeverity).toBe('Watch');
  });

  it('healthy battery history never creates a finding', async () => {
    const { app } = makeApp();
    const jwt = await signup(app);
    const dev = await addDevice(app, jwt);
    await ingest(app, dev.deviceToken, scenarios.healthy().map(batteryToApi)).expect(200);
    const res = await request(app).get(`/api/devices/${dev.id}/findings?status=all`).set('Authorization', `Bearer ${jwt}`).expect(200);
    expect(res.body.findings).toEqual([]);
  });

  it('too little data yields no finding and no forecast', async () => {
    const { app } = makeApp();
    const jwt = await signup(app);
    const dev = await addDevice(app, jwt);
    await ingest(app, dev.deviceToken, scenarios.littleData().map(batteryToApi)).expect(200);
    const res = await request(app).get(`/api/devices/${dev.id}/findings?status=all`).set('Authorization', `Bearer ${jwt}`).expect(200);
    expect(res.body.findings).toEqual([]);
  });
});

describe('finding lifecycle (hysteresis)', () => {
  function seedDevice(db) {
    db.prepare(`INSERT INTO users (email, password_hash, created_at) VALUES ('u@example.com', 'x', 'now')`).run();
    db.prepare(
      `INSERT INTO devices (user_id, name, token_hash, created_at) VALUES (1, 'd', 'h', 'now')`,
    ).run();
  }
  const insertSamples = (db, series) => {
    const stmt = db.prepare(`INSERT OR IGNORE INTO samples (device_id, ts, kind, "values") VALUES (1, ?, 'battery', ?)`);
    for (const s of series) stmt.run(s.ts, JSON.stringify({ designWh: s.designWh, fullChargeWh: s.fullChargeWh }));
  };
  const status = (db) => db.prepare('SELECT status, detect_count AS d, clear_count AS c FROM findings').all();

  it('a one-off detection that goes away is deleted and never shown', () => {
    const db = openDb(':memory:');
    seedDevice(db);
    insertSamples(db, scenarios.slowDecline());
    evaluateBattery(db, 1, defaultSettings, NOW);
    expect(status(db)).toEqual([{ status: 'pending', d: 1, c: 0 }]);

    db.exec('DELETE FROM samples');
    insertSamples(db, scenarios.healthy());
    evaluateBattery(db, 1, defaultSettings, NOW);
    expect(status(db)).toEqual([]);
  });

  it('an active finding clears only after 3 consecutive normal checks', () => {
    const db = openDb(':memory:');
    seedDevice(db);
    insertSamples(db, scenarios.slowDecline());
    evaluateBattery(db, 1, defaultSettings, NOW);
    evaluateBattery(db, 1, defaultSettings, NOW);
    expect(status(db)[0].status).toBe('active');

    db.exec('DELETE FROM samples');
    insertSamples(db, scenarios.healthy());
    evaluateBattery(db, 1, defaultSettings, NOW);
    evaluateBattery(db, 1, defaultSettings, NOW);
    expect(status(db)[0]).toMatchObject({ status: 'active', c: 2 });
    evaluateBattery(db, 1, defaultSettings, NOW);
    expect(status(db)[0].status).toBe('cleared');
  });

  it('never keeps more than one live finding per device and rule', () => {
    const db = openDb(':memory:');
    seedDevice(db);
    insertSamples(db, scenarios.slowDecline());
    for (let i = 0; i < 5; i++) evaluateBattery(db, 1, defaultSettings, NOW);
    expect(count(db, `SELECT COUNT(*) AS n FROM findings WHERE status IN ('pending','active')`)).toBe(1);
  });
});

describe('hourly agent uploads', () => {
  it('collapses many samples per day into daily points before forecasting', async () => {
    const { app } = makeApp();
    const jwt = await signup(app);
    const dev = await addDevice(app, jwt);
    const hourly = batterySeries({ days: 40, healthAt: (d) => 100 - 0.4 * d, samplesPerDay: 4, seed: 9 });
    for (let i = 0; i < hourly.length; i += 100) {
      await ingest(app, dev.deviceToken, hourly.slice(i, i + 100).map(batteryToApi)).expect(200);
    }
    const res = await request(app).get(`/api/devices/${dev.id}/findings?status=all`).set('Authorization', `Bearer ${jwt}`).expect(200);
    for (const f of res.body.findings) expect(f.evidence.points).toBeLessThanOrEqual(40);
  });
});
