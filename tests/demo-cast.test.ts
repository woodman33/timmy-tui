// chain-views-e6p2 — `timmy demo` is replayable: two runs on placeholder
// data produce byte-identical casts (frozen clock + seeded prng + fixed
// env_lock + fixture store) and an mp4 through agg+ffmpeg.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';

// Await the native export without blocking Vitest's worker/RPC event loop.
const runDemo = (out: string, env: NodeJS.ProcessEnv): Promise<{ status: number; out: string }> => new Promise(resolve => {
  execFile(process.execPath, ['--import', 'tsx', 'src/demo/cast.ts', '--out', out, '--no-seal'], {
    encoding: 'utf8', timeout: 180000, cwd: process.cwd(), env,
  }, (error, stdout, stderr) => resolve({ status: error ? 1 : 0, out: stdout + stderr + (error?.message ?? '') }));
});

describe('timmy demo', { timeout: 300000 }, () => {
  it('is deterministic: identical casts + mp4 across two runs', async () => {
    // This is a required native export test. Missing tools must fail visibly,
    // never turn the MP4 contract into a skip or a cast-only success.
    for (const [command, args] of [['agg', ['--version']], ['ffmpeg', ['-version']]] as const) {
      const tool = spawnSync(command, [...args], { encoding: 'utf8', timeout: 10000 });
      const diagnostic = `${command}: ${tool.error?.message ?? ''} ${tool.signal ?? ''} ${tool.stderr ?? ''}`;
      expect(tool.error, diagnostic).toBeUndefined();
      expect(tool.status, diagnostic).toBe(0);
    }
    const a = mkdtempSync(join(tmpdir(), 'demo-gate-a-'));
    const b = mkdtempSync(join(tmpdir(), 'demo-gate-b-'));
    const hostBin = mkdtempSync(join(tmpdir(), 'demo-host-docker-'));
    const marker = join(hostBin, 'invoked');
    writeFileSync(join(hostBin, 'docker'), '#!/bin/sh\nprintf invoked > "$DEMO_HOST_DOCKER_MARKER"\nprintf ok\nexit 0\n', { mode: 0o700 });
    const env = { ...process.env, PATH: `${hostBin}${delimiter}${process.env.PATH ?? ''}`, DEMO_HOST_DOCKER_MARKER: marker };
    const ra = await runDemo(a, env);
    const rb = await runDemo(b, env);
    expect(ra.status, ra.out.slice(-400)).toBe(0);
    expect(rb.status, rb.out.slice(-400)).toBe(0);
    expect(existsSync(marker), 'demo must not invoke the inherited Docker client').toBe(false);
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
    // An activity row mentioning airgap is not a CHAIN capture. Verify the
    // ordered active screens and both actual receipt-panel interactions.
    expect(frames).toHaveLength(6);
    const tabs = ['HOME', 'RUN', 'COMMAND', 'COMMAND', 'CHAIN', 'CHAIN'];
    for (const [index, frame] of frames.entries()) {
      expect(frame).toMatch(new RegExp(`NORMAL\\s+${tabs[index]}\\b`));
      // A bare LF preserves the terminal cursor column and causes staircase
      // playback, even when the cast and MP4 bytes are deterministic.
      expect(frame).toContain('\r\n');
      expect(frame).not.toMatch(/(?<!\r)\n/);
    }
    expect(frames[4]).toMatch(/RECEIPTS\s+\/ swarm\.airgap/);
    expect(frames[4]).not.toContain('COMMANDER');
    expect(frames[0]).toContain('docker off');
    expect(frames[5]).toContain('[o] unlink');
    expect(frames[5]).not.toBe(frames[4]);
    expect(existsSync(join(a, 'demo.mp4')), ra.out).toBe(true);
    expect(existsSync(join(b, 'demo.mp4')), rb.out).toBe(true);
    expect(statSync(join(a, 'demo.mp4')).size, ra.out).toBeGreaterThan(0);
    expect(statSync(join(b, 'demo.mp4')).size, rb.out).toBeGreaterThan(0);
    expect(readFileSync(join(a, 'demo.mp4')).equals(readFileSync(join(b, 'demo.mp4')))).toBe(true);
    // placeholder-only: no real hosts, paths, names or live-lane ids in the cast
    expect(castA).not.toMatch(/workers\.dev/);
    expect(castA).not.toMatch(/\/Users\//);
    expect(castA).not.toMatch(/swarm_mts|sb_mtr|spark[0-9]/);
  });
});
