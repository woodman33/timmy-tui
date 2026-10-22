/**
 * R10 (H167, Step C; the round's rule: "technical diagnostics (hashes, bus details, raw commands, ports, paths, ids) in a
 * secondary inspector or details control"; reference 06's stage and shelf): Timmy Studio says each thing on its face in words
 * (the strip's steps, the canvas's state and save, a draft waiting with Accept, Discard and Move it to free space, its canvas
 * jobs, the project's artifacts, nodes and cards), and keeps their ids, places and commands under Details (the strip's under
 * its Commands). In a real headless Chromium at 1376 x 768 and 390 x 844, against the real canvas server and the real bundle
 * (built here into a temporary folder), with a project of cards, receipts, a flow and a VoxVision record (tests/helpers/
 * canvas-project.ts), a canvas job linked to a receipt as the REPL links a sealed turn's, and a draft from the agent's
 * canvas_exec: a scripted call (no model runs; FAKE), its shapes put over a shape already on the board. Skipped, saying so,
 * where no Chromium is found. Screenshots go to TIMMY_CANVAS_SHOTS when it names a folder.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvasTools } from '../src/agent/canvas-tools.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { bearer, grant, nameProject } from './helpers/canvas-auth.js';
import { makeCanvasProject, type CanvasProject } from './helpers/canvas-project.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-face-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

/** The job and the receipt the test links (as the REPL links a sealed turn's receipt to its canvas job): FAKE ids. */
const JOB = 'turn-0c575980';
const RECEIPT = '5140579a';
/** The agent's canvas_exec (a scripted call, no model): two shapes, the first over the shape the person drew first. */
const DRAFT = "const { createShapeId, toRichText } = helpers; const a = createShapeId(), b = createShapeId(); editor.createShapes([{ id: a, type: 'geo', x: 520, y: 260, props: { w: 200, h: 90, richText: toRichText('FAKE intent (scripted)') } }, { id: b, type: 'geo', x: 760, y: 260, props: { w: 200, h: 90, richText: toRichText('FAKE prediction (scripted)') } }]); return [a, b];";
type Answer = { ok: boolean; jobId?: string; draft?: { id: string; shapes?: number } };

