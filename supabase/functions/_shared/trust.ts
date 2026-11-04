// The trust gate. Before Spoke's AI answers anything, it asks two questions:
//   1. Spoke's own pipeline: is the live table fresh, are recent runs healthy?
//   2. Sodabase: what is its verdict on station_status right now?
// The answer uses the worse of the two. Untrusted means no answer at all.

export type Verdict = 'trusted' | 'caveated' | 'untrusted';

export type TrustMetrics = {
  status_age_s: number | null;
  runs_15m: number;
  failed_runs_15m: number;
  stations_total: number;
  stations_installed: number;
  last_status_run: { status: string; rows_in: number; rows_rejected: number; note: string | null } | null;
};

export type SodabaseVerdict = {
  verdict: 'trusted' | 'caveated' | 'untrusted' | 'unknown';
  summary: string;
  source: 'sodabase' | 'not_configured' | 'error';
};

export type TrustResult = {
  verdict: Verdict;
  reasons: string[];
  pipeline: Verdict;
  sodabase: SodabaseVerdict;
};

// GBFS refreshes every ~60 s and Spoke ingests every minute; three missed
// minutes means the cron chain is broken somewhere.
export const STALE_AFTER_S = 180;
export const CAVEAT_AFTER_S = 90;

const rank: Record<Verdict, number> = { trusted: 0, caveated: 1, untrusted: 2 };
export const worst = (a: Verdict, b: Verdict): Verdict => (rank[a] >= rank[b] ? a : b);

export function pipelineVerdict(m: TrustMetrics): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];
  let v: Verdict = 'trusted';
  if (m.status_age_s == null || m.stations_installed === 0) {
    return { verdict: 'untrusted', reasons: ['no live station data has been ingested yet'] };
  }
  if (m.status_age_s > STALE_AFTER_S) {
    v = 'untrusted';
    reasons.push(`live data is ${Math.round(m.status_age_s / 60)} min old (limit ${STALE_AFTER_S / 60} min)`);
  } else if (m.status_age_s > CAVEAT_AFTER_S) {
    v = worst(v, 'caveated');
    reasons.push(`live data is ${m.status_age_s} s old`);
  }
  if (m.runs_15m === 0) {
    v = 'untrusted';
    reasons.push('no ingest run in the last 15 minutes');
  } else if (m.failed_runs_15m > 0) {
    v = worst(v, 'caveated');
    reasons.push(`${m.failed_runs_15m} of ${m.runs_15m} ingest runs failed in the last 15 minutes`);
  }
  const last = m.last_status_run;
  if (last && last.status === 'partial') {
    v = worst(v, 'caveated');
    reasons.push(`last ingest was partial${last.note ? `: ${last.note}` : ''}`);
  }
  if (m.stations_total > 0 && m.stations_installed / m.stations_total < 0.8) {
    v = worst(v, 'caveated');
    reasons.push(`only ${m.stations_installed} of ${m.stations_total} stations are reporting`);
  }
  return { verdict: v, reasons };
}

// Sodabase's "unknown" (still warming up, or not connected) doesn't downgrade
// the answer; Spoke's own checks still apply.
export function combine(m: TrustMetrics, s: SodabaseVerdict): TrustResult {
  const p = pipelineVerdict(m);
  let verdict = p.verdict;
  const reasons = [...p.reasons];
  if (s.verdict === 'untrusted' || s.verdict === 'caveated') {
    verdict = worst(verdict, s.verdict);
    reasons.push(`Sodabase: ${s.summary}`);
  }
  return { verdict, reasons, pipeline: p.verdict, sodabase: s };
}
