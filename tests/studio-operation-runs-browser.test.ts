/**
 * R4 (H109; r25 D9 c and the operator's "Bind workflow/result nodes to real operation and artifact IDs"): a workflow card placed
 * for an operation shows that operation's own run of its document, and the newest run (another operation's, run since) beside
 * it, never in its place; in a real headless Chromium against the real canvas server and the real bundle (built here into a
 * temporary folder, as tests/studio-operation-browser.test.ts builds it), with a real temporary project: operation X
 * (tests/helpers/canvas-operation.ts: its record, its workflow job started inside it by the real JobManager, a flow and a
 * VoxVision record naming it), then operation Y running the same document again. FAKE: each job's program is node itself,
 * standing in for upmd (no workflow block runs); FIXTURES: the flow and VoxVision records, and the run detail (a FIXTURE
 * producer, labelled FIXTURE, stands in for src/ops/run-detail.ts, not in this revision). A person's presses are Chromium's
 * own clicks. Every request the page makes goes to 127.0.0.1 (anything else is aborted). Skipped, saying so, where no Chromium
 * or Chrome is found.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUN_DETAIL_VERSION, type RunDetail } from '../src/contracts/run-detail.js';
import { JobManager } from '../src/jobs/index.js';
import { inOperation } from '../src/ops/context.js';
import { projectId } from '../src/project/index.js';
import type { RunDetailProducer } from '../src/studio/run-detail-route.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { makeCanvasProject, type CanvasProject } from './helpers/canvas-project.js';
import { addOperation, writeOperation, type Operation } from './helpers/canvas-operation.js';
import { grant } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-operation-runs-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const X = 'oa1b2c3d4';
const Y = 'ob1b2c3d4';
type Win = { timmyCanvas: { editor: { store: { allRecords: () => Array<{ typeName: string; type?: string; id: string; props: Record<string, unknown>; meta: Record<string, unknown> }> } } } };

/** FIXTURE: the least run detail the route shows (src/ops/run-detail.ts makes the real one), its words labelled FIXTURE. */
const fixtureDetail = (op: string, root: string): RunDetail => ({
  version: RUN_DETAIL_VERSION, operation: op, parent: null, children: [], project: { name: 'demo', root, id: projectId(root) },
  objective: { value: `FIXTURE: the request of ${op}`, from: `.timmy/operations/${op}.json` }, sourceRevision: null,
  verdict: { state: 'completed', words: 'FIXTURE: completed', from: `.timmy/operations/${op}.json` },
  stage: { current: null, done: 1, total: 1, from: `.timmy/operations/${op}.json` }, exits: [],
  freshness: { state: 'unknown', why: 'FIXTURE: not checked' }, acceptance: { state: 'not reviewed' }, worker: {},
  time: { startedAt: null, endedAt: null, elapsedMs: null }, prediction: null, checks: [], files: [], receipts: [],
  cost: { usd: null, measured: false, why: 'FIXTURE: no cost was reported' }, summary: { path: null }, next: null, unknown: [],
});

