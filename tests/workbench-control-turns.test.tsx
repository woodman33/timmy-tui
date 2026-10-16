// R4 (H117): the terminal Workbench's Control Room lists the project's chat turns, every surface's, from their sealed receipts
// (src/workbench/state.ts readTurns over src/repl/seal.ts chatTurnOf), after its jobs and in the same cursor order; the
// Inspector draws a selected turn as its receipt says it, then its operation's run detail. Drawn by Ink through
// ink-testing-library (180x50) over a real Timmy home in a temporary folder: tray-workflow projects made by the starter code,
// the REPL's own Workspace and Timmy's job store, and turn receipts sealed for real (signed and chained) by sealTurn into the
// project's own store, pinned in its folder, as tests/chat-one-conversation.test.ts's replTurn seals them. The Workbench reads
// that store as `timmy workbench` does when TIMMY_STORE is not set (its env here has none).
//
// FAKE or FIXTURE here, each labelled where it is made:
// - the turns' facts are FIXTURE: no model answered them; their message and answer are this test's words, sealed as hashes;
// - the job in Recent is a FAKE job (test) that runs `true`, started through Timmy's own job store;
// - the run detail's producer is a FIXTURE (as tests/workbench-operation.test.tsx's): it returns a RunDetail in the contract's
//   shape whose words say FIXTURE; the chat session's producer is a FIXTURE that has none;
// - the tools rows, the browser opener and the server starts (nothing here presses Show).
import React from 'react';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { projectStore } from '../src/agent/chat-session.js';
import { RUN_DETAIL_VERSION, type RunDetail } from '../src/contracts/run-detail.js';
import { JobManager } from '../src/jobs/index.js';
import { inOperationId } from '../src/ops/context.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import type { ApprovalRequest, Decision } from '../src/repl/approvals.js';
import { sealTurn, type TurnFacts } from '../src/repl/seal.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';
import { WorkbenchApp } from '../src/workbench/app.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor } from '../src/workbench/frame.js';
import type { Producers } from '../src/workbench/producers.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import { readTurns } from '../src/workbench/state.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-turns-'));
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

/** The project's store, pinned in its folder (src/utils/receipts.ts rootStoreDir): `to`, else its own .timmy/receipts. */
function pinStore(root: string, to = join(root, '.timmy', 'receipts')): void {
  mkdirSync(join(root, '.timmy'), { recursive: true });
  writeFileSync(join(root, '.timmy', 'store-pin'), to);
}

// FIXTURE: a run detail in the contract's shape, made by this test (not by src/ops/run-detail.ts)
function fixtureDetail(operation: string, root: string): RunDetail {
  return {
    version: RUN_DETAIL_VERSION, operation, parent: null, children: [], project: { name: 'fixture', root, id: projectId(root) },
    objective: { value: 'FIXTURE objective of the run', from: 'FIXTURE' }, sourceRevision: null,
    verdict: { state: 'completed', words: 'FIXTURE verdict words', from: 'FIXTURE' },
    stage: { current: null, done: 1, total: 1, from: 'FIXTURE' }, exits: [],
    freshness: { state: 'unknown', why: 'FIXTURE: not checked' }, acceptance: { state: 'not reviewed' }, worker: {},
    time: { startedAt: null, endedAt: null, elapsedMs: null }, prediction: null, checks: [], files: [], receipts: [],
    cost: { usd: null, measured: false, why: 'FIXTURE: no request went out' }, summary: { path: null }, next: null, unknown: [],
  };
}

const NO_CHAT: Producers['openChat'] = async () => ({ ok: false, why: 'FIXTURE: no chat session in this test' });

function workbench(project: { name: string; root: string; chosen: boolean }, producers: Producers): { c: Controller; ws: Workspace } {
  let c: Controller | undefined;
  // as `timmy workbench` runs with no TIMMY_STORE: the project's own store is the chain it reads
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TIMMY_STORE;
  const ws = new Workspace({
    glyphs: glyphSet(true), env, onPath: () => null,
    notify: (l) => c?.say(l.map((s) => s.text).join('').trim()), openWeb: () => '', link: (t) => t,
    seal: (input) => appendReceipt('runs', input).hash.slice(7, 15), receipts: () => readChain('runs'),
    jobsDir, recoverAtStart: false, chdir: () => undefined,
    askPerson: (req: ApprovalRequest): Promise<Decision> => (c ? c.askPerson(req) : Promise.resolve('deny')),
  }, project);
  spaces.push(ws);
  c = new Controller({
    env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws, producers,
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs: 100, slowMs: 400,
  });
  opened.push(c);
  return { c, ws };
}

