import { describe, it, expect } from 'vitest';
import { detectBattery, dailyHealth, linearFit } from '../src/detectors/battery.js';
import { defaultSettings, withOverrides } from '../src/settings.js';
import { scenarios, batterySeries } from '../../simulator/generate.js';

const DAY_MS = 86_400_000;
const lastTs = (samples) => new Date(samples[samples.length - 1].ts);

describe('helpers', () => {
  it('linearFit recovers an exact line', () => {
    const fit = linearFit([0, 1, 2, 3, 4], [10, 8, 6, 4, 2]);
    expect(fit.slope).toBeCloseTo(-2, 10);
    expect(fit.intercept).toBeCloseTo(10, 10);
    expect(fit.r2).toBeCloseTo(1, 10);
  });

  it('dailyHealth collapses hourly samples to one point per day', () => {
    const hourly = batterySeries({ days: 10, healthAt: () => 90, samplesPerDay: 6, seed: 5 });
    expect(hourly.length).toBe(60);
    expect(dailyHealth(hourly).length).toBe(10);
  });

  it('dailyHealth skips null, zero and unparseable readings instead of treating them as zero', () => {
    const points = dailyHealth([
      { ts: '2026-01-01T00:00:00Z', designWh: 60, fullChargeWh: 54 },
      { ts: '2026-01-02T00:00:00Z', designWh: 60, fullChargeWh: null },
      { ts: '2026-01-03T00:00:00Z', designWh: 0, fullChargeWh: 50 },
      { ts: 'not-a-date', designWh: 60, fullChargeWh: 50 },
    ]);
    expect(points).toHaveLength(1);
    expect(points[0].healthPct).toBeCloseTo(90, 5);
  });
});

describe('scenario: healthy device', () => {
  it('raises no finding (and no forecast) for 30 days of normal readings', () => {
    const samples = scenarios.healthy();
    const r = detectBattery(samples, defaultSettings, lastTs(samples));
    expect(r.findings).toEqual([]);
    expect(r.healthPct).toBeGreaterThan(98);
    expect(r.forecast).toBeNull(); // flat: nothing to forecast
  });
});

describe('scenario: battery slow decline (100% -> 80% over 180 days)', () => {
  const samples = scenarios.slowDecline();
  const r = detectBattery(samples, defaultSettings, lastTs(samples));

  it('raises Watch, not Attention', () => {
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].severity).toBe('Watch');
    expect(r.findings[0].rule).toBe('battery_wear');
  });

  it('forecast range contains the true 70% crossing date', () => {
    const trueDate = new Date(Date.parse('2026-01-01T12:00:00Z') + 270 * DAY_MS)
      .toISOString()
      .slice(0, 10);
    expect(r.forecast.alreadyBelowThreshold).toBe(false);
    expect(r.forecast.dateLow <= trueDate).toBe(true);
    expect(r.forecast.dateHigh === null || r.forecast.dateHigh >= trueDate).toBe(true);
  });

  it('reports High confidence for a clean 180-day fit', () => {
    expect(r.forecast.confidence).toBe('High');
  });
});

describe('scenario: battery accelerating (decline rate 2.5x in the last 30 days)', () => {
  const samples = scenarios.accelerating();
  const r = detectBattery(samples, defaultSettings, lastTs(samples));

  it('raises Attention and flags acceleration', () => {
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].severity).toBe('Attention');
    expect(r.findings[0].evidence.accelerating).toBe(true);
    expect(r.findings[0].title).toMatch(/accelerating/i);
  });

  it('lowers confidence to Moderate or Low because a straight line fits badly', () => {
    expect(['Moderate', 'Low']).toContain(r.forecast.confidence);
  });

  it('does not falsely reassure: early bound follows the RECENT decline rate', () => {
    // Recent true rate 0.15 %/day from ~86.7% -> 70% is ~111 days after the last sample.
    // An all-history straight line would say ~9 months. The early bound must be near 4 months.
    const lastDay = Date.parse(samples.at(-1).ts);
    const trueRecentCrossing = new Date(lastDay + 111 * DAY_MS).toISOString().slice(0, 10);
    expect(r.forecast.dateLow <= trueRecentCrossing).toBe(true);
    expect(r.forecast.monthsLow).toBeLessThan(5);
    // and the range is honestly wide, not falsely narrow
    expect(r.forecast.monthsHigh - r.forecast.monthsLow).toBeGreaterThan(2);
  });
});

describe('scenario: little data (3 readings over 4 days)', () => {
  it('says collecting data and shows no forecast or finding', () => {
    const samples = scenarios.littleData();
    expect(samples).toHaveLength(3);
    const r = detectBattery(samples, defaultSettings, lastTs(samples));
    expect(r.status).toBe('collecting');
    expect(r.forecast).toBeNull();
    expect(r.findings).toEqual([]);
  });

  it('also refuses a forecast when there are enough points but too short a span', () => {
    // 6 daily points across 5 days: points ok, span (5) < minSpanDays (14)
    const samples = batterySeries({ days: 6, healthAt: (d) => 90 - d, seed: 3 });
    const r = detectBattery(samples, defaultSettings, lastTs(samples));
    expect(r.status).toBe('collecting');
    expect(r.forecast).toBeNull();
  });

  it('returns an empty result for no samples at all', () => {
    const r = detectBattery([], defaultSettings, new Date('2026-01-01'));
    expect(r.status).toBe('collecting');
    expect(r.healthPct).toBeNull();
  });
});

describe('confidence and forecast rules', () => {
  it('never reports High confidence for a short span, even with a perfect fit', () => {
    const samples = batterySeries({ days: 20, healthAt: (d) => 95 - 0.5 * d, noisePct: 0, seed: 4 });
    const r = detectBattery(samples, defaultSettings, lastTs(samples));
    expect(r.status).toBe('ok');
    expect(r.forecast.confidence).not.toBe('High'); // span 19 days < 60
  });

  it('flags an already-worn battery below the replacement threshold', () => {
    const samples = batterySeries({ days: 60, healthAt: (d) => 74 - 0.1 * d, seed: 6 });
    const r = detectBattery(samples, defaultSettings, lastTs(samples));
    expect(r.findings[0].severity).toBe('Attention');
    expect(r.forecast.alreadyBelowThreshold).toBe(true);
  });

  it('honors overridden thresholds from the settings file', () => {
    const samples = scenarios.slowDecline();
    const strict = withOverrides({ battery: { watchBelowPct: 70 } });
    const r = detectBattery(samples, strict, lastTs(samples));
    expect(r.findings).toEqual([]); // 80% is no longer below the (lowered) watch line
  });

  it('is deterministic: same input, same output', () => {
    const samples = scenarios.slowDecline();
    const a = detectBattery(samples, defaultSettings, lastTs(samples));
    const b = detectBattery(samples, defaultSettings, lastTs(samples));
    expect(a).toEqual(b);
  });
});
