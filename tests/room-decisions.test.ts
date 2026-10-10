/**
 * Round R4 (H60): the decisions waiting on a person, in the Control Room (`/room`, the board's section, snapshot and live)
 * and `/decisions`, from real records in temporary projects with a REAL receipts chain (tests/helpers/memory-kit.ts:
 * appendReceipt, hash-chained and signed). Every request to the live board is real HTTP on 127.0.0.1.
 *
 * FAKE or SYNTHETIC pieces, each labelled:
 * - the /tools rows are FAKE (given through the roomTools seam): nothing on this machine is probed for them;
 * - the flow records are written as the flows write them (writeFlow: the file, its sha256 and its flow receipt are real),
 *   their parts made up: no agent, recipe or app ran;
 * - two job records are SYNTHETIC: what a crashed session's job manager leaves (running, its process gone), written into
 *   the jobs folder the real JobManager reads, as tests/recover.test.ts does;
 * - the NEEDS YOU wait is a real gate (gateTools) around a FAKE tool whose execute only returns; the answer is the test's.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import type { CapabilityRow } from '../src/capabilities/index.js';
import { splitCommandLine } from '../src/connectors/mcp-cli.js';
import { gateTools, waitingApprovals, type Decision as GateDecision } from '../src/repl/approvals.js';
import type { LiveState } from '../src/repl/board-live.js';
import { runSlash, type ReplContext } from '../src/repl/commands.js';
import { parseIterateLine } from '../src/repl/iterate.js';
import { againCommand, quoteArg } from '../src/room/decisions.js';
import { paramsText } from '../src/recipes/params-file.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Segment } from '../src/term/theme.js';
import { SETUP } from '../src/vox/tools.js';
import { FLOW_SCHEMA } from '../src/flows/iterate.js';
import { memoryKit, put, read, sha, text, workspace, writeFlow } from './helpers/memory-kit.js';

const kit = memoryKit();
afterEach(async () => { await kit.cleanup(); });

/** FAKE /tools rows (what a check might find): nothing on this machine was probed for them. */
const FAKE_ROWS: CapabilityRow[] = [
  { id: 'blender', kind: 'adapter', name: 'Blender (Python, headless)', rung: 'needs setup', detail: 'FAKE: Blender was not found', setup: 'brew install --cask blender (FAKE step)' },
  { id: 'openscad', kind: 'adapter', name: 'OpenSCAD (command line)', rung: 'needs setup', detail: 'FAKE: openscad is not on PATH', setup: 'brew install --cask openscad (FAKE step)' },
  { id: 'c4dpy', kind: 'adapter', name: 'Cinema 4D (c4dpy)', rung: 'needs setup', detail: 'FAKE: c4dpy asks for its licence method', setup: 'run c4dpy once and answer its licence question (FAKE step)' },
  { id: 'qwen-code', kind: 'harness', name: 'Qwen Code', rung: 'installed', detail: 'FAKE row' },
];
const HOSTILE = 'thicker <img src=x onerror=alert(1)> walls';
const OP = 'o0000abcd';
const UUID = '11111111-2222-4333-8444-555555555555';
const LEFT = 'f0000dead';
const at = (base: number, s: number): string => new Date(base + s * 1000).toISOString();
/** A pid that is not running: a process that has already exited. */
const gonePid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;
const nothingDone = (s: string): number => s.split('Nothing is done until you do it.').length - 1;

/** SYNTHETIC: a job record a crashed session's job manager leaves: running, its process gone. */
function leftJob(jobsDir: string, rec: Record<string, unknown>): void {
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(join(jobsDir, `${String(rec.id)}.json`), JSON.stringify({ project: 'p', command: 'node', args: [], state: 'running', pid: gonePid(), steps: [], lines: 0, ...rec }));
}

