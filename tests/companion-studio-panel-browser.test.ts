/**
 * R6 (H145): the browser companion's tab 4 (Studio; reference 06), what is on the shown project's own board, in a real headless
 * Chromium against the real companion server and the real canvas server (its page and bundle, built here into a temporary
 * folder), one temporary Timmy home, and two FAKE disposable projects in its projects folder, tray and blank (folders made here).
 *
 * The journey, end to end: in Studio, tray's artifacts (its VoxVision record, its operation, one of its receipts) and one of its
 * images (a reference) are placed on tray's board; Timmy proposes a draft that adds another image (FAKE: a scripted canvas_exec
 * call, no model) and leaves it waiting; a note is written; a card of blank is pasted onto tray's board (FAKE: put there by the
 * test, as a paste puts it). The companion's tab 4 then lists tray's board as Studio saved it, read on screen: each item's kind,
 * title, page, its draft and FAKE marks, its thumbnail (the record's own image, the reference's board copy: their pixels decoded
 * in the page), and what it opens (data-open-vox, data-open-run, which opens the run in Workflows, and the receipt's page in
 * Studio, which says it verifies); blank's card is named as kept apart and nothing of it is read. Then the active project
 * becomes blank: the companion and Studio follow it, tab 4 lists blank's own board only, a read of tray's board held across the
 * switch is dropped, and tray's board files are byte-identical before and after (hashed).
 *
 * FAKE, said where used: tray's VoxVision record is made by the REPL's own record writer with the FAKE Look of
 * tests/helpers/vox-fakes.ts (a labelled test double, not OpenCV: its record says "fake") and sealed with a real vox receipt on
 * this file's chain; tray's operation record is written here through Timmy's own writer (it says FAKE in its request); its run
 * detail comes from a FIXTURE producer given to the companion. The images are drawn here. Not exercised here: data-open-vox and
 * data-enlarge are handled by the page's own code on the lead's branch (819cb63), not on this one, so their attributes are read
 * here and their handling is not. Skipped, saying so, where no Chromium or Chrome is found. Captures (PNG) only when
 * TIMMY_R6_CAPTURES names a folder, each with a band that says it is FAKE and scripted.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCanvasTools } from '../src/agent/canvas-tools.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { RUN_DETAIL_VERSION, type RunDetail } from '../src/contracts/run-detail.js';
import { writeOperationRecord } from '../src/ops/operations.js';
import { projectId } from '../src/project/index.js';
import { activeProjectFile } from '../src/studio/active-follow.js';
import { boardDir } from '../src/studio/boards.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { grant, nameProject } from './helpers/canvas-auth.js';
import { act, png, put, tempKit } from './helpers/vox-panel-kit.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-studio-panel-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const HOLDER = 'd'.repeat(32);
const TOKEN = 'c4'.repeat(32);
const CAPTURES = process.env.TIMMY_R6_CAPTURES?.trim() || '';
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
type Project = { name: string; root: string; id: string };
type Who = { id: string; name: string } | null;
type Shape = { id: string; type: string; props: Record<string, unknown>; meta: Record<string, unknown> };
type Win = { timmyCanvas: { editor: { getCurrentPageShapes: () => Shape[]; createShape: (s: Record<string, unknown>) => void }; project: Who; identity: { project: Who; state: string } } };
type Item = { shape: string; page: string; kind: string; sub?: string; title: string; excerpt: string; draft: string | null; fake?: true; target?: { vox?: string; run?: string; receipt?: string }; ref?: { file: string; path: string; sha256: string; bytes: number; from: string }; thumb?: { src: string; path: string } };
type BoardAnswer = { ok: boolean; schema: string; project: { id: string; name: string }; board: { revision: number | null; savedAt: string | null; unreadable: boolean }; items: Item[]; counts: Record<string, number>; drafts: string[]; more: number; studio: string; oldLayout: string | null };

/** FAKE images, drawn here: tray's photo (red and blue halves), a second one (an amber square), blank's own (green). */
const PHOTO = png(160, 80, (x) => (x < 80 ? [200, 10, 10] : [10, 10, 200]));
const SECOND = png(64, 64, (x, y) => (x > 16 && x < 48 && y > 16 && y < 48 ? [255, 176, 0] : [20, 20, 20]));
const GREEN = png(80, 80, () => [10, 160, 10]);

