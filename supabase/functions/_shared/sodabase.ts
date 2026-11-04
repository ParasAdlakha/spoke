// Minimal MCP client for Sodabase (Streamable HTTP, JSON-RPC 2.0).
// Uses an access token from Sodabase Settings -> MCP (SODABASE_TOKEN).
// Calls the `check_trust` tool on a dataset and maps the reply to a verdict.

import type { SodabaseVerdict } from './trust.ts';

const MCP_URL = 'https://sodabase.io/mcp';

async function rpc(
  token: string,
  body: Record<string, unknown>,
  session: string | null,
  signal: AbortSignal,
): Promise<{ result: any; session: string | null }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  };
  if (session) headers['Mcp-Session-Id'] = session;
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`Sodabase MCP HTTP ${res.status}`);
  const sid = res.headers.get('mcp-session-id') ?? session;
  if (!('id' in body)) return { result: null, session: sid };
  const text = await res.text();
  let msg: any = null;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const m = JSON.parse(line.slice(5).trim());
      if (m.id === body.id) msg = m;
    }
  } else {
    msg = JSON.parse(text);
  }
  if (!msg) throw new Error('Sodabase MCP: empty reply');
  if (msg.error) throw new Error(`Sodabase MCP: ${msg.error.message ?? 'error'}`);
  return { result: msg.result, session: sid };
}

function parseObject(text: string): Record<string, any> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Sodabase replies with JSON: check_trust has `verdict`, data_trust has `status`.
// Read only those fields, because the prose around them can mention any verdict
// word. Plain text replies fall back to a word match.
export function parseVerdict(text: string): SodabaseVerdict['verdict'] {
  const obj = parseObject(text);
  if (obj) {
    const v = String(obj.verdict ?? obj.status ?? '').toLowerCase();
    return v === 'trusted' || v === 'caveated' || v === 'untrusted' ? v : 'unknown';
  }
  const t = text.toLowerCase();
  // Order matters: "untrusted" contains "trusted".
  if (/\buntrusted\b/.test(t)) return 'untrusted';
  if (/\bcaveated\b/.test(t)) return 'caveated';
  if (/\btrusted\b/.test(t)) return 'trusted';
  return 'unknown';
}

const describeFinding = (f: any): string =>
  typeof f === 'string' ? f : String(f?.summary ?? f?.message ?? f?.description ?? f?.title ?? JSON.stringify(f));

// A short, readable reason: the reply's evidence or findings, never its
// standard "read-only" note. These lines can reach riders in a refusal.
export function summarize(text: string): string {
  const obj = parseObject(text);
  let out = text;
  if (obj) {
    const evidence: string[] = Array.isArray(obj.evidence) ? obj.evidence.map(String) : [];
    const signal = evidence.filter((e) => !/no monitor history|not measured|^basis:/i.test(e));
    const findings: string[] = Array.isArray(obj.findings) ? obj.findings.map(describeFinding) : [];
    const lines = [...(signal.length ? signal : evidence), ...findings];
    if (lines.length) out = lines.join('; ');
    else if (Array.isArray(obj.findings)) out = `no findings${obj.as_of ? ` (as of ${obj.as_of})` : ''}`;
    else out = '';
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 280) || 'no detail returned';
}

export async function sodabaseTrust(token: string | undefined, dataset: string, timeoutMs = 6000): Promise<SodabaseVerdict> {
  if (!token) return { verdict: 'unknown', summary: 'Sodabase token not configured', source: 'not_configured' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const init = await rpc(token, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'spoke', version: '1.0.0' } },
    }, null, ctl.signal);
    await rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.session, ctl.signal);
    const tool = async (id: number, name: string, args: Record<string, unknown>) => {
      const call = await rpc(token, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, init.session, ctl.signal);
      // A failed tool call says nothing about the data, so it must not yield a verdict.
      if (call.result?.isError) return '';
      return (call.result?.content ?? []).map((c: any) => (c.type === 'text' ? c.text : '')).join('\n').trim();
    };
    // check_trust is the monitor's verdict. It is `unknown` until monitors have
    // history, so data_trust (the latest scan, by bare table name) is the fallback.
    // Both start together to save a round trip; data_trust is only waited for when
    // it's needed, and the finally block cancels it otherwise.
    const table = dataset.split('.').pop()!;
    const altCall = tool(3, 'data_trust', { table }).catch(() => '');
    const text = await tool(2, 'check_trust', { dataset });
    const verdict = parseVerdict(text);
    if (verdict !== 'unknown') return { verdict, summary: summarize(text), source: 'sodabase' };
    const alt = await altCall;
    const altVerdict = parseVerdict(alt);
    if (altVerdict !== 'unknown') {
      return { verdict: altVerdict, summary: `no monitor verdict yet; latest scan: ${summarize(alt)}`.slice(0, 280), source: 'sodabase' };
    }
    return { verdict, summary: summarize(text), source: 'sodabase' };
  } catch (e) {
    return { verdict: 'unknown', summary: `Sodabase unavailable: ${(e as Error).message}`, source: 'error' };
  } finally {
    clearTimeout(timer);
    ctl.abort(); // cancels a data_trust call that is still in flight
  }
}
