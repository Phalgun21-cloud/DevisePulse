import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/index.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4000);
const db = openDb(process.env.DATABASE_FILE ?? './devicepulse.db');
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const app = createApp({
  db,
  jwtSecret: process.env.JWT_SECRET,
  corsOrigin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
  webDist,
});

app.listen(port, () => console.log(`DevicePulse listening on http://localhost:${port}`));
