/**
 * Round R4 (helper H41): the file aerender writes is decided by its output module, not by the name it is given. On the
 * operator's Mac, After Effects 2026 asked for out/promo-v2.mov wrote out/promo-v2.mp4 (H.264) and the run was judged
 * unknown. Now, when the file asked for is absent and the run created exactly one file of the same name with another
 * extension in that folder (absent at submission, there after, made during the run), that file is judged in its place
 * and the verdict, the REPL line and the receipt say so; more than one is unknown, naming them. `/ae ... --om <template>`
 * passes -OMtemplate, unchecked.
 *
 * Everything here runs against TEST DOUBLES: tests/fixtures/fake-aerender.mjs (its modes mp4-for-mov and two-files
 * stand in for the output module; it writes a few bytes, not a movie). No aerender or After Effects runs in this suite.
 *
 * R4 (H46, ledger row 153): aerender also writes a folder of its own logs beside the project ("<project>.aep Logs/"). A
 * run that made one names it after its verdict as aerender's own log folder (not judged); FAKE_AERENDER_LOGS=1 makes the
 * FAKE aerender write one.
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobManager, type JobRecord } from '../src/jobs/index.js';
import { AERENDER_INSTEAD_NOTE, AERENDER_LOGS_NOTE, aerenderJob, judgeNativeJob, nativeReceiptFields, readNativeRecord, reconcileNative, type NativeJobSpec } from '../src/native/index.js';
import { AE_RENDER_NOTES, parseAeRenderArgs } from '../src/native/ae-author.js';
import { folderProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { ReceiptInput } from '../src/utils/receipts.js';

const FAKE = path.join(__dirname, 'fixtures', 'fake-aerender.mjs');
let tmp = '';
let root = '';
let managers: JobManager[] = [];
let spaces: Workspace[] = [];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'timmy-aerender-out-')));
  root = path.join(tmp, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'title.aep'), 'fake project bytes');
  managers = [];
  spaces = [];
});
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const m of managers) await m.stopAll();
  rmSync(tmp, { recursive: true, force: true });
});

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
/** An executable copy of the FAKE aerender (made executable here, whatever the checkout's modes). */
function fake(): string {
  const at = path.join(tmp, 'bin', 'aerender');
  mkdirSync(path.dirname(at), { recursive: true });
  copyFileSync(FAKE, at);
  chmodSync(at, 0o755);
  return at;
}
function spec(mode: string, extra: Partial<Parameters<typeof aerenderJob>[0]> = {}): NativeJobSpec {
  return aerenderJob({ projectFile: 'title.aep', comp: 'Main', output: 'out/title.mov', root, project: 'demo', timeoutMs: 20_000, bin: fake(), env: { FAKE_AERENDER_MODE: mode }, ...extra });
}
async function run(s: NativeJobSpec): Promise<{ m: JobManager; job: JobRecord; out: string }> {
  const m = new JobManager({ dir: path.join(tmp, 'jobs') });
  managers.push(m);
  const done = await m.done(m.start(s).id);
  return { m, job: done, out: m.tail(done.id, 50).join('\n') };
}

