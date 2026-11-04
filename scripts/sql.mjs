// Run one SQL statement against the linked project and print the rows.
//   npm run sql -- "select * from ingest_runs order by id desc limit 5"
import { withDb } from './db.mjs';

const sql = process.argv.slice(2).join(' ');
if (!sql) { console.error('usage: npm run sql -- "<sql>"'); process.exit(1); }
await withDb(async (db) => {
  const res = await db.query(sql);
  const rows = Array.isArray(res) ? res.at(-1).rows : res.rows;
  if (rows?.length) console.table(rows);
  else console.log(`${res.command ?? 'ok'} ${res.rowCount ?? ''}`);
});
