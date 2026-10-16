/**
 * R5 (H132): the companion's page as the workspace's browser view (src/companion/client): the ten tabs, the Workflow actions
 * strip, Home's connections and the two start-up settings; in a real headless Chromium against the real companion server on
 * 127.0.0.1, drawing what the real frame producer (src/ops/workspace-frame.ts) makes of records in this test's own folders.
 *
 * FAKE pieces, labelled: the connection observations (a record written by Timmy's own writeConnections, its answers made up,
 * no service asked), the frame's clock (the producer is given a fixed `now`, so its "answered 12 s ago" words, and with them
 * its revision, do not move by themselves), and a settings saver that fails. Real: the server and its token, the producer, the
 * Workbench's settings file (src/workbench/settings.ts) in this test's own TIMMY_SETTINGS_DIR. The browser resolves no name
 * but 127.0.0.1. Skipped, saying so, where no Chromium or Chrome is found.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceFrame } from '../src/contracts/workspace.js';
import { CONNECTIONS_SCHEMA, buildWorkspaceFrame, writeConnections, type ConnectionsRecord } from '../src/ops/workspace-frame.js';
import { startCompanionServer, type CompanionOptions, type CompanionServer } from '../src/companion/server.js';
import { DEFAULT_SETTINGS, readSettings, saveSettings, settingsPath } from '../src/workbench/settings.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-workspace-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

type Env = Record<string, string | undefined>;
/** FAKE: the frame's clock */
const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const ago = (s: number): string => new Date(NOW - s * 1000).toISOString();
/** FAKE: what Timmy last observed of each connection (no service was asked) */
const CHECKS: ConnectionsRecord = {
  schema: CONNECTIONS_SCHEMA,
  checks: {
    openrouter: { answer: 'refused', at: ago(180), detail: 'FAKE: HTTP 401' },
    ollama: { answer: 'accepted', at: ago(12), detail: 'FAKE: 2 models' },
    companion: { answer: 'accepted', at: ago(5), detail: 'FAKE: this page connected' },
    studio: { answer: 'not running', at: ago(300) },
  },
};

