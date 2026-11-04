// Turning live station rows into an answer. The model only phrases what the
// rows say; the facts block is built here and the reply must cite it.
// With no model key, Spoke answers from the same facts with a fixed template.

import type { TrustResult } from './trust.ts';

export type NearStation = {
  station_id: string;
  name: string;
  capacity: number;
  bikes: number;
  ebikes: number;
  docks: number;
  is_renting: boolean;
  is_returning: boolean;
  report_age_s: number;
  distance_m: number;
  trend_per_hour: number | null;
};

const walk = (m: number) => `${Math.max(1, Math.round(m / 80))} min walk`;

export function factsBlock(stations: NearStation[], trust: TrustResult): string {
  const lines = stations.map((s, i) => {
    const trend = s.trend_per_hour == null ? 'trend: not enough history yet'
      : `trend: ${s.trend_per_hour > 0 ? '+' : ''}${s.trend_per_hour} bikes/hour`;
    const state = !s.is_renting ? 'NOT RENTING' : !s.is_returning ? 'NOT ACCEPTING RETURNS' : 'open';
    return `[${i + 1}] ${s.name} | ${s.distance_m} m (${walk(s.distance_m)}) | ${s.bikes} bikes (${s.ebikes} e-bikes), ` +
      `${s.docks} free docks of ${s.capacity} | ${state} | ${trend} | reported ${s.report_age_s} s ago`;
  });
  return [
    `Data trust verdict: ${trust.verdict}${trust.reasons.length ? ` (${trust.reasons.join('; ')})` : ''}`,
    'Nearest Citi Bike stations, live:',
    ...lines,
  ].join('\n');
}

export const SYSTEM_PROMPT = [
  'You are Spoke, a Citi Bike assistant for New York. Answer in 2 to 4 short sentences.',
  'Use ONLY the facts block. Name stations exactly and cite them as [n].',
  'Give a concrete recommendation (which station, bike or dock, e-bike or classic).',
  'If a station is draining (negative trend) and has few bikes, warn that it may be empty on arrival.',
  'If the verdict is caveated, say briefly why the data may be off. Never invent numbers.',
].join(' ');

export function templateAnswer(question: string, stations: NearStation[], trust: TrustResult): string {
  const wantsDock = /\b(dock|park|return|drop)\b/i.test(question);
  const open = stations.filter((s) => (wantsDock ? s.is_returning && s.docks > 0 : s.is_renting && s.bikes > 0));
  const caveat = trust.verdict === 'caveated' ? ` Note: ${trust.reasons[0]}.` : '';
  if (!open.length) {
    return `None of the ${stations.length} nearest stations has a ${wantsDock ? 'free dock' : 'bike'} right now.${caveat}`;
  }
  const best = open[0];
  const i = stations.indexOf(best) + 1;
  const what = wantsDock ? `${best.docks} free docks` : `${best.bikes} bikes (${best.ebikes} e-bikes)`;
  const trend = best.trend_per_hour != null && best.trend_per_hour < 0 && !wantsDock
    ? ` It is draining at ${best.trend_per_hour} bikes/hour.` : '';
  return `Go to ${best.name} [${i}], ${walk(best.distance_m)} away: ${what}.${trend}${caveat}`;
}

export function refusal(trust: TrustResult): string {
  return `I won't guess. The live bike data can't be trusted right now: ${trust.reasons.join('; ') || 'unknown reason'}. ` +
    'Check the Citi Bike app directly until the feed recovers.';
}

export type ModelReply = { text: string; model: string };

export async function callModel(facts: string, question: string, env: (k: string) => string | undefined): Promise<ModelReply | null> {
  const user = `Facts:\n${facts}\n\nQuestion: ${question}`;
  const anthropic = env('ANTHROPIC_API_KEY');
  if (anthropic) {
    const model = env('SPOKE_MODEL') || 'claude-sonnet-5-5';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': anthropic, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 300, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return { text: j.content.map((c: any) => c.text ?? '').join('').trim(), model };
  }
  const openai = env('OPENAI_API_KEY');
  if (openai) {
    const model = env('SPOKE_MODEL') || 'gpt-5-mini';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${openai}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return { text: (j.choices?.[0]?.message?.content ?? '').trim(), model };
  }
  return null;
}
