/**
 * R7 (H153): the Workbench's tab 6 (3D & Motion) lists the project's meshes and recordings (src/workbench/create-tab.ts, from
 * the reading the companion's tab 6 draws, src/vox/meshes.ts), with what Timmy's own STL reader measured from the whole file,
 * DOCTRINE §15's sentence, and where the view you can turn is (the companion's tab 6; c opens it on that tab). Read in words
 * from the lines, and through the Workbench's own frame (Controller.frame, the rows Ink prints) over a real Timmy home in a
 * temporary folder, where one line of src/workbench/views.ts puts them in the tab's body.
 *
 * FAKE or FIXTURE, labelled: the meshes (written by the test, and the demo mesh as its script generated it), the chat
 * session's and run detail's producers (none), the browser opener and the server starts (FAKE: nothing presses Show).
 * Real: Timmy's STL reader, its Rerun header reader over the repository's own recording (studio/ctx-c3w8/…/context.rrd, read,
 * never changed), the Workbench's controller, layout and frame.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DOCTRINE_15, num, readStlFile, topologyWords, volumeWords } from '../src/native/stl-readback.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { Controller } from '../src/workbench/controller.js';
import { CREATE_SENTENCE, createTabLines } from '../src/workbench/create-tab.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import { plain } from '../src/workbench/text.js';
import { VIEW_MAX_TRIANGLES } from '../src/vox/meshes.js';
import { DEMO_HEADER, DEMO_MESH } from '../scripts/demo-mesh.mjs';

const RRD = resolve('studio/ctx-c3w8/checkpoints/C5/exports/context.rrd');
const g = glyphsFor(true);
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let box = '';
const made: string[] = [];
const opened: Controller[] = [];
const spaces: Workspace[] = [];
beforeAll(() => { box = mkdtempSync(join(tmpdir(), 'r7-wb-create-')); });
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  for (const c of opened.splice(0)) c.dispose();
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
/** FAKE: a flat sheet of `cells` × `cells` squares, two triangles each. */
function sheetStl(cells: number): Buffer {
  const n = cells * cells * 2;
  const b = Buffer.alloc(84 + 50 * n);
  b.writeUInt32LE(n, 80);
  let i = 0;
  for (let y = 0; y < cells; y += 1) for (let x = 0; x < cells; x += 1) {
    for (const c of [[[x, y, 0], [x + 1, y, 0], [x + 1, y + 1, 0]], [[x, y, 0], [x + 1, y + 1, 0], [x, y + 1, 0]]]) {
      c.forEach((p, k) => p.forEach((v, j) => b.writeFloatLE(v, 84 + i * 50 + 12 + k * 12 + j * 4)));
      i += 1;
    }
  }
  return b;
}
const words = (lines: ReturnType<typeof createTabLines>): string => lines.map(plain).join(' ').replace(/\s+/g, ' ');

