/**
 * R7 (H149): the REPL follows the active project (src/repl/project-follow.ts), and what runs keeps the project it started in.
 *
 * Real files throughout: the active-project record of this test file's own Timmy home (tests/isolation-setup.ts), written as
 * src/project/index.ts saveActiveProject writes it (whole, then renamed into place: another surface's write, here made from this
 * process), watched by the real follower (fs.watch and its once-a-second poll); a real Workspace with its real JobManager. FAKE,
 * said where used: upmd is the repository's test double (tests/fixtures/fake-upmd.mjs, not upmd), whose block sleeps.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activeProjectPath, folderProject, projectId, saveActiveProject, type ActiveProject } from '../src/project/index.js';
import { ActiveProjectFollower, readActiveRecord, type Busy, type StillRunning } from '../src/repl/project-follow.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Segment } from '../src/term/theme.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';

const g = glyphSet(true);
const made: string[] = [];
const stops: Array<() => unknown> = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: () => boolean, ms = 4000): Promise<number> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (what()) return Date.now() - t0; await sleep(10); }
  throw new Error('waited too long');
};
const text = (l: Segment[]): string => l.map((s) => s.text).join('');
function project(name: string): ActiveProject {
  const base = mkdtempSync(join(tmpdir(), `timmy-follow-${name}-`));
  made.push(base);
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  return { name, root, chosen: true };
}
/** Another surface's choice (as the Workbench's picker writes the record: src/project/index.ts saveActiveProject). */
const chooseElsewhere = (p: ActiveProject, by?: string): void => saveActiveProject(p, by ? { by } : {});

function follower(o: { current: () => ActiveProject; busy?: () => Busy | null; running?: (root: string) => StillRunning[] }) {
  let here = o.current();
  const notes: string[] = [];
  const moved: ActiveProject[] = [];
  const f = new ActiveProjectFollower({
    file: activeProjectPath(), current: () => here, busy: o.busy ?? (() => null), glyphs: g,
    move: (p) => { here = p; moved.push(p); },
    running: o.running ?? (() => []),
    notify: (l) => notes.push(text(l)),
  });
  stops.push(() => f.stop());
  return { f, notes, moved, here: () => here };
}

