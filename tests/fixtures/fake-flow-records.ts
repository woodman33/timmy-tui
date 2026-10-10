/**
 * FAKE flow records (round R4, H45), for the board's flow cards in tests and screenshots: synthetic, written by hand in
 * the shapes src/repl/iterate*.ts and src/repl/recover.ts write. No agent, app, render or readback ran for any of them;
 * every id, hash, job, receipt and number here is made up, and every instruction says FAKE.
 */
import { DOCTRINE_15, paramDiff, READBACK_SCOPE } from '../../src/flows/iterate.js';
import { BLEND_READBACK_SCOPE, dimensionsSummary, type BlendObjectBounds } from '../../src/flows/iterate-blender.js';
import { AE_READBACK_LABEL, AE_REPORTED_BY, AE_TOLERANCE_RULE } from '../../src/flows/iterate-ae.js';
import { SCAD_COMPARE_SCOPE, SCAD_MEASURED_BY, scadParamDiff } from '../../src/flows/iterate-scad.js';
import { FREECAD_FLOW_MEASURED_BY } from '../../src/flows/iterate-freecad.js';
import { FREECAD_READBACK_SCOPE } from '../../src/native/freecad.js';

export type FakeRecord = Record<string, unknown> & { id: string };

const hex = (c: string): string => c.repeat(64);
const AGENT = (run: string, job: string, outcome = 'completed') => ({
  run, agent: 'qwen', version: '0.0.0-fake', route: 'local endpoint, no charge', where: '127.0.0.1', model: 'fake-model', job, outcome,
  result: `.timmy/agents/${run}/result.json`, progress: `.timmy/agents/${run}/progress.log`, transcript: `.timmy/agents/${run}/transcript.txt`,
  cost_usd: 0, cost_basis: 'a local endpoint: no charge', receipt: `rcpt-agent-${run.slice(1, 5)}`,
});
const base = (id: string, minute: number, o: Record<string, unknown>): FakeRecord => ({
  flow: 1, schema: 'timmy.flow/1', id, kind: 'iterate', project: 'fake-demo',
  started_at: `2026-10-10T09:${String(minute).padStart(2, '0')}:00.000Z`, ended_at: `2026-10-10T09:${String(minute).padStart(2, '0')}:42.000Z`,
  receipts: {}, child_receipts: [], doctrine: DOCTRINE_15, ...o,
});
const TRAY_BEFORE = { width: 140, wall: 3, supportOffset: 10, bore: 3 };
const TRAY_AFTER = { width: 180, wall: 3, supportOffset: 10, bore: 3 };

