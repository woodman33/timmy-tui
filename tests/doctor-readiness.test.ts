// The operator's 22:23 order: `timmy doctor` said "Preflight BLOCKED" and then "Ready for demo: YES". The
// doctor now says what works here, capability by capability, the REPL apart from the optional lanes, and
// its exit code is documented: 0 the REPL is ready; 78 it opens, but has no model key to answer with; 1 it
// cannot start here. The lanes never change that code; `timmy doctor preflight` exits 1 while they are
// blocked.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readiness, readinessLines, type DoctorCheck, type DoctorReport } from '../src/utils/doctor.js';
import { modelKeySource, settingsFile } from '../src/utils/model-key.js';

const missing = (name: string, required = true): DoctorCheck => ({ name, required, state: 'not_configured', note: 'missing' });
const ok = (name: string, required = true): DoctorCheck => ({ name, required, state: 'ok' });
const BLOCKED: DoctorReport = {
  ok: false,
  checks: [missing('docker daemon'), missing('comfy-cli'), ok('comfy venv (filelock+sqlalchemy)'), missing('cue CLI'),
    missing('openscad', false), ok('tmux', false), { name: 'port 8188 (ComfyUI)', required: false, state: 'warn', note: 'no listener' }],
};
const READY: DoctorReport = { ok: true, checks: BLOCKED.checks.map((c) => ({ ...c, state: 'ok' })) };

describe('readiness: the REPL apart from the optional lanes', () => {
  it('a ready REPL beside blocked lanes exits 0 and names the lanes blocked, and optional', () => {
    const r = readiness(BLOCKED, { node: '24.21.0', key: true });
    expect([r.repl.state, r.lanes.state, r.exit]).toEqual(['ready', 'blocked', 0]);
    expect(r.lanes.missing).toEqual(['docker daemon', 'comfy-cli', 'cue CLI']);
    const text = readinessLines(r).join('\n');
    expect(text).toMatch(/^ {2}✓ REPL: ready/m);
    expect(text).toMatch(/^ {2}✗ Lanes \(optional\): blocked until docker daemon, comfy-cli and cue CLI pass/m);
    expect(text).toMatch(/^Exit 0: the REPL is ready\./m);
    expect(text).not.toMatch(/Ready for demo/);
  });

  it('with no model key the REPL opens for /setup but cannot answer: exit 78', () => {
    const r = readiness(READY, { node: '24.21.0', key: false });
    expect([r.repl.state, r.lanes.state, r.exit]).toEqual(['no-key', 'ready', 78]);
    const text = readinessLines(r).join('\n');
    expect(text).toMatch(/^ {2}! REPL: opens, but has no model key to answer with/m);
    expect(text).toMatch(/^ {2}✓ Lanes \(optional\): ready/m);
    expect(text).toMatch(/^Exit 78: the REPL opens, but cannot answer until a model key is set\./m);
  });

  it('on a Node older than 24 the REPL cannot start: exit 1, whatever the lanes say', () => {
    for (const pre of [READY, BLOCKED]) {
      const r = readiness(pre, { node: '22.12.0', key: true });
      expect([r.repl.state, r.exit]).toEqual(['unsupported', 1]);
      expect(readinessLines(r).join('\n')).toMatch(/^ {2}✗ REPL: cannot start here: Node 22\.12\.0, Timmy needs 24 or later/m);
    }
  });

  it('documents every code it can give in its own output', () => {
    const text = readinessLines(readiness(BLOCKED, { node: '24.21.0', key: true })).join('\n');
    expect(text).toMatch(/0 ready, 78 no model key, 1 cannot start/);
    expect(text).toMatch(/`timmy doctor preflight` exits 1 while they are blocked/);
  });
});

/** A home, a working folder and a store of their own, outside the repository, and no model key. */
function box() {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-doctor-'));
  const home = join(dir, 'home'), work = join(dir, 'work');
  mkdirSync(home); mkdirSync(work);
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_STORE: join(dir, 'store') };
  return { dir, home, work, env };
}

