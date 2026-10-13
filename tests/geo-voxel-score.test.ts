// The geo lane's voxel bench scorer: voxel occupancy F1/IoU on a truth-anchored grid plus Chamfer and F-score@τ, with
// no fitting unless asked (and then metric:false, exit 2). Needs python3 with numpy + scipy; skips (visibly) without them.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAsync } from './helpers/run-async.js';

const ROOT = join(__dirname, '..');
const scorer = join(ROOT, 'lanes', 'geo', 'voxel_score.py');
const deps = spawnSync('python3', ['-c', 'import numpy, scipy'], { encoding: 'utf8' }).status === 0;
// Awaited, never spawnSync: back-to-back synchronous runs held this worker's event loop for 71 s on a loaded machine,
// past vitest's 60 s worker RPC timeout ("Timeout calling onTaskUpdate", R4 H31).
const py = (code: string, ...args: string[]) => runAsync('python3', ['-c', code, ...args]);
const python = (args: string[]) => runAsync('python3', args);
const run = (args: string[], env: Record<string, string> = {}) => runAsync('python3', [scorer, ...args], { env: { ...process.env, ...env }, timeout: 120000 });

// two axis-aligned planes as point PLYs: the truth at x = 0 and a prediction moved exactly one voxel along x
const PLANES = `
import sys, numpy as np
from pathlib import Path
S = Path(sys.argv[1]); rng = np.random.default_rng(1)
def ply(name, pts):
    p = pts.astype(np.float32)
    (S / name).write_bytes(('ply\\nformat binary_little_endian 1.0\\nelement vertex %d\\nproperty float x\\nproperty float y\\nproperty float z\\nend_header\\n' % len(p)).encode() + p.tobytes())
u = rng.uniform(0, 4, (20000, 2))
truth = np.c_[np.zeros(len(u)), u]
ply('truth.ply', truth); ply('same.ply', truth + rng.normal(0, 0.002, truth.shape)); ply('shift.ply', truth + np.array([0.25, 0, 0]))
print('ok')
`;

