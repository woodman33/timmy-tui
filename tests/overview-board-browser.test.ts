/**
 * Round R4 (helper H78): God's Eye View on the board, the Overview section, in a real headless Chromium (skipped when none is
 * found, as the other *-browser tests are), and the live board's GET /overview. The records are made by the real writers in
 * an os.tmpdir() project on its own REAL receipts chain (tests/helpers/ops-sandbox.ts): `/measure` of a generated cube (Timmy's
 * own STL reader, real), `/iterate scad` (a flow, its agent run, an OpenSCAD run), a workflow with a hostile title.
 *
 * FAKE pieces: the code agent (tests/fixtures/fake-code-agent.mjs) and OpenSCAD (tests/fixtures/fake-openscad.mjs) are TEST
 * DOUBLES (no model, no geometry engine); nothing leaves 127.0.0.1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { request } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MAP_LABEL, OVERVIEW_SCHEMA, type Overview } from '../src/overview/index.js';
import { opsKit, replOf, sandbox, text, type Sandbox } from './helpers/ops-sandbox.js';
import { cubeStl } from './helpers/vox-fakes.js';
import type { Workspace } from '../src/repl/workspace.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && fs.existsSync(p!));
if (!browserPath) console.warn('overview-board-browser: no Chromium or Chrome found, so the real-browser check is skipped here');

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);
const F = '```';
const HOSTILE = '<img src=x onerror=alert(1)> "Work" & co';

/** One HTTP request to the live board on 127.0.0.1 (Node, not the page): status and text. */
function raw(port: number, o: { method?: string; path: string; headers?: Record<string, string> }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers: o.headers ?? {} }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (c: string) => { body += c; }).on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A project with a VoxVision record of a cube, a flow (FAKE agent and OpenSCAD) and a workflow with a hostile title. */
async function project(): Promise<{ s: Sandbox; ws: Workspace; flow: string }> {
  const s = sandbox(kit, 'overview-board-');
  const { ws } = replOf(kit, s);
  fs.mkdirSync(path.join(s.root, 'models'), { recursive: true });
  fs.writeFileSync(path.join(s.root, 'models', 'cube.stl'), cubeStl(10));
  await ws.operate('/measure models/cube.stl', 'repl', () => ws.measure('models/cube.stl'));
  await (ws as unknown as { vox: { settle(ms: number): Promise<void> } }).vox.settle(30_000);
  const instruction = 'make it 100 wide PYFILE:box.params.json PYREPLACE:60,=>100,';
  const out = text(await ws.operate(`/iterate scad box.scad "${instruction}"`, 'repl', () => ws.iterate(`scad box.scad "${instruction}"`)));
  const flow = /\b(f[0-9a-f]{8})\b/.exec(out)?.[1] ?? '';
  expect(flow, out).toMatch(/^f[0-9a-f]{8}$/);
  await ws.ops.done(ws.ops.latest!);
  fs.writeFileSync(path.join(s.root, 'WORK.md'), [`# ${HOSTILE}`, '', `${F}bash [name:build]`, 'echo build', F, ''].join('\n'));
  return { s, ws, flow };
}

