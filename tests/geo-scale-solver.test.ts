// The geo lane's self-consistency scale solver: a synthetic box seen from six cameras with per-view depth scales
// corrupted by up to e^±0.9 must come back within 2 %. Needs python3 with numpy + scipy; skips (visibly) without them.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const solver = join(ROOT, 'lanes', 'geo', 'scale_solver.py');
const py = spawnSync('python3', ['-c', 'import numpy, scipy; print(numpy.__version__, scipy.__version__)'], { encoding: 'utf8' });
const deps = py.status === 0;

describe('geo scale solver', () => {
  it('ships with its README and a usage line', () => {
    expect(existsSync(solver)).toBe(true);
    expect(readFileSync(join(ROOT, 'lanes', 'geo', 'README.md'), 'utf8')).toContain('--selftest');
    const h = spawnSync('python3', [solver, '--help'], { encoding: 'utf8' });
    expect(h.status, h.stderr).toBe(0);
    expect(h.stdout).toMatch(/usage/i);
  });
  it('without numpy + scipy it reports not_configured and exits 3 instead of a traceback (honesty clause)', () => {
    // shadow both packages on a bare interpreter: PYTHONPATH wins over site-packages, so this holds with or without them installed
    const shadow = mkdtempSync(join(tmpdir(), 'geo-nonumeric-'));
    for (const m of ['numpy', 'scipy']) writeFileSync(join(shadow, `${m}.py`), 'raise ImportError("shadowed for the test")\n');
    const env = { ...process.env, PYTHONPATH: shadow, PYTHONDONTWRITEBYTECODE: '1' };
    const h = spawnSync('python3', [solver, '--help'], { encoding: 'utf8', env });
    expect(h.status, h.stderr).toBe(0);                      // usage never needs the numeric stack
    const r = spawnSync('python3', [solver, '--selftest'], { encoding: 'utf8', env });
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, status: 'not_configured' });
    expect(r.stderr).not.toMatch(/Traceback/);
  });
  it.skipIf(!deps)('reads vertex x y z from exporter-style mesh PLYs: faces, normals, colours, big-endian doubles, ascii (Cursor: face data crashed the reader)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-ply-'));
    const py = `
import struct, sys, importlib.util, numpy as np
from pathlib import Path
S = Path(sys.argv[1]); spec = importlib.util.spec_from_file_location('ss', sys.argv[2]); ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)
V = np.array([[0,0,0],[1,0,0],[1,1,0],[0,1,0.5]], dtype=np.float32)
hdr = ('ply\\nformat binary_little_endian 1.0\\nelement vertex 4\\nproperty float x\\nproperty float y\\nproperty float z\\nproperty float nx\\nproperty float ny\\nproperty float nz\\nproperty uchar red\\nproperty uchar green\\nproperty uchar blue\\nelement face 2\\nproperty list uchar int vertex_indices\\nend_header\\n').encode()
body = b''.join(struct.pack('<ffffffBBB', *v, 0, 0, 1, 200, 100, 50) for v in V) + struct.pack('<Biii', 3, 0, 1, 2) + struct.pack('<Biii', 3, 0, 2, 3)
(S / 'bin.ply').write_bytes(hdr + body)
(S / 'asc.ply').write_text('ply\\nformat ascii 1.0\\nelement vertex 4\\nproperty float x\\nproperty float y\\nproperty float z\\nproperty uchar red\\nelement face 1\\nproperty list uchar int vertex_indices\\nend_header\\n' + ''.join(f'{x} {y} {z} 7\\n' for x, y, z in V) + '3 0 1 2\\n')
hdr2 = ('ply\\nformat binary_big_endian 1.0\\nelement vertex 4\\nproperty uchar red\\nproperty double x\\nproperty double y\\nproperty double z\\nelement face 1\\nproperty list uchar int vertex_indices\\nend_header\\n').encode()
(S / 'be.ply').write_bytes(hdr2 + b''.join(struct.pack('>Bddd', 9, *v) for v in V) + struct.pack('>Biii', 3, 0, 1, 2))
for f in ['bin.ply', 'asc.ply', 'be.ply']:
    got = ss.read_ply_xyz(S / f)
    assert got.shape == (4, 3) and np.allclose(got, V, atol=1e-6), (f, got.tolist())
print('ply-ok')
`;
    const r = spawnSync('python3', ['-c', py, dir, solver], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('ply-ok');
  });
  it.skipIf(!deps)('a true scale outside the documented grid pins to the bound and exits 2 as untrusted; inside the grid it is trusted (Cursor: descent walked off the grid)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-grid-'));
    // six synthetic views written the way a user would hand them over: one PLY per view plus a views.json with R, t
    const py = `
import json, sys, importlib.util, numpy as np
from pathlib import Path
S = Path(sys.argv[1]); spec = importlib.util.spec_from_file_location('ss', sys.argv[2]); ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)
views, truth = ss.synthetic()
spec_out = {'views': []}
for k, (p, R, t) in enumerate(views):
    p = p[:600].astype(np.float32)
    (S / f'v{k}.ply').write_bytes(('ply\\nformat binary_little_endian 1.0\\nelement vertex %d\\nproperty float x\\nproperty float y\\nproperty float z\\nend_header\\n' % len(p)).encode() + p.tobytes())
    spec_out['views'].append({'ply': f'v{k}.ply', 'R': R.tolist(), 't': t.tolist()})
(S / 'views.json').write_text(json.dumps(spec_out))
print(json.dumps({'truth': [round(float(x), 4) for x in truth]}))
`;
    const w = spawnSync('python3', ['-c', py, dir, solver], { encoding: 'utf8' });
    expect(w.status, w.stderr).toBe(0);
    const truth: number[] = JSON.parse(w.stdout.trim()).truth;
    const lo = 0.6, hi = 1.6;
    expect(Math.min(...truth)).toBeLessThan(lo);                      // the synthetic scene has at least one view below the narrow grid
    const narrow = spawnSync('python3', [solver, '--views', join(dir, 'views.json'), '--out', join(dir, 'narrow.json'), '--sub', '600', '--lo', String(lo), '--hi', String(hi)], { encoding: 'utf8', timeout: 120000 });
    expect(narrow.status, narrow.stderr).toBe(2);
    const n = JSON.parse(readFileSync(join(dir, 'narrow.json'), 'utf8'));
    expect(n.at_grid_edge).toBe(true);
    expect(Math.min(...n.scales)).toBe(lo);                           // pinned, not walked off
    expect(Math.max(...n.scales)).toBeLessThanOrEqual(hi);
    const wide = spawnSync('python3', [solver, '--views', join(dir, 'views.json'), '--out', join(dir, 'wide.json'), '--sub', '600'], { encoding: 'utf8', timeout: 120000 });
    expect(wide.status, wide.stderr).toBe(0);
    const j = JSON.parse(readFileSync(join(dir, 'wide.json'), 'utf8'));
    expect(j.at_grid_edge).toBe(false);
    for (let k = 0; k < truth.length; k++) expect(Math.abs(j.scales[k] / truth[k] - 1)).toBeLessThan(0.05);
  }, 250000);
  it.skipIf(!deps)('recovers six corrupted per-view scales within 2 % on the synthetic box (numpy + scipy present)', () => {
    const r = spawnSync('python3', [solver, '--selftest', '--sub', '2500'], { encoding: 'utf8', timeout: 240000 });
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout.trim().split('\n').pop() as string);
    expect(j.selftest).toBe('ok');
    expect(Math.max(...j.err_pct)).toBeLessThan(2);
    expect(j.at_grid_edge).toBe(false);
  }, 250000);
});
