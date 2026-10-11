/**
 * Unreal Engine as a judged native app (round R4, helper H63): UnrealEditor-Cmd's pythonscript commandlet runs Timmy's
 * harness (workers/unreal/timmy_unreal.py), which runs the project's script and writes the result file; a second,
 * separate Unreal process reads each saved level back (workers/unreal/unreal_readback.py) and Timmy compares the two.
 *
 * Everything here runs against TEST DOUBLES: tests/fixtures/fake-unreal.mjs stands in for UnrealEditor-Cmd (it checks the
 * command line Timmy passes, then runs the -script file with python3), and tests/fixtures/unreal-stub is a stand-in for
 * Unreal's `unreal` module (its level files are JSON). The harness, the readback worker, the starter
 * (templates/unreal-starter) and Timmy's judgement are the real ones, in real child processes with real files. A pass says
 * they hold together with each other and with the names the stand-in defines from Epic's documented API, not that Unreal
 * accepts the calls: no Unreal Engine runs here.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobManager, type JobRecord } from '../src/jobs/index.js';
import { EPIC_SHARED_ENGINES, locateNative, NATIVE_APPS, nativeCapabilityRows, nativeExercisedAt, nativeRunIndex, readNativeRecord } from '../src/native/index.js';
import {
  findUnreal, isUnrealJobSpec, judgeUnrealJob, parseUnrealWords, reconcileUnreal, UNREAL_DDC_GRAPH, UNREAL_FLAGS, unrealEndLines, unrealJob, unrealReceiptFields,
  unrealStartLines, unrealWorkers, type UnrealJobInput, type UnrealJobSpec,
} from '../src/native/unreal.js';
import {
  compareUnrealActors, judgeUnrealReadback, planUnrealReadback, readUnrealReadbackFile, readUnrealReadbacks, unrealReadbackJob, unrealRunOutcome,
  type UnrealReadbackPlan,
} from '../src/native/unreal-readback.js';
import { shownFolder, UNREAL_ACCOUNT_HOME_ENV, UNREAL_MAC_USER_FOLDERS } from '../src/native/unreal-outside.js';
import { createNativeTools } from '../src/agent/native-tools.js';
import { approvalNeeded } from '../src/repl/approvals.js';
import { startsWork } from '../src/ops/act.js';
import { runOutcome } from '../src/ops/outcome.js';
import { copyStarter, listStarters } from '../src/project/starters.js';

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const STUB = path.join(FIXTURES, 'unreal-stub');
const STARTER = path.join(REPO, 'templates', 'unreal-starter');
const WORKERS = path.join(REPO, 'workers', 'unreal');
const which = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
const python = which.status === 0 ? which.stdout.trim() : '';

let tmp = '';
let root = '';
let fake = '';
let managers: JobManager[] = [];

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
function install(at: string): string {
  mkdirSync(path.dirname(at), { recursive: true });
  copyFileSync(path.join(FIXTURES, 'fake-unreal.mjs'), at);
  chmodSync(at, 0o755);
  return at;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'timmy-unreal-')));
  root = path.join(tmp, 'project');
  mkdirSync(root, { recursive: true });
  for (const f of readdirSync(STARTER)) copyFileSync(path.join(STARTER, f), path.join(root, f));
  fake = install(path.join(tmp, 'bin', 'UnrealEditor-Cmd'));
  managers = [];
});
afterEach(async () => {
  for (const m of managers) await m.stopAll();
  rmSync(tmp, { recursive: true, force: true });
});

/** A folder standing in for the account's home in these tests (never a real home): its Unreal folders, as macOS keeps them. */
const account = (): string => path.join(tmp, 'account');
const accountEpic = (): string => path.join(account(), 'Library', 'Application Support', 'Epic');
const accountLogs = (): string => path.join(account(), 'Library', 'Logs', 'Unreal Engine');
/**
 * The job's environment for the FAKE: the stand-in `unreal` module and python3; no native home unless a test gives one;
 * and the outside check's seam (TIMMY_UNREAL_ACCOUNT_HOME) naming the stand-in account's home, whose Unreal folders are
 * watched and named "~/…", so no test walks a real home on any platform.
 */
const fakeEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PYTHONPATH: STUB, FAKE_UNREAL_PYTHON: python, PYTHONDONTWRITEBYTECODE: '1', TIMMY_NATIVE_HOME: '', [UNREAL_ACCOUNT_HOME_ENV]: account(), ...extra,
});
/** A watched folder or file as the verdict names it: relative to the stand-in account's home. */
const shown = (abs: string): string => shownFolder(abs, account());
function spec(extra: Partial<UnrealJobInput> = {}, env: NodeJS.ProcessEnv = {}): UnrealJobSpec {
  return unrealJob({ projectFile: 'TimmyStarter.uproject', script: 'scene.py', root, project: 'demo', timeoutMs: 60_000, bin: fake, env: fakeEnv(env), ...extra });
}
async function run(s: { kind: string } & Parameters<JobManager['start']>[0]): Promise<{ job: JobRecord; m: JobManager }> {
  const m = new JobManager({ dir: path.join(tmp, 'jobs') });
  managers.push(m);
  return { m, job: await m.done(m.start(s).id) };
}
/** A first pass, run and judged: what the REPL does when its job ends. */
async function firstPass(extra: Partial<UnrealJobInput> = {}, env: NodeJS.ProcessEnv = {}) {
  const s = spec(extra, env);
  const { job, m } = await run(s);
  return { s, job, j: judgeUnrealJob(job, s), log: m.tail(job.id, 60).join('\n') };
}
/** The second pass for a run judged ok: planned, run with the FAKE, judged. */
async function readback(env: NodeJS.ProcessEnv = {}, o: { run?: string } = {}) {
  const p = planUnrealReadback(root, o);
  if (!p.ok) throw new Error(p.error);
  const made = unrealReadbackJob(p.plan, { bin: fake, worker: path.join(WORKERS, 'unreal_readback.py'), lib: WORKERS, project: 'demo', env: fakeEnv(env), timeoutMs: 60_000 });
  const { job } = await run(made.spec);
  return { plan: p.plan, made, job, line: judgeUnrealReadback(p.plan, job, made.token, made.result, { env: made.spec.env }) };
}