/** A project holding one of each record that waits on a person, and one that does not (a failure settled by a later run). */
function project() {
  const root = kit.temp('decisions-');
  const jobsDir = join(kit.temp('decisions-jobs-'), 'jobs');
  const base = Date.now() - 3600_000;
  put(root, 'README.md', '# decisions\n');
  put(root, 'BUILD.md', ['# Build', '', '```bash [name:prep]', 'true', '```', '', '```bash [name:wait] [needs:prep]', 'sleep 30', '```', ''].join('\n'));
  put(root, 'evidence/one.txt', 'the run where it held\n');
  put(root, 'evidence/two.txt', 'the other run\n');
  const { ws, notes } = workspace(root, kit, { extra: { jobsDir, roomTools: async () => FAKE_ROWS } });
  const tray = writeFlow(root, { kind: 'tray', instruction: 'make it 160 mm "wide"', outcome: 'interrupted', recovered: true, started: at(base, 0) });
  const blender = writeFlow(root, { kind: 'blender', instruction: 'add a hole', outcome: 'differs', verdict: 'differs', started: at(base, 100) });
  const freecad = writeFlow(root, { kind: 'freecad', instruction: HOSTILE, outcome: 'failed', started: at(base, 200) });
  // An After Effects flow failed, then a later one on the same script succeeded: nothing waits for it.
  const aeOld = writeFlow(root, { kind: 'ae', instruction: 'slower fade', outcome: 'failed', started: at(base, 300) });
  writeFlow(root, { kind: 'ae', instruction: 'slower fade', outcome: 'succeeded', verdict: 'matches', started: at(base, 400) });
  // SYNTHETIC: a recipe's watcher and a workflow run, each left running by a session that ended.
  leftJob(jobsDir, { id: 'j0dead1', kind: 'task', label: `recipe enclosure.tray/1 ${UUID}`, root, startedAt: at(base, 50) });
  // SYNTHETIC: an OpenSCAD flow's state file, in its agent step, whose agent job was left running by a session that ended.
  leftJob(jobsDir, { id: 'j0dead3', kind: 'task', label: `agent qwen · flow ${LEFT}`, root, startedAt: at(base, 30) });
  put(root, `.timmy/flows/${LEFT}/state.json`, JSON.stringify({
    flow: 1, schema: FLOW_SCHEMA, id: LEFT, kind: 'iterate', target: 'scad', instruction: 'rounder corners', project: 'p', started_at: at(base, 30), outcome: 'running', step: 'agent',
    model: { path: 'box.scad', sha256: 'a'.repeat(64), bytes: 10 }, parameters: { path: 'box.params.json', created: false, before: { sha256: 'b'.repeat(64), values: {} } },
    agent: { run: 'a0000dead', agent: 'qwen', version: null, route: 'local endpoint, no charge', where: '127.0.0.1', model: 'qwen3:4b', job: 'j0dead3' }, receipts: {},
  }));
  leftJob(jobsDir, {
    id: 'j0dead2', kind: 'workflow', label: 'BUILD.md › wait', root, command: 'upmd', args: ['--ci', '-b', 'wait', '-d', root, join(root, 'BUILD.md')],
    startedAt: at(base, 250), steps: [{ name: 'prep', state: 'completed', code: 0 }, { name: 'wait', state: 'running' }], operation: OP,
  });
  // A VoxVision record that ended needing Look (OpenCV), which needs setup here (no Python on this test's PATH).
  put(root, 'results/vox/v0000bbbb.json', JSON.stringify({ schema: 'timmy.vox/1', id: 'v0000bbbb', action: 'detect', command: '/detect refs/a.png', status: 'needs setup', made_at: at(base, 150), inputs: [], tools: [{ tool: 'look', status: 'needs setup' }], metrics: [], claims: [], highlights: [], failures: [{ tool: 'look', code: 'needs-setup', message: 'Look needs a Python with OpenCV', setup: 'as recorded then' }], notes: [] }));
  // Lessons: a draft, and one checked whose evidence changed since.
  const id = (out: string): string => /Lesson\s+(l[0-9a-f]{8})/.exec(out)![1];
  const draft = id(text(ws.lesson('add "Keep the lid gap at 0.4 mm." --from evidence/one.txt --applies scad')));
  const stale = id(text(ws.lesson('add "Print the wall at 3 mm." --from evidence/two.txt --applies tray')));
  text(ws.lesson(`check ${stale}`));
  writeFileSync(join(root, 'evidence/two.txt'), 'it changed since\n');
  return { root, ws, notes, tray, blender, freecad, aeOld, draft, stale };
}

