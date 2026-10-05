// Bench loader (lanes/geo/bench_loader.py): a public 3D set → truth + manifest → scored predictions, offline. A synthetic
// WebDataset shard (two trimesh boxes with GSO-style metadata) stands in for a GSO tar; the real smoke shard (5 objects,
// 90 MB, CC-BY-4.0) was run by hand on 2026-10-04 with the same code path. Needs python3 + numpy + scipy + trimesh.
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const loader = join(ROOT, 'lanes', 'geo', 'bench_loader.py');
const deps = spawnSync('python3', ['-c', 'import numpy, scipy, trimesh'], { encoding: 'utf8' }).status === 0;
const run = (args: string[]) => spawnSync('python3', [loader, ...args], { encoding: 'utf8', timeout: 180000 });
// the fetch test hosts its server in this worker: a spawnSync there would block the event loop the server needs (the engine
// tests hit the same thing), so the loader is spawned asynchronously for it
const runAsync = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  const c = spawn('python3', [loader, ...args], { env }); let out = '', err = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  c.on('close', (status) => resolve({ status, stdout: out, stderr: err }));
});

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
    expect(man.skipped).toEqual([{ id: 'orphan', why: 'no metadata or no mesh', shard: 'fake-00000.tar' }]);
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
    // Cursor: --normalize-each discards relative scale, so every per-object record must say metric:false, not only the summary
    const ne = run(['score', '--bench', join(dir, 'bench'), '--pred-dir', join(dir, 'pred'), '--frame', 'metric', '--normalize-each', '--voxel', '0.02', '--tau', '0.01', '--samples', '40000']);
    expect(ne.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'bench', 'scores', 'summary.json'), 'utf8')).metric).toBe(false);
    const perObj = JSON.parse(readFileSync(join(dir, 'bench', 'scores', 'box_a.json'), 'utf8'));
    expect(perObj.metric).toBe(false); expect(perObj.unit).toBe('unit-cube'); expect(perObj.note.join(' ')).toMatch(/normalize_each/);
    // Cursor: a second shard into the same bench must add to the manifest, not replace it
    const SECOND = `
import io, json, sys, tarfile, trimesh
from pathlib import Path
S = Path(sys.argv[1])
def add(tar, name, data):
    ti = tarfile.TarInfo(name); ti.size = len(data); tar.addfile(ti, io.BytesIO(data))
with tarfile.open(S / 'fake-00001.tar', 'w') as tar:
    m = trimesh.creation.box(extents=[0.2, 0.2, 0.2]); add(tar, 'box_c.obj', m.export(file_type='obj').encode())
    add(tar, 'box_c.json', json.dumps({'object_id': 'box_c', 'license_id': 'cc-by-4.0', 'glb_processing': {}}).encode())
print('ok')
`;
    expect(spawnSync('python3', ['-c', SECOND, dir], { encoding: 'utf8' }).stdout.trim()).toBe('ok');
    const ex2 = run(['extract', '--tar', join(dir, 'fake-00001.tar'), '--out', join(dir, 'bench'), '--samples', '40000']);
    expect(ex2.status, ex2.stderr).toBe(0);
    const man2 = JSON.parse(readFileSync(join(dir, 'bench', 'manifest.json'), 'utf8'));
    expect(man2.count).toBe(3); expect(man2.objects.map((o: any) => o.id)).toEqual(['box_a', 'box_b', 'box_c']);
    expect(man2.shards.map((x: any) => [x.tar, x.objects])).toEqual([['fake-00000.tar', 2], ['fake-00001.tar', 1]]);
    expect(man2.objects.find((o: any) => o.id === 'box_c').shard).toBe('fake-00001.tar');
    expect(JSON.parse(ex2.stdout.trim())).toMatchObject({ objects_in_shard: 1, objects: 3, shards: 2 });
    // re-extracting the first shard replaces its objects in place, never duplicates them
    expect(run(['extract', '--tar', join(dir, 'fake-00000.tar'), '--out', join(dir, 'bench'), '--samples', '40000']).status).toBe(0);
    const man3 = JSON.parse(readFileSync(join(dir, 'bench', 'manifest.json'), 'utf8'));
    expect(man3.count).toBe(3); expect(man3.shards).toHaveLength(2);
    // different settings into the same bench are refused instead of silently mixing sample counts
    expect(run(['extract', '--tar', join(dir, 'fake-00001.tar'), '--out', join(dir, 'bench'), '--samples', '999']).status).toBe(2);
  }, 240000);

  it.skipIf(!deps)('card: one self-contained Bench Card per run, hashed, escaped, with the prediction verdict; runs keep their own folders and get an index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-card-'));
    expect(spawnSync('python3', ['-c', FAKE_SHARD, dir], { encoding: 'utf8' }).stdout.trim()).toBe('ok');
    const B = join(dir, 'bench');
    expect(run(['extract', '--tar', join(dir, 'fake-00000.tar'), '--out', B, '--samples', '30000']).status).toBe(0);
    expect(spawnSync('python3', ['-c', PREDS, B, join(dir, 'pred')], { encoding: 'utf8' }).stdout.trim()).toBe('ok');
    // nothing to card before a score exists: refused, exit 2, JSON on stdout
    const early = run(['card', '--bench', B, '--run', 'm1']);
    expect(early.status).toBe(2); expect(JSON.parse(early.stdout.trim()).status).toBe('refused');
    // a run name is a slug, never a path
    const trav = run(['card', '--bench', B, '--run', '../escape']);
    expect(trav.status).toBe(2); expect(JSON.parse(trav.stdout.trim()).status).toBe('refused');
    // run m1: a model name that is markup must come out as text
    const evil = '<script>alert(1)</script> box-model';
    expect(run(['predict', '--bench', B, '--run', 'm1', '--model', evil, '--expect-f1', '0.5', '--frame', 'metric', '--basis', 'test']).status).toBe(0);
    expect(run(['score', '--bench', B, '--run', 'm1', '--pred-dir', join(dir, 'pred'), '--frame', 'metric', '--voxel', '0.01', '--tau', '0.005', '--samples', '30000']).status).toBe(0);
    const c1 = run(['card', '--bench', B, '--run', 'm1']);
    expect(c1.status, c1.stderr).toBe(0);
    expect(JSON.parse(c1.stdout.trim())).toMatchObject({ ok: true, status: 'carded', runs_on_bench: 1 });
    const html = readFileSync(join(B, 'scores', 'm1', 'card.html'), 'utf8');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; box-model'); expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\ssrc=|<link|@import|https?:\/\//i);                        // self-contained: nothing loads from anywhere
    expect(html).toMatch(/AS PREDICTED|FALSIFIED|OUTSIDE TOLERANCE/);
    expect(html).toContain('over 8 grid phases');
    const card = JSON.parse(readFileSync(join(B, 'scores', 'm1', 'card.json'), 'utf8'));
    expect(card).toMatchObject({ kind: 'geo.bench-card', run: 'm1', set: 'gso', frame: 'metric', metric: true, scored: 2 });
    expect(html).toContain(card.card_sha256);
    // the card hash is the hash of its own data, and the summary hash is the summary's bytes: both recomputable by anyone
    const check = spawnSync('python3', ['-c', `
import hashlib, json, sys
d = json.load(open(sys.argv[1])); h = d.pop('card_sha256')
print(hashlib.sha256(json.dumps(d, sort_keys=True, separators=(',', ':')).encode()).hexdigest() == h,
      hashlib.sha256(open(sys.argv[2], 'rb').read()).hexdigest() == d['summary_sha256'])`, join(B, 'scores', 'm1', 'card.json'), join(B, 'scores', 'm1', 'summary.json')], { encoding: 'utf8' });
    expect(check.stdout.trim()).toBe('True True');
    // run m2 without a prediction: its own folder, an honest NO PREDICTION, and an index of both runs
    expect(run(['score', '--bench', B, '--run', 'm2', '--pred-dir', join(dir, 'pred'), '--frame', 'metric', '--fit', '--voxel', '0.01', '--tau', '0.005', '--samples', '30000']).status).toBe(0);
    const c2 = run(['card', '--bench', B, '--run', 'm2', '--model', 'fitted boxes']);
    expect(JSON.parse(c2.stdout.trim())).toMatchObject({ verdict: 'NO PREDICTION', runs_on_bench: 2 });
    expect(readFileSync(join(B, 'scores', 'm2', 'card.html'), 'utf8')).toContain('SHAPE SCORE');
    const index = readFileSync(join(B, 'scores', 'index.html'), 'utf8');
    expect(index).toContain('2 runs'); expect(index).toContain('href="m1/card.html"'); expect(index).toContain('fitted boxes');
    expect(index.indexOf('fitted boxes')).toBeLessThan(index.indexOf('box-model'));          // sorted by median voxel F1: the fitted run scores higher
    expect(existsSync(join(B, 'scores', 'summary.json'))).toBe(false);                       // named runs never touch the default folder
  }, 180000);

  it('fetch keeps a dropped download out of the shard directory and verifies size before calling a file present (Cursor: truncated tars were trusted)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-fetch-'));
    const body = Buffer.alloc(300_000, 7);
    let mode: 'truncate' | 'full' = 'truncate';
    const srv = createServer((req, res) => {
      res.setHeader('content-length', String(body.length));
      if (req.method === 'HEAD') return res.end();
      if (mode === 'truncate') { res.write(body.subarray(0, 100_000)); return setTimeout(() => res.destroy(), 20); }
      res.end(body);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    // the loopback server must not be routed through the sandbox's HTTP proxy
    const env = { ...process.env, TIMMY_BENCH_BASE_URL: `http://127.0.0.1:${port}`, PYTHONDONTWRITEBYTECODE: '1', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    const fetch1 = await runAsync(['fetch', '--set', 'gso', '--smoke', '--shard', '0', '--out', join(dir, 'bench')], env);
    expect(fetch1.status).toBe(5);
    expect(JSON.parse(fetch1.stdout.trim())).toMatchObject({ ok: false, status: 'incomplete', expected_bytes: body.length });
    expect(existsSync(join(dir, 'bench', 'shards', 'gso-train-00000.tar'))).toBe(false);
    expect(existsSync(join(dir, 'bench', 'shards', 'gso-train-00000.tar.part'))).toBe(false);
    mode = 'full';
    const fetch2 = await runAsync(['fetch', '--set', 'gso', '--smoke', '--shard', '0', '--out', join(dir, 'bench')], env);
    expect(fetch2.status, fetch2.stderr).toBe(0);
    const rec = JSON.parse(fetch2.stdout.trim());
    expect(rec).toMatchObject({ ok: true, status: 'fetched', bytes: body.length, expected_bytes: body.length, license: 'cc-by-4.0' });
    expect(rec.sha256).toMatch(/^[0-9a-f]{64}$/);
    const again = await runAsync(['fetch', '--set', 'gso', '--smoke', '--shard', '0', '--out', join(dir, 'bench')], env);
    expect(JSON.parse(again.stdout.trim())).toMatchObject({ status: 'present', bytes: body.length, sha256: rec.sha256 });
    writeFileSync(join(dir, 'bench', 'shards', 'gso-train-00000.tar'), body.subarray(0, 1000));           // a leftover stub is not "present"
    const stub = await runAsync(['fetch', '--set', 'gso', '--smoke', '--shard', '0', '--out', join(dir, 'bench')], env);
    expect(stub.status).toBe(5); expect(JSON.parse(stub.stdout.trim()).status).toBe('incomplete');
    srv.close();
  }, 90000);
});
