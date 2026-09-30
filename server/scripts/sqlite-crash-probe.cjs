// Minimal probe for the intermittent crash: open node:sqlite the way the app does and exit.
const { DatabaseSync } = require('node:sqlite');
const mode = process.argv[2] || 'wal';
for (let i = 0; i < 20; i++) {
  const db = new DatabaseSync(':memory:');
  if (mode === 'wal') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES (\'x\');');
  db.prepare('SELECT * FROM t').all();
  if (mode !== 'leak') db.close();
}
process.stdout.write('ok');
