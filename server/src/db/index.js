// SQLite via Node's built-in node:sqlite (no native build step; works on Windows, Node >= 22.13).
import { createRequire } from 'node:module';

// Loaded via require so Vitest/Vite (which does not yet know node:sqlite) can run the tests.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  model TEXT,
  os TEXT,
  bios TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  last_seen TEXT,
  is_simulated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  "values" TEXT NOT NULL,
  UNIQUE (device_id, ts, kind)
);
CREATE INDEX IF NOT EXISTS idx_samples_device_kind_ts ON samples (device_id, kind, ts);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  rule TEXT NOT NULL,
  component TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  evidence TEXT NOT NULL,
  explanation TEXT NOT NULL,
  status TEXT NOT NULL,            -- pending | active | cleared
  detect_count INTEGER NOT NULL DEFAULT 1,
  clear_count INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_device ON findings (device_id, status);

CREATE TABLE IF NOT EXISTS diagnose_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  status TEXT NOT NULL,            -- pending | running | done | expired
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  sample TEXT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS idx_diagnose_device ON diagnose_requests (device_id, status);
`;

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
