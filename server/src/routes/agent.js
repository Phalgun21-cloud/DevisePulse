import { Router } from 'express';
import { z } from 'zod';
import { diagnose } from '../detectors/diagnose.js';
import { explainDiagnosis } from '../explain/templates.js';
import { expireStale, baselineFor } from '../diagnoseRequests.js';

const DIAGNOSE_SECONDS = 10;

const pct = z.number().min(0).max(100).nullable();
const procs = z
  .array(
    z
      .object({
        name: z.string().trim().min(1).max(80),
        cpuPct: z.number().min(0).max(100),
        memMb: z.number().min(0).max(10_000_000),
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
    topProcesses: procs,
  })
  .strict();

export function agentRoutes({ db, settings, now }) {
  const r = Router();

  // The agent polls here every ~15 s. Each pending request is handed out once.
  r.get('/commands', (req, res) => {
    const clock = now();
    expireStale(db, req.device.id, settings, clock);
    db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(clock.toISOString(), req.device.id);
    const pending = db
      .prepare(`SELECT id FROM diagnose_requests WHERE device_id = ? AND status = 'pending' ORDER BY id`)
      .all(req.device.id);
    const claim = db.prepare(`UPDATE diagnose_requests SET status = 'running', claimed_at = ? WHERE id = ? AND status = 'pending'`);
    const commands = [];
    for (const p of pending) {
      if (claim.run(clock.toISOString(), p.id).changes > 0) {
        commands.push({ id: p.id, type: 'diagnose', durationSec: DIAGNOSE_SECONDS });
      }
    }
    res.json({ commands });
  });

  r.post('/commands/:id/result', (req, res) => {
    const clock = now();
    const id = Number(req.params.id);
    const row = Number.isInteger(id)
      ? db.prepare('SELECT * FROM diagnose_requests WHERE id = ? AND device_id = ?').get(id, req.device.id)
      : undefined;
    if (!row) return res.status(404).json({ error: 'not_found' });
    expireStale(db, req.device.id, settings, clock);
    const current = db.prepare('SELECT status FROM diagnose_requests WHERE id = ?').get(id);
    if (current.status !== 'running' && current.status !== 'pending') {
      return res.status(409).json({ error: 'already_completed' });
    }

    const { sample } = z.object({ sample: diagnoseSample }).parse(req.body);
    const result = diagnose(sample, settings, baselineFor(db, req.device.id, settings));
    result.explanation = explainDiagnosis(result);
    db.prepare(
      `UPDATE diagnose_requests SET status = 'done', completed_at = ?, sample = ?, result = ? WHERE id = ?`,
    ).run(clock.toISOString(), JSON.stringify(sample), JSON.stringify(result), id);
    res.json({ ok: true });
  });

  return r;
}
