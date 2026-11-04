# Submission texts

Copy-ready answers for the BuilderBase submission, the live demo script, and the social posts.

---

## BuilderBase submission

**Project name:** Spoke

**Tagline (one line):** Live Citi Bike availability on Supabase, checked against a data contract and Sodabase before any answer is trusted.

**Team:** Paras Adlakha, Harshita Adlakha

**Live app:** https://parasadlakha.github.io/spoke/app/

**Repository:** https://github.com/ParasAdlakha/spoke (mirror: https://github.com/HarshitaAdlakha/spoke)

**Demo video:** https://github.com/ParasAdlakha/spoke/blob/main/docs/video/Spoke-demo-2min.mp4

**Slides:** https://parasadlakha.github.io/spoke/slides/Spoke-slides.pdf

**Supabase project:** `spoke-nyc` (ref `dfytpxbxwwhktylpucwy`, us-east-1)

**Description:**

> You walk ten minutes to a Citi Bike dock because an app said there were three bikes, and the dock is empty. The data was wrong, old, or both, and nothing told you.
>
> Spoke pulls Citi Bike's public feed (about 2,500 stations) into **Supabase** every minute: a **pg_cron** job calls an **edge function** through **pg_net**, with its secret in **Vault**. Every record passes a written 10-rule data contract before it lands in one transaction; the rows that fail go to a quarantine table with a human-readable reason. The feed really needs it: on the first pull, 48 stations reported a last update in 1970 and 9 reported more bikes than they have docks. Every run, even a failed one, writes an audit row, and a pure-SQL cron job snapshots history every 10 minutes for trends.
>
> Riders ask Spoke questions like "where can I grab an e-bike near here?". Before answering, a second edge function runs a **trust gate**: is the live table fresh, are the recent runs healthy, and what does **Sodabase** say about it (its MCP `check_trust` tool)? Untrusted data gets "I won't guess", with the reasons. Trusted data gets the five nearest stations, their live counts and 60-minute trend, each one cited. Every answer is logged with the verdict it was gated on.
>
> The tables are designed for Sodabase: a heartbeat every minute, nothing ever deleted or truncated, and a schema that only changes through migrations, so "normal" is easy to learn and a real problem is easy to see.

**How we used Supabase:** 7 Postgres tables with `CHECK` constraints and row-level security; 3 pg_cron jobs (status every minute, stations hourly, snapshots every 10 minutes); pg_net and Vault for the cron → edge function call; 2 edge functions (`ingest`, `ask`); security-definer RPCs for the browser (`live_stations`, `health_summary`, `nearest_stations`, `trust_metrics`); the Supabase CLI for project creation, migrations, secrets and deploys; supabase-js with the publishable key.

**How we used Sodabase:** Sodabase is connected to the project with its read-only role and watches the public tables for stale, empty and wrong data. The `ask` edge function calls Sodabase's MCP server (`https://sodabase.io/mcp`, `check_trust` on `public.station_status`) on every answer, and an untrusted verdict from Sodabase blocks the answer.

**Pre-existing components:** None. Everything was built on 4 November 2026. The media scripts (slides, screen recording, video editing) were adapted from our earlier hackathon projects.

**AI coding tool:** Claude Code

---

## Live demo script (2 minutes, at the table)

Open https://parasadlakha.github.io/spoke/app/ before the judges arrive.

1. **(15 s) The hook.** "The app says three bikes, you walk ten minutes, the dock is empty. We profiled the Citi Bike feed before writing any code: 48 stations say they last reported in 1970."
2. **(25 s) Ask.** Click *e-bike near me*. "Before it answers, the ask edge function checks the data: is `station_status` fresh, are recent ingest runs healthy, and what does Sodabase say? Trusted, so it answers from the 5 nearest stations, cited." Point at the [n] tags on the map.
3. **(15 s) Anywhere.** Click near Union Square, then *free dock*. "Any point in the city, live."
4. **(35 s) Data health.** Switch tabs. "pg_cron calls the ingest function every minute. Every run writes an audit row, even failures. Here is the quarantine: the 1970 timestamps, the docks over capacity. They never reach the live tables, and Postgres CHECK constraints block them a second time."
5. **(20 s) Sodabase.** "Sodabase watches these tables. We designed them so normal is easy to learn: a heartbeat every minute, nothing ever deleted. And it closes the loop: if Sodabase says the table is untrusted, Spoke refuses to answer."
6. **(10 s) Close.** "Spoke: live Citi Bike, checked before it's trusted."

**If asked "what happens when the data goes bad?":** stop the cron job (`select cron.unschedule('spoke-ingest-status')`) and within three minutes every answer becomes "I won't guess: live data is 4 min old". Don't do this on the scored project unless you mean to; it shows up in Sodabase.

---

## Demo videos

All three are cut from one real recorded session against the live Supabase project. No keys or tokens appear.

| File | Length | Use |
|---|---|---|
| `docs/video/Spoke-demo-2min.mp4` | 1:22 | Narrated walkthrough: map, two trust-gated answers, data health, quarantine |
| `docs/video/Spoke-pitch-3min.mp4` | 2:20 | Problem → demo → architecture → Sodabase → close, with slides |
| `docs/video/Spoke-demo.mp4` | 0:44 | Silent, captioned, for social feeds |

---

## Images

