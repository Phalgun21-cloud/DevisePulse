import { Router } from 'express';
import { z } from 'zod';
import { hashToken, newDeviceToken } from '../middleware/auth.js';

const createDevice = z.object({
  name: z.string().trim().min(1).max(80),
  model: z.string().trim().max(120).optional(),
  os: z.string().trim().max(120).optional(),
  bios: z.string().trim().max(120).optional(),
});

const severityRank = { Watch: 1, Attention: 2, Urgent: 3 };

const publicDevice = (d) => ({
  id: d.id,
  name: d.name,
  model: d.model,
  os: d.os,
  bios: d.bios,
  lastSeen: d.last_seen,
  isSimulated: !!d.is_simulated,
});

const publicFinding = (f) => ({
  id: f.id,
  rule: f.rule,
  component: f.component,
  severity: f.severity,
  title: f.title,
  explanation: f.explanation,
  evidence: JSON.parse(f.evidence),
  status: f.status,
  firstSeen: f.first_seen,
  lastSeen: f.last_seen,
});

export function deviceRoutes({ db }) {
  const r = Router();

  // A user may only ever touch their own devices. Unknown and foreign ids both give 404,
  // so ids of other users' devices are not revealed.
  function ownDevice(req, res) {
    const id = Number(req.params.id);
    const device = Number.isInteger(id)
      ? db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(id, req.user.id)
      : undefined;
    if (!device) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    return device;
  }

  r.post('/', (req, res) => {
    const body = createDevice.parse(req.body);
    const token = newDeviceToken();
    const info = db
      .prepare(
        `INSERT INTO devices (user_id, name, model, os, bios, token_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(req.user.id, body.name, body.model ?? null, body.os ?? null, body.bios ?? null, hashToken(token), new Date().toISOString());
    // The token is shown once and never stored in plain text.
    res.status(201).json({ id: Number(info.lastInsertRowid), name: body.name, deviceToken: token });
  });

  r.get('/', (req, res) => {
    const devices = db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY id').all(req.user.id);
    const out = devices.map((d) => {
      const active = db
        .prepare(`SELECT severity FROM findings WHERE device_id = ? AND status = 'active'`)
        .all(d.id);
      const worst = active.reduce((w, f) => ((severityRank[f.severity] ?? 0) > (severityRank[w] ?? 0) ? f.severity : w), 'Normal');
      return { ...publicDevice(d), worstSeverity: worst };
    });
    res.json({ devices: out });
  });

  r.get('/:id/findings', (req, res) => {
    const device = ownDevice(req, res);
    if (!device) return;
    const all = req.query.status === 'all';
    const rows = db
      .prepare(
        `SELECT * FROM findings WHERE device_id = ? ${all ? '' : `AND status = 'active'`} ORDER BY last_seen DESC`,
      )
      .all(device.id);
    res.json({ findings: rows.map(publicFinding) });
  });

  r.get('/:id/samples', (req, res) => {
    const device = ownDevice(req, res);
    if (!device) return;
    const kind = z.enum(['battery', 'storage', 'cpu', 'probe']).parse(req.query.kind);
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const rows = db
      .prepare(`SELECT ts, "values" AS v FROM samples WHERE device_id = ? AND kind = ? ORDER BY ts DESC LIMIT ?`)
      .all(device.id, kind, limit);
    res.json({ samples: rows.reverse().map((s) => ({ ts: s.ts, values: JSON.parse(s.v) })) });
  });

  return r;
}
