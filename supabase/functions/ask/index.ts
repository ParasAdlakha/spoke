// Edge function: answer a Citi Bike question, gated on data trust.
//   POST /functions/v1/ask  { question, lat, lon }
// 1. Trust gate: Spoke's pipeline metrics + Sodabase check_trust on station_status.
// 2. Untrusted -> refuse, with the reasons. No model call.
// 3. Otherwise -> nearest stations (live counts + 60-min trend) -> model phrases
//    an answer from that facts block only. Every answer is logged in ai_answers.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { combine, type TrustMetrics } from '../_shared/trust.ts';
import { sodabaseTrust } from '../_shared/sodabase.ts';
import { callModel, factsBlock, refusal, templateAnswer, type NearStation } from '../_shared/answer.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const DEFAULT = { lat: 40.7549, lon: -73.984 }; // Bryant Park, Midtown

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const t0 = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const question = String(body.question ?? '').trim().slice(0, 300) || 'Where can I get a bike?';
    const lat = Number.isFinite(body.lat) ? Number(body.lat) : DEFAULT.lat;
    const lon = Number.isFinite(body.lon) ? Number(body.lon) : DEFAULT.lon;

    const [metricsRes, soda] = await Promise.all([
      db.rpc('trust_metrics'),
      sodabaseTrust(Deno.env.get('SODABASE_TOKEN'), Deno.env.get('SODABASE_DATASET') ?? 'public.station_status'),
    ]);
    if (metricsRes.error) throw new Error(`trust_metrics: ${metricsRes.error.message}`);
    const trust = combine(metricsRes.data as TrustMetrics, soda);

    let answer: string, model: string, stations: NearStation[] = [];
    if (trust.verdict === 'untrusted') {
      answer = refusal(trust);
      model = 'none (refused by trust gate)';
    } else {
      const near = await db.rpc('nearest_stations', { p_lat: lat, p_lon: lon, p_limit: 5 });
      if (near.error) throw new Error(`nearest_stations: ${near.error.message}`);
      stations = near.data as NearStation[];
      const facts = factsBlock(stations, trust);
      let reply = null;
      try {
        reply = await callModel(facts, question, (k) => Deno.env.get(k));
      } catch (e) {
        console.error(JSON.stringify({ model_error: (e as Error).message }));
      }
      answer = reply?.text || templateAnswer(question, stations, trust);
      model = reply?.model ?? 'template (no model configured or model error)';
    }

    const latency = Date.now() - t0;
    await db.from('ai_answers').insert({
      question, lat, lon, verdict: trust.verdict, trust, answer, model, latency_ms: latency,
    });
    return Response.json({ answer, verdict: trust.verdict, trust, stations, model, latency_ms: latency }, { headers: cors });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500, headers: cors });
  }
});
