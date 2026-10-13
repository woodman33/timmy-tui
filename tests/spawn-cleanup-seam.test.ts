/**
 * Round R4, task H16: the unresolved report. A process group that SIGKILL cannot empty cannot be made here:
 * the tests run with the right to signal every process, and there is no portable way to hold a process in
 * an uninterruptible wait. So these tests use a SEAM: ../src/runtime/process-group.js is mocked so that
 * groupLive keeps answering "live" for one chosen group after it is gone. Everything else is real:
 * the processes, their groups, the signals and the timers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The groups the seam reports as live whatever is left of them. */
const stuck = vi.hoisted(() => new Set<number>());
vi.mock('../src/runtime/process-group.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/runtime/process-group.js')>();
  return { ...actual, groupLive: (pgid: number) => stuck.has(pgid) || actual.groupLive(pgid) };
});

import { JobManager, type JobRecord } from '../src/jobs/index.js';
import { killProcessGroup, spawnProcess, type ProcessOutcome } from '../src/runtime/spawn-runtime.js';

const groups: number[] = [];
const dirs: string[] = [];
afterEach(() => {
  stuck.clear();
  for (const pid of groups.splice(0)) killProcessGroup(pid, 'SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const within = <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> =>
  Promise.race([p, new Promise<'pending'>((resolve) => { setTimeout(() => resolve('pending'), ms).unref(); })]);

/** Starts `sh -c script` as a detached child, its group reported live for ever by the seam, once it says ready. */
async function startStuck(script: string, options: Parameters<typeof spawnProcess>[2]) {
  let ready: () => void = () => undefined;
  const up = new Promise<void>((resolve) => { ready = resolve; });
  const run = spawnProcess('sh', ['-c', script], { detached: true, ...options, onStdout: (t) => { if (t.includes('ready')) ready(); } });
  groups.push(run.child.pid!);
  stuck.add(run.child.pid!);
  expect(await within(up, 8000), 'the child never said ready').not.toBe('pending');
  return run;
}

describe.skipIf(process.platform === 'win32')('cleanup unresolved (seam: groupLive reports a group that is gone)', () => {
  it('seam: spawnProcess settles closeWaitMs after the SIGKILL with cleanup unresolved, and says so', async () => {
    const run = await startStuck('trap "" TERM; echo ready; while :; do sleep 0.1; done', { killGraceMs: 200, closeWaitMs: 300 });
    const t0 = performance.now();
    run.stop();
    const o = await within(run.outcome, 6000);
    expect(o, 'the outcome never settled').not.toBe('pending');
    const out = o as ProcessOutcome;
    expect(performance.now() - t0).toBeGreaterThanOrEqual(200 + 300 - 50);
    expect(out.killed).toBe('SIGKILL');
    expect(out.signal).toBe('SIGKILL');
    expect(out.cleanup).toBe('unresolved');
    expect(out.error).toBe(`process group ${run.child.pid} still had processes after SIGKILL: cleanup unresolved`);
  });

  it('seam: when the SIGKILL reached no process the error says that instead', async () => {
    // The leader (sleep, after the exec) obeys SIGTERM and starts nothing, so the real group is empty before
    // the SIGKILL, not even a zombie left in it; the seam still calls it live.
    const run = await startStuck('echo ready; exec sleep 30', { killGraceMs: 200, closeWaitMs: 300 });
    run.stop();
    const o = await within(run.outcome, 6000);
    expect(o, 'the outcome never settled').not.toBe('pending');
    const out = o as ProcessOutcome;
    expect(out.killed).toBe('SIGTERM');
    expect(out.cleanup).toBe('unresolved');
    expect(out.error).toBe(`process group ${run.child.pid} still had processes that SIGKILL could not reach: cleanup unresolved`);
  });

  it('seam: a JobManager job that timed out keeps its reason and adds that its group did not stop, in its record too', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'timmy-cleanup-seam-'));
    dirs.push(dir);
    const jobs = path.join(dir, 'jobs');
    // the seam marks the group as soon as the job has a process, before its time limit's SIGTERM
    const m = new JobManager({ dir: jobs, onChange: (job) => { if (job.pid !== undefined && job.state === 'running') { stuck.add(job.pid); groups.push(job.pid); } } });
    const job = m.start({ kind: 'task', label: 'stuck group', project: 'cleanup-seam', root: dir, command: 'sh', args: ['-c', 'echo ready; while :; do sleep 0.1; done'], timeoutMs: 300 });
    const done = await within(m.done(job.id), 12_000);
    expect(done, 'the job never ended').not.toBe('pending');
    expect(done).toMatchObject({ state: 'failed', error: 'timed out; some processes it started did not stop', cleanup: 'unresolved' });
    // the record a later session reads carries the same
    const listed = new JobManager({ dir: jobs }).get(job.id) as JobRecord;
    expect(listed).toMatchObject({ state: 'failed', error: 'timed out; some processes it started did not stop', cleanup: 'unresolved' });
  }, 15_000);
});
