// R4 (H98): Timmy's one guided setup (src/setup/, written by src/utils/init.ts). The same questions for `timmy init`, the
// monitor and the REPL's /setup; each asked only while it has no answer; the local model preselected; anything paid opt-in
// and said so; an identity never replaced; a key never shown, never in setup.json, and kept in one place (providers.json).
// journey-2 (the independent review): the identity answer is read hidden and checked with the writer's own parser at the
// question; a leftover identity.seed is the answer, kept; no "send logs to your worker" (this version sends none); a key
// the monitor's settings held moves to providers.json; a key is never asked for in a command's arguments.
// Real files in a temporary Timmy home and settings folder; `timmy init` in real processes and a real pseudo-terminal
// (tmux). Keys and seeds are made at run time.
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { chatRoute, knownAnswers, pendingQuestions, readSetupState, setupSummary } from '../src/setup/questions.js';
import { IDENTITY_WORDS } from '../src/setup/identity.js';
import { modelKeySource } from '../src/utils/model-key.js';
import { applyInit, guidedSetup, IDENTITY_KEPT, KEY_IN_ARGUMENTS, LOGS_CLOUD_REFUSED, runInit, SEED_KEPT, SEED_UNREADABLE } from '../src/utils/init.js';

const fakeKey = (): string => ['sk', 'or', 'FAKE', randomBytes(12).toString('hex')].join('-');
const pem = (): string => generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
const VARS = ['TIMMY_HOME', 'TIMMY_PRIVATE_DIR', 'TIMMY_REPO_ROOT', 'TIMMY_SETTINGS_DIR', 'OPENROUTER_API_KEY', 'TIMMY_EDGE_HOST'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let box = '';
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'setup-guided-'));
  mkdirSync(join(box, 'repo'));
  process.env.TIMMY_HOME = join(box, 'home', 'timmy');
  process.env.TIMMY_REPO_ROOT = join(box, 'repo');
  process.env.TIMMY_SETTINGS_DIR = join(box, 'settings');
  delete process.env.TIMMY_PRIVATE_DIR;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.TIMMY_EDGE_HOST;
});
afterEach(() => {
  for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
  rmSync(box, { recursive: true, force: true });
});
const home = (): string => process.env.TIMMY_HOME!;
const settings = (): string => join(process.env.TIMMY_SETTINGS_DIR!, 'config.json');
const json = (f: string): Record<string, unknown> => JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
const mode = (f: string): number => statSync(f).mode & 0o777;
/** Answers typed in order, as a person would (null: Ctrl+C); every prompt is kept, and which were read hidden. */
const typing = (answers: Array<string | null>) => {
  const prompts: string[] = [];
  const hiddenPrompts: string[] = [];
  const lines: string[] = [];
  return {
    prompts, hiddenPrompts, lines,
    io: {
      log: (s: string) => lines.push(s),
      question: async (p: string) => { prompts.push(p); return answers.length ? answers.shift()! : ''; },
      hidden: async (p: string) => { prompts.push(p); hiddenPrompts.push(p); return answers.length ? answers.shift()! : ''; },
    },
  };
};
/** Lines over 60 columns (C-14); a line naming this test's own temporary folder (a long path, one word) is not counted. */
const wide = (lines: string[]): string[] => lines.flatMap((l) => l.split('\n')).filter((l) => [...l].length > 60 && !l.includes(box));

