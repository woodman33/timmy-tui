// R4 (H112): the terminal Workbench's interaction proof (the operator's slice C) in a real terminal: tmux, over a sandbox of
// its own (HOME, the XDG folders, the Timmy home, the settings folder, the store, TMPDIR and the tmux servers all inside this
// test's temporary folder). The home is made by `timmy init --yes`, the projects by the REPL's own `/project new` (through
// `timmy act`), and `timmy workbench` runs as the installed command runs it (src/cli.ts through tsx's loader). Keys are sent
// with tmux send-keys; mouse reports as the terminal sends them once a program asks for SGR reports (send-keys -l of
// ESC [ < b ; x ; y M, then m); what the program asked of the terminal is read from tmux (#{mouse_any_flag} and its kin) and
// from the bytes it wrote (pipe-pane).
//
// FAKE here: upmd, a TEST DOUBLE of upmd 0.2.7 (tests/fixtures/fake-upmd.mjs, through UPMD_BIN; its blocks run for real
// through sh, on a pty through Timmy's own workers/upmd/pty_run.py, this machine's python3); the workflow documents SLOW.md
// and STREAM.md (this test's: they sleep and print); one job a FAKE session leaves running (a helper this test writes, as
// tests/workbench-pty.test.ts does); the browser openers on PATH (stubs that only log; nothing here presses Show). The person
// is this test's keys and clicks. Everything else is the real program, the REPL's recovery (`timmy act /recover`) included.
//
// Screens are kept (capture-pane -e as .ansi, plain as .txt) in <tmpdir>/timmy-workbench-captures, as the H110 test keeps its.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { visibleWidth } from '../src/term/width.js';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { enterOnBlock, keepScreen, scrub, selectedBlock, sendKeys, settledScreen, waitScreen, workflowsList, type Pane } from './helpers/tmux-frame.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const JOBS = pathToFileURL(resolve('src/jobs/index.ts')).href;
const CONTEXT = pathToFileURL(resolve('src/ops/context.ts')).href;
const OPERATIONS = pathToFileURL(resolve('src/ops/operations.ts')).href;
// FAKE: upmd is a TEST DOUBLE of upmd 0.2.7's --ci behaviour (tests/fixtures/fake-upmd.mjs); each block runs for real through sh
const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const CAPTURES = join(tmpdir(), 'timmy-workbench-captures');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// FAKE workflows (this test's): blocks that wait, and one that prints a line every 200 ms for 6 s. R4 lead (2026-10-12; the
// full suite at 58ab7c9): `wait` slept 10 s, and under the suite's load a second Workbench took longer than that to start and
// reach its Control Room, so it found the run already ended (the product said so rightly: "completed · another session"). It
// now runs until the test releases it (a file outside the project), at most 90 s, so the test's own pace cannot end it early.
// The block only reads: a block with rm (or sudo, chmod, chown, dd, mkfs) is a destructive shell command and asks first.
const slow = (release: string): string => `# Slow (FAKE workflow, this test)\n\nIts blocks only wait.\n\n\`\`\`bash [name:wait]\ni=0; while [ ! -f '${release}' ] && [ $i -lt 900 ]; do sleep 0.1; i=$((i+1)); done\n\`\`\`\n\n\`\`\`bash [name:long]\nsleep 120\n\`\`\`\n`;
/** Holds the next run of `wait` (no release file), before it starts. */
const holdWait = (): void => { rmSync(join(box, 'release-wait'), { force: true }); };
/** Ends the running `wait` block (its release file). */
const releaseWait = (): void => { writeFileSync(join(box, 'release-wait'), ''); };
const STREAM = '# Stream (FAKE workflow, this test)\n\nIt prints a line every 200 ms for 6 s.\n\n```bash [name:talk]\nfor i in $(seq 1 30); do echo "line $i"; sleep 0.2; done\n```\n';

let box = '';
let repo = '';
let timmyHome = '';
let trayA = '';
let env: NodeJS.ProcessEnv = {};
const servers: string[] = [];

const cli = (args: string[], timeout = 60_000) => runAsync(process.execPath, ['--import', LOADER, CLI, ...args], { cwd: repo, env, timeout });
const jobsDir = () => join(timmyHome, 'jobs');
const records = () => (existsSync(jobsDir()) ? readdirSync(jobsDir()) : []).filter((n) => n.endsWith('.json'))
  .map((n) => JSON.parse(readFileSync(join(jobsDir(), n), 'utf8')) as { id: string; label: string; root: string; state: string; pid?: number; operation?: string; error?: string; owner?: { pid: number }; steps?: Array<{ name: string; state: string }> });
const runsOf = (label: string, root = trayA) => records().filter((j) => j.root === root && j.label === label);
/**
 * R4 lead (full suite 38): a run's block has started once its job record lists the step (src/jobs JobStep, taken from upmd's
 * start line). "Stop current" names the job as soon as it runs, which can be before that: a Workbench killed in between left
 * a record of 0 of 1 step, as it should, where this test expected 1 of 1. The stop and the kill now come after the start.
 */
const blockStarted = async (id: string): Promise<void> => {
  for (const end = Date.now() + 15_000; Date.now() < end; await sleep(100)) {
    if ((records().find((j) => j.id === id)?.steps ?? []).length > 0) return;
  }
  throw new Error(`the block of job ${id} did not start in 15 s`);
};
/**
 * R4 lead (CI at f22e044): an item that fails while `wait` is held must not leave it running into the next items (item 4
 * then found its operation to pick up, item 5 a run not completed): its finally releases it and gives the run a moment to end.
 */
