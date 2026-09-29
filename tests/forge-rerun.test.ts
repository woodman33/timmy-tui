import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  planTimeline,
  buildRecordingInvocation,
  recordTimeline,
  resolveSdkPython,
  RECORDER_SCRIPT,
  RERUN_SDK_VERSION,
  type FacetScorePoint,
  type RerunRunner,
} from '../src/forge/observe/rerun.js';

const SHA = 'a'.repeat(64);

function pt(beat_id: string, start_s: number, end_s: number, scores: Record<string, number>): FacetScorePoint {
  return { beat_id, start_s, end_s, scores };
}

// Fake runner that records the invocation and materializes the rrd the
// recorder script would have written (recordTimeline renames it to outRrd).
function okRunner(calls: Array<{ cmd: string; args: string[] }>): RerunRunner {
  return async (cmd, args) => {
    calls.push({ cmd, args });
    writeFileSync(JSON.parse(args[2]).rrd, 'fake-rrd-bytes');
  };
}

describe('planTimeline', () => {
  it('shapes the entity path as forge/<mission_id>/<probe_sha256[:12]>', () => {
    const plan = planTimeline({
      mission_id: 'm1',
      probe_sha256: SHA,
      points: [pt('b1', 0, 2, { motion: 8 })],
    });
    expect(plan.entity).toBe(`forge/m1/${SHA.slice(0, 12)}`);
  });

  it('unions facets across points in first-appearance order', () => {
    const plan = planTimeline({
      mission_id: 'm1',
      probe_sha256: SHA,
      points: [
        pt('b1', 0, 2, { motion: 8, identity: 6 }),
        pt('b2', 2, 4, { identity: 7, nsfw: 10 }),
        pt('b3', 4, 6, { motion: 5, nsfw: 10, lighting: 9 }),
      ],
    });
    expect(plan.facets).toEqual(['motion', 'identity', 'nsfw', 'lighting']);
  });

  it('builds per-facet series with times = start_s, aligned to points order', () => {
    const plan = planTimeline({
      mission_id: 'm1',
      probe_sha256: SHA,
      points: [
        pt('b1', 0, 2, { motion: 8, identity: 6 }),
        pt('b2', 2.5, 4, { motion: 4, identity: 7 }),
        pt('b3', 4.25, 6, { motion: 9, identity: 3 }),
      ],
    });
    const motion = plan.series.find(s => s.facet === 'motion');
    expect(motion?.times).toEqual([0, 2.5, 4.25]);
    expect(motion?.values).toEqual([8, 4, 9]);
    const identity = plan.series.find(s => s.facet === 'identity');
    expect(identity?.times).toEqual([0, 2.5, 4.25]);
    expect(identity?.values).toEqual([6, 7, 3]);
  });

  it('omits a point from a facet series when the facet is absent — no zero-fill', () => {
    const plan = planTimeline({
      mission_id: 'm1',
      probe_sha256: SHA,
      points: [
        pt('b1', 0, 2, { motion: 8, identity: 6 }),
        pt('b2', 2, 4, { motion: 4 }),            // identity missing here
        pt('b3', 4, 6, { motion: 9, identity: 3 }),
      ],
    });
    const identity = plan.series.find(s => s.facet === 'identity');
    expect(identity?.times).toEqual([0, 4]);      // start_s of b1 and b3 only
    expect(identity?.values).toEqual([6, 3]);
    const motion = plan.series.find(s => s.facet === 'motion');
    expect(motion?.times).toEqual([0, 2, 4]);     // motion present in all points
  });

  it('handles empty points: no facets, no series, entity still shaped', () => {
    const plan = planTimeline({ mission_id: 'm1', probe_sha256: SHA, points: [] });
    expect(plan.entity).toBe(`forge/m1/${SHA.slice(0, 12)}`);
    expect(plan.facets).toEqual([]);
    expect(plan.series).toEqual([]);
  });
});

