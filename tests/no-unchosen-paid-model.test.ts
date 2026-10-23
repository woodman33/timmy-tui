/**
 * R11 Phase 0 (H172; the order of 2026-10-23: "Never claim readiness without a real check or silently substitute a paid
 * model"; the plan's section 4, Phase 0: "every surface refuses an unchosen paid model in a test"): with an OpenRouter key
 * present and NO model chosen, no surface sends anything to OpenRouter, and each says its "no model chosen" words.
 *
 * Written against H169's intended behaviour (briefs/R11-H169.txt, item 1 and 2), before it landed: on 2aa42e25 the REPL, the
 * monitor's session and the Workbench's session send to the shipped paid default (anthropic/claude-opus-4.7), the companion
 * page asks a fixed qwen/qwen3.8-max, and `timmy init --chat openrouter` leaves the shipped default as the model: every case
 * here FAILS there, and passes once the default is NONE and each surface refuses.
 *
 * FAKE, said where used: the key is FAKE, made at run time, in this test's own Timmy home (TIMMY_HOME, TIMMY_SETTINGS_DIR);
 * every request a surface makes goes through a FAKE fetch in this process (records the address and the model named, answers
 * OpenRouter with HTTP 400, refuses anything else before it leaves) or, for the REPL child process, through the FAKE
 * OpenRouter preload (tests/fixtures/fake-openrouter-preload.mjs: every request logged, nothing reaches the network).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openChatSession } from '../src/agent/chat-session.js';
import { createAgent } from '../src/agent/core.js';
import { pageRoute } from '../src/companion/chat-route.js';
import { loadConfig } from '../src/utils/config.js';
import { runInit } from '../src/utils/init.js';

const REPO = resolve(import.meta.dirname, '..');
const LOADER = pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const PRELOAD = join(REPO, 'tests', 'fixtures', 'fake-openrouter-preload.mjs');
const CLI = join(REPO, 'src', 'cli.ts');

/** The words H169's brief gives the REPL and the monitor (item 1); the companion page's (item 2). */
const REPL_WORDS = 'No model chosen. /model <id> chooses one (/model free lists free ones).';
const PAGE_WORDS = 'No model chosen: choose one in Models';
const NOTHING_SENT = 'Nothing was sent to any model.';

const VARS = ['HOME', 'TIMMY_HOME', 'TIMMY_SETTINGS_DIR', 'TIMMY_REPO_ROOT', 'TIMMY_PRIVATE_DIR', 'TIMMY_STORE', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'TIMMY_CHAT_MODEL', 'TIMMY_CHAT_FREE_ONLY', 'TIMMY_CHAT_LOCAL_ONLY', 'OLLAMA_HOST'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let box = '';
let project = '';
const restore: Array<() => void> = [];

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'no-unchosen-paid-'));
  project = join(box, 'project');
  mkdirSync(join(project, '.timmy'), { recursive: true });
  // the project's own receipts store, pinned in its folder: a turn's seal lands there, never in a real store
  writeFileSync(join(project, '.timmy', 'store-pin'), join(project, '.timmy', 'receipts'));
  process.env.HOME = join(box, 'home');
  process.env.TIMMY_HOME = join(box, 'home', 'timmy');
  process.env.TIMMY_SETTINGS_DIR = join(box, 'settings');
  process.env.TIMMY_REPO_ROOT = project;
  for (const v of ['TIMMY_PRIVATE_DIR', 'TIMMY_STORE', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'TIMMY_CHAT_MODEL', 'TIMMY_CHAT_FREE_ONLY', 'TIMMY_CHAT_LOCAL_ONLY', 'OLLAMA_HOST'] as const) delete process.env[v];
});
afterEach(() => {
  for (const r of restore.splice(0)) r();
  for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
  rmSync(box, { recursive: true, force: true });
});

/** A FAKE OpenRouter key, saved where `timmy init --openrouter -` saves one (providers.json, 0600); no model anywhere. */
function savedKey(): string {
  const home = process.env.TIMMY_HOME!;
  mkdirSync(home, { recursive: true });
  const key = `sk-or-FAKE-${randomBytes(8).toString('hex')}`;
  writeFileSync(join(home, 'providers.json'), JSON.stringify({ openrouter_api_key: key }), { mode: 0o600 });
  return key;
}
/** The setup as `timmy init --chat openrouter` leaves it with that key saved: the OpenRouter route, and NO model chosen. */
function keyedSetup(): string {
  const key = savedKey();
  writeFileSync(join(process.env.TIMMY_HOME!, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: '127.0.0.1:11434', project: 'demo', chat: 'openrouter' } }));
  return key;
}

