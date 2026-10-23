/**
 * R11 (H169, Phase 0 item 1; the operator's order of 2026-10-23: "Never ... silently substitute a paid model", "Disable an unsafe
 * Send path rather than using an unchosen model"): no default paid model anywhere. Before R11 the settings shipped
 * anthropic/claude-opus-4.7 as the model (src/utils/config.ts DEFAULT_CONFIG), the registry named it its default, and the REPL,
 * the monitor and `timmy init --chat openrouter` sent to it the moment a key existed; a failed model fell back to a list of
 * paid models nobody chose. Now:
 *   - the settings' model is '' until a person chooses one (Models, /model <id>, timmy init --chat openrouter --model <id>);
 *     an older settings file's shipped default reads as no model unless it was recorded as a choice;
 *   - a key with no chosen model refuses the message on every surface, in the one sentence, and sends nothing;
 *   - a chosen model that fails ends the turn with the reason and the next step: no paid fallback (the lead's rule of
 *     2026-10-23 09:04); only under free-only or local-only may the local model on this computer answer as the last resort.
 * FAKE only: a FAKE OpenRouter on 127.0.0.1 behind the real SDK (it counts requests by model and refuses each), a FAKE Ollama
 * on 127.0.0.1, FAKE keys, this repository's trimmed copy of OpenRouter's public catalog. Nothing reaches the network.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { OpenRouter } from '@openrouter/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent, NoModelChosenError, type Agent } from '../src/agent/core.js';
import { chatRouteNow, NO_MODEL_CHOSEN_REFUSAL, NO_MODEL_CHOSEN_SENTENCE } from '../src/agent/chat-route.js';
import { openChatSession } from '../src/agent/chat-session.js';
import { getDefaultModel } from '../src/agent/openrouter-client.js';
import { getDefaultModelForProvider } from '../src/agent/provider-registry.js';
import { getConfig, LEGACY_DEFAULT_MODEL, loadConfig, saveConfig } from '../src/utils/config.js';
import { runInit } from '../src/utils/init.js';
import { glyphSet } from '../src/term/glyphs.js';
import { runSlash, type ReplContext } from '../src/repl/commands.js';

const FREE = 'recursive/flint-v1.0:free';
const PAID = 'minimax/minimax-m3.1-flash';
const PUBLIC = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'openrouter-public-catalog-2026-10-22.json'), 'utf8')) as { data: Array<Record<string, unknown>> };
const KEY = 'sk-or-FAKE-no-default-model-0001';

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

/** A FAKE OpenRouter: every request counted by its model; refused with HTTP 400 unless `answer` is given. */
async function fakeOpenRouter(answer?: string) {
  const byModel = new Map<string, number>();
  const base = await listen(async (req, res) => {
    const body = await readBody(req);
    let model = '(none)';
    try { model = String((JSON.parse(body) as { model?: unknown }).model ?? '(none)'); } catch { /* not JSON */ }
    byModel.set(model, (byModel.get(model) ?? 0) + 1);
    if (answer === undefined) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 400, message: 'FAKE OpenRouter: refused (no model here)' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_fake', object: 'response', status: 'completed', model, output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost: 0 } }));
  });
  return { serverURL: `${base}/api/v1`, count: (m: string) => byModel.get(m) ?? 0, total: () => [...byModel.values()].reduce((a, b) => a + b, 0), byModel };
}

/** A FAKE Ollama on 127.0.0.1: one local model (fake-qwen3:8b); every chat request counted. */
async function fakeOllama() {
  let chats = 0;
  const base = await listen(async (req, res) => {
    await readBody(req);
    const send = (code: number, v: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.url === '/api/tags') return send(200, { models: [{ name: 'fake-qwen3:8b', size: 5_225_000_000, details: { family: 'qwen3' } }] });
    if (req.url === '/api/show') return send(200, { capabilities: ['completion'], details: { format: 'gguf', family: 'qwen3' }, model_info: { 'qwen3.context_length': 40960 } });
    if (req.url === '/v1/chat/completions') { chats++; return send(200, { choices: [{ message: { content: 'FAKE: the local model answered.' } }] }); }
    return send(404, { error: 'not here' });
  });
  return { host: base, chats: () => chats };
}

