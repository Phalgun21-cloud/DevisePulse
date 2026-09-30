// End-to-end API run against a REAL MySQL 8.0 database. Skipped unless TEST_MYSQL_URL points at a throwaway
// database (it drops and recreates the DevicePulse tables there), e.g.
//   $env:TEST_MYSQL_URL = "mysql://devicepulse:...@localhost:3306/devicepulse_test"; npx vitest run mysql
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { openDbFromEnv } from '../src/db/index.js';
import { createApp } from '../src/app.js';

const url = process.env.TEST_MYSQL_URL;
const SECRET = 'test-secret-that-is-long-enough';

describe.skipIf(!url)('MySQL 8.0 end to end', () => {
  let db;
  let app;

  beforeAll(async () => {
    const setup = await openDbFromEnv({ DATABASE_URL: url });
    await setup.exec('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['evaluations', 'diagnose_requests', 'findings', 'samples', 'devices', 'users']) {
      await setup.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    await setup.exec('SET FOREIGN_KEY_CHECKS = 1');
    await setup.close();
    db = await openDbFromEnv({ DATABASE_URL: url });
    app = createApp({ db, jwtSecret: SECRET, ingestLimit: { windowMs: 60_000, limit: 1000 } });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('register, device, ingest, summary, diagnose, demo seed, rename and delete', async () => {
    expect(db.dialect).toBe('mysql');
    const cred = { email: 'mysql@example.com', password: 'correct horse battery' };
    await request(app).post('/api/auth/register').send(cred).expect(201);
    await request(app).post('/api/auth/register').send(cred).expect(409);
    const jwt = (await request(app).post('/api/auth/login').send(cred).expect(200)).body.token;
    const auth = { Authorization: `Bearer ${jwt}` };
    expect((await request(app).get('/api/me').set(auth)).body.database).toBe('mysql');

    const dev = (await request(app).post('/api/devices').set(auth).send({ name: 'mysql-laptop' }).expect(201)).body;
    const ts = new Date(Date.now() - 60_000).toISOString();
    const batch = {
      samples: [
        { ts, kind: 'battery', values: { designWh: 54, fullChargeWh: 29.9, cycles: null } },
        { ts, kind: 'cpu', values: { cpuLoadPct: 12, cpuTempC: null, cpuFreqRatio: 1.1, pluggedIn: true } },
        { ts, kind: 'storage', values: { ioProbeMs: 20.1, freeSpacePct: 4 } },
      ],
    };
    const up = await request(app).post('/api/ingest').set('Authorization', `Bearer ${dev.deviceToken}`).send(batch).expect(200);
    expect(up.body).toMatchObject({ stored: 3, duplicates: 0 });
    const again = await request(app).post('/api/ingest').set('Authorization', `Bearer ${dev.deviceToken}`).send(batch).expect(200);
    expect(again.body).toMatchObject({ stored: 0, duplicates: 3 }); // INSERT IGNORE on the unique key

    const s = (await request(app).get(`/api/devices/${dev.id}`).set(auth).expect(200)).body.summary;
    expect(s.battery.healthPct).toBe(55.4);
    expect(s.latest.cpu.values.cpuTempC).toBeNull();

    const d = (await request(app).post(`/api/devices/${dev.id}/diagnose`).set(auth).expect(202)).body;
    const cmds = (await request(app).get('/api/agent/commands').set('Authorization', `Bearer ${dev.deviceToken}`).expect(200)).body.commands;
    expect(cmds.map((c) => c.id)).toEqual([d.id]);
    const sample = { cpuPct: 97, memUsedPct: 50, swapActivityBytes: null, diskBusyPct: 5, diskLatencyMs: 0.3, cpuFreqRatio: 1, topProcesses: [{ name: 'hog.exe', cpuPct: 90, memMb: 10, count: 2 }] };
    await request(app).post(`/api/agent/commands/${d.id}/result`).set('Authorization', `Bearer ${dev.deviceToken}`).send({ sample }).expect(200);
    const done = (await request(app).get(`/api/devices/${dev.id}/diagnose/${d.id}`).set(auth).expect(200)).body;
    expect(done.result.causes[0]).toMatchObject({ rule: 'cpu_saturated', process: 'hog.exe' });

    await request(app).post('/api/demo/seed').set(auth).expect(201);
    const list = (await request(app).get('/api/devices').set(auth)).body.devices;
    const lab21 = list.find((x) => x.name === 'LAB-21');
    const f = (await request(app).get(`/api/devices/${lab21.id}/findings`).set(auth)).body.findings;
    expect(f.find((x) => x.rule === 'thermal')).toMatchObject({ severity: 'Attention', data: 'Simulated' });

    await request(app).patch(`/api/devices/${dev.id}`).set(auth).send({ name: 'renamed' }).expect(200);
    await request(app).delete(`/api/devices/${dev.id}`).set(auth).expect(204);
    await request(app).get(`/api/devices/${dev.id}`).set(auth).expect(404);
    await request(app).get('/api/agent/commands').set('Authorization', `Bearer ${dev.deviceToken}`).expect(401);
  }, 180_000);
});
