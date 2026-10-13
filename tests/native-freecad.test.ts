/**
 * FreeCAD as a native app (round R4, helper H28): FreeCAD's freecadcmd runs a Python script headless as a judged job,
 * with the rules Blender's runs follow (a run token, the script's sha256 echoed, a read-only copy run instead of the
 * original, out/ inventoried before the run, a result file that decides), and the STEP it exports can be read back in a
 * separate process and compared with FreeCAD's own report.
 *
 * Everything here runs against TEST DOUBLES, each labelled:
 *   - tests/fixtures/fake-freecadcmd.mjs stands in for freecadcmd. It runs the script with python3 the way FreeCAD's source
 *     says freecadcmd takes a .py file: imported as a module named after the file, run again in __main__ when that import
 *     raises, exit 0 either way;
 *   - tests/fixtures/freecad-stub (FreeCAD.py, Part.py) stands in for FreeCAD's own modules: volumes and bounding boxes by
 *     formula, no kernel; the .FCStd and STEP files it writes are FAKE (they hold no geometry);
 *   - tests/fixtures/fake-freecad-readback.mjs stands in for the readback worker: it copies the stand-in's numbers out of
 *     the FAKE STEP and measures nothing. The real workers/readback/step_readback.py runs once, with this machine's
 *     python3, which has no OCP: its failure path.
 * No FreeCAD runs here: a pass says the job, the helper (workers/freecad/timmy_freecad.py), the starter
 * (templates/freecad-starter/plate.py) and the judgement hold together with real child processes and files, not that
 * FreeCAD accepts the calls.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobManager, type JobRecord } from '../src/jobs/index.js';
import { locateNative, nativeCapabilityRows, nativeExercisedAt, nativeRunIndex, readNativeRecord, readNativeResult } from '../src/native/index.js';
import {
  compareFreecadReadback, DOCTRINE_15, findFreecad, freecadEndLines, freecadJob, freecadModuleName, freecadReceiptFields, judgeFreecadJob, planFreecadReadback,
  readReadbacks, reconcileFreecad, type FreecadJobSpec, type FreecadReadbackPlan,
} from '../src/native/freecad.js';
import { DOCTRINE_15 as RECIPE_DOCTRINE_15 } from '../src/recipes/index.js';
import { READBACK_TOLERANCE, type ReadbackMeasured } from '../src/flows/iterate.js';
import { createNativeTools } from '../src/agent/native-tools.js';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { COMMANDS } from '../src/repl/commands.js';
import { approvalNeeded } from '../src/repl/approvals.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { ReceiptInput } from '../src/utils/receipts.js';

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const STUB = path.join(FIXTURES, 'freecad-stub');
const FAKE_FREECADCMD = path.join(FIXTURES, 'fake-freecadcmd.mjs');
const FAKE_READBACK = path.join(FIXTURES, 'fake-freecad-readback.mjs');
const which = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
const python = which.status === 0 ? which.stdout.trim() : '';

let tmp = '';
let root = '';
let managers: JobManager[] = [];
const spaces: Workspace[] = [];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'timmy-freecad-')));
  root = path.join(tmp, 'project');
  mkdirSync(root, { recursive: true });
  managers = [];
});
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const m of managers) await m.stopAll();
  rmSync(tmp, { recursive: true, force: true });
}, 60_000);

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
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
async function runSpec(spec: FreecadJobSpec): Promise<{ job: JobRecord; m: JobManager }> {
  const m = manager();
  return { m, job: await m.done(m.start(spec).id) };
}
async function until(pred: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); }
}
/** The environment the FAKE freecadcmd needs: python3, the stand-in modules, the mode. */
const fakeEnv = (mode = 'python', extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ FAKE_FREECAD_MODE: mode, FAKE_FREECAD_PYTHON: python, PYTHONPATH: STUB, PYTHONDONTWRITEBYTECODE: '1', ...extra });
function spec(script: string, o: { mode?: string; env?: NodeJS.ProcessEnv; args?: string[]; expect?: string[] } = {}): FreecadJobSpec {
  const bin = install('fake-freecadcmd.mjs', path.join(tmp, 'bin', 'freecadcmd'));
  return freecadJob({ script, root, project: 'demo', timeoutMs: 30_000, bin, env: fakeEnv(o.mode, o.env), ...(o.args ? { args: o.args } : {}), ...(o.expect ? { expect: o.expect } : {}) });
}
function result(s: FreecadJobSpec): Record<string, any> {
  const read = readNativeResult(s.native.result!);
  if (read.state !== 'read') throw new Error(`no result file: ${read.state}`);
  return read.data as Record<string, any>;
}
const noTmp = (s: string): void => { for (const p of new Set([tmp, root])) expect(s).not.toContain(p); };

/** A small script of its own, through the helper: a box (its length from --length), saved and exported. */
const BOX = `import os, sys
sys.path.insert(0, os.environ["TIMMY_FREECAD_LIB"])
import timmy_freecad

def main(run):
    args = timmy_freecad.script_args()
    length = float(args[args.index("--length") + 1]) if "--length" in args else 20.0
    doc = run.new_document("Box")
    box = doc.addObject("Part::Box", "Box")
    box.Length = length
    box.Width = 10.0
    box.Height = 5.0
    run.recompute(doc)
    run.save_document(doc, run.out_path("box.FCStd"))
    run.export_step([box], run.out_path("box.step"))
    return {"length": length}

timmy_freecad.run_script(main)
`;
const write = (name: string, body: string): void => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), body); };

