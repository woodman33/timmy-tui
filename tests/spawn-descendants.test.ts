/**
 * Round R4, task H16 (the independent review of 07f37ec, finding 3): a stopped leader could leave a
 * same-group descendant running. The leader's close cleared the escalation timer, so a leader that obeys
 * SIGTERM could end while a descendant that ignores it (its stdio redirected, so the output closes with the
 * leader) kept running: the outcome settled before the group SIGKILL, which then never came.
 *
 * Once a stop or a time limit has begun, a detached child's outcome now waits for its process group to be
 * gone: SIGKILL after the grace period, then a short wait for the group to go. Everything here runs real
 * processes in real process groups; nothing is mocked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobManager } from '../src/jobs/index.js';
import { killProcessGroup, spawnProcess, type ProcessOutcome } from '../src/runtime/spawn-runtime.js';

let dir = '';
/** Process groups and processes a test started: killed after it, whatever happened. */
const groups: number[] = [];
const pids: number[] = [];
const managers: JobManager[] = [];
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'timmy-descendants-')); });
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stopAll()));
  for (const pid of groups.splice(0)) killProcessGroup(pid, 'SIGKILL');
  for (const pid of pids.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The leader starts a descendant in its own process group with stdin, stdout and stderr on /dev/null (so
 * the leader's output closes when the leader ends). The descendant ignores SIGTERM (an ignored signal stays
 * ignored across exec) and records its pid in the file named by $1; the leader waits for that record, says
 * "ready", and obeys SIGTERM (it sets no trap). $2 is what the descendant runs after its trap.
 */
const LEADER = [
  'sh -c \'trap "" TERM; echo $$ > "$1"; exec sleep 30\' sh "$1" </dev/null >/dev/null 2>&1 &',
  'while [ ! -s "$1" ]; do sleep 0.02; done',
  'echo ready',
  'wait',
].join('\n');

/** The same leader, with a descendant that does obey SIGTERM, 300 ms after it arrives. */
const LEADER_SLOW_DESCENDANT = [
  'sh -c \'trap "sleep 0.3; exit 0" TERM; echo $$ > "$1"; while :; do sleep 0.05; done\' sh "$1" </dev/null >/dev/null 2>&1 &',
  'while [ ! -s "$1" ]; do sleep 0.02; done',
  'echo ready',
  'wait',
].join('\n');

/** Running: the pid exists and is not a zombie (this container's init reaps orphans late, about every 2 s). */
function running(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return false; }
  return !/^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2));
}

/** The process group a pid belongs to (Linux: /proc/<pid>/stat, fifth field). */
function pgidOf(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
}

