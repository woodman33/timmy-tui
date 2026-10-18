// R5 (H131): the terminal Workbench at the operator's three sizes (160x45, 120x40 and 100x30) on Home, Chat & Intent,
// Workflows and Control Room, in a real terminal (tmux) over a sandbox of its own (HOME, the XDG folders, the Timmy home, the
// settings folder, the store, TMPDIR and the tmux server, all inside this test's temporary folder, made as
// tests/workbench-pty.test.ts makes them). Each screen is kept as that test keeps its screens: capture-pane -e as .ansi and
// plain as .txt, in <tmpdir>/timmy-workbench-captures/r5-terminal, or in TIMMY_WB_CAPTURES when it is set (the R5 order keeps
// them in the repo: TIMMY_WB_CAPTURES=docs/ui-cockpit/captures/r5/terminal npx vitest run tests/workbench-captures-pty.test.ts).
//
// FAKE here, each said on the screen or in every capture's name (…-FAKE-fixtures):
// - what Timmy observed of its connections: a record this test writes; each check's words begin "FAKE:" on Home's cards
//   (nothing is asked over the network);
// - a job a session left: its label says "FAKE job (test): sleep 300" (a real `sleep` through Timmy's real job store);
// - upmd: a TEST DOUBLE of upmd 0.2.7 (tests/fixtures/fake-upmd.mjs, through UPMD_BIN) for the one run of APPROVAL.md › tidy
//   that fills Chat's pipeline and the Control Room (its block runs for real through sh); the person at its NEEDS YOU box is
//   this test's key press;
// - the openers on PATH (`open` and `xdg-open` stubs that only log; nothing presses Show).
// Everything else is the real program, started as the installed command starts it (src/cli.ts through tsx's loader).
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONNECTIONS_SCHEMA, writeConnections } from '../src/ops/workspace-frame.js';
import { GUARD_MS } from '../src/workbench/controller.js';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { keepScreen, pastGuard, sendKeys, settledScreen, waitScreen, type Pane } from './helpers/tmux-frame.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const JOBS = pathToFileURL(resolve('src/jobs/index.ts')).href;
// FAKE: upmd is a TEST DOUBLE of upmd 0.2.7's --ci behaviour (tests/fixtures/fake-upmd.mjs); each block runs for real through sh
const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const CAPTURES = process.env.TIMMY_WB_CAPTURES ? resolve(process.env.TIMMY_WB_CAPTURES) : join(tmpdir(), 'timmy-workbench-captures', 'r5-terminal');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let box = '';
let repo = '';
let timmyHome = '';
let env: NodeJS.ProcessEnv = {};

const cli = (args: string[], timeout = 60_000) => runAsync(process.execPath, ['--import', LOADER, CLI, ...args], { cwd: repo, env, timeout });
const jobRecords = (): Array<{ id: string; label: string; root: string; state: string; pid?: number }> => {
  const dir = join(timmyHome, 'jobs');
  return (existsSync(dir) ? readdirSync(dir) : []).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));
};

/**
 * A tmux server of the test's own, its screen, its keys, waits with a deadline that names what they wait for, a capture. R5
 * (H136; the finish line, item 5): each through tests/helpers/tmux-frame.ts. A screen is read, waited for and kept only as a
 * whole frame the same in two reads (a capture once caught the Control Room mid-redraw at 100x30); a kept capture also has
 * its key-hint line and its tab's title; a key is sent once the Workbench has read the one before.
 */
function terminal(label: string) {
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  const pane: Pane = { tmux, target: 't', folders: [box] };
  const screen = () => settledScreen(pane);
  const waitFor = (re: RegExp, what: string, ms = 30_000): Promise<string> => waitScreen(pane, { what, re, ms });
  const keys = (...k: string[]) => sendKeys(pane, k);
  const capture = (name: string, title?: RegExp): string => keepScreen(pane, CAPTURES, name, { what: `the ${name} screen, whole, with its key-hint line`, re: title });
  return { tmux, screen, waitFor, keys, capture };
}

beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), 'wb-captures-'));
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
    // (the store under HOME too: a path the screens show is then said from ~, never as this machine's folders)
    XDG_CACHE_HOME: join(home, '.cache'), TIMMY_HOME: timmyHome, TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(home, '.timmy-store'),
    TIMMY_SETTINGS_DIR: join(box, 'settings'), TMPDIR: join(box, 'tmp'), OPENROUTER_API_KEY: '', COLORTERM: 'truecolor',
    TMUX: '', TMUX_TMPDIR: box, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: `${bin}:${process.env.PATH ?? ''}`, UPMD_BIN: FAKE_UPMD,
  };
  const init = await cli(['init', '--yes', '--operator', 'Sample', '--seed', 'generate', '--project', 'demo']);
  expect(init.status, init.stderr).toBe(0);
  const made = await cli(['act', '/project new tray1 --from tray-workflow']);
  expect(made.status, `${made.stdout}\n${made.stderr}`).toBe(0);
  // FAKE: what a `timmy workspace check` would have recorded (nothing is asked here); each check's words say FAKE
  const now = Date.now();
  writeConnections({
    schema: CONNECTIONS_SCHEMA,
    checks: {
      ollama: { answer: 'accepted', at: new Date(now - 3 * 60_000).toISOString(), detail: 'FAKE: 2 models' },
      openrouter: { answer: 'refused', at: new Date(now - 5 * 60_000).toISOString(), detail: 'FAKE: HTTP 401' },
      cloudflare: { answer: 'no answer', at: new Date(now - 5 * 60_000).toISOString(), detail: 'FAKE: timed out' },
    },
  }, env);
}, 150_000);

// (the hook's own retries take up to 10 s, the default hook timeout: it gets the time its loop needs)
afterAll(async () => {
  try { execFileSync('tmux', ['-L', 'wbR5', 'kill-server'], { env, stdio: 'ignore' }); } catch { /* none */ }
  // the FAKE job's `sleep`, by its record's pid (only what this test's records name)
  for (const j of timmyHome ? jobRecords() : []) if (j.pid && j.state === 'running') { try { process.kill(-j.pid, 'SIGKILL'); } catch { try { process.kill(j.pid, 'SIGKILL'); } catch { /* gone */ } } }
  for (let i = 0; ; i++) {
    try { rmSync(box, { recursive: true, force: true }); return; } catch (e) {
      if (i >= 50) throw e;
      await sleep(200);
    }
  }
}, 30_000);