describe('aerender writes the output\'s name with another extension (FAKE aerender)', () => {
  it('one file of the same name, made by the run: judged in place of the one asked for, ok when aerender exited 0; said in the why and the receipt', async () => {
    const s = spec('mp4-for-mov');
    expect(s.native.siblings).toEqual({ folder: 'out', stem: 'title', ext: '.mov', listed: true });
    expect(JSON.parse(readFileSync(path.join(root, '.timmy', 'native', s.native.run, 'job.json'), 'utf8')).siblings).toEqual({ folder: 'out', stem: 'title', ext: '.mov', listed: true });
    const { job, out } = await run(s);
    expect(out).toContain('wrote title.mp4 (fake-aerender, FAKE_AERENDER_MODE=mp4-for-mov');
    const j = judgeNativeJob(job, s);
    expect(j.outcome).toBe('ok');
    expect(j.why).toBe(`aerender wrote out/title.mp4 instead of out/title.mov (not there): ${AERENDER_INSTEAD_NOTE}; out/title.mp4 (created) written during the run, from title.aep as submitted; aerender exited 0`);
    expect(j.instead).toEqual({ requested: 'out/title.mov', written: 'out/title.mp4', note: AERENDER_INSTEAD_NOTE });
    expect(j.files).toEqual([
      { path: 'out/title.mov', present: false, written: false, change: 'absent' },
      { path: 'out/title.mp4', present: true, written: true, change: 'created', sha256: sha(path.join(root, 'out', 'title.mp4')) },
    ]);
    const sealed = nativeReceiptFields('aerender', j);
    expect(sealed).toMatchObject({ status: 'ok', native: { outcome: 'ok', why: j.why, instead: { requested: 'out/title.mov', written: 'out/title.mp4', note: AERENDER_INSTEAD_NOTE } } });
    expect(readNativeRecord(root, s.native.run)?.verdicts.at(-1)).toMatchObject({ outcome: 'ok', instead: { written: 'out/title.mp4' } });
  });

  it('beside a project of the same name (out/ae/promo-v2.aep): the project was there before, so it is never taken; the .mp4 is', async () => {
    mkdirSync(path.join(root, 'out', 'ae'), { recursive: true });
    copyFileSync(path.join(root, 'title.aep'), path.join(root, 'out', 'ae', 'promo-v2.aep'));
    const s = spec('mp4-for-mov', { projectFile: 'out/ae/promo-v2.aep', output: 'out/ae/promo-v2.mov' });
    expect(Object.keys(s.native.pre ?? {}).sort()).toEqual(['out/ae/promo-v2.aep', 'out/ae/promo-v2.mov']);
    const j = judgeNativeJob((await run(s)).job, s);
    expect(j.outcome).toBe('ok');
    expect(j.instead?.written).toBe('out/ae/promo-v2.mp4');
    expect(j.why).toMatch(/^aerender wrote out\/ae\/promo-v2\.mp4 instead of out\/ae\/promo-v2\.mov \(not there\)/);
    expect(j.files.map((f) => f.path)).toEqual(['out/ae/promo-v2.mov', 'out/ae/promo-v2.mp4']);
  });

  it('more than one: unknown, naming each, none judged', async () => {
    const s = spec('two-files');
    const j = judgeNativeJob((await run(s)).job, s);
    expect(j.outcome).toBe('unknown');
    expect(j.why).toBe(`aerender exited 0, but out/title.mov (not there) was not written by this run; this run created out/title.avi and out/title.mp4, the same name with other extensions (${AERENDER_INSTEAD_NOTE}): more than one, so which is its output is not known`);
    expect(j.instead).toEqual({ requested: 'out/title.mov', candidates: ['out/title.avi', 'out/title.mp4'], note: AERENDER_INSTEAD_NOTE });
    expect(nativeReceiptFields('aerender', j)).toMatchObject({ native: { outcome: 'unknown', instead: { candidates: ['out/title.avi', 'out/title.mp4'] } } });
    expect(nativeReceiptFields('aerender', j).status).toBeUndefined();
  });

  it('a file of that name there before the run, which the run changed, is not taken: unknown, and said so', async () => {
    mkdirSync(path.join(root, 'out'), { recursive: true });
    writeFileSync(path.join(root, 'out', 'title.mp4'), 'an older render, from before this run');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(path.join(root, 'out', 'title.mp4'), old, old);
    const s = spec('mp4-for-mov');
    expect(s.native.pre?.['out/title.mp4']).toMatchObject({ state: 'present' });
    const j = judgeNativeJob((await run(s)).job, s);
    expect(j.outcome).toBe('unknown');
    expect(j.instead).toBeUndefined();
    expect(j.why).toBe('aerender exited 0, but out/title.mov (not there; out/title.mp4 was there before this run and changed during it, so not taken as its output) was not written by this run');
  });

  it('the file asked for, when written, decides as before; a file of the same name left from before (unchanged) is never a candidate', async () => {
    const ok = spec('ok');
    const j = judgeNativeJob((await run(ok)).job, ok);
    expect(j).toMatchObject({ outcome: 'ok', why: 'out/title.mov (created) written during the run, from title.aep as submitted; aerender exited 0' });
    expect(j.instead).toBeUndefined();
    rmSync(path.join(root, 'out'), { recursive: true });
    mkdirSync(path.join(root, 'out'));
    writeFileSync(path.join(root, 'out', 'title.mp4'), 'left from before');
    const none = spec('no-output');
    const n = judgeNativeJob((await run(none)).job, none);
    expect(n).toMatchObject({ outcome: 'unknown', why: 'aerender exited 0, but out/title.mov (not there) was not written by this run' });
    expect(n.instead).toBeUndefined();
  });

  it('after a restart: reconcileNative applies the same rule from the run\'s own record', async () => {
    const s = spec('mp4-for-mov');
    const { job } = await run(s);
    const again = reconcileNative(root, s.native.run, { job });
    expect(again).toMatchObject({ outcome: 'ok', instead: { written: 'out/title.mp4' } });
    // Without the job's record its exit is not known: the file still stands in, and the outcome waits on the exit.
    const orphan = reconcileNative(root, s.native.run);
    expect(orphan.outcome).toBe('unknown');
    expect(orphan.why).toMatch(/^aerender wrote out\/title\.mp4 instead of out\/title\.mov \(not there\): .*; out\/title\.mp4 \(created\) written during the run, but aerender ended without a recorded exit status/);
  });
});

