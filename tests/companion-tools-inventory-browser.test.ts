/**
 * R11 Phase 2 (H171): the page's Tools & integrations shows the capability inventory first: one card per row, the chip with
 * the standing word (available · configured · exercised; no chip when none holds, as the terminal draws none), the row's own three sentences
 * verbatim (the one words file both surfaces read: a card says what the terminal's row says for the same FAKE state), and the
 * one next step; a step that needs a key or an address says where it is set (the terminal's words), and the page enters no credential (no
 * input in a card); green only on the exercised word (a verified receipt); the cards stack on a phone. The rows are a FAKE
 * set given to the companion (CompanionOptions.inventory), named FAKE on every card: nothing on this machine decides the
 * words. Check again asks the companion once more (the FAKE counts its calls).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { inventoryOfRows } from '../src/companion/panels/tools-inventory.js';
import { FAKE_ROWS } from './fixtures/fake-inventory-rows.js';
import { landWorkspace } from './helpers/companion-page-kit.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-tools-inventory-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');
const LONG = 240_000;
const FAKE_READ = 'FAKE rows given to the companion by a test: nothing on this computer was read';
const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
const texts = (page: Page, sel: string): Promise<string[]> => page.$$eval(sel, (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
/** the chips in card order: a row none of the words holds for has no chip (the terminal's rule: never a fourth word) */
const CHIPS = ['● available', '● configured', '● available', '● exercised', '● configured'];

