// R4 (H103): the chat's route said the same everywhere, and r25's D12.
//
// - D12: the blank-slate text (exit 78) and the setup's "Will write only to" said the receipts store pin two ways for the same
//   file ("<repo>/.timmy/store-pin" and "~/work/.timmy/store-pin"); now one wording, the same path in the same form.
// - `timmy init --chat local --model <name>` records the local chat's model, checked against what the Ollama lists (a FAKE
//   Ollama here: tests/fixtures/fake-ollama-chat.ts); a model it does not list, an Ollama that does not answer, or a chat that
//   is not local write nothing. Nothing is downloaded.
// - `timmy doctor` on the local route with a model chosen: that route, not "no model key" (src/agent/chat-readiness.ts; and
//   the doctor itself, run as a child process with its --json).
// - The REPL's /tools row says the chat's route (src/capabilities/index.ts).
// Real files in this test's own folders; nothing contacts a model.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatReadiness } from '../src/agent/chat-readiness.js';
import { resolveChatRoute } from '../src/agent/chat-route.js';
import { capabilities } from '../src/capabilities/index.js';
import { guidedSetup, printBlankSlateBanner, runInit, storePinWords } from '../src/utils/init.js';
import { closedPort, startFakeOllama, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const VARS = ['HOME', 'TIMMY_HOME', 'TIMMY_PRIVATE_DIR', 'TIMMY_REPO_ROOT', 'TIMMY_SETTINGS_DIR', 'OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
const fakes: FakeOllama[] = [];
let box = '';
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'chat-elsewhere-'));
  mkdirSync(join(box, 'home', 'work'), { recursive: true });
  mkdirSync(join(box, 'repo'));
  process.env.HOME = join(box, 'home');
  process.env.TIMMY_HOME = join(box, 'home', 'timmy');
  process.env.TIMMY_SETTINGS_DIR = join(box, 'settings');
  for (const v of ['TIMMY_PRIVATE_DIR', 'TIMMY_REPO_ROOT', 'OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL'] as const) delete process.env[v];
  // R4 lead: the workspace is this test's own folder (a case sets its own): an in-process `timmy init` otherwise wrote
  // .timmy/private/ and .timmy/store-pin into the checkout it ran from (the full suite at 1a11057 caught it through
  // tests/edge-host.test.ts, which reads that private overlay)
  process.env.TIMMY_REPO_ROOT = join(box, 'repo');
});
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
  for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
  rmSync(box, { recursive: true, force: true });
});
const fake = async (o: Parameters<typeof startFakeOllama>[0]): Promise<FakeOllama> => { const f = await startFakeOllama(o); fakes.push(f); return f; };
const home = (): string => process.env.TIMMY_HOME!;
function setUp(answers: Record<string, unknown>, ollama: string): void {
  mkdirSync(home(), { recursive: true });
  writeFileSync(join(home(), 'providers.json'), JSON.stringify({ ollama_host: ollama }));
  writeFileSync(join(home(), 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama, project: 'demo', ...answers } }));
}
const said = () => { const lines: string[] = []; return { lines, log: (s: string) => { lines.push(...String(s).split('\n')); } }; };

describe('the receipts store pin, said one way (D12)', () => {
  for (const [where, repo, words] of [
    ['a workspace under the home folder', () => join(box, 'home', 'work'), '~/work/.timmy/store-pin (the receipts store)'],
    ['a workspace outside it', () => join(box, 'repo'), '<repo>/.timmy/store-pin (the receipts store)'],
  ] as const) {
    it(`${where}: the blank-slate text and the setup's Proceed screen say the same path in the same form`, async () => {
      process.env.TIMMY_REPO_ROOT = repo();
      expect(storePinWords()).toBe(words);
      const banner = said();
      printBlankSlateBanner(banner.log);
      const fromBanner = banner.lines.filter((l) => l.includes('store-pin')).map((l) => l.trim());
      // the guided setup, answered with Enter (each preselected answer), then n at "Proceed?": nothing is written
      // the operator, the identity (asked hidden), the Ollama host, the chat, the project; then Proceed
      const answers = ['', '', '', '', '', 'n'];
      const proceed = said();
      const code = await guidedSetup('timmy init', {}, { log: proceed.log, question: async () => answers.shift() ?? 'n', hidden: async () => answers.shift() ?? '' });
      expect(code, proceed.lines.join('\n')).toBe(1);
      const fromProceed = proceed.lines.filter((l) => l.includes('store-pin')).map((l) => l.trim());
      expect(fromBanner).toEqual([words]);
      expect(fromProceed).toEqual([words]);
      expect(existsSync(join(repo(), '.timmy', 'store-pin'))).toBe(false);
    });
  }
});