/** A tray flow that succeeded: the readback of the STEP matches the sealed prediction. */
export const fakeTray = (o: Record<string, unknown> = {}): FakeRecord => base('f0000a001', 1, {
  recipe: 'enclosure.tray/1', instruction: 'FAKE: make the tray 180 mm wide', outcome: 'succeeded', ended_in: 'readback',
  why: 'the readback of the delivered STEP matches the sealed prediction',
  parameters: { path: 'recipes/tray.params.json', created: false, before: { sha256: hex('a'), values: TRAY_BEFORE }, after: { sha256: hex('b'), values: TRAY_AFTER }, diff: paramDiff(TRAY_BEFORE, TRAY_AFTER) },
  agent: AGENT('a0000a001', 'j0a0001'),
  rebuild: {
    operation: '1a2b3c4d-0000-4000-8000-00000000000a', job: 'j0a0002', state: 'succeeded', progress: 'finished',
    predicted: { bounds_mm: [180, 80, 30], volume_mm3: 151234.5 }, prediction_receipt: 'rcpt-pred-0a01',
    outputs: ['console-tray.step', 'outer.stl', 'cavity.stl', 'bosses.stl', 'bores.stl'].map((n, i) => ({ path: `out/recipes/1a2b3c4d/${n}`, sha256: hex(String(i + 1)), bytes: 1000 + i })),
    receipt: 'rcpt-build-0a01',
  },
  readback: {
    job: 'j0a0003', state: 'completed', worker: { name: 'fake-step-readback', version: '0.0.0-fake (a FAKE readback, not a measurement)' },
    step: { path: 'out/recipes/1a2b3c4d/console-tray.step', sha256: hex('1') },
    measured: { bounds_mm: [180, 80, 30], volume_mm3: 151234.5, valid: true, solids: 1, sha256: hex('1') },
    tolerance: { bounds_mm: 1e-6, volume_relative: 1e-8 },
    checks: [
      { name: 'valid shape', predicted: true, measured: true, difference: null, tolerance: 'exact', passed: true },
      { name: 'solids', predicted: 1, measured: 1, difference: 0, tolerance: 'exact', passed: true },
      ...['x', 'y', 'z'].map((a, i) => ({ name: `bounds ${a} (mm)`, predicted: [180, 80, 30][i], measured: [180, 80, 30][i], difference: 0, tolerance: '1e-6 mm', passed: true })),
      { name: 'volume (mm3)', predicted: 151234.5, measured: 151234.5, difference: 0, tolerance: '1e-8 relative', passed: true },
    ],
    verdict: 'matches', log: '.timmy/flows/f0000a001/readback.log', receipt: 'rcpt-read-0a01', scope: READBACK_SCOPE,
  },
  receipts: { agent: 'rcpt-agent-0a00', prediction: 'rcpt-pred-0a01', build: 'rcpt-build-0a01', readback: 'rcpt-read-0a01' },
  ...o,
});

/** A tray flow whose rebuild failed: nothing was read back. */
export const fakeTrayFailed = (): FakeRecord => {
  const ok = fakeTray();
  return {
    ...ok, id: 'f0000a002', started_at: '2026-10-10T09:05:00.000Z', ended_at: '2026-10-10T09:05:31.000Z', instruction: 'FAKE: make the walls 0.5 mm thin',
    outcome: 'failed', ended_in: 'build', why: 'recipe job 2b3c4d5e-0000-4000-8000-00000000000b failed: FAKE: the wall is thinner than the recipe allows; nothing was read back',
    rebuild: { operation: '2b3c4d5e-0000-4000-8000-00000000000b', job: 'j0a0012', state: 'failed', progress: 'build', reason: 'FAKE: the wall is thinner than the recipe allows', failure_files: ['.timmy/recipe-jobs/2b3c4d5e-0000-4000-8000-00000000000b/stderr.log'] },
    readback: undefined, receipts: { agent: 'rcpt-agent-0a02' },
  };
};

/** A tray flow interrupted in its build step, recorded after a restart (as src/repl/recover.ts writes one). */
export const fakeTrayInterrupted = (): FakeRecord => {
  const ok = fakeTray();
  const uuid = '3c4d5e6f-0000-4000-8000-00000000000c';
  return {
    ...ok, id: 'f0000a003', started_at: '2026-10-10T08:50:00.000Z', ended_at: '2026-10-10T09:10:00.000Z', instruction: 'FAKE: make the tray 160 mm wide',
    outcome: 'interrupted', ended_in: 'build',
    why: `the REPL running it ended during its rebuild (its job j0a0022 was left running and its process is gone); recipe job ${uuid} still runs; nothing was read back; recorded after a restart, and nothing was run again`,
    rebuild: { operation: uuid, job: 'j0a0022', state: 'running', progress: 'build' }, readback: undefined,
    recovered: {
      at: '2026-10-10T09:10:00.000Z', step: 'build', state_file: { path: '.timmy/flows/f0000a003/state.json', sha256: hex('c') }, job: { id: 'j0a0022', state: 'running', stale: true },
      next: [
        `recipe job ${uuid} is followed again as j0a0031: its exports reach out/recipes/3c4d5e6f/ once its signed result verifies`,
        `/recipe recover ${uuid} reads recipe job ${uuid} again; nothing is rerun`,
        'recipes/tray.params.json holds the agent\'s change (width 140 → 160): /recipe tray builds from it',
        '/iterate tray "FAKE: make the tray 160 mm wide" starts a new flow from recipes/tray.params.json as it is now',
      ],
    },
    receipts: { agent: 'rcpt-agent-0a03' },
  };
};

