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

  /** The readings the page makes by itself (every 4 s the strip's frame, every 5 s the canvas jobs and the project's cards). */
  const READINGS = new Set(['/api/workspace', '/api/canvas/jobs', '/api/project']);
  type Answer = { at: number; path: string; status: number; body: unknown };
  /** The fewest answers any one of the page's readings has had among `answers` (the rounds of its readings seen). */
  const rounds = (answers: Answer[]): number => Math.min(...[...READINGS].map((path) => answers.filter((a) => a.path === path).length));
  const isPaused = (a: Answer): boolean => (a.body as { session?: unknown } | null)?.session === 'holder';

  /**
   * A page at `url`, every failed response and console error of it counted (anything not to 127.0.0.1 is aborted, and counted),
   * and every reading it asks. `clock`: the page's timers on Playwright's clock (installed before the page loads, and running at
   * the real pace), so a test can run them ahead instead of waiting a fixed time.
   */
  async function watched(url: string, o: { clock?: boolean } = {}): Promise<{ page: Page; context: BrowserContext; errors: string[]; failed: string[]; elsewhere: string[]; answers: Answer[]; asked: string[] }> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    if (o.clock) await context.clock.install();
    const errors: string[] = [];
    const failed: string[] = [];
    const elsewhere: string[] = [];
    const answers: Answer[] = [];
    const asked: string[] = [];
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.origin === base || /^(data|blob):/.test(u.protocol)) return route.continue();
      elsewhere.push(u.origin);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', (r) => { const path = new URL(r.url()).pathname; if (READINGS.has(path)) asked.push(path); });
    page.on('response', async (r) => {
      const path = new URL(r.url()).pathname;
      if (r.status() >= 400) failed.push(`${r.status()} ${path}`);
      if (!READINGS.has(path)) return;
      let body: unknown = null;
      try { body = await r.json(); } catch { /* not JSON */ }
      answers.push({ at: Date.now(), path, status: r.status(), body });
    });
    await page.goto(url);
    return { page, context, errors, failed, elsewhere, answers, asked };
  }

  it('opened by Studio · Show (its launch page\'s grant), the page loads the canvas, and over two rounds of every reading it makes by itself no request fails and nothing is logged as an error', async () => {
    const said = await control.show();
    expect(said).toMatch(/^Studio opened in your browser \(http:\/\/127\.0\.0\.1:\d+\/\), through a private page that carries its key\. It shows demo\./);
    const target = launched(opened.at(-1)!);
    expect(target).toMatch(/\/#code=[0-9a-f]{32}$/);
    const w = await watched(target);
    try {
      await w.page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
      await w.page.waitForFunction(() => Boolean(document.getElementById('frame')?.dataset.revision) && document.querySelectorAll('#frame-acts li').length > 0, null, { timeout: 30_000 });
      await w.page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 20_000 });
      // two rounds of each of its readings: the strip's frame, the canvas jobs, the project's cards
      const asked = { workspace: 0, jobs: 0, project: 0 };
      w.page.on('request', (r) => { const path = new URL(r.url()).pathname; if (path === '/api/workspace') asked.workspace += 1; if (path === '/api/canvas/jobs') asked.jobs += 1; if (path === '/api/project') asked.project += 1; });
      await expect.poll(() => Math.min(asked.workspace, asked.jobs, asked.project), { timeout: 30_000, interval: 500 }).toBeGreaterThanOrEqual(2);
      expect(w.failed).toEqual([]);
      expect(w.errors).toEqual([]);
      expect(w.elsewhere).toEqual([]);
    } finally {
      await w.context.close();
    }
  }, 120_000);

  it("a REPL's /canvas open takes the canvas while the page is open: the page is paused and says why, in its panel and its strip, and still no request fails and nothing is logged, also when it asks again after its 30 s wait; no canvas job reached it while paused; the REPL's own page loads with none either", async () => {
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
      // Once paused, the page asks none of its readings for 30 s (./cards.js notFor; the strip not until a reading counts again),
      // then asks again. Waited for by what it asks (no fixed time): a reading answered paused at least 20 s after the first one is
      // that asking again. Every answer since the first paused one is a plain 200 that says why, with nothing of the project in it
      // (no canvas job or card reaches the paused page), and nothing fails or is logged as an error meanwhile.
      const pausedSince = (): Answer[] => w.answers.filter((a) => a.at >= takenAt && isPaused(a));
      await expect.poll(() => pausedSince().length, { timeout: 20_000, interval: 250 }).toBeGreaterThanOrEqual(1);
      const firstPaused = Math.min(...pausedSince().map((a) => a.at));
      await expect.poll(() => pausedSince().filter((a) => a.at >= firstPaused + 20_000).length, { timeout: 60_000, interval: 500 }).toBeGreaterThanOrEqual(1);
      const since = w.answers.filter((a) => a.at >= firstPaused);
      expect(since.filter((a) => a.at >= firstPaused + 20_000).map((a) => a.path).every((path) => path === '/api/canvas/jobs' || path === '/api/project')).toBe(true);
      for (const a of since) {
        expect(a.status, a.path).toBe(200);
        expect(a.body, a.path).toEqual({ ok: false, session: 'holder', error: expect.stringMatching(/given by another Timmy REPL/) });
      }
      expect(w.failed).toEqual([]);
      expect(w.errors).toEqual([]);
      // the REPL's own page: it counts (the REPL holds the canvas now), and over two rounds of its own readings (each answered
      // with the project) no request fails and nothing is logged either
      const mine = await watched(replPage.target);
      try {
        await mine.page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
        await mine.page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 20_000 });
        await expect.poll(() => rounds(mine.answers), { timeout: 40_000, interval: 500 }).toBeGreaterThanOrEqual(2);
        for (const a of mine.answers) expect((a.body as { ok?: unknown } | null)?.ok, `${a.path} on the REPL's page`).not.toBe(false);
        expect(mine.failed).toEqual([]);
        expect(mine.errors).toEqual([]);
      } finally {
        await mine.context.close();
      }
    } finally {
      await w.context.close();
    }
  }, 200_000);

  it('a page opened by the bare address (no grant: a bookmark, a reload) loads no canvas and says so, and asks nothing it would be refused: no request fails and nothing is logged', async () => {
    await control.show();
    const w = await watched(`${base}/`, { clock: true });
    try {
      await w.page.waitForFunction(() => document.getElementById('refused')?.hidden === false, null, { timeout: 30_000 });
      expect(await w.page.textContent('#refused-words')).toMatch(/opened without a grant from Timmy/);
      expect(await w.page.isHidden('#frame')).toBe(true);
      // the page loaded whole (its document and what it loads), then its own timers run 12 s ahead on its clock (no time waited
      // here): the strip's 4 s and the panel's 5 s readings would have been asked by then had the refused page started any. A
      // fence after them, the test's own request from the page to the open health route, is answered after anything they asked.
      // It asked none of them, no request failed, and nothing was logged as an error.
      await w.page.waitForLoadState('load');
      await w.page.clock.runFor(12_000);
      const fence = w.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/canvas/health');
      expect(await w.page.evaluate(() => fetch('/api/canvas/health', { cache: 'no-store' }).then((r) => r.status))).toBe(200);
      await fence;
      expect(w.asked).toEqual([]);
      expect(w.answers).toEqual([]);
      expect(w.failed).toEqual([]);
      expect(w.errors).toEqual([]);
    } finally {
      await w.context.close();
    }
  }, 90_000);
});
