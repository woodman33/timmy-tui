// R10 (H163; the turn-holds latency): every timmy process draws with React's production build. src/react-build.ts loads React,
// its JSX runtime, the scheduler and react-reconciler (Ink's) with NODE_ENV=production as src/cli.ts's first import, then puts
// NODE_ENV back as it was; TIMMY_REACT_DEV=1 keeps the development builds. Before, an installed timmy (NODE_ENV unset) and a
// test's terminal (vitest's NODE_ENV=test) both drew with the development builds, about twice a frame's CPU in the Workbench.
//
// (1) the rule, with a FAKE loader; (2) a timmy launched for real without a terminal (`timmy version`, src/cli.ts from source)
// and (3) the Workbench launched for real in a terminal (a tmux server of this test's own), drawn, then ended with Ctrl+C: a
// probe (tests/fixtures/react-build-probe.mjs) says at the process's exit which builds it ran, NODE_ENV then, and the receipts'
// store for its folder (under NODE_ENV=test, TIMMY_STORE: the receipts' test isolation, unchanged). No test reads React's
// development-only warnings (checked when this came in: none matches React's warning texts).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadReactProduction, REACT_MODULES } from '../src/react-build.js';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const PROBE = resolve('tests/fixtures/react-build-probe.mjs');
const RECEIPTS = resolve('src/utils/receipts.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const box = mkdtempSync(join(tmpdir(), 'react-production-'));
const cleanups: Array<() => void> = [];
afterAll(() => { for (const c of cleanups.splice(0).reverse()) c(); rmSync(box, { recursive: true, force: true }); });

/** The files a process ran (evaluated) of React, its JSX runtime, the scheduler and react-reconciler: the production builds. */
const PRODUCTION = [
  'react-reconciler/cjs/react-reconciler-constants.production.js', 'react-reconciler/cjs/react-reconciler.production.js',
  'react-reconciler/constants.js', 'react-reconciler/index.js', 'react/cjs/react-jsx-runtime.production.js',
  'react/cjs/react.production.js', 'react/index.js', 'react/jsx-runtime.js', 'scheduler/cjs/scheduler.production.js', 'scheduler/index.js',
];

/** A launched timmy's environment: a home, Timmy home and settings of its own in this test's folder; no NODE_ENV unless given. */
function launchEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = join(box, 'home');
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...withoutRunner(process.env), HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_SETTINGS_DIR: join(box, 'settings'), XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), XDG_CACHE_HOME: join(home, '.cache'), OPENROUTER_API_KEY: '', LANG: 'C.UTF-8',
  };
  delete env.NODE_ENV;
  delete env.TIMMY_REACT_DEV;
  delete env.NODE_PATH;
  return { ...env, ...extra };
}

interface Probe { files: string[]; nodeEnv: string | null; store: string | null }
const probed = (file: string): Probe => JSON.parse(readFileSync(file, 'utf8')) as Probe;

