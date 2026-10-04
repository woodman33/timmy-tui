// The geo lane's self-consistency scale solver: a synthetic box seen from six cameras with per-view depth scales
// corrupted by up to e^±0.9 must come back within 2 %. Needs python3 with numpy + scipy; skips (visibly) without them.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
    expect(h.status === 0 || /usage/i.test(h.stdout + h.stderr)).toBe(true);
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
