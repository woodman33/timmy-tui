// Geo lane MCP surface (src/geo/mcp.ts): the two lane scripts as receipted MCP tools. Called directly, never through the
// wire (server.ts dispatch is one line). Chain writes go to a tmp dir — the real store is never touched.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GEO_TOOLS, callGeoTool } from '../src/geo/mcp.js';
import { readChain, verifyChain } from '../src/utils/receipts.js';

const ROOT = join(__dirname, '..');
const deps = spawnSync('python3', ['-c', 'import numpy, scipy'], { encoding: 'utf8' }).status === 0;
const PLANES = `
import sys, numpy as np
from pathlib import Path
S = Path(sys.argv[1]); rng = np.random.default_rng(1)
def ply(name, pts):
    p = pts.astype(np.float32)
    (S / name).write_bytes(('ply\\nformat binary_little_endian 1.0\\nelement vertex %d\\nproperty float x\\nproperty float y\\nproperty float z\\nend_header\\n' % len(p)).encode() + p.tobytes())
u = rng.uniform(0, 4, (6000, 2)); truth = np.c_[np.zeros(len(u)), u]
ply('truth.ply', truth); ply('same.ply', truth + rng.normal(0, 0.002, truth.shape)); ply('shift.ply', truth + np.array([0.25, 0, 0]))
`;

