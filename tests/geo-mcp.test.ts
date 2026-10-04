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
  it('both tools are registered on the server with their lane names and required inputs', () => {
    expect(GEO_TOOLS.map((t) => t.name)).toEqual(['timmy_geo_score', 'timmy_geo_scale']);
    expect(GEO_TOOLS[0].inputSchema.required).toEqual(['truth', 'pred']);
    expect(GEO_TOOLS[1].inputSchema.required).toEqual(['views']);
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
