/**
 * R9 (H160; R8's open item G′): tab 6 (3D & Motion) lists the project's meshes and recordings as items the cursor rests on,
 * before the tools (src/workbench/create-tab.ts createTabView, placed by familyView in src/workbench/views.ts). Before, they
 * were lines above the tools and the cursor's first item was the first tool, so the page opened with the meshes partly above
 * the window at 120×40 and wholly at 100×30 (R8's rehearsal). Now the page opens with the first mesh item in view, whole, at
 * every supported size: read from the screen the Workbench's own frame draws (Controller.frame, the rows Ink prints) at 60×16
 * (the smallest it draws), 80×24, 100×30, 120×40 and 160×45, the cursor's item and its words whole, no word of it cut.
 *
 * FAKE or FIXTURE, labelled: the project's meshes are the demo tray (examples/visual-tools, as scripts/demo-mesh.mjs wrote
 * it) in its three kinds; the recording is the repository's own (studio/ctx-c3w8/…/context.rrd, read, never changed); tab 6's
 * native tools are FAKE (test) rows, each "needs setup"; the chat session's and run detail's producers have none; the
 * browser opener and the server starts are FAKE (nothing is opened or served). Real: Timmy's STL, OBJ and PLY readers, its
 * Rerun header reader, the Workbench's controller, layout and frame.
 *
 * Step 2 (R9 H160): the items' actions, as the other tabs' items have theirs: Enter shows a mesh's measurements (a recording's
 * reading) in Context's Inspector; c (Companion · Show) opens the companion's tab 6 with the selected mesh chosen (its path in
 * the address, as hex); Context's Tools names both; Files (related only) shows its path; the body says the keys under each
 * list's heading. The companion's start and the browser opener are FAKE there (a FAKE server's address; the opener records).
 *
 * H160_CAPS, when set, names a folder for the screens as they open (one .txt per size).
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { Controller } from '../src/workbench/controller.js';
import { DOCTRINE_15 } from '../src/native/stl-readback.js';
import { CREATE_SENTENCE, createActions, createCompanionHint, createDetail, createItems, createTabView, type CreateItem } from '../src/workbench/create-tab.js';
import { glyphsFor, innerWidth, screenText } from '../src/workbench/frame.js';
import type { Frame } from '../src/workbench/screen.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import { launchPageHtml } from '../src/utils/launch-page.js';
import { plain } from '../src/workbench/text.js';
import { DEMO_MESH, DEMO_OBJ, DEMO_PLY } from '../scripts/demo-mesh.mjs';

const RRD = resolve('studio/ctx-c3w8/checkpoints/C5/exports/context.rrd');
const g = glyphsFor(true);
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
const SIZES = [[60, 16], [80, 24], [100, 30], [120, 40], [160, 45]] as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** FAKE (test) native tools for tab 6's list (the ids src/workbench/nav.ts FAMILY_ROWS puts there), each "needs setup". */
const FAKE_TOOLS = ['c4dpy', 'blender', 'openscad', 'freecad', 'unreal', 'recipe-tray', 'aerender', 'afterfx'].map((id) => ({
  id, kind: 'tool' as const, name: `FAKE (test) ${id}`, rung: 'needs setup' as const, detail: `FAKE (test): ${id} is not found here`, setup: `FAKE (test): install ${id}, then check again`,
}));

let box = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];
beforeAll(() => { box = mkdtempSync(join(tmpdir(), 'r9-wb-items-')); });
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  for (const c of opened.splice(0)) c.dispose();
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
  vi.unstubAllEnvs();
});