| File | Use |
|---|---|
| `docs/img/linkedin-cover.png` | Cover: name, tagline, app screenshot |
| `docs/img/linkedin-numbers.png` | The 48 / 9 / 5 feed problems |
| `docs/img/linkedin-health.png` | The Data health view |
| `docs/img/answer.png` | App, trusted answer near Bryant Park |
| `docs/img/health.png` | App, Data health with the pipeline graph |

---

## LinkedIn post (Harshita, team voice)

Images, in order: `linkedin-cover.png`, `linkedin-numbers.png`, `linkedin-health.png`. Or attach `Spoke-demo-2min.mp4` as a native video.

> "The app said three bikes. The dock was empty."
>
> Last night our team built Spoke at the Supabase + Sodabase + BuilderBase hackathon in New York. The challenge was simple to say and hard to do: your code works, but is your data any good?
>
> We picked data every New Yorker relies on: Citi Bike's live station feed. Before writing any app code, we profiled one pull of it.
> → 48 stations reported their last update in 1970
> → 9 reported more bikes than they have docks
> → 5 were marked "installed" but hadn't reported in over a day
>
> So Spoke checks before it trusts:
> 🔁 every minute, a Supabase cron job pulls the feed through an edge function
> 🧾 every record passes a 10-rule data contract; the ones that fail are quarantined with a reason
> 📒 every run, even a failed one, is audited, so a silent pipeline shows up as stale data
> 🛡️ before Spoke answers "where can I get an e-bike?", it checks the data's health and asks Sodabase whether the table can be trusted. If not, it says "I won't guess" instead of sending you to an empty dock
>
> My background is in system dynamics, and this is a feedback-loop problem: the people using the data need to know when it's wrong, at the moment they use it, not in an engineer's alert channel the next morning.
>
> Thank you to Sodabase, Supabase and BuilderBase for an evening of pure building.
>
> ▶️ Try it live: https://harshitaadlakha.github.io/spoke/app/
> 💻 Code: https://github.com/HarshitaAdlakha/spoke
>
> #Supabase #Sodabase #DataQuality #Hackathon #NYC #CitiBike #WomenInTech #BuildInPublic

## Event post (LinkedIn, team voice)

Images: `linkedin-cover.png`, `linkedin-health.png`. Post from Harshita's account; it mentions only the team.

> Your code works. But is your data any good?
>
> That was the challenge at the Supabase + Sodabase + BuilderBase hackathon in Midtown Manhattan on 4 November: 125 builders, four hours, no talks, just building. Build on Supabase tables, cron jobs and edge functions, connect Sodabase, and get scored on data quality as well as craft.
>
> 🛠️ We built Spoke: live Citi Bike availability, checked before it's trusted.
>
> 🔁 pg_cron + an edge function load ~2,500 stations every minute
> 🧾 a 10-rule data contract quarantines what's wrong (yes, 48 stations claim to have last reported in 1970)
> 🧱 Postgres CHECK constraints block bad values a second time
> 👀 Sodabase learns how the tables normally change and watches for stale, empty or wrong data
> 🛡️ the AI answer asks Sodabase first, and refuses to guess when the data can't be trusted
>
> ▶️ https://harshitaadlakha.github.io/spoke/app/
> 💻 https://github.com/HarshitaAdlakha/spoke
>
> 🙏 Thank you to Sodabase, Supabase and BuilderBase for hosting, and to the mentors and judges in the room.
>
> #Hackathon #Supabase #Sodabase #BuilderBase #DataQuality #NYC #BuildInPublic

**Tags to add when posting** (type @ and pick the page): Sodabase, Supabase, BuilderBase, Soda.

## LinkedIn post (Paras, personal)

Images: `linkedin-numbers.png`, `linkedin-health.png`. Or attach `Spoke-pitch-3min.mp4`.

> Data-quality alerts usually go to an engineer. The person who actually needs to know is the one asking the question, right now.
>
> At the Supabase + Sodabase hackathon in NYC, Harshita and I built Spoke: live Citi Bike availability where every AI answer is gated on whether the data can be trusted.
>
> The design choices I'd make again:
> 🧾 Validate on the way in, quarantine with a reason. 48 docks reporting a 1970 timestamp become one row each with a counter, not 1,440 rows a day.
> ⏱️ Make `updated_at` mean something. It moves only when a station's report actually changes, so freshness reflects the city, not the cron job.
> 📒 A failed run still writes a row. Otherwise a broken pipeline looks exactly like a quiet night.
> 🛡️ Gate the answer, not just the dashboard. Pipeline health plus Sodabase's `check_trust` verdict decide whether the model is even called.
>
> The whole thing is a Postgres database with two small edge functions on top: pg_cron, pg_net, Vault, RLS and check constraints do the heavy lifting.
>
> ▶️ https://parasadlakha.github.io/spoke/app/
> 💻 https://github.com/ParasAdlakha/spoke
>
> Thank you to Sodabase, Supabase and BuilderBase.
>
> #Supabase #Postgres #DataQuality #DataEngineering #SystemsEngineering #Sodabase

## X post (under 280 characters)

> Built Spoke at the @supabase × Sodabase hackathon in NYC 🚲
>
> pg_cron + edge functions load Citi Bike every minute, a data contract quarantines what's wrong (48 docks "last reported" in 1970), and the AI won't answer if Sodabase says the data's untrusted.
>
> parasadlakha.github.io/spoke/app