describe('finding UnrealEditor-Cmd', () => {
  const none = { onPath: () => null };
  it('takes TIMMY_UNREAL first; an UnrealEditor.app named there is taken as the UnrealEditor-Cmd beside it; a TIMMY_UNREAL naming nothing stops the search', () => {
    expect(findUnreal({ TIMMY_UNREAL: fake }, { platform: 'darwin', ...none })).toMatchObject({ app: 'unreal', path: fake, how: 'env' });
    const mac = path.join(tmp, 'UE', 'Engine', 'Binaries', 'Mac');
    const beside = install(path.join(mac, 'UnrealEditor-Cmd'));
    mkdirSync(path.join(mac, 'UnrealEditor.app', 'Contents', 'MacOS'), { recursive: true });
    expect(findUnreal({ TIMMY_UNREAL: path.join(mac, 'UnrealEditor.app') }, { platform: 'darwin', ...none })).toMatchObject({ path: beside, how: 'env' });
    const shared = path.join(tmp, 'Epic Games');
    install(path.join(shared, 'UE_5.8', 'Engine', 'Binaries', 'Mac', 'UnrealEditor-Cmd'));
    const r = locateNative('unreal', { TIMMY_UNREAL: path.join(tmp, 'gone') }, { platform: 'darwin', shared, ...none });
    expect(r.found).toBeNull();
    expect(r.problem).toMatch(/TIMMY_UNREAL is set, but nothing runnable is there/);
  });

  it('by default looks in Epic\'s shared engines folder: "Epic Games" in the Mac\'s Shared folder', () => {
    // (written in parts, as the code writes it: the privacy gate's home-path pattern matches every name in the Users folder)
    expect(EPIC_SHARED_ENGINES.split('/')).toEqual(['', 'Users', 'Shared', 'Epic Games']);
    expect(NATIVE_APPS.unreal.shared).toEqual({ folder: EPIC_SHARED_ENGINES, prefix: 'UE_', inside: ['Engine/Binaries/Mac/UnrealEditor-Cmd'] });
  });

  it('on macOS scans the shared engines folder newest version first, passing over a version folder with no engine in it (UE_5.7)', () => {
    const shared = path.join(tmp, 'Epic Games');
    mkdirSync(path.join(shared, 'UE_5.7'), { recursive: true });
    const v58 = install(path.join(shared, 'UE_5.8', 'Engine', 'Binaries', 'Mac', 'UnrealEditor-Cmd'));
    mkdirSync(path.join(shared, 'Launcher'), { recursive: true });
    expect(findUnreal({}, { platform: 'darwin', shared, ...none })).toEqual({ app: 'unreal', path: v58, how: 'applications', folder: 'UE_5.8', version: '5.8', base: shared });
    // 5.10 is newer than 5.8 (numbers, not text)
    const v510 = install(path.join(shared, 'UE_5.10', 'Engine', 'Binaries', 'Mac', 'UnrealEditor-Cmd'));
    expect(findUnreal({}, { platform: 'darwin', shared, ...none })).toMatchObject({ path: v510, version: '5.10' });
    // off macOS the shared folder is not scanned: PATH only
    expect(findUnreal({}, { platform: 'linux', shared, ...none })).toBeNull();
    expect(findUnreal({}, { platform: 'linux', onPath: (p) => (p === 'UnrealEditor-Cmd' ? '/opt/ue/UnrealEditor-Cmd' : null) })).toMatchObject({ path: '/opt/ue/UnrealEditor-Cmd', how: 'path' });
  });
});

describe('the /tools row: installed only when the program is found; exercised only by a sealed, judged-ok Unreal run', () => {
  it('needs setup when nothing is found, saying where it looked', () => {
    const shared = path.join(tmp, 'Epic Games');
    mkdirSync(path.join(shared, 'UE_5.7'), { recursive: true });
    const row = nativeCapabilityRows({}, { platform: 'darwin', shared, applications: path.join(tmp, 'Applications'), onPath: () => null }).find((r) => r.id === 'unreal')!;
    expect(row).toMatchObject({ kind: 'adapter', name: 'Unreal Engine (UnrealEditor-Cmd, Python, headless)', rung: 'needs setup', exercisedBy: 'native:unreal', tools: ['run_native'] });
    expect(row.detail).toBe(`not found: TIMMY_UNREAL is not set, no UE_<version> folder in ${shared} holds UnrealEditor-Cmd, no UnrealEditor-Cmd on PATH; implemented; not run`);
    expect(row.setup).toMatch(/TIMMY_UNREAL/);
  });

  it('installed when found, by the shared engines folder scan, with its version by folder name; "implemented; not run" until a sealed run', () => {
    const shared = path.join(tmp, 'Epic Games');
    install(path.join(shared, 'UE_5.8', 'Engine', 'Binaries', 'Mac', 'UnrealEditor-Cmd'));
    const row = nativeCapabilityRows({}, { platform: 'darwin', shared, onPath: () => null }).find((r) => r.id === 'unreal')!;
    expect(row.rung).toBe('installed');
    expect(row.detail).toBe(`UnrealEditor-Cmd in ${path.join(shared, 'UE_5.8')} (version 5.8 by its folder name), by the shared engines folder scan; implemented; not run; runs a Python script inside the Unreal Editor, headless (/unreal <project.uproject> <script.py>); a second Unreal process reads each saved level back`);
    expect('exercised' in row).toBe(false);
  });

  it('a sealed native receipt of Unreal judged ok marks it; a readback receipt, another app or the shared tool name never does', () => {
    const chain = [
      { kind: 'native', ts: '2026-10-10T01:00:00.000Z', status: 'ok', hash: 'sha256_aaaaaaaa1', native: { app: 'blender', outcome: 'ok', why: '' } },
      { kind: 'readback', ts: '2026-10-10T02:00:00.000Z', status: 'ok', hash: 'sha256_bbbbbbbb2' },
      { kind: 'turn', ts: '2026-10-10T03:00:00.000Z', status: 'ok', tools: ['run_native'] },
      { kind: 'native', ts: '2026-10-10T04:00:00.000Z', status: 'failed', hash: 'sha256_cccccccc3', native: { app: 'unreal', outcome: 'failed', why: 'no result file' } },
    ];
    expect(nativeExercisedAt('native:unreal', nativeRunIndex(chain))).toBeUndefined();
    chain.push({ kind: 'native', ts: '2026-10-10T05:00:00.000Z', status: 'ok', hash: 'sha256_dddddddd4', native: { app: 'unreal', outcome: 'ok', why: 'x' } });
    expect(nativeExercisedAt('native:unreal', nativeRunIndex(chain))).toBe('2026-10-10T05:00:00.000Z');
  });
});

