/**
 * R4 (H109; r25 D9 c): a parameter card placed by "Place this operation" shows the values that operation used, from its own
 * records, beside the file as it is now, in a real headless Chromium against the real canvas server and the real bundle (built
 * here into a temporary folder, as tests/studio-operation-browser.test.ts builds it). The project (tests/helpers/
 * canvas-project.ts) has the tray recipe's parameter file written by the recipe's own writer; FIXTURES: operation X's record,
 * its flow record (width 140 → 150, rebuilt) and its receipts, written in their schemas (no /iterate, agent or recipe ran); then
 * width 160 by hand (no receipt), as r25 set it. Every request the page makes goes to 127.0.0.1 (anything else is aborted).
 * Skipped, saying so, where no Chromium or Chrome is found.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { readCard } from '../src/recipes/index.js';
import { paramsText, writeParams } from '../src/recipes/params-file.js';
import { makeCanvasProject, sha, type CanvasProject } from './helpers/canvas-project.js';
import { writeOperation } from './helpers/canvas-operation.js';
import { grant } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-used-values-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const FILE = 'recipes/tray.params.json';
const X = 'oa0a9ed5a';
const Y = 'ob9b9b9b9';
type Win = { timmyCanvas: { editor: { store: { allRecords: () => Array<{ typeName: string; type?: string; id: string; props: Record<string, unknown>; meta: Record<string, unknown> }> } } } };

describe.skipIf(!browserPath)('Timmy Canvas: a parameter card placed for an operation shows what it used, in a real browser', () => {
  let p: CanvasProject;
  let pageRoot = '';
  let home = '';
  let server: StudioServer;
  let browser: Browser;
  let base = '';
  const card = readCard().parameters as Record<string, number>;

  beforeAll(async () => {
    p = await makeCanvasProject('studio-used-browser-');
    // FIXTURE operation X: its record, its flow (width 140 → 150, rebuilt, sealed) and its agent's receipt naming the file after
    writeOperation(p, { id: X, request: '/run WORKFLOW.md result' });
    const s140 = sha(paramsText({ ...card, width: 140 }));
    const s150 = sha(paramsText({ ...card, width: 150 }));
    const rel = 'results/flows/fa0a9ed5a.json';
    const text = `${JSON.stringify({
      flow: 1, schema: 'timmy.flow/1', id: 'fa0a9ed5a', kind: 'iterate', recipe: 'enclosure.tray/1', instruction: 'make the tray 150 mm wide', project: 'demo', operation: X,
      started_at: '2026-10-10T04:00:00.000Z', ended_at: '2026-10-10T04:03:00.000Z', outcome: 'succeeded',
      parameters: { path: FILE, created: false, before: { sha256: s140, values: { ...card, width: 140 } }, after: { sha256: s150, values: { ...card, width: 150 } } },
      rebuild: { job: 'abcd1234-0000-4000-8000-000000000000', state: 'succeeded', predicted: { bounds_mm: [150, 80, 30], volume_mm3: 1000 }, parameters_file: { path: FILE, sha256: s150 } },
      readback: { state: 'completed', verdict: 'matches', tolerance: { bounds_mm: 0.01, volume_relative: 0.001 }, scope: 'The readback measures the delivered CAD file.' },
      receipts: {}, child_receipts: [], doctrine: 'Timmy can compute and verify dimensions of generated CAD.',
    }, null, 2)}\n`;
    p.write(rel, text);
    p.seal({ kind: 'flow', subject: 'flow · iterate · tray · fa0a9ed5a · succeeded', operation_id: X, outputs: [{ path: rel, sha256: sha(text), bytes: Buffer.byteLength(text) }] });
    p.seal({ kind: 'agent', subject: 'agent · tray', operation_id: X, files: [{ path: FILE, sha256: s150, previous_sha256: s140 }] });
    // today: width 160, by hand (no receipt names it), as r25 set it
    const wrote = writeParams(p.root, { ...card, width: 160 });
    if (!wrote.ok) throw new Error(wrote.error);
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-canvas-used-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-canvas-used-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    // R5 (H133): the page's workspace strip asks the server for the frame, which reads Timmy's settings: this file's own folder
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot });
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
  /** The drawn parameter card placed for operation `op`. */
  const paramsFor = (page: Page, op: string): Promise<string | undefined> => page.evaluate((id) => (window as never as Win).timmyCanvas.editor.store.allRecords()
    .find((r) => r.typeName === 'shape' && r.type === 'timmy-params' && r.meta?.timmyOperation === id)?.id, op);
  const placeOp = async (page: Page, op: string): Promise<string> => {
    await page.waitForSelector(`#project-groups section.pop[data-op="${op}"] .pop-place`, { timeout: 20_000 });
    await page.evaluate(() => { document.getElementById('project-said')!.textContent = ''; });
    await page.click(`#project-groups section.pop[data-op="${op}"] .pop-place`);
    await page.waitForFunction(() => /^Operation /.test(document.getElementById('project-said')?.textContent ?? ''), null, { timeout: 15_000 });
    return text(page, '#project-said');
  };

  it('shows the 150 operation X used ("as used by operation …"), with "now 160 in recipes/tray.params.json" beside it; its build; and changes nothing. The file\'s own card shows 160. An operation whose bytes no copy holds says unknown, and why', async () => {
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
      await page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 15_000 });
      await page.click('#project-by button[data-by="operation"]');
      // operation X's group holds the parameter card (the newest receipt naming the file is X's) and its flow
      await page.waitForSelector(`#project-groups section.pop[data-op="${X}"] li.pcard[data-card="params:${FILE}"]`, { timeout: 15_000 });
      expect(await placeOp(page, X)).toMatch(new RegExp(`^Operation ${X}: 2 cards placed left to right`));
      const id = (await paramsFor(page, X))!;
      expect(id).toBeTruthy();
      const at = `[data-timmy-card="${id}"]`;
      await page.waitForSelector(`${at} .tc-used`);
      expect(await text(page, `${at} .tc-badge`)).toBe('record');
      expect(await text(page, `${at} .tc-used`)).toBe(`As used by operation ${X}`);
      expect(await text(page, `${at} tr[data-tc-used="width"] .tc-as-used`)).toBe('150 mm');
      expect(await text(page, `${at} tr[data-tc-now="width"] .tc-now`)).toBe(`now 160 mm in ${FILE}`);
      // the values it did not change stand alone (the file holds the same value now): nothing under them
      const other = Object.keys(card).find((k) => k !== 'width')!;
      expect(await page.locator(`${at} tr[data-tc-used="${other}"]`).count()).toBe(1);
      expect(await page.locator(`${at} tr[data-tc-now="${other}"]`).count()).toBe(0);
      expect(await text(page, `${at} .tc-used-from`)).toMatch(/^its flow fa0a9ed5a \(succeeded\) rebuilt the tray from these values; receipt [0-9a-f]{8} sealed its record$/);
      expect(await text(page, `${at} .tc-build`)).toBe('Its build: recipe job abcd1234 succeeded, predicted 150 x 80 x 30 mm, its readback matches');
      // a record: no Save, no Rebuild, no field to type in
      expect(await page.locator(`${at} [data-tc-act], ${at} input, ${at} select`).count()).toBe(0);
      expect(await text(page, `${at} .tc-op`)).toBe(`operation ${X}`);

      // the file's own card (Place card in the list) shows today's 160
      await page.click('#project-by button[data-by="kind"]');
      await page.click(`#project-groups li.pcard[data-card="params:${FILE}"] .pcard-drawn`);
      await page.waitForFunction(() => /^Placed card/.test(document.getElementById('project-said')?.textContent ?? ''));
      const own = await page.evaluate((f) => (window as never as Win).timmyCanvas.editor.store.allRecords()
        .find((r) => r.typeName === 'shape' && r.type === 'timmy-params' && r.props.card === `params:${f}` && !r.meta?.timmyOperation)?.id, FILE);
      expect(await page.textContent(`[data-timmy-card="${own}"] .tc-table`)).toContain('160 mm');
      expect(await page.locator(`[data-timmy-card="${own}"] .tc-used`).count()).toBe(0);

      // Operation Y: a save whose receipt names bytes that no copy holds (sealed now: the newest naming the file, so the file's
      // card is Y's from the next reading); placed for Y, its parameter card says unknown, and why, each value beside the file now
      p.seal({ kind: 'edit', subject: 'edit · recipes/tray.params.json', operation_id: Y, files: [{ path: FILE, sha256: 'cd'.repeat(32) }] });
      await page.click('#project-by button[data-by="operation"]');
      expect(await placeOp(page, Y)).toMatch(new RegExp(`^Operation ${Y}: 1 card placed`));
      const yid = (await paramsFor(page, Y))!;
      const yat = `[data-timmy-card="${yid}"]`;
      await page.waitForSelector(`${yat} .tc-used`);
      expect(await text(page, `${yat} .tc-used`)).toBe(`As used by operation ${Y}: unknown`);
      expect(await text(page, `${yat} .tc-used-from`)).toMatch(/^receipt [0-9a-f]{8} \(edit\) names recipes\/tray\.params\.json as sha256 cdcdcdcdcdcd, the file is sha256 [0-9a-f]{12} now, and no copy Timmy kept holds those bytes, so the values it used are not known$/);
      expect(await text(page, `${yat} tr[data-tc-used="width"] .tc-as-used`)).toBe('unknown');
      expect(await text(page, `${yat} tr[data-tc-now="width"] .tc-now`)).toBe(`now 160 mm in ${FILE}`);
      // X's card still shows what X used (X is still listed, by its flow), however the file's card moved on to Y
      await page.waitForTimeout(5500);
      // a screenshot for a look by eye, only when TIMMY_CANVAS_SHOTS names a folder: otherwise a run leaves nothing behind
      if (process.env.TIMMY_CANVAS_SHOTS) {
        await page.evaluate((s) => { const e = (window as never as { timmyCanvas: { editor: { select: (...i: string[]) => void; zoomToSelection: () => void; selectNone: () => void } } }).timmyCanvas.editor; e.select(...s); e.zoomToSelection(); e.selectNone(); }, [id, yid]);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(process.env.TIMMY_CANVAS_SHOTS, 'used-values-1440x900.png') });
      }
      expect(await text(page, `${at} tr[data-tc-used="width"] .tc-as-used`)).toBe('150 mm');
      expect(await text(page, `${at} .tc-used`)).toBe(`As used by operation ${X}`);
      expect([...origins].every((x) => x === base)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 180_000);
});
