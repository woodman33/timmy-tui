/**
 * R11 round 7 (H176): the guided blank public starters in Studio, in a real headless Chromium against the real canvas server and
 * the real bundle (built here into a temporary folder), with a real temporary Timmy home and two disposable projects: tray (real
 * record files of every kind: tests/helpers/canvas-project.ts) and blank (one workflow document). What is checked, by reading the
 * page and the disk:
 *   - New board offers the three Houdini starters (H1 handoff, H2 cookbook, H3 pipeline atlas) under their own group, and opens
 *     each on a page of tray's board named for it: the records starters.js makes (the installed tldraw drew them: fresh ids, the
 *     recovered meta on every shape, every arrow bound at both ends), saved to tray's board while blank's board files stay
 *     byte-identical; a page opened again (a new grant: the board reopened from disk) holds them still, bindings and all
 *     (save/reopen, project isolation);
 *   - the parameter / native-operation binding: a parameter node added from Nodes lands inside the starter's step 02 frame (the
 *     slot grown to show it), a workflow node in step 03, a result node in step 01; a second parameter node goes where the
 *     free-spot rule puts it (the slot is full); each is the project's own drawn card, saved with its parent, there after a reopen.
 * Nothing here runs a recipe, a model or Houdini: the cards are diagrams here (no REPL holds tray's actions), and the test says so.
 * Skipped, saying so, where no Chromium or Chrome is found. Captures (PNG) only when TIMMY_R7_CAPTURES names a folder, each with
 * a band that says it is FAKE and scripted.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SLOT_INSET } from '../companion/studio-canvas/src/starters.js';
import { projectId } from '../src/project/index.js';
import { activeProjectFile } from '../src/studio/active-follow.js';
import { boardDir } from '../src/studio/boards.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { starterTemplates } from '../src/studio/templates.js';
import { grant, nameProject } from './helpers/canvas-auth.js';
import { makeCanvasProject, type CanvasProject } from './helpers/canvas-project.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-starters-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const HOLDER = 'b'.repeat(32);
const CAPTURES = process.env.TIMMY_R7_CAPTURES?.trim() || '';
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
type Project = { name: string; root: string; id: string; jobs: string; receipts: string };
type Rec = { id: string; type: string; typeName: string; x: number; y: number; parentId: string; props: Record<string, unknown>; meta: Record<string, unknown> };
type Win = { timmyCanvas: {
  editor: { getCurrentPage: () => { id: string; name: string }; getPages: () => Array<{ id: string; name: string }>; setCurrentPage: (id: string) => void; getCurrentPageShapes: () => Rec[]; getBindingsFromShape: (id: string, type: string) => Array<{ toId: string; props: { terminal: string; isPrecise: boolean } }>; getShape: (id: string) => Rec | undefined };
  identity: { project: { id: string } | null; state: string };
  addNode: (kind: string, id: string) => Promise<{ words: string; shape?: string; slot?: string | null }>;
} };
/** A page's shapes as the test reads them: id, type, parent, position, size, name, words and the meta the starter wrote. */
type Shape = { id: string; type: string; parentId: string; x: number; y: number; w: number; h: number; name: string; text: string; meta: Record<string, unknown>; ends: Array<[string, string, boolean]> };

