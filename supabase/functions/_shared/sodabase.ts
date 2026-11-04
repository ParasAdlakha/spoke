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

export function parseVerdict(text: string): SodabaseVerdict['verdict'] {
  const t = text.toLowerCase();
  // Order matters: "untrusted" contains "trusted".
  if (/\buntrusted\b/.test(t)) return 'untrusted';
  if (/\bcaveated\b/.test(t)) return 'caveated';
  if (/\btrusted\b/.test(t)) return 'trusted';
  return 'unknown';
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
    const call = await rpc(token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_trust', arguments: { dataset } },
    }, init.session, ctl.signal);
    const text = (call.result?.content ?? [])
      .map((c: any) => (c.type === 'text' ? c.text : ''))
      .join('\n')
      .trim();
    const verdict = parseVerdict(text);
    const summary = text.replace(/\s+/g, ' ').slice(0, 280) || 'no detail returned';
    return { verdict, summary, source: 'sodabase' };
  } catch (e) {
    return { verdict: 'unknown', summary: `Sodabase unavailable: ${(e as Error).message}`, source: 'error' };
  } finally {
    clearTimeout(timer);
  }
}
