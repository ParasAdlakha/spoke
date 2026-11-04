# Spoke

**Live Citi Bike availability for New York, checked before it's trusted.**

You're walking to a Citi Bike dock and the app says there are three bikes. You get there and there are none. Was the data wrong, old, or just unlucky? Spoke pulls the public Citi Bike feed into **Supabase** every minute with **pg_cron** and an **edge function**, checks every record against a written data contract, and quarantines what fails. It's not hypothetical: on the first pull, 48 stations reported a 1970 timestamp and 9 reported more bikes than they have docks. Ask Spoke "where can I grab an e-bike near here?" and it first runs a **trust gate**: Spoke's own pipeline health plus **Sodabase**'s verdict on the table. If the data can't be trusted, Spoke says so and refuses to guess. If it can, it answers from the nearest live stations and their 60-minute trend, citing each one.

Built by **Paras Adlakha** and **Harshita Adlakha** for the **Supabase + Sodabase + BuilderBase NYC Hackathon** (4 November 2026).

**▶️ [Open the live app](https://parasadlakha.github.io/spoke/app/)** · [Data health view](https://parasadlakha.github.io/spoke/app/#health) · **🎬 [2-minute demo](docs/video/Spoke-demo-2min.mp4)** · [3-minute pitch](docs/video/Spoke-pitch-3min.mp4) · **📑 [Slides (PDF)](docs/slides/Spoke-slides.pdf)** · [PowerPoint](docs/slides/Spoke-slides.pptx) · [Project page](https://parasadlakha.github.io/spoke/) · [Market brief](docs/market-brief.html)

![Spoke: live station map on the left, a trust-gated answer on the right](docs/img/answer.png)

*The live app. Left: every installed Citi Bike station, coloured by bikes available. Right: the answer, its trust verdict, and the stations it cites.*

**Contents:** [The hackathon](#the-hackathon) · [The problem](#the-problem) · [What Spoke does](#what-spoke-does) · [Architecture](#architecture) · [The data contract](#the-data-contract) · [The trust gate](#the-trust-gate) · [Built for Sodabase](#built-for-sodabase) · [Supabase features used](#supabase-features-used) · [Real numbers](#real-numbers) · [Tests](#tests) · [Run it yourself](#run-it-yourself) · [Repository layout](#repository-layout) · [What we learned](#what-we-learned) · [Limitations and roadmap](#limitations-and-roadmap) · [Team](#team) · [References](#references)

---

## The hackathon

| | |
|---|---|
| **Event** | Supabase + Sodabase + BuilderBase NYC Hackathon, Midtown Manhattan |
| **Date** | Wednesday 4 November 2026, 4–8 PM EST, in person |
| **Challenge** | *Your code works. But is your data any good?* Build on Supabase tables, cron jobs and edge functions; connect Sodabase, which learns how the tables normally change |
| **Judging** | Craft, execution and the **Sodabase Data Quality Score**: Sodabase checks for stale, empty or wrong data |

### What the challenge asks for, and where it is in Spoke

| Ask | Spoke |
|---|---|
| Supabase tables | 7 tables in `public`, with `CHECK` constraints and row-level security ([migration](supabase/migrations/20261104000001_spoke_schema.sql)) |
| Cron jobs | 3 `pg_cron` jobs: live status every minute, stations hourly, history every 10 minutes ([migration](supabase/migrations/20261104000003_spoke_cron.sql)) |
| Edge functions | `ingest` (called by pg_cron via `pg_net`) and `ask` (the trust-gated answer) ([`supabase/functions`](supabase/functions)) |
| Connect Sodabase | Read-only connection to the project; Sodabase's MCP `check_trust` is called on every answer when a token is set ([`sodabase.ts`](supabase/functions/_shared/sodabase.ts)) |
| Data that isn't stale | Every watched table has a timestamp that moves on a fixed rhythm; a failed run still writes a row, so silence is visible |
| Data that isn't empty | No truncation or deletion anywhere; history is insert-only |
| Data that isn't wrong | Every record passes a written contract before it's saved; failures are quarantined with a reason |

---

## The problem

Bike-share availability is the classic "the data said so" failure.

- Citi Bike is the largest bike-share system in North America: about **2,500 stations** across NYC, Jersey City and Hoboken, and a record **44.3 million trips in 2024**.
- Station status comes from a public GBFS feed that hundreds of apps, maps and dashboards read directly. It's good data, but not clean data. On 4 November 2026 it included **48 stations with a `last_reported` of `86400`** (2 January 1970), **9 stations reporting more bikes and docks than they physically have**, and stations marked "installed" that hadn't reported for over a day.
- An app that passes this through, or an AI assistant that paraphrases it, turns a bad row into a confident wrong answer. A rider walks ten minutes to an empty dock.

**Our bet:** the pipeline should know when it's wrong, and the answer should depend on it. Validate on the way in, record what you rejected and why, monitor freshness and volume continuously, and gate every AI answer on that state.

---

## What Spoke does

```mermaid
flowchart LR
    G["Citi Bike GBFS<br/>public feed, ttl 60 s"] -->|"pg_cron, every minute"| I["ingest<br/>edge function"]
    I --> V{"data contract<br/>10 rules"}
    V -- pass --> T[("station_status<br/>system_pulse")]
    V -- fail --> Q[("rejected_records<br/>quarantine")]
    T -->|"every 10 min"| H[("status_snapshots<br/>history")]
    T --> S["Sodabase<br/>learns normal change"]
    U["Rider asks:<br/>e-bike near here?"] --> A["ask<br/>edge function"]
    A --> GATE{"trust gate<br/>pipeline + Sodabase"}
    GATE -- untrusted --> R["Refuse, with reasons"]
    GATE -- "trusted / caveated" --> N["Nearest 5 stations<br/>+ 60-min trend"] --> ANS["Cited answer"]
```

| Step | What happens | Where |
|---|---|---|
| **Pull** | pg_cron calls the `ingest` edge function through `pg_net` every minute, with a shared secret from Supabase Vault | `cron.job`, `call_ingest()` |
| **Check** | Each of ~2,500 records goes through the contract: ids, counts, flags, timestamps, capacity, service area | [`validate.ts`](supabase/functions/_shared/validate.ts) |
| **Save** | Clean rows are upserted in one transaction; `updated_at` moves only for stations whose report changed | `apply_status()` |
| **Quarantine** | Failing records go to `rejected_records`, one row per station and reason with a counter | `record_rejects()` |
| **Audit** | Every run, including failures, writes one `ingest_runs` row: rows in, changed, rejected, feed age | `ingest_runs` |
| **Summarise** | One `system_pulse` row per minute: bikes, e-bikes, docks, empty and full stations | `system_pulse` |
| **Remember** | Every 10 minutes, a snapshot of every installed station for trends | `take_snapshot()` |
| **Ask** | Trust gate → nearest stations with trend → an answer citing [n] stations, or a refusal | [`ask`](supabase/functions/ask/index.ts) |

---

## Architecture

```mermaid
flowchart TB
    subgraph Browser["Browser (GitHub Pages)"]
        APP["docs/app/index.html<br/>Leaflet map · Ask · Data health"]
    end

    subgraph Supabase["Supabase project (us-east-1)"]
        subgraph Cron["pg_cron + pg_net"]
            J1["spoke-ingest-status<br/>* * * * *"]
            J2["spoke-ingest-stations<br/>7 * * * *"]
            J3["spoke-snapshot<br/>*/10 * * * *"]
        end
        VAULT[("Vault<br/>project URL, cron secret")]
        subgraph Edge["Edge functions (Deno)"]
            ING["ingest<br/>fetch · validate · apply"]
            ASK["ask<br/>trust gate · answer"]
        end
        subgraph DB["Postgres, public schema, RLS on"]
            ST[("stations")]
            SS[("station_status")]
            SN[("status_snapshots")]
            SP[("system_pulse")]
            IR[("ingest_runs")]
            RR[("rejected_records")]
            AA[("ai_answers")]
        end
        RPC["RPC: live_stations · health_summary<br/>nearest_stations · trust_metrics"]
    end

    GBFS["Citi Bike GBFS"]
    SODA["Sodabase<br/>read-only role · MCP check_trust"]
    LLM["Claude or OpenAI<br/>(optional; template fallback)"]

    J1 & J2 --> VAULT
    J1 & J2 -->|"pg_net POST + x-spoke-cron"| ING
    J3 --> SN
    ING --> GBFS
    ING --> ST & SS & SP & IR & RR
    APP -->|"publishable key, read-only"| RPC
    APP -->|"POST /functions/v1/ask"| ASK
    ASK --> RPC
    ASK -->|"Bearer token"| SODA
    ASK --> LLM
    ASK --> AA
    SODA -.->|"watches"| SS & SN & SP & IR
```

**Why so little code?** Spoke is a database with two small functions on top. The cron schedule, the secret store, the HTTP client, the history, the access rules and the read API are all Supabase. The only application logic is the contract and the trust gate, and both are pure TypeScript shared between the Deno functions and the Node tests.

---

## The data contract

Every record is checked before it touches a table. Failing records never reach the live tables; they go to the quarantine with a reason a human can read.

| Rule | Rejects | Seen live on 4 Nov |
|---|---|---|
| `bogus_timestamp` | `last_reported` before May 2013 (Citi Bike launched 27 May 2013) | **48 stations** report `86400` = 2 Jan 1970 |
| `over_capacity` | bikes + docks + disabled > capacity + 2 at an installed station | **9 stations**, e.g. "18 bikes + docks at a 4-dock station" |
| `future_timestamp` | reported more than 5 min in the future | 0 |
| `unknown_station` | status for a station missing from `station_information` | 0 |
| `invalid_count` / `ebikes_exceed_bikes` / `invalid_flag` | non-integer or negative counts, e-bikes > bikes, flags not 0/1 | 0 |
| `duplicate_station` / `missing_station_id` | the same id twice in one feed, or none | 0 |
| `outside_service_area` / `missing_name` / `invalid_capacity` | station list basics | 0 |

Three design choices keep this honest:

1. **Postgres repeats the critical rules as `CHECK` constraints**, so even a bug in the function can't write a negative count, more e-bikes than bikes, or a 1970 timestamp.
2. **A bad batch is applied partially, not dropped.** The 2,461 good stations are still good. If more than 10% of a batch is rejected, or the feed itself is over 5 minutes old, the run is marked `partial`, and the trust gate sees that.
3. **The quarantine doesn't grow every minute.** A decommissioned dock reporting 1970 every minute is one row with `times_seen` counting up, not 1,440 rows a day.

---

## The trust gate

Before `ask` answers, it combines two independent views of the data and takes the worse one ([`trust.ts`](supabase/functions/_shared/trust.ts)).

| Source | Untrusted when | Caveated when |
|---|---|---|
| **Spoke's pipeline** (`trust_metrics()`) | `station_status` is over 3 minutes old · no ingest run in 15 minutes · no data yet | over 90 s old · a failed run in the last 15 minutes · the last run was `partial` · under 80% of stations reporting |
| **Sodabase** (MCP `check_trust` on `public.station_status`) | Sodabase says untrusted | Sodabase says caveated |

- **Untrusted:** no model call. Spoke answers "I won't guess", with the reasons (for example "live data is 12 min old").
- **Caveated:** the answer says briefly why the numbers may be off.
- **Trusted:** the 5 nearest stations, their live counts and their 60-minute trend from `status_snapshots` go into a facts block. The model may only phrase what's in it and must cite stations as [n]. With no model key, a fixed template answers from the same facts, so the app works without any AI provider.
- Sodabase's **unknown** (still warming up, or not connected) never downgrades an answer on its own; Spoke's own checks still apply.

Every answer is logged in `ai_answers` with its verdict, the full trust record, the model and the latency.

---

## Built for Sodabase

Sodabase learns how each table normally changes and flags data that's stale, empty or wrong. Spoke is designed so that "normal" is easy to learn and a real problem is easy to see.

| Sodabase check | How Spoke's tables behave |
|---|---|
| **Stale** (freshness, from `updated_at` / `created_at`) | `ingest_runs`, `system_pulse`: one row per minute, `created_at`, insert-only. `status_snapshots`: ~2,450 rows every 10 min. `station_status.updated_at`: dozens of stations change every minute. A stopped cron shows up within minutes |
| **Empty** (row count drops, truncation) | Nothing is ever deleted or truncated. History tables only grow; `stations` and `station_status` hold ~2,500 rows, upserted in place |
| **Wrong** (schema / shape) | The schema lives only in migrations; nothing alters tables at runtime. Bad values are blocked by the contract and `CHECK` constraints, and recorded in `rejected_records` |

Sodabase connects with its own `soda_readonly` role and never writes. Spoke reads Sodabase back through its MCP server: `ask` opens a Streamable HTTP session at `https://sodabase.io/mcp`, calls `check_trust` with `dataset = public.station_status`, and maps the reply to a verdict. The same MCP server works from Claude Code or Cursor for investigating alerts while building:

```bash
claude mcp add --transport http sodabase https://sodabase.io/mcp
```

---

## Supabase features used

| Feature | Use |
|---|---|
| **Postgres tables + `CHECK` constraints** | 7 tables; the critical contract rules are enforced in the database |
| **pg_cron** | 3 jobs: `spoke-ingest-status` (every minute), `spoke-ingest-stations` (hourly), `spoke-snapshot` (every 10 min) |
| **pg_net** | `call_ingest()` posts to the edge function from inside Postgres |
| **Vault** | The project URL and cron secret, read by `call_ingest()`; never in a migration |
| **Edge functions (Deno)** | `ingest` and `ask`, deployed with `supabase functions deploy --use-api` |
| **Row-level security** | Live tables are public read-only; `ai_answers` isn't readable from the browser; nothing is writable with the publishable key |
| **Security-definer RPCs** | `live_stations`, `health_summary`, `nearest_stations`, `trust_metrics` for the browser; write functions are revoked from `anon` |
| **Supabase CLI** | Project creation, migrations, secrets and deploy, all scripted |
| **supabase-js** | The browser reads through RPCs with the publishable key |

---

## Real numbers

From the deployed project (`spoke-nyc`, us-east-1) on 4 November 2026:

| | |
|---|---|
| Stations ingested | 2,518 |
| Statuses accepted on the first run | 2,461 |
| Quarantined | 57 (48 `bogus_timestamp`, 9 `over_capacity`) |
| Installed stations live | 2,455 |
| Bikes / e-bikes on the network at 19:30 UTC | 32,553 / 14,051 |
| `ask` latency, trusted path, template answer | ~5 s cold, under 1 s warm |

---

## Tests

```bash
npm test
```

15 tests, run with Node's built-in test runner on the same TypeScript files the edge functions import:

| File | Covers |
|---|---|
| [`test/validate.test.ts`](test/validate.test.ts) | Every contract rule rejects with its own reason; the 1970 placeholder from the live feed is quarantined; valet tolerance; duplicates; run status (`ok` / `partial` / `failed`) |
| [`test/trust.test.ts`](test/trust.test.ts) | Healthy → trusted; stopped cron → untrusted; failed or partial runs → caveated; Sodabase can downgrade but "unknown" can't; Sodabase reply parsing doesn't mistake *untrusted* for *trusted*; template answers skip empty stations and warn about draining ones; refusals name the reason |

---

## Run it yourself

You need Node 22.6+, a Supabase account and the Supabase CLI (`npx supabase`).

```bash
git clone https://github.com/ParasAdlakha/spoke && cd spoke
npm install
cp .env.example .env            # fill SUPABASE_PROJECT_REF, SUPABASE_DB_PASSWORD, SPOKE_CRON_SECRET
npx supabase login
npx supabase link --project-ref <your-ref>
npx supabase db push            # tables, functions, RLS, cron jobs
npx supabase secrets set SPOKE_CRON_SECRET=<same as .env>   # optional: ANTHROPIC_API_KEY or OPENAI_API_KEY, SODABASE_TOKEN
npx supabase functions deploy ingest ask --use-api
npm run setup                   # Vault secrets + the first ingest
npm run sql -- "select * from ingest_runs order by id desc limit 5"
```

Then put your project URL and publishable key in [`docs/app/config.js`](docs/app/config.js) and open `docs/app/index.html` (or `npm run serve`). To connect Sodabase, sign in at [sodabase.io](https://sodabase.io) with Supabase and choose the project.

---

## Repository layout

```
supabase/
  migrations/
    20261104000001_spoke_schema.sql     tables, CHECK constraints, RLS
    20261104000002_spoke_functions.sql  apply_status, apply_stations, take_snapshot, nearest_stations, trust_metrics
    20261104000003_spoke_cron.sql       call_ingest (pg_net + Vault) and the 3 pg_cron jobs
    20261104000004_spoke_app_rpc.sql    live_stations, health_summary for the browser
  functions/
    ingest/index.ts                     fetch GBFS, validate, apply in one transaction
    ask/index.ts                        trust gate, nearest stations, answer, log
    _shared/validate.ts                 the data contract (pure, tested)
    _shared/trust.ts                    the trust gate (pure, tested)
    _shared/sodabase.ts                 MCP client for Sodabase check_trust
    _shared/answer.ts                   facts block, prompt, model call, template fallback
docs/
  app/                                  the web app (GitHub Pages)
  index.html                            project page
  slides/ video/ img/ market-brief.html
data/README.md                          source, licence, contract, feed profile
scripts/                                setup (Vault + first ingest), sql runner
test/                                   15 unit tests
```

---

## What we learned

- **The feed is the first data-quality problem.** We expected to build checks for hypothetical failures. Profiling one pull found placeholder timestamps from 1970 and docks reporting four times their capacity.
- **`updated_at` should mean something.** Updating every row every minute would make freshness meaningless. Spoke moves `updated_at` only when a station's report actually changes, so freshness reflects the city, not the cron job.
- **A failed run must still write a row.** If failures write nothing, a broken pipeline looks the same as a quiet night. Writing one `ingest_runs` row per run, success or failure, makes a gap in that table a reliable alarm.
- **Gate the answer, not just the dashboard.** Data-quality alerts usually go to an engineer's Slack. The user asking the question is the one who needs to know the data is stale, at the moment they ask.

---

## Limitations and roadmap

- **Trend needs history.** The 60-minute trend appears once `status_snapshots` holds an hour of data; before that it says "warming up".
- **No prediction yet.** "Will there be a bike in 15 minutes?" is answered from the current trend, not a model. Next: per-station, hour-of-week availability curves from `status_snapshots`.
- **Sodabase's schema check is still rolling out** on Sodabase's side, so "wrong" today relies on Spoke's contract and constraints.
- **Retention.** `status_snapshots` grows by ~350,000 rows a day; a production version would roll older snapshots into hourly aggregates.
- **Next:** Slack alerts from `rejected_records` to the feed's operator, other GBFS systems (Divvy, Bay Wheels, Capital Bikeshare) with the same contract, and push notifications when your usual dock starts draining.

---

## Team

| | |
|---|---|
| **Paras Adlakha** | [github.com/ParasAdlakha](https://github.com/ParasAdlakha) |
| **Harshita Adlakha** | [github.com/HarshitaAdlakha](https://github.com/HarshitaAdlakha) |

A mirror of this repository lives at [github.com/HarshitaAdlakha/spoke](https://github.com/HarshitaAdlakha/spoke).

---

## References

- Citi Bike, [System Data](https://citibikenyc.com/system-data) and [Data License Agreement](https://ride.citibikenyc.com/data-sharing-policy)
- MobilityData, [General Bikeshare Feed Specification (GBFS)](https://github.com/MobilityData/gbfs)
- NYC DOT, [Citi Bike monthly operating reports](https://a860-gpp.nyc.gov/downloads/2j62s821f?locale=en) (44,292,951 trips in 2024); [Wikipedia: Citi Bike](https://en.wikipedia.org/wiki/Citi_Bike) (record of 193,645 rides on 20 Sep 2024)
- Sodabase, [Docs](https://sodabase.io/docs): what it checks, warm-up, MCP tools, read-only by design
- Supabase, [Sodabase partner listing](https://supabase.com/partners/catalog/sodabase)
- Supabase docs: [Cron](https://supabase.com/docs/guides/cron), [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net), [Vault](https://supabase.com/docs/guides/database/vault), [Edge Functions](https://supabase.com/docs/guides/functions), [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)

## Licence

MIT. Station data © Citi Bike / Lyft, used under the Citi Bike Data License Agreement.
