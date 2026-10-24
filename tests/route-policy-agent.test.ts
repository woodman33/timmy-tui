/**
 * R10 (H169; the lead's ask of 2026-10-22, 16:5x): the route policy at the agent, for every model call a turn can make: the
 * turn's own request, the paid fallback models (src/agent/core.ts FALLBACK_ORDER), the last-resort local answer, and the tools
 * that ask a model of their own (describe_image; a code agent, whose route Timmy cannot see). Written first and run against
 * fa45040's code, where it failed (the counts are in the handoff), then against the fix. R11 (H169, Phase 0 item 1; the
 * lead's rule of 2026-10-23): the paid FALLBACK_ORDER is gone altogether: a failed model is never followed by a paid one,
 * with the policy on or off (tests/no-default-model.test.ts has the policy-off case).
 *
 * Every model the agent asks is a FAKE: OpenRouter is a FAKE server on 127.0.0.1 behind the real @openrouter/sdk (it counts
 * each request by the model it names and refuses each one with HTTP 400, so the agent tries what it would try next); Ollama
 * is a FAKE server on 127.0.0.1 (one local model, fake-qwen3:8b); describe_image's own requests go to an injected FAKE fetch.
 * The policy is set as a person sets it for one process (TIMMY_CHAT_FREE_ONLY, TIMMY_CHAT_LOCAL_ONLY). Nothing reaches the
 * network. This file imports nothing that fa45040 lacks, so it ran there unchanged.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenRouter } from '@openrouter/sdk';
import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod/v4';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '../src/agent/core.js';
import { createVisionTools } from '../src/agent/vision-tools.js';

const FREE = 'recursive/flint-v1.0:free';
const PAID_FALLBACKS = ['anthropic/claude-opus-4.7', 'google/gemini-3.5-flash', 'openai/gpt-5.5', 'minimax/minimax-m3'];
const PUBLIC = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'openrouter-public-catalog-2026-10-22.json'), 'utf8')) as { data: Array<Record<string, unknown>> };
// FAKE: a price for the first fallback model, so the catalog says it costs (OpenRouter's public catalog of 2026-10-22 does not
// list anthropic/claude-opus-4.7; the other fallbacks stay unlisted: unknown)
const FAKE_PAID = { id: 'anthropic/claude-opus-4.7', name: 'FAKE: Claude Opus 4.7 (a test price)', pricing: { prompt: '0.000005', completion: '0.000025' }, supported_parameters: ['tools'] };

const servers: http.Server[] = [];
const listen = (handler: http.RequestListener): Promise<string> => new Promise((resolve) => {
  const s = http.createServer(handler);
  servers.push(s);
  s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
});
const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => resolve(b));
});

/** A FAKE OpenRouter: counts every request by its model, refuses each with HTTP 400 (no model behind it, no charge). */
async function fakeOpenRouter() {
  const byModel = new Map<string, number>();
  const base = await listen(async (req, res) => {
    const body = await readBody(req);
    let model = '(none)';
    try { model = String((JSON.parse(body) as { model?: unknown }).model ?? '(none)'); } catch { /* not JSON */ }
    byModel.set(model, (byModel.get(model) ?? 0) + 1);
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 400, message: 'FAKE OpenRouter: refused (no model here)' } }));
  });
  return { serverURL: `${base}/api/v1`, count: (m: string) => byModel.get(m) ?? 0, total: () => [...byModel.values()].reduce((a, b) => a + b, 0), byModel };
}

