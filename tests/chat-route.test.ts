// R4 (H103): where the REPL's chat goes, and how a person chooses the local model. The setup's chat question lists what the
// Ollama the setup names has (GET /api/tags, from a FAKE Ollama: a real HTTP server on 127.0.0.1, no model behind it), each
// labelled local weights or cloud-backed, a cloud-backed one never preselected; with no model it says how to get one and the
// chat stays off. The answer is written to setup.json by the setup's own writer (guidedSetup, applySetup), and the REPL's
// route is read from it (resolveChatRoute): the header's words, the refusal when no model is chosen, TIMMY_CHAT_MODEL and
// this session's /model. /model on the local route lists and switches among what Ollama has, never anything it does not list.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localModelCommand, localRouteWords, prepareLocal, resolveChatRoute, type ChatRoute } from '../src/agent/chat-route.js';
import { chatChoices } from '../src/setup/chat-question.js';
import { listOllamaModels, ollamaAt } from '../src/setup/ollama-models.js';
import { readSetupState, setupSummary } from '../src/setup/questions.js';
import { wrap } from '../src/setup/terminal.js';
import { guidedSetup } from '../src/utils/init.js';
import { closedPort, startFakeOllama, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const VARS = ['TIMMY_HOME', 'TIMMY_PRIVATE_DIR', 'TIMMY_REPO_ROOT', 'TIMMY_SETTINGS_DIR', 'OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'TIMMY_CHAT_NUM_CTX'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
const fakes: FakeOllama[] = [];
let box = '';
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'chat-route-'));
  mkdirSync(join(box, 'repo'));
  process.env.TIMMY_HOME = join(box, 'home', 'timmy');
  process.env.TIMMY_REPO_ROOT = join(box, 'repo');
  process.env.TIMMY_SETTINGS_DIR = join(box, 'settings');
  for (const v of ['TIMMY_PRIVATE_DIR', 'OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'TIMMY_CHAT_NUM_CTX'] as const) delete process.env[v];
});
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
  for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
  rmSync(box, { recursive: true, force: true });
});
const fake = async (o: Parameters<typeof startFakeOllama>[0]): Promise<FakeOllama> => { const f = await startFakeOllama(o); fakes.push(f); return f; };
const home = (): string => process.env.TIMMY_HOME!;
/** A home a setup wrote: providers.json and setup.json, as applySetup writes them. */
function setUp(answers: Record<string, unknown>, ollama = 'http://127.0.0.1:11434'): void {
  mkdirSync(home(), { recursive: true });
  writeFileSync(join(home(), 'providers.json'), JSON.stringify({ ollama_host: ollama }));
  writeFileSync(join(home(), 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama, project: 'demo', ...answers } }));
}
const local = (r: ChatRoute): Extract<ChatRoute, { kind: 'local' }> => { if (r.kind !== 'local') throw new Error(`not local: ${r.kind}`); return r; };
/** Answers typed in order, as a person would; every prompt and line is kept. */
const typing = (answers: string[]) => {
  const prompts: string[] = [];
  const lines: string[] = [];
  return { prompts, lines, io: { log: (s: string) => lines.push(s), question: async (p: string) => { prompts.push(p); return answers.shift() ?? ''; }, hidden: async (p: string) => { prompts.push(p); return answers.shift() ?? ''; } } };
};
const text = (rows: Array<Array<{ text: string }>>): string => rows.map((r) => r.map((s) => s.text).join('')).join('\n');
const glyphs = { ok: '✓', fail: '✖', arrow: '→', bullet: '●' };
const MODELS = [
  { name: 'big:120b-cloud', remote_host: 'https://ollama.example:443' },
  { name: 'qwen3:8b' },
  { name: 'gpt-oss:20b', size: 13_800_000_000, details: { parameter_size: '20.9B', quantization_level: 'MXFP4' } },
];

