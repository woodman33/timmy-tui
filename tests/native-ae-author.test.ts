/**
 * Round R4 (helper H23): After Effects authoring and editing (/ae author, /ae edit, /ae inspect; run_native app
 * afterfx). Everything here runs against a TEST DOUBLE, tests/fixtures/fake-afterfx.mjs: a Node program standing in
 * for osascript or the After Effects program, which runs the harness Timmy generates (and the starter scripts) on a
 * small stand-in of After Effects' scripting objects, and saves FAKE projects. No After Effects runs in this suite:
 * a pass says Timmy's side (the run's folder, the harness, the judgement, the REPL and the agent tool) holds, not
 * that After Effects was driven.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNativeTools } from '../src/agent/native-tools.js';
import { capabilities, type CapabilityRow, type ProbeDeps } from '../src/capabilities/index.js';
import { JobManager, type JobRecord } from '../src/jobs/index.js';
import {
  AE_LIMITS, AE_PREF_OFF, aeHarness, aeHarnessConfig, aeReceiptFields, aeRouteFor, aeScriptJob, aeStem, appBundleName, isAeJobSpec, judgeAeJob, osascriptArgs,
  parseAeScriptArgs, reconcileAe, type AeJobSpec, type AeScriptJobInput,
} from '../src/native/ae-author.js';
import { locateNative, nativeCapabilityRows, nativeRunIndex, noteNativeStarted, readNativeRecord, type NativeJobSpec } from '../src/native/index.js';
import { approvalNeeded } from '../src/repl/approvals.js';
import { folderProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { ReceiptInput } from '../src/utils/receipts.js';

const REPO = path.resolve(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-afterfx.mjs');
let tmp = '';
let root = '';
let managers: JobManager[] = [];
let spaces: Workspace[] = [];

beforeEach(() => {
  // resolved: on macOS the temp folder is reached through a link, and the job specs resolve the project folder
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'timmy-ae-')));
  root = path.join(tmp, 'project');
  mkdirSync(root, { recursive: true });
  for (const f of ['author.jsx', 'edit.jsx']) copyFileSync(path.join(REPO, 'templates', 'ae-starter', f), path.join(root, f));
  managers = [];
  spaces = [];
});
afterEach(async () => {
  for (const w of spaces) await w.close();
  for (const m of managers) await m.stopAll();
  rmSync(tmp, { recursive: true, force: true });
});

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
/** An executable copy of the fake at `at` (made executable here, whatever the checkout's modes). */
function install(at: string): string {
  mkdirSync(path.dirname(at), { recursive: true });
  copyFileSync(FAKE, at);
  chmodSync(at, 0o755);
  return at;
}
const fakeAe = (): string => install(path.join(tmp, 'bin', 'AfterFX'));
function manager(): JobManager {
  const m = new JobManager({ dir: path.join(tmp, 'jobs') });
  managers.push(m);
  return m;
}
/** A run on the -r route with the fake as the After Effects program; FAKE_AE_MODE picks what the fake does. */
function job(mode: AeScriptJobInput['mode'], extra: Partial<AeScriptJobInput> = {}, fake = 'ok'): AeJobSpec {
  return aeScriptJob({ mode, root, project: 'demo', timeoutMs: 20_000, bin: fakeAe(), env: { FAKE_AE_MODE: fake }, ...extra });
}
/** A run on the macOS route: the program found inside an .app bundle (never run), the fake standing in for osascript. */
function macJob(mode: AeScriptJobInput['mode'], extra: Partial<AeScriptJobInput> = {}, fake = 'ok'): AeJobSpec {
  const exe = install(path.join(tmp, 'Applications', 'Adobe After Effects 2026', 'Adobe After Effects 2026.app', 'Contents', 'MacOS', 'After Effects'));
  return aeScriptJob({ mode, root, project: 'demo', timeoutMs: 20_000, bin: exe, platform: 'darwin', osascript: install(path.join(tmp, 'bin', 'osascript')), env: { FAKE_AE_MODE: fake }, ...extra });
}
async function run(spec: NativeJobSpec): Promise<{ m: JobManager; job: JobRecord; out: string }> {
  const m = manager();
  const done = await m.done(m.start(spec).id);
  return { m, job: done, out: m.tail(done.id, 200).join('\n') };
}
async function authored(name = 'promo'): Promise<string> {
  const a = job('author', { script: 'author.jsx', name });
  expect(judgeAeJob((await run(a)).job, a).outcome).toBe('ok');
  return path.join(root, 'out', 'ae', `${name}-v1.aep`);
}

