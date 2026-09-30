import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
export const newDeviceToken = () => `dp_${crypto.randomBytes(24).toString('hex')}`;

// Express 4 does not catch rejections from async handlers; forward them to the error handler.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function bearer(req) {
  const h = req.get('authorization') ?? '';
  const m = /^Bearer (.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

// User JWT for the web app.
export function requireUser(jwtSecret) {
  return (req, res, next) => {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'missing_token' });
    try {
      const payload = jwt.verify(token, jwtSecret);
      req.user = { id: payload.sub, email: payload.email, isAdmin: !!payload.admin };
      next();
    } catch {
      res.status(401).json({ error: 'invalid_token' });
    }
  };
}

// Random device token for the agent (stored only as a SHA-256 hash).
export function requireDevice(db) {
  return wrap(async (req, res, next) => {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'missing_token' });
    const device = await db.get('SELECT * FROM devices WHERE token_hash = ?', hashToken(token));
    if (!device) return res.status(401).json({ error: 'invalid_token' });
    req.device = device;
    next();
  });
}
