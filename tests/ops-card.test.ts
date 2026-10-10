/**
 * Round R4 (H51): the operation card (/op, /ops, the top of the board's Control Room): each item checked against its
 * receipt (an output changed since shows stale, one removed shows missing), the lessons that name it (an absent folder
 * tolerated, an unreadable file named), every string escaped on the board; the Control Room's runs grouped by operation,
 * each with its role; and the card on the live board in a real headless Chromium (skipped when none is found).
 *
 * The flow is real (src/repl/iterate-scad.ts through this process's Workspace, its receipts on the project's own chain).
 * FAKE pieces, each labelled: the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing sent;
 * PYFILE/PYREPLACE edit the parameter file), OpenSCAD is tests/fixtures/fake-openscad.mjs (a TEST DOUBLE with no geometry
 * engine). The lessons are SYNTHETIC files in the shape Timmy Memory writes (timmy.lesson/1). The card in the escaping
 * test is a SYNTHETIC object whose every string is hostile markup.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { request } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { annotateRoom, buildIndex, roleOf, type OperationCard } from '../src/ops/card.js';
import { operationCardHtml, operationsHtml } from '../src/ops/card-html.js';
import { kit as boardKit } from '../src/repl/board-kit.js';
import { BOARD_FILE } from '../src/repl/board.js';
import { projectId } from '../src/project/index.js';
import { readChain } from '../src/utils/receipts.js';
import { json, opsKit, replOf, sandbox, text, type OpsKit, type Sandbox } from './helpers/ops-sandbox.js';

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find((p): p is string => Boolean(p) && fs.existsSync(p!));
if (!browserPath) console.warn('ops-card: no Chromium or Chrome found, so the real-browser check is skipped here');

/** Hostile markup in the instruction, which the request, the flow record and the card all carry. */
const HOSTILE = '<img src=x onerror=alert(1)> & <b>wider</b>';
const INSTRUCTION = `${HOSTILE} PYFILE:box.params.json PYREPLACE:60,=>100,`;

/** A real /iterate scad flow with the FAKE agent and FAKE OpenSCAD, ended: its operation, flow and outputs. */
async function flowRun(k: OpsKit, s: Sandbox) {
  const { ws } = replOf(k, s);
  const line = `/iterate scad box.scad "${INSTRUCTION}"`;
  const out = text(await ws.operate(line, 'repl', () => ws.iterate(`scad box.scad "${INSTRUCTION}"`)));
  const h = ws.ops.latest!;
  const flow = /\b(f[0-9a-f]{8})\b/.exec(out)?.[1];
  if (!flow) throw new Error(out);
  await ws.ops.done(h);
  const record = json(path.join(s.root, 'results', 'flows', `${flow}.json`));
  const stl = (record.openscad as { stl: { path: string; sha256: string } }).stl;
  const png = (record.openscad as { png: { path: string; sha256: string } }).png;
  const agent = (record.agent as { run: string }).run;
  return { ws, op: h.id, flow, record, stl, png, agent };
}

