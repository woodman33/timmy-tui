/**
 * Blender's own Python as a third native app (R3, helper H7): the same judged-job model as c4dpy, with the
 * stronger provenance (a result per run, bound to its token, the script's sha256 and digests of every file).
 *
 * Everything here runs against TEST DOUBLES: tests/fixtures/fake-blender.mjs stands in for the blender
 * executable, and in its python mode hands the script to python3 with a stand-in `bpy`
 * (tests/fixtures/blender-stub). No Blender runs here: a pass says the job, the starter
 * (templates/blender-starter/scene.py), the helper (workers/blender/timmy_blender.py) and the judgement
 * agree with each other and with the names the stand-in defines from the documented API, not that Blender
 * accepts the calls.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobManager, type JobRecord } from '../src/jobs/index.js';
import {
  blenderJob, findBlender, judgeNativeJob, locateNative, nativeCapabilityRows, nativeReceiptFields, readNativeRecord, readNativeResult,
  type NativeJobSpec,
} from '../src/native/index.js';
import { createNativeTools } from '../src/agent/native-tools.js';

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const STUB = path.join(FIXTURES, 'blender-stub');
const which = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
const python = which.status === 0 ? which.stdout.trim() : '';

let tmp = '';
let root = '';
let managers: JobManager[] = [];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'timmy-blender-')));
  root = path.join(tmp, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'scene.py'), '# a stand-in scene: the fake blender hashes it, runs nothing\n');
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
async function runSpec(spec: NativeJobSpec): Promise<{ job: JobRecord; m: JobManager }> {
  const m = new JobManager({ dir: path.join(tmp, 'jobs') });
  managers.push(m);
  return { m, job: await m.done(m.start(spec).id) };
}
function spec(mode: string, extra: Partial<Parameters<typeof blenderJob>[0]> = {}): NativeJobSpec {
  const bin = install('fake-blender.mjs', path.join(tmp, 'bin', 'blender'));
  return blenderJob({ script: 'scene.py', root, project: 'demo', timeoutMs: 30_000, bin, env: { FAKE_BLENDER_MODE: mode }, expect: ['out/scene.blend', 'out/render.png'], ...extra });
}

describe('finding Blender', () => {
  const none = { onPath: () => null };
  it('takes TIMMY_BLENDER first, opening a Blender.app bundle to its executable', () => {
    const bundle = path.join(tmp, 'Blender.app');
    const inner = install('fake-blender.mjs', path.join(bundle, 'Contents', 'MacOS', 'Blender'));
    expect(findBlender({ TIMMY_BLENDER: bundle }, { platform: 'darwin', ...none })).toMatchObject({ app: 'blender', path: inner, how: 'env' });
  });
  it('on macOS finds /Applications/Blender.app, and a versioned Blender 4.2.app, newest first', () => {
    const apps = path.join(tmp, 'Applications');
    install('fake-blender.mjs', path.join(apps, 'Blender.app', 'Contents', 'MacOS', 'Blender'));
    expect(findBlender({}, { platform: 'darwin', applications: apps, ...none })).toMatchObject({ path: path.join(apps, 'Blender.app', 'Contents', 'MacOS', 'Blender'), how: 'applications', folder: 'Blender.app' });
    const versioned = install('fake-blender.mjs', path.join(apps, 'Blender 4.2.app', 'Contents', 'MacOS', 'Blender'));
    expect(findBlender({}, { platform: 'darwin', applications: apps, ...none })).toMatchObject({ path: versioned, version: '4.2' });
  });
  it('off macOS looks on PATH, and says why when TIMMY_BLENDER names nothing runnable', () => {
    expect(findBlender({}, { platform: 'linux', onPath: (p) => (p === 'blender' ? '/usr/bin/blender' : null) })).toMatchObject({ path: '/usr/bin/blender', how: 'path' });
    expect(locateNative('blender', { TIMMY_BLENDER: path.join(tmp, 'gone') }, { platform: 'linux', ...none }).problem).toMatch(/TIMMY_BLENDER/);
  });
});

describe('Blender jobs: the result file decides, bound to the run and the script', () => {
  it('runs blender -b --factory-startup --python <script> -- <args>, the helper folder and the binding in its environment', () => {
    const s = spec('ok', { args: ['--seed', '7'] });
    expect(s.kind).toBe('task');
    // R4 (finding 5): Blender runs the read-only copy kept in the run's folder at submission, not the script at its own path
    const copy = path.join(root, '.timmy', 'native', s.native.run, 'source', 'scene.py');
    expect(s.args).toEqual(['-b', '--factory-startup', '--python-exit-code', '1', '--python', copy, '--', '--seed', '7']);
    expect(s.label).toMatch(/Blender/);
    expect(s.env).toMatchObject({
      TIMMY_RESULT: path.join(root, '.timmy', 'native', s.native.run, 'result.json'), TIMMY_RUN: s.native.run, TIMMY_ROOT: root,
      TIMMY_SCRIPT: copy, TIMMY_SCRIPT_ORIGINAL: path.join(root, 'scene.py'), TIMMY_SCRIPT_SHA256: sha(path.join(root, 'scene.py')), TIMMY_BLENDER_LIB: path.join(REPO, 'workers', 'blender'),
    });
    expect(existsSync(path.join(String(s.env?.TIMMY_BLENDER_LIB), 'timmy_blender.py'))).toBe(true);
    expect(s.native).toMatchObject({ app: 'blender', input: { path: 'scene.py' }, expect: ['out/scene.blend', 'out/render.png'] });
    expect(readNativeRecord(root, s.native.run)?.job).toMatchObject({ app: 'blender', run: s.native.run, input: { path: 'scene.py' } });
  });

  it('refuses a script outside the project, and one that is not .py', () => {
    expect(() => spec('ok', { script: '../elsewhere.py' })).toThrow(/outside the project/);
    writeFileSync(path.join(root, 'scene.txt'), 'x');
    expect(() => spec('ok', { script: 'scene.txt' })).toThrow(/\.py/);
  });

  it('says ok for a result of this run, from this script, naming files in the project with matching sha256', async () => {
    const s = spec('ok');
    const { job } = await runSpec(s);
    const verdict = judgeNativeJob(job, s);
    expect(verdict.outcome).toBe('ok');
    expect(verdict.files.map((f) => [f.path, f.present, f.matches])).toEqual([['out/scene.blend', true, true], ['out/render.png', true, true]]);
    const sealed = nativeReceiptFields('blender', verdict);
    expect(sealed.status).toBe('ok');
    expect(sealed.native).toMatchObject({ app: 'blender', outcome: 'ok', run: s.native.run, blender_version: '4.2.0 (fake)' });
    expect(JSON.stringify(sealed)).not.toContain(tmp);
  });

  it.each([
    ['no-result', 'unknown', /no result file/],
    ['wrong-run', 'unknown', /another run/],
    ['wrong-sha', 'unknown', /another script/],
    ['no-digest', 'failed', /out\/render\.png without its sha256/],
    ['outside', 'failed', /outside the project/],
    ['fail', 'failed', /render\.render returned CANCELLED/],
  ])('mode %s is %s, never ok', async (mode, outcome, why) => {
    const s = spec(mode);
    const { job } = await runSpec(s);
    const verdict = judgeNativeJob(job, s);
    expect(verdict.outcome).toBe(outcome);
    expect(verdict.why).toMatch(why);
  });
});

describe.skipIf(!python)('the Blender starter against a stand-in bpy (python3 in Blender\'s place)', () => {
  async function starter(env: NodeJS.ProcessEnv = {}) {
    copyFileSync(path.join(REPO, 'templates', 'blender-starter', 'scene.py'), path.join(root, 'scene.py'));
    const s = spec('python', { env: { FAKE_BLENDER_MODE: 'python', FAKE_BLENDER_PYTHON: python, PYTHONPATH: STUB, PYTHONDONTWRITEBYTECODE: '1', ...env } });
    const { job, m } = await runSpec(s);
    const read = readNativeResult(s.native.result!);
    return { s, job, verdict: judgeNativeJob(job, s), result: read.state === 'read' ? read.data as Record<string, unknown> : undefined, log: m.tail(job.id, 40).join('\n') };
  }

  it('saves out/scene.blend, renders out/render.png at 640x400 with Workbench, and is judged ok', async () => {
    const { s, job, verdict, result, log } = await starter();
    expect(job.state, log).toBe('completed');
    expect(result).toMatchObject({
      ok: true, run: s.native.run, script_sha256: s.native.input?.sha256, script_sha256_read: s.native.input?.sha256,
      engine: 'BLENDER_WORKBENCH', resolution: [640, 400], materials: ['Timmy Green', 'Off White'], blender_version: '4.2.0 (stand-in)',
    });
    // Every object in the scene, from scene.objects: the primitives sit in the active collection (as on the Mac,
    // round R3, where the result listed only the master collection's Aim, Camera and Sun).
    expect(result?.objects).toEqual(['Aim', 'Camera', 'Cube', 'Cylinder', 'Ground', 'Sphere', 'Sun']);
    expect(Object.keys(result?.files as object).sort()).toEqual(['out/render.png', 'out/scene.blend']);
    expect(verdict.outcome, verdict.why).toBe('ok');
    const blend = JSON.parse(readFileSync(path.join(root, 'out', 'scene.blend'), 'utf8'));
    expect(blend).toMatchObject({ camera: 'Camera', materials: ['Timmy Green', 'Off White'] });
    expect(readFileSync(path.join(root, 'out', 'render.png')).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('a render that fails is ok: false with the error, the saved scene still recorded', async () => {
    const { verdict, result } = await starter({ BPY_STUB_RENDER_FAIL: '1' });
    expect(result).toMatchObject({ ok: false });
    expect(String(result?.error)).toMatch(/render\.render returned/);
    expect(Object.keys(result?.files as object)).toEqual(['out/scene.blend']);
    expect(String(result?.traceback)).not.toContain(root);
    expect(verdict.outcome).toBe('failed');
  });

  it('without the helper it still leaves a result that says what is missing', async () => {
    const empty = path.join(tmp, 'no-helper');
    mkdirSync(empty);
    const { verdict, result } = await starter({ TIMMY_BLENDER_LIB: empty });
    expect(String(result?.error)).toMatch(/timmy_blender\.py was not found/);
    expect(verdict.outcome).toBe('failed');
  });
});

describe('the Blender row and run_native', () => {
  it('lists Blender as a third native app, keyed to its own runs', () => {
    const rows = nativeCapabilityRows({}, { platform: 'linux', onPath: () => null });
    // R4: After Effects scripting (afterfx) is the fourth row, after Blender; OpenSCAD (H27) the fifth, FreeCAD (H28) the sixth,
    // Illustrator scripting (H64) the seventh.
    expect(rows.map((r) => r.id)).toEqual(['c4dpy', 'aerender', 'blender', 'afterfx', 'openscad', 'freecad', 'illustrator']);
    const b = rows[2];
    expect(b).toMatchObject({ kind: 'adapter', name: 'Blender (Python, headless)', rung: 'needs setup', exercisedBy: 'native:blender', tools: ['run_native'] });
    expect(b.setup).toMatch(/TIMMY_BLENDER/);
  });

  it('run_native starts a Blender job with app blender and returns at once', async () => {
    const m = new JobManager({ dir: path.join(tmp, 'jobs') });
    managers.push(m);
    const bin = install('fake-blender.mjs', path.join(tmp, 'bin', 'blender'));
    const [run] = createNativeTools({
      root: () => root, project: () => 'demo', start: (s) => m.start(s),
      find: { blender: () => ({ app: 'blender', path: bin, how: 'env' }) }, env: { FAKE_BLENDER_MODE: 'ok' },
    });
    const call = (run.function as unknown as { execute: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }).execute;
    expect(await call({ app: 'blender' })).toMatchObject({ ok: false });
    const answer = await call({ app: 'blender', script: 'scene.py', args: ['--seed', '7'] });
    expect(answer).toMatchObject({ ok: true, app: 'blender', result_file: `.timmy/native/${answer.run}/result.json` });
    const job = await m.done(answer.job as string);
    expect(job.args).toEqual(expect.arrayContaining(['--python', path.join(root, '.timmy', 'native', String(answer.run), 'source', 'scene.py'), '--', '--seed', '7']));
  });
});
