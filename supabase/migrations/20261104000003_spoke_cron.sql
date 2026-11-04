-- pg_cron schedules. The two ingest jobs call the `ingest` edge function via
-- pg_net; the URL and shared secret come from Supabase Vault, which
-- scripts/setup.mjs fills in (no secret is ever committed).

create or replace function public.call_ingest(p_job text)
returns bigint language sql security definer set search_path = public as $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'spoke_project_url')
               || '/functions/v1/ingest?job=' || p_job,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-spoke-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'spoke_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
$$;
revoke execute on function public.call_ingest(text) from anon, authenticated, public;

select cron.unschedule(jobname) from cron.job where jobname like 'spoke-%';

-- Live availability: every minute (the GBFS feed itself refreshes ~every 60 s).
select cron.schedule('spoke-ingest-status',   '* * * * *',    $$ select public.call_ingest('status') $$);
-- Station list (names, capacity, new docks): hourly at :07.
select cron.schedule('spoke-ingest-stations', '7 * * * *',    $$ select public.call_ingest('stations') $$);
-- History for trends: every 10 minutes, pure SQL.
select cron.schedule('spoke-snapshot',        '*/10 * * * *', $$ select public.take_snapshot() $$);
