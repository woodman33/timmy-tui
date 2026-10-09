/**
 * Native app jobs (R2, helper H3): Cinema 4D through c4dpy and After Effects through aerender, as Timmy
 * jobs. Everything here runs against TEST DOUBLES (tests/fixtures/fake-c4dpy.mjs, fake-aerender.mjs):
 * no Cinema 4D or After Effects runs in this suite, so a green run says the job plumbing and the
 * judgement rules hold, not that either application was driven.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobManager, type JobRecord } from '../src/jobs/index.js';
import {
  aerenderJob, c4dpyJob, findAerender, findC4dpy, judgeNativeJob, judgeNativeRun, locateNative, nativeCapabilityRows, nativeReceiptFields, readNativeResult,
  type NativeJobSpec,
} from '../src/native/index.js';
import { createNativeTools } from '../src/agent/native-tools.js';

const FIXTURES = path.join(__dirname, 'fixtures');
let tmp = '';
let root = '';
let jobsDir = '';
let managers: JobManager[] = [];

beforeEach(() => {
  // resolved: on macOS the temp folder is reached through a link, and the job specs resolve the project folder
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'timmy-native-')));
  root = path.join(tmp, 'project');
  jobsDir = path.join(tmp, 'jobs');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'scene.py'), '# a stand-in: the fake c4dpy does not read it\n');
  managers = [];
});
afterEach(async () => {
  for (const m of managers) await m.stopAll();
  rmSync(tmp, { recursive: true, force: true });
});

/** An executable copy of a fixture at `at` (made executable here, whatever the checkout's modes). */
function install(fixture: string, at: string): string {
  mkdirSync(path.dirname(at), { recursive: true });
  copyFileSync(path.join(FIXTURES, fixture), at);
  chmodSync(at, 0o755);
  return at;
}
function manager(): JobManager {
  const m = new JobManager({ dir: jobsDir });
  managers.push(m);
  return m;
}
async function runSpec(spec: NativeJobSpec): Promise<{ m: JobManager; job: JobRecord }> {
  const m = manager();
  const started = m.start(spec);
  return { m, job: await m.done(started.id) };
}

describe('finding c4dpy and aerender', () => {
  const none = { onPath: () => null };

  it('takes TIMMY_C4DPY first, before the /Applications scan and PATH', () => {
    const apps = path.join(tmp, 'Applications');
    install('fake-c4dpy.mjs', path.join(apps, 'Maxon Cinema 4D 2026', 'c4dpy.app', 'Contents', 'MacOS', 'c4dpy'));
    const own = install('fake-c4dpy.mjs', path.join(tmp, 'tools', 'c4dpy'));
    const found = findC4dpy({ TIMMY_C4DPY: own }, { platform: 'darwin', applications: apps, onPath: () => '/usr/local/bin/c4dpy' });
    expect(found).toMatchObject({ app: 'c4dpy', path: own, how: 'env' });
  });

  it('opens a c4dpy.app bundle named by TIMMY_C4DPY to the executable inside it', () => {
    const bundle = path.join(tmp, 'Maxon Cinema 4D 2026', 'c4dpy.app');
    const inner = install('fake-c4dpy.mjs', path.join(bundle, 'Contents', 'MacOS', 'c4dpy'));
    expect(findC4dpy({ TIMMY_C4DPY: bundle }, { platform: 'darwin', ...none })).toMatchObject({ path: inner, how: 'env' });
  });

  it('does not fall back past a TIMMY_C4DPY that names nothing runnable, and says why', () => {
    const apps = path.join(tmp, 'Applications');
    install('fake-c4dpy.mjs', path.join(apps, 'Maxon Cinema 4D 2026', 'c4dpy.app', 'Contents', 'MacOS', 'c4dpy'));
    const env = { TIMMY_C4DPY: path.join(tmp, 'missing', 'c4dpy') };
    expect(findC4dpy(env, { platform: 'darwin', applications: apps, ...none })).toBeNull();
    expect(locateNative('c4dpy', env, { platform: 'darwin', applications: apps, ...none }).problem).toMatch(/TIMMY_C4DPY/);
  });

  it('on macOS scans /Applications newest version first, the version from the folder name', () => {
    const apps = path.join(tmp, 'Applications');
    install('fake-c4dpy.mjs', path.join(apps, 'Maxon Cinema 4D 2025', 'c4dpy.app', 'Contents', 'MacOS', 'c4dpy'));
    const newest = install('fake-c4dpy.mjs', path.join(apps, 'Maxon Cinema 4D 2026', 'c4dpy.app', 'Contents', 'MacOS', 'c4dpy'));
    mkdirSync(path.join(apps, 'Maxon Cinema 4D 2027'), { recursive: true }); // a folder without c4dpy is passed over
    const found = findC4dpy({}, { platform: 'darwin', applications: apps, onPath: () => '/usr/local/bin/c4dpy' });
    expect(found).toMatchObject({ path: newest, version: '2026', how: 'applications' });

    install('fake-aerender.mjs', path.join(apps, 'Adobe After Effects 2025', 'aerender'));
    const ae = install('fake-aerender.mjs', path.join(apps, 'Adobe After Effects 2026', 'aerender'));
    expect(findAerender({}, { platform: 'darwin', applications: apps, ...none })).toMatchObject({ app: 'aerender', path: ae, version: '2026', how: 'applications' });
  });

  it('skips the /Applications scan off macOS and looks on PATH last', () => {
    const apps = path.join(tmp, 'Applications');
    install('fake-c4dpy.mjs', path.join(apps, 'Maxon Cinema 4D 2026', 'c4dpy.app', 'Contents', 'MacOS', 'c4dpy'));
    const onPath = (program: string) => (program === 'c4dpy' ? '/opt/maxon/c4dpy' : null);
    expect(findC4dpy({}, { platform: 'linux', applications: apps, onPath })).toMatchObject({ path: '/opt/maxon/c4dpy', how: 'path' });
    expect(findAerender({}, { platform: 'linux', applications: apps, onPath })).toBeNull();
  });
});

