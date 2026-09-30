// Demo data. Everything here is SIMULATED (seeded simulator) and is labelled so everywhere it appears.
//   seedDemo:  creates a user's simulated demo devices and replays their samples through the REAL detectors and
//              finding lifecycle, one reading at a time, exactly as live ingest would.
//   fleetDemo: a synthetic 200-laptop fleet with one planted model+BIOS battery problem, computed in memory.

import crypto from 'node:crypto';
import { hashToken } from './middleware/auth.js';
import { evaluateBattery, evaluateStorage, evaluateThermalIfDue } from './evaluate.js';
import { detectBattery } from './detectors/battery.js';
import { scenarios, storageScenarios, thermalScenarios, batterySeries, mulberry32 } from '../../simulator/generate.js';

const DEMO_DEVICES = [
  { name: 'LAB-03', model: 'Model C', bios: '3.1.0', note: 'healthy', battery: () => scenarios.healthy() },
  { name: 'LAB-07', model: 'Model A', bios: '1.4.2', note: 'battery wear accelerating', battery: () => scenarios.accelerating() },
  { name: 'LAB-12', model: 'Model B', bios: '2.0.1', note: 'disk slower than usual and nearly full', storage: () => storageScenarios.slowAndFull() },
  { name: 'LAB-21', model: 'Model B', bios: '2.1.0', note: 'hotter and slower at the same load', cpu: () => thermalScenarios.hotterWithFreqDrop() },
];

// Shift a scenario so its last reading is just before `clock`.
function shift(samples, clock) {
  const offset = clock.getTime() - 5 * 60_000 - Date.parse(samples[samples.length - 1].ts);
  return samples.map((s) => ({ ...s, ts: new Date(Date.parse(s.ts) + offset).toISOString() }));
}

async function replay(db, deviceId, kind, samples, onEach) {
  for (const { ts, ...values } of samples) {
    await db.run(`INSERT OR IGNORE INTO samples (device_id, ts, kind, vals) VALUES (?, ?, ?, ?)`, deviceId, ts, kind, JSON.stringify(values));
    await onEach(new Date(ts));
  }
}

export async function seedDemo(db, userId, settings, clock) {
  const existing = await db.all(`SELECT id, name FROM devices WHERE user_id = ? AND is_simulated = 1 ORDER BY id`, userId);
  const have = new Set(existing.map((d) => d.name));
  const created = [];

  for (const spec of DEMO_DEVICES) {
    if (have.has(spec.name)) continue;
    const id = await db.tx(async (t) => {
      const info = await t.run(
        `INSERT INTO devices (user_id, name, model, os, bios, token_hash, is_simulated, created_at)
         VALUES (?, ?, ?, 'Simulated', ?, ?, 1, ?)`,
        userId, spec.name, spec.model, spec.bios, hashToken(crypto.randomBytes(24).toString('hex')), clock.toISOString(),
      );
      const newId = Number(info.lastInsertRowid);
      if (spec.battery) await replay(t, newId, 'battery', shift(spec.battery(), clock), (at) => evaluateBattery(t, newId, settings, at));
      if (spec.storage) await replay(t, newId, 'storage', shift(spec.storage(), clock), (at) => evaluateStorage(t, newId, settings, at));
      if (spec.cpu) await replay(t, newId, 'cpu', shift(spec.cpu(), clock), (at) => evaluateThermalIfDue(t, newId, settings, at));
      await t.run('UPDATE devices SET last_seen = ? WHERE id = ?', clock.toISOString(), newId);
      return newId;
    });
    created.push({ id, name: spec.name, scenario: spec.note });
  }
  return { created, devices: DEMO_DEVICES.map((d) => ({ name: d.name, scenario: d.note })) };
}

// ---- synthetic fleet --------------------------------------------------------------------

const FLEET_GROUPS = [
  { model: 'Model A', bios: '1.4.2', devices: 24, planted: true },
  { model: 'Model A', bios: '1.5.0', devices: 40 },
  { model: 'Model B', bios: '2.0.1', devices: 60 },
  { model: 'Model B', bios: '2.1.0', devices: 46 },
  { model: 'Model C', bios: '3.1.0', devices: 30 },
];
const RANK = { Watch: 1, Attention: 2, Urgent: 3 };
let fleetCache = null;

export function fleetDemo(settings) {
  if (fleetCache && fleetCache.settings === settings) return fleetCache.result;
  const rand = mulberry32(2026);
  const days = 120;
  const endIso = '2026-05-01T12:00:00Z';
  const startIso = new Date(Date.parse(endIso) - (days - 1) * 86_400_000).toISOString();
  const groups = [];
  let seed = 1000;

  for (const g of FLEET_GROUPS) {
    let withFinding = 0;
    for (let i = 0; i < g.devices; i++) {
      const startHealth = 90 + rand() * 9;
      // Normal wear: 0.005-0.04 points/day. Planted group: a firmware-style fault that wears most batteries fast.
      const faulty = g.planted ? rand() < 0.6 : rand() < 0.03;
      const rate = faulty ? 0.06 + rand() * 0.08 : 0.005 + rand() * 0.035;
      const series = batterySeries({ startIso, days, healthAt: (d) => startHealth - rate * d, seed: seed++ });
      const r = detectBattery(series, settings, new Date(endIso));
      if (r.findings.some((f) => RANK[f.severity] >= 1)) withFinding += 1;
    }
    groups.push({ model: g.model, bios: g.bios, devices: g.devices, withFinding });
  }

  const minGroupSize = 10;
  const total = groups.reduce((a, g) => a + g.devices, 0);
  const totalWith = groups.reduce((a, g) => a + g.withFinding, 0);
  for (const g of groups) {
    const restDevices = total - g.devices;
    const restWith = totalWith - g.withFinding;
    g.ratePct = Math.round((g.withFinding / g.devices) * 1000) / 10;
    g.restRatePct = Math.round((restWith / restDevices) * 1000) / 10;
    // A pattern needs a real group size, several affected devices, and a clearly higher rate than the rest.
    g.pattern = g.devices >= minGroupSize && g.withFinding >= 3 && g.ratePct >= 3 * Math.max(g.restRatePct, 1);
  }

  const result = {
    data: 'Synthetic',
    note: 'Seeded simulator fleet. The Model A / BIOS 1.4.2 battery problem is planted for the demo.',
    devices: total,
    daysOfData: days,
    minGroupSize,
    withFinding: totalWith,
    groups: groups.filter((g) => g.devices >= minGroupSize),
  };
  fleetCache = { settings, result };
  return result;
}
