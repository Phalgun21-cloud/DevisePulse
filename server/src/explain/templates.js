// Deterministic explanation text. Works with no AI key; the optional LLM layer only
// rewords this. Wording is hedged on purpose: "elevated", "may", never a failure date.

const fmtRange = (f) => {
  if (f.monthsHigh === null) return `at least ${f.monthsLow} months`;
  if (Math.round(f.monthsLow) === Math.round(f.monthsHigh)) return `about ${Math.round(f.monthsLow)} months`;
  return `roughly ${f.monthsLow} to ${f.monthsHigh} months`;
};

export function explainBattery(finding) {
  const e = finding.evidence;
  const parts = [];

  parts.push(
    finding.severity === 'Attention' && e.accelerating
      ? `Battery capacity is declining faster recently than before. Health is ${e.healthPct}% of its original capacity.`
      : `Battery wear is increasing. Health is ${e.healthPct}% of its original capacity.`,
  );

  if (e.accelerating && e.recentDeclinePctPerDay !== null && e.earlierDeclinePctPerDay !== null) {
    parts.push(
      `Over the last 30 days it lost about ${e.recentDeclinePctPerDay} percentage points per day, ` +
        `compared with ${e.earlierDeclinePctPerDay} earlier.`,
    );
  }

  const f = e.forecast;
  if (f?.alreadyBelowThreshold) {
    parts.push(`It is already at or below your ${f.thresholdPct}% replacement threshold.`);
  } else if (f) {
    parts.push(
      `If the trend continues, health may reach ${f.thresholdPct}% in ${fmtRange(f)} ` +
        `(confidence: ${f.confidence}).`,
    );
  }

  parts.push(
    "Steps: avoid leaving it at 100% on the charger for long periods, check the maker's battery " +
      'tool for a health report, and plan a replacement if battery life becomes a problem.',
  );
  return parts.join(' ');
}

const causeText = {
  cpu_saturated: (c) =>
    `The processor was ${c.evidence.cpuPct}% busy` +
    (c.process ? `, and ${c.process} was the largest user (${c.evidence.topProcessCpuPct}% of CPU)` : '') +
    '. That is consistent with the slowdown.',
  memory_pressure: (c) =>
    `Memory was ${c.evidence.memUsedPct ?? 'heavily'}% used` +
    (c.evidence.swapActivityBytes > 0 ? ' and the system was paging to disk' : '') +
    (c.process ? `; ${c.process} held the most (${c.evidence.topProcessMemMb} MB)` : '') +
    '. Running short of memory may make everything feel slow.',
  disk_saturated: (c) =>
    `The disk was ${c.evidence.diskBusyPct ?? 'very'}% busy` +
    (c.evidence.latencyRatio ? `, with response times ${c.evidence.latencyRatio}x this laptop's usual` : '') +
    '. A saturated disk is consistent with slow opening and saving.',
  cpu_throttled: (c) =>
    `The processor ran at ${Math.round(c.evidence.cpuFreqRatio * 100)}% of its top speed while busy. ` +
    'That may mean it is slowing itself down to stay cool or save power.',
};

export function explainDiagnosis(result) {
  if (!result.causes.length) {
    return (
      'No clear cause was found in this 10-second sample. The slowdown may be intermittent, ' +
      'so try again while it is happening.'
    );
  }
  const lines = result.causes.map((c) => `${c.rank}. ${causeText[c.rule](c)}`);
  return `Likely causes, most prominent first (based on one 10-second sample):\n${lines.join('\n')}`;
}

export function explainFinding(finding) {
  switch (finding.rule) {
    case 'battery_wear':
      return explainBattery(finding);
    default:
      return finding.title;
  }
}
