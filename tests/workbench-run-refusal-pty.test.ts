// R9 (H161; R8's open item M) in a real terminal: Enter on a running workflow block, several times, and the refusal ("Not
// started: it is running now as j…") is seen in Activity each time, also once the run's own notice has come right after it;
// nothing starts. In R8's rehearsal the refusal was not seen within 10 s in 2 of 4 runs of its stop step: a notice of the run
// itself (its follower's block-start line) took the controls row and Activity's strip within a second of the Enter
// (tests/workbench-run-refusal.test.tsx says how this was established).
//
// tmux on a server of this test's own (`tmux -L`, its socket in the test's folder), over a sandbox of its own (HOME, the XDG
// folders, the Timmy home, the settings folder, the store and TMPDIR inside this test's temporary folder). The home is made by
// `timmy init --yes`, the project by the REPL's own `/project new` (through `timmy act`), and `timmy workbench` runs as the
// installed command runs it (src/cli.ts through tsx's loader). FAKE here: upmd, a TEST DOUBLE of upmd 0.2.7
// (tests/fixtures/fake-upmd.mjs, through UPMD_BIN; its blocks run for real through sh, on a pty through Timmy's own
// workers/upmd/pty_run.py, this machine's python3); CHAIN.md, this test's FAKE workflow (a, b and c wait for their files in
// turn, then wait waits for its own); the browser openers on PATH (stubs that only log; nothing here presses Show).
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { enterOnBlock, keepScreen, scrub, selectedBlock, sendKeys, settledScreen, waitScreen, workflowsList, type Pane } from './helpers/tmux-frame.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const CAPTURES = join(tmpdir(), 'timmy-workbench-captures');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BLOCKS = ['a', 'b', 'c', 'wait'];

let box = '';
let repo = '';
let timmyHome = '';
let tray = '';
let env: NodeJS.ProcessEnv = {};
const label = `h161-refusal-${process.pid}`;

const cli = (args: string[], timeout = 60_000) => runAsync(process.execPath, ['--import', LOADER, CLI, ...args], { cwd: repo, env, timeout });
const jobsDir = () => join(timmyHome, 'jobs');
const records = () => (existsSync(jobsDir()) ? readdirSync(jobsDir()) : []).filter((n) => n.endsWith('.json'))
  .map((n) => JSON.parse(readFileSync(join(jobsDir(), n), 'utf8')) as { id: string; label: string; root: string; state: string; pid?: number; steps?: Array<{ name: string; state: string }> });
