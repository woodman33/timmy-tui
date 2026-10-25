/**
 * R11 round 7 (H175; SHELL CONTRACT v1 — review/SHELL-CONTRACT-v1.md; DESIGN.md §10 B11; the lead's D3/D4/D5): the one shell
 * for every destination, in a real Chromium at 1440×900 and 390×844 on this container's FAKE state (no identity provider
 * configured, a FAKE Ollama on 127.0.0.1 with one chat model chosen: the route ready; nothing signs in, no model runs).
 *
 * What is pinned: the rail's groups and destinations in D3's order (each item carrying the page id and the legacy tab id the
 * tests' helper clicks); TimmyShell.go by a page id and by a legacy id, current() the page id, body[data-page] beside the old
 * body[data-dest]; the scaffold on every page (the kicker "NN / VERB", the title, the intro, the band's three cells read from the
 * companion's own words, the dock holding the frame's actions, the records region); a page's registration (title, primary,
 * state) drawn and the primary run; the theme switch persisted per viewer across a reload (never a status's colour); the phone's
 * rail sheet and context sheet (open, Escape, the focus back on the opener, a dialog while open); Help & find (⌘K, filter,
 * Enter opens the first, Escape returns the focus); the keys 1–9/0 still switch pages though the old row is hidden; no
 * horizontal overflow and no shell text under 13 px at either size; no page error; the UI face Outfit and the mono face
 * Monaspace Argon as the registry says.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { browserPath, launchBrowser, openPage } from './helpers/companion-page-kit.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
const LONG = 240_000;
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();

describe.skipIf(!browserPath)('the one shell: rail, topbar, page scaffold, sheets, Help & find (R11 round 7, H175)', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let browser: Browser;
  let ollama: FakeOllama;
  let companion: CompanionServer;
  const origin = (): string => `http://127.0.0.1:${companion.port}`;
  const token = (): string => /#t=([0-9a-f]{64})$/.exec(companion.url)![1];

  beforeAll(async () => {
    browser = await launchBrowser();
    box = mkdtempSync(join(tmpdir(), 'h175-r7-shell-'));
    const home = process.env.TIMMY_HOME!;
    ollama = await startFakeOllama({ models: [{ name: 'fake-qwen3:8b', capabilities: ['completion', 'tools'] }], chat: [() => ({ chunks: textChunks('fake-qwen3:8b', ['FAKE answer.']), delayMs: 20 })] });
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(join(home, 'models', 'openrouter-catalog.json'), JSON.stringify({ fetchedAt: '2026-10-22T16:00:00.000Z', models: [] }));
    writeFileSync(join(home, 'providers.json'), JSON.stringify({ ollama_host: ollama.host }));
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'test', answers: { chat: 'local', ollama: ollama.host, model: 'fake-qwen3:8b' } }));
    const env = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR };
    const root = join(box, 'fresh');
    mkdirSync(join(root, '.timmy'), { recursive: true });
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env } });
    if (kept.TIMMY_REPO === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = kept.TIMMY_REPO;
  }, LONG);
  afterAll(async () => {
    await companion?.shutdown();
    await ollama?.close();
    await browser?.close();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  /** The page opened with its token at `size`, landed and connected. */
  async function open(size: { width: number; height: number }, storageState?: StorageState) {
    const o = await openPage(browser, { origin: origin() }, size, storageState);
    await o.page.goto(`${origin()}/#t=${token()}`);
    await o.page.waitForFunction(() => Boolean(document.body.dataset.page), null, { timeout: 30_000 });
    await o.page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
    // the frame read (the band's words, the dock's actions, the rail's keys)
    await o.page.waitForFunction(() => document.querySelectorAll('#ws-actions li').length > 0 || /fresh/.test(document.getElementById('shell-crumb-ws')?.textContent ?? ''), null, { timeout: 30_000 });
    return o;
  }
  const go = (page: Page, id: string): Promise<void> => page.evaluate((i) => { (window as unknown as { TimmyShell: { go(id: string, why?: string): void } }).TimmyShell.go(i, 'test'); }, id);
  const shown = (page: Page) => page.evaluate(() => ({
    page: document.body.dataset.page, dest: document.body.dataset.dest, current: (window as unknown as { TimmyShell: { current(): string } }).TimmyShell.current(),
    visible: [...document.querySelectorAll('.page')].filter((p) => !(p as HTMLElement).hidden).map((p) => p.id),
    title: (document.querySelector('.page:not([hidden]) .page-title')?.textContent ?? '').trim(),
    kicker: (document.querySelector('.page:not([hidden]) .page-kicker')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    crumb: (document.getElementById('shell-crumb-page')?.textContent ?? '').trim(),
    railCurrent: document.querySelector('#rail-menu .rail-item[aria-current="page"]')?.getAttribute('data-page') ?? null,
    scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
  }));
  /** Every text node in the shell's own regions, with its computed size (the page's floor is 13 px). */
  const smallText = (page: Page) => page.evaluate(() => {
    const out: string[] = [];
    const roots = [...document.querySelectorAll('#shell-rail, #shell-top, .page:not([hidden]) > .page-head, .page:not([hidden]) > .page-band, .page:not([hidden]) > .page-dock, #shell-help-dialog')];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      // eslint-disable-next-line no-cond-assign
      while ((n = walker.nextNode())) {
        const el = n.parentElement;
        if (!el || !n.textContent?.trim() || !el.getClientRects().length) continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 13) out.push(`${el.tagName.toLowerCase()}.${el.className} "${n.textContent.trim().slice(0, 30)}" ${size}px`);
      }
    }
    return out;
  });

  it('at 1440×900: the rail in D3\'s groups with the page and legacy ids, go() by either id, current() the page id, the scaffold on every page, the band from the companion\'s words, the dock holding the frame\'s actions, the keys still switching, no overflow, no small text, no error', async () => {
    const { context, page, errors } = await open(DESK);
    try {
      // the rail: D3's order; each item carries the page id and the legacy tab id (what tests/helpers/companion-page-kit.ts clicks)
      const items = await page.$$eval('#rail-menu .rail-item', (els) => els.map((e) => [e.getAttribute('data-page'), e.getAttribute('data-dest'), (e.querySelector('.rail-label')?.textContent ?? '').replace(/\s+/g, ' ').trim()]));
      expect(items).toEqual([
        ['chat', 'chat', 'Chat'], ['files', 'files', 'Files'], ['workflows', 'workflows', 'Workflows'], ['runs', 'logs', 'Runs & receipts'],
        ['canvas', 'studio', 'Canvas'], ['voxvision', 'voxvision', 'VoxVision'], ['motion', 'create', 'Motion & 3D'],
        ['connections', 'connections', 'Models & accounts'], ['tools', 'tools', 'Tools & integrations'], ['control', 'control', 'Control Room'],
      ]);
      expect(await page.$$eval('#rail-menu .rail-group', (els) => els.map((e) => (e.textContent ?? '').trim()))).toEqual(['Work', 'Create', 'Connect']);
      // the old tab row is in the DOM for the keys and the switcher, never seen; Fleet & Clef and Home are not in the rail (D3)
      expect(await page.isVisible('#ws-tabs')).toBe(false);
      expect(await page.locator('#rail-menu .rail-item[data-page="fleet"], #rail-menu .rail-item[data-page="home"]').count()).toBe(0);
      // the landing: Chat, the rail's current item, the crumb, the title focused is not amber-ringed (a quiet ring)
      let s = await shown(page);
      expect(s).toMatchObject({ page: 'chat', dest: 'chat', current: 'chat', visible: ['ws-chat'], crumb: 'Chat', railCurrent: 'chat' });
      // (the kicker's number is the rail's order; its words are the page's — H171 registers Chat's in capitals, the sheet draws them so)
      expect(s.kicker.toLowerCase()).toBe('01 / start a conversation');
      expect(s.title.length).toBeGreaterThan(8);
      expect(await text(page, '#shell-crumb-ws')).toBe('fresh');
      // the band reads the companion's own words (the project, the route of the next turn, the records' state): nothing invented
      const band = await page.$$eval('#ws-chat .page-band .band-cell', (els) => els.map((e) => [(e.querySelector('.band-k')?.textContent ?? '').trim(), (e.querySelector('.band-v')?.textContent ?? '').trim()]));
      expect(band.map((c) => c[0])).toEqual(['Workspace', 'Model', 'Records']);
      expect(band[0][1]).toBe('fresh');
      expect(band[1][1]).toMatch(/fake-qwen3:8b/);
      expect(band[2][1].length, 'the Records cell: the companion\'s own words (H171\'s band() once Chat registers, else the legacy state words)').toBeGreaterThan(3);
      expect(band[2][1]).not.toMatch(/^Reading/);
      // the live status word: green only while the socket is observed open, with its words
      expect(await text(page, '#shell-status')).toBe('Companion answering');
      expect(await page.$eval('#shell-status', (e) => e.classList.contains('is-live'))).toBe(true);
      // every page: the scaffold's regions, the kicker numbered in the rail's order, a title and an intro, the dock with the frame's
      // actions inside it (the strip moved there), the records region; by a page id and by a legacy id
      const expectPage = async (goId: string, id: string, legacy: string, el: string, n: string) => {
        await go(page, goId);
        s = await shown(page);
        expect(s, id).toMatchObject({ page: id, dest: legacy, current: id, visible: [el], railCurrent: ['home', 'fleet', 'settings', 'account'].includes(id) ? null : id });
        expect(s.kicker, id).toMatch(new RegExp(`^${n} / \\S`, 'i'));
        expect(s.title.length, id).toBeGreaterThan(8);
        expect(s.scrollW, `${id}: no horizontal overflow`).toBeLessThanOrEqual(s.innerW);
        const regions = await page.$eval(`#${el}`, (p) => ['.page-head', '.page-band', '.page-body > .page-work', '.page-body > .page-context', '.page-dock', '.page-records'].map((c) => Boolean(p.querySelector(`:scope > ${c}`))));
        expect(regions, `${id}: head, band, work, context, dock, records`).toEqual([true, true, true, true, true, true]);
        expect(await page.$eval(`#${el}`, (p) => p.querySelector(':scope > .page-dock #ws-strip') !== null), `${id}: the frame's actions in the dock`).toBe(true);
        expect(await page.$eval(`#${el} .page-intro`, (e) => (e.textContent ?? '').trim().length)).toBeGreaterThan(10);
      };
      await expectPage('workflows', 'workflows', 'workflows', 'ws-workflows', '03');
      await expectPage('logs', 'runs', 'logs', 'ws-logs', '04'); // (by its legacy id: Runs & receipts)
      await expectPage('canvas', 'canvas', 'studio', 'ws-studio', '05');
      await expectPage('voxvision', 'voxvision', 'voxvision', 'ws-voxvision', '06');
      await expectPage('create', 'motion', 'create', 'ws-create', '07'); // (by its legacy id: Motion & 3D)
      await expectPage('connections', 'connections', 'connections', 'screen-connections', '08');
      await expectPage('tools', 'tools', 'tools', 'ws-tools', '09');
      await expectPage('control', 'control', 'control', 'ws-control', '10');
      await expectPage('files', 'files', 'files', 'ws-files', '02');
      // the mounted connections screen draws inside the page's work region (its own cards), the rail beside it
      await go(page, 'connections');
      // (H170's draw writes into the scaffold's work region and registers the page: the PRIMARY is drawn by the shell — GATE 04)
      await page.waitForSelector('#screen-connections .page-primary .ui-primary', { timeout: 15_000 });
      expect(await page.$eval('#screen-connections .page-work', (e) => e.childElementCount)).toBeGreaterThan(0);
      expect(await page.isVisible('#shell-rail')).toBe(true);
      // the page's primary next action: the head's button and the band's text action carry the same words (the page's own
      // registration — H169's Workflows — or, unregistered, the frame's primary action: Fleet & Clef, legacy, has only the frame's)
      await go(page, 'workflows');
      const primary = await text(page, '#ws-workflows .page-primary .ui-primary span:first-child');
      expect(primary.length).toBeGreaterThan(3);
      expect(await text(page, '#ws-workflows .band-action')).toContain(primary);
      await go(page, 'fleet');
      const framePrimary = await page.$eval('#ws-fleet .page-dock #ws-actions li[data-primary="true"]', (e) => (e.textContent ?? '').replace(/^\d+\.\s*/, '').trim()).catch(() => '');
      if (framePrimary) expect(await text(page, '#ws-fleet .page-primary .ui-primary span:first-child')).toBe(framePrimary);
      // the keys of the old row still switch pages: 0 opens Runs & receipts (logs), 2 Chat
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
      await page.keyboard.press('0');
      await page.waitForFunction(() => document.body.dataset.page === 'runs', null, { timeout: 5_000 });
      expect((await shown(page)).railCurrent).toBe('runs');
      await page.keyboard.press('2');
      await page.waitForFunction(() => document.body.dataset.page === 'chat', null, { timeout: 5_000 });
      // a page's registration: title, primary (run on click), state words with a verb-led next action; the band's own cells
      // (on a page no owner's script registers at show — Fleet & Clef, legacy — so the test's own registration is what is drawn)
      await page.evaluate(() => {
        const w = window as unknown as { TimmyShell: { page(id: string, r: object): void; state(id: string, s: string, o?: object): void; band(id: string, c: object): void; go(id: string): void } };
        (window as unknown as { __ran: string[] }).__ran = [];
        w.TimmyShell.page('fleet', { kicker: '08 / A TEST KICKER', title: 'A test title for the fleet page.', intro: 'A test intro.', primary: { label: 'Open a test source', run: () => (window as unknown as { __ran: string[] }).__ran.push('primary') }, context: 'selection', band: [{ k: 'Sources', v: '0 files' }] });
        w.TimmyShell.state('fleet', 'empty', { words: 'Nothing in this project yet.', next: { label: 'Add a source', run: () => (window as unknown as { __ran: string[] }).__ran.push('next') } });
        w.TimmyShell.band('fleet', { records: 'Test records' });
        w.TimmyShell.go('fleet');
      });
      s = await shown(page);
      expect(s.title).toBe('A test title for the fleet page.');
      expect(s.kicker).toBe('08 / A TEST KICKER'); // (a page outside the rail keeps the number it registered)
      expect(await page.getAttribute('#ws-fleet', 'data-state')).toBe('empty');
      expect(await text(page, '#ws-fleet .page-state')).toContain('Nothing in this project yet.');
      await page.click('#ws-fleet .page-state-next');
      await page.click('#ws-fleet .page-primary .ui-primary');
      expect(await page.evaluate(() => (window as unknown as { __ran: string[] }).__ran)).toEqual(['next', 'primary']);
      const cells = await page.$$eval('#ws-fleet .page-band .band-cell', (els) => els.map((e) => [(e.querySelector('.band-k')?.textContent ?? '').trim(), (e.querySelector('.band-v')?.textContent ?? '').trim()]));
      expect(cells.map((c) => c[0])).toEqual(['Workspace', 'Model', 'Records', 'Sources']);
      expect(cells[2][1]).toBe('Test records');
      expect(cells[3][1]).toBe('0 files');
      // approval: NEEDS YOU first in the band, amber by its class (its word says it; its colour is the focus amber, not green)
      await page.evaluate(() => (window as unknown as { TimmyShell: { state(id: string, s: string, o?: object): void } }).TimmyShell.state('fleet', 'approval', { words: 'A test approval waits' }));
      expect(await text(page, '#ws-fleet .page-band .band-cell.is-attn')).toContain('Needs you');
      expect(await page.$eval('#ws-fleet .page-band .band-cell.is-attn .band-v', (e) => getComputedStyle(e).color)).toBe('rgb(255, 176, 0)');
      // D8: the shell draws the ONE arrow; a label registered with a trailing arrow loses it (never "→ →")
      await page.evaluate(() => (window as unknown as { TimmyShell: { page(id: string, r: object): void } }).TimmyShell.page('fleet', { primary: { label: 'Continue to the workspace →', run: () => undefined } }));
      expect(await text(page, '#ws-fleet .page-primary .ui-primary span:first-child')).toBe('Continue to the workspace');
      expect(await page.$$eval('#ws-fleet .page-primary .ui-primary, #ws-fleet .band-action', (els) => els.map((e) => ((e.textContent ?? '').match(/[→↗]/g) ?? []).length))).toEqual([1, 1]);
      // D11: a digit key puts the focus on the page's title (the tab button is hidden), never on the body
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
      await page.keyboard.press('3');
      await page.waitForFunction(() => document.body.dataset.page === 'workflows', null, { timeout: 5_000 });
      expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain('page-title');
      // the type: the UI face for the title and the rail, the mono face for a key
      expect(await page.$eval('.page:not([hidden]) .page-title', (e) => getComputedStyle(e).fontFamily)).toMatch(/^"?Outfit"?/);
      expect(await page.$eval('#rail-menu .rail-item', (e) => getComputedStyle(e).fontFamily)).toMatch(/^"?Outfit"?/);
      expect(await page.$eval('#shell-help kbd', (e) => getComputedStyle(e).fontFamily)).toMatch(/^"?Monaspace Argon"?/);
      // no shell text under 13 px, on the pages seen
      for (const id of ['chat', 'workflows', 'connections', 'files', 'settings']) { await go(page, id); expect(await smallText(page), id).toEqual([]); }
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, LONG);

  it('Help & find: ⌘K / Ctrl+K and ? open one dialog over the page; typing filters the destinations, the page\'s actions and the keys; Enter opens the first; Escape closes and the focus returns to the opener', async () => {
    const { context, page, errors } = await open(DESK);
    try {
      await page.focus('#rail-project');
      await page.keyboard.press('Control+k');
      await page.waitForSelector('#shell-help-dialog[open]', { timeout: 5_000 });
      expect(await page.evaluate(() => document.activeElement?.className)).toBe('help-find');
      const sections = await page.$$eval('#shell-help-dialog .help-k', (els) => els.map((e) => (e.textContent ?? '').trim()));
      expect(sections).toEqual(['Go to', 'On this page', 'Keys']);
      expect(await page.$$eval('#shell-help-dialog .help-list .help-item', (els) => els.map((e) => (e.querySelector('span')?.textContent ?? '').trim()))).toEqual(expect.arrayContaining(['Open Chat', 'Open Files', 'Open Settings', 'Open Account', 'Switch to Glacier']));
      const keys = await page.$$eval('#shell-help-dialog .help-key', (els) => els.map((e) => `${(e.querySelector('kbd')?.textContent ?? '').trim()} ${(e.querySelector('span')?.textContent ?? '').trim()}`));
      expect(keys).toEqual(expect.arrayContaining(['⌘K Help & find (this)', 'Esc Close a sheet or this overlay', '0 Open Runs & receipts']));
      // typing filters all three lists; Enter opens the first match
      // (a destination matches by its name, its id or its verb phrase: "work" would also find Canvas's "Shape the work")
      await page.type('.help-find', 'workfl');
      expect(await page.$$eval('#shell-help-dialog .help-list .help-item span:first-child', (els) => els.map((e) => (e.textContent ?? '').trim()).filter((t) => /^Open /.test(t)))).toEqual(['Open Workflows']);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.body.dataset.page === 'workflows' && !(document.getElementById('shell-help-dialog') as HTMLDialogElement).open, null, { timeout: 5_000 });
      // ? when not typing; Escape closes it and the focus goes back where it was
      await page.focus('#rail-project');
      await page.keyboard.press('?');
      await page.waitForSelector('#shell-help-dialog[open]', { timeout: 5_000 });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !(document.getElementById('shell-help-dialog') as HTMLDialogElement).open, null, { timeout: 5_000 });
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('rail-project');
      // ? while typing in a field types the character
      await page.focus('#cx-input').catch(() => undefined);
      if (await page.isVisible('#cx-input')) {
        await page.keyboard.press('?');
        expect(await page.inputValue('#cx-input')).toBe('?');
        expect(await page.evaluate(() => (document.getElementById('shell-help-dialog') as HTMLDialogElement).open)).toBe(false);
      }
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, LONG);

  it('the theme: Amber by default, Glacier by the switch (html[data-theme], aria-pressed), kept per viewer across a reload (localStorage, the shell\'s key only); the focus ring and an observed live state keep their colours in both', async () => {
    const { context, page, errors } = await open(DESK);
    let state: StorageState;
    try {
      expect(await page.getAttribute('html', 'data-theme')).toBe('amber');
      const accentAmber = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--timmy-ui-accent').trim());
      await page.click('.theme-switch [data-theme="glacier"]');
      expect(await page.getAttribute('html', 'data-theme')).toBe('glacier');
      expect(await page.$$eval('.theme-switch [data-theme]', (els) => els.map((e) => `${e.getAttribute('data-theme')}=${e.getAttribute('aria-pressed')}`))).toEqual(['glacier=true', 'amber=false']);
      const accentGlacier = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--timmy-ui-accent').trim());
      expect(accentAmber.toUpperCase()).toBe('#D6AA64');
      expect(accentGlacier.toUpperCase()).toBe('#8ABBE3');
      // the statuses do not move with the family: focus and verified are the same values in both
      for (const name of ['--timmy-ui-focus', '--timmy-ui-verified']) {
        expect(await page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toUpperCase(), name)).toBe(name.endsWith('focus') ? '#FFB000' : '#28FE14');
      }
      expect(await page.$eval('#shell-status', (e) => getComputedStyle(e).color)).toBe('rgb(40, 254, 20)');
      expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('timmy.')).sort())).toEqual(expect.arrayContaining(['timmy.theme']));
      expect(await page.evaluate(() => localStorage.getItem('timmy.theme'))).toBe('glacier');
      state = await context.storageState();
      expect(errors).toEqual([]);
    } finally { await context.close(); }
    const again = await open(DESK, state!);
    try {
      expect(await again.page.getAttribute('html', 'data-theme')).toBe('glacier');
      expect(await again.page.$eval('.theme-switch [data-theme="glacier"]', (e) => e.getAttribute('aria-pressed'))).toBe('true');
      expect(again.errors).toEqual([]);
    } finally { await again.context.close(); }
  }, LONG);

  it('a page opened WITHOUT any token (an address typed by hand) keeps companion.js\'s no-token words — the shell answers every fetch with its own 401 { needs: "token" }, asks the companion nothing and never turns it into the "not the companion\'s" refusal (the lead\'s 18:01 ruling, H172\'s LEGACY 01)', async () => {
    const o = await openPage(browser, { origin: origin() }, DESK);
    const apiRequests: string[] = [];
    o.page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) apiRequests.push(u.pathname); });
    try {
      await o.page.goto(`${origin()}/`);
      await o.page.waitForFunction(() => Boolean(document.body.dataset.page), null, { timeout: 30_000 });
      await o.page.waitForTimeout(2500); // (every script's first reads, the frame's poll: all answered in the page)
      expect(await text(o.page, '#token-note')).toMatch(/^This page has no token from Timmy.*in the Workbench \(`timmy workbench`\), press c.*in `timmy watch`, press q on HOME/);
      expect(await text(o.page, '#token-note')).not.toMatch(/not the companion/);
      // (companion.js's `companion` is a script-scope const, not a window property: the refusal is read by its words, not its flag)
      expect(await text(o.page, '#shell-status')).toBe('No token · open the page from Timmy');
      // the shell's fetch answers in the page: a 401 that names the missing token, no request to the companion
      const answer = await o.page.evaluate(async () => { const r = await (window as unknown as { TimmyShell: { fetch(u: string): Promise<Response> } }).TimmyShell.fetch('/api/workspace'); return { status: r.status, body: await r.json() as { needs?: string; words?: string } }; });
      expect(answer.status).toBe(401);
      expect(answer.body.needs).toBe('token');
      expect(answer.body.words).toMatch(/no token from Timmy/);
      expect(apiRequests, 'no /api/ request leaves a token-less page').toEqual([]);
      expect(o.errors).toEqual([]);
    } finally { await o.context.close(); }
  }, LONG);

  it('at 390×844 (D5): the rail is a top strip whose Menu opens the sheet (a dialog; Escape closes it; the focus returns to Menu; a choice closes it); a registered context opens as a sheet the same way; the band wraps; the dock stays; nothing overflows sideways; no small text', async () => {
    const { context, page, errors } = await open(PHONE);
    try {
      expect(await page.isVisible('#shell-menu')).toBe(true);
      expect(await page.isVisible('#rail-sheet')).toBe(false);
      const s0 = await shown(page);
      expect(s0.scrollW).toBeLessThanOrEqual(s0.innerW);
      // the sheet
      await page.click('#shell-menu');
      await page.waitForSelector('#shell-rail.is-open', { timeout: 5_000 });
      expect(await page.isVisible('#rail-sheet')).toBe(true);
      expect(await page.getAttribute('#rail-sheet', 'role')).toBe('dialog');
      expect(await page.getAttribute('#rail-sheet', 'aria-modal')).toBe('true');
      expect(await page.getAttribute('#shell-menu', 'aria-expanded')).toBe('true');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-page'))).toBe('chat'); // the current item takes the focus
      expect(await page.isVisible('#shell-scrim')).toBe(true);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('shell-rail')?.classList.contains('is-open'), null, { timeout: 5_000 });
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('shell-menu');
      expect(await page.getAttribute('#rail-sheet', 'aria-modal')).toBeNull();
      // a choice closes it and opens the page
      await page.click('#shell-menu');
      await page.waitForSelector('#shell-rail.is-open', { timeout: 5_000 });
      await page.click('#rail-menu .rail-item[data-page="workflows"]');
      await page.waitForFunction(() => document.body.dataset.page === 'workflows' && !document.getElementById('shell-rail')?.classList.contains('is-open'), null, { timeout: 5_000 });
      let s = await shown(page);
      expect(s.scrollW).toBeLessThanOrEqual(s.innerW);
      // the band wraps to two by two; the dock is on the page with the frame's actions
      expect(await page.$$eval('#ws-workflows .page-band .band-cell', (els) => els.length)).toBeGreaterThanOrEqual(3); // (the three standard cells; an owner may add its own — H169 does)
      expect(await page.isVisible('#ws-workflows .page-dock #ws-actions')).toBe(true);
      // the context as a sheet: a registered context with something in it shows its opener; open, Escape, the focus back
      await page.evaluate(() => {
        const w = window as unknown as { TimmyShell: { page(id: string, r: object): void; go(id: string): void } };
        w.TimmyShell.page('workflows', { context: 'selection' });
        const ctx = document.getElementById('page-context-workflows')!;
        const b = document.createElement('button'); b.type = 'button'; b.textContent = 'A test control in the context'; b.className = 'ui-btn test-ctx';
        ctx.append(b);
        w.TimmyShell.page('workflows', { context: 'selection' });
      });
      await page.waitForSelector('#ws-workflows .page-context-btn:not([hidden])', { timeout: 5_000 });
      await page.click('#ws-workflows .page-context-btn');
      await page.waitForSelector('#page-context-workflows.is-open', { timeout: 5_000 });
      expect(await page.getAttribute('#page-context-workflows', 'role')).toBe('dialog');
      expect(await page.evaluate(() => document.activeElement?.className)).toBe('ui-btn test-ctx');
      const box = await page.$eval('#page-context-workflows', (e) => e.getBoundingClientRect().toJSON() as { left: number; right: number; bottom: number });
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(390);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('page-context-workflows')?.classList.contains('is-open'), null, { timeout: 5_000 });
      expect(await page.evaluate(() => document.activeElement?.className.includes('page-context-btn'))).toBe(true);
      // Help & find at this size too, its width inside the viewport
      await page.keyboard.press('Control+k');
      await page.waitForSelector('#shell-help-dialog[open]', { timeout: 5_000 });
      const dlg = await page.$eval('#shell-help-dialog', (e) => e.getBoundingClientRect().toJSON() as { left: number; right: number });
      expect(dlg.left).toBeGreaterThanOrEqual(0);
      expect(dlg.right).toBeLessThanOrEqual(390);
      await page.keyboard.press('Escape');
      // every page at this size: nothing sideways, no small shell text
      for (const id of ['chat', 'runs', 'connections', 'canvas', 'control', 'files', 'home']) {
        await go(page, id);
        s = await shown(page);
        expect(s.scrollW, `${id}: no horizontal overflow at 390`).toBeLessThanOrEqual(s.innerW);
        expect(await smallText(page), id).toEqual([]);
      }
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, LONG);
});
