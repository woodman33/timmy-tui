/**
 * R7 (H153): the Workbench's tab 6 (3D & Motion) lists the project's meshes and recordings (src/workbench/create-tab.ts, from
 * the reading the companion's tab 6 draws, src/vox/meshes.ts), with what Timmy's own STL reader measured from the whole file,
 * DOCTRINE §15's sentence, and where the view you can turn is (the companion's tab 6; c opens it on that tab). Read in words
 * from the lines, and through the Workbench's own frame (Controller.frame, the rows Ink prints) over a real Timmy home in a
 * temporary folder, where one line of src/workbench/views.ts puts them in the tab's body.
 *
 * R8 (H154): OBJ and PLY files beside STL, each with its kind, its reader's measurements, its faces and what its reader ignored.
 *
 * FAKE or FIXTURE, labelled: the meshes (written by the test, tests/helpers/mesh-fakes.ts for the OBJ and PLY cubes and the point
 * cloud, and the demo mesh as its script generated it), the chat
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
import { cubeObj, cubePly, pointCloudPly } from './helpers/mesh-fakes.js';

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
    put(root, 'refs/cube.obj', cubeObj(10));
    put(root, 'refs/cube.ply', cubePly(10));
    put(root, 'scans/cloud.ply', pointCloudPly(3));
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
    expect(said).toContain('MESHES IN THIS PROJECT (6)');
    expect(said).toContain(`refs/demo-tray.stl STL · ${r.readback.triangles} triangles · box ${r.readback.bbox!.size.map(num).join(' × ')} · ${topologyWords(r.readback)} · volume ${volumeWords(r.readback)}`);
    expect(said).toContain('refs/demo-tray.stl STL · 28 triangles · box 80 × 50 × 20 · edge-manifold: every edge shared by exactly two triangles, consistently oriented · volume 21392 (enclosed; normals outward)');
    expect(said).toContain(`the file says (its 80-byte header; not checked): ${DEMO_HEADER}`);
    expect(said).toContain(`scans/sheet.stl STL · 40328 triangles · box 142 × 142 × 0 · not edge-manifold: 568 boundary edges (one triangle: the mesh is open) · volume 0, signed: not an enclosed volume (the mesh is not closed and consistently oriented) · the companion's view shows ${VIEW_MAX_TRIANGLES} of 40328`);
    expect(said).toMatch(/bad\.stl STL · not measured: not an STL: /);
    // R8 (H154): an OBJ and a PLY of the same cube, each with its kind, the same measurements, its faces and what was ignored
    const cube = 'box 10 × 10 × 10 · edge-manifold: every edge shared by exactly two triangles, consistently oriented · volume 1000 (enclosed; normals outward)';
    expect(said).toContain(`refs/cube.obj OBJ · 12 triangles · ${cube} 6 faces: 6 with four or more corners, each split as a fan from its first corner (exact for a flat, convex polygon); 12 triangles in all · ignored: 1 comment, 1 o lines the file says (its first comment; not checked): FAKE: a cube written by a test`);
    expect(said).toContain(`refs/cube.ply PLY · 12 triangles · ${cube} 6 faces: 6 with four or more corners, each split as a fan from its first corner (exact for a flat, convex polygon); 12 triangles in all · ignored: 1 comment line the file says (its header's first comment; not checked): FAKE: a cube written by a test`);
    expect(said).toContain('scans/cloud.ply PLY · not measured: no face element in its header, so no triangles to measure (a point cloud of 3 vertices; its data is not read)');
    expect(said).toContain(`Measured by Timmy's own STL reader (timmy-stl-readback/1), OBJ reader (timmy-obj-readback/1) and PLY reader (timmy-ply-readback/1), each from the whole file: a deterministic computation on its bytes, in the file's own units. ${DOCTRINE_15}`);
    // the recordings: the header's facts, what stays unknown and why; Rerun's viewer as it is here
    expect(said).toContain('RECORDINGS TIMMY CAN READ (1)');
    // R9 lead (at the merge of H159): the row carries the Rerun CLI's reading, unknown here until a companion lists tab 6
    expect(said).toMatch(/rec\/context\.rrd written by Rerun \d+\.\d+\.\d+ · \d+ data chunks · entities unknown: Context says why · timelines unknown: Context says why/);
    expect(said).toMatch(/Rerun's viewer: (needs setup|found \(installed here, not run\))/);
    // nothing green (no live connection, passed check or seal is shown), and the measurements are text, not commands
    expect(lines.flat().filter((s) => s.role === 'live')).toEqual([]);
    // (R9 H160: the keys under each list's heading, what Enter and c do to the selected mesh or recording)
    expect(lines.flat().filter((s) => s.role === 'action').map((s) => s.text)).toEqual(['[c]', '[s]', '[Enter]', '[c]', '[Enter]']);
    // every row within the width
    for (const l of lines) expect(visibleWidth(plain(l)), plain(l)).toBeLessThanOrEqual(150);
  });

  it('with no mesh and no recording, it says so and what makes one', () => {
    const root = mkdtempSync(join(box, 'p-'));
    made.push(root);
    const said = words(createTabLines({ data: { project: { root } as never, readAt: 2 }, width: 100, g }));
    expect(said).toContain('MESHES IN THIS PROJECT (0) No mesh in this project yet: an .stl, .obj or .ply file in it is listed here (/add <file> copies one in), and a STEP once /vox view <record> has made its tessellation (that needs OCP).');
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
      // R9 (H160): the mesh is an item, the cursor's first (its mark before its path), under the keys that act on it
      expect(said).toContain("MESHES IN THIS PROJECT (1) [Enter] its measurements in Context · [c] it chosen in the companion's view you can turn ▸ refs/demo-tray.stl STL · 28 triangles · box 80 × 50 × 20 · edge-manifold");
      // R8 (H154): the frame's Unfinished words on tab 6 name the three kinds that work now (src/contracts/workspace.ts)
      expect(said).toContain("Works now: the project's meshes (STL, OBJ and PLY) measured by Timmy's own readers, a view of each you can turn in the companion");
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
