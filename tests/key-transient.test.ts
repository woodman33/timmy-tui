// The operator's 00:28 order, release issue 1: keep environment API keys transient. LIVE-01 found the
// environment's OPENROUTER_API_KEY in the settings file of the fresh home it ran in: the settings store
// took the key as a default and wrote its defaults on first use, and wrote the file 0644. The key from
// the environment is now used, never stored; existing settings are kept as they are; the deliberate
// saves (a key typed into setup, `timmy init`'s private files) are written 0600, also over a file that
// already existed with wider permissions. A synthetic key is made at run time and never printed.
import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyInit } from '../src/utils/init.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CONFIG = pathToFileURL(resolve('src/utils/config.ts')).href;
const synthetic = (): string => ['sk', 'or', 'v1', 'synthetic', randomBytes(24).toString('hex')].join('-');
const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8);
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** A fresh home with no .env in reach, and the settings file the store will use there. */
function home(): { root: string; env: NodeJS.ProcessEnv; settings: string } {
  const root = mkdtempSync(join(tmpdir(), 'key-transient-'));
  roots.push(root);
  for (const d of ['home', 'config', 'work']) mkdirSync(join(root, d));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), TIMMY_HOME: join(root, 'home', 'timmy') };
  return { root, env, settings: join(root, 'config', 'timmy-tui-nodejs', 'config.json') };
}

/**
 * Runs `steps` against src/utils/config.ts in a child process (the store is built when the module loads),
 * and after each step reports whether the settings file holds `secret`, and its mode. Never the key itself.
 */
function probe(h: ReturnType<typeof home>, secret: string, steps: string[], extraEnv: NodeJS.ProcessEnv = {}): Array<{ step: string; exists: boolean; holds: boolean; mode: string | null; used?: boolean }> {
  const script = join(h.root, 'probe.mjs');
  writeFileSync(script, `
import { existsSync, readFileSync, statSync } from 'node:fs';
const secret = process.env.PROBE_SECRET;
const c = await import(${JSON.stringify(CONFIG)});
const file = c.getConfig().path;
const look = (step, extra = {}) => {
  const exists = existsSync(file);
  console.log(JSON.stringify({ step, exists, holds: exists && readFileSync(file, 'utf8').includes(secret), mode: exists ? (statSync(file).mode & 0o777).toString(8) : null, ...extra }));
};
look('import');
for (const step of JSON.parse(process.env.PROBE_STEPS)) {
  if (step === 'load') { look(step, { used: c.loadConfig().apiKey === secret }); continue; }
  if (step === 'save-theme') c.saveConfig({ theme: 'dark' });
  if (step === 'save-whole') c.saveConfig(c.loadConfig());
  if (step === 'save-key-field') c.saveConfig({ apiKey: secret });
  if (step === 'set-raw') c.getConfig().set('autocompleteEnabled', false);
  if (step === 'save-api-key') c.saveApiKey(secret);
  look(step);
}
`);
  const r = spawnSync(process.execPath, ['--import', LOADER, script], { cwd: join(h.root, 'work'), env: { ...h.env, ...extraEnv, PROBE_SECRET: secret, PROBE_STEPS: JSON.stringify(steps) }, encoding: 'utf8', timeout: 60_000 });
  expect(r.stderr.includes(secret) || r.stdout.includes(secret)).toBe(false);
  if (r.status !== 0) throw new Error(`probe exited ${r.status}: ${r.stderr.split('\n').slice(0, 6).join(' | ')}`);
  return r.stdout.trim().split('\n').map((l) => JSON.parse(l));
}

