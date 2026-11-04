import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combine, pipelineVerdict, type TrustMetrics, type SodabaseVerdict } from '../supabase/functions/_shared/trust.ts';
import { parseVerdict, sodabaseTrust, summarize } from '../supabase/functions/_shared/sodabase.ts';
import { templateAnswer, refusal, factsBlock, type NearStation } from '../supabase/functions/_shared/answer.ts';

const healthy: TrustMetrics = {
  status_age_s: 20, runs_15m: 15, failed_runs_15m: 0, stations_total: 2518, stations_installed: 2464,
  last_status_run: { status: 'ok', rows_in: 2518, rows_rejected: 48, note: null },
};
const sodaUnknown: SodabaseVerdict = { verdict: 'unknown', summary: 'warming up', source: 'sodabase' };

test('healthy pipeline is trusted', () => {
  assert.equal(pipelineVerdict(healthy).verdict, 'trusted');
  assert.equal(combine(healthy, sodaUnknown).verdict, 'trusted');
});

test('a stopped cron makes the data untrusted', () => {
  const r = pipelineVerdict({ ...healthy, status_age_s: 600, runs_15m: 0 });
  assert.equal(r.verdict, 'untrusted');
  assert.match(r.reasons.join(' '), /10 min old/);
});

test('failed or partial runs caveat the answer', () => {
  assert.equal(pipelineVerdict({ ...healthy, failed_runs_15m: 2 }).verdict, 'caveated');
  assert.equal(pipelineVerdict({ ...healthy, last_status_run: { ...healthy.last_status_run!, status: 'partial', note: 'feed is 9 min old' } }).verdict, 'caveated');
});

test('no data yet is untrusted', () => {
  assert.equal(pipelineVerdict({ ...healthy, status_age_s: null, stations_installed: 0 }).verdict, 'untrusted');
});

test('Sodabase can downgrade but "unknown" never does', () => {
  const bad: SodabaseVerdict = { verdict: 'untrusted', summary: 'row count dropped 90%', source: 'sodabase' };
  const r = combine(healthy, bad);
  assert.equal(r.verdict, 'untrusted');
  assert.match(r.reasons.join(' '), /Sodabase: row count dropped/);
  assert.equal(combine(healthy, { ...sodaUnknown, source: 'not_configured' }).verdict, 'trusted');
});

test('Sodabase reply parsing does not confuse untrusted with trusted', () => {
  assert.equal(parseVerdict('Verdict: UNTRUSTED. station_status is stale.'), 'untrusted');
  assert.equal(parseVerdict('verdict: trusted, last checked 2 min ago'), 'trusted');
  assert.equal(parseVerdict('caveated: schema changed'), 'caveated');
  assert.equal(parseVerdict('still warming up'), 'unknown');
});

const NOTE = 'Sodabase is read-only and never changes your data.';
const checkTrustUnknown = JSON.stringify({
  note: NOTE, verdict: 'unknown',
  evidence: ['freshness: no monitor history yet', 'content_checks: the day-1 data scan found no serious issues', 'no open issues', 'basis: monitor history'],
});
const dataTrustClean = JSON.stringify({ note: NOTE, status: 'trusted', as_of: '2026-11-04 19:27', findings: [] });

test('JSON replies use the verdict field, not words in the prose', () => {
  assert.equal(parseVerdict(JSON.stringify({ verdict: 'trusted', evidence: ['previously untrusted, now recovered'] })), 'trusted');
  assert.equal(parseVerdict(JSON.stringify({ verdict: 'unknown', note: 'nothing here is trusted yet' })), 'unknown');
  assert.equal(parseVerdict(JSON.stringify({ status: 'CAVEATED' })), 'caveated');
  assert.equal(parseVerdict(JSON.stringify({ note: 'untrusted' })), 'unknown');
});

test('summaries carry the evidence and drop the boilerplate', () => {
  const s = summarize(checkTrustUnknown);
  assert.equal(s, 'content_checks: the day-1 data scan found no serious issues; no open issues');
  assert.equal(summarize(dataTrustClean), 'no findings (as of 2026-11-04 19:27)');
  assert.equal(summarize(JSON.stringify({ status: 'untrusted', findings: [{ message: 'row count dropped 90%' }] })), 'row count dropped 90%');
  assert.equal(summarize(JSON.stringify({ note: NOTE })), 'no detail returned');
});

// Fakes the MCP server. Each tool has a reply, or never answers if it's left out.
function fakeMcp(replies: Record<string, { text: string; isError?: boolean }>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (!('id' in body)) return new Response(null, { status: 202 });
    const json = (result: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result }, { headers: { 'mcp-session-id': 's1' } });
    if (body.method === 'initialize') return json({});
    const reply = replies[body.params.name];
    if (!reply) {
      return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return json({ content: [{ type: 'text', text: reply.text }], isError: reply.isError ?? false });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test('a monitor verdict does not wait for a slow data_trust', async () => {
  const restore = fakeMcp({ check_trust: { text: JSON.stringify({ verdict: 'caveated', evidence: ['volume: down 40%'] }) } });
  try {
    const r = await sodabaseTrust('t', 'public.station_status');
    assert.deepEqual(r, { verdict: 'caveated', summary: 'volume: down 40%', source: 'sodabase' });
  } finally { restore(); }
});

test('an unknown monitor verdict falls back to the scan and says so', async () => {
  const restore = fakeMcp({ check_trust: { text: checkTrustUnknown }, data_trust: { text: dataTrustClean } });
  try {
    const r = await sodabaseTrust('t', 'public.station_status');
    assert.equal(r.verdict, 'trusted');
    assert.equal(r.summary, 'no monitor verdict yet; latest scan: no findings (as of 2026-11-04 19:27)');
  } finally { restore(); }
});

test('a failed tool call gives no verdict, whatever its error text says', async () => {
  const restore = fakeMcp({ check_trust: { text: 'dataset is untrusted', isError: true }, data_trust: { text: 'trusted', isError: true } });
  try {
    assert.equal((await sodabaseTrust('t', 'public.station_status')).verdict, 'unknown');
  } finally { restore(); }
});

test('a Sodabase timeout is unknown, not a crash', async () => {
  const restore = fakeMcp({});
  try {
    const r = await sodabaseTrust('t', 'public.station_status', 20);
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.source, 'error');
  } finally { restore(); }
});

const near: NearStation[] = [
  { station_id: 'a', name: 'W 41 St & 8 Ave', capacity: 40, bikes: 0, ebikes: 0, docks: 40, is_renting: true, is_returning: true, report_age_s: 30, distance_m: 120, trend_per_hour: -4 },
  { station_id: 'b', name: 'Broadway & W 41 St', capacity: 55, bikes: 3, ebikes: 1, docks: 52, is_renting: true, is_returning: true, report_age_s: 12, distance_m: 300, trend_per_hour: -6 },
];

test('template answer skips empty stations and warns about draining ones', () => {
  const t = combine(healthy, sodaUnknown);
  const a = templateAnswer('where can I get a bike', near, t);
  assert.match(a, /Broadway & W 41 St \[2\]/);
  assert.match(a, /draining at -6/);
  assert.match(templateAnswer('where can I dock', near, t), /W 41 St & 8 Ave \[1\].*40 free docks/);
});

test('refusal names the reason and the facts block carries the verdict', () => {
  const bad = combine({ ...healthy, status_age_s: 900, runs_15m: 0 }, sodaUnknown);
  assert.match(refusal(bad), /won't guess.*15 min old/);
  assert.match(factsBlock(near, combine(healthy, sodaUnknown)), /^Data trust verdict: trusted/);
});