describe.skipIf(!browserPath)('the Tools & integrations inventory in a real browser: a card per row in the three words (R11 Phase 2, H171)', () => {
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let browser: Browser;
  let companion: CompanionServer;
  let asked = 0;

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'h171-p2-inventory-'));
    const root = join(box, 'FAKE-project');
    mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
    const env = { TIMMY_HOME: join(box, 'home'), TIMMY_SETTINGS_DIR: join(box, 'settings'), TIMMY_MCP_HOME: join(box, 'mcp-home') };
    mkdirSync(env.TIMMY_MCP_HOME, { recursive: true });
    process.env.TIMMY_HOME = env.TIMMY_HOME;
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { workspace: { env, shareMs: 0 }, inventory: async () => { asked += 1; return { inventory: inventoryOfRows(FAKE_ROWS), read: FAKE_READ }; } });
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, LONG);
  afterAll(async () => {
    await browser?.close();
    await companion?.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  async function open(size: { width: number; height: number }): Promise<{ page: Page; errors: string[] }> {
    const page = await browser.newPage({ viewport: size });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(companion.url);
    await landWorkspace(page);
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
    await page.keyboard.press('9');
    await page.waitForSelector('[data-tools-caps] .tl-card', { timeout: 30_000 });
    return { page, errors };
  }

  it('at 1440 × 900: the cards in the inventory\'s groups, each chip one of the three words (none when none holds), the row\'s own sentences, the next step; a key step says where it is set; no input on a card; green only on exercised', async () => {
    const { page, errors } = await open({ width: 1440, height: 900 });
    try {
      expect(await text(page, '[data-tools-caps] .tl-words')).toBe('6 capabilities here: 1 exercised, 2 configured, 2 available, 1 with none of the three.');
      expect(await texts(page, '[data-tools-caps] .tl-group-k')).toEqual(['Models', 'Tools', 'Vision', 'Receipts']);
      const cards = await page.$$eval('[data-tools-caps] .tl-card', (els) => els.map((e) => [e.getAttribute('data-inventory-row'), (e.querySelector('.tl-name')?.textContent ?? '').trim(), (e.querySelector('.tl-chip')?.textContent ?? '(no chip)').trim(), e.getAttribute('data-state')]));
      expect(cards).toEqual([
        ['fake:model:openrouter', 'FAKE hosted models (OpenRouter)', '● available', 'available'],
        ['fake:model:ollama-local', 'FAKE local models (Ollama)', '● configured', 'configured'],
        ['fake:tool:docker', 'FAKE Docker engine', '● available', 'available'],
        ['fake:vox:measure', 'FAKE VoxVision measure', '● exercised', 'exercised'],
        ['fake:vision:bridge', 'FAKE vision bridge', '(no chip)', 'none'],
        ['fake:receipts:chain', 'FAKE receipts (timmy receipts)', '● configured', 'configured'],
      ]);
      // every card's three sentences are the row's own words, verbatim (what the terminal shows for the same row), each fact apart
      for (const r of FAKE_ROWS) {
        const sel = `[data-inventory-row="${r.id}"]`;
        expect(await texts(page, `${sel} .tl-fact .tl-fact-w`)).toEqual([r.available.words, r.configured.words, r.exercised.words]);
        expect(await page.$$eval(`${sel} .tl-fact`, (els) => els.map((e) => [e.getAttribute('data-tl-fact'), e.getAttribute('data-tl-ok')]))).toEqual([
          ['available', r.available.ok ? '1' : '0'], ['configured', r.configured.ok ? '1' : '0'], ['exercised', r.exercised.ok ? '1' : '0'],
        ]);
      }
      // the key step: named, said to be set in the terminal, nothing to type
      const key = '[data-inventory-row="fake:model:openrouter"]';
      // the step in the terminal's words (inventoryNext: the step and where it is set), the inventory's sentence whole as the detail, then the note
      expect(await text(page, `${key} .tl-next`)).toBe('Next sign in with OpenRouter, or paste a key: Models & accounts Sign in with OpenRouter, or paste a key from openrouter.ai/keys Set in Models & accounts, the environment or the .env file: nothing is set from this card.');
      expect(await page.getAttribute(`${key} .tl-next`, 'data-tl-next')).toBe('terminal');
      // a plain step says only the step
      expect(await text(page, '[data-inventory-row="fake:model:ollama-local"] .tl-next')).toBe('Next send a message in the chat; each answered turn seals a receipt Send a message in the chat (each answered turn seals a receipt)');
      expect(await page.getAttribute('[data-inventory-row="fake:model:ollama-local"] .tl-next', 'data-tl-next')).toBe('step');
      // the exercised row: nothing next
      expect(await text(page, '[data-inventory-row="fake:vox:measure"] .tl-next')).toBe('Next nothing: it is exercised here.');
      // green (the page's --timmy-live) only on the exercised chip and the exercised fact's mark
      const green = await page.evaluate(() => {
        const live = getComputedStyle(document.documentElement).getPropertyValue('--timmy-live').trim();
        const probe = document.createElement('span'); probe.style.color = live; document.body.append(probe);
        const g = getComputedStyle(probe).color; probe.remove();
        const chips = [...document.querySelectorAll('[data-tools-caps] .tl-chip')].filter((e) => getComputedStyle(e).color === g).map((e) => e.getAttribute('data-tl-word'));
        const marks = [...document.querySelectorAll('[data-tools-caps] .tl-mark')].filter((e) => getComputedStyle(e).color === g).map((e) => e.closest('.tl-card')?.getAttribute('data-inventory-row') + ':' + e.closest('.tl-fact')?.getAttribute('data-tl-fact'));
        return { chips, marks };
      });
      expect(green).toEqual({ chips: ['exercised'], marks: ['fake:vox:measure:exercised'] });
      // no credential entry on the page's cards: not one input, and no key anywhere on the face
      expect(await page.$$eval('[data-tools-caps] input, [data-tools-caps] textarea, [data-tools-caps] select', (els) => els.length)).toBe(0);
      expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/sk-or-|Bearer /);
      // the three meanings once; what was read, and that the page sets nothing
      expect(await text(page, '[data-tools-caps] .tl-legend')).toBe('available: the files or binaries are here · configured: the key, setting or address is set · exercised: a receipt of a real run exists');
      expect(await text(page, '[data-tools-caps] .tl-note')).toBe(`Read: ${FAKE_READ}. Nothing is set from these cards: a key or an address is set in Models & accounts, the environment or the .env file.`);
      // Check again asks the companion once more (the FAKE counts)
      const before = asked;
      await page.click('[data-tl-refresh]');
      await page.waitForFunction(() => !document.querySelector('[data-tl-refresh][disabled]') && (document.querySelector('[data-tools-caps] .tl-at')?.textContent ?? '') !== '', null, { timeout: 15_000 });
      expect(asked).toBe(before + 1);
      expect(await texts(page, '[data-tools-caps] .tl-chip')).toEqual(CHIPS);
      // the cards side by side at this width (the two Models cards on one row)
      const tops = await page.$$eval('[data-tl-group="Models"] .tl-card', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(tops).toHaveLength(2);
      expect(new Set(tops).size).toBe(1);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, LONG);

  it('the routes: GET …/state carries the inventory under its schema with the rows verbatim (what the terminal reads); GET …/inventory the same rows with the page\'s cards; no key\'s value in either', async () => {
    const token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
    const get = async (path: string): Promise<Record<string, unknown>> => {
      const r = await fetch(`http://127.0.0.1:${companion.port}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(r.status).toBe(200);
      return r.json() as Promise<Record<string, unknown>>;
    };
    const state = await get('/api/panel/tools/state');
    expect(state.ok).toBe(true);
    expect(state.inventory).toMatchObject({ schema: 'timmy.capability-inventory/1', rows: FAKE_ROWS, groups: ['Models', 'Tools', 'Integrations', 'Lanes', 'Vision', 'Receipts'] });
    const inv = await get('/api/panel/tools/inventory');
    expect(inv.inventory).toEqual(state.inventory);
    expect(inv.read).toBe(FAKE_READ);
    expect((inv.cards as Array<{ id: string; standing: string }>).map((c) => [c.id, c.standing])).toEqual([
      ['fake:model:openrouter', 'available'], ['fake:model:ollama-local', 'configured'], ['fake:tool:docker', 'available'], ['fake:vox:measure', 'exercised'], ['fake:vision:bridge', 'none'], ['fake:receipts:chain', 'configured'],
    ]);
    expect(JSON.stringify([state, inv])).not.toMatch(/sk-or-|Bearer /);
    // a page without the token gets nothing
    expect((await fetch(`http://127.0.0.1:${companion.port}/api/panel/tools/inventory`)).status).toBe(401);
  }, LONG);

  it('at 1280 × 720 the same words; at 390 × 844 the cards stack, each the width of the page, nothing cut', async () => {
    for (const size of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
      const { page, errors } = await open(size);
      try {
        expect(await texts(page, '[data-tools-caps] .tl-chip')).toEqual(CHIPS);
        for (const r of FAKE_ROWS) expect(await texts(page, `[data-inventory-row="${r.id}"] .tl-fact .tl-fact-w`)).toEqual([r.available.words, r.configured.words, r.exercised.words]);
        const geo = await page.$$eval('[data-tools-caps] .tl-card', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { left: Math.round(r.left), inside: r.left >= 0 && r.right <= window.innerWidth + 1, cut: e.scrollWidth > e.clientWidth + 1 }; }));
        expect(geo).toHaveLength(6);
        for (const g of geo) { expect(g.inside).toBe(true); expect(g.cut).toBe(false); }
        if (size.width === 390) {
          // stacked: every card starts at the same left edge; the two Models cards on different rows
          expect(new Set(geo.map((g) => g.left)).size).toBe(1);
          const tops = await page.$$eval('[data-tl-group="Models"] .tl-card', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
          expect(new Set(tops).size).toBe(tops.length);
        }
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }
  }, LONG);
});