/** Waits until process.kill(pid, 0) throws, then returns its code; 'alive' if it never did within ms. */
async function errorCode(pid: number, ms: number): Promise<string> {
  const deadline = performance.now() + ms;
  for (;;) {
    try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code ?? 'unknown'; }
    if (performance.now() > deadline) return 'alive';
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The outcome, or 'pending' after ms: an outcome that never settles fails the test instead of hanging it. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> =>
  Promise.race([p, new Promise<'pending'>((resolve) => { setTimeout(() => resolve('pending'), ms).unref(); })]);

const settled = (o: ProcessOutcome | 'pending'): ProcessOutcome => {
  expect(o, 'the outcome never settled').not.toBe('pending');
  return o as ProcessOutcome;
};

async function until<T>(probe: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = performance.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Starts the leader through spawnProcess and waits until its descendant is in place. */
async function startLeader(script: string, options: Parameters<typeof spawnProcess>[2] = {}) {
  const pidFile = path.join(dir, 'descendant.pid');
  let ready: () => void = () => undefined;
  const up = new Promise<void>((resolve) => { ready = resolve; });
  const run = spawnProcess('sh', ['-c', script, 'sh', pidFile], { detached: true, ...options, onStdout: (t) => { if (t.includes('ready')) ready(); } });
  groups.push(run.child.pid!);
  expect(await within(up, 8000), 'the leader never said ready').not.toBe('pending');
  const descendant = Number(readFileSync(pidFile, 'utf8').trim());
  expect(descendant).toBeGreaterThan(1);
  pids.push(descendant);
  return { run, descendant };
}

describe.skipIf(process.platform === 'win32')('a stopped process group does not settle while a member still runs', () => {
  it('stop(): the leader obeys SIGTERM, its descendant ignores it; the group gets SIGKILL before the outcome settles', async () => {
    const grace = 400;
    const { run, descendant } = await startLeader(LEADER, { killGraceMs: grace, closeWaitMs: 1500 });
    if (process.platform === 'linux') expect(pgidOf(descendant), 'the descendant is in the leader\'s group').toBe(run.child.pid);
    expect(running(descendant)).toBe(true);
    const t0 = performance.now();
    // what was still running at the moment the outcome settled, read in the same tick
    const atSettle = run.outcome.then((o) => ({ o, descendantRunning: running(descendant), ms: performance.now() - t0 }));
    expect(run.stop()).toBe(true);
    const s = await within(atSettle, 8000);
    expect(s, 'the outcome never settled').not.toBe('pending');
    if (s === 'pending') return;
    // The outcome did not settle before the SIGKILL: when it settled, the descendant was no longer running,
    // and the grace period had passed (the leader itself ended on the SIGTERM, at once).
    expect(s.descendantRunning).toBe(false);
    expect(s.ms).toBeGreaterThanOrEqual(grace - 50);
    expect(s.o.signal).toBe('SIGTERM');
    expect(s.o.killed).toBe('SIGKILL');
    expect(s.o.timedOut).toBe(false);
    expect(s.o.error).toBeNull();
    expect(s.o.cleanup).toBe('complete');
    expect(s.o.stdout).toBe('ready\n');
    // and it is gone for good once its new parent has reaped it
    expect(await errorCode(descendant, 5000)).toBe('ESRCH');
    expect(run.stop()).toBe(false);
  });

  it('the time limit takes the same path: timedOut, SIGKILL to the group, and no member left', async () => {
    const grace = 300;
    const pidFile = path.join(dir, 'descendant.pid');
    const t0 = performance.now();
    const run = spawnProcess('sh', ['-c', LEADER, 'sh', pidFile], { detached: true, timeoutMs: 1500, killGraceMs: grace, closeWaitMs: 1500 });
    groups.push(run.child.pid!);
    const descendant = await until(() => (existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8').trim()) > 1 ? Number(readFileSync(pidFile, 'utf8').trim()) : undefined), 8000);
    pids.push(descendant);
    const atSettle = run.outcome.then((o) => ({ o, descendantRunning: running(descendant), ms: performance.now() - t0 }));
    const s = await within(atSettle, 10_000);
    expect(s, 'the outcome never settled').not.toBe('pending');
    if (s === 'pending') return;
    expect(s.descendantRunning).toBe(false);
    expect(s.ms).toBeGreaterThanOrEqual(1500 + grace - 50);
    expect(s.o.timedOut).toBe(true);
    expect(s.o.killed).toBe('SIGKILL');
    expect(s.o.error).toBeNull();
    expect(s.o.cleanup).toBe('complete');
    expect(await errorCode(descendant, 5000)).toBe('ESRCH');
  });

  it('a descendant that obeys SIGTERM a little late is waited for, without waiting out the grace period', async () => {
    const grace = 5000;
    const { run, descendant } = await startLeader(LEADER_SLOW_DESCENDANT, { killGraceMs: grace, closeWaitMs: 1000 });
    const t0 = performance.now();
    const atSettle = run.outcome.then((o) => ({ o, descendantRunning: running(descendant), ms: performance.now() - t0 }));
    run.stop();
    const s = await within(atSettle, 8000);
    expect(s, 'the outcome never settled').not.toBe('pending');
    if (s === 'pending') return;
    expect(s.descendantRunning).toBe(false);
    expect(s.ms).toBeGreaterThanOrEqual(250); // the descendant's own 300 ms, not the leader's prompt end
    expect(s.ms).toBeLessThan(grace);
    expect(s.o.killed).toBe('SIGTERM'); // SIGTERM was enough: no SIGKILL was needed
    expect(s.o.error).toBeNull();
    expect(s.o.cleanup).toBe('complete');
  });

  it('a child that ends by itself leaves what it started running, and the outcome notes it (information only)', async () => {
    const pidFile = path.join(dir, 'left.pid');
    const o = settled(await within(spawnProcess('sh', ['-c', 'sh -c \'echo $$ > "$1"; exec sleep 30\' sh "$1" </dev/null >/dev/null 2>&1 & while [ ! -s "$1" ]; do sleep 0.02; done; exit 0', 'sh', pidFile], { detached: true, killGraceMs: 300 }).outcome, 8000));
    const left = Number(readFileSync(pidFile, 'utf8').trim());
    pids.push(left);
    expect(o).toMatchObject({ status: 0, signal: null, timedOut: false, error: null, killed: null, cleanup: 'left-running' });
    // nothing signalled it: it still runs
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(running(left)).toBe(true);
  });

  it('a child that ends by itself with nothing left carries no cleanup note', async () => {
    const o = settled(await within(spawnProcess('sh', ['-c', 'exit 0'], { detached: true }).outcome, 5000));
    expect(o.cleanup).toBeUndefined();
    expect(o).toEqual({ status: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null, killed: null });
  });
});

describe.skipIf(process.platform === 'win32')('the JobManager path (/stop) runs its own sequence: the same case through it', () => {
  it('JobManager.stop: the job ends cancelled only once the descendant that ignored SIGTERM is gone', async () => {
    const m = new JobManager({ dir: path.join(dir, 'jobs') });
    managers.push(m);
    const pidFile = path.join(dir, 'descendant.pid');
    const job = m.start({ kind: 'task', label: 'leader with a stubborn descendant', project: 'descendants-test', root: dir, command: 'sh', args: ['-c', LEADER, 'sh', pidFile] });
    await until(() => (m.tail(job.id).includes('ready') ? true : undefined), 8000);
    const descendant = Number(readFileSync(pidFile, 'utf8').trim());
    pids.push(descendant);
    const leader = m.get(job.id)?.pid as number;
    groups.push(leader);
    if (process.platform === 'linux') expect(pgidOf(descendant)).toBe(leader);
    const grace = 400;
    const t0 = performance.now();
    const done = await within(m.stop(job.id, grace).then((j) => ({ j, descendantRunning: running(descendant), ms: performance.now() - t0 })), 10_000);
    expect(done, 'the stop never ended').not.toBe('pending');
    if (done === 'pending') return;
    expect(done.descendantRunning).toBe(false);
    expect(done.ms).toBeGreaterThanOrEqual(grace - 50);
    expect(done.j).toMatchObject({ state: 'cancelled', signal: 'SIGTERM', cleanup: 'complete' });
    expect(done.j?.error).toBeUndefined();
    expect(await errorCode(descendant, 5000)).toBe('ESRCH');
  });
});
