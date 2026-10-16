/**
 * R4 (H109; the operator's direction of 2026-10-11, "one shared Run detail view, linkable from … Studio nodes … and result
 * cards"): Run detail on Timmy Canvas, in a real headless Chromium against the real canvas server and the real bundle (built
 * here into a temporary folder, as tests/studio-operation-browser.test.ts builds it), with a real temporary project holding one
 * operation (tests/helpers/canvas-operation.ts). The run detail itself is made by src/ops/run-detail.ts (H102), not in this
 * revision yet: a FIXTURE producer, given through the server's options and labelled FIXTURE in every word it makes, stands in
 * for it; a second server, given none, shows what a person sees until the producer is merged. A person's presses are
 * Chromium's own clicks. Every request the page makes goes to 127.0.0.1 (anything else is aborted). Skipped, saying so, where
 * no Chromium or Chrome is found.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUN_DETAIL_VERSION, type RunDetail } from '../src/contracts/run-detail.js';
import { projectId } from '../src/project/index.js';
import { NOT_BUILT, type RunDetailProducer } from '../src/studio/run-detail-route.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { makeCanvasProject, type CanvasProject } from './helpers/canvas-project.js';
import { addOperation, type Operation } from './helpers/canvas-operation.js';
import { grant } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-run-detail-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');
/** Whether H102's producer is in this revision (then a server given none asks it, and "not built" is never said). */
const producerHere = existsSync(join(repo, 'src', 'ops', 'run-detail.ts'));

type Win = { timmyCanvas: { editor: { store: { allRecords: () => Array<{ typeName: string; type?: string; id: string; x?: number; meta: Record<string, unknown> }> } } } };
type Shown = { section: string; label: string; value: string; from: string; command: string };

/** FIXTURE: a run detail as src/ops/run-detail.ts makes one, written here by hand (its paths absolute, as a producer writes them). */
function fixtureDetail(op: string, root: string): RunDetail {
  return {
    version: RUN_DETAIL_VERSION, operation: op, parent: null, children: [],
    project: { name: 'demo', root, id: projectId(root) },
    objective: { value: 'FIXTURE: make the tray 150 mm wide', from: `.timmy/operations/${op}.json` },
    sourceRevision: null,
    verdict: { state: 'completed', words: 'FIXTURE: the tray was rebuilt and its readback matches', from: 'receipt 1a2b3c4d' },
    stage: { current: 'readback', done: 3, total: 3, from: 'results/flows/fa1b2c3d4.json' },
    exits: [{ who: 'recipe runner', code: 0, state: 'exited', from: 'jobs/j1.json' }, { who: 'upmd', code: 2, from: 'jobs/j2.json' }],
    freshness: { state: 'current', why: `FIXTURE: ${root}/recipes/tray.params.json holds the bytes it was built from`, from: 'results/flows/fa1b2c3d4.json' },
    acceptance: { state: 'not reviewed' },
    worker: { harness: { value: 'FIXTURE harness', from: 'jobs/j1.json' } },
    time: { startedAt: '2026-10-11T10:00:00.000Z', endedAt: '2026-10-11T10:02:05.000Z', elapsedMs: 125_000 },
    prediction: { words: 'FIXTURE: 150 x 80 x 30 mm', receipt: '0f0e0d0c', frozenAt: '2026-10-11T09:59:59.000Z' },
    checks: [{ name: 'bounds', predicted: '150 x 80 x 30 mm', actual: '150 x 80 x 30 mm', differs: false, from: 'receipt 1a2b3c4d' }],
    files: [{ path: `${root}/recipes/tray.params.json`, role: 'input', sha256: 'ab'.repeat(32), from: 'receipt 1a2b3c4d' }],
    receipts: [{ id: '1a2b3c4d', kind: 'flow', subject: 'tray' }],
    cost: { usd: null, measured: false, why: 'FIXTURE: no model was called, so no cost was reported' },
    summary: { path: null },
    next: { words: 'FIXTURE: look at the tray, then accept or reject it', command: `/op ${op}` },
    unknown: [{ field: 'sourceRevision', why: 'FIXTURE: no record names the revision it started from' }],
  };
}

