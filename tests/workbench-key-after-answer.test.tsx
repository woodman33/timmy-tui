// R6 (H141; CI at 388c0c8, tests/workbench-pty.test.ts slice B, as at the R4 lead's bfb7fe5 and the R5 lead's 94e0c01,
// 0cbadd0 and aa247e5): an `a` pressed once the NEEDS YOU box had been answered with y and its run had ended was read by the
// Workbench, and Activity did not expand; a second `a` expanded it. Here every `a` from the moment the box is answered is
// taken by Activity and drawn: pressed at once after the y, while the run starts (its prediction sealed, upmd's pty wrapper
// checked), while its job runs, as its record lands and after; and the one `a` slice B presses, once the run has ended and
// Activity says 0 running. Each key's line of the key log (src/workbench/controller.ts keyLog) says what took it. (The box
// was not the cause: the `a` was taken, and collapsed an Activity that opened expanded, remembered so for tray1 by slice A;
// tests/workbench-layout-remembered.test.tsx.) The key log itself is tested at the end.
//
// Drawn by Ink through ink-testing-library at 160x45 over a real Timmy home in a temporary folder: the REPL's own Workspace
// (its /run, job store, operation log and receipts, sealed for real into this test's store) and upmd on a pty through Timmy's
// own wrapper (workers/upmd/pty_run.py, this machine's python3). FAKE or FIXTURE, each labelled where it is made: upmd is
// tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd; the block runs for real through sh), the browser opener, the server
// starts and the producers.
import React from 'react';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import type { ApprovalRequest, Decision } from '../src/repl/approvals.js';
import { realOnPath } from '../src/repl/center.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';
import { WorkbenchApp } from '../src/workbench/app.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor } from '../src/workbench/frame.js';
import type { Producers } from '../src/workbench/producers.js';
import { keyLogTo, watchReads } from '../src/workbench/run.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';

const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
// FIXTURE producers: no run detail and no chat session are needed here
const NO_PRODUCERS: Producers = { runDetail: async () => ({ ok: false, why: 'FIXTURE: none in this test' }), openChat: async () => ({ ok: false, why: 'FIXTURE: none in this test' }) };
const ENTER = '\r';
const DOWN = '\u001b[B';

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-key-answer-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  cleanup();
  for (const c of opened.splice(0)) c.dispose();
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
  vi.unstubAllEnvs();
});