/** A Workbench over a project of its own with the demo tray in its three kinds and a recording. */
async function trayBench(name: string, o: { companion?: CompanionControl } = {}): Promise<{ c: Controller; root: string }> {
  const home = join(box, 'timmy');
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
  const jobsDir = join(home, 'jobs');
  mkdirSync(jobsDir, { recursive: true });
  const project = createProject(name);
  if ('error' in project) throw new Error(project.error);
  saveActiveProject(project);
  mkdirSync(join(project.root, 'refs'), { recursive: true });
  mkdirSync(join(project.root, 'rec'), { recursive: true });
  for (const f of [DEMO_MESH, DEMO_OBJ, DEMO_PLY]) copyFileSync(resolve(f), join(project.root, 'refs', f.split('/').pop()!));
  copyFileSync(RRD, join(project.root, 'rec', 'context.rrd'));
  const ws = new Workspace({ glyphs: glyphSet(true), env: process.env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t, seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined }, project);
  spaces.push(ws);
  const c = new Controller({
    env: process.env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws,
    producers: { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: async () => ({ ok: false, why: 'FIXTURE: no chat session in this test' }) },
    companion: o.companion ?? new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => FAKE_TOOLS, tickMs: 100, slowMs: 3_600_000,
  });
  opened.push(c);
  c.start();
  const end = Date.now() + 15_000;
  while (!c.data.frame && Date.now() < end) await sleep(50);
  // the tools are read once a tab that lists them is shown (tab 6 here)
  openTab6(c);
  while (c.data.caps.state !== 'ready' && Date.now() < end) await sleep(50);
  expect(c.data.frame, 'the workspace frame read').toBeTruthy();
  expect(c.data.caps.state, 'the tools read').toBe('ready');
  return { c, root: project.root };
}

/** The centre region's row `y` (a screen row) between its side borders. */
function rowAt(fr: Frame, y: number): string {
  const rect = fr.regions.center!.rect;
  const text = screenText(fr.screen)[y] ?? '';
  let x = 0;
  let out = '';
  for (const ch of text) { if (x > rect.x && x < rect.x + rect.w - 1) out += ch; x += visibleWidth(ch); }
  return out;
}

/** The screen rows an item of the centre region is drawn on, or why it is not wholly in view. */
function itemOnScreen(fr: Frame, i: number): { rows: string[] } | { out: string } {
  const reg = fr.regions.center!;
  const it = reg.items[i];
  if (!it) return { out: `there is no item ${i}` };
  const n = it.rows ?? 1;
  const rows: string[] = [];
  for (let k = 0; k < n; k++) {
    const line = it.line + k;
    if (line < reg.scroll || line >= reg.scroll + reg.height) return { out: `its row ${k + 1} of ${n} (line ${line}) is outside the window (lines ${reg.scroll} to ${reg.scroll + reg.height - 1})` };
    rows.push(rowAt(fr, reg.rect.y + 1 + reg.fixed + (line - reg.scroll)));
  }
  return { rows };
}

/** Tab 6 opened afresh (from Home, so a second 6 never turns it to its Motion view). */
function openTab6(c: Controller): void { c.key('1', {}); c.key('6', {}); }

