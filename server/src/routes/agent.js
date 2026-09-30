import { Router } from 'express';
import { z } from 'zod';
import { diagnose } from '../detectors/diagnose.js';
import { explainDiagnosis } from '../explain/templates.js';
import { expireStale, baselineFor } from '../diagnoseRequests.js';
import { wrap } from '../middleware/auth.js';

const DIAGNOSE_SECONDS = 10;

const pct = z.number().min(0).max(100).nullable();
const procs = z
  .array(
    z
      .object({
        name: z.string().trim().min(1).max(80),
        cpuPct: z.number().min(0).max(100),
        memMb: z.number().min(0).max(10_000_000),
        count: z.number().int().min(1).max(10_000).optional(), // processes sharing this name, summed by the agent
      })
      .strict(),
  )
  .max(5);

// Numbers plus process NAMES only. .strict() rejects anything else (e.g. command lines).
export const diagnoseSample = z
  .object({
    cpuPct: pct,
    memUsedPct: pct,
    swapActivityBytes: z.number().min(0).nullable(),
    diskBusyPct: pct,
    diskLatencyMs: z.number().min(0).max(600_000).nullable(),
    cpuFreqRatio: z.number().min(0).max(5).nullable(),
    pluggedIn: z.boolean().nullable().optional(), // on battery, a slower clock is power saving by design
    topProcesses: procs,
  })
  .strict();

export function agentRoutes({ db, settings, now }) {
  const r = Router();

  // The agent polls here every ~15 s. Each pending request is handed out once.
  r.get('/commands', wrap(async (req, res) => {
    const clock = now();
    await expireStale(db, req.device.id, settings, clock);
    await db.run('UPDATE devices SET last_seen = ? WHERE id = ?', clock.toISOString(), req.device.id);
    const pending = await db.all(
      `SELECT id FROM diagnose_requests WHERE device_id = ? AND status = 'pending' ORDER BY id`,
      req.device.id,
    );
    const commands = [];
    for (const p of pending) {
      const claimed = await db.run(
        `UPDATE diagnose_requests SET status = 'running', claimed_at = ? WHERE id = ? AND status = 'pending'`,
        clock.toISOString(),
        p.id,
      );
      if (claimed.changes > 0) commands.push({ id: p.id, type: 'diagnose', durationSec: DIAGNOSE_SECONDS });
    }
    res.json({ commands });
  }));

  r.post('/commands/:id/result', wrap(async (req, res) => {
    const clock = now();
    const id = Number(req.params.id);
    const row = Number.isInteger(id)
      ? await db.get('SELECT * FROM diagnose_requests WHERE id = ? AND device_id = ?', id, req.device.id)
      : undefined;
    if (!row) return res.status(404).json({ error: 'not_found' });
    await expireStale(db, req.device.id, settings, clock);
    const current = await db.get('SELECT status FROM diagnose_requests WHERE id = ?', id);
    if (current.status !== 'running' && current.status !== 'pending') {
      return res.status(409).json({ error: 'already_completed' });
    }

    const { sample } = z.object({ sample: diagnoseSample }).parse(req.body);
    const result = diagnose(sample, settings, await baselineFor(db, req.device.id, settings));
    result.explanation = explainDiagnosis(result);
    await db.run(
      `UPDATE diagnose_requests SET status = 'done', completed_at = ?, sample = ?, result = ? WHERE id = ?`,
      clock.toISOString(),
      JSON.stringify(sample),
      JSON.stringify(result),
      id,
    );
    res.json({ ok: true });
  }));

  return r;
}