let home = '';
let project = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'h169-no-default-'));
  project = join(home, 'project');
  mkdirSync(join(project, '.timmy'), { recursive: true });
  writeFileSync(join(project, '.timmy', 'store-pin'), join(project, '.timmy', 'receipts'));
  mkdirSync(join(home, 'timmy', 'models'), { recursive: true });
  mkdirSync(join(home, 'repo'), { recursive: true });
  // this computer's catalog: OpenRouter's public catalog of 2026-10-22 (FLINT free, minimax priced)
  writeFileSync(join(home, 'timmy', 'models', 'openrouter-catalog.json'), JSON.stringify({ fetchedAt: '2026-10-22T23:50:00.000Z', models: PUBLIC.data }));
  vi.stubEnv('TIMMY_HOME', join(home, 'timmy'));
  vi.stubEnv('TIMMY_REPO_ROOT', join(home, 'repo'));
  // the settings store is this test file's own (tests/isolation-setup.ts), made when the module loaded: each test starts it
  // from the defaults (its folder is the file's TIMMY_SETTINGS_DIR, where init and the Workbench read it by path)
  getConfig().clear();
  vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '');
  vi.stubEnv('TIMMY_CHAT_LOCAL_ONLY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.stubEnv('OPENROUTER_MODEL', '');
  vi.stubEnv('OLLAMA_HOST', '127.0.0.1:9');
});
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** The setup as a person who pasted a FAKE key and chose no model has it (the home's providers.json and setup.json). */
function keyedSetup(): void {
  writeFileSync(join(home, 'timmy', 'providers.json'), JSON.stringify({ ollama_host: 'http://127.0.0.1:9', openrouter_api_key: KEY }), { mode: 0o600 });
  writeFileSync(join(home, 'timmy', 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: 'http://127.0.0.1:9', project: 'demo', chat: 'openrouter' } }));
}
const settingsPath = (): string => getConfig().path;
const settingsDir = (): string => dirname(getConfig().path);
/** The words as init prints them, wrapped at 60 columns: any space may be a line break. */
const loose = (words: string): RegExp => new RegExp(words.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, '\\s+'));

const agentOn = (serverURL: string, model: string): Agent => {
  const agent = createAgent({ apiKey: KEY, model, instructions: '', maxSteps: 2, maxCost: 1 }, { multiplexer: 'none' });
  (agent as unknown as { client: OpenRouter }).client = new OpenRouter({ apiKey: KEY, serverURL });
  agent.on('error', () => undefined);
  agent.useSessions(join(home, 'sessions'));
  return agent;
};

describe('the shipped default is none', () => {
  it('a fresh settings store names no model; the registry and the client give no default either', () => {
    expect(loadConfig().model).toBe('');
    expect(getDefaultModelForProvider('openrouter', {})).toBeUndefined();
    expect(getDefaultModelForProvider('openrouter', { OPENROUTER_MODEL: 'fake/named-in-env' })).toBe('fake/named-in-env');
  });

  it('getDefaultModel picks nothing from the catalog', async () => {
    expect(await getDefaultModel()).toBe('');
  });

  it('an older settings file\'s shipped default is no model unless it was recorded as a choice; a saved choice and OPENROUTER_MODEL stand', () => {
    // the file as a version before R11 left it: conf wrote the default into it, nobody chose it
    mkdirSync(settingsDir(), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({ apiKey: '', model: LEGACY_DEFAULT_MODEL, theme: 'dark' }));
    expect(loadConfig().model).toBe('');
    // recorded by the Workbench's Models before R11 (workbench.json beside the settings file): a choice
    writeFileSync(join(settingsDir(), 'workbench.json'), JSON.stringify({ openRouterModel: LEGACY_DEFAULT_MODEL }));
    expect(loadConfig().model).toBe(LEGACY_DEFAULT_MODEL);
    rmSync(join(settingsDir(), 'workbench.json'));
    expect(loadConfig().model).toBe('');
    // chosen now, through saveConfig (Models, timmy init --model): recorded as the choice, so it stands, the legacy id too
    saveConfig({ model: LEGACY_DEFAULT_MODEL });
    expect(loadConfig().model).toBe(LEGACY_DEFAULT_MODEL);
    expect((JSON.parse(readFileSync(settingsPath(), 'utf8')) as { modelChosen?: string }).modelChosen).toBe(LEGACY_DEFAULT_MODEL);
    saveConfig({ model: FREE });
    expect(loadConfig().model).toBe(FREE);
    // the environment's model for one process wins, as before
    vi.stubEnv('OPENROUTER_MODEL', 'fake/for-this-process');
    expect(loadConfig().model).toBe('fake/for-this-process');
  });
});

