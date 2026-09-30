import { Router } from 'express';
import { z } from 'zod';
import { evaluateBattery } from '../evaluate.js';

const scalar = z.union([z.number(), z.string().max(200), z.boolean(), z.null()]);
const DAY_MS = 86_400_000;

const sample = z
  .object({
    ts: z.string().datetime(),
    kind: z.enum(['battery', 'storage', 'cpu', 'probe']),
    values: z.record(z.string().max(60), scalar),
  })
  .superRefine((s, ctx) => {
    if (s.kind === 'battery') {
      const { designWh, fullChargeWh } = s.values;
      const good = (n) => typeof n === 'number' && n > 0 && n < 1000;
      if (!good(designWh) || !good(fullChargeWh)) {
        ctx.addIssue({ code: 'custom', message: 'battery needs positive designWh and fullChargeWh' });
      }
    }
  });

const body = z.object({ samples: z.array(sample).min(1).max(200) });

export function ingestRoutes({ db, settings, now }) {
  const r = Router();

  r.post('/', (req, res) => {
    const { samples } = body.parse(req.body);
    const clock = now();

    // Reject timestamps from the far future (broken clock) instead of storing them.
    const limit = clock.getTime() + DAY_MS;
    if (samples.some((s) => Date.parse(s.ts) > limit)) {
      return res.status(400).json({ error: 'timestamp_in_future' });
    }

    const insert = db.prepare(
      'INSERT OR IGNORE INTO samples (device_id, ts, kind, "values") VALUES (?, ?, ?, ?)',
    );
    let stored = 0;
    let newBattery = 0;
    db.exec('BEGIN');
    try {
      for (const s of samples) {
        const info = insert.run(req.device.id, s.ts, s.kind, JSON.stringify(s.values));
        if (info.changes > 0) {
          stored += 1;
          if (s.kind === 'battery') newBattery += 1;
        }
      }
      db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(clock.toISOString(), req.device.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    // Trend detectors run only when a new battery reading arrived, so "two consecutive
    // detections" means two battery readings apart, not two one-minute CPU samples.
    if (newBattery > 0) evaluateBattery(db, req.device.id, settings, clock);

    res.json({ received: samples.length, stored, duplicates: samples.length - stored });
  });

  return r;
}