describe('finding After Effects, and how Timmy asks it', () => {
  const none = { onPath: () => null };

  it('takes TIMMY_AFTERFX first (an .app opened to Contents/MacOS/After Effects), then /Applications newest first, never past a broken setting', () => {
    const apps = path.join(tmp, 'Applications');
    const exe = (v: string): string => install(path.join(apps, `Adobe After Effects ${v}`, `Adobe After Effects ${v}.app`, 'Contents', 'MacOS', 'After Effects'));
    exe('2025');
    const newest = exe('2026');
    mkdirSync(path.join(apps, 'Adobe After Effects 2027'), { recursive: true }); // a folder without the application is passed over
    expect(locateNative('afterfx', {}, { platform: 'darwin', applications: apps, ...none }).found).toMatchObject({ app: 'afterfx', path: newest, how: 'applications', version: '2026' });
    const bundle = path.join(apps, 'Adobe After Effects 2025', 'Adobe After Effects 2025.app');
    expect(locateNative('afterfx', { TIMMY_AFTERFX: bundle }, { platform: 'darwin', applications: apps, ...none }).found)
      .toMatchObject({ path: path.join(bundle, 'Contents', 'MacOS', 'After Effects'), how: 'env' });
    const broken = locateNative('afterfx', { TIMMY_AFTERFX: path.join(tmp, 'nowhere.app') }, { platform: 'darwin', applications: apps, ...none });
    expect(broken.found).toBeNull();
    expect(broken.problem).toMatch(/TIMMY_AFTERFX/);
    expect(locateNative('afterfx', {}, { platform: 'linux', applications: apps, ...none }).found).toBeNull();
  });

  it('asks through osascript on macOS when the program is inside an .app (by its name), with -r otherwise; AppleScript strings are quoted', () => {
    const mac = '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects';
    expect(appBundleName(mac)).toBe('Adobe After Effects 2026');
    expect(aeRouteFor(mac, 'darwin')).toEqual({ route: 'osascript', appName: 'Adobe After Effects 2026' });
    expect(aeRouteFor(mac, 'linux')).toEqual({ route: 'binary' });
    expect(aeRouteFor('C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe', 'win32')).toEqual({ route: 'binary' });
    expect(osascriptArgs('Adobe After Effects 2026', '/p/a "q"\\b.jsx', 600)).toEqual([
      '-e', 'with timeout of 600 seconds', '-e', 'tell application "Adobe After Effects 2026" to DoScriptFile "/p/a \\"q\\"\\\\b.jsx"', '-e', 'end timeout',
    ]);
  });

  it('reads /ae words and names projects safely', () => {
    expect(parseAeScriptArgs(['author', 'a.jsx', '--name', 'Promo Spot'])).toEqual({ mode: 'author', script: 'a.jsx', name: 'Promo Spot' });
    expect(parseAeScriptArgs(['author', 'a.jsx', '--name=spot'])).toEqual({ mode: 'author', script: 'a.jsx', name: 'spot' });
    expect(parseAeScriptArgs(['author'])).toEqual({ error: expect.stringMatching(/^Usage: \/ae author <script\.jsx>/) });
    expect(parseAeScriptArgs(['edit', 'x.aep', 'e.jsx'])).toEqual({ mode: 'edit', projectFile: 'x.aep', script: 'e.jsx' });
    expect(parseAeScriptArgs(['inspect', 'x.aep'])).toEqual({ mode: 'inspect', projectFile: 'x.aep' });
    expect(parseAeScriptArgs(['title.aep', 'Main', 'out/t.mov'])).toBeUndefined();
    expect([aeStem('Promo Spot'), aeStem('promo-v12.aep'), aeStem('../../etc'), aeStem('...'), aeStem('author.jsx')]).toEqual(['Promo-Spot', 'promo', 'etc', 'project', 'author']);
  });
});

describe('the run\'s folder: an immutable, hashed harness and script', () => {
  it('writes the script byte for byte and the harness read-only, records their sha256, and keeps the project folder out of its records', () => {
    const s = job('author', { script: 'author.jsx' });
    const dir = path.join(root, '.timmy', 'native', s.native.run);
    const harness = readFileSync(path.join(dir, 'harness.jsx'), 'utf8');
    expect(sha(path.join(dir, 'harness.jsx'))).toBe(s.ae.harness.sha256);
    expect(statSync(path.join(dir, 'harness.jsx')).mode & 0o222).toBe(0);
    expect(readFileSync(path.join(dir, 'script.jsx'))).toEqual(readFileSync(path.join(root, 'author.jsx')));
    expect(statSync(path.join(dir, 'script.jsx')).mode & 0o222).toBe(0);
    expect(aeHarnessConfig(harness)).toEqual({
      v: 1, run: s.native.run, mode: 'author', root, result: path.join(dir, 'result.json'), script: path.join(dir, 'script.jsx'), script_dir: root,
      input_sha256: sha(path.join(root, 'author.jsx')), open: null, open_rel: null, save: path.join(root, 'out', 'ae', 'author-v1.aep'), save_rel: 'out/ae/author-v1.aep', limits: AE_LIMITS,
    });
    expect(/^[\t\n\r\x20-\x7e]*$/.test(harness)).toBe(true);
    const ae = JSON.parse(readFileSync(path.join(dir, 'ae.json'), 'utf8'));
    expect(ae).toMatchObject({
      record: 'timmy-ae-run', run: s.native.run, mode: 'author', route: 'binary', name: 'author', version: 1, saved: 'out/ae/author-v1.aep',
      harness: { path: `.timmy/native/${s.native.run}/harness.jsx`, sha256: s.ae.harness.sha256 }, script: { source: 'author.jsx', copy: `.timmy/native/${s.native.run}/script.jsx` },
    });
    const record = JSON.parse(readFileSync(path.join(dir, 'job.json'), 'utf8'));
    expect(record).toMatchObject({ app: 'afterfx', input: { path: 'author.jsx', sha256: sha(path.join(root, 'author.jsx')) }, expect: ['out/ae/author-v1.aep'], pre: { 'out/ae/author-v1.aep': { state: 'absent' } } });
    expect(record.args).toEqual(['-r', `./.timmy/native/${s.native.run}/harness.jsx`]);
    expect(JSON.stringify(ae)).not.toContain(tmp);
    expect(JSON.stringify(record.args)).not.toContain(tmp);
    expect(existsSync(path.join(root, 'out', 'ae'))).toBe(true);
  });

  it('refuses what it cannot run: a missing or outside script, a project that is not .aep or .aepx, or none', () => {
    expect(() => job('author', { script: 'missing.jsx' })).toThrow(/no script at missing\.jsx/);
    expect(() => job('author', { script: '../elsewhere.jsx' })).toThrow(/outside the project/);
    writeFileSync(path.join(root, 'notes.txt'), 'x');
    expect(() => job('author', { script: 'notes.txt' })).toThrow(/not an After Effects script/);
    expect(() => job('edit', { projectFile: 'notes.txt', script: 'edit.jsx' })).toThrow(/not an After Effects project/);
    expect(() => job('edit', { projectFile: 'missing.aep', script: 'edit.jsx' })).toThrow(/no project file at missing\.aep/);
    expect(() => job('inspect', {})).toThrow(/needs the project/);
    expect(() => aeScriptJob({ mode: 'author', script: 'author.jsx', root, project: 'demo', findEnv: {}, seams: { platform: 'linux', onPath: () => null } })).toThrow(/After Effects \(scripting\) was not found/);
  });

  it('a project folder with spaces and letters outside ASCII: the harness stays ASCII and finds every path', async () => {
    root = path.join(tmp, 'Pröject Ü');
    mkdirSync(root);
    copyFileSync(path.join(REPO, 'templates', 'ae-starter', 'author.jsx'), path.join(root, 'author.jsx'));
    const s = job('author', { script: 'author.jsx', name: 'spot' });
    expect(/^[\t\n\r\x20-\x7e]*$/.test(readFileSync(s.ae.harness.path, 'utf8'))).toBe(true);
    expect(judgeAeJob((await run(s)).job, s).outcome).toBe('ok');
    expect(existsSync(path.join(root, 'out', 'ae', 'spot-v1.aep'))).toBe(true);
  });
});