describe.skipIf(!browserPath)('the guided blank public starters in Studio (real browser)', () => {
  let canvasProject: CanvasProject;
  let pageRoot = '';
  let home = '';
  let base = '';
  let port = 0;
  let server: StudioServer;
  let browser: Browser;
  const dirs: string[] = [];
  let tray: Project;
  let blank: Project;
  /** what the starters' pages held when the first test ended (by page name) */
  let opened: Record<string, Shape[]> = {};

  beforeAll(async () => {
    canvasProject = await makeCanvasProject('timmy-starters-tray-');
    dirs.push(canvasProject.base);
    tray = { name: 'tray', root: canvasProject.root, id: projectId(canvasProject.root), jobs: canvasProject.jobs, receipts: canvasProject.store };
    const b = mkdtempSync(join(tmpdir(), 'timmy-starters-blank-'));
    dirs.push(b);
    mkdirSync(join(b, 'blank'), { recursive: true });
    mkdirSync(join(b, 'jobs'), { recursive: true });
    mkdirSync(join(b, 'store'), { recursive: true });
    writeFileSync(join(b, 'blank', 'BUILD.md'), '# blank build\n\n```bash [name:build]\necho blank\n```\n');
    blank = { name: 'blank', root: join(b, 'blank'), id: projectId(join(b, 'blank')), jobs: join(b, 'jobs'), receipts: join(b, 'store') };
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-starters-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-starters-home-'));
    dirs.push(pageRoot, home);
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, PATH: process.env.PATH }, root: pageRoot, projectTokenFile: true, followEveryMs: 100, followGraceMs: 200 });
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    workbench(tray);
    await nameProject(port, server.projectToken, { root: tray.root, name: tray.name, holder: HOLDER, jobs: tray.jobs, receipts: tray.receipts });
    // blank has a board folder of its own once the server has seen it named; here it is only another project whose files must stay
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 240_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of dirs) if (d) rmSync(d, { recursive: true, force: true });
  });

  /** The Workbench's p: the active project of this Timmy home (the server follows it). */
  function workbench(p: Project): void {
    const file = activeProjectFile({ TIMMY_HOME: home });
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ name: p.name, root: p.root, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  const board = (p: Project): string => boardDir(join(home, 'canvas'), p.id);
  /** Every file of project `p`'s board, with its sha256 ({} before it has any). */
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
  /** The records tray's board holds on disk: shapes and bindings. */
  function saved(p: Project): { shapes: Rec[]; bindings: Array<{ fromId: string; toId: string }> } {
    let snap: { store?: Record<string, Rec & { fromId?: string; toId?: string }> } = {};
    try { snap = (JSON.parse(readFileSync(join(board(p), 'canvas.json'), 'utf8')) as { snapshot: typeof snap }).snapshot; } catch { return { shapes: [], bindings: [] }; }
    const all = Object.values(snap.store ?? {});
    return { shapes: all.filter((r) => r.typeName === 'shape'), bindings: all.filter((r) => r.typeName === 'binding').map((r) => ({ fromId: String(r.fromId), toId: String(r.toId) })) };
  }
  async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`not in time: ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  interface Studio { page: Page; context: BrowserContext; errors: string[] }
  async function open(size = { width: 1440, height: 900 }): Promise<Studio> {
    const context = await browser.newContext({ viewport: size });
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === base || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 409 \(Conflict\)/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${base}/#code=${await grant(port, server.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.waitForFunction((id) => { const t = (window as never as Win).timmyCanvas; return t?.identity.state === 'shown' && t.identity.project?.id === id; }, tray.id, { timeout: 20_000 });
    return { page, context, errors };
  }
  const savedState = (page: Page) => page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: 15_000 });
  /** The shapes of the page shown, as Shape, in the editor's order. */
  const shapesOn = (page: Page): Promise<Shape[]> => page.evaluate(() => {
    const e = (window as never as Win).timmyCanvas.editor;
    const words = (rich: unknown): string => { const out: string[] = []; const walk = (n: { text?: string; content?: unknown[] } | undefined): void => { if (!n) return; if (typeof n.text === 'string') out.push(n.text); for (const c of n.content ?? []) walk(c as never); }; walk(rich as never); return out.join(' '); };
    return e.getCurrentPageShapes().map((s) => ({
      id: s.id, type: s.type, parentId: s.parentId, x: s.x, y: s.y, w: Number(s.props.w ?? 0), h: Number(s.props.h ?? 0), name: String(s.props.name ?? ''), text: words(s.props.richText), meta: s.meta,
      ends: s.type === 'arrow' ? e.getBindingsFromShape(s.id, 'arrow').map((b) => [b.props.terminal, b.toId, b.props.isPrecise] as [string, string, boolean]).sort() : [],
    }));
  });
  const currentPage = (page: Page) => page.evaluate(() => { const e = (window as never as Win).timmyCanvas.editor; return e.getCurrentPage().name; });
  async function goToPage(page: Page, name: string): Promise<void> {
    await page.evaluate((n) => { const e = (window as never as Win).timmyCanvas.editor; const p = e.getPages().find((x) => x.name === n); if (!p) throw new Error(`no page ${n}`); e.setCurrentPage(p.id); }, name);
  }
  async function capture(page: Page, name: string): Promise<void> {
    if (!CAPTURES) return;
    mkdirSync(CAPTURES, { recursive: true });
    await page.evaluate(() => {
      if (document.getElementById('fake-band')) return;
      const b = document.createElement('div');
      b.id = 'fake-band';
      b.textContent = 'SCRIPTED TEST · headless Chromium · records written by the test (FIXTURES in their shapes) · disposable projects tray and blank · no REPL holds the project: the cards are diagrams';
      Object.assign(b.style, { position: 'fixed', right: '8px', bottom: '8px', zIndex: '400', maxWidth: '60vw', padding: '4px 8px', background: '#070707', color: '#F2EFE9', border: '1px solid #444444', font: '12px/1.4 monospace', pointerEvents: 'none' });
      document.body.append(b);
    });
    await page.screenshot({ path: join(CAPTURES, `${name}.png`) });
  }

  it("New board offers the three Houdini starters and opens each on a page of tray's board: the records starters.js makes, every arrow bound, saved to tray's board, blank's files untouched", async () => {
    const s = await open();
    const { page } = s;
    try {
      const starters = starterTemplates();
      expect(starters.map((t) => t.id)).toEqual(['H1', 'H2', 'H3']);
      // the picker: its own group, after the guided boards (the list is fetched as the panel connects: waited for)
      await page.waitForFunction(() => document.querySelectorAll('#board-pick optgroup').length >= 3, null, { timeout: 15_000 });
      const groups = await page.$$eval('#board-pick optgroup', (gs) => gs.map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => [o.value, o.textContent])]));
      expect(groups.map((g) => g[0])).toEqual(['Guided, blank', 'Houdini starters, blank', 'Seeds, blank']);
      expect(groups[1][1]).toEqual([['H1', 'Houdini handoff'], ['H2', 'Houdini cookbook'], ['H3', 'Houdini pipeline atlas']]);
      const blankBefore = files(blank);
      for (const t of starters) {
        const trayBefore = files(tray)['canvas.json'] ?? '';
        await page.selectOption('#board-pick', t.id);
        await page.click('#board-open');
        await page.waitForFunction((title) => (document.getElementById('project-said')?.textContent ?? '').includes(`Opened the ${title} starter`), t.title, { timeout: 10_000 });
        expect(await currentPage(page)).toBe(t.title);
        const shapes = await shapesOn(page);
        // what starters.js makes: the title, the intro, three steps with a hint each and two flow arrows, the starter's cards, an arrow per binding
        expect(shapes).toHaveLength(2 + 3 * 2 + 2 + t.shapes.length + t.bindings.length);
        const roles = shapes.map((x) => String(x.meta.role));
        expect(roles.slice(0, 2)).toEqual(['title', 'intro']);
        expect(roles.filter((r) => r === 'step')).toHaveLength(3);
        expect(roles.filter((r) => r === 'hint')).toHaveLength(3);
        expect(shapes.filter((x) => x.type === 'arrow')).toHaveLength(2 + t.bindings.length);
        for (const x of shapes) {
          expect(Object.keys(x.meta).sort(), `${t.id} ${x.id}`).toEqual(['data', 'lane', 'page', 'role', 'timmyGuide', 'timmyStarter', 'timmyTemplate', 'workbench']);
          expect(x.meta.timmyTemplate).toBe(t.id);
          expect(x.meta.workbench).toBe('timmy-starter-v1');
          // every arrow bound at both ends, precisely, to shapes of this page
          if (x.type === 'arrow') {
            expect(x.ends.map((e) => [e[0], e[2]]), `${t.id} ${x.id}`).toEqual([['end', true], ['start', true]]);
            for (const e of x.ends) expect(shapes.some((y) => y.id === e[1]), `${t.id} ${x.id} is bound to ${e[1]}`).toBe(true);
          }
        }
        const steps = shapes.filter((x) => x.meta.role === 'step');
        expect(steps.map((x) => [x.type, x.name, (x.meta.timmyStarter as { slot: string }).slot])).toEqual([['frame', '01 · Define the geometry', 'result'], ['frame', '02 · Set the parameters', 'params'], ['frame', '03 · Cook in Houdini', 'workflow']]);
        expect(shapes.filter((x) => x.meta.role === 'hint').map((x) => [x.parentId, x.text])).toEqual(steps.map((st, i) => [st.id, t.steps[i].guide]));
        if (t.id === 'H3') {
          const ports = shapes.filter((x) => x.meta.role === 'port-binding');
          expect(ports.map((x) => x.text)).toEqual(['manifest', 'stage', 'stage', 'evidence', 'verdict']);
          expect(shapes.find((x) => x.meta.role === 'dag-order')!.text).toContain('manifest → skeleton → overrides → proof → gate → receipts');
        }
        // saved to tray's board (the bindings too), blank's files as they were
        await savedState(page);
        await until(`${t.id} saved to tray's board`, () => (files(tray)['canvas.json'] ?? '') !== trayBefore && saved(tray).shapes.some((r) => r.meta.timmyTemplate === t.id));
        const onDisk = saved(tray);
        for (const x of shapes) expect(onDisk.shapes.some((r) => r.id === x.id), `${t.id} ${x.id} on disk`).toBe(true);
        for (const x of shapes.filter((y) => y.type === 'arrow')) expect(onDisk.bindings.filter((b) => b.fromId === x.id)).toHaveLength(2);
        expect(files(blank)).toEqual(blankBefore);
        opened[t.title] = shapes;
        await capture(page, `starter-${t.id}-opened`);
      }
      // two openings of one starter never collide: the second gets its own ids on its own page
      await page.selectOption('#board-pick', 'H1');
      await page.click('#board-open');
      await page.waitForFunction(() => (document.getElementById('project-said')?.textContent ?? '').includes('Opened the Houdini handoff starter'), null, { timeout: 10_000 });
      expect(await currentPage(page)).toBe('Houdini handoff 2');
      const second = await shapesOn(page);
      expect(second).toHaveLength(opened['Houdini handoff'].length);
      expect(second.some((x) => opened['Houdini handoff'].some((y) => y.id === x.id))).toBe(false);
      await savedState(page);
      expect(s.errors).toEqual([]);
    } finally {
      await s.context.close();
    }
  }, 120_000);

  it('a page opened again (the board reopened from disk) holds each starter still, shapes, meta and bindings alike', async () => {
    expect(Object.keys(opened)).toEqual(['Houdini handoff', 'Houdini cookbook', 'Houdini pipeline atlas']);
    const s = await open();
    const { page } = s;
    try {
      for (const [name, before] of Object.entries(opened)) {
        await goToPage(page, name);
        const now = await shapesOn(page);
        const key = (x: Shape) => ({ ...x, ends: [...x.ends].sort() });
        expect(now.map(key).sort((a, b) => a.id.localeCompare(b.id)), name).toEqual(before.map(key).sort((a, b) => a.id.localeCompare(b.id)));
      }
      expect(s.errors).toEqual([]);
    } finally {
      await s.context.close();
    }
  });

  it("the parameter / native-operation binding: a parameter node from Nodes lands in step 02, a workflow node in step 03, a result node in step 01, each the project's own card, grown into, saved with its parent, there after a reopen", async () => {
    const s = await open();
    const { page } = s;
    try {
      await goToPage(page, 'Houdini handoff');
      // the project's cards as the page reads them (the palette draws from the same readings)
      await page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 15_000 });
      const stepIds = Object.fromEntries((await shapesOn(page)).filter((x) => x.meta.role === 'step').map((x) => [x.name.slice(0, 2), x.id]));
      const adds: Array<[string, string, string, RegExp]> = [
        ['params', 'params:box.params.json', '02', /It sits in the starter's step 02 · Set the parameters\.$/],
        ['workflow', 'workflow:BUILD.md', '03', /It sits in the starter's step 03 · Cook in Houdini\.$/],
        ['result', `flow:${canvasProject.flow}`, '01', /It sits in the starter's step 01 · Define the geometry\.$/],
      ];
      const placed: Array<{ id: string; step: string }> = [];
      for (const [kind, id, step, words] of adds) {
        const r = await page.evaluate(([k, i]) => (window as never as Win).timmyCanvas.addNode(k, i), [kind, id]);
        expect(r.words, kind).toMatch(words);
        expect(r.slot, kind).toBe(stepIds[step]);
        const card = (await shapesOn(page)).find((x) => x.id === r.shape)!;
        expect(card.parentId, kind).toBe(stepIds[step]);
        expect([card.x, card.y], kind).toEqual([SLOT_INSET.x, SLOT_INSET.y]);
        expect(card.type, kind).toBe(`timmy-${kind}`);
        placed.push({ id: card.id, step });
      }
      // each slot frame shows its card whole: grown to the card's height and width, never under the hint
      await page.waitForTimeout(500);
      const after = await shapesOn(page);
      for (const p of placed) {
        const frame = after.find((x) => x.id === stepIds[p.step])!;
        const card = after.find((x) => x.id === p.id)!;
        expect(frame.h, p.step).toBeGreaterThanOrEqual(card.y + card.h + SLOT_INSET.bottom);
        expect(frame.w, p.step).toBeGreaterThanOrEqual(card.x + card.w + SLOT_INSET.right);
      }
      // the slot is full: a second parameter node goes where the free-spot rule puts it, on the page, and says no step
      const again = await page.evaluate(() => (window as never as Win).timmyCanvas.addNode('params', 'params:recipes/tray.params.json'));
      expect(again.words).not.toMatch(/It sits in the starter's step/);
      expect(again.slot).toBeNull();
      const other = (await shapesOn(page)).find((x) => x.id === again.shape)!;
      expect(other.parentId.startsWith('page:')).toBe(true);
      // what runs: nothing here. No REPL holds tray's actions in this test, so each card says it is a diagram, in its own words
      const modes = await page.$$eval('.tc .tc-mode', (els) => els.map((e) => e.textContent ?? ''));
      expect(modes.length).toBeGreaterThanOrEqual(4);
      for (const m of modes) expect(m).toMatch(/No Timmy REPL takes tray's card actions now|diagram|Not read from Timmy yet|not followed/i);
      await savedState(page);
      await until('the slotted cards saved with their parents', () => placed.every((p) => saved(tray).shapes.some((r) => r.id === p.id && r.parentId === stepIds[p.step])));
      await capture(page, 'starter-H1-nodes-in-slots');
      expect(s.errors).toEqual([]);
      await s.context.close();
      // reopened: still in their steps
      const r = await open();
      try {
        await goToPage(r.page, 'Houdini handoff');
        const back = await shapesOn(r.page);
        for (const p of placed) expect(back.find((x) => x.id === p.id)?.parentId, p.step).toBe(stepIds[p.step]);
        expect(r.errors).toEqual([]);
      } finally {
        await r.context.close();
      }
    } catch (e) {
      await s.context.close().catch(() => undefined);
      throw e;
    }
  }, 120_000);
});
