# Data

Spoke has no bundled dataset. Everything in the database comes from the live
public Citi Bike feed, pulled by `pg_cron` → the `ingest` edge function.

## Source

| | |
|---|---|
| Publisher | Citi Bike NYC (operated by Lyft), via the [General Bikeshare Feed Specification (GBFS) 2.3](https://github.com/MobilityData/gbfs) |
| Discovery URL | `https://gbfs.citibikenyc.com/gbfs/2.3/gbfs.json` |
| Feeds used | `station_information.json` (names, location, capacity) and `station_status.json` (live bikes, e-bikes, docks, flags) at `https://gbfs.lyft.com/gbfs/2.3/bkn/en/` |
| Refresh | The feed's own `ttl` is 60 s |
| Size | About 2,500 stations in NYC, Jersey City and Hoboken |
| Licence | Citi Bike's [Data License Agreement](https://ride.citibikenyc.com/data-sharing-policy): free use of the data feeds, attribution "Station data: Citi Bike GBFS" shown on the map |
| Keys | None. The feed is public |

## Where it lands

| Table | Written by | Rhythm | Timestamp Sodabase watches |
|---|---|---|---|
| `stations` | `ingest?job=stations` | hourly at :07 | `updated_at` (moves only on real changes) |
| `station_status` | `ingest?job=status` | every minute | `updated_at` (moves only for stations whose report changed) |
| `status_snapshots` | `take_snapshot()` in SQL | every 10 minutes | `created_at` (insert-only) |
| `system_pulse` | `apply_status()` | every minute | `created_at` (insert-only) |
| `ingest_runs` | every job, including failures | every minute | `created_at` (insert-only) |
| `rejected_records` | quarantine upsert | when the feed is wrong | `last_seen` |
| `ai_answers` | `ask` | per question | `created_at` (insert-only) |

## The data contract

Every record is validated in [`supabase/functions/_shared/validate.ts`](../supabase/functions/_shared/validate.ts)
before it touches a table (tested in [`test/validate.test.ts`](../test/validate.test.ts)). Failing records go to
`rejected_records` with a reason, one row per station and reason, with a counter.

| Reason | Rule |
|---|---|
| `missing_station_id` / `duplicate_station` | every record has one id, once per feed |
| `unknown_station` | a status needs a station in `station_information` |
| `invalid_count` | bikes and docks are non-negative integers |
| `ebikes_exceed_bikes` | e-bikes are a subset of bikes |
| `invalid_flag` | `is_installed`, `is_renting`, `is_returning` are 0 or 1 |
| `bogus_timestamp` | `last_reported` before May 2013, when Citi Bike launched (the feed uses `86400`, 2 Jan 1970, as a placeholder) |
| `future_timestamp` | `last_reported` more than 5 minutes ahead |
| `over_capacity` | bikes + docks + disabled > capacity + 2 (valet tolerance) at an installed station |
| `outside_service_area` | station coordinates outside 40.4–41.1 N, 74.4–73.6 W |
| `missing_name` / `invalid_capacity` | station basics |

Database `CHECK` constraints repeat the critical rules, so even a bug in the
function can't write a negative count or a 1970 timestamp.

## What the live feed looked like (4 Nov 2026, 19:05 UTC)

Profiled before building, from one pull of both feeds:

| | |
|---|---|
| Stations in `station_information` | 2,518 |
| Statuses in `station_status` | 2,518 (feed 53 s old, ttl 60 s) |
| `last_reported` = 1970 placeholder | **48** (47 of them not installed) |
| Not installed | 54 |
| Capacity 0 | 34 |
| Bikes + docks over capacity + 2 | **7** |
| Installed but silent for over 24 h | **5** |

## Regenerating

There is nothing to regenerate: run the project and the cron jobs fill the
tables within a minute. To profile the feed yourself:

```bash
curl -s https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json | head -c 600
```