describe('R4 (H46): aerender\'s own log folder beside the project (FAKE aerender, FAKE_AERENDER_LOGS=1)', () => {
  it('one this run made is named after the verdict, in its verdict line and its receipt; it decides nothing', async () => {
    const s = spec('ok', { env: { FAKE_AERENDER_LOGS: '1' } });
    expect(s.native.logs).toEqual({ folder: 'title.aep Logs', there: false });
    expect(JSON.parse(readFileSync(path.join(root, '.timmy', 'native', s.native.run, 'job.json'), 'utf8')).logs).toEqual({ folder: 'title.aep Logs', there: false });
    const j = judgeNativeJob((await run(s)).job, s);
    expect(j.outcome).toBe('ok');
    expect(j.why).toBe(`out/title.mov (created) written during the run, from title.aep as submitted; aerender exited 0; title.aep Logs/: ${AERENDER_LOGS_NOTE}`);
    expect(AERENDER_LOGS_NOTE).toBe('aerender\'s own log folder (not judged)');
    expect(j.logFolders).toEqual(['title.aep Logs/']);
    // Not one of the files judged.
    expect(j.files.map((f) => f.path)).toEqual(['out/title.mov']);
    expect(readNativeRecord(root, s.native.run)?.verdicts.at(-1)).toMatchObject({ outcome: 'ok', logFolders: ['title.aep Logs/'] });
    expect(nativeReceiptFields('aerender', j).native.log_folders).toEqual(['title.aep Logs/']);
    // After a restart, from the run's own record, the same.
    expect(reconcileNative(root, s.native.run)).toMatchObject({ logFolders: ['title.aep Logs/'] });
  });

  it('beside a project in a folder (out/ae/promo-v2.aep): "out/ae/promo-v2.aep Logs/"; a folder there before the run is not this run\'s and is not named', async () => {
    mkdirSync(path.join(root, 'out', 'ae'), { recursive: true });
    copyFileSync(path.join(root, 'title.aep'), path.join(root, 'out', 'ae', 'promo-v2.aep'));
    const first = spec('ok', { projectFile: 'out/ae/promo-v2.aep', output: 'out/ae/promo-v2.mov', env: { FAKE_AERENDER_LOGS: '1' } });
    const j1 = judgeNativeJob((await run(first)).job, first);
    expect(j1.logFolders).toEqual(['out/ae/promo-v2.aep Logs/']);
    expect(j1.why).toContain(`; out/ae/promo-v2.aep Logs/: ${AERENDER_LOGS_NOTE}`);
    // A second run of the same project: the folder was there at its submission, so it is not named for it.
    const second = spec('ok', { projectFile: 'out/ae/promo-v2.aep', output: 'out/ae/promo-v2-b.mov', env: { FAKE_AERENDER_LOGS: '1' } });
    expect(second.native.logs).toEqual({ folder: 'out/ae/promo-v2.aep Logs', there: true });
    const j2 = judgeNativeJob((await run(second)).job, second);
    expect(j2.outcome).toBe('ok');
    expect(j2.logFolders).toBeUndefined();
    expect(j2.why).not.toContain(AERENDER_LOGS_NOTE);
  });

  it('a run that made none says nothing of one', async () => {
    const s = spec('ok');
    const j = judgeNativeJob((await run(s)).job, s);
    expect(j.logFolders).toBeUndefined();
    expect(j.why).toBe('out/title.mov (created) written during the run, from title.aep as submitted; aerender exited 0');
  });
});

