// R4 (H98): Timmy's one guided setup (src/setup/, written by src/utils/init.ts). The same questions for `timmy init`, the
// monitor and the REPL's /setup; each asked only while it has no answer; the local model and local-only logs preselected;
// anything paid or cloud opt-in and said so; an identity never replaced; a key never shown, never in setup.json.
// Real files in a temporary Timmy home; `timmy init` in a real pseudo-terminal (tmux). Keys are made at run time.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { chatRoute, knownAnswers, pendingQuestions, readSetupState, setupSummary } from '../src/setup/questions.js';
import { applyInit, guidedSetup, runInit } from '../src/utils/init.js';

const fakeKey = (): string => ['sk', 'or', 'FAKE', randomBytes(12).toString('hex')].join('-');
const VARS = ['TIMMY_HOME', 'TIMMY_PRIVATE_DIR', 'TIMMY_REPO_ROOT', 'XDG_CONFIG_HOME', 'OPENROUTER_API_KEY', 'TIMMY_EDGE_HOST'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let box = '';
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'setup-guided-'));
  mkdirSync(join(box, 'repo'));
  process.env.TIMMY_HOME = join(box, 'home', 'timmy');
  process.env.TIMMY_REPO_ROOT = join(box, 'repo');
  process.env.XDG_CONFIG_HOME = join(box, 'config');
  delete process.env.TIMMY_PRIVATE_DIR;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.TIMMY_EDGE_HOST;
});
afterEach(() => {
  for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
  rmSync(box, { recursive: true, force: true });
});
const home = (): string => process.env.TIMMY_HOME!;
const json = (f: string): Record<string, unknown> => JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
/** Answers typed in order, as a person would (null: Ctrl+C); every prompt is kept. */
const typing = (answers: Array<string | null>) => {
  const prompts: string[] = [];
  const lines: string[] = [];
  return { prompts, lines, io: { log: (s: string) => lines.push(s), question: async (p: string) => { prompts.push(p); return answers.length ? answers.shift()! : ''; }, hidden: async (p: string) => { prompts.push(p); return answers.length ? answers.shift()! : ''; } } };
};

describe('the questions, and what counts as an answer', () => {
  it('a blank home has six questions, the local model and local-only logs preselected', () => {
    const s = readSetupState();
    const pending = pendingQuestions(s);
    expect(pending.map((q) => q.id)).toEqual(['operator', 'identity', 'ollama', 'chat', 'logs', 'project']);
    expect(pending.find((q) => q.id === 'chat')!.preselect({}, s)).toBe('local');
    expect(pending.find((q) => q.id === 'logs')!.preselect({}, s)).toBe('local');
    // the paid and the cloud choices say so where they are offered
    const words = (id: string) => pending.find((q) => q.id === id)!.choices!.map((c) => `${c.label} ${c.note}`).join(' | ');
    expect(words('chat')).toMatch(/OpenRouter: a paid cloud service.*costs[\s\S]*money/);
    expect(words('logs')).toMatch(/cloud.*leave[\s\S]*this computer/);
  });

  it('what an older `timmy init` wrote counts: identity, Ollama host and project are answered; chat and logs are asked', () => {
    mkdirSync(join(home(), 'projects', 'demo'), { recursive: true });
    writeFileSync(join(home(), 'identity.json'), JSON.stringify({ version: 1, operator: 'Sample', operator_id: 'op_0123456789abcdef', seed_source: 'generated' }));
    writeFileSync(join(home(), 'providers.json'), JSON.stringify({ ollama_host: 'http://127.0.0.1:11434' }));
    expect(pendingQuestions(readSetupState()).map((q) => q.id)).toEqual(['chat', 'logs']);
    // a stored key is an answer given before: OpenRouter, so only the logs are asked
    writeFileSync(join(home(), 'providers.json'), JSON.stringify({ ollama_host: 'http://127.0.0.1:11434', openrouter_api_key: fakeKey() }));
    const s = readSetupState();
    expect({ pending: pendingQuestions(s).map((q) => q.id), chat: knownAnswers(s).chat, key: knownAnswers(s).key }).toEqual({ pending: ['logs'], chat: 'openrouter', key: 'set' });
  });

  it('the header words name the route in effect: never a paid model without a key', () => {
    expect(chatRoute({ key: false, model: 'anthropic/claude-opus-4.7' })).toBe('chat: no model key · /setup');
    expect(chatRoute({ key: true, model: 'anthropic/claude-opus-4.7' })).toBe('chat: anthropic/claude-opus-4.7 · OpenRouter');
    expect(chatRoute({ key: true, model: 'anthropic/claude-opus-4.7', short: true })).toBe('chat: claude-opus-4.7 · OpenRouter');
  });
});

