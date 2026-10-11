/**
 * Round R3 (helper H7): an independent review of 40022d9 found native results attributed too loosely
 * (finding 5) and native exercise matched by a shared tool name (finding 6). These tests hold the fixes:
 * a result file per run, success bound to the input submitted and to outputs this run wrote, a retained
 * record per run that a restart can judge from, and app-specific exercise records.
 *
 * Everything here runs against TEST DOUBLES (tests/fixtures/fake-c4dpy.mjs, fake-aerender.mjs): no
 * Cinema 4D or After Effects runs, so a pass says the judgement rules hold, not that either app was driven.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobManager, type JobRecord } from '../src/jobs/index.js';
import {
  aerenderJob, c4dpyJob, judgeNativeJob, nativeCapabilityRows, nativeReceiptFields, nativeRunIndex, noteNativeStarted, readNativeRecord, reconcileNative,
  type NativeJobSpec,
} from '../src/native/index.js';
import { capabilities, type CapabilityRow, type ProbeDeps } from '../src/capabilities/index.js';
import { createNativeTools } from '../src/agent/native-tools.js';

const FIXTURES = path.join(__dirname, 'fixtures');
let tmp = '';
let root = '';
let managers: JobManager[] = [];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'timmy-native-prov-')));
  root = path.join(tmp, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'scene.py'), '# a stand-in: the fake c4dpy hashes it, runs nothing\n');
  managers = [];
});
afterEach(async () => {
  for (const m of managers) await m.stopAll();
  rmSync(tmp, { recursive: true, force: true });
});

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
function install(fixture: string, at: string): string {
  mkdirSync(path.dirname(at), { recursive: true });
  copyFileSync(path.join(FIXTURES, fixture), at);
  chmodSync(at, 0o755);
  return at;
}
function manager(): JobManager {
  const m = new JobManager({ dir: path.join(tmp, 'jobs') });
  managers.push(m);
  return m;
}
async function runSpec(spec: NativeJobSpec): Promise<JobRecord> {
  const m = manager();
  return m.done(m.start(spec).id);
}
function c4d(mode: string, extra: Partial<Parameters<typeof c4dpyJob>[0]> = {}): NativeJobSpec {
  const bin = install('fake-c4dpy.mjs', path.join(tmp, 'bin', 'c4dpy'));
  return c4dpyJob({ script: 'scene.py', root, project: 'demo', timeoutMs: 20_000, bin, env: { FAKE_C4DPY_MODE: mode }, expect: ['out/scene.c4d', 'out/still.png'], ...extra });
}
function ae(mode: string, extra: Partial<Parameters<typeof aerenderJob>[0]> = {}): NativeJobSpec {
  const bin = install('fake-aerender.mjs', path.join(tmp, 'bin', 'aerender'));
  if (!existsSync(path.join(root, 'title.aep'))) writeFileSync(path.join(root, 'title.aep'), 'fake project bytes');
  return aerenderJob({ projectFile: 'title.aep', comp: 'Main Comp', output: 'out/title.mov', root, project: 'demo', timeoutMs: 20_000, bin, env: { FAKE_AERENDER_MODE: mode }, ...extra });
}

describe('finding 5a: a result file per run, never shared', () => {
  it('two c4dpy runs get two result files inside the project, under .timmy/native/<run>', () => {
    const a = c4d('ok-exit-1');
    const b = c4d('ok-exit-1');
    expect(a.native.run).not.toBe(b.native.run);
    expect(a.native.result).not.toBe(b.native.result);
    expect(a.native.result).toBe(path.join(root, '.timmy', 'native', a.native.run, 'result.json'));
    expect(a.env?.TIMMY_RESULT).toBe(a.native.result);
    expect(b.native.result).toBe(path.join(root, '.timmy', 'native', b.native.run, 'result.json'));
  });

  it('two runs at once each keep their own result: the second does not overwrite the first', async () => {
    const a = c4d('ok-exit-1');
    const b = c4d('fail');
    const m = manager();
    const [ja, jb] = await Promise.all([m.done(m.start(a).id), m.done(m.start(b).id)]);
    expect(judgeNativeJob(ja, a).outcome).toBe('ok');
    expect(judgeNativeJob(jb, b).outcome).toBe('failed');
  });
});

describe('finding 5b: success is bound to the script submitted', () => {
  it('records the script sha256 at submission, gives it to the script, and needs it echoed', async () => {
    const s = c4d('ok-exit-1');
    const want = sha(path.join(root, 'scene.py'));
    expect(s.native.input).toEqual({ path: 'scene.py', sha256: want });
    expect(s.env?.TIMMY_SCRIPT_SHA256).toBe(want);
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome).toBe('ok');
    expect(nativeReceiptFields('c4dpy', verdict).native).toMatchObject({ run: s.native.run, input: { path: 'scene.py', sha256: want } });
  });

  it('a result that does not echo the script sha256 is not ok', async () => {
    const s = c4d('no-sha');
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.why).toMatch(/sha256/);
  });

  it('a result that echoes another script sha256 is not ok', async () => {
    const s = c4d('wrong-sha');
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.why).toMatch(/another script/);
  });

  it('a script changed after submission does not change what runs: the copy kept at submission runs, and the verdict says the original changed', async () => {
    const s = c4d('ok-exit-1');
    writeFileSync(path.join(root, 'scene.py'), '# edited after the job was made\n');
    const verdict = judgeNativeJob(await runSpec(s), s);
    // R4 (finding 5): this was unknown while c4dpy ran the script at its own path, edited; it now runs the bytes submitted
    expect(verdict.outcome).toBe('ok');
    expect(verdict.why).toMatch(/scene\.py itself has changed since it was submitted, which did not change what ran/);
    expect(verdict.source).toMatchObject({ copy_state: 'intact', read: 'matches', established_by: ['retained copy', 'read digest'], original_changed: true });
  });

  it('a file named without its sha256 is not ok: digests are required', async () => {
    const s = c4d('no-digest');
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome).toBe('failed');
    expect(verdict.why).toMatch(/out\/still\.png.*sha256/);
  });

  it('a file named outside the project is not ok, and its path stays out of the record', async () => {
    const s = c4d('outside');
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome).toBe('failed');
    expect(verdict.why).toMatch(/outside the project/);
    expect(JSON.stringify(nativeReceiptFields('c4dpy', verdict))).not.toContain(tmp);
  });

  it('an expected file the result does not name, and this run did not write, is not accounted for', async () => {
    writeFileSync(path.join(root, 'out-before.txt'), 'x');
    mkdirSync(path.join(root, 'out'), { recursive: true });
    writeFileSync(path.join(root, 'out', 'still.png'), 'an older still, from before this run');
    const old = new Date(Date.now() - 60_000);
    utimesSync(path.join(root, 'out', 'still.png'), old, old);
    const s = c4d('one-named', { expect: ['out/scene.c4d', 'out/old.txt'] });
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome).toBe('failed');
    expect(verdict.why).toMatch(/out\/old\.txt/);
  });
});

describe('finding 5c: aerender is judged by outputs this run wrote', () => {
  it('records the project file sha256 and each output state at submission', () => {
    const s = ae('ok');
    expect(s.native.input).toEqual({ path: 'title.aep', sha256: sha(path.join(root, 'title.aep')) });
    expect(s.native.pre).toEqual({ 'out/title.mov': { state: 'absent' } });
  });

  it('an output left from before the run is not this run\'s, however recent', async () => {
    mkdirSync(path.join(root, 'out'), { recursive: true });
    writeFileSync(path.join(root, 'out', 'title.mov'), 'an earlier render');
    const s = ae('no-output');
    expect(s.native.pre?.['out/title.mov']).toMatchObject({ state: 'present', size: 17 });
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.why).toMatch(/not written by this run|was not written/);
  });

  it('an output this run rewrote is its own', async () => {
    mkdirSync(path.join(root, 'out'), { recursive: true });
    writeFileSync(path.join(root, 'out', 'title.mov'), 'an earlier render');
    const s = ae('ok');
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome).toBe('ok');
  });

  it('a second run on the same output while the first is running and unjudged is refused', () => {
    const first = ae('ok');
    expect(() => ae('ok')).not.toThrow(); // made, never started: it writes nothing and blocks nothing
    noteNativeStarted(first, { id: 'j000001', startedAt: new Date().toISOString(), pid: process.pid } as JobRecord);
    expect(() => ae('ok')).toThrow(/another run .* is writing out\/title\.mov/);
  });

  it('a run whose process is gone (stopped, crashed) does not block its output', () => {
    const first = ae('ok');
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    noteNativeStarted(first, { id: 'j000002', startedAt: new Date().toISOString(), pid: gone } as JobRecord);
    expect(() => ae('ok')).not.toThrow();
  });

  it('a sequence needs every frame of the range it was given, each written by this run', async () => {
    const s = ae('ok', { output: 'out/frame_[####].png', startFrame: 0, endFrame: 3 });
    expect(s.args).toEqual(expect.arrayContaining(['-s', '0', '-e', '3']));
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome).toBe('ok');
    expect(verdict.checked).toMatchObject([{ pattern: 'out/frame_[####].png', range: [0, 3], range_from: 'arguments', written: 4, missing: [] }]);
  });

  it('a sequence with a frame missing from its range is not ok', async () => {
    const s = ae('gap', { output: 'out/frame_[####].png', startFrame: 0, endFrame: 4 });
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.checked?.[0]).toMatchObject({ missing: [2] });
  });

  it('a single stray frame of a sequence with no range is not success', async () => {
    const s = ae('one-frame', { output: 'out/frame_[####].png' });
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome).not.toBe('ok');
    expect(verdict.why).toMatch(/one frame|range/);
  });

  it('run_native passes a frame range through, so the agent\'s sequence is judged against the whole range', async () => {
    const m = manager();
    const bin = install('fake-aerender.mjs', path.join(tmp, 'bin', 'aerender'));
    writeFileSync(path.join(root, 'title.aep'), 'fake project bytes');
    const started: NativeJobSpec[] = [];
    const [run] = createNativeTools({
      root: () => root, project: () => 'demo', start: (s) => m.start(s), find: { aerender: () => ({ app: 'aerender', path: bin, how: 'env' }) },
      onStarted: (_job, s) => void started.push(s), env: { FAKE_AERENDER_MODE: 'gap' },
    });
    const call = (run.function as unknown as { execute: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }).execute;
    const answer = await call({ app: 'aerender', project_file: 'title.aep', comp: 'Main', output: 'out/f_[####].png', start_frame: 0, end_frame: 4 });
    expect(answer).toMatchObject({ ok: true, output: 'out/f_[####].png' });
    expect(started[0].args).toEqual(expect.arrayContaining(['-s', '0', '-e', '4']));
    const verdict = judgeNativeJob(await m.done(answer.job as string), started[0]);
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.checked?.[0]).toMatchObject({ range: [0, 4], range_from: 'arguments', missing: [2] });
  });

  it('a sequence with no range is ok when a contiguous run of frames was all written by this run', async () => {
    const s = ae('ok', { output: 'out/frame_[####].png' });
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome).toBe('ok');
    expect(verdict.checked?.[0]).toMatchObject({ range: [0, 3], range_from: 'frames written', written: 4 });
  });
});

describe('finding 5d: a retained record per run, judged again after a restart', () => {
  it('writes job.json at submission and appends each verdict beside it, never touching job.json', async () => {
    const s = c4d('ok-exit-1');
    const dir = path.join(root, '.timmy', 'native', s.native.run);
    const job = JSON.parse(readFileSync(path.join(dir, 'job.json'), 'utf8'));
    expect(job).toMatchObject({
      app: 'c4dpy', run: s.native.run, program: path.join(tmp, 'bin', 'c4dpy'), input: { path: 'scene.py', sha256: sha(path.join(root, 'scene.py')) },
      result: `.timmy/native/${s.native.run}/result.json`, expect: ['out/scene.c4d', 'out/still.png'],
      pre: { 'out/scene.c4d': { state: 'absent' }, 'out/still.png': { state: 'absent' } },
    });
    expect(Date.parse(job.started_at)).toBeGreaterThan(0);
    const before = readFileSync(path.join(dir, 'job.json'), 'utf8');
    const done = await runSpec(s);
    judgeNativeJob(done, s);
    judgeNativeJob(done, s); // the REPL judges twice (its notice, its receipt): one line
    expect(readFileSync(path.join(dir, 'job.json'), 'utf8')).toBe(before);
    const rec = readNativeRecord(root, s.native.run);
    expect(rec?.verdicts).toHaveLength(1);
    expect(rec?.verdicts[0]).toMatchObject({ outcome: 'ok', job: done.id });
  });

  it('reconcileNative judges a finished run from its record, result and files alone', async () => {
    const s = c4d('ok-exit-1');
    await runSpec(s);
    const verdict = reconcileNative(root, s.native.run);
    expect(verdict.outcome).toBe('ok');
    expect(verdict.exit.state).toBe('unknown');
    expect(verdict.why).toMatch(/reconciled/);
  });

  it('reconcileNative calls an orphaned run with no result unknown, and a tampered output failed', async () => {
    const orphan = c4d('no-result');
    expect(reconcileNative(root, orphan.native.run).outcome).toBe('unknown');
    const s = c4d('ok-exit-1');
    await runSpec(s);
    writeFileSync(path.join(root, 'out', 'still.png'), 'changed after the run');
    expect(reconcileNative(root, s.native.run).outcome).toBe('failed');
  });

  it('a start note links the run to its job, so a restart judges it with the exit the job recorded', async () => {
    const s = c4d('ok-exit-1');
    const m = manager();
    const started = m.start(s);
    noteNativeStarted(s, started);
    const done = await m.done(started.id);
    expect(readNativeRecord(root, s.native.run)?.started).toMatchObject({ job: started.id });
    const verdict = reconcileNative(root, s.native.run, { findJob: (id) => (id === done.id ? done : undefined) });
    expect(verdict.outcome).toBe('ok');
    expect(verdict.exit).toMatchObject({ state: 'failed', code: 1 });
  });

  it('reconcileNative refuses a run token that is not a run of this project', () => {
    expect(() => reconcileNative(root, '../../etc')).toThrow(/run/);
    expect(() => reconcileNative(root, '00000000-0000-4000-8000-000000000000')).toThrow(/no record/);
  });

  it('reconcileNative refuses a record edited to name a file outside the project', () => {
    const s = c4d('ok-exit-1');
    const at = path.join(root, '.timmy', 'native', s.native.run, 'job.json');
    const job = JSON.parse(readFileSync(at, 'utf8'));
    writeFileSync(at, JSON.stringify({ ...job, result: '../../outside.json' }));
    expect(() => reconcileNative(root, s.native.run)).toThrow(/does not lead inside the project/);
  });
});

describe('finding 6: native exercise is app-specific', () => {
  const sealed = (ts: string, app: string, outcome: string, why = 'why', status?: string): Record<string, unknown> =>
    ({ kind: 'native', ts, hash: `sha256_${ts}`, ...(status ? { status } : {}), native: { app, outcome, why, exit_code: 0, signal: null, files: [] } });
  const none: ProbeDeps = {
    env: {}, onPath: () => false, canvasBuilt: () => false, studio: async () => ({ state: 'not-running' }), studioBase: 'http://127.0.0.1:4337',
    ollama: async () => ({ ok: false, models: [] }), openrouter: async () => 'no-key', modelKeySource: () => null, model: 'm', http: async () => null,
    lanes: () => [], adapters: () => [], receipts: () => ({ ok: true, count: 0 }), exercised: () => new Map(), edgeSet: () => false, exists: () => false,
  };
  const byId = (rows: CapabilityRow[]) => Object.fromEntries(rows.map((r) => [r.id, r]));

  it('a completed run_native call marks neither app exercised', async () => {
    const r = byId(await capabilities({ ...none, exercised: () => new Map([['run_native', '2026-10-09T10:00:00Z']]) }));
    expect(r.c4dpy.exercised).toBeUndefined();
    expect(r.aerender.exercised).toBeUndefined();
    expect(r.c4dpy.tools).toEqual(['run_native']);
  });

  it('only a sealed receipt with app c4dpy and outcome ok shows Cinema 4D exercised; After Effects is untouched', async () => {
    const chain = [sealed('2026-10-09T09:00:00Z', 'c4dpy', 'ok', 'the result file says ok', 'ok'), sealed('2026-10-09T11:00:00Z', 'c4dpy', 'failed', 'the script reported ok: false: RenderDocument returned 1', 'failed')];
    const r = byId(await capabilities({ ...none, nativeRuns: () => nativeRunIndex(chain) }));
    expect(r.c4dpy.exercised).toBe('2026-10-09T09:00:00Z');
    expect(r.c4dpy.detail).toMatch(/last run failed: the script reported ok: false: RenderDocument returned 1, 2026-10-09T11:00:00Z/);
    expect(r.aerender.exercised).toBeUndefined();
    expect(r.aerender.detail).not.toMatch(/last run/);
  });

  it('a failed or unknown run alone claims no exercise; an ok without a sealed ok status does not either', async () => {
    const chain = [sealed('2026-10-09T09:00:00Z', 'aerender', 'unknown', 'aerender exited 0, but out/a.mov is not there'), sealed('2026-10-09T10:00:00Z', 'c4dpy', 'ok', 'says ok')];
    const r = byId(await capabilities({ ...none, nativeRuns: () => nativeRunIndex(chain) }));
    expect(r.aerender.exercised).toBeUndefined();
    expect(r.aerender.detail).toMatch(/last run unknown: aerender exited 0/);
    expect(r.c4dpy.exercised).toBeUndefined();
  });

  it('a submission not yet judged shows as submitted, not exercised', async () => {
    const r = byId(await capabilities({ ...none, nativeRuns: () => nativeRunIndex([], [{ app: 'c4dpy', run: 'r1', started_at: '2026-10-09T12:00:00Z', verdicts: [] }]) }));
    expect(r.c4dpy.exercised).toBeUndefined();
    expect(r.c4dpy.detail).toMatch(/submitted 2026-10-09T12:00:00Z, not judged yet/);
  });

  it('the rows say what decides them: their own app, never a shared tool name', () => {
    const rows = nativeCapabilityRows({}, { platform: 'linux', onPath: () => null });
    for (const r of rows) expect(r.exercisedBy).toBe(`native:${r.id}`);
  });
});