describe.skipIf(!browserPath)("Timmy Studio's face in words, its ids, places and commands under Details (R10 H167)", () => {
  let p: CanvasProject;
  let pageRoot = '';
  let home = '';
  let server: StudioServer;
  let browser: Browser;
  let base = '';
  let port = 0;

  beforeAll(async () => {
    p = await makeCanvasProject('studio-face-');
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-face-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-face-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot });
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    await nameProject(port, server.projectToken, { root: p.root, name: 'demo', jobs: p.jobs, receipts: p.store });
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of [p?.base, pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  async function open(viewport: { width: number; height: number }): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === base || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#code=${await grant(port, server.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelectorAll('#frame-tabs li').length === 10 && document.querySelectorAll('#frame-acts li').length > 0, null, { timeout: 30_000 });
    return { page, context, errors };
  }
  const shoot = async (page: Page, name: string): Promise<void> => {
    const shots = process.env.TIMMY_CANVAS_SHOTS;
    if (!shots) return;
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, name) });
  };
  /** The agent's own canvas tools, with the REPL's credentials (the project is named without a holder here). */
  const agent = (name: string, args: Record<string, unknown>): Promise<Answer> => {
    const tools = createCanvasTools({ baseUrl: base, auth: () => ({ token: server.projectToken, holder: null }) });
    return (tools.find((t) => t.function.name === name)!.function.execute as (a: unknown) => Promise<Answer>)(args);
  };
  /** What a person sees of the strip and the panel: their words as drawn (a closed Details' words are not drawn). */
  const face = (page: Page): Promise<string> => page.evaluate(() => ['frame', 'side'].map((id) => document.getElementById(id)!.innerText).join('\n'));
  /** What the face must never show: a command, an id or a hash the records hold, a place. */
  const leaks = (words: string): string[] => [
    ...['/canvas', '/project new', '/board', '/studio', '/run ', '/room', '/open ', '/iterate', '/stop'].filter((c) => words.includes(c)),
    ...[JOB, RECEIPT, home, p.root, '~/', 'tldraw 5.5.2'].filter((x) => words.includes(x)),
    ...(words.match(/\b(?:o[0-9a-f]{8}|f[0-9a-f]{8}|j[0-9a-f]{6})\b|\breceipt [0-9a-f]{8}\b|\b[\w.-]+\/[\w./-]+\.(?:json|md|png|scad|stl)\b/g) ?? []),
  ];

  it('at 1376 x 768: the strip, the canvas\'s state and save, a waiting draft, its job, the artifacts, the nodes and the cards in words; their ids, places and commands under Details', async () => {
    const { page, context, errors } = await open({ width: 1376, height: 768 });
    try {
      // the person's own shape, then the agent's draft over it (scripted, FAKE), its job linked to a receipt as the REPL links one
      await page.evaluate(() => (window as never as { timmyCanvas: { editor: { createShape: (s: unknown) => void } } }).timmyCanvas.editor.createShape({ type: 'geo', x: 500, y: 240, props: { w: 260, h: 140 } }));
      const drawn = await agent('canvas_exec', { code: DRAFT, jobId: JOB });
      expect(drawn).toMatchObject({ ok: true, jobId: JOB, draft: { shapes: 2 } });
      const linked = await fetch(`${base}/api/canvas/jobs/${JOB}/receipt`, { method: 'POST', headers: { ...bearer(server.projectToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ receipt: RECEIPT }) });
      expect(linked.status).toBe(200);
      await page.waitForSelector('#drafts:not([hidden]) #draft-list li.draft');
      await page.waitForSelector(`#job-list li[data-job="${JOB}"] .job-row[data-row="Receipt"] a`, { state: 'attached', timeout: 15_000 });
      await page.evaluate(() => { for (const id of ['jobs', 'artifacts', 'nodes', 'project']) (document.getElementById(id) as HTMLDetailsElement).open = true; });
      await page.waitForSelector('#artifact-list li.aitem', { state: 'attached', timeout: 20_000 });
      await page.waitForSelector('#node-palette li.nitem', { state: 'attached', timeout: 20_000 });
      await page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 20_000 });

      // ── the face: in words, nothing of a command, an id, a hash or a place (the lists scrolled through, each part drawn)
      const seen = new Set<string>();
      const region = await page.$eval('#side-scroll', (e) => ({ h: e.scrollHeight, view: e.clientHeight }));
      for (let top = 0; top <= region.h; top += Math.max(120, region.view - 40)) {
        await page.$eval('#side-scroll', (e, t) => { e.scrollTop = t; }, top);
        seen.add(await face(page));
      }
      const words = [...seen].join('\n');
      expect(leaks(words)).toEqual([]);
      expect(words).toContain('Canvas ready · ● Timmy connected · revision');
      expect(words).toMatch(/DRAFT · proposed by Timmy · 2 shapes · from revision \d+/);
      // the draft's review, at a glance: what it lands on with Move it to free space, then Show, Accept (the amber step) and Discard
      const card = await page.$eval('#draft-list li.draft', (li) => ({
        over: li.querySelector('.draft-over-words')?.textContent ?? '', move: li.querySelector('button.draft-move')?.textContent ?? '',
        buttons: [...li.querySelectorAll('.draft-acts > button')].map((b) => b.textContent), accept: getComputedStyle(li.querySelector('button.draft-accept')!).color,
      }));
      expect(card).toMatchObject({ move: 'Move it to free space', buttons: ['Show', 'Accept', 'Discard'], accept: 'rgb(255, 176, 0)' });
      expect(card.over).toMatch(/lands on/);
      expect(await page.textContent(`#job-list li[data-job="${JOB}"] .job-row[data-row="Receipt"]`)).toBe('Receipt open its page');
      expect(await page.getAttribute(`#job-list li[data-job="${JOB}"] .job-row[data-row="Receipt"] a`, 'href')).toBe(`/receipts/${RECEIPT}`);
      await shoot(page, 'studio-face-1376x768.png');

      // ── and the Details hold the rest, as the records say them (closed at first)
      expect(await page.$$eval('#side details:is(#side-about, .job-more, .draft-more, .aitem-more, .pcard-more)', (ds) => ds.filter((d) => (d as HTMLDetailsElement).open).length)).toBe(0);
      expect(await page.textContent(`#job-list li[data-job="${JOB}"] .job-more`)).toBe(`Details job ${JOB} · receipt ${RECEIPT}`);
      expect(await page.textContent('#draft-list li.draft .draft-more')).toBe(`Details proposed by job ${JOB}`);
      await page.click('#side-about > summary');
      const about = await page.$eval('#side-about', (d) => (d as HTMLElement).innerText);
      expect(about).toMatch(/^Details\n+tldraw 5\.5\.2 · .+\n+Saved in /);
      expect(about).toContain(join(home, 'canvas', 'projects'));
      const build = page.locator('#project-groups li.pcard[data-card="workflow:BUILD.md"]');
      await build.locator('.pcard-more > summary').click();
      const more = await build.locator('.pcard-more').innerText();
      expect(more).toContain('record BUILD.md');
      expect(more).toContain('no operation: not run yet');
      expect(more).toContain('/run BUILD.md render');
      // the strip's Commands shows each step's command beside its Copy
      expect(await page.locator('#frame code.fr-cmd:visible').count()).toBe(0);
      await page.click('#frame-cmds-toggle');
      const commands = await page.locator('#frame-acts code.fr-cmd:visible').allTextContents();
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.every((c) => c.startsWith('/') || c.startsWith('Accept'))).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 150_000);

  it('at 390 x 844: the blank board\'s guide sits under the panel, across the board, in words; the strip\'s steps without their commands', async () => {
    // a project of its own, blank, named before the page opens (a page's session is its project's): the page shows its guide
    const blank = join(p.base, 'blank');
    mkdirSync(blank, { recursive: true });
    await nameProject(port, server.projectToken, { root: blank, name: 'blank' });
    const { page, context, errors } = await open({ width: 390, height: 844 });
    try {
      await page.waitForFunction(() => document.getElementById('guide') && !document.getElementById('guide')!.hidden, null, { timeout: 30_000 });
      const at = await page.evaluate(() => {
        const g = document.getElementById('guide')!.getBoundingClientRect();
        const side = document.getElementById('side')!.getBoundingClientRect();
        return { left: g.left, right: g.right, top: g.top, width: g.width, sideBottom: side.bottom, vw: innerWidth, words: document.getElementById('guide')!.innerText };
      });
      expect(at.top, 'under the panel').toBeGreaterThanOrEqual(at.sideBottom);
      expect(at.left).toBeGreaterThanOrEqual(0);
      expect(at.right).toBeLessThanOrEqual(at.vw);
      expect(at.width, 'across the board, not a column of single words').toBeGreaterThan(240);
      expect(at.words).toMatch(/^This board is blank\.\nDraw with the tools below, or ask Timmy in the REPL/);
      expect(leaks(await face(page))).toEqual([]);
      await shoot(page, 'studio-face-390x844-blank.png');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);
});
