/**
 * The unified Workspace order (2026-10-27), in a real headless Chromium against the real companion: the display nodes an
 * app's results come in as (companion/timmy-app/src/pages/display-node.jsx), each with the same header, view menu, action
 * menu, inspector and primary action:
 *   - a 3D model (a GLB) in an interactive viewport (WebGL drawn, Fit and Reset from its menu, solid ↔ wireframe kept with
 *     the board);
 *   - an HTML export in an ISOLATED preview: a sandboxed frame of an opaque origin that cannot reach Timmy's page;
 *   - a Rive file on the Rive runtime Timmy serves, with its state machine's inputs;
 *   - a video playing in its own player; an image; a native source as a reference with Reopen;
 *   - the inspector naming the file's bytes and the receipt that sealed them;
 *   - menus: from the keyboard, a press in them never drags the node, readable at 50 % and 200 % zoom (drawn at the page's
 *     size, inside the window), a sheet on a phone.
 * Real: the companion, its routes, the app's bundle, tldraw, three, the Rive runtime, the files and receipts. FAKE, labelled:
 * the "app outputs" are files written by this test, sealed by a receipt this test appends (no app ran).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../scripts/canvas/build-app.mjs';
import { appRoot } from '../src/companion/timmy-app.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { projectId } from '../src/project/index.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { browserPath, launchBrowser } from './helpers/companion-page-kit.js';

const RIV = fileURLToPath(new URL('../src/companion/assets/rive/timmy-ui/timmy-ui.riv', import.meta.url));
const MP4 = fileURLToPath(new URL('./fixtures/probe-3s.mp4', import.meta.url));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const shots = process.env.TIMMY_G_SHOTS;

/** A minimal GLB: one triangle (glTF 2.0, a binary chunk with three positions). */
function glb(): Buffer {
  const pos = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => pos.writeFloatLE(v, i * 4));
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }], bufferViews: [{ buffer: 0, byteLength: 36 }], buffers: [{ byteLength: 36 }] };
  let j = Buffer.from(JSON.stringify(json)); while (j.length % 4) j = Buffer.concat([j, Buffer.from(' ')]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + pos.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(pos.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, j, bh, pos]);
}
// the HTML export tries to reach Timmy's page and its storage; it marks what it could do in its own body
const HTML = '<!doctype html><html><body style="background:#123"><p id="out">FAKE player</p><script>let s=[];try{s.push("parent:"+parent.document.title)}catch(e){s.push("parent:blocked")}try{localStorage.getItem("x");s.push("storage:open")}catch(e){s.push("storage:blocked")}s.push("origin:"+self.origin);document.getElementById("out").textContent=s.join(" ")</script></body></html>';