const box = (name: string, s: number[], c: number[], type = 'MESH'): BlendObjectBounds => ({ name, type, min: c.map((x, i) => x - s[i] / 2), max: c.map((x, i) => x + s[i] / 2), size: [...s], location: [...c] });
const blendBounds = (objects: BlendObjectBounds[]) => ({ method: 'world-space axis-aligned bounding box', evaluated: true, units: { system: 'METRIC', scale_length: 1, length_unit: 'METERS' }, rounding: 1e-6, objects, objects_total: objects.length, without_bounds: 2 });

/** A Blender flow whose second pass differs from Blender's report (its materials). */
export const fakeBlender = (): FakeRecord => {
  const after = blendBounds([box('Cube', [3, 3, 3], [-2.4, 0, 1.5]), box('Sphere', [2, 2, 2], [0, 0.6, 1])]);
  const dims = dimensionsSummary({
    after, check: { name: 'dimensions', reported: { objects: 2 }, read: { objects: 2 }, passed: true, differences: [], tolerance: 1e-6 },
    before: { run: '4d5e6f70-0000-4000-8000-00000000000d', started_at: '2026-10-10T08:00:00.000Z', judged_at: '2026-10-10T08:00:09.000Z', script: { path: 'scene.py', sha256: hex('d') }, result: '.timmy/native/4d5e6f70-0000-4000-8000-00000000000d/result.json', result_sha256: hex('e'), bounds: blendBounds([box('Cube', [2, 2, 2], [-2.4, 0, 1]), box('Sphere', [2, 2, 2], [0, 0.6, 1])]) },
  });
  return base('f0000b001', 12, {
    target: 'blender', instruction: 'FAKE: make the cube bigger and gold', outcome: 'differs', ended_in: 'readback',
    why: 'the second pass differs from Blender\'s report: materials: reported, not in the .blend: Gold',
    script: { path: 'scene.py', before: { sha256: hex('d'), bytes: 900, lines: 40 }, after: { sha256: hex('f'), bytes: 930, lines: 41 },
      change: { added: 2, removed: 1, hunks: [{ before_line: 12, after_line: 12, removed: ['cube = add_cube(size=2)'], added: ['cube = add_cube(size=3)', 'cube.material = gold'], removed_total: 1, added_total: 2 }], hunks_total: 1, method: 'line diff (longest common subsequence)' },
      syntax: { checked: true, ok: true, python: '3.12.0', by: 'python3' } },
    agent: AGENT('a0000b001', 'j0b0001'),
    blender: { job: 'j0b0002', run: '5e6f7081-0000-4000-8000-00000000000e', state: 'completed', outcome: 'ok', blender_version: 'Blender 0.0 (FAKE)', blend: { path: 'out/scene.blend', sha256: hex('7') }, renders: [{ path: 'out/render.png', sha256: hex('8') }], log: '.timmy/flows/f0000b001/blender.log', receipt: 'rcpt-blend-0b01' },
    readback: {
      job: 'j0b0003', state: 'completed', worker: { name: 'fake-blend-readback', version: '0.0.0-fake' }, blender_version: 'Blender 0.0 (FAKE)',
      blend: { path: 'out/scene.blend', sha256_before: hex('7'), sha256_after: hex('7') },
      read: { scene: 'Scene', objects: [{ name: 'Cube', type: 'MESH', dimensions: [3, 3, 3], location: [-2.4, 0, 1.5] }, { name: 'Sphere', type: 'MESH', dimensions: [2, 2, 2], location: [0, 0.6, 1] }], objects_total: 2, materials: [{ name: 'Green', users: 1, fake_user: false }], materials_used: ['Green'], cameras: [{ name: 'Camera', data: 'Camera', lens: 50 }], active_camera: 'Camera', scenes: [], frame_range: [1, 250], render_resolution: [640, 400], resolution_percentage: 100, units: null },
      checks: [
        { name: 'objects', reported: ['Cube', 'Sphere'], read: ['Cube', 'Sphere'], passed: true, differences: [] },
        { name: 'materials', reported: ['Green', 'Gold'], read: { used: ['Green'] }, passed: false, differences: ['reported, not in the .blend: Gold'] },
        { name: 'dimensions', reported: { objects: 2 }, read: { objects: 2 }, passed: true, differences: [], tolerance: 1e-6 },
      ],
      verdict: 'differs', log: '.timmy/flows/f0000b001/readback.log', receipt: 'rcpt-read-0b01', scope: BLEND_READBACK_SCOPE,
    },
    dimensions: dims,
    receipts: { agent: 'rcpt-agent-0b01', blender: 'rcpt-blend-0b01', readback: 'rcpt-read-0b01' },
  });
};

