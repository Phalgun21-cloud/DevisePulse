import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { aggregate, chooseBucket, resolveRange } from '../src/timeseries.js';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';

const T0 = Date.parse('2026-07-01T00:00:00Z');
const MIN = 60_000;
const cpu = (min, v) => ({ ts: new Date(T0 + min * MIN).toISOString(), cpuLoadPct: v, memUsedPct: 50, cpuTempC: null });

describe('bucket choice', () => {
  it('picks the smallest nice bucket that keeps points under the limit', () => {
    expect(chooseBucket(24 * 60 * MIN, 300)).toBe(5 * MIN); // 24 h -> 288 points
    expect(chooseBucket(30 * 1440 * MIN, 300)).toBe(3 * 60 * MIN); // 30 days -> 240 points
    expect(chooseBucket(60 * MIN, 300)).toBe(MIN);
  });
});

describe('aggregate', () => {
  it('gives avg/min/max per bucket and range stats', () => {
    const s = [cpu(0, 10), cpu(1, 30), cpu(2, 20), cpu(10, 90)];
    const r = aggregate(s, 'cpu', T0, T0 + 15 * MIN, 5);
    expect(r.bucketMs).toBe(5 * MIN);
    expect(r.points[0]).toMatchObject({ t: T0, cpuLoadPct: { avg: 20, min: 10, max: 30, n: 3 } });
    expect(r.stats.cpuLoadPct).toMatchObject({ avg: 37.5, min: 10, max: 90, latest: 90, count: 4 });
    expect(r.sampleCount).toBe(4);
  });

  it('keeps missing sensors null, never zero, and reports count 0', () => {
    const r = aggregate([cpu(0, 10), cpu(1, 20)], 'cpu', T0, T0 + 10 * MIN, 5);
    expect(r.points[0].cpuTempC).toBeNull();
    expect(r.stats.cpuTempC).toEqual({ avg: null, min: null, max: null, latest: null, count: 0 });
  });

  it('breaks the line across a gap instead of drawing through it', () => {
    const r = aggregate([cpu(0, 10), cpu(60, 20)], 'cpu', T0, T0 + 70 * MIN, 20);
    const gap = r.points.find((p) => p.gap);
    expect(gap).toBeDefined();
    expect(gap.cpuLoadPct).toBeNull();
  });

  it('derives battery health from full/design capacity', () => {
    const r = aggregate([{ ts: new Date(T0).toISOString(), designWh: 60, fullChargeWh: 45, percent: 80 }], 'battery', T0, T0 + DAY(1), 10);
    expect(r.stats.healthPct.latest).toBe(75);
  });

  it('empty input is an empty series, not an error', () => {
    const r = aggregate([], 'storage', T0, T0 + DAY(1), 100);
    expect(r.points).toEqual([]);
    expect(r.stats.ioProbeMs.count).toBe(0);
  });
});

function DAY(n) {
  return n * 1440 * MIN;
}

describe('range', () => {
  const now = new Date('2026-07-05T00:00:00Z');
  it('named ranges end now', () => {
    expect(resolveRange({ range: '7d' }, now, null)).toEqual({ from: now.getTime() - DAY(7), to: now.getTime() });
  });
  it('"all" starts at the first sample', () => {
    expect(resolveRange({ range: 'all' }, now, '2026-06-01T00:00:00Z').from).toBe(Date.parse('2026-06-01T00:00:00Z'));
  });
  it('custom from/to, rejecting reversed or over-long ranges', () => {
    expect(resolveRange({ from: '2026-07-01', to: '2026-07-02' }, now, null)).toEqual({ from: Date.parse('2026-07-01'), to: Date.parse('2026-07-02') });
    expect(() => resolveRange({ from: '2026-07-02', to: '2026-07-01' }, now, null)).toThrow();
    expect(() => resolveRange({ from: '2024-01-01', to: '2026-07-01' }, now, null)).toThrow();
  });
});

describe('timeseries API', () => {
  it('returns bucketed data for the owner, 404 for others, 400 for a bad kind', async () => {
    const db = openDb(':memory:');
    const now = new Date('2026-07-05T00:00:00Z');
    const app = createApp({ db, jwtSecret: 'test-secret-that-is-long-enough', now: () => now });
    const sign = async (email) => {
      const cred = { email, password: 'correct horse battery' };
      await request(app).post('/api/auth/register').send(cred);
      return (await request(app).post('/api/auth/login').send(cred)).body.token;
    };
    const jwt = await sign('a@example.com');
    const dev = (await request(app).post('/api/devices').set('Authorization', `Bearer ${jwt}`).send({ name: 'x' })).body;
    const samples = [0, 1, 2].map((i) => ({ ts: new Date(now.getTime() - (i + 1) * 3_600_000).toISOString(), kind: 'cpu', values: { cpuLoadPct: 10 * (i + 1), cpuTempC: null } }));
    await request(app).post('/api/ingest').set('Authorization', `Bearer ${dev.deviceToken}`).send({ samples }).expect(200);

    const res = await request(app).get(`/api/devices/${dev.id}/timeseries?kind=cpu&range=24h`).set('Authorization', `Bearer ${jwt}`).expect(200);
    expect(res.body.sampleCount).toBe(3);
    expect(res.body.stats.cpuLoadPct).toMatchObject({ min: 10, max: 30, count: 3 });
    expect(res.body.stats.cpuTempC.count).toBe(0);

    const other = await sign('b@example.com');
    await request(app).get(`/api/devices/${dev.id}/timeseries?kind=cpu&range=24h`).set('Authorization', `Bearer ${other}`).expect(404);
    await request(app).get(`/api/devices/${dev.id}/timeseries?kind=nope`).set('Authorization', `Bearer ${jwt}`).expect(400);

    const raw = await request(app).get(`/api/devices/${dev.id}/samples?kind=cpu&from=${new Date(now.getTime() - 2.5 * 3_600_000).toISOString()}`).set('Authorization', `Bearer ${jwt}`).expect(200);
    expect(raw.body.samples).toHaveLength(2);
  });
});