/** FIXTURE: tray's operation's run detail, as src/ops/run-detail.ts makes one (labelled FIXTURE in every word it makes). */
function fixtureDetail(op: string, root: string): RunDetail {
  return {
    version: RUN_DETAIL_VERSION, operation: op, parent: null, children: [],
    project: { name: 'tray', root, id: projectId(root) },
    objective: { value: 'FIXTURE: run BUILD.md build', from: `.timmy/operations/${op}.json` },
    sourceRevision: null,
    verdict: { state: 'completed', words: 'FIXTURE: the build ran and its outputs are there', from: 'receipt 1a2b3c4d' },
    stage: { current: 'build', done: 1, total: 1, from: 'jobs/j1.json' },
    exits: [{ who: 'upmd', code: 0, state: 'exited', from: 'jobs/j1.json' }],
    freshness: { state: 'current', why: 'FIXTURE: its outputs hold the bytes it wrote', from: 'jobs/j1.json' },
    acceptance: { state: 'not reviewed' },
    worker: { harness: { value: 'FIXTURE harness', from: 'jobs/j1.json' } },
    time: { startedAt: '2026-10-16T10:00:00.000Z', endedAt: '2026-10-16T10:00:05.000Z', elapsedMs: 5000 },
    prediction: null, checks: [],
    files: [{ path: `${root}/out/tray.stl`, role: 'output', sha256: 'cd'.repeat(32), from: 'receipt 1a2b3c4d' }],
    receipts: [{ id: '1a2b3c4d', kind: 'workflow', subject: 'FIXTURE BUILD.md build' }],
    cost: { usd: null, measured: false, why: 'FIXTURE: no model was called' },
    summary: { path: null },
    next: { words: 'FIXTURE: look at out/tray.stl', command: `/op ${op}` },
    unknown: [],
  } as unknown as RunDetail;
}