describe('a key with no chosen model: refused on every surface, nothing sent', () => {
  it('chatRouteNow: the one sentence, the cause, where to choose (the REPL has its own in the sentence), and that nothing was sent', () => {
    const env = { TIMMY_HOME: join(home, 'timmy'), TIMMY_SETTINGS_DIR: join(home, 'settings') };
    for (const model of [null, '', '  '] as const) {
      const s = chatRouteNow({ env, key: true, openRouterModel: model, surface: 'repl' }).state;
      expect(s).toMatchObject({ kind: 'openrouter', ready: false, words: 'chat: OpenRouter · no model chosen' });
      expect(s.refusal).toEqual([`Error: ${NO_MODEL_CHOSEN_SENTENCE}`, 'Cause: an OpenRouter key is set up, and no model is chosen for the next turn: nothing is sent to a model nobody chose.', 'Nothing was sent to any model.']);
    }
    for (const surface of ['workbench', 'monitor', 'companion'] as const) {
      const s = chatRouteNow({ env, key: true, openRouterModel: null, surface }).state;
      expect(s.ready).toBe(false);
      expect(s.refusal).toEqual([...NO_MODEL_CHOSEN_REFUSAL]);
      expect(s.refusal?.[0]).toBe('Error: No model chosen. /model <id> chooses one (/model free lists free ones).');
    }
    // whatever the policy says: refused before the policy is read
    expect(chatRouteNow({ env: { ...env, TIMMY_CHAT_FREE_ONLY: '1' }, key: true, openRouterModel: null, surface: 'repl' }).state.refusal?.[0]).toBe(`Error: ${NO_MODEL_CHOSEN_SENTENCE}`);
    // a model chosen: the route is ready and names it
    expect(chatRouteNow({ env, key: true, openRouterModel: FREE, surface: 'repl' }).state).toMatchObject({ kind: 'openrouter', ready: true, words: `chat: ${FREE} · OpenRouter` });
  });

  it('the agent itself: a key and no model refuses before the conversation takes the message, 0 requests; a chosen model goes out as chosen', async () => {
    const or = await fakeOpenRouter();
    const agent = agentOn(or.serverURL, '');
    const errors: Error[] = [];
    agent.on('error', (e) => errors.push(e));
    await expect(agent.send('hello')).rejects.toBeInstanceOf(NoModelChosenError);
    expect(errors[0]).toMatchObject({ name: 'NoModelChosenError', sent: false });
    expect(errors[0].message.split('\n')[0]).toBe(NO_MODEL_CHOSEN_SENTENCE);
    expect(or.total()).toBe(0);
    expect(agent.getHistory()).toEqual([]);
    expect(agent.isRunning()).toBe(false);
    // chosen (as /model <id>, Models or timmy init choose it): the one request names it (the FAKE refuses every request)
    agent.setModel(FREE);
    const err = await agent.send('hello').then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(new RegExp(`^OpenRouter request failed for ${FREE.replace(/[.:/]/g, '\\$&')}\\.`));
    expect(Object.fromEntries(or.byModel)).toEqual({ [FREE]: 1 });
  });

  it('the monitor\'s and the Workbench\'s chat sessions, from the settings (a FAKE key, no model): refused, 0 requests; a model saved since goes out', async () => {
    keyedSetup();
    const or = await fakeOpenRouter();
    for (const surface of ['monitor', 'workbench'] as const) {
      const config = loadConfig();
      expect(config.model).toBe('');
      const agent = agentOn(or.serverURL, config.model);
      const chat = await openChatSession({ project: { name: 'demo', root: project }, surface }, { agent, ...(surface === 'monitor' ? { config: { apiKey: config.apiKey, model: config.model } } : {}) });
      expect(chat.route()).toMatchObject({ kind: 'openrouter', ready: false, words: 'chat: OpenRouter · no model chosen' });
      expect(chat.route().refusal).toEqual([...NO_MODEL_CHOSEN_REFUSAL]);
      const r = await chat.send('hello', { onText: () => undefined, askPerson: async () => 'deny' });
      expect(r).toMatchObject({ status: 'refused', sent: false });
      expect(r.lines).toEqual([...NO_MODEL_CHOSEN_REFUSAL]);
      expect(or.total()).toBe(0);
    }
    // chosen since, in the settings (Models → Enter, timmy init --model), with the Workbench's session open: its next turn
    // takes it (R24), and the one request names it (the FAKE refuses it: the turn fails, nothing else is asked)
    const agent = agentOn(or.serverURL, '');
    const chat = await openChatSession({ project: { name: 'demo', root: project }, surface: 'workbench' }, { agent });
    expect(chat.route()).toMatchObject({ ready: false, words: 'chat: OpenRouter · no model chosen' });
    saveConfig({ model: FREE });
    expect(chat.route()).toMatchObject({ ready: true, words: `chat: ${FREE} · OpenRouter` });
    const r = await chat.send('hello', { onText: () => undefined, askPerson: async () => 'deny' });
    expect(r).toMatchObject({ status: 'failed', sent: true });
    expect(r.lines).toContain(`OpenRouter request failed for ${FREE}.`);
    expect(Object.fromEntries(or.byModel)).toEqual({ [FREE]: 1 });
  });

  it('the REPL\'s /model with none chosen says so and how to choose; /model <id> chooses for the session', () => {
    const printed: string[] = [];
    let model = '';
    const c: ReplContext = {
      agent: { getModel: () => model, setModel: (m) => { model = m; }, startSession: () => 's1' },
      print: (segments) => printed.push(segments.map((s) => s.text).join('')),
      glyphs: glyphSet(false),
    };
    runSlash('/model', c);
    expect(printed[0]).toBe('  Model: none chosen · /model <id> chooses one (/model free lists free ones); nothing is sent until then');
    printed.length = 0;
    runSlash(`/model ${FREE}`, c);
    expect(printed[0]).toBe(`  Model: none chosen -> ${FREE}`);
    expect(model).toBe(FREE);
  });
});