const endHeldWait = async (): Promise<void> => {
  releaseWait();
  for (const end = Date.now() + 10_000; runsOf('SLOW.md › wait').some((j) => j.state === 'running') && Date.now() < end;) await sleep(200);
};
const opsDir = (root = trayA) => join(root, '.timmy', 'operations');
const operations = (root = trayA) => (existsSync(opsDir(root)) ? readdirSync(opsDir(root)) : []).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(opsDir(root), n), 'utf8')) as { id: string; request: string; via: string; state: string; ended: string | null });
const storeLines = () => { const f = join(box, 'store', 'runs.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0; };
const widest = (s: string) => Math.max(...s.split('\n').map((l) => visibleWidth(l)));
const count = (s: string, needle: string) => s.split(needle).length - 1;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A panel's text (its title `title`: the navigation's TIMMY, the right dock's Context): its rows inside its borders, as one line. */
function panelText(screen: string, title: string): string {
  const rows = screen.split('\n');
  const head = new RegExp(`[╭┏][─━] (?:◆ )?${title}\\b`);
  const top = rows.findIndex((l) => head.test(l));
  if (top < 0) return '';
  const x = rows[top].search(head);
  const right = rows[top].slice(x + 1).search(/[╮┓]/) + x + 1;
  const out: string[] = [];
  for (let y = top + 1; y < rows.length && !/^[╰┗]/.test(rows[y].slice(x)); y++) out.push(rows[y].slice(x + 1, right));
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** The panel with the keyboard (its title marked ◆): its rows below its first `fixed`, and its range note (a–b of n); `found`
 *  false when the screen has no such panel (a capture that landed before Ink drew it). */
function focusedPanel(screen: string, fixed = 3): { found: boolean; rows: string[]; range: string; total: number } {
  const lines = screen.split('\n');
  const top = lines.findIndex((l) => l.includes('┏━ ◆ '));
  if (top < 0) return { found: false, rows: [], range: '', total: 0 };
  const x = lines[top].indexOf('┏━ ◆ ');
  const note = /(\d+)–(\d+) of (\d+)/.exec(lines[top].slice(x));
  const rows: string[] = [];
  let y = top + 1;
  for (; y < lines.length && !lines[y].slice(x).startsWith('┗'); y++) rows.push(lines[y].slice(x + 1).replace(/┃\s*$/, '').trimEnd());
  // (its bottom edge drawn too: a frame caught mid-draw has the title and not yet the rest)
  return { found: y < lines.length, rows: rows.slice(fixed), range: note ? `${note[1]}–${note[2]}` : '', total: note ? Number(note[3]) : rows.length - fixed };
}

/**
 * R5 (H131, on H136's measurement: 2 of 300 captures at load 13 landed mid-frame, before Ink had drawn Activity): the panel
 * with the keyboard, read until it is drawn whole and the screen is the same in two reads; the deadline names what it waited
 * for. Every read of the panel in this file goes through it. R5 (H136; the finish line, item 5): through the one shared wait
 * (tests/helpers/tmux-frame.ts), a whole frame of the Workbench the same in two reads, its panel drawn to its bottom edge.
 */
async function focusedSettled(pane: Pane, fixed = 3, ms = 10_000): Promise<ReturnType<typeof focusedPanel>> {
  const screen = await waitScreen(pane, { what: 'the panel with the keyboard, drawn whole', test: (s) => focusedPanel(s, fixed).found, ms });
  return focusedPanel(screen, fixed);
}

/**
 * R5 (H137): one column of the Control Room's body on a screen (0 the roster, 1 the panes, 2 the right column), its wrapped rows
 * joined: the body is split at its rules, the cells holding │ on every row that has one (a pane's edge is not on its column's
 * heading row), so the split holds at any width.
 */
function controlColumn(screen: string, k: number): string {
  const rows = screen.split('\n');
  const head = /[╭┏][─━] (?:◆ )?\S+ \/ Control Room/;
  const top = rows.findIndex((l) => head.test(l));
  if (top < 0) return '';
  const x = rows[top].search(head);
  const right = rows[top].slice(x + 1).search(/[╮┓]/) + x + 1;
  const body: string[][] = [];
  for (let y = top + 1; y < rows.length && !/^[╰┗]/.test(rows[y].slice(x)); y++) body.push([...rows[y].slice(x + 1, right)]);
  const ruled = body.filter((r) => r.includes('│'));
  const rules = ruled.length ? [...ruled[0].keys()].filter((i) => ruled.every((r) => r[i] === '│')) : [];
  const edges = [-1, ...rules, Number.POSITIVE_INFINITY];
  return body.map((r) => r.slice(edges[k] + 1, edges[k + 1]).join('')).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * A tmux server of the test's own (its socket in the test's folder), its screen, its keys, its mouse and a kept capture. R5
 * (H136; the finish line, item 5): each through tests/helpers/tmux-frame.ts. A screen is read, waited for and kept only as a
 * whole frame of the Workbench (row 1's tab titles, the bottom border, the key-hint line or the notice in its place) the same
 * in two reads, and a key or a mouse report is sent once the Workbench has read the one before it.
 */
function terminal(label: string) {
  servers.push(label);
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  const pane: Pane = { tmux, target: 't', folders: [box] };
  const screen = (t = 't') => settledScreen(pane, { target: t });
  // (frame false: a screen that is not the Workbench's frame though its screen is still up, as a Workbench killed outright leaves it)
  const waitFor = (re: RegExp, ms = 30_000, t = 't', o: { frame?: boolean } = {}): Promise<string> => waitScreen(pane, { what: `${re}`, re, ms, target: t, ...o });
  const until = (test: (s: string) => boolean, what: string, ms = 10_000, t = 't'): Promise<string> => waitScreen(pane, { what, test, ms, target: t });
  const keys = (...k: string[]) => sendKeys(pane, k);
  const keysTo = (t: string, ...k: string[]) => sendKeys(pane, k, { target: t });
  const typed = (text: string, t = 't') => sendKeys(pane, [text], { literal: true, target: t });
  // the workspace search: '/', then its prompt on screen, the text, the text on screen, then Enter
  const find = async (name: string, t = 't') => {
    await keysTo(t, '/');
    await waitFor(/^\S?\s*\/ /m, 10_000, t);
    await typed(name, t);
    // the navigation's own search row (the top line's "project / workspace" is not it)
    await waitFor(new RegExp(`^\\S?\\s*/ ${name}`, 'm'), 10_000, t);
    await keysTo(t, 'Enter');
  };
  /** The 1-based cell of `needle` on the screen now (its `nth` match), as a mouse report names it. */
  const cellOf = (needle: string, nth = 0, t = 't'): { x: number; y: number } => {
    let rows: string[] = [];
    // (each read a whole frame, the same in two reads: tests/helpers/tmux-frame.ts); read again for up to 3 s for the needle
    for (const end = Date.now() + 3000; ;) {
      rows = screen(t).split('\n');
      let seen = 0;
      for (let y = 0; y < rows.length; y++) {
        const at = rows[y].indexOf(needle);
        if (at < 0 || seen++ < nth) continue;
        return { x: visibleWidth(rows[y].slice(0, at)) + 1, y: y + 1 };
      }
      if (Date.now() > end) break;
      execFileSync('sleep', ['0.1']);
    }
    throw new Error(`"${needle}" is not on the screen in 3 s:\n${scrub(rows.join('\n'), [box])}`);
  };
  /** The cell of `needle` on the first row that matches `row` (a tab on the tabs' row, say). */
  const cellOnRow = (needle: string, row: RegExp, t = 't'): { x: number; y: number } => {
    const rows = screen(t).split('\n');
    const y = rows.findIndex((l) => row.test(l));
    const at = y >= 0 ? rows[y].indexOf(needle, rows[y].search(row)) : -1;
    if (at < 0) throw new Error(`"${needle}" is not on a row matching ${row}:\n${scrub(rows.join('\n'), [box])}`);
    return { x: visibleWidth(rows[y].slice(0, at)) + 1, y: y + 1 };
  };
  const click = (p: { x: number; y: number }) => sendKeys(pane, [`\x1b[<0;${p.x};${p.y}M\x1b[<0;${p.x};${p.y}m`], { literal: true });
  const wheel = (p: { x: number; y: number }, down: boolean) => sendKeys(pane, [`\x1b[<${down ? 65 : 64};${p.x};${p.y}M`], { literal: true });
  const modes = (t = 't') => tmux('display-message', '-p', '-t', t, '#{mouse_any_flag} #{mouse_standard_flag} #{mouse_sgr_flag} #{alternate_on}').trim();
  // (a kept screen: whole and the same in two reads; a notice may hold the key-hint line's place, as it does in a wait)
  const capture = (name: string, t = 't'): string => keepScreen(pane, CAPTURES, name, { target: t, foot: 'drawn' });
  const start = (w: number, h: number, raw?: string) => {
    tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', String(w), '-y', String(h), '-c', repo, 'bash', '--norc', '-c',
      // R6 (H141): after the Workbench, what is left typed in its terminal for the shell is read and said (LEFT=[…])
      `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; read -r -t 1 -n 64 left; echo "LEFT=[$left]"; sleep 600`);
    if (raw) tmux('pipe-pane', '-o', '-t', 't', `cat >> '${raw}'`);
  };
  /** The Workbench's own process (the pane's shell's child). */
  const pid = (t = 't'): number => {
    const shell = tmux('display-message', '-p', '-t', t, '#{pane_pid}').trim();
    const child = execFileSync('ps', ['-o', 'pid=', '--ppid', shell], { encoding: 'utf8' }).trim().split(/\s+/)[0];
    return Number(child);
  };
  const close = () => { try { tmux('kill-server'); } catch { /* gone */ } };
  return { tmux, pane, screen, waitFor, until, keys, keysTo, typed, find, cellOf, cellOnRow, click, wheel, modes, capture, start, pid, close };
}

/**
 * Moves the Workflows list's selection to `doc` › `block` (its row's marker), with the keys. R5 (H136; the finish line, item
 * 5): the selection is read from a whole frame only (tests/helpers/tmux-frame.ts workflowsList: the ▸ row and the document it
 * sits under, in the list that has the keyboard), and each key's effect is seen before the next key goes: Home, the list's
 * first block selected; each Down, the selection moved on. No key is on its way when the walk ends (H134 saw a walk end on
 * STREAM.md › talk once: a Down still on its way moved the selection after the walk had read the block it wanted), and the
 * Enter that follows waits for that block selected (enterOnBlock).
 */
async function selectBlock(t: ReturnType<typeof terminal>, doc: string, block: string, w = 't'): Promise<void> {
  const want = `${doc} › ${block}`;
  const named = (screen: string): string => { const b = selectedBlock(screen); return b?.focused ? `${b.doc} › ${b.block}` : ''; };
  let now = named(await t.until((s) => named(s) !== '', 'a block selected in the Workflows list, which has the keyboard', 10_000, w));
  if (now === want) return;
  await t.keysTo(w, 'Home');
  now = named(await t.until((s) => { const l = workflowsList(s); return !!l?.focused && l.fromTop && l.blocks[0]?.selected === true; }, 'the list\'s first block selected (Home)', 10_000, w));
  for (let steps = 0; now !== want; steps++) {
    if (steps >= 40) throw new Error(`${want} is not selected after 40 Downs; the list's block now: ${now}:\n${scrub(t.screen(w), [box])}`);
    const before = now;
    await t.keysTo(w, 'Down');
    now = named(await t.until((s) => named(s) !== '' && named(s) !== before, `the selection moved down from ${before} (on the way to ${want})`, 10_000, w));
  }
}

/** R5 (H137): Context as tab 7's drawer (i): opened, its title waited for on the screen; shut, its title waited away. */
async function drawer(t: ReturnType<typeof terminal>, open: boolean): Promise<void> {
  await t.keys('i');
  if (open) { await t.waitFor(/◆ Context \(drawer\)/, 5000); return; }
  for (const end = Date.now() + 5000; /Context \(drawer\)/.test(t.screen()) && Date.now() < end;) await sleep(100);
  expect(t.screen()).not.toMatch(/Context \(drawer\)/);
}

beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), 'wb-interaction-pty-'));
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
    // R10 CHAT (H167): the Workbench as it was before the Chat screen (Home first, the classic Chat tab): this file checks what
    // it opens there; the Chat screen's own are tests/workbench-chat-shell.test.ts and tests/workbench-chat-landing-pty.test.ts
    XDG_CACHE_HOME: join(home, '.cache'), TIMMY_WORKBENCH_CHAT: 'classic', TIMMY_HOME: timmyHome, TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(box, 'store'),
    TIMMY_SETTINGS_DIR: join(box, 'settings'), TMPDIR: join(box, 'tmp'), OPENROUTER_API_KEY: '', COLORTERM: 'truecolor',
    TMUX: '', TMUX_TMPDIR: box, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: `${bin}:${process.env.PATH ?? ''}`, UPMD_BIN: FAKE_UPMD,
  };
  const init = await cli(['init', '--yes', '--operator', 'Sample', '--seed', 'generate', '--project', 'demo']);
  expect(init.status, init.stderr).toBe(0);
  for (const cmd of ['/project new trayB', '/project new trayA --from tray-workflow']) {
    const made = await cli(['act', cmd]);
    expect(made.status, `${made.stdout}\n${made.stderr}`).toBe(0);
  }
  trayA = join(timmyHome, 'projects', 'trayA');
  writeFileSync(join(trayA, 'SLOW.md'), slow(join(box, 'release-wait')));
  writeFileSync(join(trayA, 'STREAM.md'), STREAM);
}, 180_000);