describe.skipIf(!browserPath)("the companion's tab 4: what is on the shown project's own board, with its thumbnails and what each opens (real browser)", () => {
  const kit = tempKit();
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  const dirs: string[] = [];
  let fileStore = '';
  let home = '';
  let pageRoot = '';
  let port = 0;
  let base = '';
  let opened = 0;
  let studio: StudioServer;
  let companion: CompanionServer;
  let browser: Browser;
  let tray: Project;
  let blank: Project;
  let trayVox = '';
  const trayOp = 'o1a2b3c4d';
  const asked: Array<{ op: string; project?: string }> = [];
  /** set by the first test: what tray's board holds once Studio saved it */
  let rid = '';
  let draftId = '';
  /** This file's own receipts store (each test names it again: the setup gives every test a fresh one). */
  beforeEach(() => { process.env.TIMMY_STORE = fileStore; });

  const project = (name: string): Project => {
    const root = join(home, 'projects', name);
    mkdirSync(join(root, 'refs'), { recursive: true });
    writeFileSync(join(root, 'BUILD.md'), `# ${name} build\n\n\`\`\`bash [name:build]\necho ${name}\n\`\`\`\n`);
    return { name, root, id: projectId(root) };
  };

  beforeAll(async () => {
    fileStore = join(mkdtempSync(join(tmpdir(), 'timmy-tab4-store-')), 'receipts');
    mkdirSync(fileStore, { recursive: true });
    dirs.push(join(fileStore, '..'));
    process.env.TIMMY_STORE = fileStore;
    home = mkdtempSync(join(tmpdir(), 'timmy-tab4-home-'));
    dirs.push(home);
    // the companion follows the active project of this Timmy home (TIMMY_REPO would fix its folder instead)
    process.env.TIMMY_HOME = home;
    delete process.env.TIMMY_REPO;
    tray = project('tray');
    blank = project('blank');
    put(tray.root, 'refs/photo.png', PHOTO);
    put(tray.root, 'refs/second.png', SECOND);
    put(blank.root, 'refs/green.png', GREEN);
    trayVox = await act(kit, tray.root, (ws) => ws.detect('refs/photo.png color 200,10,10'), { FAKE_QR: 'tray vox' });
    // FAKE: tray's operation (one workflow run), through Timmy's own record writer
    const w = writeOperationRecord(tray.root, {
      schema: 'timmy.operation/1', id: trayOp, request: '/run BUILD.md build (FAKE operation, written by the test)', via: 'repl', project: 'tray',
      started: '2026-10-16T10:00:00.000Z', ended: '2026-10-16T10:00:05.000Z', state: 'succeeded', why: 'its run completed', parent: null,
      runs: [{ kind: 'workflow', id: 'j1', at: '2026-10-16T10:00:00.000Z' }], owner: { pid: process.pid, started: '2026-10-16T09:59:00.000Z' },
    } as never);
    expect(w.ok).toBe(true);
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-tab4-root-'));
    dirs.push(pageRoot);
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    studio = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: join(home, 'settings'), PATH: process.env.PATH }, root: pageRoot, projectTokenFile: true, followEveryMs: 100, followGraceMs: 200 });
    port = (studio.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    workbench(tray);
    await named(tray);
    companion = await startCompanionServer(0, {
      token: TOKEN,
      // FIXTURE: the run detail of tray's operation (and nothing for any other)
      runDetail: (op, o) => { asked.push({ op, project: o.project }); return o.project === tray.root && op === trayOp ? fixtureDetail(op, tray.root) : { error: `FIXTURE: no run detail of ${op} here` }; },
      // the companion's environment: this Timmy home, and where its Studio answers (the receipt links)
      workspace: { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: join(home, 'settings'), TIMMY_STUDIO_PORT: String(port) }, shareMs: 0 },
    });
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 240_000);
  afterAll(async () => {
    await browser?.close();
    await companion?.shutdown();
    await new Promise<void>((done) => (studio ? studio.close(() => done()) : done()));
    await kit.cleanup();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** The REPL's /canvas open: it names `p` to Studio, with its holder id and the receipts store it seals to (this file's chain). */
  const named = (p: Project) => nameProject(port, studio.projectToken, { root: p.root, name: p.name, holder: HOLDER, receipts: process.env.TIMMY_STORE! });
  /** The Workbench's p: the active project of this Timmy home (Studio and the companion both follow it). */
  function workbench(p: Project): void {
    const file = activeProjectFile({ TIMMY_HOME: home });
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ name: p.name, root: p.root, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  const board = (p: Project): string => boardDir(join(home, 'canvas'), p.id);
  const boardText = (p: Project): string => { try { return readFileSync(join(board(p), 'canvas.json'), 'utf8'); } catch { return ''; } };
  /** Every file of project `p`'s board, with its sha256. */
  function files(p: Project): Record<string, string> {
    const dir = board(p);
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
      let names: string[] = [];
      try { names = readdirSync(d); } catch { return; }
      for (const n of names.sort()) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else out[relative(dir, f)] = sha(readFileSync(f)); }
    };
    walk(dir);
    return out;
  }
  async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`not in time: ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  /** The companion's own routes, with its token (or none). */
  async function api(path: string, auth = true): Promise<{ status: number; type: string; json: Record<string, unknown> | null; body: Buffer; headers: Headers }> {
    const r = await fetch(`http://127.0.0.1:${companion.port}${path}`, { headers: auth ? { Authorization: `Bearer ${TOKEN}` } : {} });
    const body = Buffer.from(await r.arrayBuffer());
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(body.toString('utf8')) as Record<string, unknown>; } catch { json = null; }
    return { status: r.status, type: r.headers.get('content-type') ?? '', json, body, headers: r.headers };
  }
  const boardOf = async (p: Project): Promise<BoardAnswer> => {
    const r = await api(`/api/panel/studio/board?project=${p.id}`);
    expect(r.status).toBe(200);
    return r.json as unknown as BoardAnswer;
  };

  // ── Studio ──
  interface Opened { page: Page; context: BrowserContext; errors: string[] }
  const allowed = (url: string): boolean => /^(data|blob):/.test(url) || [base, `http://127.0.0.1:${companion.port}`].includes(new URL(url).origin);
  async function openStudio(): Promise<Opened> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('**/*', (route) => (allowed(route.request().url()) ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 409 \(Conflict\)/.test(m.text())) errors.push(m.text()); });
    opened += 1;
    await page.goto(`${base}/#code=${await grant(port, studio.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    return { page, context, errors };
  }
  async function studioShows(page: Page, p: Project): Promise<void> {
    await page.waitForFunction((id) => { const t = (window as never as Win).timmyCanvas; return t?.identity.state === 'shown' && t.identity.project?.id === id && t.project?.id === id; }, p.id, { timeout: 20_000 });
    await page.waitForFunction((n) => (document.getElementById('artifacts-name')?.textContent ?? '').startsWith(`${n} · `), p.name, { timeout: 20_000 });
  }

  // ── the companion ──
  async function openCompanion(viewport = { width: 1376, height: 768 }): Promise<Opened & { bad: string[] }> {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', (route) => (allowed(route.request().url()) ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors: string[] = [];
    const bad: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => { if (r.status() >= 400 && /\/api\/panel\/studio\//.test(r.url())) bad.push(`${r.status()} ${r.url()}`); });
    await page.goto(companion.url);
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
    return { page, context, errors, bad };
  }
  const headerShows = (page: Page, name: string) => page.waitForFunction((n) => document.getElementById('project-name')?.textContent === n, name, { timeout: 15_000 });
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
  const rows = (page: Page) => page.$$eval('[data-panel-host="studio"] .sb-item', (els) => els.map((e) => ({
    shape: e.getAttribute('data-shape'), kind: e.getAttribute('data-kind'), sub: e.getAttribute('data-sub'),
    head: (e.querySelector('.sb-head')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    title: e.querySelector('.sb-title')?.textContent ?? '', where: e.querySelector('.sb-where')?.textContent ?? '',
    vox: e.querySelector('[data-open-vox]')?.getAttribute('data-open-vox') ?? null, run: e.querySelector('[data-open-run]')?.getAttribute('data-open-run') ?? null,
    receipt: e.querySelector('a[data-receipt]')?.getAttribute('href') ?? null, enlarge: e.querySelector('[data-enlarge]')?.getAttribute('data-enlarge') ?? null,
    thumb: e.querySelector('.sb-thumb img')?.getAttribute('data-path') ?? null, draft: e.querySelector('[data-draft]')?.getAttribute('data-draft') ?? null,
  })));
  /** The canvas's own box (the lead's, refreshed every 5 s) and tab 4's list name the same revision of the board shown. */
  const sameRevision = async (page: Page, n: number): Promise<void> => {
    await page.waitForFunction((r) => (document.getElementById('canvas-summary')?.textContent ?? '').includes(`Revision ${r} `), n, { timeout: 15_000 });
    expect(await text(page, '[data-studio="summary"]')).toContain(`(revision ${n}, `);
  };
  /** Where tab 4's boxes are on screen (px): the Studio state, the canvas, the tab's actions, the board list. */
  const boxes = (page: Page) => page.evaluate(() => {
    const r = (sel: string) => { const b = document.querySelector(sel)!.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
    return { state: r('#ws-studio section[aria-labelledby="studio-state-title"]'), canvas: r('#ws-studio #tab-canvas'), acts: r('#ws-studio section[aria-labelledby="studio-acts-title"]'), board: r('#ws-studio .sb-box') };
  });
  /** The thumbnails drawn: each image's path, its decoded width, and that it is a data: image. */
  const thumbs = (page: Page) => page.$$eval('[data-panel-host="studio"] .sb-thumb img', (imgs) => imgs.map((i) => ({ path: i.getAttribute('data-path'), w: (i as HTMLImageElement).complete ? (i as HTMLImageElement).naturalWidth : 0, data: (i as HTMLImageElement).src.startsWith('data:image/png;base64,') })));
  async function capture(page: Page, name: string): Promise<void> {
    if (!CAPTURES) return;
    mkdirSync(CAPTURES, { recursive: true });
    await page.evaluate(() => {
      if (document.getElementById('fake-band')) return;
      const b = document.createElement('div');
      b.id = 'fake-band';
      b.textContent = 'SCRIPTED TEST · headless Chromium · FAKE VoxVision record (FAKE Look, a test double) · FAKE operation, FIXTURE run detail · FAKE draft (scripted canvas_exec, no model) · FAKE paste of blank\'s card · images drawn by the test · disposable projects tray and blank';
      Object.assign(b.style, { position: 'fixed', right: '8px', bottom: '8px', zIndex: '400', maxWidth: '60vw', padding: '4px 8px', background: '#070707', color: '#F2EFE9', border: '1px solid #444444', font: '12px/1.4 monospace', pointerEvents: 'none' });
      document.body.append(b);
    });
    await page.screenshot({ path: join(CAPTURES, `${name}.png`) });
  }
  /** The palette over tab 4 (as H143's check): no blue, purple or cyan; green only within .is-live or .is-verified; text 4.5:1. */
  const palette = (page: Page) => page.evaluate(() => {
    const parse = (v: string): number[] | null => { const m = /^rgba?\(([^)]+)\)$/.exec(v.trim()); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
    const hsl = ([r, g, b]: number[]) => { const [R, G, B] = [r / 255, g / 255, b / 255]; const max = Math.max(R, G, B); const min = Math.min(R, G, B); const l = (max + min) / 2; const d = max - min; if (d === 0) return { h: 0, s: 0, l }; const h = max === R ? 60 * (((G - B) / d) % 6) : max === G ? 60 * ((B - R) / d + 2) : 60 * ((R - G) / d + 4); return { h: (h + 360) % 360, s: d / (1 - Math.abs(2 * l - 1)), l }; };
    const lum = (c: number[]) => { const [r, g, b] = c.slice(0, 3).map((x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const out = { hue: [] as string[], green: [] as string[], contrast: [] as string[] };
    for (const el of document.querySelectorAll('#ws-studio, #ws-studio *')) {
      if (el.closest('[hidden]') || el.tagName === 'IMG') continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || el.getBoundingClientRect().width === 0) continue;
      for (const prop of ['color', 'background-color', 'border-top-color', 'border-left-color']) {
        const c = parse(cs.getPropertyValue(prop)); if (!c || c[3] === 0) continue;
        const { h, s, l } = hsl(c); if (s < 0.2 || l < 0.08 || l > 0.92) continue;
        if (h >= 150 && h <= 320) out.hue.push(`${el.tagName} ${prop}`);
        else if (h >= 75 && h < 150 && !el.closest('.is-live, .is-verified')) out.green.push(`${el.tagName}.${el.className} ${prop}`);
      }
      if (![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim())) continue;
      const fg = parse(cs.color); if (!fg) continue;
      let bg = [0, 0, 0]; for (let e: Element | null = el; e; e = e.parentElement) { const b = parse(getComputedStyle(e).backgroundColor); if (b && b[3] > 0.5) { bg = b.slice(0, 3); break; } }
      const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      if ((hi + 0.05) / (lo + 0.05) < 4.5) out.contrast.push(`${el.tagName}.${el.className}: ${(el.textContent ?? '').trim().slice(0, 30)}`);
    }
    return out;
  });

  it("Studio places tray's artifacts, a reference image, a draft and a note on tray's board; the companion's routes answer each project's own board, never mixed", async () => {
    const s = await openStudio();
    const { page } = s;
    try {
      await studioShows(page, tray);
      // tray's artifacts, placed from Studio's side panel: its VoxVision record, its operation, its first receipt
      if (!(await page.evaluate(() => (document.getElementById('artifacts') as HTMLDetailsElement).open))) await page.click('#artifacts > summary');
      for (const id of [`vox:${trayVox}`, `run:${trayOp}`]) {
        await page.locator(`#artifact-list li[data-artifact="${id}"] button.aitem-place`).click();
        await page.locator(`[data-artifact="${id}"].ta`).waitFor({ timeout: 15_000 });
      }
      const receiptRow = page.locator('#artifact-list li[data-artifact^="receipt:"]').first();
      rid = (await receiptRow.getAttribute('data-artifact'))!.slice('receipt:'.length);
      await receiptRow.locator('button.aitem-place').click();
      await page.locator(`[data-artifact="receipt:${rid}"].ta`).waitFor({ timeout: 15_000 });
      // one of tray's images, added as a reference (copied into tray's board)
      await page.click('#references > summary');
      await page.locator('#reference-list li[data-path="refs/photo.png"] button.ritem-add').click();
      await page.waitForFunction(() => (window as never as Win).timmyCanvas.editor.getCurrentPageShapes().some((x) => x.type === 'image'), null, { timeout: 15_000 });
      // a note a person wrote, and (FAKE) a card of blank pasted onto tray's board, as a paste puts one: its props as they were
      await page.evaluate(([blankId]) => {
        const ed = (window as never as Win).timmyCanvas.editor;
        ed.createShape({ type: 'note', x: -480, y: 40, props: { richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Check the lip of the tray (a note on the board)' }] }] } } });
        ed.createShape({ type: 'timmy-artifact', x: -480, y: 420, props: { w: 360, h: 180, card: 'vox:vfeedbeef', kind: 'vox', projectId: blankId, project: 'blank', title: "blank's own record (FAKE: pasted here by the test)", command: '', data: { type: 'artifact', kind: 'vox', state: "blank's words, which tray's board never shows", at: null, record: null, fake: true }, readAt: '', open: false, gone: false } });
      }, [blank.id]);
      // FAKE: Timmy's draft, a scripted canvas_exec call (no model): it adds tray's second image and waits for Accept or Discard.
      // While it runs, the VoxVision card's height moves, as the card's own fit moves it when its image loads during a call: that
      // is the page's change, never the call's, so the draft stands (artifacts.js artifactFollowed, applied in canvas.js)
      const tools = createCanvasTools({ baseUrl: base, auth: () => ({ token: studio.projectToken, holder: HOLDER, project: tray.id, opened }) });
      const exec = tools.find((t) => t.function.name === 'canvas_exec')!.function.execute as (a: unknown) => Promise<{ ok: boolean; draft?: { id: string; shapes: number } }>;
      const code = [
        `const card = editor.getCurrentPageShapes().find((s) => s.type === 'timmy-artifact' && s.props.card === 'vox:${trayVox}');`,
        'editor.updateShape({ id: card.id, type: card.type, props: { h: card.props.h + 7 } });',
        "return await window.timmyCanvas.placeReference('refs/second.png');",
      ].join('\n');
      const drawn = await exec({ code, jobId: 'turn-tab4-draft' });
      expect(drawn, JSON.stringify(drawn)).toMatchObject({ ok: true, draft: { id: expect.stringMatching(/^draft-[0-9a-f]+$/), shapes: 3 } });
      draftId = drawn.draft!.id;
      await page.waitForSelector('#draft-list li.draft button.draft-discard', { timeout: 15_000 });
      // Studio saved all of it to tray's board (the paste with no detail of blank's: a page of tray never writes blank's)
      await until("tray's board saved with everything placed", () => {
        const t = boardText(tray);
        return [`"card":"vox:${trayVox}"`, `"card":"run:${trayOp}"`, `"card":"receipt:${rid}"`, sha(PHOTO), sha(SECOND), draftId, 'Check the lip of the tray', '"card":"vox:vfeedbeef"'].every((x) => t.includes(x));
      });
      expect(boardText(tray)).not.toContain("blank's words, which tray's board never shows");
      expect(s.errors).toEqual([]);
    } finally {
      await s.context.close();
    }

    // the companion's board route: tray's board, each item with its kind, page, marks, targets and thumbnail
    const t = await boardOf(tray);
    expect(t).toMatchObject({ ok: true, schema: 'timmy.studio-board/1', project: { id: tray.id, name: 'tray' }, board: { unreadable: false }, drafts: [draftId], more: 0, studio: base, oldLayout: null });
    expect(t.board.revision).toBeGreaterThan(0);
    expect(t.counts).toEqual({ artifact: 3, reference: 2, words: 1, 'other-project': 1 });
    const by = (f: (i: Item) => boolean): Item => { const x = t.items.filter(f); expect(x).toHaveLength(1); return x[0]; };
    expect(by((i) => i.kind === 'artifact' && i.sub === 'vox')).toMatchObject({ title: 'detect refs/photo.png', fake: true, draft: null, target: { vox: trayVox }, thumb: { path: 'refs/photo.png', src: `/api/panel/voxvision/file?id=${trayVox}&path=refs%2Fphoto.png` } });
    expect(by((i) => i.kind === 'artifact' && i.sub === 'run')).toMatchObject({ fake: true, target: { run: trayOp } });
    expect(by((i) => i.kind === 'artifact' && i.sub === 'receipt')).toMatchObject({ target: { receipt: rid } });
    expect(by((i) => i.kind === 'reference' && i.title === 'photo.png')).toMatchObject({ draft: null, excerpt: "tray's own file refs/photo.png, copied into tray's board", ref: { path: 'refs/photo.png', sha256: sha(PHOTO), bytes: PHOTO.length }, thumb: { path: 'refs/photo.png', src: `/api/panel/studio/ref?file=${sha(PHOTO)}.png` } });
    expect(by((i) => i.kind === 'reference' && i.title === 'second.png')).toMatchObject({ draft: draftId, ref: { sha256: sha(SECOND) } });
    expect(by((i) => i.kind === 'words')).toMatchObject({ sub: 'note', title: 'Check the lip of the tray (a note on the board)' });
    const other = by((i) => i.kind === 'other-project');
    expect(other).toEqual({ shape: other.shape, page: other.page, kind: 'other-project', title: 'a card of blank', excerpt: "kept apart: shown on blank's own board only, so nothing of it is read here", draft: null });
    expect(JSON.stringify(t)).not.toMatch(/vfeedbeef|blank's words|blank's own record/);
    // blank's board: its own (nothing yet), nothing of tray's
    const b = await boardOf(blank);
    expect(b).toMatchObject({ ok: true, project: { id: blank.id, name: 'blank' }, board: { revision: 0, savedAt: null, unreadable: false }, items: [], counts: {}, drafts: [] });
    expect(JSON.stringify(b)).not.toMatch(new RegExp(`${trayVox}|${trayOp}|${sha(PHOTO)}|tray`));
    // a reference's board copy: tray's, the same bytes, sent as an image that runs nothing; not on blank's board; no token: 401
    const ref = await api(`/api/panel/studio/ref?file=${sha(PHOTO)}.png&project=${tray.id}`);
    expect(ref.status).toBe(200);
    expect(ref.type).toMatch(/^image\/png/);
    expect(ref.body.equals(PHOTO)).toBe(true);
    expect([ref.headers.get('x-content-type-options'), ref.headers.get('content-security-policy'), ref.headers.get('cache-control')]).toEqual(['nosniff', "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'no-store']);
    const elsewhere = await api(`/api/panel/studio/ref?file=${sha(PHOTO)}.png&project=${blank.id}`);
    expect(elsewhere.status).toBe(404);
    expect(String(elsewhere.json?.error)).toMatch(/^No reference image [0-9a-f]{12}… on blank's board/);
    expect((await api(`/api/panel/studio/ref?file=..%2Fcanvas.json&project=${tray.id}`)).status).toBe(400);
    expect((await api(`/api/panel/studio/board?project=${tray.id}`, false)).status).toBe(401);
    expect((await api(`/api/panel/studio/ref?file=${sha(PHOTO)}.png&project=${tray.id}`, false)).status).toBe(401);
    expect((await api(`/api/panel/studio/board?project=${'0'.repeat(16)}`)).status).toBe(404);
  });

  it("tab 4 lists tray's board as Studio saved it: kinds, titles, marks, the thumbnails' pixels, and what each opens (a run in Workflows, a receipt's page in Studio)", async () => {
    expect(rid).not.toBe('');
    const t = await boardOf(tray);
    const c = await openCompanion();
    const { page } = c;
    try {
      await headerShows(page, 'tray');
      await page.keyboard.press('4');
      await page.waitForFunction((n) => document.querySelectorAll('[data-panel-host="studio"] .sb-item').length === n, t.items.length, { timeout: 15_000 });
      expect(await text(page, '[data-studio="title"]')).toBe("On tray's board");
      const time = /^tray's own board, as Studio last saved it \(revision (\d+), \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\): 3 artifacts · 2 reference images · 1 with words \(notes, texts, frames\) · 1 of another project, kept apart\. 1 draft of Timmy's waiting for Accept or Discard in Studio\.$/.exec(await text(page, '[data-studio="summary"]'));
      expect(time?.[1]).toBe(String(t.board.revision));
      // each row is the route's item, in the route's order (reading order)
      const seen = await rows(page);
      expect(seen.map((r) => [r.shape, r.kind, r.title])).toEqual(t.items.map((i) => [i.shape, i.kind, i.title]));
      const row = (f: (i: Item) => boolean) => seen[t.items.findIndex(f)];
      expect(row((i) => i.sub === 'vox' && i.kind === 'artifact')).toMatchObject({ head: 'artifact · VoxVision record FAKE', vox: trayVox, run: null, receipt: null, thumb: 'refs/photo.png', enlarge: "detect refs/photo.png · refs/photo.png (artifact · VoxVision record on tray's board)" });
      // the operation's record says FAKE in its request, so its card is marked FAKE
      expect(row((i) => i.sub === 'run')).toMatchObject({ head: 'artifact · operation FAKE', run: trayOp, vox: null, thumb: null });
      const receiptItem = t.items.find((i) => i.sub === 'receipt')!;
      expect(row((i) => i.sub === 'receipt')).toMatchObject({ head: `artifact · receipt${receiptItem.fake ? ' FAKE' : ''}`, receipt: `${base}/receipts/${rid}` });
      // FAKE is drawn on a row exactly when its item is marked FAKE
      expect(seen.map((r) => r.head.includes('FAKE'))).toEqual(t.items.map((i) => i.fake === true));
      expect(row((i) => i.title === 'photo.png')).toMatchObject({ head: 'reference image', thumb: 'refs/photo.png', draft: null, enlarge: "photo.png · refs/photo.png (reference image on tray's board)" });
      expect(row((i) => i.title === 'second.png')).toMatchObject({ head: 'reference image draft · waiting in Studio', thumb: 'refs/second.png', draft: draftId });
      expect(row((i) => i.kind === 'words')).toMatchObject({ head: 'note', title: 'Check the lip of the tray (a note on the board)', thumb: null });
      expect(row((i) => i.kind === 'other-project')).toMatchObject({ head: 'kept apart', title: 'a card of blank', vox: null, run: null, receipt: null, thumb: null, enlarge: null });
      for (const r of seen) expect(r.where).toBe(`on ${t.items.find((i) => i.shape === r.shape)!.page}`);
      expect(await page.$eval('[data-panel-host="studio"] .sb-item.kind-other-project', (e) => e.textContent ?? '')).not.toMatch(/vfeedbeef|blank's words|blank's own record/);
      // the thumbnails: decoded in the page, each from its own bytes (the record's image, the board's copies)
      await page.waitForFunction(() => [...document.querySelectorAll('[data-panel-host="studio"] .sb-thumb img')].every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0), null, { timeout: 15_000 });
      expect((await thumbs(page)).sort((a, b) => String(a.path).localeCompare(String(b.path)))).toEqual([
        { path: 'refs/photo.png', w: 160, data: true }, { path: 'refs/photo.png', w: 160, data: true }, { path: 'refs/second.png', w: 64, data: true },
      ]);
      // the receipt's page in Studio (linked: this page is on this computer), opened apart, says it verifies
      const link = page.locator(`[data-panel-host="studio"] a[data-receipt="${rid}"]`);
      expect([await link.getAttribute('target'), await link.getAttribute('rel')]).toEqual(['_blank', 'noopener noreferrer']);
      expect(await page.getAttribute('[data-panel-host="studio"] a[data-studio-open]', 'href')).toBe(`${base}/`);
      // the layout: the board list takes the right column, as tall as the left one (the Studio state, the canvas, the actions)
      const at = await boxes(page);
      expect(at.board.left).toBeGreaterThan(at.state.right);
      expect([at.canvas.left, at.acts.left]).toEqual([at.state.left, at.state.left]);
      expect(at.state.bottom).toBeLessThanOrEqual(at.canvas.top);
      expect(at.canvas.bottom).toBeLessThanOrEqual(at.acts.top);
      expect(at.board.bottom - at.board.top).toBeGreaterThan(0.9 * (at.acts.bottom - at.state.top));
      const palette1 = await palette(page);
      expect(palette1).toEqual({ hue: [], green: [], contrast: [] });
      // the canvas's own box above names the same revision of tray's board (each refreshes on its own clock)
      await sameRevision(page, t.board.revision!);
      // the capture: a taller window, so the whole list is in it
      await page.setViewportSize({ width: 1376, height: 1240 });
      await page.waitForTimeout(300);
      await capture(page, '08-companion-tab4-tray-board');
      await page.setViewportSize({ width: 1376, height: 768 });
      const [popup] = await Promise.all([c.context.waitForEvent('page'), link.click()]);
      await popup.waitForLoadState();
      expect(new URL(popup.url()).pathname).toBe(`/receipts/${rid}`);
      expect(await popup.textContent('.verdict')).toBe(`✓ RECEIPT ${rid} signed and verified`);
      await popup.close();
      // Open run: the page's own handler opens the operation's run in Workflows (tab 2), at /run/<op>, read for tray
      await page.click(`[data-panel-host="studio"] [data-open-run="${trayOp}"]`);
      await page.waitForFunction((op) => location.pathname === `/run/${op}` && document.getElementById('ws-tab-workflows')?.getAttribute('aria-selected') === 'true', trayOp, { timeout: 10_000 });
      await page.waitForFunction(() => /FIXTURE: run BUILD\.md build/.test(document.getElementById('ws-workflows')?.textContent ?? ''), null, { timeout: 10_000 });
      expect(asked).toContainEqual({ op: trayOp, project: tray.root });
      expect(c.bad).toEqual([]);
      expect(c.errors).toEqual([]);
    } finally {
      await c.context.close();
    }
  });

  it("the active project becomes blank: tab 4 follows it and lists blank's own board only; a read of tray's board held across the switch is dropped; tray's board files are untouched", async () => {
    const trayBefore = files(tray);
    const c = await openCompanion();
    const { page } = c;
    let release: () => void = () => undefined;
    try {
      await headerShows(page, 'tray');
      await page.keyboard.press('4');
      await page.waitForSelector('[data-panel-host="studio"] .sb-item', { timeout: 15_000 });
      // hold the panel's next read of tray's board (it reads again every few seconds while the tab is shown)
      const gate = new Promise<void>((r) => { release = r; });
      let held!: () => void;
      const holding = new Promise<void>((r) => { held = r; });
      let heldUrl = '';
      await page.route('**/api/panel/studio/board*', async (route: Route) => {
        if (!heldUrl && route.request().url().includes(`project=${tray.id}`)) {
          heldUrl = route.request().url();
          held();
          await gate;
        }
        await route.continue();
      });
      await holding;
      // the Workbench's p chooses blank: the companion and Studio follow it
      workbench(blank);
      await named(blank);
      await headerShows(page, 'blank');
      await page.waitForFunction(() => document.querySelector('[data-studio="title"]')?.textContent === "On blank's board", null, { timeout: 15_000 });
      await page.waitForFunction(() => /^Nothing on blank's board yet\./.test(document.querySelector('[data-studio="summary"]')?.textContent ?? ''), null, { timeout: 15_000 });
      // tray's answer, let through now, is dropped: nothing of tray's is drawn under blank's name
      const late = page.waitForResponse((r) => r.url() === heldUrl);
      release();
      await late;
      await page.waitForTimeout(400);
      expect(await text(page, '[data-studio="title"]')).toBe("On blank's board");
      expect(await page.locator('[data-panel-host="studio"] .sb-item').count()).toBe(0);
      expect(await text(page, '[data-panel-host="studio"]')).not.toMatch(new RegExp(`${trayVox}|${trayOp}|photo\\.png|tray's`));

      // in Studio (now on blank's board), blank's own image is added; tab 4 lists it, and nothing of tray's
      const s = await openStudio();
      try {
        await studioShows(s.page, blank);
        await s.page.click('#references > summary');
        await s.page.locator('#reference-list li[data-path="refs/green.png"] button.ritem-add').click();
        await until("blank's board saved with its image", () => boardText(blank).includes(sha(GREEN)));
        expect(s.errors).toEqual([]);
      } finally { await s.context.close(); }
      await page.waitForFunction(() => document.querySelectorAll('[data-panel-host="studio"] .sb-item').length === 1, null, { timeout: 15_000 });
      const seen = await rows(page);
      expect(seen).toEqual([expect.objectContaining({ kind: 'reference', title: 'green.png', head: 'reference image', thumb: 'refs/green.png', vox: null, run: null, receipt: null, draft: null })]);
      await page.waitForFunction(() => { const i = document.querySelector('[data-panel-host="studio"] .sb-thumb img') as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth === 80; }, null, { timeout: 15_000 });
      // each project's own board through the route, never mixed: blank's its own, tray's as it was
      const b = await boardOf(blank);
      // (Studio may have saved once more as it closed: the list reads again within a few seconds)
      await page.waitForFunction((n) => (document.querySelector('[data-studio="summary"]')?.textContent ?? '').includes(`(revision ${n}, `), b.board.revision, { timeout: 15_000 });
      expect(await text(page, '[data-studio="summary"]')).toBe(`blank's own board, as Studio last saved it (revision ${b.board.revision}, ${await page.evaluate((iso) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }, b.board.savedAt!)}): 1 reference image.`);
      await sameRevision(page, b.board.revision!);
      await capture(page, '09-companion-tab4-blank-board');
      expect(b.items.map((i) => [i.kind, i.title, i.ref?.sha256])).toEqual([['reference', 'green.png', sha(GREEN)]]);
      expect((await boardOf(tray)).counts).toEqual({ artifact: 3, reference: 2, words: 1, 'other-project': 1 });
      expect(files(tray)).toEqual(trayBefore);
      // at 390 px wide nothing scrolls sideways
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(200);
      const m = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth }));
      expect(Math.max(m.page, m.body)).toBeLessThanOrEqual(m.inner);
      // one column, in the page's order: the Studio state, the canvas, the board list, the tab's actions
      const narrow = await boxes(page);
      expect([narrow.canvas.left, narrow.board.left, narrow.acts.left].every((x) => Math.abs(x - narrow.state.left) <= 1)).toBe(true);
      expect(narrow.state.top < narrow.canvas.top && narrow.canvas.top < narrow.board.top && narrow.board.top < narrow.acts.top).toBe(true);
      expect(c.bad).toEqual([]);
      expect(c.errors).toEqual([]);
    } finally {
      release();
      await c.context.close();
      workbench(tray);
      await named(tray);
    }
  });
});
