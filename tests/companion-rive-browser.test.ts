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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { mountRiveAssets, riveAssetsDir } from '../src/companion/rive-assets.js';

/**
 * RIVE CONTRACT v2 (R11 round 7): the source is v2; the SERVED .riv is the one CONTRACT.json names — the round-5 v1 build until
 * the lead's Mac build of v2 lands (the Rive CLI is not in this container). The v2-only reads (the named runs, the preview
 * variants, reduced motion settling) run on a v2 file and are SKIPPED, said so, on v1 — never faked.
 */
const CONTRACT = JSON.parse(readFileSync(join(riveAssetsDir(), 'timmy-ui', 'CONTRACT.json'), 'utf8')) as { version: number; asset: { contractOfTheServedFile: number } };
const SERVED_V2 = CONTRACT.asset.contractOfTheServedFile >= 2;
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
      expect(riv).toEqual({ status: 200, bytes: (CONTRACT as unknown as { asset: { bytes: number } }).asset.bytes });
      // the page's policy carries the WebAssembly keyword now that a .riv and the runtime are here
      const csp = await o.page.evaluate(async () => (await fetch('/', { cache: 'no-store' })).headers.get('content-security-policy') || '');
      expect(csp).toContain('wasm-unsafe-eval');
      await inspect(o.page);
      const cards = await o.page.$$eval('[data-inspect-component]', (els) => els.map((e) => e.getAttribute('data-inspect-component')));
      expect(cards).toEqual(['mark', 'activity', 'connection-openrouter', 'connection-ollama-local', 'connection-ollama-cloud', 'connection-cloudflare', 'welcome']);
      // REAL: the runtime loaded from this origin and drew the six components (canvas[data-loaded] is set by TimmyRive's onLoad only)
      expect(await o.page.evaluate(() => (window as unknown as { TimmyRive: { runtimeState: () => string } }).TimmyRive.runtimeState())).toBe('here');
      expect(await o.page.evaluate(() => typeof (window as unknown as { rive?: { Rive?: unknown } }).rive?.Rive)).toBe('function');
      expect(await o.page.$$eval('#screen-inspect canvas[data-timmy-rive][data-loaded]', (els) => els.map((e) => e.getAttribute('data-timmy-rive')).sort())).toEqual(['activity', 'connection-cloudflare', 'connection-ollama-cloud', 'connection-ollama-local', 'connection-openrouter', 'welcome']);
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
      expect(act.runtime!.artboardNames).toEqual(SERVED_V2 ? ['AgentConsole', 'ProviderCard', 'ActionButton', 'ActionButtonGlacier', 'AgentConsolePreview', 'ProviderCardPreview', 'ActionButtonPreview'] : ['AgentConsole', 'ProviderCard', 'ActionButton']);
      expect(act.runtime!.stateMachineNames).toEqual(['TimmyUI']);
      expect(act.runtime!.inputs.map((i) => [i.name, i.type, i.value])).toEqual([['State', 'Number', 0], ['Hover', 'Bool', false], ['Pressed', 'Bool', false], ['ReducedMotion', 'Bool', false]]);
      expect(act.nativeReduced).toBe(true); // the asset HAS the input (false here: motion is not reduced)
      const facts = await text(o.page, '[data-inspect-component="activity"] .tr-facts');
      expect(facts).toContain('timmy-ui.riv');
      expect(facts).toContain(`sha256 ${(CONTRACT as unknown as { asset: { sha256: string } }).asset.sha256.slice(0, 12)}`);
      expect(facts).toContain('artboard AgentConsole');
      expect(facts).toMatch(/Runtime\s*drawn by @rive-app\/canvas/);
      expect(facts).toContain('AgentConsole, ProviderCard, ActionButton');
      expect(facts).toMatch(/State · Number · 0/);
      expect(facts).toContain('Native contract');
      expect(facts).toContain('stopping → State 1 until the backend says cancelled → 3');
      const conn = await text(o.page, '[data-inspect-component="connection-ollama-local"] .tr-facts');
      expect(conn).toContain('artboard ProviderCard');
      expect(conn).toContain('connected has NO success pose');
      expect(await o.page.$$eval('[data-inspect-component="activity"] .tr-sources a', (as) => as.map((a) => a.textContent))).toEqual(['BUILD.txt', 'CONTRACT.json', 'INSPECT-summary.txt', 'OFL.txt', 'Outfit-OFL.txt', 'README.md', 'create-controls.py', 'make-font.py', 'rive-build-log.txt', 'rive-build-problems.txt', 'rive.yaml', 'scene.rml']);
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

  it('the mounts the screens call (R11 round 6): mountConsole follows the activity feed, mountProviderCard its provider, mountActionButton is a real button whose REAL action runs on a trusted click / Enter only, never when disabled; each drawn by the runtime, unmount cleans up', async () => {
    const o = await open({ width: 1440, height: 900 });
    try {
      type R = { mountConsole: (h: Element, o: object) => { id: string; state: string }; mountProviderCard: (h: Element, id: string, o?: object) => { id: string }; mountActionButton: (h: Element, o: object) => { id: string; setDisabled: (b: boolean) => void; unmount: () => void }; fromSse: (e: string, d: unknown, s: string) => unknown; fromProviderState: (id: string, w: string, s: string) => unknown; inspect: () => Array<{ id: string; component: string; place: string; state: string; word: string; disabled: boolean; runtime: { inputs: Array<{ name: string; value: unknown }> } | null; events: Array<{ input: string; value: unknown; source: string; did?: string; stale?: boolean }>; runs: Record<string, { reads?: string; note?: string; hidden?: boolean }> | null; restored: number; fedState: number | undefined; identity: { turn?: string; project?: string; session?: string } | null; receipt: string | null; stale: number; fileContract: number | null }>; handles: () => unknown[] };
      // the test's own host on the page (the screens' calls are H171's and H170's; the API is what is tested here)
      await o.page.evaluate(() => {
        const W = window as unknown as { TimmyRive: R; __acted: string[] };
        W.__acted = [];
        const host = document.createElement('section');
        host.id = 'h174-mounts';
        host.setAttribute('aria-label', 'H174 mounts (the test)');
        document.body.append(host);
        const c = document.createElement('div'); c.id = 'm-console'; host.append(c);
        const p = document.createElement('div'); p.id = 'm-provider'; host.append(p);
        const a = document.createElement('div'); a.id = 'm-action'; host.append(a);
        // the test's own names: the merged Chat screen (H171) mounts its own 'console' and 'action' on this page
        W.TimmyRive.mountConsole(c, { size: 'wide', name: 'test:console' });
        W.TimmyRive.mountProviderCard(p, 'ollama-local', { name: 'test:provider:ollama-local' });
        W.TimmyRive.mountActionButton(a, { name: 'test:action', label: 'Answer: once', action: (ev: Event) => { W.__acted.push(`${ev.type}:${ev.isTrusted}`); } });
      });
      await o.page.waitForFunction(() => [...document.querySelectorAll('#h174-mounts canvas')].length === 3 && [...document.querySelectorAll('#h174-mounts canvas')].every((c) => c.getAttribute('data-loaded') === 'true'), null, { timeout: 30_000 });
      // what they are: a role=img console at the host's width, a role=img card, a real <button aria-label>
      const faces = await o.page.$$eval('#h174-mounts .tr-face', (els) => els.map((e) => [e.tagName, e.getAttribute('role'), e.getAttribute('aria-label'), e.closest('[data-artboard]')!.getAttribute('data-artboard'), e.closest('[data-size]')?.getAttribute('data-size') ?? null]));
      expect(faces).toEqual([['DIV', 'img', 'Agent activity', 'AgentConsole', 'wide'], ['DIV', 'img', 'Connection to ollama-local', 'ProviderCard', 'card'], ['BUTTON', null, 'Answer: once', 'ActionButton', 'card']]);
      const widths = await o.page.$$eval('#h174-mounts .tr-face', (els) => els.map((e) => [(e as HTMLElement).offsetWidth, (e as HTMLElement).offsetHeight]));
      expect(widths[0][0]).toBeGreaterThan(600); // wide: the host's width (the body's), at 640:380
      expect(Math.abs(widths[0][0] / widths[0][1] - 640 / 380)).toBeLessThan(0.05);
      expect(widths[1]).toEqual([240, 156]);
      expect(widths[2]).toEqual([240, 72]);
      // the faces' baked words, set by the runtime to the truth of a LIVE face (the asset bakes "PREVIEW / NOT A LIVE JOB" and an
      // "Inspect interaction" button into AgentConsole and ProviderCard, and "Connect provider" as the ActionButton's Idle label):
      // read back through the runtime's getTextRunValue, not from this page's records
      type RR = { component: string; rive: { getTextRunValue: (n: string) => string | undefined } | null };
      const runsOf = (name: string) => o.page.evaluate((n) => { const hd = ((window as unknown as { TimmyRive: R }).TimmyRive.handles() as unknown as RR[]).find((x) => x.component === n)!; const g = (k: string) => hd.rive!.getTextRunValue(k); return { caption: g('PREVIEW  /  NOT A LIVE JOB'), inspect: g('Inspect interaction'), actionIdle: g('Connect provider'), provider: g('OpenRouter  ·  Ollama  ·  Cloudflare') }; }, name);
      if (!SERVED_V2) {
        // the v1 file (the round-5 build): its baked runs overwritten, its pill scaled away, its five same-named subtitle runs said
        expect(await runsOf('test:console')).toMatchObject({ caption: 'LIVE  /  THE TURN’S EVENTS', inspect: '' });
        expect(await o.page.evaluate(() => { const hd = ((window as unknown as { TimmyRive: R }).TimmyRive.handles() as unknown as Array<{ component: string; rive: { artboard: { node: (n: string) => { scaleX: number; scaleY: number } | null } } | null }>).find((x) => x.component === 'test:console')!; const n = hd.rive!.artboard.node('Primary action'); return n ? [n.scaleX, n.scaleY] : null; })).toEqual([0, 0]);
        expect(await o.page.evaluate(() => (window as unknown as { TimmyRive: R }).TimmyRive.inspect().find((x) => x.component === 'test:console')!.runs!.pill)).toMatchObject({ hidden: true });
        expect(await runsOf('test:provider:ollama-local')).toMatchObject({ caption: 'LIVE  /  GET /api/connections', inspect: '' });
        expect(await runsOf('test:action')).toMatchObject({ actionIdle: 'Answer: once' });
        expect((await runsOf('test:provider:ollama-local')).provider).toBe('OpenRouter  ·  Ollama  ·  Cloudflare');
        expect(await o.page.evaluate(() => (window as unknown as { TimmyRive: R }).TimmyRive.inspect().find((x) => x.component === 'test:provider:ollama-local')!.runs!.provider.note)).toMatch(/five runs share this name/);
      } else {
        // the v2 file: none of v1's baked runs and no pill exist (nothing to overwrite or hide); the named runs are read below
        expect(await runsOf('test:console')).toEqual({ caption: undefined, inspect: undefined, actionIdle: undefined, provider: undefined });
        expect(await o.page.evaluate(() => { const hd = ((window as unknown as { TimmyRive: R }).TimmyRive.handles() as unknown as Array<{ component: string; rive: { artboard: { node: (n: string) => unknown } } | null }>).find((x) => x.component === 'test:console')!; return Boolean(hd.rive!.artboard.node('Primary action')); })).toBe(false);
        expect(await o.page.evaluate(() => (window as unknown as { TimmyRive: R }).TimmyRive.inspect().find((x) => x.component === 'test:console')!.fileContract)).toBe(2);
      }
      // the console follows the activity feed (the same handle vocabulary as the Inspect view's)
      await o.page.evaluate(() => (window as unknown as { TimmyRive: R }).TimmyRive.fromSse('needs-you', { id: 'ask-fake' }, 'FAKE (the test): SSE needs-you'));
      expect(await text(o.page, '#m-console [data-rive-status]')).toBe('awaiting approval');
      expect(await o.page.evaluate(() => (window as unknown as { TimmyRive: R }).TimmyRive.inspect().find((x) => x.component === 'test:console')!.runtime!.inputs.find((i) => i.name === 'State')!.value)).toBe(2);
      // the asset's baked click listener ("Inspect click": the hit area → State = 1) cannot fabricate a state on a live face:
      // (i) a real pointer click on the face reaches no canvas (pointer-events: none) — State and the word stay the backend's;
      // (ii) mouse events dispatched straight at the canvas (past the CSS) reach the runtime, whose listener's hit area (the
      // pill "Primary action") is scaled to nothing — nothing moves; (iii) a State written behind the bindings' back (what a
      // listener does) is put back by the next frame's guard (counted on restored); the HTML word never follows
      const faceBox = (await o.page.locator('#m-console .tr-face').boundingBox())!;
      await o.page.mouse.click(faceBox.x + faceBox.width * 0.78, faceBox.y + faceBox.height * 0.9); // the baked button's spot
      await o.page.waitForTimeout(120);
      const afterReal = await o.page.evaluate(() => { const h = (window as unknown as { TimmyRive: R }).TimmyRive.inspect().find((x) => x.component === 'test:console')!; return { state: h.runtime!.inputs.find((i) => i.name === 'State')!.value, word: h.word, restored: h.restored, fed: h.fedState }; });
      expect(afterReal).toEqual({ state: 2, word: 'awaiting approval', restored: 0, fed: 2 });
      const afterDispatch = await o.page.evaluate(async () => {
        const R = (window as unknown as { TimmyRive: R }).TimmyRive;
        const canvas = document.querySelector('#m-console canvas') as HTMLCanvasElement;
        const b = canvas.getBoundingClientRect();
        const at = { clientX: b.left + b.width * 0.78, clientY: b.top + b.height * 0.9, bubbles: true, cancelable: true, button: 0 };
        canvas.dispatchEvent(new MouseEvent('mousemove', at));
        canvas.dispatchEvent(new MouseEvent('mousedown', at));
        canvas.dispatchEvent(new MouseEvent('mouseup', at));
        const seen: number[] = [];
        for (let i = 0; i < 6; i++) { await new Promise((r) => requestAnimationFrame(r)); seen.push(R.inspect().find((x) => x.component === 'test:console')!.runtime!.inputs.find((i) => i.name === 'State')!.value as number); }
        const h = R.inspect().find((x) => x.component === 'test:console')!;
        return { seen, state: h.runtime!.inputs.find((i) => i.name === 'State')!.value, word: h.word, restored: h.restored, fed: h.fedState, label: document.querySelector('#m-console [data-rive-status]')!.textContent };
      });
      expect(afterDispatch.state).toBe(2);
      expect(afterDispatch.fed).toBe(2);
      expect(afterDispatch.word).toBe('awaiting approval');
      expect(afterDispatch.label).toBe('awaiting approval');
      expect(afterDispatch.seen.slice(-3)).toEqual([2, 2, 2]);
      expect(afterDispatch.restored).toBe(0); // the listener's hit area is gone: nothing to put back
      const behindTheBack = await o.page.evaluate(async () => {
        const R = (window as unknown as { TimmyRive: R }).TimmyRive;
        const hd = (R.handles() as unknown as Array<{ component: string; stateMachine: string; rive: { stateMachineInputs: (sm: string) => Array<{ name: string; value: number }> } | null }>).find((x) => x.component === 'test:console')!;
        hd.rive!.stateMachineInputs(hd.stateMachine).find((i) => i.name === 'State')!.value = 1; // as the baked listener would
        const seen: number[] = [];
        for (let i = 0; i < 6; i++) { await new Promise((r) => requestAnimationFrame(r)); seen.push(R.inspect().find((x) => x.component === 'test:console')!.runtime!.inputs.find((i) => i.name === 'State')!.value as number); }
        const h = R.inspect().find((x) => x.component === 'test:console')!;
        return { seen, state: h.runtime!.inputs.find((i) => i.name === 'State')!.value, word: h.word, restored: h.restored, label: document.querySelector('#m-console [data-rive-status]')!.textContent };
      });
      expect(behindTheBack.state).toBe(2);
      expect(behindTheBack.seen.slice(-3)).toEqual([2, 2, 2]);
      expect(behindTheBack.restored).toBeGreaterThanOrEqual(1); // put back by the guard on the next frame
      expect(behindTheBack.word).toBe('awaiting approval');
      expect(behindTheBack.label).toBe('awaiting approval');
      // R11 round 7 — the feed's identity: a 'turn' event names the console's turn; another turn's needs-you/done is ignored
      // and said; 'done' attaches its receipt; reconcile() applies a re-read state for the named turn only
      const identity = await o.page.evaluate(() => {
        const R = (window as unknown as { TimmyRive: R & { reconcile: (w: string, o: { turn?: string; source?: string }) => unknown[]; feed: () => { turn: string | null; receipt: string | null; stale: number } } }).TimmyRive;
        const me = () => R.inspect().find((x) => x.component === 'test:console')!;
        const out: Record<string, unknown> = {};
        R.fromSse('turn', { id: 'turn-FAKE-1', surface: 'companion' }, 'FAKE (the test): SSE turn');
        out.afterTurn = { word: me().word, turn: me().identity?.turn, feed: R.feed() };
        R.fromSse('needs-you', { id: 'ask-x', turn: 'turn-FAKE-0' }, 'FAKE (the test): a stale needs-you of the previous turn');
        out.afterStale = { word: me().word, stale: me().stale, last: me().events[me().events.length - 1] };
        R.fromSse('done', { status: 'answered', turn: 'turn-FAKE-1', receipt: 'rcpt-FAKE-9c1' }, 'FAKE (the test): SSE done with a receipt');
        out.afterDone = { word: me().word, receipt: me().receipt, feed: R.feed() };
        const other = R.reconcile('working', { turn: 'turn-FAKE-7', source: 'FAKE (the test): a re-read of another turn' });
        out.afterOtherReconcile = { applied: other.length, word: me().word };
        const mine = R.reconcile('working', { turn: 'turn-FAKE-1', source: 'FAKE (the test): GET /api/chat/turn/turn-FAKE-1 after a reconnect' });
        out.afterReconcile = { applied: mine.length, word: me().word, state: me().runtime!.inputs.find((i) => i.name === 'State')!.value };
        R.fromSse('done', { status: 'answered', turn: 'turn-FAKE-1' }, 'FAKE (the test): SSE done');
        return out;
      });
      expect(identity.afterTurn).toMatchObject({ word: 'working', turn: 'turn-FAKE-1', feed: { turn: 'turn-FAKE-1', receipt: null } });
      expect(identity.afterStale).toMatchObject({ word: 'working', stale: 1 });
      expect((identity.afterStale as { last: { did: string; stale: boolean } }).last).toMatchObject({ stale: true, did: 'ignored: names turn turn-FAKE-0, this console follows turn turn-FAKE-1' });
      expect(identity.afterDone).toMatchObject({ word: 'idle', receipt: 'rcpt-FAKE-9c1', feed: { turn: 'turn-FAKE-1', receipt: 'rcpt-FAKE-9c1', stale: 1 } });
      expect(identity.afterOtherReconcile).toEqual({ applied: 0, word: 'idle' });
      expect(identity.afterReconcile).toMatchObject({ word: 'working', state: 1 });
      expect((identity.afterReconcile as { applied: number }).applied).toBeGreaterThanOrEqual(1);
      expect(await text(o.page, '[data-inspect-identity="activity"]').catch(() => '')).toMatch(/turn turn-FAKE-1|^$/);
      if (SERVED_V2) {
        // the v2 file: the named runs carry the page's words (read back from the runtime) and the preview variants stay in the view
        const v2 = await o.page.evaluate(() => { const g = (n: string) => { const hd = ((window as unknown as { TimmyRive: R }).TimmyRive.handles() as unknown as RR[]).find((x) => x.component === n)!; return (k: string) => hd.rive!.getTextRunValue(k); }; const c = g('test:console'); const p = g('test:provider:ollama-local'); const a = g('test:action'); return { console: { caption: c('Caption'), tag: c('Tag') }, card: { caption: p('Caption'), name: p('ProviderName'), state: p('ProviderState') }, action: { caption: a('Caption') }, artboards: (window as unknown as { TimmyRive: R }).TimmyRive.inspect().filter((x) => /^(test:|activity$|connection-)/.test(x.component)).map((x) => [x.component, (x as unknown as { artboard: string }).artboard]) }; });
        expect(v2.console).toEqual({ caption: 'LIVE  /  THE TURN’S EVENTS', tag: 'turn turn-FAKE-1' });
        expect(v2.card).toEqual({ caption: 'LIVE  /  GET /api/connections', name: 'Ollama · local', state: 'disconnected' }); // (fed 'pending' below → 'checking')
        expect(v2.action).toEqual({ caption: 'Answer: once' });
        expect(Object.fromEntries(v2.artboards as Array<[string, string]>)).toMatchObject({ 'test:console': 'AgentConsole', 'test:provider:ollama-local': 'ProviderCard', 'test:action': 'ActionButton' }); // (the view's preview variants: the PREVIEW case)
      }
      await o.page.evaluate(() => (window as unknown as { TimmyRive: R }).TimmyRive.fromSse('done', { status: 'answered' }, 'FAKE (the test): SSE done'));
      expect(await text(o.page, '#m-console [data-rive-status]')).toBe('idle');
      // the provider card follows its provider only
      await o.page.evaluate(() => (window as unknown as { TimmyRive: R }).TimmyRive.fromProviderState('openrouter', 'checked', 'FAKE (the test): another provider'));
      expect(await text(o.page, '#m-provider [data-rive-status]')).toBe('disconnected');
      await o.page.evaluate(() => (window as unknown as { TimmyRive: R }).TimmyRive.fromProviderState('ollama-local', 'pending', 'FAKE (the test): pending'));
      expect(await text(o.page, '#m-provider [data-rive-status]')).toBe('checking');
      if (SERVED_V2) expect(await o.page.evaluate(() => { const hd = ((window as unknown as { TimmyRive: R }).TimmyRive.handles() as unknown as RR[]).find((x) => x.component === 'test:provider:ollama-local')!; return hd.rive!.getTextRunValue('ProviderState'); })).toBe('checking'); // the v2 face's own state word
      expect(await o.page.evaluate(() => (window as unknown as { TimmyRive: R }).TimmyRive.inspect().find((x) => x.component === 'test:provider:ollama-local')!.runtime!.inputs.find((i) => i.name === 'State')!.value)).toBe(1);
      // the action: a synthetic click runs nothing; the person's click runs it once; Enter on the focused button runs it again
      await o.page.evaluate(() => (document.querySelector('#m-action button') as HTMLButtonElement).click());
      expect(await o.page.evaluate(() => (window as unknown as { __acted: string[] }).__acted)).toEqual([]);
      await o.page.click('#m-action button');
      expect(await o.page.evaluate(() => (window as unknown as { __acted: string[] }).__acted)).toEqual(['click:true']);
      await o.page.focus('#m-action button');
      await o.page.keyboard.press('Enter');
      expect(await o.page.evaluate(() => (window as unknown as { __acted: string[] }).__acted)).toEqual(['click:true', 'click:true']);
      // disabled: the button's attribute, the label, nothing runs; enabled again: it runs
      await o.page.evaluate(() => { const W = window as unknown as { TimmyRive: R; __btn?: { setDisabled: (b: boolean) => void; unmount: () => void } }; const hd = W.TimmyRive.inspect().find((x) => x.component === 'test:action')!; (W.TimmyRive.handles() as Array<{ id: string; setDisabled: (b: boolean) => void; unmount: () => void }>).find((x) => x.id === hd.id)!.setDisabled(true); });
      expect(await o.page.$eval('#m-action button', (b) => (b as HTMLButtonElement).disabled)).toBe(true);
      expect(await text(o.page, '#m-action [data-rive-status]')).toBe('Answer: once · unavailable');
      await o.page.click('#m-action button', { force: true }).catch(() => undefined);
      expect(await o.page.evaluate(() => (window as unknown as { __acted: string[] }).__acted)).toEqual(['click:true', 'click:true']);
      await o.page.evaluate(() => { const W = window as unknown as { TimmyRive: R }; const hd = W.TimmyRive.inspect().find((x) => x.component === 'test:action')!; (W.TimmyRive.handles() as Array<{ id: string; setDisabled: (b: boolean) => void }>).find((x) => x.id === hd.id)!.setDisabled(false); });
      await o.page.click('#m-action button');
      expect(await o.page.evaluate(() => (window as unknown as { __acted: string[] }).__acted)).toEqual(['click:true', 'click:true', 'click:true']);
      // the Inspect list names where each lives; unmount removes it
      const places = await o.page.evaluate(() => (window as unknown as { TimmyRive: R }).TimmyRive.inspect().filter((x) => ['test:console', 'test:provider:ollama-local', 'test:action'].includes(x.component)).map((x) => [x.component, x.place, x.state]));
      expect(places).toEqual([['test:console', 'chat', 'drawn'], ['test:provider:ollama-local', 'connections', 'drawn'], ['test:action', 'chat', 'drawn']]);
      await o.page.evaluate(() => { const W = window as unknown as { TimmyRive: R }; const hd = W.TimmyRive.inspect().find((x) => x.component === 'test:action')!; (W.TimmyRive.handles() as Array<{ id: string; unmount: () => void }>).find((x) => x.id === hd.id)!.unmount(); });
      expect(await o.page.$$eval('#m-action button', (els) => els.length)).toBe(0);
      expect(await o.page.evaluate(() => (window as unknown as { TimmyRive: R }).TimmyRive.inspect().some((x) => x.component === 'test:action'))).toBe(false);
      expect(o.errors).toEqual([]);
    } finally { await o.context.close(); }
  }, LONG);

  /**
   * REGRESSION (the operator's bar of 07:06 PT, 2026-10-24: "a regression check for rapid backend events and repeated redraws").
   * The storm this guards against is H172's 06:5x finding at f5730666 (gates 31/32): on a configured page the Inspect view
   * redrew SYNCHRONOUSLY on every binding event (`TimmyRive.on(() => redraw())`), and component() → load() → applySeen() →
   * set() → emit → redraw → handleFor() re-entered for the same key BEFORE made[key] was assigned — 632 handles for one card,
   * the .riv fetched 664 times, "Aborted()" × 4405, the wasm dead. This case REPRODUCES that feedback path on this head: it
   * subscribes a synchronous redraw() to every binding event, seeds lastSeen, and only then opens the view, so each handle's
   * first applySeen() emits into a redraw while that handle is still being made — at f5730666 that is the storm; here the
   * guards hold it to one handle per key and one fetch per instance. The guards it pins, explicitly: handleFor() returns the
   * handle of its key under way (R.handles(), pushed before applySeen) instead of making a second; component() returns the
   * in-flight handle for the same host+component; redraw() is never re-entered (a redraw asked for mid-redraw is the next
   * frame's) and one frame draws once however many are asked; set() ignores an unmounted handle. Not run on f5730666 itself:
   * the mount API the rest of this case uses did not exist there (H172 measured the storm on that revision; this case would
   * fail there at its first assertion — the handle count after the view opens — by that mechanism).
   */
  it('REGRESSION: a burst of 320+ backend events in one tick and a stream every ~10 ms for 3 s, with the console, the four provider cards and an ActionButton mounted and the Inspect view open — one handle per component throughout, the .riv fetched once per instance, no Aborted()/onLoadError/page error, the final State and HTML word = the last event; 500 redraws in one frame draw once; unmount mid-burst leaks nothing', async () => {
    const o = await open({ width: 1440, height: 900 });
    try {
      const rivRequests: string[] = [];
      o.page.on('request', (r) => { if (r.url().includes('/assets/rive/timmy-ui/timmy-ui.riv')) rivRequests.push(r.url()); });
      const bad: string[] = [];
      o.page.on('console', (m) => { if (/Aborted\(|onLoadError|Failed to fetch the Rive file|RuntimeError|out of memory/i.test(m.text())) bad.push(m.text().slice(0, 160)); });
      type H = { id: string; component: string; place: string; state: string; word: string; runtime: { inputs: Array<{ name: string; value: unknown }> } | null; runs: Record<string, { reads?: string; note?: string }> | null; restored: number; fedState: number | undefined };
      type R = { inspect: () => H[]; handles: () => Array<{ id: string; component: string; state: string; events: unknown[]; unmount: () => void }>; mountConsole: (h: Element, o: object) => unknown; mountProviderCard: (h: Element, id: string, o?: object) => unknown; mountActionButton: (h: Element, o: object) => unknown; fromSse: (e: string, d: unknown, s: string) => unknown; fromProviderState: (id: string, w: string, s: string) => unknown; stopping: (s: string) => unknown; set: (h: unknown, i: string, v: unknown, s: string) => unknown };
      // f5730666's path: a SYNCHRONOUS redraw on every binding event, lastSeen seeded so each handle's first applySeen() emits
      // while it is being made; then the view opens
      await o.page.evaluate(() => {
        const W = window as unknown as { TimmyRive: R & { on: (fn: () => void) => () => void }; timmyInspectAnimation: { redraw: () => void }; __syncOff?: () => void };
        W.TimmyRive.fromSse('turn', {}, 'FAKE seed');
        for (const id of ['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare']) W.TimmyRive.fromProviderState(id, 'checked', 'FAKE seed');
        W.__syncOff = W.TimmyRive.on(() => W.timmyInspectAnimation.redraw());
      });
      await inspect(o.page);
      const opened = await o.page.evaluate(() => { const R = (window as unknown as { TimmyRive: R }).TimmyRive; const keys = R.inspect().map((h) => h.component); return { keys: keys.sort(), unique: new Set(keys).size, drawn: R.inspect().filter((h) => h.state === 'drawn').length, fetched: performance.getEntriesByType('resource').filter((e) => e.name.includes('/assets/rive/timmy-ui/timmy-ui.riv')).length }; });
      expect(opened.unique, `one handle per key with a synchronous redraw on every event: ${opened.keys.join(', ')}`).toBe(opened.keys.length);
      expect(opened.keys.filter((k) => k === 'connection-openrouter')).toHaveLength(1);
      expect(opened.fetched).toBe(opened.drawn);
      expect(bad).toEqual([]);
      await o.page.evaluate(() => { const W = window as unknown as { __syncOff?: () => void }; if (W.__syncOff) W.__syncOff(); });
      await o.page.evaluate(() => {
        const W = window as unknown as { TimmyRive: R };
        const host = document.createElement('section'); host.id = 'h174-storm'; document.body.append(host);
        const mk = (id: string) => { const d = document.createElement('div'); d.id = id; host.append(d); return d; };
        W.TimmyRive.mountConsole(mk('s-console'), { size: 'card', name: 'storm:console' });
        for (const p of ['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare']) W.TimmyRive.mountProviderCard(mk(`s-${p}`), p, { name: `storm:${p}` });
        W.TimmyRive.mountActionButton(mk('s-action'), { name: 'storm:action', label: 'Storm action', action: () => undefined });
      });
      await o.page.waitForFunction(() => { const all = [...document.querySelectorAll('canvas[data-timmy-rive]')]; return all.length >= 13 && all.every((c) => c.getAttribute('data-loaded') === 'true' || c.getAttribute('data-timmy-rive') === 'mark'); }, null, { timeout: 40_000 });
      const count = () => o.page.evaluate(() => (window as unknown as { TimmyRive: R }).TimmyRive.inspect().length);
      const fetched = () => o.page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/assets/rive/timmy-ui/timmy-ui.riv')).length);
      const baseline = await count();
      const names = await o.page.evaluate(() => (window as unknown as { TimmyRive: R }).TimmyRive.inspect().map((h) => h.component).sort());
      expect(new Set(names).size, `one handle per component: ${names.join(', ')}`).toBe(names.length);
      // one .riv fetch per drawn instance since the page opened (the Chat screen's own mounts included; the mark has no file), none from here on
      const drawn = await o.page.evaluate(() => (window as unknown as { TimmyRive: R }).TimmyRive.inspect().filter((h) => h.state === 'drawn').length);
      expect(drawn).toBeGreaterThanOrEqual(12);
      expect(await fetched()).toBe(drawn);
      const requestsAtBaseline = rivRequests.length;
      // (a) the burst: 320 activity + 320 connection events in ONE tick, through the real feeds
      await o.page.evaluate(() => {
        const R = (window as unknown as { TimmyRive: R }).TimmyRive;
        const act: Array<[string, unknown] | null> = [['turn', {}], ['needs-you', {}], null, ['done', { status: 'cancelled' }], ['error', {}]];
        const prov = ['not set up', 'pending', 'checked', 'refused'];
        const ids = ['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare'];
        for (let i = 0; i < 320; i++) {
          const a = act[i % 5];
          if (a === null) R.stopping(`FAKE burst ${i}`); else R.fromSse(a[0], a[1], `FAKE burst ${i}`);
          R.fromProviderState(ids[i % 4], prov[(i >> 2) % 4], `FAKE burst ${i}`);
        }
        // the last events of the burst
        R.fromSse('needs-you', { id: 'last' }, 'FAKE burst end');
        for (const id of ids) R.fromProviderState(id, 'pending', 'FAKE burst end');
      });
      expect(await count()).toBe(baseline);
      expect(await text(o.page, '#s-console [data-rive-status]')).toBe('awaiting approval');
      expect(await text(o.page, '[data-rive-status="activity"]')).toBe('awaiting approval');
      for (const p of ['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare']) expect(await text(o.page, `#s-${p} [data-rive-status]`)).toBe('checking');
      // the sustained stream: every ~10 ms for 3 s; sampled every 500 ms; the view's draws counted (one per frame at most)
      const drawsBeforeStream = await o.page.evaluate(() => (window as unknown as { timmyInspectAnimation: { draws: () => number } }).timmyInspectAnimation.draws());
      await o.page.evaluate(() => {
        const R = (window as unknown as { TimmyRive: R }).TimmyRive;
        const S = (window as unknown as { __storm: { n: number; done: boolean; t0: number; t1: number; last: { act: string; prov: string } } });
        S.__storm = { n: 0, done: false, t0: performance.now(), t1: 0, last: { act: '', prov: '' } };
        const acts: Array<[string, string, unknown]> = [['working', 'turn', {}], ['awaiting', 'needs-you', {}], ['stopped', 'done', { status: 'cancelled' }], ['failed', 'error', {}], ['idle', 'done', { status: 'answered' }]];
        const provs: Array<[string, string]> = [['disconnected', 'not set up'], ['checking', 'pending'], ['connected', 'checked'], ['failed', 'refused']];
        const end = Date.now() + 3000;
        const batch = () => {
          const n = S.__storm.n++;
          const a = acts[n % acts.length]; const p = provs[n % provs.length];
          if (n % 7 === 3) { R.stopping(`FAKE stream ${n}`); S.__storm.last.act = 'stopping'; } else { R.fromSse(a[1], a[2], `FAKE stream ${n}`); S.__storm.last.act = a[0]; }
          for (const id of ['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare']) R.fromProviderState(id, p[1], `FAKE stream ${n}`);
          S.__storm.last.prov = p[0];
        };
        // one batch per 10 ms of wall clock: when a frame runs long (many live instances), the batches due arrive together — as a
        // real SSE stream's events do on a busy page — so the cadence holds whatever the frame rate
        const t = setInterval(() => {
          const due = Math.floor((performance.now() - S.__storm.t0) / 10);
          while (S.__storm.n < due) batch();
          if (Date.now() > end) { clearInterval(t); S.__storm.t1 = performance.now(); S.__storm.done = true; }
        }, 10);
      });
      for (let i = 0; i < 6; i++) {
        await o.page.waitForTimeout(500);
        expect(await count(), `sample ${i}`).toBe(baseline);
      }
      await o.page.waitForFunction(() => (window as unknown as { __storm: { done: boolean } }).__storm.done, null, { timeout: 10_000 });
      const storm = await o.page.evaluate(() => (window as unknown as { __storm: { n: number; t0: number; t1: number; last: { act: string; prov: string } } }).__storm);
      const drawsDuringStream = (await o.page.evaluate(() => (window as unknown as { timmyInspectAnimation: { draws: () => number } }).timmyInspectAnimation.draws())) - drawsBeforeStream;
      // a batch (5 events) per 10 ms for the 3 s, and the view drew at most once per frame of it
      expect(storm.n, `batches in ${Math.round(storm.t1 - storm.t0)} ms`).toBeGreaterThanOrEqual(290);
      expect(drawsDuringStream, `draws in ${Math.round(storm.t1 - storm.t0)} ms`).toBeLessThanOrEqual(Math.ceil((storm.t1 - storm.t0) / 1000 * 60) + 2);
      // after: the handles constant, the .riv not fetched again, nothing aborted, the final State and the HTML word = the last event
      expect(await count()).toBe(baseline);
      expect(await fetched()).toBe(drawn);
      expect(rivRequests.length).toBe(requestsAtBaseline);
      expect(bad).toEqual([]);
      expect(o.errors).toEqual([]);
      const SHOWN: Record<string, string> = { awaiting: 'awaiting approval' };
      const STATE: Record<string, number> = { idle: 0, working: 1, awaiting: 2, stopping: 1, stopped: 3, failed: 4 };
      const CSTATE: Record<string, number> = { disconnected: 0, checking: 1, connected: 0, failed: 4 };
      const finals = await o.page.evaluate(() => (window as unknown as { TimmyRive: R }).TimmyRive.inspect().filter((h) => h.runtime).map((h) => [h.component, h.word, h.runtime!.inputs.find((i) => i.name === 'State')!.value]));
      for (const [component, word, state] of finals as Array<[string, string, number]>) {
        if (/console|^activity$/.test(component)) { expect(word, component).toBe(SHOWN[storm.last.act] || storm.last.act); expect(state, component).toBe(STATE[storm.last.act]); }
        else if (/^storm:(openrouter|ollama|cloudflare)|^connection-/.test(component)) { expect(word, component).toBe(storm.last.prov); expect(state, component).toBe(CSTATE[storm.last.prov]); }
      }
      expect(await text(o.page, '#s-console [data-rive-status]')).toBe(SHOWN[storm.last.act] || storm.last.act);
      expect(await text(o.page, '#s-ollama-local [data-rive-status]')).toBe(storm.last.prov);
      // (b) repeated redraws: 500 asks within one frame draw once; across 20 frames at 10 asks each, at most one draw per frame
      const draws = await o.page.evaluate(async () => {
        const V = (window as unknown as { timmyInspectAnimation: { redrawSoon: () => void; draws: () => number } }).timmyInspectAnimation;
        const before = V.draws();
        for (let i = 0; i < 500; i++) V.redrawSoon();
        // one frame: the view's own rAF was queued first, so when this one runs that frame's single redraw has happened (the
        // view's 1.5 s refresh, should it land in between, coalesces into the same one)
        await new Promise((r) => requestAnimationFrame(r));
        const oneFrame = V.draws() - before;
        const mid = V.draws();
        for (let f = 0; f < 20; f++) { for (let i = 0; i < 10; i++) V.redrawSoon(); await new Promise((r) => requestAnimationFrame(r)); }
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { oneFrame, frames: V.draws() - mid };
      });
      expect(draws.oneFrame).toBe(1);
      expect(draws.frames).toBeLessThanOrEqual(21);
      expect(await count()).toBe(baseline);
      // (c) unmount during a burst: the console mount removed while events fly; no late event revives it; no handle leaks
      const gone = await o.page.evaluate(() => {
        const R = (window as unknown as { TimmyRive: R }).TimmyRive;
        const hd = R.handles().find((x) => x.component === 'storm:console')!;
        let seenAtUnmount = -1;
        for (let i = 0; i < 100; i++) { R.fromSse('turn', {}, `FAKE unmount-burst ${i}`); if (i === 50) { hd.unmount(); seenAtUnmount = hd.events.length; } }
        R.fromSse('error', {}, 'FAKE after unmount');
        return { state: hd.state, revived: hd.events.length - seenAtUnmount, listed: R.inspect().some((x) => x.component === 'storm:console'), root: Boolean(document.querySelector('#s-console .tr-component')), total: R.inspect().length };
      });
      expect(gone).toEqual({ state: 'unmounted', revived: 0, listed: false, root: false, total: baseline - 1 });
      expect(await text(o.page, '[data-rive-status="activity"]')).toBe('failed');
      expect(bad).toEqual([]);
      expect(o.errors).toEqual([]);
      expect(o.consoleErrors.filter((e) => /rive|inspect|abort/i.test(e))).toEqual([]);
    } finally { await o.context.close(); }
  }, LONG);

  it.skipIf(!SERVED_V2)(`RIVE CONTRACT v2 — reduced motion SETTLES: with prefers-reduced-motion the Working console stops moving within a frame (the WorkingStill pose: pixels identical across half a second); without it the ring moves${SERVED_V2 ? '' : ' [SKIPPED: the served .riv is the v1 build; runs when the v2 build lands]'}`, async () => {
    const sample = async (reduced: boolean): Promise<{ frames: string[]; loaded: boolean; nativeReduced: boolean; state: unknown }> => {
      const o = await open({ width: 1440, height: 900 }, reduced);
      try {
        await o.page.evaluate(() => { const R = (window as unknown as { TimmyRive: R }).TimmyRive; const host = document.createElement('div'); host.id = 'rm-host'; document.body.append(host); R.mountConsole(host, { size: 'card', name: 'rm:console' }); });
        await o.page.waitForFunction(() => (window as unknown as { TimmyRive: R }).TimmyRive.inspect().some((x) => x.component === 'rm:console' && x.state === 'drawn'), null, { timeout: 30_000 });
        return await o.page.evaluate(async () => { // (awaited here: the finally below closes the context)
          const R = (window as unknown as { TimmyRive: R }).TimmyRive;
          R.fromSse('turn', { id: 'turn-FAKE-rm' }, 'FAKE (the test): SSE turn');
          await new Promise((r) => setTimeout(r, 400)); // the 0 ms / 180 ms transition is over either way
          const canvas = document.querySelector('#rm-host canvas') as HTMLCanvasElement;
          const frames: string[] = [];
          for (let i = 0; i < 4; i++) { frames.push(canvas.toDataURL()); await new Promise((r) => setTimeout(r, 150)); }
          const h = R.inspect().find((x) => x.component === 'rm:console')!;
          return { frames, loaded: h.state === 'drawn', nativeReduced: (h as unknown as { nativeReduced: boolean }).nativeReduced, state: h.runtime!.inputs.find((i) => i.name === 'State')!.value };
        });
      } finally { await o.context.close(); }
    };
    const still = await sample(true);
    expect(still.loaded).toBe(true);
    expect(still.nativeReduced).toBe(true);
    expect(still.state).toBe(1);
    expect(new Set(still.frames).size, 'the Working pose under reduced motion: no pixel moves across 600 ms').toBe(1);
    const moving = await sample(false);
    expect(moving.state).toBe(1);
    expect(new Set(moving.frames).size, 'the Working ring moves without reduced motion').toBeGreaterThan(1);
  }, LONG);

  it('PREVIEW: labelled, moves the word only, records a PREVIEW event; no receipt and no progress number in the view; reduced motion is read; 390x844 fits', async () => {
    const o = await open({ width: 390, height: 844 }, true);
    try {
      await inspect(o.page);
      expect(await o.page.evaluate(() => (window as unknown as { TimmyRive: { reducedMotion: () => boolean } }).TimmyRive.reducedMotion())).toBe(true);
      const facts = await text(o.page, '[data-inspect-component="connection-openrouter"] .tr-facts');
      // the asset's own ReducedMotion input is set (the runtime's value reads true), not a pause of mine
      expect(facts).toMatch(/Reduced motion\s*on: the asset’s own ReducedMotion input is true/);
      const reduced = await o.page.evaluate(() => (window as unknown as { TimmyRive: { inspect: () => Array<{ component: string; nativeReduced: boolean; runtime: { inputs: Array<{ name: string; value: unknown }> } }> } }).TimmyRive.inspect().filter((h) => h.runtime).map((h) => [h.nativeReduced, h.runtime.inputs.find((i) => i.name === 'ReducedMotion')!.value]));
      expect(reduced.length).toBeGreaterThanOrEqual(6); // the view's six, plus whatever the Chat screen mounts on this page
      expect(reduced).toEqual(Array(reduced.length).fill([true, true]));
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
      // the face's own caption says PREVIEW while a preview set its state, LIVE again when the feed does (read back from the runtime)
      const captionOf = (name: string) => o.page.evaluate(([n, run]) => ((window as unknown as { TimmyRive: { handles: () => Array<{ component: string; rive: { getTextRunValue: (k: string) => string | undefined } | null }> } }).TimmyRive.handles().find((x) => x.component === n)!.rive!.getTextRunValue(run)), [name, SERVED_V2 ? 'Caption' : 'PREVIEW  /  NOT A LIVE JOB'] as [string, string]);
      expect(await captionOf('activity')).toBe('PREVIEW  /  NOT A LIVE JOB');
      expect(await text(o.page, '[data-inspect-runs="activity"]')).toMatch(/caption: "PREVIEW \/ NOT A LIVE JOB"/); // (text() folds the runs of spaces)
      await o.page.evaluate(() => (window as unknown as { TimmyRive: { fromSse: (e: string, d: unknown, s: string) => unknown } }).TimmyRive.fromSse('turn', {}, 'FAKE (the test): SSE turn'));
      expect(await text(o.page, '[data-rive-status="activity"]')).toBe('working');
      if (SERVED_V2) {
        // the v2 file: this view's faces are the PREVIEW variants (the caption baked at source) — the feed moves their state and the
        // events row says which source did, but the face's caption never says LIVE here: the Inspect view stays PREVIEW
        expect(await captionOf('activity')).toBe('PREVIEW  /  NOT A LIVE JOB');
        expect(await o.page.evaluate(() => (window as unknown as { TimmyRive: { inspect: () => Array<{ component: string; artboard: string }> } }).TimmyRive.inspect().find((x) => x.component === 'activity')!.artboard)).toBe('AgentConsolePreview');
      } else {
        expect(await captionOf('activity')).toBe('LIVE  /  THE TURN’S EVENTS'); // the v1 file: the overwritten run follows the source
      }
      await o.page.click('[data-preview="activity:awaiting"]');
      expect(await captionOf('activity')).toBe('PREVIEW  /  NOT A LIVE JOB');
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