describe('timmy init --chat local --model <name> (FAKE Ollama)', () => {
  const MODELS = [{ name: 'qwen3:8b' }, { name: 'big:120b-cloud', remote_host: 'https://ollama.example:443' }];
  const init = async (args: string[]) => { const out = said(); const code = await runInit(['--yes', '--operator', 'Sample', '--project', 'demo', ...args], { isTTY: false, log: out.log }); return { code, text: out.lines.join(' ').replace(/\s+/g, ' ') }; };

  it('records a model the Ollama lists; the route then answers with it', async () => {
    const ollama = await fake({ models: MODELS });
    const r = await init(['--chat', 'local', '--model', 'qwen3:8b', '--ollama', ollama.url]);
    expect(r.code, r.text).toBe(0);
    expect(JSON.parse(readFileSync(join(home(), 'setup.json'), 'utf8')).answers).toMatchObject({ chat: 'local', model: 'qwen3:8b' });
    expect(resolveChatRoute()).toMatchObject({ kind: 'local', model: 'qwen3:8b', from: 'the setup' });
    expect(ollama.requests.map((q) => `${q.method} ${q.path}`)).toEqual(['GET /api/tags']);
  });

  it('a model the Ollama does not list, an Ollama that does not answer, a chat that is not local: nothing is written', async () => {
    const ollama = await fake({ models: MODELS });
    const missing = await init(['--chat', 'local', '--model', 'llama9:70b', '--ollama', ollama.url]);
    expect(missing.code).toBe(2);
    expect(missing.text).toContain(`Nothing was written: Ollama at ${ollama.host} lists no model named llama9:70b. Timmy downloads nothing: install one yourself with ollama pull llama9:70b. Then run this again.`);
    const port = await closedPort();
    const down = await init(['--chat', 'local', '--model', 'qwen3:8b', '--ollama', `127.0.0.1:${port}`]);
    expect(down.code).toBe(1);
    expect(down.text).toMatch(/Nothing was written: Ollama at 127\.0\.0\.1:\d+ did not answer .*so Timmy cannot check that it lists qwen3:8b\. Start Ollama/);
    // R11 (H169, Phase 0 item 1): with --chat openrouter, --model names an OpenRouter model (an id as the catalog names it), so
    // a local model's name is refused as one, and nothing is written
    const paid = await init(['--chat', 'openrouter', '--model', 'qwen3:8b']);
    expect(paid.code).toBe(2);
    expect(paid.text).toContain('--model with --chat openrouter takes a model\'s id as the catalog names it');
    expect(existsSync(join(home(), 'setup.json'))).toBe(false);
  });

  it('a cloud-backed model is taken by its own name, and said to leave this computer', async () => {
    const ollama = await fake({ models: MODELS });
    const r = await init(['--chat', 'local', '--model', 'big:120b-cloud', '--ollama', ollama.url]);
    expect(r.code).toBe(0);
    expect(r.text).toContain('big:120b-cloud runs on Ollama\'s servers; your account\'s terms. Ollama sends the chat off this computer, and no cost comes back (unknown).');
  });
});