describe('finding freecadcmd', () => {
  const none = { onPath: () => null };
  it('takes TIMMY_FREECADCMD first, opening a FreeCAD.app bundle to Contents/Resources/bin/freecadcmd', () => {
    const bundle = path.join(tmp, 'FreeCAD.app');
    const inner = install('fake-freecadcmd.mjs', path.join(bundle, 'Contents', 'Resources', 'bin', 'freecadcmd'));
    expect(findFreecad({ TIMMY_FREECADCMD: bundle }, { platform: 'darwin', ...none })).toMatchObject({ app: 'freecad', path: inner, how: 'env' });
    expect(findFreecad({ TIMMY_FREECADCMD: inner }, { platform: 'linux', ...none })).toMatchObject({ path: inner, how: 'env' });
  });

  it('on macOS finds /Applications/FreeCAD.app and a versioned FreeCAD 1.1.app, newest first; elsewhere PATH', () => {
    const apps = path.join(tmp, 'Applications');
    install('fake-freecadcmd.mjs', path.join(apps, 'FreeCAD.app', 'Contents', 'Resources', 'bin', 'freecadcmd'));
    expect(findFreecad({}, { platform: 'darwin', applications: apps, ...none })).toMatchObject({ path: path.join(apps, 'FreeCAD.app', 'Contents', 'Resources', 'bin', 'freecadcmd'), how: 'applications', folder: 'FreeCAD.app' });
    const versioned = install('fake-freecadcmd.mjs', path.join(apps, 'FreeCAD 1.1.app', 'Contents', 'Resources', 'bin', 'freecadcmd'));
    expect(findFreecad({}, { platform: 'darwin', applications: apps, ...none })).toMatchObject({ path: versioned, version: '1.1' });
    expect(findFreecad({}, { platform: 'linux', onPath: (p) => (p === 'freecadcmd' ? '/usr/bin/freecadcmd' : null) })).toMatchObject({ path: '/usr/bin/freecadcmd', how: 'path' });
  });

  it('a TIMMY_FREECADCMD that names nothing runnable stops the search, with the reason', () => {
    const r = locateNative('freecad', { TIMMY_FREECADCMD: path.join(tmp, 'gone') }, { platform: 'linux', onPath: () => '/usr/bin/freecadcmd' });
    expect(r.found).toBeNull();
    expect(r.problem).toMatch(/TIMMY_FREECADCMD is set, but nothing runnable is there/);
  });
});

