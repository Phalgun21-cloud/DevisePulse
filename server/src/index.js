import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDbFromEnv } from './db/index.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4000);
// MySQL 8.0 when DATABASE_URL=mysql://user:pass@host:3306/db is set, otherwise a local SQLite file.
const db = await openDbFromEnv();
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const app = createApp({
  db,
  jwtSecret: process.env.JWT_SECRET,
  corsOrigin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
  webDist,
});

app.listen(port, () => console.log(`DevicePulse listening on http://localhost:${port} (database: ${db.dialect})`));