describe('timmy init writes the answers once, in the Timmy home', () => {
  it('--yes takes the preselected answers: the local model, local-only logs, no key; nothing is asked afterwards', async () => {
    const lines: string[] = [];
    expect(await runInit(['--yes', '--operator', 'Sample', '--project', 'demo'], { isTTY: false, log: (s) => lines.push(s) })).toBe(0);
    const rec = json(join(home(), 'setup.json'));
    expect(rec.answers).toMatchObject({ operator: 'Sample', chat: 'local', logs: 'local', ollama: 'http://127.0.0.1:11434', project: 'demo' });
    expect(rec.by).toBe('timmy init');
    expect(json(join(home(), 'providers.json'))).toEqual({ ollama_host: 'http://127.0.0.1:11434' });
    const s = readSetupState();
    expect(pendingQuestions(s)).toEqual([]);
    expect(setupSummary(s)).toBe('operator Sample · chat: local model only (Ollama at 127.0.0.1:11434; no key) · logs: this computer only · project demo');
    expect(lines.join('\n')).toContain('✓ Set up: operator Sample · chat: local model only');
  });

  it('asks only what has no answer, in order; OpenRouter is opt-in and its key goes to providers.json, never setup.json', async () => {
    const key = fakeKey();
    // operator, identity, Ollama host, chat (o), the key, logs (c), the worker's host (blank), project, proceed
    const t = typing(['Sample', '', '', 'o', key, 'c', '', 'demo', '']);
    expect(await guidedSetup('timmy init', {}, t.io)).toBe(0);
    expect(t.prompts).toEqual(['  > [operator] ', '  > [generate] ', '  > [http://127.0.0.1:11434] ', '  > [l] ', '  > ', '  > [l] ', '  > ', '  > [first-light] ', '  Proceed? [Y/n] ']);
    expect(readFileSync(join(home(), 'setup.json'), 'utf8')).not.toContain(key);
    expect(json(join(home(), 'setup.json')).answers).toMatchObject({ chat: 'openrouter', logs: 'cloud', project: 'demo' });
    expect(json(join(home(), 'providers.json')).openrouter_api_key).toBe(key);
    expect(t.lines.join('\n')).not.toContain(key);
    // asked again: nothing to ask
    const again = typing([]);
    expect(await guidedSetup('timmy init', {}, again.io)).toBe(0);
    expect({ prompts: again.prompts, said: again.lines.join(' ') }).toMatchObject({ prompts: [] });
    expect(again.lines.join(' ')).toMatch(/Every setup question has an answer/);
  });

  it('never replaces an identity: --seed on a home that has one is refused and nothing is written', async () => {
    applyInit({ operator: 'Sample', project: 'demo' }, process.env.TIMMY_REPO_ROOT);
    const before = readFileSync(join(home(), 'identity.seed'), 'utf8');
    const id = readFileSync(join(home(), 'identity.json'), 'utf8');
    const lines: string[] = [];
    expect(await runInit(['--yes', '--seed', 'generate'], { isTTY: false, log: (s) => lines.push(s) })).toBe(2);
    expect(lines.join(' ')).toMatch(/never replaces it/);
    expect([readFileSync(join(home(), 'identity.seed'), 'utf8') === before, readFileSync(join(home(), 'identity.json'), 'utf8') === id]).toEqual([true, true]);
  });

  it('Ctrl+C at a question stops with nothing written (130); a no at the end writes nothing (1)', async () => {
    expect(await guidedSetup('timmy init', {}, typing(['Sample', '', null]).io)).toBe(130);
    expect(existsSync(home())).toBe(false);
    expect(await guidedSetup('timmy init', {}, typing(['Sample', '', '', '', '', '', 'n']).io)).toBe(1);
    expect(existsSync(home())).toBe(false);
  });

  it('a flag with a value it cannot take is refused (2)', async () => {
    const lines: string[] = [];
    expect(await runInit(['--chat', 'cloudy'], { isTTY: true, log: (s) => lines.push(s) })).toBe(2);
    expect(lines.join(' ')).toContain('--chat takes local or openrouter');
  });
});

