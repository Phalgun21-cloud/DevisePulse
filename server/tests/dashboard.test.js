import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';

const SECRET = 'test-secret-that-is-long-enough';
const NOW = new Date('2026-07-05T00:00:00Z');

function makeApp() {
  const db = openDb(':memory:');
  return { db, app: createApp({ db, jwtSecret: SECRET, now: () => NOW, ingestLimit: { windowMs: 60_000, limit: 1000 } }) };
}

async function signup(app, email = 'a@example.com') {
  const cred = { email, password: 'correct horse battery' };
  await request(app).post('/api/auth/register').send(cred).expect(201);
  return (await request(app).post('/api/auth/login').send(cred)).body.token;
}

const auth = (jwt) => ({ Authorization: `Bearer ${jwt}` });

describe('health check', () => {
  it('reports the database engine when the database answers', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toEqual({ ok: true, database: 'sqlite' });
  });

  it('answers 503 (not 200) when the database is unreachable', async () => {
    const db = openDb(':memory:');
    const broken = { ...db, dialect: 'mysql', get: async () => { throw new Error('connect ECONNREFUSED'); } };
    const app = createApp({ db: broken, jwtSecret: SECRET });
    const res = await request(app).get('/api/health').expect(503);
    expect(res.body).toEqual({ ok: false, database: 'mysql', error: 'database_unreachable' });
  });
});

describe('device detail summary', () => {
  it('a brand-new device reports "collecting" everywhere and nulls, never zeros', async () => {
    const { app } = makeApp();
    const jwt = await signup(app);
    const dev = (await request(app).post('/api/devices').set(auth(jwt)).send({ name: 'new' })).body;
    const res = await request(app).get(`/api/devices/${dev.id}`).set(auth(jwt)).expect(200);
    expect(res.body.device).toMatchObject({ id: dev.id, name: 'new', isSimulated: false });
    expect(res.body.summary.battery).toMatchObject({ status: 'collecting', healthPct: null, forecast: null });
    expect(res.body.summary.storage.status.probe).toBe('no_data');
    expect(res.body.summary.thermal.status).toBe('no_data');
    expect(res.body.summary.latest).toEqual({ cpu: null, storage: null, battery: null });
  });

  it('shows the latest readings and battery history after uploads', async () => {
    const { app } = makeApp();
    const jwt = await signup(app);
    const dev = (await request(app).post('/api/devices').set(auth(jwt)).send({ name: 'mine' })).body;
    await request(app)
      .post('/api/ingest')
      .set('Authorization', `Bearer ${dev.deviceToken}`)
      .send({
        samples: [
          { ts: '2026-07-04T10:00:00Z', kind: 'battery', values: { designWh: 54, fullChargeWh: 29.9, cycles: null } },
          { ts: '2026-07-04T10:00:00Z', kind: 'cpu', values: { cpuLoadPct: 18, cpuTempC: null, cpuFreqRatio: 1.28 } },
          { ts: '2026-07-04T10:00:00Z', kind: 'storage', values: { ioProbeMs: 20.5, freeSpacePct: 10.1 } },
        ],
      })
      .expect(200);
    const s = (await request(app).get(`/api/devices/${dev.id}`).set(auth(jwt)).expect(200)).body.summary;
    expect(s.battery).toMatchObject({ status: 'collecting', healthPct: 55.4 });
    expect(s.batteryHistory).toEqual([{ date: '2026-07-04', healthPct: 55.4 }]);
    expect(s.latest.cpu).toMatchObject({ ts: '2026-07-04T10:00:00Z', values: { cpuLoadPct: 18, cpuTempC: null } });
    expect(s.latest.storage.values).toMatchObject({ ioProbeMs: 20.5, freeSpacePct: 10.1 });
  });

  it('another user gets 404', async () => {
    const { app } = makeApp();
    const jwtA = await signup(app, 'a@example.com');
    const jwtB = await signup(app, 'b@example.com');
    const dev = (await request(app).post('/api/devices').set(auth(jwtA)).send({ name: 'x' })).body;
    await request(app).get(`/api/devices/${dev.id}`).set(auth(jwtB)).expect(404);
  });
});

