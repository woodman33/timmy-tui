/**
 * R11 round 7 (H169): the CATALOG METADATA contract (the handoff, 14:11 PT 2026-10-24), pinned on the FAKE fixtures H171 draws
 * from (tests/fixtures/fake-catalog.ts): what the models route serves per model, read through the same loaders the route
 * uses — loadCatalog('openrouter') on the catalog file a Timmy home keeps, and loadCatalog('ollama-local') against a FAKE
 * Ollama on 127.0.0.1 — and the rule that an absent field is unknown, never invented. Nothing leaves this computer.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog, openRouterRow, queryCatalog, type CatalogRow } from '../src/models/catalog.js';
import { FAKE_CATALOG_FETCHED_AT, FAKE_OLLAMA_MODELS, FAKE_OPENROUTER_CATALOG, writeFakeOpenRouterCatalog } from './fixtures/fake-catalog.js';
import { startFakeOllama, type FakeOllama } from './fixtures/fake-ollama-chat.js';

describe('the catalog metadata the models route serves (R11 round 7, H169\'s contract), on the FAKE fixtures', () => {
  let home = '';
  let ollama: FakeOllama;
  let env: Record<string, string | undefined> = {};

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'h169-catalog-'));
    writeFakeOpenRouterCatalog(home);
    ollama = await startFakeOllama({ models: FAKE_OLLAMA_MODELS });
    env = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, OLLAMA_HOST: ollama.url };
  });
  afterAll(async () => {
    await ollama?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('OpenRouter: description, when it was added, context, the per-token prices as per-million numbers, modalities and capabilities; an alias names its target and keeps its price unknown', async () => {
    const load = await loadCatalog('openrouter', { env, refresh: 'never' });
    expect(load.fetchedAt).toBe(FAKE_CATALOG_FETCHED_AT);
    const rows = new Map(load.rows.map((r) => [r.id, r]));
    expect([...rows.keys()].sort()).toEqual(['fake-labs/fake-flagship-4', 'fake-labs/fake-latest', 'fake-labs/fake-mini:free', 'fake-router/auto', 'other-maker/fake-reasoner-2']);
    const flagship = rows.get('fake-labs/fake-flagship-4')!;
    expect(flagship).toMatchObject({
      source: 'openrouter', name: 'Fake Labs: Fake Flagship 4', maker: 'fake-labs', makerLabel: 'Fake Labs', shortName: 'Fake Flagship 4',
      created: 1760745600, contextLength: 200000,
      // USD per million tokens from the catalog's per-token strings; the image charge named as another charge
      price: { inPerM: 3, outPerM: 15, free: false, other: ['image'] },
      caps: { tools: true, vision: true, reasoning: false },
      inputModalities: ['text', 'image'], outputModalities: ['text'],
    });
    expect(flagship.description).toMatch(/^FAKE listing\. A general model/);
    // free: true only when every listed charge is zero
    expect(rows.get('fake-labs/fake-mini:free')!.price).toEqual({ inPerM: 0, outPerM: 0, free: true });
    // reasoning from the listed parameters; tools listed as absent = false (the provider listed its parameters)
    expect(rows.get('other-maker/fake-reasoner-2')!.caps).toEqual({ tools: false, vision: false, reasoning: true });
    // a router's variable price: unknown, with why
    expect(rows.get('fake-router/auto')!.price).toMatchObject({ free: 'unknown', why: expect.stringMatching(/varies|no fixed price/) });
    // the alias: no description, no price of its own, no capabilities listed (unknown), the model it points at named
    const alias = rows.get('fake-labs/fake-latest')!;
    expect(alias.aliasOf).toBe('fake-labs/fake-flagship-4');
    expect(alias.description).toBeUndefined();
    expect(alias.price.free).toBe('unknown');
    expect(alias.caps).toEqual({});
    expect(alias.contextLength).toBeUndefined();
    // newest first = when OpenRouter added it, rows without a date last
    const recent = queryCatalog(load.rows, { source: 'openrouter', sort: 'recent' }).rows.map((r) => r.id);
    expect(recent).toEqual(['fake-labs/fake-latest', 'fake-labs/fake-flagship-4', 'fake-labs/fake-mini:free', 'other-maker/fake-reasoner-2', 'fake-router/auto']);
    // the filters: a capability keeps only a row whose cap is true; cost=free keeps only the known free
    expect(queryCatalog(load.rows, { source: 'openrouter', sort: 'name', capability: 'vision' }).rows.map((r) => r.id)).toEqual(['fake-labs/fake-flagship-4']);
    expect(queryCatalog(load.rows, { source: 'openrouter', sort: 'name', cost: 'free' }).rows.map((r) => r.id)).toEqual(['fake-labs/fake-mini:free']);
    expect(queryCatalog(load.rows, { source: 'openrouter', sort: 'name', cost: 'paid' }).rows.map((r) => r.id).sort()).toEqual(['fake-labs/fake-flagship-4', 'other-maker/fake-reasoner-2']);
  });

  it('a listing with no parameters, no modalities and no price keeps every one of them unknown (never false, never 0)', () => {
    const row: CatalogRow = openRouterRow({ id: 'nobody/says-nothing', name: 'Nobody: Says Nothing' });
    expect(row.caps).toEqual({});
    expect(row.price.free).toBe('unknown');
    expect(row.price.inPerM).toBeUndefined();
    expect(row.description).toBeUndefined();
    expect(row.created).toBeUndefined();
    expect(row.contextLength).toBeUndefined();
    expect(row.inputModalities).toBeUndefined();
  });

  it('Ollama on this computer (FAKE): installed, no charge, the family as the maker, the weights\' size, parameter size and quantization, the capabilities /api/show lists (a model whose answer lists none is not a chat row); the cloud-backed name apart', async () => {
    const load = await loadCatalog('ollama-local', { env, refresh: 'never', timeoutMs: 2000 });
    expect(load.from).toBe('live');
    const rows = new Map(load.rows.map((r) => [r.id, r]));
    expect(rows.get('fake-qwen3:8b')).toMatchObject({
      source: 'ollama-local', name: 'fake-qwen3:8b', maker: 'qwen3', makerLabel: 'qwen3', installed: true,
      price: { inPerM: 0, outPerM: 0, free: true }, caps: { tools: true, vision: false, reasoning: true },
      sizeBytes: 5_225_000_000, parameterSize: '8.2B', quantization: 'Q4_K_M',
    });
    expect(rows.get('fake-llava:7b')!.caps).toEqual({ tools: false, vision: true, reasoning: false });
    // no capabilities field at all (an older Ollama's answer): /api/show does not establish local completion weights, so it is
    // not a local chat model row (src/models/ollama-list.ts); the listing says how many were left out, nothing is guessed
    expect(rows.has('fake-tiny:1b')).toBe(false);
    expect(JSON.stringify({ ...load, rows: [] })).toMatch(/did not pass Ollama's \/api\/show check/);
    // Ollama gives no description and no "added" date: unknown
    for (const r of load.rows) { expect(r.description).toBeUndefined(); expect(r.created).toBeUndefined(); }
    // the cloud-backed name is not a local chat model row of this source
    expect(rows.has('fake-big:120b-cloud')).toBe(false);
    // what the FAKE was asked: its list and each model's /api/show (no model ran)
    expect(ollama.requests.every((r) => r.path === '/api/tags' || r.path === '/api/show' || r.path === '/api/ps')).toBe(true);
    expect(ollama.chats()).toEqual([]);
  });
});
