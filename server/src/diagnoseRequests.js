// Shared helpers for the diagnose command channel (used by the user and agent routes).

const MIN_MS = 60_000;

// Requests nobody collected or finished must not hang the page forever.
export function expireStale(db, deviceId, settings, clock) {
  const cutoff = new Date(clock.getTime() - settings.diagnose.requestExpiryMinutes * MIN_MS).toISOString();
  db.prepare(
    `UPDATE diagnose_requests SET status = 'expired'
     WHERE device_id = ? AND status IN ('pending', 'running') AND created_at < ?`,
  ).run(deviceId, cutoff);
}

// The device's own "normal" disk latency: median of its earlier completed diagnoses.
// Null until there are enough of them, which makes the latency rule skip rather than guess.
export function baselineFor(db, deviceId, settings) {
  const rows = db
    .prepare(`SELECT sample FROM diagnose_requests WHERE device_id = ? AND status = 'done' ORDER BY id`)
    .all(deviceId);
  const latencies = rows
    .map((r) => JSON.parse(r.sample).diskLatencyMs)
    .filter((v) => typeof v === 'number')
    .sort((a, b) => a - b);
  if (latencies.length < settings.diagnose.baselineMinDiagnoses) return { diskLatencyMs: null };
  const mid = Math.floor(latencies.length / 2);
  const median = latencies.length % 2 ? latencies[mid] : (latencies[mid - 1] + latencies[mid]) / 2;
  return { diskLatencyMs: median };
}

export function publicRequest(row) {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    result: row.result ? JSON.parse(row.result) : null,
  };
}