describe('geo MCP tools', () => {
  it('the three tools are registered on the server with their lane names and required inputs', () => {
    expect(GEO_TOOLS.map((t) => t.name)).toEqual(['timmy_geo_score', 'timmy_geo_bench', 'timmy_geo_scale']);
    expect(GEO_TOOLS[0].inputSchema.required).toEqual(['truth', 'pred']);
    expect(GEO_TOOLS[1].inputSchema.required).toEqual(['step', 'bench']);
    expect((GEO_TOOLS[1].inputSchema.properties as any).step.enum).toEqual(['predict', 'score', 'card']);
    expect(GEO_TOOLS[2].inputSchema.required).toEqual(['views']);
    const server = readFileSync(join(ROOT, 'src', 'mcp', 'server.ts'), 'utf8');
    expect(server).toContain('...GEO_TOOLS');
    expect(server).toContain("name.startsWith('timmy_geo_')");
    for (const t of GEO_TOOLS) expect(t.description).toMatch(/not_configured|untrusted/);
  });

  it('refuses missing inputs before any process starts, and seals nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-mcp-'));
    const r = callGeoTool('timmy_geo_score', { truth: join(dir, 'nope.ply'), pred: join(dir, 'nope.ply') }, dir);
    expect(r).toMatchObject({ ok: false, status: 'invalid_request', exit_code: null });
    expect(callGeoTool('timmy_geo_scale', {}, dir).status).toBe('invalid_request');
    expect(callGeoTool('timmy_geo_whatever', {}, dir).status).toBe('invalid_request');
    expect(readChain('runs', dir)).toHaveLength(0);
  });

  it.skipIf(!deps)('score: same plane is ok + metric; fitted shift is untrusted (exit 2); each call seals a verifiable receipt without home paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-mcp-'));
    expect(spawnSync('python3', ['-c', PLANES, dir], { encoding: 'utf8' }).status).toBe(0);
    const ok = callGeoTool('timmy_geo_score', { truth: join(dir, 'truth.ply'), pred: join(dir, 'same.ply'), voxel: 0.25, tau: 0.1 }, dir);
    expect(ok.ok).toBe(true); expect(ok.status).toBe('ok'); expect(ok.exit_code).toBe(0);
    const res: any = ok.result;
    expect(res.metric).toBe(true); expect(res.voxel.f1).toBeGreaterThan(0.97); expect(res.surface.fscore.f).toBeGreaterThan(0.99);
    const fit = callGeoTool('timmy_geo_score', { truth: join(dir, 'truth.ply'), pred: join(dir, 'shift.ply'), fit: true, out: join(dir, 'fit.json') }, dir);
    expect(fit.ok).toBe(false); expect(fit.status).toBe('untrusted'); expect(fit.exit_code).toBe(2);
    expect((fit.result as any).metric).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'fit.json'), 'utf8')).fit.applied).toBe(true);
    const chain = readChain('runs', dir);
    expect(chain).toHaveLength(2);
    expect(chain[0]).toMatchObject({ kind: 'run', status: 'ok', exit_code: 0, policy: 'auto' });
    expect(chain[0].subject).toBe('geo.voxel-score truth.ply vs same.ply');
    expect(chain[1]).toMatchObject({ status: 'ok', error_class: 'untrusted_metric', exit_code: 2 });
    expect(chain[1].subject).toContain('(fitted)');
    expect(ok.receipt).toBe(chain[0].hash); expect(fit.receipt).toBe(chain[1].hash);
    expect(JSON.stringify(chain)).not.toContain(process.env.HOME ?? '/nonexistent-home');
    expect(verifyChain('runs', dir).ok).toBe(true);
  });

  it.skipIf(!deps)('a usage error (argparse exit 2, no JSON) is failed/usage, not untrusted; fit:"true" from a client is the flag, not `--fit true` (Cursor)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-mcp-'));
    expect(spawnSync('python3', ['-c', PLANES, dir], { encoding: 'utf8' }).status).toBe(0);
    const bad = callGeoTool('timmy_geo_score', { truth: join(dir, 'truth.ply'), pred: join(dir, 'same.ply'), voxel: 'abc' as unknown as number }, dir);
    expect(bad.status).toBe('failed'); expect(bad.exit_code).toBe(2); expect(bad.result).toBeNull(); expect(bad.stderr).toMatch(/usage|invalid/);
    const strFit = callGeoTool('timmy_geo_score', { truth: join(dir, 'truth.ply'), pred: join(dir, 'shift.ply'), fit: 'true' as unknown as boolean }, dir);
    expect(strFit.status).toBe('untrusted'); expect((strFit.result as any).fit.applied).toBe(true);
    const strNoFit = callGeoTool('timmy_geo_score', { truth: join(dir, 'truth.ply'), pred: join(dir, 'same.ply'), fit: 'false' as unknown as boolean, normalize: 0 as unknown as boolean }, dir);
    expect(strNoFit.status).toBe('ok'); expect((strNoFit.result as any).fit.applied).toBe(false); expect((strNoFit.result as any).unit).toBe('m');
    const chain = readChain('runs', dir);
    expect(chain.map((c) => [c.status, c.error_class])).toEqual([['failed', 'usage'], ['ok', 'untrusted_metric'], ['ok', undefined]]);
    // the receipt subject follows the same coercion: 'true' is fitted, 'false' is not (Cursor: string false still labelled receipts fitted)
    expect(chain[1].subject).toBe('geo.voxel-score truth.ply vs shift.ply (fitted)');
    expect(chain[2].subject).toBe('geo.voxel-score truth.ply vs same.ply');
  });

  it.skipIf(!deps)('bench: predict seals before score, score grades it, a missing prediction is partial not ok, a wrong step is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-mcp-'));
    expect(callGeoTool('timmy_geo_bench', { step: 'score', bench: dir, pred_dir: dir }, dir).status).toBe('invalid_request');     // no manifest → refused, nothing sealed
    const shard = `
import io, json, sys, tarfile, numpy as np, trimesh
from pathlib import Path
S = Path(sys.argv[1])
def add(tar, name, data):
    ti = tarfile.TarInfo(name); ti.size = len(data); tar.addfile(ti, io.BytesIO(data))
with tarfile.open(S / 'fake.tar', 'w') as tar:
    for oid, ext in (('a', [0.1, 0.2, 0.3]), ('b', [0.2, 0.2, 0.1])):
        m = trimesh.creation.box(extents=ext); add(tar, f'{oid}.obj', m.export(file_type='obj').encode())
        add(tar, f'{oid}.json', json.dumps({'object_id': oid, 'license_id': 'cc-by-4.0', 'glb_processing': {}}).encode())
P = S / 'pred'; P.mkdir()
pts, _ = trimesh.sample.sample_surface(trimesh.creation.box(extents=[0.1, 0.2, 0.3]), 20000, seed=2); p = np.asarray(pts, dtype=np.float32)
(P / 'a.ply').write_bytes((f'ply\\nformat binary_little_endian 1.0\\nelement vertex {len(p)}\\nproperty float x\\nproperty float y\\nproperty float z\\nend_header\\n').encode() + p.tobytes())
`;
    expect(spawnSync('python3', ['-c', shard, dir], { encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('python3', [join(ROOT, 'lanes', 'geo', 'bench_loader.py'), 'extract', '--tar', join(dir, 'fake.tar'), '--out', join(dir, 'bench'), '--samples', '20000'], { encoding: 'utf8' }).status).toBe(0);
    expect(callGeoTool('timmy_geo_bench', { step: 'predict', bench: join(dir, 'bench') }, dir).status).toBe('invalid_request');           // no model / expect_f1
    const pr = callGeoTool('timmy_geo_bench', { step: 'predict', bench: join(dir, 'bench'), model: 'exact-a', expect_f1: 0.97, frame: 'metric' }, dir);
    expect(pr.status, pr.stderr).toBe('ok');
    const sc = callGeoTool('timmy_geo_bench', { step: 'score', bench: join(dir, 'bench'), pred_dir: join(dir, 'pred'), frame: 'metric', voxel: 0.01, tau: 0.005, samples: 20000 }, dir);
    expect(sc.status, sc.stderr).toBe('partial'); expect(sc.exit_code).toBe(2);                                                   // b had no prediction
    const r: any = sc.result;
    expect(r.scored).toBe(1); expect(r.missing).toBe(1); expect(r.prediction).toMatchObject({ model: 'exact-a', graded: true, as_predicted: true, falsified: false });
    expect(callGeoTool('timmy_geo_bench', { step: 'nope', bench: join(dir, 'bench') }, dir).status).toBe('invalid_request');
    // card: renders from the default run; a bad run name is refused before any process; a lane refusal is invalid_request, never partial
    const cardOk = callGeoTool('timmy_geo_bench', { step: 'card', bench: join(dir, 'bench') }, dir);
    expect(cardOk.status, cardOk.stderr).toBe('ok'); expect((cardOk.result as any).verdict).toBe('AS PREDICTED');
    expect(callGeoTool('timmy_geo_bench', { step: 'card', bench: join(dir, 'bench'), run: '../x' }, dir).status).toBe('invalid_request');
    for (const reserved of ['summary.json', 'Card.HTML']) expect(callGeoTool('timmy_geo_bench', { step: 'card', bench: join(dir, 'bench'), run: reserved }, dir).status, reserved).toBe('invalid_request');
    const noScore = callGeoTool('timmy_geo_bench', { step: 'card', bench: join(dir, 'bench'), run: 'never-scored' }, dir);
    expect(noScore.status).toBe('invalid_request'); expect((noScore.result as any).status).toBe('refused');
    // a string 'false' for fit / normalize_each is neither the flag nor a "(shape score)" label on the receipt
    const plain = callGeoTool('timmy_geo_bench', { step: 'score', bench: join(dir, 'bench'), pred_dir: join(dir, 'pred'), frame: 'metric', voxel: 0.01, tau: 0.005, samples: 20000, fit: 'false' as unknown as boolean, normalize_each: 'false' as unknown as boolean }, dir);
    expect(plain.status).toBe('partial'); expect((plain.result as any).metric).toBe(true);
    const chain = readChain('runs', dir);
    expect(chain.map((c) => [c.subject, c.error_class])).toEqual([['geo.bench-predict bench exact-a', undefined], ['geo.bench-score bench pred', 'partial'],
      ['geo.bench-card bench', undefined], ['geo.bench-card bench [never-scored]', 'refused'], ['geo.bench-score bench pred', 'partial']]);
  }, 120000);

  it.skipIf(!deps)('scale: the synthetic views solve to ok on the default grid and to untrusted on a grid that excludes a true scale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-mcp-'));
    const solver = join(ROOT, 'lanes', 'geo', 'scale_solver.py');
    const py = `
import json, sys, importlib.util, numpy as np
from pathlib import Path
S = Path(sys.argv[1]); spec = importlib.util.spec_from_file_location('ss', sys.argv[2]); ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)
views, truth = ss.synthetic()
(S / 'views.json').write_text(json.dumps({'views': [{'points_cam': p[:500].tolist(), 'R': R.tolist(), 't': t.tolist()} for p, R, t in views]}))
`;
    expect(spawnSync('python3', ['-c', py, dir, solver], { encoding: 'utf8' }).status).toBe(0);
    const ok = callGeoTool('timmy_geo_scale', { views: join(dir, 'views.json'), sub: 500 }, dir);
    expect(ok.status, ok.stderr).toBe('ok');
    expect((ok.result as any).scales).toHaveLength(6); expect((ok.result as any).at_grid_edge).toBe(false);
    const narrow = callGeoTool('timmy_geo_scale', { views: join(dir, 'views.json'), sub: 500, lo: 0.6, hi: 1.6 }, dir);
    expect(narrow.status).toBe('untrusted'); expect(narrow.exit_code).toBe(2); expect((narrow.result as any).at_grid_edge).toBe(true);
    expect(readChain('runs', dir).map((r) => r.error_class)).toEqual([undefined, 'untrusted_metric']);
  }, 120000);
});