describe('FreeCAD jobs: freecadcmd <copy>, judged by the result file', () => {
  it('runs freecadcmd with the copy alone on its command line, under a module name no other file has; the arguments in TIMMY_SCRIPT_ARGS', () => {
    write('part.py', BOX);
    const s = spec('part.py', { args: ['--length', '30'] });
    const module = `timmy_${s.native.run.slice(0, 8)}_part`;
    const copy = path.join(root, '.timmy', 'native', s.native.run, 'source', `${module}.py`);
    expect(s.command).toBe(path.join(tmp, 'bin', 'freecadcmd'));
    expect(s.args).toEqual([copy]);
    expect(s.freecad).toEqual({ module, args: ['--length', '30'] });
    expect(s.env).toMatchObject({
      TIMMY_RESULT: path.join(root, '.timmy', 'native', s.native.run, 'result.json'), TIMMY_RUN: s.native.run, TIMMY_ROOT: root, TIMMY_OUT: path.join(root, 'out'),
      TIMMY_SCRIPT: copy, TIMMY_SCRIPT_ORIGINAL: path.join(root, 'part.py'), TIMMY_SCRIPT_DIR: root, TIMMY_SCRIPT_SHA256: sha(BOX),
      TIMMY_SCRIPT_ARGS: '["--length","30"]', TIMMY_FREECAD_LIB: path.join(REPO, 'workers', 'freecad'),
    });
    // the copy: the submitted bytes, read-only
    expect(readFileSync(copy, 'utf8')).toBe(BOX);
    expect(statSync(copy).mode & 0o222).toBe(0);
    expect(s.native).toMatchObject({ app: 'freecad', input: { path: 'part.py', sha256: sha(BOX) }, copy: { path: `.timmy/native/${s.native.run}/source/${module}.py`, sha256: sha(BOX) } });
    expect(s.native.inventory).toMatchObject({ folders: ['out'], complete: true });
    const rec = readNativeRecord(root, s.native.run);
    expect(rec?.job).toMatchObject({ app: 'freecad', args: [`./.timmy/native/${s.native.run}/source/${module}.py`], input: { path: 'part.py' } });
    expect(JSON.parse(readFileSync(path.join(rec!.dir, 'freecad.json'), 'utf8'))).toEqual({ record: 'timmy-freecad-run', v: 1, run: s.native.run, module, script_args: ['--length', '30'] });
    // a name Python would take for its own (test.py), or one with characters a module name cannot hold
    expect(freecadModuleName(s.native.run, 'test.py')).toBe(`timmy_${s.native.run.slice(0, 8)}_test`);
    expect(freecadModuleName(s.native.run, 'parts/my plate-v2.py')).toBe(`timmy_${s.native.run.slice(0, 8)}_my_plate_v2`);
  });

  it('refuses a script outside the project, and one that is not .py; finding nothing says how to set it up', () => {
    write('part.py', BOX);
    expect(() => spec('../elsewhere.py')).toThrow(/outside the project/);
    write('part.txt', 'x');
    expect(() => spec('part.txt')).toThrow(/\.py/);
    expect(() => freecadJob({ script: 'part.py', root, project: 'demo', findEnv: { TIMMY_FREECADCMD: path.join(tmp, 'gone') } })).toThrow(/FreeCAD \(freecadcmd, headless\) was not found on this machine \(TIMMY_FREECADCMD is set/);
  });
});

describe.skipIf(!python)('FreeCAD jobs under the stand-in (python3 in freecadcmd\'s place)', () => {
  it('ok: a result of this run, from the copy, naming the .FCStd and STEP it made, each with a matching sha256', async () => {
    write('part.py', BOX);
    const s = spec('part.py');
    const { job, m } = await runSpec(s);
    const r = result(s);
    expect(r, m.tail(job.id, 40).join('\n')).toMatchObject({
      ok: true, run: s.native.run, script_sha256: sha(BOX), script_sha256_read: sha(BOX), script_is_copy: true, script_ran: s.native.copy!.path,
      freecad_version: '1.0.0', units: 'mm', length: 20,
    });
    expect(Object.keys(r.files).sort()).toEqual(['out/box.FCStd', 'out/box.step']);
    const j = judgeFreecadJob(job, s);
    expect(j.outcome, j.why).toBe('ok');
    expect(j.why).toMatch(/the copy kept at submission ran/);
    expect(j.files.map((f) => [f.path, f.change, f.matches])).toEqual([['out/box.FCStd', 'created', true], ['out/box.step', 'created', true]]);
    expect(j.freecad).toMatchObject({ version: '1.0.0', script_is_copy: true, module: s.freecad.module });
    expect(j.freecad.exports).toEqual([{ path: 'out/box.step', format: 'STEP', objects: ['Box'], shape: { type: 'Solid', valid: true, solids: 1, volume_mm3: 1000, bounds: { min: [0, 0, 0], max: [20, 10, 5], size: [20, 10, 5], method: expect.stringMatching(/optimalBoundingBox/) } } }]);
    expect(j.freecad.objects).toEqual([{ document: 'Box', name: 'Box', label: 'Box', type: 'Part::Box', state: [], shape: expect.objectContaining({ volume_mm3: 1000 }) }]);
    // the final judgement alone is recorded beside the run
    expect(readNativeRecord(root, s.native.run)?.verdicts.map((v) => v.outcome)).toEqual(['ok']);
    const sealed = freecadReceiptFields(j);
    expect(sealed.status).toBe('ok');
    expect(sealed.native).toMatchObject({ app: 'freecad', outcome: 'ok', run: s.native.run, freecad: { freecad_version: '1.0.0', script_is_copy: true, objects: 1, doctrine: DOCTRINE_15 } });
    expect((sealed.native.freecad.exports as Array<Record<string, any>>)[0].reported).toMatchObject({ volume_mm3: 1000, units: 'mm', measured_by: 'FreeCAD (its own report)', geometry: { provenance: 'generated', evidence: 'constructed' } });
    noTmp(JSON.stringify(sealed));
  });

  it('a script error in main: ok: false with the error, judged failed', async () => {
    write('broken.py', BOX.replace('    doc = run.new_document("Box")', '    raise ValueError("the part is wrong (a test)")'));
    const s = spec('broken.py');
    const { job } = await runSpec(s);
    expect(result(s)).toMatchObject({ ok: false, error: 'ValueError: the part is wrong (a test)', files: {} });
    noTmp(String(result(s).traceback));
    const j = judgeFreecadJob(job, s);
    expect(j.outcome).toBe('failed');
    expect(j.why).toMatch(/the script reported ok: false: ValueError: the part is wrong \(a test\)/);
    expect(j.freecad.error).toBe('ValueError: the part is wrong (a test)');
  });

  it('an error before run_script: freecadcmd runs the file again and exits 0, no result is written, judged unknown with the hint', async () => {
    write('top.py', `raise RuntimeError("before run_script (a test)")\n${BOX}`);
    const s = spec('top.py');
    const { job, m } = await runSpec(s);
    expect(job.exitCode).toBe(0);
    expect(m.tail(job.id, 40).join('\n')).toMatch(/running it again in __main__/);
    expect(existsSync(s.native.result!)).toBe(false);
    const j = judgeFreecadJob(job, s);
    expect(j.outcome).toBe('unknown');
    expect(j.why).toMatch(/exited 0 but wrote no result file/);
    expect(j.why).toMatch(/if __name__ == "__main__"/);
  });

  it('no result file: a script whose work sits under if __name__ == "__main__" runs nothing when freecadcmd imports it', async () => {
    write('guarded.py', BOX.replace('timmy_freecad.run_script(main)', 'if __name__ == "__main__":\n    timmy_freecad.run_script(main)'));
    const s = spec('guarded.py');
    const { job } = await runSpec(s);
    expect(existsSync(s.native.result!)).toBe(false);
    expect(existsSync(path.join(root, 'out', 'box.FCStd'))).toBe(false);
    const j = judgeFreecadJob(job, s);
    expect(j.outcome).toBe('unknown');
    expect(j.why).toMatch(/call timmy_freecad\.run_script\(main\) at the top level/);
    const lines = text(freecadEndLines(j, s, { id: job.id, label: job.label, glyphs: glyphSet(true), sep: ' · ', scrub: (t) => t }));
    expect(lines).toMatch(/\.timmy\/native\/.*\/result\.json · \/jobs j[0-9a-f]{6} for freecadcmd's own output/);
    expect(lines).not.toContain(DOCTRINE_15); // no dimension shown, so no sentence
  });

  it('no result file and a crash: unknown when it exits 0, failed when it does not', async () => {
    write('part.py', BOX);
    const quiet = spec('part.py', { mode: 'no-result' });
    expect(judgeFreecadJob((await runSpec(quiet)).job, quiet).outcome).toBe('unknown');
    const crashed = spec('part.py', { mode: 'crash' });
    const { job } = await runSpec(crashed);
    expect(job.exitCode).toBe(134);
    const j = judgeFreecadJob(job, crashed);
    expect(j.outcome).toBe('failed');
    expect(j.why).toMatch(/no result file, and freecadcmd exited 134/);
  });

  it('main runs once: an error after run_script makes freecadcmd run the file again, and run_script refuses the second call', async () => {
    write('after.py', `${BOX.replace('    return {"length": length}', '    open(os.path.join(os.environ["TIMMY_ROOT"], "count.txt"), "a").write("main\\n")\n    return {"length": length}')}raise RuntimeError("after run_script (a test)")\n`);
    const s = spec('after.py');
    const { job, m } = await runSpec(s);
    const log = m.tail(job.id, 40).join('\n');
    expect(log).toMatch(/running it again in __main__/);
    expect(log).toMatch(/run_script was called again in this process/);
    expect(readFileSync(path.join(root, 'count.txt'), 'utf8')).toBe('main\n');
    expect(judgeFreecadJob(job, s).outcome).toBe('ok');
  });

  it('outputs reused vs created: the same bytes again are not this run\'s; other bytes are', async () => {
    write('part.py', BOX);
    const first = spec('part.py');
    const one = judgeFreecadJob((await runSpec(first)).job, first);
    expect(one.outcome, one.why).toBe('ok');
    expect(one.files.map((f) => f.change)).toEqual(['created', 'created']);
    // The stand-in writes the same bytes for the same box: a second run rewrites them identically.
    const again = spec('part.py');
    const two = judgeFreecadJob((await runSpec(again)).job, again);
    expect(two.files.map((f) => f.change)).toEqual(['reused', 'reused']);
    expect(two.outcome).toBe('unknown');
    expect(two.why).toMatch(/names out\/box\.FCStd, which was there before this run with the same bytes \(reused\): not made by this run/);
    const lines = text(freecadEndLines(two, again, { id: 'j000001', label: 'FreeCAD · part.py', glyphs: glyphSet(true), sep: ' · ', scrub: (t) => t }));
    expect(lines).toMatch(/out\/box\.step · not made by this run \(reused\)/);
    expect(lines).not.toMatch(/\/freecad readback/); // nothing is offered for a run not judged ok
    const longer = spec('part.py', { args: ['--length', '30'] });
    const three = judgeFreecadJob((await runSpec(longer)).job, longer);
    expect(three.outcome, three.why).toBe('ok');
    expect(three.files.map((f) => f.change)).toEqual(['changed', 'changed']);
  });

  it('the copy changed: before it ran (the script read other bytes) or after (the copy no longer holds them): unknown either way', async () => {
    write('part.py', BOX);
    const before = spec('part.py');
    const copy = path.join(root, before.native.copy!.path);
    chmodSync(copy, 0o644);
    writeFileSync(copy, `${BOX}# changed after submission\n`);
    const b = judgeFreecadJob((await runSpec(before)).job, before);
    expect(b.outcome).toBe('unknown');
    expect(b.why).toMatch(/reports reading other bytes than part\.py as submitted/);

    const after = spec('part.py', { args: ['--length', '40'] });
    const { job } = await runSpec(after);
    const copied = path.join(root, after.native.copy!.path);
    chmodSync(copied, 0o644);
    writeFileSync(copied, `${BOX}# changed after the run\n`);
    const a = judgeFreecadJob(job, after);
    expect(a.outcome).toBe('unknown');
    expect(a.why).toMatch(/no longer holds the submitted bytes/);
  });

  it('the code that ran came from another file of the module\'s name: unknown, and it says which file ran', async () => {
    write('part.py', BOX);
    const s = spec('part.py', { mode: 'python-cwd' });
    // A file with the copy's module name in the project folder, first on sys.path in this mode: it is imported instead.
    write(`${s.freecad.module}.py`, `${BOX}# not the script submitted\n`);
    const { job } = await runSpec(s);
    expect(result(s)).toMatchObject({ ok: true, script_is_copy: false, script_ran: `${s.freecad.module}.py`, script_sha256_read: sha(BOX) });
    const j = judgeFreecadJob(job, s);
    expect(j.outcome).toBe('unknown');
    expect(j.why).toMatch(new RegExp(`the code that ran came from ${s.freecad.module}\\.py, not the copy kept at submission`));
  });

  it('a result that does not say which file ran (written without the helper): unknown', async () => {
    write('part.py', BOX);
    const s = spec('part.py', { mode: 'no-result' });
    const { job } = await runSpec(s);
    writeFileSync(s.native.result!, JSON.stringify({ ok: true, run: s.native.run, script_sha256: sha(BOX), script_sha256_read: sha(BOX), files: {} }));
    const j = judgeFreecadJob(job, s);
    expect(j.outcome).toBe('unknown');
    expect(j.why).toMatch(/does not say whether the code that ran came from the copy kept at submission \(script_is_copy\)/);
  });

  it('after a restart the run is judged again from its own folder, the exit not recorded', async () => {
    write('part.py', BOX);
    const s = spec('part.py');
    await runSpec(s);
    const j = reconcileFreecad(root, s.native.run);
    expect(j.outcome, j.why).toBe('ok');
    expect(j.exit.state).toBe('unknown');
    expect(j.freecad.module).toBe(s.freecad.module);
    rmSync(path.join(root, s.native.copy!.path));
    expect(reconcileFreecad(root, s.native.run).outcome).toBe('unknown');
  });
});

describe.skipIf(!python)('the FreeCAD starter against the stand-in FreeCAD and Part modules', () => {
  async function starter(o: { args?: string[]; env?: NodeJS.ProcessEnv } = {}) {
    copyFileSync(path.join(REPO, 'templates', 'freecad-starter', 'plate.py'), path.join(root, 'plate.py'));
    const s = spec('plate.py', { ...(o.args ? { args: o.args } : {}), ...(o.env ? { env: o.env } : {}) });
    const { job, m } = await runSpec(s);
    return { s, job, judged: judgeFreecadJob(job, s), r: result(s), log: m.tail(job.id, 40).join('\n') };
  }
  const plateVolume = (l: number, w: number, t: number, d: number): number => l * w * t - 4 * Math.PI * (d / 2) ** 2 * t;

  it('builds the plate from Part features, saves out/plate.FCStd, exports out/plate.step, checks itself, and is judged ok', async () => {
    const { s, job, judged, r, log } = await starter();
    expect(r.ok, log).toBe(true);
    expect(r.objects.map((o: Record<string, unknown>) => [o.name, o.type])).toEqual([
      ['Blank', 'Part::Box'], ['Hole1', 'Part::Cylinder'], ['Hole2', 'Part::Cylinder'], ['Hole3', 'Part::Cylinder'], ['Hole4', 'Part::Cylinder'], ['Holes', 'Part::MultiFuse'], ['Plate', 'Part::Cut'],
    ]);
    expect(r.documents).toEqual([{ name: 'Plate', label: 'Plate', file: 'out/plate.FCStd', objects: 7 }]);
    expect(r.parameters).toEqual({ length: 100, width: 60, thickness: 6, hole_diameter: 6.5, inset: 8 });
    expect(r.checks.map((c: Record<string, unknown>) => [c.label, c.passed])).toEqual([['plate bounds', true], ['plate analytic volume', true], ['plate is one valid solid', true]]);
    expect(r.exports[0]).toMatchObject({ path: 'out/plate.step', objects: ['Plate'], shape: { valid: true, solids: 1, bounds: { min: [0, 0, 0], max: [100, 60, 6] } } });
    expect(r.exports[0].shape.volume_mm3).toBeCloseTo(plateVolume(100, 60, 6, 6.5), 9);
    expect(judged.outcome, judged.why).toBe('ok');
    expect(judged.freecad.checks).toEqual([{ label: 'plate bounds', passed: true }, { label: 'plate analytic volume', passed: true }, { label: 'plate is one valid solid', passed: true }]);
    // The FAKE .FCStd is a zip holding the stand-in's Document.xml (the feature tree, no shapes).
    const fcstd = readFileSync(path.join(root, 'out', 'plate.FCStd'));
    expect(fcstd.subarray(0, 2).toString()).toBe('PK');
    expect(fcstd.toString('latin1')).toMatch(/type="Part::Cut" name="Plate"/);
    const lines = text(freecadEndLines(judged, s, { id: job.id, label: job.label, glyphs: glyphSet(true), sep: ' · ', scrub: (t) => t, receipt: 'abc123', readback: { ready: false, why: 'TIMMY_CADQUERY_PYTHON is not set' } }));
    expect(lines).toMatch(/out\/plate\.FCStd · created by this run · sha256 [0-9a-f]{12}… \(Timmy's, after the run\)/);
    expect(lines).toMatch(/FreeCAD 1\.0\.0: 7 objects in Plate · FreeCAD's own report of its own document, in the process that built it/);
    expect(lines).toMatch(/out\/plate\.step holds Plate: 1 valid solid, 100 x 60 x 6 mm, 35,203\.6\d* mm3 · FreeCAD's numbers/);
    expect(lines).toMatch(/the script's own: 3 of 3 passed/);
    expect(lines).toContain(DOCTRINE_15);
    expect(lines).toMatch(new RegExp(`/freecad readback ${s.native.run.slice(0, 8)} reads out/plate\\.step back in its own process .*\\(first: TIMMY_CADQUERY_PYTHON is not set\\)`));
  });

  it('takes its parameters from TIMMY_SCRIPT_ARGS', async () => {
    const { judged, r } = await starter({ args: ['--length', '120', '--hole_diameter=5'] });
    expect(judged.outcome, judged.why).toBe('ok');
    expect(r.args).toEqual(['--length', '120', '--hole_diameter=5']);
    expect(r.parameters).toMatchObject({ length: 120, hole_diameter: 5 });
    expect(r.exports[0].shape.bounds.max).toEqual([120, 60, 6]);
    expect(r.exports[0].shape.volume_mm3).toBeCloseTo(plateVolume(120, 60, 6, 5), 9);
  });

  it('refuses a hole that would leave the plate: ok: false with the reason, nothing built', async () => {
    const { judged, r } = await starter({ args: ['--inset', '3'] });
    expect(r).toMatchObject({ ok: false, files: {} });
    expect(r.error).toMatch(/inset 3 leaves less than 1 mm between a hole of diameter 6\.5 and the edge/);
    expect(judged.outcome).toBe('failed');
    expect(existsSync(path.join(root, 'out', 'plate.FCStd'))).toBe(false);
  });

  it('a feature recompute leaves in error ends the run ok: false naming it (FreeCAD marks it, it does not raise)', async () => {
    const { judged, r } = await starter({ env: { FREECAD_STUB_FAIL: 'Holes' } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/recompute left 2 objects in error: Holes \(Invalid\); Plate \(Invalid\)/);
    expect(judged.outcome).toBe('failed');
  });

  it('a FreeCAD without optimalBoundingBox: the bounds come from Shape.BoundBox, and the result says so', async () => {
    const { judged, r } = await starter({ env: { FREECAD_STUB_NO_OPTIMAL: '1' } });
    expect(judged.outcome, judged.why).toBe('ok');
    expect(r.exports[0].shape.bounds.method).toBe('FreeCAD Shape.BoundBox');
  });

  it('a check that fails ends the run ok: false with the numbers, after the document and the STEP are written', async () => {
    const { judged, r } = await starter({ env: { FREECAD_STUB_INVALID: '1' } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Failed: 1 of 3 checks failed: plate is one valid solid');
    expect(r.checks[2]).toMatchObject({ label: 'plate is one valid solid', passed: false, detail: { valid: false, solids: 1 } });
    expect(Object.keys(r.files).sort()).toEqual(['out/plate.FCStd', 'out/plate.step']);
    expect(judged.outcome).toBe('failed');
  });

  it('without the helper it still leaves a result that says what is missing', async () => {
    const empty = path.join(tmp, 'no-helper');
    mkdirSync(empty);
    const { judged, r } = await starter({ env: { TIMMY_FREECAD_LIB: empty } });
    expect(String(r.error)).toMatch(/timmy_freecad\.py was not found/);
    expect(judged.outcome).toBe('failed');
  });
});

describe('the readback comparison', () => {
  const reported: FreecadReadbackPlan['reported'] = { type: 'Solid', valid: true, solids: 1, volume_mm3: 35203.6, bounds: { min: [0, 0, 0], max: [100, 60, 6], size: [100, 60, 6] } };
  const measured = (o: Partial<ReadbackMeasured> = {}): ReadbackMeasured => ({
    ok: true, worker: { name: 'w', version: '1' }, source: { name: 'out/plate.step', sha256: 'a'.repeat(64), bytes: 1 }, valid: true, solids: 1,
    bounds: { min: [0, 0, 0], max: [100, 60, 6], size: [100, 60, 6] }, volume_mm3: 35203.6, ...o,
  });

  it('matches within /iterate\'s tolerance; each corner, the solids, validity and the volume are checked with their numbers', () => {
    const c = compareFreecadReadback(reported, measured({ volume_mm3: 35203.6 * (1 + 5e-9), bounds: { min: [0, 0, 0], max: [100 + 5e-7, 60, 6], size: [100, 60, 6] } }));
    expect(c.verdict).toBe('matches');
    expect(c.checks.map((x) => x.name)).toEqual(['valid shape', 'solids', 'bounds min x (mm)', 'bounds min y (mm)', 'bounds min z (mm)', 'bounds max x (mm)', 'bounds max y (mm)', 'bounds max z (mm)', 'volume (mm3)']);
    expect(c.checks.find((x) => x.name === 'bounds max x (mm)')).toMatchObject({ reported: 100, measured: 100 + 5e-7, tolerance: `${READBACK_TOLERANCE.bounds_mm} mm`, passed: true });
  });

  it('differs past it, or when either side is not a valid shape, or the solid count differs', () => {
    expect(compareFreecadReadback(reported, measured({ volume_mm3: 35204.6 })).verdict).toBe('differs');
    expect(compareFreecadReadback(reported, measured({ bounds: { min: [0, 0, 0], max: [100.5, 60, 6], size: [100.5, 60, 6] } })).checks.filter((x) => !x.passed).map((x) => x.name)).toEqual(['bounds max x (mm)']);
    expect(compareFreecadReadback(reported, measured({ valid: false })).checks.filter((x) => !x.passed).map((x) => x.name)).toEqual(['valid shape']);
    expect(compareFreecadReadback({ ...reported, valid: false }, measured()).verdict).toBe('differs');
    expect(compareFreecadReadback(reported, measured({ solids: 2 })).verdict).toBe('differs');
  });

  it('the sentence the readback and the run show beside dimensions is DOCTRINE §15, verbatim', () => {
    expect(DOCTRINE_15).toBe(RECIPE_DOCTRINE_15);
    expect(DOCTRINE_15).toBe('Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.');
  });
});

/** A Workspace whose /freecad finds the FAKE freecadcmd through a wrapper (it sets the stand-in modules itself). */
function workspace(o: { readback?: string; env?: Record<string, string> } = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const wrapper = path.join(tmp, 'bin', 'freecadcmd-wrapper');
  mkdirSync(path.dirname(wrapper), { recursive: true });
  writeFileSync(wrapper, `#!/bin/sh\n# a TEST wrapper: the FAKE freecadcmd with the stand-in FreeCAD and Part modules\nPYTHONPATH='${STUB}' FAKE_FREECAD_PYTHON='${python}' FAKE_FREECAD_MODE=python PYTHONDONTWRITEBYTECODE=1 exec '${process.execPath}' '${FAKE_FREECADCMD}' "$@"\n`, { mode: 0o755 });
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env: { TIMMY_FREECADCMD: wrapper, ...(o.env ?? {}) },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: path.join(tmp, 'ws-jobs'),
    chdir: () => {},
    // FAKE: the readback test double instead of TIMMY_CADQUERY_PYTHON workers/readback/step_readback.py.
    ...(o.readback ? { freecadTest: { readback: (step: { abs: string; rel: string }) => ({ command: process.execPath, args: [FAKE_READBACK, o.readback!, step.abs, '--as', step.rel] }) } } : {}),
  };
  const ws = new Workspace(deps, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed };
}
const jobIn = (out: string, word: string): string => { const m = new RegExp(`${word}\\s+(j[0-9a-f]{6})`).exec(out); if (!m) throw new Error(`no job in: ${out}`); return m[1]; };

describe.skipIf(!python)('/freecad in the workspace, and /freecad readback', () => {
  async function plate(w: ReturnType<typeof workspace>) {
    copyFileSync(path.join(REPO, 'templates', 'freecad-starter', 'plate.py'), path.join(root, 'plate.py'));
    const out = text(await w.ws.freecad('plate.py'));
    expect(out).toMatch(/App\s+freecadcmd, headless · it runs \.timmy\/native\/[0-9a-f-]{36}\/source\/timmy_[0-9a-f]{8}_plate\.py, a read-only copy of plate\.py/);
    const id = jobIn(out, 'Running');
    await until(() => w.notes.some((n) => n.includes(`${id} ok`) || n.includes(`${id} failed`) || n.includes(`${id} unknown`)));
    const run = readNativeRecord(root, w.sealed.find((r) => r.kind === 'native')!.native!.run!)!;
    return { id, run: run.job.run, out };
  }

  it('/freecad plate.py runs as a judged job: the end notice says each file, FreeCAD\'s own report with DOCTRINE §15, and offers the readback; the receipt carries the report', async () => {
    const w = workspace({ readback: 'match' });
    const { id, run } = await plate(w);
    const notice = w.notes.join('\n');
    expect(notice).toMatch(new RegExp(`${id} ok  FreeCAD · plate\\.py: the result file is this run's`));
    expect(notice).toMatch(/exported out\/plate\.step · created by this run/);
    expect(notice).toMatch(/out\/plate\.step holds Plate: 1 valid solid, 100 x 60 x 6 mm/);
    expect(notice).toContain(DOCTRINE_15);
    expect(notice).toMatch(new RegExp(`/freecad readback ${run.slice(0, 8)} reads out/plate\\.step back in its own process`));
    const receipt = w.sealed.find((r) => r.kind === 'native')!;
    expect(receipt).toMatchObject({ status: 'ok', native: { app: 'freecad', outcome: 'ok', run } });
    expect((receipt.native as Record<string, any>).freecad).toMatchObject({ freecad_version: '1.0.0', script_is_copy: true, exports: [{ path: 'out/plate.step', reported: { geometry: { provenance: 'generated', evidence: 'constructed' } } }] });
    noTmp(JSON.stringify(w.sealed));
    // /freecad alone lists the run
    expect(text(await w.ws.freecad(''))).toMatch(new RegExp(`${run.slice(0, 8)}  ok · FreeCAD · plate\\.py`));
  });

  it('/freecad readback: the STEP read back in its own process matches FreeCAD\'s report; both are labelled, recorded beside the run and sealed', async () => {
    const w = workspace({ readback: 'match' });
    const { run } = await plate(w);
    const out = text(await w.ws.freecad('readback'));
    expect(out).toMatch(new RegExp(`reads out/plate\\.step \\(sha256 [0-9a-f]{12}…, as FreeCAD run ${run.slice(0, 8)} recorded it\\) in its own process`));
    expect(out).toMatch(/Compares\s+with FreeCAD's report of Plate: 1 valid solid, 100 x 60 x 6 mm/);
    expect(out).toContain(DOCTRINE_15);
    const rb = jobIn(out, 'Readback');
    await until(() => w.notes.some((n) => n.includes(`${rb} readback`)));
    const notice = w.notes.slice(w.notes.findIndex((n) => n.includes(`${rb} readback`))).join('\n');
    expect(notice).toMatch(new RegExp(`${rb} readback matches  out/plate\\.step · FreeCAD run ${run.slice(0, 8)} · receipt id\\d+ · record \\.timmy/native/${run}/readbacks\\.jsonl`));
    expect(notice).toMatch(/FreeCAD reported   1 valid solid, 100 x 60 x 6 mm, 35,203\.\d+ mm3 · FreeCAD 1\.0\.0: FreeCAD's own report of its own document/);
    expect(notice).toMatch(/readback measured  1 valid solid, 100 x 60 x 6 mm, 35,203\.\d+ mm3 · fake-step-readback 0\.0\.0-fake \(a FAKE readback, not a measurement\), from the file's bytes/);
    expect(notice).toMatch(/within 1e-6 mm and 1e-8 relative: matches · both are OpenCascade/);
    expect(notice).toContain(DOCTRINE_15);
    const [line] = readReadbacks(path.join(root, '.timmy', 'native', run));
    expect(line).toMatchObject({ readback: 1, run, job: rb, state: 'completed', verdict: 'matches', step: { path: 'out/plate.step' }, log: `.timmy/native/${run}/readback-${rb}.log` });
    expect(line.measured).toMatchObject({ geometry: { provenance: 'generated', evidence: 'checked' }, units: 'mm' });
    expect(line.reported).toMatchObject({ geometry: { provenance: 'generated', evidence: 'constructed' }, measured_by: "FreeCAD's own report of its own document, in the process that built it" });
    expect(readFileSync(path.join(root, line.log!), 'utf8')).toMatch(/FAKE readback: numbers copied/);
    const receipt = w.sealed.find((r) => r.kind === 'readback')!;
    const freecadReceipt = `id${w.sealed.findIndex((r) => r.kind === 'native') + 1}`;
    expect(receipt).toMatchObject({ status: 'ok', child_receipts: [freecadReceipt], outputs: [{ path: line.log }] });
    expect((receipt.sources as Array<Record<string, any>>)[0]).toEqual({ path: 'out/plate.step', sha256: sha(readFileSync(path.join(root, 'out', 'plate.step'))), role: 'read' });
    expect((receipt.sources as Array<Record<string, any>>)[1]).toMatchObject({ freecad_run: run, verdict: 'matches', units: 'mm', doctrine: DOCTRINE_15 });
    noTmp(JSON.stringify(w.sealed));
  });

  it('a readback that differs says which numbers, with both values; a failed worker keeps its output; neither is a match', async () => {
    const w = workspace({ readback: 'differ' });
    await plate(w);
    const rb = jobIn(text(await w.ws.freecad('readback')), 'Readback');
    await until(() => w.notes.some((n) => n.includes(`${rb} readback`)));
    const notice = w.notes.join('\n');
    expect(notice).toMatch(new RegExp(`${rb} readback differs  out/plate\\.step: bounds max x \\(mm\\): FreeCAD reported 100, the readback measured 100\\.5 \\(difference 0\\.500\\); volume \\(mm3\\): FreeCAD reported 35203\\.\\d+, the readback measured 35204\\.\\d+ \\(difference 1\\.00\\)`));
    expect(w.sealed.find((r) => r.kind === 'readback')).toMatchObject({ status: 'failed', discrepancies: [expect.stringMatching(/^bounds max x/), expect.stringMatching(/^volume/)] });

    // A fresh out/: the same plate again would write the same bytes, which Timmy judges reused (not this run's work).
    rmSync(path.join(root, 'out'), { recursive: true, force: true });
    const f = workspace({ readback: 'fail' });
    const run = (await plate(f)).run;
    const failed = jobIn(text(await f.ws.freecad(`readback ${run.slice(0, 8)}`)), 'Readback');
    await until(() => f.notes.some((n) => n.includes(`${failed} readback`)));
    expect(f.notes.join('\n')).toMatch(new RegExp(`${failed} readback failed  out/plate\\.step: not-step: FAKE: OpenCascade could not read the file as STEP \\(exit 2\\)`));
    expect(readReadbacks(path.join(root, '.timmy', 'native', run)).at(-1)).toMatchObject({ verdict: 'failed', reason: expect.stringMatching(/^not-step/) });
  });

  it('/stop on a readback: recorded with no verdict, sealed as cancelled', async () => {
    const w = workspace({ readback: 'sleep' });
    const { run } = await plate(w);
    const rb = jobIn(text(await w.ws.freecad('readback')), 'Readback');
    await until(() => w.ws.jobs.get(rb)?.state === 'running');
    await w.ws.stop(rb);
    await until(() => readReadbacks(path.join(root, '.timmy', 'native', run)).length > 0);
    const [line] = readReadbacks(path.join(root, '.timmy', 'native', run));
    expect(line).toMatchObject({ job: rb, state: 'cancelled', reason: 'stopped with /stop before it finished: no verdict' });
    expect(line.verdict).toBeUndefined();
    expect(line.measured).toBeUndefined();
    expect(w.sealed.find((r) => r.kind === 'readback')).toMatchObject({ status: 'cancelled' });
  });

  it('refuses to read back a STEP whose bytes changed since the run, a run not judged ok, and an unknown run; nothing starts', async () => {
    const w = workspace({ readback: 'match' });
    const { run } = await plate(w);
    expect(text(await w.ws.freecad('readback 0000ffff'))).toMatch(/Not started: no FreeCAD run 0000ffff in this project/);
    writeFileSync(path.join(root, 'out', 'plate.step'), 'edited after the run\n');
    const before = w.ws.jobs.list().length;
    expect(text(await w.ws.freecad('readback'))).toMatch(new RegExp(`Not started: out/plate\\.step has changed since run ${run.slice(0, 8)} \\(sha256 now [0-9a-f]{12}…, the run recorded [0-9a-f]{12}…\\): reading it back would not measure what FreeCAD reported`));
    expect(w.ws.jobs.list().length).toBe(before);
    // A run judged failed is not read back.
    rmSync(path.join(root, 'out'), { recursive: true, force: true });
    write('broken.py', BOX.replace('    doc = run.new_document("Box")', '    raise ValueError("no part (a test)")'));
    const id = jobIn(text(await w.ws.freecad('broken.py')), 'Running');
    await until(() => w.notes.some((n) => n.includes(`${id} failed`)));
    const broken = w.sealed.filter((r) => r.kind === 'native').at(-1)!.native!.run!;
    expect(text(await w.ws.freecad(`readback ${broken.slice(0, 8)}`))).toMatch(new RegExp(`Not started: run ${broken.slice(0, 8)} was judged failed: the script reported ok: false: ValueError: no part \\(a test\\)`));
  });

  it('without a readback Python nothing starts and the setup is said; with this machine\'s python3 (no OCP) the real worker runs and fails, recorded', async () => {
    const w = workspace();
    const { run } = await plate(w);
    expect(w.notes.join('\n')).toMatch(/\(first: TIMMY_CADQUERY_PYTHON is not set: set TIMMY_CADQUERY_PYTHON to the absolute path of a Python with CadQuery/);
    expect(text(await w.ws.freecad('readback'))).toMatch(/Not started: TIMMY_CADQUERY_PYTHON is not set: set TIMMY_CADQUERY_PYTHON/);
    const real = workspace({ env: { TIMMY_CADQUERY_PYTHON: python } });
    const out = text(await real.ws.freecad(`readback ${run.slice(0, 8)}`));
    const rb = jobIn(out, 'Readback');
    await until(() => real.notes.some((n) => n.includes(`${rb} readback`)));
    const line = readReadbacks(path.join(root, '.timmy', 'native', run)).at(-1)!;
    // The real worker (workers/readback/step_readback.py) ran with python3: without OCP it says so; with OCP it cannot read the FAKE STEP.
    expect(line).toMatchObject({ verdict: 'failed', job: rb });
    expect(line.reason).toMatch(/^(no-ocp|not-step|read-failed|no-shape)/);
    expect(line.worker?.name).toBe('timmy-step-readback');
    expect(real.sealed.find((r) => r.kind === 'readback')).toMatchObject({ status: 'failed' });
  });
});

describe('the FreeCAD row, run_native and the command', () => {
  it('a /tools row of its own: needs setup with the step; installed and "implemented; not run" when found; exercised only by a sealed run of its own judged ok', () => {
    const none = nativeCapabilityRows({}, { platform: 'linux', onPath: () => null }).find((r) => r.id === 'freecad')!;
    expect(none).toMatchObject({ kind: 'adapter', name: 'FreeCAD (freecadcmd, headless)', rung: 'needs setup', exercisedBy: 'native:freecad', tools: ['run_native'] });
    expect(none.setup).toMatch(/TIMMY_FREECADCMD/);
    expect(none.detail).toMatch(/implemented; not run/);
    const bin = install('fake-freecadcmd.mjs', path.join(tmp, 'bin', 'freecadcmd'));
    const found = nativeCapabilityRows({ TIMMY_FREECADCMD: bin }, { platform: 'linux', onPath: () => null }).find((r) => r.id === 'freecad')!;
    expect(found.rung).toBe('installed');
    expect(found.detail).toMatch(/^freecadcmd at TIMMY_FREECADCMD; implemented; not run; runs a Python script headless \(\/freecad\): an editable \.FCStd and a STEP export/);
    const sealedRun = (ts: string, app: string, outcome: string, status?: string) => ({ kind: 'native', ts, hash: `sha256_${ts}`, ...(status ? { status } : {}), native: { app, outcome, why: 'why', exit_code: 0, signal: null, files: [] } });
    const blenderOnly = nativeRunIndex([sealedRun('2026-10-09T09:00:00Z', 'blender', 'ok', 'ok')]);
    expect(nativeExercisedAt('native:freecad', blenderOnly)).toBeUndefined();
    const index = nativeRunIndex([sealedRun('2026-10-09T10:00:00Z', 'freecad', 'ok', 'ok')]);
    expect(nativeExercisedAt('native:freecad', index)).toBe('2026-10-09T10:00:00Z');
    expect(nativeCapabilityRows({ TIMMY_FREECADCMD: bin }, { platform: 'linux', onPath: () => null }, index).find((r) => r.id === 'freecad')!.detail).toMatch(/last run ok, 2026-10-09T10:00:00Z/);
  });

  it('run_native starts a FreeCAD job with app freecad (the operator is asked first) and returns at once', async () => {
    write('part.py', BOX);
    const m = manager();
    const bin = install('fake-freecadcmd.mjs', path.join(tmp, 'bin', 'freecadcmd'));
    const [run] = createNativeTools({ root: () => root, project: () => 'demo', start: (s) => m.start(s), find: { freecad: () => ({ app: 'freecad', path: bin, how: 'env' }) }, env: { FAKE_FREECAD_MODE: 'no-result' } });
    const call = (run.function as unknown as { execute: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }).execute;
    expect(await call({ app: 'freecad' })).toMatchObject({ ok: false, error: expect.stringMatching(/freecad needs script/) });
    const answer = await call({ app: 'freecad', script: 'part.py', args: ['--length', '30'] });
    expect(answer).toMatchObject({ ok: true, app: 'freecad', result_file: `.timmy/native/${answer.run}/result.json`, module: `timmy_${String(answer.run).slice(0, 8)}_part` });
    expect(String(answer.note)).toMatch(/run_script\(main\) at the top level/);
    const job = await m.done(answer.job as string);
    expect(job.args).toEqual([path.join(root, '.timmy', 'native', String(answer.run), 'source', `timmy_${String(answer.run).slice(0, 8)}_part.py`)]);
    expect(approvalNeeded('run_native', { app: 'freecad', script: 'part.py' })).toMatchObject({ reason: expect.stringMatching(/FreeCAD/) });
  });

  it('/freecad is a workspace command, its help line within 60 columns', () => {
    const c = COMMANDS.find((x) => x.name === 'freecad');
    expect(c).toMatchObject({ group: 'work' });
    expect(`  /${c!.name.padEnd(11)} ${c!.description}`.length).toBeLessThanOrEqual(60);
  });
});

describe('planning a readback without a judged run', () => {
  it('says there is nothing to read back yet', () => {
    expect(planFreecadReadback(root)).toEqual({ ok: false, error: 'no FreeCAD run in this project yet: /freecad <script.py> makes one' });
    expect(planFreecadReadback(root, { run: 'zz' })).toMatchObject({ ok: false, error: expect.stringMatching(/not a run token/) });
  });
});