describe('/ae <project> <comp> <output> --om <template> (FAKE aerender)', () => {
  const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
  function make() {
    const notes: string[] = [];
    const sealed: ReceiptInput[] = [];
    const ws = new Workspace({
      glyphs: glyphSet(true), env: {}, onPath: () => null, notify: (l) => notes.push(l.map((s) => s.text).join('')),
      openWeb: (url) => url, link: (t) => t, seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
      jobsDir: path.join(tmp, 'ws-jobs'), chdir: () => {},
    }, folderProject(root));
    spaces.push(ws);
    return { ws, notes, sealed };
  }
  /** /ae's render form finds aerender, and its job takes its environment, from this process's environment: set for one test. */
  async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
    const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }

  it('reads --om, before or after the positions, with = or not; refuses one without a name, or another option', () => {
    expect(parseAeRenderArgs(['a.aep', 'Main Comp', 'out/a.mov', '--om', 'H.264 - Match Render Settings - 15 Mbps'])).toEqual({ projectFile: 'a.aep', comp: 'Main Comp', output: 'out/a.mov', omTemplate: 'H.264 - Match Render Settings - 15 Mbps' });
    expect(parseAeRenderArgs(['--om=Lossless', 'a.aep', 'Main', 'out/a.mov'])).toEqual({ projectFile: 'a.aep', comp: 'Main', output: 'out/a.mov', omTemplate: 'Lossless' });
    expect(parseAeRenderArgs(['a.aep', 'Main', 'out/a.mov'])).toEqual({ projectFile: 'a.aep', comp: 'Main', output: 'out/a.mov' });
    expect(parseAeRenderArgs(['a.aep', 'Main', 'out/a.mov', '--om'])).toEqual({ error: expect.stringMatching(/^--om needs an output module template's name/) });
    expect(parseAeRenderArgs(['a.aep', 'Main', 'out/a.mov', '--rs', 'Best'])).toEqual({ error: expect.stringMatching(/^No option --rs: the render form takes --om <template>\. Usage: \/ae <project\.aep> <comp> <output file> \[--om <template>\]$/) });
    expect(parseAeRenderArgs(['a.aep', 'Main'])).toEqual({ error: 'Usage: /ae <project.aep> <comp> <output file> [--om <template>]' });
  });

  it('passes it to aerender as -OMtemplate, as given; the usage says the names are After Effects\' own and unchecked', async () => {
    await withEnv({ TIMMY_AERENDER: fake() }, async () => {
      const { ws, notes, sealed } = make();
      const usage = text(await ws.ae(''));
      expect(usage).toContain('/ae <project.aep> <comp> <output file> [--om <template>]');
      for (const n of AE_RENDER_NOTES) expect(usage).toContain(n);
      expect(usage).toMatch(/differ by version and language; Timmy does not check them/);
      const started = text(await ws.ae('title.aep "Main Comp" out/title.mov --om "H.264 - Match Render Settings - 15 Mbps"'));
      expect(started).toContain('After Effects renders Main Comp from title.aep with the output module template "H.264 - Match Render Settings - 15 Mbps" (After Effects\' own name; Timmy does not check it)');
      const id = /\b(j[0-9a-f]{6})\b/.exec(started)![1];
      expect(ws.jobs.get(id)!.args.slice(-2)).toEqual(['-OMtemplate', 'H.264 - Match Render Settings - 15 Mbps']);
      const [run] = readdirSync(path.join(root, '.timmy', 'native'));
      expect(readNativeRecord(root, run)!.job.args.slice(-2)).toEqual(['-OMtemplate', 'H.264 - Match Render Settings - 15 Mbps']);
      await ws.jobs.done(id);
      expect(ws.jobs.tail(id, 20).join('\n')).toContain('output module template "H.264 - Match Render Settings - 15 Mbps" (fake-aerender: recorded, not applied');
      // The fake wrote what was asked (no FAKE_AERENDER_MODE here): judged as before.
      await new Promise((r) => setTimeout(r, 150));
      expect(notes.join('\n')).toMatch(new RegExp(`${id} ok  After Effects · title\\.aep › Main Comp: out/title\\.mov \\(created\\) written during the run`));
      expect(text(await ws.ae('title.aep Main out/x.mov --om'))).toMatch(/--om needs an output module template's name/);
      expect(sealed.filter((r) => r.kind === 'native')).toHaveLength(1);
    });
  });

  it('the end line and the receipt of a run that wrote .mp4 when asked for .mov say so plainly', async () => {
    await withEnv({ TIMMY_AERENDER: fake(), FAKE_AERENDER_MODE: 'mp4-for-mov' }, async () => {
      const { ws, notes, sealed } = make();
      const started = text(await ws.ae('title.aep Main out/title.mov'));
      const id = /\b(j[0-9a-f]{6})\b/.exec(started)![1];
      await ws.jobs.done(id);
      await new Promise((r) => setTimeout(r, 150));
      expect(notes.join('\n')).toContain(`${id} ok  After Effects · title.aep › Main: aerender wrote out/title.mp4 instead of out/title.mov (not there): aerender's output module decides the container, and aerender gives the file that container's extension; out/title.mp4 (created) written during the run`);
      const receipt = sealed.find((r) => r.kind === 'native');
      expect(receipt).toMatchObject({ status: 'ok', native: { app: 'aerender', outcome: 'ok', instead: { requested: 'out/title.mov', written: 'out/title.mp4' } } });
      expect(JSON.stringify(receipt)).not.toContain(root);
    });
  });

  it('R4 (H46): the end line and the receipt of a run that made aerender\'s own log folder name it, not judged', async () => {
    await withEnv({ TIMMY_AERENDER: fake(), FAKE_AERENDER_LOGS: '1' }, async () => {
      const { ws, notes, sealed } = make();
      const started = text(await ws.ae('title.aep Main out/title.mov'));
      const id = /\b(j[0-9a-f]{6})\b/.exec(started)![1];
      await ws.jobs.done(id);
      await new Promise((r) => setTimeout(r, 150));
      expect(notes.join('\n')).toContain(`${id} ok  After Effects · title.aep › Main: out/title.mov (created) written during the run, from title.aep as submitted; aerender exited 0; title.aep Logs/: ${AERENDER_LOGS_NOTE}`);
      expect(sealed.find((r) => r.kind === 'native')).toMatchObject({ status: 'ok', native: { app: 'aerender', log_folders: ['title.aep Logs/'] } });
    });
  });
});