describe.skipIf(!browserPath)('the companion\'s page draws the workspace frame and saves its start-up settings, in a real browser (R5 H132)', () => {
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
  const servers: CompanionServer[] = [];
  let box = '';
  let root = '';
  let env: Env = {};
  let browser: Browser;
  let companion: CompanionServer;

  /**
   * A companion of this test's own, its folder fixed to the FAKE project, its frame made on the FAKE clock, and made for each
   * read (no frame shared between reads: one test's settings are never drawn in the next)
   */
  async function start(workspace: CompanionOptions['workspace'] = {}): Promise<CompanionServer> {
    process.env.TIMMY_REPO = root;
    try {
      const s = await startCompanionServer(0, { workspace: { env, frame: (o) => buildWorkspaceFrame({ ...o, now: NOW }), shareMs: 0, ...workspace } });
      servers.push(s);
      return s;
    } finally { if (kept.TIMMY_REPO === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = kept.TIMMY_REPO; }
  }

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'h132-ws-browser-'));
    root = join(box, 'FAKE-project');
    mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
    env = { TIMMY_HOME: join(box, 'home'), TIMMY_SETTINGS_DIR: join(box, 'settings'), OLLAMA_HOST: 'http://127.0.0.1:11434' };
    // the active project's record is read through this process's Timmy home: this test's own, with none in it
    process.env.TIMMY_HOME = env.TIMMY_HOME;
    delete process.env.OPENROUTER_API_KEY;
    writeConnections(CHECKS, env);
    companion = await start();
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 120_000);
  afterEach(() => {
    rmSync(join(box, 'settings'), { recursive: true, force: true });
    writeConnections(CHECKS, env);
  });
  afterAll(async () => {
    await browser?.close();
    for (const s of servers) await s.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  /** The page in a fresh context at the address Timmy gives, the frame drawn; requests elsewhere are refused and recorded. */
  async function open(o: { on?: CompanionServer; viewport?: { width: number; height: number } } = {}): Promise<{ page: Page; context: BrowserContext; posts: string[]; errors: string[]; outside: string[] }> {
    const s = o.on ?? companion;
    const origin = `http://127.0.0.1:${s.port}`;
    const context = await browser.newContext({ viewport: o.viewport ?? { width: 1376, height: 768 } });
    const posts: string[] = [];
    const errors: string[] = [];
    const outside: string[] = [];
    context.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/workspace/prefs') posts.push(r.postData() ?? ''); });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      outside.push(url.href);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(s.url);
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
    await page.waitForSelector('#home-connections .conn-card', { timeout: 15_000 });
    return { page, context, posts, errors, outside };
  }
  const prefs = (page: Page): Promise<{ state: string; words: string; companion: [boolean, boolean]; studio: [boolean, boolean]; reload: boolean }> => page.evaluate(() => {
    const el = document.getElementById('prefs-state')!;
    const box = (id: string): [boolean, boolean] => { const b = document.getElementById(id) as HTMLInputElement; return [b.checked, b.disabled]; };
    return { state: el.dataset.state ?? '', words: el.textContent ?? '', companion: box('pref-companion'), studio: box('pref-studio'), reload: !document.getElementById('prefs-reload')!.hidden };
  });
  const stateIs = (page: Page, state: string): Promise<unknown> => page.waitForFunction((s) => document.getElementById('prefs-state')?.dataset.state === s, state, { timeout: 15_000 });
  /** "14:08", as the page says a time: hour and minute in the browser's own time */
  const hourMinute = (page: Page, iso: string): Promise<string> => page.evaluate((i) => { const t = new Date(i); return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; }, iso);
  const savedAt = (): string => (JSON.parse(readFileSync(settingsPath(env), 'utf8')) as { saved_at: string }).saved_at;
  /** Holds back the page's reads of the frame (not its saves), as if it had not polled since. */
  const isRead = (url: URL): boolean => url.pathname === '/api/workspace';
  const holdReads = (page: Page): Promise<void> => page.route(isRead, (route) => route.abort('connectionrefused'));
  const freeReads = (page: Page): Promise<void> => page.unroute(isRead);

  it('a box changed is saved in the Workbench\'s settings file: "Saving…", then "Saved at HH:MM", and the page draws the frame made after it', async () => {
    const { page, context, posts, errors, outside } = await open();
    try {
      await page.waitForFunction(() => !(document.getElementById('pref-companion') as HTMLInputElement).disabled);
      expect(await prefs(page)).toMatchObject({ state: 'idle', words: 'Kept in the Workbench’s settings file: the terminal reads the same one.', companion: [false, false], studio: [false, false], reload: false });
      expect(await page.textContent('#home-connections [data-connection="companion"] .conn-detail')).toContain('opens when asked');
      // every word the state says from here, in order
      await page.evaluate(() => {
        const el = document.getElementById('prefs-state')!;
        const w = window as unknown as { __said: string[] };
        w.__said = [];
        new MutationObserver(() => { if (w.__said.at(-1) !== el.textContent) w.__said.push(el.textContent ?? ''); }).observe(el, { childList: true, characterData: true, subtree: true });
      });
      await page.click('#pref-companion');
      await stateIs(page, 'saved');
      expect(await page.evaluate(() => (window as unknown as { __said: string[] }).__said)).toEqual(['Saving…', `Saved at ${await hourMinute(page, savedAt())}`]);
      expect(readSettings(env).settings).toMatchObject({ openCompanionAtStart: true, openStudioAtStart: false });
      expect(await prefs(page)).toMatchObject({ words: `Saved at ${await hourMinute(page, savedAt())}`, companion: [true, false], studio: [false, false], reload: false });
      // one save, sent with the revision of the frame the page drew
      expect(posts.map((p) => Object.keys(JSON.parse(p)).sort())).toEqual([['if_revision', 'openCompanionAtStart']]);
      // the frame the save answered with is drawn: the companion's card says it opens with the workspace now
      await page.waitForFunction(() => /opens with the workspace/.test(document.querySelector('#home-connections [data-connection="companion"] .conn-detail')?.textContent ?? ''));
      expect(errors).toEqual([]);
      expect(outside).toEqual([]);
    } finally { await context.close(); }
  });

  it('changed elsewhere since the page drew it: "Changed elsewhere: reload", nothing written, the box as before; Reload draws the settings as they are, and the next save goes', async () => {
    const { page, context, posts } = await open();
    try {
      await page.waitForFunction(() => !(document.getElementById('pref-studio') as HTMLInputElement).disabled);
      await holdReads(page);
      // the terminal's Workbench (or another page) turns the companion on meanwhile
      expect(saveSettings({ ...DEFAULT_SETTINGS, openCompanionAtStart: true }, env).ok).toBe(true);
      await page.click('#pref-studio');
      await stateIs(page, 'conflict');
      expect(await prefs(page)).toEqual({ state: 'conflict', words: 'Changed elsewhere: reload', companion: [false, true], studio: [false, true], reload: true });
      expect(readSettings(env).settings).toMatchObject({ openCompanionAtStart: true, openStudioAtStart: false });
      // the companion's answer showed other settings than the page drew: not sent again
      expect(posts).toHaveLength(1);
      await freeReads(page);
      await page.click('#prefs-reload');
      await stateIs(page, 'reloaded');
      const reloaded = await prefs(page);
      expect(reloaded).toMatchObject({ companion: [true, false], studio: [false, false], reload: false });
      expect(reloaded.words).toMatch(/^Reloaded at \d{2}:\d{2}: these are the settings now\.$/);
      await page.click('#pref-studio');
      await stateIs(page, 'saved');
      expect(readSettings(env).settings).toMatchObject({ openCompanionAtStart: true, openStudioAtStart: true });
      expect(posts).toHaveLength(2);
    } finally { await context.close(); }
  });

  it('a frame another revision only by what it observed (not the settings): the save is sent once more with that frame\'s revision, and saved', async () => {
    const { page, context, posts } = await open();
    try {
      await page.waitForFunction(() => !(document.getElementById('pref-companion') as HTMLInputElement).disabled);
      await holdReads(page);
      // FAKE: Studio answered meanwhile; the frame's revision moves, its two settings do not
      writeConnections({ ...CHECKS, checks: { ...CHECKS.checks, studio: { answer: 'accepted', at: ago(2), detail: 'FAKE: studio running' } } }, env);
      await page.click('#pref-companion');
      await stateIs(page, 'saved');
      expect(readSettings(env).settings).toMatchObject({ openCompanionAtStart: true, openStudioAtStart: false });
      const sent = posts.map((p) => JSON.parse(p) as { if_revision: string; openCompanionAtStart: boolean });
      expect(sent).toHaveLength(2);
      expect(sent.map((p) => p.openCompanionAtStart)).toEqual([true, true]);
      expect(sent[0].if_revision).not.toBe(sent[1].if_revision);
    } finally { await context.close(); }
  });

  it('a save that fails says why in the companion\'s words ("Failed to save: …"), the box goes back, and nothing is written; an unreachable companion is said too', async () => {
    const failing = await start({ save: () => ({ ok: false, error: 'FAKE: the disk is full', path: '' }) });
    const { page, context } = await open({ on: failing });
    try {
      await page.waitForFunction(() => !(document.getElementById('pref-companion') as HTMLInputElement).disabled);
      await page.click('#pref-companion');
      await stateIs(page, 'failed');
      expect(await prefs(page)).toEqual({ state: 'failed', words: 'Failed to save: the Workbench\'s settings file could not be written (FAKE: the disk is full); nothing was changed', companion: [false, false], studio: [false, false], reload: false });
      expect(existsSync(settingsPath(env))).toBe(false);
      await page.route((url) => url.pathname === '/api/workspace/prefs', (route) => route.abort('connectionrefused'));
      await page.click('#pref-studio');
      await page.waitForFunction(() => /could not be reached/.test(document.getElementById('prefs-state')?.textContent ?? ''));
      expect(await prefs(page)).toMatchObject({ state: 'failed', companion: [false, false], studio: [false, false] });
      expect((await prefs(page)).words).toMatch(/^Failed to save: the companion could not be reached \(.+\)$/);
      expect(existsSync(settingsPath(env))).toBe(false);
    } finally { await context.close(); }
  });

  /** Counts the page's reads of the frame from now on. */
  const countReads = (context: BrowserContext): { n: number } => {
    const seen = { n: 0 };
    context.on('request', (r) => { if (r.method() === 'GET' && isRead(new URL(r.url()))) seen.n += 1; });
    return seen;
  };
  /** FAKE: Studio answered a check 2 s before the frame's clock */
  const studioAnswered = (): string => writeConnections({ ...CHECKS, checks: { ...CHECKS.checks, studio: { answer: 'accepted', at: ago(2), detail: 'FAKE: studio running' } } }, env);
  const studioLive = (page: Page): Promise<unknown> => page.waitForFunction(() => document.querySelector('#home-connections [data-connection="studio"] .conn-state')?.textContent === '● live', null, { timeout: 15_000 });

  it('live: read every few seconds while seen, drawn again only when the frame\'s revision is another (focus kept in place); a new observation shows within a poll', async () => {
    const { page, context } = await open();
    const reads = countReads(context);
    try {
      // every change to what the frame draws, from here
      await page.evaluate(() => {
        const w = window as unknown as { __changes: number };
        w.__changes = 0;
        const seen = new MutationObserver((m) => { w.__changes += m.length; });
        for (const id of ['ws-tabs', 'ws-actions', 'home-connections', 'home-preview', 'chat-events', 'flow-runs', 'ws-activity-list']) {
          const el = document.getElementById(id);
          if (el) seen.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
        }
      });
      // a keyboard's place: the Ollama card
      await page.focus('#home-connections [data-connection="ollama"]');
      await page.waitForTimeout(6_500);
      expect(reads.n).toBeGreaterThanOrEqual(2);
      expect(await page.evaluate(() => (window as unknown as { __changes: number }).__changes)).toBe(0);
      studioAnswered();
      await studioLive(page);
      expect(await page.evaluate(() => (window as unknown as { __changes: number }).__changes)).toBeGreaterThan(0);
      expect(await page.textContent('#home-connections [data-connection="studio"] .conn-words')).toBe('answered just now (FAKE: studio running)');
      // the card focused before the redraw has focus in its new self
      expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.connection)).toBe('ollama');
    } finally { await context.close(); }
  });

  it('live: not seen, the page reads nothing; its socket opening again reads the frame at once', async () => {
    const { page, context } = await open();
    const reads = countReads(context);
    try {
      // the page as a hidden tab sees itself (the browser's own visibility is not changed by a test)
      await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
      await page.waitForTimeout(3_500);
      const quiet = reads.n;
      await page.waitForTimeout(3_500);
      expect(reads.n).toBe(quiet);
      studioAnswered();
      for (const c of companion.clients) c.terminate();
      await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · RECONNECTING', null, { timeout: 10_000 });
      await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
      await studioLive(page);
      expect(reads.n).toBe(quiet + 1);
    } finally { await context.close(); }
  });

  /** The frame as the companion gives it (its token), to compare what the page draws with: the FAKE clock makes it the page's. */
  const frameNow = async (s: CompanionServer = companion): Promise<WorkspaceFrame> => {
    const token = /#t=([0-9a-f]{64})$/.exec(s.url)![1];
    return await (await fetch(`http://127.0.0.1:${s.port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } })).json() as WorkspaceFrame;
  };
  const shown = (page: Page): Promise<{ selected: string[]; visible: string[]; focused: string | null }> => page.evaluate(() => ({
    selected: [...document.querySelectorAll('#ws-tabs [aria-selected="true"]')].map((b) => (b as HTMLElement).dataset.wsTab ?? ''),
    visible: [...document.querySelectorAll('.ws-page')].filter((p) => !(p as HTMLElement).hidden).map((p) => (p as HTMLElement).dataset.wsPage ?? ''),
    focused: (document.activeElement as HTMLElement | null)?.dataset?.wsTab ?? null,
  }));
  /** A tab opened by its button, its fade ended. */
  const openTab = async (page: Page, id: string): Promise<void> => {
    await page.click(`#ws-tab-${id}`);
    await page.waitForFunction((t) => !(document.getElementById(`ws-${t}`) as HTMLElement).hidden && document.getAnimations().every((a) => a.playState !== 'running'), id, { timeout: 10_000 });
  };

  it('the ten tabs: a tablist in the frame\'s order, labels and keys, each naming its panel; keys 1 to 9 then 0 open them (not while typing), arrows move along them, the focus ring is amber', async () => {
    const f = await frameNow();
    const { page, context, errors } = await open();
    try {
      expect(await page.getAttribute('#ws-tabs', 'role')).toBe('tablist');
      const tabs = await page.$$eval('#ws-tabs [role="tab"]', (els) => els.map((b) => ({
        id: (b as HTMLElement).dataset.wsTab ?? '', key: b.querySelector('.tab-key')?.textContent ?? '', label: b.querySelector('.tab-label')?.textContent ?? '',
        shortcut: b.getAttribute('aria-keyshortcuts'), controls: b.getAttribute('aria-controls') ?? '', selected: b.getAttribute('aria-selected'), border: getComputedStyle(b).borderTopColor,
      })));
      expect(tabs.map((t) => [t.id, t.key, t.label, t.shortcut])).toEqual(f.tabs.map((t) => [t.id, t.key, t.label, t.key]));
      // the selected tab is the one with the 1px amber border
      expect(tabs.map((t) => [t.id, t.selected, t.border === 'rgb(255, 176, 0)'])).toEqual(f.tabs.map((t) => [t.id, t.id === 'home' ? 'true' : 'false', t.id === 'home']));
      for (const t of tabs) {
        expect(await page.getAttribute(`#${t.controls}`, 'role')).toBe('tabpanel');
        expect(await page.getAttribute(`#${t.controls}`, 'aria-labelledby')).toBe(`ws-tab-${t.id}`);
      }
      for (const t of f.tabs) {
        await page.keyboard.press(t.key);
        expect(await shown(page), `key ${t.key}`).toMatchObject({ selected: [t.id], visible: [t.id] });
      }
      // typing in a text field: the digits are the field's
      await page.keyboard.press('3');
      await page.focus('#run-op');
      await page.keyboard.type('12');
      expect(await shown(page)).toMatchObject({ selected: ['workflows'], visible: ['workflows'] });
      expect(await page.inputValue('#run-op')).toBe('12');
      // from a focused tab: Right, Left, End, Home move along the ten and open the tab reached
      await page.focus('#ws-tab-workflows');
      await page.keyboard.press('ArrowRight');
      expect(await shown(page)).toEqual({ selected: ['studio'], visible: ['studio'], focused: 'studio' });
      expect(await page.evaluate(() => { const cs = getComputedStyle(document.activeElement!); return [cs.outlineStyle, cs.outlineColor, cs.outlineWidth]; })).toEqual(['solid', 'rgb(255, 176, 0)', '2px']);
      await page.keyboard.press('ArrowLeft');
      expect(await shown(page)).toEqual({ selected: ['workflows'], visible: ['workflows'], focused: 'workflows' });
      await page.keyboard.press('End');
      expect(await shown(page)).toEqual({ selected: ['logs'], visible: ['logs'], focused: 'logs' });
      await page.keyboard.press('Home');
      expect(await shown(page)).toEqual({ selected: ['home'], visible: ['home'], focused: 'home' });
      // a key pressed from inside the page left: focus goes to the tab opened, not lost with the page
      await page.focus('#home-connections [data-connection="ollama"]');
      await page.keyboard.press('2');
      expect(await shown(page)).toEqual({ selected: ['chat'], visible: ['chat'], focused: 'chat' });
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  it('the Workflow actions strip is the frame\'s actions of the tab shown: at most one primary, filled amber with black words; the rest on the ground with a grey line; one not available now is aria-disabled and says why', async () => {
    const f = await frameNow();
    const { page, context } = await open();
    try {
      let primaries = 0;
      for (const t of f.tabs) {
        await openTab(page, t.id);
        const drawn = await page.$$eval('#ws-actions .act', (els) => els.map((b) => {
          const cs = getComputedStyle(b);
          const why = b.getAttribute('aria-describedby');
          return {
            label: b.querySelector('.act-label')?.textContent ?? '', command: (b as HTMLElement).dataset.act ?? '', primary: b.classList.contains('is-primary'),
            disabled: b.getAttribute('aria-disabled') === 'true', why: why ? document.getElementById(why)?.textContent ?? null : null,
            look: [cs.backgroundColor, cs.color, cs.borderTopColor],
          };
        }));
        const want = f.actions[t.id];
        expect(drawn.map((d) => [d.label, d.command, d.primary, d.disabled]), t.id).toEqual(want.map((a) => [a.label, a.command, a.primary, !a.enabled]));
        expect(drawn.filter((d) => d.primary).length, t.id).toBeLessThanOrEqual(1);
        for (const [i, d] of drawn.entries()) {
          if (d.primary) primaries += 1;
          expect(d.look, `${t.id}: ${d.label}`).toEqual(d.primary ? ['rgb(255, 176, 0)', 'rgb(0, 0, 0)', 'rgb(255, 176, 0)'] : ['rgb(0, 0, 0)', d.disabled ? 'rgb(142, 142, 147)' : 'rgb(242, 239, 233)', 'rgb(68, 68, 68)']);
          expect(d.why, `${t.id}: ${d.label}`).toBe(want[i].enabled ? null : `not now: ${want[i].why}`);
        }
      }
      expect(primaries).toBe(Object.values(f.actions).flat().filter((a) => a.primary).length);
    } finally { await context.close(); }
  });

  /**
   * The page as drawn now, each element shown (outside a model's answers and any frame): each colour that is blue, purple,
   * cyan or mint; each green outside what .is-live or .is-verified marks (and how many greens are inside); each text below
   * 4.5:1 against what is behind it (its opacity and its ancestors' counted).
   */
  const looks = (page: Page): Promise<{ hue: string[]; green: string[]; greens: number; contrast: string[]; texts: number }> => page.evaluate(() => {
    const parse = (v: string): number[] | null => {
      const m = /^rgba?\(([^)]+)\)$/.exec(v.trim());
      if (!m) return null;
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p[3] ?? 1];
    };
    const hsl = ([r, g, b]: number[]): { h: number; s: number; l: number } => {
      const [R, G, B] = [r / 255, g / 255, b / 255];
      const max = Math.max(R, G, B);
      const min = Math.min(R, G, B);
      const l = (max + min) / 2;
      const d = max - min;
      if (d === 0) return { h: 0, s: 0, l };
      const h = max === R ? 60 * (((G - B) / d) % 6) : max === G ? 60 * ((B - R) / d + 2) : 60 * ((R - G) / d + 4);
      return { h: (h + 360) % 360, s: d / (1 - Math.abs(2 * l - 1)), l };
    };
    const lum = (c: number[]): number => {
      const [r, g, b] = c.slice(0, 3).map((x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const name = (el: Element): string => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList.length ? `.${[...el.classList].join('.')}` : ''}`;
    const behind = (el: Element): number[] => {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c[3] > 0.5) return c.slice(0, 3);
      }
      return [0, 0, 0];
    };
    const out = { hue: [] as string[], green: [] as string[], greens: 0, contrast: [] as string[], texts: 0 };
    for (const el of document.querySelectorAll('body, body *')) {
      if (el.closest('[hidden], script, style, template, iframe, #streamdown-root .sd-messages')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      for (const prop of ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color', 'text-decoration-color', 'fill', 'stroke']) {
        const c = parse(cs.getPropertyValue(prop));
        if (!c || c[3] === 0) continue;
        const { h, s, l } = hsl(c);
        if (s < 0.2 || l < 0.08 || l > 0.92) continue;
        if (h >= 150 && h <= 320) out.hue.push(`${name(el)} ${prop} ${cs.getPropertyValue(prop)}`);
        else if (h >= 75 && h < 150) { if (el.closest('.is-live, .is-verified')) out.greens += 1; else out.green.push(`${name(el)} ${prop} ${cs.getPropertyValue(prop)}`); }
      }
      if (![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim())) continue;
      const fg = parse(cs.color);
      if (!fg) continue;
      out.texts += 1;
      let opacity = fg[3];
      for (let e: Element | null = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
      const bg = behind(el);
      const seen = [0, 1, 2].map((i) => fg[i] * opacity + bg[i] * (1 - opacity));
      const [hi, lo] = [lum(seen), lum(bg)].sort((x, y) => y - x);
      const ratio = (hi + 0.05) / (lo + 0.05);
      if (ratio < 4.5) out.contrast.push(`${name(el)} ${ratio.toFixed(2)}: "${(el.textContent ?? '').trim().slice(0, 40)}"`);
    }
    return out;
  });

  it('every tab\'s chrome is the palette\'s: no blue, purple, cyan or mint; green only where .is-live (or .is-verified) marks it; every text at least 4.5:1; at 1376 Home\'s columns side by side', async () => {
    const f = await frameNow();
    const { page, context } = await open();
    try {
      // the first box of each column (the right column is a stack of boxes)
      const cols = await page.$$eval('#ws-home .cols-home > .box, #ws-home .cols-home > .col-stack > .box:first-child', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; }));
      expect(cols).toHaveLength(2);
      expect(cols[1][0]).toBeGreaterThan(cols[0][0]);
      expect(cols[1][1]).toBe(cols[0][1]);
      let greens = 0;
      for (const t of f.tabs) {
        await openTab(page, t.id);
        const views = t.id === 'chat' ? ['chat', 'streamdown'] : [null];
        for (const view of views) {
          if (view) {
            await page.click(`.view-switch [data-tab="${view}"]`);
            await page.waitForFunction((v) => document.getElementById(`tab-${v}`)?.classList.contains('active') && document.getAnimations().every((a) => a.playState !== 'running'), view, { timeout: 10_000 });
          }
          const seen = await looks(page);
          const where = view ? `${t.id} (${view})` : t.id;
          expect(seen.hue, where).toEqual([]);
          expect(seen.green, where).toEqual([]);
          expect(seen.contrast, where).toEqual([]);
          expect(seen.texts, where).toBeGreaterThan(5);
          greens += seen.greens;
        }
      }
      // the check saw green where it belongs (the FAKE live connections), so the rule above is not empty
      expect(greens).toBeGreaterThan(0);
      // and it finds what it looks for: a blue word, a green line and a faint word, planted here (FAKE), are each found
      await openTab(page, 'home');
      await page.addStyleTag({ content: '.brand { color: #3b82f6 !important } #home-conn-title { border-bottom: 1px solid #28fe14 } #prefs-title { color: #333333 !important }' });
      const planted = await looks(page);
      expect(planted.hue.filter((s) => s.startsWith('h1.brand color'))).toHaveLength(1);
      expect(planted.green.filter((s) => s.startsWith('h2#home-conn-title.box-title border-bottom-color'))).toHaveLength(1);
      expect(planted.contrast.filter((s) => s.startsWith('h2#prefs-title.box-title'))).toHaveLength(1);
    } finally { await context.close(); }
  });

  it('R5 lead (the finish line, item 3): the project\'s sealed chat turns and a turn being answered, as the frame carries them: in the conversation mirror, the event log and the Control Room, never their words', async () => {
    // FAKE: two sealed turns and a third being answered, laid into the real producer's frame (no model, no receipt written)
    const turns: NonNullable<WorkspaceFrame['chat']>['turns'] = [
      { receipt: 'd61b3006', surface: 'workbench', state: 'stopped', model: 'qwen3:8b', at: ago(60), ms: 4100, operation: 'of1057412', route: 'local', words: 'turn stopped in the Workbench · qwen3:8b · receipt d61b3006 · 4.1 s' },
      { receipt: 'fd970711', surface: 'repl', state: 'answered', model: 'qwen3:8b', at: ago(120), ms: 40, operation: null, route: 'local', words: 'turn answered in the REPL · qwen3:8b · receipt fd970711 · 0.0 s' },
    ];
    const withTurns = await start({ frame: async (o) => {
      const f = await buildWorkspaceFrame({ ...o, now: NOW });
      return { ...f, chat: { turns }, activity: { ...f.activity, running: f.activity.running + 1, stopCurrent: { job: null, words: 'Stop current: the chat turn in the Workbench (Esc in its composer)' }, chatTurn: { surface: 'workbench', since: ago(5), words: 'a chat turn is being answered in the Workbench (since 11:59:55 UTC)' } } };
    } });
    const { page, context, errors, outside } = await open({ on: withTurns });
    try {
      await openTab(page, 'chat');
      await page.waitForSelector('#console-logs [data-mirror="frame-turn"]', { timeout: 15_000 });
      const mirror = await page.$$eval('#console-logs [data-mirror="frame-turn"]', (els) => els.map((e) => ({ surface: (e as HTMLElement).dataset.surface, state: (e as HTMLElement).dataset.state, text: e.textContent ?? '' })));
      // oldest first, as a conversation reads; each names its receipt, and says its words are not here
      expect(mirror.map((m) => [m.surface, m.state])).toEqual([['repl', 'answered'], ['workbench', 'stopped']]);
      expect(mirror[1].text).toContain('d61b3006');
      expect(mirror[1].text).toContain('of1057412');
      expect(mirror[1].text).toContain('sealed before this page connected');
      expect(mirror[1].text).toContain('not shown here');
      expect(await page.textContent('#console-logs [data-mirror="frame-running"]')).toContain('a chat turn is being answered in the Workbench');
      expect(await page.textContent('#console-logs [data-mirror="frame-running"]')).toContain('Esc in its composer');
      // the event log beside it: the same entries the Workbench's log shows, newest first
      const events = await page.$$eval('#chat-events .ev', (els) => els.map((e) => e.textContent ?? ''));
      expect(events.findIndex((e) => e.includes('turn stopped in the Workbench'))).toBeLessThan(events.findIndex((e) => e.includes('turn answered in the REPL')));
      expect(events.filter((e) => e.includes('[chat]'))).toHaveLength(2);
      // the Control Room lists the turns and the one being answered
      await openTab(page, 'control');
      expect(await page.textContent('#control-now [data-control="chat-turns"]')).toBe('Chat turns (2)');
      expect(await page.textContent('#control-now [data-control="chat-running"]')).toContain('being answered in the Workbench');
      expect(await page.$$eval('#control-now [data-control="chat-turn-list"] .ev', (els) => els.length)).toBe(2);
      expect(errors).toEqual([]);
      expect(outside).toEqual([]);
    } finally { await context.close(); }
  });
  it('at 390 px wide every tab fits the window (nothing scrolls sideways), and Home\'s columns stack', async () => {
    const f = await frameNow();
    const { page, context } = await open({ viewport: { width: 390, height: 844 } });
    try {
      for (const t of f.tabs) {
        await openTab(page, t.id);
        const m = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth }));
        expect(Math.max(m.page, m.body), t.id).toBeLessThanOrEqual(m.inner);
        // each title set on a box's border stays one line, so none covers what its box holds
        const tall = await page.$$eval('.box-title, .ws-strip > .strip-title, .activity-head', (els) => els
          .filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().height > 24)
          .map((e) => `${e.className}: ${(e.textContent ?? '').trim().slice(0, 40)}`));
        expect(tall, t.id).toEqual([]);
      }
      await openTab(page, 'home');
      const cols = await page.$$eval('#ws-home .cols-home > *', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right) }; }));
      expect(cols.length).toBeGreaterThanOrEqual(2);
      expect(new Set(cols.map((c) => c.left)).size).toBe(1);
      for (let i = 1; i < cols.length; i += 1) expect(cols[i].top).toBeGreaterThan(cols[i - 1].top);
      for (const c of cols) expect(c.right).toBeLessThanOrEqual(390);
    } finally { await context.close(); }
  });
});
