-- Database functions. The edge function validates in TypeScript (tested in
-- test/validate.test.ts) and hands the clean rows to these in one round trip,
-- so each ingest is a single transaction.

-- Known stations and their capacity, as one JSON object (avoids row limits).
create or replace function public.station_capacities()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(station_id, capacity), '{}'::jsonb) from stations;
$$;

-- Upsert quarantined records (shared by both jobs).
create or replace function public.record_rejects(p_feed text, p_rejects jsonb)
returns void language sql security definer set search_path = public as $$
  insert into rejected_records (feed, station_id, reason, detail, payload)
  select p_feed, r.station_id, r.reason, r.detail, r.payload
  from jsonb_to_recordset(coalesce(p_rejects, '[]'::jsonb))
       as r(station_id text, reason text, detail text, payload jsonb)
  on conflict (feed, station_id, reason) do update
    set times_seen = rejected_records.times_seen + 1,
        last_seen  = now(),
        detail     = excluded.detail,
        payload    = excluded.payload;
$$;

-- Apply a validated station_information batch.
create or replace function public.apply_stations(p_rows jsonb, p_rejects jsonb, p_run jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_run bigint;
  v_written integer;
begin
  with up as (
    insert into stations (station_id, legacy_id, name, short_name, lat, lon, region_id, capacity, station_type)
    select r.station_id, r.legacy_id, r.name, r.short_name, r.lat, r.lon, r.region_id, r.capacity, r.station_type
    from jsonb_to_recordset(p_rows) as r(station_id text, legacy_id text, name text, short_name text,
         lat double precision, lon double precision, region_id text, capacity integer, station_type text)
    on conflict (station_id) do update
      set legacy_id = excluded.legacy_id, name = excluded.name, short_name = excluded.short_name,
          lat = excluded.lat, lon = excluded.lon, region_id = excluded.region_id,
          capacity = excluded.capacity, station_type = excluded.station_type, updated_at = now()
      where (stations.name, stations.lat, stations.lon, stations.capacity, stations.region_id, stations.station_type)
            is distinct from
            (excluded.name, excluded.lat, excluded.lon, excluded.capacity, excluded.region_id, excluded.station_type)
    returning 1
  )
  select count(*) into v_written from up;

  perform record_rejects('station_information', p_rejects);

  insert into ingest_runs (job, status, started_at, finished_at, feed_updated_at, rows_in, rows_written, rows_rejected, note)
  values ('stations', p_run->>'status', (p_run->>'started_at')::timestamptz, now(),
          (p_run->>'feed_updated_at')::timestamptz, (p_run->>'rows_in')::int, v_written,
          jsonb_array_length(coalesce(p_rejects, '[]'::jsonb)), p_run->>'note')
  returning id into v_run;
  return v_run;
end;
$$;

-- Apply a validated station_status batch, then write the system pulse.
create or replace function public.apply_status(p_rows jsonb, p_rejects jsonb, p_run jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_run bigint;
  v_written integer;
  v_feed timestamptz := (p_run->>'feed_updated_at')::timestamptz;
begin
  with up as (
    insert into station_status (station_id, bikes, ebikes, docks, bikes_disabled, docks_disabled,
                                is_installed, is_renting, is_returning, last_reported)
    select r.station_id, r.bikes, r.ebikes, r.docks, r.bikes_disabled, r.docks_disabled,
           r.is_installed, r.is_renting, r.is_returning, r.last_reported
    from jsonb_to_recordset(p_rows) as r(station_id text, bikes int, ebikes int, docks int,
         bikes_disabled int, docks_disabled int, is_installed boolean, is_renting boolean,
         is_returning boolean, last_reported timestamptz)
    on conflict (station_id) do update
      set bikes = excluded.bikes, ebikes = excluded.ebikes, docks = excluded.docks,
          bikes_disabled = excluded.bikes_disabled, docks_disabled = excluded.docks_disabled,
          is_installed = excluded.is_installed, is_renting = excluded.is_renting,
          is_returning = excluded.is_returning, last_reported = excluded.last_reported,
          updated_at = now()
      where (station_status.bikes, station_status.ebikes, station_status.docks, station_status.is_renting,
             station_status.is_returning, station_status.last_reported)
            is distinct from
            (excluded.bikes, excluded.ebikes, excluded.docks, excluded.is_renting,
             excluded.is_returning, excluded.last_reported)
    returning 1
  )
  select count(*) into v_written from up;

  perform record_rejects('station_status', p_rejects);

  insert into ingest_runs (job, status, started_at, finished_at, feed_updated_at, rows_in, rows_written, rows_rejected, note)
  values ('status', p_run->>'status', (p_run->>'started_at')::timestamptz, now(), v_feed,
          (p_run->>'rows_in')::int, v_written, jsonb_array_length(coalesce(p_rejects, '[]'::jsonb)), p_run->>'note')
  returning id into v_run;

  insert into system_pulse (run_id, feed_updated_at, stations_reporting, stations_renting, bikes, ebikes, docks,
                            empty_stations, full_stations)
  select v_run, v_feed,
         count(*) filter (where s.is_installed),
         count(*) filter (where s.is_installed and s.is_renting),
         coalesce(sum(s.bikes) filter (where s.is_installed), 0),
         coalesce(sum(s.ebikes) filter (where s.is_installed), 0),
         coalesce(sum(s.docks) filter (where s.is_installed), 0),
         count(*) filter (where s.is_installed and s.is_renting and s.bikes = 0),
         count(*) filter (where s.is_installed and s.is_returning and s.docks = 0)
  from station_status s;

  return v_run;
end;
$$;

-- Copy the live status of every installed station into the history table.
create or replace function public.take_snapshot()
returns integer language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  insert into status_snapshots (station_id, bikes, ebikes, docks, is_renting, last_reported)
  select station_id, bikes, ebikes, docks, is_renting, last_reported
  from station_status where is_installed;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Nearest stations to a point, with live counts and the 60-minute trend.
create or replace function public.nearest_stations(p_lat double precision, p_lon double precision, p_limit integer default 5)
returns table (
  station_id text, name text, lat double precision, lon double precision, capacity integer,
  bikes integer, ebikes integer, docks integer, is_renting boolean, is_returning boolean,
  last_reported timestamptz, report_age_s integer, distance_m integer,
  bikes_60m_ago integer, trend_per_hour numeric
) language sql stable security definer set search_path = public as $$
  with near as (
    select st.station_id, st.name, st.lat, st.lon, st.capacity,
           ss.bikes, ss.ebikes, ss.docks, ss.is_renting, ss.is_returning, ss.last_reported,
           extract(epoch from now() - ss.last_reported)::int as report_age_s,
           (6371000 * 2 * asin(sqrt(
              power(sin(radians(st.lat - p_lat) / 2), 2) +
              cos(radians(p_lat)) * cos(radians(st.lat)) * power(sin(radians(st.lon - p_lon) / 2), 2)
           )))::int as distance_m
    from stations st join station_status ss using (station_id)
    where ss.is_installed
    order by distance_m
    limit greatest(1, least(p_limit, 20))
  )
  select n.*, h.bikes as bikes_60m_ago,
         case when h.created_at is null or now() - h.created_at < interval '15 minutes' then null
              else round((n.bikes - h.bikes) / (extract(epoch from now() - h.created_at) / 3600.0)::numeric, 1)
         end as trend_per_hour
  from near n
  left join lateral (
    select sn.bikes, sn.created_at from status_snapshots sn
    where sn.station_id = n.station_id and sn.created_at >= now() - interval '70 minutes'
    order by sn.created_at asc limit 1
  ) h on true
  order by n.distance_m;
$$;

-- Raw trust metrics for the answer gate. The verdict itself is decided in
-- TypeScript (supabase/functions/_shared/trust.ts) so it is unit-tested.
create or replace function public.trust_metrics()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'now', now(),
    'status_updated_at', (select max(updated_at) from station_status),
    'status_age_s', (select extract(epoch from now() - max(updated_at))::int from station_status),
    'last_status_run', (select to_jsonb(r) from (
        select id, status, created_at, feed_updated_at, rows_in, rows_written, rows_rejected, note
        from ingest_runs where job = 'status' order by id desc limit 1) r),
    'runs_15m', (select count(*) from ingest_runs where job = 'status' and created_at > now() - interval '15 minutes'),
    'failed_runs_15m', (select count(*) from ingest_runs where job = 'status' and status = 'failed'
                          and created_at > now() - interval '15 minutes'),
    'stations_total', (select count(*) from stations),
    'stations_installed', (select count(*) from station_status where is_installed),
    'last_snapshot_at', (select max(created_at) from status_snapshots)
  );
$$;

grant execute on function public.nearest_stations(double precision, double precision, integer) to anon, authenticated;
grant execute on function public.trust_metrics() to anon, authenticated;
revoke execute on function public.apply_status(jsonb, jsonb, jsonb) from anon, authenticated, public;
revoke execute on function public.apply_stations(jsonb, jsonb, jsonb) from anon, authenticated, public;
revoke execute on function public.record_rejects(text, jsonb) from anon, authenticated, public;
revoke execute on function public.take_snapshot() from anon, authenticated, public;
revoke execute on function public.station_capacities() from anon, authenticated, public;
