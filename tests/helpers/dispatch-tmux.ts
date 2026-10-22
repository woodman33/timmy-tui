// R8 (H156; R7's open item H): a tmux server of the test file's own for Timmy's dispatch sessions (timmy-dp-<plan id>), and a
// check, after the file's tests, that they left none on the default tmux server.
//
// src/utils/dispatch.ts starts each dispatch in a tmux session; under TIMMY_DISPATCH_DRYRUN=1 its pane runs `echo …; sleep 30`
// and its shell then stays open, so a session no test cancels stays until someone closes it. Up to R7 they were made on the
// default server: 7 after each full suite (1 from tests/context-cone-dispatch.test.ts, 6 from tests/fleet-dispatch.test.ts),
// closed by hand. TIMMY_TMUX_SOCKET=<label> puts them on `tmux -L <label>` instead (src/utils/dispatch.ts); this helper gives
// the file a label of its own and stops that server (kill-server) after the file's tests, with every session on it.
//
// R10 (H163; R9's REMAINING-DEFECTS item 17): a run stopped before its afterAll left its server running (R9: 7 servers, 19
// sessions, stopped by hand). Each label is now written down when the file begins (a file named for it in
// <temporary folder>/timmy-test-dp-servers, with this run's pid and where tmux keeps its socket), and its record is removed once
// its server is stopped. When a file begins, it first stops the servers earlier runs wrote down and did not stop: only those, by
// their own names, and only when the run that wrote one down has ended (its pid no longer runs). An exit hook stops this run's
// own server when its afterAll did not run.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';

/** The dispatch sessions on the server a plain `tmux` reaches (the default one, or the one $TMUX names), as the product did. */
export function dispatchSessionsOnDefault(): string[] {
  const r = spawnSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? (r.stdout ?? '').split('\n').filter((n) => n.startsWith('timmy-dp-')) : [];
}

/** Where the helper writes down the servers it names: one file per server, named for its label. */
export const SERVERS_DIR = (): string => join(tmpdir(), 'timmy-test-dp-servers');
/** A label this helper makes: timmy-test-dp-<pid>-<6 hex>. */
const LABEL = /^timmy-test-dp-(\d+)-[0-9a-f]{6}$/;

export interface ServerRecord { label: string; pid: number; tmuxTmpdir: string }

/** Writes down a server this helper names, before anything can start it. */
export function recordServer(dir: string, r: ServerRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, r.label), `${JSON.stringify({ ...r, at: new Date().toISOString() })}\n`, { mode: 0o600 });
}

const running = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Where tmux keeps a label's socket under a TMUX_TMPDIR (tmux's own rule: <TMUX_TMPDIR or /tmp>/tmux-<uid>/<label>). */
const socketOf = (label: string, tmuxTmpdir: string): string => join(tmuxTmpdir || '/tmp', `tmux-${process.getuid?.() ?? 0}`, label);

/** Stops a server by its own name and removes its socket file (only that label's, only a socket); what was done. */
function stopServer(label: string, tmuxTmpdir: string): { stopped: boolean; socket: 'removed' | 'none' } {
  const env = { ...process.env, TMUX_TMPDIR: tmuxTmpdir };
  const at = spawnSync('tmux', ['-L', label, 'display-message', '-p', '#{socket_path}'], { env, encoding: 'utf8', timeout: 5000 });
  const k = spawnSync('tmux', ['-L', label, 'kill-server'], { env, encoding: 'utf8', timeout: 5000 });
  const socket = at.status === 0 ? (at.stdout ?? '').trim() : socketOf(label, tmuxTmpdir);
  let removed = false;
  try { if (basename(socket) === label && lstatSync(socket).isSocket()) { rmSync(socket, { force: true }); removed = true; } } catch { /* none was made, or it is gone */ }
  return { stopped: k.status === 0, socket: removed ? 'removed' : 'none' };
}

/**
 * Stops the servers earlier runs wrote down in `dir` and did not stop: only records this helper writes (a file named for a
 * label of its own, holding that label), only when the run that wrote one has ended; then removes the record. What it did.
 */
export function sweepLeftServers(dir: string = SERVERS_DIR()): Array<{ label: string; pid: number; stopped: boolean; socket: 'removed' | 'none' }> {
  const done: Array<{ label: string; pid: number; stopped: boolean; socket: 'removed' | 'none' }> = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return done; }
  for (const name of names) {
    const m = LABEL.exec(name);
    if (!m) continue;
    let r: Partial<ServerRecord>;
    try { r = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<ServerRecord>; } catch { continue; }
    if (r.label !== name || typeof r.pid !== 'number' || r.pid !== Number(m[1]) || typeof r.tmuxTmpdir !== 'string') continue;
    if (running(r.pid)) continue;   // its run is still going (or its pid was taken since: left alone either way)
    const s = stopServer(name, r.tmuxTmpdir);
    try { rmSync(join(dir, name), { force: true }); } catch { /* gone */ }
    done.push({ label: name, pid: r.pid, ...s });
  }
  return done;
}

/**
 * Call once at a test file's top level: its dispatches use a tmux server of its own for its whole run, and its afterAll fails
 * when a timmy-dp-* session that was not on the default server when the file began is there when it ends. Which file made it
 * is not known here: files run side by side, so another file's leftover fails this check too (seen at R8: dispatch.test.ts,
 * which cancels its own session, failed on the other two files' sessions); the message names the sessions.
 */
export function dispatchTmuxOfItsOwn(): { label: string } {
  const label = `timmy-test-dp-${process.pid}-${randomBytes(3).toString('hex')}`;
  const tmuxTmpdir = process.env.TMUX_TMPDIR || '/tmp';
  let before: string[] = [];
  let given: string | undefined;
  let stopped = false;
  // stops this file's server (with every session on it) and removes its socket file and its record; once
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    stopServer(label, tmuxTmpdir);
    try { rmSync(join(SERVERS_DIR(), label), { force: true }); } catch { /* gone */ }
  };
  beforeAll(() => {
    sweepLeftServers();
    recordServer(SERVERS_DIR(), { label, pid: process.pid, tmuxTmpdir });
    // a run that ends before its afterAll (an error, a bail, a process.exit) still stops its own server
    process.once('exit', stop);
    before = dispatchSessionsOnDefault();
    given = process.env.TIMMY_TMUX_SOCKET;
    process.env.TIMMY_TMUX_SOCKET = label;
  });
  afterAll(() => {
    if (given === undefined) delete process.env.TIMMY_TMUX_SOCKET; else process.env.TIMMY_TMUX_SOCKET = given;
    // the server's socket file stays after kill-server, and after the server exits by itself when its last session is closed
    // (tests/dispatch.test.ts cancels its only one), so it is removed too: only this label's, only a socket
    stop();
    process.off('exit', stop);
    const left = dispatchSessionsOnDefault().filter((n) => !before.includes(n));
    expect(left, `dispatch sessions that appeared on the default tmux server while this file ran (this file's belong on tmux -L ${label}; a file running beside it may have made them)`).toEqual([]);
  });
  return { label };
}