describe('device settings', () => {
  it('renames a device, and deleting it removes its data and revokes its agent token', async () => {
    const { app, db } = makeApp();
    const jwt = await signup(app);
    const dev = (await request(app).post('/api/devices').set(auth(jwt)).send({ name: 'old' })).body;
    await request(app)
      .post('/api/ingest')
      .set('Authorization', `Bearer ${dev.deviceToken}`)
      .send({ samples: [{ ts: '2026-07-04T10:00:00Z', kind: 'storage', values: { ioProbeMs: 20, freeSpacePct: 4 } }] })
      .expect(200);
    const renamed = await request(app).patch(`/api/devices/${dev.id}`).set(auth(jwt)).send({ name: 'Library 4', model: 'Dell' }).expect(200);
    expect(renamed.body.device).toMatchObject({ name: 'Library 4', model: 'Dell' });
    await request(app).patch(`/api/devices/${dev.id}`).set(auth(jwt)).send({ token_hash: 'x' }).expect(400);

    const other = await signup(app, 'other@example.com');
    await request(app).delete(`/api/devices/${dev.id}`).set(auth(other)).expect(404);
    await request(app).delete(`/api/devices/${dev.id}`).set(auth(jwt)).expect(204);
    expect(db.prepare('SELECT COUNT(*) AS n FROM samples').get().n).toBe(0);
    await request(app).post('/api/ingest').set('Authorization', `Bearer ${dev.deviceToken}`)
      .send({ samples: [{ ts: '2026-07-04T11:00:00Z', kind: 'storage', values: { ioProbeMs: 20 } }] }).expect(401);
  });
});

describe('diagnose history', () => {
  it('lists this device\'s requests, newest first', async () => {
    const { app } = makeApp();
    const jwt = await signup(app);
    const dev = (await request(app).post('/api/devices').set(auth(jwt)).send({ name: 'x' })).body;
    const first = (await request(app).post(`/api/devices/${dev.id}/diagnose`).set(auth(jwt)).expect(202)).body;
    const res = await request(app).get(`/api/devices/${dev.id}/diagnose`).set(auth(jwt)).expect(200);
    expect(res.body.requests.map((r) => r.id)).toEqual([first.id]);
  });
});

describe('demo data', () => {
  it('seeds simulated devices whose findings went through the real lifecycle', async () => {
    const { app } = makeApp();
    const jwt = await signup(app);
    const seeded = (await request(app).post('/api/demo/seed').set(auth(jwt)).expect(201)).body;
    expect(seeded.devices.length).toBeGreaterThanOrEqual(3);
    const list = (await request(app).get('/api/devices').set(auth(jwt))).body.devices;
    expect(list.every((d) => d.isSimulated)).toBe(true);

    const findingsOf = async (name) => {
      const d = list.find((x) => x.name === name);
      return (await request(app).get(`/api/devices/${d.id}/findings`).set(auth(jwt))).body.findings;
    };
    expect((await findingsOf('LAB-07')).find((f) => f.rule === 'battery_wear')).toMatchObject({ severity: 'Attention', data: 'Simulated' });
    expect((await findingsOf('LAB-12')).find((f) => f.rule === 'storage_slow')).toMatchObject({ severity: 'Attention', data: 'Simulated' });
    expect((await findingsOf('LAB-21')).find((f) => f.rule === 'thermal')).toMatchObject({ severity: 'Attention', data: 'Simulated' });
    expect(await findingsOf('LAB-03')).toEqual([]);
  }, 60_000);

  it('seeding twice does not duplicate, and other users do not see the demo devices', async () => {
    const { app } = makeApp();
    const jwt = await signup(app);
    await request(app).post('/api/demo/seed').set(auth(jwt)).expect(201);
    await request(app).post('/api/demo/seed').set(auth(jwt)).expect(200);
    const mine = (await request(app).get('/api/devices').set(auth(jwt))).body.devices;
    expect(new Set(mine.map((d) => d.name)).size).toBe(mine.length);
    const other = await signup(app, 'other@example.com');
    expect((await request(app).get('/api/devices').set(auth(other))).body.devices).toEqual([]);
  }, 60_000);

  it('summary of a seeded battery device has a forecast range in months and no exact dates', async () => {
    const { app } = makeApp();
    const jwt = await signup(app);
    await request(app).post('/api/demo/seed').set(auth(jwt)).expect(201);
    const d = (await request(app).get('/api/devices').set(auth(jwt))).body.devices.find((x) => x.name === 'LAB-07');
    const s = (await request(app).get(`/api/devices/${d.id}`).set(auth(jwt))).body.summary;
    expect(s.battery.forecast.monthsLow).toBeGreaterThan(0);
    expect(JSON.stringify(s.battery)).not.toMatch(/date(Low|Mid|High)/);
    expect(s.batteryHistory.length).toBeGreaterThan(100);
  }, 60_000);
});