describe('React\'s production build in every timmy process (R10 H163; the turn-holds latency)', () => {
  it('loads React, its JSX runtime, the scheduler and react-reconciler with NODE_ENV=production, then puts NODE_ENV back as it was (unset stays unset, "test" stays "test"); a module that cannot load leaves the rest; TIMMY_REACT_DEV=1 loads nothing', () => {
    expect(REACT_MODULES).toEqual(['react', 'react/jsx-runtime', 'scheduler', 'react-reconciler', 'react-reconciler/constants.js']);
    for (const before of [undefined, 'test', 'development', 'production']) {
      const env: NodeJS.ProcessEnv = before === undefined ? {} : { NODE_ENV: before };
      const seen: Array<[string, string | undefined]> = [];
      // FAKE loader: records what was loaded and NODE_ENV as it was then
      expect(loadReactProduction(env, (id) => { seen.push([id, env.NODE_ENV]); return {}; })).toBe('production');
      expect(seen).toEqual(REACT_MODULES.map((id) => [id, 'production']));
      expect(Object.prototype.hasOwnProperty.call(env, 'NODE_ENV'), `NODE_ENV set afterwards (it was ${before ?? 'unset'})`).toBe(before !== undefined);
      expect(env.NODE_ENV).toBe(before);
    }
    const partly: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    const loaded: string[] = [];
    expect(loadReactProduction(partly, (id) => { if (id === 'scheduler') throw new Error('FAKE: not installed here'); loaded.push(id); return {}; })).toBe('production');
    expect(loaded).toEqual(REACT_MODULES.filter((id) => id !== 'scheduler'));
    expect(partly.NODE_ENV).toBe('test');
    const dev: NodeJS.ProcessEnv = { TIMMY_REACT_DEV: '1', NODE_ENV: 'test' };
    let loads = 0;
    expect(loadReactProduction(dev, () => { loads++; return {}; })).toBe('development');
    expect(loads).toBe(0);
    expect(dev).toEqual({ TIMMY_REACT_DEV: '1', NODE_ENV: 'test' });
  });

  it('a timmy launched without a terminal (`timmy version` from source) ran the production builds only, and NODE_ENV is as it was afterwards: "test" stays "test", so the receipts\' NODE_ENV=test isolation still gives TIMMY_STORE; unset stays unset', async () => {
    const store = join(box, 'store');
    for (const nodeEnv of ['test', null] as const) {
      const out = join(box, `version-${nodeEnv ?? 'unset'}.json`);
      const env = launchEnv({ REACT_PROBE_OUT: out, REACT_PROBE_RECEIPTS: RECEIPTS, TIMMY_STORE: store, ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}) });
      const r = await runAsync(process.execPath, ['--import', LOADER, '--import', PROBE, CLI, 'version'], { cwd: box, env, timeout: 120_000 });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.stdout).toMatch(/^timmy-tui v\S+ \(revision /);
      const p = probed(out);
      expect(p.files, `NODE_ENV ${nodeEnv ?? 'unset'}`).toEqual(PRODUCTION);
      expect(p.nodeEnv).toBe(nodeEnv);
      if (nodeEnv === 'test') expect(p.store, 'the receipts\' store for the process\'s folder under NODE_ENV=test').toBe(store);
    }
  }, 300_000);

  it('the Workbench launched in a terminal draws with the production builds only (Ink and the app took them from the module cache), NODE_ENV left unset; TIMMY_REACT_DEV=1 keeps the development builds', async () => {
    for (const dev of [false, true]) {
      const out = join(box, `workbench-${dev ? 'development' : 'production'}.json`);
      const label = `reactprod${dev ? 'd' : 'p'}${process.pid}`;
      const env = launchEnv({ REACT_PROBE_OUT: out, TERM: 'xterm-256color', TMUX: '', TMUX_TMPDIR: box, ...(dev ? { TIMMY_REACT_DEV: '1' } : {}) });
      const tmux = (...args: string[]): string => execFileSync('tmux', ['-L', label, ...args], { env, encoding: 'utf8', timeout: 10_000 });
      cleanups.push(() => { try { tmux('kill-server'); } catch { /* gone */ } });
      tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '120', '-y', '36', '-c', box, 'bash', '--norc', '-c', `${process.execPath} --import ${LOADER} --import ${PROBE} ${CLI} workbench; echo EXIT=$?; sleep 120`);
      const pane = (): string => tmux('capture-pane', '-p', '-t', 't');
      const until = async (what: string, re: RegExp, ms: number): Promise<void> => {
        for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (re.test(pane())) return;
        throw new Error(`timed out waiting for ${what}:\n${pane()}`);
      };
      // (R10 CHAT H167: the Workbench opens on the Chat screen, whose header row ends with LOCAL RECORDS; Home's run line, where
      // Stop current is, is one key away)
      await until('the Workbench drawn', /Stop current|LOCAL RECORDS/, 120_000);
      tmux('send-keys', '-t', 't', 'C-c');
      await until('the Workbench ended', /EXIT=\d+/, 30_000);
      expect(pane()).toMatch(/EXIT=0\b/);
      const p = probed(out);
      if (dev) {
        expect(p.files).toEqual(expect.arrayContaining(['react/cjs/react.development.js', 'react-reconciler/cjs/react-reconciler.development.js', 'scheduler/cjs/scheduler.development.js']));
        expect(p.files.filter((f) => f.endsWith('.production.js'))).toEqual([]);
      } else {
        expect(p.files).toEqual(PRODUCTION);
      }
      expect(p.nodeEnv).toBeNull();
      tmux('kill-server');
    }
  }, 300_000);
});
