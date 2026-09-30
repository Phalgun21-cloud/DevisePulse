// Prints which database the server is configured for and what is stored in it.
//   npm run db:check        (from server/)
import 'dotenv/config';
import { openDbFromEnv } from '../src/db/index.js';

const db = await openDbFromEnv();
console.log(`database: ${db.dialect}${db.dialect === 'mysql' ? ` (${process.env.DATABASE_URL.replace(/:[^:@/]+@/, ':****@')})` : ''}`);
for (const table of ['users', 'devices', 'samples', 'findings', 'diagnose_requests', 'evaluations']) {
  const row = await db.get(`SELECT COUNT(*) AS n FROM ${table}`);
  console.log(`${table.padEnd(18)} ${row.n}`);
}
const devices = await db.all('SELECT id, name, is_simulated, last_seen FROM devices ORDER BY id');
for (const d of devices) {
  const kinds = await db.all('SELECT kind, COUNT(*) AS n, MAX(ts) AS last FROM samples WHERE device_id = ? GROUP BY kind', d.id);
  const active = await db.get(`SELECT COUNT(*) AS n FROM findings WHERE device_id = ? AND status = 'active'`, d.id);
  console.log(
    `#${d.id} ${d.name} [${d.is_simulated ? 'simulated' : 'real'}] last seen ${d.last_seen ?? 'never'} | ` +
      (kinds.map((k) => `${k.kind}=${k.n}`).join(' ') || 'no samples') +
      ` | active findings ${active.n}`,
  );
}
await db.close();
