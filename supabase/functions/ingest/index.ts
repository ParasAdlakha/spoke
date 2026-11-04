// Edge function: ingest the Citi Bike GBFS feed.
//   POST /functions/v1/ingest?job=status    every minute (pg_cron)
//   POST /functions/v1/ingest?job=stations  hourly (pg_cron), and on first run
// Called only by pg_cron with the shared secret in `x-spoke-cron`.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { runStatus, validateStations, validateStatus } from '../_shared/validate.ts';

const GBFS = 'https://gbfs.lyft.com/gbfs/2.3/bkn/en';
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

async function feed(name: string): Promise<{ last_updated: number; data: any }> {
  const res = await fetch(`${GBFS}/${name}.json`, { headers: { 'User-Agent': 'spoke-hackathon/1.0' } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return await res.json();
}

async function logFailure(job: string, started: string, note: string) {
  await db.from('ingest_runs').insert({
    job, status: 'failed', started_at: started, finished_at: new Date().toISOString(), note: note.slice(0, 500),
  });
}

async function ingestStations(started: string) {
  const f = await feed('station_information');
  const list = f.data?.stations ?? [];
  const { rows, rejects } = validateStations(list);
  const nowS = Date.now() / 1000;
  const run = { ...runStatus(list.length, rejects.length, nowS - f.last_updated), started_at: started,
    feed_updated_at: new Date(f.last_updated * 1000).toISOString(), rows_in: list.length };
  const { data, error } = await db.rpc('apply_stations', { p_rows: rows, p_rejects: rejects, p_run: run });
  if (error) throw new Error(`apply_stations: ${error.message}`);
  return { run_id: data, rows_in: list.length, valid: rows.length, rejected: rejects.length, status: run.status };
}

async function ingestStatus(started: string) {
  let { data: caps, error } = await db.rpc('station_capacities');
  if (error) throw new Error(`station_capacities: ${error.message}`);
  if (!caps || Object.keys(caps).length === 0) {
    await ingestStations(started); // first run: the station list must exist first
    ({ data: caps } = await db.rpc('station_capacities'));
  }
  const f = await feed('station_status');
  const list = f.data?.stations ?? [];
  const nowS = Date.now() / 1000;
  const { rows, rejects } = validateStatus(list, caps ?? {}, nowS);
  const run = { ...runStatus(list.length, rejects.length, nowS - f.last_updated), started_at: started,
    feed_updated_at: new Date(f.last_updated * 1000).toISOString(), rows_in: list.length };
  const { data, error: e2 } = await db.rpc('apply_status', { p_rows: rows, p_rejects: rejects, p_run: run });
  if (e2) throw new Error(`apply_status: ${e2.message}`);
  return { run_id: data, rows_in: list.length, valid: rows.length, rejected: rejects.length, status: run.status,
    feed_age_s: Math.round(nowS - f.last_updated) };
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('SPOKE_CRON_SECRET');
  if (!secret || req.headers.get('x-spoke-cron') !== secret) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }
  const job = new URL(req.url).searchParams.get('job') ?? 'status';
  const started = new Date().toISOString();
  try {
    const out = job === 'stations' ? await ingestStations(started) : await ingestStatus(started);
    console.log(JSON.stringify({ job, ...out, ms: Date.now() - Date.parse(started) }));
    return Response.json({ job, ...out });
  } catch (e) {
    const msg = (e as Error).message;
    console.error(JSON.stringify({ job, error: msg }));
    await logFailure(job === 'stations' ? 'stations' : 'status', started, msg);
    return Response.json({ job, error: msg }, { status: 500 });
  }
});
