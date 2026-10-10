/**
 * Round R4 (H75): Timmy Canvas's own drawn cards (companion/studio-canvas/src/cards.js) in a real headless Chromium, against
 * the real canvas server, the real bundle (built here into a temporary folder, as tests/studio-project-browser.test.ts builds
 * it), a real temporary project (tests/helpers/canvas-project.ts) and the REPL's side for real: a Workspace whose /run uses
 * tests/fixtures/fake-upmd.mjs (a labelled TEST DOUBLE of upmd 0.2.7) and whose /recipe tray uses a FAKE recipe executor
 * (SYNTHETIC files, no CadQuery), and a CanvasProject that names the project with its holder id and takes the cards' actions.
 * Receipts are sealed by appendReceipt into a temporary store. The page is opened as /canvas open opens it (its one-time grant
 * in the address's fragment). Every request the page makes goes to 127.0.0.1 (anything else is aborted). Skipped, saying so,
 * where no Chromium or Chrome is found.
 */
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPORTS } from '../src/recipes/index.js';
import { folderProject, projectId } from '../src/project/index.js';
import { CanvasProject } from '../src/repl/canvas-project.js';
import { Workspace } from '../src/repl/workspace.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { HOSTILE_TITLE, makeCanvasProject, type CanvasProject as Fixture } from './helpers/canvas-project.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-cards-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const F = '```';
/** A document upmd runs: its second block takes 3 s, so the card is seen while it runs. */
const RUN_DOC = ['# Make', '', 'Prose that stays.', '', `${F}bash [name:setup]`, 'mkdir -p dist', F, '', `${F}bash [name:build, deps:setup]`, 'sleep 3; echo built > dist/out.txt', F, ''].join('\n');
const TRAY = 'recipes/tray.params.json';

/** A FAKE recipe executor (the jobs.ts seam, as tests/board-edits.test.ts writes it): SYNTHETIC files, signed receipts, no geometry. */
function fakeExecutor(dir: string): string {
  const file = join(dir, 'fake-recipe-complete.mts');
  const mod = (name: string) => JSON.stringify(pathToFileURL(resolve(name)).href);
  writeFileSync(file, `
// FAKE recipe executor (test fixture): SYNTHETIC files only; no CadQuery, no Open3D, no Python.
import fs from 'node:fs'; import path from 'node:path'; import {randomUUID} from 'node:crypto';
import {loadJob,jobDirectory,recordResult} from ${mod('lanes/recipes/jobs.ts')};
import {appendReceipt} from ${mod('src/utils/receipts.ts')};
import {sha,prediction,validate} from ${mod('lanes/recipes/tray.ts')};
const [,root,id]=process.argv.slice(2), job=loadJob(root,id), dir=jobDirectory(root,id), workspace=path.join(dir,'workspace');
const p=validate(job.request), pred=prediction(p);
const run=randomUUID(), base=path.join(workspace,'.timmy','recipe-runs',run);fs.mkdirSync(base,{recursive:true});
fs.writeFileSync(path.join(base,'request.json'),JSON.stringify(job.request));
fs.writeFileSync(path.join(base,'prediction.json'),JSON.stringify(pred,null,2)+'\\n');
fs.writeFileSync(path.join(base,'build.py'),'SYNTHETIC fixture source; not the recipe');
const common={subject:'SYNTHETIC recipe fixture; no geometry claim',policy:'auto',cost_usd:0};
const prediction_=appendReceipt('runs',{...common,status:'ok',kind:'recipe.prediction',sources:['request.json','prediction.json','build.py'].map(n=>({path:path.join(base,n),sha256:sha(fs.readFileSync(path.join(base,n)))}))},workspace);
const native=path.join(base,'native');fs.mkdirSync(native);
const exports=${JSON.stringify(EXPORTS)}.map(f=>{fs.writeFileSync(path.join(native,f),'SYNTHETIC '+f+'; not geometry');return {file:f,sha256:sha(fs.readFileSync(path.join(native,f)))};});
const labels=[...Array.from({length:12},(_,i)=>'Stage check '+(i+1)),'Native bounds','Native analytic volume','Native valid single solid','STEP reimport bounds','STEP reimport analytic volume','STEP reimport valid single solid','STL closed, manifold, orientable','STL one component, no self intersections','STL volume agrees within 0.1%','Every construction stage validated',...Array.from({length:8},(_,i)=>'axis '+(i+1))];
const result={schema:'timmy.tray-build/1',engine:'SYNTHETIC fixture',synthetic:true,variant:{measured:{bounds:pred.bounds,volume:pred.volumeMm3},mesh:{engine:'SYNTHETIC mesh fixture'},checks:labels.map((label,i)=>({id:'geometry.'+String(i+1).padStart(2,'0'),label,passed:true}))}};
fs.writeFileSync(path.join(native,'result.json'),JSON.stringify(result));
fs.writeFileSync(path.join(base,'native.log'),'SYNTHETIC native log');
const sources=[path.join(native,'result.json'),path.join(base,'native.log'),...exports.map(e=>path.join(native,e.file))].map(f=>({path:f,sha256:sha(fs.readFileSync(f))}));
const receipt=appendReceipt('runs',{...common,status:'ok',kind:'recipe.build',child_receipts:[prediction_.id],sources},workspace);
const report={state:'succeeded',run,parameters:p,predictionReceipt:prediction_.id,receipt:receipt.id,receiptHash:receipt.hash,checksPassed:30,exports};
fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(report,null,2)+'\\n');
recordResult(root,id,{...report,directory:base});
`);
  return file;
}

