/**
 * Round R4 (task H16): whether a process group still has a process that runs. A stop asks this before it
 * says a group is gone: spawnProcess (./spawn-runtime.ts) once a stop or a time limit has begun, and
 * JobManager (src/jobs) in its own stop sequence. The check moved here from src/jobs so both ask it the
 * same way.
 *
 * process.kill(-pgid, 0) succeeds while the group has any member, a zombie included. On Linux a zombie (an
 * ended process its new parent has not reaped yet; some inits reap orphans only every second or two) runs
 * nothing, so /proc is read to leave zombies out. Elsewhere the signal check is the answer. Windows has no
 * POSIX process groups: the pid alone is asked there.
 */
import { readdirSync, readFileSync } from 'node:fs';

/** The /proc scan runs at most once per SCAN_MS per group; the cheap signal check runs every time. */
const SCAN_MS = 200;
const scans = new Map<number, { at: number; live: boolean }>();

/**
 * Whether any process of the group `pgid` (the pid of the group's leader) still runs. On Linux a zombie
 * does not count: an init that reaps orphans late must not keep a finished group alive.
 */
export function groupLive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  if (process.platform === 'win32') return pidAlive(pgid);
  let denied = false;
  try { process.kill(-pgid, 0); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
    denied = true; // a member exists that this process may not signal
  }
  if (process.platform !== 'linux') return true;
  const now = performance.now();
  const memo = scans.get(pgid);
  if (memo && now - memo.at < SCAN_MS) return memo.live;
  let names: string[];
  try { names = readdirSync('/proc'); } catch { return true; }
  let live = false;
  let seen = false;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try { stat = readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; }
    // pid (comm) state ppid pgrp ...: comm may hold spaces and parentheses, so read after the last ')'
    const [state, , pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(pgrp) !== pgid) continue;
    seen = true;
    if (state !== 'Z' && state !== 'X') { live = true; break; }
  }
  // A member the signal check found but /proc does not show (hidepid hides other users' processes) may run.
  if (!seen && denied) live = true;
  if (scans.size > 256) scans.clear();
  scans.set(pgid, { at: now, live });
  return live;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
