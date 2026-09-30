// Battery wear + forecast detector.
// Pure function: (samples, settings, now) -> result. No database, no network, no clock.
//
// samples: [{ ts: ISO string, fullChargeWh: number, designWh: number }, ...]
// result:  { status, healthPct, points, spanDays, slopePctPerDay, r2, forecast, findings }

import { defaultSettings } from '../settings.js';

const DAY_MS = 86_400_000;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// One point per calendar day (UTC): median health, so hourly samples don't dominate.
export function dailyHealth(samples) {
  const byDay = new Map();
  for (const s of samples) {
    if (!(s.designWh > 0) || !(s.fullChargeWh > 0)) continue; // null/zero readings are skipped
    const t = Date.parse(s.ts);
    if (Number.isNaN(t)) continue;
    const day = Math.floor(t / DAY_MS);
    const pct = (s.fullChargeWh / s.designWh) * 100;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(pct);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, pcts]) => ({ day, healthPct: median(pcts) }));
}

// Ordinary least squares of y on x, with standard error of the slope.
export function linearFit(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return { slope: 0, intercept: my, r2: 0, slopeSe: Infinity };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - (intercept + slope * xs[i])) ** 2;
  const r2 = syy === 0 ? 1 : Math.max(0, 1 - sse / syy);
  const slopeSe = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : Infinity;
  return { slope, intercept, r2, slopeSe };
}

function confidenceLabel(r2, spanDays, s) {
  if (r2 >= s.highConfidence.r2 && spanDays >= s.highConfidence.spanDays) return 'High';
  if (r2 >= s.moderateConfidence.r2 && spanDays >= s.moderateConfidence.spanDays) return 'Moderate';
  return 'Low';
}

const LOWER = { High: 'Moderate', Moderate: 'Low', Low: 'Low' };

// Decline rate (pct points per day, positive = getting worse) or null if too few points.
function declineRate(points, s) {
  if (points.length < s.minPointsPerWindow) return null;
  const fit = linearFit(points.map((p) => p.day), points.map((p) => p.healthPct));
  return -fit.slope;
}

export function detectBattery(samples, settings = defaultSettings, now = new Date()) {
  const s = settings.battery;
  const points = dailyHealth(samples);
  const empty = {
    status: 'collecting',
    healthPct: null,
    points: points.length,
    spanDays: 0,
    slopePctPerDay: null,
    r2: null,
    forecast: null,
    findings: [],
  };
  if (points.length === 0) return empty;

  const first = points[0].day;
  const last = points[points.length - 1].day;
  const spanDays = last - first;
  const latestHealth = points[points.length - 1].healthPct;
  const base = { ...empty, healthPct: round1(latestHealth), spanDays };

  // Not enough history: report "collecting data" and NEVER a forecast date.
  if (points.length < s.minPoints || spanDays < s.minSpanDays) return base;

  const xs = points.map((p) => p.day);
  const ys = points.map((p) => p.healthPct);
  const fit = linearFit(xs, ys);
  const nowDay = Math.floor(now.getTime() / DAY_MS);
  const currentFitted = Math.min(100, fit.intercept + fit.slope * last);

  // Acceleration: recent window decline vs the earlier period's decline.
  const cutoff = last - s.accelerationWindowDays;
  const recent = points.filter((p) => p.day > cutoff);
  const earlier = points.filter((p) => p.day <= cutoff);
  const recentRate = declineRate(recent, s);
  const earlierRate = declineRate(earlier, s);
  const accelerating =
    recentRate !== null &&
    earlierRate !== null &&
    earlierRate > s.flatSlopePctPerDay &&
    recentRate >= s.accelerationRatio * earlierRate;

  let confidence = confidenceLabel(fit.r2, spanDays, s);
  // A straight line is a poor model of an accelerating decline: be less sure.
  if (accelerating) confidence = LOWER[confidence];

  // Forecast the day health crosses the replacement threshold.
  let forecast = null;
  const declining = -fit.slope > s.flatSlopePctPerDay;
  if (latestHealth <= s.replacementThresholdPct) {
    forecast = { alreadyBelowThreshold: true, thresholdPct: s.replacementThresholdPct, confidence };
  } else if (declining) {
    const band = Number.isFinite(fit.slopeSe) ? s.forecastSeMultiplier * fit.slopeSe : 0;
    let fastRate = -(fit.slope - band); // steeper decline, pct/day (positive)
    const slowSlope = fit.slope + band; // shallower
    // When the decline is accelerating, the all-time line averages in the slow early period
    // and would falsely reassure. Use the recent rate as the early bound and measure the gap
    // from the latest observed health.
    let gapFrom = currentFitted;
    if (accelerating) {
      fastRate = Math.max(fastRate, recentRate);
      gapFrom = latestHealth;
    }
    const gap = gapFrom - s.replacementThresholdPct;
    const daysLow = gap / fastRate;
    const daysHigh = slowSlope < -s.flatSlopePctPerDay * 0.25 ? gap / -slowSlope : null; // null = open-ended
    const daysMid = daysHigh === null ? gap / -fit.slope : accelerating ? (daysLow + daysHigh) / 2 : gap / -fit.slope;
    const asOf = (days) => new Date((last + days) * DAY_MS).toISOString().slice(0, 10);
    forecast = {
      alreadyBelowThreshold: false,
      thresholdPct: s.replacementThresholdPct,
      confidence,
      daysFromLastSampleLow: Math.round(daysLow),
      daysFromLastSampleMid: Math.round(daysMid),
      daysFromLastSampleHigh: daysHigh === null ? null : Math.round(daysHigh),
      dateLow: asOf(daysLow),
      dateMid: asOf(daysMid),
      dateHigh: daysHigh === null ? null : asOf(daysHigh),
      monthsLow: round1(daysLow / 30.4),
      monthsHigh: daysHigh === null ? null : round1(daysHigh / 30.4),
      nowDay,
    };
  }

  // Severity.
  let severity = null;
  if (latestHealth < s.attentionBelowPct || accelerating) severity = 'Attention';
  else if (latestHealth < s.watchBelowPct) severity = 'Watch';

  const findings = [];
  if (severity) {
    findings.push({
      rule: 'battery_wear',
      component: 'battery',
      severity,
      title: accelerating ? 'Battery degradation is accelerating' : 'Battery wear detected',
      evidence: {
        healthPct: round1(latestHealth),
        slopePctPerDay: round3(fit.slope),
        r2: round2(fit.r2),
        spanDays,
        points: points.length,
        accelerating,
        recentDeclinePctPerDay: recentRate === null ? null : round3(recentRate),
        earlierDeclinePctPerDay: earlierRate === null ? null : round3(earlierRate),
        forecast,
      },
    });
  }

  return {
    status: 'ok',
    healthPct: round1(latestHealth),
    points: points.length,
    spanDays,
    slopePctPerDay: round3(fit.slope),
    r2: round2(fit.r2),
    forecast,
    findings,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