const runsOf = (l: string) => records().filter((j) => j.root === tray && j.label === l);
const operations = () => { const d = join(tray, '.timmy', 'operations'); return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.json')).length : 0; };
const release = (name: string) => writeFileSync(join(box, `go-${name}`), '');

/** The tmux server of this test's own and its one pane, through tests/helpers/tmux-frame.ts (whole frames, keys read). */
function terminal() {
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  const pane: Pane = { tmux, target: 't', folders: [box] };
  const waitFor = (re: RegExp, ms = 30_000): Promise<string> => waitScreen(pane, { what: `${re}`, re, ms });
  const until = (test: (s: string) => boolean, what: string, ms = 10_000): Promise<string> => waitScreen(pane, { what, test, ms });
  const keys = (...k: string[]) => sendKeys(pane, k);
  const screen = () => settledScreen(pane);
  const start = (w: number, h: number) => tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', String(w), '-y', String(h), '-c', repo, 'bash', '--norc', '-c',
    `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
  const close = () => { try { tmux('kill-server'); } catch { /* gone */ } };
  return { tmux, pane, waitFor, until, keys, screen, start, close, capture: (name: string) => keepScreen(pane, CAPTURES, name, { foot: 'drawn' }) };
}

beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), 'wb-refusal-pty-'));
  const home = join(box, 'home');
  repo = join(box, 'repo');
  timmyHome = join(home, 'timmy');
  const bin = join(box, 'fakebin');
  for (const d of [home, repo, bin, join(box, 'tmp'), join(box, 'settings'), CAPTURES]) mkdirSync(d, { recursive: true });
  // FAKE openers: a Show pressed here would only be logged (none is pressed in this file)
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$0 $*" >> '${box}/opened.log'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const base = withoutRunner(process.env);
  delete base.NODE_PATH;
  env = {
    ...base, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'), TIMMY_HOME: timmyHome, TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(box, 'store'),
    TIMMY_SETTINGS_DIR: join(box, 'settings'), TMPDIR: join(box, 'tmp'), OPENROUTER_API_KEY: '', COLORTERM: 'truecolor',
    TMUX: '', TMUX_TMPDIR: box, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: `${bin}:${process.env.PATH ?? ''}`, UPMD_BIN: FAKE_UPMD,
  };
  const init = await cli(['init', '--yes', '--operator', 'Sample', '--seed', 'generate', '--project', 'demo']);
  expect(init.status, init.stderr).toBe(0);
  const made = await cli(['act', '/project new trayA --from tray-workflow']);
  expect(made.status, `${made.stdout}\n${made.stderr}`).toBe(0);
  tray = join(timmyHome, 'projects', 'trayA');
  // FAKE workflow (this test's): each block waits for a file of the test's, at most 60 s; running wait runs all four
  writeFileSync(join(tray, 'CHAIN.md'), ['# Chain (FAKE workflow, this test)', '', 'Each block waits for a file of the test\'s, at most 60 s.', '',
    ...BLOCKS.flatMap((name, i) => [`\`\`\`bash [name:${name}${i ? `, deps:${BLOCKS[i - 1]}` : ''}]`, `i=0; while [ ! -f '${join(box, `go-${name}`)}' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done`, '```', ''])].join('\n'));
}, 180_000);

afterAll(async () => {
  for (const name of BLOCKS) { try { release(name); } catch { /* the folder is gone */ } }
  try { execFileSync('tmux', ['-L', label, 'kill-server'], { env, stdio: 'ignore' }); } catch { /* none */ }
  // what this test left running, by its own records' pids only
  for (const j of records()) if (j.pid && (j.state === 'running' || j.state === 'queued')) { try { process.kill(-j.pid, 'SIGKILL'); } catch { /* gone */ } }
  for (let i = 0; ; i++) {
    try { rmSync(box, { recursive: true, force: true }); return; } catch (e) { if (i >= 50) throw e; await sleep(200); }
  }
}, 30_000);

