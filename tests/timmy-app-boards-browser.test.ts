/**
 * The unified Workspace order (2026-10-27), in a real headless Chromium against the real companion: several saved boards per
 * project. The Boards menu is the shared dropdown (src/menu.jsx): opened and driven from the keyboard (Enter, the arrows,
 * Escape with the focus back on its button), drawn over the page (a portal), a sheet at a phone's width. A new board is blank,
 * says how to begin, is saved in the project (app-boards/<id>/), and opens again as left in a fresh browser; the desk keeps
 * its own work; a rename keeps the board's id and work.
 *
 * Real: the companion, its routes, the app's bundle, tldraw, the files. No model is used.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../scripts/canvas/build-app.mjs';
import { BOARDS_FOLDER, DESK_FOLDER, appRoot } from '../src/companion/timmy-app.js';
import { projectId } from '../src/project/index.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { browserPath, launchBrowser } from './helpers/companion-page-kit.js';

const shots = process.env.TIMMY_G_SHOTS;

describe.skipIf(!browserPath)('Workspace boards: several saved boards per project, through the shared dropdown', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = ''; let root = ''; let browser: Browser; let companion: CompanionServer; let origin = ''; let token = '';
  const problems: string[] = [];

  beforeAll(async () => {
    if (!existsSync(join(appRoot(), 'dist', 'app.js'))) await buildApp();
    browser = await launchBrowser();
    box = mkdtempSync(join(tmpdir(), 'boards-browser-'));
    root = join(box, 'project');
    mkdirSync(root, { recursive: true });
    const env = { TIMMY_HOME: process.env.TIMMY_HOME!, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR };
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env } });
    origin = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  }, 600_000);
  afterAll(async () => {
    await companion?.shutdown();
    await browser?.close();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
    expect(problems.filter((p) => !/favicon/.test(p))).toEqual([]);
  });

  const open = async (width: number, height: number): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
    await page.goto(`${origin}/app#t=${token}`);
    await page.waitForSelector('.ta-rail', { state: 'attached', timeout: 60_000 });
    if (await page.locator('.ta-menu').isVisible()) { await page.click('.ta-menu'); await page.waitForSelector('.ta-rail.is-open'); }
    await page.click('.ta-rail-item[data-nav="canvas"]');
    await page.waitForSelector('.ta-stage .tl-container', { timeout: 60_000 });
    return page;
  };
  const shapes = async (page: Page): Promise<number> => page.evaluate(() => Number(/(\d+) shape/.exec(document.querySelector('.ta-toolsrow-note')?.textContent ?? '')?.[1] ?? -1));
  const shot = async (page: Page, name: string): Promise<void> => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
  const shapesIn = (file: string): number => { try { return Object.values((JSON.parse(readFileSync(file, 'utf8')) as { snapshot: { store: Record<string, { typeName?: string }> } }).snapshot.store).filter((r) => r.typeName === 'shape').length; } catch { return -1; } };
  const boardsDir = (): string => join(process.env.TIMMY_HOME!, 'canvas', 'projects', projectId(root), BOARDS_FOLDER);

  it('a new board from the keyboard: blank, saved in the project, the desk left as it was; opened again in a fresh browser', async () => {
    const page = await open(1440, 900);
    await page.waitForFunction(() => Number(/(\d+) shape/.exec(document.querySelector('.ta-toolsrow-note')?.textContent ?? '')?.[1] ?? 0) >= 4, null, { timeout: 30_000 });
    const desk = await shapes(page);
    const menu = page.locator('button[data-menu="boards"]');
    expect(await menu.innerText()).toContain('Desk');
    // keyboard: Enter opens the list on its first item (the desk, checked); the arrows move; Escape closes it, focus back
    await menu.focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role="menu"][data-menu-for="boards"]');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-board-item') === 'desk', null, { timeout: 5_000 }).catch(async () => { throw new Error(`focus: ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 300))}`); });
    expect(await page.locator('[data-board-item="desk"]').getAttribute('aria-checked')).toBe('true');
    // the list is drawn over the page, not inside the canvas (a portal on the body)
    expect(await page.evaluate(() => document.querySelector('[role="menu"][data-menu-for="boards"]')?.parentElement === document.body)).toBe(true);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role="menu"][data-menu-for="boards"]', { state: 'detached' });
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-menu'))).toBe('boards');
    // New board…: Enter, ArrowDown to it, Enter; type its name, Enter
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-board-item') === 'desk');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-action'))).toBe('board-new');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-board-name]');
    await page.keyboard.type('Storyboard');
    await shot(page, 'boards-1-new');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('button[data-menu="boards"]')?.getAttribute('data-board') === 'storyboard', null, { timeout: 20_000 });
    await page.waitForSelector('[data-board-empty]', { timeout: 20_000 });
    expect(await shapes(page)).toBe(0);
    // blank also behind the shapes: the desk's sections are the first board's own (found on the Mac at 0038c38)
    expect(await page.locator('.ta-desk-section').count()).toBe(0);
    await shot(page, 'boards-2-blank');
    // a node on the new board: saved in ITS folder, the desk untouched
    await page.click('.ta-tool[data-tool="Nodes"]');
    await page.click('.ta-popover-item[data-node="card:conversation"]');
    await page.waitForFunction(() => Number(/(\d+) shape/.exec(document.querySelector('.ta-toolsrow-note')?.textContent ?? '')?.[1] ?? -1) === 1);
    await expect.poll(() => shapesIn(join(boardsDir(), 'storyboard', 'canvas.json')), { timeout: 20_000 }).toBe(1);
    expect(existsSync(join(process.env.TIMMY_HOME!, 'canvas', 'projects', projectId(root), DESK_FOLDER))).toBe(true);
    // back to the desk with the mouse: its work as it was
    await menu.click();
    await page.click('[data-board-item="desk"]');
    await page.waitForFunction((n) => Number(/(\d+) shape/.exec(document.querySelector('.ta-toolsrow-note')?.textContent ?? '')?.[1] ?? -1) === n, desk, { timeout: 20_000 });
    // rename the desk: its id and work stay
    await menu.click();
    await page.click('[data-action="board-rename"]');
    await page.fill('[data-board-name]', 'Main desk');
    await page.click('[data-action="board-rename-save"]');
    await page.waitForFunction(() => (document.querySelector('button[data-menu="boards"]')?.textContent ?? '').includes('Main desk'));
    expect(await shapes(page)).toBe(desk);
    await page.context().close();

    // a fresh browser (nothing of the first one's storage): the desk opens; the Storyboard opens as it was left
    const again = await open(1440, 900);
    await again.waitForFunction((n) => Number(/(\d+) shape/.exec(document.querySelector('.ta-toolsrow-note')?.textContent ?? '')?.[1] ?? -1) === n, desk, { timeout: 30_000 });
    expect(await again.locator('button[data-menu="boards"]').innerText()).toContain('Main desk');
    await again.click('button[data-menu="boards"]');
    expect(await again.locator('[data-board-item]').allInnerTexts()).toEqual([expect.stringContaining('Main desk'), expect.stringContaining('Storyboard')]);
    await again.click('[data-board-item="storyboard"]');
    await again.waitForFunction(() => Number(/(\d+) shape/.exec(document.querySelector('.ta-toolsrow-note')?.textContent ?? '')?.[1] ?? -1) === 1, null, { timeout: 20_000 });
    await again.context().close();
  }, 180_000);

  it('on a phone the Boards list is a sheet at the foot of the screen, each item at least 44 px tall', async () => {
    const page = await open(390, 844);
    const menu = page.locator('button[data-menu="boards"]');
    if (!(await menu.isVisible())) await page.click('[data-phone="tools"]');
    await menu.click();
    const list = page.locator('[role="menu"][data-menu-for="boards"]');
    await list.waitFor();
    expect(await list.getAttribute('class')).toContain('is-sheet');
    const box = (await list.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    for (const h of await page.locator('[role="menu"] .ta-menu-item').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
    await shot(page, 'boards-3-phone-sheet');
    await page.keyboard.press('Escape');
    await list.waitFor({ state: 'detached' });
    await page.context().close();
  }, 120_000);
});