describe('recordTimeline (fake runner)', () => {
  const input = {
    mission_id: 'm1',
    probe_sha256: SHA,
    points: [
      pt('b1', 0, 2, { motion: 8, identity: 6 }),
      pt('b2', 2, 4, { motion: 4 }),
    ],
  };

  it('builds the invocation from planTimeline and returns {rrd, entity, sdk_version}', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const out = join(mkdtempSync(join(tmpdir(), 'forge-rerun-')), 'out', 'scores.rrd');
    const res = await recordTimeline(input, out, { runner: okRunner(calls) });
    expect(res.rrd).toBe(out);
    expect(res.entity).toBe(`forge/m1/${SHA.slice(0, 12)}`);
    expect(res.sdk_version).toBe(RERUN_SDK_VERSION); // pinned version carried on the result
    expect(existsSync(out)).toBe(true);              // temp renamed into place on success
    expect(calls).toHaveLength(1);
    // Invocation = resolved python + ['-c', RECORDER_SCRIPT, <json payload>].
    expect(calls[0].cmd).toBeTruthy();
    expect(calls[0].args[0]).toBe('-c');
    expect(calls[0].args[1]).toBe(RECORDER_SCRIPT);
    const payload = JSON.parse(calls[0].args[2]);
    expect(payload.entity).toBe(`forge/m1/${SHA.slice(0, 12)}`);
    expect(dirname(dirname(payload.rrd))).toBe(dirname(out)); // recorder writes the temp path
    expect(payload.application_id).toBeTruthy();
    expect(payload.recording_id).toBeTruthy();
    expect(payload.facets).toBeUndefined(); // dead field dropped from the payload
    // Series in the payload must match planTimeline exactly.
    const plan = planTimeline(input);
    expect(payload.series).toEqual(plan.series);
  });

  it('creates the output directory if missing', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const out = join(mkdtempSync(join(tmpdir(), 'forge-rerun-')), 'nested', 'deep', 'scores.rrd');
    expect(existsSync(dirname(out))).toBe(false);
    await recordTimeline(input, out, { runner: okRunner(calls) });
    expect(existsSync(dirname(out))).toBe(true);
  });

  it('propagates the runner error verbatim and leaves no partial .rrd', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'forge-rerun-')), 'scores.rrd');
    // Runner partially writes the temp rrd then fails, as a dying recorder would.
    const runner: RerunRunner = async (_cmd, args) => {
      writeFileSync(JSON.parse(args[2]).rrd, 'partial-rrd-bytes');
      throw new Error('exit 1: module not found');
    };
    await expect(recordTimeline(input, out, { runner })).rejects.toThrow('exit 1: module not found');
    expect(existsSync(out)).toBe(false);                        // no partial artifact at outRrd
    expect(existsSync(`${out}.tmp-${process.pid}`)).toBe(false); // temp cleaned up
  });

  it('passes hostile mission/facet names as one argv element that JSON round-trips', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    // Quotes, backslash, newline, command substitution — nothing may reach a shell.
    const hostileMission = 'mi"ss\\' + '\n' + '$(touch /tmp/forge-pwned)`x`';
    const hostileFacet = 'fa"cet\\' + '\n' + '$(boom)';
    const out = join(mkdtempSync(join(tmpdir(), 'forge-rerun-')), 'scores.rrd');
    await recordTimeline({
      mission_id: hostileMission,
      probe_sha256: SHA,
      points: [pt('b"1\\' + '\n' + '$(id)', 0, 2, { [hostileFacet]: 5 })],
    }, out, { runner: okRunner(calls) });
    // Exactly one argv element carries the plan; spawn (not a shell) keeps it whole.
    expect(calls[0].args).toHaveLength(3);
    const payload = JSON.parse(calls[0].args[2]);
    expect(payload.entity).toBe(`forge/${encodeURIComponent(hostileMission).replace(/\./g, '%2E')}/${SHA.slice(0, 12)}`);
    expect(payload.series[0].facet).toBe(hostileFacet);
    expect(JSON.stringify(payload)).toBe(calls[0].args[2]); // exact byte round-trip
  });

  it('refuses an oversized plan (argv transport guard)', () => {
    // Distinct facet per point: one series each, so the payload grows linearly.
    const points = Array.from({ length: 3000 }, (_, i) =>
      pt(`b${i}`, i, i + 1, { [`facet_${String(i).padStart(4, '0')}`]: 8 }));
    const plan = planTimeline({ mission_id: 'm1', probe_sha256: SHA, points });
    expect(() => buildRecordingInvocation(plan, '/tmp/scores.rrd', 'python'))
      .toThrow(/timeline plan too large for argv transport/);
  });
});

