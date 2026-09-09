// chain-views-e6p2 — `timmy demo` is replayable: two runs on placeholder
// data produce byte-identical casts (frozen clock + seeded prng + fixed
// env_lock + fixture store) and an mp4 through agg+ffmpeg.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const runDemo = (out: string): { status: number; out: string } => {
  const r = spawnSync('npx', ['tsx', 'src/demo/cast.ts', '--out', out, '--no-seal'], {
    encoding: 'utf8', timeout: 180000, cwd: process.cwd(),
  });
  return { status: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

describe('timmy demo', { timeout: 300000 }, () => {
  it('is deterministic: identical casts + mp4 across two runs', () => {
    const a = mkdtempSync(join(tmpdir(), 'demo-gate-a-'));
    const b = mkdtempSync(join(tmpdir(), 'demo-gate-b-'));
    const ra = runDemo(a);
    const rb = runDemo(b);
    expect(ra.status, ra.out.slice(-400)).toBe(0);
    expect(rb.status, rb.out.slice(-400)).toBe(0);
    const castA = readFileSync(join(a, 'demo.cast'), 'utf8');
    const castB = readFileSync(join(b, 'demo.cast'), 'utf8');
    expect(castA).toBe(castB);
    // asciinema v2 header + at least the five scripted beats
    const lines = castA.trim().split('\n');
    const header = JSON.parse(lines[0]);
    expect(header.version).toBe(2);
    expect(header.width).toBe(120);
    expect(lines.length).toBeGreaterThanOrEqual(6);
    const frames = lines.slice(1).map(l => JSON.parse(l)[2] as string);
    expect(frames.some(f => f.includes('YOUR JOURNEY'))).toBe(true);   // HOME
    expect(frames.some(f => f.includes('RUNS'))).toBe(true);          // RUN
    expect(frames.some(f => f.includes('SWARM'))).toBe(true);         // swarm view
    expect(frames.some(f => f.includes('closed-3'))).toBe(true);      // launch beat preset
    expect(frames.some(f => f.includes('swarm.airgap'))).toBe(true);  // CHAIN airgap
    expect(existsSync(join(a, 'demo.mp4'))).toBe(true);
    expect(readFileSync(join(a, 'demo.mp4')).equals(readFileSync(join(b, 'demo.mp4')))).toBe(true);
    // placeholder-only: no real hosts, paths or names in the cast
    expect(castA).not.toMatch(/workers\.dev/);
    expect(castA).not.toMatch(/\/Users\//);
  });
});
