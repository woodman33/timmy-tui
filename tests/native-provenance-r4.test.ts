/**
 * Round R4 (helper H18): an independent review of 07f37ec found that a native run's verdict could say
 * "as submitted" about a script that changed before the app read it (finding 5), and could count an old
 * file as this run's output because its bytes matched the digest a current result named (finding 6).
 * These tests hold the fixes:
 *   finding 5  the app runs a read-only copy of the script kept in the run's folder at submission, checked
 *              against the submission when it is made and when the run is judged; the script's own read
 *              digest must agree when given and is required when no copy ran (a run recorded before R4).
 *   finding 6  every output path a run may be judged on is inventoried before it starts (the expected
 *              outputs, and every file under out/ for the scripted apps), and each output is classified
 *              after it: created, changed or reused. Only created and changed are this run's work; an
 *              aerender sequence is judged the same way, frame by frame.
 *
 * Everything here runs against TEST DOUBLES: tests/fixtures/fake-native-app.mjs stands in for c4dpy and
 * Blender, tests/fixtures/fake-aerender.mjs for aerender, and python3 with stand-in `c4d` / `bpy` modules for
 * the starters. No Cinema 4D, Blender or After Effects runs here: a pass says the judgement rules and the
 * job set-up hold with real child processes, files, modes and timing, not that any of those apps was driven.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobManager, type JobRecord } from '../src/jobs/index.js';
import {
  aerenderJob, blenderJob, c4dpyJob, judgeNativeJob, judgeNativeRun, nativeReceiptFields, readNativeRecord, readNativeResult, reconcileNative,
  type NativeJobSpec,
} from '../src/native/index.js';

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const which = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
const python = which.status === 0 ? which.stdout.trim() : '';

let tmp = '';
let root = '';
let managers: JobManager[] = [];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'timmy-native-r4-')));
  root = path.join(tmp, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'scene.py'), '# the script as submitted: the fake app reads it, runs nothing\n');
  managers = [];
});
afterEach(async () => {
  for (const m of managers) await m.stopAll();
  rmSync(tmp, { recursive: true, force: true });
});

type ScriptApp = 'c4dpy' | 'blender';
type Result = Record<string, unknown> & { fixture?: { executed_sha256: string | null; original_sha256_seen: string | null } };

const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
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
async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}
function readResult(spec: NativeJobSpec): Result {
  const read = readNativeResult(spec.native.result!);
  if (read.state !== 'read') throw new Error(`no result file: ${read.state}`);
  return read.data as Result;
}
/** A file in the project from before the run, its times a minute old. */
function before(rel: string, text: string): void {
  const at = path.join(root, rel);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, text);
  const old = new Date(Date.now() - 60_000);
  utimesSync(at, old, old);
}
/** A c4dpy or Blender job running the fake app, as /c4d, /blender and run_native submit it (no expect unless given). */
function scripted(app: ScriptApp, env: NodeJS.ProcessEnv, extra: { expect?: string[] } = {}): NativeJobSpec {
  const bin = install('fake-native-app.mjs', path.join(tmp, 'bin', app));
  const make = app === 'c4dpy' ? c4dpyJob : blenderJob;
  return make({ script: 'scene.py', root, project: 'demo', timeoutMs: 20_000, bin, env, ...extra });
}