describe('c4dpy jobs: the result file decides, the exit is recorded beside it', () => {
  function spec(mode: string, extra: Partial<Parameters<typeof c4dpyJob>[0]> = {}): NativeJobSpec {
    const bin = install('fake-c4dpy.mjs', path.join(tmp, 'bin', 'c4dpy'));
    return c4dpyJob({ script: 'scene.py', args: ['--frames', '1'], root, project: 'demo', timeoutMs: 20_000, bin, env: { FAKE_C4DPY_MODE: mode }, expect: ['out/scene.c4d', 'out/still.png'], ...extra });
  }

  it('builds a task job: c4dpy <script.py> [args], with the result path, the run token and the root in its environment', () => {
    const s = spec('ok-exit-1');
    expect(s.kind).toBe('task');
    expect(s.command).toBe(path.join(tmp, 'bin', 'c4dpy'));
    expect(s.args).toEqual([path.join(root, 'scene.py'), '--frames', '1']);
    expect(s.root).toBe(root);
    expect(s.label).toMatch(/Cinema 4D/);
    // R3 (finding 5a): each run writes its own result file, never a shared one
    expect(s.env?.TIMMY_RESULT).toBe(path.join(root, '.timmy', 'native', String(s.env?.TIMMY_RUN), 'result.json'));
    expect(s.env?.TIMMY_ROOT).toBe(root);
    expect(s.env?.TIMMY_RUN).toMatch(/^[0-9a-f-]{16,}$/);
    expect(s.env?.TIMMY_SCRIPT).toBe(path.join(root, 'scene.py'));
    expect(s.env?.TIMMY_SCRIPT_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(path.join(String(s.env?.TIMMY_C4D_LIB), 'timmy_c4d.py'))).toBe(true);
    expect(s.native).toMatchObject({ app: 'c4dpy', result: s.env?.TIMMY_RESULT, run: s.env?.TIMMY_RUN, input: { path: 'scene.py', sha256: s.env?.TIMMY_SCRIPT_SHA256 } });
  });

  it('a script outside the project folder is refused', () => {
    expect(() => spec('ok-exit-1', { script: '../elsewhere.py' })).toThrow(/outside the project/);
  });

  it('says ok when the result file says ok and its files are there, though c4dpy exited 1', async () => {
    const s = spec('ok-exit-1');
    const { m, job } = await runSpec(s);
    expect(job.state).toBe('failed');
    expect(job.exitCode).toBe(1);
    expect(m.tail(job.id).join('\n')).toMatch(/fake-c4dpy: scene\.py --frames 1/);
    expect(existsSync(path.join(root, 'out', 'scene.c4d'))).toBe(true);
    const verdict = judgeNativeJob(job, s);
    expect(verdict.outcome).toBe('ok');
    expect(verdict.why).toMatch(/exit(ed)? (code )?1/);
    expect(verdict.exit).toMatchObject({ code: 1, state: 'failed' });
    expect(verdict.files.map((f) => [f.path, f.present, f.matches])).toEqual([['out/scene.c4d', true, true], ['out/still.png', true, true]]);
    expect(verdict.c4dVersion).toBe(2026000);
    const sealed = nativeReceiptFields('c4dpy', verdict);
    expect(sealed.status).toBe('ok');
    expect(sealed.native).toMatchObject({ app: 'c4dpy', outcome: 'ok', exit_code: 1, c4d_version: 2026000 });
    expect(JSON.stringify(sealed)).not.toContain(root);
  });

  it('finds c4dpy through this process\'s environment when the job is given extra variables', () => {
    const bin = install('fake-c4dpy.mjs', path.join(tmp, 'tools', 'c4dpy'));
    const before = process.env.TIMMY_C4DPY;
    process.env.TIMMY_C4DPY = bin;
    try {
      const s = c4dpyJob({ script: 'scene.py', root, project: 'demo', env: { FAKE_C4DPY_MODE: 'no-result' } });
      expect(s.command).toBe(bin);
    } finally {
      if (before === undefined) delete process.env.TIMMY_C4DPY;
      else process.env.TIMMY_C4DPY = before;
    }
  });

  it('says unknown when c4dpy exits 0 without writing a result file', async () => {
    const s = spec('no-result');
    const { job } = await runSpec(s);
    expect(job.state).toBe('completed');
    const verdict = judgeNativeJob(job, s);
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.why).toMatch(/no result file/);
    expect(nativeReceiptFields('c4dpy', verdict).status).toBeUndefined();
  });

  it('says failed when the result file says ok:false, with the script\'s error', async () => {
    const s = spec('fail');
    const { job } = await runSpec(s);
    const verdict = judgeNativeJob(job, s);
    expect(verdict.outcome).toBe('failed');
    expect(verdict.why).toMatch(/RenderDocument returned 1/);
  });

  it('says failed when the result says ok but a file it names is not there', async () => {
    const s = spec('lie');
    const { job } = await runSpec(s);
    expect(job.state).toBe('completed');
    const verdict = judgeNativeJob(job, s);
    expect(verdict.outcome).toBe('failed');
    expect(verdict.why).toMatch(/out\/scene\.c4d/);
  });

  it('says unknown when the result file belongs to another run', async () => {
    const s = spec('stale');
    const { job } = await runSpec(s);
    const verdict = judgeNativeJob(job, s);
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.why).toMatch(/another run/);
  });

  it('a time limit stops the job; with no result file it failed', async () => {
    const s = spec('hang', { timeoutMs: 400 });
    const { job } = await runSpec(s);
    expect(job.state).toBe('failed');
    expect(job.error).toBe('timed out');
    const verdict = judgeNativeJob(job, s);
    expect(verdict.outcome).toBe('failed');
    expect(verdict.why).toMatch(/timed out/);
  });

  it('a job still going is judged unknown, never ok', () => {
    const running = { state: 'running', exitCode: undefined, signal: undefined, startedAt: new Date().toISOString() } as unknown as JobRecord;
    expect(judgeNativeRun(running, { ok: true, files: {} }, { root }).outcome).toBe('unknown');
  });

  it('reads a result file as missing, unreadable or read', () => {
    const at = path.join(root, 'out', 'r.json');
    expect(readNativeResult(at)).toEqual({ state: 'missing' });
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, '{ not json');
    expect(readNativeResult(at).state).toBe('unreadable');
    writeFileSync(at, '{"ok":true}');
    expect(readNativeResult(at)).toEqual({ state: 'read', data: { ok: true } });
  });
});

