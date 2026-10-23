/**
 * R10 (H169): the Models rail's catalog (src/models/catalog.ts). Its OpenRouter rows are read from a trimmed copy of
 * OpenRouter's public catalog of 2026-10-22 (tests/fixtures/openrouter-public-catalog-2026-10-22.json: the answer of the
 * keyless GET https://openrouter.ai/api/v1/models, 12 of its models). Nothing here reaches the network: every request goes to
 * a FAKE fetch given to the code (one that fails the test when it is called shows that nothing was asked).
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addedWords, capsWords, catalogPath, clearFilters, defaultQuery, filtered, loadCatalog, makersOf, ollamaRow, openRouterRow, priceWords,
  queryCatalog, readCatalogCache, SORT_LABEL, withSort, writeCatalogCache, type CatalogRow, type OpenRouterCatalogModel,
} from '../src/models/catalog.js';
import { listModelsSync, readCache } from '../src/models/registry.js';
import { modelPrice, freeModels } from '../src/agent/model-price.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'openrouter-public-catalog-2026-10-22.json');
const PUBLIC = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { data: OpenRouterCatalogModel[] };
const ROWS: CatalogRow[] = PUBLIC.data.map(openRouterRow);
const row = (id: string): CatalogRow => { const r = ROWS.find((x) => x.id === id); if (!r) throw new Error(`no ${id}`); return r; };

/** A FAKE fetch: answers from `route`, records every request; `never` fails the test when anything is asked. */
function fakeFetch(route: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers ?? {});
    calls.push({ url, headers: Object.fromEntries(h.entries()) });
    return route(url, init);
  }) as typeof fetch;
  return { f, calls };
}
const never = (() => { throw new Error('FAKE fetch: no request may be made here'); }) as unknown as typeof fetch;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let home = '';
let env: Record<string, string | undefined> = {};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'h169-catalog-'));
  env = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: join(home, 'settings') };
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('OpenRouter rows: what the public catalog says, nothing guessed', () => {
  it('keeps the description, when OpenRouter added it, the context and the prices per million tokens', () => {
    const r = row('minimax/minimax-m3.1-flash');
    expect(r.description).toMatch(/^MiniMax/);
    expect(r.created).toBe(1792379569);
    expect(addedWords(r)).toBe('added to OpenRouter 2026-10-19');
    expect(r.contextLength).toBe(1_000_000);
    expect(r.price.inPerM).toBeCloseTo(0.15, 10);
    expect(r.price.outPerM).toBeCloseTo(0.6, 10);
    expect(r.price.free).toBe(false);
    expect(priceWords(r)).toBe('$0.15 in / $0.6 out per 1M tokens');
  });

  it('is free only when every price is zero; a router\'s -1 price is unknown, never free', () => {
    expect(row('recursive/flint-v1.0:free').price).toEqual({ inPerM: 0, outPerM: 0, free: true });
    expect(row('nvidia/nemotron-3.5-super-vl:free').price.free).toBe(true);
    const router = row('typesafe/jev-router');
    expect(router.price.free).toBe('unknown');
    expect(router.price.inPerM).toBeUndefined();
    expect(priceWords(router)).toMatch(/^price unknown \(the catalog gives no fixed price/);
    // a zero completion price does not make a model free when its prompt costs
    expect(row('scaledown/summarize').price.free).toBe(false);
    // a missing price is unknown
    expect(openRouterRow({ id: 'fake/no-price' }).price).toMatchObject({ free: 'unknown', why: 'the catalog lists no price for it' });
  });

  it('names the other charges and prices that vary, so free-only never overlooks them', () => {
    const argon = row('google/gemini-4-argon');
    expect(argon.price.other).toEqual(expect.arrayContaining(['web_search', 'image', 'internal_reasoning']));
    expect(priceWords(argon)).toContain('also charges');
    expect(row('deepseek/deepseek-v4.1-flash-1017').price.varies).toBe(true);
    expect(priceWords(row('anthropic/claude-haiku-5.5'))).toContain('other prices at some hours or prompt sizes');
    // FAKE: token prices of zero with a charge per request is not free
    expect(openRouterRow({ id: 'fake/request-fee', pricing: { prompt: '0', completion: '0', request: '0.001' } }).price.free).toBe(false);
  });

  it('reads capabilities from supported_parameters and input_modalities, unknown when a field is absent', () => {
    const moon = row('moondream/moondream3-preview');
    expect(moon.caps).toEqual({ tools: false, reasoning: true, vision: true });
    expect(row('recursive/flint-v1.0:free').caps).toEqual({ tools: true, reasoning: true, vision: false });
    expect(row('scaledown/summarize').caps.tools).toBe(false);
    const bare = openRouterRow({ id: 'fake/bare', name: 'FAKE: Bare' });
    expect(bare.caps).toEqual({});
    expect(capsWords(bare)).toBe('tools unknown · vision unknown · reasoning unknown');
    expect(capsWords(moon)).toBe('no tools · vision · reasoning');
  });

  it('takes the maker from the id (an alias\'s ~ dropped) and its label from the name\'s "Maker: " prefix', () => {
    const haiku = row('anthropic/claude-haiku-5.5');
    expect(haiku).toMatchObject({ maker: 'anthropic', makerLabel: 'Anthropic', shortName: 'Claude Haiku 5.5', name: 'Anthropic: Claude Haiku 5.5' });
    const alias = row('~unbiased/pareto-latest');
    expect(alias).toMatchObject({ maker: 'unbiased', shortName: 'Pareto Latest', aliasOf: 'unbiased/pareto-26.10' });
    expect(alias.makerLabel).toBeUndefined();
    expect(row('google/gemini-nano-banana-2.1').outputModalities).toEqual(['image', 'text']);
  });
});

describe('queryCatalog: Recently added, search, Maker, Capability, Cost, Context', () => {
  it('opens on Recently added: when OpenRouter added it, newest first', () => {
    const q = defaultQuery('openrouter');
    expect(q).toEqual({ source: 'openrouter', sort: 'recent' });
    expect(SORT_LABEL[q.sort]).toBe('Recently added');
    const r = queryCatalog(ROWS, q);
    expect(r.total).toBe(12);
    expect(r.rows.map((x) => x.id).slice(0, 3)).toEqual(['recursive/flint-v1.0:free', 'minimax/minimax-m3.1-flash', 'deepseek/deepseek-v4.1-flash-1017']);
    const created = r.rows.map((x) => x.created ?? 0);
    expect([...created].sort((a, b) => b - a)).toEqual(created);
  });

  it('shows text-output models unless every output kind is asked for', () => {
    const fakeImage = openRouterRow({ id: 'fake/image-only', name: 'FAKE: Image Only', created: 1792700000, architecture: { output_modalities: ['image'] }, pricing: { prompt: '0', completion: '0' } });
    const rows = [...ROWS, fakeImage];
    expect(queryCatalog(rows, defaultQuery('openrouter')).rows.some((x) => x.id === 'fake/image-only')).toBe(false);
    const all = queryCatalog(rows, { ...defaultQuery('openrouter'), output: 'all' });
    expect(all.rows[0].id).toBe('fake/image-only');
    expect(all.total).toBe(13);
    // a model that answers in text and images is a text-output model
    expect(queryCatalog(rows, defaultQuery('openrouter')).rows.some((x) => x.id === 'google/gemini-nano-banana-2.1')).toBe(true);
  });

  it('searches the name, the id and the maker, every word, apart from the filters', () => {
    const ids = (search: string) => queryCatalog(ROWS, { source: 'openrouter', sort: 'name', search }).rows.map((x) => x.id);
    expect(ids('pareto')).toEqual(['unbiased/pareto-26.10', '~unbiased/pareto-latest']);
    expect(ids('ANTHROPIC')).toEqual(['anthropic/claude-haiku-5.5']);
    expect(ids('claude haiku')).toEqual(['anthropic/claude-haiku-5.5']);
    expect(ids('unbiased')).toHaveLength(2);
    expect(ids('nothing-like-this')).toEqual([]);
  });

  it('filters by maker, capability, cost and context; an unknown is in no filter', () => {
    const q = (o: object) => queryCatalog(ROWS, { source: 'openrouter', sort: 'name', ...o }).rows.map((x) => x.id);
    expect(q({ maker: 'google' })).toEqual(['google/gemini-4-argon', 'google/gemini-nano-banana-2.1']);
    expect(q({ capability: 'tools' })).not.toContain('moondream/moondream3-preview');
    expect(q({ capability: 'tools' })).not.toContain('scaledown/summarize');
    expect(q({ capability: 'vision' })).not.toContain('recursive/flint-v1.0:free');
    expect(q({ cost: 'free' })).toEqual(['nvidia/nemotron-3.5-super-vl:free', 'recursive/flint-v1.0:free']);
    expect(q({ cost: 'paid' })).not.toContain('typesafe/jev-router');
    expect(q({ cost: 'free' })).not.toContain('typesafe/jev-router');
    expect(q({ minContext: 1_000_000 }).every((id) => (row(id).contextLength ?? 0) >= 1_000_000)).toBe(true);
    expect(q({ minContext: 1_000_000 })).not.toContain('moondream/moondream3-preview');
  });

  it('never resets the filters or the search when the sort changes', () => {
    const base = { source: 'openrouter' as const, sort: 'recent' as const, capability: 'tools' as const, cost: 'paid' as const, minContext: 200_000, search: 'flash' };
    const set = (q: typeof base | ReturnType<typeof withSort>) => queryCatalog(ROWS, q).rows.map((x) => x.id).sort();
    const recent = set(base);
    expect(recent.length).toBeGreaterThan(1);
    for (const sort of ['name', 'price', 'context', 'recent'] as const) {
      const q = withSort(base, sort);
      expect(q).toEqual({ ...base, sort });
      expect(set(q)).toEqual(recent);
    }
  });

  it('sorts by price (free first, unknown last) and by context (largest first, unknown last)', () => {
    const price = queryCatalog(ROWS, { source: 'openrouter', sort: 'price' }).rows;
    expect(price[0].price.free).toBe(true);
    expect(price.at(-1)?.id).toBe('typesafe/jev-router');
    const ins = price.filter((r) => r.price.free !== 'unknown').map((r) => r.price.inPerM ?? 0);
    expect([...ins].sort((a, b) => a - b)).toEqual(ins);
    const fakeNoCtx = openRouterRow({ id: 'fake/no-context', name: 'FAKE: No Context' });
    const ctx = queryCatalog([...ROWS, fakeNoCtx], { source: 'openrouter', sort: 'context' }).rows;
    expect(ctx.at(-1)?.id).toBe('fake/no-context');
    expect(ctx[0].contextLength).toBe(1_048_576);
  });

  it('lists the makers with their labels and counts, and clears filters without losing the sort', () => {
    const makers = makersOf(ROWS);
    expect(makers).toEqual(expect.arrayContaining([{ id: 'anthropic', label: 'Anthropic', count: 1 }, { id: 'google', label: 'Google', count: 2 }, { id: 'unbiased', label: 'unbiased', count: 2 }]));
    expect(queryCatalog(ROWS, defaultQuery('openrouter')).makers).toEqual(makers);
    const q = { source: 'openrouter' as const, sort: 'price' as const, maker: 'google', search: 'x' };
    expect(filtered(q)).toBe(true);
    expect(clearFilters(q)).toEqual({ source: 'openrouter', sort: 'price' });
    expect(filtered(clearFilters(q))).toBe(false);
  });

  it('keeps the sources apart', () => {
    const local = ollamaRow({ name: 'fake-qwen3:8b', capabilities: ['completion', 'tools'], family: 'qwen3' }, 'ollama-local');
    expect(queryCatalog([...ROWS, local], defaultQuery('ollama-local')).rows.map((x) => x.id)).toEqual(['fake-qwen3:8b']);
    expect(queryCatalog([...ROWS, local], defaultQuery('openrouter')).total).toBe(12);
  });
});

describe('loadCatalog(openrouter): the public GET, kept with its date, kept again when the network fails', () => {
  it('fetches the keyless catalog, keeps it in the Timmy home with when it was fetched', async () => {
    const fake = fakeFetch(() => json(PUBLIC));
    const r = await loadCatalog('openrouter', { env, fetch: fake.f, refresh: 'always', now: () => Date.parse('2026-10-22T23:50:00Z') });
    expect(r).toMatchObject({ from: 'live', fetchedAt: '2026-10-22T23:50:00.000Z', asked: true });
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(12);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe('https://openrouter.ai/api/v1/models');
    expect(fake.calls[0].headers.authorization).toBeUndefined();
    const kept = readCatalogCache(env);
    expect(kept?.kind).toBe('fetched');
    expect(kept?.cache.fetchedAt).toBe('2026-10-22T23:50:00.000Z');
    expect(statSync(catalogPath(env)).isFile()).toBe(true);
  });

  it('keeps the last good copy, dated, when the network fails, and says why', async () => {
    writeCatalogCache({ fetchedAt: '2026-10-21T08:00:00.000Z', models: PUBLIC.data.slice(0, 3) }, env);
    const before = readFileSync(catalogPath(env), 'utf8');
    const down = fakeFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); });
    const r = await loadCatalog('openrouter', { env, fetch: down.f, refresh: 'always' });
    expect(r).toMatchObject({ from: 'cache', cache: 'fetched', fetchedAt: '2026-10-21T08:00:00.000Z', asked: true });
    expect(r.rows).toHaveLength(3);
    expect(r.error).toBe('the catalog could not be fetched: the connection failed (ENOTFOUND); showing the copy fetched 2026-10-21 08:00');
    expect(readFileSync(catalogPath(env), 'utf8')).toBe(before);
    // an HTTP error keeps it too
    const busy = fakeFetch(() => json({ error: 'busy' }, 503));
    const r2 = await loadCatalog('openrouter', { env, fetch: busy.f, refresh: 'always' });
    expect(r2.from).toBe('cache');
    expect(r2.error).toContain('OpenRouter answered HTTP 503');
    expect(readFileSync(catalogPath(env), 'utf8')).toBe(before);
  });

  it('asks nothing when told never, or when the kept copy is fresh', async () => {
    writeCatalogCache({ fetchedAt: '2026-10-22T20:00:00.000Z', models: PUBLIC.data }, env);
    expect(await loadCatalog('openrouter', { env, fetch: never, refresh: 'never' })).toMatchObject({ from: 'cache', asked: false });
    const fresh = await loadCatalog('openrouter', { env, fetch: never, now: () => Date.parse('2026-10-22T21:00:00Z') });
    expect(fresh).toMatchObject({ from: 'cache', asked: false });
    // a day old: asked again
    const stale = fakeFetch(() => json(PUBLIC));
    await loadCatalog('openrouter', { env, fetch: stale.f, now: () => Date.parse('2026-10-24T21:00:00Z') });
    expect(stale.calls).toHaveLength(1);
  });

  it('falls back to the snapshot shipped with Timmy, named so, when this computer fetched none', async () => {
    const r = await loadCatalog('openrouter', { env, fetch: never, refresh: 'never' });
    expect(r.from).toBe('cache');
    expect(r.cache).toBe('shipped');
    expect(r.rows.length).toBeGreaterThan(100);
  });

  it('asks for every output kind only when asked, and keeps that copy apart; with nothing kept and no network, none', async () => {
    const down = fakeFetch(() => { throw new TypeError('fetch failed'); });
    const none = await loadCatalog('openrouter', { env, fetch: down.f, output: 'all', refresh: 'always' });
    expect(none).toMatchObject({ from: 'none', rows: [] });
    expect(down.calls[0].url).toBe('https://openrouter.ai/api/v1/models?output_modalities=all');
    const ok = fakeFetch(() => json(PUBLIC));
    await loadCatalog('openrouter', { env, fetch: ok.f, output: 'all', refresh: 'always' });
    expect(existsSync(catalogPath(env, 'all'))).toBe(true);
    expect(existsSync(catalogPath(env))).toBe(false);
  });

  it('never changes the chat\'s model: no settings file is written, whatever the fetch did', async () => {
    const settings = join(env.TIMMY_SETTINGS_DIR!, 'config.json');
    mkdirSync(env.TIMMY_SETTINGS_DIR!, { recursive: true });
    writeFileSync(settings, JSON.stringify({ model: 'fake/selected-model' }));
    await loadCatalog('openrouter', { env, fetch: fakeFetch(() => { throw new TypeError('fetch failed'); }).f, refresh: 'always' });
    await loadCatalog('openrouter', { env, fetch: fakeFetch(() => json(PUBLIC)).f, refresh: 'always' });
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ model: 'fake/selected-model' });
  });
});

