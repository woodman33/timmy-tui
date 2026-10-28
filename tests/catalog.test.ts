/**
 * The unified Workspace order (2026-10-27): the one integration catalog (src/capabilities/catalog.ts). FAKE inventory, apps
 * and Treg rows stand in for the companion's; the native and vision finders are seams. What is checked: every registry gives
 * entries with its source kept; the six facts stay apart (installed is not callable, configuration is not discovery, a
 * metadata-only provider is never callable); similarly named OpenHands entries stay separate; the adapter modules named
 * for providers exist in this tree.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapterModuleExists, buildCatalog, CATALOG_STATES, PROVIDER_ADAPTERS } from '../src/capabilities/catalog.js';
import type { Inventory } from '../src/capabilities/inventory.js';

const fact = (ok: boolean, words: string) => ({ ok, found: words, words, source: 'FAKE' });
const INV: Inventory = {
  schema: 'timmy.capability-inventory/1', readAt: '2026-10-27T00:00:00Z', means: { available: '', configured: '', exercised: '' },
  groups: ['Models', 'Tools', 'Integrations', 'Lanes', 'Vision', 'Receipts'],
  rows: [
    { id: 'model:openrouter', name: 'OpenRouter', group: 'Models', available: fact(true, 'built in'), configured: fact(false, 'no key'), exercised: { ok: false, found: 'none', source: 'FAKE', words: 'none' }, next: 'paste a key' },
    { id: 'mcp:server:fake', name: 'fake server', group: 'Integrations', available: fact(true, 'named'), configured: fact(true, 'named in config'), exercised: { ok: false, found: 'none', source: 'FAKE', words: 'none' } },
    { id: 'agent:openhands', name: 'OpenHands, local model', group: 'Integrations', available: fact(false, 'docker not on PATH'), configured: fact(false, 'no model'), exercised: { ok: false, found: 'none', source: 'FAKE', words: 'none' } },
    { id: 'lane:opencode', name: 'OpenCode CLI', group: 'Lanes', available: fact(true, 'on PATH'), configured: fact(true, 'no key'), exercised: { ok: true, receipt: 'r1', hash: 'sha256:aa', when: 'now', what: 'dispatch', source: 'FAKE', words: 'a dispatch receipt' } },
    { id: 'receipts:chain', name: 'Receipts', group: 'Receipts', available: fact(true, ''), configured: fact(true, ''), exercised: { ok: false, found: '', source: 'FAKE', words: '' } },
  ],
};
const APPS = [
  { id: 'card-lab', title: 'Image Analysis', kind: 'image', lead: '', availability: 'hostable', hostable: true, problem: null, running: true, installed: '6f166d2d3f9e', receipts: ['abcd1234'], operations: [{ id: 'inspect-image', label: 'Inspect an image', where: ['page' as const], how: 'POST /api/apps/card-lab/handoff' }] },
  { id: 'film-room', title: 'Video Breakdown', kind: 'video', lead: '', availability: 'hostable', hostable: false, problem: 'not installed', running: false, installed: null, receipts: [], operations: [] },
];
const TREG = {
  title: 'Treg', next: 'sign in',
  installed: { ok: true, words: 'bridge here' }, signed_in: { ok: false, words: 'not signed in' }, discovered: { ok: false, words: 'not discovered' },
  ran_here: { ok: false, words: 'no call' }, qualified: { ok: false, words: 'not qualified' }, tools: [{ name: 'search', paid: false }, { name: 'call', paid: true }],
};
const catalog = () => buildCatalog({
  inventory: INV, apps: APPS, treg: TREG, env: {},
  native: (app) => (app === 'blender' ? { found: { path: '/x/blender', how: 'path' } } : { found: null }),
  vision: () => [{ id: 'openhands', name: 'OpenHands · Qwen', operations: ['probe', 'review'], executionKind: 'local-agent', installedAdapter: false, requestContract: {}, qualification: 'presence is not qualification' }],
  which: () => null,
  now: 0,
});
const entry = (id: string) => catalog().entries.find((e) => e.id === id)!;

describe('the integration catalog', () => {
  it('reads every registry and keeps each entry’s source', () => {
    const c = catalog();
    expect(c.registries.map((r) => r.registry).sort()).toEqual(['apps', 'connectors', 'inventory', 'native', 'providers', 'vision', 'workflows']);
    for (const r of c.registries) expect(r.error).toBeUndefined();
    for (const e of c.entries) {
      expect(e.sources.length).toBeGreaterThan(0);
      expect(Object.keys(e.states)).toEqual([...CATALOG_STATES]);
      expect(e.states.researched.ok).toBe(true);
    }
    expect(c.entries.some((e) => e.id === 'inventory:receipts:chain')).toBe(false);
    // a lane is named by the inventory and by LANE_RUNNERS: one entry, both sources
    expect(entry('inventory:lane:opencode').sources.map((s) => s.registry)).toEqual(['inventory', 'lanes']);
  });

  it('keeps the six facts apart', () => {
    const or = entry('inventory:model:openrouter');
    expect(or.states.installed.ok).toBe(true);
    expect(or.states.callable.ok).toBe(false); // installed, not configured: not callable
    expect(entry('inventory:mcp:server:fake').states.discovered.ok).toBeNull(); // configuration is not discovery
    expect(entry('inventory:mcp:server:fake').states.discovered.words).toMatch(/configuration, not discovery/);
    expect(entry('inventory:lane:opencode').states.verified.ok).toBe(true);
    expect(entry('native:blender').states.installed.ok).toBe(true);
    expect(entry('native:blender').states.installed.words).not.toMatch(/\/x\/blender/); // no path shown
    expect(entry('native:aerender').role).toBe('render-only');
    expect(entry('native:openscad').states.installed.ok).toBe(false);
    expect(entry('apps:card-lab').states.discovered.ok).toBe(true);
    expect(entry('apps:card-lab').states.verified.ok).toBe(true);
    expect(entry('apps:film-room').states.callable.ok).toBe(false);
    expect(entry('connectors:treg').states.configured.ok).toBe(false);
    expect(entry('connectors:treg').states.callable.ok).toBe(false);
  });

  it('a provider with no runtime adapter is metadata only and never callable', () => {
    const c = catalog();
    const providers = c.entries.filter((e) => e.kind === 'provider');
    expect(providers.length).toBeGreaterThan(5);
    const openai = entry('provider:openai');
    expect(openai.metadataOnly).toBe(true);
    expect(openai.states.callable.ok).toBe(false);
    expect(openai.operations).toEqual([]);
    for (const p of providers) if (p.metadataOnly) expect(p.states.callable.ok).toBe(false);
  });

  it('OpenHands as a Control Room harness and as the vision registry’s review stay separate entries', () => {
    const ids = catalog().entries.filter((e) => /openhands/i.test(e.id)).map((e) => e.id).sort();
    expect(ids).toEqual(['inventory:agent:openhands', 'vision:openhands']);
    expect(entry('inventory:agent:openhands').kind).toBe('harness');
    expect(entry('vision:openhands').kind).toBe('vision');
  });

  it('a missing registry says so instead of vanishing', () => {
    const c = buildCatalog({ inventory: null, inventoryError: 'boom', apps: null, treg: null, env: {}, native: () => ({ found: null }), vision: () => [], which: () => null });
    expect(c.registries.find((r) => r.registry === 'inventory')!.error).toBe('boom');
    expect(c.registries.find((r) => r.registry === 'apps')!.error).toMatch(/no app listing/);
  });

  it('the provider adapters it names exist in this tree', () => {
    for (const m of Object.values(PROVIDER_ADAPTERS)) expect(adapterModuleExists(resolve('.'), m!)).toBe(true);
  });
});
