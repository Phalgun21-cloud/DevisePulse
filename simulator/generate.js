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
