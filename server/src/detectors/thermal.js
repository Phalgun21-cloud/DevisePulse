// Thermal. Pure: (cpuSamples, settings, now) -> { status, findings, skippedRules }.
// samples: [{ ts, cpuLoadPct, cpuTempC, cpuFreqRatio, pluggedIn }]
//
// Compares the recent window with the device's own first week, WITHIN the same load band and power state, so
// "hotter because busier" and "slower because unplugged" are not findings.
//   temperature available: +tempRiseWatchC at similar load -> Watch; plus a frequency drop under load -> Attention.
//   no temperature:        frequency drop under sustained high load -> Watch (one signal never exceeds Watch).
// Never Urgent. Missing values are skipped, never read as zero.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (n) => Math.round(n * 10) / 10;

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Group samples by load band and power state; keep only the chosen metric's values.
function bands(samples, key, width) {
  const out = new Map();
  for (const x of samples) {
    const v = num(x[key]);
    if (v === null) continue;
    const band = Math.min(Math.floor(x.cpuLoadPct / width), Math.floor(99.999 / width));
    const id = `${band}|${x.pluggedIn === false ? 'battery' : x.pluggedIn === true ? 'ac' : 'unknown'}`;
    if (!out.has(id)) out.set(id, { band, power: id.split('|')[1], values: [] });
    out.get(id).values.push(v);
  }
  return out;
}

// Compare recent with baseline band by band. Returns per-band rows and a recent-sample-weighted mean change.
function compare(base, recent, key, s, filterBand = () => true) {
  const b = bands(base, key, s.bucketWidthPct);
  const r = bands(recent, key, s.bucketWidthPct);
  const rows = [];
  for (const [id, rb] of r) {
    const bb = b.get(id);
    if (!bb || !filterBand(rb.band)) continue;
    if (bb.values.length < s.minBaselinePerBucket || rb.values.length < s.minRecentPerBucket) continue;
    rows.push({
      loadBand: `${rb.band * s.bucketWidthPct}-${(rb.band + 1) * s.bucketWidthPct}%`,
      power: rb.power,
      baseline: median(bb.values),
      recent: median(rb.values),
      recentSamples: rb.values.length,
    });
  }
  const weight = rows.reduce((a, x) => a + x.recentSamples, 0);
  return { rows, weight };
}

function freqDropPct({ rows, weight }) {
  if (!weight) return null;
  const drop = rows.reduce((a, x) => a + ((x.baseline - x.recent) / x.baseline) * 100 * x.recentSamples, 0) / weight;
  return round1(drop);
}

// Samples inside a run of load > sustainedLoadPct that has already lasted sustainedMinutes.
function sustained(samples, s) {
  const out = [];
  let runStart = null;
  let prevT = null;
  for (const x of samples) {
    const high = num(x.cpuLoadPct) !== null && x.cpuLoadPct > s.sustainedLoadPct;
    if (!high) {
      runStart = null;
    } else {
      if (runStart === null || prevT === null || x.t - prevT > 10 * 60_000) runStart = x.t;
      if (x.t - runStart >= s.sustainedMinutes * 60_000) out.push(x);
    }
    prevT = x.t;
  }
  return out;
}

export function detectThermal(samples, settings, now) {
  const s = settings.thermal;
  const nowMs = now.getTime();
  const sorted = samples
    .map((x) => ({ ...x, t: Date.parse(x.ts) }))
    .filter((x) => Number.isFinite(x.t) && x.t <= nowMs && num(x.cpuLoadPct) !== null)
    .sort((a, b) => a.t - b.t);

  const hasTemp = sorted.some((x) => num(x.cpuTempC) !== null);
  const hasFreq = sorted.some((x) => num(x.cpuFreqRatio) !== null);
  if (!sorted.length || (!hasTemp && !hasFreq)) return { status: 'no_data', findings: [], skippedRules: ['thermal'] };

  const baseEnd = sorted[0].t + s.baselineDays * DAY_MS;
  if (nowMs < baseEnd) return { status: 'collecting_baseline', findings: [], skippedRules: [] };
  const base = sorted.filter((x) => x.t < baseEnd);
  const recent = sorted.filter((x) => x.t > nowMs - s.recentHours * HOUR_MS && x.t >= baseEnd);

  const highBand = (band) => band * s.bucketWidthPct >= s.highLoadFromPct;
  const findings = [];

  if (hasTemp) {
    const temp = compare(base, recent, 'cpuTempC', s);
    if (!temp.weight) return { status: 'no_comparable_load', findings: [], skippedRules: [] };
    const rise = round1(temp.rows.reduce((a, x) => a + (x.recent - x.baseline) * x.recentSamples, 0) / temp.weight);
    if (rise >= s.tempRiseWatchC) {
      const freq = hasFreq ? compare(base, recent, 'cpuFreqRatio', s, highBand) : { rows: [], weight: 0 };
      const drop = freqDropPct(freq);
      const withFreq = drop !== null && drop >= s.freqDropWithHeatPct;
      const top = [...temp.rows].sort((a, b) => b.recentSamples - a.recentSamples)[0];
      findings.push({
        rule: 'thermal',
        component: 'thermal',
        severity: withFreq ? 'Attention' : 'Watch',
        title: withFreq ? 'Running hotter and slower at the same load' : 'Running hotter than usual at the same load',
        evidence: {
          basis: 'temperature',
          tempRiseC: rise,
          thresholdC: s.tempRiseWatchC,
          exampleBand: top.loadBand,
          exampleBaselineC: round1(top.baseline),
          exampleRecentC: round1(top.recent),
          freqDropPct: drop,
          freqThresholdPct: s.freqDropWithHeatPct,
          bands: temp.rows.map((x) => ({ ...x, baseline: round1(x.baseline), recent: round1(x.recent) })),
        },
      });
    }
    return { status: 'ok', findings, skippedRules: [] };
  }

  // No temperature: frequency under sustained high load only.
  const freq = compare(sustained(base, s), sustained(recent, s), 'cpuFreqRatio', s);
  if (!freq.weight) return { status: 'no_comparable_load', findings: [], skippedRules: [] };
  const drop = freqDropPct(freq);
  if (drop >= s.freqDropAlonePct) {
    const top = [...freq.rows].sort((a, b) => b.recentSamples - a.recentSamples)[0];
    findings.push({
      rule: 'thermal',
      component: 'thermal',
      severity: 'Watch', // one signal alone never exceeds Watch
      title: 'Processor slower under heavy load than usual',
      evidence: {
        basis: 'frequency',
        freqDropPct: drop,
        thresholdPct: s.freqDropAlonePct,
        sustainedLoadPct: s.sustainedLoadPct,
        exampleBaselineRatio: Math.round(top.baseline * 100) / 100,
        exampleRecentRatio: Math.round(top.recent * 100) / 100,
        temperature: null,
      },
    });
  }
  return { status: 'ok', findings, skippedRules: [] };
}