describe('resolveSdkPython (version-pinned ladder)', () => {
  // A fake `python` executable: logs every probe's -c snippet to `log` and
  // exits ${STUB_EXIT:-0}, standing in for a rerun import that either
  // verifies the pin (0) or reports the wrong version / fails (nonzero).
  let dir: string;
  let stub: string;
  let log: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules(); // fresh module instance per test → fresh resolver memo
    dir = mkdtempSync(join(tmpdir(), 'forge-rerun-py-'));
    log = join(dir, 'probes.log');
    stub = join(dir, 'python-stub');
    writeFileSync(stub, [
      '#!/bin/sh',
      `printf '%s\\n' "$2" >> "${log}"`,
      'exit "${STUB_EXIT:-0}"',
      '',
    ].join('\n'));
    chmodSync(stub, 0o755);
    for (const k of ['TIMMY_RERUN_PYTHON', 'STUB_EXIT', 'PATH']) savedEnv[k] = process.env[k];
    process.env.PATH = dir; // bare python3 rung becomes unresolvable → deterministic ladder
  });

  afterEach(() => {
    for (const k of ['TIMMY_RERUN_PYTHON', 'STUB_EXIT', 'PATH']) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function probeLog(): string[] {
    if (!existsSync(log)) return [];
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  }

  it('rejects a candidate whose rerun.__version__ is not the pinned one', async () => {
    process.env.TIMMY_RERUN_PYTHON = stub;
    process.env.STUB_EXIT = '1'; // wrong-version stub: version assert fails
    const mod = await import('../src/forge/observe/rerun.js');
    expect(mod.resolveSdkPython()).toBeNull();
  });

  it('accepts a candidate that import-verifies the pinned version', async () => {
    process.env.TIMMY_RERUN_PYTHON = stub; // STUB_EXIT unset → probe succeeds
    const mod = await import('../src/forge/observe/rerun.js');
    expect(mod.resolveSdkPython()).toBe(stub);
  });

  it('memoizes the resolution: the second call does not re-probe', async () => {
    process.env.TIMMY_RERUN_PYTHON = stub;
    const mod = await import('../src/forge/observe/rerun.js');
    expect(mod.resolveSdkPython()).toBe(stub);
    expect(mod.resolveSdkPython()).toBe(stub); // memo hit: no second spawn
    const probes = probeLog();
    expect(probes).toHaveLength(1); // env-override rung won; later rungs never probed
    expect(probes[0]).toContain(`== '${RERUN_SDK_VERSION}'`);
    expect(probes[0]).not.toContain('assert ');
    expect(RECORDER_SCRIPT).toContain("raise RuntimeError('rerun SDK version mismatch')");
  });

  it('falls through a nonexistent env candidate instead of returning it', async () => {
    process.env.TIMMY_RERUN_PYTHON = join(dir, 'does-not-exist');
    const mod = await import('../src/forge/observe/rerun.js');
    expect(mod.resolveSdkPython()).toBeNull(); // env rung failed → venv/python3 rungs also absent
  });

  it('recordTimeline throws naming the pin and the override when no candidate matches', async () => {
    process.env.TIMMY_RERUN_PYTHON = stub;
    process.env.STUB_EXIT = '1';
    const mod = await import('../src/forge/observe/rerun.js');
    const err: Error = await mod.recordTimeline({
      mission_id: 'm1',
      probe_sha256: SHA,
      points: [pt('b1', 0, 2, { motion: 8 })],
    }, join(dir, 'out.rrd')).catch((e: unknown) => e as Error);
    expect(err.message).toContain(RERUN_SDK_VERSION);
    expect(err.message).toContain('TIMMY_RERUN_PYTHON');
    expect(existsSync(join(dir, 'out.rrd'))).toBe(false); // failed before any recording
  });
});