describe.each(['c4dpy', 'blender'] as const)('finding 5 (%s): what ran is exactly what was submitted', (app) => {
  it('an original edited after the run starts, and read during it, changes nothing that ran; a result without script_sha256_read is bound by the copy kept at submission', async () => {
    const submitted = readFileSync(path.join(root, 'scene.py'));
    const ready = path.join(tmp, 'ready');
    const go = path.join(tmp, 'go');
    const s = scripted(app, { FAKE_READY_FILE: ready, FAKE_GO_FILE: go });
    const m = manager();
    const started = m.start(s);
    await waitFor(() => existsSync(ready)); // the app has started and waits before it reads its script
    const edited = '# edited after the run started\nraise SystemExit("not the script submitted")\n';
    writeFileSync(path.join(root, 'scene.py'), edited);
    writeFileSync(go, '');
    const job = await m.done(started.id);
    const result = readResult(s);
    // the fixture's own account: it read the edited original during the run, and reported no read digest
    expect(result.fixture?.original_sha256_seen).toBe(sha(edited));
    expect(result).not.toHaveProperty('script_sha256_read');
    const verdict = judgeNativeJob(job, s);
    // The defect at 07f37ec: the app ran the script at its own path, edited after the run started, and with
    // no read digest the verdict still said "as submitted". A run judged ok must have run the submitted bytes.
    if (verdict.outcome === 'ok') expect(result.fixture?.executed_sha256, `judged ok (${verdict.why}), so it must have run the submitted bytes`).toBe(sha(submitted));
    expect(result.fixture?.executed_sha256).toBe(sha(submitted));
    expect(verdict.outcome).toBe('ok');
    expect(verdict.why).toMatch(/scene\.py as submitted \(the copy kept at submission ran/);
    expect(verdict.why).toMatch(/the script reported no sha256 of what it read/);
    expect(verdict.why).toMatch(/scene\.py itself has changed since it was submitted, which did not change what ran/);
    expect(verdict.source).toEqual({
      copy: `.timmy/native/${s.native.run}/source/scene.py`, copy_state: 'intact', read: 'not reported', established_by: ['retained copy'], original_changed: true,
    });
    expect(nativeReceiptFields(app, verdict).native.source).toEqual(verdict.source);
  });

  it('runs a read-only copy kept in the run\'s own folder, in the project folder, and tells the script where the original is', () => {
    const original = path.join(root, 'scene.py');
    const s = scripted(app, {});
    const copy = path.join(root, '.timmy', 'native', s.native.run, 'source', 'scene.py');
    expect(s.args).toContain(copy);
    expect(s.args).not.toContain(original);
    expect(s.root).toBe(root); // the job's working folder is still the project
    expect(readFileSync(copy)).toEqual(readFileSync(original));
    expect(statSync(copy).mode & 0o777).toBe(0o444);
    expect(s.env).toMatchObject({ TIMMY_SCRIPT: copy, TIMMY_SCRIPT_ORIGINAL: original, TIMMY_SCRIPT_DIR: root, TIMMY_SCRIPT_SHA256: sha(readFileSync(original)) });
    expect(s.native.copy).toEqual({ path: `.timmy/native/${s.native.run}/source/scene.py`, sha256: sha(readFileSync(original)) });
    expect(readNativeRecord(root, s.native.run)?.job).toMatchObject({
      input: { path: 'scene.py', sha256: sha(readFileSync(original)) }, copy: { path: `.timmy/native/${s.native.run}/source/scene.py`, sha256: sha(readFileSync(original)) },
    });
  });

  it('a script reached through a link is copied under the name submitted; its folder is where the link leads, as __file__ was', () => {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'real_scene.py'), '# the script the link leads to\n');
    rmSync(path.join(root, 'scene.py'));
    symlinkSync(path.join(root, 'src', 'real_scene.py'), path.join(root, 'scene.py'));
    const s = scripted(app, {});
    const copy = path.join(root, '.timmy', 'native', s.native.run, 'source', 'scene.py');
    expect(readFileSync(copy, 'utf8')).toBe('# the script the link leads to\n');
    expect(s.env).toMatchObject({ TIMMY_SCRIPT: copy, TIMMY_SCRIPT_ORIGINAL: path.join(root, 'src', 'real_scene.py'), TIMMY_SCRIPT_DIR: path.join(root, 'src') });
    expect(s.native.input).toEqual({ path: 'scene.py', sha256: sha('# the script the link leads to\n') });
  });

  it('a copy changed during the run is not what was submitted, whatever the result says it read', async () => {
    const s = scripted(app, { FAKE_TAMPER: '1', FAKE_READ_DIGEST: 'executed' });
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.why).toMatch(/the copy of scene\.py kept at submission \(\.timmy\/native\/.*\/source\/scene\.py\) no longer holds the submitted bytes/);
    expect(verdict.source).toMatchObject({ copy_state: 'changed', read: 'matches', established_by: [] });
  });

  it('a read digest that disagrees with the submission is never "as submitted", even with the copy intact', async () => {
    const ready = path.join(tmp, 'ready');
    const go = path.join(tmp, 'go');
    const s = scripted(app, { FAKE_READY_FILE: ready, FAKE_GO_FILE: go, FAKE_READ_DIGEST: 'original' });
    const m = manager();
    const started = m.start(s);
    await waitFor(() => existsSync(ready));
    writeFileSync(path.join(root, 'scene.py'), '# edited during the run\n');
    writeFileSync(go, '');
    const verdict = judgeNativeJob(await m.done(started.id), s);
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.why).toMatch(/the script reports reading other bytes than scene\.py as submitted/);
    expect(verdict.source).toMatchObject({ copy_state: 'intact', read: 'differs', established_by: [] });
  });

  it('a run recorded without a copy (before round R4) needs the script\'s read digest to be "as submitted"', async () => {
    const legacy = (spec: NativeJobSpec): void => {
      const at = path.join(root, '.timmy', 'native', spec.native.run, 'job.json');
      const record = JSON.parse(readFileSync(at, 'utf8')) as Record<string, unknown>;
      delete record.copy;
      writeFileSync(at, `${JSON.stringify(record, null, 2)}\n`);
    };
    const silent = scripted(app, {});
    const job = await runSpec(silent);
    legacy(silent);
    const verdict = reconcileNative(root, silent.native.run, { job });
    // The defect at 07f37ec: the read digest was checked only when the result carried one.
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.why).toMatch(/does not report the sha256 of the script as it was read \(script_sha256_read\), and no copy kept at submission ran/);
    expect(verdict.source).toMatchObject({ read: 'not reported', established_by: [] });
    const read = readResult(silent);
    expect(judgeNativeRun(job, read, { root, app, run: silent.native.run, input: silent.native.input }).outcome).toBe('unknown');

    // its own bytes: the first run's out/scene.bin rewritten with the same bytes would be reused (finding 6)
    const reported = scripted(app, { FAKE_READ_DIGEST: 'executed', FAKE_BYTES: 'fake scene bytes, a second run\n' });
    const done = await runSpec(reported);
    legacy(reported);
    const bound = reconcileNative(root, reported.native.run, { job: done });
    expect(bound.outcome, bound.why).toBe('ok');
    expect(bound.why).toMatch(/scene\.py as submitted \(the script read bytes with the submitted sha256; no copy was kept for this run\)/);
    expect(bound.source).toMatchObject({ read: 'matches', established_by: ['read digest'] });
  });
});

