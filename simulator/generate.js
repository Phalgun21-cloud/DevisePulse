// Seeded synthetic telemetry. Fixed seeds make every test run identical.
// Used by the scenario tests now and by the demo replay later.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Roughly normal noise (sum of uniforms), mean 0, sd ~ 1.
function gauss(rand) {
  return (rand() + rand() + rand() + rand() - 2) / 0.5774;
}

const DAY_MS = 86_400_000;

/**
 * Build battery samples.
 * healthAt(dayIndex) -> true health percent for that day.
 * Returns [{ ts, fullChargeWh, designWh }] with measurement noise added.
 */
export function batterySeries({
  startIso = '2026-01-01T12:00:00Z',
  days,
  designWh = 60,
  healthAt,
  samplesPerDay = 1,
  noisePct = 0.15,
  seed = 1,
}) {
  const rand = mulberry32(seed);
  const start = Date.parse(startIso);
  const out = [];
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < samplesPerDay; k++) {
      const health = healthAt(d) + gauss(rand) * noisePct;
      const ts = new Date(start + d * DAY_MS + k * 3_600_000).toISOString();
      out.push({ ts, designWh, fullChargeWh: round2((health / 100) * designWh) });
    }
  }
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;

// ---- named scenarios (mirror the testing plan's scenario table) ----------------------

export const scenarios = {
  healthy: (seed = 11) =>
    batterySeries({ days: 30, healthAt: () => 99.5, seed }),

  slowDecline: (seed = 12) =>
    // 100% -> 80% over 180 days (indexes 0..180); true 70% crossing is day 270.
    batterySeries({ days: 181, healthAt: (d) => 100 - (20 * d) / 180, seed }),

  accelerating: (seed = 13) =>
    // 0.06 %/day for 150 days, then 0.15 %/day for the last 30 days (2.5x).
    batterySeries({
      days: 181,
      healthAt: (d) => (d <= 150 ? 100 - 0.06 * d : 100 - 0.06 * 150 - 0.15 * (d - 150)),
      seed,
    }),

  littleData: (seed = 14) =>
    // 3 readings over 4 days.
    batterySeries({ days: 5, healthAt: (d) => 99 - d * 0.1, seed }).filter((_, i) => [0, 2, 4].includes(i)),
};

// ---- storage ------------------------------------------------------------------------

const HEALTHY_NVME = {
  smartPassed: true,
  criticalWarning: 0,
  availableSparePct: 100,
  availableSpareThresholdPct: 10,
  percentageUsed: 12,
  mediaErrors: 0,
  reallocatedSectors: null,
  pendingSectors: null,
};

const NO_SMART = {
  smartPassed: null,
  criticalWarning: null,
  availableSparePct: null,
  availableSpareThresholdPct: null,
  percentageUsed: null,
  mediaErrors: null,
  reallocatedSectors: null,
  pendingSectors: null,
};

/**
 * Build storage samples like the agent sends (default every 15 minutes).
 * probeMsAt(t), freeAt(t), smartAt(t): t is the fractional day index.
 * Returns flat objects [{ ts, ioProbeMs, freeSpacePct, ...smart }] with noise on the probe time.
 */
export function storageSeries({
  startIso = '2026-01-01T00:00:00Z',
  days,
  samplesPerDay = 96,
  probeMsAt = () => 40,
  freeAt = () => 40,
  smartAt = () => HEALTHY_NVME,
  noise = 0.1,
  seed = 21,
}) {
  const rand = mulberry32(seed);
  const start = Date.parse(startIso);
  const out = [];
  for (let i = 0; i < days * samplesPerDay; i++) {
    const t = i / samplesPerDay;
    const ms = probeMsAt(t);
    out.push({
      ts: new Date(start + t * DAY_MS).toISOString(),
      ioProbeMs: ms === null ? null : Math.max(1, round2(ms * (1 + gauss(rand) * noise))),
      freeSpacePct: freeAt(t),
      ...smartAt(t),
    });
  }
  return out;
}

export const storageScenarios = {
  healthy: (seed = 31) => storageSeries({ days: 30, seed }),

  nvmeWear85: (seed = 32) =>
    storageSeries({ days: 10, smartAt: () => ({ ...HEALTHY_NVME, percentageUsed: 85 }), seed }),

  nvmeCriticalWarning: (seed = 33) =>
    storageSeries({ days: 10, smartAt: (t) => ({ ...HEALTHY_NVME, criticalWarning: t >= 9 ? 4 : 0 }), seed }),

  spareAtThreshold: (seed = 34) =>
    storageSeries({ days: 10, smartAt: () => ({ ...HEALTHY_NVME, availableSparePct: 10 }), seed }),

  // 0 errors in week 1, 2 in week 2, 6 in week 3: rising week over week.
  mediaErrorsRising: (seed = 35) =>
    storageSeries({
      days: 21,
      smartAt: (t) => ({ ...HEALTHY_NVME, mediaErrors: t < 7 ? 0 : t < 14 ? 2 : 6 }),
      seed,
    }),

  // One jump then flat: a single weekly increase.
  mediaErrorsOnce: (seed = 36) =>
    storageSeries({ days: 21, smartAt: (t) => ({ ...HEALTHY_NVME, mediaErrors: t < 15 ? 0 : 3 }), seed }),

  // 40 ms for 7 days, then 4x (160 ms) from day 7 on. No SMART on this device.
  slowPersistent: (seed = 37) =>
    storageSeries({ days: 10, probeMsAt: (t) => (t < 7 ? 40 : 160), smartAt: () => NO_SMART, seed }),

  // Same, but free space also drops below 5%: two signals move together.
  slowAndFull: (seed = 38) =>
    storageSeries({
      days: 10,
      probeMsAt: (t) => (t < 7 ? 40 : 160),
      freeAt: (t) => (t < 7 ? 20 : 4),
      smartAt: () => NO_SMART,
      seed,
    }),

  // 10x slower for one hour on day 8, normal otherwise.
  oneHourSpike: (seed = 39) =>
    storageSeries({ days: 10, probeMsAt: (t) => (t >= 8.1 && t < 8.1 + 1 / 24 ? 400 : 40), smartAt: () => NO_SMART, seed }),

  freeSpace: (pct, seed = 40) => storageSeries({ days: 4, freeAt: () => pct, seed }),

  // No SMART and the probe could not be timed (nulls): nothing may crash or be invented.
  allMissing: (seed = 41) =>
    storageSeries({ days: 4, probeMsAt: () => null, freeAt: () => null, smartAt: () => NO_SMART, seed }),

  sataPending: (seed = 42) =>
    storageSeries({
      days: 10,
      smartAt: () => ({ ...NO_SMART, smartPassed: true, reallocatedSectors: 0, pendingSectors: 8 }),
      seed,
    }),
};
