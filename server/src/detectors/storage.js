// Storage health. Pure: (samples, settings, now) -> { status, findings, skippedRules }.
// samples: [{ ts, ioProbeMs, freeSpacePct, smartPassed, criticalWarning, availableSparePct,
//             availableSpareThresholdPct, percentageUsed, mediaErrors, reallocatedSectors, pendingSectors }]
// Tier A = SMART fields (null when smartctl is unavailable). Tier B = ioProbeMs, a timed 8 MB write+fsync+read.
// A missing field skips its rule; it is never read as zero. Never predicts when a drive will stop working.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const STORAGE_RULES = ['storage_smart_critical', 'storage_wear', 'storage_errors', 'storage_slow', 'storage_free_space'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (n) => Math.round(n * 10) / 10;

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Latest non-null value of `key` at or before time t (ms), or null.
function valueAt(sorted, key, t) {
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].t <= t && num(sorted[i][key]) !== null) return sorted[i][key];
  }
  return null;
}

const finding = (rule, severity, title, evidence) => ({ rule, component: 'storage', severity, title, evidence });

export function detectStorage(samples, settings, now) {
  const s = settings.storage;
  const nowMs = now.getTime();
  const sorted = samples
    .map((x) => ({ ...x, t: Date.parse(x.ts) }))
    .filter((x) => Number.isFinite(x.t) && x.t <= nowMs)
    .sort((a, b) => a.t - b.t);
  const latest = sorted[sorted.length - 1] ?? {};
  const findings = [];
  const skipped = [];
  const status = { probe: 'no_data', smart: 'not_available' };

  // --- Tier A: hard SMART warnings -> Urgent ---------------------------------------------
  const cw = num(latest.criticalWarning);
  const spare = num(latest.availableSparePct);
  const spareMin = num(latest.availableSpareThresholdPct);
  const passed = typeof latest.smartPassed === 'boolean' ? latest.smartPassed : null;
  if (cw === null && (spare === null || spareMin === null) && passed === null) skipped.push('storage_smart_critical');
  else {
    status.smart = 'available';
    const reasons = [];
    if (cw !== null && cw > 0) reasons.push('critical_warning');
    if (spare !== null && spareMin !== null && spare <= spareMin) reasons.push('spare_at_threshold');
    if (passed === false) reasons.push('smart_failed');
    if (reasons.length) {
      findings.push(
        finding('storage_smart_critical', 'Urgent', 'Drive reports a critical health warning: back up now', {
          reasons,
          criticalWarning: cw,
          availableSparePct: spare,
          availableSpareThresholdPct: spareMin,
          smartPassed: passed,
        }),
      );
    }
  }

  // --- Tier A: wear (rated endurance used) -----------------------------------------------
  const used = num(latest.percentageUsed);
  if (used === null) skipped.push('storage_wear');
  else if (used >= s.wearAttentionPct) {
    findings.push(
      finding('storage_wear', 'Attention', 'Drive has used most of its rated write endurance', {
        percentageUsed: used,
        thresholdPct: s.wearAttentionPct,
      }),
    );
  }

  // --- Tier A: error counters, week over week --------------------------------------------
  const errKey = num(latest.mediaErrors) !== null ? 'mediaErrors' : num(latest.reallocatedSectors) !== null ? 'reallocatedSectors' : null;
  const pending = num(latest.pendingSectors);
  if (errKey === null && pending === null) skipped.push('storage_errors');
  else {
    const w = s.errorWindowDays * DAY_MS;
    const e0 = errKey ? valueAt(sorted, errKey, nowMs) : null;
    const e1 = errKey ? valueAt(sorted, errKey, nowMs - w) : null;
    const e2 = errKey ? valueAt(sorted, errKey, nowMs - 2 * w) : null;
    const risingNow = e0 !== null && e1 !== null && e0 > e1;
    const risingBefore = e1 !== null && e2 !== null && e1 > e2;
    let severity = null;
    if ((pending !== null && pending > 0) || (risingNow && risingBefore)) severity = 'Attention';
    else if (risingNow) severity = 'Watch';
    if (severity) {
      findings.push(
        finding('storage_errors', severity, risingNow && risingBefore ? 'Drive errors are rising week over week' : 'Drive is reporting errors', {
          counter: errKey,
          errorsNow: e0,
          errorsWeekAgo: e1,
          errorsTwoWeeksAgo: e2,
          pendingSectors: pending,
        }),
      );
    }
  }
  const smartSignal = findings.some((f) => f.rule !== 'storage_free_space');

  // --- free space ----------------------------------------------------------------------
  const free = num(latest.freeSpacePct);
  if (free === null) skipped.push('storage_free_space');
  else if (free < s.freeInfoBelowPct) {
    findings.push(
      finding('storage_free_space', free < s.freeWatchBelowPct ? 'Watch' : 'Information', 'Disk is nearly full', {
        freeSpacePct: free,
        thresholdPct: free < s.freeWatchBelowPct ? s.freeWatchBelowPct : s.freeInfoBelowPct,
      }),
    );
  }

  // --- Tier B: timed probe vs the device's own first days --------------------------------
  const probes = sorted.filter((x) => num(x.ioProbeMs) !== null && x.ioProbeMs > 0);
  if (!probes.length) skipped.push('storage_slow');
  else {
    const baseEnd = probes[0].t + s.baselineDays * DAY_MS;
    const base = probes.filter((x) => x.t < baseEnd).map((x) => x.ioProbeMs);
    const recent = probes.filter((x) => x.t > nowMs - s.recentHours * HOUR_MS).map((x) => x.ioProbeMs);
    if (nowMs < baseEnd || base.length < s.minBaselineSamples) {
      status.probe = 'collecting_baseline';
    } else if (recent.length < s.minRecentSamples) {
      status.probe = 'not_enough_recent';
    } else {
      status.probe = 'ok';
      const baselineMs = round1(median(base));
      const recentMedianMs = round1(median(recent));
      const ratio = round1(recentMedianMs / baselineMs);
      if (ratio >= s.slowRatio) {
        // One signal alone stays at Watch (rule 3). Attention only when a second storage signal moves with it.
        const fullToo = free !== null && free < s.freeWatchBelowPct;
        const coMoving = fullToo || smartSignal;
        findings.push(
          finding('storage_slow', coMoving ? 'Attention' : 'Watch', 'Disk is slower than usual', {
            baselineMs,
            recentMedianMs,
            ratio,
            thresholdRatio: s.slowRatio,
            baselineSamples: base.length,
            recentSamples: recent.length,
            recentHours: s.recentHours,
            coMoving: fullToo ? 'free_space_low' : smartSignal ? 'smart' : null,
            freeSpacePct: free,
          }),
        );
      }
    }
  }

  return { status, findings, skippedRules: skipped };
}
