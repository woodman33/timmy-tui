// Round R4 (H67, ledger row 162): the pty wrapper's stop file as Timmy reads it (src/workflows/pty-stop.ts), the job record's
// new fields (src/jobs: a step's `seen`, `expected`, `interrupted.rest` and `.wrapper`) read back by another manager, the
// run's own folder, and the wrapper's options in a job's arguments (src/workflows/upmd-live.ts). The stop files and job
// records here are SYNTHETIC (written by hand in the shapes the wrapper and src/jobs write; no process ran them); the
// wrapper itself runs for real in tests/workflow-parent-death.test.ts and tests/workflow-recover.test.ts.
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobManager, type JobStep } from '../src/jobs/index.js';
import { makeRunFolder, mergePtyStop, readPtyStop, wrapperDid, type PtyStop } from '../src/workflows/pty-stop.js';
import { runBlocks } from '../src/workflows/run-blocks.js';
import { isLiveRun, liveProgram, upmdJob, wrapperStopFile } from '../src/workflows/upmd-live.js';

const dirs: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const T = (s: number): string => new Date(Date.UTC(2026, 9, 10, 9, 0, 0) + s * 1000).toISOString();
/** SYNTHETIC: a stop file's object in the wrapper's shape. */
const stopOf = (o: Partial<PtyStop> = {}): PtyStop => ({
  wrapper_pid: 4242, command: 'upmd', command_pid: 4243, started_at: T(0), at: T(9), why: 'its parent (process 4000) ended',
  parent: { pid: 4000, ended: true }, stopped: true, stopping_at: T(8), said: 'its parent (process 4000) ended: stopping upmd (process group 4243) with SIGTERM',
  signals: ['SIGTERM'], groups: [4243, 4250], left: [], exit: 143, blocks: [], ...o,
});
const write = (dir: string, value: unknown): string => { const f = join(dir, 'stop.json'); writeFileSync(f, typeof value === 'string' ? value : JSON.stringify({ schema: 'timmy.pty-stop/1', ...value as object }), { mode: 0o600 }); return f; };

describe("reading a wrapper's stop file", () => {
  it('takes only a regular file of the shape, written by the job\'s own process; says why otherwise', () => {
    const dir = temp('h67-read-');
    expect(readPtyStop(join(dir, 'stop.json'), { pid: 4242 })).toEqual({ ok: false, why: 'its pty wrapper wrote no stop file' });
    const good = write(dir, stopOf({ blocks: [{ n: 1, count: 2, name: 'first', state: 'completed', code: 0, started_at: T(1), ended_at: T(2) }, { n: 2, count: 2, state: 'stopped', started_at: T(3), stopped_at: T(8) }] }));
    const read = readPtyStop(good, { pid: 4242 });
    expect(read.ok && read.stop.blocks.map((b) => [b.n, b.name ?? null, b.state])).toEqual([[1, 'first', 'completed'], [2, null, 'stopped']]);
    expect(readPtyStop(good, { pid: 999 })).toEqual({ ok: false, why: "its pty wrapper's stop file names process 4242, not the run's (999)" });
    // another process's, or not the wrapper's shape: not used
    for (const bad of ['{', JSON.stringify({ schema: 'other/1' }), JSON.stringify({ ...stopOf(), schema: 'timmy.pty-stop/1', signals: ['TERM'] }), JSON.stringify({ ...stopOf(), schema: 'timmy.pty-stop/1', blocks: [{ n: 0, state: 'completed' }] })]) {
      const d = temp('h67-bad-');
      const r = readPtyStop(write(d, bad), { pid: 4242 });
      expect(r.ok, bad.slice(0, 40)).toBe(false);
    }
    // a link is not followed; a file over 64 KB is not read
    const linked = temp('h67-link-');
    symlinkSync(good, join(linked, 'stop.json'));
    expect(readPtyStop(join(linked, 'stop.json'), { pid: 4242 })).toEqual({ ok: false, why: "its pty wrapper's stop file is not one Timmy reads (a regular file of at most 64 KB)" });
    const big = temp('h67-big-');
    expect(readPtyStop(write(big, 'x'.repeat(65 * 1024)), { pid: 4242 }).ok).toBe(false);
  });
});