function sandbox(): void {
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('TIMMY_STORE', join(box, 'store'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
}

function trayProject(name: string): { name: string; root: string; chosen: boolean } {
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(made);
  return made;
}

function workbench(project: { name: string; root: string; chosen: boolean }, keys: Array<Record<string, unknown>>): Controller {
  let c: Controller | undefined;
  const env = { ...process.env, UPMD_BIN: FAKE_UPMD };
  const onPath = (cmd: string) => realOnPath(cmd, process.env);
  const ws = new Workspace({
    glyphs: glyphSet(true), env, onPath,
    notify: (l) => c?.say(l.map((s) => s.text).join('').trim()), openWeb: () => '', link: (t) => t,
    seal: (input) => appendReceipt('runs', input).hash.slice(7, 15), receipts: () => readChain('runs'),
    jobsDir, recoverAtStart: false, chdir: () => undefined,
    askPerson: (req: ApprovalRequest): Promise<Decision> => (c ? c.askPerson(req) : Promise.resolve('deny')),
  }, project);
  spaces.push(ws);
  c = new Controller({
    env, jobsDir, onPath, glyphs: glyphsFor(true), workspace: ws, producers: NO_PRODUCERS,
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs: 100, slowMs: 400,
    keyLog: (entry) => { keys.push({ ms: Date.now(), ...entry }); },
  });
  opened.push(c);
  return c;
}

function frameOf(c: Controller, columns: number, rows: number) {
  const app = <WorkbenchApp controller={c} colour={false} size={{ columns, rows }} />;
  const r = render(app);
  Object.defineProperty(r.stdout, 'columns', { configurable: true, get: () => columns });
  Object.defineProperty(r.stdout, 'rows', { configurable: true, get: () => rows });
  r.rerender(app);
  return { r, text: () => r.lastFrame() ?? '' };
}

async function until<T>(what: string, get: () => T | undefined | false | null, ms = 20_000, show?: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${show ? `:\n${show()}` : ''}`);
    await sleep(20);
  }
}

const runsOf = (root: string) => (existsSync(jobsDir) ? readdirSync(jobsDir) : []).filter((n) => n.endsWith('.json'))
  .map((n) => JSON.parse(readFileSync(join(jobsDir, n), 'utf8')) as { id: string; label: string; root: string; state: string })
  .filter((j) => j.root === root && j.label === 'APPROVAL.md › tidy');

/** The Activity strip as the app drew it: ▾ expanded, ▸ collapsed (null: not drawn). */
const drawnOpen = (text: string): boolean | null => (/▾ Activity/.test(text) ? true : /▸ Activity/.test(text) ? false : null);

/** Runs APPROVAL.md › tidy from Workflows up to its NEEDS YOU box, past the box's type-ahead guard. */
async function toTheBox(c: Controller, f: ReturnType<typeof frameOf>): Promise<void> {
  c.start();
  await sleep(150);
  c.selectWorkspace('workflows');
  c.ui.focus = 'center';
  const on = () => { const s = c.selected(); return s?.kind === 'block' && s.doc.rel === 'APPROVAL.md' && s.block.name === 'tidy'; };
  for (let i = 0; i < 20 && !on(); i++) { f.r.stdin.write(DOWN); await sleep(60); }
  expect(on()).toBe(true);
  f.r.stdin.write(ENTER);
  await until('the Run confirm', () => c.ui.overlay?.kind === 'confirm-run', 5_000, f.text);
  f.r.stdin.write(ENTER);
  await until('the NEEDS YOU box', () => c.ui.overlay?.kind === 'needs-you', 10_000, f.text);
  await sleep(400); // past the type-ahead guard
}

const said = (keys: ReadonlyArray<Record<string, unknown>>): string => keys.map((k) => JSON.stringify(k)).join('\n');

describe('a key right after the NEEDS YOU box is answered (R6 H141; CI at 388c0c8, slice B)', () => {
  it('every a from the y on toggles Activity and is drawn: at once after the y, while the run starts and runs, as its record lands, and after', async () => {
    sandbox();
    const p = trayProject('answered-then-a');
    const keys: Array<Record<string, unknown>> = [];
    const c = workbench(p, keys);
    const f = frameOf(c, 160, 45);
    await toTheBox(c, f);
    f.r.stdin.write('y');
    expect(c.ui.overlay).toBe(null);
    let open = c.ui.activityOpen;
    let ended = 0;
    let n = 0;
    // an a every 25 ms (the first at once), until the run has ended and 1.5 s more have passed
    for (const end = Date.now() + 20_000; Date.now() < end && !(ended && Date.now() - ended > 1500); n++) {
      const at = keys.length;
      f.r.stdin.write('a');
      open = !open;
      const mine = keys.slice(at).find((k) => k.input === 'a');
      expect(c.ui.activityOpen, `the a pressed ${n + 1}${n ? '' : ', at once after the y,'} was not taken by Activity:\n${said(keys.slice(-8))}`).toBe(open);
      expect(mine?.took).toBe('the key a');
      await sleep(25);
      if (!ended && runsOf(p.root)[0]?.state === 'completed') ended = Date.now();
    }
    expect(ended, 'the run ended').toBeGreaterThan(0);
    // pressed through the whole run, and drawn as it is now
    expect(n).toBeGreaterThan(20);
    await until('Activity drawn as it is', () => drawnOpen(f.text()) === c.ui.activityOpen, 3_000, f.text);
    // the y answered the box once; no a was ever an answer (each one was Activity's)
    expect(keys.filter((k) => typeof k.took === 'string' && k.took.startsWith('the NEEDS YOU box'))).toEqual([expect.objectContaining({ input: 'y', took: 'the NEEDS YOU box: allowed once' })]);
  }, 60_000);

  it('the a slice B presses: once the run has ended and Activity says 0 running, one a expands Activity, drawn', async () => {
    sandbox();
    const p = trayProject('ended-then-a');
    const keys: Array<Record<string, unknown>> = [];
    const c = workbench(p, keys);
    const f = frameOf(c, 160, 45);
    await toTheBox(c, f);
    f.r.stdin.write('y');
    await until('the run to end', () => runsOf(p.root)[0]?.state === 'completed', 15_000, f.text);
    const [run] = runsOf(p.root);
    await until('its end drawn in Activity', () => new RegExp(`${run.id} completed`).test(f.text()) && /Activity\s+0 running/.test(f.text()), 10_000, f.text);
    expect(drawnOpen(f.text())).toBe(false);
    f.r.stdin.write('a');
    expect(c.ui.activityOpen, said(keys.slice(-6))).toBe(true);
    await until('Activity expanded, drawn', () => /▾ Activity[\s\S]*All operations/.test(f.text()), 3_000, f.text);
    // and it stays expanded while the Workbench reads its records on (its ticks, the frame's reading)
    await sleep(1500);
    expect(c.ui.activityOpen, said(keys.slice(-6))).toBe(true);
    expect(drawnOpen(f.text())).toBe(true);
  }, 60_000);
});

describe('the key log (TIMMY_WORKBENCH_KEYLOG; src/workbench/run.ts and controller.ts)', () => {
  it('one JSON line an entry, with its time, in a file only its owner reads; none without a path', () => {
    expect(keyLogTo(undefined)).toBe(undefined);
    expect(keyLogTo('')).toBe(undefined);
    const file = join(box, 'keys.log');
    const log = keyLogTo(file)!;
    log({ input: 'a', took: 'the key a' });
    log({ read: '\r', raw: true });
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toEqual([expect.objectContaining({ input: 'a', took: 'the key a' }), expect.objectContaining({ read: '\r', raw: true })]);
    for (const l of lines) expect(Date.parse(String(l.at))).toBeGreaterThan(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // a log that cannot be written is no failure of the Workbench's
    expect(() => keyLogTo(join(box, 'no-such-folder', 'keys.log'))!({ input: 'a' })).not.toThrow();
  });

  it('each chunk read from the terminal, as read (by its length only while a field has the keyboard); the reads themselves unchanged', () => {
    // FIXTURE: a stream that hands out what was pushed to it, as a terminal's does
    const queue = ['a', '\u001b[B', 'my message'];
    const stdin = Object.assign(new EventEmitter(), { isRaw: true, read: () => queue.shift() ?? null }) as unknown as NodeJS.ReadStream;
    const seen: Array<Record<string, unknown>> = [];
    let typing = false;
    watchReads(stdin, (e) => seen.push(e), () => typing);
    expect(stdin.read()).toBe('a');
    expect(stdin.read()).toBe('\u001b[B');
    typing = true;
    expect(stdin.read()).toBe('my message');
    expect(stdin.read()).toBe(null);
    expect(seen).toEqual([{ read: 'a', raw: true }, { read: '\u001b[B', raw: true }, { read: '(10 characters, a field has the keyboard)', raw: true }]);
  });

  it('a key typed into a field is said by its length; what took each key is said', () => {
    sandbox();
    const p = trayProject('key-log');
    const keys: Array<Record<string, unknown>> = [];
    const c = workbench(p, keys);
    c.key('/', {});
    c.key('Files', {});
    c.key('', { escape: true });
    c.key('a', {});
    expect(keys.map((k) => [k.input, k.field, k.took])).toEqual([
      ['/', null, 'the key /'],
      ['(5 characters)', 'search', 'the field search'],
      ['', 'search', 'the field search'],
      ['a', null, 'the key a'],
    ]);
    expect(keys.at(-1)).toMatchObject({ activity: false, activityNow: true });
  });
});