/** A region's rows between its side borders, joined (whitespace squashed). */
function regionText(fr: Frame, region: 'center' | 'right'): string {
  const r = fr.regions[region]!.rect;
  const text = screenText(fr.screen);
  const out: string[] = [];
  for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
    let x = 0;
    let row = '';
    for (const ch of text[y] ?? '') { if (x > r.x && x < r.x + r.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(row);
  }
  return squash(out.join(' '));
}

/** The keyboard given to a zone (Tab around the zones). */
function focusOn(c: Controller, zone: 'center' | 'right'): void {
  for (let k = 0; k < 8 && c.ui.focus !== zone; k++) c.key('', { tab: true });
  expect(c.ui.focus).toBe(zone);
}

const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');

describe('the Workbench\'s tab 6: its meshes and recordings as items (R9 H160, R8\'s G′)', () => {
  it('each mesh and each recording is an item, listed before the tools, with the words it had as a line (createTabView)', async () => {
    const { c } = await trayBench('FAKE-items-order');
    openTab6(c);
    const fr = c.frame(160, 45);
    const reg = fr.regions.center!;
    const kinds = reg.items.map((x) => x.item.kind);
    // the meshes by path (OBJ, PLY, STL of the one tray), then the recording, then the tools
    expect(kinds.slice(0, 4)).toEqual(['mesh', 'mesh', 'mesh', 'recording']);
    expect(kinds.slice(4, 12)).toEqual(Array(8).fill('cap'));
    const own = reg.items.slice(0, 4).map((x) => x.item as CreateItem);
    expect(own.map((x) => (x.kind === 'mesh' ? x.mesh.path : x.rec.path))).toEqual(['refs/demo-tray.obj', 'refs/demo-tray.ply', 'refs/demo-tray.stl', 'rec/context.rrd']);
    // its words as the tab said them: the kind and what its reader measured from the whole file
    const v = createTabView({ data: c.data, width: innerWidth(reg.rect.w), height: reg.rect.h - 2, g, cursor: 0 });
    const words = (k: number): string => squash(v.lines.slice(v.items[k].line, v.items[k].line + (v.items[k].rows ?? 1)).map(plain).join(' '));
    expect(words(2)).toContain('refs/demo-tray.stl STL · 28 triangles · box 80 × 50 × 20 · edge-manifold: every edge shared by exactly two triangles, consistently oriented · volume 21392 (enclosed; normals outward)');
    expect(words(0)).toMatch(/^▸ refs\/demo-tray\.obj OBJ · 28 triangles/);
    expect(words(3)).toMatch(/^rec\/context\.rrd written by Rerun \d+\.\d+\.\d+ · \d+ data chunks · entities, frames and time range: unknown to Timmy \(inside the recording's data chunks/);
  }, 30_000);

  it('the page opens with the first mesh item in view, whole, the cursor on it, at 60x16, 80x24, 100x30, 120x40 and 160x45; the tab still says Unfinished', async () => {
    const { c } = await trayBench('FAKE-items-open');
    const caps = process.env.H160_CAPS;
    if (caps) mkdirSync(caps, { recursive: true });
    for (const [cols, rows] of SIZES) {
      const at = `tab 6 at ${cols}x${rows}, as it opens`;
      openTab6(c);
      const fr = c.frame(cols, rows);
      if (caps) writeFileSync(join(caps, `h160-tab6-${cols}x${rows}-open.txt`), `${screenText(fr.screen).join('\n')}\n`);
      const reg = fr.regions.center!;
      expect(c.ui.cursor[reg.list] ?? 0, at).toBe(0);
      expect(reg.items[0]?.item.kind, at).toBe('mesh');
      const first = reg.items[0].item as Extract<CreateItem, { kind: 'mesh' }>;
      expect(first.mesh.path, at).toBe('refs/demo-tray.obj');
      // in view, every row of it
      const seen = itemOnScreen(fr, 0);
      expect('rows' in seen ? '' : seen.out, at).toBe('');
      if (!('rows' in seen)) continue;
      // the cursor's mark on its first row; its words whole: the same words the view drew for it, no row ending cut
      expect(seen.rows[0].trimStart().startsWith(`${g.cursor} refs/demo-tray.obj`), `${at}: ${seen.rows[0]}`).toBe(true);
      const v = createTabView({ data: c.data, width: innerWidth(reg.rect.w), height: reg.rect.h - 2, g, cursor: 0 });
      const own = squash(v.lines.slice(v.items[0].line, v.items[0].line + (v.items[0].rows ?? 1)).map(plain).join(' '));
      expect(squash(seen.rows.join(' ')), at).toBe(own);
      expect(own, at).toMatch(/refs\/demo-tray\.obj OBJ · 28 triangles/);
      for (const r of seen.rows) expect(r.trimEnd().endsWith(g.ellipsis), `${at}: a row of it is cut: ${r}`).toBe(false);
      // tab 6 says it is unfinished, first, at every size
      expect(rowAt(fr, reg.rect.y + 1), at).toContain('◌ Unfinished');
    }
  }, 60_000);

  it('a moved cursor keeps each mesh and the recording whole in view, at 60x16 and 100x30', async () => {
    const { c } = await trayBench('FAKE-items-move');
    for (const [cols, rows] of [[60, 16], [100, 30]] as const) {
      openTab6(c);
      for (let k = 0; k < 6 && c.ui.focus !== 'center'; k++) c.key('', { tab: true });
      expect(c.ui.focus).toBe('center');
      // (a cursor moved at the size before is kept when the tab opens again: back to the first item)
      for (let k = 0; k < 6; k++) c.key('', { upArrow: true });
      for (let i = 0; i < 4; i++) {
        const at = `item ${i + 1} at ${cols}x${rows}`;
        if (i) c.key('', { downArrow: true });
        const fr = c.frame(cols, rows);
        const reg = fr.regions.center!;
        expect(c.ui.cursor[reg.list], at).toBe(i);
        const seen = itemOnScreen(fr, i);
        expect('rows' in seen ? '' : seen.out, at).toBe('');
        if (!('rows' in seen)) continue;
        expect(seen.rows[0].trimStart().startsWith(g.cursor), `${at}: ${seen.rows[0]}`).toBe(true);
        for (const r of seen.rows) expect(r.trimEnd().endsWith(g.ellipsis), `${at}: a row of it is cut: ${r}`).toBe(false);
      }
    }
  }, 60_000);
});

describe('tab 6\'s items\' actions: Enter, c, Context\'s Tools and Files (R9 H160)', () => {
  it('Enter on a mesh shows what its reader measured in Context\'s Inspector, whole (createDetail): the reader, DOCTRINE §15\'s sentence and c\'s words; on the recording, its reading with what stays unknown and why, and Rerun\'s viewer as found or not (found is not run)', async () => {
    const { c } = await trayBench('FAKE-items-enter');
    // 160x45: Context is a column beside the page (whose box is whole): Enter shows the mesh under Context's tabs
    openTab6(c);
    focusOn(c, 'center');
    c.ui.tab = 'tools';
    await c.enter();
    expect(c.ui.tab).toBe('inspector');
    let fr = c.frame(160, 45);
    expect(fr.layout.rightAs).toBe('column');
    let ctx = regionText(fr, 'right');
    expect(ctx).toMatch(/^Tools │ ▸ Inspector │ Files MESH · OBJ refs\/demo-tray\.obj Measured by Timmy's own OBJ reader \(timmy-obj-readback\/1\), from the whole file/);
    expect(ctx).toContain('Triangles 28');
    // 100x30: Context is a drawer, which Enter opens; where the page's Unfinished box is shortened its words come first in
    // Context (R8's G), and the keys scroll Context to the measurements (↓, as a box with no rows to select scrolls)
    c.frame(100, 30);
    focusOn(c, 'center');
    await c.enter();
    fr = c.frame(100, 30);
    expect(fr.layout.rightAs).toBe('drawer');
    ctx = regionText(fr, 'right');
    expect(ctx).toMatch(/^Tools │ ▸ Inspector │ Files ◌ UNFINISHED · THIS TAB Works now:/);
    focusOn(c, 'right');
    for (let k = 0; k < 40 && !/Triangles 28/.test(ctx); k++) { c.key('', { downArrow: true }); ctx = regionText(c.frame(100, 30), 'right'); }
    expect(ctx).toContain('Triangles 28');
    expect(ctx).toMatch(/MESH · OBJ refs\/demo-tray\.obj|Measured by Timmy's own OBJ reader|Corners/);
    // the whole of it, as Context draws it (its lines; the drawer scrolls)
    const items = createItems(c.data);
    const obj = items[0] as Extract<CreateItem, { kind: 'mesh' }>;
    const said = squash(createDetail(obj, 56, g).map(plain).join(' '));
    for (const words of [
      'MESH · OBJ refs/demo-tray.obj', 'Triangles 28', 'Box 80 × 50 × 20, from 0, 0, 0 to 80, 50, 20', 'Volume 21392 (enclosed; normals outward)',
      'Topology edge-manifold: every edge shared by exactly two triangles, consistently oriented',
      'Faces 14 faces: 14 with four or more corners', 'Ignored 1 comment, 1 o lines', 'File Wavefront OBJ (text)',
      'Says the file\'s own words (its first comment; not checked): TIMMY DEMO MESH: generated by scripts/demo-mesh.mjs, not measured or exported',
      'Origin not recorded: where the file came from is not recorded', 'View the companion\'s view you can turn: all 28 triangles',
      DOCTRINE_15, '[c] Companion · Show: the companion\'s tab 6 with this mesh chosen, in a view you can turn',
    ]) expect(said).toContain(squash(words));
    // nothing green: a measurement is not a live connection, a passed check or a sealed receipt
    expect(createDetail(obj, 56, g).flat().filter((x) => x.role === 'live')).toEqual([]);
    // the recording (the fourth item): Enter shows its reading (160x45: under Context's tabs)
    c.key('', { escape: true });
    c.frame(160, 45);
    focusOn(c, 'center');
    for (let k = 0; k < 3; k++) c.key('', { downArrow: true });
    expect(c.selected()?.kind).toBe('recording');
    await c.enter();
    ctx = regionText(c.frame(160, 45), 'right');
    expect(ctx).toMatch(/^Tools │ ▸ Inspector │ Files RECORDING · Rerun \(\.rrd\) rec\/context\.rrd Header written by Rerun \d+\.\d+\.\d+/);
    const rec = items[3] as Extract<CreateItem, { kind: 'recording' }>;
    const read = squash(createDetail(rec, 56, g).map(plain).join(' '));
    expect(read).toMatch(/Header written by Rerun \d+\.\d+\.\d+ · compression /);
    expect(read).toMatch(/Messages \d+ store info · \d+ data chunks/);
    expect(read).toContain(squash('Entities unknown to Timmy: inside the recording\'s data chunks (compressed Arrow), which Timmy does not decode; Rerun\'s viewer shows it'));
    expect(read).toContain('Time range unknown to Timmy:');
    expect(read).toMatch(rec.viewer.state === 'needs setup' ? /Viewer Rerun's viewer: needs setup/ : /Viewer Rerun's viewer: found \(installed here, not run\) Rerun's viewer is found here \([^)]*\): found is not run, and this tab runs nothing/);
  }, 60_000);

  it('Context\'s Tools names what Enter and c do to the selection, and the body says the keys under each list\'s heading; Files (related only) shows the mesh\'s path', async () => {
    const { c } = await trayBench('FAKE-items-tools');
    openTab6(c);
    focusOn(c, 'right');
    // ← → move Context's tabs (Tools, Inspector, Files)
    for (let k = 0; k < 3 && c.ui.tab !== 'tools'; k++) c.key('', { leftArrow: true });
    expect(c.ui.tab).toBe('tools');
    let fr = c.frame(160, 45);
    let ctx = regionText(fr, 'right');
    expect(ctx).toContain('For refs/demo-tray.obj, in FAKE-items-tools.');
    expect(ctx).toContain('[Enter] Its measurements, in full [c] Companion · Show, mesh chosen');
    // whole in Context's drawer too (its rows are cut, not wrapped: each label with its key and the mark fits its 36 cells)
    for (const it of createItems(c.data)) for (const a of createActions(it)) expect(2 + visibleWidth(`[${a.key}] ${a.label}`), a.label).toBeLessThanOrEqual(36);
    // the recording's (the fourth item)
    focusOn(c, 'center');
    for (let k = 0; k < 3; k++) c.key('', { downArrow: true });
    const atRec = c.frame(160, 45);
    expect(regionText(atRec, 'right')).toContain('For rec/context.rrd, in FAKE-items-tools. ▸ [Enter] Its reading, in full [c] Companion · Show: tab 6');
    expect(regionText(atRec, 'center')).toContain("RECORDINGS TIMMY CAN READ (1) [Enter] its reading in Context: its header's facts, and what stays unknown, with why ▸ rec/context.rrd");
    for (let k = 0; k < 3; k++) c.key('', { upArrow: true });
    focusOn(c, 'right');
    // the body: the keys, under the meshes' heading and the recordings'
    const body = regionText(fr, 'center');
    expect(body).toContain("MESHES IN THIS PROJECT (3) [Enter] its measurements in Context · [c] it chosen in the companion's view you can turn ▸ refs/demo-tray.obj");
    // Files, related only ([f]): the mesh's path
    for (let k = 0; k < 3 && c.ui.tab !== 'files'; k++) c.key('', { rightArrow: true });
    expect(c.ui.tab).toBe('files');
    c.key('f', {});
    expect(c.ui.related).toBe(true);
    fr = c.frame(160, 45);
    ctx = regionText(fr, 'right');
    expect(ctx).toMatch(/Related to refs\/demo-tray\.obj \[f\] all files .*refs\/demo-tray\.obj/);
    expect(ctx).not.toContain('none: the selection names no project file');
  }, 60_000);

  it('c on a mesh opens the companion\'s tab 6 with that mesh chosen (its path, as hex, in the address); on the recording or a tool, tab 6 alone (FAKE server and opener)', async () => {
    const hrefs: string[] = [];
    const companion = new CompanionControl({
      opener: { program: 'FAKE opener', open: (href) => { hrefs.push(href); return { ok: true }; } },
      start: async () => ({ port: 4399, url: 'http://127.0.0.1:4399/#t=FAKE', address: 'http://127.0.0.1:4399/', shutdown: async () => undefined }),
    });
    const { c } = await trayBench('FAKE-items-show', { companion });
    expect(createCompanionHint(createItems(c.data)[2])).toBe(`tab=create&mesh=${hex('refs/demo-tray.stl')}`);
    expect(createCompanionHint(null)).toBe('tab=create');
    try {
      openTab6(c);
      focusOn(c, 'center');
      const said = async (): Promise<string> => { await c.showCompanion(); return c.ui.flash?.text ?? ''; };
      // the first mesh (the cursor's as the tab opens), then the second
      expect(await said()).toContain(`The Companion opened in your browser (http://127.0.0.1:4399/?tab=create&mesh=${hex('refs/demo-tray.obj')}), through a private page that carries its key`);
      c.key('', { downArrow: true });
      expect(await said()).toContain(`?tab=create&mesh=${hex('refs/demo-tray.ply')})`);
      // the page carries the same address (the key after #)
      expect(readFileSync(fileURLToPath(hrefs[1]), 'utf8')).toBe(launchPageHtml(`http://127.0.0.1:4399/?tab=create&mesh=${hex('refs/demo-tray.ply')}#t=FAKE`));
      // the recording, then the first tool: tab 6 alone
      c.key('', { downArrow: true });
      c.key('', { downArrow: true });
      expect(await said()).toContain('(http://127.0.0.1:4399/?tab=create)');
      c.key('', { downArrow: true });
      expect(c.selected()?.kind).toBe('cap');
      expect(await said()).toContain('(http://127.0.0.1:4399/?tab=create)');
    } finally {
      // the private pages go with their minute or with the process; this test's worker does not end here, so it removes its own
      for (const h of hrefs) rmSync(dirname(fileURLToPath(h)), { recursive: true, force: true });
    }
  }, 60_000);
});

describe('tab 6 keeps its words as its meshes become items (R9 H160, step 3)', () => {
  it('at 60x16, 80x24, 100x30, 120x40 and 160x45: what was measured and by which reader, DOCTRINE §15\'s sentence and "no motion timeline" on the page, the same in Context for the cursor\'s mesh; tab 6 still marked unfinished on its page, its tab and row 2', async () => {
    const { c } = await trayBench('FAKE-items-words');
    const readers = "Measured by Timmy's own STL reader (timmy-stl-readback/1), OBJ reader (timmy-obj-readback/1) and PLY reader (timmy-ply-readback/1), each from the whole file: a deterministic computation on its bytes, in the file's own units.";
    for (const [cols, rows] of SIZES) {
      const at = `tab 6 at ${cols}x${rows}`;
      openTab6(c);
      const fr = c.frame(cols, rows);
      const reg = fr.regions.center!;
      // the page's own rows (the window shows some of them; the rest scroll)
      const v = createTabView({ data: c.data, width: innerWidth(reg.rect.w), height: reg.rect.h - 2, g, cursor: 0 });
      const page = squash(v.lines.map(plain).join(' '));
      expect(page, at).toContain(squash(CREATE_SENTENCE));
      expect(page, at).toContain('No Timmy surface draws a motion timeline yet');
      expect(page, at).toContain(squash(`${readers} ${DOCTRINE_15}`));
      // the cursor's mesh in Context: who measured it and the sentence
      const said = squash(createDetail(reg.items[0].item as CreateItem, 36, g).map(plain).join(' '));
      expect(said, at).toContain("Measured by Timmy's own OBJ reader (timmy-obj-readback/1), from the whole file");
      expect(said, at).toContain(DOCTRINE_15);
      // still unfinished: the page's box first, the tab's mark, and row 2's word beside the tab's name
      const screen = screenText(fr.screen);
      expect(rowAt(fr, reg.rect.y + 1), at).toContain('◌ Unfinished');
      expect(screen.slice(0, fr.layout.tabRows).join('\n'), at).toContain('◌');
      expect(screen[fr.layout.top.y], at).toContain('6 3D & Motion · unfinished');
    }
  }, 60_000);
});