describe('the environment model key stays transient', () => {
  it('is used, and never written: not on first use, not by partial or whole-config saves, not through the raw store', () => {
    const h = home();
    const key = synthetic();
    const seen = probe(h, key, ['load', 'save-theme', 'save-whole', 'save-key-field', 'set-raw', 'load'], { OPENROUTER_API_KEY: key });
    expect(seen.filter((s) => s.step === 'load').map((s) => s.used)).toEqual([true, true]);
    expect(seen.map((s) => [s.step, s.holds])).toEqual([['import', false], ['load', false], ['save-theme', false], ['save-whole', false], ['save-key-field', false], ['set-raw', false], ['load', false]]);
    expect(JSON.parse(readFileSync(h.settings, 'utf8'))).toMatchObject({ theme: 'dark', apiKey: '', autocompleteEnabled: false });
  });

  it('keeps existing settings as they were, a key saved earlier included, and rewrites the file 0600', () => {
    const h = home();
    const saved = synthetic();
    const fromEnv = synthetic();
    mkdirSync(join(h.root, 'config', 'timmy-tui-nodejs'), { recursive: true });
    writeFileSync(h.settings, JSON.stringify({ apiKey: saved, model: 'x/y', theme: 'light', graphics: 'ansi', autocompleteEnabled: false }), { mode: 0o644 });
    chmodSync(h.settings, 0o644);
    const seen = probe(h, fromEnv, ['load', 'save-theme'], { OPENROUTER_API_KEY: fromEnv });
    expect(seen.find((s) => s.step === 'load')?.used).toBe(true); // the environment still wins for the run
    expect(seen.every((s) => s.holds === false)).toBe(true);
    const after = JSON.parse(readFileSync(h.settings, 'utf8'));
    expect(after).toMatchObject({ apiKey: saved, model: 'x/y', theme: 'dark', graphics: 'ansi', autocompleteEnabled: false });
    expect(mode(h.settings)).toBe('600');
  });

  it('saves a key on purpose only through saveApiKey, 0600, over a file that was 0644', () => {
    const h = home();
    const typed = synthetic();
    mkdirSync(join(h.root, 'config', 'timmy-tui-nodejs'), { recursive: true });
    writeFileSync(h.settings, JSON.stringify({ model: 'x/y' }), { mode: 0o644 });
    chmodSync(h.settings, 0o644);
    const seen = probe(h, typed, ['save-api-key']);
    expect(seen.at(-1)).toMatchObject({ step: 'save-api-key', exists: true, holds: true, mode: '600' });
    expect(JSON.parse(readFileSync(h.settings, 'utf8'))).toMatchObject({ model: 'x/y', apiKey: typed });
  });

  it('writes a fresh settings file 0600 even with no key anywhere', () => {
    const h = home();
    const seen = probe(h, synthetic(), ['save-theme']);
    expect(seen.map((s) => [s.step, s.exists, s.mode])).toEqual([['import', true, '600'], ['save-theme', true, '600']]);
  });
});

describe("timmy init's private files are private", () => {
  const vars = ['TIMMY_HOME', 'TIMMY_PRIVATE_DIR', 'TIMMY_REPO_ROOT'] as const;
  const before = Object.fromEntries(vars.map((v) => [v, process.env[v]]));
  afterEach(() => { for (const v of vars) { if (before[v] === undefined) delete process.env[v]; else process.env[v] = before[v]; } });

  it('rewrites providers.json and identity.seed 0600 when they already existed 0644', () => {
    const h = home();
    const key = synthetic();
    const timmy = join(h.root, 'home', 'timmy');
    mkdirSync(timmy, { recursive: true });
    for (const f of ['providers.json', 'identity.seed']) { writeFileSync(join(timmy, f), 'old\n', { mode: 0o644 }); chmodSync(join(timmy, f), 0o644); }
    process.env.TIMMY_HOME = timmy;
    process.env.TIMMY_PRIVATE_DIR = join(h.root, 'work', '.timmy', 'private');
    process.env.TIMMY_REPO_ROOT = join(h.root, 'work');
    applyInit({ operator: 'tester', project: 'p', seed: 'generate', openrouter: key }, join(h.root, 'work'));
    expect(readFileSync(join(timmy, 'providers.json'), 'utf8').includes(key)).toBe(true);
    expect(['providers.json', 'identity.seed'].map((f) => [f, mode(join(timmy, f))])).toEqual([['providers.json', '600'], ['identity.seed', '600']]);
    expect(existsSync(join(h.root, 'work', '.timmy', 'private', 'config.json'))).toBe(true);
    expect(mode(join(h.root, 'work', '.timmy', 'private', 'config.json'))).toBe('600');
  });
});
