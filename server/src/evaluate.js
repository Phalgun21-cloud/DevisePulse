// Runs detectors for a device and keeps the findings table in sync.
// Anti-false-alarm rules (from the plan):
//   * a finding must be detected on `confirmDetections` consecutive evaluations before it shows,
//   * an active finding clears only after `clearAfterNormal` consecutive normal evaluations,
//   * at most one live finding per (device, rule).

import { detectBattery } from './detectors/battery.js';
import { explainFinding } from './explain/templates.js';

export function loadBatterySamples(db, deviceId) {
  const rows = db
    .prepare(`SELECT ts, "values" AS v FROM samples WHERE device_id = ? AND kind = 'battery' ORDER BY ts`)
    .all(deviceId);
  return rows.map((r) => {
    const v = JSON.parse(r.v);
    return { ts: r.ts, fullChargeWh: v.fullChargeWh, designWh: v.designWh };
  });
}

function syncRule(db, deviceId, rule, detected, cfg, nowIso) {
  const live = db
    .prepare(`SELECT * FROM findings WHERE device_id = ? AND rule = ? AND status IN ('pending','active')`)
    .get(deviceId, rule);

  if (detected) {
    const explanation = explainFinding(detected);
    const evidence = JSON.stringify(detected.evidence);
    if (!live) {
      const status = cfg.confirmDetections <= 1 ? 'active' : 'pending';
      db.prepare(
        `INSERT INTO findings (device_id, rule, component, severity, title, evidence, explanation,
                               status, detect_count, clear_count, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      ).run(deviceId, rule, detected.component, detected.severity, detected.title, evidence, explanation, status, nowIso, nowIso);
      return;
    }
    const count = live.detect_count + 1;
    const status = live.status === 'pending' && count >= cfg.confirmDetections ? 'active' : live.status;
    db.prepare(
      `UPDATE findings SET severity = ?, title = ?, evidence = ?, explanation = ?, status = ?,
                           detect_count = ?, clear_count = 0, last_seen = ? WHERE id = ?`,
    ).run(detected.severity, detected.title, evidence, explanation, status, count, nowIso, live.id);
    return;
  }

  if (!live) return;
  if (live.status === 'pending') {
    // never surfaced to the user: a one-off blip just disappears
    db.prepare('DELETE FROM findings WHERE id = ?').run(live.id);
    return;
  }
  const clears = live.clear_count + 1;
  if (clears >= cfg.clearAfterNormal) {
    db.prepare(`UPDATE findings SET status = 'cleared', clear_count = ?, last_seen = ? WHERE id = ?`).run(clears, nowIso, live.id);
  } else {
    db.prepare('UPDATE findings SET clear_count = ? WHERE id = ?').run(clears, live.id);
  }
}

export function evaluateBattery(db, deviceId, settings, now = new Date()) {
  const result = detectBattery(loadBatterySamples(db, deviceId), settings, now);
  syncRule(db, deviceId, 'battery_wear', result.findings[0] ?? null, settings.findings, now.toISOString());
  return result;
}