describe.skipIf(!browserPath)("Timmy Canvas: a workflow card placed for an operation shows that operation's own run, in a real browser", () => {
  let p: CanvasProject;
  let x: Operation;
  let pageRoot = '';
  let home = '';
  let server: StudioServer;
  let browser: Browser;
  let base = '';
  const asked: string[] = [];
  const producer: RunDetailProducer = (op, o) => { asked.push(op); return fixtureDetail(op, o.project); };

  beforeAll(async () => {
    p = await makeCanvasProject('studio-operation-runs-browser-');
    x = await addOperation(p, X);
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-canvas-runs-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-canvas-runs-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    // R5 (H133): the page's workspace strip asks the server for the frame, which reads Timmy's settings: this file's own folder
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot, runDetail: producer });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const named = await fetch(`${base}/api/project/active`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.projectToken}` },
      body: JSON.stringify({ root: p.root, name: 'demo', jobs: p.jobs, receipts: p.store }),
    });
    expect(named.status).toBe(200);
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of [p?.base, pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
  const waitText = (page: Page, sel: string, re: RegExp) => page.waitForFunction(([s, src]) => new RegExp(src).test((document.querySelector(s)?.textContent ?? '').replace(/\s+/g, ' ').trim()), [sel, re.source] as const, { timeout: 20_000 });

  it("keeps X's own run on X's workflow card after Y ran the document again, with Y's newest run beside it; a card placed by Place card shows the newest; Run detail is X's", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const origins = new Set<string>();
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
        origins.add(url.origin);
        return url.origin === base ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(`${base}/#code=${await grant(Number(new URL(base).port), server.projectToken)}`);
      await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
      await page.click('#project-by button[data-by="operation"]');
      await page.waitForSelector(`#project-groups section.pop[data-op="${X}"] .pop-place`, { timeout: 20_000 });
      await page.click(`#project-groups section.pop[data-op="${X}"] .pop-place`);
      await page.waitForFunction(() => /^Operation /.test(document.getElementById('project-said')?.textContent ?? ''), null, { timeout: 15_000 });
      const xwf = await page.evaluate((op) => (window as never as Win).timmyCanvas.editor.store.allRecords()
        .find((r) => r.typeName === 'shape' && r.type === 'timmy-workflow' && r.meta?.timmyOperation === op)?.id, X);
      expect(xwf).toBeTruthy();
      const at = `[data-timmy-card="${xwf}"]`;
      // its run is the newest now: said as its own run, with no "now" line
      await waitText(page, `${at} .tc-last`, new RegExp(`^Run of operation ${X} \\(build\\): completed`));
      expect(await page.locator(`${at} .tc-now-run`).count()).toBe(0);
      expect(await text(page, `${at} .tc-op`)).toBe(`operation ${X}`);

      // Y runs RUN.md › build again (its own record, a job started inside it): the newest run is Y's now
      writeOperation(p, { id: Y, request: '/run RUN.md build' });
      const manager = new JobManager({ dir: p.jobs });
      const y = inOperation({ id: Y }, () => manager.start({ kind: 'workflow', label: 'RUN.md › build', project: 'demo', root: p.root, command: process.execPath, args: ['-e', 'setTimeout(() => {}, 20)'] }));
      await manager.done(y.id);
      await waitText(page, `${at} .tc-now-run`, new RegExp(`^now: the newest run of RUN\\.md \\(build\\) is completed, by operation ${Y}$`));
      // X's card still says X's run, and names X: never Y's run in its place
      expect(await text(page, `${at} .tc-last`)).toMatch(new RegExp(`^Run of operation ${X} \\(build\\): completed`));
      expect(await text(page, `${at} .tc-op`)).toBe(`operation ${X}`);
      await page.click(`${at} .tc-toggle`);
      await waitText(page, `${at} .tc-details`, new RegExp(`run of operation ${X}job ${x.job.id}`));
      expect(await text(page, `${at} .tc-details`)).toContain(`newest runjob ${y.id}`);
      // its Run detail is X's
      await page.click(`${at} .tc-rd`);
      await page.waitForFunction(() => document.getElementById('run-detail')?.dataset.state === 'shown', null, { timeout: 15_000 });
      expect(await text(page, '#run-detail-title')).toBe(`Run detail · operation ${X}`);
      expect(asked.at(-1)).toBe(X);

      // the document's own card (Place card in the list) shows the newest run, Y's, as before
      await page.click('#project-by button[data-by="kind"]');
      await page.click('#project-groups li.pcard[data-card="workflow:RUN.md"] .pcard-drawn');
      await page.waitForFunction(() => /^Placed card/.test(document.getElementById('project-said')?.textContent ?? ''), null, { timeout: 15_000 });
      const plain = await page.evaluate(() => (window as never as Win).timmyCanvas.editor.store.allRecords()
        .find((r) => r.typeName === 'shape' && r.type === 'timmy-workflow' && !r.meta?.timmyOperation)?.id);
      await waitText(page, `[data-timmy-card="${plain}"] .tc-last`, /^Newest run \(build\): completed/);
      expect(await text(page, `[data-timmy-card="${plain}"] .tc-op`)).toBe(`operation ${Y}`);
      expect(await page.locator(`[data-timmy-card="${plain}"] .tc-now-run`).count()).toBe(0);
      if (process.env.TIMMY_CANVAS_SHOTS) await page.screenshot({ path: join(process.env.TIMMY_CANVAS_SHOTS, 'operation-runs-1440x900.png') });
      expect([...origins].every((o) => o === base)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 180_000);
});