describe('serving the built dashboard', () => {
  it('serves index.html for app routes but keeps /api 404s as JSON', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-web-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    const app = createApp({ db: openDb(':memory:'), jwtSecret: SECRET, webDist: dir });
    const page = await request(app).get('/devices/5').expect(200);
    expect(page.text).toContain('id="root"');
    const api = await request(app).get('/api/nope').expect(404);
    expect(api.body).toEqual({ error: 'not_found' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('fleet demo', () => {
  it('is labelled Synthetic, shows sample sizes, and finds the planted model+BIOS group', async () => {
    const { app } = makeApp();
    const jwt = await signup(app);
    const res = await request(app).get('/api/fleet/demo').set(auth(jwt)).expect(200);
    expect(res.body.data).toBe('Synthetic');
    expect(res.body.devices).toBe(200);
    expect(res.body.groups.every((g) => g.devices >= res.body.minGroupSize)).toBe(true);
    const planted = res.body.groups.find((g) => g.model === 'Model A' && g.bios === '1.4.2');
    expect(planted.pattern).toBe(true);
    expect(planted.withFinding).toBeGreaterThan(0);
    expect(res.body.groups.filter((g) => g.pattern)).toHaveLength(1);
  }, 60_000);

  it('needs a login', async () => {
    const { app } = makeApp();
    await request(app).get('/api/fleet/demo').expect(401);
  });
});

describe('all-devices overview', () => {
  it('summarises every device of the user with latest readings, counts, coverage and findings', async () => {
    const { app } = makeApp();
    const jwt = await signup(app);
    const real = (await request(app).post('/api/devices').set(auth(jwt)).send({ name: 'real one' })).body;
    await request(app)
      .post('/api/ingest')
      .set('Authorization', `Bearer ${real.deviceToken}`)
      .send({
        samples: [
          { ts: '2026-07-04T10:00:00Z', kind: 'cpu', values: { cpuLoadPct: 18, memUsedPct: 70, cpuTempC: null, cpuFreqRatio: 1.2 } },
          { ts: '2026-07-04T10:01:00Z', kind: 'cpu', values: { cpuLoadPct: 22, memUsedPct: 71, cpuTempC: null, cpuFreqRatio: 1.1 } },
          { ts: '2026-07-04T10:00:00Z', kind: 'storage', values: { ioProbeMs: 20, freeSpacePct: 4, percentageUsed: null } },
        ],
      })
      .expect(200);
    // A second upload = a second storage check, so the free-space finding is confirmed (2 detections).
    await request(app)
      .post('/api/ingest')
      .set('Authorization', `Bearer ${real.deviceToken}`)
      .send({ samples: [{ ts: '2026-07-04T10:15:00Z', kind: 'storage', values: { ioProbeMs: 21, freeSpacePct: 4, percentageUsed: null } }] })
      .expect(200);
    await request(app).post('/api/demo/seed').set(auth(jwt)).expect(201);
    const other = await signup(app, 'other@example.com');
    await request(app).post('/api/devices').set(auth(other)).send({ name: 'not mine' });

    const res = await request(app).get('/api/overview').set(auth(jwt)).expect(200);
    expect(res.body.totals).toMatchObject({ devices: 5, real: 1, simulated: 4 });
    expect(res.body.devices.map((d) => d.name)).not.toContain('not mine');
    const r = res.body.devices.find((d) => d.name === 'real one');
    expect(r.readings).toMatchObject({ cpu: 2, storage: 2, battery: 0 });
    expect(r.latest.cpu).toMatchObject({ cpuLoadPct: 22, memUsedPct: 71 });
    expect(r.latest.storage).toMatchObject({ ioProbeMs: 21, freeSpacePct: 4 });
    expect(r.coverage).toMatchObject({ cpu: true, memory: true, cpuSpeed: true, temperature: false, battery: false, diskTest: true, smart: false });
    expect(r.findings.map((f) => f.rule)).toContain('storage_free_space');
    expect(res.body.totals.bySeverity.Attention).toBeGreaterThanOrEqual(3);
    expect(res.body.findings.length).toBe(res.body.totals.activeFindings);
  }, 60_000);

  it('monitoring rules come from the live settings', async () => {
    const { app } = makeApp();
    const jwt = await signup(app);
    const res = await request(app).get('/api/monitoring').set(auth(jwt)).expect(200);
    expect(res.body.settings.storage.slowRatio).toBe(3);
    expect(res.body.settings.findings).toEqual({ confirmDetections: 2, clearAfterNormal: 3 });
    expect(res.body.cadence.cpuSeconds).toBe(60);
  });
});
