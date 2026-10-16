// R5 (H136): tab 3 Workflows' body (src/workbench/workflows-tab.ts): its readers over a real run and its three columns (the
// operator's references 03 and 12: .intent and .predict | the sandbox and the run | the receipt and its review), drawn as
// rows at the body's sizes for 160x45, 120x40 and 100x30. A real Timmy home in a temporary folder: a project made by the
// starter code, the REPL's own Workspace (its /run, its job store, its operation log and its receipt chain, sealed for real
// into this test's store), the run detail's one producer (src/ops/run-detail.ts readRunDetail) over those records, and the
// chain verified by src/utils/receipts.ts verifyReceiptIn.
//
// FAKE or FIXTURE here, each labelled where it is made: upmd is tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7;
// the blocks run for real through sh, over a pipe); PAIR.md and LONG.md are this test's (FAKE workflows); a copy of the chain
// with one receipt's words changed (to show "not verified"); a run detail whose prediction is dated after its run started
// (FIXTURE, to show "not recorded").
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunDetail } from '../src/contracts/run-detail.js';
import type { JobRecord } from '../src/jobs/index.js';
import { readRunDetail } from '../src/ops/run-detail.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { scrubHomes } from '../src/utils/home-scrub.js';
import { appendReceipt, readChain, verifyReceiptIn, type Receipt } from '../src/utils/receipts.js';
import { glyphsFor } from '../src/workbench/frame.js';
import type { Data, Lazy, Ui, View } from '../src/workbench/model.js';
import { readJobs, readWorkflows, type WorkflowsView } from '../src/workbench/state.js';
import { plain, type Line } from '../src/workbench/text.js';
import type { ViewCtx } from '../src/workbench/views.js';
import {
  blockKey, columnWidths, readWorkflowsTab, refreshBlockStates, selectedBlock, stateMark, workflowsTabView, type WorkflowsTabData,
} from '../src/workbench/workflows-tab.js';

const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// FAKE workflow (this test's): `first` waits a moment and prints, `second` needs it and prints
const PAIR = '# Pair (FAKE workflow, this test)\n\nTwo blocks: the second needs the first.\n\n```bash [name:first]\nsleep 1.5\necho first says one\necho first says two\n```\n\n```bash [name:second, deps:first]\necho second says three\n```\n';
const g = glyphsFor(true);

let box = '';
let home = '';
let jobsDir = '';
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-wftab-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
  vi.unstubAllEnvs();
});

function sandbox(): void {
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
}

const ENV = (): NodeJS.ProcessEnv => ({ ...process.env, UPMD_BIN: FAKE_UPMD });

/** A project made by the starter code (APPROVAL.md and WORKFLOW.md), with this test's PAIR.md beside them. */
function project(name: string): { name: string; root: string; chosen: boolean } {
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  writeFileSync(join(made.root, 'PAIR.md'), PAIR);
  saveActiveProject(made);
  return made;
}

/** The REPL's own Workspace over the project (its /run seals into this test's store; upmd over a pipe: no python3 asked). */
function workspace(p: { name: string; root: string; chosen: boolean }): Workspace {
  const ws = new Workspace({
    glyphs: glyphSet(true), env: ENV(), onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t,
    seal: (input) => appendReceipt('runs', input).hash.slice(7, 15), receipts: () => readChain('runs'),
    jobsDir, recoverAtStart: false, chdir: () => undefined,
  }, p);
  spaces.push(ws);
  return ws;
}

/** /run <doc> <block> as the Workbench runs it (src/workbench/controller.ts runBlock): one operation, the REPL's own /run. */
async function run(ws: Workspace, p: { name: string; root: string }, doc: string, block: string): Promise<JobRecord> {
  const h = ws.ops.begin({ request: `/run ${doc} ${block}`, via: 'workbench', root: p.root, project: p.name });
  await ws.ops.run(h, () => ws.run(`${doc} ${block}`));
  const job = ws.jobs.list().find((j) => j.label === `${doc} › ${block}`);
  if (!job) throw new Error(`no job for ${doc} › ${block}`);
  return job;
}

const docsOf = (root: string, records: readonly JobRecord[], chain: readonly Receipt[]): WorkflowsView => readWorkflows(root, { jobs: records, chain, files: [], env: ENV() });

