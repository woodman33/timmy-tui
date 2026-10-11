/**
 * Round R4 (H51): whether the process a record names is still the one that wrote it, by the proof rule recovery uses
 * (src/repl/recover.ts): a pid alone is never enough, since pids are reused. A record names its writer by pid and by when
 * that process started; the writer is alive only when a process with that pid runs now AND it started then (the process
 * table's elapsed time, whole seconds, within a few seconds of the recorded start). A record whose writer is gone is
 * stale: it is shown as such and never trusted as a live hold.
 */
import { spawnSync } from 'node:child_process';

/** How far a process's start, as the process table reads it (whole seconds), may be from the start a record names. */
export const START_SLACK_MS = 3000;

/** This process as a record names it: its pid, and when it started (from its uptime). */
export const THIS_PROCESS: Readonly<{ pid: number; started: string }> = Object.freeze({
  pid: process.pid,
  started: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
});

/** ps's elapsed time ([[dd-]hh:]mm:ss) in seconds, or undefined. */
export function elapsedSeconds(t: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(t.trim());
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : undefined;
}

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** When the process with this pid started (ms), from the process table, or undefined when it cannot be read or runs no more. */
export function processStartMs(pid: number): number | undefined {
  try {
    const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 });
    if (r.status !== 0 || typeof r.stdout !== 'string') return undefined;
    const secs = elapsedSeconds(r.stdout.trim().split('\n')[0] ?? '');
    return secs === undefined ? undefined : Date.now() - secs * 1000;
  } catch { return undefined; }
}

/**
 * Whether a record's writer runs now: 'alive' (this process, or a process with its pid that started when it did),
 * 'gone' (no such process, or one that started at another time: its pid was reused), or 'unknown' (a process with its
 * pid runs and the process table could not be read). A caller holding something for safety treats 'unknown' as alive.
 */
export function writerState(owner: { pid?: unknown; started?: unknown } | undefined): 'alive' | 'gone' | 'unknown' {
  const pid = owner?.pid;
  const started = typeof owner?.started === 'string' ? Date.parse(owner.started) : Number.NaN;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1 || Number.isNaN(started)) return 'gone';
  if (pid === THIS_PROCESS.pid) return owner?.started === THIS_PROCESS.started ? 'alive' : 'gone';
  if (!pidAlive(pid)) return 'gone';
  const at = processStartMs(pid);
  if (at === undefined) return 'unknown';
  return Math.abs(at - started) <= START_SLACK_MS ? 'alive' : 'gone';
}
