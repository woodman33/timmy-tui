/**
 * R11 round 5 (H174): the `timmy-rive` shape on Timmy Canvas (companion/studio-canvas/src/rive-shape.js) in a real Chromium on the
 * real Studio server and bundle, with NO .riv and no Rive runtime on the Studio's origin (its server does not serve /vendor/rive/
 * or /assets/rive/ until the lead mounts mountRive + mountRiveAssets there): the shape draws its words and the text mark beside
 * the exact state word (HTML, aria-live), never an error; selection and width move the `selected` / `expanded` inputs (tldraw's
 * own facts); a FAKE backend event through TimmyRive.fromProviderState (the test's, named FAKE) moves the connection word and
 * the shape keeps it with the board (props.state); the welcome shape's trigger is the person's click only. Nothing animates
 * here, and the shape says why.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { grant, nameProject } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find((p): p is string => Boolean(p) && existsSync(p!));

type Win = { timmyCanvas: { editor: { getShape: (id: string) => { props: Record<string, unknown>; x: number; y: number } | undefined; select: (...ids: string[]) => void; selectNone: () => void; updateShape: (s: unknown) => void }; placeRive: (c: string, o?: Record<string, unknown>) => string }; TimmyRive: { fromProviderState: (id: string, w: string, s: string) => unknown; inspect: () => Array<{ component: string; state: string; why: string; events: Array<{ input: string; value: unknown; source: string }> }>; runtimeState: () => string } };

describe.skipIf(!browserPath)('the timmy-rive shape on Timmy Canvas, with no .riv and no runtime on the Studio\'s origin (R11 round 5, H174)', () => {
  let root = '';
  let home = '';
  let server: StudioServer | undefined;
  let browser: Browser | undefined;
  let base = '';
  const port = (): number => (server!.address() as AddressInfo).port;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'h174-rive-shape-root-'));
    home = mkdtempSync(join(tmpdir(), 'h174-rive-shape-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(root, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(root, 'dist'), { licenses: root });
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root });
    base = `http://127.0.0.1:${port()}`;
    mkdirSync(join(home, 'project'));
    await nameProject(port(), server.projectToken, { root: join(home, 'project'), name: 'rive-shape-browser' });
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k))) as Record<string, string>;
    browser = await chromium.launch({ headless: true, executablePath: browserPath, env, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  async function open(): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#code=${await grant(port(), server!.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    return { page, context, errors };
  }
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();

  it('places a connection shape: the word beside the text mark, no runtime here (said so), selected and expanded from tldraw, a FAKE backend word kept with the board', async () => {
    const { page, context, errors } = await open();
    try {
      const id = await page.evaluate(() => (window as unknown as Win).timmyCanvas.placeRive('connection', { provider: 'ollama-local', label: 'Ollama · local' }));
      expect(typeof id).toBe('string');
      await page.waitForSelector('[data-timmy-rive-shape][data-component="connection"]', { timeout: 20_000 });
      const shape = page.locator('[data-timmy-rive-shape][data-component="connection"]');
      expect(await shape.getAttribute('data-state')).toBe('disconnected');
      expect(await text(page, '[data-timmy-rive-shape] [data-rive-status]')).toBe('disconnected');
      expect(await page.getAttribute('[data-timmy-rive-shape] [data-rive-status]', 'aria-live')).toBe('polite');
      expect(await text(page, '[data-timmy-rive-shape] .tr-shape-title')).toBe('Ollama · local');
      expect(await text(page, '[data-timmy-rive-shape] .tr-fallback')).toBe('○');
      // no runtime on this origin: the component settled on its words, nothing drawn by a runtime, the reason said
      await page.waitForFunction(() => (window as unknown as Win).TimmyRive.inspect().every((x) => x.state === 'words'), null, { timeout: 20_000 });
      const info = await page.evaluate(() => (window as unknown as Win).TimmyRive.inspect());
      expect(info).toHaveLength(1);
      expect(info[0].component).toBe('connection:ollama-local');
      expect(info[0].why).toMatch(/serves no Rive runtime|not loaded/);
      expect(await page.$$eval('[data-timmy-rive-shape] canvas[data-loaded]', (els) => els.length)).toBe(0);
      expect(await text(page, '[data-timmy-rive-shape] .tr-shape-source')).toContain('as saved with the board; no backend event has set it on this page');
      // tldraw's selection → selected; its width → expanded
      await page.evaluate((sid) => (window as unknown as Win).timmyCanvas.editor.select(sid), id);
      await page.waitForSelector('[data-timmy-rive-shape].is-selected', { timeout: 10_000 });
      expect(await text(page, '[data-timmy-rive-shape] [data-rive-status]')).toBe('disconnected · selected');
      expect(await text(page, '[data-timmy-rive-shape] .tr-shape-foot')).toContain('selected');
      await page.evaluate((sid) => { const W = window as unknown as Win; const s = W.timmyCanvas.editor.getShape(sid)!; W.timmyCanvas.editor.updateShape({ id: sid, type: 'timmy-rive', props: { ...s.props, w: 420 } }); }, id);
      await page.waitForSelector('[data-timmy-rive-shape].is-expanded', { timeout: 10_000 });
      expect(await text(page, '[data-timmy-rive-shape] .tr-shape-more')).toContain('Connection · inputs: connection, selected, expanded');
      expect(await text(page, '[data-timmy-rive-shape] [data-rive-status]')).toBe('disconnected · selected · expanded');
      await page.evaluate(() => (window as unknown as Win).timmyCanvas.editor.selectNone());
      await page.waitForSelector('[data-timmy-rive-shape]:not(.is-selected)', { timeout: 10_000 });
      let events = (await page.evaluate(() => (window as unknown as Win).TimmyRive.inspect()))[0].events;
      expect(events.map((e) => [e.input, e.value, e.source.split(' (')[0]])).toEqual([['selected', false, 'tldraw selection'], ['expanded', false, 'tldraw size'], ['selected', true, 'tldraw selection'], ['expanded', true, 'tldraw size'], ['selected', false, 'tldraw selection']]);
      // FAKE: the backend's word through H170's feed (the test calls it) → the shape's word, and the board keeps it
      await page.evaluate(() => (window as unknown as Win).TimmyRive.fromProviderState('ollama-local', 'checked', 'FAKE (the test): GET /api/connections ollama-local "checked"'));
      await page.waitForFunction(() => document.querySelector('[data-timmy-rive-shape]')?.getAttribute('data-state') === 'connected', null, { timeout: 10_000 });
      expect(await text(page, '[data-timmy-rive-shape] [data-rive-status]')).toBe('connected · expanded');
      expect(await text(page, '[data-timmy-rive-shape] .tr-shape-source')).toBe('from FAKE (the test): GET /api/connections ollama-local "checked"');
      await page.waitForFunction((sid) => (window as unknown as Win).timmyCanvas.editor.getShape(sid)?.props.state === 'connected', id, { timeout: 10_000 });
      // another provider's word moves nothing here (the shape is bound to its own)
      await page.evaluate(() => (window as unknown as Win).TimmyRive.fromProviderState('openrouter', 'refused', 'FAKE (the test): another provider'));
      expect(await page.getAttribute('[data-timmy-rive-shape]', 'data-state')).toBe('connected');
      events = (await page.evaluate(() => (window as unknown as Win).TimmyRive.inspect()))[0].events;
      expect(events.filter((e) => e.input === 'connection')).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 120_000);

  it('places a welcome shape: a real button; its trigger fires for the person\'s click only; the activity shape\'s word is idle', async () => {
    const { page, context, errors } = await open();
    try {
      await page.evaluate(() => (window as unknown as Win).timmyCanvas.placeRive('welcome'));
      await page.evaluate(() => (window as unknown as Win).timmyCanvas.placeRive('activity'));
      await page.waitForSelector('[data-timmy-rive-shape][data-component="activity"]', { state: 'attached', timeout: 20_000 });
      // both in view (the second is placed clear of the first, which may be off screen)
      await page.evaluate(() => (window as unknown as { timmyCanvas: { editor: { zoomToFit: () => void } } }).timmyCanvas.editor.zoomToFit());
      const face = page.locator('[data-timmy-rive-shape][data-component="welcome"] .tr-face');
      await face.waitFor({ state: 'visible', timeout: 10_000 });
      expect(await face.evaluate((e) => e.tagName)).toBe('BUTTON');
      expect(await text(page, '[data-timmy-rive-shape][data-component="activity"] [data-rive-status]')).toBe('idle');
      const before = await page.evaluate(() => (window as unknown as Win).TimmyRive.inspect().find((x) => x.component === 'welcome')!.events.filter((e) => e.input === 'welcome').length);
      expect(before).toBe(0);
      await face.click();
      await page.waitForFunction(() => (window as unknown as Win).TimmyRive.inspect().find((x) => x.component === 'welcome')!.events.some((e) => e.input === 'welcome'), null, { timeout: 10_000 });
      const ev = await page.evaluate(() => (window as unknown as Win).TimmyRive.inspect().find((x) => x.component === 'welcome')!.events.filter((e) => e.input === 'welcome'));
      expect(ev).toHaveLength(1);
      expect(ev[0].source).toBe('user click');
      expect(await text(page, '[data-timmy-rive-shape][data-component="welcome"] [data-rive-status]')).toContain('welcome');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 120_000);
});
