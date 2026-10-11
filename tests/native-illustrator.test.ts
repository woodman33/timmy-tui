/**
 * Round R4 (helper H64): Adobe Illustrator authoring, editing and reading back (/illustrator author, edit, inspect;
 * run_native app illustrator; timmy act). Everything here runs against a TEST DOUBLE, tests/fixtures/fake-illustrator.mjs:
 * a Node program standing in for osascript and Illustrator, which runs the harness Timmy generates (and the starter
 * scripts) on a small stand-in of Illustrator's scripting objects and writes FAKE documents, its own SVG rendering, a FAKE
 * PDF and a real PNG. No Illustrator runs in this suite: a pass says Timmy's side (the run's folder, the harness, the
 * judgement, Timmy's own SVG reading, the REPL, the agent tool and timmy act) holds, not that Illustrator was driven.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNativeTools } from '../src/agent/native-tools.js';
import { capabilities, type CapabilityRow, type ProbeDeps } from '../src/capabilities/index.js';
import { JobManager, type JobRecord } from '../src/jobs/index.js';
import {
  AUTOMATION_PLACE, ILLUSTRATOR_LIMITS, illustratorAppName, illustratorHarness, illustratorHarnessConfig, illustratorJob, illustratorOsascriptArgs, illustratorReceiptFields,
  illustratorStem, isIllustratorJobSpec, judgeIllustratorJob, osascriptWhy, parseIllustratorArgs, reconcileIllustrator, type IllustratorJobInput, type IllustratorJobSpec,
} from '../src/native/illustrator.js';
import { locateNative, nativeCapabilityRows, nativeRunIndex, noteNativeStarted, readNativeRecord, type NativeJobSpec } from '../src/native/index.js';
import { runOutcome } from '../src/ops/outcome.js';
import { approvalNeeded, gateTools, ILLUSTRATOR_APPROVAL_REASON, type ApprovalRequest } from '../src/repl/approvals.js';
import { REPL_INSTRUCTIONS } from '../src/repl/main.js';
import { folderProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { HOMEBREW } from '../src/theme/tokens.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { ReceiptInput } from '../src/utils/receipts.js';

const REPO = path.resolve(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-illustrator.mjs');
const STARTER = path.join(REPO, 'templates', 'illustrator-starter');
let tmp = '';
let root = '';
let managers: JobManager[] = [];
let spaces: Workspace[] = [];

beforeEach(() => {
  // resolved: on macOS the temp folder is reached through a link, and the job specs resolve the project folder
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'timmy-ai-')));
  root = path.join(tmp, 'project');
  mkdirSync(root, { recursive: true });
  for (const f of ['badge.jsx', 'edit.jsx']) copyFileSync(path.join(STARTER, f), path.join(root, f));
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
/** Illustrator's program inside its bundle, as macOS keeps it (the fake stands in; it is never run as the program). */
const fakeApp = (): string => install(path.join(tmp, 'Applications', 'Adobe Illustrator 2026', 'Adobe Illustrator.app', 'Contents', 'MacOS', 'Adobe Illustrator'));
/** osascript: the fake on a bin folder of its own. */
const fakeOsascript = (): string => install(path.join(tmp, 'bin', 'osascript'));
function manager(): JobManager {
  const m = new JobManager({ dir: path.join(tmp, 'jobs') });
  managers.push(m);
  return m;
}
/** A run with the fake as osascript; FAKE_AI_MODE picks what the fake does. */
function job(mode: IllustratorJobInput['mode'], extra: Partial<IllustratorJobInput> = {}, fake = 'ok'): IllustratorJobSpec {
  return illustratorJob({ mode, root, project: 'demo', timeoutMs: 20_000, bin: fakeApp(), osascript: fakeOsascript(), env: { FAKE_AI_MODE: fake }, ...extra });
}
async function run(spec: NativeJobSpec): Promise<{ m: JobManager; job: JobRecord; out: string }> {
  const m = manager();
  const done = await m.done(m.start(spec).id);
  return { m, job: done, out: m.tail(done.id, 200).join('\n') };
}
async function authored(name = 'badge'): Promise<string> {
  const a = job('author', { script: 'badge.jsx', name });
  expect(judgeIllustratorJob((await run(a)).job, a).outcome).toBe('ok');
  return path.join(root, 'out', 'illustrator', `${name}-v1.ai`);
}