/** An OpenSCAD flow that succeeded: Timmy's STL reading agrees with OpenSCAD's own summary. */
export const fakeScad = (): FakeRecord => {
  const measure = (size: number[], volume: number, run: string, job: string) => ({ stl: 'out/box.stl', sha256: hex('9'), size, min: [0, 0, 0], max: size, volume, area: 1, triangles: 12, manifold: true, oriented: true, run, job });
  return base('f0000c001', 20, {
    target: 'scad', instruction: 'FAKE: make the box 100 wide and 50 deep', outcome: 'succeeded', ended_in: 'readback',
    why: 'Timmy\'s reading of out/box.stl (100 x 50 x 30, volume 150000, closed and consistently oriented) matches OpenSCAD\'s own summary of the same export',
    model: { path: 'box.scad', sha256: hex('a'), bytes: 400 },
    parameters: { path: 'box.params.json', before: { sha256: hex('b'), bytes: 90, values: { width: 60, depth: 40, height: 30 } }, after: { sha256: hex('c'), bytes: 91, values: { width: 100, depth: 50, height: 30 } }, diff: scadParamDiff({ width: 60, depth: 40, height: 30 }, { width: 100, depth: 50, height: 30 }) },
    agent: AGENT('a0000c001', 'j0c0001'),
    openscad: { job: 'j0c0002', run: '6f708192-0000-4000-8000-00000000000f', state: 'completed', outcome: 'ok', version: 'OpenSCAD 0.0 (FAKE)', defines: ['width=100', 'depth=50', 'height=30'], stl: { path: 'out/box.stl', made: true, sha256: hex('9'), bytes: 684 }, png: { path: 'out/box.png', made: true, sha256: hex('6') }, log: '.timmy/flows/f0000c001/openscad.log', receipt: 'rcpt-scad-0c01' },
    readback: {
      verdict: 'matches', checks: [{ name: 'closed', passed: true, detail: 'every edge is shared by exactly two triangles' }, { name: 'summary', passed: true, detail: 'OpenSCAD\'s bounding box agrees' }],
      measured: { ...measure([100, 50, 30], 150000, '6f708192-0000-4000-8000-00000000000f', 'j0c0002'), measured_by: 'timmy-stl-readback/1 (Timmy\'s own reading of the STL, independent of OpenSCAD\'s engine)' },
      summary: { state: 'written', min: [0, 0, 0], max: [100, 50, 30], agrees: true }, scope: SCAD_COMPARE_SCOPE,
    },
    before_after: { measured_by: SCAD_MEASURED_BY, before: { ...measure([60, 40, 30], 72000, '0718293a-0000-4000-8000-000000000010', 'j0c0000'), started_at: '2026-10-10T08:30:00.000Z' }, after: measure([100, 50, 30], 150000, '6f708192-0000-4000-8000-00000000000f', 'j0c0002') },
    receipts: { agent: 'rcpt-agent-0c01', openscad: 'rcpt-scad-0c01' },
  });
};

