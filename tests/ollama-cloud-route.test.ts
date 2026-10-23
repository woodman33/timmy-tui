/**
 * R11 Phase 2 (H169, item c): Ollama's cloud as a route. The ":cloud" names the Ollama on this computer lists (/api/tags) run
 * on Ollama's servers under the person's Ollama account, through that Ollama. They are catalog rows of their own (source
 * 'ollama-cloud', via this computer's Ollama), under the heading "Ollama cloud (your Ollama account)", priced only as "runs on
 * Ollama's servers; your account's terms" (never "free", never "no charge"); the route is named "ollama cloud · <name>" on
 * every surface that says a route (the one route's words, the page's label and words, init's line, the receipt); local-only
 * refuses it with one sentence.
 *
 * FAKE: an Ollama on 127.0.0.1 that lists the names (/api/tags, /api/show, /api/ps; no model behind it). No live call to any
 * cloud model is made here or anywhere: nothing leaves this computer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatRouteNow } from '../src/agent/chat-route.js';
import { pageRoute } from '../src/companion/chat-route.js';
import { loadCatalog, OLLAMA_CLOUD_HEADING, OLLAMA_CLOUD_TERMS, ollamaCloudRoute } from '../src/models/catalog.js';
import { listLocalOllama } from '../src/models/ollama-list.js';
import { startFakeOllama, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const CLOUD = 'fake-kimi:cloud';
const LOCAL = 'fake-qwen3:8b';
let box = '';
let ollama: FakeOllama;
const env = (): Record<string, string | undefined> => ({ TIMMY_HOME: join(box, 'home'), TIMMY_SETTINGS_DIR: join(box, 'settings'), TIMMY_CHAT_FREE_ONLY: '', TIMMY_CHAT_LOCAL_ONLY: '' });
/** The setup as `timmy init --chat local --model <m>` records it, at the FAKE's address. */
const setUp = (model: string): void => {
  mkdirSync(join(box, 'home'), { recursive: true });
  writeFileSync(join(box, 'home', 'providers.json'), JSON.stringify({ ollama_host: ollama.url }));
  writeFileSync(join(box, 'home', 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: ollama.url, project: 'demo', chat: 'local', model } }));
};