describe('joining the wrapper\'s account to what Timmy recorded', () => {
  const steps = (): JobStep[] => [{ name: 'first', index: 1, state: 'completed', code: 0, startedAt: T(1), endedAt: T(2) }, { name: 'second', index: 2, state: 'running', startedAt: T(3) }];

  it('a block whose end only the wrapper saw takes its end; a block only it saw start is added and interrupted; what comes after is not run', () => {
    // SYNTHETIC: the REPL saw second start; the wrapper saw second end and third start before it stopped upmd.
    const stop = stopOf({ blocks: [
      { n: 1, count: 3, name: 'first', state: 'completed', code: 0, started_at: T(1), ended_at: T(2) },
      { n: 2, count: 3, name: 'second', state: 'completed', code: 0, started_at: T(3), ended_at: T(5) },
      { n: 3, count: 3, state: 'stopped', started_at: T(5), stopped_at: T(8) },
    ] });
    const m = mergePtyStop(steps(), stop, (n, count) => (count === 3 ? ['first', 'second', 'third'][n - 1] : undefined));
    expect(m.steps).toEqual([
      { name: 'first', index: 1, state: 'completed', code: 0, startedAt: T(1), endedAt: T(2) },
      { name: 'second', index: 2, state: 'completed', code: 0, startedAt: T(3), endedAt: T(5), seen: 'wrapper' },
      { name: 'third', index: 3, state: 'interrupted', startedAt: T(5), endedAt: T(8), seen: 'wrapper' },
    ]);
    expect(m).toMatchObject({ running: 'third', ended: ['second'], rest: 'not run', upmdEnded: false });
    expect(m.account).toEqual({ why: 'its parent (process 4000) ended', at: T(8), stopped: true, signals: ['SIGTERM'], left: 0, exit: 143 });
    // a block known by number only, its name not known anywhere: named by its number
    expect(mergePtyStop([], stopOf({ blocks: [{ n: 4, count: 9, state: 'stopped', stopped_at: T(8) }] })).steps[0].name).toBe('block 4');
  });

  it('what Timmy saw end stands; a group left after SIGKILL proves nothing of what came after; a command never started proves all', () => {
    const own = steps();
    own[1] = { ...own[1], state: 'failed', code: 3, endedAt: T(4) };
    const m = mergePtyStop(own, stopOf({ left: [4250], signals: ['SIGTERM', 'SIGKILL'], blocks: [{ n: 2, name: 'second', state: 'completed', code: 0, ended_at: T(6) }] }));
    expect(m.steps[1]).toEqual({ name: 'second', index: 2, state: 'failed', code: 3, startedAt: T(3), endedAt: T(4) });
    expect(m).toMatchObject({ ended: [], rest: 'not seen' });
    expect(m.account.left).toBe(1);
    expect(mergePtyStop([], stopOf({ command_pid: null, stopped: false, signals: [], groups: [], exit: null, why: 'its parent (process 4000) had ended before upmd started' }))).toMatchObject({ rest: 'not run', upmdEnded: false, steps: [] });
    expect(mergePtyStop(steps(), stopOf({ stopped: false, signals: [], groups: [], exit: 0, why: 'upmd ended by itself', blocks: [{ n: 2, name: 'second', state: 'completed', code: 0, ended_at: T(6) }] }))).toMatchObject({ rest: 'not run', upmdEnded: true, ended: ['second'] });
  });

  it('says what the wrapper did, in words, for each way it ends', () => {
    const a = (o: Partial<PtyStop>) => mergePtyStop([], stopOf(o)).account;
    expect(wrapperDid(a({}))).toBe('its pty wrapper saw its REPL end and stopped upmd at once (SIGTERM)');
    expect(wrapperDid(a({ signals: ['SIGTERM', 'SIGKILL'], left: [77] }))).toBe('its pty wrapper saw its REPL end and stopped upmd at once (SIGTERM, then SIGKILL); 1 process group of it still ran after SIGKILL');
    expect(wrapperDid(a({ why: 'SIGINT received', signals: ['SIGINT'] }))).toBe('its pty wrapper received SIGINT and stopped upmd (SIGINT)');
    expect(wrapperDid(a({ why: 'its output could not be written any more', signals: ['SIGHUP'] }))).toBe('its pty wrapper stopped upmd (SIGHUP): its output could not be written any more');
    expect(wrapperDid(a({ stopped: false, signals: [], exit: 0, why: 'upmd ended by itself' }))).toBe('its pty wrapper saw upmd end by itself (exit 0)');
    expect(wrapperDid(a({ stopped: false, signals: [], exit: null, command_pid: null, why: 'its parent (process 4000) had ended before upmd started' }))).toBe('its REPL had ended before upmd started, so its pty wrapper did not start upmd');
  });
});

