import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combine, pipelineVerdict, type TrustMetrics, type SodabaseVerdict } from '../supabase/functions/_shared/trust.ts';
import { parseVerdict } from '../supabase/functions/_shared/sodabase.ts';
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
