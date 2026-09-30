import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(200),
});

// Express 4 does not catch rejections from async handlers; forward them to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function authRoutes({ db, jwtSecret }) {
  const r = Router();

  r.post('/register', wrap(async (req, res) => {
    const { email, password } = credentials.parse(req.body);
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (exists) return res.status(409).json({ error: 'email_taken' });
    const hash = await bcrypt.hash(password, 10);
    const info = db
      .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
      .run(email, hash, new Date().toISOString());
    res.status(201).json({ id: Number(info.lastInsertRowid), email });
  }));

  r.post('/login', wrap(async (req, res) => {
    const { email, password } = credentials.parse(req.body);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Same response for unknown email and wrong password: don't reveal which accounts exist.
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    const token = jwt.sign({ sub: user.id, email: user.email, admin: !!user.is_admin }, jwtSecret, {
      expiresIn: '12h',
    });
    res.json({ token });
  }));

  return r;
}