describe.skipIf(!python)('the starters run as copies and still find what sits beside the original (python3 standing in)', () => {
  it('Cinema 4D: timmy_c4d.py beside the original scene.py is found through TIMMY_SCRIPT_DIR', async () => {
    copyFileSync(path.join(REPO, 'templates', 'c4d-starter', 'scene.py'), path.join(root, 'scene.py'));
    copyFileSync(path.join(REPO, 'workers', 'c4d', 'timmy_c4d.py'), path.join(root, 'timmy_c4d.py'));
    const empty = path.join(tmp, 'no-helper');
    mkdirSync(empty);
    const s = c4dpyJob({
      script: 'scene.py', root, project: 'demo', bin: python, timeoutMs: 30_000,
      env: { PYTHONPATH: path.join(FIXTURES, 'c4d-stub'), PYTHONDONTWRITEBYTECODE: '1', TIMMY_C4D_LIB: empty },
    });
    const job = await runSpec(s);
    const result = readResult(s);
    expect(result.ok, String(result.error)).toBe(true);
    expect(result.script_sha256_read).toBe(s.native.input?.sha256);
    const verdict = judgeNativeJob(job, s);
    expect(verdict.outcome, verdict.why).toBe('ok');
    expect(verdict.source?.established_by).toEqual(['retained copy', 'read digest']);
    expect(verdict.files.map((f) => [f.path, f.change])).toEqual([['out/scene.c4d', 'created'], ['out/still.png', 'created']]);
  });

  it('Blender: timmy_blender.py beside the original scene.py is found through TIMMY_SCRIPT_DIR', async () => {
    copyFileSync(path.join(REPO, 'templates', 'blender-starter', 'scene.py'), path.join(root, 'scene.py'));
    copyFileSync(path.join(REPO, 'workers', 'blender', 'timmy_blender.py'), path.join(root, 'timmy_blender.py'));
    const empty = path.join(tmp, 'no-helper');
    mkdirSync(empty);
    const bin = install('fake-blender.mjs', path.join(tmp, 'bin', 'blender'));
    const s = blenderJob({
      script: 'scene.py', root, project: 'demo', bin, timeoutMs: 30_000,
      env: { FAKE_BLENDER_MODE: 'python', FAKE_BLENDER_PYTHON: python, PYTHONPATH: path.join(FIXTURES, 'blender-stub'), PYTHONDONTWRITEBYTECODE: '1', TIMMY_BLENDER_LIB: empty },
    });
    const job = await runSpec(s);
    const result = readResult(s);
    expect(result.ok, String(result.error)).toBe(true);
    const verdict = judgeNativeJob(job, s);
    expect(verdict.outcome, verdict.why).toBe('ok');
    expect(verdict.source?.established_by).toEqual(['retained copy', 'read digest']);
  });
});

