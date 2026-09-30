import { describe, it, expect } from 'vitest';
import { detectStorage } from '../src/detectors/storage.js';
import { evaluateStorage } from '../src/evaluate.js';
import { explainFinding } from '../src/explain/templates.js';
import { defaultSettings } from '../src/settings.js';
import { openDb } from '../src/db/index.js';
import { storageScenarios } from '../../simulator/generate.js';

const DAY_MS = 86_400_000;
const START = Date.parse('2026-01-01T00:00:00Z');
const at = (days) => new Date(START + days * DAY_MS);
const upTo = (samples, when) => samples.filter((s) => Date.parse(s.ts) <= when.getTime());
const lastTs = (samples) => new Date(samples[samples.length - 1].ts);
const run = (samples, when = lastTs(samples)) => detectStorage(upTo(samples, when), defaultSettings, when);
const byRule = (r, rule) => r.findings.find((f) => f.rule === rule);
const worst = (r) => {
  const rank = { Information: 0, Watch: 1, Attention: 2, Urgent: 3 };
  return r.findings.reduce((w, f) => (rank[f.severity] > (rank[w] ?? -1) ? f.severity : w), null);
};

describe('scenario: healthy storage', () => {
  it('raises nothing above Information over 30 days', () => {
    const s = storageScenarios.healthy();
    for (let d = 4; d <= 30; d += 2) {
      const r = run(s, at(d));
      expect(['Watch', 'Attention', 'Urgent']).not.toContain(worst(r));
    }
  });
});

describe('scenario: NVMe wear 85% used', () => {
  it('is Attention, not Urgent', () => {
    const f = byRule(run(storageScenarios.nvmeWear85()), 'storage_wear');
    expect(f.severity).toBe('Attention');
    expect(f.evidence.percentageUsed).toBe(85);
  });
});

describe('scenario: NVMe critical warning or spare at threshold', () => {
  it('critical warning is Urgent', () => {
    const r = run(storageScenarios.nvmeCriticalWarning());
    expect(byRule(r, 'storage_smart_critical').severity).toBe('Urgent');
  });

  it('available spare at its threshold is Urgent', () => {
    const f = byRule(run(storageScenarios.spareAtThreshold()), 'storage_smart_critical');
    expect(f.severity).toBe('Urgent');
    expect(f.evidence).toMatchObject({ availableSparePct: 10, availableSpareThresholdPct: 10 });
  });

  it('Urgent explanation says to back up now', () => {
    const f = byRule(run(storageScenarios.nvmeCriticalWarning()), 'storage_smart_critical');
    expect(explainFinding(f)).toMatch(/back up/i);
  });
});

describe('scenario: media errors', () => {
  it('rising week over week is Attention', () => {
    const f = byRule(run(storageScenarios.mediaErrorsRising()), 'storage_errors');
    expect(f.severity).toBe('Attention');
    expect(f.evidence).toMatchObject({ errorsNow: 6, errorsWeekAgo: 2, errorsTwoWeeksAgo: 0 });
  });

  it('a single weekly increase is Watch', () => {
    expect(byRule(run(storageScenarios.mediaErrorsOnce()), 'storage_errors').severity).toBe('Watch');
  });

  it('SATA pending sectors are Attention', () => {
    expect(byRule(run(storageScenarios.sataPending()), 'storage_errors').severity).toBe('Attention');
  });
});

describe('scenario: slow disk, persistent (4x baseline from day 7)', () => {
  const s = storageScenarios.slowPersistent();

  it('Watch by the end of the first slow day', () => {
    const f = byRule(run(s, at(8)), 'storage_slow');
    expect(f.severity).toBe('Watch');
    expect(f.evidence.ratio).toBeGreaterThanOrEqual(3);
  });

  it('still only Watch after 3 days when it is the only signal (decision 2026-09-30, rule 3)', () => {
    const r = run(s, at(10));
    expect(byRule(r, 'storage_slow').severity).toBe('Watch');
    expect(['Attention', 'Urgent']).not.toContain(worst(r));
  });

  it('Attention when free space below 5% moves with it', () => {
    const r = run(storageScenarios.slowAndFull(), at(10));
    expect(byRule(r, 'storage_slow').severity).toBe('Attention');
    expect(worst(r)).not.toBe('Urgent');
  });

  it('no slow-disk verdict before the 3-day baseline exists', () => {
    const r = run(s, at(2));
    expect(byRule(r, 'storage_slow')).toBeUndefined();
    expect(r.status.probe).toBe('collecting_baseline');
  });
});