describe('one data path: the picker\'s registry and the price read the same catalog', () => {
  it('the registry keeps description and created, and the price rule is the catalog\'s', () => {
    const cache = { fetchedAt: '2026-10-22T23:50:00.000Z', models: PUBLIC.data };
    const prev = process.env.TIMMY_HOME;
    process.env.TIMMY_HOME = home;
    try {
      writeCatalogCache(cache, { TIMMY_HOME: home });
      expect(readCache()?.fetchedAt).toBe('2026-10-22T23:50:00.000Z');
      const entry = listModelsSync().find((e) => e.id === 'anthropic/claude-haiku-5.5');
      expect(entry?.description).toMatch(/^Claude Haiku 5\.5/);
      expect(entry?.created).toBe(1791397883);
    } finally {
      if (prev === undefined) delete process.env.TIMMY_HOME; else process.env.TIMMY_HOME = prev;
    }
    expect(modelPrice('typesafe/jev-router', cache).free).toBeNull();
    expect(modelPrice('recursive/flint-v1.0:free', cache).free).toBe(true);
    expect(modelPrice('scaledown/summarize', cache).free).toBe(false);
    expect(freeModels(cache).map((m) => m.id)).toEqual(['nvidia/nemotron-3.5-super-vl:free', 'recursive/flint-v1.0:free']);
  });
});

