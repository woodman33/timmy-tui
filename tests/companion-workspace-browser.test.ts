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
});