describe.each(['c4dpy', 'blender'] as const)('finding 6 (%s): an output is this run\'s only if this run made it', (app) => {
  const BYTES = 'fake scene bytes\n';

  it.each([
    ['left untouched', 'keep'],
    ['rewritten with identical bytes', 'write'],
  ])('a named output there before the run with the same bytes (%s) is reused, never made by this run', async (_how, write) => {
    before('out/scene.bin', BYTES);
    const s = scripted(app, { FAKE_WRITE: write, FAKE_READ_DIGEST: 'executed' });
    const verdict = judgeNativeJob(await runSpec(s), s);
    // The defect at 07f37ec: a current-token result naming an old file with its correct sha256 was judged ok.
    expect(verdict.outcome).not.toBe('ok');
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.files).toEqual([expect.objectContaining({ path: 'out/scene.bin', present: true, matches: true, change: 'reused', written: false })]);
    expect(verdict.why).toMatch(/names out\/scene\.bin, which was there before this run with the same bytes \(reused\): not made by this run/);
    // the inventory taken before the run, and the classification kept in the run's record and in its receipt
    const rec = readNativeRecord(root, s.native.run);
    expect(rec?.job.pre['out/scene.bin']).toMatchObject({ state: 'present', size: BYTES.length, sha256: sha(BYTES) });
    expect(rec?.job.inventory).toMatchObject({ folders: ['out'], complete: true, files: 1, unhashed: 0 });
    expect(rec?.verdicts.at(-1)?.files[0]).toMatchObject({ path: 'out/scene.bin', change: 'reused', written: false });
    expect(nativeReceiptFields(app, verdict).native.files[0]).toMatchObject({ path: 'out/scene.bin', change: 'reused' });
  });

  it('a fresh output the result names is created by this run, and the run is ok', async () => {
    const s = scripted(app, { FAKE_READ_DIGEST: 'executed' });
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome, verdict.why).toBe('ok');
    expect(verdict.files).toEqual([expect.objectContaining({ path: 'out/scene.bin', change: 'created', written: true, matches: true })]);
    expect(verdict.why).toMatch(/out\/scene\.bin created by this run/);
    expect(readNativeRecord(root, s.native.run)?.job.inventory).toMatchObject({ folders: ['out'], complete: true, files: 0 });
  });

  it('an output there before with other bytes, rewritten by the run, is changed: this run\'s', async () => {
    before('out/scene.bin', 'an older scene\n');
    const s = scripted(app, { FAKE_READ_DIGEST: 'executed' });
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome, verdict.why).toBe('ok');
    expect(verdict.files[0]).toMatchObject({ path: 'out/scene.bin', change: 'changed', written: true });
  });

  it('an expected output the result names, reused, is not this run\'s either', async () => {
    before('out/scene.bin', BYTES);
    const s = scripted(app, { FAKE_WRITE: 'keep', FAKE_READ_DIGEST: 'executed' }, { expect: ['out/scene.bin'] });
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.files).toEqual([expect.objectContaining({ path: 'out/scene.bin', change: 'reused', written: false })]);
  });

  it('a named file outside out/ and the expected files was not inventoried: whether this run made it is not known', async () => {
    const s = scripted(app, { FAKE_OUTPUT: 'renders/a.bin', FAKE_READ_DIGEST: 'executed' });
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.files[0]).toMatchObject({ path: 'renders/a.bin', change: 'unrecorded', written: false, inventoried: false });
    expect(verdict.why).toMatch(/names renders\/a\.bin, which Timmy did not inventory before the run \(it is outside out\/ and the expected outputs\)/);
  });

  it('a named output that is a link made during the run, to a file from before it, is judged by the bytes it leads to', async () => {
    before('assets/old.bin', BYTES);
    const s = scripted(app, { FAKE_WRITE: 'link', FAKE_LINK_TO: 'assets/old.bin', FAKE_READ_DIGEST: 'executed' });
    const verdict = judgeNativeJob(await runSpec(s), s);
    // out/scene.bin was not there before the run, but the bytes it leads to were: never "created" by this run
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.files[0]).toMatchObject({ path: 'out/scene.bin', present: true, matches: true, written: false, inventoried: false });
    expect(['reused', 'unrecorded']).toContain(verdict.files[0].change);
    expect(verdict.why).toMatch(/names out\/scene\.bin, which .*it leads to assets\/old\.bin, and it is outside out\/ and the expected outputs/);
  });
});