describe('finding Illustrator, and how Timmy asks it', () => {
  const none = { onPath: () => null };

  it('takes TIMMY_ILLUSTRATOR first (Adobe Illustrator.app opened to Contents/MacOS/Adobe Illustrator), then /Applications newest first', () => {
    const apps = path.join(tmp, 'Applications');
    const exe = (v: string): string => install(path.join(apps, `Adobe Illustrator ${v}`, 'Adobe Illustrator.app', 'Contents', 'MacOS', 'Adobe Illustrator'));
    exe('2025');
    const newest = exe('2026');
    mkdirSync(path.join(apps, 'Adobe Illustrator 2027'), { recursive: true }); // a folder without the application is passed over
    expect(locateNative('illustrator', {}, { platform: 'darwin', applications: apps, ...none }).found).toMatchObject({ app: 'illustrator', path: newest, how: 'applications', version: '2026' });
    const bundle = path.join(apps, 'Adobe Illustrator 2025', 'Adobe Illustrator.app');
    expect(locateNative('illustrator', { TIMMY_ILLUSTRATOR: bundle }, { platform: 'darwin', applications: apps, ...none }).found)
      .toMatchObject({ path: path.join(bundle, 'Contents', 'MacOS', 'Adobe Illustrator'), how: 'env' });
    const broken = locateNative('illustrator', { TIMMY_ILLUSTRATOR: path.join(tmp, 'nowhere.app') }, { platform: 'darwin', applications: apps, ...none });
    expect(broken.found).toBeNull();
    expect(broken.problem).toMatch(/TIMMY_ILLUSTRATOR/);
    expect(locateNative('illustrator', {}, { platform: 'linux', applications: apps, ...none }).found).toBeNull();
  });

  it('asks with "do javascript file" inside a timeout of its own, by the application\'s name, AppleScript strings quoted: the one sentence', () => {
    expect(illustratorOsascriptArgs('Adobe Illustrator', '/p/a "q"\\b.jsx', 600)).toEqual([
      '-e', 'with timeout of 600 seconds', '-e', 'tell application "Adobe Illustrator" to do javascript file "/p/a \\"q\\"\\\\b.jsx"', '-e', 'end timeout',
    ]);
    expect(illustratorAppName('/Applications/Adobe Illustrator 2026/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator')).toEqual({ appName: 'Adobe Illustrator' });
    expect(illustratorAppName('C:\\Program Files\\Adobe\\Adobe Illustrator 2026\\Support Files\\Contents\\Windows\\Illustrator.exe')).toEqual({ error: expect.stringMatching(/is not inside an application \(\.app\): Timmy asks Illustrator through osascript, on macOS/) });
  });

  it('refuses what it cannot run: no osascript, a program outside an .app, a missing or outside script, a document that is not .ai', () => {
    expect(() => illustratorJob({ mode: 'author', script: 'badge.jsx', root, project: 'demo', bin: fakeApp(), findEnv: { PATH: path.join(tmp, 'empty') } })).toThrow(/osascript was not found on PATH/);
    expect(() => illustratorJob({ mode: 'author', script: 'badge.jsx', root, project: 'demo', bin: path.join(tmp, 'Illustrator.exe'), osascript: fakeOsascript() })).toThrow(/is not inside an application \(\.app\)/);
    expect(() => job('author', { script: 'missing.jsx' })).toThrow(/no script at missing\.jsx/);
    expect(() => job('author', { script: '../elsewhere.jsx' })).toThrow(/outside the project/);
    writeFileSync(path.join(root, 'notes.txt'), 'x');
    expect(() => job('author', { script: 'notes.txt' })).toThrow(/not an Illustrator script/);
    expect(() => job('edit', { docFile: 'notes.txt', script: 'edit.jsx' })).toThrow(/not an Illustrator document \(\.ai\)/);
    expect(() => job('inspect', { docFile: 'missing.ai' })).toThrow(/no document at missing\.ai/);
    expect(() => illustratorJob({ mode: 'author', script: 'badge.jsx', root, project: 'demo', findEnv: {}, seams: { platform: 'linux', onPath: () => null } })).toThrow(/Illustrator \(scripting\) was not found/);
    expect(existsSync(path.join(root, '.timmy', 'native'))).toBe(false);
  });

  it('reads /illustrator words and names documents safely', () => {
    expect(parseIllustratorArgs(['author', 'a.jsx', '--name', 'Spring Badge'])).toEqual({ mode: 'author', script: 'a.jsx', name: 'Spring Badge' });
    expect(parseIllustratorArgs(['author', 'a.jsx', '--name=b'])).toEqual({ mode: 'author', script: 'a.jsx', name: 'b' });
    expect(parseIllustratorArgs(['author'])).toEqual({ error: expect.stringMatching(/^Usage: \/illustrator author <script\.jsx>/) });
    expect(parseIllustratorArgs(['author', 'a.jsx', '--size', '9'])).toEqual({ error: expect.stringMatching(/^No option --size: author takes --name <doc>/) });
    expect(parseIllustratorArgs(['edit', 'x.ai', 'e.jsx'])).toEqual({ mode: 'edit', docFile: 'x.ai', script: 'e.jsx' });
    expect(parseIllustratorArgs(['inspect', 'x.ai'])).toEqual({ mode: 'inspect', docFile: 'x.ai' });
    expect(parseIllustratorArgs(['draw', 'x'])).toEqual({ error: expect.stringMatching(/^No \/illustrator draw: author, edit or inspect/) });
    expect(parseIllustratorArgs([])).toBeUndefined();
    expect([illustratorStem('Spring Badge'), illustratorStem('badge-v12.ai'), illustratorStem('../../etc'), illustratorStem('...'), illustratorStem('badge.jsx')]).toEqual(['Spring-Badge', 'badge', 'etc', 'artwork', 'badge']);
  });
});

describe('the run\'s folder: an immutable, hashed harness and script', () => {
  it('writes the script byte for byte and the harness read-only, records their sha256, and keeps the project folder out of its records', () => {
    const s = job('author', { script: 'badge.jsx' });
    const dir = path.join(root, '.timmy', 'native', s.native.run);
    const harness = readFileSync(path.join(dir, 'harness.jsx'), 'utf8');
    expect(sha(path.join(dir, 'harness.jsx'))).toBe(s.illustrator.harness.sha256);
    expect(statSync(path.join(dir, 'harness.jsx')).mode & 0o222).toBe(0);
    expect(readFileSync(path.join(dir, 'script.jsx'))).toEqual(readFileSync(path.join(root, 'badge.jsx')));
    expect(statSync(path.join(dir, 'script.jsx')).mode & 0o222).toBe(0);
    const out = (ext: string) => ({ path: path.join(root, 'out', 'illustrator', `badge-v1.${ext}`), rel: `out/illustrator/badge-v1.${ext}` });
    expect(illustratorHarnessConfig(harness)).toEqual({
      v: 1, run: s.native.run, mode: 'author', root, result: path.join(dir, 'result.json'), script: path.join(dir, 'script.jsx'), script_dir: root,
      input_sha256: sha(path.join(root, 'badge.jsx')), open: null, open_rel: null, save: out('ai').path, save_rel: 'out/illustrator/badge-v1.ai',
      exports: { svg: out('svg'), pdf: out('pdf'), png: out('png') }, svg_precision: 3, png_scale: 100, limits: ILLUSTRATOR_LIMITS,
    });
    expect(/^[\t\n\r\x20-\x7e]*$/.test(harness)).toBe(true);
    const rec = JSON.parse(readFileSync(path.join(dir, 'illustrator.json'), 'utf8'));
    expect(rec).toMatchObject({
      record: 'timmy-illustrator-run', run: s.native.run, mode: 'author', route: 'osascript', app_name: 'Adobe Illustrator', name: 'badge', version: 1, saved: 'out/illustrator/badge-v1.ai',
      exports: { svg: 'out/illustrator/badge-v1.svg', pdf: 'out/illustrator/badge-v1.pdf', png: 'out/illustrator/badge-v1.png' },
      harness: { path: `.timmy/native/${s.native.run}/harness.jsx`, sha256: s.illustrator.harness.sha256 }, script: { source: 'badge.jsx', copy: `.timmy/native/${s.native.run}/script.jsx` },
    });
    const record = JSON.parse(readFileSync(path.join(dir, 'job.json'), 'utf8'));
    expect(record).toMatchObject({
      app: 'illustrator', input: { path: 'badge.jsx', sha256: sha(path.join(root, 'badge.jsx')) }, expect: ['out/illustrator/badge-v1.ai', 'out/illustrator/badge-v1.svg', 'out/illustrator/badge-v1.pdf'],
      pre: { 'out/illustrator/badge-v1.ai': { state: 'absent' }, 'out/illustrator/badge-v1.png': { state: 'absent' } },
    });
    expect(record.args).toEqual(['-e', 'with timeout of 15 seconds', '-e', `tell application "Adobe Illustrator" to do javascript file "./.timmy/native/${s.native.run}/harness.jsx"`, '-e', 'end timeout']);
    expect(s.command).toBe(path.join(tmp, 'bin', 'osascript'));
    expect(JSON.stringify(rec)).not.toContain(tmp);
    expect(JSON.stringify(record.args)).not.toContain(tmp);
  });

  it('a project folder with spaces and letters outside ASCII: the harness stays ASCII and finds every path', async () => {
    root = path.join(tmp, 'Pröject Ü');
    mkdirSync(root);
    copyFileSync(path.join(STARTER, 'badge.jsx'), path.join(root, 'badge.jsx'));
    const s = job('author', { script: 'badge.jsx', name: 'spot' });
    expect(/^[\t\n\r\x20-\x7e]*$/.test(readFileSync(s.illustrator.harness.path, 'utf8'))).toBe(true);
    expect(judgeIllustratorJob((await run(s)).job, s)).toMatchObject({ outcome: 'ok', illustrator: { check: { verdict: 'agrees' } } });
    expect(existsSync(path.join(root, 'out', 'illustrator', 'spot-v1.ai'))).toBe(true);
  });
});

