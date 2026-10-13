/**
 * Test helpers for Timmy VoxVision (round R4, helper H49): a project, a Workspace with recorded receipts, generated
 * PNG and STL files, and FAKE tools.
 *
 * FAKE: every tool made here is a labelled test double, a Node script behind a small shell wrapper. It is not OpenCV,
 * OCP, Blender, ffprobe, ffmpeg, numpy or Roboflow. It answers as the real worker's one JSON line does (the fields
 * VoxVision reads), from the bytes it is given, and says "fake" in its worker version. Its behaviour is chosen through
 * the job's environment (FAKE_* variables), which the Workspace passes to every job it starts.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { folderProject } from '../../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../../src/repl/workspace.js';
import { glyphSet } from '../../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../../src/utils/receipts.js';

export const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
export const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');

/** Temporary folders and workspaces, cleaned up by `cleanup()` (call it in afterEach). */
export function tempKit() {
  const dirs: string[] = [];
  const spaces: Workspace[] = [];
  return {
    temp: (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; },
    track: (w: Workspace): Workspace => { spaces.push(w); return w; },
    cleanup: async (): Promise<void> => {
      for (const w of spaces.splice(0)) await w.close();
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    },
  };
}

export const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };

/** A PNG (8-bit RGB) of w × h pixels from a function of (x, y) → [r, g, b], written with zlib alone. */
export function png(w: number, h: number, at: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const [r, g, b] = at(x, y); raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3); }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (kind: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(kind, 'latin1'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A closed, outward-facing cube of side s from the origin, as a binary STL (12 triangles). */
export function cubeStl(s: number): Buffer {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const b = Buffer.alloc(84 + 50 * f.length);
  b.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => t.forEach((c, k) => v[c].forEach((x, j) => b.writeFloatLE(x, 84 + i * 50 + 12 + k * 12 + j * 4))));
  return b;
}

/** The FAKE tools' one script: a labelled test double (see the module's header). */
const FAKE_SCRIPT = String.raw`
// FAKE: a test double of Timmy's VoxVision workers (tests/helpers/vox-fakes.ts). Not OpenCV, OCP, Blender, ffmpeg,
// numpy or Roboflow: it answers in the workers' JSON shape, from the bytes it is given, with "fake" in its version.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const role = process.env.FAKE_ROLE;
const args = process.argv.slice(2);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const say = (o, code = 0) => { process.stdout.write(JSON.stringify(o) + '\n', () => process.exit(code)); };
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const src = (path, name) => { const b = readFileSync(path); return { b, s: { sha256: sha(b), bytes: b.length } }; };
const env = process.env;
if (role === 'look' && args[0] === '-c') {
  // the import check (src/vision/look.ts checkOpenCv)
  if (env.FAKE_NO_CV2) { console.error("ModuleNotFoundError: No module named 'cv2' (FAKE)"); process.exit(1); }
  console.log('5.0.0-fake'); process.exit(0);
} else if (env.FAKE_SLEEP === role) setInterval(() => {}, 1000);
else if (role === 'look') {
  const worker = { name: 'timmy-look', version: 'fake' };
  const observation = (path, name) => {
    const { s } = src(path, name);
    return { ok: true, worker, opencv: '5.0.0-fake', python: 'fake', source: { path: name, ...s }, image: { width: 4, height: 2, channels: 3 },
      measurements: [
        { name: 'mean_color', value: { r: 200, g: 10, b: 10, hex: '#c80a0a' }, unit: 'sRGB 8-bit, uncalibrated', tier: 'deterministic computation', note: 'FAKE' },
        { name: 'sharpness', value: 12.5, unit: 'variance of the Laplacian (relative)', tier: 'deterministic computation', note: 'FAKE' },
        { name: 'edge_density', value: 0.25, unit: 'fraction of pixels', tier: 'deterministic computation', note: 'FAKE' },
        { name: 'qr_codes_decoded', value: env.FAKE_QR ? [{ text: env.FAKE_QR, corners: [[0, 0], [3, 0], [3, 1], [0, 1]] }] : [], unit: 'decoded text and corner pixels', tier: 'deterministic computation', note: 'FAKE' },
        { name: 'aruco_markers', value: [], unit: 'marker id (DICT_4X4_50) and corner pixels', tier: 'deterministic computation', note: 'FAKE' },
      ], uncertainty: ['FAKE: a test double, not OpenCV.'] };
  };
  // args[0] is workers/look/look.py, as the real interpreter is given it
  const image = args[1];
  const name = opt('--as');
  const out = opt('--out');
  const draw = (from, to) => { copyFileSync(from, to); const b = readFileSync(to); return { file: basename(to), sha256: env.FAKE_BAD_SHA ? '0'.repeat(64) : sha(b), bytes: b.length, width: 4, height: 2 }; };
  if (opt('--vox') === 'detect') {
    const o = { ok: true, worker, mode: 'vox detect', vox: 'vox/1', opencv: '5.0.0-fake', python: 'fake', observation: observation(image, name), highlight: null };
    const color = opt('--color');
    if (color) o.color_region = { name: 'color_region', value: { rgb: color.split(',').map(Number), tolerance: 48, pixels: 2, share: 0.25, centroid: [1.5, 0.5], box: [1, 0, 3, 1] }, unit: 'pixels', tier: 'deterministic computation', method: 'FAKE', note: 'FAKE' };
    const drawn = [...(env.FAKE_QR ? ['qr_codes_decoded'] : []), ...(color ? ['color_region'] : [])];
    if (out && drawn.length) o.highlight = { ...draw(image, out), drawn_from: drawn, method: 'FAKE: a copy of the input, not a drawing' };
    else o.highlight_note = 'nothing was detected to outline, so no annotated copy was written';
    say(o);
  } else if (opt('--vox') === 'diff') {
    const o = { ok: true, worker, mode: 'vox diff', vox: 'vox/1', opencv: '5.0.0-fake', python: 'fake', a: observation(image, name), b: observation(opt('--other'), opt('--other-as')),
      difference: { name: 'pixel_difference', value: { pixels: 8, changed: 2, changed_share: 0.25, changed_over_16: 1, changed_over_16_share: 0.125, max: 200, mean: 30 }, unit: '8-bit levels', tier: 'deterministic computation', method: 'FAKE', note: 'FAKE' }, highlight: null };
    if (out) o.highlight = { ...draw(image, out), drawn_from: ['pixel_difference'], method: 'FAKE: a copy of a, not a heatmap' };
    say(o);
  } else say({ ok: false, worker, error: { code: 'usage', message: 'FAKE look: --vox only' } }, 64);
} else if (role === 'step' && /step_tessellate\.py$/.test(args[0] ?? '')) {
  // FAKE (R4 H70): the STEP tessellation worker's double. Not OCP and not a mesh of the STEP: a box STL of the readback's
  // size (FAKE_TESS_SIZE, else FAKE_STEP_SIZE), written to --out (never over a file), answered in the worker's JSON shape.
  // FAKE_NO_OCP: exit 3 (no-ocp); FAKE_TESS_FAIL: exit 2 (mesh-failed); FAKE_TESS_BAD_SHA: it reports a wrong sha256.
  const worker = { name: 'timmy-step-tessellate', version: 'fake' };
  const out = opt('--out');
  const box = ([x, y, z]) => {
    const v = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const b = Buffer.alloc(84 + 50 * f.length);
    b.write('FAKE tessellation (a box, not a mesh of the STEP)', 0, 'latin1');
    b.writeUInt32LE(f.length, 80);
    f.forEach((t, i) => t.forEach((c, k) => v[c].forEach((q, j) => b.writeFloatLE(q, 84 + i * 50 + 12 + k * 12 + j * 4))));
    return b;
  };
  if (env.FAKE_NO_OCP) say({ ok: false, worker, error: { code: 'no-ocp', message: 'OCP is not importable (FAKE)' } }, 3);
  else if (env.FAKE_TESS_FAIL) say({ ok: false, worker, error: { code: 'mesh-failed', message: 'BRepMesh made no mesh (FAKE)' } }, 2);
  else if (!out || existsSync(out)) say({ ok: false, worker, error: { code: 'exists', message: 'the output file is already there (FAKE)' } }, 2);
  else {
    const { s } = src(args[1]);
    const stl = box((env.FAKE_TESS_SIZE ?? env.FAKE_STEP_SIZE ?? '10,20,30').split(',').map(Number));
    writeFileSync(out, stl);
    say({ ok: true, worker, python: 'fake', engine: { ocp: '7.9-fake', cadquery: null }, source: { name: opt('--as'), ...s }, units: 'mm', unit_in_effect: 'MM',
      tessellation: { method: 'FAKE: a box of the readback\'s size, not a mesh of the STEP', linear_deflection_mm: Number(opt('--linear')), angular_deflection_rad: Number(opt('--angular')), relative: false, parallel: false, faces: 6, faces_without_mesh: 0, triangles: 12 },
      output: { file: basename(out), format: 'stl-binary', sha256: env.FAKE_TESS_BAD_SHA ? '0'.repeat(64) : sha(stl), bytes: stl.length, triangles: 12, writer: 'FAKE' },
      tier: 'FAKE', scope: 'FAKE' });
  }
} else if (role === 'step') {
  const worker = { name: 'timmy-step-readback', version: 'fake' };
  if (env.FAKE_NO_OCP) say({ ok: false, worker, error: { code: 'no-ocp', message: 'OCP is not importable (FAKE)' } }, 3);
  else {
    const { s } = src(args[1]);
    const size = (env.FAKE_STEP_SIZE ?? '10,20,30').split(',').map(Number);
    // FAKE_STEP_NO_UNIT (R4 H61): a readback whose OCP did not report the unit in effect (unit_in_effect null).
    say({ ok: true, worker, python: 'fake', engine: { ocp: '7.8-fake', cadquery: null }, source: { name: opt('--as'), ...s }, units: 'mm', unit_in_effect: env.FAKE_STEP_NO_UNIT ? null : 'MM', tier: 'deterministic computation',
      valid: true, solids: 1, bounds: { min: [0, 0, 0], max: size, size, method: 'FAKE bounds' }, volume_mm3: size[0] * size[1] * size[2], volume_method: 'FAKE volume' });
  }
} else if (role === 'blender') {
  const as = args[args.indexOf('--as') + 1];
  say({ ok: true, worker: { name: 'timmy-blend-readback', version: 'fake' }, blender_version: '4.2 (FAKE)', python: 'fake', file: { name: as, opened: as }, scene: 'Scene',
    objects: [{ name: 'Cube', type: 'MESH', dimensions: [2, 2, 2], location: [0, 0, 0], materials: ['Red'] }], objects_total: 1,
    materials: [{ name: 'Red', users: 1, fake_user: false }], materials_used: ['Red'], cameras: [], active_camera: null,
    scenes: [{ name: 'Scene', objects: 1, camera: null, frame_start: 1, frame_end: 250, resolution: [1920, 1080], resolution_percentage: 100, engine: 'BLENDER_EEVEE' }],
    frame_range: [1, 250], render_resolution: [1920, 1080], resolution_percentage: 100, units: { system: 'METRIC', scale_length: 1, length_unit: 'METERS' },
    bounds: { method: 'FAKE bounds', evaluated: true, units: null, rounding: 1e-6, objects: [{ name: 'Cube', type: 'MESH', min: [-1, -1, -1], max: [1, 1, 1], size: [2, 2, 2], location: [0, 0, 0] }], objects_total: 1, without_bounds: 0 },
    tier: 'native readback: a second pass by the same application', scope: 'FAKE' });
} else if (role === 'python3' && /voxel_score\.py$/.test(args[0] ?? '')) {
  const code = Number(env.FAKE_GEO_EXIT ?? '0');
  if (code === 3) say({ ok: false, status: 'not_configured', note: 'voxel_score needs numpy and scipy: pip install numpy scipy' }, 3);
  else if (code === 2 && env.FAKE_GEO_USAGE) { console.error('usage: voxel_score.py (FAKE argparse)'); process.exit(2); }
  else {
    const fit = code === 2;
    say({ kind: 'geo.voxel-score', metric: !fit, unit: 'm', fit: fit ? { applied: true, engine: 'fake' } : { applied: false },
      voxel: { voxel_m: 0.25, tolerance_m: 0.0125, precision: 0.9, recall: 0.8, f1: 0.847, iou: 0.73, f1_band: [0.84, 0.85], phases: 8 },
      surface: { chamfer_mean_dist: 0.01, chamfer_l2_sq: 0.0002, fscore: { tau: 0.1, precision: 1, recall: 1, f: 1 } }, points: { truth: 3, pred: 3 },
      note: fit ? ['prediction fitted to truth (similarity); the result is a shape score, not a metric one'] : [] }, code);
  }
} else if (role === 'python3' && /video_readback\.py$/.test(args[0] ?? '')) {
  const { s } = src(args[1]);
  say({ ok: true, worker: { name: 'timmy-video-readback', version: 'fake' }, python: 'fake', tools: { ffprobe: { found: 'path', version: 'ffprobe fake' }, ffmpeg: { found: 'path', version: 'ffmpeg fake' } },
    source: { name: opt('--as'), ...s }, unchanged_during_read: true,
    probe: { codec: 'h264', pix_fmt: 'yuv420p', format: 'mp4', width: 160, height: 120, fps: [10, 1], fps_value: 10, duration: Number(env.FAKE_DURATION ?? '2'), duration_from: 'the container (format duration)', frames: 20, frames_from: "nb_frames (the container's count)", start_time: 0 },
    scale: 1, scaled: [160, 120], colour_tolerance: 48, colour_metric: 'Euclidean distance in 8-bit RGB', samples: [], frames: [], scope: 'FAKE' });
} else if (role === 'roboflow') {
  const req = JSON.parse(env.TIMMY_ROBOFLOW_REQUEST ?? '{}');
  say({ ok: true, action: 'detect', predictions: [{ class: 'card', confidence: 0.91, x: 1, y: 1, width: 2, height: 1, model: req.project + '/' + req.version }] });
} else say({ ok: false, error: { code: 'fake', message: 'FAKE: no role ' + role } }, 64);
`;

/** FAKE tools in a fresh folder: shell wrappers for each role around one Node script. */
export function fakeTools(dir: string): { look: string; step: string; blender: string; python3: string; ffprobe: string; ffmpeg: string; roboflow: string } {
  const js = join(dir, 'fake-vox-tools.mjs');
  writeFileSync(js, FAKE_SCRIPT);
  const wrap = (name: string, role: string): string => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\nFAKE_ROLE=${role} exec "${process.execPath}" "${js}" "$@"\n`);
    chmodSync(p, 0o755);
    return p;
  };
  return { look: wrap('python', 'look'), step: wrap('cadquery-python', 'step'), blender: wrap('blender', 'blender'), python3: wrap('python3', 'python3'), ffprobe: wrap('ffprobe', 'ffprobe'), ffmpeg: wrap('ffmpeg', 'ffmpeg'), roboflow: wrap('roboflow-python', 'roboflow') };
}

/**
 * R4 (H61): a FAKE `rerun` in a fresh folder: a labelled test double of Rerun's viewer program. It opens no window and
 * reads no file; it writes what it was given to $FAKE_RERUN_LOG (each argument on its own line, its working folder and its
 * process group, which a detached start makes its own), then exits.
 * R4 (H70): `rerun --help` prints a short help in clap's form listing `--bind <BIND>` (not when FAKE_RERUN_NO_BIND is set;
 * exit 2 when FAKE_RERUN_HELP_FAIL is set), noting each call in $FAKE_RERUN_HELP_LOG with the last line on the test's
 * screen ($FAKE_RERUN_SCREEN) then; it never writes the launch log. A launch copies the lines of $FAKE_RERUN_SCREEN (what
 * was printed so far) into its log as it starts.
 */
export function fakeRerun(dir: string): string {
  const p = join(dir, 'rerun');
  writeFileSync(p, [
    '#!/bin/sh',
    '# FAKE: a test double of Rerun\'s `rerun` viewer (tests/helpers/vox-fakes.ts): no window, no file read; it logs its arguments.',
    'if [ "$1" = "--help" ]; then',
    '  if [ -n "${FAKE_RERUN_HELP_LOG:-}" ]; then',
    '    last=""; if [ -n "${FAKE_RERUN_SCREEN:-}" ] && [ -f "$FAKE_RERUN_SCREEN" ]; then last="$(tail -n 1 "$FAKE_RERUN_SCREEN")"; fi',
    '    echo "help after: $last" >> "$FAKE_RERUN_HELP_LOG"',
    '  fi',
    '  if [ -n "${FAKE_RERUN_HELP_FAIL:-}" ]; then echo "error: FAKE: --help failed" >&2; exit 2; fi',
    '  echo "The Rerun command-line interface (FAKE)"',
    '  echo ""',
    '  echo "Usage: rerun [OPTIONS] [URL_OR_PATHS]... [COMMAND]"',
    '  echo ""',
    '  echo "Options:"',
    '  if [ -z "${FAKE_RERUN_NO_BIND:-}" ]; then',
    '    echo "      --bind <BIND>"',
    '    echo "          What bind address IP to use."',
    '  fi',
    '  echo "      --port <PORT>"',
    '  echo "          What port the local Viewer server listens on."',
    '  exit 0',
    'fi',
    'log="${FAKE_RERUN_LOG:?FAKE_RERUN_LOG is not set}"',
    '{',
    '  echo "pgid $(ps -o pgid= -p $$ | tr -d \' \')"',
    '  echo "cwd $(pwd)"',
    '  for a in "$@"; do echo "arg $a"; done',
    '  if [ -n "${FAKE_RERUN_SCREEN:-}" ] && [ -f "$FAKE_RERUN_SCREEN" ]; then while IFS= read -r l; do echo "screen $l"; done < "$FAKE_RERUN_SCREEN"; fi',
    '  echo "end"',
    '} > "$log.tmp" && mv "$log.tmp" "$log"',
    '',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/** A Workspace on a project folder, with its notices and receipts recorded (sealed receipts get fake hashes). */
export function workspace(root: string, kit: ReturnType<typeof tempKit>, o: { env?: NodeJS.ProcessEnv; onPath?: (cmd: string) => string | null; extra?: Partial<WorkspaceDeps> } = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env: o.env ?? {},
    onPath: o.onPath ?? (() => null),
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => `Open ${url} in your browser.`,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `r${sealed.length}`; },
    jobsDir: join(kit.temp('vox-jobs-'), 'jobs'),
    chdir: () => {},
    recoverAtStart: false,
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i + 1).padStart(8, '0')}${'0'.repeat(56)}` })) as unknown as Receipt[],
    ...o.extra,
  }, folderProject(root));
  kit.track(ws);
  return { ws, notes, sealed };
}

/** Waits until no job of the workspace is running and VoxVision has written its records. */
export async function settled(ws: Workspace, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && ws.jobs.list().some((j) => !['completed', 'failed', 'cancelled'].includes(j.state))) await new Promise((r) => setTimeout(r, 25));
  // the record is written after the job's end: wait for the action itself
  const vox = (ws as unknown as { vox: { settle(ms: number): Promise<void> } }).vox;
  await vox.settle(ms);
}