/** A FAKE Ollama on 127.0.0.1: one local model (fake-qwen3:8b) and its answers, each chat request counted. */
async function fakeOllama() {
  let chats = 0;
  const base = await listen(async (req, res) => {
    const body = await readBody(req);
    const send = (code: number, v: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.url === '/api/tags') return send(200, { models: [{ name: 'fake-qwen3:8b', size: 5_225_000_000, details: { family: 'qwen3' } }] });
    if (req.url === '/api/show') return send(200, { capabilities: ['completion'], details: { format: 'gguf', family: 'qwen3' }, model_info: { 'qwen3.context_length': 40960 } });
    if (req.url === '/v1/chat/completions') { chats++; void body; return send(200, { choices: [{ message: { content: 'FAKE: the local model answered.' } }] }); }
    return send(404, { error: 'not here' });
  });
  return { host: base, chats: () => chats };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let home = '';
let project = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'h169-policy-agent-'));
  project = join(home, 'project');
  mkdirSync(join(project, 'refs'), { recursive: true });
  writeFileSync(join(project, 'refs', 'board.png'), PNG);
  // this computer's catalog: OpenRouter's public catalog of 2026-10-22 (FLINT is free in it) and the FAKE price above
  mkdirSync(join(home, 'models'), { recursive: true });
  writeFileSync(join(home, 'models', 'openrouter-catalog.json'), JSON.stringify({ fetchedAt: '2026-10-22T23:50:00.000Z', models: [...PUBLIC.data, FAKE_PAID] }));
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(home, 'settings'));
  vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '');
  vi.stubEnv('TIMMY_CHAT_LOCAL_ONLY', '');
  // no real Ollama is ever asked: the FAKE's address, or a port nothing listens on
  vi.stubEnv('OLLAMA_HOST', '127.0.0.1:9');
});
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const agentOn = (serverURL: string, model = FREE) => {
  const agent = createAgent({ apiKey: 'FAKE-openrouter-key', model, instructions: '', maxSteps: 2, maxCost: 1 }, { multiplexer: 'none' });
  (agent as unknown as { client: OpenRouter }).client = new OpenRouter({ apiKey: 'FAKE-openrouter-key', serverURL });
  agent.on('error', () => undefined);
  // its conversation in this test's own folder (the default is the working folder's .sessions)
  agent.useSessions(join(home, 'sessions'));
  return agent;
};

describe('free-only: no paid model is tried in place of a free one (the billing defect at fa45040)', () => {
  it('a failed free model sends no request to any paid fallback model', async () => {
    vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '1');
    const or = await fakeOpenRouter();
    const agent = agentOn(or.serverURL);
    const err = await agent.send('hello').then(() => null, (e: Error) => e);
    // every request the FAKE OpenRouter saw, by model: the free model's own (it is free; the FAKE refused it), and no paid
    // fallback model (fa45040: anthropic/claude-opus-4.7 was asked once)
    expect({ failed: err !== null, requests: Object.fromEntries(or.byModel) }).toEqual({ failed: true, requests: { [FREE]: 1 } });
    expect(Object.fromEntries(PAID_FALLBACKS.map((m) => [m, or.count(m)]))).toEqual(Object.fromEntries(PAID_FALLBACKS.map((m) => [m, 0])));
    expect(err!.message).toMatch(/No fallback model was tried on OpenRouter, and no local model on this computer could answer\.$/);
    // the model the agent names is still the one chosen (a fallback never replaced it)
    expect(agent.getModel()).toBe(FREE);
  });

  it('with the policy off, no fallback model is tried either (R11: the paid fallback list is gone; one request, the chosen model\'s)', async () => {
    const or = await fakeOpenRouter();
    const agent = agentOn(or.serverURL);
    await agent.send('hello').catch(() => undefined);
    expect(or.count(FREE)).toBe(1);
    expect(Object.fromEntries(PAID_FALLBACKS.map((m) => [m, or.count(m)]))).toEqual(Object.fromEntries(PAID_FALLBACKS.map((m) => [m, 0])));
    expect(or.total()).toBe(1);
  });
});

describe('the last-resort local answer under the policy', () => {
  it('free-only: the free model fails, no paid fallback is asked, and the local model on this computer (no charge) answers', async () => {
    vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '1');
    const or = await fakeOpenRouter();
    const ol = await fakeOllama();
    vi.stubEnv('OLLAMA_HOST', ol.host);
    const agent = agentOn(or.serverURL);
    const answer = await agent.send('hello');
    expect({ answer, openrouter: Object.fromEntries(or.byModel), ollamaChats: ol.chats() }).toEqual({ answer: 'FAKE: the local model answered.', openrouter: { [FREE]: 1 }, ollamaChats: 1 });
    expect(agent.lastFallback()).toMatchObject({ model: 'fake-qwen3:8b' });
  });

  it('local-only: the OpenRouter turn is refused before anything is sent: no OpenRouter request, no fallback, no last resort', async () => {
    vi.stubEnv('TIMMY_CHAT_LOCAL_ONLY', '1');
    const or = await fakeOpenRouter();
    const ol = await fakeOllama();
    vi.stubEnv('OLLAMA_HOST', ol.host);
    const agent = agentOn(or.serverURL);
    const out = await agent.send('hello').then((answer) => ({ answer }), (e: Error & { sent?: boolean }) => ({ error: e }));
    const err = 'error' in out ? out.error : null;
    expect({ refused: err?.name ?? null, sent: err?.sent, answered: 'answer' in out ? out.answer : null, openrouter: Object.fromEntries(or.byModel), ollamaChats: ol.chats() })
      .toEqual({ refused: 'PolicyRefusedError', sent: false, answered: null, openrouter: {}, ollamaChats: 0 });
    expect(err?.message).toMatch(/^Local-only is on, so this message was not sent: OpenRouter \(cloud\) runs off this computer\./);
    expect(or.total()).toBe(0);
    expect(ol.chats()).toBe(0);
    // the conversation did not take the message
    expect(agent.getHistory().some((m) => m.content === 'hello')).toBe(false);
  });
});

