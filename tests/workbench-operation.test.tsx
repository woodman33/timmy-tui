// R4 (H110), slice B: one connected operation from the terminal Workbench, drawn by Ink through ink-testing-library (180x50)
// over a real Timmy home in a temporary folder: a tray-workflow project made by the starter code, the REPL's own Workspace
// (its /run, its NEEDS YOU gate, its job store and its receipt chain, sealed for real into this test's store), the operation
// log, and Studio's project cards read from the same records.
//
// FAKE or FIXTURE here, each labelled where it is made:
// - upmd is tests/fixtures/fake-upmd.mjs, a TEST DOUBLE of upmd 0.2.7's --ci behaviour (each block runs for real through sh);
// - the person at the NEEDS YOU box is this test's key presses (the box itself is the Workbench's);
// - the run detail's producer is a FIXTURE (src/ops/run-detail.ts, H102's, is not in this revision): it returns a RunDetail
//   in the contract's shape whose words say FIXTURE;
// - the chat session's producer is a FIXTURE (src/agent/chat-session.ts, H103's, is not in this revision): it answers
//   without any model, and says so;
// - the tools rows, the browser opener and the server starts (nothing here presses Show).
import React from 'react';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { ChatSession, ChatTurnHooks, OpenChatSession } from '../src/contracts/chat-session.js';
import { RUN_DETAIL_VERSION, type RunDetail } from '../src/contracts/run-detail.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import type { ApprovalRequest, Decision } from '../src/repl/approvals.js';
import { Workspace } from '../src/repl/workspace.js';
import { projectCards } from '../src/studio/project-cards.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { appendReceipt, readChain, type Receipt } from '../src/utils/receipts.js';
import { WorkbenchApp } from '../src/workbench/app.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor } from '../src/workbench/frame.js';
import { realProducers, type Producers } from '../src/workbench/producers.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';

const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const COMMAND = 'mkdir -p scratch && touch scratch/x && rm scratch/x';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-op-'));
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

// FIXTURE: a run detail in the contract's shape, made by this test (not by src/ops/run-detail.ts)
function fixtureDetail(operation: string, root: string): RunDetail {
  return {
    version: RUN_DETAIL_VERSION, operation, parent: null, children: [], project: { name: 'fixture', root, id: projectId(root) },
    objective: { value: 'FIXTURE objective of the run', from: 'FIXTURE' }, sourceRevision: null,
    verdict: { state: 'completed', words: 'FIXTURE verdict words', from: 'FIXTURE' },
    stage: { current: 'tidy', done: 1, total: 1, from: 'FIXTURE' }, exits: [{ who: 'upmd (FIXTURE)', code: 0, from: 'FIXTURE' }],
    freshness: { state: 'unknown', why: 'FIXTURE: not checked' }, acceptance: { state: 'not reviewed' }, worker: {},
    time: { startedAt: null, endedAt: null, elapsedMs: null }, prediction: null, checks: [], files: [], receipts: [],
    cost: { usd: null, measured: false, why: 'FIXTURE: no request went out' }, summary: { path: null }, next: null, unknown: [],
  };
}

