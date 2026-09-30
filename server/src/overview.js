// All of a user's devices at a glance: latest readings, readings counts, which signals each device actually
// provides (coverage), and active findings. Missing signals are reported as not covered, never as zero readings.

const SEVERITIES = ['Urgent', 'Attention', 'Watch', 'Information'];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const SMART_KEYS = ['smartPassed', 'criticalWarning', 'availableSparePct', 'percentageUsed', 'mediaErrors', 'reallocatedSectors', 'pendingSectors'];

async function latestValues(db, deviceId, kind) {
  const row = await db.get(
    `SELECT ts, vals AS v FROM samples WHERE device_id = ? AND kind = ? ORDER BY ts DESC LIMIT 1`,
    deviceId,
    kind,
  );
  return row ? { ts: row.ts, ...JSON.parse(row.v) } : null;
}

export async function overview(db, userId) {
  const devices = await db.all('SELECT * FROM devices WHERE user_id = ? ORDER BY id', userId);
  const out = [];
  const allFindings = [];

  for (const d of devices) {
    const counts = await db.all(
      `SELECT kind, COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM samples WHERE device_id = ? GROUP BY kind`,
      d.id,
    );
    const readings = { cpu: 0, storage: 0, battery: 0 };
    let first = null;
    for (const c of counts) {
      if (c.kind in readings) readings[c.kind] = Number(c.n);
      if (!first || c.first < first) first = c.first;
    }
    const cpu = await latestValues(db, d.id, 'cpu');
    const storage = await latestValues(db, d.id, 'storage');
    const battery = await latestValues(db, d.id, 'battery');
    const findings = (await db.all(`SELECT * FROM findings WHERE device_id = ? AND status = 'active'`, d.id)).map((f) => ({
      id: f.id,
      deviceId: d.id,
      deviceName: d.name,
      data: d.is_simulated ? 'Simulated' : 'Real',
      rule: f.rule,
      component: f.component,
      severity: f.severity,
      title: f.title,
      firstSeen: f.first_seen,
      lastSeen: f.last_seen,
    }));
    allFindings.push(...findings);

    const health = battery && num(battery.fullChargeWh) && num(battery.designWh) ? Math.round((battery.fullChargeWh / battery.designWh) * 1000) / 10 : null;
    out.push({
      id: d.id,
      name: d.name,
      model: d.model,
      bios: d.bios,
      isSimulated: !!d.is_simulated,
      lastSeen: d.last_seen,
      monitoredSince: first,
      readings,
      latest: {
        cpu: cpu && { ts: cpu.ts, cpuLoadPct: num(cpu.cpuLoadPct), memUsedPct: num(cpu.memUsedPct), cpuFreqRatio: num(cpu.cpuFreqRatio), cpuTempC: num(cpu.cpuTempC), pluggedIn: cpu.pluggedIn ?? null },
        storage: storage && { ts: storage.ts, ioProbeMs: num(storage.ioProbeMs), freeSpacePct: num(storage.freeSpacePct), percentageUsed: num(storage.percentageUsed) },
        battery: battery && { ts: battery.ts, healthPct: health, percent: num(battery.percent) },
      },
      coverage: {
        cpu: num(cpu?.cpuLoadPct) !== null,
        memory: num(cpu?.memUsedPct) !== null,
        cpuSpeed: num(cpu?.cpuFreqRatio) !== null,
        temperature: num(cpu?.cpuTempC) !== null,
        battery: health !== null,
        diskTest: num(storage?.ioProbeMs) !== null,
        freeSpace: num(storage?.freeSpacePct) !== null,
        smart: !!storage && SMART_KEYS.some((k) => storage[k] !== null && storage[k] !== undefined),
      },
      findings,
      worstSeverity: SEVERITIES.find((s) => findings.some((f) => f.severity === s)) ?? 'Normal',
    });
  }

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, allFindings.filter((f) => f.severity === s).length]));
  const rank = { Urgent: 0, Attention: 1, Watch: 2, Information: 3 };
  return {
    totals: {
      devices: out.length,
      real: out.filter((d) => !d.isSimulated).length,
      simulated: out.filter((d) => d.isSimulated).length,
      activeFindings: allFindings.length,
      bySeverity,
      readings: out.reduce((a, d) => a + d.readings.cpu + d.readings.storage + d.readings.battery, 0),
    },
    devices: out,
    findings: allFindings.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.lastSeen < b.lastSeen ? 1 : -1)),
  };
}

// What is measured, how often, and the live thresholds (read from settings, so the page cannot drift from the code).
export function monitoring(settings) {
  return {
    cadence: { cpuSeconds: 60, batterySeconds: 3600, storageSeconds: 900, commandPollSeconds: 15, diagnoseSeconds: 10 },
    settings,
  };
}