describe('tools that ask a model of their own', () => {
  /** A FAKE client for an OpenRouter turn: it calls one tool as a model would, then answers with what the tool gave back. */
  const callingTool = (agent: ReturnType<typeof createAgent>, name: string, args: Record<string, unknown>) => {
    (agent as unknown as { client: unknown }).client = {
      callModel: (req: { tools?: Array<{ function: { name: string; execute: (a: unknown, c: unknown) => Promise<unknown> } }> }) => ({
        async *getItemsStream() {
          const t = req.tools?.find((x) => x.function.name === name);
          let out: string;
          try { out = JSON.stringify(await t!.function.execute(args, {})); } catch (e) { out = `error: ${(e as Error).message}`; }
          yield { type: 'message', id: 'm1', content: [{ text: out }] };
        },
        getResponse: async () => ({}),
        cancel: async () => undefined,
      }),
    };
  };
  /** A FAKE Ollama whose model asks for one tool (its /api/chat answer), then says what the tool gave back. */
  async function ollamaCallingTool(name: string, args: Record<string, unknown>) {
    let chats = 0;
    const base = await listen(async (req, res) => {
      const body = await readBody(req);
      const send = (code: number, v: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
      if (req.url === '/api/show') return send(200, { capabilities: ['completion', 'tools'], details: { format: 'gguf', family: 'qwen3' }, model_info: { 'qwen3.context_length': 40960 } });
      if (req.url === '/api/chat') {
        chats++;
        const messages = (JSON.parse(body) as { messages: Array<{ role: string; content: string }> }).messages;
        const told = messages.filter((m) => m.role === 'tool').at(-1);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.end(`${JSON.stringify(told
          ? { model: 'fake-qwen3:8b', message: { role: 'assistant', content: `tool said: ${told.content}` }, done: true, done_reason: 'stop' }
          : { model: 'fake-qwen3:8b', message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: true, done_reason: 'stop' })}\n`);
        return;
      }
      return send(404, { error: 'not here' });
    });
    return { host: base, chats: () => chats };
  }
  /** describe_image's own requests, through an injected FAKE fetch: the models list (to see it takes images) and its POST. */
  const describeFetch = () => {
    const posts: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST') { posts.push(String((JSON.parse(String(init?.body)) as { model?: unknown }).model)); return new Response(JSON.stringify({ choices: [{ message: { content: 'FAKE: a board.' } }], usage: { cost: 0.0004 } }), { status: 200 }); }
      if (url.includes('/models')) return new Response(JSON.stringify({ data: PUBLIC.data }), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    return { f, posts };
  };
  const newAgent = () => {
    const agent = createAgent({ apiKey: 'FAKE-openrouter-key', model: FREE, instructions: '', maxSteps: 2, maxCost: 1 }, { multiplexer: 'none' });
    agent.on('error', () => undefined);
    agent.useSessions(join(home, `sessions-${Math.random().toString(36).slice(2)}`));
    return agent;
  };
  const DESCRIBE = { path: 'refs/board.png', question: 'What is it?', model: 'minimax/minimax-m3.1-flash' };

  it('free-only: describe_image\'s paid OpenRouter request is not made (an OpenRouter turn on a free model)', async () => {
    vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '1');
    vi.stubEnv('OPENROUTER_API_KEY', 'FAKE-openrouter-key');
    const d = describeFetch();
    const agent = newAgent();
    agent.setTools(createVisionTools({ root: () => project, fetch: d.f, model: () => FREE }) as Parameters<typeof agent.setTools>[0]);
    callingTool(agent, 'describe_image', DESCRIBE);
    const answer = await agent.send('describe the board');
    // fa45040: the tool ran and its request went (one POST for minimax/minimax-m3.1-flash)
    expect(d.posts).toEqual([]);
    expect(answer).toMatch(/^error: Free-only is on, so describe_image did not run \(it asks minimax\/minimax-m3\.1-flash\): minimax\/minimax-m3\.1-flash costs \$0\.15 in \/ \$0\.6 out per 1M tokens/);
  });

  it('local-only: describe_image\'s OpenRouter request is not made (a turn on this computer\'s Ollama)', async () => {
    vi.stubEnv('TIMMY_CHAT_LOCAL_ONLY', '1');
    vi.stubEnv('OPENROUTER_API_KEY', 'FAKE-openrouter-key');
    const d = describeFetch();
    const ol = await ollamaCallingTool('describe_image', DESCRIBE);
    const agent = newAgent();
    agent.useLocalChat({ host: ol.host, model: 'fake-qwen3:8b' });
    agent.setTools(createVisionTools({ root: () => project, fetch: d.f, model: () => FREE }) as Parameters<typeof agent.setTools>[0]);
    const answer = await agent.send('describe the board');
    expect({ posts: d.posts, ollamaChats: ol.chats() }).toEqual({ posts: [], ollamaChats: 2 });
    expect(answer).toContain('Local-only is on, so describe_image did not run (it asks minimax/minimax-m3.1-flash): OpenRouter (cloud) runs off this computer.');
  });

  it('the policy off: describe_image runs as before (its one POST)', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'FAKE-openrouter-key');
    const d = describeFetch();
    const agent = newAgent();
    agent.setTools(createVisionTools({ root: () => project, fetch: d.f, model: () => FREE }) as Parameters<typeof agent.setTools>[0]);
    callingTool(agent, 'describe_image', DESCRIBE);
    await agent.send('describe the board');
    expect(d.posts).toEqual(['minimax/minimax-m3.1-flash']);
  });

  it('a code agent (iterate_recipe), whose model route Timmy cannot see, does not start under either rule', async () => {
    let started = 0;
    // FAKE: a tool by iterate_recipe's name that only counts its starts (the real one starts a code agent)
    const fakeIterate = tool({ name: 'iterate_recipe', description: 'FAKE iterate_recipe', inputSchema: z.object({ instruction: z.string() }), outputSchema: z.any(), execute: async () => { started++; return { ok: true }; } } as never);
    // free-only, an OpenRouter turn on a free model
    vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '1');
    const a1 = newAgent();
    a1.setTools([fakeIterate] as Parameters<typeof a1.setTools>[0]);
    callingTool(a1, 'iterate_recipe', { instruction: 'make it 2 mm wider' });
    const free = await a1.send('widen the tray');
    const startedUnderFreeOnly = started;
    // local-only, a turn on this computer's Ollama
    vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '');
    vi.stubEnv('TIMMY_CHAT_LOCAL_ONLY', '1');
    const ol = await ollamaCallingTool('iterate_recipe', { instruction: 'make it 2 mm wider' });
    const a2 = newAgent();
    a2.useLocalChat({ host: ol.host, model: 'fake-qwen3:8b' });
    a2.setTools([fakeIterate] as Parameters<typeof a2.setTools>[0]);
    const local = await a2.send('widen the tray');
    expect({ startedUnderFreeOnly, startedUnderLocalOnly: started - startedUnderFreeOnly }).toEqual({ startedUnderFreeOnly: 0, startedUnderLocalOnly: 0 });
    expect(free).toMatch(/^error: Free-only is on, so iterate_recipe did not run \(it asks its code agent's model\): its code agent's model's price is not known \(its code agent picks its own model in that agent's setup, which this check cannot see\), and unknown is never free\./);
    expect(local).toContain('Local-only is on, so iterate_recipe did not run (it asks its code agent\'s model): its code agent picks its own model in that agent\'s setup, which this check cannot see, so it may run off this computer.');
  });
});
