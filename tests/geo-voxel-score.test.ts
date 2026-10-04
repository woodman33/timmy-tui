// The geo lane's voxel bench scorer: voxel occupancy F1/IoU on a truth-anchored grid plus Chamfer and F-score@τ, with
// no fitting unless asked (and then metric:false, exit 2). Needs python3 with numpy + scipy; skips (visibly) without them.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const scorer = join(ROOT, 'lanes', 'geo', 'voxel_score.py');
const deps = spawnSync('python3', ['-c', 'import numpy, scipy'], { encoding: 'utf8' }).status === 0;
const py = (code: string, ...args: string[]) => spawnSync('python3', ['-c', code, ...args], { encoding: 'utf8' });
const run = (args: string[], env: Record<string, string> = {}) => spawnSync('python3', [scorer, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });

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
  it('ships with its README, answers --help on a bare interpreter, and reports not_configured (exit 3) without numpy', () => {
    expect(existsSync(scorer)).toBe(true);
    expect(readFileSync(join(ROOT, 'lanes', 'geo', 'README.md'), 'utf8')).toContain('voxel_score.py');
    const shadow = mkdtempSync(join(tmpdir(), 'geo-nonumeric-'));
    for (const m of ['numpy', 'scipy']) writeFileSync(join(shadow, `${m}.py`), 'raise ImportError("shadowed for the test")\n');
    const env = { PYTHONPATH: shadow, PYTHONDONTWRITEBYTECODE: '1' };
    const h = run(['--help'], env);
    expect(h.status, h.stderr).toBe(0); expect(h.stdout).toMatch(/usage/i);
    const r = run(['--selftest'], env);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, status: 'not_configured' });
  });
  it.skipIf(!deps)('a mesh input without trimesh is not_configured (exit 3) too, never an exit-1 traceback (Cursor: mesh path broke the honesty clause)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-mesh-'));
    writeFileSync(join(dir, 'box.obj'), 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3\nf 1 3 4\n');
    const shadow = mkdtempSync(join(tmpdir(), 'geo-notrimesh-')); writeFileSync(join(shadow, 'trimesh.py'), 'raise ImportError("shadowed for the test")\n');
    const r = run(['--truth', join(dir, 'box.obj'), '--pred', join(dir, 'box.obj')], { PYTHONPATH: shadow, PYTHONDONTWRITEBYTECODE: '1' });
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, status: 'not_configured' });
    expect(r.stderr).not.toMatch(/Traceback/);
  });

  it.skipIf(!deps)('one voxel of displacement is the whole story: strict voxel F1 0, F-score 0 under τ and 1 over it; the same plane scores ≈1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-vox-'));
    expect(py(PLANES, dir).stdout.trim()).toBe('ok');
    const same = run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'same.ply'), '--voxel', '0.25', '--tau', '0.1']);
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
    const two = JSON.parse(run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'same.ply'), '--voxel', '0.25', '--tau', '0.1', '--phases', '2']).stdout.trim());
    expect(two.voxel.phases).toBe(2); expect(two.voxel.f1_phases).toHaveLength(2);
    const sh = JSON.parse(run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'shift.ply'), '--voxel', '0.25', '--tau', '0.1']).stdout.trim());
    expect(sh.voxel.f1).toBe(0); expect(sh.voxel.iou).toBe(0);
    expect(sh.surface.fscore).toMatchObject({ tau: 0.1, precision: 0, recall: 0, f: 0 });
    expect(sh.surface.chamfer_mean_dist).toBeCloseTo(0.25, 2);
    const wide = JSON.parse(run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'shift.ply'), '--voxel', '0.25', '--tau', '0.3']).stdout.trim());
    expect(wide.surface.fscore.f).toBe(1);                                         // τ = 0.3 forgives a 0.25 shift; the voxel grid does not
    expect(wide.voxel.f1).toBe(0);
  });

  it.skipIf(!deps)('--fit recovers the shifted plane but says metric:false and exits 2; --normalize switches to unit-cube units', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-vox-'));
    expect(py(PLANES, dir).stdout.trim()).toBe('ok');
    const f = run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'shift.ply'), '--fit', '--out', join(dir, 'fit.json')]);
    expect(f.status, f.stderr).toBe(2);
    const j = JSON.parse(readFileSync(join(dir, 'fit.json'), 'utf8'));
    expect(j.metric).toBe(false); expect(j.fit.applied).toBe(true); expect(j.voxel.f1).toBeGreaterThan(0.97);
    expect(j.note.join(' ')).toMatch(/not a metric one/);
    const n = JSON.parse(run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'shift.ply'), '--normalize', '--voxel', '0.0625', '--tau', '0.1']).stdout.trim());
    expect(n.unit).toBe('unit-cube'); expect(n.metric).toBe(true);
    expect(n.surface.chamfer_mean_dist).toBeCloseTo(0.25 / 4, 2);                  // the plane spans 4 m → shift is 1/16 of the unit cube
    expect(n.surface.fscore.f).toBe(1);                                            // 0.0625 ≤ τ 0.1 in unit-cube terms
  });

  it.skipIf(!deps)('--fit undoes a 15 % shrink plus a shift on the house (scale ≈ 1.176) with Open3D when present and with the numpy loop when not; both say metric:false', () => {
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
    expect(py(house, dir, scorer).stdout.trim()).toBe('ok');
    const unfit = JSON.parse(run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'scaled.ply'), '--phases', '2']).stdout.trim());
    expect(unfit.metric).toBe(true); expect(unfit.voxel.f1).toBeLessThan(0.2);                 // metric, and honestly bad
    const o3dOk = spawnSync('python3', ['-c', 'import open3d'], { encoding: 'utf8' }).status === 0;
    const fit = run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'scaled.ply'), '--fit', '--phases', '2']);
    expect(fit.status, fit.stderr).toBe(2);
    const f = JSON.parse(fit.stdout.trim());
    expect(f.metric).toBe(false); expect(f.fit.engine).toMatch(o3dOk ? /^open3d-/ : /^numpy-umeyama$/);
    expect(f.voxel.f1).toBeGreaterThan(0.95); expect(Math.abs(f.fit.scale_applied - 1 / 0.85)).toBeLessThan(0.01);
    // the numpy loop is the fallback everywhere Open3D is not installed: shadow it and the control must still hold
    const shadow = mkdtempSync(join(tmpdir(), 'geo-noo3d-')); writeFileSync(join(shadow, 'open3d.py'), 'raise ImportError("shadowed for the test")\n');
    const np = JSON.parse(run(['--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'scaled.ply'), '--fit', '--phases', '2'], { PYTHONPATH: shadow, PYTHONDONTWRITEBYTECODE: '1' }).stdout.trim());
    expect(np.fit.engine).toBe('numpy-umeyama'); expect(np.voxel.f1).toBeGreaterThan(0.9); expect(Math.abs(np.fit.scale_applied - 1 / 0.85)).toBeLessThan(0.02);
  }, 120000);

  it.skipIf(!deps)('controls: the same house in place scores ≈1, shifted 0.5 m or scaled 0.85 it drops clearly, and the fit undoes a pure shift', () => {
    const r = run(['--selftest']);
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
});
