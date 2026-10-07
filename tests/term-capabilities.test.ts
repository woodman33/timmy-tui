import { describe, expect, it } from 'vitest';
import { detectCapabilities, type CapabilityInput } from '../src/term/capabilities.js';

// Env-matrix tests for playbook §16.6–16.7 (color, Unicode, width, CI, TTY, plain), plus the two
// defects the Cockpit prototype hit: tmux without a UTF-8 locale and a pane that starts at 0 columns.
const TTY = { isTTY: true, columns: 100, rows: 30 };
const PIPE = { isTTY: false };
const caps = (env: Record<string, string>, over: Partial<CapabilityInput> = {}) =>
  detectCapabilities({ env, stdin: TTY, stdout: TTY, stderr: TTY, ...over });

describe('color level', () => {
  it('reads COLORTERM, then TERM, on a terminal', () => {
    expect(caps({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }).color).toBe(3);
    expect(caps({ TERM: 'xterm-256color', COLORTERM: '24bit' }).color).toBe(3);
    expect(caps({ TERM: 'xterm-256color' }).color).toBe(2);
    expect(caps({ TERM: 'xterm' }).color).toBe(1);
    expect(caps({}).color).toBe(0);
  });
  it('turns color off for TERM=dumb, a non-empty NO_COLOR, and output that is not a terminal', () => {
    expect(caps({ TERM: 'dumb', COLORTERM: 'truecolor' }).color).toBe(0);
    expect(caps({ TERM: 'xterm-256color', NO_COLOR: '1' }).color).toBe(0);
    expect(caps({ TERM: 'xterm-256color', NO_COLOR: '' }).color).toBe(2);
    expect(caps({ TERM: 'xterm-256color' }, { stdout: PIPE }).color).toBe(0);
  });
  it('lets FORCE_COLOR force a level without a terminal and beat NO_COLOR (Node convention)', () => {
    expect(caps({ FORCE_COLOR: '1' }, { stdout: PIPE }).color).toBe(1);
    expect(caps({ FORCE_COLOR: '2' }, { stdout: PIPE }).color).toBe(2);
    expect(caps({ FORCE_COLOR: '3' }, { stdout: PIPE }).color).toBe(3);
    expect(caps({ FORCE_COLOR: '' }, { stdout: PIPE }).color).toBe(1);
    expect(caps({ FORCE_COLOR: '2', NO_COLOR: '1' }).color).toBe(2);
    expect(caps({ FORCE_COLOR: '0', TERM: 'xterm-256color' }).color).toBe(0);
    expect(caps({ FORCE_COLOR: 'false', TERM: 'xterm-256color' }).color).toBe(0);
  });
  it('lets --color and --no-color win over everything', () => {
    expect(caps({ FORCE_COLOR: '3' }, { flags: { color: false } }).color).toBe(0);
    expect(caps({ TERM: 'xterm-256color' }, { stdout: PIPE, flags: { color: true } }).color).toBe(2);
    expect(caps({}, { stdout: PIPE, flags: { color: true } }).color).toBe(1);
  });
});

describe('ansi attributes', () => {
  it('allows bold on a real terminal under NO_COLOR, and nothing at all into a pipe or TERM=dumb', () => {
    expect(caps({ TERM: 'xterm', NO_COLOR: '1' }).ansi).toBe(true);
    expect(caps({ TERM: 'xterm' }, { stdout: PIPE }).ansi).toBe(false);
    expect(caps({ TERM: 'dumb' }).ansi).toBe(false);
    expect(caps({ FORCE_COLOR: '1' }, { stdout: PIPE }).ansi).toBe(true);
    expect(caps({ TERM: 'xterm' }, { flags: { color: false } }).ansi).toBe(false);
  });
});