describe('the questions, and what counts as an answer', () => {
  it('a blank home has five questions, the local model preselected; no question sends logs anywhere', () => {
    const s = readSetupState();
    const pending = pendingQuestions(s);
    expect(pending.map((q) => q.id)).toEqual(['operator', 'identity', 'ollama', 'chat', 'project']);
    expect(pending.find((q) => q.id === 'chat')!.preselect({}, s)).toBe('local');
    // the paid choice says so where it is offered
    const words = pending.find((q) => q.id === 'chat')!.choices!.map((c) => `${c.label} ${c.note}`).join(' | ');
    expect(words).toMatch(/OpenRouter: a paid cloud service.*costs[\s\S]*money/);
    // journey-2: logs and run events stay on this computer (nothing in the monitor or the REPL sends them to a worker)
    expect(pending.map((q) => q.title).join(' | ')).not.toMatch(/[Ll]ogs|worker/);
    expect(setupSummary(s)).toContain('logs: this computer only');
  });

  it('what an older `timmy init` wrote counts: identity, Ollama host and project are answered; the chat is asked', () => {
    mkdirSync(join(home(), 'projects', 'demo'), { recursive: true });
    writeFileSync(join(home(), 'identity.json'), JSON.stringify({ version: 1, operator: 'Sample', operator_id: 'op_0123456789abcdef', seed_source: 'generated' }));
    writeFileSync(join(home(), 'providers.json'), JSON.stringify({ ollama_host: 'http://127.0.0.1:11434' }));
    expect(pendingQuestions(readSetupState()).map((q) => q.id)).toEqual(['chat']);
    // a stored key is an answer given before: OpenRouter, so nothing is asked
    writeFileSync(join(home(), 'providers.json'), JSON.stringify({ ollama_host: 'http://127.0.0.1:11434', openrouter_api_key: fakeKey() }));
    const s = readSetupState();
    expect({ pending: pendingQuestions(s).map((q) => q.id), chat: knownAnswers(s).chat, key: knownAnswers(s).key }).toEqual({ pending: [], chat: 'openrouter', key: 'set' });
  });

  it('the header words name the route in effect: never a paid model without a key', () => {
    expect(chatRoute({ key: false, model: 'anthropic/claude-opus-4.7' })).toBe('chat: no model key · /setup');
    expect(chatRoute({ key: true, model: 'anthropic/claude-opus-4.7' })).toBe('chat: anthropic/claude-opus-4.7 · OpenRouter');
    expect(chatRoute({ key: true, model: 'anthropic/claude-opus-4.7', short: true })).toBe('chat: claude-opus-4.7 · OpenRouter');
    // journey-2: the monitor's chat goes to the commander when it is connected with a token, key or no key
    expect(chatRoute({ key: false, model: 'anthropic/claude-opus-4.7', short: true, commander: 'openrouter/auto' })).toBe('chat: auto · commander');
    expect(chatRoute({ key: true, model: 'anthropic/claude-opus-4.7', commander: null })).toBe('chat: anthropic/claude-opus-4.7 · OpenRouter');
  });
});