const UI = (o: Partial<Ui> = {}): Ui => ({
  page: 'workflows', workspace: 'workflows', focus: 'center', tab: 'inspector', navOpen: false, rightOpen: false, activityOpen: false, activityAll: false,
  overlay: null, input: { field: null, text: '' }, cursor: {}, scroll: {}, sel: {}, anchor: {}, wheel: {}, activityFollow: true, toolsQuery: '', flash: null,
  mouse: false, related: false, settings: { settings: {}, path: '', state: 'none yet' }, saved: null,
  companion: { serving: false, address: null, last: null }, studio: { serving: false, address: null, last: null }, mine: [], starting: [], ...o,
} as unknown as Ui);

/** The Workbench's Data for the project, from the records as read now (the parts tab 3 reads). */
function dataOf(p: { name: string; root: string }, records: readonly JobRecord[], chain: readonly Receipt[], extra: Partial<Data> & { workflowsTab?: WorkflowsTabData } = {}): Data {
  return {
    project: { name: p.name, root: p.root, shown: p.root, chosen: true, id: projectId(p.root) }, projects: [], files: { total: 0, truncated: false, groups: [] },
    workflows: refreshBlockStates(docsOf(p.root, records, chain), records, chain), jobs: readJobs(records, p.root, { mine: new Set(), chain }), away: [],
    decisions: { items: [], more: 0, total: 0, otherSetup: 0, tools: {}, operations: {}, notes: [] }, route: { kind: 'none', words: 'chat: none', ready: false },
    activity: { running: 0, waiting: 0, last: null, events: [] }, chat: { session: null, total: 0, messages: [] }, vox: [], native: {}, starters: [], boards: [],
    studio: { state: 'idle' }, overview: { state: 'idle' }, caps: { state: 'idle' }, details: {}, readAt: Date.now(), ...extra,
  } as Data;
}

/** The tab's reading for the block at the list's cursor, as the controller reads it each frame. */
function tabOf(data: Data, ui: Ui, ws: Workspace, records: readonly JobRecord[], chain: readonly Receipt[], root: string): WorkflowsTabData {
  const sel = selectedBlock({ ui, data });
  return readWorkflowsTab({
    records, chain, selected: sel ? { doc: sel.doc, block: sel.block.name } : null, tail: (j, n) => ws.jobs.tail(j.id, n),
    verify: (hash) => { const r = verifyReceiptIn(chain, hash); return r.ok ? { ok: true } : { ok: false, reason: r.reason }; },
    scrub: (t) => scrubHomes(t.split(root).join('.'), process.env), now: Date.now(),
  });
}

/** The cursor's place of `doc › block` in the list (every block, in the documents' order). */
function at(data: Data, doc: string, block: string): number {
  const all = data.workflows.docs.flatMap((d) => (d.blocks.length ? d.blocks.map((b) => `${d.rel} › ${b.name}`) : [`${d.rel} ›`]));
  const i = all.indexOf(`${doc} › ${block}`);
  if (i < 0) throw new Error(`${doc} › ${block} is not in the list: ${all.join(', ')}`);
  return i;
}

/** The body at a size: the body's inner width and height for a terminal of `columns` (src/workbench/layout.ts). */
function body(data: Data, ui: Ui, size: { width: number; height: number; columns: number }): { v: View; text: string[] } {
  const c = { ui, data, g, width: size.width, height: size.height, now: Date.now(), can: { run: true, chat: false, detail: true }, columns: size.columns } as ViewCtx & { columns: number };
  const v = workflowsTabView(c);
  return { v, text: v.lines.map(plain) };
}

// the body's inner size at each terminal size (src/workbench/layout.ts: row 1, row 2, Activity & log; tab 3's body takes the
// whole width, Context a drawer): 160x45 → 156x28, 120x40 → 116x23, 100x30 → 96x14
const AT_160 = { width: 156, height: 28, columns: 160 };
const AT_120 = { width: 116, height: 23, columns: 120 };
const AT_100 = { width: 96, height: 14, columns: 100 };

/** The text of one of the three columns (side by side: split at the rules). */
function column(text: string[], i: 0 | 1 | 2, width: number): string[] {
  const [l, m] = columnWidths(width);
  const from = i === 0 ? 0 : i === 1 ? l + 3 : l + 3 + m + 3;
  const to = i === 0 ? l : i === 1 ? l + 3 + m : undefined;
  return text.map((t) => [...t].slice(from, to).join(''));
}