describe.skipIf(!browserPath)("Timmy Canvas: an operation's run detail in the side panel, in a real browser", () => {
  let p: CanvasProject;
  let o: Operation;
  let pageRoot = '';
  let home = '';
  let homeB = '';
  let server: StudioServer;
  let serverB: StudioServer;
  let browser: Browser;
  let base = '';
  let baseB = '';
  const asked: Array<{ op: string; project: string }> = [];
  let failing = false;
  // FIXTURE producer: records each call; fails, in words naming a path, when the test says so
  const producer: RunDetailProducer = (op, x) => {
    asked.push({ op, project: x.project });
    if (failing) throw new Error(`FIXTURE: the records of ${x.project}/results could not be read`);
    return fixtureDetail(op, x.project);
  };

  beforeAll(async () => {
    p = await makeCanvasProject('studio-run-detail-browser-');
    o = await addOperation(p);
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-canvas-rd-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-canvas-rd-home-'));
    homeB = mkdtempSync(join(tmpdir(), 'timmy-canvas-rd-homeb-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    // R5 (H133): the page's workspace strip asks the server for the frame, which reads Timmy's settings: this file's own folder
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot, runDetail: producer });
    serverB = await startStudioServer(0, { env: { TIMMY_HOME: homeB, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    baseB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}`;
    for (const [b, s] of [[base, server], [baseB, serverB]] as const) {
      const named = await fetch(`${b}/api/project/active`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.projectToken}` },
        body: JSON.stringify({ root: p.root, name: 'demo', jobs: p.jobs, receipts: p.store }),
      });
      expect(named.status).toBe(200);
    }
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    for (const s of [server, serverB]) await new Promise<void>((done) => (s ? s.close(() => done()) : done()));
    for (const d of [p?.base, pageRoot, home, homeB]) if (d) rmSync(d, { recursive: true, force: true });
  });

  async function open(context: BrowserContext, at: string, s: StudioServer): Promise<{ page: Page; origins: Set<string>; errors: string[] }> {
    const origins = new Set<string>();
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
      origins.add(url.origin);
      return url.origin === at ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${at}/#code=${await grant(Number(new URL(at).port), s.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 15_000 });
    await page.click('#project-by button[data-by="operation"]');
    await page.waitForSelector(`#project-groups section.pop[data-op="${o.op}"] .pop-rd`, { timeout: 15_000 });
    return { page, origins, errors };
  }
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
  /** The run detail as the panel shows it: each row with its section, label, value, record and command. */
  const shown = (page: Page): Promise<Shown[]> => page.evaluate(() => [...document.querySelectorAll('#run-detail-body section.rd-section')].flatMap((s) => {
    const title = s.querySelector('h3')?.textContent ?? '';
    return [...s.querySelectorAll('dt')].map((dt) => {
      const dd = dt.nextElementSibling!;
      return { section: title, label: dt.textContent ?? '', value: dd.querySelector('.rd-value')?.textContent ?? '', from: dd.querySelector('.rd-from')?.textContent ?? '', command: dd.querySelector('.rd-cmd')?.textContent ?? '' };
    });
  }));
  const state = (page: Page, want: string) => page.waitForFunction((w) => document.getElementById('run-detail')?.dataset.state === w, want, { timeout: 15_000 });

  it("shows the operation's run detail from its group in the Project panel and from a card placed for it: the same fields the Workbench shows, each with its record, the verdict, stage, exits, freshness and acceptance apart; Read again asks again; a failure is said in words", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const { page, origins, errors } = await open(context, base, server);
      expect(await page.isHidden('#run-detail')).toBe(true);
      await page.click(`#project-groups section.pop[data-op="${o.op}"] .pop-rd`);
      await state(page, 'shown');
      expect(await page.isVisible('#run-detail')).toBe(true);
      expect(await text(page, '#run-detail-title')).toBe(`Run detail · operation ${o.op}`);
      expect(await text(page, '#run-detail-read')).toMatch(/^Read from Timmy's records at .+\. It does not change by itself: Read again reads it again\.$/);
      const rows = await shown(page);
      const at = (label: string) => rows.find((r) => r.label === label);
      // kept apart: Timmy's verdict, the stage, each exit (a nonzero one as it is), the freshness and a person's acceptance
      expect(rows.filter((r) => r.section === 'State, each kept apart').map((r) => [r.label, r.value, r.from])).toEqual([
        ["Timmy's verdict", 'completed: FIXTURE: the tray was rebuilt and its readback matches', 'from receipt 1a2b3c4d'],
        ['workflow stage', 'readback · 3 of 3 steps done', 'from results/flows/fa1b2c3d4.json'],
        ['exit of recipe runner', 'exit 0 (exited)', 'from jobs/j1.json'],
        ['exit of upmd', 'exit 2', 'from jobs/j2.json'],
        ['artifact freshness', 'current: FIXTURE: ./recipes/tray.params.json holds the bytes it was built from', 'from results/flows/fa1b2c3d4.json'],
        ["a person's acceptance", 'not reviewed', ''],
      ]);
      expect(at('request')).toMatchObject({ value: 'FIXTURE: make the tray 150 mm wide', from: `from .timmy/operations/${o.op}.json` });
      expect(at('project')!.value).toBe('demo');
      expect(at('input')).toMatchObject({ value: `./recipes/tray.params.json · sha256 ${'ab'.repeat(6)}`, from: 'from receipt 1a2b3c4d' });
      expect(at('cost')).toMatchObject({ value: 'unknown: FIXTURE: no model was called, so no cost was reported', from: '' });
      expect(at('time')!.value).toBe('2 min 5 s');
      expect(at('next')).toMatchObject({ value: 'FIXTURE: look at the tray, then accept or reject it', command: `/op ${o.op}` });
      const all = await text(page, '#run-detail');
      expect(all).not.toContain('%');
      expect(all).not.toContain(p.root);
      expect(all).not.toContain(tmpdir());
      expect(asked).toEqual([{ op: o.op, project: p.root }]);
      await page.click('#run-detail-close');
      expect(await page.isHidden('#run-detail')).toBe(true);

      // the operation's cards, placed: each names its operation and offers Run detail beside Details
      await page.click(`#project-groups section.pop[data-op="${o.op}"] .pop-place`);
      await page.waitForFunction(() => /^Operation /.test(document.getElementById('project-said')?.textContent ?? ''), null, { timeout: 15_000 });
      const cards = await page.evaluate((op) => (window as never as Win).timmyCanvas.editor.store.allRecords()
        .filter((r) => r.typeName === 'shape' && typeof r.type === 'string' && r.type.startsWith('timmy-') && r.meta?.timmyOperation === op)
        .sort((a, b) => (a.x ?? 0) - (b.x ?? 0)).map((r) => r.id), o.op);
      expect(cards.length).toBeGreaterThanOrEqual(3);
      await page.waitForFunction((ids) => ids.every((id) => document.querySelector(`[data-timmy-card="${id}"] .tc-rd`)), cards, { timeout: 15_000 });
      for (const id of cards) expect(await text(page, `[data-timmy-card="${id}"] .tc-rd`)).toBe('Run detail');
      const board = () => page.evaluate(() => (window as never as Win).timmyCanvas.editor.store.allRecords().filter((r) => r.typeName === 'shape').map((r) => r.id).sort());
      const before = await board();
      await page.click(`[data-timmy-card="${cards[cards.length - 1]}"] .tc-rd`);
      await state(page, 'shown');
      expect(await text(page, '#run-detail-title')).toBe(`Run detail · operation ${o.op}`);
      expect((await shown(page)).map((r) => [r.section, r.label, r.value])).toEqual(rows.map((r) => [r.section, r.label, r.value]));
      expect(asked).toHaveLength(2);
      // the press changed nothing on the board
      expect(await board()).toEqual(before);
      // screenshots for a look by eye, only when TIMMY_CANVAS_SHOTS names a folder: otherwise a run leaves nothing behind
      if (process.env.TIMMY_CANVAS_SHOTS) {
        await page.screenshot({ path: join(process.env.TIMMY_CANVAS_SHOTS, 'run-detail-1440x900.png') });
        await page.evaluate(() => document.querySelector('#run-detail-body section:nth-of-type(2)')?.scrollIntoView({ block: 'start' }));
        await page.locator('#side').screenshot({ path: join(process.env.TIMMY_CANVAS_SHOTS, 'run-detail-panel-state.png') });
      }

      // Read again asks again; a producer that fails is said in Timmy's words (no path), with the command that shows it today
      failing = true;
      await page.click('#run-detail-again');
      await state(page, 'refused');
      expect(asked).toHaveLength(3);
      expect(await text(page, '#run-detail-body .rd-refused')).toBe(`The run detail of ${o.op} could not be made: FIXTURE: the records of ./results could not be read`);
      expect(await text(page, '#run-detail-body p:last-child')).toBe(`In Timmy: /op ${o.op}`);
      expect(await page.locator('#run-detail-body section.rd-section').count()).toBe(0);
      expect(await text(page, '#run-detail-read')).toMatch(/^Asked at .+\.$/);
      failing = false;
      expect([...origins].every((x) => x === base)).toBe(true);
      // Chromium's own line for the 500 this test asked for; nothing else
      expect(errors).toEqual(['Failed to load resource: the server responded with a status of 500 (Internal Server Error)']);
    } finally {
      failing = false;
      await context.close();
    }
  }, 180_000);

  it.skipIf(producerHere)('until src/ops/run-detail.ts is merged, Run detail says it is not built in this revision yet, and the command that shows the operation today', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const { page, origins, errors } = await open(context, baseB, serverB);
      await page.click(`#project-groups section.pop[data-op="${o.op}"] .pop-rd`);
      await state(page, 'not-built');
      expect(await text(page, '#run-detail-title')).toBe(`Run detail · operation ${o.op}`);
      // said plainly: "not built yet" is not a refusal
      expect(await text(page, '#run-detail-body .rd-said')).toBe(NOT_BUILT(o.op));
      expect(await page.locator('#run-detail-body .rd-refused').count()).toBe(0);
      expect(await text(page, '#run-detail-body p:last-child')).toBe(`In Timmy: /op ${o.op}`);
      expect(await text(page, '#run-detail-body .rd-cmd')).toBe(`/op ${o.op}`);
      expect([...origins].every((x) => x === baseB)).toBe(true);
      // Chromium's own line for the 501 (not built) it answered; nothing else
      expect(errors).toEqual(['Failed to load resource: the server responded with a status of 501 (Not Implemented)']);
    } finally {
      await context.close();
    }
  }, 180_000);
});
