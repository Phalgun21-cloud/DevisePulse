import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { defaultSettings } from './settings.js';
import { requireUser, requireDevice } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/devices.js';
import { ingestRoutes } from './routes/ingest.js';
import { agentRoutes } from './routes/agent.js';

export function createApp({
  db,
  jwtSecret,
  settings = defaultSettings,
  now = () => new Date(),
  corsOrigin = true,
  ingestLimit = { windowMs: 60_000, limit: 120 },
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

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'invalid_request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
