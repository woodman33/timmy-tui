/**
 * R10 (H169): the route policy (src/agent/route-policy.ts) and where every surface reads it: the one chat route
 * (src/agent/chat-route.ts chatRouteNow: the REPL, the chat session of the Workbench and the monitor) and the companion page's
 * own chat (src/companion/chat-route.ts pageRoute). Pure checks and FAKE setups; nothing is sent anywhere (a fetch that fails
 * the test when called stands in for the network).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod/v4';
import {
  checkRoute, inferenceAt, localOnlyOn, permits, policyRefusalLines, policyTools, routePolicyNow, routeWords, saveRoutePolicy, type RoutePolicy,
} from '../src/agent/route-policy.js';
import { chatRouteNow } from '../src/agent/chat-route.js';
import { pageRoute } from '../src/companion/chat-route.js';
import { openRouterRow, ollamaRow } from '../src/models/catalog.js';
import { modelPrice } from '../src/agent/model-price.js';
import { settingsFile } from '../src/utils/model-key.js';

const PUBLIC = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'openrouter-public-catalog-2026-10-22.json'), 'utf8')) as { data: Array<{ id: string }> };
const CACHE = { fetchedAt: '2026-10-22T23:50:00.000Z', models: PUBLIC.data };
const price = (id: string) => modelPrice(id, CACHE as Parameters<typeof modelPrice>[1]);
const FREE_ONLY: RoutePolicy = { freeOnly: true, localOnly: false };
const LOCAL_ONLY: RoutePolicy = { freeOnly: false, localOnly: true };
const BOTH: RoutePolicy = { freeOnly: true, localOnly: true };
const OFF: RoutePolicy = { freeOnly: false, localOnly: false };

let home = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'h169-policy-'));
  vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '');
  vi.stubEnv('TIMMY_CHAT_LOCAL_ONLY', '');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe('where a model call runs', () => {
  it('tells this computer, another computer and a cloud apart; a cloud model served through localhost is cloud', () => {
    expect(inferenceAt({ source: 'openrouter', model: 'x/y' })).toBe('cloud');
    expect(inferenceAt({ source: 'ollama-cloud', model: 'gpt-oss:120b' })).toBe('cloud');
    expect(inferenceAt({ source: 'ollama-local', model: 'fake-qwen3:8b', host: '127.0.0.1:11434' })).toBe('this computer');
    expect(inferenceAt({ source: 'ollama-local', model: 'fake-qwen3:8b' })).toBe('this computer');
    expect(inferenceAt({ source: 'ollama-local', model: 'kimi-k2:cloud', host: '127.0.0.1:11434' })).toBe('cloud');
    expect(inferenceAt({ source: 'ollama-local', model: 'fake-qwen3:8b', host: '127.0.0.1:11434', remote: true })).toBe('cloud');
    expect(inferenceAt({ source: 'ollama-local', model: 'fake-qwen3:8b', host: '192.0.2.20:11434' })).toBe('another computer');
    expect(routeWords({ source: 'ollama-local', model: 'm', host: '192.0.2.20:11434' })).toBe('the Ollama at 192.0.2.20:11434 (another computer)');
  });
});

describe('checkRoute', () => {
  it('local-only refuses everything off this computer, and says which rule, why and what it permits', () => {
    const or = checkRoute({ source: 'openrouter', model: 'recursive/flint-v1.0:free' }, LOCAL_ONLY, { price });
    expect(or).toEqual({
      ok: false, reason: 'cloud-under-local-only', cause: 'OpenRouter (cloud) runs off this computer',
      permitted: 'permitted: a model with local weights on this computer\'s Ollama (/model lists them); local-only stays on',
      words: 'Local-only is on, so this message was not sent: OpenRouter (cloud) runs off this computer. Nothing was sent; permitted: a model with local weights on this computer\'s Ollama (/model lists them); local-only stays on.',
    });
    expect(checkRoute({ source: 'ollama-cloud', model: 'gpt-oss:120b' }, LOCAL_ONLY)).toMatchObject({ ok: false, reason: 'cloud-under-local-only' });
    const tag = checkRoute({ source: 'ollama-local', model: 'kimi-k2:cloud', host: '127.0.0.1:11434' }, LOCAL_ONLY);
    expect(tag).toMatchObject({ ok: false, cause: 'kimi-k2:cloud is a cloud model: the Ollama at 127.0.0.1:11434 sends it to Ollama\'s cloud' });
    expect(checkRoute({ source: 'ollama-local', model: 'm', host: '192.0.2.5:11434' }, LOCAL_ONLY)).toMatchObject({ ok: false, reason: 'cloud-under-local-only' });
    expect(checkRoute({ source: 'ollama-local', model: 'm', host: '127.0.0.1:11434', gateway: 'cloudflare' }, LOCAL_ONLY)).toMatchObject({ ok: false, cause: 'the Cloudflare gateway is off this computer' });
    expect(checkRoute({ source: 'ollama-local', model: 'fake-qwen3:8b', host: '127.0.0.1:11434' }, LOCAL_ONLY)).toEqual({ ok: true });
  });

  it('free-only permits what is known to be free; a price that costs or is unknown is refused', () => {
    expect(checkRoute({ source: 'openrouter', model: 'recursive/flint-v1.0:free' }, FREE_ONLY, { price })).toEqual({ ok: true });
    expect(checkRoute({ source: 'openrouter', model: 'minimax/minimax-m3.1-flash' }, FREE_ONLY, { price })).toMatchObject({
      ok: false, reason: 'paid-under-free-only', cause: 'minimax/minimax-m3.1-flash costs $0.15 in / $0.6 out per 1M tokens',
    });
    expect(checkRoute({ source: 'openrouter', model: 'typesafe/jev-router' }, FREE_ONLY, { price })).toMatchObject({ ok: false, reason: 'price-unknown-under-free-only' });
    expect(checkRoute({ source: 'openrouter', model: 'fake/not-in-the-catalog' }, FREE_ONLY, { price })).toMatchObject({ ok: false, reason: 'price-unknown-under-free-only' });
    // a model with local weights on this computer costs nothing; Ollama's cloud and another computer's Ollama are not known
    expect(checkRoute({ source: 'ollama-local', model: 'fake-qwen3:8b', host: '127.0.0.1:11434' }, FREE_ONLY)).toEqual({ ok: true });
    expect(checkRoute({ source: 'ollama-local', model: 'kimi-k2:cloud', host: '127.0.0.1:11434' }, FREE_ONLY)).toMatchObject({ ok: false, reason: 'price-unknown-under-free-only' });
    expect(checkRoute({ source: 'ollama-local', model: 'm', host: '192.0.2.5:11434' }, FREE_ONLY)).toMatchObject({ ok: false, reason: 'price-unknown-under-free-only' });
    expect(checkRoute({ source: 'ollama-cloud', model: 'gpt-oss:120b' }, FREE_ONLY)).toMatchObject({ ok: false, reason: 'price-unknown-under-free-only' });
  });

  it('checks local-only first when both are on, and permits anything when both are off', () => {
    expect(checkRoute({ source: 'openrouter', model: 'recursive/flint-v1.0:free' }, BOTH, { price })).toMatchObject({ reason: 'cloud-under-local-only' });
    expect(checkRoute({ source: 'openrouter', model: 'minimax/minimax-m3.1-flash' }, OFF, { price })).toEqual({ ok: true });
  });

  it('names what was not done: a fallback not tried, a tool that did not run', () => {
    expect(checkRoute({ source: 'openrouter', model: 'minimax/minimax-m3.1-flash', role: 'fallback' }, FREE_ONLY, { price }))
      .toMatchObject({ words: expect.stringMatching(/^Free-only is on, so the fallback model minimax\/minimax-m3\.1-flash was not tried: /) });
    expect(checkRoute({ source: 'openrouter', model: 'minimax/minimax-m3.1-flash', role: 'tool', tool: 'describe_image' }, LOCAL_ONLY, { price }))
      .toMatchObject({ words: expect.stringMatching(/^Local-only is on, so describe_image did not run \(it asks minimax\/minimax-m3\.1-flash\): /) });
  });

  it('marks the Models rail\'s rows the policy permits', () => {
    const free = openRouterRow(PUBLIC.data.find((m) => m.id === 'recursive/flint-v1.0:free') as never);
    const paid = openRouterRow(PUBLIC.data.find((m) => m.id === 'minimax/minimax-m3.1-flash') as never);
    const local = ollamaRow({ name: 'fake-qwen3:8b', capabilities: ['completion'] }, 'ollama-local');
    const cloud = ollamaRow({ name: 'gpt-oss:120b' }, 'ollama-cloud');
    expect([free, paid, local, cloud].map((r) => permits(r, FREE_ONLY, '127.0.0.1:11434').ok)).toEqual([true, false, true, false]);
    expect([free, paid, local, cloud].map((r) => permits(r, LOCAL_ONLY, '127.0.0.1:11434').ok)).toEqual([false, false, true, false]);
  });

  it('gives a refusal as a surface prints one: what, Cause, Try (the rule stays on), and that nothing was sent', () => {
    const c = checkRoute({ source: 'openrouter', model: 'x/y' }, LOCAL_ONLY);
    if (c.ok) throw new Error('expected a refusal');
    expect(policyRefusalLines(c)).toEqual([
      'Error: local-only is on, so this message was not sent.',
      'Cause: OpenRouter (cloud) runs off this computer.',
      'Try: /model lists the models this computer\'s Ollama has; /setup chat keeps one (local-only stays on)',
      'Nothing was sent to any model.',
    ]);
    expect(policyRefusalLines(c, true)[2]).toBe('Try: choose a model on this computer\'s Ollama: /model in the REPL lists them, or timmy init --chat local --model <name> (local-only stays on)');
  });
});

describe('the setting', () => {
  it('is kept beside free-only in the settings file; TIMMY_CHAT_LOCAL_ONLY wins for one process', async () => {
    const env = { TIMMY_SETTINGS_DIR: join(home, 'settings') };
    expect(localOnlyOn(env)).toBe(false);
    mkdirSync(env.TIMMY_SETTINGS_DIR, { recursive: true });
    writeFileSync(settingsFile(env), JSON.stringify({ freeOnly: true, localOnly: true }));
    expect(routePolicyNow(env)).toEqual({ freeOnly: true, localOnly: true });
    expect(localOnlyOn({ ...env, TIMMY_CHAT_LOCAL_ONLY: '0' })).toBe(false);
    expect(localOnlyOn({ TIMMY_SETTINGS_DIR: join(home, 'none'), TIMMY_CHAT_LOCAL_ONLY: 'on' })).toBe(true);
  });

  it('saveRoutePolicy writes the settings store (the one this process uses) and says when a variable wins', async () => {
    const env = { ...process.env, TIMMY_CHAT_LOCAL_ONLY: '' };
    const r = await saveRoutePolicy({ localOnly: true }, env);
    expect(r.policy.localOnly).toBe(true);
    expect(r.overridden).toEqual([]);
    expect(JSON.parse(readFileSync(settingsFile(env), 'utf8')).localOnly).toBe(true);
    const again = await saveRoutePolicy({ localOnly: false }, { ...env, TIMMY_CHAT_LOCAL_ONLY: '1' });
    expect(again.overridden).toEqual(['localOnly']);
    expect(again.policy.localOnly).toBe(true);
    expect(JSON.parse(readFileSync(settingsFile(env), 'utf8')).localOnly).toBe(false);
  });
});

describe('policyTools: a tool that asks a model of its own is checked at its call, before anything runs', () => {
  const counting = (name: string) => {
    let runs = 0;
    const t = tool({ name, description: `FAKE ${name}`, inputSchema: z.object({ model: z.string().optional() }), outputSchema: z.any(), execute: async () => { runs++; return { ok: true }; } } as never);
    return { t, runs: () => runs };
  };
  const exec = (t: unknown, args: Record<string, unknown>) => (t as { function: { execute: (a: unknown, c: unknown) => Promise<unknown> } }).function.execute(args, {});

  it('refuses describe_image\'s paid model under free-only (not run), runs it with the policy off, and leaves other tools as given', async () => {
    const d = counting('describe_image');
    const other = counting('calculator');
    let policy: RoutePolicy = FREE_ONLY;
    const [wrapped, untouched] = policyTools([d.t, other.t], () => policy, { openRouterModel: () => 'recursive/flint-v1.0:free', price });
    expect(untouched).toBe(other.t);
    await expect(exec(wrapped, { model: 'minimax/minimax-m3.1-flash' })).rejects.toMatchObject({ policy: 'paid-under-free-only', sent: false });
    expect(d.runs()).toBe(0);
    // its default model is the chat's OpenRouter model: free here, so it runs
    await expect(exec(wrapped, {})).resolves.toEqual({ ok: true });
    policy = OFF;
    await exec(wrapped, { model: 'minimax/minimax-m3.1-flash' });
    expect(d.runs()).toBe(2);
  });

  it('lets the local spatial review run under local-only, and never starts a code agent under either rule', async () => {
    const review = counting('review_spatial_with_local_model');
    const iterate = counting('iterate_native');
    const [r, i] = policyTools([review.t, iterate.t], () => BOTH);
    await exec(r, { model: 'fake-qwen3:8b' });
    expect(review.runs()).toBe(1);
    await expect(exec(i, {})).rejects.toMatchObject({ policy: 'cloud-under-local-only' });
    expect(iterate.runs()).toBe(0);
  });
});

describe('every surface reads the one route, with the policy', () => {
  const setup = (answers: Record<string, string>) => {
    const h = join(home, `timmy-${Math.random().toString(36).slice(2)}`);
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, 'setup.json'), JSON.stringify({ answers }));
    return { TIMMY_HOME: h, TIMMY_SETTINGS_DIR: join(h, 'settings') };
  };

  it('local-only refuses OpenRouter at send, in the refusal\'s words, whatever the model costs', () => {
    const env = { ...setup({ chat: 'openrouter' }), OPENROUTER_API_KEY: 'FAKE-key', TIMMY_CHAT_LOCAL_ONLY: '1' };
    const now = chatRouteNow({ env, openRouterModel: 'recursive/flint-v1.0:free', surface: 'workbench', price });
    expect(now.state).toMatchObject({ kind: 'openrouter', ready: false });
    expect(now.state.words).toMatch(/ · local-only: not sent$/);
    expect(now.state.refusal?.[0]).toBe('Error: local-only is on, so this message was not sent.');
    expect(now.state.refusal?.at(-1)).toBe('Nothing was sent to any model.');
  });

  it('the local route: a model with local weights here is ready under both rules; a cloud model is refused', () => {
    const local = setup({ chat: 'local', ollama: '127.0.0.1:11434', model: 'fake-qwen3:8b' });
    const ready = chatRouteNow({ env: { ...local, TIMMY_CHAT_LOCAL_ONLY: '1', TIMMY_CHAT_FREE_ONLY: '1' }, surface: 'repl' });
    expect(ready.state).toMatchObject({ kind: 'local', ready: true });
    expect(ready.state.words).toMatch(/ · local-only$/);
    const cloud = setup({ chat: 'local', ollama: '127.0.0.1:11434', model: 'kimi-k2:cloud' });
    const refusedLocal = chatRouteNow({ env: { ...cloud, TIMMY_CHAT_LOCAL_ONLY: '1' }, surface: 'repl' });
    expect(refusedLocal.state).toMatchObject({ ready: false });
    expect(refusedLocal.state.refusal?.[1]).toBe('Cause: kimi-k2:cloud is a cloud model: the Ollama at 127.0.0.1:11434 sends it to Ollama\'s cloud.');
    const refusedFree = chatRouteNow({ env: { ...cloud, TIMMY_CHAT_FREE_ONLY: '1' }, surface: 'repl' });
    expect(refusedFree.state.words).toMatch(/ · free-only: not sent$/);
    // the policy off: as before
    expect(chatRouteNow({ env: cloud, surface: 'repl' }).state.ready).toBe(true);
  });

  it('the companion page says the rule that keeps Send off, never "no model chosen"', () => {
    const cloud = setup({ chat: 'local', ollama: '127.0.0.1:11434', model: 'kimi-k2:cloud' });
    const local = pageRoute({ ...cloud, TIMMY_CHAT_LOCAL_ONLY: '1' }, home);
    expect(local).toMatchObject({ kind: 'none', ready: false, label: 'local-only · Send is off' });
    expect(local.words).toMatch(/^Send is off: local-only is on, and this page would ask kimi-k2:cloud on Ollama at 127\.0\.0\.1:11434\. Cause: kimi-k2:cloud is a cloud model/);
    expect(local.words).not.toMatch(/no model is chosen/);
    const or = setup({ chat: 'openrouter' });
    const page = pageRoute({ ...or, OPENROUTER_API_KEY: 'FAKE-key', TIMMY_CHAT_LOCAL_ONLY: '1' }, home);
    expect(page).toMatchObject({ kind: 'none', ready: false, label: 'local-only · Send is off' });
    expect(JSON.stringify(page)).not.toContain('FAKE-key');
  });
});

describe('the chat session refuses before anything is sent', () => {
  it('local-only on, an OpenRouter route: refused in the policy\'s words, no request (a FAKE client that fails when called), no receipt', async () => {
    const { openChatSession } = await import('../src/agent/chat-session.js');
    const { createAgent } = await import('../src/agent/core.js');
    const project = join(home, 'project');
    mkdirSync(join(project, '.timmy'), { recursive: true });
    writeFileSync(join(project, '.timmy', 'store-pin'), join(project, '.timmy', 'receipts'));
    vi.stubEnv('TIMMY_HOME', join(home, 'timmy'));
    vi.stubEnv('TIMMY_CHAT_LOCAL_ONLY', '1');
    const agent = createAgent({ apiKey: 'FAKE-openrouter-key', model: 'recursive/flint-v1.0:free', instructions: '', maxSteps: 2, maxCost: 1 }, { multiplexer: 'none' });
    agent.useSessions(join(project, '.sessions'));
    let asked = 0;
    (agent as unknown as { client: unknown }).client = { callModel: () => { asked++; throw new Error('FAKE client: no request may be made'); } };
    const sealed: unknown[] = [];
    const chat = await openChatSession({ project: { name: 'tray', root: project }, surface: 'workbench' }, { agent, seal: (f) => { sealed.push(f); return { id: 'x', hash: 'sha256:x', verified: true }; } });
    const r = await chat.send('hello', { onText: () => undefined, askPerson: async () => 'deny' });
    expect(r).toMatchObject({ status: 'refused', sent: false, costWords: 'no request, no cost' });
    expect(r.lines?.[0]).toBe('Error: local-only is on, so this message was not sent.');
    expect(asked).toBe(0);
    expect(sealed).toEqual([]);
  });
});
