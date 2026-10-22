/**
 * R6 (H145): the shown project's artifacts on Timmy Studio's board, in a real headless Chromium against the real canvas server and
 * the real bundle (built here into a temporary folder), with a real temporary Timmy home and two FAKE disposable projects, tray and
 * blank (folders made here). The journey the operator asked for: an artifact → its card on the board (it shows the artifact) →
 * its preview (Open preview) → its one action; and isolation (R6 H139): an artifact card of tray shows tray's artifact and opens
 * tray's preview, never blank's; blank's board files are byte-identical before and after tray's steps (hashed); a placement
 * pending while Studio switches places nothing on either board.
 *
 * FAKE, said where used: each project's VoxVision record is made by the REPL's own record writer (src/repl/vox.ts /detect) with the
 * FAKE Look of tests/helpers/vox-fakes.ts (a labelled test double, not OpenCV: its record says "fake", and the card says FAKE),
 * sealed with a real vox receipt on this file's chain; tray's operation record is written here (FAKE, it says so in its request)
 * through Timmy's own writer (src/ops/operations.ts), and its run detail comes from a FIXTURE producer given through the server's
 * options (labelled FIXTURE in every word it makes). Skipped, saying so, where no Chromium or Chrome is found.
 *
 * Captures (PNG) are written only when TIMMY_R6_CAPTURES names a folder; each carries a band that says it is FAKE and scripted.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RUN_DETAIL_VERSION, type RunDetail } from '../src/contracts/run-detail.js';
import { writeOperationRecord } from '../src/ops/operations.js';
import { projectId } from '../src/project/index.js';
import { activeProjectFile } from '../src/studio/active-follow.js';
import { boardDir } from '../src/studio/boards.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { readChain } from '../src/utils/receipts.js';
import { bearer, call, grant, nameProject, pageSession } from './helpers/canvas-auth.js';
import { act, png, put, tempKit } from './helpers/vox-panel-kit.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-artifacts-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const HOLDER = 'e'.repeat(32);
const CAPTURES = process.env.TIMMY_R6_CAPTURES?.trim() || '';
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
// R7 lead: one matcher for page.route and page.unroute. Playwright matches a function matcher by identity, so
// `page.unroute(() => true, handler)`, given a new arrow function, removed nothing (the same removal in
// tests/studio-nodes-browser.test.ts left a read in its handler's route.fetch() when the page closed, on e1bea84)
const ANY_URL = (): boolean => true;
// The page keeps this route for its whole life, so removing the test's own handler never removes the page's last route (when the
// last one goes, Playwright continues a request still with a handler by itself, and that handler's own continue then fails:
// "route.continue: Route is already handled!", an unhandled rejection)
const passOn = (route: Route): Promise<void> => route.fallback();
// a held read's handler is off the page once the test removes it: `routed` counts every call of it, and a request made after the
// removal does not reach it (the page's own address: a plain page, read without a token)
async function gone(page: Page, routed: () => number): Promise<void> {
  const before = routed();
  await page.evaluate(() => fetch('/', { cache: 'no-store' }).then((r) => r.status, () => 0));
  expect(routed(), 'a request made after the unroute reached a removed handler').toBe(before);
}
type Project = { name: string; root: string; id: string };
type Who = { id: string; name: string } | null;
type Win = { timmyCanvas: { editor: { getCurrentPageShapes: () => Array<{ id: string; type: string; props: Record<string, unknown> }> }; project: Who; identity: { project: Who; switching: Who; state: string; kept: Array<{ words: string }> }; placeArtifact: (id: string) => Promise<{ shape: string }>; artifacts: () => { answer: { artifacts: Array<{ id: string }> } | null; project: string | null } } };

/** FIXTURE: tray's operation's run detail, as src/ops/run-detail.ts makes one (its paths absolute, as a producer writes them). */
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
    prediction: null,
    checks: [],
    files: [
      { path: `${root}/BUILD.md`, role: 'input', sha256: 'ab'.repeat(32), from: 'receipt 1a2b3c4d' },
      { path: `${root}/out/tray.stl`, role: 'output', sha256: 'cd'.repeat(32), from: 'receipt 1a2b3c4d' },
      { path: `${root}/out/build.log`, role: 'log', from: 'jobs/j1.json' },
    ],
    receipts: [{ id: '1a2b3c4d', kind: 'workflow', subject: 'FIXTURE BUILD.md build' }, { id: '0f0e0d0c', kind: 'predict', subject: 'FIXTURE prediction' }],
    cost: { usd: null, measured: false, why: 'FIXTURE: no model was called' },
    summary: { path: null },
    next: { words: 'FIXTURE: look at out/tray.stl', command: `/op ${op}` },
    unknown: [],
  } as unknown as RunDetail;
}