describe('scenario: slow disk, one-hour spike', () => {
  it('no finding at any point, including right after the spike', () => {
    const s = storageScenarios.oneHourSpike();
    for (const d of [8.15, 8.2, 8.5, 9, 10]) {
      expect(byRule(run(s, at(d)), 'storage_slow')).toBeUndefined();
    }
  });

  it('no active finding through the real lifecycle either', async () => {
    const db = openDb(':memory:');
    const deviceId = seedDevice(db);
    await replay(db, deviceId, storageScenarios.oneHourSpike());
    expect(db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE status = 'active'`).get().n).toBe(0);
  });
});

describe('scenario: free space', () => {
  it('below 10% is Information', () => {
    expect(byRule(run(storageScenarios.freeSpace(8)), 'storage_free_space').severity).toBe('Information');
  });
  it('below 5% is Watch', () => {
    expect(byRule(run(storageScenarios.freeSpace(4)), 'storage_free_space').severity).toBe('Watch');
  });
  it('20% free is nothing', () => {
    expect(byRule(run(storageScenarios.freeSpace(20)), 'storage_free_space')).toBeUndefined();
  });
});

describe('scenario: missing sensors', () => {
  it('no SMART: SMART rules skip, the probe rule still runs', () => {
    const r = run(storageScenarios.slowPersistent(), at(8));
    expect(r.skippedRules).toEqual(expect.arrayContaining(['storage_smart_critical', 'storage_wear', 'storage_errors']));
    expect(byRule(r, 'storage_slow')).toBeDefined();
  });

  it('everything null: no crash, no finding, nothing treated as zero', () => {
    const r = run(storageScenarios.allMissing());
    expect(r.findings).toEqual([]);
    expect(r.skippedRules).toEqual(
      expect.arrayContaining(['storage_smart_critical', 'storage_wear', 'storage_errors', 'storage_slow', 'storage_free_space']),
    );
  });

  it('no samples at all: no crash', () => {
    expect(detectStorage([], defaultSettings, at(1)).findings).toEqual([]);
  });

  it('a probe time of 0 is ignored, never used as a reading', () => {
    const s = storageScenarios.slowPersistent().map((x, i) => (i % 2 ? { ...x, ioProbeMs: 0 } : x));
    const f = byRule(run(s, at(8)), 'storage_slow');
    expect(f.evidence.baselineMs).toBeGreaterThan(30);
  });

  it('thresholds come from settings', () => {
    const s = { ...defaultSettings, storage: { ...defaultSettings.storage, wearAttentionPct: 90 } };
    const r = detectStorage(storageScenarios.nvmeWear85(), s, lastTs(storageScenarios.nvmeWear85()));
    expect(byRule(r, 'storage_wear')).toBeUndefined();
  });
});

describe('storage explanations', () => {
  const banned = [/will fail/i, /going to fail/i, /\bdie\b/i, /guarantee/i, /\bon \d{4}-\d{2}-\d{2}/, /definitely/i];
  const cases = {
    wear: byRule(run(storageScenarios.nvmeWear85()), 'storage_wear'),
    critical: byRule(run(storageScenarios.nvmeCriticalWarning()), 'storage_smart_critical'),
    errors: byRule(run(storageScenarios.mediaErrorsRising()), 'storage_errors'),
    slow: byRule(run(storageScenarios.slowPersistent(), at(8)), 'storage_slow'),
    slowFull: byRule(run(storageScenarios.slowAndFull(), at(10)), 'storage_slow'),
    free: byRule(run(storageScenarios.freeSpace(4)), 'storage_free_space'),
  };

  for (const [name, f] of Object.entries(cases)) {
    it(`${name}: hedged, specific, no banned phrases`, () => {
      const text = explainFinding(f);
      expect(text).not.toBe(f.title); // a real template, not the fallback
      for (const b of banned) expect(text).not.toMatch(b);
    });
  }

  it('slow disk says "slower than usual" and gives both numbers', () => {
    const text = explainFinding(cases.slow);
    expect(text).toMatch(/slower than usual/i);
    expect(text).toContain(`${cases.slow.evidence.baselineMs} ms`);
    expect(text).toContain(`${cases.slow.evidence.recentMedianMs} ms`);
  });
});

// ---- lifecycle ------------------------------------------------------------------------

function seedDevice(db) {
  db.prepare(`INSERT INTO users (email, password_hash, created_at) VALUES ('s@example.com', 'x', '2026-01-01')`).run();
  return Number(
    db
      .prepare(`INSERT INTO devices (user_id, name, token_hash, created_at) VALUES (1, 'disk', 'h', '2026-01-01')`)
      .run().lastInsertRowid,
  );
}

// Insert each sample and evaluate, the way ingest does when a new storage reading arrives.
async function replay(db, deviceId, samples, until = Infinity) {
  const insert = db.prepare(`INSERT INTO samples (device_id, ts, kind, vals) VALUES (?, ?, 'storage', ?)`);
  for (const { ts, ...values } of samples) {
    if (Date.parse(ts) > until) break;
    insert.run(deviceId, ts, JSON.stringify(values));
    await evaluateStorage(db, deviceId, defaultSettings, new Date(ts));
  }
}

describe('storage lifecycle (2 detections to show, 3 normal to clear)', () => {
  it('persistent slow disk becomes active Watch on day 1 of the slowdown, never above Watch', async () => {
    const db = openDb(':memory:');
    const id = seedDevice(db);
    await replay(db, id, storageScenarios.slowPersistent());
    const rows = db.prepare(`SELECT * FROM findings WHERE rule = 'storage_slow'`).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(rows[0].severity).toBe('Watch');
    expect(Date.parse(rows[0].first_seen)).toBeLessThan(at(8).getTime());
  });

  it('a skipped rule (SMART went missing) does not clear an active SMART finding', async () => {
    const db = openDb(':memory:');
    const id = seedDevice(db);
    const wear = storageScenarios.nvmeWear85();
    await replay(db, id, wear.slice(0, 10));
    expect(db.prepare(`SELECT status FROM findings WHERE rule = 'storage_wear'`).get().status).toBe('active');
    const later = wear.slice(10, 20).map((s) => ({ ...s, percentageUsed: null, criticalWarning: null }));
    await replay(db, id, later);
    expect(db.prepare(`SELECT status FROM findings WHERE rule = 'storage_wear'`).get().status).toBe('active');
  });

  it('clears after 3 normal checks', async () => {
    const db = openDb(':memory:');
    const id = seedDevice(db);
    const s = storageScenarios.freeSpace(4);
    await replay(db, id, s.slice(0, 5));
    expect(db.prepare(`SELECT status FROM findings WHERE rule = 'storage_free_space'`).get().status).toBe('active');
    await replay(db, id, s.slice(5, 8).map((x) => ({ ...x, freeSpacePct: 30 })));
    expect(db.prepare(`SELECT status FROM findings WHERE rule = 'storage_free_space'`).get().status).toBe('cleared');
  });
});