describe('aerender jobs: an existing project rendered headless', () => {
  function spec(mode: string, extra: Partial<Parameters<typeof aerenderJob>[0]> = {}): NativeJobSpec {
    const bin = install('fake-aerender.mjs', path.join(tmp, 'bin', 'aerender'));
    writeFileSync(path.join(root, 'title.aep'), 'fake project bytes');
    return aerenderJob({ projectFile: 'title.aep', comp: 'Main Comp', output: 'out/title.mov', root, project: 'demo', timeoutMs: 20_000, bin, env: { FAKE_AERENDER_MODE: mode }, ...extra });
  }

  it('builds aerender -project <file> -comp "<name>" -output <file>, with templates when given', () => {
    const s = spec('ok', { rsTemplate: 'Best Settings', omTemplate: 'Lossless' });
    expect(s.kind).toBe('task');
    expect(s.args).toEqual(['-project', path.join(root, 'title.aep'), '-comp', 'Main Comp', '-output', path.join(root, 'out', 'title.mov'), '-RStemplate', 'Best Settings', '-OMtemplate', 'Lossless']);
    expect(s.native).toMatchObject({ app: 'aerender', output: path.join(root, 'out', 'title.mov') });
    expect(s.native.result).toBeUndefined();
  });

  it('refuses a project file that is not .aep or .aepx', () => {
    writeFileSync(path.join(root, 'notes.txt'), 'x');
    expect(() => spec('ok', { projectFile: 'notes.txt' })).toThrow(/\.aep/);
  });

  it('says ok when the output was written during the run', async () => {
    const s = spec('ok');
    const { job } = await runSpec(s);
    expect(job.state).toBe('completed');
    const verdict = judgeNativeJob(job, s);
    expect(verdict.outcome).toBe('ok');
    expect(verdict.files[0]).toMatchObject({ path: 'out/title.mov', present: true });
  });

  it('says unknown when aerender exits 0 and the output is not there', async () => {
    const s = spec('no-output');
    const { job } = await runSpec(s);
    expect(judgeNativeJob(job, s).outcome).toBe('unknown');
  });

  it('says failed when aerender exits 1 and wrote no output', async () => {
    const s = spec('error');
    const { job } = await runSpec(s);
    expect(job.exitCode).toBe(1);
    const verdict = judgeNativeJob(job, s);
    expect(verdict.outcome).toBe('failed');
  });
});

