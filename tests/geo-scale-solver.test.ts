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
  it.skipIf(!deps)('recovers six corrupted per-view scales within 2 % on the synthetic box (numpy + scipy present)', () => {
    const r = spawnSync('python3', [solver, '--selftest', '--sub', '2500'], { encoding: 'utf8', timeout: 240000 });
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout.trim().split('\n').pop() as string);
    expect(j.selftest).toBe('ok');
    expect(Math.max(...j.err_pct)).toBeLessThan(2);
    expect(j.at_grid_edge).toBe(false);
  }, 250000);
});
