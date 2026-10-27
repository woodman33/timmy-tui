/**
 * Timmy's Treg bridge (src/connectors/treg-bridge.ts), adopted from the operator's private adapter of 2026-10-27.
 *
 * Real pieces: the bridge's MCP server (the SDK's Server) and a real SDK Client talking to it over the SDK's in-memory
 * transport; the bridge's own SDK Client and its streamable-HTTP transport.
 * FAKE pieces, labelled: the remote. A TEST DOUBLE `fetch` answers the JSON-RPC Treg's endpoint would (initialize,
 * tools/list, tools/call) with made-up tools and answers; nothing contacts treg.to. A made-up sign-in file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AUTH_NEEDED, createTregBridge, readCredentials, TREG_ENDPOINT, tregConfigPath, UNAVAILABLE, WITHHELD } from '../src/connectors/treg-bridge.js';
import { answerValue, callParts, chargedOf, freeArgs, quoteOf, tregSignIn, usdWords } from '../src/connectors/treg.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const TOKEN = 'fake-bridge-token-0001';

function signIn(o: Record<string, unknown> = { token: TOKEN, active_org: 'fake-team' }): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'treg-bridge-'));
  dirs.push(d);
  const f = path.join(d, 'config.json');
  fs.writeFileSync(f, JSON.stringify(o));
  return f;
}

interface Seen { url: string; method: string; rpc: string | null; auth: string | null; org: string | null; redirect: string | undefined }

/** The FAKE remote: Treg's MCP endpoint as JSON-RPC over HTTP, made up. */
function fakeRemote(o: { tools?: unknown[]; answer?: (name: string, args: unknown) => unknown; fail?: 'call' } = {}) {
  const seen: Seen[] = [];
  const tools = o.tools ?? [
    { name: 'catalog_search', description: 'FAKE search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'balance', description: 'FAKE balance', inputSchema: { type: 'object', properties: {} } },
    { name: 'admin_delete', description: 'FAKE: a tool the bridge never offers', inputSchema: { type: 'object', properties: {} } },
  ];
  const f = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const h = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { id?: number; method?: string; params?: { name?: string; arguments?: unknown } } : null;
    seen.push({ url: String(url), method: init?.method ?? 'GET', rpc: body?.method ?? null, auth: h.get('authorization'), org: h.get('x-treg-org'), redirect: init?.redirect });
    if (init?.method !== 'POST' || !body) return new Response(null, { status: 405 });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const ok = (result: unknown): Response => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (body.method === 'initialize') return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-treg-remote', version: '0' } });
    if (body.method === 'tools/list') return ok({ tools });
    if (body.method === 'tools/call') {
      if (o.fail === 'call') throw new Error(`FAKE network failure; Authorization: Bearer ${TOKEN}`);
      const name = body.params?.name ?? '';
      return ok(o.answer ? o.answer(name, body.params?.arguments) : { content: [{ type: 'text', text: JSON.stringify({ fake: true, tool: name }) }] });
    }
    return new Response(null, { status: 404 });
  };
  return { fetch: f, seen };
}