interface Asked { method: string; host: string; path: string; model: string | null }
/**
 * A FAKE fetch for this process: every request recorded (its address and the model its body names); one to openrouter.ai
 * answered as a FAKE OpenRouter does in tests/route-policy-agent.test.ts (HTTP 400: no model behind it, no charge, so the
 * agent tries what it would try next and that is recorded too); any other refused before it leaves (ECONNREFUSED).
 */
function fakeNetwork(): { asked: Asked[]; openRouter: () => Asked[] } {
  const original = globalThis.fetch;
  const asked: Asked[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    // the body: given beside the address, or inside a Request (the OpenRouter SDK builds one)
    let text = '';
    try { text = init?.body !== undefined && init.body !== null ? String(init.body) : input instanceof Request ? await input.clone().text() : ''; } catch { text = ''; }
    let model: string | null = null;
    try { const b = text ? JSON.parse(text) as { model?: unknown } : null; model = typeof b?.model === 'string' ? b.model : null; } catch { model = null; }
    asked.push({ method, host: url.hostname, path: url.pathname, model });
    if (url.hostname === 'openrouter.ai') return new Response(JSON.stringify({ error: { code: 400, message: 'FAKE OpenRouter: refused (no model here)' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    const cause = Object.assign(new Error('refused by the test\'s FAKE fetch: nothing left this process'), { code: 'ECONNREFUSED' });
    throw new TypeError('fetch failed', { cause });
  }) as typeof fetch;
  restore.push(() => { globalThis.fetch = original; });
  return { asked, openRouter: () => asked.filter((q) => q.host === 'openrouter.ai') };
}

const hooks = { onText: () => undefined, askPerson: async () => 'deny' as const };
const joined = (lines: readonly string[] | undefined): string => (lines ?? []).join('\n');

describe('no surface sends to an unchosen paid model (R11 Phase 0; FAKE key, FAKE network)', () => {
  it('the REPL (a child `timmy repl`, a message on stdin): 0 requests to OpenRouter, the REPL\'s words, a failing exit', async () => {
    keyedSetup();
    const log = join(box, 'fetch.jsonl');
    // (TIMMY_STUDIO_PORT: a turn that seals starts this REPL's own canvas server; H172's port, never 4337's)
    const child = spawn(process.execPath, ['--import', LOADER, '--import', PRELOAD, CLI, 'repl'], {
      cwd: project,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, TIMMY_REPO_ROOT: project, TIMMY_TEST_FETCH_LOG: log, NO_COLOR: '1', TERM: 'dumb', TIMMY_STUDIO_PORT: '4494' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    child.stdin.end('hello\n');
    const code = await new Promise<number | null>((done) => child.on('exit', (c) => done(c)));
    const requests = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { method: string; url: string; body: { model?: string } | null }) : [];
    const toOpenRouter = requests.filter((q) => /openrouter\.ai/.test(q.url));
    expect(toOpenRouter.map((q) => `${q.method} ${q.url} ${q.body?.model ?? ''}`), `the REPL sent to OpenRouter with no model chosen:\n${out}`).toEqual([]);
    expect(out, 'the REPL\'s refusal').toContain(REPL_WORDS);
    expect(out).toContain(NOTHING_SENT);
    expect(code, `a refused message is a failing exit in a pipe; the REPL said:\n${out}`).not.toBe(0);
  }, 60_000);

  it('the monitor\'s chat session (surface monitor, on its own agent from loadConfig): refused, 0 requests, the same words', async () => {
    keyedSetup();
    const net = fakeNetwork();
    // as `timmy watch` builds it (src/tui/fast-entry.tsx, ShellV2): its config from loadConfig(), its own agent on it
    const config = loadConfig();
    expect(config.apiKey, 'the FAKE key is found').toMatch(/^sk-or-FAKE-/);
    const agent = createAgent({ apiKey: config.apiKey ?? '', model: config.model ?? '', instructions: '', maxSteps: 2, maxCost: 1 }, { multiplexer: 'none' });
    const chat = await openChatSession({ project: { name: 'demo', root: project }, surface: 'monitor' }, { agent, config: { apiKey: config.apiKey, model: config.model } });
    const r = await chat.send('hello', hooks);
    expect(net.openRouter().map((q) => `${q.method} ${q.path} ${q.model ?? ''}`), 'the monitor sent to OpenRouter with no model chosen').toEqual([]);
    expect(r.status, `the monitor's turn: ${JSON.stringify(r)}`).toBe('refused');
    expect(r.sent).toBe(false);
    expect(joined(r.lines)).toContain(REPL_WORDS);
    expect(joined(r.lines)).toContain(NOTHING_SENT);
    // the route it shows before any message says the same
    expect(chat.route().ready).toBe(false);
    expect(joined(chat.route().refusal)).toMatch(/no model chosen/i);
  });

  it('the Workbench\'s chat session (surface workbench, the agent from loadConfig): refused, 0 requests, says no model is chosen', async () => {
    keyedSetup();
    const net = fakeNetwork();
    const chat = await openChatSession({ project: { name: 'demo', root: project }, surface: 'workbench' });
    const r = await chat.send('hello', hooks);
    expect(net.openRouter().map((q) => `${q.method} ${q.path} ${q.model ?? ''}`), 'the Workbench session sent to OpenRouter with no model chosen').toEqual([]);
    expect(r.status, `the Workbench's turn: ${JSON.stringify(r)}`).toBe('refused');
    expect(r.sent).toBe(false);
    expect(joined(r.lines)).toMatch(/no model chosen/i);
    expect(joined(r.lines)).toContain(NOTHING_SENT);
    expect(chat.route().ready).toBe(false);
  });

  it('the companion page\'s own Send (pageRoute): off, no-model-chosen, its words; no fixed model of its own', () => {
    keyedSetup();
    const page = pageRoute(process.env, project);
    expect(page.ready, `the page's route: ${JSON.stringify(page)}`).toBe(false);
    expect(page.kind).toBe('none');
    // H169's brief, item 2: the contract the page draws Send off by
    expect((page as { reason?: string }).reason).toBe('no-model-chosen');
    expect(`${page.label} ${page.words}`).toContain(PAGE_WORDS);
    // nothing of the page names a model nobody chose
    expect(JSON.stringify(page)).not.toMatch(/qwen3\.8-max|claude-opus/);
  });

  it('`timmy init --chat openrouter` with no --model (a key saved) records the route and no model; the config then names none', async () => {
    savedKey();
    const lines: string[] = [];
    const code = await runInit(['--yes', '--operator', 'Sample', '--project', 'demo', '--chat', 'openrouter'], { isTTY: false, log: (s) => { lines.push(...String(s).split('\n')); } });
    expect(code, lines.join('\n')).toBe(0);
    const answers = (JSON.parse(readFileSync(join(process.env.TIMMY_HOME!, 'setup.json'), 'utf8')) as { answers: Record<string, unknown> }).answers;
    expect(answers.chat).toBe('openrouter');
    expect(answers.model).toBeUndefined();
    // it says a model is still to be chosen
    expect(lines.join(' ').replace(/\s+/g, ' ')).toMatch(/model is still to be chosen|no model (is )?chosen/i);
    // the shipped default is NONE: the config names no model until one is chosen
    expect(loadConfig().model || '', 'the config\'s model with none chosen').toBe('');
  });

  it('control: a model the person chose (OPENROUTER_MODEL) is the one the Workbench session asks for, and no other', async () => {
    keyedSetup();
    process.env.OPENROUTER_MODEL = 'fake-maker/fake-free-model:free';
    const net = fakeNetwork();
    const chat = await openChatSession({ project: { name: 'demo', root: project }, surface: 'workbench' });
    expect(chat.route().ready).toBe(true);
    const r = await chat.send('hello', hooks);
    const or = net.openRouter();
    expect(or.length, `requests to the FAKE OpenRouter: ${JSON.stringify(or)}`).toBeGreaterThan(0);
    expect(or[0].model).toBe('fake-maker/fake-free-model:free');
    expect(r.sent).toBe(true);
    expect(r.status).not.toBe('refused');
  });
});