describe('`timmy workbench` in a terminal: Enter on a running block (tmux; R9 H161, R8\'s item M)', () => {
  it('Enter on the running CHAIN.md › wait three times: each time the refusal is seen in Activity, and is still there once the run\'s own notice has come; one job, one operation', async () => {
    const t = terminal();
    try {
      t.start(160, 45);
      await t.waitFor(/trayA \/ [\s\S]*Activity/);
      // the workspace search: '/', its prompt, the name, Enter
      await t.keys('/');
      await t.waitFor(/^\S?\s*\/ /m, 10_000);
      await sendKeys(t.pane, ['Workflows'], { literal: true });
      await t.waitFor(/^\S?\s*\/ Workflows/m, 10_000);
      await t.keys('Enter');
      await t.waitFor(/trayA \/ Workflows/, 10_000);
      // CHAIN.md › wait selected (Home, then Down until the list's ▸ is on it)
      const named = (s: string): string => { const b = selectedBlock(s); return b?.focused ? `${b.doc} › ${b.block}` : ''; };
      await t.until((s) => named(s) !== '', 'a block selected in the Workflows list, which has the keyboard');
      await t.keys('Home');
      await t.until((s) => { const l = workflowsList(s); return !!l?.focused && l.fromTop && l.blocks[0]?.selected === true; }, 'the list\'s first block selected (Home)');
      for (let steps = 0; named(t.screen()) !== 'CHAIN.md › wait'; steps++) {
        if (steps >= 40) throw new Error(`CHAIN.md › wait is not selected after 40 Downs:\n${scrub(t.screen(), [box])}`);
        const before = named(t.screen());
        await t.keys('Down');
        await t.until((s) => named(s) !== '' && named(s) !== before, `the selection moved down from ${before}`);
      }
      await enterOnBlock(t.pane, 'CHAIN.md', 'wait');
      await t.waitFor(/Run CHAIN\.md › wait\?/, 10_000);
      await t.keys('Enter');
      const top = await t.waitFor(/Stop current: j[0-9a-f]+ CHAIN\.md › wait/, 20_000);
      const id = /Stop current: (j[0-9a-f]+)/.exec(top)![1];
      const refusal = new RegExp(`Not started: it is running now as ${id}, started by this Workbench`);
      // (R10 H167: the same refusal on Activity's strip, where a job is said by its label)
      const chainLabel = 'CHAIN\\.md › wait';
      const refusalSaid = new RegExp(`Not started: it is running now as ${chainLabel}, started by this Workbench`);
      const jobs = runsOf('CHAIN.md › wait').length;
      const ops = operations();
      expect(jobs).toBe(1);
      for (const [i, block] of ['a', 'b', 'c'].entries()) {
        // R9 lead (M′: this wait failed on CI at 6f406ea and at af4b13f, its screen kept in REMAINING-DEFECTS): the run's
        // follower reads the records once a second and says a block's start up to a second after it begins
        // (src/repl/run-progress.ts). An Enter pressed before that line lands is refused all the same, and the refusal stays
        // held on the controls row, but the follower's line, newer, then takes Activity's strip, which shows only the newest
        // event. So from the second Enter on, the Enter waits for that line first; the first stays pressed at once, as R8's
        // driver pressed it (within the second after "Stop current"), and its refusal may be seen on the strip or, held, on
        // the controls row: before it there is no refusal, so either place shows this one
        // (R10 H167: Activity's strip says a job by its label, CHAIN.md › wait; its id is Stop current's and the Inspector's)
        if (i > 0) await t.waitFor(new RegExp(`last: [0-9:]+ ● ${chainLabel}\\s+running: ${block}\\b`), 8000);
        await enterOnBlock(t.pane, 'CHAIN.md', 'wait');
        const at = Date.now();
        // a new refusal: from the second Enter on, Activity's strip names it as the newest event (before this Enter the strip
        // named the run's notice); the first, wherever Activity shows it
        const said = await t.waitFor(i > 0 ? new RegExp(`last: [0-9:]+ ${refusalSaid.source}`) : refusal, 5000);
        expect(said).not.toMatch(/Run CHAIN\.md › wait\?/);
        t.capture(`wb-refusal-160x45-enter-${i + 1}`);
        // the run moves on: block `block` ends, and a notice of the run itself (that end, or its follower's line) takes the strip
        release(block);
        const after = await t.waitFor(new RegExp(`last: [0-9:]+ ● ${chainLabel}\\s+(?:${block} completed|running: )`), 8000);
        const late = Date.now() - at;
        expect(late, 'the run\'s notice came while the refusal is still fresh (6 s)').toBeLessThan(5500);
        // R8's M: the refusal is still in Activity (its controls row) once the run's notice has come
        expect(after, `Enter ${i + 1}: the refusal ${late} ms after the Enter, once the run's notice was the newest:\n${scrub(after, [box])}`).toMatch(refusal);
        t.capture(`wb-refusal-160x45-enter-${i + 1}-after-the-runs-notice`);
      }
      // one press, one run: still the one job and the one operation
      expect(runsOf('CHAIN.md › wait')).toHaveLength(jobs);
      expect(operations()).toBe(ops);
      release('wait');
      for (const end = Date.now() + 20_000; runsOf('CHAIN.md › wait')[0]?.state !== 'completed' && Date.now() < end;) await sleep(200);
      expect(runsOf('CHAIN.md › wait')[0]?.state).toBe('completed');
      // Ctrl+C with nothing running quits at once
      await t.keys('C-c');
      await t.waitFor(/EXIT=0\b/, 20_000);
    } finally {
      t.close();
    }
  }, 180_000);
});