describe('the Overview section on the snapshot board', () => {
  it('comes first, escaped, with its map labelled a layout and its geometry thumbnail linked to its record', async () => {
    const { s, ws } = await project();
    expect(text(ws.board(''))).toContain('.timmy/board/index.html');
    const html = fs.readFileSync(path.join(s.root, '.timmy', 'board', 'index.html'), 'utf8');
    const main = html.slice(html.indexOf('<main>'));
    expect(main.indexOf('<h2 id="overview">')).toBeGreaterThan(0);
    expect(main.indexOf('<h2 id="overview">')).toBeLessThan(main.indexOf('<h2 id="room">'));
    expect(html).toContain(`<figcaption><strong>${MAP_LABEL}</strong>`);
    expect(html).toMatch(/<svg class="ov-map-svg"[^>]* role="img" aria-label="layout, not geometry: /);
    // The thumbnail comes from the VoxVision record, linked relatively, and says so.
    expect(html).toMatch(/<img src="\.\.\/\.\.\/results\/vox\/v[0-9a-f]{8}\/bbox\.svg" alt="bbox-svg: geometry from results\/vox\/v[0-9a-f]{8}\.json"/);
    expect(html).toMatch(/<figcaption><strong>geometry from results\/vox\/v[0-9a-f]{8}\.json<\/strong>/);
    // The hostile title is text, never markup; no style attribute in the section (the live page allows none).
    const section = html.slice(html.indexOf('<h2 id="overview">'), html.indexOf('<h2 id="room">'));
    expect(section).not.toContain('<img src=x');
    expect(section).toContain('&lt;img src=x onerror=alert(1)&gt; &quot;Work&quot; &amp; co');
    expect(section).not.toMatch(/ style="/);
    expect(section).toContain('<a class="ov-go" href="#room">Control Room</a>');
    expect(section).toContain('<a class="ov-go" href="#voxvision">VoxVision</a>');
    // Every link within the page goes to a section the page has: the line about Timmy Canvas is drawn only when the REPL
    // checked the canvas (not here), so nothing links to it.
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const targets = [...section.matchAll(/<a [^>]*href="#([^"]+)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(3);
    expect(targets.filter((t) => !ids.has(t))).toEqual([]);
    expect(html).not.toContain('id="canvas"');
  }, 180_000);
});

describe.skipIf(!browserPath)('the Overview section on the live board (headless Chromium, a fresh context)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath }); });
  afterAll(async () => { await browser?.close(); });

  it('is drawn first, links to the Control Room, labels its map "layout, not geometry", loads its geometry thumbnail as a blob; GET /overview needs the token', async () => {
    const { s, ws, flow } = await project();
    expect(text(await ws.boardLive('live'))).toContain('Live board');
    const lb = ws.liveBoard!;
    const token = lb.url.split('#t=')[1];
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    page.on('dialog', (d) => { problems.push(`a dialog: ${d.message()}`); void d.dismiss(); });
    await page.goto(lb.url);
    await page.waitForSelector('#overview');
    // First: the Overview's heading is the first heading of the board's sections, and its link is first in the contents.
    expect(await page.evaluate(() => document.querySelector('#main h2')?.id)).toBe('overview');
    expect(await page.evaluate(() => document.querySelector('#toc a')?.getAttribute('href'))).toBe('#overview');
    // What needs you comes first among its cards.
    expect(await page.$$eval('.ov-grid > article', (els) => els.map((e) => e.getAttribute('data-ov')))).toEqual(['needs', 'agents', 'workflows', 'apps', 'spatial', 'history', 'project']);
    // The map: an SVG, labelled as a layout, with the flow and its agent as nodes.
    expect(await page.textContent('.ov-map figcaption strong')).toBe(MAP_LABEL);
    expect(await page.getAttribute('.ov-map svg', 'aria-label')).toMatch(/^layout, not geometry: /);
    expect(await page.$$eval('.ov-map svg .ov-node title', (els) => els.map((e) => e.textContent ?? ''))).toEqual(expect.arrayContaining([expect.stringContaining(flow)]));
    expect(await page.$$eval('.ov-map svg line.ov-edge', (els) => els.length)).toBeGreaterThan(0);
    // The geometry thumbnail: a VoxVision highlight loaded through the token-protected /file as a blob: URL, labelled with its record.
    await page.waitForFunction(() => /^blob:/.test(document.querySelector('.ov-thumb img')?.getAttribute('src') ?? ''), undefined, { timeout: 15_000 });
    expect(await page.textContent('.ov-thumb figcaption strong')).toMatch(/^geometry from results\/vox\/v[0-9a-f]{8}\.json$/);
    // The hostile workflow title is text.
    expect(await page.$$eval('#overview ~ section.overview img[src="x"], .overview script', (els) => els.length)).toBe(0);
    // A link to the Control Room: it goes to the section that shows the run.
    const go = page.locator('.ov-agents a.ov-go[href="#room"]').first();
    expect(await go.textContent()).toBe('Control Room');
    await go.click();
    await page.waitForFunction(() => location.hash === '#room');
    expect(await page.evaluate(() => !!document.getElementById('room'))).toBe(true);
    // No link of the Overview leads to a section this page does not have.
    expect(await page.$$eval('section.overview a[href^="#"]', (els) => els.map((e) => (e.getAttribute('href') ?? '').slice(1)).filter((id) => !document.getElementById(id)))).toEqual([]);
    // A command copies itself (green), as every board command does.
    expect(await page.$$eval('.overview button.cmd', (els) => els.map((e) => e.getAttribute('data-cmd')))).toEqual(expect.arrayContaining([`/room ${flow}`]));
    // The live page is not redrawn on every poll for the overview's own times: two states a second apart have one shape.
    const auth = { Authorization: `Bearer ${token}` };
    const one = JSON.parse((await raw(lb.port, { path: '/state', headers: auth })).body) as { shape: string; html: string };
    await new Promise((r) => setTimeout(r, 1100));
    const two = JSON.parse((await raw(lb.port, { path: '/state', headers: auth })).body) as { shape: string };
    expect(two.shape).toBe(one.shape);
    // On the live page the Overview's links stay within the page and its thumbnail names its file only as data (the page
    // fetches it with the token): no link to a file, no image the browser would load by itself.
    const live = one.html.slice(one.html.indexOf('<h2 id="overview">'), one.html.indexOf('<h2 id="room">'));
    expect(live).toContain('<a class="ov-go" href="#room">Control Room</a>');
    expect(live).not.toMatch(/<a [^>]*href="(?!#)/);
    expect(live).toMatch(/<img data-vox-src="results\/vox\/v[0-9a-f]{8}\/bbox\.svg"/);
    expect(live).not.toMatch(/<img [^>]*\ssrc=/);
    // GET /overview: the model, with the token only, GET only.
    const got = await raw(lb.port, { path: '/overview', headers: auth });
    expect(got.status).toBe(200);
    const model = JSON.parse(got.body) as Overview;
    expect(model.schema).toBe(OVERVIEW_SCHEMA);
    expect(model.agents.items.some((a) => a.id === flow)).toBe(true);
    expect(got.body).not.toContain(s.root);
    expect((await raw(lb.port, { path: '/overview' })).status).toBe(401);
    expect((await raw(lb.port, { path: '/overview', headers: { Authorization: `Bearer ${'0'.repeat(64)}` } })).status).toBe(401);
    expect((await raw(lb.port, { method: 'POST', path: '/overview', headers: auth })).status).toBe(405);
    expect(problems).toEqual([]);
    await context.close();
  }, 180_000);
});
