// R8 (H156; R7's open item H): a tmux server of the test file's own for Timmy's dispatch sessions (timmy-dp-<plan id>), and a
// check, after the file's tests, that they left none on the default tmux server.
//
// src/utils/dispatch.ts starts each dispatch in a tmux session; under TIMMY_DISPATCH_DRYRUN=1 its pane runs `echo …; sleep 30`
// and its shell then stays open, so a session no test cancels stays until someone closes it. Up to R7 they were made on the
// default server: 7 after each full suite (1 from tests/context-cone-dispatch.test.ts, 6 from tests/fleet-dispatch.test.ts),
// closed by hand. TIMMY_TMUX_SOCKET=<label> puts them on `tmux -L <label>` instead (src/utils/dispatch.ts); this helper gives
// the file a label of its own and stops that server (kill-server) after the file's tests, with every session on it.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';

/** The dispatch sessions on the server a plain `tmux` reaches (the default one, or the one $TMUX names), as the product did. */
export function dispatchSessionsOnDefault(): string[] {
  const r = spawnSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? (r.stdout ?? '').split('\n').filter((n) => n.startsWith('timmy-dp-')) : [];
}

/**
 * Call once at a test file's top level: its dispatches use a tmux server of its own for its whole run, and its afterAll fails
 * when a timmy-dp-* session that was not on the default server when the file began is there when it ends. Which file made it
 * is not known here: files run side by side, so another file's leftover fails this check too (seen at R8: dispatch.test.ts,
 * which cancels its own session, failed on the other two files' sessions); the message names the sessions.
 */
export function dispatchTmuxOfItsOwn(): { label: string } {
  const label = `timmy-test-dp-${process.pid}-${randomBytes(3).toString('hex')}`;
  let before: string[] = [];
  let given: string | undefined;
  beforeAll(() => {
    before = dispatchSessionsOnDefault();
    given = process.env.TIMMY_TMUX_SOCKET;
    process.env.TIMMY_TMUX_SOCKET = label;
  });
  afterAll(() => {
    if (given === undefined) delete process.env.TIMMY_TMUX_SOCKET; else process.env.TIMMY_TMUX_SOCKET = given;
    // the server's socket file stays after kill-server, and after the server exits by itself when its last session is closed
    // (tests/dispatch.test.ts cancels its only one), so it is removed too: only this label's, only a socket. Where tmux put it:
    // as the server says, or, with no server left, tmux's own default place for a label
    const at = spawnSync('tmux', ['-L', label, 'display-message', '-p', '#{socket_path}'], { encoding: 'utf8', timeout: 5000 });
    spawnSync('tmux', ['-L', label, 'kill-server'], { encoding: 'utf8', timeout: 5000 });
    const socket = at.status === 0 ? (at.stdout ?? '').trim() : join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`, label);
    try { if (basename(socket) === label && lstatSync(socket).isSocket()) rmSync(socket, { force: true }); } catch { /* none was made */ }
    const left = dispatchSessionsOnDefault().filter((n) => !before.includes(n));
    expect(left, `dispatch sessions that appeared on the default tmux server while this file ran (this file's belong on tmux -L ${label}; a file running beside it may have made them)`).toEqual([]);
  });
  return { label };
}
