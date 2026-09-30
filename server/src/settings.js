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
};

export function withOverrides(overrides = {}) {
  return {
    ...defaultSettings,
    findings: { ...defaultSettings.findings, ...(overrides.findings ?? {}) },
    battery: { ...defaultSettings.battery, ...(overrides.battery ?? {}) },
  };
}