describe('the models Ollama lists (FAKE Ollama)', () => {
  it('labels each local weights or cloud-backed (a name that says cloud, or a remote host Ollama names), with what it reports', async () => {
    const ollama = await fake({ models: [...MODELS, { name: 'hidden:latest', remote_host: 'https://ollama.example:443' }] });
    const list = await listOllamaModels(ollama.url);
    if (!list.ok) throw new Error(list.why);
    expect(list.at).toEqual({ origin: ollama.url, host: ollama.host, loopback: true });
    expect(list.models.map((m) => [m.name, m.cloud])).toEqual([['big:120b-cloud', true], ['qwen3:8b', false], ['gpt-oss:20b', false], ['hidden:latest', true]]);
    expect(list.models[2]).toMatchObject({ size: 13_800_000_000, parameterSize: '20.9B', quantization: 'MXFP4' });
    expect(ollama.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/tags']);
  });

  it('says why there is no list: nothing answered, or an address Timmy does not use (nothing asked)', async () => {
    const port = await closedPort();
    expect(await listOllamaModels(`127.0.0.1:${port}`)).toMatchObject({ ok: false, state: 'no answer', why: 'the connection failed (ECONNREFUSED)' });
    expect(await listOllamaModels('http://user:pw@127.0.0.1:11434')).toMatchObject({ ok: false, state: 'not asked' });
    // another computer's address (a documentation address, 192.0.2.x) is told apart from this one
    expect(ollamaAt('192.0.2.10:11434')).toEqual({ origin: 'http://192.0.2.10:11434', host: '192.0.2.10:11434', loopback: false });
    expect(ollamaAt('')).toEqual({ origin: 'http://127.0.0.1:11434', host: '127.0.0.1:11434', loopback: true });
  });
});

describe('the setup\'s chat question, in a terminal (FAKE Ollama)', () => {
  it('lists the models numbered and labelled; a cloud-backed one is never preselected; Enter takes the first local one', async () => {
    const ollama = await fake({ models: MODELS });
    const c = chatChoices(await listOllamaModels(ollama.url), ollama.url, wrap);
    expect(c.lines).toEqual([
      '  Chat model',
      `    Ollama at ${ollama.host} lists 3 models:`,
      '     1  big:120b-cloud · cloud-backed: Ollama sends the chat',
      '        off this computer',
      '     2  qwen3:8b · local weights · 8B · Q4_K_M · 5.2 GB',
      '     3  gpt-oss:20b · local weights · 20.9B · MXFP4 · 13.8',
      '        GB',
      '    Local weights: on this computer, free, private, no key.',
      '    o  OpenRouter: a paid cloud service',
      '       Your messages go to OpenRouter and each answer costs',
      '       money. Asks for your key next.',
      '    Type 1 to 3 or o; Enter takes the one in brackets.',
    ]);
    expect(c.lines.filter((l) => [...l].length > 60)).toEqual([]);
    expect(c.shown).toBe('2');
    expect(c.read('')).toEqual({ ok: true, chat: 'local', model: 'qwen3:8b' });
    expect(c.read('1')).toEqual({ ok: true, chat: 'local', model: 'big:120b-cloud' });
    expect(c.read('gpt-oss:20b')).toEqual({ ok: true, chat: 'local', model: 'gpt-oss:20b' });
    expect(c.read('o')).toEqual({ ok: true, chat: 'openrouter' });
    expect(c.read('9')).toEqual({ ok: false, why: 'No model number 9: type 1 to 3.' });
    expect(c.read('llama9')).toEqual({ ok: false, why: 'Type 1 to 3 or o; Enter takes the one in brackets.' });
  });

  it('with no model, or only cloud-backed ones, says how to get one and preselects the local chat off (l)', async () => {
    const none = await fake({ models: [] });
    const c = chatChoices(await listOllamaModels(none.url), none.url, wrap);
    expect(c.lines.join('\n')).toContain(`Ollama at ${none.host} lists no model.`);
    expect(c.lines.join('\n')).toContain('    l  local model only: off until a model is chosen');
    expect(c.lines.join(' ').replace(/\s+/g, ' ')).toContain('Timmy downloads nothing: install one yourself with ollama pull <model>. Then /setup chat in the REPL.');
    expect(c.shown).toBe('l');
    expect(c.read('')).toEqual({ ok: true, chat: 'local', model: '' });
    const cloudOnly = await fake({ models: [MODELS[0]] });
    const d = chatChoices(await listOllamaModels(cloudOnly.url), cloudOnly.url, wrap);
    expect(d.shown).toBe('l');
    expect(d.read('')).toEqual({ ok: true, chat: 'local', model: '' });
    expect(d.read('1')).toEqual({ ok: true, chat: 'local', model: 'big:120b-cloud' });
    const port = await closedPort();
    const e = chatChoices(await listOllamaModels(`127.0.0.1:${port}`), `127.0.0.1:${port}`, wrap);
    expect(e.lines.join(' ').replace(/\s+/g, ' ')).toContain(`Ollama at 127.0.0.1:${port} did not answer (the connection failed (ECONNREFUSED)).`);
    expect(e.lines.filter((l) => [...l].length > 60)).toEqual([]);
    // Ollama gave no list: a model's own name is taken as typed (the chat checks it at its first message)
    expect(e.read('qwen3:8b')).toEqual({ ok: true, chat: 'local', model: 'qwen3:8b' });
  });

  it('timmy init\'s guided setup asks it with the list, writes the model to setup.json, and the REPL\'s route reads it', async () => {
    const ollama = await fake({ models: MODELS });
    // operator, identity (a new key), the FAKE Ollama's address, chat (Enter: the first local model), project, proceed
    const t = typing(['Sample', '', ollama.url, '', 'demo', '']);
    expect(await guidedSetup('timmy init', {}, t.io)).toBe(0);
    expect(t.prompts).toEqual(['  > [operator] ', '  > [new key] ', '  > [http://127.0.0.1:11434] ', '  > [2] ', '  > [first-light] ', '  Proceed? [Y/n] ']);
    const said = t.lines.join('\n');
    expect(said).toContain('     1  big:120b-cloud · cloud-backed: Ollama sends the chat');
    expect(said.replace(/\s+/g, ' ')).toContain(`chat: local model qwen3:8b (Ollama at ${ollama.host}; no key)`);
    const setup = JSON.parse(readFileSync(join(home(), 'setup.json'), 'utf8'));
    expect(setup.answers).toMatchObject({ chat: 'local', model: 'qwen3:8b', ollama: ollama.url });
    expect(setupSummary(readSetupState())).toBe(`operator Sample · chat: local model qwen3:8b (Ollama at ${ollama.host}; no key) · logs: this computer only · project demo`);
    const r = local(resolveChatRoute());
    expect(r).toMatchObject({ host: ollama.url, model: 'qwen3:8b', from: 'the setup', cloud: false });
    expect(localRouteWords(r)).toBe('chat: local qwen3:8b · Ollama');
  });
});

describe('the chat\'s route, from the setup', () => {
  it('OpenRouter unless the setup chose the local model; the local route\'s model: /model, then TIMMY_CHAT_MODEL, then the setup', () => {
    expect(resolveChatRoute()).toEqual({ kind: 'openrouter' });
    setUp({ chat: 'openrouter' });
    expect(resolveChatRoute()).toEqual({ kind: 'openrouter' });
    setUp({ chat: 'local', model: 'qwen3:8b' });
    expect(local(resolveChatRoute())).toMatchObject({ model: 'qwen3:8b', from: 'the setup' });
    process.env.TIMMY_CHAT_MODEL = 'gpt-oss:20b';
    expect(local(resolveChatRoute())).toMatchObject({ model: 'gpt-oss:20b', from: 'TIMMY_CHAT_MODEL' });
    expect(local(resolveChatRoute({ session: 'llama3.2:3b' }))).toMatchObject({ model: 'llama3.2:3b', from: 'this session (/model)' });
    process.env.TIMMY_CHAT_MODEL = 'not a name';
    expect(local(resolveChatRoute())).toMatchObject({ model: 'qwen3:8b', note: 'TIMMY_CHAT_MODEL is set to something that is not a model name, so it is not used' });
  });

  it('the header names the route; with no model chosen the chat is off and a message gets why, sending nothing', () => {
    setUp({ chat: 'local', model: '' });
    const r = local(resolveChatRoute());
    expect(r.model).toBeNull();
    expect(localRouteWords(r)).toBe('chat: local · no model chosen · /model');
    const ready = prepareLocal(r, glyphs);
    if (!('refusal' in ready)) throw new Error('expected a refusal');
    expect(text(ready.refusal)).toBe([
      '✖ Error: the chat is set to the local model, and no model is chosen.',
      '  Cause: the setup recorded none for Ollama at 127.0.0.1:11434.',
      '  Try: /model (lists what Ollama has), then /model <name>; /setup chat keeps one',
      '  Nothing was sent to any model.',
    ].join('\n'));
    // a cloud-backed model, and another computer's Ollama (a documentation address), each said in the header
    setUp({ chat: 'local', model: 'big:120b-cloud' });
    // R11 Phase 2 (H169, item c): a ":cloud" name is Ollama's cloud route, named as such
    expect(localRouteWords(local(resolveChatRoute()))).toBe('chat: ollama cloud · big:120b-cloud');
    setUp({ chat: 'local', model: 'big:120b-cloud' }, 'http://192.0.2.10:11434');
    expect(localRouteWords(local(resolveChatRoute()))).toBe('chat: ollama cloud · big:120b-cloud through the Ollama at 192.0.2.10:11434 (not this computer)');
    setUp({ chat: 'local', model: 'qwen3:8b' }, 'http://192.0.2.10:11434');
    expect(localRouteWords(local(resolveChatRoute()))).toBe('chat: local qwen3:8b · Ollama at 192.0.2.10:11434 (not this computer)');
    setUp({ chat: 'local', model: 'qwen3:8b' }, 'http://127.0.0.1:11434/ollama');
    expect(localRouteWords(local(resolveChatRoute()))).toBe('chat: local · the Ollama address is not usable · /setup chat');
  });
});

describe('/model on the local route (FAKE Ollama)', () => {
  it('lists what Ollama has, marks the model in use, and switches only to a model it lists (a cloud-backed one said so)', async () => {
    const ollama = await fake({ models: MODELS });
    setUp({ chat: 'local', model: 'qwen3:8b' }, ollama.url);
    const r = local(resolveChatRoute());
    let chosen: string | null = null;
    const set = (m: string): void => { chosen = m; };
    const listing = text(await localModelCommand('', r, { set, glyphs }));
    expect(listing).toContain(`  Chat     local · Ollama at ${ollama.host}`);
    expect(listing).toContain('  Model    qwen3:8b (the setup)');
    expect(listing).toMatch(/ {3}1 {2}big:120b-cloud {2}cloud-backed: Ollama sends the chat off this computer/);
    expect(listing).toMatch(/● {2}2 {2}qwen3:8b {8}local weights · 8B · Q4_K_M · 5\.2 GB/);
    expect(listing).toContain('/model <name or number> switches for this session; /setup chat keeps one for every start.');
    expect(chosen).toBeNull();
    const cloud = text(await localModelCommand('1', r, { set, glyphs }));
    expect(chosen).toBe('big:120b-cloud');
    expect(cloud).toContain('✓ Chat model qwen3:8b → big:120b-cloud for this session');
    expect(cloud).toContain('Ollama cloud: big:120b-cloud runs on Ollama\'s servers; your account\'s terms. Ollama sends the chat off this computer; no cost comes back (unknown).');
    expect(cloud).not.toMatch(/no charge|: free/);
    const named = text(await localModelCommand('gpt-oss:20b', r, { set, glyphs }));
    expect(chosen).toBe('gpt-oss:20b');
    expect(named).toContain('local weights · 20.9B · MXFP4 · 13.8 GB · takes tool calls');
    chosen = null;
    expect(text(await localModelCommand('llama9:70b', r, { set, glyphs }))).toContain(`Nothing changed: Ollama at ${ollama.host} lists no model named llama9:70b.`);
    expect(chosen).toBeNull();
    // nothing downloaded, nothing chatted: /model only lists and asks what a model can do
    expect(new Set(ollama.requests.map((r) => r.path))).toEqual(new Set(['/api/tags', '/api/show']));
  });

  it('with Ollama not answering, nothing changes and it says why', async () => {
    const port = await closedPort();
    setUp({ chat: 'local', model: 'qwen3:8b' }, `http://127.0.0.1:${port}`);
    const r = local(resolveChatRoute());
    let chosen: string | null = null;
    const out = text(await localModelCommand('qwen3:8b', r, { set: (m) => { chosen = m; }, glyphs }));
    expect(out).toBe(`  ✖ Nothing changed: Ollama at 127.0.0.1:${port} did not answer (the connection failed (ECONNREFUSED)), so Timmy cannot check that it has qwen3:8b.`);
    expect(chosen).toBeNull();
  });
});
