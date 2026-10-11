// R4 (H97): the pages TIMMY Studios' dashboard server serves (src/utils/dash-server.ts), in a real headless Chromium against
// the real server on 127.0.0.1, with real files in a temporary folder (a SYNTHETIC .env and .timmy/ beside the pages):
//   - the dashboard (`/panes`) draws its ledger, its frames and its events from the server's two records, and says unknown
//     for a cost that is not known;
//   - a Slate project's site (`/publish`) loads with its reference image;
//   - the legacy Slate panel's canvas page (renderCanvasPage, src/utils/projects.ts) loads nothing from a CDN and says that
//     the canvas lives in Timmy Canvas now (`/canvas open`); before, it asked unpkg and esm.sh for tldraw and React, then
//     failed on an import of a file that was never there;
//   - none of them asks anything of anywhere but the server (every request of every frame is recorded; one elsewhere is
//     aborted before it leaves, and the browser resolves no name but 127.0.0.1), and a page asking for .env is refused.
// Skipped, saying so, where no Chromium or Chrome is found.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeDashboard } from '../src/utils/dash.js';
import { startDashServer, type DashServer } from '../src/utils/dash-server.js';
import { addCastToProject, addRefToProject, initProject, readProject, renderCanvasPage, renderProjectSite, saveProject } from '../src/utils/projects.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('dash-pages-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SECRET = `SYNTHETIC_SECRET_${Date.now().toString(36)}`;