type Win = { timmyCanvas: { placeDrawnCard: (id: string) => Promise<{ shape: string; type: string }>; editor: {
  getShape: (id: string) => { type: string; props: Record<string, unknown> } | undefined; store: { allRecords: () => Array<{ typeName: string; type?: string; id: string }> };
  getShapePageBounds: (id: string) => { center: { x: number; y: number } } | undefined; centerOnPoint: (p: { x: number; y: number }, o?: unknown) => void;
} } };

describe.skipIf(!browserPath)("Timmy Canvas's own drawn cards in a real browser", () => {
  let p: Fixture;
  const dirs: string[] = [];
  const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
  let pageRoot = '';
  let home = '';
  let storeBase = '';
  let store = '';
  let server: StudioServer;
  let ws: Workspace;
  let cp: CanvasProject;
  let browser: Browser;
  let base = '';
  const notes: string[] = [];
  const supervisors: Promise<void>[] = [];
  const receipts = (): Array<Record<string, unknown>> => { try { return readFileSync(join(store, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>); } catch { return []; } };

  beforeAll(async () => {
    p = await makeCanvasProject('studio-cards-browser-');
    p.write('RUN.md', RUN_DOC);
    pageRoot = temp('timmy-cards-root-');
    home = temp('timmy-cards-home-');
    storeBase = temp('timmy-cards-store-');
    store = join(storeBase, '.timmy', 'receipts');
    // The fixture's VoxVision and flow records, sealed again into this test's real store, so the cards can verify them.
    const vox = readFileSync(join(p.root, p.voxFile));
    const svg = readFileSync(join(p.root, `results/vox/${p.voxId}/bbox.svg`));
    appendReceipt('runs', { kind: 'vox', subject: 'vox · measure · part.stl · ok', policy: 'auto', status: 'ok', project: 'demo', project_id: p.pid, outputs: [{ path: p.voxFile, sha256: sha(vox), bytes: vox.length }, { path: `results/vox/${p.voxId}/bbox.svg`, sha256: sha(svg), bytes: svg.length }] }, storeBase);
    const flow = readFileSync(join(p.root, p.flowFile));
    appendReceipt('runs', { kind: 'flow', subject: `flow · iterate · tray · ${p.flow} · succeeded`, policy: 'auto', status: 'ok', project: 'demo', project_id: p.pid, outputs: [{ path: p.flowFile, sha256: sha(flow), bytes: flow.length }] }, storeBase);
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    server = await startStudioServer(0, { env: { TIMMY_HOME: home }, root: pageRoot });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fixtures = temp('timmy-cards-fixtures-');
    const fakePython = join(fixtures, 'fake-python');
    writeFileSync(fakePython, '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
    const jobs = join(temp('timmy-cards-jobs-'), 'jobs');
    ws = new Workspace({
      glyphs: glyphSet(true),
      env: { UPMD_BIN: resolve('tests/fixtures/fake-upmd.mjs'), TIMMY_CADQUERY_PYTHON: fakePython },
      onPath: () => null,
      notify: (l) => notes.push(l.map((s) => s.text).join('')),
      openWeb: (url) => `Open ${url} in your browser.`,
      link: (t) => t,
      seal: (input) => appendReceipt('runs', input, storeBase).hash.slice(7, 15),
      receipts: () => receipts() as never,
      jobsDir: jobs,
      chdir: () => {},
      recipeTest: { executor: fakeExecutor(fixtures), pollMs: 100, onSupervisor: (child: ChildProcess) => { supervisors.push(new Promise((r) => { child.once('close', () => r()); child.once('error', () => r()); })); } },
    }, folderProject(p.root));
    cp = new CanvasProject({
      base: () => base, env: { TIMMY_HOME: home }, project: () => ws.project, projectId,
      jobsDir: jobs, receipts: () => store, board: () => null, ownToken: () => server.projectToken, act: (e) => ws.canvasAct(e),
    });
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    cp?.stop();
    await browser?.close();
    await ws?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    await Promise.race([Promise.all(supervisors), new Promise((r) => setTimeout(r, 15000))]);
    for (const d of [p?.base, ...dirs]) if (d) rmSync(d, { recursive: true, force: true });
  });

  /** A page as /canvas open opens it (a fresh grant in its fragment), or without one. */
  async function open(o: { grant?: boolean } = {}): Promise<{ page: Page; context: BrowserContext; origins: Set<string>; errors: string[]; grant: string | null }> {
    let target = `${base}/`;
    let grant: string | null = null;
    if (o.grant !== false) {
      expect(await cp.handOff({ grant: true })).toEqual({ ok: true, name: 'demo' });
      const t = cp.openTarget();
      expect(t.secret).toBe(true);
      target = t.target;
      grant = /#code=([0-9a-f]{32})$/.exec(target)![1];
    }
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const origins = new Set<string>();
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
      origins.add(url.origin);
      return url.hostname === '127.0.0.1' && url.origin === base ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(target);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 15_000 });
    return { page, context, origins, errors, grant };
  }
  const place = (page: Page, id: string): Promise<{ shape: string; type: string }> => page.evaluate((c) => (window as never as Win).timmyCanvas.placeDrawnCard(c), id);
  const card = (shape: string): string => `[data-timmy-card="${shape}"]`;
  /** Brings a card to the middle of the view at the zoom it has (a canvas is not scrolled, its camera is moved). */
  const show = async (page: Page, shape: string): Promise<void> => {
    await page.evaluate((id) => { const e = (window as never as Win).timmyCanvas.editor; const b = e.getShapePageBounds(id); if (b) e.centerOnPoint(b.center, { animation: { duration: 0 } }); }, shape);
    await page.waitForTimeout(100);
  };
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();

  it('opened by /canvas open: the grant leaves the address and becomes a session; the three cards say executable or diagram, as text, with details on demand', async () => {
    const { page, context, origins, errors, grant } = await open();
    try {
      expect(await page.evaluate(() => location.hash)).toBe('');
      expect(page.url()).not.toContain(grant!);
      expect(await text(page, '#project-acts')).toBe('This page was opened by Timmy: its executable cards can act.');
      // Place card, from the panel (the workflow document that runs) and by the page's own call (the other two).
      await page.click('#project-groups li.pcard[data-card="workflow:RUN.md"] .pcard-drawn');
      await page.waitForFunction(() => /^Placed card: /.test(document.getElementById('project-said')?.textContent ?? ''));
      const wf = await page.evaluate(() => (window as never as Win).timmyCanvas.editor.store.allRecords().filter((r) => r.typeName === 'shape' && r.type === 'timmy-workflow').map((r) => r.id).at(-1)!);
      const params = await place(page, `params:${TRAY}`);
      const result = await place(page, `vox:${p.voxId}`);
      expect(params.type).toBe('timmy-params');
      expect(result.type).toBe('timmy-result');
      await page.waitForSelector(`${card(wf)} .tc-blocks`);
      expect(await text(page, `${card(wf)} .tc-badge`)).toBe('executable');
      expect(await text(page, `${card(wf)} .tc-mode`)).toBe('Executable: its buttons are sent to the Timmy REPL that holds demo, which runs them as the live board\'s own actions.');
      expect(await page.$$eval(`${card(wf)} .tc-block .tc-name`, (n) => n.map((x) => x.textContent))).toEqual(['setup', 'build']);
      expect(await page.locator(`${card(wf)} button[data-tc-act="run"]`).count()).toBe(2);
      expect(await text(page, `${card(params.shape)} .tc-badge`)).toBe('executable');
      expect(await page.inputValue(`${card(params.shape)} [data-tc-param="width"]`)).toBe('145');
      expect(await page.isDisabled(`${card(params.shape)} button[data-tc-act="save"]`)).toBe(true);
      expect(await page.isDisabled(`${card(params.shape)} button[data-tc-act="rebuild"]`)).toBe(false);
      // The result card: a diagram of its record, verified by its receipt, its highlight drawn from the board's file guard.
      expect(await text(page, `${card(result.shape)} .tc-badge`)).toBe('diagram');
      expect(await text(page, `${card(result.shape)} .tc-check`)).toMatch(/^verified · receipt [0-9a-f]{8} sealed it$/);
      await page.waitForFunction((s) => { const i = document.querySelector(`${s} .tc-images img`) as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth > 0; }, card(result.shape));
      expect(await page.getAttribute(`${card(result.shape)} .tc-images img`, 'src')).toBe(`/api/project/image?p=${encodeURIComponent(`results/vox/${p.voxId}/bbox.svg`)}`);
      // Details: the technical part, on demand.
      await show(page, wf);
      expect(await page.locator(`${card(wf)} .tc-details`).count()).toBe(0);
      await page.click(`${card(wf)} .tc-toggle`);
      await page.waitForSelector(`${card(wf)} .tc-details`);
      const shownDetails = await page.$$eval(`${card(wf)} .tc-details dt, ${card(wf)} .tc-details dd`, (n) => n.map((x) => x.textContent));
      expect(shownDetails.slice(0, 6)).toEqual(['document', 'RUN.md', 'sha256', sha(RUN_DOC), 'card', 'workflow:RUN.md']);
      expect(await page.$$eval(`${card(wf)} .tc-block-cmd code`, (n) => n.map((x) => x.textContent))).toEqual(['mkdir -p dist', 'sleep 3; echo built > dist/out.txt']);
      await page.click(`${card(wf)} .tc-toggle`);
      await page.waitForSelector(`${card(wf)} .tc-details`, { state: 'detached' });
      // A hostile title stays text: no element made from it, nothing run.
      const hostile = await place(page, 'workflow:BUILD.md');
      await page.waitForSelector(`${card(hostile.shape)} .tc-title`);
      expect(await page.textContent(`${card(hostile.shape)} .tc-title`)).toBe(HOSTILE_TITLE);
      expect(await page.locator('img[src="x"]').count()).toBe(0);
      expect(await page.evaluate(() => (window as never as { __xss?: unknown }).__xss)).toBeUndefined();
      // The grant and the session are nowhere a person or another page could read them.
      // (tldraw keeps its own user preferences in localStorage; nothing of Timmy's is there.)
      const kept = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]));
      expect(kept).not.toContain(grant!);
      expect(kept).not.toMatch(/[0-9a-f]{64}/);
      expect(await page.evaluate(() => [sessionStorage.length, document.cookie])).toEqual([0, '']);
      expect(await page.content()).not.toContain(grant!);
      let saved = '';
      for (let i = 0; i < 40 && !saved.includes(result.shape); i++) { await new Promise((r) => setTimeout(r, 150)); saved = await (await fetch(`${base}/api/canvas/document`)).text(); }
      expect(saved).toContain(result.shape);
      expect(saved).not.toContain(grant!);
      expect(saved).not.toContain(p.root);
      expect([...origins]).toEqual([base]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it("Run up to here, clicked by a person, runs /run as the REPL's job and the card follows its records; a script's click does nothing", async () => {
    const { page, context, errors } = await open();
    try {
      const wf = await place(page, 'workflow:RUN.md');
      const run = `${card(wf.shape)} button[data-tc-act="run"][data-tc-block="build"]`;
      await page.waitForSelector(run);
      // A click made by script (as code on the page through the agent's canvas bridge could make): nothing is sent.
      const jobsBefore = ws.jobs.list().length;
      await page.evaluate((s) => { (document.querySelector(s) as HTMLButtonElement).click(); document.querySelector(s)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }, run);
      await page.waitForTimeout(1500);
      expect(ws.jobs.list().length).toBe(jobsBefore);
      expect(notes.filter((n) => n.startsWith('  canvas  /run')).length).toBe(0);
      // A person's click.
      await page.click(run);
      await page.waitForFunction((s) => /^canvas \/run RUN\.md build/.test(document.querySelector(`${s} .tc-answer`)?.textContent ?? ''), card(wf.shape), { timeout: 20_000 });
      expect(notes).toContain('  canvas  /run RUN.md build');
      // The card follows the records: the newest run while it runs, then its outcome with its receipt.
      await page.waitForFunction((s) => /^Newest run \(build\): running/.test(document.querySelector(`${s} .tc-last`)?.textContent ?? ''), card(wf.shape), { timeout: 15_000 });
      await page.waitForFunction((s) => /^Newest run \(build\): completed, its prediction met · [\d.]+ s · receipt [0-9a-f]{8}$/.test(document.querySelector(`${s} .tc-last`)?.textContent ?? ''), card(wf.shape), { timeout: 30_000 });
      const job = ws.jobs.list().find((j) => j.kind === 'workflow')!;
      expect(job.state).toBe('completed');
      const outcome = receipts().find((r) => r.kind === 'workflow' && (r.job as { id?: string } | undefined)?.id === job.id)!;
      expect(await text(page, `${card(wf.shape)} .tc-last`)).toContain(`receipt ${String(outcome.hash).slice(7, 15)}`);
      expect(await page.$$eval(`${card(wf.shape)} .tc-block .tc-word`, (n) => n.map((x) => x.textContent))).toEqual(['completed', 'completed']);
      expect(readFileSync(join(p.root, 'dist/out.txt'), 'utf8')).toBe('built\n');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it("the parameter card's typed value is saved through the board's save path, a refused value says why, and Rebuild runs the FAKE recipe job the card then shows", async () => {
    const { page, context, errors } = await open();
    try {
      const pc = await place(page, `params:${TRAY}`);
      const at = card(pc.shape);
      await page.waitForSelector(`${at} [data-tc-param="width"]`);
      const was = readFileSync(join(p.root, TRAY));
      // Typing makes Save available and holds Rebuild until it is saved; the keys reach the field, not tldraw.
      await page.click(`${at} [data-tc-param="width"]`);
      await page.fill(`${at} [data-tc-param="width"]`, '160');
      expect(await page.isDisabled(`${at} button[data-tc-act="save"]`)).toBe(false);
      expect(await page.isDisabled(`${at} button[data-tc-act="rebuild"]`)).toBe(true);
      expect(await page.evaluate((id) => !!(window as never as Win).timmyCanvas.editor.getShape(id), pc.shape)).toBe(true);
      await page.click(`${at} button[data-tc-act="save"]`);
      await page.waitForFunction((s) => /^Saved recipes\/tray\.params\.json: width 145 → 160/.test(document.querySelector(`${s} .tc-answer`)?.textContent ?? ''), at, { timeout: 20_000 });
      expect(JSON.parse(readFileSync(join(p.root, TRAY), 'utf8')).parameters.width).toBe(160);
      const edit = receipts().filter((r) => r.kind === 'edit').at(-1)!;
      expect(edit).toMatchObject({ policy: 'human-gated', subject: `edit · ${TRAY} · parameters from Timmy Canvas (the live board's save path)` });
      expect((edit.files as Array<{ previous_sha256?: string }>)[0].previous_sha256).toBe(sha(was));
      expect(notes.some((n) => n.startsWith('  canvas  saved recipes/tray.params.json: width 145 → 160'))).toBe(true);
      // The card is drawn from the saved file again: the field reads 160 and Rebuild is offered.
      await page.waitForFunction((s) => (document.querySelector(`${s} [data-tc-param="width"]`) as HTMLInputElement | null)?.value === '160' && !(document.querySelector(`${s} button[data-tc-act="rebuild"]`) as HTMLButtonElement).disabled, at, { timeout: 15_000 });
      // A value the recipe refuses: the card says why in the failure colour; the file stays as saved.
      const now = readFileSync(join(p.root, TRAY));
      await page.fill(`${at} [data-tc-param="bore"]`, '50');
      await page.click(`${at} button[data-tc-act="save"]`);
      await page.waitForFunction((s) => /^Refused: /.test(document.querySelector(`${s} .tc-answer`)?.textContent ?? ''), at, { timeout: 20_000 });
      expect(await page.getAttribute(`${at} .tc-answer`, 'class')).toContain('tc-bad');
      expect(readFileSync(join(p.root, TRAY))).toEqual(now);
      await page.click(`${at} button.tc-quiet`);
      // Rebuild: the REPL's /recipe tray, from the saved file (FAKE executor); the card shows the newest build from its records.
      await page.waitForFunction((s) => !(document.querySelector(`${s} button[data-tc-act="rebuild"]`) as HTMLButtonElement).disabled, at);
      await page.click(`${at} button[data-tc-act="rebuild"]`);
      await page.waitForFunction((s) => /^canvas \/recipe tray/.test(document.querySelector(`${s} .tc-answer`)?.textContent ?? ''), at, { timeout: 20_000 });
      await page.waitForFunction((s) => /^Newest build: succeeded/.test(document.querySelector(`${s} .tc-build`)?.textContent ?? ''), at, { timeout: 30_000 });
      expect(await text(page, `${at} .tc-build`)).toMatch(/bounds 160 x 80 x 30 mm/);
      expect(errors.filter((e) => !/status of 422/.test(e))).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('a page opened without the grant is read but cannot act: the card says why and gives the typed command', async () => {
    const { page, context, errors } = await open({ grant: false });
    try {
      expect(await text(page, '#project-acts')).toBe('This page was opened without a grant from Timmy: its cards cannot act.');
      const wf = await place(page, 'workflow:RUN.md');
      await page.waitForSelector(`${card(wf.shape)} .tc-blocks`);
      expect(await text(page, `${card(wf.shape)} .tc-badge`)).toBe('diagram');
      expect(await text(page, `${card(wf.shape)} .tc-mode`)).toMatch(/^Read from Timmy now, but this page cannot act: it was not opened by \/canvas open in Timmy/);
      expect(await page.locator(`${card(wf.shape)} button[data-tc-act]`).count()).toBe(0);
      expect(await page.$$eval(`${card(wf.shape)} .tc-block .tc-cmd`, (n) => n.map((x) => x.textContent))).toEqual(['/run RUN.md setup', '/run RUN.md build']);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  it('when no REPL takes the actions, or the canvas shows another project, an executable card turns into a diagram that says so', async () => {
    const { page, context, errors } = await open();
    try {
      const pc = await place(page, `params:${TRAY}`);
      const at = card(pc.shape);
      await page.waitForFunction((s) => document.querySelector(`${s} .tc-badge`)?.textContent === 'executable', at);
      // The REPL stops taking actions (as it does when it ends): after its last ask, the canvas says no REPL takes them.
      cp.stop();
      await page.waitForFunction((s) => document.querySelector(`${s} .tc-badge`)?.textContent === 'diagram', at, { timeout: 60_000 });
      expect(await text(page, `${at} .tc-mode`)).toMatch(/^No Timmy REPL takes demo's card actions now/);
      expect(await page.locator(`${at} button[data-tc-act]`).count()).toBe(0);
      expect(await page.$$eval(`${at} .tc-cmd`, (n) => n.map((x) => x.textContent))).toEqual(['/recipe tray', `/open ${TRAY}`]);
      // Another project named to the canvas: the card is not followed, and keeps its last reading.
      const other = temp('timmy-cards-other-');
      const r = await fetch(`${base}/api/project/active`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.projectToken}` }, body: JSON.stringify({ root: other, name: 'other' }) });
      expect(r.status).toBe(200);
      await page.waitForFunction((s) => /^Not followed now: the canvas shows other, not demo\./.test(document.querySelector(`${s} .tc-mode`)?.textContent ?? ''), at, { timeout: 15_000 });
      expect(await page.locator(`${at} [data-tc-param]`).count()).toBe(0);
      expect(await text(page, `${at} .tc-read`)).toMatch(/^as last read at /);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);
});