describe('timmy init --chat openrouter', () => {
  const lines: string[] = [];
  const log = (s: string): void => { lines.push(s); };
  beforeEach(() => { lines.length = 0; });

  it('without --model records the route and says a model is still to be chosen; no model is chosen', async () => {
    expect(await runInit(['--yes', '--operator', 'Sample', '--project', 'demo', '--chat', 'openrouter', '--openrouter', KEY], { isTTY: false, log })).toBe(0);
    const setup = JSON.parse(readFileSync(join(home, 'timmy', 'setup.json'), 'utf8')) as { answers: Record<string, unknown> };
    expect(setup.answers.chat).toBe('openrouter');
    expect(setup.answers.model).toBeUndefined();
    expect(lines.join('\n')).toMatch(loose('No model is chosen for OpenRouter yet, so nothing is sent until one is: timmy init --chat openrouter --model <id>'));
    expect(lines.join('\n')).not.toContain(KEY);
    expect(loadConfig().model).toBe('');
  });

  it('--model <id> in the kept catalog chooses it for the next turn, with its price; one the catalog does not list chooses nothing (exit 2)', async () => {
    expect(await runInit(['--yes', '--operator', 'Sample', '--project', 'demo', '--chat', 'openrouter', '--openrouter', KEY, '--model', PAID], { isTTY: false, log })).toBe(0);
    expect(lines.join('\n')).toMatch(loose(`Chosen for the next turn: ${PAID} on OpenRouter ($0.15 in / $0.6 out per 1M tokens (OpenRouter catalog of 2026-10-22)`));
    expect(loadConfig().model).toBe(PAID);
    expect(JSON.parse(readFileSync(join(home, 'timmy', 'setup.json'), 'utf8')).answers.model).toBeUndefined();
    lines.length = 0;
    expect(await runInit(['--yes', '--chat', 'openrouter', '--model', 'fake-maker/not-in-the-catalog'], { isTTY: false, log })).toBe(2);
    expect(lines.join('\n')).toMatch(loose('Nothing was chosen: the OpenRouter catalog this computer keeps (fetched, of 2026-10-22) lists no model fake-maker/not-in-the-catalog.'));
    expect(loadConfig().model).toBe(PAID);
    // the local model's flag is unchanged: --model with --chat local names what Ollama lists
    lines.length = 0;
    expect(await runInit(['--yes', '--chat', 'openrouter', '--model', 'not an id'], { isTTY: false, log })).toBe(2);
    expect(lines.join('\n')).toMatch(loose("--model with --chat openrouter takes a model's id"));
  });
});

