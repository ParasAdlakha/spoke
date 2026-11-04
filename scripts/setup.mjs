// One-time wiring after `supabase db push` and `supabase functions deploy`:
// stores the project URL and the pg_cron shared secret in Supabase Vault, so
// the cron jobs can call the `ingest` edge function. Idempotent.
//
//   SPOKE_CRON_SECRET must match the edge-function secret of the same name
//   (`npx supabase secrets set SPOKE_CRON_SECRET=...`).
import { loadEnv, withDb } from './db.mjs';

loadEnv();
const ref = process.env.SUPABASE_PROJECT_REF;
const secret = process.env.SPOKE_CRON_SECRET;
if (!ref || !secret) {
  console.error('Set SUPABASE_PROJECT_REF and SPOKE_CRON_SECRET in .env first.');
  process.exit(1);
}

await withDb(async (db) => {
  const put = async (name, value) => {
    const { rows } = await db.query('select id from vault.secrets where name = $1', [name]);
    if (rows.length) await db.query('select vault.update_secret($1, $2)', [rows[0].id, value]);
    else await db.query('select vault.create_secret($1, $2)', [value, name]);
  };
  await put('spoke_project_url', `https://${ref}.supabase.co`);
  await put('spoke_cron_secret', secret);
  const jobs = await db.query("select jobname, schedule, active from cron.job where jobname like 'spoke-%' order by jobname");
  console.table(jobs.rows);
  // Kick the first ingest now instead of waiting for the next minute.
  await db.query("select public.call_ingest('status')");
  console.log('Vault secrets set; first ingest requested. Check: npm run sql -- "select * from ingest_runs order by id desc limit 5"');
});
