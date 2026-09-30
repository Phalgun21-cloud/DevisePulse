import 'dotenv/config';
import { openDb } from './db/index.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4000);
const db = openDb(process.env.DATABASE_FILE ?? './devicepulse.db');
const app = createApp({
  db,
  jwtSecret: process.env.JWT_SECRET,
  corsOrigin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
});

app.listen(port, () => console.log(`DevicePulse API listening on http://localhost:${port}`));