/** A FreeCAD flow stopped by its checks: the agent changed another file as well. */
export const fakeFreecad = (): FakeRecord => base('f0000d001', 30, {
  target: 'freecad', instruction: 'FAKE: make the plate 120 mm long', outcome: 'stopped', ended_in: 'checks',
  why: 'the agent changed files other than plate.py: notes/other.txt (added); FreeCAD did not run, and nothing was reverted',
  script: { path: 'plate.py', before: { sha256: hex('1'), bytes: 1200, lines: 50 } },
  agent: { ...AGENT('a0000d001', 'j0d0001'), others: [{ path: 'notes/other.txt', how: 'added', sha256_after: hex('2') }] },
  receipts: { agent: 'rcpt-agent-0d01' },
});

/** A FreeCAD flow that succeeded, read back. */
export const fakeFreecadOk = (): FakeRecord => {
  const shape = (len: number, vol: number) => ({ step: 'out/plate.step', objects: ['Plate'], valid: true, solids: 1, size: [len, 60, 6], min: [0, 0, 0], max: [len, 60, 6], volume_mm3: vol });
  return base('f0000d002', 31, {
    target: 'freecad', instruction: 'FAKE: make the plate 120 mm long', outcome: 'succeeded', ended_in: 'readback',
    why: 'the readback of out/plate.step matches FreeCAD\'s report',
    script: { path: 'plate.py', before: { sha256: hex('1'), bytes: 1200, lines: 50 }, after: { sha256: hex('3'), bytes: 1200, lines: 50 },
      change: { added: 1, removed: 1, hunks: [{ before_line: 8, after_line: 8, removed: ['DEFAULTS = {"length": 100.0,'], added: ['DEFAULTS = {"length": 120.0,'], removed_total: 1, added_total: 1 }], hunks_total: 1, method: 'line diff (longest common subsequence)' },
      syntax: { checked: true, ok: true, python: '3.12.0', by: 'python3' } },
    agent: AGENT('a0000d002', 'j0d0011'),
    freecad: { job: 'j0d0012', run: '18293a4b-0000-4000-8000-000000000011', state: 'completed', outcome: 'ok', version: '0.0 (FAKE)', fcstd: [{ path: 'out/plate.FCStd', sha256: hex('4') }], step: { path: 'out/plate.step', sha256: hex('5') }, reported: { valid: true, solids: 1, bounds: { min: [0, 0, 0], max: [120, 60, 6], size: [120, 60, 6] }, volume_mm3: 42403.1, objects: ['Plate'] }, log: '.timmy/flows/f0000d002/freecad.log', receipt: 'rcpt-fc-0d02' },
    readback: { job: 'j0d0013', state: 'completed', worker: { name: 'fake-freecad-readback', version: '0.0.0-fake' }, step: { path: 'out/plate.step', sha256: hex('5') }, measured: { valid: true, solids: 1, bounds: { size: [120, 60, 6] }, volume_mm3: 42403.1, measured_by: 'the STEP read back with OCP (FAKE)' }, tolerance: { bounds_mm: 1e-6, volume_relative: 1e-8 }, checks: [{ name: 'volume (mm3)', reported: 42403.1, measured: 42403.1, passed: true }], verdict: 'matches', log: '.timmy/flows/f0000d002/readback.log', receipt: 'rcpt-read-0d02', scope: FREECAD_READBACK_SCOPE },
    before_after: { measured_by: FREECAD_FLOW_MEASURED_BY, before: { ...shape(100, 35336.0), run: '293a4b5c-0000-4000-8000-000000000012', started_at: '2026-10-10T08:40:00.000Z' }, after: { ...shape(120, 42403.1), run: '18293a4b-0000-4000-8000-000000000011', job: 'j0d0012' } },
    receipts: { agent: 'rcpt-agent-0d02', freecad: 'rcpt-fc-0d02', readback: 'rcpt-read-0d02' },
  });
};

