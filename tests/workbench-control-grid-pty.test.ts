// R5 (H137): tab 7 Control Room's panes as the operator's references 07 and 14 lay them out, in a real terminal (tmux) at
// 160x45: a 2×2 grid, two running FAKE jobs first, then the two newest ended ones; a running pane's lines following its log
// (and saying how often it is read: the Workbench's own tick, 1 s); the arrows moving the selection's heavy frame in the
// grid's order. Over a sandbox of its own (HOME, the XDG folders, the Timmy home, the settings folder, the store, TMPDIR and
// the tmux server, all inside this test's temporary folder), made as tests/workbench-captures-pty.test.ts makes it. The screen
// is kept as that test keeps its screens (capture-pane -e as .ansi and plain as .txt), in
// <tmpdir>/timmy-workbench-captures/r5-control-grid, or in TIMMY_WB_CAPTURES when it is set.
//
// FAKE here, each said in its label or in the capture's name (…-FAKE-fixtures):
// - a FAKE session (this test's helper) that starts four jobs through Timmy's real job store and stays until the test lets it
//   go: two that end at once ("FAKE job (test): done A", "… done B", which exits 3), one that prints "FAKE line <n>" every
//   0.5 s, one that sleeps; to the Workbench they are another session's;
// - the openers on PATH (`open` and `xdg-open` stubs that only log; nothing presses Show).
// Everything else is the real program, started as the installed command starts it (src/cli.ts through tsx's loader).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { keepScreen, sendKeys, settledScreen, waitScreen, type Pane } from './helpers/tmux-frame.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const JOBS = pathToFileURL(resolve('src/jobs/index.ts')).href;
const CAPTURES = process.env.TIMMY_WB_CAPTURES ? resolve(process.env.TIMMY_WB_CAPTURES) : join(tmpdir(), 'timmy-workbench-captures', 'r5-control-grid');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let box = '';
let repo = '';
let timmyHome = '';
let env: NodeJS.ProcessEnv = {};
let session: ChildProcess | null = null;

const cli = (args: string[], timeout = 60_000) => runAsync(process.execPath, ['--import', LOADER, CLI, ...args], { cwd: repo, env, timeout });
const jobRecords = (): Array<{ id: string; state: string; pid?: number }> => {
  const dir = join(timmyHome, 'jobs');
  return (existsSync(dir) ? readdirSync(dir) : []).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));
};

/**
 * A tmux server of the test's own, its screen, its keys, waits with a deadline that names what they wait for, a capture. R5
 * (H136; the finish line, item 5): each through tests/helpers/tmux-frame.ts. A screen is read, waited for and kept only as a
 * whole frame the same in two reads (a wait's value is read from that frame); a kept capture also has its key-hint line and
 * shows what it is kept for; a key is sent once the Workbench has read the one before.
 */
function terminal(label: string) {
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  const pane: Pane = { tmux, target: 't', folders: [box] };
  const screen = () => settledScreen(pane);
  const waitFor = async <T>(what: string, get: (s: string) => T | null | undefined | false, ms = 30_000): Promise<T> => {
    const s = await waitScreen(pane, { what, test: (x) => !!get(x), ms });
    return get(s) as T;
  };
  const keys = (...k: string[]) => sendKeys(pane, k);
  const capture = (name: string, shows?: RegExp): string => keepScreen(pane, CAPTURES, name, { what: `the ${name} screen, whole, with its key-hint line`, re: shows });
  return { tmux, screen, waitFor, keys, capture };
}

/** The screen row (its index) where both ids are on a pane's edge, or -1. */
const rowWith = (screen: string, a: string, b: string): number => screen.split('\n').findIndex((l) => new RegExp(`[━─] ${a} [━─]`).test(l) && new RegExp(`[━─] ${b} [━─]`).test(l));
/** The newest "FAKE line N" the screen shows (0 for none). */
const newestLine = (screen: string): number => Math.max(0, ...[...screen.matchAll(/FAKE line (\d+)/g)].map((m) => Number(m[1])));

beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), 'wb-grid-pty-'));
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
    XDG_CACHE_HOME: join(home, '.cache'), TIMMY_HOME: timmyHome, TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(home, '.timmy-store'),
    TIMMY_SETTINGS_DIR: join(box, 'settings'), TMPDIR: join(box, 'tmp'), OPENROUTER_API_KEY: '', COLORTERM: 'truecolor',
    TMUX: '', TMUX_TMPDIR: box, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: `${bin}:${process.env.PATH ?? ''}`,
  };
  const init = await cli(['init', '--yes', '--operator', 'Sample', '--seed', 'generate', '--project', 'demo']);
  expect(init.status, init.stderr).toBe(0);
  const made = await cli(['act', '/project new tray1 --from tray-workflow']);
  expect(made.status, `${made.stdout}\n${made.stderr}`).toBe(0);
}, 150_000);

afterAll(async () => {
  try { execFileSync('tmux', ['-L', 'wbGrid', 'kill-server'], { env, stdio: 'ignore' }); } catch { /* none */ }
  if (box) writeFileSync(join(box, 'release'), '');
  for (const end = Date.now() + 5000; session && session.exitCode === null && Date.now() < end;) await sleep(100);
  try { session?.kill('SIGKILL'); } catch { /* gone */ }
  // the FAKE jobs' processes, by their records' pids (only what this test's records name)
  for (const j of timmyHome ? jobRecords() : []) if (j.pid && j.state === 'running') { try { process.kill(-j.pid, 'SIGKILL'); } catch { try { process.kill(j.pid, 'SIGKILL'); } catch { /* gone */ } } }
  for (let i = 0; ; i++) {
    try { rmSync(box, { recursive: true, force: true }); return; } catch (e) {
      if (i >= 50) throw e;
      await sleep(200);
    }
  }
}, 30_000);