function workbench(project: { name: string; root: string; chosen: boolean }, producers: Producers): { c: Controller; ws: Workspace } {
  let c: Controller | undefined;
  const env = { ...process.env, UPMD_BIN: FAKE_UPMD };
  const ws = new Workspace({
    glyphs: glyphSet(true), env, onPath: () => null,
    notify: (l) => c?.say(l.map((s) => s.text).join('').trim()), openWeb: () => '', link: (t) => t,
    seal: (input) => appendReceipt('runs', input).hash.slice(7, 15), receipts: () => readChain('runs'),
    jobsDir, recoverAtStart: false, chdir: () => undefined,
    // the Workbench's own NEEDS YOU box
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

async function until<T>(what: string, get: () => T | undefined | false | null, ms = 30_000, show?: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${show ? `:\n${show()}` : ''}`);
    await sleep(50);
  }
}

const TAB = '\t';
const ENTER = '\r';
const NO_CHAT: Producers['openChat'] = async () => ({ ok: false, why: 'FIXTURE: no chat session in this test' });
/** One region's words, its wrapped rows joined (the frame the app draws, read by cell). */
function regionText(c: Controller, region: 'center' | 'right' | 'bottom' | 'top', columns = 180, rows = 50): string {
  const fr = c.frame(columns, rows);
  const rect = fr.regions[region]?.rect;
  if (!rect) return '';
  const out: string[] = [];
  for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
    let x = 0;
    let row = '';
    for (const seg of fr.screen[y] ?? []) for (const ch of seg.text) { if (x > rect.x && x < rect.x + rect.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(row);
  }
  return out.join(' ').replace(/\s+/g, ' ');
}

describe('the terminal Workbench, slice B: one connected operation (R4 H110)', () => {
  it('runs APPROVAL.md › tidy from Workflows: a confirm, the NEEDS YOU box drawn here (y allows once), progress in Activity, one job and one operation in Control Room, the Inspector\'s run detail (FIXTURE producer), the same operation on Studio\'s cards', async () => {
    sandbox();
    const p = trayProject('tray-run');
    const details: string[] = [];
    const { c, ws } = workbench(p, {
      // FIXTURE: the run detail's producer
      runDetail: async () => ({ ok: true, value: (op: string, o: { root: string }) => { details.push(op); return fixtureDetail(op, o.root); } }),
      openChat: NO_CHAT,
    });
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    // R5 (H131): 3 opens the Workflows tab; the center has APPROVAL.md's tidy selected first; Enter asks before it runs
    await press(f.r, '3', TAB);
    expect(f.text()).toMatch(/▸\s+1\s+tidy/);
    expect(f.text()).toContain('[Enter] Run it here, through the REPL\'s own /run (one job, one operation)');
    await press(f.r, ENTER);
    expect(f.text()).toContain('Run APPROVAL.md › tidy?');
    expect(f.text()).toMatch(/Needs you\s+tidy: a destructive command; its NEEDS YOU box asks first/);
    expect(ws.jobs.list().filter((j) => j.root === p.root)).toEqual([]);
    // Enter: the REPL's own /run; its NEEDS YOU box is the Workbench's, and nothing runs while it waits
    await press(f.r, ENTER);
    const box = await until('the NEEDS YOU box', () => /⚠ NEEDS YOU/.test(f.text()) && f.text(), 10_000, f.text);
    expect(box).toContain('/run APPROVAL.md tidy');
    expect(box).toContain('runs a destructive shell command on this machine: tidy');
    expect(box).toContain(COMMAND);
    expect(box).toContain('[y] allow once');
    expect(box).not.toContain('allow for this session'); // a shell command is asked about every time
    expect(box).toContain('[n] / Esc / Enter deny (the default)');
    expect(f.lines().every((l) => visibleWidth(l) === 180)).toBe(true);
    // what waits on you shows beside the Control Room's tab and Home's (R5, H131: the workspace frame's counts, read again
    // within a second of the box)
    await until('the waiting counts on the tabs', () => /7 Control(?: Room)? ⚠1/.test(f.text()) && /1 Home ⚠1/.test(f.text()), 5000, f.text);
    expect(ws.jobs.list().filter((j) => j.root === p.root)).toEqual([]);
    expect(existsSync(join(p.root, 'scratch'))).toBe(false);
    // Follow selected artifact (Quick settings): the run, once it starts, is what the Inspector and Activity show
    c.ui.settings.settings.followSelectedArtifact = true;
    // past the box's type-ahead guard, y allows it once
    await sleep(400);
    await press(f.r, 'y');
    const job = await until('the run\'s job', () => ws.jobs.list().find((j) => j.label === 'APPROVAL.md › tidy'), 10_000, f.text);
    await until('the Inspector to follow the run', () => regionText(c, 'right').includes(`Job ${job.id}`), 5000, f.text);
    expect(c.ui.workspace).toBe('workflows'); // the workspace never changes by itself
    expect((await ws.jobs.done(job.id)).state).toBe('completed');
    const op = job.operation!;
    expect(op).toMatch(/^o[0-9a-f]{8}$/);
    await until('the operation to end', () => { try { return JSON.parse(readFileSync(join(p.root, '.timmy', 'operations', `${op}.json`), 'utf8')).ended; } catch { return null; } }, 10_000);
    await sleep(300);

    // one job, one operation, one prediction, one block receipt and one workflow receipt: no second execution
    expect(ws.jobs.list().filter((j) => j.root === p.root)).toHaveLength(1);
    const records = readdirSync(jobsDir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(jobsDir, n), 'utf8')) as { root: string; operation?: string });
    expect(records.filter((r) => r.root === p.root).map((r) => r.operation)).toEqual([op]);
    const chain: Receipt[] = readChain('runs');
    expect(chain.map((r) => r.kind)).toEqual(['predict', 'workflow-block', 'workflow']);
    expect(chain.filter((r) => r.kind === 'workflow' && r.operation_id === op)).toHaveLength(1);
    expect(new Set(chain.map((r) => r.operation_id))).toEqual(new Set([op]));
    expect(chain[0]).toMatchObject({ decisions: [{ decision: 'allow once', tier: 'NEEDS YOU (the person, in its box)' }] });
    const record = JSON.parse(readFileSync(join(p.root, '.timmy', 'operations', `${op}.json`), 'utf8'));
    expect(record).toMatchObject({ id: op, request: '/run APPROVAL.md tidy', via: 'workbench', state: 'succeeded', runs: [{ kind: 'job', id: job.id }] });
    // the block ran once: it made scratch/x and deleted it
    expect(readdirSync(join(p.root, 'scratch'))).toEqual([]);

    // Activity: the run's progress as it went (the REPL's own lines and the job record's), newest first
    await press(f.r, 'a');
    const activity = regionText(c, 'bottom');
    expect(activity).toMatch(new RegExp(`✓ ${job.id} completed operation ${op} · APPROVAL\\.md › tidy · 1 of 1 steps`));
    expect(activity).toMatch(new RegExp(`● ${job.id} tidy completed · 1 of 1 · block tidy: receipt [0-9a-f]{8}`));
    expect(activity).toContain(`Operation ${op} /op ${op} shows the request, its blocks and what they made`);
    const events = c.data.activity.events.map((e) => e.words);
    for (const w of [`${job.id} started: APPROVAL.md › tidy`, 'NEEDS YOU: allowed /run APPROVAL.md tidy once', `/run APPROVAL.md tidy: operation ${op}, through the REPL's own /run; its NEEDS YOU box asks first…`]) expect(events).toContain(w);
    await press(f.r, 'a');

    // Control Room: the same job and operation; the Inspector draws the operation's run detail (FIXTURE producer)
    c.selectWorkspace('control');
    await sleep(200);
    // Activity for the selected operation only, then all operations again (A)
    await press(f.r, 'a');
    const mine = regionText(c, 'bottom');
    expect(mine).toContain(`Operation ${op} [A] all operations`);
    expect(mine).toContain(`Operation ${op} /op ${op} shows the request`);
    // the box's answer is the operation's too (older than the rows shown: read from the events)
    expect(c.data.activity.events.filter((e) => e.operation === op).map((e) => e.words)).toContain('NEEDS YOU: allowed /run APPROVAL.md tidy once');
    await press(f.r, 'A');
    expect(regionText(c, 'bottom')).toContain(`All operations [A] only ${op}`);
    await press(f.r, 'A', 'a');
    const room = f.text();
    expect(room).toMatch(new RegExp(`${job.id}\\s+completed\\s+APPROVAL\\.md › tidy[^\\n]*${op}[^\\n]*this Workbench`));
    await until('the run detail', () => /RUN DETAIL · o[0-9a-f]{8}/.test(f.text()), 5000, f.text);
    const inspector = regionText(c, 'right');
    expect(inspector).toContain(`RUN DETAIL · ${op}`);
    expect(inspector).toContain('Objective FIXTURE objective of the run');
    expect(inspector).toContain('Verdict completed · FIXTURE verdict words');
    expect(inspector).toContain('Cost unknown: FIXTURE: no request went out');
    expect(details).toContain(op);

    // Studio's cards name the same operation, read from the same records
    const cards = projectCards({ root: p.root, name: p.name, jobs: jobsDir, receipts: null }, { chain, jobs: ws.jobs.list() });
    expect(cards.operations?.map((o) => o.id)).toContain(op);
    expect(cards.operations?.find((o) => o.id === op)).toMatchObject({ request: '/run APPROVAL.md tidy', via: 'workbench', state: 'succeeded' });
  }, 60_000);

  it('deny is the default: Enter at the NEEDS YOU box denies; nothing runs and nothing is sealed', async () => {
    sandbox();
    const p = trayProject('tray-deny');
    const { c, ws } = workbench(p, { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: NO_CHAT });
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    await press(f.r, '3', TAB, ENTER, ENTER);
    await until('the NEEDS YOU box', () => /⚠ NEEDS YOU/.test(f.text()), 10_000, f.text);
    await sleep(400);
    await press(f.r, ENTER);
    await until('the denial', () => /Not run: you denied it in its NEEDS YOU box\. Nothing ran, and nothing was sealed\./.test(f.text()), 10_000, f.text);
    expect(f.text()).not.toContain('⚠ NEEDS YOU');
    expect(ws.jobs.list().filter((j) => j.root === p.root)).toEqual([]);
    expect(readChain('runs')).toEqual([]);
    expect(existsSync(join(p.root, 'scratch'))).toBe(false);
  }, 30_000);

  it('the NEEDS YOU box ignores keys in its first 300 ms (type-ahead), and Ctrl+C denies it without quitting', async () => {
    sandbox();
    const p = trayProject('tray-guard');
    const { c } = workbench(p, { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: NO_CHAT });
    // FAKE request, in the gate's shape
    const req: ApprovalRequest = { tool: 'FAKE tool (test)', reason: 'FAKE: asks a person', summary: 'FAKE summary', session: false };
    const first = c.askPerson(req);
    c.key('y', {}); // at once: type-ahead, not an answer
    expect(c.ui.overlay?.kind).toBe('needs-you');
    await sleep(350);
    c.key('a', {}); // not offered (session: false): not an answer
    expect(c.ui.overlay?.kind).toBe('needs-you');
    c.key('y', {});
    expect(await first).toBe('once');
    expect(c.ui.overlay).toBe(null);
    // Ctrl+C at the box denies it, and the Workbench stays
    let quit = false;
    const second = c.askPerson(req);
    (c as unknown as { d: { onExit?: () => void } }).d.onExit = () => { quit = true; };
    c.key('c', { ctrl: true });
    expect(await second).toBe('deny');
    expect(quit).toBe(false);
    // a paste is never an answer: it denies
    const third = c.askPerson(req);
    await sleep(350);
    c.key('yes', {});
    expect(await third).toBe('deny');
  });

  it('the composer sends through the chat session (FIXTURE producer): the answer streams, a tool\'s NEEDS YOU box is the Workbench\'s, the receipt and whether anything was sent are said', async () => {
    sandbox();
    const p = trayProject('tray-chat');
    const sent: string[] = [];
    const keys: string[] = [];
    // FIXTURE: a chat session in the contract's shape; it answers without any model and says so
    const openChat: OpenChatSession = async (o) => {
      expect(o).toMatchObject({ project: { name: 'tray-chat', root: p.root }, surface: 'workbench' });
      const session: ChatSession = {
        route: () => ({ kind: 'local', words: 'chat: FIXTURE route', ready: true }),
        // R4 lead: the composer sends once (the contract's sendOnce), its key the message's operation's
        sendOnce: async (key: string, text: string, hooks: ChatTurnHooks) => { keys.push(key); return session.send(text, hooks); },
        send: async (text: string, hooks: ChatTurnHooks) => {
          sent.push(text);
          hooks.onText('Hello');
          await sleep(150);
          const d = await hooks.askPerson({ tool: 'write_project_file', reason: 'FIXTURE: changes a file in your project', summary: 'notes.md', session: false });
          hooks.onText(`Hello from the FIXTURE session; the tool was ${d === 'deny' ? 'denied' : 'allowed'}.`);
          return { status: 'answered', text: `Hello from the FIXTURE session; the tool was ${d === 'deny' ? 'denied' : 'allowed'}.`, sent: false, receipt: 'fixture1', costWords: 'no charge (FIXTURE: no model)' };
        },
      };
      return session;
    };
    const { c } = workbench(p, { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: async () => ({ ok: true, value: openChat }) });
    c.start();
    c.selectWorkspace('chat');
    const f = frameOf(c, 180, 50);
    await until('the session', () => /chat: FIXTURE route/.test(f.text()), 5000, f.text);
    expect(f.text()).toContain('[Enter] Type a message (sent through the chat session, on the route above)');
    await press(f.r, TAB, ENTER);
    for (const ch of 'hi there') f.r.stdin.write(ch);
    await sleep(100);
    await press(f.r, ENTER);
    await until('the tool\'s NEEDS YOU box', () => /⚠ NEEDS YOU/.test(f.text()), 5000, f.text);
    expect(f.text()).toContain('write_project_file');
    await sleep(400);
    await press(f.r, 'n');
    await until('the answer', () => /answered · nothing was sent to any model · no charge \(FIXTURE: no model\) · receipt fixture1 · operation o[0-9a-f]{8}/.test(regionText(c, 'center')), 5000, f.text);
    expect(regionText(c, 'center')).toContain('Timmy: Hello from the FIXTURE session; the tool was denied.');
    expect(regionText(c, 'center')).toContain('You: hi there');
    expect(sent).toEqual(['hi there']);
    // R4 lead: through sendOnce, keyed by the operation the turn is recorded under (the one the center names)
    const op = /operation (o[0-9a-f]{8})/.exec(regionText(c, 'center'))![1];
    expect(keys).toEqual([`wb-${op}`]);
    // R4 lead: one route on every part of the Workbench: the top line and Settings say the session's own words
    expect(regionText(c, 'top')).toContain('chat: FIXTURE route');
  });

  it('without the producers: the Inspector and the composer say what they need; nothing is sent', async () => {
    sandbox();
    const p = trayProject('tray-none');
    // R4 lead (the merge): the real loaders find both producers in this revision (H102's and H103's, merged)
    expect((await realProducers.runDetail()).ok).toBe(true);
    expect((await realProducers.openChat()).ok).toBe(true);
    // a Timmy without them (FIXTURE loaders that say so, as the real ones would): the words, and nothing is sent
    const missing: Producers = {
      runDetail: async () => ({ ok: false, why: 'src/ops/run-detail.ts (H102\'s run detail) is not in this revision' }),
      openChat: async () => ({ ok: false, why: 'src/agent/chat-session.ts (H103\'s chat session) is not in this revision' }),
    };
    const { c } = workbench(p, missing);
    c.start();
    c.selectWorkspace('chat');
    const f = frameOf(c, 180, 50);
    await until('the producers', () => /is not in this revision/.test(regionText(c, 'center')), 5000, f.text);
    expect(regionText(c, 'center')).toContain('sending from the Workbench needs the shared chat session: src/agent/chat-session.ts (H103\'s chat session) is not in this revision. Type in the REPL (timmy) or the monitor (timmy watch) instead. Nothing is sent from here.');
    await press(f.r, TAB, ENTER);
    for (const ch of 'hello') f.r.stdin.write(ch);
    await press(f.r, ENTER);
    expect(regionText(c, 'bottom')).toContain('Not sent: sending from the Workbench needs the shared chat session');
  });
});
