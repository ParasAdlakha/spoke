-- Spoke: live Citi Bike availability with a data-quality contract.
-- Every table here is something Sodabase can watch: each has a timestamp
-- column (created_at or updated_at) that moves on a steady rhythm.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Stations: refreshed hourly from GBFS station_information.
-- ---------------------------------------------------------------------------
create table if not exists public.stations (
  station_id    text primary key,
  legacy_id     text,
  name          text not null check (length(trim(name)) > 0),
  short_name    text,
  lat           double precision not null check (lat between 40.4 and 41.1),
  lon           double precision not null check (lon between -74.4 and -73.6),
  region_id     text,
  capacity      integer not null check (capacity >= 0),
  station_type  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Station status: one row per station, the latest validated report.
-- updated_at moves only when a station's report actually changes.
-- ---------------------------------------------------------------------------
create table if not exists public.station_status (
  station_id      text primary key references public.stations (station_id) on delete cascade,
  bikes           integer not null check (bikes >= 0),
  ebikes          integer not null check (ebikes >= 0 and ebikes <= bikes),
  docks           integer not null check (docks >= 0),
  bikes_disabled  integer not null default 0 check (bikes_disabled >= 0),
  docks_disabled  integer not null default 0 check (docks_disabled >= 0),
  is_installed    boolean not null,
  is_renting      boolean not null,
  is_returning    boolean not null,
  last_reported   timestamptz not null check (last_reported > '2013-05-01'),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Status snapshots: insert-only history, written every 10 minutes by pg_cron.
-- This is what trends ("draining fast") are computed from.
-- ---------------------------------------------------------------------------
create table if not exists public.status_snapshots (
  id             bigint generated always as identity primary key,
  station_id     text not null references public.stations (station_id) on delete cascade,
  bikes          integer not null,
  ebikes         integer not null,
  docks          integer not null,
  is_renting     boolean not null,
  last_reported  timestamptz not null,
  created_at     timestamptz not null default now()
);
create index if not exists status_snapshots_station_time on public.status_snapshots (station_id, created_at desc);
create index if not exists status_snapshots_time on public.status_snapshots (created_at);

-- ---------------------------------------------------------------------------
-- System pulse: one row per ingest minute, the whole network at a glance.
-- ---------------------------------------------------------------------------
create table if not exists public.system_pulse (
  id                  bigint generated always as identity primary key,
  run_id              bigint,
  feed_updated_at     timestamptz not null,
  stations_reporting  integer not null check (stations_reporting >= 0),
  stations_renting    integer not null check (stations_renting >= 0),
  bikes               integer not null check (bikes >= 0),
  ebikes              integer not null check (ebikes >= 0),
  docks               integer not null check (docks >= 0),
  empty_stations      integer not null check (empty_stations >= 0),
  full_stations       integer not null check (full_stations >= 0),
  created_at          timestamptz not null default now()
);
create index if not exists system_pulse_time on public.system_pulse (created_at desc);

-- ---------------------------------------------------------------------------
-- Ingest runs: the pipeline's own audit log. Every run writes exactly one row,
-- including failures, so a silent pipeline is itself visible as stale data.
-- ---------------------------------------------------------------------------
create table if not exists public.ingest_runs (
  id               bigint generated always as identity primary key,
  job              text not null check (job in ('status', 'stations')),
  status           text not null check (status in ('ok', 'partial', 'failed')),
  started_at       timestamptz not null,
  finished_at      timestamptz not null,
  feed_updated_at  timestamptz,
  rows_in          integer not null default 0 check (rows_in >= 0),
  rows_written     integer not null default 0 check (rows_written >= 0),
  rows_rejected    integer not null default 0 check (rows_rejected >= 0),
  note             text,
  created_at       timestamptz not null default now()
);
create index if not exists ingest_runs_time on public.ingest_runs (created_at desc);

-- ---------------------------------------------------------------------------
-- Rejected records: the quarantine. One row per (feed, station, reason), so a
-- decommissioned station reporting 1970 timestamps every minute is one row
-- with a counter, not 1,440 rows a day.
-- ---------------------------------------------------------------------------
create table if not exists public.rejected_records (
  id           bigint generated always as identity primary key,
  feed         text not null,
  station_id   text not null,
  reason       text not null,
  detail       text,
  payload      jsonb not null,
  times_seen   integer not null default 1,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  unique (feed, station_id, reason)
);

-- ---------------------------------------------------------------------------
-- AI answers: every question, the trust verdict it was gated on, and the model.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_answers (
  id          bigint generated always as identity primary key,
  question    text not null,
  lat         double precision,
  lon         double precision,
  verdict     text not null check (verdict in ('trusted', 'caveated', 'untrusted')),
  trust       jsonb not null,
  answer      text not null,
  model       text not null,
  latency_ms  integer not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row-level security: the live data is public read-only; nothing is writable
-- from the browser. Writes happen only through the service role (edge
-- functions) and security-definer functions called by pg_cron.
-- ---------------------------------------------------------------------------
alter table public.stations          enable row level security;
alter table public.station_status    enable row level security;
alter table public.status_snapshots  enable row level security;
alter table public.system_pulse      enable row level security;
alter table public.ingest_runs       enable row level security;
alter table public.rejected_records  enable row level security;
alter table public.ai_answers        enable row level security;

create policy "public read" on public.stations         for select using (true);
create policy "public read" on public.station_status   for select using (true);
create policy "public read" on public.status_snapshots for select using (true);
create policy "public read" on public.system_pulse     for select using (true);
create policy "public read" on public.ingest_runs      for select using (true);
create policy "public read" on public.rejected_records for select using (true);