describe('the /tools rows', () => {
  it('says installed, where and how it was found, when it is here; never reachable without a run', () => {
    const apps = path.join(tmp, 'Applications');
    install('fake-c4dpy.mjs', path.join(apps, 'Maxon Cinema 4D 2026', 'c4dpy.app', 'Contents', 'MacOS', 'c4dpy'));
    install('fake-aerender.mjs', path.join(apps, 'Adobe After Effects 2026', 'aerender'));
    const rows = nativeCapabilityRows({}, { platform: 'darwin', applications: apps, onPath: () => null });
    expect(rows.map((r) => [r.id, r.kind, r.name, r.rung])).toEqual([
      ['c4dpy', 'adapter', 'Cinema 4D (c4dpy)', 'installed'],
      ['aerender', 'adapter', 'After Effects (aerender)', 'installed'],
    ]);
    expect(rows[0].detail).toMatch(/Maxon Cinema 4D 2026/);
    expect(rows[0].detail).toMatch(/not run/);
    expect(rows[1].detail).toMatch(/existing/);
    for (const r of rows) expect(r.tools).toEqual(['run_native']);
  });

  it('says needs setup, with the step, when it is not found', () => {
    const rows = nativeCapabilityRows({}, { platform: 'darwin', applications: path.join(tmp, 'none'), onPath: () => null });
    expect(rows.map((r) => r.rung)).toEqual(['needs setup', 'needs setup']);
    expect(rows[0].setup).toMatch(/TIMMY_C4DPY/);
    expect(rows[1].setup).toMatch(/TIMMY_AERENDER/);
    const broken = nativeCapabilityRows({ TIMMY_AERENDER: path.join(tmp, 'gone') }, { platform: 'darwin', applications: path.join(tmp, 'none'), onPath: () => null });
    expect(broken[1].detail).toMatch(/TIMMY_AERENDER/);
  });
});

