/**
 * R4 (H109): Timmy Canvas follows the active project unless a board is pinned, in a real headless Chromium against the real canvas
 * server and the real bundle (built here into a temporary folder), with a real temporary Timmy home: the REPL's handoff names
 * alpha (POST /api/project/active with the server's token; FAKE: no REPL takes card actions, so the cards are diagrams), and the
 * active project changes to beta through <TIMMY_HOME>/state/active-project.json, written as src/project/index.ts
 * saveActiveProject writes it. A person's presses are Chromium's own clicks; switching boards is the editor's own call, as
 * tldraw's page menu makes it. Every request the page makes goes to 127.0.0.1 (anything else is aborted). Skipped, saying so,
 * where no Chromium or Chrome is found.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeProjectFile } from '../src/studio/active-follow.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { projectId } from '../src/project/index.js';
import { bearer, grant, nameProject } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-follow-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

type Editor = {
  getCurrentPage: () => { id: string; meta: Record<string, unknown> };
  setCurrentPage: (id: string) => void;
  getShape: (id: string) => { props: Record<string, unknown> } | undefined;
};
type Win = { timmyCanvas: { editor: Editor; placeDrawnCard: (id: string) => Promise<{ shape: string }> } };

describe.skipIf(!browserPath)('Timmy Canvas follows the active project unless a board is pinned, in a real browser', () => {
  let base = '';
  let pageRoot = '';
  let home = '';
  let server: StudioServer;
  let browser: Browser;
  const made: string[] = [];
  const project = (name: string, title: string) => {
    const root = join(mkdtempSync(join(tmpdir(), `timmy-follow-${name}-`)), name);
    made.push(join(root, '..'));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'BUILD.md'), `# ${title}\n\n\`\`\`bash [name:build]\necho build\n\`\`\`\n`);
    return { name, root, id: projectId(root) };
  };
  let alpha: { name: string; root: string; id: string };
  let beta: { name: string; root: string; id: string };

  beforeAll(async () => {
    alpha = project('alpha', 'Alpha build');
    beta = project('beta', 'Beta build');
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-canvas-follow-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-canvas-follow-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    // a server that serves this Timmy home for its REPLs (as the REPL's own and `timmy studio` do): it follows the active project
    server = await startStudioServer(0, { env: { TIMMY_HOME: home }, root: pageRoot, projectTokenFile: true, followEveryMs: 100, followGraceMs: 200 });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await nameProject(Number(new URL(base).port), server.projectToken, { root: alpha.root, name: 'alpha', holder: 'a'.repeat(32) });
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of [...made, pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
  const shows = (page: Page, name: string) => page.waitForFunction((n) => document.getElementById('project-name')?.textContent === n, name, { timeout: 20_000 });

  it("a following board changes project with the active project (its cards keep theirs); a board pinned to alpha keeps alpha, visibly, saved with the board; unpinned, it follows again", async () => {
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
      await shows(page, 'alpha');
      // board 1 follows: it says so, offers to pin it, and shows no pin
      expect(await text(page, '#project-follow')).toBe('This board follows the project the canvas shows (the active project).');
      expect(await page.isHidden('#project-pinned')).toBe(true);
      expect(await text(page, '#project-pin')).toBe('Pin this board to alpha');
      const board1 = await page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentPage().id);
      const a1 = (await page.evaluate(() => (window as never as Win).timmyCanvas.placeDrawnCard('workflow:BUILD.md'))).shape;

      // board 2 (New board → Open), pinned to alpha with the panel's Pin (a person's click), with alpha's card on it
      await page.click('#board-open');
      await page.waitForFunction((b1) => (window as never as Win).timmyCanvas.editor.getCurrentPage().id !== b1, board1);
      const board2 = await page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentPage().id);
      await page.click('#project-pin');
      await page.waitForFunction(() => document.getElementById('project-pinned')?.hidden === false);
      expect(await text(page, '#project-said')).toBe('This board is pinned to alpha: it keeps it when the active project changes.');
      expect(await text(page, '#project-pinned')).toBe('pinned');
      expect(await text(page, '#project-follow')).toBe('Pinned to alpha: this board keeps it when the active project changes, and its cards are read from it.');
      expect(await text(page, '#project-pin')).toBe('Follow the active project');
      const a2 = (await page.evaluate(() => (window as never as Win).timmyCanvas.placeDrawnCard('workflow:BUILD.md'))).shape;

      // back on board 1, the active project changes to beta (the file, as /project writes it)
      await page.evaluate((id) => { (window as never as Win).timmyCanvas.editor.setCurrentPage(id); }, board1);
      await shows(page, 'alpha');
      const file = activeProjectFile({ TIMMY_HOME: home });
      mkdirSync(join(home, 'state'), { recursive: true });
      writeFileSync(`${file}.tmp`, `${JSON.stringify({ name: 'beta', root: beta.root, at: new Date().toISOString() })}\n`, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      // board 1 follows it: its panel shows beta's cards, and the band says what changed and what did not
      await shows(page, 'beta');
      await page.waitForSelector('#project-groups li.pcard[data-card="workflow:BUILD.md"]');
      expect(await text(page, '#project-groups li.pcard[data-card="workflow:BUILD.md"] .pcard-title')).toBe('Beta build');
      expect(await text(page, '#project-said')).toBe('The canvas now shows beta, the active project of this Timmy home (it showed alpha). Cards of alpha on this board stay, shown as last read; nothing on the board was changed.');
      // its card of alpha keeps alpha (never re-targeted), shown as last read
      await page.waitForFunction((s) => /^Not followed now: the canvas shows beta, not alpha\. Shown as last read\.$/.test(document.querySelector(`[data-timmy-card="${s}"] .tc-mode`)?.textContent ?? ''), a1, { timeout: 15_000 });
      expect(await page.evaluate((s) => (window as never as Win).timmyCanvas.editor.getShape(s)!.props.projectId, a1)).toBe(alpha.id);
      expect(await text(page, `[data-timmy-card="${a1}"] .tc-title`)).toBe('Alpha build');

      // board 2, pinned, keeps alpha: the pin and the project the canvas shows, both said; its card of alpha is read from alpha now
      await page.evaluate((id) => { (window as never as Win).timmyCanvas.editor.setCurrentPage(id); }, board2);
      await shows(page, 'alpha');
      await page.waitForFunction(() => /The canvas shows beta now\.$/.test(document.getElementById('project-follow')?.textContent ?? ''), null, { timeout: 15_000 });
      expect(await text(page, '#project-follow')).toBe('Pinned to alpha: this board keeps it when the active project changes, and its cards are read from it. The canvas shows beta now.');
      expect(await page.isHidden('#project-pinned')).toBe(false);
      expect(await text(page, '#project-groups li.pcard[data-card="workflow:BUILD.md"] .pcard-title')).toBe('Alpha build');
      await page.waitForFunction((s) => /^This board is pinned to alpha, and the canvas shows beta now/.test(document.querySelector(`[data-timmy-card="${s}"] .tc-mode`)?.textContent ?? ''), a2, { timeout: 15_000 });
      expect(await text(page, `[data-timmy-card="${a2}"] .tc-mode`)).toBe('This board is pinned to alpha, and the canvas shows beta now: alpha\'s cards are read here and act through no Timmy REPL. To act on them: /canvas open in Timmy, in alpha.');
      expect(await text(page, `[data-timmy-card="${a2}"] .tc-read`)).toMatch(/^read from Timmy's records at /);

      // the pin is the board's own, saved with the document by Timmy
      let saved: { snapshot?: { store?: Record<string, { typeName?: string; id?: string; meta?: Record<string, unknown> }> } } = {};
      for (let i = 0; i < 40; i++) {
        saved = await (await fetch(`${base}/api/canvas/document`, { headers: bearer(server.projectToken) })).json() as typeof saved;
        if (saved.snapshot?.store?.[board2]?.meta?.timmyPin) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(saved.snapshot!.store![board2].meta!.timmyPin).toMatchObject({ projectId: alpha.id, project: 'alpha' });
      expect(saved.snapshot!.store![board1].meta?.timmyPin).toBeUndefined();

      // unpinned (a person's click), board 2 follows the project the canvas shows again
      await page.click('#project-pin');
      await shows(page, 'beta');
      expect(await text(page, '#project-said')).toBe('This board follows the project the canvas shows again (it was pinned to alpha).');
      expect(await page.isHidden('#project-pinned')).toBe(true);
      expect([...origins].every((x) => x === base)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 180_000);
});