describe('author', () => {
  it('ok: the result is this run\'s, the new version was created by it and hashed by Timmy, and After Effects reports the comps, layers and keyframes', async () => {
    const s = job('author', { script: 'author.jsx', name: 'promo' });
    expect(s.args).toEqual(['-r', path.join(root, '.timmy', 'native', s.native.run, 'harness.jsx')]);
    expect(s.ae.saved?.rel).toBe('out/ae/promo-v1.aep');
    const { job: done, out } = await run(s);
    expect(done.state).toBe('completed');
    expect(out).toMatch(/fake-afterfx \(FAKE After Effects\): started with -r harness\.jsx/);
    const j = judgeAeJob(done, s);
    const aep = path.join(root, 'out', 'ae', 'promo-v1.aep');
    expect(j.outcome).toBe('ok');
    expect(j.why).toMatch(/^the result file is this run's, from author\.jsx as submitted, and says ok; out\/ae\/promo-v1\.aep was created by this run \(sha256 [0-9a-f]{12}…, computed by Timmy after the run\)/);
    expect(j.why).toMatch(/After Effects exited 0/);
    expect(j.ae.saved).toEqual({ path: 'out/ae/promo-v1.aep', present: true, created: true, sha256: sha(aep), bytes: statSync(aep).size });
    expect(j.ae.harness).toEqual({ path: `.timmy/native/${s.native.run}/harness.jsx`, sha256: s.ae.harness.sha256, unchanged: true, read: s.ae.harness.sha256 });
    expect(j.ae.comps).toMatchObject([{
      name: 'Main', width: 1920, height: 1080, fps: 30, duration: 10, num_layers: 3,
      layers: [
        { index: 1, name: 'Mover', kind: 'solid', keyframes: [{ path: 'Transform > Position', match: 'ADBE Transform Group/ADBE Position', keys: 2 }] },
        { index: 2, name: 'Title', kind: 'text', text: 'Title' },
        { index: 3, name: 'Background', kind: 'solid' },
      ],
    }]);
    const result = JSON.parse(readFileSync(s.native.result!, 'utf8'));
    expect(result).toMatchObject({ timmy_ae: 1, ok: true, run: s.native.run, stage: 'done', saved: true, script_sha256: sha(path.join(root, 'author.jsx')), script_sha256_read: sha(path.join(root, 'author.jsx')), write_preference: 'on', files: {} });
    expect(result.error).toBeUndefined();
    const sealed = aeReceiptFields(j);
    expect(sealed.status).toBe('ok');
    expect(sealed.native).toMatchObject({ app: 'afterfx', outcome: 'ok', run: s.native.run, input: { path: 'author.jsx' }, ae: { mode: 'author', route: 'binary', saved: { path: 'out/ae/promo-v1.aep', sha256: sha(aep) }, comps: 1, layers: 3 } });
    expect(JSON.stringify(sealed)).not.toContain(tmp);
    judgeAeJob(done, s); // the REPL judges twice (its notice, its receipt): one line
    expect(readNativeRecord(root, s.native.run)?.verdicts).toMatchObject([{ outcome: 'ok', job: done.id }]);
    expect(job('author', { script: 'author.jsx', name: 'promo' }).ae.saved?.rel).toBe('out/ae/promo-v2.aep');
  });

  it('on the macOS route: osascript asks the application by name inside a timeout, and the harness\'s line comes back through it', async () => {
    const s = macJob('author', { script: 'author.jsx' });
    expect(s.command).toBe(path.join(tmp, 'bin', 'osascript'));
    expect(s.args).toEqual(['-e', 'with timeout of 15 seconds', '-e', `tell application "Adobe After Effects 2026" to DoScriptFile "${s.ae.harness.path}"`, '-e', 'end timeout']);
    expect(JSON.parse(readFileSync(path.join(root, '.timmy', 'native', s.native.run, 'job.json'), 'utf8')).args[3])
      .toBe(`tell application "Adobe After Effects 2026" to DoScriptFile "./.timmy/native/${s.native.run}/harness.jsx"`);
    const { job: done, out } = await run(s);
    expect(out).toMatch(/osascript asked "Adobe After Effects 2026" to DoScriptFile harness\.jsx/);
    expect(out).toMatch(new RegExp(`^TIMMY-AE ${s.native.run} ok=true result=written$`, 'm'));
    const j = judgeAeJob(done, s);
    expect(j.outcome).toBe('ok');
    expect(j.ae).toMatchObject({ route: 'osascript', appName: 'Adobe After Effects 2026', status: `TIMMY-AE ${s.native.run} ok=true result=written` });
    expect(j.why).toMatch(/osascript exited 0/);
  });
});

describe('failures, each with its reason', () => {
  it('a script error: failed with the error and its line; the result file and the raw output are kept, and nothing is saved after the error', async () => {
    writeFileSync(path.join(root, 'broken.jsx'), "var comp = app.project.items.addComp('Main', 1920, 1080, 1, 10, 30);\nnotAFunction();\n");
    const s = job('author', { script: 'broken.jsx' });
    const { job: done, out } = await run(s);
    expect(done.state).toBe('completed');
    const j = judgeAeJob(done, s);
    expect(j.outcome).toBe('failed');
    expect(j.why).toMatch(/the script reported ok: false: ReferenceError: notAFunction is not defined/);
    expect(j.ae).toMatchObject({ stage: 'script', error_line: 2, error: 'ReferenceError: notAFunction is not defined' });
    expect(j.ae.comps).toMatchObject([{ name: 'Main', num_layers: 0 }]);
    const result = JSON.parse(readFileSync(s.native.result!, 'utf8'));
    expect(result).toMatchObject({ ok: false, stage: 'script', error_line: 2 });
    expect(result.saved).toBeUndefined();
    expect(out).toMatch(/FAKE After Effects/);
    expect(aeReceiptFields(j)).toMatchObject({ status: 'failed', native: { outcome: 'failed', ae: { stage: 'script', error_line: 2 } } });
  });

  it('no result file: unknown when the program exited 0 (the possible causes named, as possible), failed when it exited 1', async () => {
    const s = job('author', { script: 'author.jsx' }, 'no-run');
    const j = judgeAeJob((await run(s)).job, s);
    expect(j.outcome).toBe('unknown');
    expect(j.why).toMatch(/exited 0 but wrote no result file/);
    expect(j.why).toMatch(/possible causes, not checked: .*"Allow Scripts to Write Files and Access Network"/);
    const c = job('author', { script: 'author.jsx' }, 'crash');
    const r = await run(c);
    expect(r.job.exitCode).toBe(1);
    expect(r.out).toMatch(/AppleEvent timed out/);
    const jc = judgeAeJob(r.job, c);
    expect(jc.outcome).toBe('failed');
    expect(jc.why).toMatch(/no result file, and After Effects exited 1/);
  });

  it('on the macOS route, what osascript itself reported names the step: not allowed to control the app (-1743), or the Apple event timed out (-1712)', async () => {
    const denied = macJob('author', { script: 'author.jsx' }, 'not-allowed');
    const jd = judgeAeJob((await run(denied)).job, denied);
    expect(jd.outcome).toBe('failed');
    expect(jd.why).toMatch(/^macOS did not let osascript control After Effects \(osascript reported: Not authorized to send Apple events to Adobe After Effects 2026\. \(-1743\)\): allow your terminal under System Settings > Privacy & Security > Automation, then run again; no result file, and osascript exited 1/);
    const slow = macJob('author', { script: 'author.jsx' }, 'crash');
    const js = judgeAeJob((await run(slow)).job, slow);
    expect(js.outcome).toBe('failed');
    expect(js.why).toMatch(/^the Apple event to After Effects timed out \(osascript reported: .*AppleEvent timed out\. \(-1712\)\) and no result file was written: After Effects may still be running the script/);
  });

  it('the new version missing after a result that says ok: failed', async () => {
    const s = job('author', { script: 'author.jsx' }, 'vanish-aep');
    const j = judgeAeJob((await run(s)).job, s);
    expect(JSON.parse(readFileSync(s.native.result!, 'utf8')).ok).toBe(true);
    expect(j.outcome).toBe('failed');
    expect(j.why).toMatch(/out\/ae\/author-v1\.aep is not there/);
    expect(j.ae.saved).toEqual({ path: 'out/ae/author-v1.aep', present: false, created: false });
  });

  it('a file at the new version\'s name that this run did not write is not its project, though the result says ok', async () => {
    const s = job('author', { script: 'author.jsx' }, 'save-noop');
    const aep = path.join(root, 'out', 'ae', 'author-v1.aep');
    writeFileSync(aep, 'a project left from before this run');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(aep, old, old);
    const j = judgeAeJob((await run(s)).job, s);
    expect(JSON.parse(readFileSync(s.native.result!, 'utf8')).ok).toBe(true);
    expect(j.outcome).toBe('failed');
    expect(j.why).toMatch(/out\/ae\/author-v1\.aep was expected and the result does not name it, nor did this run write it/);
    expect(j.ae.saved).toMatchObject({ present: true, created: false });
  });

  it('a project with unsaved changes open in After Effects stops the run untouched: nothing made, read or saved', async () => {
    const s = job('author', { script: 'author.jsx' }, 'dirty');
    const j = judgeAeJob((await run(s)).job, s);
    expect(j.outcome).toBe('failed');
    expect(j.why).toMatch(/unsaved changes; Timmy neither saves nor closes it: save or close it in After Effects, then run again/);
    expect(j.ae.stage).toBe('guard');
    expect(j.ae.comps).toBeUndefined();
    expect(existsSync(path.join(root, 'out', 'ae', 'author-v1.aep'))).toBe(false);
  });

  it('the write preference off: the harness stops before any project, and the judgement says exactly what to turn on; Timmy never changes it', async () => {
    const s = macJob('author', { script: 'author.jsx' }, 'write-pref-off');
    const { job: done, out } = await run(s);
    expect(out).toMatch(new RegExp(`^TIMMY-AE ${s.native.run} ok=false result=not-written write-preference=off reason=could not open it for writing`, 'm'));
    expect(out).not.toMatch(/VIOLATION/);
    const j = judgeAeJob(done, s);
    expect(j.outcome).toBe('failed');
    expect(j.why).toBe(AE_PREF_OFF);
    expect(j.why).toMatch(/turn that setting on \(After Effects > Settings \(Preferences in older versions\) > Scripting & Expressions; on Windows, Edit > Preferences > Scripting & Expressions\), then run again; Timmy never changes it$/);
    expect(existsSync(s.native.result!)).toBe(false);
    expect(existsSync(path.join(root, 'out', 'ae', 'author-v1.aep'))).toBe(false);
    expect(readFileSync(s.ae.harness.path, 'utf8')).not.toMatch(/setPref|savePref|saveToDisk/);
    // The -r route has no line back from After Effects: the preference is named as a possible cause, not as the cause.
    const b = job('author', { script: 'author.jsx' }, 'write-pref-off');
    const jb = judgeAeJob((await run(b)).job, b);
    expect(jb.outcome).toBe('unknown');
    expect(jb.why).toMatch(/possible causes, not checked/);
  });

  it('a harness changed after Timmy wrote it is not the run\'s: unknown, however the result reads', async () => {
    const s = job('author', { script: 'author.jsx' });
    const { job: done } = await run(s);
    chmodSync(s.ae.harness.path, 0o644);
    writeFileSync(s.ae.harness.path, `${readFileSync(s.ae.harness.path, 'utf8')}// edited afterwards\n`);
    const j = judgeAeJob(done, s);
    expect(j.outcome).toBe('unknown');
    expect(j.why).toMatch(/harness\.jsx changed since Timmy wrote it/);
  });
});

describe('edit and inspect never write the project given', () => {
  it('edit saves a new version, and the project given stays byte for byte, even when the script saves on its own', async () => {
    const v1 = await authored('promo');
    const before = readFileSync(v1);
    writeFileSync(path.join(root, 'edit-and-save.jsx'), `${readFileSync(path.join(root, 'edit.jsx'), 'utf8')}app.project.save();\n`);
    const e = job('edit', { projectFile: 'out/ae/promo-v1.aep', script: 'edit-and-save.jsx' });
    expect(e.ae.saved?.rel).toBe('out/ae/promo-v2.aep');
    expect(e.ae.source).toMatchObject({ rel: 'out/ae/promo-v1.aep', sha256: sha(v1) });
    expect(aeHarnessConfig(readFileSync(e.ae.harness.path, 'utf8'))).toMatchObject({ mode: 'edit', open: v1, open_rel: 'out/ae/promo-v1.aep', save_rel: 'out/ae/promo-v2.aep' });
    const j = judgeAeJob((await run(e)).job, e);
    expect(j.outcome).toBe('ok');
    expect(j.why).toMatch(/out\/ae\/promo-v2\.aep was created by this run .*; out\/ae\/promo-v1\.aep is unchanged/);
    expect(readFileSync(v1)).toEqual(before);
    expect(j.ae.source).toEqual({ path: 'out/ae/promo-v1.aep', sha256: sha(v1), unchanged: true });
    const main = j.ae.comps?.[0];
    expect(main?.layers.map((l) => [l.name, l.kind])).toEqual([['Subtitle', 'text'], ['Mover', 'solid'], ['Title', 'text'], ['Background', 'solid']]);
    expect(main?.layers.find((l) => l.name === 'Title')?.text).toBe('Title, edited');
  });

  it('a script that writes the project it was given is caught: failed, naming the file', async () => {
    await authored('promo');
    writeFileSync(path.join(root, 'clobber.jsx'), "var f = new File(TIMMY.source); f.open('w'); f.write('overwritten by the script'); f.close();\n");
    const e = job('edit', { projectFile: 'out/ae/promo-v1.aep', script: 'clobber.jsx' });
    const j = judgeAeJob((await run(e)).job, e);
    expect(j.outcome).toBe('failed');
    expect(j.why).toMatch(/^out\/ae\/promo-v1\.aep changed during the run \(its sha256 is not the one recorded at submission\): Timmy never writes it, so the script or something else did; this run's new version is out\/ae\/promo-v2\.aep/);
    expect(j.ae.source?.unchanged).toBe(false);
  });

  it('inspect: After Effects reads a project back into the result (its own report) and closes it unsaved; the file is unchanged and nothing new is saved', async () => {
    const v1 = await authored('promo');
    const before = readFileSync(v1);
    const i = job('inspect', { projectFile: 'out/ae/promo-v1.aep' });
    expect(i.ae.saved).toBeUndefined();
    expect(i.native.expect).toEqual([]);
    expect(i.native.input).toEqual({ path: 'out/ae/promo-v1.aep', sha256: sha(v1) });
    const j = judgeAeJob((await run(i)).job, i);
    expect(j.outcome).toBe('ok');
    expect(j.why).toMatch(/from out\/ae\/promo-v1\.aep as submitted, and says ok; out\/ae\/promo-v1\.aep is unchanged; After Effects reported 1 comp \(its own report\)/);
    expect(j.ae.comps?.[0]).toMatchObject({ name: 'Main', num_layers: 3 });
    expect(JSON.parse(readFileSync(i.native.result!, 'utf8'))).toMatchObject({ closed_unsaved: true, project: { saved: false } });
    expect(readFileSync(v1)).toEqual(before);
    expect(existsSync(path.join(root, 'out', 'ae', 'promo-v2.aep'))).toBe(false);
  });
});

describe('runs and their records', () => {
  it('a second After Effects script run while one is running and unjudged is refused; a run whose process is gone does not block', () => {
    const first = job('author', { script: 'author.jsx' });
    noteNativeStarted(first, { id: 'j000001', startedAt: new Date().toISOString(), pid: process.pid } as JobRecord);
    expect(() => job('author', { script: 'author.jsx' })).toThrow(/another After Effects script run \(.{8}, job j000001, .*\) has not been judged yet/);
    rmSync(path.join(root, '.timmy'), { recursive: true, force: true });
    const second = job('author', { script: 'author.jsx' });
    noteNativeStarted(second, { id: 'j000002', startedAt: new Date().toISOString(), pid: spawnSync(process.execPath, ['-e', '']).pid } as JobRecord);
    expect(() => job('author', { script: 'author.jsx' })).not.toThrow();
  });

  it('reconcileAe judges a run again from its folder after a restart, the exit not recorded', async () => {
    const s = job('author', { script: 'author.jsx' });
    await run(s);
    const j = reconcileAe(root, s.native.run);
    expect(j.outcome).toBe('ok');
    expect(j.exit.state).toBe('unknown');
    expect(j.ae.saved).toMatchObject({ path: 'out/ae/author-v1.aep', created: true });
    expect(readNativeRecord(root, s.native.run)?.verdicts).toHaveLength(1);
    expect(() => reconcileAe(root, '00000000-0000-4000-8000-000000000000')).toThrow(/no record/);
  });
});

describe('the harness and the starters are ExtendScript (ES3)', () => {
  const code = (text: string): string => text.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const config = { v: 1 as const, run: 'r', mode: 'author' as const, root: '/p', result: '/p/r.json', script: '/p/s.jsx', script_dir: '/p', input_sha256: 'a'.repeat(64), open: null, open_rel: null, save: '/p/out/ae/x-v1.aep', save_rel: 'out/ae/x-v1.aep', limits: AE_LIMITS };

  it('uses nothing ExtendScript lacks, and parses', () => {
    const texts = { harness: aeHarness(config), author: readFileSync(path.join(REPO, 'templates/ae-starter/author.jsx'), 'utf8'), edit: readFileSync(path.join(REPO, 'templates/ae-starter/edit.jsx'), 'utf8') };
    for (const [name, text] of Object.entries(texts)) {
      expect(code(text), name).not.toMatch(/=>|`|\blet\s|\bconst\s|\.forEach\(|\.map\(|\.filter\(|\.trim\(|\bJSON\.|Object\.keys|\.includes\(/);
      expect(code(text), `${name}: a trailing comma`).not.toMatch(/,\s*[\]}]/);
      expect(() => new vm.Script(text), name).not.toThrow();
    }
  });

  it('its sha256, as After Effects would compute it, matches node:crypto at every padding edge', () => {
    const text = aeHarness(config);
    const fn = text.slice(text.indexOf('  function sha256Hex'), text.indexOf('\n}(\n/* timmy-ae-config'));
    const ctx = vm.createContext({});
    vm.runInContext(fn, ctx);
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 70_000]) {
      const bytes = randomBytes(n);
      expect(vm.runInContext(`sha256Hex(${JSON.stringify(bytes.toString('latin1'))})`, ctx), `${n} bytes`).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });
});

describe('/tools: After Effects (scripting)', () => {
  const none: ProbeDeps = {
    env: {}, onPath: () => false, canvasBuilt: () => false, studio: async () => ({ state: 'not-running' }), studioBase: 'http://127.0.0.1:4337',
    ollama: async () => ({ ok: false, models: [] }), openrouter: async () => 'no-key', modelKeySource: () => null, model: 'm', http: async () => null,
    lanes: () => [], adapters: () => [], receipts: () => ({ ok: true, count: 0 }), exercised: () => new Map(), edgeSet: () => false, exists: () => false,
  };
  const sealed = (ts: string, app: string, outcome: string, status?: string): Record<string, unknown> =>
    ({ kind: 'native', ts, hash: `sha256_${ts}`, ...(status ? { status } : {}), native: { app, outcome, why: 'why', exit_code: 0, signal: null, files: [] } });
  const byId = (rows: CapabilityRow[]) => Object.fromEntries(rows.map((r) => [r.id, r]));

  it('needs setup with the step, or installed where found; "implemented; not run" until a sealed run of its own', async () => {
    const missing = nativeCapabilityRows({}, { platform: 'linux', onPath: () => null }).find((r) => r.id === 'afterfx');
    expect(missing).toMatchObject({ kind: 'adapter', name: 'After Effects (scripting)', rung: 'needs setup', exercisedBy: 'native:afterfx', tools: ['run_native'] });
    expect(missing?.detail).toMatch(/TIMMY_AFTERFX is not set.*; implemented; not run/);
    expect(missing?.setup).toMatch(/TIMMY_AFTERFX/);
    const found = nativeCapabilityRows({ TIMMY_AFTERFX: fakeAe() }, { platform: 'linux', onPath: () => null }).find((r) => r.id === 'afterfx');
    expect(found?.rung).toBe('installed');
    expect(found?.detail).toMatch(/at TIMMY_AFTERFX; implemented; not run; writes and edits projects inside the application \(\/ae author, \/ae edit, \/ae inspect; its window opens\)/);
    const aerender = nativeCapabilityRows({ TIMMY_AERENDER: fakeAe() }, { platform: 'linux', onPath: () => null }).find((r) => r.id === 'aerender');
    expect(aerender?.detail).toMatch(/making or editing one: \/ae author, \/ae edit/);
    // Only a sealed After Effects script run judged ok marks the row exercised; an aerender ok does not, nor the reverse.
    const r1 = byId(await capabilities({ ...none, nativeRuns: () => nativeRunIndex([sealed('2026-10-09T09:00:00Z', 'aerender', 'ok', 'ok')]) }));
    expect(r1.afterfx.exercised).toBeUndefined();
    expect(r1.afterfx.detail).toMatch(/implemented; not run/);
    const r2 = byId(await capabilities({ ...none, nativeRuns: () => nativeRunIndex([sealed('2026-10-09T10:00:00Z', 'afterfx', 'ok', 'ok')]) }));
    expect(r2.afterfx.exercised).toBe('2026-10-09T10:00:00Z');
    expect(r2.afterfx.detail).toMatch(/last run ok, 2026-10-09T10:00:00Z/);
    expect(r2.aerender.exercised).toBeUndefined();
  });
});

describe('the run_native agent tool: app afterfx', () => {
  it('asks first like every run_native call, refuses a call missing what its mode needs, and starts a run that answers at once', async () => {
    const policy = (args: Record<string, unknown>) => { const r = approvalNeeded('run_native', args); return r && { reason: r.reason, session: r.session }; };
    expect(policy({ app: 'afterfx', mode: 'author', script: 'author.jsx' })).toEqual(policy({ app: 'c4dpy', script: 'scene.py' }));
    expect(approvalNeeded('run_native', { app: 'afterfx', mode: 'edit' })).toMatchObject({ reason: expect.stringMatching(/After Effects/), summary: 'afterfx' });
    const m = manager();
    const bin = fakeAe();
    const started: NativeJobSpec[] = [];
    const [tool] = createNativeTools({
      root: () => root, project: () => 'demo', start: (spec) => m.start(spec), find: { afterfx: () => ({ app: 'afterfx', path: bin, how: 'env' }) }, onStarted: (_job, spec) => void started.push(spec),
    });
    const call = (tool.function as unknown as { execute: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }).execute;
    expect(await call({ app: 'afterfx' })).toMatchObject({ ok: false, error: expect.stringMatching(/afterfx author needs script/) });
    expect(await call({ app: 'afterfx', mode: 'edit', script: 'edit.jsx' })).toMatchObject({ ok: false, error: expect.stringMatching(/afterfx edit needs project_file/) });
    expect(await call({ app: 'afterfx', mode: 'inspect' })).toMatchObject({ ok: false, error: expect.stringMatching(/afterfx inspect needs project_file/) });
    expect(m.list()).toHaveLength(0);
    const answer = await call({ app: 'afterfx', script: 'author.jsx', name: 'spot', timeout_minutes: 1 });
    expect(answer).toMatchObject({ ok: true, app: 'afterfx', mode: 'author', saved: 'out/ae/spot-v1.aep', result_file: `.timmy/native/${answer.run}/result.json` });
    expect(String(answer.note)).toMatch(/Started, not finished: After Effects \(with -r\) starts or comes forward and opens its window/);
    expect(String(answer.note)).toMatch(/"Allow Scripts to Write Files and Access Network"/);
    expect(started).toHaveLength(1);
    expect(isAeJobSpec(started[0])).toBe(true);
    const done = await m.done(String(answer.job));
    expect(judgeAeJob(done, started[0] as AeJobSpec).outcome).toBe('ok');
    const notFound = createNativeTools({ root: () => root, project: () => 'demo', start: (spec) => m.start(spec), find: { afterfx: () => null } });
    const missing = await (notFound[0].function as unknown as { execute: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }).execute({ app: 'afterfx', script: 'author.jsx' });
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/After Effects \(scripting\) was not found/), setup: expect.stringMatching(/TIMMY_AFTERFX/) });
  });
});

describe('the REPL: /ae author, /ae edit, /ae inspect', () => {
  const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
  const jobIdOf = (out: string): string => { const m = /\b(j[0-9a-f]{6})\b/.exec(out); if (!m) throw new Error(`no job id in: ${out}`); return m[1]; };
  function make(env: Record<string, string>) {
    const notes: string[] = [];
    const sealed: ReceiptInput[] = [];
    const ws = new Workspace({
      glyphs: glyphSet(true), env, onPath: () => null, notify: (l) => notes.push(l.map((s) => s.text).join('')),
      openWeb: (url) => `Open ${url} in your browser.`, link: (t) => t, seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
      jobsDir: path.join(tmp, 'ws-jobs'), chdir: () => {},
    }, folderProject(root));
    spaces.push(ws);
    return { ws, notes, sealed };
  }
  const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('says before a run that After Effects opens its window and what stops a run, then reports the new version, its sha256, After Effects\' report and the next step', async () => {
    const { ws, notes, sealed } = make({ TIMMY_AFTERFX: fakeAe() });
    const usage = text(await ws.ae(''));
    for (const u of ['/ae author <script.jsx> [--name <project>]', '/ae edit <project.aep> <script.jsx>', '/ae inspect <project.aep>', '/ae <project.aep> <comp> <output file>']) expect(usage).toContain(u);
    expect(text(await ws.ae('author'))).toMatch(/Usage: \/ae author <script\.jsx>/);

    const started = text(await ws.ae('author author.jsx --name promo'));
    expect(started).toMatch(/App {8}started with -r and the harness: its window opens \(a script runs only inside the application\)/);
    expect(started).toMatch(/a project open in After Effects with unsaved changes stops the run untouched/);
    expect(started).toMatch(/"Allow Scripts to Write Files and Access Network" .*Timmy never changes it/);
    expect(started).toMatch(/Saves {6}out\/ae\/promo-v1\.aep, a new project/);
    expect(started.indexOf('its window opens')).toBeLessThan(started.indexOf('Running'));
    const id = jobIdOf(started);
    await ws.jobs.done(id);
    await settle();
    const ended = notes.join('\n');
    expect(ended).toMatch(new RegExp(`${id} ok  After Effects · author author\\.jsx → out/ae/promo-v1\\.aep: the result file is this run's`));
    expect(ended).toMatch(/saved {4}out\/ae\/promo-v1\.aep · created by this run · sha256 [0-9a-f]{12}… \(Timmy's, after the run\)/);
    expect(ended).toMatch(/reported 1 comp: Main 1920x1080, 30 fps, 10 s, 3 layers: Mover \(solid; Position 2 keys\), Title \(text "Title"\), Background \(solid\) · as After Effects reported its own project, not an independent reading/);
    expect(ended).toMatch(/next {5}\/ae out\/ae\/promo-v1\.aep Main out\/promo-v1\.mov renders it with aerender/);
    expect(ended).toMatch(/next {5}\/ae inspect out\/ae\/promo-v1\.aep has After Effects read it back \(the same application reading its own file, not an independent reader\)/);
    const receipt = sealed.find((r) => r.kind === 'native');
    expect(receipt).toMatchObject({ status: 'ok', native: { app: 'afterfx', outcome: 'ok', ae: { mode: 'author', saved: { path: 'out/ae/promo-v1.aep', sha256: sha(path.join(root, 'out', 'ae', 'promo-v1.aep')) } } } });
    expect(JSON.stringify(receipt)).not.toContain(root);

    notes.length = 0;
    const edited = text(await ws.ae('edit out/ae/promo-v1.aep edit.jsx'));
    expect(edited).toMatch(/Saves {6}out\/ae\/promo-v2\.aep, a new version; out\/ae\/promo-v1\.aep is never written/);
    await ws.jobs.done(jobIdOf(edited.slice(edited.indexOf('Running'))));
    await settle();
    expect(notes.join('\n')).toMatch(/given {4}out\/ae\/promo-v1\.aep · unchanged \(sha256 as at submission\)/);
    expect(notes.join('\n')).toMatch(/Subtitle \(text "Subtitle"\), Mover \(solid; Position 2 keys\), Title \(text "Title, edited"\)/);

    notes.length = 0;
    const inspected = text(await ws.ae('inspect out/ae/promo-v2.aep'));
    expect(inspected).toMatch(/Saves {6}nothing: it opens out\/ae\/promo-v2\.aep to read it and closes it unsaved/);
    await ws.jobs.done(jobIdOf(inspected.slice(inspected.indexOf('Running'))));
    await settle();
    expect(notes.join('\n')).toMatch(/ ok  After Effects · inspect out\/ae\/promo-v2\.aep: .*out\/ae\/promo-v2\.aep is unchanged/);
    expect(notes.join('\n')).toMatch(/next {5}\/ae out\/ae\/promo-v2\.aep Main out\/promo-v2\.mov renders it with aerender/);
    expect(sealed.filter((r) => r.kind === 'native').map((r) => (r.native as { ae?: { mode?: string } }).ae?.mode)).toEqual(['author', 'edit', 'inspect']);
  });

  it('a failed run says the error, its line, the result file and where the raw output is', async () => {
    writeFileSync(path.join(root, 'broken.jsx'), 'undefinedThing.call();\n');
    const { ws, notes } = make({ TIMMY_AFTERFX: fakeAe() });
    const id = jobIdOf(text(await ws.ae('author broken.jsx')).split('Running')[1]);
    await ws.jobs.done(id);
    await settle();
    const ended = notes.join('\n');
    expect(ended).toMatch(new RegExp(`${id} failed`));
    expect(ended).toMatch(/error {4}at script \(line 1\): ReferenceError: undefinedThing is not defined · \.timmy\/native\/[0-9a-f-]{36}\/result\.json · \/jobs j[0-9a-f]{6} for the raw output/);
    expect(ended).not.toMatch(/next /);
  });

  it('without After Effects found, nothing starts and the step is named', async () => {
    const { ws } = make({});
    const out = text(await ws.ae('author author.jsx'));
    expect(out).toMatch(/After Effects \(scripting\) was not found on this machine/);
    expect(out).toMatch(/Setup: install After Effects; or set TIMMY_AFTERFX/);
    expect(out).not.toMatch(/Running/);
    expect(existsSync(path.join(root, '.timmy', 'native'))).toBe(false);
  });
});
