/**
 * R6 lead: the companion page's tab panels (src/companion/client/panels.js; companion.js draws them): a panel registered for
 * a tab draws into that tab's host when the tab is shown, is given the shown project and its own routes' address, and one
 * that throws says so in words in its host while the rest of the page keeps working. In a real headless Chromium against the
 * real companion server on 127.0.0.1.
 *
 * FAKE pieces, labelled: the panels themselves (registered by the test in the page, standing in for panel-vox.js and
 * panel-tools.js) and the frame's clock (a fixed `now`). Real: the server, its token, the frame producer, the page's code.
 * Skipped, saying so, where no Chromium or Chrome is found.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorkspaceFrame } from '../src/ops/workspace-frame.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-panels-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const NOW = Date.parse('2026-10-16T12:00:00.000Z');

describe.skipIf(!browserPath)('the companion page\'s tab panels draw where their tab is shown (R6 lead)', () => {
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let browser: Browser;
  let companion: CompanionServer;

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'r6-panels-browser-'));
    const root = join(box, 'FAKE-project');
    mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
    const env = { TIMMY_HOME: join(box, 'home'), TIMMY_SETTINGS_DIR: join(box, 'settings') };
    process.env.TIMMY_HOME = env.TIMMY_HOME;
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { workspace: { env, frame: (o) => buildWorkspaceFrame({ ...o, now: NOW }), shareMs: 0 } });
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await companion?.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  async function open(): Promise<{ page: Page; errors: string[] }> {
    const page = await browser.newPage({ viewport: { width: 1376, height: 768 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(companion.url);
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
    await page.waitForSelector('#home-connections .conn-card', { timeout: 15_000 });
    return { page, errors };
  }

  it('serves the registry and both panels\' files, and loads them before the page\'s own code', async () => {
    for (const f of ['/panels.js', '/panel-vox.js', '/panel-tools.js']) {
      const r = await fetch(new URL(f, companion.url));
      expect(r.status, f).toBe(200);
      expect(r.headers.get('content-type') ?? '', f).toMatch(/javascript/);
    }
    const { page, errors } = await open();
    try {
      expect(await page.evaluate(() => typeof (globalThis as unknown as { TimmyPanels?: unknown }).TimmyPanels === 'undefined' ? 'absent' : 'present'))
        .toBe('absent'); // a classic script's top-level const is no property of the window …
      expect(await page.evaluate('typeof TimmyPanels.register')).toBe('function'); // … but every later script sees it
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('a registered panel draws only when its tab is shown, for the shown project, with its own routes\' address', async () => {
    const { page, errors } = await open();
    try {
      await page.evaluate(`(() => {
        window.__drawn = [];
        TimmyPanels.register('voxvision', { draw(host, frame, ctx) {
          window.__drawn.push({ schema: frame.schema, own: ctx.own, project: ctx.project, api: ctx.api('records') });
          host.replaceChildren(ctx.h('p', { class: 'fake-panel' }, 'FAKE panel drawn'));
        } });
      })()`);
      expect(await page.evaluate('window.__drawn.length')).toBe(0);
      await page.keyboard.press('5');
      await page.waitForSelector('[data-panel-host="voxvision"] .fake-panel', { timeout: 10_000 });
      const drawn = await page.evaluate('window.__drawn') as Array<{ schema: string; own: boolean; project: string; api: string }>;
      const shown = await page.evaluate(() => document.getElementById('project')?.dataset.project ?? '');
      expect(shown).toMatch(/\S/);
      expect(drawn[0]).toEqual({ schema: 'timmy.workspace/1', own: true, project: shown, api: `/api/panel/voxvision/records?project=${encodeURIComponent(shown)}` });
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('the address can name the tab to open (?tab=<id>, or tab=<id> beside the token), and the token still leaves the address', async () => {
    const u = new URL(companion.url);
    const token = /t=([0-9a-f]{64})/.exec(u.hash)?.[1] ?? '';
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const cases: Array<[string, string]> = [
      [`${u.origin}/?tab=voxvision#t=${token}`, 'voxvision'],
      [`${u.origin}/#t=${token}&tab=tools`, 'tools'],
      [`${u.origin}/?tab=nonesuch#t=${token}`, 'home'],
    ];
    for (const [address, want] of cases) {
      const page = await browser.newPage({ viewport: { width: 1376, height: 768 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.goto(address);
        await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
        await page.waitForFunction((w) => document.querySelector('#ws-tabs [aria-selected="true"]')?.getAttribute('data-ws-tab') === w, want, { timeout: 10_000 });
        expect(page.url(), address.replace(token, '<token>')).not.toContain(token);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }
  });

  it('a panel that throws says so in its host, and the page goes on working', async () => {
    const { page, errors } = await open();
    try {
      await page.evaluate(`TimmyPanels.register('tools', { draw() { throw new Error('FAKE failure'); } })`);
      await page.keyboard.press('9');
      await page.waitForFunction(() => /could not be drawn: FAKE failure/.test(document.querySelector('[data-panel-host="tools"]')?.textContent ?? ''), null, { timeout: 10_000 });
      await page.keyboard.press('1');
      await page.waitForFunction(() => !(document.getElementById('ws-home') as HTMLElement).hidden);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });
});
