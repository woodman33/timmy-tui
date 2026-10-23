// R5 lead: a chat model's price and abilities as this computer knows them, and the free-only policy on the one chat route
// every surface reads. FAKE catalogs; nothing asks the network.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freeModels, freeOnlyOn, freeOnlyRefusal, modelPrice } from '../src/agent/model-price.js';
import { chatRouteNow } from '../src/agent/chat-route.js';
import { catalogPath, readCache } from '../src/models/registry.js';

const CATALOG = {
  fetchedAt: '2026-10-01T08:00:00.000Z',
  models: [
    { id: 'acme/paid-1', context_length: 200000, supported_parameters: ['tools', 'temperature'], pricing: { prompt: '0.000003', completion: '0.000015' } },
    { id: 'acme/small:free', context_length: 32768, supported_parameters: ['temperature'], pricing: { prompt: '0', completion: '0' } },
    { id: 'acme/zero', context_length: 1048576, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } },
    { id: 'openrouter/auto', context_length: 2000000, pricing: { prompt: '-1', completion: '-1' } },
    { id: 'acme/odd:free', pricing: { prompt: '0.000001', completion: '0' } },
  ],
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('a model\'s price', () => {
  it('is the catalog\'s, with its date, the context and whether it takes tools', () => {
    const p = modelPrice('acme/paid-1', CATALOG);
    expect(p).toMatchObject({ free: false, from: 'catalog', catalogAt: '2026-10-01', tools: true, ctx: 200000 });
    expect(p.inPerM).toBeCloseTo(3);
    expect(p.outPerM).toBeCloseTo(15);
    expect(p.words).toBe('$3 in / $15 out per 1M tokens (OpenRouter catalog of 2026-10-01) · 200k context · tools');
  });
  it('free is both prices 0 in the catalog; 1M context reads 1.05M; no tools says so', () => {
    expect(modelPrice('acme/zero', CATALOG).words).toBe('free (OpenRouter catalog of 2026-10-01) · 1.05M context · tools');
    expect(modelPrice('acme/small:free', CATALOG)).toMatchObject({ free: true, tools: false });
  });
  it('a router\'s variable price is unknown, never free', () => {
    expect(modelPrice('openrouter/auto', CATALOG)).toMatchObject({ free: null, from: 'catalog' });
    expect(modelPrice('openrouter/auto', CATALOG).words).toContain('price unknown');
  });
  it('the catalog wins over a :free name: a :free id the catalog prices is not free', () => {
    expect(modelPrice('acme/odd:free', CATALOG).free).toBe(false);
  });
  it('a model the catalog does not list is unknown, unless OpenRouter\'s :free name says free (and then it says how it knows)', () => {
    expect(modelPrice('acme/unlisted', CATALOG)).toMatchObject({ free: null, from: 'none' });
    expect(modelPrice('acme/unlisted', CATALOG).words).toBe('price unknown: the OpenRouter catalog of 2026-10-01 does not list it (timmy models --refresh)');
    expect(modelPrice('acme/new:free', CATALOG)).toMatchObject({ free: true, from: 'name' });
    expect(modelPrice('acme/new:free', null).words).toBe('free by its :free name; this computer has no catalog to look in (timmy models --refresh)');
    expect(modelPrice('acme/unlisted', null).words).toBe('price unknown: this computer has no catalog to look in (timmy models --refresh)');
  });
  it('lists the catalog\'s free models, sorted, with their context and tools', () => {
    expect(freeModels(CATALOG)).toEqual([
      { id: 'acme/small:free', ctx: 32768, tools: false },
      { id: 'acme/zero', ctx: 1048576, tools: true },
    ]);
    expect(freeModels(null)).toEqual([]);
  });
});