describe('a chosen model that fails: no paid fallback, ever (the lead\'s rule of 2026-10-23 09:04)', () => {
  it('with the policy off the turn ends with the reason and the next step: 0 further OpenRouter requests, 0 Ollama requests', async () => {
    const or = await fakeOpenRouter();
    const ol = await fakeOllama();
    vi.stubEnv('OLLAMA_HOST', ol.host);
    const agent = agentOn(or.serverURL, PAID);
    const err = await agent.send('hello').then(() => null, (e: Error) => e);
    expect(err?.message.split('\n')).toEqual([
      `OpenRouter request failed for ${PAID}.`,
      expect.stringMatching(/^Reason: .*FAKE OpenRouter: refused/),
      'Next: choose another model (Models (M) in timmy workbench, or /model <id> in the REPL) or try again. No fallback model was tried: a model nobody chose is never asked in its place.',
    ]);
    expect(Object.fromEntries(or.byModel)).toEqual({ [PAID]: 1 });
    expect(ol.chats()).toBe(0);
    expect(agent.lastFallback()).toBeNull();
    expect(agent.getModel()).toBe(PAID);
  });

  it('under free-only the local model on this computer may answer as the last resort, named as a fallback; no paid model is asked', async () => {
    vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '1');
    const or = await fakeOpenRouter();
    const ol = await fakeOllama();
    vi.stubEnv('OLLAMA_HOST', ol.host);
    const agent = agentOn(or.serverURL, FREE);
    expect(await agent.send('hello')).toBe('FAKE: the local model answered.');
    expect(Object.fromEntries(or.byModel)).toEqual({ [FREE]: 1 });
    expect(ol.chats()).toBe(1);
    expect(agent.lastFallback()).toMatchObject({ model: 'fake-qwen3:8b', cause: expect.stringMatching(new RegExp(`^${FREE.replace(/[.:/]/g, '\\$&')}: `)) });
    expect(agent.lastTurnModel()).toBe('ollama/fake-qwen3:8b');
  });

  it('under free-only with no local model to answer, the turn ends with the reason: still no paid model', async () => {
    vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '1');
    const or = await fakeOpenRouter();
    const agent = agentOn(or.serverURL, FREE);
    const err = await agent.send('hello').then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/No fallback model was tried on OpenRouter, and no local model on this computer could answer\.$/);
    expect(Object.fromEntries(or.byModel)).toEqual({ [FREE]: 1 });
  });
});