describe('the follower of the active-project record (R7 H149)', () => {
  it('the record as the REPL starts is not a change; another surface\'s change moves the REPL within a second and says so; the REPL\'s own choice moves nothing', async () => {
    const tray = project('tray');
    const blank = project('blank');
    const other = project('other');
    chooseElsewhere(other);
    const w = follower({ current: () => folderProject(tray.root) });
    w.f.start();
    await sleep(300);
    expect(w.moved).toEqual([]);
    // the Workbench's picker chooses blank
    const t0 = Date.now();
    chooseElsewhere(blank, 'workbench');
    await until(() => w.moved.length === 1, 1500);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(w.here()).toEqual({ name: 'blank', root: blank.root, chosen: true });
    expect(w.notes).toEqual(['  → Now in blank: the active project changed (chosen in the Workbench), and this REPL follows it; /project shows it.']);
    // this REPL's own /project writes the record for the project it is in already: nothing moves, nothing is said
    saveActiveProject(w.here(), { by: 'repl' });
    await sleep(1300);
    expect(w.moved).toHaveLength(1);
    expect(w.notes).toHaveLength(1);
  });

  it('a request running when the change arrives finishes first: the REPL says it will follow, then follows by the record as it is when the request ends', async () => {
    const tray = project('tray');
    const blank = project('blank');
    const third = project('third');
    let busy: Busy | null = 'turn';
    const w = follower({ current: () => tray, busy: () => busy, running: (root) => (root === tray.root ? [{ id: 'j1a2b3c4', what: 'preview the project' }] : []) });
    w.f.start();
    chooseElsewhere(blank, 'workbench');
    await until(() => w.notes.length === 1);
    expect(w.moved).toEqual([]);
    expect(w.notes[0]).toBe('  → The active project is now blank (chosen in the Workbench): this REPL follows blank once this turn ends; the turn finishes in tray.');
    expect(w.f.pending).toBe('blank');
    // another change while the turn runs: said once for the new project; the record as it is when the turn ends is followed
    chooseElsewhere(third);
    await until(() => w.notes.length === 2);
    expect(w.notes[1]).toBe('  → The active project is now third (chosen elsewhere): this REPL follows third once this turn ends; the turn finishes in tray.');
    w.f.idle();
    expect(w.moved).toEqual([]); // still busy: nothing yet
    busy = null;
    w.f.idle();
    expect(w.moved.map((p) => p.name)).toEqual(['third']);
    expect(w.notes[2]).toBe('  → Now in third: the active project changed (chosen elsewhere), and this REPL follows it. j1a2b3c4 (preview the project), started in tray, keeps running there, with its records, logs and receipts.');
    expect(w.f.pending).toBeNull();
  });

  it('the record back on the REPL\'s project before its request ends: the REPL stays, and says so once; a command and an action are named as such', async () => {
    const tray = project('tray');
    const blank = project('blank');
    let busy: Busy | null = 'command';
    const w = follower({ current: () => tray, busy: () => busy });
    w.f.start();
    chooseElsewhere(blank, 'repl');
    await until(() => w.notes.length === 1);
    expect(w.notes[0]).toBe('  → The active project is now blank (chosen in another Timmy REPL): this REPL follows blank once this command ends; it finishes in tray.');
    chooseElsewhere(tray, 'workbench');
    await until(() => w.notes.length === 2);
    expect(w.notes[1]).toBe('  → The active project is tray again: this REPL stays in tray.');
    busy = null;
    w.f.idle();
    expect(w.moved).toEqual([]);
    expect(w.notes).toHaveLength(2);
    busy = 'action';
    chooseElsewhere(blank, 'workbench');
    await until(() => w.notes.length === 3);
    expect(w.notes[2]).toBe('  → The active project is now blank (chosen in the Workbench): this REPL follows blank once the action running now ends; it finishes in tray.');
  });

  it('reads the record as readActiveProject does: a folder that is one; `by` only when it is a surface it knows; a name with control characters is said without them', () => {
    const p = project('tray');
    const file = activeProjectPath();
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({ name: 'tray', root: p.root, at: 'now', by: 'workbench' }));
    expect(readActiveRecord(file)).toMatchObject({ project: { name: 'tray', root: p.root, chosen: true }, by: 'workbench' });
    writeFileSync(file, JSON.stringify({ name: 'tray', root: p.root, by: '<script>' }));
    expect(readActiveRecord(file)?.by).toBeNull();
    writeFileSync(file, JSON.stringify({ name: 'gone', root: join(p.root, 'nope') }));
    expect(readActiveRecord(file)).toBeNull();
    writeFileSync(file, 'not json');
    expect(readActiveRecord(file)).toBeNull();
  });
});