describe('author, edit, inspect', () => {
  it('author ok: the result is this run\'s; the .ai, .svg, .pdf and .png were created by it, hashed by Timmy; Timmy\'s own reading of the SVG agrees', async () => {
    const s = job('author', { script: 'badge.jsx', name: 'badge' });
    const { job: done, out } = await run(s);
    expect(done.state).toBe('completed');
    expect(out).toMatch(/fake-illustrator \(FAKE Adobe Illustrator\): osascript asked "Adobe Illustrator" to do javascript file harness\.jsx/);
    expect(out).toMatch(new RegExp(`^TIMMY-AI ${s.native.run} ok=true result=written$`, 'm'));
    expect(out).toMatch(/0 documents left open/); // it closed what it made
    const j = judgeIllustratorJob(done, s);
    const at = (ext: string): string => path.join(root, 'out', 'illustrator', `badge-v1.${ext}`);
    expect(j.outcome).toBe('ok');
    expect(j.why).toMatch(/^the result file is this run's, from badge\.jsx as submitted, and says ok; out\/illustrator\/badge-v1\.ai was created by this run \(sha256 [0-9a-f]{12}…, computed by Timmy after the run\), with badge-v1\.svg, badge-v1\.pdf and badge-v1\.png; Illustrator reported 4 shapes and 1 text \(its own report\); Timmy's own reading of the SVG agrees; osascript exited 0/);
    expect(j.illustrator.saved).toEqual({ path: 'out/illustrator/badge-v1.ai', present: true, created: true, sha256: sha(at('ai')), bytes: statSync(at('ai')).size, starts: expect.stringMatching(/^FAKE-AI/) });
    for (const ext of ['svg', 'pdf', 'png'] as const) expect(j.illustrator.exports[ext]).toMatchObject({ path: `out/illustrator/badge-v1.${ext}`, present: true, created: true, sha256: sha(at(ext)), harness: { written: true } });
    expect(j.illustrator.exports.pdf?.starts).toBe('%PDF-1.4');
    expect(j.illustrator.harness).toEqual({ path: `.timmy/native/${s.native.run}/harness.jsx`, sha256: s.illustrator.harness.sha256, unchanged: true, read: s.illustrator.harness.sha256 });
    // Illustrator's own report (the fake's): one artboard of 600 x 400, the badge's four shapes and its label
    expect(j.illustrator.report).toMatchObject({
      state: 'as saved', artboards: [{ index: 1, name: 'Badge', rect: [0, 0, 600, -400], width: 600, height: 400 }], active_artboard: 1, layers: [{ name: 'Badge', depth: 0, visible: true, locked: false, items: 5 }],
      path_items_total: 4, text_frames_total: 1, text_frames: [{ name: 'Label', contents: 'TIMMY', kind: 'TextType.POINTTEXT' }],
      drawn: { shapes: 4, bounds: [20, -20, 580, -380], texts: ['TIMMY'], hidden: 0, guides: 0, clipping: 0, in_compound: 0 },
    });
    expect(j.illustrator.report?.path_items.map((p) => [p.name, p.closed, p.bounds])).toEqual([
      ['Rule', false, [140, -270, 460, -270]], ['Spark', true, expect.any(Array)], ['Ring', true, [210, -60, 390, -240]], ['Badge', true, [20, -20, 580, -380]],
    ]);
    // Timmy's own reading of the SVG the fake wrote, each part against that report
    expect(j.illustrator.check).toMatchObject({
      verdict: 'agrees', svg: 'out/illustrator/badge-v1.svg',
      artboard: { illustrator: [600, 400], svg: [600, 400], from: 'viewBox', agrees: true },
      shapes: { illustrator: 4, svg: 4, by_element: { rect: 1, circle: 1, line: 1, polygon: 1 }, agrees: true },
      texts: { illustrator: ['TIMMY'], svg: ['TIMMY'], agrees: true },
      bounds: { illustrator: [20, 20, 580, 380], svg: [20, 20, 580, 380], agrees: true, tolerance: 0.001 },
      png: { path: 'out/illustrator/badge-v1.png', size: [600, 400], expected: [600, 400], agrees: true },
    });
    const result = JSON.parse(readFileSync(s.native.result!, 'utf8'));
    expect(result).toMatchObject({
      timmy_illustrator: 1, ok: true, run: s.native.run, stage: 'done', saved: true, saved_path: at('ai'), closed: true, alerts_suppressed: true, svg_precision: 3,
      script_sha256: sha(path.join(root, 'badge.jsx')), script_sha256_read: sha(path.join(root, 'badge.jsx')), illustrator_version: '30.0.0 (FAKE)', files: {},
    });
    expect(result.error).toBeUndefined();
    const sealed = illustratorReceiptFields(j);
    expect(sealed.status).toBe('ok');
    expect(sealed.native).toMatchObject({
      app: 'illustrator', outcome: 'ok', run: s.native.run, input: { path: 'badge.jsx' },
      illustrator: { mode: 'author', route: 'osascript', saved: { path: 'out/illustrator/badge-v1.ai', sha256: sha(at('ai')) }, exports: { svg: { sha256: sha(at('svg')) } }, report: { artboards: 1, layers: 1, shapes: 4, texts: 1 }, readback: { verdict: 'agrees', by: 'Timmy, reading the exported SVG itself' } },
    });
    expect(JSON.stringify(sealed)).not.toContain(tmp);
    judgeIllustratorJob(done, s); // the REPL judges twice (its notice, its receipt): one line
    expect(readNativeRecord(root, s.native.run)?.verdicts).toMatchObject([{ outcome: 'ok', job: done.id, readback: { verdict: 'agrees' } }]);
    expect(job('author', { script: 'badge.jsx', name: 'badge' }).illustrator.saved?.rel).toBe('out/illustrator/badge-v2.ai');
  });

  it('edit saves the next version with its exports; the document given stays byte for byte, even when the script saves on its own', async () => {
    const v1 = await authored('badge');
    const before = readFileSync(v1);
    writeFileSync(path.join(root, 'edit-and-save.jsx'), `${readFileSync(path.join(root, 'edit.jsx'), 'utf8')}TIMMY.document.save();\n`);
    const e = job('edit', { docFile: 'out/illustrator/badge-v1.ai', script: 'edit-and-save.jsx' });
    expect(e.illustrator.saved?.rel).toBe('out/illustrator/badge-v2.ai');
    expect(e.illustrator.source).toMatchObject({ rel: 'out/illustrator/badge-v1.ai', sha256: sha(v1) });
    const j = judgeIllustratorJob((await run(e)).job, e);
    expect(j.outcome).toBe('ok');
    expect(j.why).toMatch(/out\/illustrator\/badge-v2\.ai was created by this run .*; out\/illustrator\/badge-v1\.ai is unchanged; Illustrator reported 5 shapes and 1 text/);
    expect(readFileSync(v1)).toEqual(before);
    expect(j.illustrator.source).toEqual({ path: 'out/illustrator/badge-v1.ai', sha256: sha(v1), unchanged: true });
    expect(j.illustrator.check).toMatchObject({ verdict: 'agrees', shapes: { svg: 5, by_element: { circle: 2 } }, texts: { svg: ['TIMMY 2'] } });
  });

  it('inspect: Illustrator reads the document back and closes it unsaved; its SVG goes into the run\'s folder; nothing new in the project', async () => {
    const v1 = await authored('badge');
    const before = readFileSync(v1);
    const listing = readdirSync(path.join(root, 'out', 'illustrator')).sort();
    const i = job('inspect', { docFile: 'out/illustrator/badge-v1.ai' });
    expect(i.illustrator.saved).toBeUndefined();
    expect(i.native.expect).toEqual([]);
    expect(i.native.input).toEqual({ path: 'out/illustrator/badge-v1.ai', sha256: sha(v1) });
    const j = judgeIllustratorJob((await run(i)).job, i);
    expect(j.outcome).toBe('ok');
    expect(j.why).toMatch(/from out\/illustrator\/badge-v1\.ai as submitted, and says ok; out\/illustrator\/badge-v1\.ai is unchanged; Illustrator reported 4 shapes and 1 text \(its own report\); Timmy's own reading of the SVG agrees/);
    expect(j.illustrator.check).toMatchObject({ verdict: 'agrees', svg: `.timmy/native/${i.native.run}/inspect.svg` });
    expect(j.illustrator.report?.state).toBe('as opened');
    expect(readFileSync(v1)).toEqual(before);
    expect(readdirSync(path.join(root, 'out', 'illustrator')).sort()).toEqual(listing);
    expect(JSON.parse(readFileSync(i.native.result!, 'utf8'))).toMatchObject({ closed: true, exports: { svg: { written: true } } });
  });
});

describe('failures, each with its reason', () => {
  it('-1743: macOS refused osascript\'s Apple events: the run says exactly that and how the operator grants it; Timmy never grants it or opens the settings', async () => {
    const s = job('author', { script: 'badge.jsx' }, 'not-allowed');
    const { job: done, out } = await run(s);
    expect(out).toContain('execution error: Not authorized to send Apple events to Adobe Illustrator. (-1743)');
    const j = judgeIllustratorJob(done, s);
    expect(j.outcome).toBe('failed');
    expect(j.why).toBe('macOS did not let osascript control Adobe Illustrator: osascript reported "Not authorized to send Apple events to Adobe Illustrator." (-1743). The operator grants this, once: System Settings › Privacy & Security › Automation, then under the app Timmy runs in (your terminal, or whichever app started Timmy) turn on Adobe Illustrator, and run again; Timmy never grants it and never opens System Settings; no result file, and osascript exited 1');
    expect(j.illustrator.osascript).toEqual({ text: 'Not authorized to send Apple events to Adobe Illustrator.', code: -1743 });
    expect(osascriptWhy({ text: 'x', code: -1743 })).toContain(AUTOMATION_PLACE);
    // What ran was osascript with the three lines, nothing else: no settings URL, no "open", no tccutil
    expect(s.command).toBe(path.join(tmp, 'bin', 'osascript'));
    expect(s.args.filter((a) => a !== '-e')).toEqual(['with timeout of 15 seconds', `tell application "Adobe Illustrator" to do javascript file "${s.illustrator.harness.path}"`, 'end timeout']);
    for (const text of [JSON.stringify(s.args), readFileSync(s.illustrator.harness.path, 'utf8')]) expect(text).not.toMatch(/x-apple\.systempreferences|tccutil|\bopen -b\b|Privacy_Automation/);
    expect(illustratorReceiptFields(j)).toMatchObject({ status: 'failed', native: { illustrator: { osascript: { code: -1743 } } } });
  });

  it('-1712 and -2741: an Apple event that timed out, or an AppleScript Illustrator does not know, each named with what osascript said', async () => {
    const t = job('author', { script: 'badge.jsx' }, 'timeout');
    const jt = judgeIllustratorJob((await run(t)).job, t);
    expect(jt.outcome).toBe('failed');
    expect(jt.why).toMatch(/^the Apple event to Illustrator timed out: osascript reported "Adobe Illustrator got an error: AppleEvent timed out\." \(-1712\), and no result file was written/);
    const c = job('author', { script: 'badge.jsx' }, 'syntax');
    const jc = judgeIllustratorJob((await run(c)).job, c);
    expect(jc.why).toMatch(/^osascript could not compile the AppleScript that asks Illustrator: it reported "Expected end of line, etc\. but found identifier\." \(-2741\); Timmy asks with "do javascript file"/);
  });

  it('a script error: failed with the error and its line; the .ai holds the document as saved before it, and nothing is exported', async () => {
    writeFileSync(path.join(root, 'broken.jsx'), "var r = TIMMY.document.pathItems.rectangle(0, 0, 10, 10);\nnotAFunction();\n");
    const s = job('author', { script: 'broken.jsx' });
    const { job: done } = await run(s);
    expect(done.state).toBe('completed');
    const j = judgeIllustratorJob(done, s);
    expect(j.outcome).toBe('failed');
    expect(j.why).toMatch(/^the run reported ok: false at its script stage: ReferenceError: notAFunction is not defined \(line 2\); osascript exited 0/);
    expect(j.illustrator).toMatchObject({ stage: 'script', error_line: 2, error: 'ReferenceError: notAFunction is not defined', saved: { present: true, created: true } });
    // read back as the script left it (not saved): the rectangle it drew before its error
    expect(j.illustrator.report).toMatchObject({ state: 'as the script left it, not saved', drawn: { shapes: 1 } });
    expect(j.illustrator.exports.svg).toMatchObject({ present: false });
    expect(j.illustrator.check).toBeUndefined();
    const saved = readFileSync(path.join(root, 'out', 'illustrator', 'broken-v1.ai'), 'utf8');
    expect(JSON.parse(saved.slice(saved.indexOf('\n') + 1)).layers[0].items).toEqual([]); // the FAKE .ai: the document before the script
    expect(illustratorReceiptFields(j)).toMatchObject({ status: 'failed', native: { outcome: 'failed', illustrator: { stage: 'script', error_line: 2 } } });
  });

  it('a document already open in Illustrator stops the run untouched: nothing opened, saved, read or closed', async () => {
    const v1 = await authored('badge');
    const before = readFileSync(v1);
    const e = job('edit', { docFile: 'out/illustrator/badge-v1.ai', script: 'edit.jsx' }, 'open-doc');
    const { out, job: done } = await run(e);
    expect(out).toMatch(/badge-v1\.ai is open in it, with unsaved changes/);
    expect(out).toMatch(/1 document left open/);
    const j = judgeIllustratorJob(done, e);
    expect(j.outcome).toBe('failed');
    expect(j.why).toMatch(/^the run reported ok: false at its guard stage: out\/illustrator\/badge-v1\.ai is open in Illustrator; Timmy neither saves nor closes a document open there: close it in Illustrator, then run again/);
    expect(j.illustrator.report).toBeUndefined();
    expect(existsSync(path.join(root, 'out', 'illustrator', 'badge-v2.ai'))).toBe(false);
    expect(readFileSync(v1)).toEqual(before);
  });

  it('an export Illustrator writes under another name than asked: failed, naming what is in the folder', async () => {
    const s = job('author', { script: 'badge.jsx' }, 'double-ext');
    const j = judgeIllustratorJob((await run(s)).job, s);
    expect(j.outcome).toBe('failed');
    expect(j.why).toMatch(/^the run reported ok: false at its export stage: Illustrator did not write out\/illustrator\/badge-v1\.svg; in its folder, files of that name: .*badge-v1\.svg\.svg/);
    expect(j.illustrator.saved).toMatchObject({ present: true, created: true });
  });

  it('PNG only when the export options allow: without ExportOptionsPNG24 the run is ok and says why there is no PNG', async () => {
    const s = job('author', { script: 'badge.jsx' }, 'no-png');
    const j = judgeIllustratorJob((await run(s)).job, s);
    expect(j.outcome).toBe('ok');
    expect(j.illustrator.exports.png).toMatchObject({ present: false, created: false, harness: { written: false, skipped: 'this Illustrator has no ExportOptionsPNG24' } });
    expect(j.illustrator.check?.png).toBeUndefined();
    expect(j.illustrator.check?.verdict).toBe('agrees');
  });

  it('Timmy\'s reading differs from Illustrator\'s report: the run is ok, the reading says differs with both numbers, and the operation counts it as differs', async () => {
    const s = job('author', { script: 'badge.jsx' }, 'svg-differs');
    const { job: done } = await run(s);
    noteNativeStarted(s, done); // as the REPL notes each run's job
    const j = judgeIllustratorJob(done, s);
    expect(j.outcome).toBe('ok');
    expect(j.why).toMatch(/Timmy's own reading of the SVG differs/);
    expect(j.illustrator.check).toMatchObject({ verdict: 'differs', shapes: { illustrator: 4, svg: 3, agrees: false } });
    expect(readNativeRecord(root, s.native.run)?.verdicts.at(-1)).toMatchObject({ outcome: 'ok', readback: { verdict: 'differs' } });
    const jobs = { get: (id: string) => (id === done.id ? done : undefined) };
    expect(runOutcome({ kind: 'native', id: s.native.run, at: '' }, root, jobs)).toMatchObject({ state: 'differs', words: 'ok (judged by its result file); Timmy\'s own reading of its export differs', claims: [`job:${done.id}`] });
    expect(illustratorReceiptFields(j)).toMatchObject({ status: 'ok', native: { illustrator: { readback: { verdict: 'differs', shapes: { illustrator: 4, svg: 3 } } } } });
  });

  it('the result file cannot be written: failed before any document is touched; the .ai missing after an ok: failed', async () => {
    const w = job('author', { script: 'badge.jsx' }, 'write-fail');
    const { out, job: done } = await run(w);
    expect(out).toMatch(new RegExp(`^TIMMY-AI ${w.native.run} ok=false result=not-written reason=could not open it for writing`, 'm'));
    const jw = judgeIllustratorJob(done, w);
    expect(jw.outcome).toBe('failed');
    expect(jw.why).toMatch(/^the harness could not write its result file \(could not open it for writing: Permission denied/);
    expect(existsSync(path.join(root, 'out', 'illustrator', 'badge-v1.ai'))).toBe(false);
    const v = job('author', { script: 'badge.jsx', name: 'gone' }, 'vanish-ai');
    const jv = judgeIllustratorJob((await run(v)).job, v);
    expect(jv.outcome).toBe('failed');
    expect(jv.why).toMatch(/out\/illustrator\/gone-v1\.ai/);
    expect(jv.illustrator.saved).toEqual({ path: 'out/illustrator/gone-v1.ai', present: false, created: false });
  });

  it('a harness changed after Timmy wrote it is not the run\'s: unknown; a script that writes the document it was given: failed', async () => {
    const s = job('author', { script: 'badge.jsx' });
    const { job: done } = await run(s);
    chmodSync(s.illustrator.harness.path, 0o644);
    writeFileSync(s.illustrator.harness.path, `${readFileSync(s.illustrator.harness.path, 'utf8')}// edited afterwards\n`);
    const j = judgeIllustratorJob(done, s);
    expect(j.outcome).toBe('unknown');
    expect(j.why).toMatch(/harness\.jsx changed since Timmy wrote it/);
    await authored('second');
    writeFileSync(path.join(root, 'clobber.jsx'), "var f = new File(TIMMY.source); f.open('w'); f.write('overwritten by the script'); f.close();\n");
    const e = job('edit', { docFile: 'out/illustrator/second-v1.ai', script: 'clobber.jsx' });
    const je = judgeIllustratorJob((await run(e)).job, e);
    expect(je.outcome).toBe('failed');
    expect(je.why).toMatch(/^out\/illustrator\/second-v1\.ai changed during the run \(its sha256 is not the one recorded at submission\): Timmy never writes it, so the script or something else did; this run's new version is out\/illustrator\/second-v2\.ai/);
  });
});

describe('runs and their records', () => {
  it('a second Illustrator run while one is running and unjudged is refused; a run whose process is gone does not block', () => {
    const first = job('author', { script: 'badge.jsx' });
    noteNativeStarted(first, { id: 'j000001', startedAt: new Date().toISOString(), pid: process.pid } as JobRecord);
    expect(() => job('author', { script: 'badge.jsx' })).toThrow(/another Illustrator run \(.{8}, job j000001, .*\) has not been judged yet; Illustrator runs one script at a time/);
    rmSync(path.join(root, '.timmy'), { recursive: true, force: true });
    const second = job('author', { script: 'badge.jsx' });
    noteNativeStarted(second, { id: 'j000002', startedAt: new Date().toISOString(), pid: spawnSync(process.execPath, ['-e', '']).pid } as JobRecord);
    expect(() => job('author', { script: 'badge.jsx' })).not.toThrow();
  });

  it('reconcileIllustrator judges a run again from its folder after a restart, the exit not recorded', async () => {
    const s = job('author', { script: 'badge.jsx' });
    await run(s);
    const j = reconcileIllustrator(root, s.native.run);
    expect(j.outcome).toBe('ok');
    expect(j.exit.state).toBe('unknown');
    expect(j.illustrator.saved).toMatchObject({ path: 'out/illustrator/badge-v1.ai', created: true });
    expect(j.illustrator.check?.verdict).toBe('agrees');
    expect(readNativeRecord(root, s.native.run)?.verdicts).toHaveLength(1);
    expect(() => reconcileIllustrator(root, '00000000-0000-4000-8000-000000000000')).toThrow(/no record/);
  });
});

describe('the harness and the starters are ExtendScript (ES3); the starter draws in Homebrew\'s colours', () => {
  const code = (text: string): string => text.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const config = {
    v: 1 as const, run: 'r', mode: 'author' as const, root: '/p', result: '/p/r.json', script: '/p/s.jsx', script_dir: '/p', input_sha256: 'a'.repeat(64), open: null, open_rel: null,
    save: '/p/out/illustrator/x-v1.ai', save_rel: 'out/illustrator/x-v1.ai', exports: { svg: { path: '/p/x.svg', rel: 'x.svg' }, pdf: null, png: null }, svg_precision: 3, png_scale: 100, limits: ILLUSTRATOR_LIMITS,
  };

  it('uses nothing ExtendScript lacks, and parses', () => {
    const texts = { harness: illustratorHarness(config), badge: readFileSync(path.join(STARTER, 'badge.jsx'), 'utf8'), edit: readFileSync(path.join(STARTER, 'edit.jsx'), 'utf8') };
    for (const [name, text] of Object.entries(texts)) {
      expect(code(text), name).not.toMatch(/=>|`|\blet\s|\bconst\s|\.forEach\(|\.map\(|\.filter\(|\.trim\(|\bJSON\.|Object\.keys|\.includes\(|\.indexOf\(\[|Array\.isArray/);
      expect(code(text), `${name}: a trailing comma`).not.toMatch(/,\s*[\]}]/);
      expect(() => new vm.Script(text), name).not.toThrow();
    }
    // it never changes a preference
    expect(code(texts.harness)).not.toMatch(/setBooleanPreference|setIntegerPreference|setRealPreference|setStringPreference|removePreference/);
  });

  it('its sha256, as Illustrator would compute it, matches node:crypto at every padding edge', () => {
    const text = illustratorHarness(config);
    const fn = text.slice(text.indexOf('  function sha256Hex'), text.indexOf('\n}(\n/* timmy-illustrator-config'));
    const ctx = vm.createContext({});
    vm.runInContext(fn, ctx);
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 70_000]) {
      const bytes = randomBytes(n);
      expect(vm.runInContext(`sha256Hex(${JSON.stringify(bytes.toString('latin1'))})`, ctx), `${n} bytes`).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('the badge\'s colours are Timmy Homebrew\'s tokens, not new ones', () => {
    const badge = readFileSync(path.join(STARTER, 'badge.jsx'), 'utf8');
    const used = [...badge.matchAll(/rgb\((\d+), (\d+), (\d+)\)/g)].map((m) => `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`);
    expect(used).toHaveLength(3);
    for (const hex of used) expect(Object.values(HOMEBREW)).toContain(hex);
  });
});

describe('/tools: Illustrator (scripting)', () => {
  const none: ProbeDeps = {
    env: {}, onPath: () => false, canvasBuilt: () => false, studio: async () => ({ state: 'not-running' }), studioBase: 'http://127.0.0.1:4337',
    ollama: async () => ({ ok: false, models: [] }), openrouter: async () => 'no-key', modelKeySource: () => null, model: 'm', http: async () => null,
    lanes: () => [], adapters: () => [], receipts: () => ({ ok: true, count: 0 }), exercised: () => new Map(), edgeSet: () => false, exists: () => false,
  };
  const sealed = (ts: string, app: string, outcome: string, status?: string): Record<string, unknown> =>
    ({ kind: 'native', ts, hash: `sha256_${ts}`, ...(status ? { status } : {}), native: { app, outcome, why: 'why', exit_code: 0, signal: null, files: [] } });
  const byId = (rows: CapabilityRow[]) => Object.fromEntries(rows.map((r) => [r.id, r]));

  it('needs setup with the step, or installed where found; "implemented; not run" until a sealed run of its own', async () => {
    const missing = nativeCapabilityRows({}, { platform: 'linux', onPath: () => null }).find((r) => r.id === 'illustrator');
    expect(missing).toMatchObject({ kind: 'adapter', name: 'Illustrator (scripting)', rung: 'needs setup', exercisedBy: 'native:illustrator', tools: ['run_native'] });
    expect(missing?.detail).toMatch(/TIMMY_ILLUSTRATOR is not set.*; implemented; not run/);
    expect(missing?.setup).toMatch(/TIMMY_ILLUSTRATOR/);
    const apps = path.join(tmp, 'Applications');
    fakeApp();
    const found = nativeCapabilityRows({}, { platform: 'darwin', applications: apps, onPath: () => null }).find((r) => r.id === 'illustrator');
    expect(found?.rung).toBe('installed');
    expect(found?.detail).toMatch(/in .*Adobe Illustrator 2026 \(version 2026 by its folder name\), by the \/Applications scan; implemented; not run; makes, edits and reads documents inside the application through osascript \(\/illustrator author, edit, inspect; its window opens; macOS may ask for Automation\), its SVG export read back by Timmy/);
    // Only a sealed Illustrator run judged ok marks the row exercised; another app's ok does not.
    const r1 = byId(await capabilities({ ...none, nativeRuns: () => nativeRunIndex([sealed('2026-10-10T09:00:00Z', 'afterfx', 'ok', 'ok')]) }));
    expect(r1.illustrator.exercised).toBeUndefined();
    expect(r1.illustrator.detail).toMatch(/implemented; not run/);
    const r2 = byId(await capabilities({ ...none, nativeRuns: () => nativeRunIndex([sealed('2026-10-10T10:00:00Z', 'illustrator', 'ok', 'ok')]) }));
    expect(r2.illustrator.exercised).toBe('2026-10-10T10:00:00Z');
    expect(r2.illustrator.detail).toMatch(/last run ok, 2026-10-10T10:00:00Z/);
    expect(r2.afterfx.exercised).toBeUndefined();
  });
});

describe('the run_native agent tool: app illustrator', () => {
  type Exec = (a: Record<string, unknown>) => Promise<Record<string, unknown>>;

  it('is asked every time, with its own reason and each part named; an earlier allow-for-session of run_native does not cover it', async () => {
    const need = approvalNeeded('run_native', { app: 'illustrator', mode: 'edit', project_file: 'out/illustrator/badge-v1.ai', script: 'edit.jsx' });
    expect(need).toEqual({ reason: ILLUSTRATOR_APPROVAL_REASON, summary: 'illustrator edit out/illustrator/badge-v1.ai edit.jsx', session: false });
    expect(approvalNeeded('run_native', { app: 'illustrator', script: 'badge.jsx\x1b]52;c;eA==\x07' })?.summary).toBe('illustrator author badge.jsx');
    // the other apps keep their rule: allowed for the session with "a"
    expect(approvalNeeded('run_native', { app: 'c4dpy', script: 'scene.py' })?.session).toBeUndefined();
    const asked: ApprovalRequest[] = [];
    const ran: string[] = [];
    const tool = { type: 'function', function: { name: 'run_native', execute: async (a: Record<string, unknown>) => { ran.push(String(a.app)); return { ok: true }; } } };
    const [gated] = gateTools([tool], async (req) => { asked.push(req); return 'session'; });
    const exec = (gated.function as unknown as { execute: (a: Record<string, unknown>, c: unknown) => Promise<unknown> }).execute;
    await exec({ app: 'blender', script: 'scene.py' }, {}); // asked, and allowed for the session
    await exec({ app: 'blender', script: 'scene.py' }, {}); // not asked again
    await exec({ app: 'illustrator', script: 'badge.jsx' }, {}); // asked: Illustrator is asked every time
    await exec({ app: 'illustrator', script: 'badge.jsx' }, {}); // asked again
    expect(asked.map((r) => [r.summary, r.session])).toEqual([['blender scene.py', undefined], ['illustrator author badge.jsx', false], ['illustrator author badge.jsx', false]]);
    expect(ran).toEqual(['blender', 'blender', 'illustrator', 'illustrator']);
  });

  it('refuses a call missing what its mode needs, and starts a run that answers at once; judged ok', async () => {
    const m = manager();
    const bin = fakeApp();
    const started: NativeJobSpec[] = [];
    fakeOsascript();
    const [tool] = createNativeTools({
      root: () => root, project: () => 'demo', start: (spec) => m.start(spec), find: { illustrator: () => ({ app: 'illustrator', path: bin, how: 'env' }) },
      onStarted: (_job, spec) => void started.push(spec), env: { PATH: `${path.join(tmp, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    const call = (tool.function as unknown as { execute: Exec }).execute;
    expect(await call({ app: 'illustrator' })).toMatchObject({ ok: false, error: expect.stringMatching(/illustrator author needs script/) });
    expect(await call({ app: 'illustrator', mode: 'edit', script: 'edit.jsx' })).toMatchObject({ ok: false, error: expect.stringMatching(/illustrator edit needs project_file: the \.ai/) });
    expect(await call({ app: 'illustrator', mode: 'inspect' })).toMatchObject({ ok: false, error: expect.stringMatching(/illustrator inspect needs project_file/) });
    expect(m.list()).toHaveLength(0);
    const answer = await call({ app: 'illustrator', script: 'badge.jsx', name: 'badge', timeout_minutes: 1 });
    expect(answer).toMatchObject({
      ok: true, app: 'illustrator', mode: 'author', saved: 'out/illustrator/badge-v1.ai', result_file: `.timmy/native/${answer.run}/result.json`,
      exports: ['out/illustrator/badge-v1.svg', 'out/illustrator/badge-v1.pdf', 'out/illustrator/badge-v1.png'],
    });
    expect(String(answer.note)).toMatch(/^Started, not finished: Adobe Illustrator \(Adobe Illustrator, through osascript\) starts or comes forward and opens its window/);
    expect(String(answer.note)).toMatch(/Timmy then reads the SVG export itself and compares it with Illustrator's report/);
    expect(String(answer.note)).toMatch(/macOS may ask the operator once to allow Automation for Illustrator; Timmy never grants it/);
    expect(started).toHaveLength(1);
    expect(isIllustratorJobSpec(started[0])).toBe(true);
    const done = await m.done(String(answer.job));
    expect(judgeIllustratorJob(done, started[0] as IllustratorJobSpec).outcome).toBe('ok');
    const notFound = createNativeTools({ root: () => root, project: () => 'demo', start: (spec) => m.start(spec), find: { illustrator: () => null } });
    const missing = await (notFound[0].function as unknown as { execute: Exec }).execute({ app: 'illustrator', script: 'badge.jsx' });
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/Illustrator \(scripting\) was not found/), setup: expect.stringMatching(/TIMMY_ILLUSTRATOR/) });
    // the REPL's agent is told what app illustrator does, and that it is asked every time
    expect(REPL_INSTRUCTIONS).toContain('run_native with app illustrator runs a .jsx inside Adobe Illustrator through osascript on macOS');
  });
});

describe('the REPL: /illustrator author, edit, inspect', () => {
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
  const bundle = (): string => path.dirname(path.dirname(path.dirname(fakeApp())));

  it('says before a run that Illustrator opens its window and that the Automation question is the operator\'s; then the files, Illustrator\'s report and Timmy\'s own reading', async () => {
    fakeOsascript();
    const { ws, notes, sealed } = make({ TIMMY_ILLUSTRATOR: bundle(), PATH: path.join(tmp, 'bin') });
    const usage = text(await ws.illustrator(''));
    for (const u of ['/illustrator author <script.jsx> [--name <doc>]', '/illustrator edit <doc.ai> <script.jsx>', '/illustrator inspect <doc.ai>']) expect(usage).toContain(u);
    expect(text(await ws.illustrator('author'))).toMatch(/Usage: \/illustrator author <script\.jsx>/);

    const started = text(await ws.illustrator('author badge.jsx --name badge'));
    expect(started).toMatch(/App {8}Adobe Illustrator, asked through osascript \(do javascript\): it starts, or comes forward, and its window opens/);
    expect(started).toMatch(/macOS may ask once whether the app Timmy runs in \(your terminal, or whichever app started Timmy\) may control Adobe Illustrator \(System Settings › Privacy & Security › Automation; its question names that app\): that is yours to answer; Timmy never grants it, changes it or opens System Settings/);
    expect(started).toMatch(/Saves {6}out\/illustrator\/badge-v1\.ai, a new document; badge-v1\.svg and badge-v1\.pdf beside it, and badge-v1\.png when Illustrator's PNG export allows/);
    expect(started).toMatch(/Running {4}j[0-9a-f]{6} {2}Illustrator makes a document from badge\.jsx · judged by its result file, the files it writes \(Timmy's sha256\) and Timmy's own reading of the SVG/);
    expect(started.indexOf('its window opens')).toBeLessThan(started.indexOf('Running'));
    const id = jobIdOf(started.slice(started.indexOf('Running')));
    await ws.jobs.done(id);
    await settle();
    const ended = notes.join('\n');
    expect(ended).toMatch(new RegExp(`${id} ok  Illustrator · author badge\\.jsx → out/illustrator/badge-v1\\.ai: the result file is this run's`));
    expect(ended).toMatch(/saved {4}out\/illustrator\/badge-v1\.ai · created by this run · sha256 [0-9a-f]{12}… \(Timmy's, after the run\)/);
    expect(ended).toMatch(/exports {2}badge-v1\.svg \(created, sha256 [0-9a-f]{12}…, [\d.]+ KB\) · badge-v1\.pdf \(created, sha256 [0-9a-f]{12}…, \d+ B\) · badge-v1\.png \(created/);
    expect(ended).toContain('reported 1 artboard (600 × 400 pt), 1 layer, 4 shapes, 1 text "TIMMY" · as Illustrator reported its own document, not an independent reading');
    expect(ended).toContain('readback agrees: artboard 600 × 400 (viewBox); 4 shapes (rect 1, circle 1, line 1, polygon 1); text "TIMMY"; bounds (20, 20)–(580, 380) within ±0.001; PNG 600 × 400 px · Timmy\'s own reading of out/illustrator/badge-v1.svg');
    expect(ended).toMatch(/next {5}\/illustrator edit out\/illustrator\/badge-v1\.ai <script\.jsx> saves its next version/);
    const receipt = sealed.find((r) => r.kind === 'native');
    expect(receipt).toMatchObject({ status: 'ok', native: { app: 'illustrator', outcome: 'ok', illustrator: { mode: 'author', saved: { path: 'out/illustrator/badge-v1.ai', sha256: sha(path.join(root, 'out', 'illustrator', 'badge-v1.ai')) }, readback: { verdict: 'agrees' } } } });
    expect(JSON.stringify(receipt)).not.toContain(root);

    notes.length = 0;
    const edited = text(await ws.illustrator('edit out/illustrator/badge-v1.ai edit.jsx'));
    expect(edited).toMatch(/Saves {6}out\/illustrator\/badge-v2\.ai, the next version, with badge-v2\.svg and badge-v2\.pdf \(and badge-v2\.png when it can\); out\/illustrator\/badge-v1\.ai is never written/);
    await ws.jobs.done(jobIdOf(edited.slice(edited.indexOf('Running'))));
    await settle();
    expect(notes.join('\n')).toMatch(/given {4}out\/illustrator\/badge-v1\.ai · unchanged \(sha256 as at submission\)/);
    expect(notes.join('\n')).toContain('text "TIMMY 2"');

    notes.length = 0;
    const inspected = text(await ws.illustrator('inspect out/illustrator/badge-v2.ai'));
    expect(inspected).toMatch(/Saves {6}nothing in the project: it opens out\/illustrator\/badge-v2\.ai to read it, exports an SVG into the run's folder for Timmy's own reading, and closes it unsaved/);
    await ws.jobs.done(jobIdOf(inspected.slice(inspected.indexOf('Running'))));
    await settle();
    expect(notes.join('\n')).toMatch(/ ok  Illustrator · inspect out\/illustrator\/badge-v2\.ai: .*out\/illustrator\/badge-v2\.ai is unchanged/);
    expect(notes.join('\n')).toMatch(/readback agrees: .*Timmy's own reading of \.timmy\/native\/[0-9a-f-]{36}\/inspect\.svg/);
    expect(sealed.filter((r) => r.kind === 'native').map((r) => (r.native as { illustrator?: { mode?: string } }).illustrator?.mode)).toEqual(['author', 'edit', 'inspect']);
  });

  it('a failed run says the error, its line, the result file and where the raw output is; without Illustrator nothing starts and the step is named', async () => {
    fakeOsascript();
    writeFileSync(path.join(root, 'broken.jsx'), 'undefinedThing.call();\n');
    const { ws, notes } = make({ TIMMY_ILLUSTRATOR: bundle(), PATH: path.join(tmp, 'bin') });
    const id = jobIdOf(text(await ws.illustrator('author broken.jsx')).split('Running')[1]);
    await ws.jobs.done(id);
    await settle();
    const ended = notes.join('\n');
    expect(ended).toMatch(new RegExp(`${id} failed`));
    expect(ended).toMatch(/error {4}at script \(line 1\): ReferenceError: undefinedThing is not defined · \.timmy\/native\/[0-9a-f-]{36}\/result\.json · \/jobs j[0-9a-f]{6} for the raw output/);
    expect(ended).not.toMatch(/next /);
    const bare = make({});
    const out = text(await bare.ws.illustrator('author badge.jsx'));
    expect(out).toMatch(/Illustrator \(scripting\) was not found on this machine/);
    expect(out).toMatch(/Setup: install Adobe Illustrator; or set TIMMY_ILLUSTRATOR/);
    expect(out).not.toMatch(/Running/);
  });
});