// LIVE GATE: exercises the real recording path (pinned rerun SDK python per
// docs/RERUN-TIMMY-GUIDE.md). Skipped unless RUN_LIVE_INTEGRATION=1 AND an
// SDK python resolves AND the pinned rerun CLI is on PATH. No screenshots —
// assertion is on the .rrd artifact bytes only (house rule).
function liveGate(): { sdkPython: string | null; rerunCli: boolean } {
  if (process.env.RUN_LIVE_INTEGRATION !== '1') return { sdkPython: null, rerunCli: false };
  let rerunCli = false;
  try { execFileSync('rerun', ['--version'], { stdio: 'pipe' }); rerunCli = true; } catch { /* absent */ }
  return { sdkPython: resolveSdkPython(), rerunCli };
}

const live = liveGate();
(live.sdkPython && live.rerunCli ? describe : describe.skip)('recordTimeline LIVE (RUN_LIVE_INTEGRATION=1)', () => {
  it('records synthetic facet timelines to a non-empty .rrd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-rerun-live-'));
    try {
      const out = join(dir, 'scores.rrd');
      const res = await recordTimeline({
        mission_id: 'live-m1',
        probe_sha256: SHA,
        points: [
          pt('b1', 0, 2, { motion: 8, identity: 6 }),
          pt('b2', 2, 4, { motion: 4 }),
          pt('b3', 4, 6, { motion: 9, identity: 3, nsfw: 10 }),
        ],
      }, out);
      expect(res.entity).toBe(`forge/live-m1/${SHA.slice(0, 12)}`);
      expect(res.sdk_version).toBe(RERUN_SDK_VERSION);
      expect(existsSync(out)).toBe(true);
      expect(statSync(out).size).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});


describe('rerun recording boundaries', () => {
  const input = { mission_id: 'm1', probe_sha256: SHA, points: [pt('b1', 0, 1, { motion: 8 })] };
  it('rejects invalid windows, scores and ambiguous points before execution', () => {
    for (const point of [pt('b1', NaN, 1, { motion: 8 }), pt('b1', -1, 1, { motion: 8 }), pt('b1', 1, 1, { motion: 8 }), pt('b1', 0, 1, { motion: Infinity }), pt('b1', 0, 1, { motion: 11 })]) {
      expect(() => planTimeline({ ...input, points: [point] })).toThrow();
    }
    expect(() => planTimeline({ ...input, points: [pt('a', 0, 2, { motion: 1 }), pt('b', 1, 3, { motion: 2 })] })).toThrow(/overlap/);
  });
  it('preserves existing output and refuses empty or symlink runner output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rerun-boundary-'));
    try {
      const out = join(dir, 'out.rrd'); writeFileSync(out, 'keep');
      const runner = vi.fn(okRunner([]));
      await expect(recordTimeline(input, out, { runner })).rejects.toThrow(/exist/);
      expect(readFileSync(out, 'utf8')).toBe('keep'); expect(runner).not.toHaveBeenCalled();
      rmSync(out);
      await expect(recordTimeline(input, out, { runner: async (_cmd, args) => { writeFileSync(JSON.parse(args[2]).rrd, ''); } })).rejects.toThrow(/empty|regular/);
      const victim = join(dir, 'victim'); writeFileSync(victim, 'keep');
      await expect(recordTimeline(input, out, { runner: async (_cmd, args) => { symlinkSync(victim, JSON.parse(args[2]).rrd); } })).rejects.toThrow(/regular/);
      expect(readFileSync(victim, 'utf8')).toBe('keep');
      expect(readdirSync(dir)).toEqual(['victim']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('uses distinct temporary paths for concurrent calls to the same destination', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rerun-race-')); const paths: string[] = [];
    const runner: RerunRunner = async (_cmd, args) => { const path = JSON.parse(args[2]).rrd; paths.push(path); writeFileSync(path, 'rrd'); await new Promise(r => setTimeout(r, 10)); };
    try {
      const outcomes = await Promise.allSettled([recordTimeline(input, join(dir, 'out.rrd'), { runner }), recordTimeline(input, join(dir, 'out.rrd'), { runner })]);
      expect(new Set(paths).size).toBe(2);
      expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(readdirSync(dir)).toEqual(['out.rrd']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


it('bounds argv payload by UTF-8 bytes, not JavaScript character count', () => {
  const plan = planTimeline({ mission_id: '界'.repeat(40000), probe_sha256: SHA, points: [] });
  expect(() => buildRecordingInvocation(plan, '/tmp/synthetic.rrd', 'python')).toThrow(/too large/);
});