describe.skipIf(!browserPath)('the dashboard server\'s pages in a real browser (R4 H97)', () => {
  let root = '';
  let browser: Browser;
  let dash: DashServer;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'h97-dash-pages-')));
    writeFileSync(join(root, '.env'), `OPENROUTER_API_KEY=${SECRET}\n`);
    mkdirSync(join(root, '.timmy', 'runs'), { recursive: true });
    const frames = join(root, 'studio', 'frames', 'clip');
    mkdirSync(frames, { recursive: true });
    for (const n of [1, 2]) writeFileSync(join(frames, `frame_000${n}.png`), PNG);
    writeFileSync(join(root, '.timmy', 'generations.json'), JSON.stringify({ schema: 1, generations: [
      { id: 'gen_lighthouse', prompt: 'a lighthouse at dusk', prompt_hash: 'h', provider: 'seedance-2-0', model: 'bytedance/seedance-2.0', kind: 'video', transport: 'openrouter', status: 'done', cost_usd: 0.22, framesDir: frames, frameCount: 2, stamp: 's', created_at: '2026-10-11T10:00:00.000Z' },
      { id: 'gen_placeholder', prompt: 'a placeholder cost', prompt_hash: 'h', provider: 'higgsfield', kind: 'image', transport: 'higgsfield', status: 'done', cost_usd: 0, cost_measured: false, stamp: 's', created_at: '2026-10-11T10:01:00.000Z' },
    ] }));
    writeFileSync(join(root, '.timmy', 'runs', 'events.jsonl'), `${JSON.stringify({ ts: '2026-10-11T10:00:00.000Z', genId: 'gen_lighthouse', event: 'recorded' })}\n`);
    writeDashboard(root);
    initProject('film', {}, root);
    const ref = join(root, 'hero.png');
    writeFileSync(ref, PNG);
    addRefToProject('film', ref, 'hero', root);
    const proj = readProject('film', root)!;
    proj.beats = [{ at: 0, dur: 3, label: 'OPEN', text: 'The <b>lighthouse</b> wakes' }, { at: 3, dur: 2, label: 'TURN', text: 'A ship answers' }];
    saveProject(proj, root);
    addCastToProject('film', { id: 'c1', name: 'Keeper', wardrobe: 'yellow coat', emotion: 'wary' }, root);
    renderProjectSite('film', root);
    renderCanvasPage('film', root);
    dash = await startDashServer({ root, port: 0 });
    // the browser resolves no name but 127.0.0.1: nothing a page asks for can leave this computer
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await dash?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A page of the server in a fresh context; every request recorded, one to any other origin aborted before it leaves. */
  async function open(path: string): Promise<{ page: Page; requests: string[]; outside: string[]; errors: string[]; close: () => Promise<void> }> {
    const context = await browser.newContext();
    const requests: string[] = [];
    const outside: string[] = [];
    const errors: string[] = [];
    context.on('request', (r) => requests.push(r.url()));
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === dash.base) return route.continue();
      outside.push(url.href);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${dash.base}${path}`);
    return { page, requests, outside, errors, close: () => context.close() };
  }

  it('the dashboard draws its ledger, frames and events from the server\'s records; an unknown cost says unknown; nothing from elsewhere', async () => {
    const { page, requests, outside, errors, close } = await open('/studio/dashboard.html');
    try {
      await page.waitForFunction(() => document.querySelectorAll('#gens tr').length === 3, null, { timeout: 15_000 });
      const rows = await page.$$eval('#gens tr', (trs) => trs.slice(1).map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent ?? '')));
      expect(rows.map((r) => [r[0], r[5]])).toEqual([['gen_placeholder', 'unknown'], ['gen_lighthouse', '$0.220']]);
      await page.waitForFunction(() => [...document.querySelectorAll('#frames img')].length === 2 && [...document.querySelectorAll('#frames img')].every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0), null, { timeout: 15_000 });
      await page.waitForFunction(() => (document.getElementById('events')?.textContent ?? '').includes('"recorded"'), null, { timeout: 15_000 });
      expect(errors).toEqual([]);
      // a page of this server asking for .env, or for .timmy/, is refused, and never gets its bytes (the browser logs each 403)
      const asked = await page.evaluate(async () => Promise.all(['/.env', '/.timmy/generations.json'].map(async (p) => { const r = await fetch(p); return [r.status, await r.text()] as const; })));
      for (const [status, text] of asked) { expect(status).toBe(403); expect(text).not.toContain('SYNTHETIC_SECRET'); expect(text).not.toContain('gen_lighthouse'); }
      expect(outside).toEqual([]);
      for (const r of requests) expect(new URL(r).origin, r).toBe(dash.base);
      expect(requests.map((r) => new URL(r).pathname)).toEqual(expect.arrayContaining(['/studio/dashboard.html', '/data/generations.json', '/data/events.jsonl', '/studio/frames/clip/frame_0001.png', '/studio/frames/clip/frame_0002.png']));
      expect(await page.content()).not.toContain(root);
      expect(errors.filter((e) => !/status of 403/.test(e))).toEqual([]);
    } finally { await close(); }
  }, 60_000);

  it('a Slate project\'s site loads with its reference image, from the server only', async () => {
    const { page, requests, outside, errors, close } = await open('/studio/film/site/index.html');
    try {
      await page.waitForFunction(() => { const i = document.querySelector('.refs img') as HTMLImageElement | null; return Boolean(i && i.complete && i.naturalWidth > 0); }, null, { timeout: 15_000 });
      expect(outside).toEqual([]);
      for (const r of requests) expect(new URL(r).origin, r).toBe(dash.base);
      expect(errors).toEqual([]);
    } finally { await close(); }
  }, 60_000);

  it('the legacy Slate canvas page loads nothing from a CDN, and says the canvas lives in Timmy Canvas (/canvas open)', async () => {
    const { page, requests, outside, errors, close } = await open('/studio/film/site/canvas.html');
    try {
      await page.waitForLoadState('load');
      await page.waitForTimeout(500);
      expect(outside).toEqual([]);
      expect(requests.map((r) => new URL(r).pathname)).toEqual(['/studio/film/site/canvas.html']);
      const text = (await page.textContent('body')) ?? '';
      expect(text).toContain('The canvas lives in Timmy Canvas now: in Timmy\'s REPL, type /canvas open.');
      // the project's beats and cast, as text (its markup escaped: no element made from them)
      expect(text).toContain('The <b>lighthouse</b> wakes');
      expect(await page.$$eval('.beats b', (bs) => bs.map((b) => b.textContent))).toEqual(['0s–3s [OPEN]', '3s–5s [TURN]']);
      expect(text).toContain('C1 Keeper');
      expect(await page.$$('script')).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally { await close(); }
  }, 60_000);
});
