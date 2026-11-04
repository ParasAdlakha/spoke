// Builds the Spoke deck: each rendered slide PNG full-bleed, with the spoken script in the notes.
//   node build-deck.cjs <slides png dir> <out.pptx>
const pptxgen = require("pptxgenjs");
const path = require("path");
const [dir, out] = process.argv.slice(2);

const NOTES = [
  "Hi, we're Paras and Harshita. This is Spoke: live Citi Bike availability for New York, checked before it's trusted. It runs entirely on Supabase tables, cron jobs and edge functions, Sodabase watches its data, and its AI answers refuse to guess when the data can't be trusted.",
  "You've had this happen: the app says three bikes, you walk ten minutes, and the dock is empty. Citi Bike's public feed powers hundreds of apps: about 2,500 stations and a record 44 million trips last year. Before we wrote any app code, we profiled one pull of it. 48 stations report a last update in 1970. 9 report more bikes and docks than they physically have. 5 are marked installed but have been silent for a day. Passing that straight through is how riders end up at empty docks.",
  "So Spoke checks first. Ask where to grab an e-bike, and before answering it runs a trust gate: its own pipeline health, plus Sodabase's verdict on the table. Trusted: you get the nearest stations, live counts and the trend, each cited. Caveated: it answers and tells you why the numbers may be off. Untrusted: it says it won't guess, and why. No model call at all.",
  "It's a database with two small functions on top. pg_cron calls the ingest edge function through pg_net every minute, with its secret kept in Vault. Each of the 2,518 records goes through a ten-rule contract and lands in one transaction. A pure-SQL cron job snapshots history every ten minutes for trends. The ask function reads it through RPCs, and row-level security keeps everything read-only from the browser.",
  "Bad rows never reach the live tables. They go to a quarantine with a reason a human can read: 48 bogus 1970 timestamps, and docks reporting thirty bikes in a twenty-two dock station. One row per station and reason, so it doesn't bloat. Postgres check constraints repeat the critical rules, and every run, even a failed one, writes an audit row, so a silent pipeline shows up as stale data.",
  "We designed it for Sodabase. Stale: there's a heartbeat every minute, and a stopped cron shows within minutes. Empty: nothing is ever deleted, so a row-count drop is always real. Wrong: schema only changes through migrations, and bad values are blocked twice. And Sodabase closes the loop: every answer calls Sodabase's MCP check_trust tool. If Sodabase says the table is untrusted, Spoke won't answer.",
  "Next, we go from 'is the data fresh' to 'will there be a bike': hour-of-week curves per station from the snapshots, alerts back to the feed's operator, every other GBFS city, and push notifications when your usual dock is draining. Spoke: live Citi Bike, checked before it's trusted. Thank you.",
];

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.title = "Spoke";
pres.author = "Paras Adlakha";
pres.company = "Paras Adlakha and Harshita Adlakha";
pres.subject = "Supabase + Sodabase + BuilderBase NYC Hackathon, 4 November 2026";
NOTES.forEach((note, i) => {
  const slide = pres.addSlide();
  slide.addImage({ path: path.join(dir, `s${i + 1}.png`), x: 0, y: 0, w: 10, h: 5.625, altText: `Spoke slide ${i + 1}` });
  slide.addNotes(note);
});
pres.writeFile({ fileName: out }).then((f) => console.log("wrote", f));