describe('the Workbench\'s tab 6: the project\'s meshes and recordings (R7 H153)', () => {
  it('lists each mesh with what Timmy\'s own STL reader measured from the whole file, its recordings, and where the view you can turn is', () => {
    const root = mkdtempSync(join(box, 'p-'));
    made.push(root);
    put(root, 'refs/demo-tray.stl', readFileSync(resolve(DEMO_MESH)));
    put(root, 'scans/sheet.stl', sheetStl(142));
    put(root, 'bad.stl', 'FAKE: not an STL. '.repeat(6));
    mkdirSync(join(root, 'rec'), { recursive: true });
    copyFileSync(RRD, join(root, 'rec', 'context.rrd'));
    const lines = createTabLines({ data: { project: { root } as never, readAt: 1 }, width: 150, g });
    const said = words(lines);
    // first: where the view you can turn is, and what no surface draws yet
    expect(said.startsWith(`${CREATE_SENTENCE} [c] Companion · Show: tab 6, the meshes in a view you can turn; [s] Studio · Show: the canvas (2D shapes and cards).`)).toBe(true);
    expect(CREATE_SENTENCE).toBe("The companion's tab 6 draws this project's meshes in a view you can turn: Timmy's own drawing of each file's triangles, not a render by Blender or any native tool. No Timmy surface draws a motion timeline yet; each app below draws its own, once set up.");
    // the meshes, each with Timmy's reader's measurements
    const r = readStlFile(join(root, 'refs', 'demo-tray.stl'), 'refs/demo-tray.stl');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(said).toContain('MESHES IN THIS PROJECT (3)');
    expect(said).toContain(`refs/demo-tray.stl ${r.readback.triangles} triangles · box ${r.readback.bbox!.size.map(num).join(' × ')} · ${topologyWords(r.readback)} · volume ${volumeWords(r.readback)}`);
    expect(said).toContain('refs/demo-tray.stl 28 triangles · box 80 × 50 × 20 · edge-manifold: every edge shared by exactly two triangles, consistently oriented · volume 21392 (enclosed; normals outward)');
    expect(said).toContain(`the file says (its 80-byte header; not checked): ${DEMO_HEADER}`);
    expect(said).toContain(`scans/sheet.stl 40328 triangles · box 142 × 142 × 0 · not edge-manifold: 568 boundary edges (one triangle: the mesh is open) · volume 0, signed: not an enclosed volume (the mesh is not closed and consistently oriented) · the companion's view shows ${VIEW_MAX_TRIANGLES} of 40328`);
    expect(said).toMatch(/bad\.stl not measured: not an STL: /);
    expect(said).toContain(`Measured by Timmy's own STL reader (timmy-stl-readback/1), from the whole file: a deterministic computation on its bytes, in the file's own units. ${DOCTRINE_15}`);
    // the recordings: the header's facts, what stays unknown and why; Rerun's viewer as it is here
    expect(said).toContain('RECORDINGS TIMMY CAN READ (1)');
    expect(said).toMatch(/rec\/context\.rrd written by Rerun \d+\.\d+\.\d+ · \d+ data chunks · entities, frames and time range: unknown to Timmy \(inside the recording's data chunks \(compressed Arrow\), which Timmy does not decode; Rerun's viewer shows it\)/);
    expect(said).toMatch(/Rerun's viewer: (needs setup|found \(installed here, not run\))/);
    // nothing green (no live connection, passed check or seal is shown), and the measurements are text, not commands
    expect(lines.flat().filter((s) => s.role === 'live')).toEqual([]);
    expect(lines.flat().filter((s) => s.role === 'action').map((s) => s.text)).toEqual(['[c]', '[s]']);
    // every row within the width
    for (const l of lines) expect(visibleWidth(plain(l)), plain(l)).toBeLessThanOrEqual(150);
  });

  it('with no mesh and no recording, it says so and what makes one', () => {
    const root = mkdtempSync(join(box, 'p-'));
    made.push(root);
    const said = words(createTabLines({ data: { project: { root } as never, readAt: 2 }, width: 100, g }));
    expect(said).toContain('MESHES IN THIS PROJECT (0) No mesh in this project yet: an .stl file in it is listed here (/add <file.stl> copies one in), and a STEP once /vox view <record> has made its tessellation (that needs OCP).');
    expect(said).toContain('RECORDINGS TIMMY CAN READ (0) No Rerun recording (.rrd) in this project.');
  });

  it('in the Workbench\'s own frame at 160 × 45: tab 6 (both views) lists the meshes first, under the sentence that says where the view you can turn is', async () => {
    const home = join(box, 'timmy');
    vi.stubEnv('TIMMY_HOME', home);
    vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const jobsDir = join(home, 'jobs');
    mkdirSync(jobsDir, { recursive: true });
    const project = createProject('FAKE-wb-tray');
    if ('error' in project) throw new Error(project.error);
    saveActiveProject(project);
    put(project.root, 'refs/demo-tray.stl', readFileSync(resolve(DEMO_MESH)));
    const ws = new Workspace({ glyphs: glyphSet(true), env: process.env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t, seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined }, project);
    spaces.push(ws);
    const c = new Controller({
      env: process.env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws,
      producers: { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: async () => ({ ok: false, why: 'FIXTURE: no chat session in this test' }) },
      companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
      studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
      capabilities: async () => [], tickMs: 100, slowMs: 400,
    });
    opened.push(c);
    c.start();
    const end = Date.now() + 10_000;
    while (!c.data.frame && Date.now() < end) await sleep(50);
    const center = (): string => {
      const fr = c.frame(160, 45);
      const rect = fr.regions.center!.rect;
      const text = screenText(fr.screen);
      const out: string[] = [];
      for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
        let x = 0;
        let row = '';
        for (const ch of text[y] ?? '') { if (x > rect.x + 1 && x < rect.x + rect.w - 2) row += ch; x += visibleWidth(ch); }
        out.push(row.replace(/\s+$/, ''));
      }
      return out.join(' ').replace(/\s+/g, ' ');
    };
    for (const view of ['create3d', 'motion']) {
      c.key('6', {});
      expect(c.ui.workspace).toBe(view);
      const said = center();
      expect(said).toContain(`${CREATE_SENTENCE} [c] Companion · Show: tab 6, the meshes in a view you can turn; [s] Studio · Show: the canvas (2D shapes and cards).`);
      expect(said).toContain('MESHES IN THIS PROJECT (1) refs/demo-tray.stl 28 triangles · box 80 × 50 × 20 · edge-manifold');
      // R7 lead, at H150's merge: the frame's Unfinished block now comes first on tab 6, so at 160 × 45 the tools list can
      // begin below the pane (PgDn shows it): the meshes come before the tools, or the tools are not in view yet
      const tools = said.indexOf('TOOLS (');
      expect(tools === -1 || said.indexOf('MESHES IN THIS PROJECT') < tools, `meshes ${said.indexOf('MESHES IN THIS PROJECT')}, tools ${tools}`).toBe(true);
    }
    // c opens the companion on this tab (tab=create): its page's tab 6 draws the view
    expect(c.ui.page).toBe('create');
    // a capture of the screen as the frame draws it, where H153_CAPS names a folder
    if (process.env.H153_CAPS) { mkdirSync(process.env.H153_CAPS, { recursive: true }); writeFileSync(join(process.env.H153_CAPS, 'h153-10-workbench-tab6-160x45-frame.txt'), `${screenText(c.frame(160, 45).screen).join('\n')}\n`); }
  }, 30_000);
});
