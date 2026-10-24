/**
 * R11 round 5 (H174): the `timmy-rive` shape on Timmy Canvas (companion/studio-canvas/src/rive-shape.js) in a real Chromium on the
 * real Studio server and bundle, on the operator's native asset timmy-ui.riv: the Studio serves the runtime (/vendor/rive/,
 * mountRive) and the asset + listing (/assets/rive/, mountRiveAssets — the lead's 59d86eca), so the shape's artboard
 * (ProviderCard) is DRAWN by the runtime (REAL) beside the exact state word (HTML, aria-live), never an error; selection and width move the `selected` / `expanded` inputs (tldraw's
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

type Win = { timmyCanvas: { editor: { getShape: (id: string) => { props: Record<string, unknown>; x: number; y: number } | undefined; select: (...ids: string[]) => void; selectNone: () => void; updateShape: (s: unknown) => void; createShape: (s: unknown) => void; createBindings: (b: unknown[]) => void; getBindingsToShape: (id: string, type: string) => unknown[]; getShapePageBounds: (id: string) => { x: number; y: number; w: number; h: number } | undefined; getCurrentPageShapes: () => Array<{ id: string; type: string; props: Record<string, unknown> }>; licenseManager?: { state: { get: () => string }; isDevelopment: boolean } }; placeRive: (c: string, o?: Record<string, unknown>) => string }; TimmyRive: { fromProviderState: (id: string, w: string, s: string) => unknown; inspect: () => Array<{ component: string; state: string; why: string; runtime: { inputs: Array<{ name: string; value: unknown }> }; events: Array<{ input: string; value: unknown; source: string }> }>; runtimeState: () => string; handles: () => unknown[] } };
/** The capture of the welcome shape at 100 %: written beside the report when H174_CAPS names that folder, else skipped. */
const CAP_DIR = process.env.H174_CAPS || '';
const CAP_WELCOME = CAP_DIR ? join(CAP_DIR, 'studio-welcome-face-100pct.png') : '';