describe('finding 6 (aerender): an output and each frame by its bytes', () => {
  function ae(mode: string, extra: Partial<Parameters<typeof aerenderJob>[0]> = {}): NativeJobSpec {
    const bin = install('fake-aerender.mjs', path.join(tmp, 'bin', 'aerender'));
    if (!existsSync(path.join(root, 'title.aep'))) writeFileSync(path.join(root, 'title.aep'), 'fake project bytes');
    return aerenderJob({ projectFile: 'title.aep', comp: 'Main Comp', output: 'out/title.mov', root, project: 'demo', timeoutMs: 20_000, bin, env: { FAKE_AERENDER_MODE: mode }, ...extra });
  }

  it('an output rewritten with the bytes it already had is reused, not rendered by this run', async () => {
    before('out/title.mov', 'fake movie bytes\n'); // exactly what the fake aerender writes
    const s = ae('ok');
    expect(s.native.pre?.['out/title.mov']).toMatchObject({ state: 'present', sha256: sha('fake movie bytes\n') });
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(statSync(path.join(root, 'out', 'title.mov')).mtimeMs).toBeGreaterThan(Date.now() - 30_000); // it was written during the run
    // The defect at 07f37ec: a new time on the same bytes counted as this run's render.
    expect(verdict.outcome).not.toBe('ok');
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.files[0]).toMatchObject({ path: 'out/title.mov', change: 'reused', written: false });
    expect(verdict.why).toMatch(/out\/title\.mov \(there before this run with the same bytes: reused, not written by this run\)/);
  });

  it('a frame rewritten with the bytes it already had is reused, so the sequence is not whole', async () => {
    for (let f = 0; f <= 3; f++) before(`out/f_000${f}.png`, f === 1 ? 'fake frame 1\n' : `an older frame ${f}\n`);
    const s = ae('ok', { output: 'out/f_[####].png', startFrame: 0, endFrame: 3 });
    const verdict = judgeNativeJob(await runSpec(s), s);
    // The defect at 07f37ec: every frame had a new time, so every frame counted as this run's.
    expect(verdict.outcome).not.toBe('ok');
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.checked?.[0]).toMatchObject({ range: [0, 3], written: 3, missing: [1], stale: [1], by_change: { created: 0, changed: 3, reused: 1, unverified: 0 } });
    expect(verdict.why).toMatch(/out\/f_\[####\]\.png \(1 frame of 0–3 missing or not written during this run, first 1; 1 frame was there before this run with the same bytes \(reused\)\)/);
    const pre = s.native.pre?.['out/f_[####].png'];
    expect(pre?.state === 'sequence' ? pre.frames['1'] : undefined).toMatchObject({ sha256: sha('fake frame 1\n') });
  });

  it('frames new to the run, or with other bytes than before, are all this run\'s', async () => {
    before('out/f_0000.png', 'an older frame 0\n');
    const s = ae('ok', { output: 'out/f_[####].png', startFrame: 0, endFrame: 3 });
    const verdict = judgeNativeJob(await runSpec(s), s);
    expect(verdict.outcome, verdict.why).toBe('ok');
    expect(verdict.checked?.[0]).toMatchObject({ written: 4, missing: [], by_change: { created: 3, changed: 1, reused: 0, unverified: 0 } });
  });

  it('an output whose bytes before the run were not recorded, rewritten with the same size, is not shown to be this run\'s', async () => {
    before('out/title.mov', 'other movie bytes');
    const s = ae('ok');
    const at = statSync(path.join(root, 'out', 'title.mov'));
    // as an inventory past its hashing budget records a file: its size and times, no sha256
    const pre = { 'out/title.mov': { state: 'present' as const, size: 'fake movie bytes\n'.length, mtimeMs: at.mtimeMs, ctimeMs: at.ctimeMs, sha256: '' } };
    const job = await runSpec(s);
    const verdict = judgeNativeJob(job, { ...s.native, pre, record: undefined });
    expect(verdict.files[0]).toMatchObject({ path: 'out/title.mov', change: 'unverified', written: false });
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.why).toMatch(/its bytes before the run were not recorded/);
  });
});
