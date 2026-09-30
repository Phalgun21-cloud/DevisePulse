// Every detector threshold lives here so tests and tuning change ONE place.
// These are starting defaults to validate with the tests, not proven values.

export const defaultSettings = {
  findings: {
    confirmDetections: 2, // consecutive detections before a finding is shown
    clearAfterNormal: 3, // consecutive normal checks before an active finding clears
  },
  battery: {
    replacementThresholdPct: 70, // forecast target: health % at which to plan replacement
    minPoints: 5, // distinct days of data needed before any forecast
    minSpanDays: 14, // span of those days
    watchBelowPct: 85,
    attentionBelowPct: 75,
    accelerationWindowDays: 30, // "recent" window for the acceleration check
    accelerationRatio: 2, // recent decline rate / earlier decline rate
    minPointsPerWindow: 3, // days needed in each window to compare rates
    flatSlopePctPerDay: 0.002, // declines slower than this are treated as flat
    forecastSeMultiplier: 2, // forecast range = slope +/- this many standard errors (~95%)
    highConfidence: { r2: 0.9, spanDays: 60 },
    moderateConfidence: { r2: 0.7, spanDays: 30 },
  },
  diagnose: {
    cpuPct: 85, // CPU busy at or above this is a cause
    memUsedPct: 90, // memory used at or above this is a cause
    swapActivityBytesMin: 1024 * 1024, // paging during the 10 s window counts as swap activity
    diskBusyPct: 80, // disk busy above this is a cause
    diskLatencyRatio: 3, // latency this many times the device's own baseline is a cause
    throttleFreqRatio: 0.75, // current/max frequency below this ...
    throttleMinLoadPct: 70, // ... while CPU load is at least this is throttling
    baselineMinDiagnoses: 3, // prior diagnoses needed before a latency baseline exists
    requestExpiryMinutes: 10, // a pending request nobody collected is dropped after this
  },
  storage: {
    wearAttentionPct: 80, // NVMe "percentage used" (rated endurance) at or above this -> Attention
    errorWindowDays: 7, // media errors / reallocated sectors compared week over week
    baselineDays: 3, // the device's own first days of timed probes form its baseline
    minBaselineSamples: 24, // probes needed in the baseline window
    recentHours: 24, // recent window compared with the baseline (median)
    minRecentSamples: 12, // probes needed in the recent window
    slowRatio: 3, // recent median at least this many times the baseline -> slower than usual
    freeInfoBelowPct: 10,
    freeWatchBelowPct: 5, // also the "co-moving" signal that lifts a slow disk to Attention
  },
  thermal: {
    bucketWidthPct: 20, // compare temperature only within the same CPU-load band (0-20, 20-40, ...)
    baselineDays: 7, // the device's own first week is its baseline
    recentHours: 24,
    minBaselinePerBucket: 30, // samples needed in a band for it to count
    minRecentPerBucket: 12,
    tempRiseWatchC: 10, // hotter than baseline at similar load by this much -> Watch
    highLoadFromPct: 60, // bands at/above this load are used for the frequency check
    freqDropWithHeatPct: 10, // frequency drop that, WITH the temperature rise, lifts it to Attention
    sustainedLoadPct: 80, // no temperature: compare frequency only under sustained load above this
    sustainedMinutes: 5, // ... that has lasted at least this long
    freqDropAlonePct: 20, // frequency drop alone (no temperature) -> Watch, never higher
    evaluateEveryMinutes: 60, // CPU samples arrive every minute; the trend check runs at most hourly
  },
};

export function withOverrides(overrides = {}) {
  return {
    ...defaultSettings,
    findings: { ...defaultSettings.findings, ...(overrides.findings ?? {}) },
    battery: { ...defaultSettings.battery, ...(overrides.battery ?? {}) },
    diagnose: { ...defaultSettings.diagnose, ...(overrides.diagnose ?? {}) },
    storage: { ...defaultSettings.storage, ...(overrides.storage ?? {}) },
    thermal: { ...defaultSettings.thermal, ...(overrides.thermal ?? {}) },
  };
}