function frameOf(c: Controller, columns: number, rows: number) {
  const app = <WorkbenchApp controller={c} colour={false} size={{ columns, rows }} />;
  const r = render(app);
  // ink-testing-library's terminal is always 100 columns wide: give it this frame's size, and Ink lays out again at it
  Object.defineProperty(r.stdout, 'columns', { configurable: true, get: () => columns });
  Object.defineProperty(r.stdout, 'rows', { configurable: true, get: () => rows });
  r.rerender(app);
  return { r, text: () => r.lastFrame() ?? '', lines: () => (r.lastFrame() ?? '').split('\n') };
}

async function press(r: ReturnType<typeof render>, ...keys: string[]): Promise<void> {
  for (const k of keys) { r.stdin.write(k); await sleep(60); }
  await sleep(80);
}

async function until<T>(what: string, get: () => T | undefined | false | null, ms = 10_000, show?: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${show ? `:\n${show()}` : ''}`);
    await sleep(50);
  }
}

const ENTER = '\r';
const DOWN = '\u001b[B';

/** One region's words, its wrapped rows joined (the frame the app draws, read by cell). */
function regionText(c: Controller, region: 'center' | 'right' | 'bottom' | 'top', columns = 180, rows = 50): string {
  const fr = c.frame(columns, rows);
  const rect = fr.regions[region]?.rect;
  if (!rect) return '';
  const out: string[] = [];
  // R5 (H131): row 2 draws the run state and Stop current in its bottom edge, so the top region is read to that edge
  const last = region === 'top' ? rect.y + rect.h - 1 : rect.y + rect.h - 2;
  for (let y = rect.y + 1; y <= last; y++) {
    let x = 0;
    let row = '';
    for (const seg of fr.screen[y] ?? []) for (const ch of seg.text) { if (x > rect.x && x < rect.x + rect.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(y === rect.y + rect.h - 1 ? row.replace(/[─━]/g, ' ') : row);
  }
  return out.join(' ').replace(/\s+/g, ' ');
}

/** The Control Room, found as a person finds a workspace: /, its name, Enter. */
async function toControlRoom(c: Controller, f: ReturnType<typeof frameOf>): Promise<void> {
  await press(f.r, '/', ...'Control', ENTER);
  expect(c.ui.workspace).toBe('control');
  expect(c.ui.focus).toBe('center');
}

// FIXTURE facts of one turn: no model answered it; its message and answer are these words, which only their hashes leave
const PROMPT = 'FIXTURE prompt words, never shown';
const ANSWER = 'FIXTURE answer words, never shown';
function facts(o: { root: string; name: string; surface: 'repl' | 'workbench' | 'companion'; model: string; ms: number; status?: TurnFacts['status']; route?: TurnFacts['route'] }): TurnFacts & { model: string } {
  return {
    prompt: PROMPT, answer: o.status === 'cancelled' ? '' : ANSWER, steps: 0, spend: 0, costMeasured: false, ms: o.ms, status: o.status ?? 'ok',
    surface: o.surface, model: o.model, project: o.name, projectId: projectId(o.root),
    ...(o.status === 'cancelled' ? { cancelledAt: 'before-tools' as const } : {}), ...(o.route ? { route: o.route } : {}),
  };
}

/** A turn sealed as every surface's is (src/repl/seal.ts sealTurn), into the store of the project at `store` (projectStore, as
 *  tests/chat-one-conversation.test.ts's replTurn seals), within `operation` when one is given (the request's scope stamps it
 *  on the receipt); its receipt's short id. */
function seal(f: TurnFacts & { model: string }, store: string, operation?: string): string {
  const once = () => sealTurn(f, projectStore(store));
  const s = operation ? inOperationId(operation, once) : once();
  expect(s.verified).toBe(true);
  return s.id;
}

const OP_WB = 'o0e117a01';
const OP_STOP = 'o0e117a02';
const OP_ELSE = 'o0e117a03';
const OP_LATER = 'o0e117a04';

/** R5 (H137): one column of the Control Room's body (0 the roster, 1 the panes, 2 the right column), its wrapped rows joined.
 *  The columns are split at their rules: the cells holding the rule glyph on every row that has one (a pane's box edge is not
 *  on its column's heading row), so the split holds at any width. */
function columnText(c: Controller, k: number, columns = 180, rows = 50): string {
  const fr = c.frame(columns, rows);
  const rect = fr.regions.center?.rect;
  if (!rect) return '';
  const grid: string[][] = [];
  for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
    const cells: string[] = [];
    let x = 0;
    for (const seg of fr.screen[y] ?? []) for (const ch of seg.text) {
      const n = visibleWidth(ch);
      if (x > rect.x && x < rect.x + rect.w - 1) cells.push(ch, ...Array<string>(Math.max(0, n - 1)).fill(''));
      x += n;
    }
    grid.push(cells);
  }
  const ruled = grid.filter((r) => r.includes('│'));
  const rules = ruled.length ? [...ruled[0].keys()].filter((x) => ruled.every((r) => r[x] === '│')) : [];
  const edges = [-1, ...rules, Number.POSITIVE_INFINITY];
  return grid.map((r) => r.slice(edges[k] + 1, edges[k + 1]).join('')).join(' ').replace(/\s+/g, ' ');
}

/** A row's pieces in this order, as its column draws them: ` · ` between two on one row, a space where the row wraps. */
const inRow = (...pieces: string[]): RegExp => new RegExp(pieces.join('(?: · | )'));

describe('the terminal Workbench\'s Control Room lists every surface\'s chat turns (R4 H117)', () => {
  it('after its jobs: three turns of the project, newest first, each from its surface (a stopped one says stopped); another project\'s turn is not there; the Inspector draws a selected turn and its operation\'s run detail (FIXTURE producer); a turn sealed while it is open is listed at the next reading', async () => {
    sandbox();
    const p = trayProject('turns-a');
    pinStore(p.root);
    const elsewhere = createProject('turns-elsewhere');
    if ('error' in elsewhere) throw new Error(elsewhere.error);
    // FAKE job (test): Recent has one job, as after the lead's rehearsal (f22e044), so the turns come after it
    const jobs = new JobManager({ dir: jobsDir });
    const job = jobs.start({ kind: 'task', label: 'FAKE job (test): true', project: p.name, root: p.root, command: 'true', args: [] });
    await jobs.done(job.id);
    // the turns, oldest first: the REPL's (sealed outside any operation), a Workbench turn that was stopped, another project's
    // turn in the same chain, and a Workbench turn on the local route (Ollama on this computer, as its receipt names it)
    const repl = seal(facts({ root: p.root, name: p.name, surface: 'repl', model: 'fixture/chat-model', ms: 2400 }), p.root);
    const stopped = seal(facts({ root: p.root, name: p.name, surface: 'workbench', model: 'qwen3:8b', ms: 800, status: 'cancelled' }), p.root, OP_STOP);
    const other = seal(facts({ root: elsewhere.root, name: elsewhere.name, surface: 'workbench', model: 'qwen3:8b', ms: 500 }), p.root, OP_ELSE);
    const wb = seal(facts({
      root: p.root, name: p.name, surface: 'workbench', model: 'qwen3:8b', ms: 1200,
      route: { host: 'http://127.0.0.1:11434', endpoint: 'local', tools: 'on', modelResolved: 'qwen3:8b-fixture', costBasis: 'local endpoint' },
    }), p.root, OP_WB);
    // all four are in the one chain the Workbench reads (the project's pinned store), the other project's among them
    const chain = readChain('runs', p.root);
    expect(chain.map((r) => r.hash.slice(7, 15))).toEqual([repl, stopped, other, wb]);
    expect(chain.map((r) => r.operation_id ?? null)).toEqual([null, OP_STOP, OP_ELSE, OP_WB]);

    const details: string[] = [];
    const { c } = workbench(p, {
      // FIXTURE: the run detail's producer
      runDetail: async () => ({ ok: true, value: (op: string, o: { root: string }) => { details.push(op); return fixtureDetail(op, o.root); } }),
      openChat: NO_CHAT,
    });
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    await until('the Recent job', () => c.data.jobs.some((j) => j.id === job.id), 5000, f.text);
    await toControlRoom(c, f);

    // the rows as read: the project's three, the newest first, never the other project's
    expect(c.data.turns).toEqual([
      { receipt: wb, surface: 'workbench', state: 'answered', model: 'qwen3:8b-fixture', at: chain[3].ts, ms: 1200, operation: OP_WB, local: true },
      { receipt: stopped, surface: 'workbench', state: 'stopped', model: 'qwen3:8b', at: chain[1].ts, ms: 800, operation: OP_STOP },
      { receipt: repl, surface: 'repl', state: 'answered', model: 'fixture/chat-model', at: chain[0].ts, ms: 2400, operation: null },
    ]);
    const room = regionText(c, 'center');
    expect(room).toContain('RECENT (1)');
    expect(room).toContain('CHAT TURNS (3)');
    expect(room.indexOf(job.id)).toBeLessThan(room.indexOf('CHAT TURNS (3)'));
    expect(columnText(c, 2)).toMatch(inRow(`✓ ${wb}`, 'answered', 'from the Workbench', 'qwen3:8b-fixture', '1\\.2 s', OP_WB, '\\d+ s ago'));
    expect(columnText(c, 2)).toMatch(inRow(`■ ${stopped}`, 'stopped by you', 'from the Workbench', 'qwen3:8b', '0\\.8 s', OP_STOP, '\\d+ s ago')); // R6 (H140): who asked, always said (the Workbench: by you)
    expect(columnText(c, 2)).toMatch(inRow(`✓ ${repl}`, 'answered', 'from the REPL', 'fixture/chat-model', '2\\.4 s', 'no operation', '\\d+ s ago'));
    expect(room.indexOf(wb)).toBeLessThan(room.indexOf(stopped));
    expect(room.indexOf(stopped)).toBeLessThan(room.indexOf(repl));
    expect(columnText(c, 2)).toContain('A turn being answered now is on the surface that sent it, where Esc (the Workbench) or Ctrl+C (the REPL) stops it.');
    // another project's turn, though in the same chain, is not this project's: absent everywhere
    expect(f.text()).not.toContain(other);
    expect(f.text()).not.toContain(OP_ELSE);
    // a receipt holds hashes only: no word of a message or an answer is drawn
    expect(f.text()).not.toContain('prompt words');
    expect(f.text()).not.toContain('answer words');
    expect(f.lines().every((l) => visibleWidth(l) === 180)).toBe(true);

    // the cursor starts on the Recent job; Down moves it to the first turn row (the turns follow the jobs)
    expect(c.selected()).toMatchObject({ kind: 'job', job: { id: job.id } });
    await press(f.r, DOWN);
    expect(c.selected()).toMatchObject({ kind: 'turn', turn: { receipt: wb } });
    expect(columnText(c, 2)).toMatch(new RegExp(`▸ ✓ ${wb} answered from the Workbench`));
    // R5 (H137): tab 7 draws its own columns, so its Inspector is Context's drawer: i opens it, and i again closes it
    await press(f.r, 'i');
    await until('the turn\'s run detail', () => regionText(c, 'right').includes(`RUN DETAIL · ${OP_WB}`), 5000, f.text);
    const inspector = regionText(c, 'right');
    expect(inspector).toContain('CHAT TURN');
    for (const w of [`Receipt ${wb}`, 'From the Workbench', 'Ended answered', 'Model qwen3:8b-fixture', 'Route local endpoint, no charge: Ollama on this computer', 'Took 1.2 s', `Operation ${OP_WB}`, 'Its receipt keeps the message and the answer as hashes, never their words.', 'Objective FIXTURE objective of the run', 'Verdict completed · FIXTURE verdict words']) expect(inspector).toContain(w);
    expect(inspector).toMatch(/When \d\d:\d\d:\d\d \(\d+ s ago\)/);
    expect(details).toContain(OP_WB);
    await press(f.r, 'i');

    // Down again: the stopped turn, its own operation's run detail
    await press(f.r, DOWN);
    expect(c.selected()).toMatchObject({ kind: 'turn', turn: { receipt: stopped } });
    await press(f.r, 'i');
    await until('the stopped turn\'s run detail', () => regionText(c, 'right').includes(`RUN DETAIL · ${OP_STOP}`), 5000, f.text);
    for (const w of [`Receipt ${stopped}`, 'Ended stopped', 'Model qwen3:8b', 'Route not recorded on its receipt (it names the model, not the endpoint that answered)', `Operation ${OP_STOP}`]) expect(regionText(c, 'right')).toContain(w);
    await press(f.r, 'i');
    // and the REPL's turn, which names no operation
    await press(f.r, DOWN);
    expect(c.selected()).toMatchObject({ kind: 'turn', turn: { receipt: repl } });
    await press(f.r, 'i');
    for (const w of [`Receipt ${repl}`, 'From the REPL', 'Model fixture/chat-model', 'Operation none recorded', 'Run detail: this turn names no operation.']) expect(regionText(c, 'right')).toContain(w);
    expect(details).toEqual([OP_WB, OP_STOP]);
    await press(f.r, 'i');

    // a turn sealed while the Workbench is open (here a companion page's, through an Ollama its receipt names off this computer:
    // FIXTURE host 192.0.2.10, a documentation address no computer has) is listed at the next reading; the selection stays on
    // the turn the person chose
    const later = seal(facts({
      root: p.root, name: p.name, surface: 'companion', model: 'fixture/chat-model', ms: 300,
      route: { host: 'http://192.0.2.10:11434', endpoint: 'remote', tools: 'off', modelResolved: 'fixture/remote-model', costBasis: 'unknown' },
    }), p.root, OP_LATER);
    await until('the fourth turn', () => regionText(c, 'center').includes('CHAT TURNS (4)'), 5000, f.text);
    expect(columnText(c, 2)).toMatch(inRow(`✓ ${later}`, 'answered', 'from a companion page', 'fixture/remote-model', '0\\.3 s', OP_LATER));
    expect(c.selected()).toMatchObject({ kind: 'turn', turn: { receipt: repl } });
    await press(f.r, 'i');
    expect(regionText(c, 'right')).toContain(`Receipt ${repl}`);
    await press(f.r, 'i');
    // up to it (the newest turn, first under Recent): its route is the Ollama its receipt names, off this computer
    await press(f.r, '\u001b[A', '\u001b[A', '\u001b[A');
    expect(c.selected()).toMatchObject({ kind: 'turn', turn: { receipt: later, surface: 'companion', local: false } });
    await press(f.r, 'i');
    for (const w of [`Receipt ${later}`, 'From a companion page', 'Model fixture/remote-model', 'Route Ollama, which sent it off this computer (another computer, or a cloud-backed model): no cost comes back', `Operation ${OP_LATER}`]) expect(regionText(c, 'right')).toContain(w);
    expect(f.text()).not.toContain('192.0.2.10');
  }, 30_000);

  it('more turns than it lists: the newest eight, newest first, and it says so; the same receipt read twice is one turn', async () => {
    sandbox();
    const b = trayProject('turns-many');
    pinStore(b.root);
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push(seal(facts({ root: b.root, name: b.name, surface: i % 2 ? 'workbench' : 'repl', model: 'fixture/chat-model', ms: 100 + i }), b.root));
    const chain = readChain('runs', b.root);
    const newest = ids.slice(1).reverse();
    expect(readTurns(chain, b.root).map((t) => t.receipt)).toEqual(newest);
    // the same receipt read twice is one turn
    expect(readTurns([...chain, ...chain], b.root).map((t) => t.receipt)).toEqual(newest);

    const { c } = workbench(b, { runDetail: async () => ({ ok: false, why: 'FIXTURE: none in this test' }), openChat: NO_CHAT });
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    await toControlRoom(c, f);
    const room = regionText(c, 'center');
    expect(room).toContain('CHAT TURNS (8)');
    expect(room).toContain('The newest 8 are listed.');
    for (const id of newest) expect(room).toContain(id);
    expect(f.text()).not.toContain(ids[0]);
  }, 30_000);

  it('an empty project says no chat turn of it is sealed yet, though its chain holds another project\'s turn', async () => {
    sandbox();
    const b = trayProject('turns-b');
    pinStore(b.root);
    const theirs = seal(facts({ root: b.root, name: b.name, surface: 'repl', model: 'fixture/chat-model', ms: 900 }), b.root, OP_WB);
    // the empty project's store is pinned to the same receipts: its chain holds turns-b's turn, none of its own
    const empty = trayProject('turns-empty');
    pinStore(empty.root, join(b.root, '.timmy', 'receipts'));
    const chain = readChain('runs', empty.root);
    expect(chain.map((r) => r.hash.slice(7, 15))).toEqual([theirs]);
    expect(readTurns(chain, empty.root)).toEqual([]);

    const { c } = workbench(empty, { runDetail: async () => ({ ok: false, why: 'FIXTURE: none in this test' }), openChat: NO_CHAT });
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    await toControlRoom(c, f);
    const room = regionText(c, 'center');
    expect(room).toContain('CHAT TURNS (0)');
    expect(columnText(c, 2)).toContain('No chat turn of this project is sealed yet: a turn is listed once its receipt is sealed, from whichever surface sent it (the REPL, the Workbench, the monitor, a companion page).');
    expect(columnText(c, 2)).toContain('A turn being answered now is on the surface that sent it, where Esc (the Workbench) or Ctrl+C (the REPL) stops it.');
    expect(f.text()).not.toContain(theirs);
    expect(c.data.turns).toEqual([]);
  }, 30_000);
});
