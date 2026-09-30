// Runs detectors for a device and keeps the findings table in sync.
// Anti-false-alarm rules (from the plan):
//   * a finding must be detected on `confirmDetections` consecutive evaluations before it shows,
//   * an active finding clears only after `clearAfterNormal` consecutive normal evaluations,
//   * at most one live finding per (device, rule).

import { detectBattery } from './detectors/battery.js';
import { detectStorage, STORAGE_RULES } from './detectors/storage.js';
import { detectThermal } from './detectors/thermal.js';
import { explainFinding } from './explain/templates.js';

const DAY_MS = 86_400_000;
const STORAGE_LOOKBACK_DAYS = 15; // two error windows plus slack; the baseline window is loaded separately

const parseRows = (rows) => rows.map((r) => ({ ts: r.ts, ...JSON.parse(r.v) }));

export async function loadBatterySamples(db, deviceId) {
  const rows = await db.all(`SELECT ts, vals AS v FROM samples WHERE device_id = ? AND kind = 'battery' ORDER BY ts`, deviceId);
  return rows.map((r) => {
    const v = JSON.parse(r.v);
    return { ts: r.ts, fullChargeWh: v.fullChargeWh, designWh: v.designWh };
  });
}

async function syncRule(db, deviceId, rule, detected, cfg, nowIso) {
  const live = await db.get(
    `SELECT * FROM findings WHERE device_id = ? AND rule = ? AND status IN ('pending','active')`,
    deviceId,
    rule,
  );

  if (detected) {
    const explanation = explainFinding(detected);
    const evidence = JSON.stringify(detected.evidence);
    if (!live) {
      const status = cfg.confirmDetections <= 1 ? 'active' : 'pending';
      await db.run(
        `INSERT INTO findings (device_id, rule, component, severity, title, evidence, explanation,
                               status, detect_count, clear_count, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        deviceId, rule, detected.component, detected.severity, detected.title, evidence, explanation, status, nowIso, nowIso,
      );
      return;
    }
    const count = live.detect_count + 1;
    const status = live.status === 'pending' && count >= cfg.confirmDetections ? 'active' : live.status;
    await db.run(
      `UPDATE findings SET severity = ?, title = ?, evidence = ?, explanation = ?, status = ?,
                           detect_count = ?, clear_count = 0, last_seen = ? WHERE id = ?`,
      detected.severity, detected.title, evidence, explanation, status, count, nowIso, live.id,
    );
    return;
  }

  if (!live) return;
  if (live.status === 'pending') {
    // never surfaced to the user: a one-off blip just disappears
    await db.run('DELETE FROM findings WHERE id = ?', live.id);
    return;
  }
  const clears = live.clear_count + 1;
  if (clears >= cfg.clearAfterNormal) {
    await db.run(`UPDATE findings SET status = 'cleared', clear_count = ?, last_seen = ? WHERE id = ?`, clears, nowIso, live.id);
  } else {
    await db.run('UPDATE findings SET clear_count = ? WHERE id = ?', clears, live.id);
  }
}

export async function evaluateBattery(db, deviceId, settings, now = new Date()) {
  const result = detectBattery(await loadBatterySamples(db, deviceId), settings, now);
  await syncRule(db, deviceId, 'battery_wear', result.findings[0] ?? null, settings.findings, now.toISOString());
  return result;
}

// The baseline window (first days) plus recent history only: storage readings arrive every 15 minutes.
export async function loadStorageSamples(db, deviceId, settings, now) {
  const first = (await db.get(`SELECT MIN(ts) AS ts FROM samples WHERE device_id = ? AND kind = 'storage'`, deviceId))?.ts;
  if (!first) return [];
  const baseEnd = new Date(Date.parse(first) + settings.storage.baselineDays * DAY_MS).toISOString();
  const since = new Date(now.getTime() - STORAGE_LOOKBACK_DAYS * DAY_MS).toISOString();
  return parseRows(
    await db.all(
      `SELECT ts, vals AS v FROM samples
       WHERE device_id = ? AND kind = 'storage' AND (ts < ? OR ts >= ?) ORDER BY ts`,
      deviceId, baseEnd, since,
    ),
  );
}

// CPU samples for the thermal baseline week plus the recent window.
export async function loadCpuSamples(db, deviceId, settings, now) {
  const first = (await db.get(`SELECT MIN(ts) AS ts FROM samples WHERE device_id = ? AND kind = 'cpu'`, deviceId))?.ts;
  if (!first) return [];
  const baseEnd = new Date(Date.parse(first) + settings.thermal.baselineDays * DAY_MS).toISOString();
  const since = new Date(now.getTime() - settings.thermal.recentHours * 3_600_000).toISOString();
  return parseRows(
    await db.all(
      `SELECT ts, vals AS v FROM samples
       WHERE device_id = ? AND kind = 'cpu' AND (ts < ? OR (ts >= ? AND ts <= ?)) ORDER BY ts`,
      deviceId, baseEnd, since, now.toISOString(),
    ),
  );
}

// CPU samples arrive every minute; the thermal trend runs at most once per `evaluateEveryMinutes` of DATA time
// (so a backlog uploaded after a network outage is judged at the times it was measured). Returns whether it ran.
export async function evaluateThermalIfDue(db, deviceId, settings, dataNow) {
  const last = await db.get(`SELECT last_ts FROM evaluations WHERE device_id = ? AND detector = 'thermal'`, deviceId);
  if (last && dataNow.getTime() - Date.parse(last.last_ts) < settings.thermal.evaluateEveryMinutes * 60_000) return false;
  const upsert =
    db.dialect === 'mysql'
      ? `INSERT INTO evaluations (device_id, detector, last_ts) VALUES (?, 'thermal', ?)
         ON DUPLICATE KEY UPDATE last_ts = VALUES(last_ts)`
      : `INSERT INTO evaluations (device_id, detector, last_ts) VALUES (?, 'thermal', ?)
         ON CONFLICT (device_id, detector) DO UPDATE SET last_ts = excluded.last_ts`;
  await db.run(upsert, deviceId, dataNow.toISOString());
  const result = detectThermal(await loadCpuSamples(db, deviceId, settings, dataNow), settings, dataNow);
  // Only a real comparison is a check: "collecting baseline" or "no comparable load" neither confirms nor clears.
  if (result.status === 'ok') {
    await syncRule(db, deviceId, 'thermal', result.findings[0] ?? null, settings.findings, dataNow.toISOString());
  }
  return true;
}

export async function evaluateStorage(db, deviceId, settings, now = new Date()) {
  const result = detectStorage(await loadStorageSamples(db, deviceId, settings, now), settings, now);
  for (const rule of STORAGE_RULES) {
    // Missing data is not a "normal" check: a skipped rule neither confirms nor clears a finding.
    if (result.skippedRules.includes(rule)) continue;
    await syncRule(db, deviceId, rule, result.findings.find((f) => f.rule === rule) ?? null, settings.findings, now.toISOString());
  }
  return result;
}
