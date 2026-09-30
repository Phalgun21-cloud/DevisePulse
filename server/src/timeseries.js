// Time-bucketed readings for dashboard charts. Pure functions plus a loader.
// Missing readings stay null (a visible gap), never zero. Gaps in time break the line instead of bridging it.

const MIN = 60_000;
const DAY = 1440 * MIN;
const STEPS = [1, 5, 15, 30, 60, 180, 360, 720, 1440, 4320, 10080, 20160, 43200].map((m) => m * MIN);
const MAX_RANGE = 400 * DAY;
const NAMED = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY, '1y': 365 * DAY };

export const FIELDS = {
  cpu: ['cpuLoadPct', 'memUsedPct', 'cpuFreqRatio', 'cpuTempC', 'swapUsedPct'],
  storage: ['ioProbeMs', 'freeSpacePct', 'percentageUsed', 'mediaErrors'],
  battery: ['healthPct', 'percent', 'fullChargeWh'],
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r2 = (v) => Math.round(v * 100) / 100;

function valueOf(sample, kind, field) {
  if (kind === 'battery' && field === 'healthPct') {
    const full = num(sample.fullChargeWh);
    const design = num(sample.designWh);
    return full !== null && design ? (full / design) * 100 : null;
  }
  return num(sample[field]);
}

export function chooseBucket(spanMs, maxPoints) {
  return STEPS.find((s) => spanMs / s <= maxPoints) ?? STEPS[STEPS.length - 1];
}

function badRange(code) {
  const err = new Error(code);
  err.status = 400;
  err.code = code;
  return err;
}

// { range: '24h'|'7d'|'30d'|'90d'|'1y'|'all' } or { from, to } -> { from, to } in ms.
export function resolveRange(query, now, firstTs) {
  const to = query.to ? Date.parse(query.to) : now.getTime();
  let from;
  if (query.from) from = Date.parse(query.from);
  else if (query.range === 'all') from = firstTs ? Date.parse(firstTs) : to - DAY;
  else from = to - (NAMED[query.range] ?? DAY);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw badRange('invalid_range');
  if (from >= to) throw badRange('range_reversed');
  if (to - from > MAX_RANGE) throw badRange('range_too_long');
  return { from, to };
}

export function aggregate(samples, kind, from, to, maxPoints = 240) {
  const fields = FIELDS[kind];
  const bucketMs = chooseBucket(to - from, maxPoints);
  const buckets = new Map();
  const acc = Object.fromEntries(fields.map((f) => [f, { sum: 0, min: Infinity, max: -Infinity, count: 0, latest: null, latestT: -Infinity }]));
  let sampleCount = 0;
  let firstTs = null;
  let lastTs = null;

  for (const s of samples) {
    const t = Date.parse(s.ts);
    if (!Number.isFinite(t) || t < from || t > to) continue;
    sampleCount += 1;
    if (!firstTs || s.ts < firstTs) firstTs = s.ts;
    if (!lastTs || s.ts > lastTs) lastTs = s.ts;
    const key = Math.floor(t / bucketMs) * bucketMs;
    if (!buckets.has(key)) buckets.set(key, Object.fromEntries(fields.map((f) => [f, []])));
    const b = buckets.get(key);
    for (const f of fields) {
      const v = valueOf(s, kind, f);
      if (v === null) continue;
      b[f].push(v);
      const a = acc[f];
      a.sum += v;
      a.count += 1;
      a.min = Math.min(a.min, v);
      a.max = Math.max(a.max, v);
      if (t >= a.latestT) {
        a.latest = v;
        a.latestT = t;
      }
    }
  }

  const points = [];
  let prev = null;
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    if (prev !== null && key - prev > 1.5 * bucketMs) {
      points.push({ t: prev + bucketMs, gap: true, ...Object.fromEntries(fields.map((f) => [f, null])) });
    }
    const b = buckets.get(key);
    const p = { t: key };
    for (const f of fields) {
      const v = b[f];
      p[f] = v.length
        ? { avg: r2(v.reduce((x, y) => x + y, 0) / v.length), min: r2(Math.min(...v)), max: r2(Math.max(...v)), n: v.length }
        : null;
    }
    points.push(p);
    prev = key;
  }

  const stats = Object.fromEntries(
    fields.map((f) => {
      const a = acc[f];
      return [
        f,
        a.count
          ? { avg: r2(a.sum / a.count), min: r2(a.min), max: r2(a.max), latest: r2(a.latest), count: a.count }
          : { avg: null, min: null, max: null, latest: null, count: 0 },
      ];
    }),
  );

  return { kind, from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucketMs, sampleCount, firstTs, lastTs, points, stats };
}

export async function loadTimeseries(db, deviceId, kind, query, now) {
  const first = (await db.get(`SELECT MIN(ts) AS ts FROM samples WHERE device_id = ? AND kind = ?`, deviceId, kind))?.ts;
  const { from, to } = resolveRange(query, now, first);
  const rows = await db.all(
    `SELECT ts, vals AS v FROM samples WHERE device_id = ? AND kind = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT 250000`,
    deviceId,
    kind,
    new Date(from).toISOString(),
    new Date(to).toISOString(),
  );
  const maxPoints = Math.min(Math.max(Number(query.points) || 240, 20), 600);
  return aggregate(
    rows.map((r) => ({ ts: r.ts, ...JSON.parse(r.v) })),
    kind,
    from,
    to,
    maxPoints,
  );
}
