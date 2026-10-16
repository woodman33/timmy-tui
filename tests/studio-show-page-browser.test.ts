/**
 * R5 (H137; the rehearsal's one console error, at a4cfbde on GET /api/canvas/jobs and at e7f853e on GET /api/workspace): the
 * Studio page the Workbench's Studio · Show (`s`) opens logs no failed request. In a real headless Chromium against the real
 * canvas server and the real bundle (built here into a temporary folder), the page is opened as the Workbench opens it: its
 * StudioControl (src/workbench/servers.ts) serves Studio, names the project with the Workbench's own holder id, takes a one-time
 * grant and hands its opener a private launch page; the opener here is a FAKE that records that page, and this test opens the
 * address the launch page carries. Then a REPL's /canvas open (its own CanvasProject, src/repl/canvas-project.ts, with its own
 * holder id) takes the canvas while the page is open, as in the rehearsal: the page's session is paused from then on, and the
 * page hears of it only from its next reading. Every response of 400 or more and every console error is counted. FAKE: the
 * project (tests/helpers/canvas-project.ts), the opener, and the card actions' answers (nothing runs). Skipped, saying so,
 * where no Chromium is found.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectId } from '../src/project/index.js';
import { CanvasProject } from '../src/repl/canvas-project.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { StudioControl } from '../src/workbench/servers.js';
import { makeCanvasProject, type CanvasProject as Project } from './helpers/canvas-project.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-show-page-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

/** The page's readings come every 4 s (the strip) and 5 s (the jobs, the cards): two rounds of each. */
const TWO_ROUNDS_MS = 11_000;

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const port = (s.address() as AddressInfo).port; s.close(() => resolve(port)); });
});

