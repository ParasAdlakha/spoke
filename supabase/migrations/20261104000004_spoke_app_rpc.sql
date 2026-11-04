-- Read-only RPCs for the web app (one call each, no 1,000-row page limit).

-- Every installed station with live counts, compact keys for a small payload.
create or replace function public.live_stations()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', st.station_id, 'n', st.name, 'la', st.lat, 'lo', st.lon, 'c', st.capacity,
    'b', ss.bikes, 'e', ss.ebikes, 'd', ss.docks, 'r', ss.is_renting, 'rt', ss.is_returning,
    'age', extract(epoch from now() - ss.last_reported)::int
  )), '[]'::jsonb)
  from stations st join station_status ss using (station_id)
  where ss.is_installed;
$$;

-- Everything the "Data health" panel shows.
create or replace function public.health_summary()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'trust', trust_metrics(),
    'pulse', (select coalesce(jsonb_agg(p order by p.created_at), '[]'::jsonb) from (
        select created_at, bikes, ebikes, docks, stations_reporting, empty_stations, full_stations
        from system_pulse where created_at > now() - interval '3 hours' order by created_at desc limit 180) p),
    'runs', (select coalesce(jsonb_agg(r order by r.id desc), '[]'::jsonb) from (
        select id, job, status, created_at, extract(epoch from finished_at - started_at)::numeric(6,2) as secs,
               extract(epoch from started_at - feed_updated_at)::int as feed_age_s,
               rows_in, rows_written, rows_rejected, note
        from ingest_runs order by id desc limit 12) r),
    'rejects', (select coalesce(jsonb_agg(x order by x.stations desc), '[]'::jsonb) from (
        select feed, reason, count(*) as stations, sum(times_seen) as times_seen, max(last_seen) as last_seen,
               (array_agg(detail order by last_seen desc))[1] as example
        from rejected_records where last_seen > now() - interval '1 hour'
        group by feed, reason) x),
    'counts', jsonb_build_object(
        'stations', (select count(*) from stations),
        'snapshots', (select count(*) from status_snapshots),
        'pulse', (select count(*) from system_pulse),
        'runs', (select count(*) from ingest_runs),
        'answers', (select count(*) from ai_answers)),
    'answers', (select coalesce(jsonb_agg(a order by a.id desc), '[]'::jsonb) from (
        select id, created_at, question, verdict, model, latency_ms from ai_answers order by id desc limit 8) a)
  );
$$;

grant execute on function public.live_stations() to anon, authenticated;
grant execute on function public.health_summary() to anon, authenticated;