describe('the Unreal job: its command line, its record, its refusals', () => {
  it('runs UnrealEditor-Cmd <project> -run=pythonscript -script=<harness> and the flags, the copy and the binding in its environment', () => {
    const s = spec({ args: ['--cubes', '4'] });
    expect(isUnrealJobSpec(s)).toBe(true);
    const harness = path.join(WORKERS, 'timmy_unreal.py');
    const log = `Saved/Logs/Timmy-${s.native.run.slice(0, 8)}.log`;
    expect(s.args).toEqual([
      path.join(root, 'TimmyStarter.uproject'), '-run=pythonscript', `-script=${harness}`, '-unattended', '-nullrhi', '-nosplash', '-nopause', '-stdout', '-FullStdOutLogOutput',
      '-DDC=InstalledNoZenLocalFallback', `-LocalDataCachePath=${path.join(root, 'Saved', 'DerivedDataCache')}`, `-abslog=${path.join(root, ...log.split('/'))}`,
    ]);
    expect([...UNREAL_FLAGS]).toEqual(s.args.slice(3, 3 + UNREAL_FLAGS.length));
    const copy = path.join(root, '.timmy', 'native', s.native.run, 'source', 'scene.py');
    expect(statSync(copy).mode & 0o777).toBe(0o444);
    expect(s.env).toMatchObject({
      TIMMY_RESULT: path.join(root, '.timmy', 'native', s.native.run, 'result.json'), TIMMY_RUN: s.native.run, TIMMY_ROOT: root, TIMMY_SCRIPT: copy,
      TIMMY_SCRIPT_SHA256: sha(path.join(root, 'scene.py')), TIMMY_SCRIPT_DIR: root, TIMMY_SCRIPT_ARGS: '["--cubes","4"]',
      TIMMY_UNREAL_PROJECT: path.join(root, 'TimmyStarter.uproject'), TIMMY_UNREAL_CONTENT: path.join(root, 'Content'), TIMMY_UNREAL_WATCH: '["Content","out"]', TIMMY_UNREAL_LIB: WORKERS,
    });
    expect(s.native).toMatchObject({ app: 'unreal', input: { path: 'scene.py' }, inventory: { folders: ['Content', 'out'], complete: true } });
    expect(readNativeRecord(root, s.native.run)?.job).toMatchObject({ app: 'unreal', run: s.native.run, input: { path: 'scene.py' }, program: fake });
    const u = JSON.parse(readFileSync(path.join(root, '.timmy', 'native', s.native.run, 'unreal.json'), 'utf8'));
    expect(u).toEqual({
      record: 'timmy-unreal-run', v: 1, run: s.native.run, project: { path: 'TimmyStarter.uproject', sha256: sha(path.join(root, 'TimmyStarter.uproject')) }, content: 'Content',
      watch: ['Content', 'out'], harness: { file: 'timmy_unreal.py', sha256: sha(harness) }, args: ['--cubes', '4'], flags: [...UNREAL_FLAGS],
      place: { cache: 'Saved/DerivedDataCache', log, ddc: UNREAL_DDC_GRAPH, native_home: false },
    });
    // R4 (H72): with no native home Timmy sets neither HOME nor CFFIXED_USER_HOME, and makes the cache's and the log's folders
    expect(s.env?.HOME).toBeUndefined();
    expect(s.env?.CFFIXED_USER_HOME).toBeUndefined();
    expect(statSync(path.join(root, 'Saved', 'DerivedDataCache')).isDirectory()).toBe(true);
    expect(statSync(path.join(root, 'Saved', 'Logs')).isDirectory()).toBe(true);
  });

  it('a project in a folder has its Content beside it', () => {
    mkdirSync(path.join(root, 'game'));
    copyFileSync(path.join(root, 'TimmyStarter.uproject'), path.join(root, 'game', 'Game.uproject'));
    const s = spec({ projectFile: 'game/Game.uproject' });
    expect(s.unreal).toMatchObject({ content: 'game/Content', watch: ['game/Content', 'out'] });
    expect(s.env?.TIMMY_UNREAL_CONTENT).toBe(path.join(root, 'game', 'Content'));
  });

  it('refuses another file than a .uproject, a missing one, a script outside the project or not .py; nothing is recorded for them', () => {
    expect(() => spec({ projectFile: 'scene.py' })).toThrow(/not an Unreal project file/);
    expect(() => spec({ projectFile: 'Missing.uproject' })).toThrow(/no project file at Missing\.uproject/);
    expect(() => spec({ script: '../elsewhere.py' })).toThrow(/outside the project/);
    expect(() => spec({ script: 'scene.params.json' })).toThrow(/\.py/);
    expect(existsSync(path.join(root, '.timmy', 'native'))).toBe(false);
  });

  it('refuses a harness folder whose path has a space (Unreal reads the first word of -script=): nothing starts, nothing is recorded', () => {
    const spaced = path.join(tmp, 'with space', 'unreal');
    cpSync(WORKERS, spaced, { recursive: true });
    expect(unrealWorkers({ TIMMY_UNREAL_LIB: spaced })).toMatchObject({ ok: false, why: expect.stringContaining('has a space or a quote in it') });
    expect(() => unrealJob({ projectFile: 'TimmyStarter.uproject', script: 'scene.py', root, project: 'demo', bin: fake, env: { TIMMY_UNREAL_LIB: spaced } })).toThrow(/nothing started.*TIMMY_UNREAL_LIB/);
    const missing = path.join(tmp, 'nolib');
    mkdirSync(missing);
    expect(unrealWorkers({ TIMMY_UNREAL_LIB: missing })).toMatchObject({ ok: false, why: 'timmy_unreal.py is not in the folder TIMMY_UNREAL_LIB names' });
    expect(existsSync(path.join(root, '.timmy', 'native'))).toBe(false);
  });

  it('/unreal words: a .uproject, then a .py, then the script\'s arguments', () => {
    expect(parseUnrealWords(['TimmyStarter.uproject', 'scene.py', '--n', '4'])).toEqual({ projectFile: 'TimmyStarter.uproject', script: 'scene.py', args: ['--n', '4'] });
    expect(parseUnrealWords(['scene.py'])).toMatchObject({ error: expect.stringContaining('Name the project file (.uproject) first') });
    expect(parseUnrealWords(['TimmyStarter.uproject'])).toMatchObject({ error: expect.stringContaining('/unreal TimmyStarter.uproject <script.py>') });
    expect([startsWork('/unreal'), startsWork('/unreal TimmyStarter.uproject scene.py'), startsWork('/unreal readback')]).toEqual([false, true, true]);
  });
});

