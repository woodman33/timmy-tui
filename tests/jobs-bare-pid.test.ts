/**
 * Round R4, task H29 (2): once a job's first process (its group's leader) has exited and been reaped, its pid may
 * belong to another process. killProcessGroup fell back to signalling that bare pid whenever the group signal failed
 * (no such group: its last process ended in the meantime), so a stop could reach an unrelated process.
 *
 * Pid reuse cannot be arranged on demand, so these tests use a SEAM at the OS boundary: process.kill is wrapped so
 * that (1) the job's group answers ESRCH, as a group whose last process just ended does (groupLive's probe too), and
 * (2) the leader's pid names a real, unrelated decoy process, as it would after reuse. Everything else is real: the
 * job, its process group, the decoy, the JobManager and its timers, and every signal that is delivered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobManager, type JobSpec } from '../src/jobs/index.js';
import { groupLive } from '../src/runtime/process-group.js';
import { killProcessGroup } from '../src/runtime/spawn-runtime.js';

let dir = '';
let managers: JobManager[] = [];
let groups: number[] = [];
let children: ChildProcess[] = [];

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'timmy-bare-pid-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(managers.map((m) => m.stopAll()));
  for (const g of groups) if (groupLive(g)) try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ }
  for (const c of children) c.kill('SIGKILL'); // a no-op once the child has exited and been reaped
  managers = []; groups = []; children = [];
  rmSync(dir, { recursive: true, force: true });
});

const until = async <T>(what: string, probe: () => T | undefined, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
/** Runs (not gone, not a zombie its parent has yet to reap). */
function runs(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop() ?? '').startsWith('Z'); } catch { return true; }
}
/** An unrelated process: not in any job's group. */
async function decoy(): Promise<ChildProcess> {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(c);
  await new Promise<void>((resolve, reject) => { c.once('spawn', resolve); c.once('error', reject); });
  return c;
}
/** A job whose first process exits at once, leaving `sleep 30` running in its group: the job stays running. */
async function lingering(): Promise<{ m: JobManager; id: string; leader: number }> {
  const m = new JobManager({ dir });
  managers.push(m);
  const spec: JobSpec = { kind: 'task', label: 'lingering group', project: 'bare-pid', root: dir, command: 'sh', args: ['-c', 'sleep 30 >/dev/null 2>&1 & echo child=$!'] };
  const id = m.start(spec).id;
  const leader = await until('the job to start', () => m.get(id)?.pid);
  groups.push(leader);
  await until('its first process to end while its group runs on', () => (m.get(id)?.note ? true : undefined));
  expect(m.get(id)?.state).toBe('running');
  expect(groupLive(leader)).toBe(true);
  return { m, id, leader };
}
/** The seam: the job's group is gone (ESRCH), and its leader's pid now names `reused`. Returns every call made. */
function pidReuseSeam(leader: number, reused: number): Array<[number, string | number | undefined]> {
  const real = process.kill.bind(process);
  const calls: Array<[number, string | number | undefined]> = [];
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    calls.push([pid, signal]);
    if (pid === -leader) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH', errno: -3, syscall: 'kill' });
    return real(pid === leader ? reused : pid, signal as NodeJS.Signals);
  }) as typeof process.kill);
  return calls;
}

describe.skipIf(process.platform === 'win32')('never the bare pid of a leader that has exited (seam: pid reuse)', () => {
  it('seam: stop() of a job whose leader has exited signals only its group, never an unrelated process now holding that pid', async () => {
    const { m, id, leader } = await lingering();
    const other = await decoy();
    const calls = pidReuseSeam(leader, other.pid!);
    let stopped;
    try { stopped = await m.stop(id, 100); } finally { vi.restoreAllMocks(); }
    expect(stopped).toMatchObject({ state: 'cancelled' });
    expect(calls.some(([pid, signal]) => pid === -leader && signal === 'SIGTERM'), 'its group was signalled').toBe(true);
    expect(calls.filter(([pid]) => pid === leader), 'the bare pid of its exited leader').toEqual([]);
    await new Promise((r) => setTimeout(r, 200));
    expect(runs(other.pid!), 'the unrelated process still runs').toBe(true);
  });

  it('seam: signalNow() (the REPL exiting at once) never signals the bare pid of a leader that has exited', async () => {
    const { m, id, leader } = await lingering();
    const other = await decoy();
    const calls = pidReuseSeam(leader, other.pid!);
    let delivered;
    try { delivered = m.signalNow(id, 'SIGTERM'); } finally { vi.restoreAllMocks(); }
    expect(delivered).toBe(false);
    expect(calls.filter(([pid]) => pid === leader)).toEqual([]);
    await new Promise((r) => setTimeout(r, 200));
    expect(runs(other.pid!)).toBe(true);
  });

  it('signalNow() reaches the group of a job whose leader has exited, and leaves another session\'s job alone', async () => {
    const { m, id, leader } = await lingering();
    expect(m.signalNow(id, 'SIGTERM')).toBe(true);
    await until('the rest of its group to end', () => (groupLive(leader) ? undefined : true));
    // a job this manager did not start (another session's record) is never signalled from here
    expect(new JobManager({ dir }).signalNow(id, 'SIGTERM')).toBe(false);
    expect(m.signalNow('j000000', 'SIGTERM')).toBe(false);
  });

  it('killProcessGroup: told the leader has exited, a failed group signal stops there; otherwise the bare pid is signalled', async () => {
    // a child without a group of its own: its pid names no group, so the group signal fails (ESRCH)
    const plain = await decoy();
    expect(killProcessGroup(plain.pid!, 'SIGTERM', { leaderExited: true })).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(runs(plain.pid!), 'nothing was delivered to the bare pid').toBe(true);
    const ended = new Promise<NodeJS.Signals | null>((resolve) => plain.once('exit', (_code, signal) => resolve(signal)));
    expect(killProcessGroup(plain.pid!, 'SIGTERM')).toBe(true);
    expect(await ended).toBe('SIGTERM');
  });
});