beforeEach(async () => {
  box = mkdtempSync(join(tmpdir(), 'h169-ollama-cloud-'));
  ollama = await startFakeOllama({ models: [{ name: LOCAL, capabilities: ['completion', 'tools'] }, { name: CLOUD, remote_host: 'https://ollama.example:443' }] });
  vi.stubEnv('TIMMY_HOME', join(box, 'home'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await ollama.close();
  rmSync(box, { recursive: true, force: true });
});

describe('the words', () => {
  it('the heading, the terms and the route\'s name', () => {
    expect(OLLAMA_CLOUD_HEADING).toBe('Ollama cloud (your Ollama account)');
    expect(OLLAMA_CLOUD_TERMS).toBe('runs on Ollama\'s servers; your account\'s terms');
    expect(ollamaCloudRoute(CLOUD)).toBe('ollama cloud · fake-kimi:cloud');
    expect(`${OLLAMA_CLOUD_HEADING} ${OLLAMA_CLOUD_TERMS}`).not.toMatch(/free|no charge/);
  });
});

describe('the catalog', () => {
  it('the local listing keeps the ":cloud" names apart from the local models (no /api/show asked of them)', async () => {
    const l = await listLocalOllama({ baseUrl: ollama.url, timeoutMs: 2000 });
    expect(l.answered).toBe(true);
    expect(l.models.map((m) => m.name)).toEqual([LOCAL]);
    // what /api/tags said of it (the FAKE's details), nothing more: no /api/show, no capabilities, not loaded-or-not
    expect(l.cloud).toEqual([{ name: CLOUD, capabilities: null, contextLength: null, family: null, parameterSize: '8B', quantizationLevel: 'Q4_K_M', sizeBytes: 5_200_000_000, running: null }]);
    expect(l.why).toBe('Ollama lists 2: 1 cloud model is not local');
    expect(ollama.requests.filter((r) => r.path === '/api/show').map((r) => r.body.model)).toEqual([LOCAL]);
  });

  it('loadCatalog(\'ollama-cloud\'): the ":cloud" names as rows via this computer\'s Ollama, with the account\'s terms, no key needed; the hosted list said not set up', async () => {
    const load = await loadCatalog('ollama-cloud', { env: env(), ollamaHost: ollama.url, timeoutMs: 2000, ollamaCloudKey: () => null });
    expect(load.from).toBe('live');
    expect(load.rows).toHaveLength(1);
    expect(load.rows[0]).toMatchObject({ source: 'ollama-cloud', id: CLOUD, name: CLOUD, installed: false, cloudVia: 'this computer\'s Ollama', price: { free: 'unknown', why: OLLAMA_CLOUD_TERMS } });
    expect(load.rows[0].price).not.toHaveProperty('inPerM');
    expect(load.error).toBe(`1 cloud model through this computer's Ollama (${OLLAMA_CLOUD_TERMS}); Ollama Cloud's own list is not set up: no key (an Ollama account's key, from ollama.com/settings/keys)`);
    expect(`${load.rows[0].price.why} ${load.error}`).not.toMatch(/no charge|: free|free\b/);
    // the local rows never hold it
    const local = await loadCatalog('ollama-local', { env: env(), ollamaHost: ollama.url, timeoutMs: 2000 });
    expect(local.rows.map((r) => r.id)).toEqual([LOCAL]);
    // no cloud name listed: said so, with how one is added
    const none = await startFakeOllama({ models: [{ name: LOCAL }] });
    try {
      const empty = await loadCatalog('ollama-cloud', { env: env(), ollamaHost: none.url, timeoutMs: 2000, ollamaCloudKey: () => null });
      expect(empty.rows).toEqual([]);
      expect(empty.error).toMatch(/^this computer's Ollama lists no cloud model \(ollama pull <name>:cloud adds one; it runs under your Ollama account\); Ollama Cloud's own list is not set up/);
    } finally { await none.close(); }
  });
});

describe('the route on every surface this owner has', () => {
  it('the one route names it "ollama cloud · <name>" and is ready; local-only refuses it with one sentence; free-only too (its price is the account\'s terms, never free)', () => {
    setUp(CLOUD);
    const now = chatRouteNow({ env: env(), surface: 'repl' });
    expect(now.route).toMatchObject({ kind: 'local', model: CLOUD, cloud: true });
    expect(now.state).toMatchObject({ kind: 'local', ready: true, words: 'chat: ollama cloud · fake-kimi:cloud' });
    const localOnly = chatRouteNow({ env: { ...env(), TIMMY_CHAT_LOCAL_ONLY: '1' }, surface: 'repl' });
    expect(localOnly.state).toMatchObject({ ready: false, words: 'chat: ollama cloud · fake-kimi:cloud · local-only: not sent' });
    expect(localOnly.state.refusal?.[1]).toBe(`Cause: ${CLOUD} is a cloud model: the Ollama at ${ollama.host} sends it to Ollama's cloud.`);
    expect(localOnly.state.refusal?.[1]?.match(/\. /g) ?? []).toHaveLength(0);
    const freeOnly = chatRouteNow({ env: { ...env(), TIMMY_CHAT_FREE_ONLY: '1' }, surface: 'repl' });
    expect(freeOnly.state).toMatchObject({ ready: false, words: 'chat: ollama cloud · fake-kimi:cloud · free-only: not sent' });
    expect(freeOnly.state.refusal?.[1]).toMatch(/^Cause: fake-kimi:cloud's price is not known \(Ollama's cloud bills by its plans: no price per request is known here\), and unknown is never free\.$/);
    // a local model is unchanged
    setUp(LOCAL);
    expect(chatRouteNow({ env: env(), surface: 'repl' }).state.words).toBe('chat: local fake-qwen3:8b · Ollama');
  });

  it('the companion page: its label names the route, its words say the terms, never free or no charge; local-only turns Send off with the sentence', () => {
    setUp(CLOUD);
    const page = pageRoute(env(), box);
    expect(page).toMatchObject({ kind: 'local', ready: true, model: CLOUD, cloud: true, label: 'ollama cloud · fake-kimi:cloud · this page\'s own chat · no tools' });
    expect(page.words).toContain(`Its name says cloud: it ${OLLAMA_CLOUD_TERMS}. Ollama sends the chat off this computer, and no cost comes back (unknown).`);
    expect(page.words).not.toMatch(/No charge|free/);
    const off = pageRoute({ ...env(), TIMMY_CHAT_LOCAL_ONLY: '1' }, box);
    expect(off).toMatchObject({ kind: 'none', ready: false, label: 'local-only · Send is off' });
    expect(off.words).toContain(`Cause: ${CLOUD} is a cloud model: the Ollama at ${ollama.host} sends it to Ollama's cloud.`);
  });
});
