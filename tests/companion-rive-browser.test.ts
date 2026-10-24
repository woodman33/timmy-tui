/**
 * R11 round 5 (H174): the Rive components and their runtime bindings (src/companion/client/rive-bindings.js), the Inspect
 * animation view (screen-inspect-animation.js) and the assets' routes (src/companion/rive-assets.ts), in a real Chromium at
 * 1440x900 and 390x844 on a real companion server on 127.0.0.1 with NO .riv in hand (the words path — the compile of the
 * .rml sources is the operator's Rive tooling's, not this container's):
 *   - a missing asset shows the words of GET /assets/mark.json beside the text mark; no page error; nothing drawn that looks
 *     like the animation (no canvas carries data-loaded);
 *   - the bindings move an input ONLY when a backend event arrives: FAKE events the test injects through the owners' feeds
 *     (TimmyRive.fromProviderState / fromSse / stopping — labelled FAKE in their source), and the page's own GET /api/connections
 *     (REAL: this companion's providerStates for the test home, DERIVED from what H170's screen draws); before them, no event;
 *   - the welcome trigger fires for the person's click / keyboard only, never for a synthetic event;
 *   - prefers-reduced-motion is read (autoplay off; the pause itself needs a loaded file, which is not here: said so);
 *   - the Inspect view lists the T mark and every component with its source files, what the runtime reports (not loaded here:
 *     "not reported", the source's names), the binding events with their sources, and the PREVIEW control labelled
 *     "Preview playback — not an execution, no progress, no receipt"; a preview moves the word and records a PREVIEW event; no
 *     receipt and no progress number appears anywhere in the view;
 *   - the assets' listing is reached through the page (the test splices mountRiveAssets into the companion's stack before its
 *     404 handler — the lead's server.ts mount line stands in for this once merged) and GET /vendor/rive/rive.js is served.
 * FAKE here: the injected events (named FAKE in their source strings). REAL: the companion, its token, the page's code, the
 * runtime file served, the connections read.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { mountRiveAssets } from '../src/companion/rive-assets.js';
import { browserPath, openPage } from './helpers/companion-page-kit.js';
import { ensureCompanionWeb } from '../scripts/companion-web-build.mjs';

const LONG = 240_000;
const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();

/** The test's stand-in for the lead's server.ts mount: my routes placed before the companion's final 404 handler. */
function spliceRiveAssets(app: CompanionServer['app']): void {
  const router = (app as unknown as { _router: { stack: Array<{ route?: { path?: string } }> } })._router;
  // the lead's mount (server.ts, 59d86eca) is there: nothing to splice
  if (router.stack.some((l) => l.route && l.route.path === '/api/rive/assets')) return;
  const before = router.stack.length;
  mountRiveAssets(app);
  const added = router.stack.splice(before, router.stack.length - before);
  // the companion ends its stack with the 404 catch-all and the error handler (server.ts): the routes go after its last route
  let at = before - 1;
  while (at > 0 && !router.stack[at].route) at -= 1;
  router.stack.splice(at + 1, 0, ...added);
}