describe('timmy doctor on the chat\'s route', () => {
  it('the local route with a model its Ollama lists: ready, no model key needed; without a model, or not listed, or no answer: why, and the fix', async () => {
    const ollama = await fake({ models: [{ name: 'qwen3:8b' }] });
    setUp({ chat: 'local', model: 'qwen3:8b' }, ollama.url);
    const ok = await chatReadiness({ env: process.env, node: '24.21.0', keySource: null });
    expect(ok).toMatchObject({ route: 'local', answers: true, exitLine: expect.stringMatching(/^Exit 0: the REPL is ready\./), next: 'Next step: `timmy` opens the REPL.' });
    expect(ok.replLine).toBe(`  ✓ REPL: ready (Node 24.21.0): the chat is the local model qwen3:8b on Ollama at ${ollama.host}, which lists it now; no model key is needed, and nothing is charged. No model was run.`);
    expect(ollama.requests.map((q) => `${q.method} ${q.path}`)).toEqual(['GET /api/tags']);
    setUp({ chat: 'local', model: '' }, ollama.url);
    const none = await chatReadiness({ env: process.env, node: '24.21.0', keySource: null });
    expect(none).toMatchObject({ answers: false, exitLine: expect.stringMatching(/^Exit 78: the REPL opens, but its chat cannot answer until the local model is ready/) });
    expect(none.replLine).toBe(`  ! REPL: opens, but its chat cannot answer yet (Node 24.21.0): the chat is set to the local model (Ollama at ${ollama.host}), and no model is chosen; timmy init --chat local --model <name> (a model Ollama lists); or /model in the REPL`);
    setUp({ chat: 'local', model: 'llama9:70b' }, ollama.url);
    expect((await chatReadiness({ env: process.env, node: '24.21.0', keySource: null })).replLine).toContain('answers but lists no model by that name; ollama pull llama9:70b (Timmy downloads nothing)');
    setUp({ chat: 'local', model: 'qwen3:8b' }, `127.0.0.1:${await closedPort()}`);
    expect((await chatReadiness({ env: process.env, node: '24.21.0', keySource: null })).replLine).toMatch(/did not answer .*; start Ollama \(the Ollama app, or ollama serve\)$/);
    // the OpenRouter route: the key's own lines stand
    setUp({ chat: 'openrouter' }, ollama.url);
    expect(await chatReadiness({ env: process.env, node: '24.21.0', keySource: 'providers.json' })).toEqual({ route: 'openrouter', answers: true, json: { route: 'openrouter', key: 'providers.json' } });
  });

  it('the doctor itself (a child process): its --json names the local route, and it is not "no model key"', async () => {
    const ollama = await fake({ models: [{ name: 'qwen3:8b' }] });
    setUp({ chat: 'local', model: 'qwen3:8b' }, ollama.url);
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TIMMY_HOME: home(), TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, TIMMY_PRIVATE_DIR: join(box, 'private'), TIMMY_STORE: join(box, 'store'), OPENROUTER_API_KEY: '' };
    // a child process, not spawnSync: the FAKE Ollama answers the doctor's GET /api/tags from this process's event loop
    const run = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, resolve('scripts/timmy-doctor.ts'), ...args], { cwd: join(box, 'repo'), env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('close', (status) => done({ status, stdout, stderr }));
    });
    const j = await run(['doctor', '--json']);
    const report = JSON.parse(j.stdout.slice(j.stdout.indexOf('{')));
    expect(report.chat).toMatchObject({ route: 'local', model: 'qwen3:8b', listed: true, ready: true });
    const supported = Number(process.versions.node.split('.')[0]) >= 24;
    expect(report.readiness.repl.state).toBe(supported ? 'ready' : 'unsupported');
    const t = await run(['doctor']);
    expect(t.status, t.stderr).toBe(supported ? 0 : 1);
    expect(t.stdout).not.toMatch(/REPL: opens, but has no model key/);
    if (supported) expect(t.stdout).toContain('✓ REPL: ready');
  }, 120_000);
});

describe('the REPL\'s /tools row says the chat\'s route', () => {
  const none = {
    env: {}, onPath: () => false, exists: () => false, canvasBuilt: () => false,
    studio: async () => ({ state: 'none' as const, detail: 'nothing answered' }), studioBase: 'http://127.0.0.1:4337',
    ollama: async () => ({ ok: false, models: [] }), openrouter: async () => 'no-key' as const, modelKeySource: () => null, model: 'm',
    http: async () => null, lanes: () => [], adapters: () => [], receipts: () => ({ ok: true, count: 0 }), exercised: () => new Map<string, string>(), edgeSet: () => false,
  };
  const repl = async (deps: Partial<Parameters<typeof capabilities>[0]>) => (await capabilities({ ...none, ...deps } as Parameters<typeof capabilities>[0])).find((r) => r.id === 'repl');
  it('the local route with a model: installed, no key needed; without one: needs setup with the command that sets it; OpenRouter: the key', async () => {
    setUp({ chat: 'local', model: 'qwen3:8b' }, 'http://127.0.0.1:11434');
    expect(await repl({ chatRoute: () => resolveChatRoute() })).toMatchObject({ rung: 'installed', detail: 'chat: local qwen3:8b · Ollama at 127.0.0.1:11434 (no model key needed)' });
    setUp({ chat: 'local', model: '' }, 'http://127.0.0.1:11434');
    expect(await repl({ chatRoute: () => resolveChatRoute() })).toMatchObject({ rung: 'needs setup', detail: 'chat: local · no model chosen', setup: 'timmy init --chat local --model <name>, or /model in the REPL' });
    setUp({ chat: 'openrouter' }, 'http://127.0.0.1:11434');
    expect(await repl({ chatRoute: () => resolveChatRoute(), modelKeySource: () => 'environment' })).toMatchObject({ rung: 'installed', detail: 'chat: OpenRouter · model key from the environment' });
    // without the route (an older caller), the row is as it was
    expect(await repl({})).toMatchObject({ rung: 'needs setup', detail: 'no model key' });
  });
});