describe('judging a first pass: the harness\'s result file decides, bound to the run, the script and the harness', () => {
  it('a FAKE Unreal that runs nothing: no result file, so unknown when it exited 0 and failed when it exited 3; never ok', async () => {
    const quiet = await firstPass({}, { FAKE_UNREAL_MODE: 'no-result' });
    expect(quiet.j.outcome).toBe('unknown');
    expect(quiet.j.why).toMatch(/exited 0 but wrote no result file/);
    expect(quiet.j.why).toMatch(/Unreal did not run the harness/);
    const crashed = await firstPass({}, { FAKE_UNREAL_MODE: 'exit3' });
    expect(crashed.j.outcome).toBe('failed');
    expect(crashed.j.why).toMatch(/no result file, and UnrealEditor-Cmd exited 3/);
  });

  describe.skipIf(!python)('the harness and the starter against the stand-in unreal (python3 in Unreal\'s place)', () => {
    it('builds /Game/Timmy/TimmyGrid with 9 cubes, saves Content/Timmy/TimmyGrid.umap, and is judged ok with Unreal\'s report', async () => {
      const { s, job, j, log } = await firstPass();
      expect(job.state, log).toBe('completed');
      expect(j.outcome, j.why).toBe('ok');
      expect(j.why).toMatch(/the result file is this run's, from scene\.py as submitted/);
      expect(j.files.map((f) => [f.path, f.change, f.matches])).toEqual([['Content/Timmy/TimmyGrid.umap', 'created', true]]);
      const u = j.unreal;
      expect(u).toMatchObject({ version: '5.8.2-0+++UE5+Release-5.8 (stand-in)', script_ran: s.native.copy!.path, project: 'TimmyStarter.uproject', watched: ['Content', 'out'] });
      expect(u.harness).toEqual({ name: 'timmy_unreal', version: '0.2.0', sha256: sha(path.join(WORKERS, 'timmy_unreal.py')) });
      expect(u.inputs).toEqual({ 'scene.params.json': sha(path.join(root, 'scene.params.json')) });
      expect(u.levels).toHaveLength(1);
      const level = u.levels[0];
      expect(level).toMatchObject({ asset: '/Game/Timmy/TimmyGrid', file: 'Content/Timmy/TimmyGrid.umap', sha256: sha(path.join(root, 'Content', 'Timmy', 'TimmyGrid.umap')), actors_total: 9, malformed: 0 });
      expect(level.actors[0]).toEqual({
        name: 'StaticMeshActor_0', label: 'TimmyCube_0_0', class: '/Script/Engine.StaticMeshActor', class_name: 'StaticMeshActor', mesh: '/Engine/BasicShapes/Cube.Cube',
        location: [0, 0, 50], rotation: [0, 0, 0], scale: [1, 1, 1], bounds: { origin: [0, 0, 50], extent: [50, 50, 50], min: [-50, -50, 0], max: [50, 50, 100], size: [100, 100, 100] },
      });
      expect(level.actors[8]).toMatchObject({ label: 'TimmyCube_2_2', location: [300, 300, 50] });
      expect(u.made).toHaveLength(9);
      expect(u.checks?.length).toBe(9);
      expect(u.checks?.every((c) => c.passed)).toBe(true);
      // The receipt: the native fields, Unreal's report, the geometry tags (generated, constructed); no folder of this machine.
      const sealed = unrealReceiptFields(j);
      expect(sealed.status).toBe('ok');
      expect(sealed.native).toMatchObject({ app: 'unreal', outcome: 'ok', run: s.native.run, unreal_version: u.version, unreal: { levels: [{ asset: '/Game/Timmy/TimmyGrid', file: 'Content/Timmy/TimmyGrid.umap', actors: 9 }], actors_made: 9, checks: { passed: 9, of: 9 }, geometry: { provenance: 'generated', evidence: 'constructed' } } });
      expect(JSON.stringify(sealed)).not.toContain(tmp);
      // The verdict is the run's own record, beside its job.json.
      expect(readNativeRecord(root, s.native.run)?.verdicts.at(-1)).toMatchObject({ outcome: 'ok', job: job.id });
    });

    it('a script that raises is ok: false with its error and a traceback with the project folder written as "."', async () => {
      writeFileSync(path.join(root, 'broken.py'), 'def main(run):\n    run.new_level("/Game/Broken")\n    raise ValueError("the grid has no cubes")\n');
      const { j } = await firstPass({ script: 'broken.py' });
      expect(j.outcome).toBe('failed');
      expect(j.why).toMatch(/the script reported ok: false: ValueError: the grid has no cubes/);
      const result = JSON.parse(readFileSync(path.join(root, '.timmy', 'native', j.run!, 'result.json'), 'utf8'));
      expect(result.traceback).toMatch(/ValueError: the grid has no cubes/);
      expect(result.traceback).not.toContain(root);
      // the blank level new_level saved before the error is still named with its sha256: nothing is lost
      expect(Object.keys(result.files)).toEqual(['Content/Broken.umap']);
    });

    it('a level Unreal would not save (FAKE: save_current_level returns False) fails with that said', async () => {
      const { j } = await firstPass({}, { UNREAL_STUB_SAVE_FAIL: '1' });
      expect(j.outcome).toBe('failed');
      expect(j.why).toMatch(/save_current_level returned False for \/Game\/Timmy\/TimmyGrid/);
    });

    it('a harness changed between submission and the run is not the one Timmy started: unknown, whatever the result says', async () => {
      const lib = path.join(tmp, 'lib');
      cpSync(WORKERS, lib, { recursive: true });
      const s = spec({ env: fakeEnv({ TIMMY_UNREAL_LIB: lib }) });
      appendFileSync(path.join(lib, 'timmy_unreal.py'), '\n# changed after the job was submitted\n');
      const { job } = await run(s);
      const j = judgeUnrealJob(job, s);
      expect(j.outcome).toBe('unknown');
      expect(j.why).toMatch(/the harness that ran \(sha256 [0-9a-f]{12}…\) is not the one Timmy started/);
    });

    it('a level file changed after its last save (by the script itself) is unknown: what the first pass reported is not what the file holds', async () => {
      writeFileSync(path.join(root, 'tamper.py'), [
        'import os',
        'def main(run):',
        '    run.new_level("/Game/Tamper")',
        '    run.spawn_mesh(run.load_mesh("/Engine/BasicShapes/Cube.Cube"), (0, 0, 50), label="One")',
        '    saved = run.save_level()',
        '    with open(os.path.join(run.root, saved["file"]), "a") as f:',
        '        f.write(" ")',
        '',
      ].join('\n'));
      const { j } = await firstPass({ script: 'tamper.py' });
      expect(j.outcome).toBe('unknown');
      expect(j.why).toMatch(/Content\/Tamper\.umap changed after \/Game\/Tamper was last saved/);
    });

    it('run again, it opens its level, replaces its own cubes (fresh actor names) and keeps every other actor; judged ok, the file changed', async () => {
      expect((await firstPass()).j.outcome).toBe('ok');
      writeFileSync(path.join(root, 'scene.params.json'), JSON.stringify({ level: '/Game/Timmy/TimmyGrid', count: 4, columns: 2, spacing_cm: 200, size_cm: 50 }));
      const { j } = await firstPass();
      expect(j.outcome, j.why).toBe('ok');
      expect(j.files.map((f) => [f.path, f.change])).toEqual([['Content/Timmy/TimmyGrid.umap', 'changed']]);
      expect(j.unreal.removed).toHaveLength(9);
      expect(j.unreal.levels[0].actors.map((a) => [a.name, a.label, a.bounds.size])).toEqual([
        ['StaticMeshActor_10', 'TimmyCube_0_1', [50, 50, 50]], ['StaticMeshActor_11', 'TimmyCube_1_0', [50, 50, 50]],
        ['StaticMeshActor_12', 'TimmyCube_1_1', [50, 50, 50]], ['StaticMeshActor_9', 'TimmyCube_0_0', [50, 50, 50]],
      ]);
    });

    it('after a restart, a run is judged again from its own folder (reconcileUnreal), with Unreal\'s checks', async () => {
      const s = spec();
      const { job } = await run(s);
      const again = reconcileUnreal(root, s.native.run);
      expect(again.outcome, again.why).toBe('ok');
      expect(again.why).toMatch(/its process is gone, with no exit status \(recorded beside the outcome, not deciding it\)/);
      expect(reconcileUnreal(root, s.native.run, { job }).outcome).toBe('ok');
    });
  });
});

describe.skipIf(!python)('the readback: a second Unreal process opens each saved level; the first pass alone is never trusted', () => {
  it('reads the level back and agrees, actor by actor, within the stated tolerance; the record names both sets of bytes', async () => {
    const first = await firstPass();
    expect(first.j.outcome).toBe('ok');
    const { plan, made, job, line } = await readback();
    expect(plan).toMatchObject({ run: first.s.native.run, project: { path: 'TimmyStarter.uproject', changed: false }, levels: [{ asset: '/Game/Timmy/TimmyGrid', file: 'Content/Timmy/TimmyGrid.umap', actors_total: 9 }] });
    expect(made.spec.args).toEqual([
      path.join(root, 'TimmyStarter.uproject'), '-run=pythonscript', `-script=${path.join(WORKERS, 'unreal_readback.py')}`, ...UNREAL_FLAGS,
      '-DDC=InstalledNoZenLocalFallback', `-LocalDataCachePath=${path.join(root, 'Saved', 'DerivedDataCache')}`,
      `-abslog=${path.join(root, 'Saved', 'Logs', `Timmy-${first.s.native.run.slice(0, 8)}-readback-${made.token.slice(0, 8)}.log`)}`,
    ]);
    expect(made.place).toEqual({ cache: 'Saved/DerivedDataCache', log: `Saved/Logs/Timmy-${first.s.native.run.slice(0, 8)}-readback-${made.token.slice(0, 8)}.log`, ddc: UNREAL_DDC_GRAPH, native_home: false });
    expect(job.state).toBe('completed');
    expect(line).toMatchObject({ app: 'unreal', run: first.s.native.run, token: made.token, verdict: 'agrees', worker: { name: 'unreal_readback', version: '0.1.0' }, unreal_version: '5.8.2-0+++UE5+Release-5.8 (stand-in)' });
    const level = line.levels[0];
    const recorded = sha(path.join(root, 'Content', 'Timmy', 'TimmyGrid.umap'));
    expect(level).toMatchObject({ verdict: 'agrees', loaded: true, actors: { first_pass: 9, readback: 9, compared: 9, agree: 9 }, sha256: { recorded, read_before: recorded, read_after: recorded, timmy_after: recorded } });
    expect(level.checks.every((c) => c.passed && c.in === 'both' && c.max?.location_cm === 0 && c.max?.bounds_cm === 0)).toBe(true);
    // a readback with another token's file is never taken for this one
    expect(readUnrealReadbackFile(made.result, 'another-token', first.s.native.run)).toMatchObject({ ok: false, error: expect.stringContaining('another readback') });
  });

  it('a level that loads otherwise than reported (FAKE: the stand-in moves the first actor 5 cm on load) differs, with the numbers', async () => {
    expect((await firstPass()).j.outcome).toBe('ok');
    const { line } = await readback({ UNREAL_STUB_LOAD_SHIFT_CM: '5' });
    expect(line.verdict).toBe('differs');
    expect(line.reason).toBe('/Game/Timmy/TimmyGrid: TimmyCube_0_0 (StaticMeshActor_0) location (cm) x: first pass 0, readback 5 (difference 5; tolerance 0.001 cm)');
    const bad = line.levels[0].checks.filter((c) => !c.passed);
    expect(bad).toHaveLength(1);
    expect(bad[0].differences.map((d) => d.what)).toEqual(['location (cm) x', 'bounds min (cm) x', 'bounds max (cm) x']);
    expect(line.levels[0].actors).toMatchObject({ compared: 9, agree: 8 });
  });

  it('an actor the first pass reported but the level does not hold (FAKE: dropped on load) differs', async () => {
    expect((await firstPass()).j.outcome).toBe('ok');
    const { line } = await readback({ UNREAL_STUB_LOAD_DROP: '1' });
    expect(line.verdict).toBe('differs');
    expect(line.levels[0].checks.find((c) => !c.passed)).toMatchObject({ name: 'StaticMeshActor_8', in: 'first pass only' });
  });

  it('starts nothing for a level file changed since the run, a run not judged ok, or a run that saved no level', async () => {
    const first = await firstPass();
    appendFileSync(path.join(root, 'Content', 'Timmy', 'TimmyGrid.umap'), ' ');
    expect(planUnrealReadback(root)).toMatchObject({ ok: false, error: expect.stringMatching(/Content\/Timmy\/TimmyGrid\.umap has changed since run [0-9a-f]{8}.*nothing was started/) });
    expect(planUnrealReadback(root, { run: 'zz' })).toMatchObject({ ok: false, error: expect.stringContaining('is not a run token') });
    writeFileSync(path.join(root, 'nolevel.py'), 'def main(run):\n    return {"said": "nothing saved"}\n');
    const none = await firstPass({ script: 'nolevel.py' });
    expect(none.j.outcome).toBe('ok');
    expect(planUnrealReadback(root, { run: none.s.native.run })).toMatchObject({ ok: false, error: expect.stringContaining('saved no level, so there is nothing to read back') });
    // what an operation counts for these runs: never succeeded without an agreeing readback
    const outcome = (r: string) => runOutcome({ kind: 'native', id: r, at: '' }, root, { get: () => undefined });
    expect(outcome(none.s.native.run)).toMatchObject({ state: 'unknown', words: expect.stringContaining('it saved no level, so nothing was read back') });
    expect(outcome(first.s.native.run)).toMatchObject({ state: 'unknown', words: expect.stringContaining('not read back yet') });
  });

  it('an operation counts an Unreal run by its newest readback: agrees succeeded, differs differs; its readback jobs are its own', async () => {
    const first = await firstPass();
    const rec = () => readNativeRecord(root, first.s.native.run)!;
    const agree = await readback();
    const { appendUnrealReadback } = await import('../src/native/unreal-readback.js');
    appendUnrealReadback(rec().dir, agree.line);
    expect(unrealRunOutcome(rec().dir, rec().verdicts.at(-1)!, rec().result, [])).toMatchObject({ state: 'succeeded', claims: [`job:${agree.job.id}`] });
    const differ = await readback({ UNREAL_STUB_LOAD_SHIFT_CM: '5' });
    appendUnrealReadback(rec().dir, differ.line);
    expect(readUnrealReadbacks(rec().dir).map((l) => l.verdict)).toEqual(['agrees', 'differs']);
    expect(runOutcome({ kind: 'native', id: first.s.native.run, at: '' }, root, { get: () => undefined })).toMatchObject({ state: 'differs', claims: [`job:${agree.job.id}`, `job:${differ.job.id}`] });
  });
});

/** A judgement's lines as the REPL prints them (text only). */
const endText = (j: ReturnType<typeof judgeUnrealJob>, s: UnrealJobSpec, id: string): string =>
  unrealEndLines(j, s, { id, label: 'Unreal', glyphs: { ok: '✓', fail: '✖' }, sep: ' · ', scrub: (x) => x }).map((l) => l.map((seg) => seg.text).join('')).join('\n');

describe('R4 (H72): where Unreal writes, what it wrote outside the project, and what a failed run left', () => {
  it('with TIMMY_NATIVE_HOME, the first pass and the readback set HOME and CFFIXED_USER_HOME to it (never recording its path); the started line says where everything goes', () => {
    const home = path.join(tmp, 'native-home');
    mkdirSync(home);
    const s = spec({}, { TIMMY_NATIVE_HOME: home });
    expect(s.env).toMatchObject({ HOME: home, CFFIXED_USER_HOME: home });
    expect(s.unreal.place).toEqual({ cache: 'Saved/DerivedDataCache', log: `Saved/Logs/Timmy-${s.native.run.slice(0, 8)}.log`, ddc: UNREAL_DDC_GRAPH, native_home: true });
    expect(readFileSync(path.join(root, '.timmy', 'native', s.native.run, 'unreal.json'), 'utf8')).not.toContain(home);
    const started = unrealStartLines(s, ' · ').map((l) => l.map((seg) => seg.text).join('')).join('\n');
    expect(started).toContain(`Caches     Saved/DerivedDataCache (derived data; no Zen: its local store is not used) · log Saved/Logs/Timmy-${s.native.run.slice(0, 8)}.log · Unreal's user folders in Timmy's native home (TIMMY_NATIVE_HOME)`);
    const plan = { run: s.native.run, dir: s.native.record!, root, project: { path: 'TimmyStarter.uproject', abs: path.join(root, 'TimmyStarter.uproject'), changed: false }, levels: [] } as UnrealReadbackPlan;
    const made = unrealReadbackJob(plan, { bin: fake, worker: path.join(WORKERS, 'unreal_readback.py'), lib: WORKERS, project: 'demo', env: { TIMMY_NATIVE_HOME: home } });
    expect(made.spec.env).toMatchObject({ HOME: home, CFFIXED_USER_HOME: home });
    expect(made.place.native_home).toBe(true);
    // without one, the started line says Unreal's user folders are this account's own
    expect(unrealStartLines(spec(), ' · ').map((l) => l.map((seg) => seg.text).join('')).join('\n')).toContain('Unreal\'s user folders in this account\'s own home (TIMMY_NATIVE_HOME would keep them out of it)');
  });

  it('refuses (nothing starts, nothing recorded) a project whose Saved folder leads outside it', () => {
    const elsewhere = path.join(tmp, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(root, 'Saved'));
    expect(() => spec()).toThrow(/Unreal's cache folder Saved\/DerivedDataCache does not lead inside the project .*nothing started/);
    expect(existsSync(path.join(root, '.timmy', 'native'))).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  describe.skipIf(!python)('a FAKE Unreal in real child processes', () => {
    it('keeps its derived-data cache and its log in the project\'s Saved folder, where the flags put them; none of it is an output', async () => {
      const { s, j } = await firstPass();
      expect(j.outcome, j.why).toBe('ok');
      expect(existsSync(path.join(root, 'Saved', 'DerivedDataCache', 'fake-unreal-ddc.udd'))).toBe(true);
      expect(readFileSync(path.join(root, 'Saved', 'Logs', `Timmy-${s.native.run.slice(0, 8)}.log`), 'utf8')).toMatch(/Python script executed successfully/);
      expect(j.files.map((f) => f.path)).toEqual(['Content/Timmy/TimmyGrid.umap']);
    });

    it('without a native home, Unreal\'s user files land in the account\'s Unreal folders: the verdict counts the files changed there during the job by folder, by their timestamps, without naming a writer; the run\'s record, the receipt and the lines keep the counts and the names', async () => {
      const { s, j, job } = await firstPass({}, { FAKE_UNREAL_ACCOUNT_HOME: account() });
      expect(j.outcome, j.why).toBe('ok');
      const epic = shown(accountEpic());
      const logs = shown(accountLogs());
      expect(j.outside).toMatchObject({
        state: 'checked', folders: UNREAL_MAC_USER_FOLDERS.map((f) => `~/${f}`), files: 2, by_folder: { [`${epic}/UnrealEngine/5.8/Saved`]: 1, [`${logs}/TimmyStarterEditor`]: 1 },
        names: [`${epic}/UnrealEngine/5.8/Saved/Config/MacEditor/EditorSettings.ini`, `${logs}/TimmyStarterEditor/AutoSDKInfo.json`],
      });
      expect(j.why).toContain(`2 files changed during the job in the 4 folders Unreal keeps in this account's home (by their timestamps; which process changed them is not known, and no other folder was looked at): ${epic}/UnrealEngine/5.8/Saved (1), ${logs}/TimmyStarterEditor (1)`);
      expect(readNativeRecord(root, s.native.run)?.verdicts.at(-1)).toMatchObject({ outcome: 'ok', outside: { files: 2, names: j.outside!.names } });
      expect(unrealReceiptFields(j).native.unreal).toMatchObject({ outside: { state: 'checked', files: 2, by_folder: j.outside!.by_folder } });
      expect(endText(j, s, job.id)).toContain(`outside  2 files changed during the job in the 4 folders Unreal keeps in this account's home (by their timestamps; which process changed them is not known, and no other folder was looked at): ${epic}/UnrealEngine/5.8/Saved (1), ${logs}/TimmyStarterEditor (1) · checked ${UNREAL_MAC_USER_FOLDERS.map((f) => `~/${f}`).join(', ')} for files changed since the job started (metadata only)`);
      // judged again (its lines, then its receipt), the job's check is the one kept: not walked again
      expect(judgeUnrealJob(job, s).outside).toEqual(j.outside);
    });

    it('with a native home they go there (CFFIXED_USER_HOME: Unreal ignores HOME for them): no file changed in the account\'s Unreal folders during the job, said as a timestamp check of those folders only', async () => {
      const home = path.join(tmp, 'native-home');
      const { j } = await firstPass({}, { FAKE_UNREAL_ACCOUNT_HOME: account(), TIMMY_NATIVE_HOME: home });
      expect(j.outcome, j.why).toBe('ok');
      expect(j.outside).toMatchObject({ state: 'checked', files: 0, names: [] });
      expect(j.why).toContain('no file changed during the job in the 4 folders Unreal keeps in this account\'s home (by their timestamps; no other folder was looked at)');
      expect(existsSync(path.join(home, 'Library', 'Application Support', 'Epic', 'UnrealEngine', '5.8', 'Saved', 'Config', 'MacEditor', 'EditorSettings.ini'))).toBe(true);
      expect(existsSync(path.join(account(), 'Library'))).toBe(false);
    });

    it('the readback is checked too: a FAKE write into a watched folder while it runs is named on its record', async () => {
      expect((await firstPass()).j.outcome).toBe('ok');
      const stray = path.join(accountEpic(), 'UnrealEngine', 'Common', 'Zen', 'Data', 'stray.bin');
      const { line } = await readback({ FAKE_UNREAL_OUTSIDE_WRITE: stray });
      expect(line.verdict).toBe('agrees');
      expect(line.outside).toMatchObject({ state: 'checked', files: 1, by_folder: { [`${shown(accountEpic())}/UnrealEngine/Common/Zen`]: 1 }, names: [shown(stray)] });
    });

    it('r21 again: a script whose spawn gives no actor (spawn_actor_from_object in the commandlet) after its level was saved fails, whatever Unreal\'s exit and words; the level is recorded as written by the failed run, never as an output', async () => {
      writeFileSync(path.join(root, 'spawn.py'), [
        'import unreal',
        'def main(run):',
        '    run.new_level("/Game/Timmy/TimmyGrid")',
        '    cube = run.load_mesh("/Engine/BasicShapes/Cube.Cube")',
        '    actor = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).spawn_actor_from_object(cube, unreal.Vector(0, 0, 50), unreal.Rotator(0, 0, 0))',
        '    if actor is None:',
        '        raise RuntimeError("spawn_actor_from_object gave no actor for /Engine/BasicShapes/Cube.Cube")',
        '',
      ].join('\n'));
      const { s, job, j, log } = await firstPass({ script: 'spawn.py' });
      // Unreal's exit and words say success: the result file decides
      expect(job.exitCode).toBe(0);
      expect(log).toMatch(/LogUtils: Warning: SpawnActorFromObject\. No actor was spawned\./);
      expect(log).toMatch(/Python script executed successfully/);
      expect(j.outcome).toBe('failed');
      expect(j.why).toMatch(/the script reported ok: false: RuntimeError: spawn_actor_from_object gave no actor for \/Engine\/BasicShapes\/Cube\.Cube/);
      const level = sha(path.join(root, 'Content', 'Timmy', 'TimmyGrid.umap'));
      expect(j.files).toEqual([]);
      expect(j.failedWrites).toEqual([{ path: 'Content/Timmy/TimmyGrid.umap', recorded: level, present: true, sha256: level, matches: true, change: 'created' }]);
      expect(j.why).toContain(`written by this failed run: Content/Timmy/TimmyGrid.umap (created; sha256 ${level.slice(0, 12)}…)`);
      expect(readNativeRecord(root, s.native.run)?.verdicts.at(-1)).toMatchObject({ outcome: 'failed', files: [], failed_writes: [{ path: 'Content/Timmy/TimmyGrid.umap', recorded: level, change: 'created' }] });
      const sealed = unrealReceiptFields(j);
      expect(sealed.status).toBe('failed');
      expect(sealed.native.files).toEqual([]);
      expect(sealed.native.unreal).toMatchObject({ failed_run_writes: [{ path: 'Content/Timmy/TimmyGrid.umap', recorded: level, change: 'created', matches: true }] });
      const text = endText(j, s, job.id);
      expect(text).toMatch(/left {5}Content\/Timmy\/TimmyGrid\.umap · written by this failed run \(created\) · sha256 [0-9a-f]{12}… \(Timmy's, after the run, as the harness recorded it\) · [0-9.]+ (B|KB) · not an output: the run failed/);
      expect(text).not.toMatch(/saved {4}Content/);
      // a file the failed run named and then changed again is said so: the harness's sha256 and Timmy's both
      appendFileSync(path.join(root, 'Content', 'Timmy', 'TimmyGrid.umap'), ' ');
      const again = judgeUnrealJob(job, s);
      expect(again.failedWrites?.[0]).toMatchObject({ matches: false, recorded: level });
      expect(again.why).toMatch(new RegExp(`Content/Timmy/TimmyGrid\\.umap \\(created; sha256 ${level.slice(0, 12)}…; [0-9a-f]{12}… now\\)`));
    });

    it('spawn_mesh spawns by class and then sets the mesh; a mesh set_static_mesh refuses leaves no half-made actor', async () => {
      writeFileSync(path.join(root, 'half.py'), [
        'import unreal',
        'def main(run):',
        '    run.new_level("/Game/Half")',
        '    try:',
        '        run.spawn_mesh(unreal.Class("/Script/Engine.NotAMesh"), (0, 0, 0))',
        '    except RuntimeError as e:',
        '        run.note(str(e))',
        '    run.spawn_mesh(run.load_mesh("/Engine/BasicShapes/Cube.Cube"), (0, 0, 50), label="One")',
        '    run.save_level()',
        '',
      ].join('\n'));
      const { j, log } = await firstPass({ script: 'half.py' });
      expect(j.outcome, j.why).toBe('ok');
      expect(log).not.toMatch(/No actor was spawned/);
      expect(j.unreal.notes).toEqual(['set_static_mesh did not give the spawned StaticMeshActor the mesh /Script/Engine.NotAMesh']);
      expect(j.unreal.levels[0].actors.map((a) => [a.label, a.mesh, a.bounds.size])).toEqual([['One', '/Engine/BasicShapes/Cube.Cube', [100, 100, 100]]]);
      expect(j.unreal.made.map((m) => m.label)).toEqual(['One']);
    });

    it('the harness writes no bytecode beside itself (Unreal\'s Python wrote __pycache__ there on the Mac)', async () => {
      const lib = path.join(tmp, 'lib');
      const stub = path.join(tmp, 'stub');
      cpSync(WORKERS, lib, { recursive: true });
      cpSync(STUB, stub, { recursive: true });
      const { j } = await firstPass({}, { TIMMY_UNREAL_LIB: lib, PYTHONPATH: stub, PYTHONDONTWRITEBYTECODE: '' });
      expect(j.outcome, j.why).toBe('ok');
      expect(readdirSync(lib).sort()).toEqual(['timmy_unreal.py', 'unreal_readback.py']);
      expect(readdirSync(stub)).toEqual(['unreal.py']);
    });
  });
});

/**
 * R4 u23 (H72, the Mac run through the installed Timmy, revision 796485a): a first pass stopped with /stop after its script
 * saved a level (stop.py saved /Game/Timmy/StopGrid, then slept) was never judged: no verdict line in its run's folder, a
 * plain task receipt naming neither the run nor the level, no outside check, and nothing said about the file it left.
 */
describe.skipIf(!python)('R4 u23 (H72): an Unreal run Timmy stops after its script saved a level', () => {
  it('is judged when it ends: the level is named as changed during the stopped run (found against the inventory taken at submission), never an output; the outside check runs; the operation counts it stopped', async () => {
    writeFileSync(path.join(root, 'stop.py'), [
      'import time',
      'def main(run):',
      '    run.new_level("/Game/Timmy/StopGrid")',
      '    run.spawn_mesh(run.load_mesh("/Engine/BasicShapes/Cube.Cube"), (0, 0, 50), label="StopCube_0")',
      '    run.save_level()',
      '    print("stop.py: saved; sleeping", flush=True)',
      '    time.sleep(60)',
      '',
    ].join('\n'));
    const s = spec({ script: 'stop.py' });
    const m = new JobManager({ dir: path.join(tmp, 'jobs') });
    managers.push(m);
    const id = m.start(s).id;
    const level = path.join(root, 'Content', 'Timmy', 'StopGrid.umap');
    for (let i = 0; i < 300 && !m.tail(id, 40).join('\n').includes('stop.py: saved; sleeping'); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(level)).toBe(true);
    const job = (await m.stop(id))!;
    expect(job.state).toBe('cancelled');
    const j = judgeUnrealJob(job, s);
    const made = sha(level);
    expect(j.files).toEqual([]);
    expect(j.failedWrites).toEqual([{ path: 'Content/Timmy/StopGrid.umap', found: 'inventory', present: true, sha256: made, change: 'created' }]);
    expect(j.why).toContain('no result file, and UnrealEditor-Cmd was stopped');
    expect(j.why).toContain(`changed in Content/ and out/ during this stopped run, found against their inventory at submission (not named by a result, so which process changed them is not shown; not outputs): Content/Timmy/StopGrid.umap (created; sha256 ${made.slice(0, 12)}…)`);
    // the cause is known: no "Unreal did not run the harness" guess for a run Timmy stopped
    expect(j.why).not.toContain('a possible cause, not checked');
    expect(j.outside).toMatchObject({ state: 'checked', files: 0 });
    expect(readNativeRecord(root, s.native.run)?.verdicts.at(-1)).toMatchObject({ job: job.id, exit: { state: 'cancelled' }, files: [], failed_writes: [{ path: 'Content/Timmy/StopGrid.umap', found: 'inventory', change: 'created' }], outside: { state: 'checked' } });
    const sealed = unrealReceiptFields(j);
    expect(sealed.native.files).toEqual([]);
    expect(sealed.native.unreal).toMatchObject({ failed_run_writes: [{ path: 'Content/Timmy/StopGrid.umap', found: 'inventory', change: 'created', sha256: made }], outside: { state: 'checked' } });
    const text = endText(j, s, job.id);
    expect(text).toMatch(new RegExp(`^ {2}${job.id} stopped {2}Unreal: no result file, and UnrealEditor-Cmd was stopped`));
    expect(text).toMatch(/left {5}Content\/Timmy\/StopGrid\.umap · changed during this stopped run \(created\) · sha256 [0-9a-f]{12}… \(Timmy's, after the run; found against the inventory taken at submission, not named by a result\) · [0-9.]+ (B|KB) · not an output: the run was stopped/);
    expect(text).toMatch(/outside {2}no file changed during the job in the 4 folders Unreal keeps in this account's home/);
    // the operation's outcome: stopped, not failed
    expect(runOutcome({ kind: 'native', id: s.native.run, at: '' }, root, { get: () => job })).toMatchObject({ state: 'stopped' });
    // a file there before the run and untouched by it is not named; one the run removed is named as gone
    const kept = path.join(root, 'Content', 'Timmy', 'Kept.umap');
    writeFileSync(kept, 'kept');
    writeFileSync(path.join(root, 'stop2.py'), readFileSync(path.join(root, 'stop.py'), 'utf8').replace('/Game/Timmy/StopGrid', '/Game/Timmy/StopGrid2'));
    const s2 = spec({ script: 'stop2.py' });
    rmSync(kept);
    const m2 = new JobManager({ dir: path.join(tmp, 'jobs2') });
    managers.push(m2);
    const id2 = m2.start(s2).id;
    for (let i = 0; i < 300 && !m2.tail(id2, 40).join('\n').includes('stop.py: saved; sleeping'); i++) await new Promise((r) => setTimeout(r, 100));
    const j2 = judgeUnrealJob((await m2.stop(id2))!, s2);
    // StopGrid.umap, there at this run's submission and untouched by it, is not named
    expect(j2.failedWrites?.map((f) => [f.path, f.change])).toEqual([['Content/Timmy/Kept.umap', 'gone'], ['Content/Timmy/StopGrid2.umap', 'created']]);
    expect(j2.why).toContain('Content/Timmy/Kept.umap (gone), Content/Timmy/StopGrid2.umap (created; sha256 ');
  }, 60_000);
});

describe('the comparison itself', () => {
  const actor = (o: Partial<{ name: string; location: number[]; rotation: number[]; scale: number[] }> = {}) => ({
    name: o.name ?? 'A', label: 'A', class: '/Script/Engine.StaticMeshActor', location: o.location ?? [0, 0, 0], rotation: o.rotation ?? [0, 0, 0], scale: o.scale ?? [1, 1, 1],
    bounds: { origin: [0, 0, 0], extent: [50, 50, 50], min: [-50, -50, -50], max: [50, 50, 50], size: [100, 100, 100] },
  });
  it('equal rotations written differently agree; a quarter turn does not, and says so with both rotators', () => {
    expect(compareUnrealActors([actor({ rotation: [0, 360, 0] })], [actor({ rotation: [0, 0, 0] })]).agree).toBe(1);
    expect(compareUnrealActors([actor({ rotation: [0, -90, 0] })], [actor({ rotation: [0, 270, 0] })]).agree).toBe(1);
    const turned = compareUnrealActors([actor({ rotation: [0, 90, 0] })], [actor()]);
    expect(turned.agree).toBe(0);
    expect(turned.checks[0].differences[0]).toMatchObject({ what: 'rotation (pitch, yaw, roll, degrees)', first: '0, 90, 0', readback: '0, 0, 0' });
  });
  it('a difference within the tolerance agrees; past it, it differs', () => {
    expect(compareUnrealActors([actor({ location: [10, 0, 0] })], [actor({ location: [10.0009, 0, 0] })]).agree).toBe(1);
    expect(compareUnrealActors([actor({ location: [10, 0, 0] })], [actor({ location: [10.002, 0, 0] })]).agree).toBe(0);
    expect(compareUnrealActors([actor({ scale: [1, 1, 1] })], [actor({ scale: [1, 1, 1.00001] })]).agree).toBe(0);
    expect(compareUnrealActors([actor()], [actor(), actor({ name: 'B' })]).checks.at(-1)).toMatchObject({ name: 'B', in: 'readback only', passed: false });
  });
  it('a readback stopped before it ended has no verdict', () => {
    const plan = { run: '00000000-0000-4000-8000-000000000000', dir: tmp, root, project: { path: 'p.uproject', abs: '', changed: false }, levels: [] } as UnrealReadbackPlan;
    const job = { id: 'j000001', state: 'cancelled' } as JobRecord;
    expect(judgeUnrealReadback(plan, job, 't', path.join(tmp, 'none.json'))).toMatchObject({ state: 'cancelled', reason: 'stopped before it finished: no verdict' });
    expect(judgeUnrealReadback(plan, job, 't', path.join(tmp, 'none.json')).verdict).toBeUndefined();
  });
});

describe('run_native with app unreal, and its approval', () => {
  it('asks every time, naming the project file, the script and its arguments; Blender\'s box is as it was', () => {
    expect(approvalNeeded('run_native', { app: 'unreal', project_file: 'TimmyStarter.uproject', script: 'scene.py', args: ['--cubes', '4'] })).toEqual({
      reason: 'starts Unreal Engine on this machine (UnrealEditor-Cmd, headless): it runs a Python script of your project inside the editor, which may save levels in your project; a second Unreal process then reads them back',
      summary: 'unreal TimmyStarter.uproject scene.py --cubes 4', session: false,
    });
    expect(approvalNeeded('run_native', { app: 'unreal', project_file: 'x\x1b]52;c;eA==\x07.uproject', script: 's.py' })?.summary).toBe('unreal x.uproject s.py');
    expect(approvalNeeded('run_native', { app: 'blender', script: 'scenes/scene.py' })).toEqual({ reason: 'starts Cinema 4D, After Effects, Blender, OpenSCAD or FreeCAD on this machine', summary: 'blender scenes/scene.py' });
  });

  it.skipIf(!python)('starts an Unreal job and returns at once with its run, its result file and its copy; it needs project_file and script', async () => {
    const m = new JobManager({ dir: path.join(tmp, 'jobs') });
    managers.push(m);
    const [tool] = createNativeTools({ root: () => root, project: () => 'demo', start: (s) => m.start(s), find: { unreal: () => ({ app: 'unreal', path: fake, how: 'env' }) }, env: fakeEnv() });
    const call = (tool.function as unknown as { execute: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }).execute;
    expect(await call({ app: 'unreal', script: 'scene.py' })).toMatchObject({ ok: false, error: expect.stringContaining('unreal needs project_file') });
    expect(await call({ app: 'unreal', project_file: 'TimmyStarter.uproject' })).toMatchObject({ ok: false, error: expect.stringContaining('unreal needs script') });
    const answer = await call({ app: 'unreal', project_file: 'TimmyStarter.uproject', script: 'scene.py' });
    expect(answer).toMatchObject({ ok: true, app: 'unreal', result_file: `.timmy/native/${answer.run}/result.json`, copy: `.timmy/native/${answer.run}/source/scene.py`, project_file: 'TimmyStarter.uproject' });
    expect(String(answer.note)).toMatch(/A second Unreal process then reads each saved level back, and its verdict \(agrees or differs\) is the check/);
    expect(String(answer.note)).toMatch(/Unreal keeps its cache and its log in Saved\/DerivedDataCache and Saved\/Logs\/Timmy-[0-9a-f]{8}\.log; each verdict says whether files changed during the job in the folders Unreal keeps in this account's home, by their timestamps \(not which process changed them, and no other folder\)/);
    const job = await m.done(answer.job as string);
    expect(job.state).toBe('completed');
  });
});

describe('the starter', () => {
  it('ships as a project starter: a .uproject with the two plugins and no C++ module, the script, its parameters and a README', () => {
    expect(listStarters().map((s) => s.name)).toContain('unreal-starter');
    const dest = path.join(tmp, 'new');
    expect(copyStarter('unreal-starter', dest)).toEqual({ files: ['README.md', 'scene.params.json', 'scene.py', 'TimmyStarter.uproject'] });
    const project = JSON.parse(readFileSync(path.join(dest, 'TimmyStarter.uproject'), 'utf8'));
    expect(project.Plugins).toEqual([{ Name: 'PythonScriptPlugin', Enabled: true }, { Name: 'EditorScriptingUtilities', Enabled: true }]);
    expect(project.Modules).toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(dest, 'scene.params.json'), 'utf8'))).toEqual({ level: '/Game/Timmy/TimmyGrid', count: 9, columns: 3, spacing_cm: 150, size_cm: 100, mesh: '/Engine/BasicShapes/Cube.Cube' });
  });
});