describe('`timmy workbench` in a terminal: tab 7 Control Room\'s panes as a 2×2 grid at 160x45 (tmux; R5 H137)', () => {
  it('two running FAKE jobs side by side, the two newest ended below them; the printing pane follows its log and says it is read every 1 s; → ↓ ← ↑ move the heavy frame in the grid\'s order; one frame, as wide as the terminal; kept as a capture', async () => {
    const trayRoot = join(timmyHome, 'projects', 'tray1');
    const talkScript = join(box, 'talk.sh');
    writeFileSync(talkScript, 'i=0\nwhile [ $i -lt 600 ]; do i=$((i+1)); echo "FAKE line $i"; sleep 0.5; done\n');
    const ids = join(box, 'ids.json');
    const helper = join(box, 'fake-session.mts');
    writeFileSync(helper, [
      '// FAKE session (test only): four jobs through Timmy\'s real job store, their ids written; it stays (and so reads their',
      '// output) until its release file appears',
      `import { JobManager } from '${JOBS}';`,
      "import { existsSync, writeFileSync } from 'node:fs';",
      'const [dir, root, project, out, release, talkScript] = process.argv.slice(2);',
      'const jobs = new JobManager({ dir });',
      'const wait = (ms) => new Promise((r) => setTimeout(r, ms));',
      "const a = jobs.start({ kind: 'task', label: 'FAKE job (test): done A', project, root, command: 'sh', args: ['-c', 'echo FAKE done A'] });",
      'await jobs.done(a.id); await wait(30);',
      "const b = jobs.start({ kind: 'task', label: 'FAKE job (test): done B', project, root, command: 'sh', args: ['-c', 'echo FAKE done B; exit 3'] });",
      'await jobs.done(b.id); await wait(30);',
      "const talk = jobs.start({ kind: 'task', label: 'FAKE job (test): a line every 0.5 s', project, root, command: 'sh', args: [talkScript] });",
      'await wait(30);',
      "const nap = jobs.start({ kind: 'task', label: 'FAKE job (test): sleep 300', project, root, command: 'sleep', args: ['300'] });",
      "for (let i = 0; i < 100 && !(jobs.get(talk.id)?.state === 'running' && jobs.get(nap.id)?.state === 'running'); i++) await wait(50);",
      'writeFileSync(out, JSON.stringify({ a: a.id, b: b.id, talk: talk.id, nap: nap.id }));',
      'for (let i = 0; i < 2400 && !existsSync(release); i++) await wait(100);',
      'await jobs.stopAll();',
      'process.exit(0);',
      '',
    ].join('\n'));
    session = spawn(process.execPath, ['--import', LOADER, helper, join(timmyHome, 'jobs'), trayRoot, 'tray1', ids, join(box, 'release'), talkScript], { cwd: repo, env, stdio: 'ignore' });
    // (R10 H167: read once whole: the session's writeFileSync makes the file before its bytes are in it, and a read between the
    // two found it empty under load)
    const written = (): { a: string; b: string; talk: string; nap: string } | null => {
      try { return JSON.parse(readFileSync(ids, 'utf8')) as { a: string; b: string; talk: string; nap: string }; } catch { return null; }
    };
    for (const end = Date.now() + 30_000; !written() && Date.now() < end;) await sleep(100);
    expect(existsSync(ids) && written() !== null, 'the FAKE session\'s four jobs started').toBe(true);
    const job = written()!;

    const t = terminal('wbGrid');
    t.tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '160', '-y', '45', '-c', repo, 'bash', '--norc', '-c',
      `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
    await t.waitFor('the Workbench, at the start', (s) => /tray1 \/ Home · recent work[\s\S]*Activity & log/.test(s));
    // 7: the Control Room (row 2's actions keep the keyboard, as after any tab key); Tab gives it to the panes
    await t.keys('7');
    await t.waitFor('the Control Room', (s) => /tray1 \/ Control Room · jobs/.test(s));
    await t.keys('Tab');
    await t.waitFor('the Control Room with the keyboard', (s) => /◆ tray1 \/ Control Room · jobs/.test(s));
    // the grid: the running ones (the newest first) side by side, the newest ended ones on the row of panes below
    const top = await t.waitFor('the two running panes side by side', (s) => { const y = rowWith(s, job.nap, job.talk); return y >= 0 ? y + 1 : null; }) - 1;
    const below = await t.waitFor('the two ended panes side by side below them', (s) => { const y = rowWith(s, job.b, job.a); return y > top ? y : null; });
    expect(below).toBeGreaterThan(top);
    const screen = t.screen();
    expect(screen).toMatch(/RUNNING NOW \(2\) {2}· {2}NEWEST ENDED RUNS \(2\)/);
    expect(screen).toContain('log read every 1 s');
    expect(screen).toMatch(/exit 3/);
    expect(screen).toMatch(/\[x\] stops the selected pane's job {2}· {2}\[Enter\] its run detail {2}· {2}\[←→↑↓\] between panes/);
    // the printing pane follows its log, a line every 0.5 s, read every 1 s
    const n1 = await t.waitFor('a printed line in its pane', (s) => newestLine(s) || null);
    const n2 = await t.waitFor('a later line in its pane', (s) => { const n = newestLine(s); return n >= n1 + 3 ? n : null; }, 20_000);
    expect(n2).toBeGreaterThanOrEqual(n1 + 3);
    // the arrows move the selection's heavy frame in the grid's order: →, ↓, ←, ↑
    await t.waitFor('the newest running pane selected', (s) => new RegExp(`┏━ ${job.nap} `).test(s));
    for (const [k, id] of [['Right', job.talk], ['Down', job.a], ['Left', job.b], ['Up', job.nap]] as const) {
      await t.keys(k);
      await t.waitFor(`the heavy frame on ${id} after ${k}`, (s) => new RegExp(`┏━ ${id} `).test(s), 10_000);
    }
    await t.keys('Right');
    await t.waitFor('the heavy frame on the printing pane', (s) => new RegExp(`┏━ ${job.talk} `).test(s), 10_000);
    // (R5 H136: kept once it is whole, with the heavy frame on the printing pane, and the same in two reads)
    const txt = t.capture('control-grid-160x45-FAKE-fixtures', new RegExp(`┏━ ${job.talk} `));
    const rows = txt.replace(/\n$/, '').split('\n');
    expect(rows, 'one frame, as many rows as the terminal').toHaveLength(45);
    expect(Math.max(...rows.map((l) => [...l].length)), 'no row wider than the terminal').toBeLessThanOrEqual(160);
    expect(txt.split('Workflow actions').length - 1, 'one frame').toBe(1);
    expect(txt.includes(box), 'a folder of this machine').toBe(false);
    expect(txt.includes(hostname()), 'this machine\'s name').toBe(false);
    await t.keys('C-c');
    await t.waitFor('the Workbench quitting at Ctrl+C (the FAKE jobs are another session\'s: left running; R6 H141: it stopped nothing, so exit 0)', (s) => /EXIT=0\b/.test(s), 20_000);
    writeFileSync(join(box, 'release'), '');
    console.log(`Control Room grid capture (R5 H137, .ansi and .txt): ${join(CAPTURES, 'control-grid-160x45-FAKE-fixtures')}`);
  }, 180_000);
});