async function connect(o: { configPath: string; fetch: (url: string | URL, init?: RequestInit) => Promise<Response> }) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createTregBridge(o);
  const client = new Client({ name: 'treg-bridge-test', version: '1' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe('Timmy’s Treg bridge (the FAKE remote)', () => {
  it('reads the sign-in file TREG_CONFIG names (an absolute path), else the home’s; a missing or empty one is a sign-in to do', async () => {
    expect(tregConfigPath({ TREG_CONFIG: '/x/treg.json', HOME: '/h' })).toBe('/x/treg.json');
    expect(tregConfigPath({ TREG_CONFIG: 'relative.json', HOME: '/h' })).toBe(path.join('/h', '.treg', 'config.json'));
    expect(tregConfigPath({ HOME: '/h' })).toBe(path.join('/h', '.treg', 'config.json'));
    await expect(readCredentials('/nonexistent/treg.json')).rejects.toThrow(AUTH_NEEDED);
    await expect(readCredentials(signIn({ token: '  ' }))).rejects.toThrow(AUTH_NEEDED);
    await expect(readCredentials(signIn({ token: 'a\nb' }))).rejects.toThrow(AUTH_NEEDED);
    const s = tregSignIn({ TREG_CONFIG: signIn() });
    expect(s).toMatchObject({ from: 'TREG_CONFIG', present: true, token: true, team: true });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });

  it('lists only the allowed tools, with the remote’s own schemas; sends the token to the fixed endpoint only, redirects refused', async () => {
    const remote = fakeRemote();
    const b = await connect({ configPath: signIn(), fetch: remote.fetch });
    const listed = await b.client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['catalog_search', 'balance']);
    expect(listed.tools[0].inputSchema).toEqual({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] });
    const r = await b.client.callTool({ name: 'balance', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse((r.content as Array<{ text: string }>)[0].text)).toEqual({ fake: true, tool: 'balance' });
    expect(remote.seen.length).toBeGreaterThan(0);
    expect(remote.seen.every((x) => x.url === TREG_ENDPOINT && x.auth === `Bearer ${TOKEN}` && x.org === 'fake-team' && x.redirect === 'error')).toBe(true);
    await b.close();
  });

  it('refuses a tool outside its list before anything is sent, and a call the remote did not list in that session', async () => {
    const remote = fakeRemote();
    const b = await connect({ configPath: signIn(), fetch: remote.fetch });
    const r = await b.client.callTool({ name: 'admin_delete', arguments: {} });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(/Nothing was sent/);
    expect(remote.seen).toHaveLength(0);
    const c = await b.client.callTool({ name: 'call', arguments: { endpoint_id: 'x' } }); // allowed, but this remote lists no `call`
    expect(c.isError).toBe(true);
    expect(remote.seen.some((x) => x.rpc === 'tools/call')).toBe(false);
    await b.close();
  });

  it('withholds an answer that carries the token; a failed call is said in fixed words, never the error’s, and is not retried', async () => {
    const echo = fakeRemote({ answer: () => ({ content: [{ type: 'text', text: `here is your token ${TOKEN}` }] }) });
    const b = await connect({ configPath: signIn(), fetch: echo.fetch });
    const r = await b.client.callTool({ name: 'catalog_search', arguments: { query: 'x' } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect((r.content as Array<{ text: string }>)[0].text).toBe(WITHHELD);
    await b.close();

    const down = fakeRemote({ fail: 'call' });
    const c = await connect({ configPath: signIn(), fetch: down.fetch });
    const f = await c.client.callTool({ name: 'catalog_search', arguments: { query: 'x' } });
    expect((f.content as Array<{ text: string }>)[0].text).toBe(UNAVAILABLE);
    expect(JSON.stringify(f)).not.toContain(TOKEN);
    expect(down.seen.filter((x) => x.rpc === 'tools/call')).toHaveLength(1);
    await c.close();

    const none = await connect({ configPath: '/nonexistent/treg.json', fetch: fakeRemote().fetch });
    const n = await none.client.callTool({ name: 'balance', arguments: {} });
    expect((n.content as Array<{ text: string }>)[0].text).toBe(AUTH_NEEDED);
    await none.close();
  });
});

describe('reading Treg’s answers (made-up answers in Treg’s shapes)', () => {
  it('a quote from catalog_get’s endpoint.cost; none without a price in USD', () => {
    expect(quoteOf({ endpoint: { id: 'fake.x', name: 'FAKE', method: 'GET', cost: { type: 'per_success', usd: 0.001, note: 'charged on 2xx only', checked: '2026-10-27', confidence: 'verified' } } }))
      .toEqual({ endpoint_id: 'fake.x', name: 'FAKE', method: 'GET', usd: 0.001, type: 'per_success', note: 'charged on 2xx only', checked: '2026-10-27', confidence: 'verified' });
    expect(quoteOf({ endpoint: { id: 'fake.x', cost: { value: 2, currency: 'EUR' } } })).toBeNull();
    expect(quoteOf({ endpoint: { id: 'fake.x', cost: { value: 0.5, currency: 'USD' } } })?.usd).toBe(0.5);
    expect(quoteOf('not json')).toBeNull();
  });

  it('a charge only from Treg’s own fields, never from the data it carries', () => {
    expect(chargedOf({ http_status: 200, charged_micro: 1000, data: { cost: 99 } })).toEqual({ usd: 0.001, field: 'charged_micro', raw: 1000 });
    expect(chargedOf({ _meta: { billing: { charged_usd: 0.02 } } })).toEqual({ usd: 0.02, field: '_meta.billing.charged_usd', raw: 0.02 });
    expect(chargedOf({ data: { cost: 99, items: [{ charged: 5 }] } })).toBeNull();
    expect(chargedOf(null)).toBeNull();
  });

  it('the arguments the host passes, and nothing else', () => {
    expect(freeArgs('catalog_search', { query: ' backlinks ', limit: '3' })).toEqual({ ok: true, args: { query: 'backlinks', limit: 3 } });
    expect(freeArgs('catalog_search', { query: 'x', limit: 50 }).ok).toBe(false);
    expect(freeArgs('catalog_get', { endpoint_id: 'tikhub.tiktok.user.profile' })).toEqual({ ok: true, args: { endpoint_id: 'tikhub.tiktok.user.profile' } });
    expect(freeArgs('catalog_get', { endpoint_id: 'a b' }).ok).toBe(false);
    expect(freeArgs('balance', { anything: 1 })).toEqual({ ok: true, args: {} });
    expect(callParts({ query: { uniqueId: 'x' }, method: 'GET' }).ok).toBe(true);
    expect(callParts({ headers: { Authorization: 'x' } }).ok).toBe(false);
    expect(callParts({ uploads: [] }).ok).toBe(false);
    expect(callParts({ method: 'get' }).ok).toBe(false);
    expect(usdWords(0.001)).toBe('$0.001');
    expect(usdWords(12)).toBe('$12.00');
    expect(answerValue(JSON.stringify({ ok: true, result: { content: [{ type: 'text', text: '{"a":1}' }] } }), 'sdk')).toEqual({ a: 1 });
  });
});