describe('timmy init writes the answers once, in the Timmy home', () => {
  it('--yes takes the preselected answers: the local model, no key; nothing is asked afterwards', async () => {
    const lines: string[] = [];
    expect(await runInit(['--yes', '--operator', 'Sample', '--project', 'demo'], { isTTY: false, log: (s) => lines.push(s) })).toBe(0);
    const rec = json(join(home(), 'setup.json'));
    expect(rec.answers).toEqual({ operator: 'Sample', identity: 'generated', chat: 'local', ollama: 'http://127.0.0.1:11434', project: 'demo' });
    expect(rec.by).toBe('timmy init');
    expect(json(join(home(), 'providers.json'))).toEqual({ ollama_host: 'http://127.0.0.1:11434' });
    const s = readSetupState();
    expect(pendingQuestions(s)).toEqual([]);
    expect(setupSummary(s)).toBe('operator Sample · chat: local model only (Ollama at 127.0.0.1:11434; no key) · logs: this computer only · project demo');
    expect(lines.join('\n')).toContain('✓ Set up: operator Sample · chat: local model only');
    expect(wide(lines)).toEqual([]);
  });

  it('asks only what has no answer, in order; the identity and the key are read hidden; the key goes to providers.json only', async () => {
    const key = fakeKey();
    // operator, identity (Enter: a new key), Ollama host, chat (o), the key, project, proceed
    const t = typing(['Sample', '', '', 'o', key, 'demo', '']);
    expect(await guidedSetup('timmy init', {}, t.io)).toBe(0);
    expect(t.prompts).toEqual(['  > [operator] ', '  > [new key] ', '  > [http://127.0.0.1:11434] ', '  > [l] ', '  > ', '  > [first-light] ', '  Proceed? [Y/n] ']);
    expect(t.hiddenPrompts).toEqual(['  > [new key] ', '  > ']);
    expect(readFileSync(join(home(), 'setup.json'), 'utf8')).not.toContain(key);
    expect(json(join(home(), 'setup.json')).answers).toMatchObject({ chat: 'openrouter', project: 'demo' });
    expect(json(join(home(), 'providers.json')).openrouter_api_key).toBe(key);
    expect(mode(join(home(), 'providers.json'))).toBe(0o600);
    expect(t.lines.join('\n')).not.toContain(key);
    // asked again: nothing to ask
    const again = typing([]);
    expect(await guidedSetup('timmy init', {}, again.io)).toBe(0);
    expect(again.prompts).toEqual([]);
    expect(again.lines.join(' ')).toMatch(/Every setup question has an answer/);
    expect(again.lines.join(' ')).not.toMatch(/--openrouter <key>/);
  });

  it('OpenRouter chosen and no key typed: the confirm says the local model, and that is what is written', async () => {
    const t = typing(['Sample', '', '', 'o', '', 'demo', '']);
    expect(await guidedSetup('timmy init', {}, t.io)).toBe(0);
    const said = t.lines.join('\n');
    expect(said).toContain('No key given: the chat stays on the local model (no key).');
    const confirm = said.slice(said.indexOf('Will write only to:'));
    expect(confirm.replace(/\s+/g, ' ')).toContain('chat: local model only (Ollama at 127.0.0.1:11434; no key)');
    expect(confirm).not.toContain('OpenRouter');
    expect(json(join(home(), 'setup.json')).answers).toMatchObject({ chat: 'local' });
    expect(json(join(home(), 'providers.json')).openrouter_api_key).toBeUndefined();
  });

  it('never replaces an identity: --seed on a home that has one is refused within 60 columns, and nothing is written', async () => {
    applyInit({ operator: 'Sample', project: 'demo' }, process.env.TIMMY_REPO_ROOT);
    const before = readFileSync(join(home(), 'identity.seed'), 'utf8');
    const id = readFileSync(join(home(), 'identity.json'), 'utf8');
    const lines: string[] = [];
    expect(await runInit(['--yes', '--seed', 'generate'], { isTTY: false, log: (s) => lines.push(s) })).toBe(2);
    expect(lines.join(' ').replace(/\s+/g, ' ')).toContain(IDENTITY_KEPT);
    expect(wide(lines)).toEqual([]);
    expect([readFileSync(join(home(), 'identity.seed'), 'utf8') === before, readFileSync(join(home(), 'identity.json'), 'utf8') === id]).toEqual([true, true]);
  });

  it('Ctrl+C at a question stops with nothing written (130); a no at the end writes nothing (1)', async () => {
    expect(await guidedSetup('timmy init', {}, typing(['Sample', '', null]).io)).toBe(130);
    expect(existsSync(home())).toBe(false);
    expect(await guidedSetup('timmy init', {}, typing(['Sample', '', '', '', '', 'n']).io)).toBe(1);
    expect(existsSync(home())).toBe(false);
  });

  it('a flag with a value it cannot take is refused (2); --logs cloud is not offered; --edge-host takes localhost:8787', async () => {
    const lines: string[] = [];
    expect(await runInit(['--chat', 'cloudy'], { isTTY: true, log: (s) => lines.push(s) })).toBe(2);
    expect(lines.join(' ')).toContain('--chat takes local or openrouter');
    lines.length = 0;
    expect(await runInit(['--yes', '--logs', 'cloud'], { isTTY: false, log: (s) => lines.push(s) })).toBe(2);
    expect(lines.join(' ').replace(/\s+/g, ' ')).toContain(LOGS_CLOUD_REFUSED);
    expect(existsSync(home())).toBe(false);
    lines.length = 0;
    expect(await runInit(['--yes', '--operator', 'Sample', '--logs', 'local', '--edge-host', 'localhost:8787'], { isTTY: false, log: (s) => lines.push(s) })).toBe(0);
    expect(json(join(process.env.TIMMY_REPO_ROOT!, '.timmy', 'private', 'config.json')).edge_host).toBe('localhost:8787');
    expect(json(join(home(), 'setup.json')).answers).not.toHaveProperty('logs');
  });
});