/** Every segment of the rows drawn green, with its row's words. */
const greens = (lines: readonly Line[]): string[] => lines.flatMap((l) => l.filter((s) => s.role === 'live').map((s) => s.text));

/** A column's words as one line: its boxes' borders and the line breaks of wrapped words read as spaces. */
const flat = (rows: readonly string[]): string => rows.join(' ').replace(/[│╭╮╰╯─┃┏┓┗┛━]/g, ' ').replace(/\s+/g, ' ');

async function until<T>(what: string, get: () => T | undefined | false | null, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe('tab 3 Workflows: the newest job record decides each block\'s state (R5 H136; the review of 2026-10-15)', () => {
  it('a block row read while its run went on said waiting; read again from the newest job record it says completed (no lag behind the job)', async () => {
    sandbox();
    const p = project('wf-lag');
    const ws = workspace(p);
    const job = await run(ws, p, 'PAIR.md', 'second');
    // the documents as the slow reading read them while the run went on (every few seconds in the Workbench)
    const during = docsOf(p.root, ws.jobs.list(), readChain('runs'));
    const was = during.docs.find((d) => d.rel === 'PAIR.md')!.blocks.find((b) => b.name === 'second')!;
    expect(was.word).toBe('waiting');
    // read again from the job records of the same moment: the same (nothing has ended)
    const now1 = refreshBlockStates(during, ws.jobs.list(), readChain('runs')).docs.find((d) => d.rel === 'PAIR.md')!.blocks;
    expect(now1.find((b) => b.name === 'second')!.word).toBe('waiting');
    const ended = await ws.jobs.done(job.id);
    expect(ended.state).toBe('completed');
    // the documents' reading still says waiting; the newest job record says completed, with each block's exit code
    expect(during.docs.find((d) => d.rel === 'PAIR.md')!.blocks.find((b) => b.name === 'second')!.word).toBe('waiting');
    const now2 = refreshBlockStates(during, ws.jobs.list(), readChain('runs')).docs.find((d) => d.rel === 'PAIR.md')!.blocks;
    expect(now2.map((b) => [b.name, b.word, b.run])).toEqual([['first', 'completed', job.id], ['second', 'completed', job.id]]);
    expect(now2.find((b) => b.name === 'second')!.detail).toContain('exit 0');
    // the same words the board's card reads from the same records (src/repl/board-workflows.ts connectWorkflow)
    const board = docsOf(p.root, ws.jobs.list(), readChain('runs')).docs.find((d) => d.rel === 'PAIR.md')!.blocks;
    expect(now2.map((b) => [b.name, b.word, b.detail, b.run])).toEqual(board.map((b) => [b.name, b.word, b.detail, b.run]));
    // a document no run touched: not run yet
    const tray = refreshBlockStates(during, ws.jobs.list(), readChain('runs')).docs.find((d) => d.rel === 'WORKFLOW.md')!.blocks;
    expect(new Set(tray.map((b) => b.word))).toEqual(new Set(['not run yet']));
  }, 60_000);
});

describe('tab 3 Workflows: three columns, as references 03 and 12 lay them out (R5 H136)', () => {
  it('after a run: .intent and .predict (frozen before the run) | where it ran, its steps, its log\'s last lines, the RUN box | its receipt verified here (green), its checks, verdict and timmy op', async () => {
    sandbox();
    const p = project('wf-after');
    const ws = workspace(p);
    const job = await run(ws, p, 'PAIR.md', 'second');
    await ws.jobs.done(job.id);
    const records = ws.jobs.list();
    const chain = readChain('runs');
    const op = job.operation!;
    expect(op).toMatch(/^o[0-9a-f]{8}$/);
    // the one run detail, from the records (the controller reads it through the same producer)
    const rd = readRunDetail(op, { project: p.root, jobs: records, chain });
    if (!rd.ok) throw new Error(rd.why);
    const ui = UI();
    let data = dataOf(p, records, chain, { details: { [op]: { state: 'ready', value: rd.detail, at: Date.now() } } });
    ui.cursor['center:workflows'] = at(data, 'PAIR.md', 'second');
    data = { ...data, workflowsTab: tabOf(data, ui, ws, records, chain, p.root) } as Data;
    const tab = (data as Data & { workflowsTab: WorkflowsTabData }).workflowsTab;
    expect(tab.for).toBe(blockKey('PAIR.md', 'second'));
    expect(tab.run).toMatchObject({ job: job.id, operation: op, word: 'completed', live: false, steps: [{ name: 'first', word: 'completed' }, { name: 'second', word: 'completed' }] });
    expect(tab.run!.tail.lines).toEqual(expect.arrayContaining(['first says one', 'first says two', 'second says three']));
    expect(tab.run!.receipt).toMatchObject({ kind: 'workflow', verified: { ok: true } });

    const { v, text } = body(data, ui, AT_160);
    // every row exactly the body's width, three columns between two rules, and within the body's height
    expect(text.every((t) => visibleWidth(t) === AT_160.width)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(AT_160.height);
    expect(text.filter((t) => t.split(' │ ').length === 3).length).toBe(text.length);
    const [left, centre, right] = [column(text, 0, AT_160.width), column(text, 1, AT_160.width), column(text, 2, AT_160.width)];
    const L = left.join('\n');
    const C = centre.join('\n');
    const R = right.join('\n');
    // left: the plan (upmd found), every document and block (the whole list shows at this size), the selected one marked;
    // .intent and .predict
    expect(L).toContain('PLAN · upmd found');
    for (const name of ['APPROVAL.md', 'PAIR.md', 'WORKFLOW.md', 'tidy', 'first', 'second', 'change', 'inspect', 'result', 'lesson']) expect(L).toContain(name);
    expect(L).not.toMatch(/more above|of \d+ rows/);
    expect(L).toMatch(/▸\s+2 second\s+✓ completed exit 0/);
    expect(L).toMatch(/second\.intent[^\n]*block 2/);
    expect(flat(left)).toMatch(/document PAIR\.md command echo second says three needs first runs first → second no destructive command/);
    expect(L).toMatch(/second\.predict[^\n]*j[0-9a-f]{6}/);
    // frozen before the run first (a clipped column keeps it), then the sealed words and their receipt
    expect(flat(left)).toMatch(new RegExp(`second\\.predict ${job.id} frozen before the run (?:· sealed \\d\\d:\\d\\d:\\d\\d )?`));
    expect(flat(left)).toContain(`${rd.detail.prediction!.words} receipt ${rd.detail.prediction!.receipt}`);
    expect(L).toMatch(new RegExp(`receipt\\s+${rd.detail.prediction!.receipt}`));
    expect(L).toContain('frozen before the run');
    expect(L).not.toContain('frozen before the run: not recorded');
    // centre: where it ran, the run's blocks, its log's last lines (cut, never wrapped), the RUN box, the preview line
    expect(C).toContain('SANDBOX · where it runs');
    expect(flat(centre)).toContain('this computer, in the project folder (upmd)');
    // the environment the run detail names (its env lock), where it names one; upmd over a pipe adds no runner line
    if (rd.detail.worker.environment) expect(flat(centre)).toMatch(/\(upmd\) environment \S/);
    expect(flat(centre)).not.toContain('runner');
    expect(C).toMatch(new RegExp(`STEPS · ${job.id} ✓ completed`));
    expect(C).toMatch(/PAIR\.md › second · \d/);
    expect(C).toMatch(/✓ first completed · exit 0/);
    expect(C).toMatch(/✓ second completed · exit 0/);
    expect(C).toContain('OUTPUT');
    expect(C).toContain('second says three');
    expect(C).toContain('RUN PAIR.md › second');
    expect(C).toContain('[Enter] Run it here');
    expect(flat(centre)).toContain('[Enter] Run it here the REPL\'s own /run, one job; it asks first');
    expect(C).toMatch(/REPL\s+\/run PAIR\.md second/);
    expect(flat(centre)).toContain('A browser or sandbox preview is drawn only by the companion (c); here, the run in words.');
    // right: the receipt card (verified in this reading), the checks predicted against actual, the verdict, timmy op
    expect(R).toContain('second.receipt');
    expect(R).toMatch(new RegExp(`id\\s+${tab.run!.receipt!.id}`));
    expect(R).toMatch(/kind\s+workflow/);
    expect(R).toContain('✓ verified');
    expect(flat(right)).toMatch(/CHECKS (?:· )?predicted vs actual/);
    expect(R).toMatch(/✓ block first matches/);
    expect(R).toMatch(/exits 0 → exit 0/);
    expect(R).toContain('VERDICT');
    expect(R).toMatch(/✓ completed/);
    expect(R).toContain(`timmy op ${op}`);
    // green only for what was verified or passed in this reading: the receipt card and the checks that matched
    const green = greens(v.lines);
    expect(green.length).toBeGreaterThan(0);
    for (const s of green) expect(s).toMatch(/^(?:[╭╮╰╯─│ ]+|second\.receipt|✓ verified|✓ | matches|block (?:first|second))$/);
    // one meaning per mark: no ● (live) or ○ (configured) for a block or a run
    expect(text.join('\n')).not.toMatch(/[●○]/);
    // the items: every block in the list's order, as before (Enter on one opens its Run confirm in the controller)
    expect(v.items.map((x) => x.item.key)).toEqual(data.workflows.docs.flatMap((d) => d.blocks.map((b) => `block:${d.rel}:${b.key}`)));
    expect(v.items[ui.cursor['center:workflows']].item).toMatchObject({ kind: 'block', block: { name: 'second' } });
    expect(text[v.items[ui.cursor['center:workflows']].line]).toMatch(/▸\s+2 second/);
  }, 60_000);

  it('a receipt that does not verify in this reading is never green: "not verified" and why, amber with ✕', async () => {
    sandbox();
    const p = project('wf-tampered');
    const ws = workspace(p);
    const job = await run(ws, p, 'PAIR.md', 'second');
    await ws.jobs.done(job.id);
    const records = ws.jobs.list();
    // FIXTURE: a copy of the chain with the run's outcome receipt's words changed after it was sealed
    const chain = readChain('runs').map((r) => (r.kind === 'workflow' && r.job?.id === job.id ? { ...r, subject: `${r.subject} (changed)` } : r));
    const ui = UI();
    let data = dataOf(p, records, chain);
    ui.cursor['center:workflows'] = at(data, 'PAIR.md', 'second');
    data = { ...data, workflowsTab: tabOf(data, ui, ws, records, chain, p.root) } as Data;
    const { v, text } = body(data, ui, AT_160);
    const R = column(text, 2, AT_160.width).join('\n');
    expect(R).toMatch(/✕ not verified:/);
    expect(R).not.toContain('✓ verified');
    expect(greens(v.lines)).toEqual([]);
    // its run detail is not read here (none given): the .predict card and the checks say so, and the verdict is the job's
    expect(flat(column(text, 0, AT_160.width))).toMatch(/reading the run detail of o[0-9a-f]{8}/);
    expect(flat(column(text, 2, AT_160.width))).toMatch(/VERDICT ✓ completed \(its job record's word\)/);
  }, 60_000);

  it('a prediction dated after its run started is not said to be frozen before it: "frozen before the run: not recorded"', async () => {
    sandbox();
    const p = project('wf-frozen');
    const ws = workspace(p);
    const job = await run(ws, p, 'PAIR.md', 'second');
    await ws.jobs.done(job.id);
    const records = ws.jobs.list();
    const chain = readChain('runs');
    const op = job.operation!;
    const rd = readRunDetail(op, { project: p.root, jobs: records, chain });
    if (!rd.ok) throw new Error(rd.why);
    // FIXTURE: the run detail with its prediction dated a minute after the run's start
    const later: RunDetail = { ...rd.detail, prediction: { ...rd.detail.prediction!, frozenAt: new Date(Date.parse(job.startedAt) + 60_000).toISOString() } };
    const ui = UI();
    let data = dataOf(p, records, chain, { details: { [op]: { state: 'ready', value: later, at: Date.now() } as Lazy<RunDetail> } });
    ui.cursor['center:workflows'] = at(data, 'PAIR.md', 'second');
    data = { ...data, workflowsTab: tabOf(data, ui, ws, records, chain, p.root) } as Data;
    const L = flat(column(body(data, ui, AT_160).text, 0, AT_160.width));
    expect(L).toContain('frozen before the run: not recorded');
    expect(L).not.toMatch(/frozen before the run(?!:)/);
  }, 60_000);

  it('a block nothing has run: the .intent card (needs you before it runs), and "not recorded" for its prediction, receipt and checks; nothing green', () => {
    sandbox();
    const p = project('wf-none');
    const ui = UI();
    let data = dataOf(p, [], []);
    ui.cursor['center:workflows'] = at(data, 'APPROVAL.md', 'tidy');
    data = { ...data, workflowsTab: readWorkflowsTab({ records: [], chain: [], selected: { doc: data.workflows.docs.find((d) => d.rel === 'APPROVAL.md')!, block: 'tidy' }, tail: () => [], verify: () => ({ ok: false, reason: 'FIXTURE: nothing to verify' }), now: Date.now() }) } as Data;
    const { v, text } = body(data, ui, AT_160);
    const [L, C, R] = [0, 1, 2].map((i) => column(text, i as 0 | 1 | 2, AT_160.width).join('\n'));
    const [fl, fc, fr] = [0, 1, 2].map((i) => flat(column(text, i as 0 | 1 | 2, AT_160.width)));
    expect(L).toMatch(/▸\s+1 tidy\s+⚠ · not run yet/);
    expect(L).toContain('tidy.intent');
    expect(L).toContain('⚠ needs you before it runs');
    expect(L).toMatch(/command\s+mkdir -p scratch/);
    expect(L).toContain('tidy.predict');
    expect(fl).toMatch(/not recorded: nothing has run it yet/);
    expect(fc).toContain('not run yet: no job has run this block');
    expect(C).toContain('RUN APPROVAL.md › tidy');
    expect(fc).toContain('⚠ its NEEDS YOU box asks first');
    expect(fr).toMatch(/not recorded: nothing has run it, so nothing is sealed/);
    expect(fr).toMatch(/CHECKS (?:· )?predicted vs actual not recorded: nothing has run/);
    expect(R).toMatch(/VERDICT\s*\n\s*not run yet/);
    expect(greens(v.lines)).toEqual([]);
    expect(text.join('\n')).not.toMatch(/[●○]/);
  });

  it('a run going on: ▶ running and … waiting (never ● or ○), its log so far', async () => {
    sandbox();
    const p = project('wf-live');
    const ws = workspace(p);
    const job = await run(ws, p, 'PAIR.md', 'second');
    // read while its first block sleeps: its job runs, and its second block waits for the first
    await until('the run to start', () => ws.jobs.list().find((j) => j.id === job.id)?.state === 'running');
    const records = ws.jobs.list();
    const chain = readChain('runs');
    const ui = UI();
    let data = dataOf(p, records, chain);
    ui.cursor['center:workflows'] = at(data, 'PAIR.md', 'second');
    data = { ...data, workflowsTab: tabOf(data, ui, ws, records, chain, p.root) } as Data;
    const { text } = body(data, ui, AT_160);
    const [L, C, R] = [0, 1, 2].map((i) => column(text, i as 0 | 1 | 2, AT_160.width).join('\n'));
    expect(C).toMatch(new RegExp(`STEPS · ${job.id} ▶ running`));
    expect(C).toMatch(/… second waiting/);
    expect(L).toMatch(/second\s+… waiting/);
    expect(flat(column(text, 2, AT_160.width))).toContain('not sealed yet: it runs');
    // the RUN box says a run of it goes on: Enter starts nothing until it ends, and x stops it
    expect(flat(column(text, 1, AT_160.width))).toMatch(new RegExp(`Not from here now: it is running now as ${job.id}[\\s\\S]*x stops ${job.id}`));
    expect(R).not.toContain('✓ verified');
    expect(text.join('\n')).not.toMatch(/[●○]/);
    // the marks, each with its word
    expect(stateMark('running', g)).toEqual({ glyph: '▶', role: 'text' });
    expect(stateMark('waiting', g)).toEqual({ glyph: '…', role: 'secondary' });
    expect(stateMark('failed', g)).toEqual({ glyph: '✕', role: 'failure' });
    expect(stateMark('stopped', g).glyph).toBe('■');
    await ws.jobs.done(job.id);
  }, 60_000);

  it('Enter: the RUN box names the block it runs while this list has the keyboard; with row 2\'s, it says Enter acts there now', () => {
    sandbox();
    const p = project('wf-enter');
    let data = dataOf(p, [], []);
    const ui = UI({ focus: 'top' });
    ui.cursor['center:workflows'] = at(data, 'WORKFLOW.md', 'result');
    data = { ...data, workflowsTab: { for: blockKey('WORKFLOW.md', 'result'), at: Date.now(), run: null } } as Data;
    const top = column(body(data, ui, AT_160).text, 1, AT_160.width);
    expect(top.join('\n')).toContain('RUN WORKFLOW.md › result');
    expect(flat(top)).toContain('Enter acts on row 2 now. Tab to this list: then Enter runs WORKFLOW.md › result');
    expect(top.join('\n')).not.toContain('[Enter]');
    ui.focus = 'center';
    const here = column(body(data, ui, AT_160).text, 1, AT_160.width);
    expect(here.join('\n')).toContain('[Enter] Run it here');
    expect(flat(here)).not.toContain('Enter acts on');
    expect(flat(here)).toContain('runs change → inspect → result');
  });

  it('120x40 and 100x30: every row fits its box (three columns at 120, stacked at 100: the list, then what Enter does); a clipped column says 1–N of M', async () => {
    sandbox();
    const p = project('wf-sizes');
    const ws = workspace(p);
    const job = await run(ws, p, 'PAIR.md', 'second');
    await ws.jobs.done(job.id);
    const records = ws.jobs.list();
    const chain = readChain('runs');
    const ui = UI();
    let data = dataOf(p, records, chain);
    ui.cursor['center:workflows'] = at(data, 'PAIR.md', 'second');
    data = { ...data, workflowsTab: tabOf(data, ui, ws, records, chain, p.root) } as Data;
    // 120x40: three columns in 70 cells
    const at120 = body(data, ui, AT_120);
    expect(at120.text.every((t) => visibleWidth(t) === AT_120.width)).toBe(true);
    expect(at120.text.length).toBeLessThanOrEqual(AT_120.height);
    expect(at120.text.every((t) => t.split(' │ ').length === 3)).toBe(true);
    expect(at120.text.join('\n')).not.toMatch(/[●○]/);
    // 100x30: stacked, one column as wide as the body; the list first, the RUN box right under it
    const at100 = body(data, ui, AT_100);
    expect(at100.text.every((t) => visibleWidth(t) === AT_100.width)).toBe(true);
    const all = at100.text.join('\n');
    expect(all.indexOf('WORKFLOW.md')).toBeLessThan(all.indexOf('RUN PAIR.md › second'));
    expect(all.indexOf('RUN PAIR.md › second')).toBeLessThan(all.indexOf('second.intent'));
    expect(all.indexOf('second.intent')).toBeLessThan(all.indexOf('SANDBOX'));
    expect(all.indexOf('SANDBOX')).toBeLessThan(all.indexOf('second.receipt'));
    expect(at100.v.items[ui.cursor['center:workflows']].line).toBeLessThan(AT_100.height);
    // a short body (160 columns, 14 rows): each column clipped says which of its rows show
    const short = body(data, ui, { width: 156, height: 14, columns: 160 });
    expect(short.text.length).toBe(14);
    expect(short.text.join('\n')).toMatch(/↓ 1–13 of \d+ rows/);
    expect(short.text[short.v.items[ui.cursor['center:workflows']].line]).toMatch(/▸\s+2 second/);
  }, 60_000);

  it('a long list keeps the selected block in view: marks above and below say what is not shown; every block stays an item, in order', () => {
    sandbox();
    const p = project('wf-long');
    // FAKE workflow (this test's): thirty blocks
    writeFileSync(join(p.root, 'LONG.md'), `# Long (FAKE workflow, this test)\n\n${Array.from({ length: 30 }, (_, i) => `\`\`\`bash [name:b${i + 1}]\necho ${i + 1}\n\`\`\`\n`).join('\n')}`);
    const ui = UI();
    const data = dataOf(p, [], []);
    ui.cursor['center:workflows'] = at(data, 'LONG.md', 'b25');
    const { v, text } = body(data, ui, AT_160);
    const L = column(text, 0, AT_160.width);
    expect(text.length).toBeLessThanOrEqual(AT_160.height);
    expect(L.join('\n')).toMatch(/↑ \d+ more above/);
    expect(L.join('\n')).toMatch(/↓ \d+–\d+ of \d+ rows/);
    const sel = v.items[ui.cursor['center:workflows']];
    expect(sel.item).toMatchObject({ kind: 'block', block: { name: 'b25' } });
    expect(sel.line).toBeGreaterThanOrEqual(0);
    expect(sel.line).toBeLessThan(AT_160.height);
    expect(L[sel.line]).toMatch(/▸\s+25 b25/);
    // every block is an item, in the list's order; those not drawn are on no row of the body
    expect(v.items.map((x) => x.item.key)).toEqual(data.workflows.docs.flatMap((d) => d.blocks.map((b) => `block:${d.rel}:${b.key}`)));
    for (const x of v.items) if (x.line >= 0 && x.line < AT_160.height) expect(L[x.line]).toContain((x.item as { block: { name: string } }).block.name);
  });
});
