// Shared Postgres connection for the scripts. Uses the pooler URL that
// `supabase link` writes to supabase/.temp/pooler-url, plus the DB password.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export function loadEnv(file = '.env') {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function connectionString() {
  loadEnv();
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  const pw = process.env.SUPABASE_DB_PASSWORD;
  const poolerFile = path.join('supabase', '.temp', 'pooler-url');
  if (!pw || !fs.existsSync(poolerFile)) {
    throw new Error('Set SUPABASE_DB_URL, or SUPABASE_DB_PASSWORD after `npx supabase link`.');
  }
  const u = new URL(fs.readFileSync(poolerFile, 'utf8').trim());
  u.password = encodeURIComponent(pw);
  return u.toString();
}

export async function withDb(fn) {
  const client = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}