describe.skipIf(!browserPath)("Studio's project-linked artifacts: an artifact card shows its artifact and opens its preview, its project's only (real browser)", () => {
  const kit = tempKit();
  let pageRoot = '';
  let home = '';
  let base = '';
  let port = 0;
  let server: StudioServer;
  let browser: Browser;
  const dirs: string[] = [];
  let tray: Project;
  let blank: Project;
  let trayVox = '';
  let blankVox = '';
  const trayOp = 'o1a2b3c4d';
  const asked: Array<{ op: string; project: string }> = [];
  /**
   * This file's own receipts store: the records are sealed in beforeAll, and every test reads the same chain (the setup gives each
   * test a fresh empty TIMMY_STORE, so each test names this one again before it runs; the canvas server's receipt pages read it).
   */
  let fileStore = '';
  beforeEach(() => { process.env.TIMMY_STORE = fileStore; });

  const project = (name: string): Project => {
    const root = join(mkdtempSync(join(tmpdir(), `timmy-art-${name}-`)), name);
    dirs.push(join(root, '..'));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'BUILD.md'), `# ${name} build\n\n\`\`\`bash [name:build]\necho ${name}\n\`\`\`\n`);
    return { name, root, id: projectId(root) };
  };

  beforeAll(async () => {
    fileStore = join(mkdtempSync(join(tmpdir(), 'timmy-art-store-')), 'receipts');
    mkdirSync(fileStore, { recursive: true });
    dirs.push(join(fileStore, '..'));
    process.env.TIMMY_STORE = fileStore;
    tray = project('tray');
    blank = project('blank');
    // FAKE images, 2:1 as the FAKE Look reports them (4 x 2 px: the record keeps what the tool said), drawn larger here so a
    // capture can be read: tray's red then blue, blank's green then grey
    put(tray.root, 'refs/photo.png', png(160, 80, (x) => (x < 80 ? [200, 10, 10] : [10, 10, 200])));
    put(blank.root, 'refs/photo.png', png(160, 80, (x) => (x < 80 ? [10, 160, 10] : [90, 90, 90])));
    trayVox = await act(kit, tray.root, (ws) => ws.detect('refs/photo.png color 200,10,10'), { FAKE_QR: 'tray vox' });
    blankVox = await act(kit, blank.root, (ws) => ws.detect('refs/photo.png color 10,160,10'), { FAKE_QR: 'blank vox' });
    // FAKE: tray's operation (one workflow run), through Timmy's own record writer
    const w = writeOperationRecord(tray.root, {
      schema: 'timmy.operation/1', id: trayOp, request: '/run BUILD.md build (FAKE operation, written by the test)', via: 'repl', project: 'tray',
      started: '2026-10-16T10:00:00.000Z', ended: '2026-10-16T10:00:05.000Z', state: 'succeeded', why: 'its run completed', parent: null,
      runs: [{ kind: 'workflow', id: 'j1', at: '2026-10-16T10:00:00.000Z' }], owner: { pid: process.pid, started: '2026-10-16T09:59:00.000Z' },
    } as never);
    expect(w.ok).toBe(true);
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-art-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-art-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    server = await startStudioServer(0, {
      env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, PATH: process.env.PATH }, root: pageRoot, projectTokenFile: true, followEveryMs: 100, followGraceMs: 200,
      // FIXTURE: the run detail of tray's operation (and nothing for any other)
      runDetail: (op, o) => { asked.push({ op, project: o.project }); if (o.project !== tray.root || op !== trayOp) throw new Error(`FIXTURE: no run detail of ${op} here`); return fixtureDetail(op, o.project); },
    });
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    await named(tray);
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 240_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    await kit.cleanup();
    for (const d of [...dirs, pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  /** The REPL's /canvas open: it names `p`, with its holder id and the receipts store it seals to (this file's chain). */
  const named = (p: Project) => nameProject(port, server.projectToken, { root: p.root, name: p.name, holder: HOLDER, receipts: process.env.TIMMY_STORE! });
  /** The Workbench's p: the active project of this Timmy home (the server follows it). */
  function workbench(p: Project): void {
    const file = activeProjectFile({ TIMMY_HOME: home });
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ name: p.name, root: p.root, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  /** Every file of project `p`'s board, with its sha256 ({} before it has any). */
  function files(p: Project): Record<string, string> {
    const dir = boardDir(join(home, 'canvas'), p.id);
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
      let names: string[] = [];
      try { names = readdirSync(d); } catch { return; }
      for (const n of names.sort()) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else out[relative(dir, f)] = sha(readFileSync(f)); }
    };
    walk(dir);
    return out;
  }
  const boardText = (p: Project): string => { try { return readFileSync(join(boardDir(join(home, 'canvas'), p.id), 'canvas.json'), 'utf8'); } catch { return ''; } };

  interface Studio { page: Page; context: BrowserContext; errors: string[] }
  async function open(): Promise<Studio> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === base || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.route(ANY_URL, passOn);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 409 \(Conflict\)/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${base}/#code=${await grant(port, server.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    return { page, context, errors };
  }
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
  async function shows(page: Page, p: Project): Promise<void> {
    await page.waitForFunction((id) => { const t = (window as never as Win).timmyCanvas; return t?.identity.state === 'shown' && t.identity.project?.id === id && t.project?.id === id; }, p.id, { timeout: 20_000 });
    await page.waitForFunction((n) => (document.getElementById('artifacts-name')?.textContent ?? '').startsWith(`${n} · `), p.name, { timeout: 20_000 });
    // the Artifacts list starts folded (the panel keeps its room): a person opens it
    if (!(await page.evaluate(() => (document.getElementById('artifacts') as HTMLDetailsElement).open))) await page.click('#artifacts > summary');
  }
  const savedState = (page: Page) => page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: 15_000 });
  async function capture(page: Page, name: string): Promise<void> {
    if (!CAPTURES) return;
    mkdirSync(CAPTURES, { recursive: true });
    await page.evaluate(() => {
      if (document.getElementById('fake-band')) return;
      const b = document.createElement('div');
      b.id = 'fake-band';
      b.textContent = 'SCRIPTED TEST · headless Chromium · FAKE VoxVision records (FAKE Look, a test double) · FAKE operation, FIXTURE run detail · disposable projects tray and blank';
      Object.assign(b.style, { position: 'fixed', right: '8px', bottom: '8px', zIndex: '400', padding: '4px 8px', background: '#070707', color: '#F2EFE9', border: '1px solid #444444', font: '12px/1.4 monospace', pointerEvents: 'none' });
      document.body.append(b);
    });
    await page.screenshot({ path: join(CAPTURES, `${name}.png`) });
  }
  /** The artifact cards on the board on screen: their artifact, project and type. */
  const cardsOnBoard = (page: Page) => page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentPageShapes().filter((s) => s.type === 'timmy-artifact').map((s) => ({ id: s.id, card: s.props.card, projectId: s.props.projectId })));

  it('the server: the list of tray\'s artifacts only, a VoxVision record\'s preview and image, refused without a credential and for another project', async () => {
    const session = await pageSession(port, server.projectToken);
    const list = await call(port, 'GET', `/api/project/artifacts?project=${tray.id}`, { headers: bearer(session) });
    expect(list.status).toBe(200);
    const rows = list.json.artifacts as Array<{ id: string; kind: string; title: string; receipt: { verified: boolean; short: string } | null; fake: boolean; preview: Record<string, string> }>;
    expect(list.json.project).toEqual({ id: tray.id, name: 'tray' });
    // tray's VoxVision record (FAKE), its operation (FAKE) and its receipts; nothing of blank's
    expect(rows.find((r) => r.id === `vox:${trayVox}`)).toMatchObject({ kind: 'vox', title: 'detect refs/photo.png', fake: true, receipt: { verified: true }, preview: { kind: 'vox', id: trayVox } });
    expect(rows.find((r) => r.id === `run:${trayOp}`)).toMatchObject({ kind: 'run', preview: { kind: 'run', op: trayOp } });
    expect(rows.some((r) => r.id === `vox:${blankVox}`)).toBe(false);
    const chain = readChain('runs');
    const blankShorts = chain.filter((r) => r.project_id === blank.id).map((r) => r.hash.slice(7, 15));
    expect(blankShorts.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.kind === 'receipt').map((r) => r.id.slice('receipt:'.length)).some((s) => blankShorts.includes(s))).toBe(false);
    // a record's preview and an image it names; nothing without a credential; nothing of a project the canvas does not show
    const pv = await call(port, 'GET', `/api/project/artifact/vox?id=${trayVox}&project=${tray.id}`, { headers: bearer(session) });
    expect(pv.status).toBe(200);
    expect((pv.json.preview as { overlays: unknown[] }).overlays.length).toBe(3);
    expect((await call(port, 'GET', `/api/project/artifact/vox-file?id=${trayVox}&path=refs%2Fphoto.png&project=${tray.id}`, { headers: bearer(session) })).headers['content-type']).toMatch(/^image\/png/);
    expect((await call(port, 'GET', '/api/project/artifacts')).status).toBe(401);
    const other = await call(port, 'GET', `/api/project/artifacts?project=${blank.id}`, { headers: bearer(session) });
    expect(other.status).toBe(409);
    expect(other.json).toMatchObject({ notShown: true, shows: { id: tray.id, name: 'tray' } });
    // blank's record is not tray's: asked through tray, it is not there
    expect((await call(port, 'GET', `/api/project/artifact/vox?id=${blankVox}&project=${tray.id}`, { headers: bearer(session) })).status).toBe(404);
  });

  it("an artifact card on tray's board shows tray's VoxVision record (its image, what was measured over it, its receipt verified now) and opens its preview; a run card shows its outputs and receipts and opens its run detail; a receipt card opens its receipt page; blank's board is untouched", async () => {
    const blankBefore = files(blank);
    const s = await open();
    const { page } = s;
    try {
      await shows(page, tray);
      // the list: tray's artifacts, each with Place on the board
      const row = page.locator(`#artifact-list li[data-artifact="vox:${trayVox}"]`);
      await row.waitFor({ timeout: 15_000 });
      expect(await row.getAttribute('data-project')).toBe(tray.id);
      expect(await page.locator(`#artifact-list li[data-artifact="vox:${blankVox}"]`).count()).toBe(0);
      // (R10 H167: in words, the file by its name; the record's whole title, its place included, under the item's Details)
      expect((await row.textContent()) ?? '').toMatch(/VoxVision record\s*detect photo\.png\s*FAKE/);
      expect(await row.locator('.aitem-more').textContent()).toContain('detect refs/photo.png');
      // Place on the board: the card shows the artifact
      await row.locator('button.aitem-place').click();
      const card = page.locator(`[data-artifact="vox:${trayVox}"].ta`);
      await card.waitFor({ timeout: 15_000 });
      expect(await card.getAttribute('data-project')).toBe(tray.id);
      await page.waitForFunction((id) => { const img = document.querySelector(`[data-artifact="vox:${id}"] img[data-ta-image="refs/photo.png"]`) as HTMLImageElement | null; return !!img && img.complete && img.naturalWidth === 160; }, trayVox, { timeout: 15_000 });
      // what was measured over it, drawn in the image's frame (4 x 2 px, as the record says), each labelled
      const ov = await card.locator('svg.ta-overlay').evaluate((svg) => ({ box: svg.getAttribute('viewBox'), shapes: [...svg.children].map((c) => [c.tagName, c.getAttribute('data-ov')]) }));
      expect(ov).toEqual({ box: '0 0 4 2', shapes: [['polygon', 'qr-1#1'], ['rect', 'color-region#1'], ['circle', 'color-region#2']] });
      expect(await card.locator('.ta-legend li').allTextContents()).toEqual(['⬠ QR 1 "tray vox" · measured · constructed', '▭ colour region rgb(200, 10, 10) · measured · constructed', '• centroid · measured · constructed']);
      expect(await text(page, `[data-artifact="vox:${trayVox}"] .ta-fake`)).toBe('FAKE');
      expect(await text(page, `[data-artifact="vox:${trayVox}"] .ta-fake-words`)).toBe('FAKE: made by a test double (timmy-look fake), not by the real tool');
      // its receipt: green only because it verifies now
      // (R10 H167: in words on the card; the receipt's id is its tip)
      const receipt = card.locator('.ta-receipt');
      expect(await receipt.textContent()).toBe('✓ sealed and verified');
      expect(await receipt.getAttribute('title')).toMatch(/^receipt [0-9a-f]{8}$/);
      expect(await receipt.evaluate((e) => getComputedStyle(e).color)).toBe('rgb(40, 254, 20)');
      await savedState(page);
      await capture(page, '01-tray-vox-artifact-card');
      // its one action: Open preview, Studio's VoxVision preview in the side panel (tray's record, every image with its overlays)
      expect(await card.locator('button.ta-open').allTextContents()).toEqual(['Open preview']);
      await card.locator('button.ta-open').click();
      await page.waitForFunction((id) => document.getElementById('artifact-preview')?.dataset.vox === id && /detect · ok$/.test(document.getElementById('artifact-preview-title')?.textContent ?? ''), trayVox, { timeout: 15_000 });
      expect(await page.getAttribute('#artifact-preview', 'data-project')).toBe(tray.id);
      expect(await text(page, '#artifact-preview-fake')).toBe('FAKE: made by a test double (timmy-look fake), not by the real tool');
      await page.waitForFunction(() => document.querySelectorAll('#artifact-preview-images img[data-ta-image]').length === 2, null, { timeout: 15_000 });
      expect(await page.locator('#artifact-preview-images img[data-ta-image]').evaluateAll((l) => l.map((e) => e.getAttribute('data-ta-image')))).toEqual(['refs/photo.png', `results/vox/${trayVox}/annotated.png`]);
      expect(await page.locator('#artifact-preview-images figure').first().locator('svg.ta-overlay > *').count()).toBe(3);
      expect(await text(page, '#artifact-preview-body .ap-receipt')).toBe('✓ sealed and verified');
      expect(await text(page, '#artifact-preview-body .ap-companion')).toBe(`The companion's tab 5 shows this record in full (its entity tree, frames, pipeline and engines): in the Workbench, 5, select ${trayVox}, then c.`);
      expect(await text(page, '#artifact-preview-body code.rd-cmd')).toBe(`/open results/vox/${trayVox}.json`);
      await capture(page, '02-tray-vox-preview');

      // a run: its card shows its outputs and receipts (its run detail's) and opens its run detail
      await page.locator(`#artifact-list li[data-artifact="run:${trayOp}"] button.aitem-place`).click();
      const run = page.locator(`[data-artifact="run:${trayOp}"].ta`);
      await run.waitFor({ timeout: 15_000 });
      await page.waitForFunction((op) => document.querySelectorAll(`[data-artifact="run:${op}"] [data-ta-file]`).length === 2, trayOp, { timeout: 15_000 });
      expect(await run.locator('[data-ta-file]').evaluateAll((l) => l.map((e) => e.getAttribute('data-ta-file')))).toEqual(['./out/tray.stl', './out/build.log']);
      expect(await run.locator('[data-ta-receipt]').evaluateAll((l) => l.map((e) => e.getAttribute('data-ta-receipt')))).toEqual(['1a2b3c4d', '0f0e0d0c']);
      expect(await text(page, `[data-artifact="run:${trayOp}"] .ta-verdict`)).toBe("Timmy's verdict: completed · FIXTURE: the build ran and its outputs are there");
      expect(await run.locator('button.ta-open').allTextContents()).toEqual(['Open run detail']);
      await run.locator('button.ta-open').click();
      await page.waitForFunction((op) => document.getElementById('run-detail')?.dataset.op === op && document.getElementById('run-detail')?.dataset.state === 'shown', trayOp, { timeout: 15_000 });
      expect(asked.every((a) => a.project === tray.root)).toBe(true);

      // a receipt: its card says whether it verifies now, and opens Studio's receipt page
      const receiptRow = page.locator('#artifact-list li[data-artifact^="receipt:"]').first();
      const rid = (await receiptRow.getAttribute('data-artifact'))!.slice('receipt:'.length);
      await receiptRow.locator('button.aitem-place').click();
      const rc = page.locator(`[data-artifact="receipt:${rid}"].ta`);
      await rc.waitFor({ timeout: 15_000 });
      expect(await rc.locator('.ta-receipt').textContent()).toBe('✓ sealed and verified');
      expect(await rc.locator('.ta-receipt').getAttribute('title')).toBe(`receipt ${rid}`);
      const [popup] = await Promise.all([s.context.waitForEvent('page'), rc.locator('button.ta-open').click()]);
      await popup.waitForLoadState();
      expect(new URL(popup.url()).pathname).toBe(`/receipts/${rid}`);
      expect(await popup.textContent('.verdict')).toBe(`✓ RECEIPT ${rid} signed and verified`);
      await popup.close();
      await savedState(page);
      await capture(page, '03-tray-three-artifact-cards');

      // what tray's board holds of them on disk: their names, never an image, never a verified mark
      const saved = boardText(tray);
      expect(saved).toContain(`"card":"vox:${trayVox}"`);
      expect(saved).not.toMatch(/sealed and verified/);
      expect(saved).not.toMatch(/data:image|blob:/);
      expect(files(blank)).toEqual(blankBefore);
      expect(s.errors).toEqual([]);
    } finally {
      await s.context.close();
    }
  });

  it("switching to blank: tray's cards and preview are gone from screen, blank's list is blank's own, a placement pending across the switch places nothing on either board", async () => {
    const s = await open();
    const { page } = s;
    try {
      await shows(page, tray);
      await page.locator(`#artifact-list li[data-artifact="vox:${trayVox}"]`).waitFor({ timeout: 15_000 });
      const trayCards = (await cardsOnBoard(page)).length;
      expect(trayCards).toBe(3);
      const trayBefore = files(tray);
      const blankBefore = files(blank);
      // a placement whose reading is held until the switch to blank has begun
      let release: () => void = () => {};
      const gate = new Promise<void>((done) => { release = done; });
      let taken = false;
      let seen = false;
      let routed = 0;
      const holdIt = async (route: Route): Promise<void> => {
        routed += 1;
        const u = new URL(route.request().url());
        if (taken || u.pathname !== '/api/project/artifacts') { await route.fallback(); return; }
        taken = true;
        // R10 (H167; it failed once in a whole studio run at 2 workers, the kept note missing): the reading is answered for tray
        // before the switch begins (`seen` once it is answered), then held. `seen` had been set before the request reached the
        // server, so on a loaded computer the switch could come first, the server answered for blank, and the page dropped the
        // reading without a note (there was no reading of tray's to note)
        const answered = await route.fetch();
        seen = true;
        await gate;
        await route.fulfill({ response: answered });
      };
      await page.route(ANY_URL, holdIt);
      const placing = page.evaluate((id) => (window as never as Win).timmyCanvas.placeArtifact(id).then(() => 'placed', (e: Error) => e.message), `vox:${trayVox}`);
      for (let i = 0; i < 100 && !seen; i++) await page.waitForTimeout(50);
      expect(seen).toBe(true);
      workbench(blank);
      await named(blank);
      await page.waitForFunction((id) => (window as never as Win).timmyCanvas.identity.switching?.id === id || (window as never as Win).timmyCanvas.identity.project?.id === id, blank.id, { timeout: 20_000 });
      release();
      expect(await placing).toBe('Not placed: Studio switched boards while it read tray\'s artifacts, so nothing was placed on either board.');
      await page.unroute(ANY_URL, holdIt);
      await gone(page, () => routed);
      await shows(page, blank);
      // blank's board: none of tray's cards; blank's list: blank's record only
      expect(await cardsOnBoard(page)).toEqual([]);
      await page.locator(`#artifact-list li[data-artifact="vox:${blankVox}"]`).waitFor({ timeout: 15_000 });
      expect(await page.locator(`#artifact-list li[data-artifact="vox:${trayVox}"]`).count()).toBe(0);
      expect(await page.locator('#artifact-list li').evaluateAll((l) => l.every((e) => e.getAttribute('data-project') === e.ownerDocument.defaultView!.document.querySelector('#artifact-list li')?.getAttribute('data-project')))).toBe(true);
      expect(await page.locator('#artifact-list li').first().getAttribute('data-project')).toBe(blank.id);
      expect(await page.isHidden('#artifact-preview')).toBe(true);
      const kept = await page.evaluate(() => (window as never as Win).timmyCanvas.identity.kept.map((k) => k.words));
      expect(kept.some((w) => /^A reading of tray \(its artifacts\) came back after Studio switched to blank: it was dropped/.test(w))).toBe(true);
      // nothing was written to either board by the placement that was refused
      await page.waitForTimeout(800);
      expect(files(blank)).toEqual(blankBefore);
      expect(Object.keys(files(tray))).toEqual(Object.keys(trayBefore));
      expect(boardText(tray).split('"type":"timmy-artifact"').length - 1).toBe(trayCards);
      await capture(page, '04-blank-after-switch');
      // back on tray: its three cards, its own
      workbench(tray);
      await named(tray);
      await shows(page, tray);
      await page.waitForFunction((n) => (window as never as Win).timmyCanvas.editor.getCurrentPageShapes().filter((x) => x.type === 'timmy-artifact').length === n, trayCards, { timeout: 15_000 });
      expect((await cardsOnBoard(page)).every((c) => c.projectId === tray.id)).toBe(true);
      expect(s.errors).toEqual([]);
    } finally {
      await s.context.close();
    }
  });
});