const EVIL_LAYER = '<img src=x onerror=alert(1)>';
/** An After Effects comp report as the record keeps it (compFacts: Position keys only), with a hostile layer name to escape. */
const aeFacts = (moverStart: number, run: string) => ({
  comp: 'Main', size: [1920, 1080], fps: 30, duration: 4,
  layers: [
    { name: 'Mover', kind: 'solid', colour: [0.157, 0.996, 0.078], span: [0, 4], position: { num_keys: 3, keys: [[0, [moverStart, 760]], [2, [1680, 760]], [3, [1680, 300]]] } },
    { name: 'Title', kind: 'text', text: 'FAKE title', span: [0.5, 3.5], position: { value: [960, 200] } },
    { name: EVIL_LAYER, kind: 'solid', colour: [0.2, 0.2, 0.2], span: [1, 2.5], position: { num_keys: 2, keys: [[1, [300, 300]], [2.5, [600, 300]]] } },
    { name: 'Backdrop', kind: 'solid', colour: [0.07, 0.07, 0.07], span: [0, 4] },
  ],
  layers_total: 4, run,
});
/** An After Effects flow whose render differs from After Effects' own report at one sample. */
export const fakeAe = (o: Record<string, unknown> = {}): FakeRecord => base('f0000e001', 40, {
  target: 'ae', instruction: 'FAKE: start the Mover at x 480', outcome: 'differs', ended_in: 'readback',
  why: 'the render out/ae/author-v2.mp4 differs from After Effects\' own report: Mover at 2 s: After Effects\' keys put it at (1680, 760), the render shows it at (1880, 760) (off by (200, 0))',
  options: { comp: 'Main' },
  script: { path: 'author.jsx', before: { sha256: hex('a'), bytes: 2000, lines: 60 }, after: { sha256: hex('b'), bytes: 2000, lines: 60 },
    change: { added: 1, removed: 1, hunks: [{ before_line: 22, after_line: 22, removed: ['  position.setValueAtTime(0, [240, H / 2 + 220]);'], added: ['  position.setValueAtTime(0, [480, H / 2 + 220]);'], removed_total: 1, added_total: 1 }], hunks_total: 1, method: 'line diff (longest common subsequence)' },
    syntax: { checked: true, ok: true, by: 'Node\'s vm.Script', node: 'v22.0.0' } },
  agent: AGENT('a0000e001', 'j0e0001'),
  author: { job: 'j0e0002', run: '3a4b5c6d-0000-4000-8000-000000000013', state: 'completed', outcome: 'ok', name: 'author', version: 2, ae_version: '0.0 (FAKE)', aep: { path: 'out/ae/author-v2.aep', sha256: hex('c'), bytes: 50000 }, log: '.timmy/flows/f0000e001/author.log', receipt: 'rcpt-ae-0e01' },
  render: { job: 'j0e0003', run: '4b5c6d7e-0000-4000-8000-000000000014', state: 'completed', comp: 'Main', requested: 'out/ae/author-v2.mp4', outcome: 'ok', file: { path: 'out/ae/author-v2.mp4', sha256: hex('d'), bytes: 300000, instead: false }, log: '.timmy/flows/f0000e001/render.log', receipt: 'rcpt-aer-0e01' },
  readback: {
    job: 'j0e0004', state: 'completed', label: AE_READBACK_LABEL, reported_by: AE_REPORTED_BY, verdict: 'differs',
    worker: { name: 'fake-video-readback', version: '0.0.0-fake' }, video: { path: 'out/ae/author-v2.mp4', sha256: hex('d') },
    probe: { codec: 'h264', pix_fmt: 'yuv420p', format: 'mp4', width: 1920, height: 1080, fps: [30, 1], fps_value: 30, duration: 4, duration_from: 'stream', frames: 120, frames_from: 'stream' },
    scale: 4, scaled: [480, 270], tolerance: { x_px: 38.4, y_px: 21.6, rule: AE_TOLERANCE_RULE, colour: 48, colour_metric: 'max channel difference' },
    checks: [
      { name: 'comp size', reported: [1920, 1080], measured: [1920, 1080], difference: [0, 0], tolerance: 'exact', passed: true },
      { name: 'frame rate', reported: 30, measured: '30/1 (30)', difference: 0, tolerance: '0.003 fps', passed: true },
      { name: 'duration (s)', reported: 4, measured: 4, difference: 0, tolerance: 'one frame (0.033 s)', passed: true },
      { name: 'frame count', reported: 120, measured: 120, difference: 0, tolerance: 'exact', passed: true },
      { name: 'Mover at 0 s', reported: [480, 760], measured: [481, 760], difference: [1, 0], tolerance: '38.4 x, 21.6 y comp pixels', passed: true, note: 'its key; frame 0' },
      { name: 'Mover at 1 s', reported: [1080, 760], measured: [1079, 761], difference: [-1, 1], tolerance: '38.4 x, 21.6 y comp pixels', passed: true, note: 'linear between its keys at 0 s and 2 s; frame 30' },
      { name: 'Mover at 2 s', reported: [1680, 760], measured: [1880, 760], difference: [200, 0], tolerance: '38.4 x, 21.6 y comp pixels', passed: false, note: 'its key; frame 60' },
      { name: 'Mover at 2.5 s', reported: null, measured: [1680, 530], tolerance: '', passed: null, note: 'it is eased (bezier out, bezier in) between its keys at 2 s and 3 s: compared at key times only' },
      { name: 'Mover at 3 s', reported: [1680, 300], measured: [1680, 301], difference: [0, 1], tolerance: '38.4 x, 21.6 y comp pixels', passed: true, note: 'its key; frame 90' },
      { name: `${EVIL_LAYER} at 1 s`, reported: [300, 300], measured: [301, 300], difference: [1, 0], tolerance: '38.4 x, 21.6 y comp pixels', passed: true },
    ],
    not_compared: ['Backdrop: it has no Position keys'],
    frames: [0, 30, 60, 90].map((n) => ({ path: `.timmy/flows/f0000e001/frames/frame-${String(n).padStart(6, '0')}.png`, frame: n, time: n / 30, sha256: hex('e') })),
    plan: { path: '.timmy/flows/f0000e001/readback-plan.json', sha256: hex('f') },
    log: '.timmy/flows/f0000e001/readback.log', receipt: 'rcpt-read-0e01',
  },
  before_after: {
    reported_by: AE_REPORTED_BY,
    before: { ...aeFacts(240, '2a3b4c5d-0000-4000-8000-000000000015'), started_at: '2026-10-10T08:20:00.000Z' },
    after: aeFacts(480, '3a4b5c6d-0000-4000-8000-000000000013'),
    changes: ['Mover: Position 0 s (240, 760), 2 s (1680, 760), 3 s (1680, 300) → 0 s (480, 760), 2 s (1680, 760), 3 s (1680, 300)'],
  },
  receipts: { agent: 'rcpt-agent-0e01', author: 'rcpt-ae-0e01', render: 'rcpt-aer-0e01', readback: 'rcpt-read-0e01' },
  ...o,
});

/** A tray flow's state file while it runs its build (no record yet), as its session writes it (`step` beside the record). */
export const fakeTrayRunningState = (): FakeRecord => {
  const ok = fakeTray();
  return {
    ...ok, id: 'f0000f001', started_at: '2026-10-10T09:50:00.000Z', ended_at: undefined, instruction: 'FAKE: make the tray 150 mm wide',
    outcome: 'running', ended_in: undefined, why: undefined, step: 'build',
    rebuild: { operation: '5c6d7e8f-0000-4000-8000-000000000016', job: 'j0f0002', state: 'running', predicted: { bounds_mm: [150, 80, 30], volume_mm3: 130000 }, prediction_receipt: 'rcpt-pred-0f01' },
    readback: undefined, receipts: { agent: 'rcpt-agent-0f01', prediction: 'rcpt-pred-0f01' },
  };
};

/** Every FAKE record above, newest last. */
export const fakeFlowRecords = (): FakeRecord[] => [fakeTray(), fakeTrayFailed(), fakeTrayInterrupted(), fakeBlender(), fakeScad(), fakeFreecad(), fakeFreecadOk(), fakeAe()];