describe('the Workspace follows without writing the record again, and what runs keeps its project (R7 H149)', () => {
  function workspace(start: ActiveProject, o: { surface?: 'repl'; env?: NodeJS.ProcessEnv } = {}) {
    const notes: string[] = [];
    const switched: string[] = [];
    const jobs = join(mkdtempSync(join(tmpdir(), 'timmy-follow-jobs-')), 'jobs');
    made.push(join(jobs, '..'));
    const ws = new Workspace({
      glyphs: g, env: o.env ?? {}, onPath: () => null, notify: (l) => notes.push(text(l)), openWeb: (url) => `Open ${url}`, link: (t) => t,
      seal: (input) => appendReceipt('runs', input).hash.slice(7, 15), jobsDir: jobs, chdir: () => {}, recoverAtStart: false, runProgress: false,
      onSwitch: (p) => { switched.push(p.name); return `a new conversation, kept in ${p.name}`; },
      ...(o.surface ? { surface: o.surface } : {}),
    }, start);
    stops.push(() => ws.close());
    return { ws, notes, switched };
  }

  it('follow() moves the project as /project does (its conversation too), without writing the record; /project writes it, with the surface that chose', () => {
    const tray = project('tray');
    const blank = project('blank');
    const { ws, switched } = workspace(folderProject(tray.root), { surface: 'repl' });
    chooseElsewhere(blank, 'workbench');
    const before = readFileSync(activeProjectPath());
    ws.follow({ name: 'blank', root: blank.root, chosen: true });
    expect(ws.project).toEqual({ name: 'blank', root: blank.root, chosen: true });
    expect(ws.root).toBe(blank.root);
    expect(switched).toEqual(['blank']);
    expect(readFileSync(activeProjectPath())).toEqual(before);
    expect(ws.summary().map(text).join('\n')).toContain('Project  blank');
    ws.project_(tray.root);
    expect(JSON.parse(readFileSync(activeProjectPath(), 'utf8'))).toMatchObject({ name: 'tray', root: tray.root, by: 'repl' });
  });

  it('says what of it runs (a turn, a command, an action) while its request runs, and tells who asked once none runs', async () => {
    const tray = project('tray');
    const { ws } = workspace(tray);
    let ends = 0;
    ws.afterRequests(() => { ends += 1; });
    expect(ws.busy).toBeNull();
    let release!: () => void;
    const turn = ws.operate('hello there', 'repl', () => new Promise<void>((r) => { release = r; }));
    expect(ws.busy).toBe('turn');
    const command = ws.operate('/files', 'repl', () => sleep(30));
    expect(ws.busy).toBe('turn');
    await command;
    expect(ends).toBe(0);
    release();
    await turn;
    expect(ws.busy).toBeNull();
    expect(ends).toBe(1);
    const slash = ws.operate('/files', 'repl', () => { expect(ws.busy).toBe('command'); });
    await slash;
    await ws.operate('run docs/x.md build', 'board', () => { expect(ws.busy).toBe('action'); });
    expect(ends).toBe(3);
  });

  it('a /run started in tray keeps tray when the REPL follows blank while it starts: its job, record and receipts are tray\'s (FAKE upmd)', async () => {
    const tray = project('tray');
    const blank = project('blank');
    writeFileSync(join(tray.root, 'BUILD.md'), '# Build\n\n```bash [name:build]\nsleep 2; echo built > out.txt\n```\n');
    const { ws } = workspace(tray, { env: { UPMD_BIN: resolve('tests/fixtures/fake-upmd.mjs'), PATH: process.env.PATH } });
    const started = ws.run('BUILD.md build');
    // the follow lands while /run awaits its first check (upmd's version): what it starts must still be tray's
    ws.follow({ name: 'blank', root: blank.root, chosen: true });
    const lines = (await started).map(text).join('\n');
    const id = /Running {4}(j[0-9a-f]+)/.exec(lines)?.[1];
    expect(id, lines).toBeTruthy();
    const job = ws.jobs.get(id!)!;
    expect({ project: job.project, root: job.root }).toEqual({ project: 'tray', root: tray.root });
    expect(ws.runningIn(tray.root).map((r) => r.id)).toContain(id);
    expect(ws.runningIn(blank.root)).toEqual([]);
    // /project in blank names the job with the project it runs in
    await until(() => ws.jobs.get(id!)?.state === 'running', 5000);
    expect(ws.summary().map(text).join('\n')).toContain(`Jobs     ${id} running (in tray)`);
    const predicted = readChain('runs').filter((r) => r.kind === 'predict');
    expect(predicted.map((r) => ({ project: r.project, project_id: r.project_id }))).toEqual([{ project: 'tray', project_id: projectId(tray.root) }]);
    // it stops as tray's, and its receipt says so
    const stopped = (await ws.stop(id!)).map(text).join('\n');
    expect(stopped).toContain(`${id} cancelled`);
    await until(() => readChain('runs').some((r) => r.kind === 'workflow'), 5000);
    const sealed = readChain('runs').filter((r) => r.kind === 'workflow');
    expect(sealed.map((r) => ({ project: r.project, project_id: r.project_id }))).toEqual([{ project: 'tray', project_id: projectId(tray.root) }]);
    expect(existsSync(join(blank.root, 'out.txt'))).toBe(false);
  });
});