describe('the operation card, each item checked against its receipt', () => {
  it('verified as sealed; an output changed since shows stale, one removed shows missing; lessons named and checked, an unreadable one named', async () => {
    const s = sandbox(kit, 'ops-card-');
    const { ws, op, flow, record, stl, png, agent } = await flowRun(kit, s);
    expect(record).toMatchObject({ outcome: 'succeeded', operation: op });

    let card = text(ws.op(op));
    expect(card).toContain(`Operation ${op}  succeeded`);
    expect(card).toContain(`Request    /iterate scad box.scad "${INSTRUCTION}" · repl`);
    expect(card).toMatch(new RegExp(`Flow\\s+${flow}\\s+scad\\s+succeeded`));
    expect(card).toMatch(/verified: receipt [0-9a-f]{8} sealed this record's bytes/);
    expect(card).toMatch(/Output\s+box\.params\.json\s+the editable source \(its parameters\) · by flow f[0-9a-f]{8}\n\s+verified: sha256 [0-9a-f]{12}, as receipt [0-9a-f]{8} sealed its record/);
    expect(card).toContain(`Output     ${stl.path}  STL · by flow ${flow}`);
    expect(card).toContain(`Output     ${png.path}  render · by flow ${flow}`);
    expect(card).toContain(`/measure ${stl.path} · /inspect ${stl.path}`);
    // The lessons folder is not there: tolerated, said in words.
    expect(card).toContain('Lessons    none in .timmy/memory/lessons names this operation or its records');
    expect(card).not.toContain('Unreadable');
    // Its runs, each with its role; the flow's own jobs are shown with it, not again.
    expect(card).toContain(`flow ${flow}  builder and checker  succeeded`);
    expect(card).toContain(`agent ${agent}  builder  completed`);
    expect(card).not.toMatch(/\njob j[0-9a-f]{6}  role not recorded/);

    // SYNTHETIC lessons, in the shape Timmy Memory writes: one naming the STL with its sha256 and the flow's receipt, one
    // about another operation, a file that is not JSON, one of another schema.
    const flowReceipt = readChain('runs', s.root).find((r) => r.kind === 'flow')!;
    const lessons = path.join(s.root, '.timmy', 'memory', 'lessons');
    fs.mkdirSync(lessons, { recursive: true });
    fs.writeFileSync(path.join(lessons, 'l0000001.json'), JSON.stringify({ schema: 'timmy.lesson/1', id: 'l0000001', text: 'Widening the <b>box</b> keeps its lid gap', status: 'checked', evidence: [{ path: stl.path, sha256: stl.sha256, receipt: flowReceipt.hash }], operation: null }));
    fs.writeFileSync(path.join(lessons, 'l0000002.json'), JSON.stringify({ schema: 'timmy.lesson/1', id: 'l0000002', text: 'about something else', status: 'draft', evidence: [{ path: 'notes.md', sha256: 'ab'.repeat(32), receipt: null }], operation: 'o00000000' }));
    fs.writeFileSync(path.join(lessons, 'broken.json'), '{ not JSON');
    fs.writeFileSync(path.join(lessons, 'other.json'), JSON.stringify({ schema: 'timmy.note/1' }));
    card = text(ws.op(op));
    expect(card).toContain('Lesson     l0000001  checked  Widening the <b>box</b> keeps its lid gap');
    expect(card).toContain(`${stl.path} · receipt ${flowReceipt.hash.slice(7, 19)}: verified: sha256 ${stl.sha256.slice(0, 12)} now as when it was checked; its receipt is on the chain`);
    expect(card).not.toContain('l0000002');
    expect(card).toContain('Unreadable .timmy/memory/lessons/broken.json: it is not JSON');
    expect(card).toContain('Unreadable .timmy/memory/lessons/other.json: not a timmy.lesson/1 lesson');

    // The STL changed since its run, the render removed: stale and missing; the lesson naming the STL says so.
    fs.appendFileSync(path.join(s.root, stl.path), 'changed after the flow\n');
    fs.rmSync(path.join(s.root, png.path));
    card = text(ws.op(op));
    expect(card).toMatch(new RegExp(`Output\\s+${stl.path.replace(/[.]/g, '\\.')}  STL · by flow ${flow}\\n\\s+stale: changed since its run: sha256 [0-9a-f]{12} now, ${stl.sha256.slice(0, 12)} as recorded`));
    expect(card).toMatch(new RegExp(`Output\\s+${png.path.replace(/[.]/g, '\\.')}  render · by flow ${flow}\\n\\s+missing: gone since its run \\(it was sha256 ${png.sha256.slice(0, 12)}\\)`));
    expect(card).toContain('Lesson     l0000001  checked, but its evidence changed since');
    expect(card).toMatch(/receipt [0-9a-f]{12}: stale: changed since its run/);
    // The flow record itself is unchanged: still verified.
    expect(card).toMatch(/verified: receipt [0-9a-f]{8} sealed this record's bytes/);

    // /ops lists it; the board's snapshot carries its card at the top of the Control Room, escaped.
    expect(text(ws.opsView(''))).toMatch(new RegExp(`${op}  succeeded\\s+/iterate scad box\\.scad`));
    ws.board('');
    const html = fs.readFileSync(path.join(s.root, BOARD_FILE), 'utf8');
    const at = html.indexOf(`data-op="${op}"`);
    expect(at).toBeGreaterThan(html.indexOf('id="room-operations"'));
    expect(at).toBeLessThan(html.indexOf('id="room-running"'));
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>wider</b>');
    expect(html).not.toContain('<b>box</b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &lt;b&gt;wider&lt;/b&gt;');
    expect(html).toContain(`<a class="file" href="../../${stl.path}">${stl.path}</a>`);
    expect(html).not.toContain(s.base);
  }, 120_000);
});

describe('the operation card on the board: escaped, every string', () => {
  it('a SYNTHETIC card whose every string is hostile markup is drawn as text, on the snapshot and the live board', () => {
    const x = '<script>alert(1)</script>"\'&';
    const check = { status: 'stale' as const, words: x, receipt: x };
    const card: OperationCard = {
      id: 'o0123abcd', request: x, via: x, state: x, tone: 'attention', why: x, note: x, started: x, ended: x, parent: x, record: x,
      workflows: [{ doc: x, block: x, job: x, state: x, tone: 'ok', steps: [{ name: x, state: x, role: x, owner: x, receipt: x }], check, commands: [x] }],
      flows: [{ id: x, kind: x, instruction: x, outcome: x, verdict: x, tone: 'failed', steps: [{ name: x, state: 'failed', code: 3, role: x }], file: x, check, commands: [x] }],
      outputs: [{ path: x, role: x, by: x, sha256: x, check, commands: [x] }],
      vox: [{ id: x, file: x, action: x, status: x, tone: 'ok', inputs: [x], values: [x], about: 'its outputs', check, commands: [x] }],
      lessons: [{ id: x, file: x, text: x, status: x, tone: 'attention', evidence: [{ what: x, check }], commands: [x] }],
      lessonErrors: [x], runs: [{ kind: x, id: x, role: x, state: x, tone: 'neutral' }], receipts: [{ id: x, kind: x }], commands: [x],
    };
    for (const live of [false, true]) {
      const html = operationsHtml([card], boardKit({ live, base: '../../' }));
      expect(html).not.toContain('<script>');
      expect(html).not.toMatch(/="[^"]*"'&[^"]*"/);
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;');
      expect(html).toContain('data-op="o0123abcd"');
      expect(html).not.toMatch(/\sstyle=/);
      // Each part, each check and each command is there, as words.
      for (const part of ['Workflow', 'Flows', 'Native outputs', 'VoxVision', 'Lessons', 'Runs, by role']) expect(html).toContain(`<h5>${part} <span class="count">1</span></h5>`);
      // A check each: the workflow's, the flow's, the output's, the VoxVision record's, the lesson's evidence.
      expect(html.match(/class="op-check op-check-stale"><b>stale<\/b>/g)?.length).toBe(5);
    }
    expect(operationCardHtml(card, boardKit({ live: false, base: '../../' }))).toMatch(/^<article class="card op-card op-tone-attention" data-op="o0123abcd">/);
  });
});

describe('the Control Room: runs grouped by operation, each with its role', () => {
  it('roles come from each run\'s kind, never guessed', () => {
    expect(roleOf('chat')).toBe('planner');
    expect(roleOf('agent')).toBe('builder');
    expect(roleOf('native')).toBe('builder');
    expect(roleOf('recipe')).toBe('builder');
    expect(roleOf('flow')).toBe('builder and checker');
    expect(roleOf('look')).toBe('observer');
    expect(roleOf('vox')).toBe('observer');
    expect(roleOf('job', 'readback out/x.step · flow f00000001')).toBe('checker');
    expect(roleOf('job', 'vox inspect a.png · Look (OpenCV)')).toBe('observer');
    expect(roleOf('job', 'look refs/a.png')).toBe('observer');
    expect(roleOf('job', 'preview npm run dev')).toBe('role not recorded');
    expect(roleOf('mcp')).toBe('role not recorded');
    expect(roleOf('flow', '', 'agent')).toBe('builder');
    expect(roleOf('flow', '', 'readback')).toBe('checker');
    expect(roleOf('flow', '', 'checks')).toBe('checker');
    expect(roleOf('flow', '', 'publish')).toBe('role not recorded');
  });

  it('/room: the operations first (running first), each with its runs and their roles; each run says its operation and role', async () => {
    const s = sandbox(kit, 'ops-room-');
    const { ws, op, flow, agent } = await flowRun(kit, s);
    const room = text(await ws.room(''));
    const lines = room.split('\n');
    const opsAt = lines.findIndex((l) => l.startsWith('  OPERATIONS'));
    expect(opsAt).toBeGreaterThan(0);
    expect(opsAt).toBeLessThan(lines.findIndex((l) => l.startsWith('  RUNNING NOW')));
    expect(room).toMatch(new RegExp(`${op}  succeeded  /iterate scad box\\.scad`));
    expect(room).toContain(`        flow ${flow}  builder and checker · succeeded`);
    expect(room).toContain(`        agent ${agent}  builder · completed`);
    // Each run below names its role and its operation (as its own record names it).
    expect(room).toMatch(new RegExp(`role builder · operation ${op} · the agent step of flow ${flow}`));
    expect(room).toMatch(new RegExp(`role builder and checker · operation ${op}`));
    // One run in full: its role and its operation's card.
    const one = text(await ws.room(agent));
    expect(one).toContain(`Role`);
    expect(one).toContain(`builder · operation ${op} (/op ${op})`);
  }, 120_000);

  it('annotateRoom: a run is given the operation its own record or receipt names, and none when nothing names one', () => {
    const s = sandbox(kit, 'ops-annotate-');
    const ix = buildIndex({ root: s.root, projectId: projectId(s.root), chain: [], jobs: [], scrub: (t) => t });
    const jobs = [{ id: 'j000001', operation: 'o00000001' }, { id: 'j000002' }] as unknown as Parameters<typeof annotateRoom>[2];
    const room = { all: [
      { kind: 'job', id: 'j000001', step: 'readback a.step' },
      { kind: 'job', id: 'j000002', step: 'preview the project' },
      { kind: 'look', id: 'j000003', job: 'j000001', step: 'look refs/a.png' },
      { kind: 'chat', id: 'abcd1234' },
    ] as Array<{ kind: string; id: string; job?: string; step?: string; operation?: string; role?: string }> };
    annotateRoom(room, ix, jobs);
    expect(room.all.map((r) => [r.id, r.operation ?? null, r.role])).toEqual([
      ['j000001', 'o00000001', 'checker'],
      ['j000002', null, 'role not recorded'],
      ['j000003', 'o00000001', 'observer'],
      ['abcd1234', null, 'planner'],
    ]);
  });
});

function get(port: number, token: string, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((done, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path: pathname, setHost: false, agent: false, headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe.skipIf(!browserPath)('the operation card on the live board, in a real browser (headless Chromium, a fresh context)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath }); });
  afterAll(async () => { await browser?.close(); });

  it('tops the Control Room: the request as text (its markup never drawn), the flow and its steps with their roles, the outputs checked, the commands; no CSP or script error', async () => {
    const s = sandbox(kit, 'ops-card-browser-');
    const { ws, op, flow, stl } = await flowRun(kit, s);
    await ws.boardLive('live');
    const { url, port } = ws.liveBoard!;
    // The live state's HTML carries the card too.
    const state = await get(port, url.split('#t=')[1], '/state');
    expect(state.status).toBe(200);
    expect((JSON.parse(state.body) as { html: string }).html).toContain(`data-op="${op}"`);

    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(url);
    const card = page.locator(`article.op-card[data-op="${op}"]`);
    await card.waitFor({ timeout: 10_000 });
    expect(await card.isVisible()).toBe(true);
    // The first card of the section, above the runs.
    const order = await page.evaluate((id) => {
      const c = document.querySelector(`article.op-card[data-op="${id}"]`)!;
      const running = document.getElementById('room-running')!;
      return [Boolean(c.compareDocumentPosition(running) & Node.DOCUMENT_POSITION_FOLLOWING), document.querySelector('#room-operations')?.textContent ?? ''];
    }, op);
    expect(order[0]).toBe(true);
    expect(order[1]).toMatch(/^Operations/);
    expect(await card.locator('.op-id').textContent()).toBe(`Operation ${op}`);
    expect(await card.locator('.op-request code').textContent()).toBe(`/iterate scad box.scad "${INSTRUCTION}"`);
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(await card.locator('.op-request b').count()).toBe(0);
    expect(await card.locator('.op-name', { hasText: `flow ${flow}` }).count()).toBe(1);
    expect(await card.locator(`ol.op-steps[aria-label="the steps of flow ${flow}"] .op-role`).allTextContents()).toContain('builder');
    const stlItem = card.locator('li.op-item', { hasText: stl.path });
    expect(await stlItem.locator('.op-check b').first().textContent()).toBe('verified');
    expect(await card.locator(`button.cmd[data-cmd="/op ${op}"]`).count()).toBe(1);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(s.base);
    expect(problems).toEqual([]);
    await context.close();
  }, 120_000);
});
