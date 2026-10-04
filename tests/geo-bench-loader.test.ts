// Bench loader (lanes/geo/bench_loader.py): a public 3D set → truth + manifest → scored predictions, offline. A synthetic
// WebDataset shard (two trimesh boxes with GSO-style metadata) stands in for a GSO tar; the real smoke shard (5 objects,
// 90 MB, CC-BY-4.0) was run by hand on 2026-10-04 with the same code path. Needs python3 + numpy + scipy + trimesh.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const loader = join(ROOT, 'lanes', 'geo', 'bench_loader.py');
const deps = spawnSync('python3', ['-c', 'import numpy, scipy, trimesh'], { encoding: 'utf8' }).status === 0;
const run = (args: string[]) => spawnSync('python3', [loader, ...args], { encoding: 'utf8', timeout: 180000 });

const FAKE_SHARD = `
import io, json, sys, tarfile, numpy as np, trimesh
from pathlib import Path
S = Path(sys.argv[1])
def add(tar, name, data):
    ti = tarfile.TarInfo(name); ti.size = len(data); tar.addfile(ti, io.BytesIO(data))
with tarfile.open(S / 'fake-00000.tar', 'w') as tar:
    for oid, ext in (('box_a', [0.1, 0.2, 0.4]), ('box_b', [0.3, 0.05, 0.1])):
        m = trimesh.creation.box(extents=ext); m.apply_translation([0, 0, ext[2] / 2])           # metres, sitting on z = 0 like a scan
        add(tar, f'{oid}.obj', m.export(file_type='obj').encode())
        c = (m.bounds[0] + m.bounds[1]) / 2; s = 1.0 / max(ext)
        g = m.copy(); g.apply_translation(-c); g.apply_scale(s)
        add(tar, f'{oid}.glb', g.export(file_type='glb'))
        add(tar, f'{oid}.thumbnail_0.jpg', b'\\xff\\xd8\\xff\\xd9')
        add(tar, f'{oid}.json', json.dumps({'object_id': oid, 'name': oid, 'category': 'Test', 'license_id': 'cc-by-4.0',
            'glb_processing': {'normalization': 'center_aabb_to_origin+scale_max_extent_to_1', 'applied_translation': (-c).tolist(), 'applied_scale': s, 'final_extents': (np.array(ext) * s).tolist()}}).encode())
    add(tar, 'orphan.json', b'{}')                                                                   # metadata without a mesh → skipped, not fatal
print('ok')
`;
const PREDS = `
import sys, json, numpy as np, trimesh
from pathlib import Path
B = Path(sys.argv[1]); P = Path(sys.argv[2]); P.mkdir(exist_ok=True)
m = json.load(open(B / 'manifest.json'))
for o in m['objects']:
    e = o['frames']['metric']['extents_m']; mesh = trimesh.creation.box(extents=e); mesh.apply_translation([0, 0, e[2] / 2])
    if o['id'] == 'box_b': mesh.apply_translation([0.05, 0, 0])                                        # one prediction is 5 cm off
    pts, _ = trimesh.sample.sample_surface(mesh, 30000, seed=3); p = np.asarray(pts, dtype=np.float32)
    (P / f"{o['id']}.ply").write_bytes((f'ply\\nformat binary_little_endian 1.0\\nelement vertex {len(p)}\\nproperty float x\\nproperty float y\\nproperty float z\\nend_header\\n').encode() + p.tobytes())
print('ok')
`;

