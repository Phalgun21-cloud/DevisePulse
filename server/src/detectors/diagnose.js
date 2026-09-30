// Slow-laptop diagnosis. Pure: (sample, settings, baseline) -> ranked causes.
// A missing reading (null/undefined) skips its rule; it is never treated as zero.
// score = how far past the threshold the reading is (1.0 = exactly at it), used only for ranking.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (v) => Math.round(v * 10) / 10;

function topBy(processes, key) {
  const list = Array.isArray(processes) ? processes : [];
  let best = null;
  for (const p of list) {
    if (num(p?.[key]) === null) continue;
    if (!best || p[key] > best[key]) best = p;
  }
  return best;
}

export function diagnose(sample, settings, baseline = {}) {
  const s = settings.diagnose;
  const causes = [];
  const skipped = [];

  const cpu = num(sample.cpuPct);
  const mem = num(sample.memUsedPct);
  const swap = num(sample.swapActivityBytes);
  const busy = num(sample.diskBusyPct);
  const latency = num(sample.diskLatencyMs);
  const baseLatency = num(baseline?.diskLatencyMs);
  const freqRatio = num(sample.cpuFreqRatio);

  // 1. CPU saturated
  if (cpu === null) skipped.push('cpu_saturated');
  else if (cpu >= s.cpuPct) {
    const hog = topBy(sample.topProcesses, 'cpuPct');
    causes.push({
      rule: 'cpu_saturated',
      score: cpu / s.cpuPct,
      process: hog?.name ?? null,
      evidence: {
        cpuPct: cpu,
        thresholdPct: s.cpuPct,
        topProcessCpuPct: hog ? hog.cpuPct : null,
        processCount: hog ? (hog.count ?? 1) : null,
      },
    });
  }

  // 2. Memory pressure (high use or paging)
  const swapActive = swap !== null && swap >= s.swapActivityBytesMin;
  if (mem === null && swap === null) skipped.push('memory_pressure');
  else if ((mem !== null && mem >= s.memUsedPct) || swapActive) {
    const big = topBy(sample.topProcesses, 'memMb');
    const memScore = mem !== null ? mem / s.memUsedPct : 0;
    causes.push({
      rule: 'memory_pressure',
      score: Math.max(memScore, swapActive ? 1 : 0),
      process: big?.name ?? null,
      evidence: {
        memUsedPct: mem,
        thresholdPct: s.memUsedPct,
        swapActivityBytes: swap,
        topProcessMemMb: big ? big.memMb : null,
        processCount: big ? (big.count ?? 1) : null,
      },
    });
  }

  // 3. Disk saturated (busy %, or latency well above the device's own baseline)
  const latencyRatio = latency !== null && baseLatency !== null && baseLatency > 0 ? latency / baseLatency : null;
  if (busy === null && latencyRatio === null) skipped.push('disk_saturated');
  else {
    const busyHit = busy !== null && busy > s.diskBusyPct;
    const latencyHit = latencyRatio !== null && latencyRatio >= s.diskLatencyRatio;
    if (busyHit || latencyHit) {
      causes.push({
        rule: 'disk_saturated',
        score: Math.max(busyHit ? busy / s.diskBusyPct : 0, latencyHit ? latencyRatio / s.diskLatencyRatio : 0),
        process: null,
        evidence: {
          diskBusyPct: busy,
          thresholdPct: s.diskBusyPct,
          diskLatencyMs: latency,
          baselineLatencyMs: baseLatency,
          latencyRatio: latencyRatio === null ? null : round1(latencyRatio),
        },
      });
    }
  }

  // 4. Throttling: clock well below its maximum while the CPU is busy
  if (freqRatio === null || cpu === null) skipped.push('cpu_throttled');
  else if (cpu >= s.throttleMinLoadPct && freqRatio < s.throttleFreqRatio) {
    // On battery the OS lowers the clock on purpose: still reported, but as power saving and ranked lower,
    // so a program saturating the CPU is not hidden behind it (seen on a real unplugged laptop).
    const onBattery = sample.pluggedIn === false;
    const score = s.throttleFreqRatio / Math.max(freqRatio, 0.01);
    causes.push({
      rule: 'cpu_throttled',
      score: onBattery ? score * 0.5 : score,
      process: null,
      evidence: { cpuFreqRatio: freqRatio, thresholdRatio: s.throttleFreqRatio, cpuPct: cpu, onBattery },
    });
  }

  causes.sort((a, b) => b.score - a.score);
  const ranked = causes.map((c, i) => ({ ...c, score: Math.round(c.score * 100) / 100, rank: i + 1 }));

  return {
    verdict: ranked.length ? 'causes_found' : 'no_clear_cause',
    causes: ranked,
    skippedRules: skipped,
  };
}