/** The titles of the items, in order, from the text lines. */
const titles = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('    ! ')).map((l) => l.slice(6).replace(/ {2}(blocks a running request|blocks a requested save|left by a session that ended|setup a run needs|interrupted|differs|failed|memory)$/, ''));

describe('what waits on a person, from real records', () => {
  it('/decisions: each record that waits, in order (left behind, setup, runs, lessons), with what is needed, why and the exact command; a settled failure is not listed', async () => {
    const { root, ws, tray, blender, freecad, aeOld, draft, stale } = project();
    const out = text(await ws.decisions(''));
    expect(out.split('\n')[0]).toBe(`  Waiting on you  10 in ${ws.project.name} · what blocks a request first · from the records and checks each names`);
    expect(titles(out)).toEqual([
      '2 runs were left by a Timmy session that ended',
      'VoxVision: Look (OpenCV) needs setup',
      'Blender (Python, headless) needs setup',
      'OpenSCAD (command line) needs setup',
      `flow ${freecad.id} (/iterate freecad) failed in its checks step`,
      'workflow run j0dead2 (BUILD.md › wait) was interrupted',
      `flow ${blender.id} (/iterate blender) ended differing: its readback did not match`,
      `flow ${tray.id} (/iterate tray) was interrupted in its checks step`,
      `lesson ${stale} is stale: "Print the wall at 3 mm."`,
      `lesson ${draft} is a draft: "Keep the lid gap at 0.4 mm."`,
    ]);
    expect(nothingDone(out)).toBe(10);
    expect(out).not.toContain(aeOld.id);
    // Left behind: what /recover settles, named by its record.
    // Newest first: the flow's state file was written last.
    expect(out).toContain(`why     flow ${LEFT} (/iterate scad): its state file says its agent step runs, and that step's job j0dead3 was left running by a session whose process is gone; recipe job ${UUID}: its newest watcher j0dead1 was left running by a session whose process is gone`);
    expect(out).toContain(`record  .timmy/flows/${LEFT}/state.json`);
    expect(out).toContain('type    /recover');
    // Setup: the step /tools or VoxVision gives, for a tool a run of this project used; the other rows counted, /tools named.
    expect(out).toContain(`step    ${SETUP.look}`);
    expect(out).toContain('ended needing it');
    expect(out).toContain('step    brew install --cask blender (FAKE step)');
    expect(out).toContain(`the newest run of this project that used it: flow ${blender.id} (/iterate blender)`);
    expect(out).toContain(`step    brew install --cask openscad (FAKE step)`);
    expect(out).toContain(`the newest run of this project that used it: flow ${LEFT} (/iterate scad)`);
    expect(out).not.toContain('run c4dpy once');
    expect(out).toContain('1 other row of /tools needs setup for a tool no run of this project used or tried: /tools lists it');
    // Runs: the record (and its receipt), why, and the command to inspect or start it again.
    expect(out).toContain(`record  ${freecad.rel} · receipt ${freecad.receipt!.hash.slice(7, 15)}`);
    expect(out).toContain(`type    /room ${freecad.id} · /open ${freecad.rel} · /iterate freecad model.freecad "${HOSTILE}"`);
    expect(out).toContain(`type    /iterate tray 'make it 160 mm "wide"' · /room ${tray.id}`);
    expect(out).toContain(`type    /room ${blender.id} · /open ${blender.rel} · /iterate blender model.blender "add a hole"`);
    expect(out).toContain('type    /run BUILD.md wait · /jobs j0dead2');
    expect(out).toContain('why     its job record says running and its process is gone: the session that ran it ended while wait ran');
    // Lessons: check a draft; a stale one says what changed.
    expect(out).toContain(`type    /lesson check ${draft} · /lesson ${draft}`);
    expect(out).toContain(`type    /lesson ${stale} · /lesson check ${stale} · /lesson retire ${stale}`);
    expect(out).toContain('why     recorded checked, but its evidence changed since: item 1: evidence/two.txt changed: sha256 ');
    expect(out).toContain('why     recorded draft; its evidence checks now');
    expect(out).toContain(`why     its record says: it ended failed`);
    expect(out).toContain('ended needing it');
    expect(out).not.toContain(root);
    // Through the command registry, as typed.
    const printed: Segment[][] = [];
    await runSlash('/decisions', { print: (s: Segment[]) => printed.push(s), glyphs: glyphSet(true), workspace: ws } as unknown as ReplContext);
    expect(text(printed)).toBe(out);
  });

  it('the Control Room shows the first six, what blocks first, and the count of the rest; the snapshot escapes every record\'s text', async () => {
    const { root, ws, freecad } = project();
    const room = text(await ws.room(''));
    const first = (s: string): number => { const i = room.indexOf(s); expect(i, s).toBeGreaterThanOrEqual(0); return i; };
    expect(first('WAITING ON YOU  10, what blocks a request first; all of them: /decisions')).toBeLessThan(first('OPERATIONS'));
    expect(first('OPERATIONS')).toBeLessThan(first('RUNNING NOW'));
    expect(titles(room)).toHaveLength(6);
    expect(room).toContain('    and 4 more wait: /decisions lists them');
    expect(nothingDone(room)).toBe(6);
    ws.board('');
    const html = read(root, '.timmy/board/index.html');
    const part = html.slice(html.indexOf('<h3 id="room-decisions">'), html.indexOf('<div class="room-costs">'));
    // The flow left in its agent step still says it runs (its state file); /recover records it.
    expect(html).toContain('<a href="#room">Control Room <b>1 running · 10 waiting on you</b></a>');
    expect(part).toContain('<h3 id="room-decisions">Waiting on you <span class="count">10</span></h3>');
    expect(part.match(/<li class="dec /g)).toHaveLength(6);
    expect(part).toContain('and 4 more wait: /decisions lists them');
    expect(part).toContain('data-cmd="/decisions"');
    expect(part).toContain('<details class="more" data-keep="room:decisions:other-setup"><summary>1 other row of /tools needs setup</summary>');
    // Hostile text from a record is text: escaped, in the title's command and nowhere as markup.
    expect(part).toContain(`data-cmd="/iterate freecad model.freecad &quot;thicker &lt;img src=x onerror=alert(1)&gt; walls&quot;"`);
    expect(html).not.toContain('<img src=x');
    expect(part).toContain(`<a class="file" href="../../${freecad.rel}">${freecad.rel}</a>`);
    expect(part.split('Nothing is done until you do it.').length - 1).toBe(6);
    expect(part).not.toContain('data-act=');
  });

  it('an operation with an item waiting is marked: its card on the board, /op and /ops', async () => {
    const { root, ws } = project();
    await ws.decisions('');
    ws.board('');
    const html = read(root, '.timmy/board/index.html');
    expect(html).toContain(`class="card op-card op-tone-neutral op-has-waiting" data-op="${OP}" data-waiting="1"`);
    expect(html).toContain('<span class="op-label">waiting on you</span> workflow run j0dead2 (BUILD.md › wait) was interrupted <a href="#room-decisions">Waiting on you</a>');
    expect(text(ws.op(OP))).toContain('Waiting    on you: workflow run j0dead2 (BUILD.md › wait) was interrupted · /decisions');
    expect(text(ws.opsView(''))).toContain('1 waiting on you');
  });

  it('nothing waiting: /decisions and the board say so plainly', async () => {
    const root = kit.temp('decisions-none-');
    put(root, 'README.md', '# nothing waits\n');
    const { ws } = workspace(root, kit, { extra: { roomTools: async () => [] } });
    expect(text(await ws.decisions(''))).toBe([
      `  Waiting on you  nothing in ${ws.project.name}: no NEEDS YOU box, refused save, run left by a session that ended, setup a run needs, run that ended needing you, or lesson to check`,
      '  The Control Room shows the first of these: /room · on the board: /board live',
    ].join('\n'));
    ws.board('');
    const html = read(root, '.timmy/board/index.html');
    expect(html).toContain('<h3 id="room-decisions">Waiting on you <span class="count">0</span></h3><p class="meta">Nothing waits on you here: no NEEDS YOU box');
    expect(html).toContain('<a href="#room">Control Room <b>idle</b></a>');
  });
});

interface Reply { status: number; body: string }
function raw(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? '/', headers: { Host: `127.0.0.1:${port}`, ...(o.headers ?? {}) }, setHost: false, agent: false }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** A real gate around a FAKE tool (its execute only returns); the operator's answer is whatever the test gives `answer`. */
function waitingCall() {
  let answer: (d: GateDecision) => void = () => undefined;
  const fake = { type: 'function', function: { name: 'write_project_file', execute: async () => 'FAKE: written' } };
  const [gated] = gateTools([fake], () => new Promise<GateDecision>((r) => { answer = r; }));
  const run = (gated.function.execute as (a: unknown, c: unknown) => Promise<unknown>)({ path: 'notes/plan.md', content: 'x' }, {});
  return { run, answer: (d: GateDecision) => answer(d) };
}

describe('what blocks a request first: a NEEDS YOU box and a save the board refused', () => {
  it('both lead the list while they wait, on /decisions and on the live board; each goes once it is answered or saved again', async () => {
    const { ws, root } = project();
    await ws.decisions(''); // the tools are checked, as /room and /decisions check them
    await ws.boardLive('live');
    const { port, url } = ws.liveBoard!;
    const token = url.split('#t=')[1];
    const json = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    // The board shows the tray's parameter card with no file; then the file is written on disk before a save.
    const shown = JSON.parse((await raw(port, { path: '/state', headers: { Authorization: `Bearer ${token}` } })).body) as LiveState;
    expect(shown.recipes).toEqual(['tray']);
    put(root, 'recipes/tray.params.json', paramsText({ width: 170, wall: 3, supportOffset: 10, bore: 3 }));
    const params = { width: 150, wall: 3, supportOffset: 10, bore: 3 };
    const refused = await raw(port, { method: 'POST', path: '/edit', headers: json, body: JSON.stringify({ action: 'set-params', recipe: 'tray', base: null, parameters: params }) });
    expect(refused.status).toBe(409);
    const call = waitingCall();
    await new Promise((r) => setTimeout(r, 20)); // its box comes up once the gate's queue reaches it
    try {
      expect(waitingApprovals()).toEqual([expect.objectContaining({ tool: 'write_project_file', summary: 'notes/plan.md', shown: true, session: true })]);
      const out = text(await ws.decisions(''));
      expect(titles(out).slice(0, 2)).toEqual(['NEEDS YOU: write_project_file (notes/plan.md)', 'recipes/tray.params.json changed on disk after the board showed it']);
      expect(out).toContain('    ! NEEDS YOU: write_project_file (notes/plan.md)  blocks a running request');
      expect(out).toContain('keys    y: allow it once · a: allow it for this session · n, Esc or Enter: deny it');
      expect(out).toContain('why     the chat agent asked to run write_project_file, and Timmy asks first because it changes a file in your project');
      expect(out).toContain('    ! recipes/tray.params.json changed on disk after the board showed it  blocks a requested save');
      expect(out).toMatch(/why {5}the board refused your save of the tray recipe's parameters at [0-9-]{10} [0-9:]{5} UTC: the file is sha256 [0-9a-f]{12} now and the board had shown no file; nothing was written/);
      expect(out).toContain('type    /open recipes/tray.params.json');
      // The live board, polled while the box waits, shows the same first, escaped, with no button.
      const live = JSON.parse((await raw(port, { path: '/state', headers: { Authorization: `Bearer ${token}` } })).body) as LiveState;
      const part = live.html.slice(live.html.indexOf('<h3 id="room-decisions">'), live.html.indexOf('<div class="room-costs">'));
      expect(part.indexOf('NEEDS YOU: write_project_file (notes/plan.md)')).toBeLessThan(part.indexOf('recipes/tray.params.json changed on disk'));
      expect(part).toContain('<li class="dec dec-approval dec-blocks"');
      expect(part).toContain('<kbd>y: allow it once</kbd>');
      expect(part).not.toContain('data-act=');
      expect(live.toc).toContain('waiting on you');
    } finally {
      call.answer('deny');
      await call.run.catch(() => undefined);
    }
    expect(waitingApprovals()).toEqual([]);
    // Saved again from the file as it is now: the refused save no longer waits.
    const now = sha(readFileSync(join(root, 'recipes/tray.params.json')));
    const saved = await raw(port, { method: 'POST', path: '/edit', headers: json, body: JSON.stringify({ action: 'set-params', recipe: 'tray', base: now, parameters: params }) });
    expect(saved.status).toBe(200);
    const after = titles(text(await ws.decisions('')));
    expect(after.some((t) => t.startsWith('NEEDS YOU'))).toBe(false);
    expect(after.some((t) => t.includes('changed on disk'))).toBe(false);
  });
});

describe('the commands an item gives are typed back exactly', () => {
  it('quoteArg survives Timmy\'s command-line split for spaces, both quotes and plain words', () => {
    for (const s of ['plain', 'two words', 'say "hi"', "it's", `both "double" and 'single'`, '  edges  ']) expect(splitCommandLine(`/x ${quoteArg(s)}`).slice(1)).toEqual([s]);
  });

  it('againCommand reads back as the same /iterate request for each kind of flow', () => {
    const cases: Array<[Record<string, unknown>, string, string | undefined]> = [
      [{ kind: 'iterate', instruction: 'make it "wider"', parameters: { path: 'recipes/tray.params.json' } }, 'tray', undefined],
      [{ kind: 'iterate', target: 'scad', instruction: 'thicker', model: { path: 'my models/box.scad' } }, 'scad', 'my models/box.scad'],
      [{ kind: 'iterate', target: 'freecad', instruction: "it's a hole", script: { path: 'part.py' } }, 'freecad', 'part.py'],
      [{ kind: 'iterate', target: 'blender', instruction: 'red', script: { path: 'scene.py' } }, 'blender', undefined],
      [{ kind: 'iterate', target: 'ae', instruction: 'slower', script: { path: 'title.jsx' } }, 'ae', 'title.jsx'],
    ];
    for (const [record, recipe, file] of cases) {
      const line = againCommand(record)!;
      expect(line.startsWith(`/iterate ${recipe} `)).toBe(true);
      const parsed = parseIterateLine(line.slice('/iterate '.length));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.request).toMatchObject({ recipe, instruction: record.instruction, ...(file ? { file } : {}) });
    }
    expect(againCommand({ kind: 'iterate', target: 'scad', instruction: 'x' })).toBeUndefined();
  });
});

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('room-decisions: no Chromium or Chrome found, so the real-browser check is skipped here');

describe.skipIf(!browserPath)('the Waiting on you part on the live board (headless Chromium, a fresh context)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath }); });
  afterAll(async () => { await browser?.close(); });

  it('draws the items with their commands as text, a NEEDS YOU box first while it waits, and no script or policy error', async () => {
    const { ws } = project();
    await ws.decisions('');
    await ws.boardLive('live');
    const call = waitingCall();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const problems: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
      page.on('pageerror', (e) => problems.push(String(e)));
      await page.goto(ws.liveBoard!.url);
      await page.waitForSelector('#room-decisions');
      const items = page.locator('ol.decisions > li.dec');
      expect(await items.count()).toBe(6);
      expect(await items.first().locator('.dec-title').textContent()).toBe('NEEDS YOU: write_project_file (notes/plan.md)');
      // The hostile instruction is text in the item's command: no element was made from it.
      expect(await page.locator('ol.decisions').innerText()).toContain(`/iterate freecad model.freecad "${HOSTILE}"`);
      expect(await page.evaluate(() => document.querySelectorAll('img').length)).toBe(0);
      // Answered: the box's item goes on the next draw.
      call.answer('deny');
      await call.run.catch(() => undefined);
      await page.waitForFunction(() => !document.querySelector('li.dec-approval'), undefined, { timeout: 8000 });
      expect(problems).toEqual([]);
    } finally {
      call.answer('deny');
      await call.run.catch(() => undefined);
      await context.close();
    }
  }, 40_000);
});