describe.skipIf(!browserPath)('Workspace display nodes: 3D, isolated HTML, Rive, video, image and native source, each with the same controls', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = ''; let root = ''; let browser: Browser; let companion: CompanionServer; let origin = ''; let token = '';
  const problems: string[] = [];
  const files: Record<string, Buffer> = {};

  beforeAll(async () => {
    if (!existsSync(join(appRoot(), 'dist', 'app.js'))) await buildApp();
    browser = await launchBrowser();
    box = mkdtempSync(join(tmpdir(), 'display-nodes-'));
    root = join(box, 'project');
    const j = (app: string, job: string) => { const d = join(root, 'from-apps', app, job); mkdirSync(d, { recursive: true }); return d; };
    writeFileSync(join(j('model-studio', 'm1'), 'chair.glb'), files['from-apps/model-studio/m1/chair.glb'] = glb());
    writeFileSync(join(j('model-studio', 'm1'), 'chair.blend'), files['from-apps/model-studio/m1/chair.blend'] = Buffer.from('BLENDER-v400 FAKE'));
    writeFileSync(join(j('stream-studio', 's1'), 'player.html'), files['from-apps/stream-studio/s1/player.html'] = Buffer.from(HTML));
    copyFileSync(RIV, join(j('animate', 'a1'), 'ui.riv')); files['from-apps/animate/a1/ui.riv'] = readFileSync(RIV);
    copyFileSync(MP4, join(j('film-room', 'f1'), 'clip.mp4')); files['from-apps/film-room/f1/clip.mp4'] = readFileSync(MP4);
    const seal = (app: string, job: string, paths: string[]) => appendReceipt('runs', {
      kind: 'miniapp', subject: `miniapp · ${app} · export · succeeded (FAKE)`, policy: 'app-initiated', status: 'ok', project: 'project', project_id: projectId(root),
      job: { id: job, kind: 'export', label: 'export', state: 'succeeded' },
      outputs: paths.map((p) => ({ path: p, sha256: sha(files[p]), bytes: files[p].length })),
      miniapp: { app, title: app, revision: null, record_sha256: sha('r'), started_by: 'test', principal: 'operator' },
    }, root);
    seal('model-studio', 'm1', ['from-apps/model-studio/m1/chair.glb', 'from-apps/model-studio/m1/chair.blend']);
    seal('stream-studio', 's1', ['from-apps/stream-studio/s1/player.html']);
    seal('animate', 'a1', ['from-apps/animate/a1/ui.riv']);
    seal('film-room', 'f1', ['from-apps/film-room/f1/clip.mp4']);
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
    expect(problems.filter((p) => !/favicon|WebGL|GPU stall|GroupMarkerNotSet/.test(p))).toEqual([]);
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
  const shot = async (page: Page, name: string): Promise<void> => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
  const importOf = async (page: Page, path: string): Promise<void> => {
    await page.click('[data-tool="Import"]');
    await page.click(`[data-import="${path}"]`);
    await page.waitForSelector(`[data-node-path="${path}"]`, { timeout: 30_000 });
  };
  const node = (path: string) => `[data-node-path="${path}"]`;
  const shapeOf = async (page: Page, path: string) => page.evaluate((p) => { const el = document.querySelector(`[data-node-path="${p}"]`)!.closest('.tl-shape') as HTMLElement; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; }, path);

  it('each kind draws its work with its own controls; menus are keyboard-driven and never drag the node; the inspector names bytes and receipt', async () => {
    const page = await open(1440, 900);
    const GLB = 'from-apps/model-studio/m1/chair.glb';
    await importOf(page, GLB);
    // the 3D model in an interactive viewport (WebGL): drawn, then its View menu → Wireframe (kept with the board)
    await page.waitForSelector(`${node(GLB)} [data-node-3d="ok"] canvas`, { timeout: 30_000 });
    const drawn = await page.evaluate((s) => { const c = document.querySelector(`${s} canvas`) as HTMLCanvasElement; const g = c.getContext('webgl2') || c.getContext('webgl'); return Boolean(g) && c.width > 0; }, node(GLB));
    expect(drawn).toBe(true);
    await page.click(`${node(GLB)} button[data-menu="node-view"]`);
    await page.click('[role="menu"] [data-view="wireframe"]');
    await expect.poll(() => page.locator(`${node(GLB)} button[data-menu="node-view"]`).innerText()).toContain('Wireframe');
    // the actions menu from the keyboard: Enter opens it on its first item (Fit), the arrows move, Escape returns the focus
    await page.focus(`${node(GLB)} button[data-menu="node-actions"]`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-act') === 'fit');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-act'))).toBe('reset');
    await page.keyboard.press('Enter'); // Reset the view: the menu closes, the focus back on its button
    await page.waitForSelector('[role="menu"]', { state: 'detached' });
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-menu'))).toBe('node-actions');
    // a press and a drag inside an open menu never move the node (nor pan the camera)
    const before = await shapeOf(page, GLB);
    await page.click(`${node(GLB)} button[data-menu="node-actions"]`);
    const list = (await page.locator('[role="menu"]').boundingBox())!;
    await page.mouse.move(list.x + 20, list.y + 12); await page.mouse.down(); await page.mouse.move(list.x + 220, list.y + 160, { steps: 6 }); await page.mouse.up();
    expect(await shapeOf(page, GLB)).toEqual(before);
    await page.keyboard.press('Escape');
    // the inspector: the bytes as the receipt names them
    await page.click(`${node(GLB)} [data-node-toggle]`);
    await expect.poll(() => page.locator(`${node(GLB)} [data-node-sha]`).getAttribute('title'), { timeout: 20_000 }).toBe(sha(files[GLB]));
    expect(await page.locator(`${node(GLB)} [data-node-receipt]`).innerText()).toMatch(/[0-9a-f]{8} \(miniapp, these bytes\)/);
    expect(await page.locator(`${node(GLB)} [data-node-primary]`).innerText()).toBe('Open in 3D Model Studio');
    await shot(page, 'nodes-1-3d');

    // the native source beside it: a reference, reopened in its app
    const BLEND = 'from-apps/model-studio/m1/chair.blend';
    await importOf(page, BLEND);
    expect(await page.locator(`${node(BLEND)}[data-node-kind="file"] .ta-node-ref-kind`).innerText()).toBe('Blender scene');

    // the HTML export in an isolated preview: its script runs, but Timmy's page and storage are out of its reach
    const HTML_P = 'from-apps/stream-studio/s1/player.html';
    await importOf(page, HTML_P);
    const frame = page.frameLocator(`${node(HTML_P)} iframe[data-node-preview]`);
    await expect.poll(async () => frame.locator('#out').innerText(), { timeout: 20_000 }).toMatch(/parent:blocked storage:blocked origin:null/);
    expect(await page.locator(`${node(HTML_P)} iframe`).getAttribute('sandbox')).toBe('allow-scripts');
    // its Source view reads the file as text
    await page.click(`${node(HTML_P)} button[data-menu="node-view"]`);
    await page.click('[role="menu"] [data-view="source"]');
    await expect.poll(() => page.locator(`${node(HTML_P)} .ta-node-source`).innerText(), { timeout: 20_000 }).toContain('FAKE player');

    // the Rive file on the Rive runtime, its state machine's inputs listed
    const RIV_P = 'from-apps/animate/a1/ui.riv';
    await importOf(page, RIV_P);
    await page.waitForSelector(`${node(RIV_P)} [data-node-rive="ok"]`, { timeout: 30_000 });
    expect(await page.locator(`${node(RIV_P)} .ta-node-rive-inputs`).innerText()).toMatch(/state machine TimmyUI/);
    expect(await page.locator(`${node(RIV_P)} .ta-node-input`).count()).toBeGreaterThanOrEqual(1);

    // the video in its own player
    const MP4_P = 'from-apps/film-room/f1/clip.mp4';
    await importOf(page, MP4_P);
    await expect.poll(() => page.evaluate((s) => (document.querySelector(`${s} video`) as HTMLVideoElement | null)?.readyState ?? 0, node(MP4_P)), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    expect(await page.locator(`${node(MP4_P)} [data-node-primary]`).innerText()).toBe('Open in Video Breakdown');
    await page.click('[data-tool="Fit workspace"]');
    await page.waitForTimeout(600);
    await shot(page, 'nodes-2-board');

    // zoomed out to 50 % and in to 200 %: the menu is drawn at the page's own size and inside the window
    for (const z of [0.5, 2]) {
      const zoomBtn = z < 1 ? '[data-tool="Zoom out"]' : '[data-tool="Zoom in"]';
      for (let i = 0; i < 3; i++) await page.click(zoomBtn);
      await page.waitForTimeout(300);
      // (the button may be off the stage at this zoom: the keyboard reaches it, and the list is kept inside the window)
      await page.locator(`${node(GLB)} button[data-menu="node-actions"]`).focus();
      await page.keyboard.press('Enter');
      const m = page.locator('[role="menu"]');
      await m.waitFor();
      const b = (await m.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0); expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(1440); expect(b.y + b.height).toBeLessThanOrEqual(900);
      expect(await m.evaluate((el) => getComputedStyle(el).fontSize)).toBe('13px');
      await page.keyboard.press('Escape');
      await m.waitFor({ state: 'detached' });
    }

    // the board keeps each node's view (the 3D model's wireframe) and where it came from
    await expect.poll(async () => {
      const d = await page.evaluate(async (t) => (await fetch('/api/app/desk', { headers: { authorization: `Bearer ${t}` } })).json(), token);
      return Object.values(d.snapshot.store as Record<string, { type?: string; props?: { path?: string; mode?: string } }>).filter((r) => r.type === 'timmy-display').map((r) => `${r.props!.path}:${r.props!.mode}`).sort();
    }, { timeout: 20_000 }).toEqual([`${BLEND}:reference`, `${MP4_P}:player`, `${GLB}:wireframe`, `${HTML_P}:source`, `${RIV_P}:play`].sort());
    await page.context().close();
  }, 240_000);

  it('the preview grant serves only an app’s HTML, under the isolating policy, and ends', async () => {
    const page = await open(1440, 900);
    const r = await page.evaluate(async (t) => {
      const ask = async (p: string) => { const x = await fetch(`/api/files/preview?path=${encodeURIComponent(p)}`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: '{}' }); return { status: x.status, body: await x.json() }; };
      const ok = await ask('from-apps/stream-studio/s1/player.html');
      const served = await fetch(ok.body.url);
      return { ok: ok.status, csp: served.headers.get('content-security-policy'), notHtml: (await ask('from-apps/model-studio/m1/chair.glb')).status, outside: (await ask('player.html')).status, noToken: (await fetch('/api/files/preview?path=x', { method: 'POST' })).status, guess: (await fetch('/files-preview/0000')).status };
    }, token);
    expect(r.ok).toBe(200);
    expect(r.csp).toMatch(/^sandbox allow-scripts;/);
    expect(r.csp).not.toMatch(/allow-same-origin/);
    expect(r.csp).toMatch(/connect-src 'none'/);
    expect(r.notHtml).toBe(415);
    expect([403, 404]).toContain(r.outside);
    expect(r.noToken).toBe(401);
    expect(r.guess).toBe(404);
    await page.context().close();
  }, 120_000);

  it('on a phone a node’s action menu is a sheet, every item reachable', async () => {
    const page = await open(390, 844);
    await page.waitForSelector('.tl-shape[data-shape-type="timmy-display"]', { timeout: 30_000 });
    await page.click('[data-phone="overview"]');
    const btn = page.locator('button[data-menu="node-actions"]').first();
    await btn.focus();
    await page.keyboard.press('Enter');
    const m = page.locator('[role="menu"]');
    await m.waitFor();
    expect(await m.getAttribute('class')).toContain('is-sheet');
    const b = (await m.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(390); expect(b.y + b.height).toBeLessThanOrEqual(844);
    for (const h of await page.locator('[role="menu"] .ta-menu-item').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
    await shot(page, 'nodes-3-phone-sheet');
    await page.keyboard.press('Escape');
    await page.context().close();
  }, 120_000);
});