describe('loadCatalog(ollama-local): the loopback Ollama\'s own models, never a cloud one', () => {
  const show: Record<string, unknown> = {
    'fake-qwen3:8b': { capabilities: ['completion', 'tools', 'thinking'], details: { format: 'gguf', family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' }, model_info: { 'qwen3.context_length': 40960 } },
    'fake-remote:latest': { capabilities: ['completion'], details: { format: 'gguf' }, remote_host: 'https://ollama.com:443' },
    'fake-gemma:2b': { capabilities: ['completion', 'vision'], details: { format: 'gguf', family: 'gemma3' }, model_info: {} },
  };
  const ollama = (o: { ps?: boolean } = {}) => fakeFetch(async (url, init) => {
    if (url.endsWith('/api/tags')) return json({ models: [{ name: 'fake-qwen3:8b', size: 5_225_000_000, details: { family: 'qwen3' } }, { name: 'kimi-k2:cloud' }, { name: 'fake-remote:latest' }, { name: 'fake-gemma:2b', size: 1_600_000_000 }] });
    if (url.endsWith('/api/show')) { const m = JSON.parse(String(init?.body ?? '{}')).model as string; return show[m] ? json(show[m]) : json({ error: 'not found' }, 404); }
    if (url.endsWith('/api/ps') && o.ps !== false) return json({ models: [{ name: 'fake-qwen3:8b', model: 'fake-qwen3:8b' }] });
    return json({ error: 'no' }, 404);
  });

  it('lists the models that pass /api/show as local weights, with their facts and which is loaded now', async () => {
    const fake = ollama();
    const r = await loadCatalog('ollama-local', { env, fetch: fake.f, ollamaHost: 'http://127.0.0.1:4483' });
    expect(r.from).toBe('live');
    expect(r.rows.map((x) => x.id).sort()).toEqual(['fake-gemma:2b', 'fake-qwen3:8b']);
    const qwen = r.rows.find((x) => x.id === 'fake-qwen3:8b')!;
    expect(qwen).toMatchObject({ source: 'ollama-local', installed: true, running: true, sizeBytes: 5_225_000_000, contextLength: 40960, maker: 'qwen3', parameterSize: '8.2B', quantization: 'Q4_K_M' });
    expect(qwen.caps).toEqual({ tools: true, vision: false, reasoning: true });
    expect(qwen.price).toEqual({ inPerM: 0, outPerM: 0, free: true });
    expect(priceWords(qwen)).toBe('no charge (local)');
    expect(r.rows.find((x) => x.id === 'fake-gemma:2b')).toMatchObject({ running: false, caps: { tools: false, vision: true, reasoning: false } });
    expect(r.error).toBe('Ollama lists 4: 1 cloud model is not local; 1 did not pass Ollama\'s /api/show check as local weights');
    expect(fake.calls.every((c) => c.url.startsWith('http://127.0.0.1:4483/'))).toBe(true);
  });

  it('leaves running unknown when /api/ps does not answer', async () => {
    const r = await loadCatalog('ollama-local', { env, fetch: ollama({ ps: false }).f, ollamaHost: '127.0.0.1:4483' });
    expect(r.rows.every((x) => x.running === undefined)).toBe(true);
  });

  it('says none, with why, when Ollama does not answer; asks nothing of an address that is not this computer', async () => {
    const down = fakeFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', syscall: 'connect' } }); });
    const r = await loadCatalog('ollama-local', { env, fetch: down.f, ollamaHost: 'http://127.0.0.1:4484' });
    expect(r).toMatchObject({ from: 'none', rows: [] });
    expect(r.error).toBe('Ollama at http://127.0.0.1:4484 did not answer (the connection failed (ECONNREFUSED))');
    const away = await loadCatalog('ollama-local', { env, fetch: never, ollamaHost: 'https://ollama.com' });
    expect(away).toMatchObject({ from: 'none', asked: false });
    expect(away.error).toMatch(/^Ollama was not asked: Local Ollama requires a loopback/);
  });
});

describe('loadCatalog(ollama-cloud): the hosted list, with the key in the header only', () => {
  it('asks nothing without a key, and says how to set one up', async () => {
    const r = await loadCatalog('ollama-cloud', { env, fetch: never });
    expect(r).toMatchObject({ from: 'none', asked: false, rows: [] });
    expect(r.error).toMatch(/^Ollama Cloud is not set up: no key/);
  });

  it('lists the cloud models as remote rows (no local weights, price unknown), the key sent as a Bearer header', async () => {
    const fake = fakeFetch(() => json({ models: [{ name: 'gpt-oss:120b', details: { family: 'gptoss', parameter_size: '116.8B' } }, { name: 'bad name' }] }));
    const r = await loadCatalog('ollama-cloud', { env, fetch: fake.f, ollamaCloudKey: () => 'FAKE-ollama-key-0001' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe('https://ollama.com/api/tags');
    expect(fake.calls[0].url).not.toContain('FAKE-ollama-key');
    expect(fake.calls[0].headers.authorization).toBe('Bearer FAKE-ollama-key-0001');
    expect(r.from).toBe('live');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ source: 'ollama-cloud', id: 'gpt-oss:120b', installed: false, price: { free: 'unknown' } });
    expect(r.rows[0].running).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('FAKE-ollama-key');
  });

  it('says a refused key in words, and keeps the key out of them', async () => {
    const r = await loadCatalog('ollama-cloud', { env, fetch: fakeFetch(() => json({ error: 'unauthorized' }, 401)).f, ollamaCloudKey: () => 'FAKE-ollama-key-0002' });
    expect(r).toMatchObject({ from: 'none', asked: true });
    expect(r.error).toBe('Ollama Cloud\'s list could not be read: Ollama refused the key (HTTP 401)');
    expect(JSON.stringify(r)).not.toContain('FAKE-ollama-key');
  });
});

describe('the Ollama the local rows ask is the one the chat asks', () => {
  it('ollamaAddressNow (src/models/ollama-list.ts) equals ollamaAddress (src/capabilities/ollama-route.ts) for each setup', async () => {
    const { ollamaAddress } = await import('../src/capabilities/ollama-route.js');
    const { ollamaAddressNow } = await import('../src/models/ollama-list.js');
    const cases: Array<{ env: Record<string, string>; setup?: unknown; providers?: unknown; want: string }> = [
      { env: {}, want: 'http://127.0.0.1:11434' },
      { env: { OLLAMA_HOST: '127.0.0.1:4483' }, want: '127.0.0.1:4483' },
      { env: { OLLAMA_BASE_URL: 'http://127.0.0.1:4484/' }, want: 'http://127.0.0.1:4484' },
      { env: { OLLAMA_HOST: '127.0.0.1:4483' }, setup: { answers: { chat: 'local', ollama: '127.0.0.1:4484', model: 'fake-qwen3:8b' } }, want: 'http://127.0.0.1:4484' },
      { env: {}, setup: { answers: { chat: 'local', model: 'fake-qwen3:8b' } }, providers: { ollama_host: 'http://localhost:4483' }, want: 'http://localhost:4483' },
      { env: { OLLAMA_HOST: '127.0.0.1:4483' }, setup: { answers: { chat: 'openrouter' } }, want: '127.0.0.1:4483' },
    ];
    for (const [i, c] of cases.entries()) {
      const h = join(home, `case-${i}`);
      mkdirSync(h, { recursive: true });
      if (c.setup) writeFileSync(join(h, 'setup.json'), JSON.stringify(c.setup));
      if (c.providers) writeFileSync(join(h, 'providers.json'), JSON.stringify(c.providers));
      const e = { TIMMY_HOME: h, TIMMY_SETTINGS_DIR: join(h, 'settings'), ...c.env };
      expect({ i, now: ollamaAddressNow(e), route: ollamaAddress(e) }).toEqual({ i, now: c.want, route: c.want });
    }
  });
});