describe('the catalog this computer fetched', () => {
  it('lives in the Timmy home and wins over the shipped snapshot', () => {
    const home = mkdtempSync(join(tmpdir(), 'tw-catalog-'));
    try {
      vi.stubEnv('TIMMY_HOME', home);
      const shipped = readCache();
      expect(catalogPath()).toBe(join(home, 'models', 'openrouter-catalog.json'));
      mkdirSync(join(home, 'models'), { recursive: true });
      writeFileSync(catalogPath(), JSON.stringify(CATALOG));
      expect(readCache()?.fetchedAt).toBe(CATALOG.fetchedAt);
      expect(readCache()?.fetchedAt).not.toBe(shipped?.fetchedAt ?? 'none');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('free-only', () => {
  it('is off by default; TIMMY_CHAT_FREE_ONLY turns it on or off and wins over the settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-settings-'));
    try {
      expect(freeOnlyOn({ TIMMY_SETTINGS_DIR: dir })).toBe(false);
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ freeOnly: true }));
      expect(freeOnlyOn({ TIMMY_SETTINGS_DIR: dir })).toBe(true);
      expect(freeOnlyOn({ TIMMY_SETTINGS_DIR: dir, TIMMY_CHAT_FREE_ONLY: '0' })).toBe(false);
      expect(freeOnlyOn({ TIMMY_SETTINGS_DIR: join(dir, 'none'), TIMMY_CHAT_FREE_ONLY: 'on' })).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses unknown and paid, passes free, and says why and the way out', () => {
    expect(freeOnlyRefusal('acme/zero', modelPrice('acme/zero', CATALOG))).toBeNull();
    const paid = freeOnlyRefusal('acme/paid-1', modelPrice('acme/paid-1', CATALOG))!;
    expect(paid[0]).toBe('Error: free-only is on, and acme/paid-1 is not known to be free, so this message was not sent.');
    expect(paid[1]).toBe('Cause: acme/paid-1 costs $3 in / $15 out per 1M tokens.');
    expect(paid.at(-1)).toBe('Nothing was sent to any model.');
    expect(freeOnlyRefusal('acme/unlisted', modelPrice('acme/unlisted', CATALOG))![1]).toContain('price unknown');
    expect(freeOnlyRefusal(null, null)![1]).toBe('Cause: no model is named for this surface, so its price cannot be known.');
    expect(freeOnlyRefusal('x', null, true)![2]).toMatch(/^Try: choose a free model: \/model free in the REPL lists them/);
    // R5 lead (the finish line, item 3): free-only stays on; turning it off is never the fix offered
    expect(freeOnlyRefusal('x', null, true)!.join(' ')).not.toMatch(/free-only off|TIMMY_CHAT_FREE_ONLY=0/);
  });
});

describe('the one chat route under free-only', () => {
  const price = (id: string) => modelPrice(id, CATALOG);
  // a Timmy home of the test's own (tests/isolation-setup.ts refuses the account's): the route reads the setup there
  const home = mkdtempSync(join(tmpdir(), 'tw-route-'));
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });
  const route = (model: string | null, surface: 'repl' | 'workbench' | 'companion', freeOnly: boolean) =>
    chatRouteNow({ env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: join(home, 'settings') }, key: true, openRouterModel: model, surface, freeOnly, price });
  it('off: the OpenRouter route is ready whatever the model costs, as before', () => {
    expect(route('acme/paid-1', 'repl', false).state).toMatchObject({ kind: 'openrouter', ready: true });
    expect(route('acme/paid-1', 'repl', false).state.words).not.toContain('free-only');
  });
  it('on: a free model is ready and says free-only; a paid or unknown one is refused on every surface, nothing sent', () => {
    expect(route('acme/zero', 'repl', true).state).toMatchObject({ ready: true, words: expect.stringContaining('· free-only') });
    for (const surface of ['repl', 'workbench', 'companion'] as const) {
      for (const model of ['acme/paid-1', 'acme/unlisted']) {
        const s = route(model, surface, true).state;
        expect(s, `${surface} ${model}`).toMatchObject({ kind: 'openrouter', ready: false });
        expect(s.words).toContain('free-only: not sent');
        expect(s.refusal?.at(-1)).toBe('Nothing was sent to any model.');
        expect(s.refusal?.[2]).toMatch(surface === 'repl' ? /^Try: \/model free/ : /^Try: choose a free model: \/model free in the REPL/);
      }
      // R11 (H169, Phase 0 item 1): no model at all is refused before the policy is read: nothing is sent to a model nobody chose
      const none = route(null, surface, true).state;
      expect(none).toMatchObject({ kind: 'openrouter', ready: false, words: 'chat: OpenRouter · no model chosen' });
      expect(none.refusal?.[0]).toBe('Error: No model chosen. /model <id> chooses one (/model free lists free ones).');
      expect(none.refusal?.at(-1)).toBe('Nothing was sent to any model.');
    }
  });
});
