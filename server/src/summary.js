// Current state of one device for the dashboard, from the same pure detectors the lifecycle uses.
// Nothing here is invented: no data -> a "collecting"/"no_data" status and nulls.

import { detectBattery, dailyHealth } from './detectors/battery.js';
import { detectStorage } from './detectors/storage.js';
import { detectThermal } from './detectors/thermal.js';
import { loadBatterySamples, loadStorageSamples, loadCpuSamples } from './evaluate.js';

const DAY_MS = 86_400_000;
const round1 = (n) => Math.round(n * 10) / 10;

async function latest(db, deviceId, kind) {
  const row = await db.get(
    `SELECT ts, vals AS v FROM samples WHERE device_id = ? AND kind = ? ORDER BY ts DESC LIMIT 1`,
    deviceId,
    kind,
  );
  return row ? { ts: row.ts, values: JSON.parse(row.v) } : null;
}

export async function deviceSummary(db, device, settings, clock) {
  const batterySamples = await loadBatterySamples(db, device.id);
  const b = detectBattery(batterySamples, settings, clock);
  let forecast = null;
  if (b.forecast) {
    // Exact dates are deliberately dropped: the dashboard shows ranges, never a failure date.
    const { dateLow, dateMid, dateHigh, ...rest } = b.forecast; // eslint-disable-line no-unused-vars
    forecast = rest;
  }

  const cpu = await latest(db, device.id, 'cpu');
  const cpuNow = cpu ? new Date(cpu.ts) : clock;
  const storage = detectStorage(await loadStorageSamples(db, device.id, settings, clock), settings, clock);
  const thermal = detectThermal(await loadCpuSamples(db, device.id, settings, cpuNow), settings, cpuNow);

  return {
    battery: {
      status: b.status,
      healthPct: b.healthPct,
      points: b.points,
      spanDays: b.spanDays,
      needsPoints: settings.battery.minPoints,
      needsSpanDays: settings.battery.minSpanDays,
      forecast,
      thresholdPct: settings.battery.replacementThresholdPct,
      watchBelowPct: settings.battery.watchBelowPct,
    },
    batteryHistory: dailyHealth(batterySamples)
      .slice(-365)
      .map((p) => ({ date: new Date(p.day * DAY_MS).toISOString().slice(0, 10), healthPct: round1(p.healthPct) })),
    storage: { status: storage.status, skippedRules: storage.skippedRules },
    thermal: { status: thermal.status, skippedRules: thermal.skippedRules },
    latest: { cpu, storage: await latest(db, device.id, 'storage'), battery: await latest(db, device.id, 'battery') },
  };
}
