import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDbFromEnv } from './db/index.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4000);

// MySQL 8.0 when DATABASE_URL=mysql://user:pass@host:3306/db is set, otherwise a local SQLite file.
let db;
try {
  db = await openDbFromEnv();
} catch (err) {
  console.error(`Could not open the database: ${err.code ?? ''} ${err.message}`);
  console.error('Check DATABASE_URL in server/.env (MySQL running? user and password right?).');
  process.exit(1);
}

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const app = createApp({
  db,
  jwtSecret: process.env.JWT_SECRET,
  corsOrigin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
  webDist,
});

const server = app.listen(port, () => console.log(`DevicePulse listening on http://localhost:${port} (database: ${db.dialect})`));

// Finish in-flight requests and close the database cleanly on Ctrl+C or a host shutdown.
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await db.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