// R5 (H131): the hook's own retries take up to 10 s (50 x 200 ms), the default hook timeout: under a loaded machine it
// timed out while it still had retries left (seen once in a 4-file run); it gets the time its loop needs
afterAll(async () => {
  for (const label of servers) { try { execFileSync('tmux', ['-L', label, 'kill-server'], { env, stdio: 'ignore' }); } catch { /* none */ } }
  // what a test left running (a stopped test's runs), by their records' pids: only processes this test's records name
  for (const j of records()) if (j.pid && (j.state === 'running' || j.state === 'queued')) { try { process.kill(-j.pid, 'SIGKILL'); } catch { /* gone */ } }
  for (let i = 0; ; i++) {
    try { rmSync(box, { recursive: true, force: true }); return; } catch (e) {
      if (i >= 50) throw e;
      await sleep(200);
    }
  }
}, 30_000);

describe('`timmy workbench` in a terminal: the interaction proof (tmux; R4 H112, slice C)', () => {
  it('the mouse (item 1): it asks for SGR reports; a click opens a workspace, picks a tab, selects a row and runs nothing; the wheel scrolls the list under the pointer; m gives the mouse to the terminal and takes it back; quit with the mouse given back leaves no mouse mode', async () => {
    const raw = join(box, 'raw-mouse.log');
    const t = terminal('wbM');
    try {
      t.start(160, 45, raw);
      await t.waitFor(/trayA \/ [\s\S]*Activity/);
      await t.find('Workflows');
      await t.waitFor(/trayA \/ Workflows/, 5000);
      // it asked the terminal for button reports in SGR encoding, in its own screen (R5 H136: it asks before its first frame,
      // src/workbench/run.ts, so the frame waited for above comes after it)
      expect(t.modes()).toBe('1 1 1 1');
      // a click on row 1's 7 Control Room opens it, and on 3 Workflows (R5: the tabs; the navigation is a drawer). R10 (H167):
      // the tabs are the header's second row, their first words at 160 columns beside the word "unfinished"
      await t.click(t.cellOf('7 Control'));
      await t.waitFor(/trayA \/ Control Room/, 5000);
      await t.click(t.cellOf('Workflows'));
      await t.waitFor(/trayA \/ Workflows/, 5000);
      // a click on a right-dock tab picks it: Tools, then Files (the Inspector is the first one shown); R5 (H136): tab 3's
      // body takes the whole width, so Context is its drawer (i), closed again before the row is clicked
      await t.keys('i');
      await t.waitFor(/◆ Context \(drawer\)/, 5000);
      expect(t.screen()).toMatch(/Tools │ ▸ Inspector │ {3}Files/);
      await t.click(t.cellOnRow('Tools', /Tools │\s+(?:▸ )?Inspector/));
      await t.waitFor(/▸ Tools │ {3}Inspector │ {3}Files/, 5000);
      await t.click(t.cellOnRow('Files', /Tools │\s+(?:▸ )?Inspector/));
      await t.waitFor(/Tools │ {3}Inspector │ ▸ Files/, 5000);
      await t.keys('i');
      for (const end = Date.now() + 5000; /Context \(drawer\)/.test(t.screen()) && Date.now() < end;) await sleep(100);
      expect(t.screen()).not.toMatch(/Context \(drawer\)/);
      // a click on a row selects it; clicked again and again, it is only selected: no confirm, no NEEDS YOU box, no job
      const row = t.cellOf(' tidy ');
      await t.click(row);
      await t.click(row);
      await t.click(row);
      await t.waitFor(/RUN\s+APPROVAL\.md › tidy/, 5000);
      // (R5 H136: an observation window, not a wait: nothing is to open in it, and every click was read before it began)
      await sleep(800);
      expect(t.screen()).not.toMatch(/Run APPROVAL\.md › tidy\?|⚠ NEEDS YOU/);
      expect(runsOf('APPROVAL.md › tidy')).toEqual([]);
      t.capture('wb-mouse-160x45-row-selected');
      // the wheel over All tools' list scrolls it by rows (its range note moves), and opens nothing (9 Tools & MCP opens it)
      await t.click(t.cellOf('9 Tools'));
      const tools = await t.waitFor(/\/ Tools & integrations[^\n]*1–\d+ of \d+/, 30_000);
      const total = /1–(\d+) of (\d+)/.exec(tools)!;
      const over = t.cellOf('[r] checks again');
      for (let i = 0; i < 3; i++) await t.wheel(over, true);
      await t.waitFor(new RegExp(`4–${Number(total[1]) + 3} of ${total[2]}`), 5000);
      expect(t.screen()).toContain('trayA / Tools & integrations');
      // m: the mouse back to the terminal (it reports none to the Workbench; the terminal selects text again), then taken
      await t.keys('m');
      await t.waitFor(/Mouse: the terminal's again/, 5000);
      expect(t.modes()).toBe('0 0 0 1');
      await t.keys('m');
      await t.waitFor(/Mouse: the Workbench takes clicks/, 5000);
      expect(t.modes()).toBe('1 1 1 1');
      // given back again, then quit: the terminal is left with no mouse mode and its own screen
      await t.keys('m');
      await t.keys('C-c');
      const after = await t.waitFor(/EXIT=(\d+)/, 20_000);
      // R6 (H141): a quit that stopped nothing reports no interruption
      expect(after.match(/EXIT=(\d+)/)![1]).toBe('0');
      expect(t.modes()).toBe('0 0 0 0');
      const bytes = readFileSync(raw, 'utf8');
      expect(bytes.includes('\x1b[?1000h') && bytes.includes('\x1b[?1006h')).toBe(true);
      expect(bytes.lastIndexOf('\x1b[?1000l')).toBeGreaterThan(bytes.lastIndexOf('\x1b[?1000h'));
      expect(bytes.lastIndexOf('\x1b[?1006l')).toBeGreaterThan(bytes.lastIndexOf('\x1b[?1006h'));
    } finally {
      t.close();
    }
  }, 180_000);

  it('duplicates and retries (item 2), and a project switch during a run (item 3): two Enters at once start one job and one operation; Run again says so; a second Workbench in another window shows the run and starts nothing; p to trayB keeps the run and its Stop, back in trayA it ends once', async () => {
    const t = terminal('wbD');
    try {
      t.start(160, 45);
      await t.waitFor(/trayA \/ [\s\S]*Activity/);
      await t.find('Workflows');
      await t.waitFor(/trayA \/ Workflows/, 5000);
      holdWait();
      await selectBlock(t, 'SLOW.md', 'wait');
      await enterOnBlock(t.pane, 'SLOW.md', 'wait');
      await t.waitFor(/Run SLOW\.md › wait\?/, 5000);
      const jobsBefore = records().length;
      const sealedBefore = storeLines();
      // two Enters in one send (as fast as a terminal delivers them)
      t.tmux('send-keys', '-t', 't', 'Enter', 'Enter');
      await t.waitFor(/Stop current: j[0-9a-f]+ SLOW\.md › wait/, 15_000);
      // (R5 H136: an observation window, not a wait: no second run is to start in it)
      await sleep(1000);
      expect(runsOf('SLOW.md › wait')).toHaveLength(1);
      expect(operations().filter((o) => o.request === '/run SLOW.md wait')).toHaveLength(1);
      expect(records().length).toBe(jobsBefore + 1);
      const [job] = runsOf('SLOW.md › wait');
      expect(job.state).toBe('running');
      // Run again while it runs: said, nothing started (R5 H136: Enter once it is seen selected, in the list with the keyboard)
      await enterOnBlock(t.pane, 'SLOW.md', 'wait');
      await t.waitFor(new RegExp(`Not started: it is running now as ${job.id}, started by this Workbench`), 5000);
      expect(t.screen()).not.toMatch(/Run SLOW\.md › wait\?/);
      t.capture('wb-dup-160x45-run-again');

      // a second Workbench, in another window of this terminal: it shows the run, as another session's, and starts nothing
      const ops = operations().length;
      const sealed = storeLines();
      t.tmux('new-window', '-t', 't', '-c', repo, 'bash', '--norc', '-c', `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
      await t.waitFor(/trayA \/ [\s\S]*Activity/, 30_000, 't:1');
      await t.find('Control', 't:1');
      // (R5 H137: its pane: its id on the box's edge, its mark, word and label below, then who started it)
      const second = await t.waitFor(new RegExp(`RUNNING NOW \\(1\\)[\\s\\S]*${job.id} [━─][^\\n]*\\n[^\\n]*▶ running {2}SLOW\\.md › wait[^\\n]*\\n[^\\n]*another session`), 10_000, 't:1');
      // R4 lead (CI at f22e044): the frame matched above can be caught while it is still being drawn (its lower rows blank), so
      // the Activity line is waited for, not read from that same capture
      expect(second).toMatch(/RUNNING NOW \(1\)/);
      await t.waitFor(new RegExp(`Activity\\s+\\S* ?1 running`), 5000, 't:1');
      await t.keysTo('t:1', 'a');
      await t.waitFor(new RegExp(`${job.id} started: SLOW\\.md › wait`), 5000, 't:1');
      t.capture('wb-dup-160x45-second-workbench', 't:1');
      // (R5 H136: an observation window, not a wait: the second Workbench is to start and seal nothing in it)
      await sleep(1000);
      expect(records().length).toBe(jobsBefore + 1);
      expect(operations().length).toBe(ops);
      expect(storeLines()).toBe(sealed);
      // its Run on the same block: who runs it, and nothing starts
      await t.keysTo('t:1', 'a');
      await t.find('Workflows', 't:1');
      await t.waitFor(/trayA \/ Workflows/, 5000, 't:1');
      await selectBlock(t, 'SLOW.md', 'wait', 't:1');
      await enterOnBlock(t.pane, 'SLOW.md', 'wait', { target: 't:1' });
      await t.waitFor(new RegExp(`Not started: it is running now as ${job.id}, started by another Timmy session`), 5000, 't:1');
      // (R5 H136: an observation window after the refusal was drawn: nothing is to start in it)
      await sleep(500);
      expect(runsOf('SLOW.md › wait')).toHaveLength(1);
      expect(operations().length).toBe(ops);
      // the second one quits at once (nothing of its own runs); the run goes on
      await t.keysTo('t:1', 'C-c');
      await t.waitFor(/EXIT=0\b/, 20_000, 't:1');
      expect(runsOf('SLOW.md › wait')[0].state).toBe('running');
      expect(sealedBefore).toBeLessThan(storeLines()); // only the first run's prediction (and nothing of the second window)

      // p to trayB: the run keeps running in trayA; Stop still names it, with its project; Activity says where it runs
      t.tmux('select-window', '-t', 't:0');
      await t.keys('p');
      await t.waitFor(/Switch project/, 5000);
      await t.typed('trayB');
      await t.waitFor(/› trayB\b[\s\S]*▸ trayB\b/, 10_000);
      await t.keys('Enter');
      const b = await t.waitFor(/trayB \/ Workflows/, 10_000);
      expect(b).toContain(`[x] Stop current: ${job.id} SLOW.md › wait (in trayA)`);
      expect(b).toMatch(/run: 1 running in trayA/);
      expect(b).toMatch(/Activity\s+\S* ?1 running \(1 in trayA\)/);
      t.capture('wb-switch-160x45-in-trayB');
      expect(runsOf('SLOW.md › wait')[0].state).toBe('running');
      // back in trayA: it ends there, normally, once
      await t.keys('p');
      await t.waitFor(/Switch project/, 5000);
      await t.typed('trayA');
      await t.waitFor(/› trayA\b[\s\S]*▸ trayA\b/, 10_000);
      await t.keys('Enter');
      await t.waitFor(/trayA \/ Workflows/, 10_000);
      releaseWait();
      for (const end = Date.now() + 30_000; runsOf('SLOW.md › wait')[0]?.state === 'running' && Date.now() < end;) await sleep(200);
      expect(runsOf('SLOW.md › wait')).toMatchObject([{ id: job.id, state: 'completed' }]);
      expect(runsOf('SLOW.md › wait', join(timmyHome, 'projects', 'trayB'))).toEqual([]);
      await t.waitFor(/Stop current: idle/, 10_000);
      await t.keys('C-c');
      await t.waitFor(/EXIT=0\b/, 20_000);
    } finally {
      await endHeldWait();
      t.close();
    }
  }, 240_000);

  it('reconnect and stale (item 4): quit while a run goes on (Ctrl+C twice): its record ends as the Workbench\'s own stop writes it, and recovery finds nothing left; a Workbench killed outright leaves a stale record: started again, the Workbench says stale, the REPL\'s recovery ends it, and the Workbench then says ended by recovery; a job an ended session left running is said left running, with its operation, and Stop names it', async () => {
    const recordOf = (id: string) => records().find((j) => j.id === id)!;
    const opOf = (id: string) => operations().find((o) => o.id === recordOf(id).operation);

    // 1. quit while it runs: Ctrl+C asks (naming the run), Ctrl+C again quits, stopping it through the Workbench's own stop
    const t = terminal('wbR');
    let quit = { id: '' } as ReturnType<typeof records>[number];
    try {
      t.start(160, 45);
      await t.waitFor(/trayA \/ [\s\S]*Activity/);
      await t.find('Workflows');
      await t.waitFor(/trayA \/ Workflows/, 15_000);
      await selectBlock(t, 'SLOW.md', 'long');
      await enterOnBlock(t.pane, 'SLOW.md', 'long');
      await t.waitFor(/Run SLOW\.md › long\?/, 15_000);
      await t.keys('Enter');
      await t.waitFor(/Stop current: j[0-9a-f]+ SLOW\.md › long/, 15_000);
      [quit] = runsOf('SLOW.md › long');
      await blockStarted(quit.id);
      await t.keys('C-c');
      const asked = await t.waitFor(/Quit the Workbench\?/, 15_000);
      expect(asked).toContain(`${quit.id} SLOW.md › long`);
      // R6 (H141; the interaction review of a77d80d, defect 15: a stray "7" once sat before the shell's next prompt after a quit
      // with a box open): a key typed while the box is up is the Workbench's, never left for the shell
      await t.typed('7');
      await t.keys('C-c');
      // R6 (H141): this quit stopped a run of its own, so it reports the interruption (130)
      const ended = await t.waitFor(/EXIT=130/, 30_000);
      // R5 (H136): the terminal is given back and the run's end is said there. Seen once at b303c1b: EXIT=130 written over
      // the Workbench's last frame, its own screen still up, no closing line; such an end fails here, not passes unnoticed
      expect(t.modes().split(' ')[3], `the alternate screen is left once the Workbench ends:\n${scrub(ended, [box])}`).toBe('0');
      expect(ended).toContain(`${quit.id} (SLOW.md › long) was cancelled as the Workbench ended.`);
      expect(await t.waitFor(/LEFT=\[[^\]]*\]/, 10_000, 't', { frame: false })).toContain('LEFT=[]');
    } finally {
      t.close();
    }
    // its record says how it ended (cancelled, its cleanup complete) and its operation that it was stopped: nothing is left
    // for recovery, and the REPL's /recover says so (and changes nothing)
    const quitRecord = recordOf(quit.id);
    expect(quitRecord).toMatchObject({ state: 'cancelled', cleanup: 'complete' });
    expect(quitRecord.pid !== undefined && alive(quitRecord.pid)).toBe(false);
    const quitOp = opOf(quit.id)!;
    expect(quitOp).toMatchObject({ state: 'stopped', via: 'workbench' });
    expect(quitOp.ended).not.toBe(null);
    const nothing = await cli(['act', '/recover', '--project', trayA]);
    expect(nothing.status, nothing.stderr).toBe(0);
    expect(nothing.stdout).toMatch(/nothing to pick up in trayA/);
    expect(recordOf(quit.id)).toEqual(quitRecord);

    // 2. killed outright while it runs (SIGKILL: nothing of the Workbench runs to record its end)
    const k = terminal('wbK');
    let killed = { id: '' } as ReturnType<typeof records>[number];
    try {
      k.start(160, 45);
      await k.waitFor(/trayA \/ [\s\S]*Activity/);
      await k.find('Workflows');
      await k.waitFor(/trayA \/ Workflows/, 15_000);
      await selectBlock(k, 'SLOW.md', 'long');
      await enterOnBlock(k.pane, 'SLOW.md', 'long');
      await k.waitFor(/Run SLOW\.md › long\?/, 15_000);
      await k.keys('Enter');
      await k.waitFor(/Stop current: j[0-9a-f]+ SLOW\.md › long/, 15_000);
      killed = runsOf('SLOW.md › long').find((j) => j.state === 'running')!;
      await blockStarted(killed.id);
      process.kill(k.pid(), 'SIGKILL');
      // (killed outright, it never left its screen: the shell's EXIT line is written over its last frame, not a frame)
      await k.waitFor(/EXIT=137/, 10_000, 't', { frame: false });
    } finally {
      k.close();
    }
    // its pty wrapper saw its Workbench end and stopped upmd: nothing of it runs, and its record still says it runs
    for (const end = Date.now() + 10_000; killed.pid !== undefined && alive(killed.pid) && Date.now() < end;) await sleep(200);
    expect(killed.pid !== undefined && alive(killed.pid)).toBe(false);
    expect(recordOf(killed.id)).toMatchObject({ state: 'running' });
    const killedOp = opOf(killed.id)!;
    expect(killedOp).toMatchObject({ state: 'running', ended: null, via: 'workbench' });

    // started again: the Control Room says stale, and what waits on you; the Inspector says it in recovery's words, with its
    // operation; Stop has nothing to stop (no process of it runs: /recover records it)
    const w = terminal('wbS');
    try {
      w.start(160, 45);
      await w.waitFor(/trayA \/ [\s\S]*Activity/);
      await w.find('Control');
      // (R5 H137: with nothing running, the newest ended runs are quiet panes, two to a row at 160 columns: the id on the box's
      // edge, the word, label and blocks below on one row where they fit, then who started it and its operation)
      const stale = await w.waitFor(new RegExp(`${killed.id} [━─][^\\n]*\\n[^\\n]*stale {2}SLOW\\.md › long · 1 of 1 step`), 10_000);
      // the right dock on its Inspector (a layout remembered from an earlier Workbench may have it on Files); R5 (H137): tab 7
      // draws its own columns, so Context is its drawer (i), shut again before a pane is clicked
      await drawer(w, true);
      if (!/▸ Inspector/.test(w.screen())) { await w.click(w.cellOnRow('Inspector', /Tools │\s+(?:▸ )?Inspector/)); await w.waitFor(/▸ Inspector/, 15_000); }
      await drawer(w, false);
      expect(controlColumn(stale, 2)).toMatch(new RegExp(`⚠ workflow run ${killed.id} \\(SLOW\\.md › long\\) was interrupted`));
      expect(stale).toContain('Stop current: idle');
      // the one quit with its Workbench: ended by its own stop, said as its record says (no recovery words)
      expect(stale).toMatch(new RegExp(`${quit.id} [━─][^\\n]*\\n[^\\n]*cancelled {2}SLOW\\.md › long · 1 of 1 step[^\\n]*\\n[^\\n]*${quitOp.id}`));
      await w.click(w.cellOf(`─ ${quit.id} `));
      await drawer(w, true);
      const quitDock = panelText(await w.waitFor(new RegExp(`Job\\s+${quit.id}`), 15_000), 'Context');
      expect(quitDock).toContain(`Operation ${quitOp.id}`);
      expect(quitDock).toContain('Record cancelled');
      expect(quitDock).not.toMatch(/left running|stale|ended by recovery/);
      w.capture('wb-recover-160x45-quit-inspector');
      // the stale one, selected
      await drawer(w, false);
      await w.click(w.cellOf(`─ ${killed.id} `));
      await drawer(w, true);
      const staleDock = panelText(await w.waitFor(new RegExp(`Job\\s+${killed.id}`), 15_000), 'Context');
      expect(staleDock).toContain('stale: its record says it runs, and no process of it runs: the session that started it ended without recording how it ended. /recover in the REPL records it (nothing is run again).');
      expect(staleDock).toContain('Record running, stale');
      expect(staleDock).toContain(`Operation ${killedOp.id}`);
      w.capture('wb-recover-160x45-stale-inspector');
      await w.keys('x');
      await w.waitFor(/Stop current: nothing runs in trayA\./, 15_000);
      expect(recordOf(killed.id)).toMatchObject({ state: 'running' });

      // the REPL's recovery: it records the interrupted run (nothing is run again); [r]: ended by recovery, in its words
      const recovered = await cli(['act', '/recover', '--project', trayA]);
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(recovered.stdout).toContain(`run ${killed.id} of SLOW.md › long was interrupted while long was running`);
      expect(recordOf(killed.id)).toMatchObject({ state: 'cancelled' });
      expect(opOf(killed.id)).toMatchObject({ state: 'interrupted' });
      await w.keys('r');
      // R5 (H131; this test's flake under load): [r] was taken, as its notice says. From then on the run detail is read again,
      // and until that reading comes the Inspector says "reading…", never the verdict read before: a reading made between
      // recovery's two writes (the job's record ended, the operation's not yet) said "left running", and it stayed drawn
      // (src/workbench/controller.ts wantDetail; step by step in tests/workbench-run-detail.test.ts)
      await w.waitFor(/Read trayA's records again at \d\d:\d\d:\d\d\./, 10_000);
      const ended = await w.waitFor(new RegExp(`${killed.id} [━─][^\\n]*\\n[^\\n]*cancelled {2}SLOW\\.md › long[^\\n]*\\n[^\\n]*ended by recovery`), 10_000);
      expect(panelText(ended, 'Context')).toMatch(/ended by recovery: a later session's recovery wrote its end from what it found \(.+\); nothing was run again\./);
      // whether to run it again still waits on the person (upmd resumes nothing), now with its record's own words
      expect(controlColumn(ended, 2)).toMatch(new RegExp(`⚠ workflow run ${killed.id} \\(SLOW\\.md › long\\) was interrupted`));
      // its operation's run detail, read after [r]: while it is read, nothing to scroll to; then the wheel over the Inspector
      // brings its verdict into view, one step at a time, each step's effect waited for on the screen
      const inspector = w.cellOnRow('Inspector', /Tools │\s+(?:▸ )?Inspector/);
      const verdictAfterR = async (): Promise<string> => {
        for (const end = Date.now() + 20_000; Date.now() < end;) {
          const text = panelText(w.screen(), 'Context');
          if (/RUN DETAIL[\s\S]*Verdict \S+ · \S+/.test(text)) return text;
          if (/Run detail: reading…/.test(text)) { await sleep(100); continue; }
          await w.wheel({ x: inspector.x, y: inspector.y + 8 }, true);
          for (const moved = Date.now() + 3000; panelText(w.screen(), 'Context') === text && Date.now() < moved;) await sleep(50);
        }
        throw new Error(`timed out after 20 s waiting for the run detail's verdict, read after [r], in the Inspector:\n${w.screen()}`);
      };
      const detail = await verdictAfterR();
      expect(detail).toMatch(new RegExp(`RUN DETAIL · ${killedOp.id} Objective /run SLOW\\.md long Verdict recovered · interrupted`));
      expect(detail).not.toContain('left running');
      w.capture('wb-recover-160x45-ended-by-recovery');

      // 3. a job an ended session left running (FAKE: a helper session starts it in an operation of its own and ends)
      const helper = join(box, 'fake-left-job.mts');
      writeFileSync(helper, [
        '// FAKE session (test only): starts one job in an operation of its own, records that operation, and ends without stopping it',
        `import { JobManager } from '${JOBS}';`,
        `import { inOperation, newOperationId } from '${CONTEXT}';`,
        `import { writeOperationRecord } from '${OPERATIONS}';`,
        'const [dir, root, project] = process.argv.slice(2);',
        'const jobs = new JobManager({ dir });',
        'const op = newOperationId();',
        'const started = new Date().toISOString();',
        "const j = inOperation({ id: op }, () => jobs.start({ kind: 'task', label: 'FAKE job (test): sleep 300', project, root, command: 'sleep', args: ['300'] }));",
        "const w = writeOperationRecord(root, { schema: 'timmy.operation/1', id: op, request: 'FAKE request (test): sleep 300', via: 'repl', project, started, ended: null, state: 'running', parent: null, runs: [{ kind: 'job', id: j.id, at: started }], owner: { pid: process.pid, started } });",
        "if (!w.ok) { console.error(w.error); process.exit(1); }",
        "for (let i = 0; i < 100 && jobs.get(j.id)?.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 50));",
        'console.log(`${j.id} ${op}`);',
        'process.exit(0);',
        '',
      ].join('\n'));
      const left = await runAsync(process.execPath, ['--import', LOADER, helper, jobsDir(), trayA, 'trayA'], { cwd: repo, env, timeout: 30_000 });
      expect(left.status, left.stderr).toBe(0);
      const [leftId, leftOp] = left.stdout.trim().split(/\s+/);
      expect(recordOf(leftId)).toMatchObject({ state: 'running', operation: leftOp });
      const helperPid = recordOf(leftId).owner!.pid;
      expect(alive(helperPid)).toBe(false);
      await w.keys('r');
      const running = await w.waitFor(new RegExp(`RUNNING NOW \\(1\\)[\\s\\S]*${leftId} [━─][^\\n]*\\n[^\\n]*▶ running {2}FAKE job \\(test\\): sleep 300[^\\n]*\\n[^\\n]*left running`), 10_000);
      expect(running).toContain(`Stop current: ${leftId} FAKE job (test): sleep 300`);
      await drawer(w, false);
      await w.click(w.cellOf(`─ ${leftId} `));
      await drawer(w, true);
      const leftDock = panelText(await w.waitFor(new RegExp(`Job\\s+${leftId}`), 15_000), 'Context');
      expect(leftDock).toContain(`left running: started by a Timmy session that has ended (pid ${helperPid}), and its process still runs. Stop ends it through recovery's stop (only when the process table proves the group is the job's).`);
      expect(leftDock).toContain(`Operation ${leftOp}`);
      expect(leftDock).toContain('Record running');
      expect(w.screen()).toContain(`Stop current: ${leftId} FAKE job (test): sleep 300`);
      w.capture('wb-recover-160x45-left-running');
      // x stops what the top line named: through recovery's stop; its record says cancelled; its process is gone
      const leftPid = recordOf(leftId).pid!;
      await w.keys('x');
      await w.waitFor(new RegExp(`Cancelled ${leftId}; its record says cancelled\\.`), 10_000);
      expect(recordOf(leftId)).toMatchObject({ state: 'cancelled' });
      for (const end = Date.now() + 5000; alive(leftPid) && Date.now() < end;) await sleep(100);
      expect(alive(leftPid)).toBe(false);
      await w.waitFor(/Stop current: idle/, 10_000);
      await w.keys('C-c');
      await w.waitFor(/EXIT=0\b/, 20_000);
    } finally {
      w.close();
    }
  }, 300_000);

  it('lines arriving and resizes (item 5): Activity expanded, a row selected higher up stays selected, on its row, with the rows above it, while a FAKE block prints a line every 200 ms (only following the newest moves the view; End follows again); resized during a run and during a NEEDS YOU box, the Workbench draws one frame as wide as the terminal, and the box still takes y', async () => {
    const t = terminal('wbL');
    try {
      t.start(160, 45);
      await t.waitFor(/trayA \/ [\s\S]*Activity/);
      await t.find('Workflows');
      await t.waitFor(/trayA \/ Workflows/, 5000);
      await selectBlock(t, 'STREAM.md', 'talk');
      await enterOnBlock(t.pane, 'STREAM.md', 'talk');
      await t.waitFor(/Run STREAM\.md › talk\?/, 5000);
      await t.keys('Enter');
      await t.waitFor(/Stop current: j[0-9a-f]+ STREAM\.md › talk/, 15_000);
      const [job] = runsOf('STREAM.md › talk');
      // Activity, expanded, with the keyboard (R5 H136: Workflows draws its own columns, Context the i drawer: one Tab)
      await t.keys('a', 'Tab');
      await t.waitFor(/following the newest/, 5000);
      await t.waitFor(new RegExp(`${job.id} │ line 10\\b`), 15_000);
      const activity = () => focusedSettled(t.pane);
      const first = await activity();
      expect(first.total).toBeGreaterThan(first.rows.length);
      // three rows up: held there
      await t.keys('Up', 'Up', 'Up');
      await t.waitFor(/held where you are \(End follows the newest\)/, 5000);
      const before = await activity();
      const at = before.rows.findIndex((r) => /^\s?▸ /.test(r));
      expect(at).toBeGreaterThan(0);
      // five more lines arrive (its range note counts them): the selected row, the rows above it and the range stay
      for (const end = Date.now() + 10_000; (await activity()).total < before.total + 5 && Date.now() < end;) await sleep(100);
      const after = await activity();
      expect(after.total).toBeGreaterThanOrEqual(before.total + 5);
      expect(after.range).toBe(before.range);
      expect(after.rows.slice(0, at + 1)).toEqual(before.rows.slice(0, at + 1));
      t.capture('wb-stream-160x45-held');
      // End: the newest again, shown at the foot
      await t.keys('End');
      await t.waitFor(/following the newest/, 5000);
      const following = await activity();
      expect(following.range.endsWith(`–${following.total}`)).toBe(true);
      expect(following.rows.findIndex((r) => /^\s?▸ /.test(r))).toBeGreaterThan(-1);
      for (const end = Date.now() + 20_000; runsOf('STREAM.md › talk')[0]?.state === 'running' && Date.now() < end;) await sleep(200);
      expect(runsOf('STREAM.md › talk')[0].state).toBe('completed');
      // every line once, in order, whatever upmd redrew (Activity, all of it, by its rows' words); R5 (H136): read once the
      // run's end is drawn (its job's completed event), not after a set time
      await t.waitFor(new RegExp(`${job.id} completed`), 10_000);
      // R6 lead (CI at bbf0d33, once; not seen in 3 local runs): one read after the run's end found the view not at its last
      // row. Read until the view shows the newest (up to 5 s; a view that stopped following still fails), and say what it showed
      let ended = await activity();
      for (const end = Date.now() + 5_000; !ended.range.endsWith(`–${ended.total}`) && Date.now() < end; await sleep(200)) ended = await activity();
      expect(ended.range.endsWith(`–${ended.total}`), `after the run's end the view shows ${ended.range} of ${ended.total}; its last rows: ${ended.rows.slice(-3).join(' / ')}`).toBe(true);

      // resized during a run: one frame each time, as wide as the terminal; the run and its Stop as they were
      await t.keys('BTab');
      holdWait();
      await selectBlock(t, 'SLOW.md', 'wait');
      await enterOnBlock(t.pane, 'SLOW.md', 'wait');
      await t.waitFor(/Run SLOW\.md › wait\?/, 5000);
      await t.keys('Enter');
      await t.waitFor(/Stop current: j[0-9a-f]+ SLOW\.md › wait/, 15_000);
      const wait = runsOf('SLOW.md › wait').find((j) => j.state === 'running')!;
      for (const [w, h] of [[120, 40], [100, 30], [160, 45]] as const) {
        t.tmux('resize-window', '-t', 't', '-x', String(w), '-y', String(h));
        await t.waitFor(new RegExp(`Stop current: ${wait.id}`), 10_000);
        // (kept once whole at this size and the same in two reads: the redraw for the new size, not a set time after it)
        const shot = t.capture(`wb-resize-run-${w}x${h}`);
        expect(count(shot, 'Activity & log'), shot).toBe(1);
        expect(widest(shot)).toBeLessThanOrEqual(w);
        // one frame from the first row to the last: the header first (R10 H167: TIMMY and the project on its first row, the
        // tabs on its second), Activity & log's bottom border last
        const rows = shot.trimEnd().split('\n');
        expect(rows).toHaveLength(h);
        expect(rows[0]).toMatch(/^TIMMY · trayA/);
        expect(rows[h - 1]).toMatch(/^[╰┗]/);
      }
      releaseWait();
      for (const end = Date.now() + 20_000; records().find((j) => j.id === wait.id)?.state === 'running' && Date.now() < end;) await sleep(200);
      expect(records().find((j) => j.id === wait.id)).toMatchObject({ state: 'completed' });
      expect(runsOf('SLOW.md › wait').filter((j) => j.state !== 'completed')).toEqual([]);

      // resized during a NEEDS YOU box: one box each time, answerable; y allows it once: one job, one operation, its receipts
      await t.waitFor(/Stop current: idle/, 10_000);
      await selectBlock(t, 'APPROVAL.md', 'tidy');
      await enterOnBlock(t.pane, 'APPROVAL.md', 'tidy');
      await t.waitFor(/Run APPROVAL\.md › tidy\?/, 5000);
      const sealed = storeLines();
      await t.keys('Enter');
      await t.waitFor(/⚠ NEEDS YOU/, 15_000);
      for (const [w, h] of [[120, 40], [100, 30], [160, 45]] as const) {
        t.tmux('resize-window', '-t', 't', '-x', String(w), '-y', String(h));
        await t.waitFor(/⚠ NEEDS YOU[\s\S]*\[y\] allow once/, 10_000);
        const shot = t.capture(`wb-resize-needs-you-${w}x${h}`);
        expect(count(shot, '⚠ NEEDS YOU'), shot).toBe(1);
        expect(count(shot, '[y] allow once'), shot).toBe(1);
        expect(count(shot, 'Activity & log'), shot).toBe(1);
        expect(widest(shot)).toBeLessThanOrEqual(w);
      }
      // nothing of the run has started while the box waits, and nothing is sealed
      expect(runsOf('APPROVAL.md › tidy')).toEqual([]);
      expect(storeLines()).toBe(sealed);
      await t.keys('y');
      for (const end = Date.now() + 20_000; runsOf('APPROVAL.md › tidy')[0]?.state !== 'completed' && Date.now() < end;) await sleep(200);
      expect(runsOf('APPROVAL.md › tidy')).toMatchObject([{ state: 'completed' }]);
      expect(operations().filter((o) => o.request === '/run APPROVAL.md tidy')).toHaveLength(1);
      const chain = readFileSync(join(box, 'store', 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).slice(sealed).map((l) => (JSON.parse(l) as { kind: string }).kind);
      // its receipts (the store notes each one sealed, as receipt.sealed): the prediction with the answer, the block, the run
      expect(chain.filter((k) => k !== 'receipt.sealed')).toEqual(['predict', 'workflow-block', 'workflow']);
      expect(chain.filter((k) => k === 'receipt.sealed')).toHaveLength(3);
      expect(t.screen()).not.toContain('⚠ NEEDS YOU');
      await t.keys('C-c');
      await t.waitFor(/EXIT=0\b/, 20_000);
    } finally {
      await endHeldWait();
      t.close();
    }
  }, 240_000);

  it('the way to the workspace finder (item 6): in All tools, while its search holds /, the search says Esc, then g, then / (R5: the navigation is a drawer at every size); [/] Find a workspace shows only where / finds one (the drawer); Esc clears the search and says g, then /; the same at 80x24', async () => {
    const t = terminal('wbF');
    try {
      t.start(160, 45);
      await t.waitFor(/trayA \/ [\s\S]*Activity/);
      await t.find('All tools');
      const tools = await t.waitFor(/trayA \/ Tools & integrations[\s\S]*\[r\] checks again/, 30_000);
      // the center has the keyboard: / searches the tools there; the list says how to reach the finder
      expect(panelText(tools, 'TIMMY')).toBe('');
      expect(tools).not.toContain('[/] Find a workspace');
      expect(tools).toContain('a workspace: g, then /');
      // /: the tools search, its first hint the way to the finder
      await t.keys('/');
      const typing = await t.waitFor(/Search: /, 5000);
      expect(typing).toContain('find a workspace: Esc, then g, then /');
      expect(typing).not.toContain('[/] Find a workspace');
      await t.typed('blender');
      await t.waitFor(/match "blender"/, 5000);
      t.capture('wb-finder-160x45-tools-search');
      // Esc: the search cleared, and the way to the finder said; g opens the navigation's drawer, where / finds a workspace
      await t.keys('Escape');
      await t.waitFor(/Tools search cleared\. g, then \/ finds a workspace\./, 5000);
      await t.keys('g');
      expect(panelText(await t.waitFor(/[╭┏][─━] (?:◆ )?TIMMY/, 5000), 'TIMMY')).toContain('[/] Find a workspace');
      await t.find('Templates');
      await t.waitFor(/trayA \/ Templates/, 5000);

      // 80x24: the navigation is not shown; the way is Esc, then g, then /
      t.tmux('resize-window', '-t', 't', '-x', '80', '-y', '24');
      await t.waitFor(/trayA \/ Templates/, 10_000);
      await t.find('All tools');
      // (its list is where it was left: the matched row selected, so its first rows are scrolled away)
      await t.waitFor(/trayA \/ Tools & integrations/, 30_000);
      await t.keys('/');
      const narrow = await t.waitFor(/Search: /, 5000);
      expect(narrow).toContain('find a workspace: Esc, then g, then /');
      expect(narrow).not.toContain('[/] Find a workspace');
      t.capture('wb-finder-80x24-tools-search');
      await t.keys('Escape');
      await t.waitFor(/Tools search cleared\. g, then \/ finds a workspace\./, 5000);
      await t.keys('g');
      await t.find('Templates');
      const there = await t.waitFor(/trayA \/ Templates/, 5000);
      expect(widest(there)).toBeLessThanOrEqual(80);
      await t.keys('C-c');
      await t.waitFor(/EXIT=0\b/, 20_000);
    } finally {
      t.close();
    }
  }, 180_000);
});
