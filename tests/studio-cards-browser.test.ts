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
import { bearer } from './helpers/canvas-auth.js';

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

  /** A page as /canvas open opens it (a fresh grant in its fragment), or without one (R4 H83: it then loads no canvas). */
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
    if (o.grant === false) {
      await page.waitForFunction(() => document.getElementById('status')?.dataset.kind === 'refused', null, { timeout: 30_000 });
      return { page, context, origins, errors, grant };
    }
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
      // R4 (H83): read with the page's session and shown from memory (an object URL); the address names no session
      expect(await page.getAttribute(`${card(result.shape)} .tc-images img`, 'data-tc-image')).toBe(`results/vox/${p.voxId}/bbox.svg`);
      expect(await page.getAttribute(`${card(result.shape)} .tc-images img`, 'src')).toMatch(new RegExp(`^blob:${base.replace(/[.]/g, '\\.')}/`));
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
      for (let i = 0; i < 40 && !saved.includes(result.shape); i++) { await new Promise((r) => setTimeout(r, 150)); saved = await (await fetch(`${base}/api/canvas/document`, { headers: bearer(server.projectToken) })).text(); }
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

  it('a page opened without the grant loads no canvas and cannot act: it says why and what to type (R4 H83; R4 H81: the detail needs a session)', async () => {
    const { page, context, errors } = await open({ grant: false });
    try {
      // R4 (H83): no canvas, no cards, no project: the page says it needs /canvas open, and starts nothing else
      expect(await text(page, '#status')).toBe('Not loaded: This page was opened without a grant from Timmy, so it loads no canvas: Timmy opens the canvas page with a one-time grant, and a page opened by its address, a bookmark or a reload has none. In Timmy: /canvas open.');
      expect(await page.isVisible('#refused')).toBe(true);
      expect(await page.isHidden('#side-ready')).toBe(true);
      expect(await page.locator('[data-timmy-card]').count()).toBe(0);
      expect(await page.evaluate(() => (window as never as { timmyCanvas?: unknown }).timmyCanvas)).toBeUndefined();
      // R4 (H81): the detail itself, asked for by the page without a session: refused, no command in the answer
      const asked = await page.evaluate(async () => { const r = await fetch('/api/project?detail=1', { cache: 'no-store' }); return { status: r.status, body: await r.text() }; });
      expect(asked.status).toBe(401);
      expect(asked.body).not.toContain('mkdir -p dist');
      expect(JSON.parse(asked.body)).toMatchObject({ ok: false, session: 'none' });
      // R4 (H83): and the card list itself
      const listed = await page.evaluate(async () => { const r = await fetch('/api/project', { cache: 'no-store' }); return { status: r.status, body: await r.text() }; });
      expect(listed.status).toBe(401);
      expect(listed.body).not.toContain('RUN.md');
      expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  /** A person's click through Chromium's own input (CDP Input.dispatchMouseEvent): a trusted click, at the element's middle. */
  async function personClick(page: Page, context: BrowserContext, sel: string): Promise<void> {
    const box = await page.locator(sel).boundingBox();
    if (!box) throw new Error(`${sel} is not on screen`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    } finally { await cdp.detach(); }
  }

  it('R4 (H81): getters page script puts on Object.prototype (and a wrapped fetch and JSON.stringify) never see the session, and a person\'s click still acts', async () => {
    const { page, context } = await open();
    try {
      const wf = await place(page, 'workflow:RUN.md');
      const run = `${card(wf.shape)} button[data-tc-act="run"][data-tc-block="setup"]`;
      await page.waitForSelector(run);
      await show(page, wf.shape);
      // Page script, as code the agent's canvas bridge runs on the page could install it: a getter (and a setter that keeps
      // the value) on Object.prototype for every member a request's init or headers might leave out, an iterator getter, and
      // fetch and JSON.stringify wrapped. Each records whatever it sees that holds a session's header (Bearer and 64 hex digits).
      await page.evaluate(() => {
        const w = window as unknown as { __hits: string[]; __calls: number; __fetches: string[] };
        w.__hits = [];
        w.__calls = 0;
        w.__fetches = [];
        const own = Object.getOwnPropertyNames;
        const desc = Object.getOwnPropertyDescriptor;
        // what an object holds as its own data (never through a getter), two levels deep: a request's init and its headers
        const scan = (o: unknown, depth: number): string => {
          if (!o || typeof o !== 'object' || depth > 2 || Array.isArray(o) || o instanceof Node) return '';
          let s = '';
          let keys: string[] = [];
          try { keys = own(o).slice(0, 200); } catch { return ''; }
          for (const k of keys) {
            const d = desc(o, k);
            if (!d || !('value' in d)) continue;
            if (typeof d.value === 'string') s += `${k}=${d.value.slice(0, 200)};`;
            else s += scan(d.value, depth + 1);
          }
          return s;
        };
        let inside = false;
        const look = (where: string, v: unknown): void => {
          if (inside) return;
          inside = true;
          try {
            w.__calls += 1;
            const s = typeof v === 'string' ? v : scan(v, 0);
            if (/Bearer [0-9a-f]{64}/.test(s)) w.__hits.push(`${where}: ${s.slice(0, 300)}`);
          } finally { inside = false; }
        };
        const names = ['integrity', 'keepalive', 'mode', 'redirect', 'referrer', 'referrerPolicy', 'signal', 'window', 'priority', 'duplex', 'cache', 'credentials',
          'method', 'headers', 'body', 'attributionReporting', 'browsingTopics', 'privateToken', 'adAuctionHeaders', 'sharedStorageWritable', 'targetAddressSpace',
          'Authorization', 'authorization', 'Content-Type'];
        for (const n of names) {
          Object.defineProperty(Object.prototype, n, {
            configurable: true,
            get(this: unknown) { look(`get ${n}`, this); return undefined; },
            set(this: object, v: unknown) { look(`set ${n}`, v); Object.defineProperty(this, n, { value: v, writable: true, enumerable: true, configurable: true }); },
          });
        }
        Object.defineProperty(Object.prototype, Symbol.iterator, { configurable: true, get(this: unknown) { look('iterator', this); return undefined; } });
        const realFetch = window.fetch;
        window.fetch = function (input: RequestInfo | URL, init?: RequestInit) { look('fetch', init); w.__fetches.push(String(input)); return realFetch.call(window, input, init); } as typeof fetch;
        const realStringify = JSON.stringify;
        JSON.stringify = function (v: unknown, ...rest: unknown[]) { look('stringify', v); return (realStringify as (...a: unknown[]) => string)(v, ...rest); } as typeof JSON.stringify;
      });
      const jobsBefore = ws.jobs.list().length;
      const revisionBefore = (await (await fetch(`${base}/api/canvas/document`, { headers: bearer(server.projectToken) })).json() as { revision: number }).revision;
      await personClick(page, context, run);
      await page.waitForFunction((s) => /^canvas \/run RUN\.md setup/.test(document.querySelector(`${s} .tc-answer`)?.textContent ?? ''), card(wf.shape), { timeout: 20_000 });
      expect(notes).toContain('  canvas  /run RUN.md setup');
      expect(ws.jobs.list().length).toBe(jobsBefore + 1);
      // R4 (H83): the page's own requests (the action, its readings, the canvas's saves, the bridge) carry the session and go
      // through what cards.js took at load, never the wrapped fetch. A save went out meanwhile (the card's reading changed, so
      // the server's revision moved), the wrappers were live (the test's own fetch goes through them), and none saw the session.
      for (let i = 0; i < 100; i++) {
        const now = (await (await fetch(`${base}/api/canvas/document`, { headers: bearer(server.projectToken) })).json() as { revision: number }).revision;
        if (now > revisionBefore) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      expect((await (await fetch(`${base}/api/canvas/document`, { headers: bearer(server.projectToken) })).json() as { revision: number }).revision).toBeGreaterThan(revisionBefore);
      await page.evaluate(() => fetch('/api/canvas/templates', { cache: 'no-store' }).then((r) => r.text()));
      const seen = await page.evaluate(() => { const w = window as unknown as { __hits: string[]; __calls: number; __fetches: string[] }; return { hits: w.__hits, calls: w.__calls, fetches: w.__fetches }; });
      expect(seen.calls).toBeGreaterThan(0);
      expect(seen.fetches).toContain('/api/canvas/templates');
      expect(seen.fetches.filter((f) => /\/api\/(project|canvas\/(document|jobs))/.test(f))).toEqual([]);
      expect(seen.hits).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('R4 (H81): a window capture listener that rewrites the clicked button (and a replaced Event.prototype.target and WeakMap.prototype.get) does not change what is sent; a button the page made itself sends nothing', async () => {
    const { page, context } = await open();
    try {
      const wf = await place(page, 'workflow:RUN.md');
      const setupSel = `${card(wf.shape)} button[data-tc-act="run"][data-tc-block="setup"]`;
      await page.waitForSelector(setupSel);
      await show(page, wf.shape);
      // each button by an id of the test's own (React leaves an id it did not set alone): the page script below rewrites the
      // attributes a selector would use
      await page.evaluate((c) => {
        document.querySelector(`${c} button[data-tc-act="run"][data-tc-block="setup"]`)!.id = 'h81-setup';
        document.querySelector(`${c} button[data-tc-act="run"][data-tc-block="build"]`)!.id = 'h81-build';
      }, card(wf.shape));
      const setup = '#h81-setup';
      const notesFrom = notes.length;
      const buildsBefore = ws.jobs.list().filter((j) => j.label === 'RUN.md › build').length;
      const ran = (): string[] => notes.slice(notesFrom).filter((n) => n.startsWith('  canvas  /run RUN.md')).map((n) => n.trim());
      /** A person's click on the setup button; what the REPL was sent for it (it answers once the run has started). */
      const clickSetup = async (): Promise<string | undefined> => {
        const before = ran().length;
        await page.waitForFunction((s) => !(document.querySelector(s) as HTMLButtonElement | null)?.disabled, setup);
        await personClick(page, context, setup);
        for (let i = 0; i < 100 && ran().length === before; i++) await new Promise((r) => setTimeout(r, 100));
        await page.waitForFunction((s) => !(document.querySelector(s) as HTMLButtonElement | null)?.disabled, setup);
        return ran()[before];
      };
      // 1. Page script: a window capture listener (it runs before cards.js's own, on document) rewrites the setup button to
      //    name the build block, as the click comes.
      await page.evaluate(() => {
        const b = document.getElementById('h81-setup')!;
        window.addEventListener('click', () => { b.setAttribute('data-tc-block', 'build'); b.setAttribute('title', 'Sends /run RUN.md build to Timmy (Run up to here)'); }, true);
      });
      expect(await clickSetup()).toBe('canvas  /run RUN.md setup');
      // 2. ... and every event's target is said to be the build button
      await page.evaluate(() => {
        const build = document.getElementById('h81-build')!;
        (window as unknown as { __target?: PropertyDescriptor }).__target = Object.getOwnPropertyDescriptor(Event.prototype, 'target');
        Object.defineProperty(Event.prototype, 'target', { configurable: true, get() { return build; } });
      });
      expect(await clickSetup()).toBe('canvas  /run RUN.md setup');
      // 3. ... and every WeakMap lookup of a button answers for the build button
      await page.evaluate(() => {
        const build = document.getElementById('h81-build')!;
        const get = WeakMap.prototype.get;
        WeakMap.prototype.get = function (this: WeakMap<object, unknown>, k: object) { return get.call(this, k instanceof HTMLButtonElement ? build : k); };
      });
      expect(await clickSetup()).toBe('canvas  /run RUN.md setup');
      expect(ran()).toEqual(['canvas  /run RUN.md setup', 'canvas  /run RUN.md setup', 'canvas  /run RUN.md setup']);
      expect(ws.jobs.list().filter((j) => j.label === 'RUN.md › build').length).toBe(buildsBefore);
      // A button the page made itself, inside the card, with the attributes cards.js's own buttons carry: a person's click on
      // it sends nothing (it is not a button cards.js drew).
      await page.evaluate((c) => {
        Object.defineProperty(Event.prototype, 'target', (window as unknown as { __target: PropertyDescriptor }).__target);
        const root = document.querySelector(c)!;
        const fake = document.createElement('button');
        fake.type = 'button';
        fake.textContent = 'Run up to here';
        fake.setAttribute('data-tc-act', 'run');
        fake.setAttribute('data-tc-block', 'build');
        fake.id = 'not-cards-own';
        fake.style.cssText = 'position:relative;z-index:10;padding:6px';
        root.querySelector('.tc-head')!.append(fake);
      }, card(wf.shape));
      const acts: string[] = [];
      page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/project/act') acts.push(r.method()); });
      const before = { jobs: ws.jobs.list().length, notes: notes.length };
      await personClick(page, context, '#not-cards-own');
      await page.waitForTimeout(1500);
      // Nothing went to the REPL: no request to the act route, no action noted, no job. (Other notes, from runs the earlier
      // tests started, may still arrive meanwhile, so only the REPL's note of a canvas action is looked for.)
      expect(acts).toEqual([]);
      expect(notes.slice(before.notes).filter((n) => /^\s+canvas\s/.test(n))).toEqual([]);
      expect(ws.jobs.list().length).toBe(before.jobs);
    } finally {
      await context.close();
    }
  }, 120_000);

  it("R4 (H81): Save sends the values typed into the card, not what page script writes into its fields at the click", async () => {
    const { page, context } = await open();
    try {
      const pc = await place(page, `params:${TRAY}`);
      const at = card(pc.shape);
      await page.waitForSelector(`${at} [data-tc-param="width"]`);
      await show(page, pc.shape);
      const was = JSON.parse(readFileSync(join(p.root, TRAY), 'utf8')).parameters.width as number;
      const typedWidth = was === 150 ? 151 : 150;
      await page.click(`${at} [data-tc-param="width"]`);
      await page.fill(`${at} [data-tc-param="width"]`, String(typedWidth));
      await page.waitForFunction((s) => !(document.querySelector(`${s} button[data-tc-act="save"]`) as HTMLButtonElement).disabled, at);
      // Page script: as the click comes, before cards.js's listener, write another width into the field (no input event)
      await page.evaluate((s) => {
        window.addEventListener('click', () => {
          const f = document.querySelector(`${s} [data-tc-param="width"]`) as HTMLInputElement | null;
          if (f) f.value = '199';
        }, true);
      }, at);
      await personClick(page, context, `${at} button[data-tc-act="save"]`);
      await page.waitForFunction((s) => /^Saved recipes\/tray\.params\.json: width /.test(document.querySelector(`${s} .tc-answer`)?.textContent ?? ''), at, { timeout: 20_000 });
      expect(JSON.parse(readFileSync(join(p.root, TRAY), 'utf8')).parameters.width).toBe(typedWidth);
    } finally {
      await context.close();
    }
  }, 120_000);

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
      // R4 (H83): the page's session was given for demo, so it is told nothing of the project shown now (not even its name)
      await page.waitForFunction((s) => /^Not followed now: Refused: this canvas page's session was given for another project than the one the canvas shows now\. In Timmy: \/canvas open, from the REPL that holds this project\. Shown as last read\.$/.test(document.querySelector(`${s} .tc-mode`)?.textContent ?? ''), at, { timeout: 15_000 });
      expect(await page.locator(`${at} [data-tc-param]`).count()).toBe(0);
      expect(await text(page, `${at} .tc-read`)).toMatch(/^as last read at /);
      // R4 (H81, H83): the page's session was given for demo, so the server refused it the other project (Chromium logs that
      // 401); the page then asks again in 30 s, not at every reading
      expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
      expect(errors.filter((e) => /status of 401/.test(e)).length).toBeLessThanOrEqual(2);
    } finally {
      await context.close();
    }
  }, 120_000);
});
