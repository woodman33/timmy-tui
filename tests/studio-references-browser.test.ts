/**
 * R6 (H145): reference images on a project's board, from the project's own files only, in a real headless Chromium against the
 * real canvas server and the real bundle (built here into a temporary folder), with a real temporary Timmy home and two FAKE
 * disposable projects, tray and blank (folders made here, with FAKE images drawn here). What is checked, by reading what is on
 * screen and on disk: an image added to tray's board is copied into tray's board folder (refs/<sha256>.png, the same bytes) and
 * nothing is written into tray's own folder; its asset's meta says { path, sha256, bytes, from, project }; it is shown, with a
 * caption naming its file and where it came from, from that copy (read with the page's session, never a credential in an
 * address), and again after a save and a reopen; it never appears on blank's board, and blank's board files are byte-identical
 * before and after (hashed); a file outside the project, a link out of it and an SVG are refused, in words; a draft that adds one
 * (a FAKE scripted canvas_exec, no model) marks its asset and shapes, and Discard removes them.
 *
 * Skipped, saying so, where no Chromium or Chrome is found. Captures (PNG) only when TIMMY_R6_CAPTURES names a folder, each
 * with a band that says it is FAKE and scripted.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvasTools } from '../src/agent/canvas-tools.js';
import { projectId } from '../src/project/index.js';
import { activeProjectFile } from '../src/studio/active-follow.js';
import { boardDir } from '../src/studio/boards.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { bearer, call, grant, nameProject, pageSession } from './helpers/canvas-auth.js';
import { png } from './helpers/vox-fakes.js';
import { bytesWords } from '../companion/studio-canvas/src/references.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-references-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const HOLDER = 'f'.repeat(32);
const CAPTURES = process.env.TIMMY_R6_CAPTURES?.trim() || '';
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
type Project = { name: string; root: string; id: string };
type Rec = { id: string; type: string; typeName: string; parentId?: string; props: Record<string, unknown>; meta: Record<string, unknown> };
type Who = { id: string; name: string } | null;
type Win = { timmyCanvas: { editor: { getCurrentPageShapes: () => Rec[]; getAssets: () => Rec[]; store: { allRecords: () => Rec[] } }; project: Who; identity: { project: Who; state: string }; placeReference: (path: string) => Promise<Record<string, unknown>>; drafts: () => Array<{ id: string; shapes: string[]; assets: string[] }> } };

describe.skipIf(!browserPath)('Studio reference images: from the project\'s own files, copied into its board, shown on its board only (real browser)', () => {
  let pageRoot = '';
  let home = '';
  let base = '';
  let port = 0;
  let server: StudioServer;
  let browser: Browser;
  const dirs: string[] = [];
  let tray: Project;
  let blank: Project;
  let outside = '';
  let opened = 0;
  let replOn: Project;
  /** FAKE images, drawn here: tray's photo (red and blue halves), a second one (amber square), blank's own (green). */
  const PHOTO = png(160, 80, (x) => (x < 80 ? [200, 10, 10] : [10, 10, 200]));
  const SECOND = png(64, 64, (x, y) => (x > 16 && x < 48 && y > 16 && y < 48 ? [255, 176, 0] : [20, 20, 20]));
  const BLANKS = png(80, 80, () => [10, 160, 10]);

  const project = (name: string): Project => {
    const root = join(mkdtempSync(join(tmpdir(), `timmy-ref-${name}-`)), name);
    dirs.push(join(root, '..'));
    mkdirSync(join(root, 'refs'), { recursive: true });
    writeFileSync(join(root, 'BUILD.md'), `# ${name} build\n`);
    return { name, root, id: projectId(root) };
  };

  beforeAll(async () => {
    tray = project('tray');
    blank = project('blank');
    writeFileSync(join(tray.root, 'refs', 'photo.png'), PHOTO);
    writeFileSync(join(tray.root, 'refs', 'second.png'), SECOND);
    // FAKE: an SVG that would run script, and a link to an image outside the project
    writeFileSync(join(tray.root, 'refs', 'notes.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    outside = join(mkdtempSync(join(tmpdir(), 'timmy-ref-outside-')), 'outside.png');
    dirs.push(join(outside, '..'));
    writeFileSync(outside, png(8, 8, () => [255, 255, 255]));
    symlinkSync(outside, join(tray.root, 'refs', 'link.png'));
    writeFileSync(join(blank.root, 'refs', 'green.png'), BLANKS);
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-ref-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-ref-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot, projectTokenFile: true, followEveryMs: 100, followGraceMs: 200 });
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    await named(tray);
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 240_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of [...dirs, pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  const named = async (p: Project) => { replOn = p; return nameProject(port, server.projectToken, { root: p.root, name: p.name, holder: HOLDER }); };
  function workbench(p: Project): void {
    const file = activeProjectFile({ TIMMY_HOME: home });
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ name: p.name, root: p.root, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  /** Every file under `dir`, with its sha256 (links named, never followed). */
  function tree(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
      let names: string[] = [];
      try { names = readdirSync(d); } catch { return; }
      for (const n of names.sort()) {
        const f = join(d, n);
        const st = statSync(f, { throwIfNoEntry: false });
        if (!st) { out[relative(dir, f)] = 'gone'; continue; }
        if (st.isDirectory()) walk(f); else out[relative(dir, f)] = sha(readFileSync(f));
      }
    };
    walk(dir);
    return out;
  }
  const board = (p: Project): string => boardDir(join(home, 'canvas'), p.id);
  const boardText = (p: Project): string => { try { return readFileSync(join(board(p), 'canvas.json'), 'utf8'); } catch { return ''; } };

  interface Studio { page: Page; context: BrowserContext; errors: string[] }
  async function open(): Promise<Studio> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === base || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 409 \(Conflict\)/.test(m.text())) errors.push(m.text()); });
    opened += 1;
    await page.goto(`${base}/#code=${await grant(port, server.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    return { page, context, errors };
  }
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
  async function shows(page: Page, p: Project): Promise<void> {
    await page.waitForFunction((id) => { const t = (window as never as Win).timmyCanvas; return t?.identity.state === 'shown' && t.identity.project?.id === id && t.project?.id === id; }, p.id, { timeout: 20_000 });
  }
  const savedState = (page: Page) => page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: 15_000 });
  async function capture(page: Page, name: string): Promise<void> {
    if (!CAPTURES) return;
    mkdirSync(CAPTURES, { recursive: true });
    await page.evaluate(() => {
      if (document.getElementById('fake-band')) return;
      const b = document.createElement('div');
      b.id = 'fake-band';
      b.textContent = 'SCRIPTED TEST · headless Chromium · FAKE images drawn by the test · FAKE draft: a scripted canvas_exec call, no model · disposable projects tray and blank';
      Object.assign(b.style, { position: 'fixed', right: '8px', bottom: '8px', zIndex: '400', padding: '4px 8px', background: '#070707', color: '#F2EFE9', border: '1px solid #444444', font: '12px/1.4 monospace', pointerEvents: 'none' });
      document.body.append(b);
    });
    await page.screenshot({ path: join(CAPTURES, `${name}.png`) });
  }
  /** The board's reference images: each image shape with its asset's src and meta, and the rendered <img>'s natural width. */
  const refs = (page: Page) => page.evaluate(() => {
    const ed = (window as never as Win).timmyCanvas.editor;
    const assets = new Map(ed.getAssets().map((a) => [a.id, a]));
    return ed.getCurrentPageShapes().filter((s) => s.type === 'image').map((s) => {
      const a = assets.get(String(s.props.assetId));
      const img = document.getElementById(s.id)?.querySelector('img.tl-image') as HTMLImageElement | null;
      return { id: s.id, asset: a?.id ?? null, src: a ? a.props.src : null, meta: a ? a.meta.timmyRef : null, alt: s.props.altText, natural: img && img.complete ? img.naturalWidth : 0, parent: s.parentId };
    });
  });
  const captions = (page: Page) => page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentPageShapes().filter((s) => s.type === 'text' && s.meta.timmyRefCaption).map((s) => {
    const words: string[] = [];
    const walk = (n: unknown): void => { if (!n || typeof n !== 'object') return; const o = n as { text?: unknown; content?: unknown[] }; if (typeof o.text === 'string') words.push(o.text); for (const c of o.content ?? []) walk(c); };
    walk(s.props.richText);
    return words.join('');
  }));

  it('the server: a file outside the project, a link out of it, an SVG and a request without a credential are refused, in words; nothing is copied', async () => {
    const session = await pageSession(port, server.projectToken);
    const copy = (path: string, project = tray.id, auth = bearer(session)) => call(port, 'POST', '/api/project/reference', { headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ project, path }) });
    const before = tree(board(tray));
    const out = await copy('../outside.png');
    expect(out.status).toBe(400);
    expect(out.json.error).toBe('Refused: ../outside.png is not a path inside tray (no "..", no leading "/"): a reference image is a PNG, JPEG, WebP or GIF from the project\'s own files only.');
    expect((await copy(outside)).status).toBe(400);
    const link = await copy('refs/link.png');
    expect(link.status).toBe(403);
    expect(link.json.error).toBe('Refused: refs/link.png is not added: it is reached through a link (which may lead out of the project), and a link is never followed. Nothing was copied.');
    const svg = await copy('refs/notes.svg');
    expect(svg.status).toBe(415);
    expect(svg.json.error).toBe('Refused: refs/notes.svg is an SVG, which can carry script; a reference image is a PNG, JPEG, WebP or GIF.');
    expect((await copy('refs/photo.png', tray.id, {})).status).toBe(401);
    // another project's board than the one shown: refused, both to copy into and to read from
    const other = await copy('refs/green.png', blank.id);
    expect(other.status).toBe(409);
    expect(other.json).toMatchObject({ notShown: true, shows: { id: tray.id, name: 'tray' } });
    expect(tree(board(tray))).toEqual(before);
    // the list names the project's raster images only (no link, no SVG)
    const files = await call(port, 'GET', `/api/project/reference-files?project=${tray.id}`, { headers: bearer(session) });
    expect((files.json.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['refs/photo.png', 'refs/second.png']);
    expect((await call(port, 'GET', `/api/canvas/ref/${tray.id}/${'0'.repeat(64)}.png`)).status).toBe(401);
    expect((await call(port, 'GET', `/api/canvas/ref/${tray.id}/..%2Fcanvas.json`, { headers: bearer(session) })).status).toBe(400);
  });

  it("an image added to tray's board is copied into tray's board folder, shown with its file name and where it came from, kept through a save and a reopen, and never on blank's board; blank's files are untouched", async () => {
    const trayFolder = tree(tray.root);
    const blankBoard = tree(board(blank));
    const s = await open();
    const { page } = s;
    try {
      await shows(page, tray);
      await page.click('#references > summary');
      const row = page.locator('#reference-list li[data-path="refs/photo.png"]');
      await row.waitFor({ timeout: 15_000 });
      expect(await row.getAttribute('data-project')).toBe(tray.id);
      expect(await page.locator('#reference-list li').evaluateAll((l) => l.map((e) => e.getAttribute('data-path')))).toEqual(['refs/photo.png', 'refs/second.png']);
      await row.locator('button.ritem-add').click();
      await page.waitForFunction(() => (window as never as Win).timmyCanvas.editor.getCurrentPageShapes().some((s) => s.type === 'image'), null, { timeout: 15_000 });
      await page.waitForFunction(() => { const img = document.querySelector('.tl-image') as HTMLImageElement | null; return !!img && img.complete && img.naturalWidth === 160; }, null, { timeout: 15_000 });
      const [one] = await refs(page);
      const digest = sha(PHOTO);
      expect(one).toMatchObject({ src: `/api/canvas/ref/${tray.id}/${digest}.png`, natural: 160, meta: { path: 'refs/photo.png', sha256: digest, bytes: PHOTO.length, from: "tray's own file refs/photo.png, copied into tray's board", project: tray.id, projectName: 'tray' } });
      const caption = `photo.png · from refs/photo.png in tray · sha256 ${digest.slice(0, 12)} · ${bytesWords(PHOTO.length)}`;
      expect(one.alt).toBe(caption);
      expect(await captions(page)).toEqual([caption]);
      // the copy is in tray's board folder, the same bytes; nothing was written into tray's own folder
      expect(readFileSync(join(board(tray), 'refs', `${digest}.png`)).equals(PHOTO)).toBe(true);
      expect(tree(tray.root)).toEqual(trayFolder);
      await savedState(page);
      expect(await text(page, '#project-said')).toBe(`Added to tray's board: refs/photo.png (sha256 ${digest.slice(0, 12)}, ${bytesWords(PHOTO.length)}), copied into its board folder.`);
      await capture(page, '05-tray-reference-image');
      // the board on disk names the copy by its address only: no image bytes, no credential
      const saved = boardText(tray);
      expect(saved).toContain(`"src":"/api/canvas/ref/${tray.id}/${digest}.png"`);
      expect(saved).not.toMatch(/data:image|blob:|Bearer|#code=/);
      expect(tree(board(blank))).toEqual(blankBoard);
    } finally {
      await s.context.close();
    }
    // reopened (a new page, a new grant): the image comes back from the board's copy
    const again = await open();
    try {
      await shows(again.page, tray);
      await again.page.waitForFunction(() => { const img = document.querySelector('.tl-image') as HTMLImageElement | null; return !!img && img.complete && img.naturalWidth === 160; }, null, { timeout: 15_000 });
      expect((await refs(again.page)).map((r) => r.meta && (r.meta as { path: string }).path)).toEqual(['refs/photo.png']);
      // blank: its own board shows none of tray's images; its board files are as they were
      workbench(blank);
      await named(blank);
      await shows(again.page, blank);
      await again.page.waitForTimeout(500);
      expect(await refs(again.page)).toEqual([]);
      expect(await again.page.locator('.tl-image').count()).toBe(0);
      expect(tree(board(blank))).toEqual(blankBoard);
      expect(existsSync(join(board(blank), 'refs'))).toBe(false);
      // tray's copy is not served while blank is shown
      const session = await pageSession(port, server.projectToken);
      const digest = sha(PHOTO);
      expect((await call(port, 'GET', `/api/canvas/ref/${tray.id}/${digest}.png`, { headers: bearer(session) })).status).toBe(409);
      await capture(again.page, '06-blank-without-tray-reference');
      expect(again.errors).toEqual([]);
    } finally {
      await again.context.close();
      workbench(tray);
      await named(tray);
    }
  });

  it('a draft that adds a reference image marks its asset and shapes; Discard removes them, and the board keeps its own', async () => {
    const s = await open();
    const { page } = s;
    try {
      await shows(page, tray);
      await page.waitForFunction(() => document.querySelectorAll('.tl-image').length === 1, null, { timeout: 15_000 });
      // FAKE: a scripted canvas_exec call (no model), as the agent's canvas tools send it: a draft by default
      const tools = createCanvasTools({ baseUrl: base, auth: () => ({ token: server.projectToken, holder: HOLDER, project: replOn.id, opened }) });
      const exec = tools.find((t) => t.function.name === 'canvas_exec')!.function.execute as (a: unknown) => Promise<{ ok: boolean; draft?: { id: string; shapes: number }; result?: Record<string, unknown> }>;
      const drawn = await exec({ code: "return await window.timmyCanvas.placeReference('refs/second.png');", jobId: 'turn-ref-draft' });
      expect(drawn).toMatchObject({ ok: true, draft: { id: expect.stringMatching(/^draft-/), shapes: 3 } });
      const second = sha(SECOND);
      const marked = await page.evaluate(() => (window as never as Win).timmyCanvas.editor.store.allRecords().filter((r) => r.meta && (r.meta as { timmyDraft?: unknown }).timmyDraft).map((r) => [r.typeName, r.type]).sort());
      expect(marked).toEqual([['asset', 'image'], ['shape', 'group'], ['shape', 'image'], ['shape', 'text']]);
      await page.waitForSelector('#draft-list li.draft button.draft-discard', { timeout: 15_000 });
      await capture(page, '07-tray-reference-draft');
      await page.click('#draft-list li.draft button.draft-discard');
      await page.waitForFunction(() => (window as never as Win).timmyCanvas.editor.getCurrentPageShapes().filter((s) => s.type === 'image').length === 1, null, { timeout: 15_000 });
      const left = await page.evaluate(() => (window as never as Win).timmyCanvas.editor.getAssets().map((a) => a.id));
      expect(left).toEqual([`asset:${sha(PHOTO)}`]);
      expect(left).not.toContain(`asset:${second}`);
      await savedState(page);
      const saved = boardText(tray);
      expect(saved).not.toContain(second);
      expect(saved).toContain(sha(PHOTO));
      expect(s.errors).toEqual([]);
    } finally {
      await s.context.close();
    }
  });
});