describe.skipIf(!browserPath)('the Rive components, their bindings and the Inspect animation view, on the operator\'s native asset timmy-ui.riv (R11 round 5, H174)', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let browser: Browser;
  let c: CompanionServer;
  const origin = (): string => `http://127.0.0.1:${c.port}`;
  const tokenOf = (): string => /#t=([0-9a-f]{64})$/.exec(c.url)![1];

  beforeAll(async () => {
    await ensureCompanionWeb();
    // Chromium without this container's proxy variables (H173's harness fact): every request stays on 127.0.0.1
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k))) as Record<string, string>;
    browser = await chromium.launch({ headless: true, executablePath: browserPath, env, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    box = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'h174-rive-'));
    const home = join(box, 'home');
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(join(home, 'models', 'openrouter-catalog.json'), JSON.stringify({ fetchedAt: '2026-10-22T16:00:00.000Z', models: [] }));
    const settings = join(box, 'settings');
    mkdirSync(settings, { recursive: true });
    const envOf = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: settings };
    const root = join(box, 'project');
    mkdirSync(join(root, '.timmy'), { recursive: true });
    process.env.TIMMY_REPO = root;
    c = await startCompanionServer(0, { chatEnv: envOf, workspace: { env: envOf } });
    spliceRiveAssets(c.app);
    if (kept.TIMMY_REPO === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = kept.TIMMY_REPO;
  }, LONG);
  afterAll(async () => {
    await c?.shutdown();
    await browser?.close();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  async function open(size: { width: number; height: number }, reduced = false) {
    const o = await openPage(browser, { origin: origin() }, size);
    if (reduced) await o.page.emulateMedia({ reducedMotion: 'reduce' });
    const consoleErrors: string[] = [];
    o.page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    await o.page.goto(`${origin()}/#t=${tokenOf()}`);
    await o.page.waitForFunction(() => Boolean(document.body.dataset.screen) && Boolean((window as unknown as { TimmyRive?: unknown }).TimmyRive), null, { timeout: 30_000 });
    return { ...o, consoleErrors };
  }
  /** The Inspect view on the #inspect fragment (the shell's screen once H171 adds it; the fragment path meanwhile). */
  async function inspect(page: Page): Promise<void> {
    await page.evaluate(() => { location.hash = '#inspect'; });
    await page.waitForSelector('#screen-inspect:not([hidden]) [data-inspect-component]', { timeout: 30_000 });
    await page.waitForFunction(() => !/Reading the companion/.test(document.querySelector('[data-inspect-listing]')?.textContent || ''), null, { timeout: 30_000 });
    // every component has settled (drawn by the runtime, or the words) before anything is asserted of it
    await page.waitForFunction(() => { const els = [...document.querySelectorAll('[data-inspect-runtime]')]; return els.length >= 7 && els.every((e) => /words only|drawn by/.test(e.textContent || '')); }, null, { timeout: 30_000 });
  }

  it('the operator\'s native asset: the three components are DRAWN by the runtime (REAL: @rive-app/canvas + timmy-ui.riv from this origin, the WebAssembly keyword on), the runtime reports its artboards, TimmyUI and its inputs; the mark stays on the words path (no timmy-mark.riv); a missing file stays words, never an error', async () => {
    const o = await open({ width: 1440, height: 900 });
    try {
      // the companion serves the runtime (installed: @rive-app/canvas), the native asset, and says the mark's file is not here
      const rt = await o.page.evaluate(async () => { const r = await fetch('/vendor/rive/rive.js'); return { status: r.status, type: r.headers.get('content-type') || '' }; });
      expect(rt.status).toBe(200);
      expect(rt.type).toContain('javascript');
      const words = await o.page.evaluate(async () => (await fetch('/assets/mark.json')).json());
      expect(words).toMatchObject({ mark: false, runtime: true });
      const riv = await o.page.evaluate(async () => { const r = await fetch('/assets/rive/timmy-ui/timmy-ui.riv'); const b = await r.arrayBuffer(); return { status: r.status, bytes: b.byteLength }; });
      expect(riv).toEqual({ status: 200, bytes: 405278 });
      // the page's policy carries the WebAssembly keyword now that a .riv and the runtime are here
      const csp = await o.page.evaluate(async () => (await fetch('/', { cache: 'no-store' })).headers.get('content-security-policy') || '');
      expect(csp).toContain('wasm-unsafe-eval');
      await inspect(o.page);
      const cards = await o.page.$$eval('[data-inspect-component]', (els) => els.map((e) => e.getAttribute('data-inspect-component')));
      expect(cards).toEqual(['mark', 'activity', 'connection-openrouter', 'connection-ollama-local', 'connection-ollama-cloud', 'connection-cloudflare', 'welcome']);
      // REAL: the runtime loaded from this origin and drew the six components (canvas[data-loaded] is set by TimmyRive's onLoad only)
      expect(await o.page.evaluate(() => (window as unknown as { TimmyRive: { runtimeState: () => string } }).TimmyRive.runtimeState())).toBe('here');
      expect(await o.page.evaluate(() => typeof (window as unknown as { rive?: { Rive?: unknown } }).rive?.Rive)).toBe('function');
      expect(await o.page.$$eval('canvas[data-timmy-rive][data-loaded]', (els) => els.map((e) => e.getAttribute('data-timmy-rive')).sort())).toEqual(['activity', 'connection-cloudflare', 'connection-ollama-cloud', 'connection-ollama-local', 'connection-openrouter', 'welcome']);
      // the mark: no timmy-mark.riv → the text mark and the companion's words (never an error)
      expect(await o.page.$$eval('[data-inspect-component="mark"] canvas[data-loaded]', (els) => els.length)).toBe(0);
      expect(await text(o.page, '[data-inspect-component="mark"] [data-rive-note]')).toBe(words.words);
      expect(await text(o.page, '[data-inspect-component="mark"] [data-inspect-runtime]')).toMatch(/words only — the companion says the file is not here \(nothing asked for\)/);
      // what the RUNTIME reports of the asset (not the source's names): the three artboards, TimmyUI, the four inputs with values
      type Info = { component: string; state: string; contract: string | null; nativeReduced: boolean; runtime: { artboardNames: string[]; stateMachineNames: string[]; inputs: Array<{ name: string; type: string; value: unknown }> } | null; events: Array<{ input: string; value: unknown; native: { input: string; value: unknown } | null; source: string }> };
      const info = await o.page.evaluate(() => (window as unknown as { TimmyRive: { inspect: () => Info[] } }).TimmyRive.inspect());
      const act = info.find((x) => x.component === 'activity')!;
      expect(act.state).toBe('drawn');
      expect(act.contract).toBe('TimmyUI');
      expect(act.runtime!.artboardNames).toEqual(['AgentConsole', 'ProviderCard', 'ActionButton']);
      expect(act.runtime!.stateMachineNames).toEqual(['TimmyUI']);
      expect(act.runtime!.inputs.map((i) => [i.name, i.type, i.value])).toEqual([['State', 'Number', 0], ['Hover', 'Bool', false], ['Pressed', 'Bool', false], ['ReducedMotion', 'Bool', false]]);
      expect(act.nativeReduced).toBe(true); // the asset HAS the input (false here: motion is not reduced)
      const facts = await text(o.page, '[data-inspect-component="activity"] .tr-facts');
      expect(facts).toContain('timmy-ui.riv');
      expect(facts).toContain('sha256 9fd9ae7c0981');
      expect(facts).toContain('artboard AgentConsole');
      expect(facts).toMatch(/Runtime\s*drawn by @rive-app\/canvas/);
      expect(facts).toContain('AgentConsole, ProviderCard, ActionButton');
      expect(facts).toMatch(/State · Number · 0/);
      expect(facts).toContain('Native contract');
      expect(facts).toContain('stopping → State 1 until the backend says cancelled → 3');
      const conn = await text(o.page, '[data-inspect-component="connection-ollama-local"] .tr-facts');
      expect(conn).toContain('artboard ProviderCard');
      expect(conn).toContain('connected has NO success pose');
      expect(await o.page.$$eval('[data-inspect-component="activity"] .tr-sources a', (as) => as.map((a) => a.textContent))).toEqual(['OFL.txt', 'README.md', 'create-controls.py', 'rive.yaml', 'scene.rml']);
      const rml = await o.page.evaluate(async () => { const r = await fetch('/assets/rive/timmy-ui/scene.rml'); return { status: r.status, body: await r.text() }; });
      expect(rml.status).toBe(200);
      expect(rml.body).toContain('name="AgentConsole"');
      expect(rml.body).toContain('<StateMachine name="TimmyUI"');
      // the listing's words
      const listing = await text(o.page, '[data-inspect-listing]');
      expect(listing).toMatch(/The components with a \.riv are drawn by the runtime/);
      expect(listing).toMatch(/Runtime served by this companion: yes/);
      // the glyphs in the text colour (B10: amber is a role, never a mark); the text fallback hidden under a drawn canvas
      expect(await o.page.$eval('[data-inspect-component="welcome"] .tr-face', (e) => getComputedStyle(e).color)).toBe('rgb(242, 239, 233)');
      expect(await o.page.$eval('[data-inspect-component="welcome"] .tr-fallback', (e) => (e as HTMLElement).hidden)).toBe(true);
      // no page error; the Inspect view asks for no absent file (the mark's is not here: nothing asked). The console carries the
      // runtime's own "Failed to fetch the Rive file: HTTP 404" twice: H171's chat-shell.js drawMarks draws the T mark through
      // window.rive whenever the runtime is present (it was loaded by this view for the native asset), without asking
      // /assets/mark.json first — his one line (an ASK in the handoff); not a page error, and not this view's request
      expect(o.errors).toEqual([]);
      expect(o.consoleErrors.filter((e) => /rive|inspect/i.test(e) && !/Failed to fetch the Rive file: HTTP 404/.test(e))).toEqual([]);
      // a file that is not there: the words path, never a page error (TimmyRive.load with a missing asset; the runtime itself
      // logs "Failed to fetch the Rive file: HTTP 404" to the console — its own words, not a page error)
      const missing = await o.page.evaluate(async () => {
        const R = (window as unknown as { TimmyRive: { load: (c: HTMLCanvasElement, a: string, o: object) => { state: string; why: string } } }).TimmyRive;
        const c = document.createElement('canvas');
        document.body.append(c);
        const hd = R.load(c, '/assets/rive/welcome/welcome.riv', { artboard: 'TimmyWelcome', stateMachine: 'Welcome', component: 'missing' });
        await new Promise<void>((done) => { const t = setInterval(() => { if (hd.state !== 'loading') { clearInterval(t); done(); } }, 50); });
        return { state: hd.state, why: hd.why, loaded: c.dataset.loaded ?? null };
      });
      expect(missing).toEqual({ state: 'words', why: 'the file did not load', loaded: null });
      expect(o.errors).toEqual([]);
      expect(o.consoleErrors.filter((e) => /rive|inspect/i.test(e) && !/Failed to fetch the Rive file: HTTP 404/.test(e))).toEqual([]);
      // the state words: the labels beside the canvases, aria-live
      expect(await text(o.page, '[data-rive-status="connection-ollama-local"]')).toBe('disconnected');
      expect(await text(o.page, '[data-rive-status="activity"]')).toBe('idle');
      expect(await o.page.getAttribute('[data-rive-status="activity"]', 'aria-live')).toBe('polite');
      // the welcome is a real button; a connection is role=img with its label
      expect(await o.page.$eval('[data-inspect-component="welcome"] .tr-face', (e) => e.tagName)).toBe('BUTTON');
      expect(await o.page.getAttribute('[data-inspect-component="connection-openrouter"] .tr-face', 'role')).toBe('img');
      expect(await o.page.getAttribute('[data-inspect-component="connection-openrouter"] .tr-face', 'aria-label')).toBe('Connection to openrouter');
      expect(o.errors).toEqual([]);
      expect(o.consoleErrors.filter((e) => /rive|inspect/i.test(e) && !/Failed to fetch the Rive file: HTTP 404/.test(e))).toEqual([]);
    } finally { await o.context.close(); }
  }, LONG);

  it('the bindings move an input only when a backend event arrives (FAKE events through the owners\' feeds; the REAL connections read, derived from the screen); the welcome trigger is the person\'s only', async () => {
    const o = await open({ width: 1440, height: 900 });
    try {
      await inspect(o.page);
      type Ev = { input: string; value: unknown; source: string; did: string };
      const eventsOf = (key: string) => o.page.evaluate((k) => (window as unknown as { timmyInspectAnimation: { handles: () => Record<string, { events: Ev[]; word: string; values: Record<string, unknown> }> } }).timmyInspectAnimation.handles()[k].events, key);
      // before any event: the welcome and the activity have none (the connection cards may have the page's own GET /api/connections, below)
      expect(await eventsOf('activity')).toEqual([]);
      expect(await eventsOf('welcome')).toEqual([]);
      // FAKE: H170's feed with the backend's word (the test calls it; in the product, screen-connections.js's one line)
      await o.page.evaluate(() => (window as unknown as { TimmyRive: { fromProviderState: (id: string, w: string, s: string) => unknown } }).TimmyRive.fromProviderState('ollama-cloud', 'checked', 'FAKE (the test): GET /api/connections ollama-cloud "checked"'));
      expect(await text(o.page, '[data-rive-status="connection-ollama-cloud"]')).toBe('connected');
      let evs = await eventsOf('connection-ollama-cloud');
      // connected: no success pose is authored → the native State stays 0 Idle, the label says connected, the event says why
      expect(evs[evs.length - 1]).toMatchObject({ input: 'connection', value: 'connected', source: 'FAKE (the test): GET /api/connections ollama-cloud "checked"', did: 'moved (no success pose is authored: State stays 0 Idle; the label says connected)', native: { input: 'State', value: 0 } });
      await o.page.evaluate(() => (window as unknown as { TimmyRive: { fromProviderState: (id: string, w: string, s: string) => unknown } }).TimmyRive.fromProviderState('ollama-cloud', 'refused', 'FAKE (the test): refused'));
      expect(await text(o.page, '[data-rive-status="connection-ollama-cloud"]')).toBe('failed');
      await o.page.evaluate(() => (window as unknown as { TimmyRive: { fromProviderState: (id: string, w: string, s: string) => unknown } }).TimmyRive.fromProviderState('openrouter', 'pending', 'FAKE (the test): pending'));
      expect(await text(o.page, '[data-rive-status="connection-openrouter"]')).toBe('checking');
      // FAKE: H169's SSE names through fromSse, and Stop
      const sse = (event: string, data: unknown) => o.page.evaluate(([e, d]) => (window as unknown as { TimmyRive: { fromSse: (e: string, d: unknown, s: string) => unknown } }).TimmyRive.fromSse(e as string, d, `FAKE (the test): SSE ${e as string}`), [event, data]);
      await sse('turn', { id: 'turn-fake' });
      expect(await text(o.page, '[data-rive-status="activity"]')).toBe('working');
      await sse('tool', { name: 'get_current_time', status: 'asked' });
      expect(await text(o.page, '[data-rive-status="activity"]')).toBe('working');
      await sse('needs-you', { id: 'ask-fake', words: 'FAKE question' });
      expect(await text(o.page, '[data-rive-status="activity"]')).toBe('awaiting approval');
      // the native input moved with the word (REAL: the runtime's State input reads 2 Approval now; the event records it)
      const native = await o.page.evaluate(() => { const x = (window as unknown as { TimmyRive: { inspect: () => Array<{ component: string; runtime: { inputs: Array<{ name: string; value: unknown }> }; events: Array<{ native: unknown }> }> } }).TimmyRive.inspect().find((h) => h.component === 'activity')!; return { state: x.runtime.inputs.find((i) => i.name === 'State')!.value, last: x.events[x.events.length - 1].native }; });
      expect(native).toEqual({ state: 2, last: { input: 'State', value: 2, note: '' } });
      await o.page.evaluate(() => (window as unknown as { TimmyRive: { stopping: (s: string) => unknown } }).TimmyRive.stopping('FAKE (the test): POST /api/chat/stop'));
      expect(await text(o.page, '[data-rive-status="activity"]')).toBe('stopping');
      await sse('done', { status: 'cancelled' });
      expect(await text(o.page, '[data-rive-status="activity"]')).toBe('stopped');
      await sse('error', { words: 'FAKE failure' });
      expect(await text(o.page, '[data-rive-status="activity"]')).toBe('failed');
      await sse('done', { status: 'answered' });
      expect(await text(o.page, '[data-rive-status="activity"]')).toBe('idle');
      // a delta moves nothing new once working; 'route' alone is working
      evs = await eventsOf('activity');
      expect(evs.map((e) => e.value)).toEqual(['working', 'working', 'awaiting', 'stopping', 'stopped', 'failed', 'idle']);
      expect(evs.every((e) => e.source.startsWith('FAKE (the test)'))).toBe(true);
      // each with the contract's input and value: stopping → State 1 (no stopping pose), stopped → 3, failed → 4, idle → 0
      expect(evs.map((e) => (e as unknown as { native: { input: string; value: number } }).native.value)).toEqual([1, 1, 2, 1, 3, 4, 0]);
      expect(evs.map((e) => (e as unknown as { did: string }).did)).toEqual(['moved', 'moved', 'moved', 'moved (no stopping pose: State 1 Working until the backend says cancelled (3))', 'moved', 'moved', 'moved']);
      // the Inspect view shows them with their sources, newest first
      await o.page.evaluate(() => (window as unknown as { timmyInspectAnimation: { redraw: () => void } }).timmyInspectAnimation.redraw());
      const shown = await o.page.$$eval('[data-inspect-events="activity"] li', (els) => els.map((e) => e.getAttribute('data-event-source')));
      expect(shown[0]).toBe('FAKE (the test): SSE done');
      expect(await text(o.page, '[data-inspect-values="activity"]')).toContain('activity = "idle"');
      // the welcome trigger: a synthetic event fires nothing; the person's click fires it once
      const synthetic = await o.page.evaluate(() => { const W = window as unknown as { TimmyRive: { trigger: (h: unknown, i: string, e: Event) => unknown }; timmyInspectAnimation: { handles: () => Record<string, unknown> } }; return W.TimmyRive.trigger(W.timmyInspectAnimation.handles().welcome, 'welcome', new MouseEvent('click')); });
      expect(synthetic).toBeNull();
      expect(await eventsOf('welcome')).toEqual([]);
      await o.page.click('[data-inspect-component="welcome"] .tr-face');
      evs = await eventsOf('welcome');
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({ input: 'welcome', value: 'welcome', source: 'user click' });
      expect(await text(o.page, '[data-rive-status="welcome"]')).toContain('welcome');
      // the keyboard: focus the welcome and press Enter (a button's own click, trusted)
      await o.page.focus('[data-inspect-component="welcome"] .tr-face');
      await o.page.keyboard.press('Enter');
      evs = await eventsOf('welcome');
      expect(evs).toHaveLength(2);
      expect(evs[1].source).toMatch(/^user /);
      // REAL: the page's own connections screen (GET /api/connections on this companion: the test home's providerStates) → the
      // connection components follow what it draws, each event saying it is derived from the drawing, not the event itself
      await o.page.evaluate(() => (window as unknown as { TimmyShell: { go: (id: string) => void } }).TimmyShell.go('connections'));
      await o.page.waitForSelector('#screen-connections [data-provider][data-state]', { timeout: 30_000 });
      await o.page.waitForFunction(() => { const W = window as unknown as { timmyInspectAnimation: { handles: () => Record<string, { events: { source: string }[] }> } }; const h = W.timmyInspectAnimation.handles(); return ['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare'].every((p) => h[`connection-${p}`].events.some((e) => e.source.startsWith('derived from the page'))); }, null, { timeout: 30_000 });
      const drawn = await o.page.$$eval('#screen-connections [data-provider][data-state]', (els) => els.map((e) => [e.getAttribute('data-provider'), e.getAttribute('data-state')]));
      for (const [id, state] of drawn) {
        const list = await eventsOf(`connection-${id}`);
        const derived = list.filter((e) => e.source.startsWith('derived from the page'));
        expect(derived.length, String(id)).toBeGreaterThan(0);
        expect(derived[derived.length - 1].source).toBe(`derived from the page's drawing of GET /api/connections: ${id} data-state="${state}"`);
        const expected = state === 'checked' ? 'connected' : state === 'pending' ? 'checking' : state === 'refused' || state === 'unreachable' ? 'failed' : 'disconnected';
        expect(derived[derived.length - 1].value, String(id)).toBe(expected);
      }
      expect(o.errors).toEqual([]);
    } finally { await o.context.close(); }
  }, LONG);

  it('PREVIEW: labelled, moves the word only, records a PREVIEW event; no receipt and no progress number in the view; reduced motion is read; 390x844 fits', async () => {
    const o = await open({ width: 390, height: 844 }, true);
    try {
      await inspect(o.page);
      expect(await o.page.evaluate(() => (window as unknown as { TimmyRive: { reducedMotion: () => boolean } }).TimmyRive.reducedMotion())).toBe(true);
      const facts = await text(o.page, '[data-inspect-component="connection-openrouter"] .tr-facts');
      // the asset's own ReducedMotion input is set (the runtime's value reads true), not a pause of mine
      expect(facts).toMatch(/Reduced motion\s*on: the asset’s own ReducedMotion input is true/);
      expect(await o.page.evaluate(() => (window as unknown as { TimmyRive: { inspect: () => Array<{ component: string; nativeReduced: boolean; runtime: { inputs: Array<{ name: string; value: unknown }> } }> } }).TimmyRive.inspect().filter((h) => h.runtime).map((h) => [h.nativeReduced, h.runtime.inputs.find((i) => i.name === 'ReducedMotion')!.value]))).toEqual(Array(6).fill([true, true]));
      // the label, exactly, on every card with a preview control
      const labels = await o.page.$$eval('[data-preview-words]', (els) => els.map((e) => (e.textContent || '').trim()));
      expect(labels.length).toBeGreaterThanOrEqual(5);
      expect(new Set(labels)).toEqual(new Set(['Preview playback — not an execution, no progress, no receipt']));
      expect(await o.page.getAttribute('[data-inspect-component="activity"] .tr-previews', 'aria-label')).toBe('Preview playback — not an execution, no progress, no receipt');
      // the welcome has no preview button: the person presses it
      expect(await o.page.$$eval('[data-inspect-component="welcome"] [data-preview]', (els) => els.length)).toBe(0);
      // a preview moves the word and is recorded as PREVIEW; the HTML label follows
      await o.page.click('[data-preview="activity:awaiting"]');
      expect(await text(o.page, '[data-rive-status="activity"]')).toBe('awaiting approval');
      const first = await o.page.$eval('[data-inspect-events="activity"] li', (e) => e.getAttribute('data-event-source'));
      expect(first).toBe('PREVIEW — not an execution, no progress, no receipt');
      await o.page.click('[data-preview="connection-cloudflare:connected"]');
      expect(await text(o.page, '[data-rive-status="connection-cloudflare"]')).toBe('connected');
      await o.page.click('[data-preview="connection-cloudflare:selected"]');
      expect(await text(o.page, '[data-rive-status="connection-cloudflare"]')).toBe('connected · selected');
      // nothing in the view is a receipt or a progress number
      const whole = await text(o.page, '#screen-inspect');
      expect(whole).not.toMatch(/receipt [0-9a-f]{8}|sha256_[0-9a-f]|\b\d{1,3}\s?%/);
      expect(whole).toMatch(/no receipt/);
      // the phone width: one column, no horizontal overflow
      expect(await o.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      // Close clears the fragment and hides the view
      await o.page.click('[data-inspect-close]');
      expect(await o.page.evaluate(() => location.hash)).toBe('');
      expect(await o.page.$eval('#screen-inspect', (e) => (e as HTMLElement).hidden)).toBe(true);
      expect(o.errors).toEqual([]);
    } finally { await o.context.close(); }
  }, LONG);
});
