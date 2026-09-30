import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the real HTTP router in Node. Only native runtime boundaries are
// mocked; these tests do not qualify workerd, Durable Objects, or Code Mode.
// Any accidental native dispatch fails instead of silently returning success.
vi.mock('@cloudflare/codemode', () => ({
  DynamicWorkerExecutor: class { constructor() { throw new Error('Unexpected native executor'); } },
}));
vi.mock('agents', () => ({
  getAgentByName: () => { throw new Error('Unexpected Durable Object dispatch'); },
}));
vi.mock('agents/mcp', () => ({
  RPC_DO_PREFIX: 'test-mcp:',
  createMcpHandler: () => { throw new Error('Unexpected native MCP dispatch'); },
}));
vi.mock('../src/room.js', () => ({ SlateRoom: class {} }));
vi.mock('../src/commander.js', () => ({ Commander: class {} }));
vi.mock('../src/timmy.js', () => ({ Timmy: class {} }));

type Worker = typeof import('../src/index.js')['default'];
type Env = Parameters<Worker['fetch']>[1];
const MODEL = 'fixture/model';
const TOKEN = 'fixture-caller-token';
const env: Env = {
  OPENROUTER_API_KEY: 'fixture-upstream-key',
  TIMMY_EDGE_TOKEN: TOKEN,
  ALLOWED_MODELS: MODEL,
  RATE_LIMIT_PER_MIN: '2',
};
const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as Parameters<Worker['fetch']>[2];
let worker: Worker;
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
  // The router's rate window is module-local. Each test owns a fresh module;
  // no assertion depends on requests performed by another test.
  vi.resetModules();
  vi.spyOn(Date, 'now').mockReturnValue(120_000);
  upstream = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === 'https://openrouter.ai/api/v1/models') {
      return Response.json({ data: [{ id: MODEL, context_length: 8192, pricing: { prompt: '1', completion: '2' } }] });
    }
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      return Response.json({ choices: [{ message: { content: 'pong' } }] });
    }
    throw new Error(`Unexpected upstream URL: ${url}`);
  });
  vi.stubGlobal('fetch', upstream);
  worker = (await import('../src/index.js')).default;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function request(path: string, init: RequestInit = {}, bindings: Env = env) {
  return worker.fetch(new Request(`https://timmy-ai-proxy.test${path}`, init), bindings, context);
}
const headers = { Authorization: `Bearer ${TOKEN}` };
const chat = (body: unknown = { model: MODEL, messages: [] }) => request('/chat', {
  method: 'POST', headers, body: JSON.stringify(body),
});

describe('AI proxy HTTP routing (native boundaries mocked)', () => {
  it('serves health without authentication and reports missing bindings', async () => {
    const response = await request('/health', {}, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ auth: true, code_mode: false, daily_head: false, slate_room: false, commander: false, timmy: false });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('reports Code Mode availability from the LOADER binding without executing it', async () => {
    const response = await request('/health', {}, { ...env, LOADER: {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code_mode: true });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Bearer wrong-token'])('rejects an absent or incorrect caller token (%s)', async (authorization) => {
    const response = await request('/models', { headers: authorization ? { Authorization: authorization } : {} });
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('fails closed when the caller-token binding is missing', async () => {
    const response = await request('/models', { headers }, { ...env, TIMMY_EDGE_TOKEN: undefined });
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('serves trimmed model metadata to authenticated callers', async () => {
    const response = await request('/models', { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: MODEL, ctx: 8192, in: '1', out: '2' }]);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('preserves upstream model-list failures', async () => {
    upstream.mockResolvedValueOnce(new Response('provider unavailable', { status: 503 }));
    const response = await request('/models', { headers });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('provider unavailable');
  });

  it('rejects models outside the allowlist without spending upstream', async () => {
    const response = await chat({ model: 'fixture/disallowed', messages: [] });
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('passes allowed chat through with the upstream credential and unchanged body', async () => {
    const body = { model: MODEL, messages: [{ role: 'user', content: 'fixture message' }] };
    const response = await chat(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ choices: [{ message: { content: 'pong' } }] });
    expect(upstream).toHaveBeenCalledOnce();
    const [url, options] = upstream.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(options?.method).toBe('POST');
    expect(options?.body).toBe(JSON.stringify(body));
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer fixture-upstream-key');
  });

  it('preserves upstream error status and body verbatim', async () => {
    const body = '{"error":{"message":"upstream says no"}}';
    upstream.mockResolvedValueOnce(new Response(body, { status: 402 }));
    const response = await chat();
    expect(response.status).toBe(402);
    expect(await response.text()).toBe(body);
  });

  it('rate-limits its own third request, then admits a fresh minute', async () => {
    expect((await chat()).status).toBe(200);
    expect((await chat()).status).toBe(200);
    expect((await chat()).status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(2);
    vi.mocked(Date.now).mockReturnValue(180_001);
    expect((await chat()).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it('rejects malformed chat JSON without an upstream call', async () => {
    const response = await request('/chat', { method: 'POST', headers, body: '{' });
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('reports a missing upstream credential without attempting a request', async () => {
    const response = await request('/models', { headers }, { ...env, OPENROUTER_API_KEY: undefined });
    expect(response.status).toBe(500);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('requires authentication before dispatching Code Mode', async () => {
    const response = await request('/code', { method: 'POST', body: '{}' }, { ...env, LOADER: {} });
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses Code Mode when the native LOADER binding is absent', async () => {
    // The old removed-/code expectation predates the authenticated Code Mode
    // route. Current behavior is an explicit unavailable response, not 404.
    const response = await request('/code', { method: 'POST', headers, body: '{"code":"return 1"}' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringContaining('no LOADER') });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['/runs/fixture/events', '/commander/fixture/state', '/timmy/fixture/state'])('reports the missing native binding for %s', async (path) => {
    const response = await request(path, { headers });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringContaining('binding') });
    expect(upstream).not.toHaveBeenCalled();
  });
});