describe("the job record's new fields, read back by another manager", () => {
  it("keeps a step's seen, the run's expected order and its interrupted rest and wrapper account; old records read as before", () => {
    const dir = join(temp('h67-jobs-'), 'jobs');
    mkdirSync(dir, { recursive: true });
    const gone = 2147480000;
    // SYNTHETIC: a /run record its REPL left, in src/jobs' shape
    writeFileSync(join(dir, 'j0c0d0e.json'), JSON.stringify({
      id: 'j0c0d0e', kind: 'workflow', label: 'probe.md › third', project: 'demo', root: dir, command: 'python3', args: ['-I', 'pty_run.py', '--stop-file', join(dir, 'stop.json'), '--', 'upmd'],
      state: 'running', pid: gone, startedAt: T(0), lines: 9, expected: { steps: ['first', 'second', 'third'], receipt: 'abcd1234' },
      steps: [{ name: 'first', index: 1, state: 'completed', code: 0 }, { name: 'second', index: 2, state: 'running', startedAt: T(3) }],
    }));
    const m = new JobManager({ dir });
    expect(m.get('j0c0d0e')).toMatchObject({ stale: true, expected: { steps: ['first', 'second', 'third'], receipt: 'abcd1234' } });
    const merged = mergePtyStop(m.get('j0c0d0e')!.steps, stopOf({ blocks: [{ n: 2, state: 'stopped', stopped_at: T(8) }] }));
    const ended = m.endLeft('j0c0d0e', { state: 'cancelled', error: 'interrupted: …', cleanup: 'complete', steps: merged.steps, interrupted: { step: merged.running, rest: merged.rest, wrapper: merged.account } })!;
    const again = new JobManager({ dir }).get('j0c0d0e')!;
    expect(again).toEqual(ended);
    expect(again).toMatchObject({ state: 'cancelled', interrupted: { step: 'second', rest: 'not run', wrapper: { why: 'its parent (process 4000) ended', stopped: true, signals: ['SIGTERM'], left: 0, exit: 143 } } });
    expect(again.steps[1]).toEqual({ name: 'second', index: 2, state: 'interrupted', startedAt: T(3), endedAt: T(8), seen: 'wrapper' });
    // the views read third as not run: the account proves it
    expect(runBlocks(again, again.expected!.steps).map((b) => [b.name, b.word])).toEqual([['first', 'completed'], ['second', 'interrupted'], ['third', 'not run']]);
    // endLeft as before H67 (its callers in recover.ts): running steps interrupted, the record names the newest; rest not set
    writeFileSync(join(dir, 'j0c0d0f.json'), JSON.stringify({ id: 'j0c0d0f', kind: 'workflow', label: 'probe.md › third', project: 'demo', root: dir, command: 'upmd', args: [], state: 'running', pid: gone, startedAt: T(0), lines: 0, steps: [{ name: 'first', index: 1, state: 'running' }] }));
    const old = new JobManager({ dir }).endLeft('j0c0d0f', { state: 'failed', error: 'interrupted', interrupted: true })!;
    expect(old.interrupted).toEqual({ step: 'first' });
    expect(runBlocks(old, ['first', 'second']).map((b) => b.word)).toEqual(['interrupted', 'not seen']);
  });
});

describe("the run's own folder, and the wrapper's options in a job's arguments", () => {
  it('makes <jobs>/runs/w<8 hex>/ (0700) and names stop.json in it; nothing when it cannot be made', () => {
    const jobs = join(temp('h67-folder-'), 'jobs');
    const file = makeRunFolder(jobs)!;
    expect(basename(file)).toBe('stop.json');
    expect(basename(dirname(file))).toMatch(/^w[0-9a-f]{8}$/);
    expect(dirname(dirname(file))).toBe(join(jobs, 'runs'));
    expect(lstatSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(makeRunFolder(jobs)).not.toBe(file);
    const blocked = temp('h67-blocked-');
    writeFileSync(join(blocked, 'jobs'), 'a file where the folder would be');
    expect(makeRunFolder(join(blocked, 'jobs'))).toBeUndefined();
  });

  it('puts --parent and --stop-file before the wrapper\'s --; a live run is still told by its wrapper, with or without them', () => {
    const pty = { ok: true as const, python: '/usr/bin/python3', script: '/pkg/workers/upmd/pty_run.py' };
    const job = upmdJob('/opt/upmd', ['--ci', '-b', 'third'], pty, { parent: 4000, stopFile: '/jobs/runs/w0011aabb/stop.json' });
    expect(job.args).toEqual(['-I', '/pkg/workers/upmd/pty_run.py', '--parent', '4000', '--stop-file', '/jobs/runs/w0011aabb/stop.json', '--', '/opt/upmd', '--ci', '-b', 'third']);
    expect([isLiveRun(job.args), wrapperStopFile(job.args), liveProgram({ kind: 'workflow', args: job.args })]).toEqual([true, '/jobs/runs/w0011aabb/stop.json', '/opt/upmd']);
    const before = ['-I', '/pkg/workers/upmd/pty_run.py', '--', '/opt/upmd', '--ci'];
    expect([isLiveRun(before), wrapperStopFile(before)]).toEqual([true, undefined]);
    const pipe = upmdJob('/opt/upmd', ['--ci', '-b', 'third'], { ok: false, why: 'no python3 on PATH' }, { parent: 4000, stopFile: '/x/stop.json' });
    expect([pipe.args, isLiveRun(pipe.args), wrapperStopFile(pipe.args)]).toEqual([['--ci', '-b', 'third'], false, undefined]);
  });
});
