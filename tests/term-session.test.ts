import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { EXIT, TerminalSession } from '../src/term/session.js';

// Playbook §16.7: documented exit codes, and the terminal restored on every exit path, exactly once.
class FakeIn { isTTY = true; isRaw = false; setRawMode(v: boolean) { this.isRaw = v; return this; } }
class FakeOut { isTTY = true; writes: string[] = []; write(s: string) { this.writes.push(s); return true; } }

describe('exit codes', () => {
  it('uses 0, 1, 2, sysexits, 129, 130 and 143, never 126 or 127', () => {
    expect(EXIT).toEqual({ ok: 0, failure: 1, usage: 2, dataErr: 65, noInput: 66, noPerm: 77, config: 78, hangup: 129, cancelled: 130, terminated: 143 });
  });
});

describe('TerminalSession', () => {
  const make = () => {
    const stdin = new FakeIn(), stdout = new FakeOut(), exits: number[] = [];
    const session = new TerminalSession({ stdin, stdout, stderr: stdout }, { exit: (code) => { exits.push(code); } });
    return { stdin, stdout, exits, session };
  };
  it('restores attributes, bracketed paste, cursor, the main screen and raw mode, once', () => {
    const { stdin, stdout, session } = make();
    session.setRaw(true);
    session.enterAltScreen();
    session.enableBracketedPaste();
    session.hideCursor();
    expect(stdin.isRaw).toBe(true);
    stdout.writes = [];
    session.restore();
    session.restore();
    expect(stdout.writes).toEqual(['\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l']);
    expect(stdin.isRaw).toBe(false);
  });
  // C-11 (row 27): a full-screen app's last frame must be drawn while its own screen is still up.
  // Ink's last frame after the restore landed on the main screen, erased it and stayed there.
  it('runs teardown hooks, newest first, before the terminal is restored, once, even when one throws', () => {
    const { stdout, session } = make();
    session.enterAltScreen();
    stdout.writes = [];
    const order: string[] = [];
    session.beforeRestore(() => { order.push('first'); stdout.write('last frame'); });
    session.beforeRestore(() => { order.push('second'); throw new Error('boom'); });
    const off = session.beforeRestore(() => { order.push('removed'); });
    off();
    session.restore();
    session.restore();
    expect(order).toEqual(['second', 'first']);
    expect(stdout.writes).toEqual(['last frame', '\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l']);
  });
  it('writes nothing to a stream that is not a terminal', () => {
    const { stdout, session } = make();
    stdout.isTTY = false;
    session.hideCursor();
    session.restore();
    expect(stdout.writes).toEqual([]);
  });
  it('exits 130 on SIGINT, 143 on SIGTERM, 129 on SIGHUP and 1 on an uncaught exception, restoring first', async () => {
    for (const [event, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['uncaughtException', 1]] as const) {
      const { stdout, exits, session } = make();
      const proc = new EventEmitter();
      session.hideCursor();
      session.install(proc as unknown as NodeJS.Process);
      proc.emit(event, new Error('boom'));
      await new Promise((r) => setTimeout(r, 10));
      expect(exits, event).toEqual([code]);
      expect(stdout.writes.join(''), event).toContain('\x1b[?25h');
    }
  });
  it('forces exit on a second signal while draining', async () => {
    const { exits, session } = make();
    const proc = new EventEmitter();
    session.install(proc as unknown as NodeJS.Process, { drain: () => new Promise(() => {}) });
    proc.emit('SIGINT');
    proc.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 10));
    expect(exits).toEqual([130]);
  });
});