describe('unicode', () => {
  it('takes the first set of LC_ALL, LC_CTYPE, LANG', () => {
    expect(caps({ LANG: 'en_US.UTF-8' }).unicode).toBe(true);
    expect(caps({ LANG: 'C.utf8' }).unicode).toBe(true);
    expect(caps({ LC_CTYPE: 'UTF-8' }).unicode).toBe(true);
    expect(caps({ LC_ALL: 'C', LANG: 'en_US.UTF-8' }).unicode).toBe(false);
    expect(caps({ LC_ALL: '', LANG: 'en_US.UTF-8' }).unicode).toBe(true);
    expect(caps({ LANG: 'C' }).unicode).toBe(false);
    expect(caps({ WT_SESSION: 'abc' }).unicode).toBe(true);
  });
  it('stays ASCII inside tmux without a UTF-8 locale, where tmux prints every glyph as _', () => {
    expect(caps({ TMUX: '/tmp/tmux-501/default,1,0', LANG: 'C' }).unicode).toBe(false);
    expect(caps({ TMUX: '/tmp/tmux-501/default,1,0', TERM_PROGRAM: 'tmux' }).unicode).toBe(false);
    expect(caps({ TMUX: '/tmp/tmux-501/default,1,0', LC_ALL: 'C.UTF-8' }).unicode).toBe(true);
  });
  it('trusts a known UTF-8 terminal only when no locale variable is set at all', () => {
    expect(caps({ TERM_PROGRAM: 'ghostty' }).unicode).toBe(true);
    expect(caps({ TERM: 'xterm-kitty' }).unicode).toBe(true);
    expect(caps({ TERM_PROGRAM: 'ghostty', LANG: 'C' }).unicode).toBe(false);
    expect(caps({ TERM: 'xterm' }).unicode).toBe(false);
  });
  it('lets TIMMY_UNICODE override detection', () => {
    expect(caps({ LANG: 'en_US.UTF-8', TIMMY_UNICODE: '0' }).unicode).toBe(false);
    expect(caps({ LANG: 'C', TIMMY_UNICODE: '1' }).unicode).toBe(true);
  });
});

describe('size', () => {
  it('measures the terminal and wraps prose at min(columns, 80)', () => {
    const c = caps({});
    expect([c.columns, c.rows, c.proseWidth]).toEqual([100, 30, 80]);
    const narrow = caps({}, { stdout: { isTTY: true, columns: 60, rows: 20 } });
    expect([narrow.columns, narrow.proseWidth]).toEqual([60, 60]);
  });
  it('falls back to 80x24 when the size is unknown or zero (a pane that starts at 0 columns)', () => {
    const c = caps({}, { stdout: { isTTY: true, columns: 0, rows: 0 } });
    expect([c.columns, c.rows]).toEqual([80, 24]);
    expect(caps({}, { stdout: PIPE }).columns).toBe(80);
  });
});

describe('interaction and motion', () => {
  it('is interactive only when stdin and stdout are terminals outside CI and TERM=dumb', () => {
    expect(caps({ TERM: 'xterm' }).interactive).toBe(true);
    expect(caps({ TERM: 'xterm' }, { stdin: PIPE }).interactive).toBe(false); // echo hi | timmy
    expect(caps({ TERM: 'xterm' }, { stdout: PIPE }).interactive).toBe(false);
    expect(caps({ TERM: 'xterm', CI: '1' }).interactive).toBe(false);
    expect(caps({ TERM: 'xterm', GITHUB_ACTIONS: 'true' }).interactive).toBe(false);
    expect(caps({ TERM: 'xterm', CI: 'false' }).interactive).toBe(true);
    expect(caps({ TERM: 'dumb' }).interactive).toBe(false);
  });
  it('animates indicators only on a stderr terminal, never in CI, plain mode or reduced motion', () => {
    expect(caps({ TERM: 'xterm' }).animate).toBe(true);
    expect(caps({ TERM: 'xterm' }, { stderr: PIPE }).animate).toBe(false);
    expect(caps({ TERM: 'xterm', CI: '1' }).animate).toBe(false);
    expect(caps({ TERM: 'xterm', TIMMY_REDUCED_MOTION: '1' }).animate).toBe(false);
    expect(caps({ TERM: 'xterm' }, { flags: { plain: true } }).animate).toBe(false);
  });
  it('moves the cursor only on a stdout terminal that is not dumb and not plain', () => {
    expect(caps({ TERM: 'xterm' }).cursor).toBe(true);
    expect(caps({ TERM: 'dumb' }).cursor).toBe(false);
    expect(caps({ TERM: 'xterm' }, { stdout: PIPE }).cursor).toBe(false);
    expect(caps({ TERM: 'xterm', TIMMY_PLAIN: '1' }).cursor).toBe(false);
  });
  it('names the multiplexer and SSH', () => {
    expect(caps({ TMUX: 'x' }).multiplexer).toBe('tmux');
    expect(caps({ ZELLIJ: '0' }).multiplexer).toBe('zellij');
    expect(caps({ STY: '1.pts' }).multiplexer).toBe('screen');
    expect(caps({}).multiplexer).toBe(null);
    expect(caps({ SSH_TTY: '/dev/pts/1' }).ssh).toBe(true);
    expect(caps({}).ssh).toBe(false);
  });
});