describe('the model key: found where the REPL finds it, read only', () => {
  it('finds a key in the environment, in timmy init\'s providers file, and in the settings file, and none in an empty home', () => {
    const b = box();
    try {
      expect(modelKeySource({ ...b.env }, b.work, b.home, 'linux')).toBeNull();
      expect(modelKeySource({ ...b.env, OPENROUTER_API_KEY: 'sk-or-v1-test' }, b.work, b.home, 'linux')).toBe('environment');
      mkdirSync(join(b.home, 'timmy'));
      writeFileSync(join(b.home, 'timmy', 'providers.json'), JSON.stringify({ openrouter_api_key: 'sk-or-v1-test' }));
      expect(modelKeySource({ ...b.env }, b.work, b.home, 'linux')).toBe('providers.json');
      rmSync(join(b.home, 'timmy'), { recursive: true });
      for (const platform of ['linux', 'darwin'] as const) {
        const file = settingsFile({ ...b.env }, b.home, platform);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, JSON.stringify({ apiKey: 'sk-or-v1-test' }));
        expect(modelKeySource({ ...b.env }, b.work, b.home, platform)).toBe('settings');
        rmSync(file);
      }
      writeFileSync(join(b.work, 'timmy-tui.config.json'), JSON.stringify({ apiKey: 'sk-or-v1-test' }));
      expect(modelKeySource({ ...b.env }, b.work, b.home, 'linux')).toBe('timmy-tui.config.json');
    } finally { rmSync(b.dir, { recursive: true, force: true }); }
  });

  it('ignores a timmy-tui.config.json that holds no object, as loadConfig does, instead of throwing (the review, row 99)', () => {
    const b = box();
    try {
      for (const body of ['"abc"', '123', 'true', 'null', '[]']) {
        writeFileSync(join(b.work, 'timmy-tui.config.json'), body);
        expect(modelKeySource({ ...b.env }, b.work, b.home, 'linux'), body).toBeNull();
        expect(modelKeySource({ ...b.env, OPENROUTER_API_KEY: 'sk-or-v1-test' }, b.work, b.home, 'linux'), body).toBe('environment');
      }
    } finally { rmSync(b.dir, { recursive: true, force: true }); }
  });

  it("lets a .env in the working folder steer the lookup as it steers the REPL's: TIMMY_HOME there, not the default", () => {
    const b = box();
    try {
      const env = { PATH: b.env.PATH, HOME: b.home };
      mkdirSync(join(b.home, 'timmy'));
      writeFileSync(join(b.home, 'timmy', 'providers.json'), JSON.stringify({ openrouter_api_key: 'sk-or-v1-test' }));
      expect(modelKeySource(env, b.work, b.home, 'linux')).toBe('providers.json');
      // A .env that moves TIMMY_HOME to a folder with no providers file: the REPL then finds no key, nor may the doctor.
      writeFileSync(join(b.work, '.env'), `TIMMY_HOME=${join(b.dir, 'elsewhere')}\n`);
      expect(modelKeySource(env, b.work, b.home, 'linux')).toBeNull();
      // And one that moves it to a folder that has one.
      mkdirSync(join(b.dir, 'elsewhere'));
      writeFileSync(join(b.dir, 'elsewhere', 'providers.json'), JSON.stringify({ openrouter_api_key: 'sk-or-v1-test' }));
      expect(modelKeySource(env, b.work, b.home, 'linux')).toBe('providers.json');
      // The real environment wins over the .env, as it does in the REPL.
      expect(modelKeySource({ ...env, TIMMY_HOME: join(b.dir, 'none') }, b.work, b.home, 'linux')).toBeNull();
    } finally { rmSync(b.dir, { recursive: true, force: true }); }
  });

  it('writes nothing while it looks', () => {
    const b = box();
    try {
      modelKeySource({ ...b.env, OPENROUTER_API_KEY: 'sk-or-v1-test' }, b.work, b.home, process.platform);
      expect([readdirSync(b.home), readdirSync(b.work)]).toEqual([[], []]);
    } finally { rmSync(b.dir, { recursive: true, force: true }); }
  });
});

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const DOCTOR = resolve('scripts/timmy-doctor.ts');
// The doctor judges the Node it runs on, this test's own: on a Node older than 24 (Timmy's engines) the
// documented answer is exit 1, "cannot start", whatever the key; the qualification runs these on Node 24.
const SUPPORTED = Number(process.versions.node.split('.')[0]) >= 24;

describe('timmy doctor, run', () => {
  it('without a model key: the REPL line says so, the exit is 78 as documented, and no line claims readiness the checks deny', () => {
    const b = box();
    try {
      const r = spawnSync(process.execPath, ['--import', LOADER, DOCTOR, 'doctor'], { cwd: b.work, env: b.env, encoding: 'utf8', timeout: 60_000 });
      expect(r.status, r.stderr).toBe(SUPPORTED ? 78 : 1);
      expect(r.stdout).toMatch(/^What works here:$/m);
      expect(r.stdout).toMatch(SUPPORTED ? /^ {2}! REPL: opens, but has no model key to answer with/m : /^ {2}✗ REPL: cannot start here: Node /m);
      expect(r.stdout).toMatch(/^ {2}[✓✗] Lanes \(optional\): /m);
      expect(r.stdout).toMatch(SUPPORTED ? /^Exit 78: /m : /^Exit 1: /m);
      expect(r.stdout).not.toMatch(/Ready for demo/);
    } finally { rmSync(b.dir, { recursive: true, force: true }); }
  });

  it('with a model key in the environment: exit 0, the key never printed, nothing written to the settings folder', () => {
    const b = box();
    try {
      const secret = 'sk-or-v1-0000doctorcheck0000';
      const r = spawnSync(process.execPath, ['--import', LOADER, DOCTOR, 'doctor', '--json'], { cwd: b.work, env: { ...b.env, OPENROUTER_API_KEY: secret }, encoding: 'utf8', timeout: 60_000 });
      expect(r.status, r.stderr).toBe(SUPPORTED ? 0 : 1);
      expect(r.stdout + r.stderr).not.toContain(secret);
      const out = JSON.parse(r.stdout);
      expect([out.readiness.repl.state, out.readiness.exit]).toEqual(SUPPORTED ? ['ready', 0] : ['unsupported', 1]);
      expect(readdirSync(b.home).filter((n) => n !== 'timmy')).toEqual([]);
    } finally { rmSync(b.dir, { recursive: true, force: true }); }
  });
});
