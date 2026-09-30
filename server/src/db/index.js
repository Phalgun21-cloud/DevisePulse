// One async database interface over two engines:
//   SQLite (built-in node:sqlite) for tests and zero-setup local runs,
//   MySQL 8.0 (mysql2) whenever DATABASE_URL=mysql://... is set.
// API: all(sql, ...p) -> rows, get(sql, ...p) -> row|undefined, run(sql, ...p) -> { changes, lastInsertRowid },
//      exec(sql), tx(async (t) => ...) runs on one connection in a transaction, close().
// SQL is written once with `?` placeholders; the few dialect differences are handled here or via `db.dialect`.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SQLITE_SCHEMA = `
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
  vals TEXT NOT NULL,
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
-- When a periodic detector last ran for a device (data time), so minute-level samples do not re-run it.
CREATE TABLE IF NOT EXISTS evaluations (
  device_id INTEGER NOT NULL REFERENCES devices(id),
  detector TEXT NOT NULL,
  last_ts TEXT NOT NULL,
  PRIMARY KEY (device_id, detector)
);
`;

// MySQL 8.0. Timestamps stay ISO-8601 strings (same ordering and comparisons as SQLite).
// utf8mb4_bin: exact, case-sensitive comparisons for tokens and timestamps.
const MYSQL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    is_admin TINYINT NOT NULL DEFAULT 0,
    created_at VARCHAR(40) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(80) NOT NULL,
    model VARCHAR(120), os VARCHAR(120), bios VARCHAR(120),
    token_hash CHAR(64) NOT NULL UNIQUE,
    last_seen VARCHAR(40),
    is_simulated TINYINT NOT NULL DEFAULT 0,
    created_at VARCHAR(40) NOT NULL,
    INDEX idx_devices_user (user_id),
    CONSTRAINT fk_devices_user FOREIGN KEY (user_id) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS samples (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    device_id INT NOT NULL,
    ts VARCHAR(40) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    vals TEXT NOT NULL,
    UNIQUE KEY uq_samples (device_id, ts, kind),
    INDEX idx_samples_device_kind_ts (device_id, kind, ts),
    CONSTRAINT fk_samples_device FOREIGN KEY (device_id) REFERENCES devices(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS findings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    device_id INT NOT NULL,
    rule VARCHAR(40) NOT NULL,
    component VARCHAR(20) NOT NULL,
    severity VARCHAR(16) NOT NULL,
    title VARCHAR(200) NOT NULL,
    evidence MEDIUMTEXT NOT NULL,
    explanation TEXT NOT NULL,
    status VARCHAR(10) NOT NULL,
    detect_count INT NOT NULL DEFAULT 1,
    clear_count INT NOT NULL DEFAULT 0,
    first_seen VARCHAR(40) NOT NULL,
    last_seen VARCHAR(40) NOT NULL,
    INDEX idx_findings_device (device_id, status),
    CONSTRAINT fk_findings_device FOREIGN KEY (device_id) REFERENCES devices(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS diagnose_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    device_id INT NOT NULL,
    status VARCHAR(10) NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    claimed_at VARCHAR(40), completed_at VARCHAR(40),
    sample TEXT, result MEDIUMTEXT,
    INDEX idx_diagnose_device (device_id, status),
    CONSTRAINT fk_diagnose_device FOREIGN KEY (device_id) REFERENCES devices(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS evaluations (
    device_id INT NOT NULL,
    detector VARCHAR(20) NOT NULL,
    last_ts VARCHAR(40) NOT NULL,
    PRIMARY KEY (device_id, detector),
    CONSTRAINT fk_evaluations_device FOREIGN KEY (device_id) REFERENCES devices(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

// ---- SQLite ------------------------------------------------------------------------------

function openSqlite(file) {
  // Loaded via require so Vitest/Vite (which does not yet know node:sqlite) can run the tests.
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  // Older local databases used a column named "values" (a reserved word in MySQL): rename it once.
  const table = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'samples'`).get();
  if (table && raw.prepare(`SELECT 1 AS x FROM pragma_table_info('samples') WHERE name = 'values'`).get()) {
    raw.exec('ALTER TABLE samples RENAME COLUMN "values" TO vals');
  }
  raw.exec(SQLITE_SCHEMA);

  const api = {
    dialect: 'sqlite',
    raw,
    prepare: (sql) => raw.prepare(sql), // synchronous access, used by tests only
    async all(sql, ...params) {
      return raw.prepare(sql).all(...params);
    },
    async get(sql, ...params) {
      return raw.prepare(sql).get(...params);
    },
    async run(sql, ...params) {
      const info = raw.prepare(sql).run(...params);
      return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
    },
    async exec(sql) {
      raw.exec(sql);
    },
    async tx(fn) {
      raw.exec('BEGIN');
      try {
        const out = await fn(api);
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    async close() {
      raw.close();
    },
  };
  return api;
}

// ---- MySQL -------------------------------------------------------------------------------

const toMysql = (sql) => sql.replace(/INSERT OR IGNORE/gi, 'INSERT IGNORE');

function wrapMysql(conn, pool) {
  const q = async (sql, params) => (await conn.query(toMysql(sql), params))[0];
  const api = {
    dialect: 'mysql',
    async all(sql, ...params) {
      return q(sql, params);
    },
    async get(sql, ...params) {
      return (await q(sql, params))[0];
    },
    async run(sql, ...params) {
      const r = await q(sql, params);
      return { changes: r.affectedRows, lastInsertRowid: r.insertId };
    },
    async exec(sql) {
      await conn.query(sql);
    },
    async tx(fn) {
      if (!pool) return fn(api); // already inside a transaction
      const c = await pool.getConnection();
      try {
        await c.beginTransaction();
        const out = await fn(wrapMysql(c, null));
        await c.commit();
        return out;
      } catch (err) {
        await c.rollback();
        throw err;
      } finally {
        c.release();
      }
    },
    async close() {
      if (pool) await pool.end();
    },
  };
  return api;
}

async function openMysql(url) {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({ uri: url, connectionLimit: 10, dateStrings: true, supportBigNumbers: false });
  for (const stmt of MYSQL_SCHEMA) await pool.query(stmt);
  return wrapMysql(pool, pool);
}

// openDb(':memory:' | 'file.db') -> SQLite (sync open, async API). openDbFromEnv() picks MySQL when configured.
export function openDb(file = ':memory:') {
  return openSqlite(file);
}

export async function openDbFromEnv(env = process.env) {
  if (env.DATABASE_URL && /^mysql:\/\//.test(env.DATABASE_URL)) return openMysql(env.DATABASE_URL);
  return openSqlite(env.DATABASE_FILE ?? './devicepulse.db');
}
