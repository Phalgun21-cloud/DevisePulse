import { Router } from 'express';
import { z } from 'zod';
import { hashToken, newDeviceToken, wrap } from '../middleware/auth.js';
import { expireStale, publicRequest } from '../diagnoseRequests.js';
import { deviceSummary } from '../summary.js';

const createDevice = z.object({
  name: z.string().trim().min(1).max(80),
  model: z.string().trim().max(120).optional(),
  os: z.string().trim().max(120).optional(),
  bios: z.string().trim().max(120).optional(),
  simulated: z.boolean().optional(), // a simulator-fed demo device; everything it shows is labelled Simulated
});

const updateDevice = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    model: z.string().trim().max(120).nullable().optional(),
    bios: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

const severityRank = { Watch: 1, Attention: 2, Urgent: 3 };

const publicDevice = (d) => ({
  id: d.id,
  name: d.name,
  model: d.model,
  os: d.os,
  bios: d.bios,
  lastSeen: d.last_seen,
  isSimulated: !!d.is_simulated,
  createdAt: d.created_at,
});

const publicFinding = (f, device) => ({
  id: f.id,
  data: device.is_simulated ? 'Simulated' : 'Real', // rule 5: never present simulated data as measured
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

export function deviceRoutes({ db, settings, now }) {
  const r = Router();

  // A user may only ever touch their own devices. Unknown and foreign ids both give 404,
  // so ids of other users' devices are not revealed.
  async function ownDevice(req, res) {
    const id = Number(req.params.id);
    const device = Number.isInteger(id)
      ? await db.get('SELECT * FROM devices WHERE id = ? AND user_id = ?', id, req.user.id)
      : undefined;
    if (!device) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    return device;
  }

  r.post('/', wrap(async (req, res) => {
    const body = createDevice.parse(req.body);
    const token = newDeviceToken();
    const info = await db.run(
      `INSERT INTO devices (user_id, name, model, os, bios, token_hash, is_simulated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      req.user.id,
      body.name,
      body.model ?? null,
      body.os ?? null,
      body.bios ?? null,
      hashToken(token),
      body.simulated ? 1 : 0,
      new Date().toISOString(),
    );
    // The token is shown once and never stored in plain text.
    res.status(201).json({ id: Number(info.lastInsertRowid), name: body.name, deviceToken: token });
  }));

  r.get('/', wrap(async (req, res) => {
    const devices = await db.all('SELECT * FROM devices WHERE user_id = ? ORDER BY id', req.user.id);
    const out = [];
    for (const d of devices) {
      const active = await db.all(`SELECT severity FROM findings WHERE device_id = ? AND status = 'active'`, d.id);
      const worst = active.reduce((w, f) => ((severityRank[f.severity] ?? 0) > (severityRank[w] ?? 0) ? f.severity : w), 'Normal');
      out.push({ ...publicDevice(d), worstSeverity: worst, activeFindings: active.length });
    }
    res.json({ devices: out });
  }));

  // Everything the device page needs: current state per component. Forecasts are month ranges only (rule 1).
  r.get('/:id', wrap(async (req, res) => {
    const device = await ownDevice(req, res);
    if (!device) return;
    res.json({ device: publicDevice(device), summary: await deviceSummary(db, device, settings, now()) });
  }));

  r.patch('/:id', wrap(async (req, res) => {
    const device = await ownDevice(req, res);
    if (!device) return;
    const body = updateDevice.parse(req.body);
    await db.run(
      'UPDATE devices SET name = ?, model = ?, bios = ? WHERE id = ?',
      body.name ?? device.name,
      body.model === undefined ? device.model : body.model,
      body.bios === undefined ? device.bios : body.bios,
      device.id,
    );
    res.json({ device: publicDevice(await db.get('SELECT * FROM devices WHERE id = ?', device.id)) });
  }));

  // Removes the device and everything recorded for it. Its agent token stops working immediately.
  r.delete('/:id', wrap(async (req, res) => {
    const device = await ownDevice(req, res);
    if (!device) return;
    await db.tx(async (t) => {
      for (const table of ['samples', 'findings', 'diagnose_requests', 'evaluations']) {
        await t.run(`DELETE FROM ${table} WHERE device_id = ?`, device.id);
      }
      await t.run('DELETE FROM devices WHERE id = ?', device.id);
    });
    res.status(204).end();
  }));

  r.get('/:id/findings', wrap(async (req, res) => {
    const device = await ownDevice(req, res);
    if (!device) return;
    const all = req.query.status === 'all';
    const rows = await db.all(
      `SELECT * FROM findings WHERE device_id = ? ${all ? '' : `AND status = 'active'`} ORDER BY last_seen DESC`,
      device.id,
    );
    res.json({ findings: rows.map((f) => publicFinding(f, device)) });
  }));

  r.get('/:id/samples', wrap(async (req, res) => {
    const device = await ownDevice(req, res);
    if (!device) return;
    const kind = z.enum(['battery', 'storage', 'cpu', 'probe']).parse(req.query.kind);
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const rows = await db.all(
      `SELECT ts, vals AS v FROM samples WHERE device_id = ? AND kind = ? ORDER BY ts DESC LIMIT ?`,
      device.id,
      kind,
      limit,
    );
    res.json({ samples: rows.reverse().map((s) => ({ ts: s.ts, values: JSON.parse(s.v) })) });
  }));

  r.get('/:id/diagnose', wrap(async (req, res) => {
    const device = await ownDevice(req, res);
    if (!device) return;
    await expireStale(db, device.id, settings, now());
    const rows = await db.all('SELECT * FROM diagnose_requests WHERE device_id = ? ORDER BY id DESC LIMIT 10', device.id);
    res.json({ requests: rows.map(publicRequest) });
  }));

  // Ask the agent for a 10 s "why is it slow" sample. One open request per device at a time.
  r.post('/:id/diagnose', wrap(async (req, res) => {
    const device = await ownDevice(req, res);
    if (!device) return;
    const clock = now();
    await expireStale(db, device.id, settings, clock);
    const open = await db.get(
      `SELECT * FROM diagnose_requests WHERE device_id = ? AND status IN ('pending', 'running') ORDER BY id DESC`,
      device.id,
    );
    if (open) return res.status(200).json(publicRequest(open));
    const info = await db.run(
      `INSERT INTO diagnose_requests (device_id, status, created_at) VALUES (?, 'pending', ?)`,
      device.id,
      clock.toISOString(),
    );
    const row = await db.get('SELECT * FROM diagnose_requests WHERE id = ?', Number(info.lastInsertRowid));
    res.status(202).json(publicRequest(row));
  }));

  // The page polls this until status is done (or expired).
  r.get('/:id/diagnose/:reqId', wrap(async (req, res) => {
    const device = await ownDevice(req, res);
    if (!device) return;
    await expireStale(db, device.id, settings, now());
    const reqId = Number(req.params.reqId);
    const row = Number.isInteger(reqId)
      ? await db.get('SELECT * FROM diagnose_requests WHERE id = ? AND device_id = ?', reqId, device.id)
      : undefined;
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(publicRequest(row));
  }));

  return r;
}
