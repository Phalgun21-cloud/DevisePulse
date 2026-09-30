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

const procLabel = (name, count) => (count > 1 ? `${name} (${count} processes)` : name);

const causeText = {
  cpu_saturated: (c) =>
    `The processor was ${c.evidence.cpuPct}% busy` +
    (c.process
      ? `, and ${procLabel(c.process, c.evidence.processCount)} was the largest user (${c.evidence.topProcessCpuPct}% of CPU)`
      : '') +
    '. That is consistent with the slowdown.',
  memory_pressure: (c) =>
    `Memory was ${c.evidence.memUsedPct ?? 'heavily'}% used` +
    (c.evidence.swapActivityBytes > 0 ? ' and the system was paging to disk' : '') +
    (c.process ? `; ${procLabel(c.process, c.evidence.processCount)} held the most (${c.evidence.topProcessMemMb} MB)` : '') +
    '. Running short of memory may make everything feel slow.',
  disk_saturated: (c) =>
    `The disk was ${c.evidence.diskBusyPct ?? 'very'}% busy` +
    (c.evidence.latencyRatio ? `, with response times ${c.evidence.latencyRatio}x this laptop's usual` : '') +
    '. A saturated disk is consistent with slow opening and saving.',
  cpu_throttled: (c) =>
    `The processor ran at ${Math.round(c.evidence.cpuFreqRatio * 100)}% of its top speed while busy. ` +
    (c.evidence.onBattery
      ? 'The laptop is on battery, so this is most likely power saving; plugging in may make it faster.'
      : 'That may mean it is slowing itself down to stay cool or save power.'),
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

const smartReasonText = {
  critical_warning: 'its critical warning flag is set',
  spare_at_threshold: 'its reserve of spare blocks has reached the minimum',
  smart_failed: 'its overall self-assessment is "failed"',
};

export function explainStorage(finding) {
  const e = finding.evidence;
  switch (finding.rule) {
    case 'storage_smart_critical':
      return (
        `The drive reports that ${e.reasons.map((r) => smartReasonText[r]).join(' and ')}. ` +
        'That means an elevated risk of losing data. Back up important files now, then have the drive checked.'
      );
    case 'storage_wear':
      return (
        `The drive reports that ${e.percentageUsed}% of its rated write endurance has been used. ` +
        'Many drives keep working past this point, but the risk of problems is elevated. ' +
        'Make sure backups are current and plan a replacement.'
      );
    case 'storage_errors': {
      const name = e.counter === 'reallocatedSectors' ? 'reallocated sectors' : 'media errors';
      const parts = [];
      if (e.errorsNow !== null && e.errorsWeekAgo !== null && e.errorsNow > e.errorsWeekAgo) {
        parts.push(`The drive's count of ${name} rose from ${e.errorsWeekAgo} to ${e.errorsNow} over the last week`);
        if (e.errorsTwoWeeksAgo !== null && e.errorsWeekAgo > e.errorsTwoWeeksAgo) {
          parts[0] += `, after rising from ${e.errorsTwoWeeksAgo} the week before`;
        }
      }
      if (e.pendingSectors > 0) parts.push(`The drive has ${e.pendingSectors} sectors waiting to be remapped`);
      return (
        `${parts.join('. ')}. This is consistent with a drive that is wearing out, and the risk of data loss is elevated. ` +
        'Back up important files and have the drive checked.'
      );
    }
    case 'storage_slow':
      return (
        `The disk is slower than usual: a timed 8 MB write and read took about ${e.recentMedianMs} ms over the last ` +
        `${e.recentHours} hours, compared with ${e.baselineMs} ms in this laptop's first days (${e.ratio}x). ` +
        (e.coMoving === 'free_space_low'
          ? `Free space is also very low (${e.freeSpacePct}%), which may be part of the cause. `
          : e.coMoving === 'smart'
            ? 'The drive is also reporting a health warning (see the related finding). '
            : '') +
        'A nearly full disk, background updates or a wearing drive may cause this. Free up space and check again.'
      );
    case 'storage_free_space':
      return (
        `Only ${e.freeSpacePct}% of the disk is free. Windows and apps may slow down or fail to update when the disk is ` +
        'nearly full. Remove unused programs, old downloads or large files.'
      );
    default:
      return finding.title;
  }
}

export function explainThermal(finding) {
  const e = finding.evidence;
  if (e.basis === 'frequency') {
    return (
      `Under sustained heavy load the processor now runs about ${e.freqDropPct}% slower than in its first week ` +
      `(${e.exampleRecentRatio}x versus ${e.exampleBaselineRatio}x its base speed). Temperature is not available on this ` +
      'device, so the cause cannot be confirmed; this is consistent with the processor slowing itself down because of ' +
      'heat, or with a changed power setting. Steps: check the power mode, clean the air vents and avoid soft surfaces.'
    );
  }
  const parts = [
    `The processor is running hotter than it used to at similar load: about ${e.exampleRecentC} °C at ` +
      `${e.exampleBand} load, compared with ${e.exampleBaselineC} °C in its first week (about ${e.tempRiseC} °C warmer overall).`,
  ];
  if (finding.severity === 'Attention' && e.freqDropPct !== null) {
    parts.push(
      `It is also about ${e.freqDropPct}% slower under heavy load, which may mean it is slowing itself down to stay cool.`,
    );
  }
  parts.push(
    'This is consistent with dust in the vents, a weaker fan or dried thermal paste. ' +
      'Steps: clean the air vents, use it on a hard flat surface, and have the fan checked if it stays hot.',
  );
  return parts.join(' ');
}

export function explainFinding(finding) {
  if (finding.component === 'storage') return explainStorage(finding);
  if (finding.component === 'thermal') return explainThermal(finding);
  switch (finding.rule) {
    case 'battery_wear':
      return explainBattery(finding);
    default:
      return finding.title;
  }
}