describe('the identity answer (journey-2, item 1): hidden, and checked with the writer\'s parser at the question', () => {
  it('a 64-hex seed file is a key Timmy reads; a file it cannot read is refused at the question, in words that never repeat it', async () => {
    const seedFile = join(box, 'seed.hex');
    const seed = randomBytes(32).toString('hex');
    writeFileSync(seedFile, `${seed}\n`, { mode: 0o600 });
    const bad = join(box, 'not-a-key.txt');
    writeFileSync(bad, 'not a key\n');
    // operator, identity (a bad file, then a missing one, then the seed file), Ollama, chat, project, proceed
    const t = typing(['Sample', bad, join(box, 'missing'), seedFile, '', '', 'demo', '']);
    expect(await guidedSetup('timmy init', {}, t.io)).toBe(0);
    const said = t.lines.join(' ').replace(/\s+/g, ' ');
    expect(said).toContain(IDENTITY_WORDS.unreadable);
    expect(said).toContain(IDENTITY_WORDS.missing);
    expect(said).not.toContain(bad);
    expect(said).toContain('identity: the key you gave');
    // the identity is the seed's: identity.json says imported, the seed file is the PEM of that key (0600)
    expect(json(join(home(), 'identity.json')).seed_source).toBe('imported');
    expect(mode(join(home(), 'identity.seed'))).toBe(0o600);
    expect(t.hiddenPrompts.filter((p) => p === '  > [new key] ')).toHaveLength(3);
  });

  it('a seed typed (hidden) works too; the words never show it; a key that is not ed25519 is refused', async () => {
    const seed = randomBytes(32).toString('hex');
    const rsa = join(box, 'rsa.pem');
    writeFileSync(rsa, generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' }) as string);
    const t = typing(['Sample', rsa, seed, '', '', 'demo', '']);
    expect(await guidedSetup('timmy init', {}, t.io)).toBe(0);
    expect(t.lines.join(' ').replace(/\s+/g, ' ')).toContain(IDENTITY_WORDS.notEd25519);
    expect(t.lines.join('\n')).not.toContain(seed);
    expect(readFileSync(join(home(), 'setup.json'), 'utf8')).not.toContain(seed);
    expect(json(join(home(), 'identity.json')).seed_source).toBe('imported');
  });

  it('--seed with a file Timmy cannot read is refused before anything is asked (2), nothing written', async () => {
    const bad = join(box, 'not-a-key.txt');
    writeFileSync(bad, 'not a key\n');
    const t = typing([]);
    expect(await guidedSetup('timmy init', { identity: bad }, t.io)).toBe(2);
    expect(t.prompts).toEqual([]);
    expect(t.lines.join(' ').replace(/\s+/g, ' ')).toContain(`--seed: ${IDENTITY_WORDS.unreadable}`);
    expect(existsSync(home())).toBe(false);
  });
});

describe('a leftover identity.seed (journey-2, item 2): the answer, kept, and said so', () => {
  it('is not asked; the confirm says the existing identity.seed (kept); its bytes stay and it is narrowed to 0600', async () => {
    mkdirSync(home(), { recursive: true });
    const key = pem();
    writeFileSync(join(home(), 'identity.seed'), key, { mode: 0o644 });
    const s = readSetupState();
    expect(s.identity).toMatchObject({ exists: false, seed: 'readable' });
    expect(pendingQuestions(s).map((q) => q.id)).toEqual(['operator', 'ollama', 'chat', 'project']);
    const t = typing(['Sample', '', '', 'demo', '']);
    expect(await guidedSetup('timmy init', {}, t.io)).toBe(0);
    expect(t.lines.join(' ').replace(/\s+/g, ' ')).toContain('identity: the existing identity.seed (kept)');
    expect(readFileSync(join(home(), 'identity.seed'), 'utf8')).toBe(key);
    expect(mode(join(home(), 'identity.seed'))).toBe(0o600);
    expect(json(join(home(), 'identity.json')).seed_source).toBe('kept');
  });

  it('a seed given with it is refused (2), never dropped in silence; an unreadable one stops the setup before any question (1)', async () => {
    mkdirSync(home(), { recursive: true });
    writeFileSync(join(home(), 'identity.seed'), pem(), { mode: 0o600 });
    const lines: string[] = [];
    expect(await runInit(['--yes', '--seed', 'generate'], { isTTY: false, log: (s) => lines.push(s) })).toBe(2);
    expect(lines.join(' ').replace(/\s+/g, ' ')).toContain(SEED_KEPT);
    expect(existsSync(join(home(), 'identity.json'))).toBe(false);
    writeFileSync(join(home(), 'identity.seed'), 'not a key\n');
    const t = typing([]);
    expect(await guidedSetup('timmy init', {}, t.io)).toBe(1);
    expect(t.prompts).toEqual([]);
    expect(t.lines.join(' ').replace(/\s+/g, ' ')).toContain(SEED_UNREADABLE);
    expect(wide(t.lines)).toEqual([]);
    expect(readFileSync(join(home(), 'identity.seed'), 'utf8')).toBe('not a key\n');
  });
});

// `timmy init` in real processes: the key read from stdin with `-`, and the monitor's old settings key moved (item 4, 5)
const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
/** The key loadConfig uses in a process with `env`: compared there, never printed. */
async function keyInUse(env: NodeJS.ProcessEnv, expected: string): Promise<string> {
  const script = `const { loadConfig } = await import(${JSON.stringify(pathToFileURL(resolve('src/utils/config.ts')).href)}); const k = loadConfig().apiKey; console.log(k === process.env.EXPECTED_KEY ? 'expected' : k ? 'another' : 'none');`;
  const r = await runAsync(process.execPath, ['--import', LOADER, '--input-type=module', '-e', script], { cwd: box, env: { ...env, EXPECTED_KEY: expected }, timeout: 60_000 });
  return r.stdout.trim();
}

describe('the model key in one place (journey-2, items 4 and 5)', () => {
  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...withoutRunner(process.env), HOME: join(box, 'home'), TIMMY_HOME: home(), TIMMY_REPO_ROOT: join(box, 'repo'), TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, TIMMY_STORE: join(box, 'store'), OPENROUTER_API_KEY: '' };
    delete e.TIMMY_PRIVATE_DIR;
    return e;
  };
  const oldSettings = (key: string): void => {
    mkdirSync(process.env.TIMMY_SETTINGS_DIR!, { recursive: true });
    writeFileSync(settings(), JSON.stringify({ apiKey: key, model: 'test/model', onboarded: true }), { mode: 0o600 });
  };

  it('timmy init --openrouter - takes a new key from stdin: providers.json holds it (0600), the settings\' old key is gone, the chat uses it', async () => {
    const old = fakeKey();
    const fresh = fakeKey();
    oldSettings(old);
    expect(await keyInUse(env(), old)).toBe('expected'); // before: the settings' key, the only one
    const r = await runAsync(process.execPath, ['--import', LOADER, CLI, 'init', '--yes', '--operator', 'Sample', '--project', 'demo', '--openrouter', '-'], { cwd: join(box, 'repo'), env: env(), input: `${fresh}\n`, timeout: 60_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toContain(fresh);
    expect(`${r.stdout}${r.stderr}`).not.toContain(KEY_IN_ARGUMENTS.slice(0, 30));
    expect(json(join(home(), 'providers.json')).openrouter_api_key).toBe(fresh);
    expect(mode(join(home(), 'providers.json'))).toBe(0o600);
    // the settings keep everything else (the settings store wrote its defaults in when it read the file: keyInUse above)
    const after = json(settings());
    expect(after).not.toHaveProperty('apiKey');
    expect({ model: after.model, onboarded: after.onboarded }).toEqual({ model: 'test/model', onboarded: true });
    expect(mode(settings())).toBe(0o600);
    expect(await keyInUse(env(), fresh)).toBe('expected');
    expect(modelKeySource(env(), join(box, 'repo'), join(box, 'home'))).toBe('providers.json');
  }, 120_000);

  it('a key only the settings held moves to providers.json at the setup, and the setup says so', async () => {
    const old = fakeKey();
    oldSettings(old);
    const r = await runAsync(process.execPath, ['--import', LOADER, CLI, 'init', '--yes', '--operator', 'Sample', '--project', 'demo'], { cwd: join(box, 'repo'), env: env(), timeout: 60_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout.replace(/\s+/g, ' ')).toContain('The model key the monitor\'s settings held is now in');
    expect(json(join(home(), 'providers.json')).openrouter_api_key).toBe(old);
    expect(json(settings())).not.toHaveProperty('apiKey');
    expect(await keyInUse(env(), old)).toBe('expected');
  }, 120_000);

  it('a key given in the arguments still works, and the words say it was visible; the banner never asks for one there', async () => {
    const key = fakeKey();
    const lines: string[] = [];
    expect(await runInit(['--yes', '--operator', 'Sample', '--project', 'demo', '--openrouter', key], { isTTY: false, log: (s) => lines.push(s) })).toBe(0);
    expect(lines.join(' ').replace(/\s+/g, ' ')).toContain(KEY_IN_ARGUMENTS);
    expect(lines.join('\n')).not.toContain(key);
    expect(wide(lines)).toEqual([]);
    const banner: string[] = [];
    expect(await runInit([], { isTTY: false, log: (s) => banner.push(s) })).toBe(0);
    expect(banner.join('\n')).toContain('--openrouter -');
    expect(banner.join('\n')).not.toMatch(/--openrouter <key>|<pem\|hex>/);
    expect(wide(banner)).toEqual([]);
  });
});

// `timmy init` as a person meets it: a real terminal (tmux), 60 columns (C-14), a key typed and never shown.
const TSX = resolve('node_modules/.bin/tsx');
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
  const dir = mkdtempSync(join(tmpdir(), 'sg-'));
  const env: NodeJS.ProcessEnv = { ...withoutRunner(process.env), HOME: dir, TIMMY_HOME: join(dir, 'timmy'), TIMMY_REPO_ROOT: dir, XDG_CONFIG_HOME: join(dir, '.config'), TIMMY_STORE: join(dir, 'store'), OPENROUTER_API_KEY: '', TMUX: '', TMUX_TMPDIR: dir, LC_ALL: 'C.UTF-8' };
  return { dir, env };
};

describe('timmy init in a real terminal', () => {
  it('asks the five questions within 60 columns, takes Enter for the preselected answers, hides the key, and sets up', async () => {
    const { dir, env } = ptyHome();
    const key = fakeKey();
    const p = pty(dir, 'init', env, `${TSX} ${CLI} init; echo EXIT=$?; sleep 60`);
    try {
      await p.waitFor(/TIMMY · first run — guided setup/);
      await p.waitFor(/Operator name \(your receipts show it\)\n\s+> \[operator\]/);
      p.type('Sample');
      await p.waitFor(/Identity: Enter makes a new key[\s\S]*Hidden as you type\.\n\s+> \[new key\]/);
      p.type('');
      await p.waitFor(/Ollama host \(the local model\)\n\s+> \[http:\/\/127\.0\.0\.1:11434\]/);
      p.type('');
      await p.waitFor(/Chat model\n\s+l  local model only[\s\S]*o  OpenRouter: a paid cloud service[\s\S]*> \[l\]/);
      p.type('o');
      await p.waitFor(/OpenRouter key \(hidden as you type; blank: no key\)\n\s+>\s*$/m);
      p.type(key);
      await p.waitFor(/> \*{20,}/);
      await p.waitFor(/First project name[\s\S]*> \[first-light\]/);
      p.type('demo');
      await p.waitFor(/Proceed\? \[Y\/n\]/);
      const before = p.screen();
      p.type('');
      const [, code] = await p.waitFor(/EXIT=(\d+)/);
      const after = p.screen();
      expect(code).toBe('0');
      expect(before).toMatch(/Will write only to:\n\s+~\/timmy\//);
      expect(before).not.toMatch(/Logs and run events|worker/);
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

  // item 1, at 80 columns: a seed pasted at the identity question is never on the screen; a bad file is refused there
  it('a 64-hex seed pasted at the identity question shows only as *; a file Timmy cannot read is refused at once (80 columns)', async () => {
    const { dir, env } = ptyHome();
    const seed = randomBytes(32).toString('hex');
    const bad = join(dir, 'notes.txt');
    writeFileSync(bad, 'not a key\n');
    const p = pty(dir, 'initseed', env, `${TSX} ${CLI} init; echo EXIT=$?; sleep 60`, 80);
    try {
      await p.waitFor(/> \[operator\]/);
      p.type('Sample');
      await p.waitFor(/> \[new key\]/);
      p.type(bad);
      await p.waitFor(/That file is not a key Timmy can read/);
      p.type(seed);
      await p.waitFor(/Ollama host/);
      const screen = p.screen();
      expect(screen).toMatch(/\[new key\] \*{64}\n/);
      expect(screen).not.toContain(seed);
      expect(screen).not.toContain(bad);
      p.keys('C-c');
      const [, code] = await p.waitFor(/EXIT=(\d+)/);
      expect(code).toBe('130');
      expect(existsSync(join(dir, 'timmy'))).toBe(false);
      expect(p.screen()).not.toContain(seed);
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
      await p.waitFor(/> \[new key\]/);
      p.keys('C-c');
      const [, code] = await p.waitFor(/EXIT=(\d+)/);
      expect({ code, said: /Stopped: nothing was written\./.test(p.screen()), home: existsSync(join(dir, 'timmy')) }).toEqual({ code: '130', said: true, home: false });
    } finally {
      p.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