describe.skipIf(!browserPath)("the Studio page the Workbench's Studio · Show opens: no failed request, also once a REPL's /canvas open takes the canvas", () => {
  let p: Project;
  let pageRoot = '';
  let home = '';
  let browser: Browser;
  let control: StudioControl;
  let server: StudioServer | null = null;
  let base = '';
  const opened: string[] = [];
  const env: Record<string, string> = {};
  const closers: Array<() => void> = [];

  beforeAll(async () => {
    p = await makeCanvasProject('studio-show-page-');
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-show-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-show-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    const port = await freePort();
    // the Workbench's environment: its own Timmy home and settings, Studio's port
    Object.assign(env, { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: join(home, 'settings'), TIMMY_STUDIO_PORT: String(port), HOME: home });
    base = `http://127.0.0.1:${port}`;
    control = new StudioControl({
      env, projectId, jobsDir: p.jobs, receipts: () => p.store, project: () => ({ root: p.root, name: 'demo' }),
      // FAKE opener: it opens nothing, and records the private launch page it was given
      opener: { program: 'FAKE opener (test)', open: (href: string) => { opened.push(href); return { ok: true }; } },
      act: async () => ({ status: 200, text: 'FAKE: no card action runs in this test' }),
      // the real server, serving this test's bundle (the real ensure serves the checkout's companion/studio-canvas)
      ensure: async (at: number) => {
        const s = await startStudioServer(at, { env, projectTokenFile: true, root: pageRoot });
        server = s;
        return { state: 'started' as const, server: s };
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    for (const c of closers.splice(0)) c();
    control?.close();
    await control?.stopServing();
    for (const d of [p?.base, pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  /** The address the launch page carries (the grant in its fragment), as the browser opens it. */
  const launched = (href: string): string => {
    const html = readFileSync(decodeURIComponent(new URL(href).pathname), 'utf8');
    return JSON.parse(html.match(/location\.replace\(("[^"]+")\)/)![1]) as string;
  };

  /** The readings the page makes by itself: its strip's frame, the canvas jobs, the project's cards. */
  const READINGS = new Set(['/api/workspace', '/api/canvas/jobs', '/api/project']);
  type Answer = { at: number; path: string; status: number; body: unknown };

  /** A page at `url`, every failed response and console error of it counted (anything not to 127.0.0.1 is aborted, and counted). */
  async function watched(url: string): Promise<{ page: Page; context: BrowserContext; errors: string[]; failed: string[]; elsewhere: string[]; answers: Answer[] }> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    const failed: string[] = [];
    const elsewhere: string[] = [];
    const answers: Answer[] = [];
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.origin === base || /^(data|blob):/.test(u.protocol)) return route.continue();
      elsewhere.push(u.origin);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('response', async (r) => {
      const path = new URL(r.url()).pathname;
      if (r.status() >= 400) failed.push(`${r.status()} ${path}`);
      if (!READINGS.has(path)) return;
      let body: unknown = null;
      try { body = await r.json(); } catch { /* not JSON */ }
      answers.push({ at: Date.now(), path, status: r.status(), body });
    });
    await page.goto(url);
    return { page, context, errors, failed, elsewhere, answers };
  }

  it('opened by Studio · Show (its launch page\'s grant), the page loads the canvas, and over two rounds of every reading it makes by itself no request fails and nothing is logged as an error', async () => {
    const said = await control.show();
    expect(said).toMatch(/^Studio opened in your browser \(http:\/\/127\.0\.0\.1:\d+\/\), through a private page that carries its key\. It shows demo\./);
    const target = launched(opened.at(-1)!);
    expect(target).toMatch(/\/#code=[0-9a-f]{32}$/);
    const w = await watched(target);
    try {
      await w.page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
      await w.page.waitForFunction(() => document.querySelectorAll('#frame-tabs li').length === 10, null, { timeout: 30_000 });
      await w.page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 20_000 });
      // two rounds of each of its readings: the strip's frame, the canvas jobs, the project's cards
      const asked = { workspace: 0, jobs: 0, project: 0 };
      w.page.on('request', (r) => { const path = new URL(r.url()).pathname; if (path === '/api/workspace') asked.workspace += 1; if (path === '/api/canvas/jobs') asked.jobs += 1; if (path === '/api/project') asked.project += 1; });
      await expect.poll(() => Math.min(asked.workspace, asked.jobs, asked.project), { timeout: 30_000, intervals: [500] }).toBeGreaterThanOrEqual(2);
      expect(w.failed).toEqual([]);
      expect(w.errors).toEqual([]);
      expect(w.elsewhere).toEqual([]);
    } finally {
      await w.context.close();
    }
  }, 120_000);

  it("a REPL's /canvas open takes the canvas while the page is open: the page is paused and says why, in its panel and its strip, and still no request fails and nothing is logged; no canvas job reached it while paused; the REPL's own page loads with none either", async () => {
    await control.show();
    const w = await watched(launched(opened.at(-1)!));
    try {
      await w.page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
      await w.page.waitForFunction(() => document.getElementById('frame')?.dataset.stale === 'false', null, { timeout: 30_000 });
      await w.page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 20_000 });
      // the REPL's /canvas open: it names the same project with its own holder id and takes a grant for its own page
      const repl = new CanvasProject({
        base: () => base, env, project: () => ({ root: p.root, name: 'demo' }), projectId, jobsDir: p.jobs, receipts: () => p.store, board: () => null,
        ownToken: () => server!.projectToken, act: async () => ({ status: 200, text: 'FAKE second surface: never asked here' }),
      });
      closers.push(() => repl.stop());
      const takenAt = Date.now();
      expect(await repl.handOff({ grant: true })).toEqual({ ok: true, name: 'demo' });
      const replPage = repl.openTarget();
      expect(replPage.secret).toBe(true);
      // the page hears of it at its next reading: its panel's line and its strip say why, in the server's words
      await w.page.waitForFunction(() => /given by another Timmy REPL/.test(document.getElementById('project-acts')?.textContent ?? ''), null, { timeout: 20_000 });
      await w.page.waitForFunction(() => document.getElementById('frame')?.dataset.stale === 'true', null, { timeout: 20_000 });
      expect(await w.page.textContent('#frame-note')).toMatch(/^ · Workspace not read now: .*given by another Timmy REPL.* Shown as last read at \d\d:\d\d:\d\d\.$/);
      // the reading that told it was answered with a plain 200 that says why, with nothing of the project in it
      const paused = w.answers.filter((a) => a.at >= takenAt && (a.body as { session?: unknown } | null)?.session === 'holder');
      expect(paused.length).toBeGreaterThanOrEqual(1);
      for (const a of paused) {
        expect(a.status, a.path).toBe(200);
        expect(a.body, a.path).toEqual({ ok: false, session: 'holder', error: expect.stringMatching(/given by another Timmy REPL/) });
      }
      // and over two more rounds of its readings, nothing fails, and no canvas job or card reaches the paused page
      await w.page.waitForTimeout(TWO_ROUNDS_MS);
      expect(w.failed).toEqual([]);
      expect(w.errors).toEqual([]);
      const lastPause = Math.max(...paused.map((a) => a.at));
      for (const a of w.answers.filter((x) => x.at > lastPause)) expect(a.body, `${a.path} after the pause`).toMatchObject({ ok: false });
      // the REPL's own page: it counts (the REPL holds the canvas now), and loads with no failed request either
      const mine = await watched(replPage.target);
      try {
        await mine.page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
        await mine.page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 20_000 });
        await mine.page.waitForTimeout(6000);
        expect(mine.failed).toEqual([]);
        expect(mine.errors).toEqual([]);
      } finally {
        await mine.context.close();
      }
    } finally {
      await w.context.close();
    }
  }, 150_000);

  it('a page opened by the bare address (no grant: a bookmark, a reload) loads no canvas and says so, and asks nothing it would be refused: no request fails and nothing is logged', async () => {
    await control.show();
    const w = await watched(`${base}/`);
    try {
      await w.page.waitForFunction(() => document.getElementById('refused')?.hidden === false, null, { timeout: 30_000 });
      expect(await w.page.textContent('#refused-words')).toMatch(/opened without a grant from Timmy/);
      expect(await w.page.isHidden('#frame')).toBe(true);
      await w.page.waitForTimeout(6000);
      expect(w.failed).toEqual([]);
      expect(w.errors).toEqual([]);
    } finally {
      await w.context.close();
    }
  }, 90_000);
});