describe('the run_native agent tool', () => {
  type Exec = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  function tools(m: JobManager, found: { c4dpy?: string | null; aerender?: string | null }) {
    const started: Array<{ job: JobRecord; spec: NativeJobSpec }> = [];
    const list = createNativeTools({
      root: () => root, project: () => 'demo', start: (spec) => m.start(spec),
      find: {
        c4dpy: () => (found.c4dpy ? { app: 'c4dpy', path: found.c4dpy, how: 'env' } : null),
        aerender: () => (found.aerender ? { app: 'aerender', path: found.aerender, how: 'env' } : null),
      },
      onStarted: (job, spec) => void started.push({ job, spec }),
      env: { FAKE_C4DPY_MODE: 'hang' },
    });
    const call = (args: Record<string, unknown>) => (list.find((t) => t.function.name === 'run_native')!.function as unknown as { execute: Exec }).execute(args);
    return { call, started };
  }

  it('starts a c4dpy job and returns its id at once, while the job keeps running', async () => {
    const m = manager();
    const bin = install('fake-c4dpy.mjs', path.join(tmp, 'bin', 'c4dpy'));
    const { call, started } = tools(m, { c4dpy: bin });
    const t0 = performance.now();
    const answer = await call({ app: 'c4dpy', script: 'scene.py', timeout_minutes: 1 });
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(answer).toMatchObject({ ok: true, app: 'c4dpy' });
    expect(answer.result_file).toBe(`.timmy/native/${answer.run}/result.json`);
    const id = answer.job as string;
    expect(id).toMatch(/^j[0-9a-f]{6}$/);
    expect(['queued', 'running']).toContain(m.get(id)?.state);
    expect(started).toHaveLength(1);
    expect(started[0].spec.native.app).toBe('c4dpy');
    // the run's folder knows its job, so a restart can find the job's record
    expect(JSON.parse(readFileSync(path.join(root, '.timmy', 'native', String(answer.run), 'started.json'), 'utf8'))).toMatchObject({ job: id });
    const stopped = await m.stop(id, 200);
    expect(stopped?.state).toBe('cancelled');
  });

  it('starts nothing and names the step when the app is not found', async () => {
    const m = manager();
    const { call, started } = tools(m, {});
    const answer = await call({ app: 'aerender', project_file: 'title.aep', comp: 'Main', output: 'out/a.mov' });
    expect(answer).toMatchObject({ ok: false });
    expect(String(answer.error)).toMatch(/not found/);
    expect(String(answer.setup)).toMatch(/TIMMY_AERENDER/);
    expect(started).toHaveLength(0);
    expect(m.list()).toHaveLength(0);
  });

  it('refuses a script outside the project and a call missing what its app needs', async () => {
    const m = manager();
    const bin = install('fake-c4dpy.mjs', path.join(tmp, 'bin', 'c4dpy'));
    const { call } = tools(m, { c4dpy: bin, aerender: bin });
    expect(await call({ app: 'c4dpy', script: '../x.py' })).toMatchObject({ ok: false });
    expect(await call({ app: 'c4dpy' })).toMatchObject({ ok: false });
    expect(await call({ app: 'aerender', project_file: 'title.aep' })).toMatchObject({ ok: false });
    expect(m.list()).toHaveLength(0);
    expect(readFileSync(path.join(root, 'scene.py'), 'utf8')).toMatch(/stand-in/);
  });
});

// Round R2 (the Mac run): a sandboxed c4dpy (no license in its HOME) asked "Enter the license method" and
// waited for a person; the job stops on that line, and TIMMY_NATIVE_HOME gives native apps their real home.
describe('native jobs on a sandboxed Timmy', () => {
  it('stop when Cinema 4D asks how to license it, and take HOME from TIMMY_NATIVE_HOME', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'c4d-home-'));
    writeFileSync(join(root, 'scene.py'), '# a scene\n');
    const spec = c4dpyJob({ script: 'scene.py', root, project: 'p', bin: process.execPath, env: { TIMMY_NATIVE_HOME: join(root, 'native-home') } });
    expect(spec.stopWhen?.pattern.test('Enter the license method:')).toBe(true);
    expect(spec.stopWhen?.error).toMatch(/license/);
    expect(spec.env?.HOME).toBe(join(root, 'native-home'));
    const plain = c4dpyJob({ script: 'scene.py', root, project: 'p', bin: process.execPath, env: {} });
    expect(plain.env?.HOME).toBeUndefined();
  });
});