describe.skipIf(!browserPath)('the timmy-rive shape on Timmy Canvas, drawn from the operator\'s native asset (R11 round 5, H174)', () => {
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
    page.on('crash', () => errors.push('the page CRASHED (the renderer died)'));
    page.on('framenavigated', (f) => { if (f === page.mainFrame() && !/#code=/.test(f.url()) && navigations.push(f.url()) > 1) errors.push(`the page navigated again: ${f.url()}`); });
    const navigations: string[] = [];
    await page.goto(`${base}/#code=${await grant(port(), server!.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    return { page, context, errors };
  }
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();

  it('places a connection shape: ProviderCard drawn by the runtime beside the state word, selected (→ Hover) and expanded from tldraw, FAKE backend words kept with the board (checking → State 1; connected → State 0, no success pose)', async () => {
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
      expect(await page.$eval('[data-timmy-rive-shape] .tr-fallback', (e) => (e as HTMLElement).textContent)).toBe('○');
      // REAL: the Studio serves the runtime (/vendor/rive/) and the operator's native asset; the shape's ProviderCard is DRAWN
      await page.waitForFunction(() => (window as unknown as Win).TimmyRive.inspect().every((x) => x.state === 'drawn'), null, { timeout: 20_000 });
      const info = await page.evaluate(() => (window as unknown as Win).TimmyRive.inspect() as unknown as Array<{ component: string; state: string; why: string; contract: string | null; runtime: { artboardNames: string[]; stateMachineNames: string[]; inputs: Array<{ name: string; value: unknown }> } }>);
      expect(info).toHaveLength(1);
      expect(info[0].component).toBe('connection:ollama-local');
      expect(info[0].state).toBe('drawn');
      expect(info[0].contract).toBe('TimmyUI');
      expect(info[0].runtime.artboardNames).toEqual(['AgentConsole', 'ProviderCard', 'ActionButton']);
      expect(info[0].runtime.stateMachineNames).toEqual(['TimmyUI']);
      expect(await text(page, '[data-timmy-rive-shape] [data-rive-note]')).toBe('');
      const served = await page.evaluate(async () => ({ rt: (await fetch('/vendor/rive/rive.js')).status, list: await (await fetch('/api/rive/assets')).json() }));
      expect(served.rt).toBe(200);
      expect(served.list.runtime).toBe(true);
      expect(served.list.components.map((c: { component: string; riv: { name: string } | null }) => [c.component, c.riv ? c.riv.name : null])).toEqual([['activity', null], ['connection', null], ['timmy-ui', 'timmy-ui.riv'], ['welcome', null]]);
      expect(await page.$$eval('[data-timmy-rive-shape] canvas[data-loaded]', (els) => els.length)).toBe(1);
      expect(await text(page, '[data-timmy-rive-shape] .tr-shape-source')).toContain('as saved with the board; no backend event has set it on this page');
      // tldraw's selection → selected; its width → expanded
      await page.evaluate((sid) => (window as unknown as Win).timmyCanvas.editor.select(sid), id);
      await page.waitForSelector('[data-timmy-rive-shape].is-selected', { timeout: 10_000 });
      expect(await text(page, '[data-timmy-rive-shape] [data-rive-status]')).toBe('disconnected · selected');
      expect(await text(page, '[data-timmy-rive-shape] .tr-shape-foot')).toContain('selected');
      await page.evaluate((sid) => { const W = window as unknown as Win; const s = W.timmyCanvas.editor.getShape(sid)!; W.timmyCanvas.editor.updateShape({ id: sid, type: 'timmy-rive', props: { ...s.props, w: 420 } }); }, id);
      await page.waitForSelector('[data-timmy-rive-shape].is-expanded', { timeout: 10_000 });
      expect(await text(page, '[data-timmy-rive-shape] .tr-shape-more')).toContain('ProviderCard · TimmyUI: State, Hover, Pressed, ReducedMotion');
      expect(await text(page, '[data-timmy-rive-shape] [data-rive-status]')).toBe('disconnected · selected · expanded');
      await page.evaluate(() => (window as unknown as Win).timmyCanvas.editor.selectNone());
      await page.waitForSelector('[data-timmy-rive-shape]:not(.is-selected)', { timeout: 10_000 });
      let events = (await page.evaluate(() => (window as unknown as Win).TimmyRive.inspect()))[0].events;
      expect(events.map((e) => [e.input, e.value, e.source.split(' (')[0]])).toEqual([['selected', false, 'tldraw selection'], ['expanded', false, 'tldraw size'], ['selected', true, 'tldraw selection'], ['expanded', true, 'tldraw size'], ['selected', false, 'tldraw selection']]);
      // FAKE: the backend's word through H170's feed (the test calls it) → the shape's word, and the board keeps it; the native
      // State moves with the words that have a pose (checking → 1), and connected has none (State 0: the label alone says it)
      await page.evaluate(() => (window as unknown as Win).TimmyRive.fromProviderState('ollama-local', 'pending', 'FAKE (the test): pending'));
      await page.waitForFunction(() => document.querySelector('[data-timmy-rive-shape]')?.getAttribute('data-state') === 'checking', null, { timeout: 10_000 });
      expect(await page.evaluate(() => (window as unknown as Win).TimmyRive.inspect()[0].runtime.inputs.find((i: { name: string }) => i.name === 'State')!.value)).toBe(1);
      await page.evaluate(() => (window as unknown as Win).TimmyRive.fromProviderState('ollama-local', 'checked', 'FAKE (the test): GET /api/connections ollama-local "checked"'));
      await page.waitForFunction(() => document.querySelector('[data-timmy-rive-shape]')?.getAttribute('data-state') === 'connected', null, { timeout: 10_000 });
      expect(await page.evaluate(() => (window as unknown as Win).TimmyRive.inspect()[0].runtime.inputs.find((i: { name: string }) => i.name === 'State')!.value)).toBe(0);
      expect(await text(page, '[data-timmy-rive-shape] [data-rive-status]')).toBe('connected · expanded');
      expect(await text(page, '[data-timmy-rive-shape] .tr-shape-source')).toBe('from FAKE (the test): GET /api/connections ollama-local "checked"');
      await page.waitForFunction((sid) => (window as unknown as Win).timmyCanvas.editor.getShape(sid)?.props.state === 'connected', id, { timeout: 10_000 });
      // another provider's word moves nothing here (the shape is bound to its own)
      await page.evaluate(() => (window as unknown as Win).TimmyRive.fromProviderState('openrouter', 'refused', 'FAKE (the test): another provider'));
      expect(await page.getAttribute('[data-timmy-rive-shape]', 'data-state')).toBe('connected');
      events = (await page.evaluate(() => (window as unknown as Win).TimmyRive.inspect()))[0].events;
      expect(events.filter((e) => e.input === 'connection')).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 120_000);

  it('places a welcome shape: a real button; its trigger fires for the person\'s click only; the activity shape\'s word is idle', async () => {
    const { page, context, errors } = await open();
    try {
      // (the welcome first, clicked while it is the shape in view; the activity placed after — no camera move: a zoomToFit here
      // has ended the page's execution context in some runs, cause not pinned, see the report)
      // placed at the viewport's centre (the board already holds the first case's shapes: a free spot would be off screen)
      await page.evaluate(() => { const W = window as unknown as Win & { timmyCanvas: { editor: { getViewportPageBounds: () => { x: number; y: number; w: number; h: number } } } }; const v = W.timmyCanvas.editor.getViewportPageBounds(); W.timmyCanvas.placeRive('welcome', { at: { x: Math.round(v.x + v.w / 2 - 120), y: Math.round(v.y + v.h / 2 - 100) } }); });
      const face = page.locator('[data-timmy-rive-shape][data-component="welcome"] .tr-face');
      await face.waitFor({ state: 'visible', timeout: 10_000 });
      expect(await face.evaluate((e) => e.tagName)).toBe('BUTTON');
      // readable and usable as a button at 100 %: the face fills the shape's content width at 240:72 (H172's capture at 9447d6f8
      // showed a 38×9 px pill — the component was an inline-grid shrunk to its word); its box ≥ 200×60 at zoom 1; a wider
      // shape scales it; the artboard's own label run is the shape's label; a capture at 100 % beside the report
      await page.evaluate(() => { const ed = (window as unknown as Win & { timmyCanvas: { editor: { getZoomLevel: () => number; resetZoom: () => unknown } } }).timmyCanvas.editor; if (Math.abs(ed.getZoomLevel() - 1) > 0.001) ed.resetZoom(); return 'ok'; });
      await page.waitForTimeout(250);
      const box = await face.boundingBox();
      expect(box, 'the face at 100 %').not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(200);
      expect(box!.height).toBeGreaterThanOrEqual(60);
      expect(Math.abs(box!.width / box!.height - 240 / 72)).toBeLessThan(0.15);
      await page.waitForFunction(() => (window as unknown as Win).TimmyRive.inspect().find((x) => x.component === 'welcome')!.state === 'drawn', null, { timeout: 20_000 });
      const runs = await page.evaluate(() => { const R = (window as unknown as Win).TimmyRive; const hd = (R.handles() as Array<{ component: string; rive: { getTextRunValue: (n: string) => string | undefined } | null }>).find((x) => x.component === 'welcome')!; return { idle: hd.rive!.getTextRunValue('Connect provider'), arrow: hd.rive!.getTextRunValue('→') }; });
      expect(runs).toEqual({ idle: 'Welcome / guide', arrow: '→' });
      const wider = await page.evaluate(() => { const W = window as unknown as Win & { timmyCanvas: { editor: { getCurrentPageShapes: () => Array<{ id: string; type: string; props: { component?: string; w: number; h: number } }>; updateShape: (s: { id: string; type: string; props: { w: number } }) => unknown } } }; const ed = W.timmyCanvas.editor; const sh = ed.getCurrentPageShapes().find((x) => x.type === 'timmy-rive' && x.props.component === 'welcome')!; ed.updateShape({ id: sh.id, type: sh.type, props: { w: sh.props.w * 1.5 } }); return sh.props.w * 1.5; });
      await page.waitForTimeout(250);
      const box2 = await face.boundingBox();
      expect(box2!.width).toBeGreaterThan(box!.width * 1.3);
      expect(box2!.width).toBeLessThanOrEqual(wider);
      if (CAP_DIR && existsSync(CAP_DIR)) await page.screenshot({ path: CAP_WELCOME, clip: { x: Math.max(0, box2!.x - 40), y: Math.max(0, box2!.y - 80), width: Math.min(900, box2!.width + 80), height: box2!.height + 220 } }).catch(() => undefined);
      const before = await page.evaluate(() => (window as unknown as Win).TimmyRive.inspect().find((x) => x.component === 'welcome')!.events.filter((e) => e.input === 'welcome').length);
      expect(before).toBe(0);
      await face.click();
      await page.waitForFunction(() => (window as unknown as Win).TimmyRive.inspect().find((x) => x.component === 'welcome')!.events.some((e) => e.input === 'welcome'), null, { timeout: 10_000 });
      const ev = await page.evaluate(() => (window as unknown as Win).TimmyRive.inspect().find((x) => x.component === 'welcome')!.events.filter((e) => e.input === 'welcome'));
      expect(ev).toHaveLength(1);
      expect(ev[0].source).toBe('user click');
      expect(await text(page, '[data-timmy-rive-shape][data-component="welcome"] [data-rive-status]')).toContain('welcome');
      await page.evaluate(() => (window as unknown as Win).timmyCanvas.placeRive('activity'));
      await page.waitForSelector('[data-timmy-rive-shape][data-component="activity"]', { state: 'attached', timeout: 20_000 });
      expect(await page.$eval('[data-timmy-rive-shape][data-component="activity"] [data-rive-status]', (e) => (e.textContent || '').trim())).toBe('idle');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 120_000);
  it('R11 round 6: an arrow BINDS to the shape through tldraw\'s default binding and follows its move; the artboard is picked on the shape (a <select>, keyboard reachable) and the props are SAVED through the Studio\'s board save, present on reopen', async () => {
    const { page, context, errors } = await open();
    try {
      const id = await page.evaluate(() => (window as unknown as Win).timmyCanvas.placeRive('activity', { label: 'Console on the board' }));
      await page.waitForSelector('[data-timmy-rive-shape][data-component="activity"]', { state: 'attached', timeout: 20_000 });
      // an arrow bound to the shape (tldraw's own arrow binding; ShapeUtil.canBind's default is true, read in @tldraw/editor)
      const bound = await page.evaluate((sid) => {
        const ed = (window as unknown as Win).timmyCanvas.editor;
        const shape = ed.getShape(sid)!;
        const arrowId = `shape:h174-arrow-${Date.now()}`;
        ed.createShape({ id: arrowId, type: 'arrow', x: shape.x - 200, y: shape.y - 100, props: { start: { x: 0, y: 0 }, end: { x: 200, y: 100 } } });
        ed.createBindings([{ id: `binding:h174-${Date.now()}`, type: 'arrow', fromId: arrowId, toId: sid, props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } }]);
        const before = ed.getShapePageBounds(arrowId)!;
        ed.updateShape({ id: sid, type: 'timmy-rive', x: shape.x + 300, y: shape.y + 120 });
        const after = ed.getShapePageBounds(arrowId)!;
        return { bindings: ed.getBindingsToShape(sid, 'arrow').length, arrowId, moved: Math.round(after.x + after.w - (before.x + before.w)), movedY: Math.round(after.y + after.h - (before.y + before.h)) };
      }, id);
      expect(bound.bindings).toBe(1);
      expect(bound.moved).toBeGreaterThan(200); // the arrow's far end followed the shape's move
      expect(bound.movedY).toBeGreaterThan(80);
      // the artboard picked on the shape: the <select> is a native control; its change writes the props
      // (the shape may sit outside the viewport after its move: the native <select> is driven by its own change event here —
      // the handler is what is tested; the control is a native select, reachable by Tab and the arrow keys when on screen)
      const select = page.locator(`[data-rive-pick="${id}"]`);
      expect(await select.evaluate((e) => (e as HTMLSelectElement).value)).toBe('activity');
      expect(await select.evaluate((e) => [...(e as HTMLSelectElement).options].map((o) => [o.value, o.textContent]))).toEqual([['welcome', 'ActionButton'], ['connection', 'ProviderCard'], ['activity', 'AgentConsole']]);
      await select.evaluate((e) => { const el = e as HTMLSelectElement; el.value = 'connection'; el.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitForFunction((sid) => (window as unknown as Win).timmyCanvas.editor.getShape(sid)?.props.component === 'connection', id, { timeout: 10_000 });
      await page.waitForSelector(`[data-timmy-rive-shape][data-component="connection"]`, { state: 'attached', timeout: 10_000 });
      expect(await page.evaluate((sid) => { const p = (window as unknown as Win).timmyCanvas.editor.getShape(sid)!.props; return [p.component, p.label, p.state]; }, id)).toEqual(['connection', 'Provider connection', 'disconnected']);
      // the board save (the Studio's own, under the project): saved, then the same shape with its props in a new page
      await page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: 20_000 });
      const saved = await page.evaluate(([sid, aid]) => (window as unknown as Win).timmyCanvas.editor.getCurrentPageShapes().filter((s) => s.id === sid || s.id === aid).map((s) => [s.id, s.type]), [id, bound.arrowId]);
      expect(saved.map((s) => s[1]).sort()).toEqual(['arrow', 'timmy-rive']);
      expect(errors).toEqual([]);
      await context.close();
      const again = await open();
      try {
        const reopened = await again.page.evaluate((sid) => { const ed = (window as unknown as Win).timmyCanvas.editor; return ed.getCurrentPageShapes().filter((s) => s.id === sid).map((s) => [s.id, s.props.component, s.props.label, s.props.state, ed.getBindingsToShape(s.id, 'arrow').length]); }, id);
        expect(reopened).toEqual([[id, 'connection', 'Provider connection', 'disconnected', 1]]);
        await again.page.waitForSelector(`[data-timmy-rive-shape="${id}"] canvas[data-loaded]`, { state: 'attached', timeout: 20_000 });
        expect(again.errors).toEqual([]);
      } finally { await again.context.close(); }
    } finally { try { await context.close(); } catch { /* closed above */ } }
  }, 180_000);

});