describe('geo voxel scorer', () => {
  it('ships with its README, answers --help on a bare interpreter, and reports not_configured (exit 3) without numpy', async () => {
    expect(existsSync(scorer)).toBe(true);
    expect(readFileSync(join(ROOT, 'lanes', 'geo', 'README.md'), 'utf8')).toContain('voxel_score.py');
    const shadow = mkdtempSync(join(tmpdir(), 'geo-nonumeric-'));
    for (const m of ['numpy', 'scipy']) writeFileSync(join(shadow, `${m}.py`), 'raise ImportError("shadowed for the test")\n');
    const env = { PYTHONPATH: shadow, PYTHONDONTWRITEBYTECODE: '1' };
    const h = await run(['--help'], env);
    expect(h.status, h.stderr).toBe(0); expect(h.stdout).toMatch(/usage/i);
    const r = await run(['--selftest'], env);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, status: 'not_configured' });
  });
  it.skipIf(!deps)('a mesh input without trimesh is not_configured (exit 3) too, never an exit-1 traceback (Cursor: mesh path broke the honesty clause)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-mesh-'));
    writeFileSync(join(dir, 'box.obj'), 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3\nf 1 3 4\n');
    const shadow = mkdtempSync(join(tmpdir(), 'geo-notrimesh-')); writeFileSync(join(shadow, 'trimesh.py'), 'raise ImportError("shadowed for the test")\n');
    const r = await run(['--truth', join(dir, 'box.obj'), '--pred', join(dir, 'box.obj')], { PYTHONPATH: shadow, PYTHONDONTWRITEBYTECODE: '1' });
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, status: 'not_configured' });
    expect(r.stderr).not.toMatch(/Traceback/);
  });

  it.skipIf(!deps)('one voxel of displacement is the whole story: strict voxel F1 0, F-score 0 under τ and 1 over it; the same plane scores ≈1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-vox-'));
    expect((await py(PLANES, dir)).stdout.trim()).toBe('ok');
    const same = await run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'same.ply'), '--voxel', '0.25', '--tau', '0.1']);
    expect(same.status, same.stderr).toBe(0);
    const s = JSON.parse(same.stdout.trim());
    expect(s.metric).toBe(true); expect(s.fit.applied).toBe(false); expect(s.unit).toBe('m');
    expect(s.voxel.f1).toBeGreaterThan(0.97); expect(s.surface.fscore.f).toBeGreaterThan(0.99);
    expect(s.surface.chamfer_mean_dist).toBeLessThan(0.02);                       // the sampling floor, never exactly 0
    expect(s.voxel.grid_unstable).toBe(false);                                     // 2 mm jitter must not move a truth-centred grid
    // the F1 band: eight grid phases, headline inside the band, band width is the sensitivity; --phases 2 keeps the diagonal pair
    expect(s.voxel.phases).toBe(8); expect(s.voxel.f1_phases).toHaveLength(8);
    expect(s.voxel.f1_band[0]).toBeLessThanOrEqual(s.voxel.f1); expect(s.voxel.f1_band[1]).toBeGreaterThanOrEqual(s.voxel.f1);
    expect(s.voxel.grid_sensitivity).toBeCloseTo(s.voxel.f1_band[1] - s.voxel.f1_band[0], 4);
    const two = JSON.parse((await run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'same.ply'), '--voxel', '0.25', '--tau', '0.1', '--phases', '2'])).stdout.trim());
    expect(two.voxel.phases).toBe(2); expect(two.voxel.f1_phases).toHaveLength(2);
    const sh = JSON.parse((await run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'shift.ply'), '--voxel', '0.25', '--tau', '0.1'])).stdout.trim());
    expect(sh.voxel.f1).toBe(0); expect(sh.voxel.iou).toBe(0);
    expect(sh.surface.fscore).toMatchObject({ tau: 0.1, precision: 0, recall: 0, f: 0 });
    expect(sh.surface.chamfer_mean_dist).toBeCloseTo(0.25, 2);
    const wide = JSON.parse((await run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'shift.ply'), '--voxel', '0.25', '--tau', '0.3'])).stdout.trim());
    expect(wide.surface.fscore.f).toBe(1);                                         // τ = 0.3 forgives a 0.25 shift; the voxel grid does not
    expect(wide.voxel.f1).toBe(0);
  });

  it.skipIf(!deps)('--fit recovers the shifted plane but says metric:false and exits 2; --normalize switches to unit-cube units', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-vox-'));
    expect((await py(PLANES, dir)).stdout.trim()).toBe('ok');
    const f = await run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'shift.ply'), '--fit', '--out', join(dir, 'fit.json')]);
    expect(f.status, f.stderr).toBe(2);
    const j = JSON.parse(readFileSync(join(dir, 'fit.json'), 'utf8'));
    expect(j.metric).toBe(false); expect(j.fit.applied).toBe(true); expect(j.voxel.f1).toBeGreaterThan(0.97);
    expect(j.note.join(' ')).toMatch(/not a metric one/);
    const n = JSON.parse((await run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'shift.ply'), '--normalize', '--voxel', '0.0625', '--tau', '0.1'])).stdout.trim());
    expect(n.unit).toBe('unit-cube'); expect(n.metric).toBe(true);
    expect(n.surface.chamfer_mean_dist).toBeCloseTo(0.25 / 4, 2);                  // the plane spans 4 m → shift is 1/16 of the unit cube
    expect(n.surface.fscore.f).toBe(1);                                            // 0.0625 ≤ τ 0.1 in unit-cube terms
  });

  it.skipIf(!deps)('--fit undoes a 15 % shrink plus a shift on the house (scale ≈ 1.176) with Open3D when present and with the numpy loop when not; both say metric:false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-fit-'));
    const house = `
import sys, numpy as np, importlib.util
spec = importlib.util.spec_from_file_location('vs', sys.argv[2]); vs = importlib.util.module_from_spec(spec); spec.loader.exec_module(vs)
t = vs.synthetic_house(seed=7); p = vs.synthetic_house(seed=11); c = t.mean(0)
def ply(name, pts):
    q = pts.astype(np.float32); open(sys.argv[1] + '/' + name, 'wb').write(('ply\\nformat binary_little_endian 1.0\\nelement vertex %d\\nproperty float x\\nproperty float y\\nproperty float z\\nend_header\\n' % len(q)).encode() + q.tobytes())
ply('truth.ply', t); ply('scaled.ply', (p - c) * 0.85 + c + np.array([0.3, -0.2, 0.1]))
print('ok')
`;
    expect((await py(house, dir, scorer)).stdout.trim()).toBe('ok');
    const unfit = JSON.parse((await run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'scaled.ply'), '--phases', '2'])).stdout.trim());
    expect(unfit.metric).toBe(true); expect(unfit.voxel.f1).toBeLessThan(0.2);                 // metric, and honestly bad
    const o3dOk = (await python(['-c', 'import open3d'])).status === 0;
    const fit = await run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'scaled.ply'), '--fit', '--phases', '2']);
    expect(fit.status, fit.stderr).toBe(2);
    const f = JSON.parse(fit.stdout.trim());
    expect(f.metric).toBe(false); expect(f.fit.engine).toMatch(o3dOk ? /^open3d-/ : /^numpy-umeyama$/);
    expect(f.voxel.f1).toBeGreaterThan(0.95); expect(Math.abs(f.fit.scale_applied - 1 / 0.85)).toBeLessThan(0.01);
    // the numpy loop is the fallback everywhere Open3D is not installed: shadow it and the control must still hold
    const shadow = mkdtempSync(join(tmpdir(), 'geo-noo3d-')); writeFileSync(join(shadow, 'open3d.py'), 'raise ImportError("shadowed for the test")\n');
    const np = JSON.parse((await run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'scaled.ply'), '--fit', '--phases', '2'], { PYTHONPATH: shadow, PYTHONDONTWRITEBYTECODE: '1' })).stdout.trim());
    expect(np.fit.engine).toBe('numpy-umeyama'); expect(np.voxel.f1).toBeGreaterThan(0.9); expect(Math.abs(np.fit.scale_applied - 1 / 0.85)).toBeLessThan(0.02);
  }, 120000);

  it.skipIf(!deps)('controls: the same house in place scores ≈1, shifted 0.5 m or scaled 0.85 it drops clearly, and the fit undoes a pure shift', async () => {
    const r = await run(['--selftest']);
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout.trim());
    expect(j.selftest).toBe('ok');
    expect(j.voxel_f1.in_place).toBeGreaterThan(0.97); expect(j.fscore.in_place).toBeGreaterThan(0.99);
    expect(j.voxel_f1.shift_0p5m).toBeLessThan(0.6); expect(j.voxel_f1.scale_0p85).toBeLessThan(0.6);
    expect(j.fit_recovers_shift).toMatchObject({ metric: false }); expect(j.fit_recovers_shift.voxel_f1).toBeGreaterThan(0.95);
    expect(j.sampling_floor_chamfer).toBeGreaterThan(0);
    expect(j.voxel_f1_band.shift_0p5m[1]).toBeGreaterThan(j.voxel_f1_band.shift_0p5m[0]);     // the knife edge shows up as band width, not as luck
    expect(j.voxel_f1_band.scale_0p85).toEqual([0, 0]);
  }, 90000);

  // an L of two boxes (no symmetry, so its pose is unique) as surface points; the prediction is the same L turned 90° about
  // x and 37° about z, scaled 2.3× and moved — what a generator hands back: its own up axis, its own yaw, its own scale
  const POSED = `
import sys, numpy as np, trimesh
from pathlib import Path
S = Path(sys.argv[1])
def ply(name, pts, extra=None):
    cols = [('x', pts[:, 0]), ('y', pts[:, 1]), ('z', pts[:, 2])] + (extra or [])
    head = 'ply\\nformat binary_little_endian 1.0\\nelement vertex %d\\n' % len(pts) + ''.join('property float %s\\n' % n for n, _ in cols) + 'end_header\\n'
    (S / name).write_bytes(head.encode() + np.stack([c for _, c in cols], 1).astype(np.float32).tobytes())
a = trimesh.creation.box(extents=[0.4, 0.1, 0.1]); b = trimesh.creation.box(extents=[0.1, 0.25, 0.1]); b.apply_translation([-0.15, 0.175, 0])
L = trimesh.util.concatenate([a, b])
truth = np.asarray(trimesh.sample.sample_surface(L, 12000, seed=1)[0]); pred0 = np.asarray(trimesh.sample.sample_surface(L, 12000, seed=2)[0])
def rot(ax, deg):
    c, s = np.cos(np.radians(deg)), np.sin(np.radians(deg)); i, j = [k for k in range(3) if k != ax]
    m = np.eye(3); m[i, i] = c; m[i, j] = -s; m[j, i] = s; m[j, j] = c; return m
posed = (pred0 @ (rot(2, 37) @ rot(0, 90)).T) * 2.3 + np.array([1.0, -2.0, 0.5])
ply('truth.ply', truth); ply('posed.ply', posed)
# the same L as a 3D Gaussian splat (3DGS layout, opacity as a logit) plus 3000 near-transparent floaters in a 2 m box
rng = np.random.default_rng(3); fl = rng.uniform(-1, 1, (3000, 3))
pts = np.r_[pred0, fl]; n = len(pts)
logit = np.r_[np.full(len(pred0), 4.0), np.full(len(fl), -6.0)]
z = np.zeros(n)
ply('splat.ply', pts, [('nx', z), ('ny', z), ('nz', z), ('f_dc_0', z), ('f_dc_1', z), ('f_dc_2', z), ('opacity', logit),
                       ('scale_0', z - 5), ('scale_1', z - 5), ('scale_2', z - 5), ('rot_0', z + 1), ('rot_1', z), ('rot_2', z), ('rot_3', z)])
print('ok')
`;

  it.skipIf(!deps)('--fit-global finds a generator-style pose (own up axis, yaw and scale) that the plain --fit cannot; both say metric:false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-posed-'));
    const mk = await py(POSED, dir);
    if (mk.status !== 0 && /No module named 'trimesh'/.test(mk.stderr)) return;                 // trimesh is optional for the scorer
    expect(mk.stdout.trim(), mk.stderr).toBe('ok');
    const args = ['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'posed.ply'), '--voxel', '0.01', '--tau', '0.01'];
    const plain = await run([...args, '--fit']);
    expect(plain.status).toBe(2);
    const p = JSON.parse(plain.stdout.trim());
    expect(p.fit.rotations).toBe('identity'); expect(p.voxel.f1).toBeLessThan(0.5);
    const glob = await run([...args, '--fit-global']);
    expect(glob.status, glob.stderr).toBe(2);
    const g = JSON.parse(glob.stdout.trim());
    expect(g.metric).toBe(false);
    expect(g.fit).toMatchObject({ applied: true, rotations: 'global', start_poses: 384, rotation_ambiguous: false });
    expect(g.fit.scale_applied).toBeCloseTo(1 / 2.3, 2);
    expect(g.voxel.f1).toBeGreaterThan(0.9); expect(g.surface.fscore.f).toBeGreaterThan(0.95);
    expect(g.note.join(' ')).toMatch(/global rotation search over 384 start poses/);
  }, 180000);

  it.skipIf(!deps)('a 3D Gaussian splat PLY is read as the centres of its opaque Gaussians: floaters are dropped and counted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-splat-'));
    const mk = await py(POSED, dir);
    if (mk.status !== 0 && /No module named 'trimesh'/.test(mk.stderr)) return;
    expect(mk.stdout.trim(), mk.stderr).toBe('ok');
    const args = ['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'splat.ply'), '--voxel', '0.01', '--tau', '0.01'];
    const r = await run(args);                                                                           // same frame as the truth: no fit needed
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout.trim());
    expect(j.inputs.pred_from).toBe('splat-centers opacity>=0.1 (12000 of 15000)');
    expect(j.points.pred).toBe(12000); expect(j.voxel.precision).toBeGreaterThan(0.95);
    const all = JSON.parse((await run([...args, '--splat-min-opacity', '0.001'])).stdout.trim());         // keep the floaters: precision collapses
    expect(all.inputs.pred_from).toBe('splat-centers opacity>=0.001 (15000 of 15000)');
    expect(all.voxel.precision).toBeLessThan(j.voxel.precision - 0.1);
  }, 120000);

  // Bugbot (PR #86): with every Gaussian under --splat-min-opacity the prediction is empty, and the scorer died in cKDTree
  // with a traceback. An empty prediction is a result — F1 0, F-score 0, no Chamfer (null, never NaN) — and a fit has
  // nothing to work on, so it is skipped and said so; an empty TRUTH leaves nothing to score against and is refused.
  const EMPTY = `
import sys, json, numpy as np
from pathlib import Path
S = Path(sys.argv[1]); rng = np.random.default_rng(4)
u = rng.uniform(0, 2, (5000, 2)); pts = np.c_[u, np.zeros(len(u))]; z = np.zeros(len(pts))
cols = [pts[:, 0], pts[:, 1], pts[:, 2], z + 3.0, z, z, z]; names = ['x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2']
head = 'ply\\nformat binary_little_endian 1.0\\nelement vertex %d\\n' % len(pts) + ''.join('property float %s\\n' % n for n in names) + 'end_header\\n'
(S / 'splat.ply').write_bytes(head.encode() + np.stack(cols, 1).astype(np.float32).tobytes())
(S / 'truth.json').write_text(json.dumps({'points': pts.tolist()}))
(S / 'one.json').write_text(json.dumps({'points': [[0.5, 0.5, 0.0]]}))
print('ok')
`;

  it.skipIf(!deps)('Bugbot: a splat with no Gaussian over the bar is an empty prediction — F1 0, Chamfer null, fit skipped — never a traceback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-empty-'));
    const mk = await py(EMPTY, dir);
    expect(mk.stdout.trim(), mk.stderr).toBe('ok');
    const args = ['--truth', join(dir, 'truth.json'), '--pred', join(dir, 'splat.ply'), '--voxel', '0.1', '--tau', '0.05', '--splat-min-opacity', '1'];
    const r = await run(args);                                                   // a logit of 3 is 95 % opaque: under a bar of 1.0
    expect(r.status, r.stderr).toBe(0); expect(r.stderr).not.toMatch(/Traceback/);
    const j = JSON.parse(r.stdout.trim());
    expect(j).toMatchObject({ empty_prediction: true, points: { truth: 5000, pred: 0 }, inputs: { pred_from: 'splat-centers opacity>=1 (0 of 5000)' } });
    expect(j.voxel.f1).toBe(0); expect(j.voxel.recall).toBe(0); expect(j.surface.fscore.f).toBe(0);
    expect(j.surface).toMatchObject({ chamfer_mean_dist: null, chamfer_l2_sq: null, pred_to_truth_p95: null, truth_to_pred_p95: null });
    expect(j.note.join(' ')).toMatch(/no points/);
    for (const extra of [['--fit-global'], ['--fit', '--normalize']]) {   // a fit asked for: skipped, still metric:false (exit 2), JSON all the same
      const f = await run([...args, ...extra]);
      expect(f.status, `${extra} ${f.stderr}`).toBe(2);
      const k = JSON.parse(f.stdout.trim());
      expect(k.metric).toBe(false); expect(k.fit).toMatchObject({ applied: false, skipped: 'empty prediction' });
    }
    // one point has no extent: the similarity fit would divide by zero (NaN, which is not JSON); it is skipped too
    const one = await run(['--truth', join(dir, 'truth.json'), '--pred', join(dir, 'one.json'), '--voxel', '0.1', '--tau', '0.05', '--fit-global']);
    expect(one.status, one.stderr).toBe(2); expect(one.stdout).not.toMatch(/NaN|Infinity/);
    const o = JSON.parse(one.stdout.trim());
    expect(o.empty_prediction).toBe(false); expect(o.fit.skipped).toMatch(/fewer than 3 points/); expect(o.surface.chamfer_mean_dist).toBeGreaterThan(0);
    // the other way round there is nothing to score against: refused (exit 2) with a status, not a traceback
    const t = await run(['--truth', join(dir, 'splat.ply'), '--pred', join(dir, 'truth.json'), '--splat-min-opacity', '1']);
    expect(t.status).toBe(2); expect(t.stderr).not.toMatch(/Traceback/);
    expect(JSON.parse(t.stdout.trim())).toMatchObject({ ok: false, status: 'refused' });
  }, 120000);
});
