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

export function explainFinding(finding) {
  switch (finding.rule) {
    case 'battery_wear':
      return explainBattery(finding);
    default:
      return finding.title;
  }
}