// `timmy init` as a person meets it: a real terminal (tmux), 60 columns (C-14), the key typed and never shown.
const TSX = resolve('node_modules/.bin/tsx');
const CLI = resolve('src/cli.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function pty(dir: string, name: string, env: NodeJS.ProcessEnv, command: string, width = 60) {
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', name, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', String(width), '-y', '50', '-c', dir, 'bash', '--norc', '-c', command);
  const screen = (): string => tmux('capture-pane', '-p', '-S', '-200', '-t', 't');
  const waitFor = async (re: RegExp, ms = 45_000): Promise<RegExpMatchArray> => {
    for (let i = 0; i < ms / 100; i++) { const m = screen().match(re); if (m) return m; await sleep(100); }
    throw new Error(`timed out waiting for ${re}:\n${screen()}`);
  };
  const keys = (...k: string[]) => tmux('send-keys', '-t', 't', ...k);
  const type = (text: string) => { tmux('send-keys', '-t', 't', '-l', text); tmux('send-keys', '-t', 't', 'Enter'); };
  return { tmux, screen, waitFor, keys, type, kill: () => { try { tmux('kill-server'); } catch { /* gone */ } } };
}
const ptyHome = () => {
  const dir = mkdtempSync('/tmp/sg-');
  const env: NodeJS.ProcessEnv = { ...withoutRunner(process.env), HOME: dir, TIMMY_HOME: join(dir, 'timmy'), TIMMY_REPO_ROOT: dir, XDG_CONFIG_HOME: join(dir, '.config'), TIMMY_STORE: join(dir, 'store'), OPENROUTER_API_KEY: '', TMUX: '', TMUX_TMPDIR: dir, LC_ALL: 'C.UTF-8' };
  return { dir, env };
};

describe('timmy init in a real terminal', () => {
  it('asks the six questions within 60 columns, takes Enter for the preselected answers, hides the key, and sets up', async () => {
    const { dir, env } = ptyHome();
    const key = fakeKey();
    const p = pty(dir, 'init', env, `${TSX} ${CLI} init; echo EXIT=$?; sleep 60`);
    try {
      await p.waitFor(/TIMMY · first run — guided setup/);
      await p.waitFor(/Operator name \(your receipts show it\)\n\s+> \[operator\]/);
      p.type('Sample');
      await p.waitFor(/Identity: g makes a new key[\s\S]*> \[generate\]/);
      p.type('');
      await p.waitFor(/Ollama host \(the local model\)\n\s+> \[http:\/\/127\.0\.0\.1:11434\]/);
      p.type('');
      await p.waitFor(/Chat model\n\s+l  local model only[\s\S]*o  OpenRouter: a paid cloud service[\s\S]*> \[l\]/);
      p.type('o');
      await p.waitFor(/OpenRouter key \(hidden as you type; blank: no key\)\n\s+>\s*$/m);
      p.type(key);
      await p.waitFor(/> \*{20,}/);
      await p.waitFor(/Logs and run events\n\s+l  this computer only[\s\S]*> \[l\]/);
      p.type('');
      await p.waitFor(/First project name[\s\S]*> \[first-light\]/);
      p.type('demo');
      await p.waitFor(/Proceed\? \[Y\/n\]/);
      const before = p.screen();
      p.type('');
      const [, code] = await p.waitFor(/EXIT=(\d+)/);
      const after = p.screen();
      expect(code).toBe('0');
      expect(before).toMatch(/Will write only to:\n\s+~\/timmy\//);
      expect(after).toMatch(/✓ Set up: operator Sample · chat: OpenRouter \(paid,\s+cloud;\s+key\s+set\)/);
      // the key was never on the screen, and is only in providers.json
      expect(after.includes(key) || before.includes(key)).toBe(false);
      expect(after.split('\n').filter((l) => [...l].length > 60)).toEqual([]);
      expect(JSON.parse(readFileSync(join(dir, 'timmy', 'providers.json'), 'utf8')).openrouter_api_key).toBe(key);
      expect(readFileSync(join(dir, 'timmy', 'setup.json'), 'utf8')).not.toContain(key);
    } finally {
      p.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('Ctrl+C at a question stops it: exit 130, nothing written', async () => {
    const { dir, env } = ptyHome();
    const p = pty(dir, 'initc', env, `${TSX} ${CLI} init; echo EXIT=$?; sleep 60`);
    try {
      await p.waitFor(/> \[operator\]/);
      p.type('Sample');
      await p.waitFor(/> \[generate\]/);
      p.keys('C-c');
      const [, code] = await p.waitFor(/EXIT=(\d+)/);
      expect({ code, said: /Stopped: nothing was written\./.test(p.screen()), home: existsSync(join(dir, 'timmy')) }).toEqual({ code: '130', said: true, home: false });
    } finally {
      p.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
