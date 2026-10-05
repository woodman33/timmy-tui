// `timmy geo score|bench|scale` — the CLI route to the same receipted dispatcher the timmy_geo_* MCP tools use.
// Runs the real CLI under tsx with a tmp cwd so the receipt chain it seals is the tmp one. Needs python3 + numpy + scipy.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const deps = spawnSync('python3', ['-c', 'import numpy, scipy'], { encoding: 'utf8' }).status === 0;
// TIMMY_STORE pins the receipt store (vitest sets a per-file one in its own env; the spawned CLI gets this test's)
const cli = (cwd: string, ...args: string[]) => spawnSync('npx', ['tsx', join(ROOT, 'src', 'cli.ts'), 'geo', ...args], { encoding: 'utf8', cwd, timeout: 120000, env: { ...process.env, TIMMY_BIN_DRY_RUN: '', TIMMY_STORE: join(cwd, 'store') } });
const PLANES = `
import sys, numpy as np
from pathlib import Path
S = Path(sys.argv[1]); rng = np.random.default_rng(1)
def ply(name, pts):
    p = pts.astype(np.float32)
    (S / name).write_bytes(('ply\\nformat binary_little_endian 1.0\\nelement vertex %d\\nproperty float x\\nproperty float y\\nproperty float z\\nend_header\\n' % len(p)).encode() + p.tobytes())
u = rng.uniform(0, 4, (6000, 2)); truth = np.c_[np.zeros(len(u)), u]
ply('truth.ply', truth); ply('same.ply', truth + rng.normal(0, 0.002, truth.shape))
`;

describe('timmy geo (CLI route)', () => {
  it('without a sub-verb it prints usage and exits 64; the help text lists the verb', () => {
    const r = cli(mkdtempSync(join(tmpdir(), 'geo-cli-')));
    expect(r.status).toBe(64); expect(r.stderr).toMatch(/usage: timmy geo score\|bench\|scale/);
    expect(readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8')).toMatch(/geo score\|bench\|scale\s+Voxel bench/);
  }, 60000);

  it.skipIf(!deps)('score seals the same receipt the MCP tool would, in the cwd chain, and hands the global --out through to the lane', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-cli-'));
    expect(spawnSync('python3', ['-c', PLANES, dir], { encoding: 'utf8' }).status).toBe(0);
    const r = cli(dir, 'score', '--truth', join(dir, 'truth.ply'), '--pred', join(dir, 'same.ply'), '--voxel', '0.25', '--tau', '0.1', '--json', '--out', join(dir, 'score.json'));
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout.trim());
    expect(j).toMatchObject({ ok: true, status: 'ok', exit_code: 0 });
    expect(j.result.metric).toBe(true); expect(j.result.voxel.f1).toBeGreaterThan(0.97);
    expect(existsSync(join(dir, 'score.json'))).toBe(true);                                            // --out reached voxel_score.py
    // the bus is ONE stream: each sealed receipt is followed by its receipt.sealed envelope line; count receipts, not lines
    const lines = readFileSync(join(dir, 'store', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const chain = lines.filter((l) => typeof l.hash === 'string' && l.subject);
    expect(chain).toHaveLength(1); expect(lines.some((l) => l.kind === 'receipt.sealed' && l.payload?.hash === chain[0].hash)).toBe(true);
    expect(chain[0]).toMatchObject({ kind: 'run', subject: 'geo.voxel-score truth.ply vs same.ply', status: 'ok', exit_code: 0 });
    expect(j.receipt).toBe(chain[0].hash);
    const bad = cli(dir, 'score', '--truth', join(dir, 'nope.ply'), '--pred', join(dir, 'same.ply'), '--json');
    expect(bad.status).toBe(64); expect(JSON.parse(bad.stdout.trim()).status).toBe('invalid_request');
  }, 120000);
});