describe('geo bench loader', () => {
  it('has a usage line and documents the steps in the README', () => {
    const h = run(['--help']);
    expect(h.status, h.stderr).toBe(0); expect(h.stdout).toMatch(/fetch,extract,predict,score/);
    expect(readFileSync(join(ROOT, 'lanes', 'geo', 'README.md'), 'utf8')).toContain('bench_loader.py');
  });

  it.skipIf(!deps)('extract writes metric + unit truth per object with a manifest that carries licence, extents and hashes; score ranks a 5 cm miss below an exact box', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-bench-'));
    expect(spawnSync('python3', ['-c', FAKE_SHARD, dir], { encoding: 'utf8' }).stdout.trim()).toBe('ok');
    const ex = run(['extract', '--tar', join(dir, 'fake-00000.tar'), '--out', join(dir, 'bench'), '--samples', '40000']);
    expect(ex.status, ex.stderr).toBe(0);
    const man = JSON.parse(readFileSync(join(dir, 'bench', 'manifest.json'), 'utf8'));
    expect(man).toMatchObject({ kind: 'geo.bench-manifest', set: 'gso', count: 2, samples_per_object: 40000 });
    expect(man.source.license).toBe('cc-by-4.0'); expect(man.source.tar_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(man.skipped).toEqual([{ id: 'orphan', why: 'no metadata or no mesh' }]);
    const a = man.objects.find((o: any) => o.id === 'box_a');
    expect(a.frames.metric.extents_m.map((x: number) => Math.round(x * 100) / 100)).toEqual([0.1, 0.2, 0.4]);
    expect(a.frames.metric.unit).toBe('m'); expect(a.frames.unit.applied_scale).toBeCloseTo(2.5, 6);
    expect(a.frames.unit.glb_sha256).toMatch(/^[0-9a-f]{64}$/); expect(a.views).toEqual(['view_0.jpg']);
    for (const f of ['truth_metric.ply', 'truth_unit.glb', 'meta.json', 'view_0.jpg']) expect(existsSync(join(dir, 'bench', 'objects', 'box_a', f)), f).toBe(true);
    // predictions in the metric frame: box_a exact (resampled), box_b moved 5 cm → scored strictly, no fitting
    expect(spawnSync('python3', ['-c', PREDS, join(dir, 'bench'), join(dir, 'pred')], { encoding: 'utf8' }).stdout.trim()).toBe('ok');
    const sc = run(['score', '--bench', join(dir, 'bench'), '--pred-dir', join(dir, 'pred'), '--frame', 'metric', '--voxel', '0.01', '--tau', '0.005', '--samples', '40000']);
    expect(sc.status, sc.stderr).toBe(0);
    const sum = JSON.parse(readFileSync(join(dir, 'bench', 'scores', 'summary.json'), 'utf8'));
    expect(sum).toMatchObject({ kind: 'geo.bench-summary', frame: 'metric', unit: 'm', metric: true, fit: false, scored: 2, missing: [] });
    const row = (id: string) => sum.rows.find((r: any) => r.id === id);
    expect(row('box_a').voxel_f1).toBeGreaterThan(0.9); expect(row('box_a').fscore).toBeGreaterThan(0.95);
    // the 5 cm shift runs along box_b's long axis, so its big faces slide over themselves: the score drops, it does not collapse
    expect(row('box_b').voxel_f1).toBeLessThan(row('box_a').voxel_f1 - 0.15); expect(row('box_b').fscore).toBeLessThan(0.9);
    expect(row('box_b').chamfer_mean_dist).toBeGreaterThan(0.005);
    expect(JSON.parse(readFileSync(join(dir, 'bench', 'scores', 'box_b.json'), 'utf8')).inputs).toMatchObject({ frame: 'metric', pred: 'box_b.ply', normalize_each: false });
    // a fitted run is a shape score and says so; a missing prediction is reported, never silently skipped
    const fit = run(['score', '--bench', join(dir, 'bench'), '--pred-dir', join(dir, 'pred'), '--frame', 'metric', '--fit', '--voxel', '0.01', '--tau', '0.005', '--samples', '40000']);
    expect(fit.status).toBe(0);
    const fsum = JSON.parse(readFileSync(join(dir, 'bench', 'scores', 'summary.json'), 'utf8'));
    expect(fsum.metric).toBe(false); expect(fsum.rows.find((r: any) => r.id === 'box_b').voxel_f1).toBeGreaterThan(0.9);
    const partial = run(['score', '--bench', join(dir, 'bench'), '--pred-dir', dir, '--frame', 'metric', '--samples', '40000']);
    expect(partial.status).toBe(1);                                                                 // nothing scored
    expect(JSON.parse(partial.stdout.trim()).missing).toBe(2);
    // the Timmy formula: a prediction sealed before scoring is graded by the score — and a wrong one is called falsified
    const pr = run(['predict', '--bench', join(dir, 'bench'), '--model', 'exact-boxes', '--expect-f1', '0.95', '--expect-fscore', '0.97', '--frame', 'metric', '--basis', 'test']);
    expect(pr.status, pr.stderr).toBe(0);
    const prediction = JSON.parse(readFileSync(join(dir, 'bench', 'scores', 'prediction.json'), 'utf8'));
    expect(prediction).toMatchObject({ kind: 'geo.bench-prediction', model: 'exact-boxes', expected: { median_voxel_f1: 0.95, median_fscore: 0.97 }, tolerance_f1: 0.08 });
    expect(prediction.prediction_sha256).toMatch(/^[0-9a-f]{64}$/); expect(prediction.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    const graded = run(['score', '--bench', join(dir, 'bench'), '--pred-dir', join(dir, 'pred'), '--frame', 'metric', '--voxel', '0.01', '--tau', '0.005', '--samples', '40000']);
    expect(graded.status).toBe(0);
    const g = JSON.parse(readFileSync(join(dir, 'bench', 'scores', 'summary.json'), 'utf8')).prediction;
    expect(g).toMatchObject({ model: 'exact-boxes', graded: true, frame_matches: true, prediction_sha256: prediction.prediction_sha256 });
    expect(g.falsified).toBe(g.gap < -0.08);                                                        // the median over {exact, 5 cm off} decides; the rule is the receipt's
    expect(typeof g.observed_median_fscore).toBe('number');
  }, 180000);
});
