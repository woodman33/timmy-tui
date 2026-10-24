/**
 * R9 (H160): the Workbench's c on a tab 6 mesh opens the companion's tab 6 with that mesh chosen. Its address carries
 * `tab=create&mesh=<the mesh's path as the hex of its UTF-8 bytes>` (src/workbench/create-tab.ts createCompanionHint, through
 * src/workbench/servers.ts withQuery, the key after #), and the page's tab 6 (src/companion/client/panel-create.js) chooses
 * the mesh it names on its first list: its row marked current, its view and its measurements. Negative controls: an address
 * with no mesh, or one naming no mesh of the project, chooses as before (the first measured, by path).
 *
 * In a real headless Chromium over the real companion server, on a project in a temporary folder holding the demo tray
 * (examples/visual-tools, as scripts/demo-mesh.mjs wrote it) in its three kinds. Nothing leaves 127.0.0.1.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { createCompanionHint } from '../src/workbench/create-tab.js';
import { withQuery } from '../src/workbench/servers.js';
import { DEMO_MESH, DEMO_OBJ, DEMO_PLY } from '../scripts/demo-mesh.mjs';
import { landWorkspace } from './helpers/companion-page-kit.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-create-mesh-hint-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

/** A mesh item as tab 6's list holds one, for its hint (only its kind and path are read). */
const meshAt = (path: string) => ({ kind: 'mesh', mesh: { path } });

describe.skipIf(!browserPath)('the companion\'s tab 6 chooses the mesh the Workbench\'s c names (R9 H160)', () => {
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let browser: Browser;
  let companion: CompanionServer;

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'r9-mesh-hint-'));
    const root = join(box, 'home', 'projects', 'FAKE-tray');
    mkdirSync(join(root, 'refs'), { recursive: true });
    for (const f of [DEMO_MESH, DEMO_OBJ, DEMO_PLY]) copyFileSync(resolve(f), join(root, 'refs', f.split('/').pop()!));
    process.env.TIMMY_HOME = join(box, 'home');
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { workspace: { env: { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: join(box, 'settings') }, shareMs: 0 } });
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await companion?.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  /** The page at an address with this query, on its tab 6 once its meshes are listed: the rows and which one is current. */
  async function chosen(query: string): Promise<{ page: Page; rows: Array<[string, string]>; title: string; errors: string[] }> {
    const page = await browser.newPage({ viewport: { width: 1376, height: 768 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(withQuery(companion.url, query));
    await landWorkspace(page);
    await page.waitForSelector('[data-panel-host="create"] .create-mesh', { timeout: 30_000 });
    await page.waitForFunction(() => /The view you can turn · /.test(document.querySelector('[data-create="view-title"]')?.textContent ?? ''), null, { timeout: 15_000 });
    const rows = await page.$$eval('.create-mesh', (bs) => bs.map((b) => [(b as HTMLElement).dataset.createMesh ?? '', b.getAttribute('aria-current') ?? ''] as [string, string]));
    const title = await page.$eval('[data-create="view-title"]', (e) => (e.textContent ?? '').trim());
    return { page, rows, title, errors };
  }

  it('an address naming refs/demo-tray.ply opens tab 6 with it chosen: its row current, its view and its measurements', async () => {
    const q = createCompanionHint(meshAt('refs/demo-tray.ply'));
    expect(q).toBe(`tab=create&mesh=${Buffer.from('refs/demo-tray.ply').toString('hex')}`);
    const { page, rows, title, errors } = await chosen(q);
    try {
      expect(rows).toEqual([['refs/demo-tray.obj', 'false'], ['refs/demo-tray.ply', 'true'], ['refs/demo-tray.stl', 'false']]);
      expect(title).toBe('The view you can turn · refs/demo-tray.ply');
      expect(await page.$eval('[data-create="measure-title"]', (e) => (e.textContent ?? '').trim())).toBe('Measured from the file · refs/demo-tray.ply');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it('negative controls: no mesh in the address, or one naming no mesh of the project, chooses the first measured, as before', async () => {
    for (const q of ['tab=create', createCompanionHint(meshAt('refs/not-here.stl'))]) {
      const { page, rows, title, errors } = await chosen(q);
      try {
        expect(rows, q).toEqual([['refs/demo-tray.obj', 'true'], ['refs/demo-tray.ply', 'false'], ['refs/demo-tray.stl', 'false']]);
        expect(title, q).toBe('The view you can turn · refs/demo-tray.obj');
        expect(errors, q).toEqual([]);
      } finally { await page.close(); }
    }
  }, 60_000);
});
