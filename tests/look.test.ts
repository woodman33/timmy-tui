// "Observations out" (round R2, look): the Look worker (workers/look/look.py, OpenCV) measures an image;
// /observe runs it as a job, writes the observation into results/observations/ and seals one receipt.
// The job path runs a labelled fake worker (a test double, not OpenCV). The real worker runs on a generated
// image only where OpenCV is importable, and is skipped where it is not (CI has no OpenCV).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { LOOK_SCRIPT, lookPython, resetLookChecks, runLook } from '../src/vision/look.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
afterEach(async () => {
  resetLookChecks();
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A labelled test double for a Python with OpenCV: answers the import check, and prints a fixed observation. */
function fakePython(opts: { cv2?: boolean; fail?: boolean; sleep?: boolean } = {}): string {
  const dir = temp('fake-python-');
  const js = join(dir, 'fake-look.mjs');
  writeFileSync(js, [
    "import { createHash } from 'node:crypto';",
    "import { readFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `if (args[0] === '-c') { if (${opts.cv2 === false}) { console.error("ModuleNotFoundError: No module named 'cv2'"); process.exit(1); } console.log('5.0.0-fake'); process.exit(0); }`,
    `if (${opts.sleep === true}) { setInterval(() => {}, 1000); }`,
    `else if (${opts.fail === true}) { console.log(JSON.stringify({ ok: false, error: { code: 'unreadable', message: 'OpenCV could not decode the image' } })); process.exit(2); }`,
    'else {',
    "  const image = args[1]; const as = args[args.indexOf('--as') + 1];",
    '  const bytes = readFileSync(image);',
    "  console.error('a warning on stderr');",
    "  console.log(JSON.stringify({ ok: true, worker: { name: 'timmy-look', version: 'fake' }, opencv: '5.0.0-fake', python: 'fake', source: { path: as, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, image: { width: 4, height: 2, channels: 3 }, measurements: [{ name: 'mean_color', value: { r: 200, g: 10, b: 10, hex: '#c80a0a' }, unit: 'sRGB 8-bit, uncalibrated', tier: 'deterministic computation', note: 'test double' }], uncertainty: ['Colors are uncalibrated.'] }));",
    '}',
  ].join('\n'));
  const sh = join(dir, 'python');
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

function make(root: string, extra: Partial<WorkspaceDeps> = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env: {},
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('jobs-'), 'jobs'),
    chdir: () => {},
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}rest` })) as unknown as Receipt[],
    ...extra,
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed };
}

describe('finding the Python for Look', () => {
  it('takes TIMMY_VISION_PYTHON, then TIMMY_VISUAL_PYTHON, then python3 on the PATH; a relative path is refused', () => {
    expect(lookPython({ TIMMY_VISION_PYTHON: '/opt/a/python', TIMMY_VISUAL_PYTHON: '/opt/b/python' }, () => '/usr/bin/python3')).toEqual({ python: '/opt/a/python', from: 'TIMMY_VISION_PYTHON' });
    expect(lookPython({ TIMMY_VISUAL_PYTHON: '/opt/b/python' }, () => null)).toEqual({ python: '/opt/b/python', from: 'TIMMY_VISUAL_PYTHON' });
    expect(lookPython({}, (c) => (c === 'python3' ? '/usr/bin/python3' : null))).toEqual({ python: '/usr/bin/python3', from: 'PATH' });
    expect('error' in lookPython({ TIMMY_VISION_PYTHON: 'python' }, () => null)).toBe(true);
    expect('error' in lookPython({}, () => null)).toBe(true);
  });
});

describe('/observe through a job (fake worker)', () => {
  it('runs Look as a job, writes the observation, seals one observe receipt, and Results lists it', async () => {
    const root = temp('proj-');
    put(root, 'refs/board.png', PNG);
    const { ws, sealed, notes } = make(root, { env: { TIMMY_VISION_PYTHON: fakePython() } });
    const started = await ws.observeFile('refs/board.png');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(ws.jobs.get(started.job.id)?.label).toBe('look refs/board.png');
    const outcome = await started.done;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.file).toMatch(/^results\/observations\/board-\d{8}-\d{6}\.json$/);
    const written = JSON.parse(readFileSync(join(root, outcome.file), 'utf8'));
    expect(written.source).toEqual({ path: 'refs/board.png', sha256: createHash('sha256').update(PNG).digest('hex'), bytes: PNG.length });
    expect(written.tiers).toEqual(['deterministic computation']);
    expect(written.look.measurements[0].tier).toBe('deterministic computation');
    const observe = sealed.filter((r) => r.kind === 'observe');
    expect(observe).toHaveLength(1);
    expect(sealed.filter((r) => r.kind === 'task')).toEqual([]);
    expect(observe[0]).toMatchObject({
      status: 'ok', files: [{ path: 'refs/board.png', sha256: written.source.sha256 }],
      outputs: [{ path: outcome.file }], observation: { tiers: ['deterministic computation'] }, job: { id: started.job.id, state: 'completed' },
    });
    expect(JSON.stringify(sealed)).not.toContain(root);
    expect(notes.some((n) => n.includes(started.job.id) && n.includes('observed'))).toBe(true);
    const results = text(ws.results(''));
    expect(results).toContain('Observations');
    expect(results).toMatch(/refs\/board\.png.*results\/observations\/board-/);
    expect(results).toContain('receipt 00000000');
  });

  it('a worker that cannot read the image fails the observation, honestly, with no observation file', async () => {
    const root = temp('proj-');
    put(root, 'refs/bad.png', PNG);
    const { ws, sealed } = make(root, { env: { TIMMY_VISION_PYTHON: fakePython({ fail: true }) } });
    const started = await ws.observeFile('refs/bad.png');
    if (!started.ok) throw new Error(started.error);
    const outcome = await started.done;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('could not decode');
    expect(existsSync(join(root, 'results'))).toBe(false);
    expect(sealed.at(-1)).toMatchObject({ kind: 'observe', status: 'failed' });
    expect(sealed.at(-1)?.outputs).toBeUndefined();
  });

  it('a stopped Look ends cancelled, with a receipt that says so', async () => {
    const root = temp('proj-');
    put(root, 'refs/slow.png', PNG);
    const { ws, sealed } = make(root, { env: { TIMMY_VISION_PYTHON: fakePython({ sleep: true }) } });
    const started = await ws.observeFile('refs/slow.png');
    if (!started.ok) throw new Error(started.error);
    for (let i = 0; i < 100 && ws.jobs.get(started.job.id)?.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 20));
    await ws.stop(started.job.id);
    const outcome = await started.done;
    expect(outcome.ok).toBe(false);
    expect(sealed.at(-1)).toMatchObject({ kind: 'observe', status: 'cancelled', job: { state: 'cancelled' } });
  });

  it('without OpenCV nothing runs, and it says how to get it', async () => {
    const root = temp('proj-');
    put(root, 'refs/a.png', PNG);
    const { ws, sealed } = make(root, { env: { TIMMY_VISION_PYTHON: fakePython({ cv2: false }) } });
    const lines = text(await ws.observe('refs/a.png'));
    expect(lines).toContain('OpenCV');
    expect(lines).toContain('opencv-python-headless');
    expect(ws.jobs.list()).toEqual([]);
    expect(sealed).toEqual([]);
  });
});

const python = spawnSync('python3', ['-c', 'import cv2, numpy'], { encoding: 'utf8' }).status === 0 ? 'python3' : null;

describe.skipIf(!python)('the real Look worker (OpenCV is importable here)', () => {
  it('measures a generated image: size, colors, QR text, markers; the same bytes give the same answer', async () => {
    const dir = temp('look-real-');
    const image = join(dir, 'card.png');
    const gen = [
      'import cv2, numpy as np, sys',
      'img = np.full((400, 600, 3), 255, np.uint8)',
      "qr = cv2.QRCodeEncoder.create().encode('timmy-look-test')",
      'qr = cv2.resize(qr, (qr.shape[1] * 6, qr.shape[0] * 6), interpolation=cv2.INTER_NEAREST)',
      'qr = cv2.cvtColor(qr, cv2.COLOR_GRAY2BGR) if qr.ndim == 2 else qr',
      'h, w = qr.shape[:2]',
      'img[20:20 + h, 20:20 + w] = qr',
      'img[330:390, 0:600] = (0, 0, 255)',
      "if hasattr(cv2, 'aruco'):",
      '    m = cv2.aruco.generateImageMarker(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50), 7, 160)',
      '    img[60:220, 400:560] = cv2.cvtColor(m, cv2.COLOR_GRAY2BGR)',
      'cv2.imwrite(sys.argv[1], img)',
    ].join('\n');
    expect(spawnSync(python!, ['-c', gen, image], { encoding: 'utf8' }).status).toBe(0);
    const first = await runLook({ python: python!, imagePath: image, rel: 'refs/card.png' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const o = first.observation;
    expect(o.worker.name).toBe('timmy-look');
    expect(o.source).toEqual({ path: 'refs/card.png', sha256: createHash('sha256').update(readFileSync(image)).digest('hex'), bytes: readFileSync(image).length });
    expect(o.image).toEqual({ width: 600, height: 400, channels: 3 });
    const by = Object.fromEntries(o.measurements.map((m) => [m.name, m]));
    for (const m of o.measurements) expect(m.tier).toBe('deterministic computation');
    expect(by.qr_codes_decoded.value).toEqual([expect.objectContaining({ text: 'timmy-look-test' })]);
    const colors = by.dominant_colors.value as Array<{ hex: string; share: number }>;
    expect(colors.length).toBeGreaterThan(1);
    expect(colors.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 2);
    expect(colors[0].hex).toBe('#ffffff');
    expect(typeof by.sharpness.value).toBe('number');
    expect(by.edge_density.value).toBeGreaterThan(0);
    if (by.aruco_markers.value !== null) expect(by.aruco_markers.value).toEqual([expect.objectContaining({ id: 7 })]);
    expect(o.uncertainty.length).toBeGreaterThan(2);
    const second = await runLook({ python: python!, imagePath: image, rel: 'refs/card.png' });
    expect(second.ok && JSON.stringify(second.observation)).toBe(JSON.stringify(o));
    expect(JSON.stringify(o)).not.toContain(dir);
  });

  it('through the workspace: /add, then /observe, as a job with the real worker; one intake and one observe receipt', async () => {
    const root = temp('proj-');
    const out = temp('outside-');
    const gen = "import cv2, numpy as np, sys\nimg = np.zeros((120, 160, 3), np.uint8)\nimg[:, 80:] = (255, 255, 255)\ncv2.imwrite(sys.argv[1], img)";
    expect(spawnSync(python!, ['-c', gen, join(out, 'half.png')], { encoding: 'utf8' }).status).toBe(0);
    const { ws, sealed } = make(root, { env: {}, onPath: (c) => (c === 'python3' ? (spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim() || null) : null) });
    expect(text(ws.add(join(out, 'half.png')))).toMatch(/refs\/half\.png\s+image/);
    const started = await ws.observeFile('refs/half.png');
    if (!started.ok) throw new Error(started.error);
    const outcome = await started.done;
    if (!outcome.ok) throw new Error(outcome.error);
    const written = JSON.parse(readFileSync(join(root, outcome.file), 'utf8'));
    expect(written.look.image).toEqual({ width: 160, height: 120, channels: 3 });
    const shares = Object.fromEntries((written.look.measurements.find((m: { name: string }) => m.name === 'dominant_colors').value as Array<{ hex: string; share: number }>).map((c) => [c.hex, c.share]));
    expect(shares).toEqual({ '#000000': 0.5, '#ffffff': 0.5 });
    expect(sealed.map((r) => r.kind)).toEqual(['intake', 'observe']);
    expect(JSON.stringify(sealed)).not.toContain(root);
    expect(JSON.stringify(sealed)).not.toContain(out);
  });

  it('an unreadable image is a JSON error and a nonzero exit', async () => {
    const dir = temp('look-real-');
    const image = join(dir, 'not.png');
    writeFileSync(image, 'not an image');
    const r = await runLook({ python: python!, imagePath: image, rel: 'refs/not.png' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/could not (decode|read)/);
    expect(existsSync(LOOK_SCRIPT)).toBe(true);
  });
});

// Round R2 (the Mac run): a sandboxed HOME hid OpenCV installed with pip --user; TIMMY_NATIVE_HOME is the
// home local runtimes use.
describe('the Look worker on a sandboxed Timmy', () => {
  it('runs Python with HOME from TIMMY_NATIVE_HOME when it is set, and leaves the rest as it is', async () => {
    const { lookEnv } = await import('../src/vision/look.js');
    expect(lookEnv({ HOME: '/tmp/sandbox', TIMMY_NATIVE_HOME: '/tmp/native', PATH: '/bin' })).toMatchObject({ HOME: '/tmp/native', PATH: '/bin' });
    expect(lookEnv({ HOME: '/tmp/sandbox', PATH: '/bin' })).toEqual({ HOME: '/tmp/sandbox', PATH: '/bin' });
  });
});