describe('`timmy workbench` at the operator\'s sizes, kept as captures (tmux; R5 H131)', () => {
  it('Home, Chat & Intent, Workflows and Control Room at 160x45, 120x40 and 100x30: one frame each, exactly the terminal\'s rows, no line wider; row 1, row 2, the body and Activity & log; no folder of this machine and not its name', async () => {
    const trayRoot = join(timmyHome, 'projects', 'tray1');
    // FAKE: a session that starts one job through Timmy's real job store and ends without stopping it
    const helper = join(box, 'fake-left-job.mts');
    writeFileSync(helper, [
      '// FAKE job (test only): a session that starts one job and ends without stopping it; prints the job id',
      `import { JobManager } from '${JOBS}';`,
      'const [dir, root, project] = process.argv.slice(2);',
      'const jobs = new JobManager({ dir });',
      "const j = jobs.start({ kind: 'task', label: 'FAKE job (test): sleep 300', project, root, command: 'sleep', args: ['300'] });",
      "for (let i = 0; i < 100 && jobs.get(j.id)?.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 50));",
      'console.log(j.id);',
      'process.exit(0);',
      '',
    ].join('\n'));
    const left = await runAsync(process.execPath, ['--import', LOADER, helper, join(timmyHome, 'jobs'), trayRoot, 'tray1'], { cwd: repo, env, timeout: 30_000 });
    expect(left.status, left.stderr).toBe(0);
    const leftId = left.stdout.trim();

    const t = terminal('wbR5');
    t.tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '160', '-y', '45', '-c', repo, 'bash', '--norc', '-c',
      `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
    await t.waitFor(/tray1 \/ Home · connections, as observed[\s\S]*Activity & log/, 'Home, at the start');
    await t.waitFor(new RegExp(`Stop current: ${leftId}`), 'Stop current naming the FAKE job a session left');

    // FAKE upmd: one run of APPROVAL.md › tidy, from row 2's first action on Workflows (the bar has the keyboard at the start;
    // Home selects its first action, whichever the frame made the primary; Enter: its Run confirm; Enter: the REPL's own
    // /run, whose NEEDS YOU box the Workbench draws; y allows it once)
    await t.keys('3');
    await t.waitFor(/tray1 \/ Workflows · plan and run/, 'Workflows');
    await t.keys('Home');
    await t.waitFor(/1 Run APPROVAL\.md › tidy · \/run APPROVAL\.md tidy · /, 'row 2\'s first action selected, with its command');
    await t.keys('Enter');
    await t.waitFor(/Run APPROVAL\.md › tidy\?/, 'the Run confirm');
    await t.keys('Enter');
    await t.waitFor(/⚠ NEEDS YOU[\s\S]*deny \(the default\)/, 'the NEEDS YOU box');
    // past the box's type-ahead guard (keys in its first GUARD_MS are not answers), counted from when it was seen drawn
    await pastGuard(Date.now(), GUARD_MS);
    await t.keys('y');
    const tidy = () => jobRecords().find((j) => j.root === trayRoot && j.label === 'APPROVAL.md › tidy');
    for (const end = Date.now() + 60_000; tidy()?.state !== 'completed' && Date.now() < end;) await sleep(200);
    expect(tidy()?.state, 'the FAKE-upmd run of APPROVAL.md › tidy, by its job record').toBe('completed');

    const pages = [
      // (at 100x30 the title gives its tail to the range note, 1–N of M: QA defect 7)
      { key: '1', name: 'home', title: /tray1 \/ Home · connections/ },
      { key: '2', name: 'chat', title: /tray1 \/ Chat · conversation/ },
      { key: '3', name: 'workflows', title: /tray1 \/ Workflows · plan and run/ },
      { key: '7', name: 'control-room', title: /tray1 \/ Control Room · jobs/ },
    ] as const;
    const kept: string[] = [];
    for (const [w, h] of [[160, 45], [120, 40], [100, 30]] as const) {
      t.tmux('resize-window', '-t', 't', '-x', String(w), '-y', String(h));
      for (const p of pages) {
        await t.keys(p.key);
        await t.waitFor(p.title, `${p.name} at ${w}x${h}`);
        // the run's end is read (Chat's pipeline names its receipt) and the frame's waiting counts are drawn
        if (p.name === 'chat') await t.waitFor(/Pipeline · intent → predict → sandbox → receipt[\s\S]*sealed/, `Chat's pipeline with the run's sealed records at ${w}x${h}`);
        if (p.name === 'control-room') await t.waitFor(new RegExp(`${leftId} [━─][^\\n]*\\n[^\\n]*▶ running {2}FAKE job \\(test\\): sleep 300`), `the FAKE job's pane in the Control Room at ${w}x${h}`);
        // kept once it is whole (its tab's title, its bottom border, its key-hint line) and the same in two reads
        const name = `${p.name}-${w}x${h}-FAKE-fixtures`;
        const txt = t.capture(name, p.title);
        kept.push(name);
        const rows = txt.replace(/\n$/, '').split('\n');
        expect(rows, `${name}: one frame, as many rows as the terminal`).toHaveLength(h);
        expect(Math.max(...rows.map((l) => [...l].length)), `${name}: no row wider than the terminal`).toBeLessThanOrEqual(w);
        expect(txt.split('Workflow actions').length - 1, `${name}: one frame`).toBe(1);
        expect(rows[1], `${name}: row 1`).toMatch(/^TIMMY · tray1/);
        expect(txt).toContain('Activity & log');
        // nothing of this machine: not the sandbox's folders, not its name
        expect(txt.includes(box), `${name}: a folder of this machine`).toBe(false);
        expect(txt.includes(hostname()), `${name}: this machine's name`).toBe(false);
      }
    }
    await t.keys('C-c');
    await t.waitFor(/EXIT=0\b/, 'the Workbench quitting at Ctrl+C (the FAKE job is another session\'s: it is left running, and named; R6 H141: it stopped nothing, so exit 0)', 20_000);
    expect(existsSync(join(box, 'opened.log'))).toBe(false);
    console.log(`Workbench captures (R5, ${kept.length} screens, .ansi and .txt): ${CAPTURES}\n  ${kept.join('\n  ')}`);
  }, 300_000);
});
