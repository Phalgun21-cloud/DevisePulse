import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { defaultSettings } from './settings.js';
import { requireUser, requireDevice, wrap } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/devices.js';
import { ingestRoutes } from './routes/ingest.js';
import { agentRoutes } from './routes/agent.js';
import { seedDemo, fleetDemo } from './demo.js';

export function createApp({
  db,
  jwtSecret,
  settings = defaultSettings,
  now = () => new Date(),
  corsOrigin = true,
  ingestLimit = { windowMs: 60_000, limit: 120 },
  webDist = null,
}) {
  if (!jwtSecret || jwtSecret.length < 16) {
    throw new Error('JWT_SECRET must be set to at least 16 characters');
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.use('/api/auth', authRoutes({ db, jwtSecret }));
  app.use('/api/devices', requireUser(jwtSecret), deviceRoutes({ db, settings, now }));

  // Demo data: simulated devices for the signed-in user, and the synthetic fleet view. Always labelled.
  app.post('/api/demo/seed', requireUser(jwtSecret), wrap(async (req, res) => {
    const result = await seedDemo(db, req.user.id, settings, now());
    res.status(result.created.length ? 201 : 200).json(result);
  }));
  app.get('/api/me', requireUser(jwtSecret), (req, res) => res.json({ id: req.user.id, email: req.user.email, database: db.dialect }));
  app.get('/api/fleet/demo', requireUser(jwtSecret), (_req, res) => res.json(fleetDemo(settings)));
  app.use(
    '/api/agent',
    rateLimit({ ...ingestLimit, standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited' } }),
    requireDevice(db),
    agentRoutes({ db, settings, now }),
  );
  app.use(
    '/api/ingest',
    rateLimit({ ...ingestLimit, standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited' } }),
    requireDevice(db),
    ingestRoutes({ db, settings, now }),
  );

  // The built dashboard (web/dist), when present: static files plus the single-page-app fallback.
  if (webDist && fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'invalid_request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err.status === 400 && err.code) return res.status(400).json({ error: err.code });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
