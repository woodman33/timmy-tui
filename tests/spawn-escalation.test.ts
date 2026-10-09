/**
 * Round R3 (the independent review of 40022d9, finding 1): a stop that sends only SIGTERM leaves a process
 * that ignores SIGTERM running, and its command pending for ever. spawnProcess now escalates: SIGTERM, then
 * SIGKILL to the same process group after a grace period; and when the output is still open a moment after
 * that (a process that left the group holds it), the outcome settles anyway and says why. The outcome
 * records how far the stop went (killed: 'SIGTERM' | 'SIGKILL' | null).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { killProcessGroup, spawnProcess, type ProcessOutcome } from '../src/runtime/spawn-runtime.js';

/** Process groups and processes a test started: killed after it, whatever happened. */
const groups: number[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of groups.splice(0)) killProcessGroup(pid, 'SIGKILL');
  for (const pid of pids.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
});

/** A shell that ignores SIGTERM, and so does every sleep it starts (an ignored signal stays ignored across exec). */
const STUBBORN = 'trap "" TERM; echo ready; while :; do sleep 0.1; done';

/** The outcome, or 'pending' after ms: an outcome that never settles fails the test instead of hanging it. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> =>
  Promise.race([p, new Promise<'pending'>((resolve) => { setTimeout(() => resolve('pending'), ms).unref(); })]);

const settled = (o: ProcessOutcome | 'pending'): ProcessOutcome => {
  expect(o, 'the outcome never settled').not.toBe('pending');
  return o as ProcessOutcome;
};

describe('a stop escalates to SIGKILL when SIGTERM is ignored', () => {
  it('the time limit: a process group that ignores SIGTERM ends with SIGKILL after the grace period', async () => {
    const t0 = performance.now();
    const { child, outcome } = spawnProcess('sh', ['-c', STUBBORN], { detached: true, timeoutMs: 500, killGraceMs: 300 });
    groups.push(child.pid!);
    const o = settled(await within(outcome, 6000));
    expect(o.timedOut).toBe(true);
    expect(o.signal).toBe('SIGKILL');
    expect(o.killed).toBe('SIGKILL');
    expect(o.error).toBeNull();
    expect(o.stdout).toBe('ready\n');
    expect(performance.now() - t0).toBeLessThan(500 + 300 + 2500);
  });

  it('a child without a group of its own is killed with SIGKILL too', async () => {
    const { child, outcome } = spawnProcess('sh', ['-c', STUBBORN], { timeoutMs: 500, killGraceMs: 300 });
    groups.push(child.pid!);
    const o = settled(await within(outcome, 6000));
    expect(o.timedOut).toBe(true);
    expect(o.signal).toBe('SIGKILL');
    expect(o.killed).toBe('SIGKILL');
  });

  it('an explicit stop() escalates the same way, and is not a time limit', async () => {
    let ready: () => void = () => undefined;
    const up = new Promise<void>((resolve) => { ready = resolve; });
    const run = spawnProcess('sh', ['-c', STUBBORN], { detached: true, killGraceMs: 300, onStdout: (t) => { if (t.includes('ready')) ready(); } });
    groups.push(run.child.pid!);
    await within(up, 5000);
    const t0 = performance.now();
    expect(run.stop()).toBe(true);
    expect(run.stop()).toBe(true); // a second stop joins the first; it starts no second sequence
    const o = settled(await within(run.outcome, 6000));
    expect(o.timedOut).toBe(false);
    expect(o.signal).toBe('SIGKILL');
    expect(o.killed).toBe('SIGKILL');
    expect(performance.now() - t0).toBeGreaterThanOrEqual(250);
    expect(performance.now() - t0).toBeLessThan(300 + 2500);
    expect(run.stop()).toBe(false); // nothing left to stop
  });

  it('the maxBuffer stop escalates too, and keeps its ENOBUFS reason', async () => {
    const { child, outcome } = spawnProcess('sh', ['-c', 'trap "" TERM; while :; do echo 0123456789; done'], { detached: true, maxBuffer: 4096, killGraceMs: 300 });
    groups.push(child.pid!);
    const o = settled(await within(outcome, 6000));
    expect(o.signal).toBe('SIGKILL');
    expect(o.killed).toBe('SIGKILL');
    expect(o.error).toMatch(/^ENOBUFS: stdout exceeded maxBuffer \(4096\)/);
  });
});

describe('output still open after the group is gone', () => {
  it('a grandchild in a new session holding stdout cannot keep the outcome pending: it settles and says why', async () => {
    // The child starts `sleep 30` in a session of its own (Node's detached: setsid), giving it this stdout,
    // prints its pid, and waits. The group's stop ends the child; the sleep keeps the pipe open.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const g = spawn('sleep', ['30'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      'console.log(String(g.pid)); g.unref();',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const t0 = performance.now();
    let grandchild = 0;
    const { child, outcome } = spawnProcess(process.execPath, ['-e', script], {
      detached: true, timeoutMs: 800, killGraceMs: 300, closeWaitMs: 300,
      // read as it arrives, so the test can end the sleep even when the outcome never settles
      onStdout: (t) => { const pid = Number(t.trim().split('\n')[0]); if (!grandchild && pid > 1) { grandchild = pid; pids.push(pid); } },
    });
    groups.push(child.pid!);
    const o = settled(await within(outcome, 8000));
    expect(grandchild).toBeGreaterThan(1);
    expect(o.stdout.trim()).toBe(String(grandchild));
    expect(o.timedOut).toBe(true);
    // The child itself ended on SIGTERM; nothing in its group was left for SIGKILL.
    expect(o.signal).toBe('SIGTERM');
    expect(o.killed).toBe('SIGTERM');
    expect(o.error).toMatch(/output still open after the process group was stopped: a process it started outside its group may still run/);
    expect(performance.now() - t0).toBeLessThan(800 + 300 + 300 + 2500);
    // It really was still running, outside the group: the test, not the runner, ends it.
    expect(() => process.kill(grandchild, 0)).not.toThrow();
  });
});

describe('what a stop does not touch', () => {
  it('a command that ends by itself: no signal, no error, nothing killed', async () => {
    const o = await spawnProcess('sh', ['-c', 'echo hi; echo err >&2; exit 3'], { detached: true, timeoutMs: 10_000, killGraceMs: 300 }).outcome;
    expect(o).toEqual({ status: 3, signal: null, stdout: 'hi\n', stderr: 'err\n', timedOut: false, error: null, killed: null });
  });

  it('a group that obeys SIGTERM ends on it at once: no SIGKILL, no waiting for the grace period', async () => {
    const t0 = performance.now();
    const { child, outcome } = spawnProcess('sh', ['-c', 'sleep 30'], { detached: true, timeoutMs: 300, killGraceMs: 10_000 });
    groups.push(child.pid!);
    const o = settled(await within(outcome, 6000));
    expect(o.signal).toBe('SIGTERM');
    expect(o.killed).toBe('SIGTERM');
    expect(o.timedOut).toBe(true);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
