import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../src/term/capabilities.js';
import { measuredFromPalette, TIMMY_NIGHT } from '../src/term/palettes.js';
import { buildTheme } from '../src/term/theme.js';
import { visibleWidth } from '../src/term/width.js';
import { LineEditor } from '../src/repl/editor.js';
import { renderInput } from '../src/repl/input-view.js';

// Block input (tinted pad, ` › text`, tinted pad) when the ground is measured; bordered (rules around
// `› text`) when it is not (playbook §17.2). Text on the tint stays at the default foreground.
const TTY = { isTTY: true, columns: 80, rows: 24 };
const theme = (env: Record<string, string>, measured = true) =>
  buildTheme(detectCapabilities({ env, stdin: TTY, stdout: TTY, stderr: TTY }), measured ? measuredFromPalette(TIMMY_NIGHT) : undefined);
const NIGHT = theme({ TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' });
const UNMEASURED = theme({ TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' }, false);
const ASCII = theme({ TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C' }, false);
const editor = (text: string) => { const e = new LineEditor(); e.insert(text); return e; };
const TINT = '\x1b[48;2;31;31;31m';

describe('block input', () => {
  it('draws a tinted pad, the prompt row and a tinted pad, then the hint', () => {
    const v = renderInput(editor(''), NIGHT, 80);
    expect(v.lines).toEqual([
      `${TINT}\x1b[K\x1b[49m`,
      `${TINT}\x1b[K › \x1b[49m`,
      `${TINT}\x1b[K\x1b[49m`,
      '\x1b[37m  Enter to send · Ctrl+J newline · / commands\x1b[39m',
    ]);
    expect(v.cursor).toEqual({ row: 1, col: 3 });
  });
  it('puts the cursor after the text by display width (CJK takes two cells)', () => {
    expect(renderInput(editor('hello'), NIGHT, 80).cursor).toEqual({ row: 1, col: 8 });
    expect(renderInput(editor('日本'), NIGHT, 80).cursor).toEqual({ row: 1, col: 7 });
  });
  it('soft-wraps long text and continues new lines under the text, never past the width', () => {
    const v = renderInput(editor('a'.repeat(20)), NIGHT, 20);
    expect(v.lines.slice(1, 3)).toEqual([`${TINT}\x1b[K › ${'a'.repeat(16)}\x1b[49m`, `${TINT}\x1b[K   aaaa\x1b[49m`]);
    expect(v.cursor).toEqual({ row: 2, col: 7 });
    const multi = renderInput(editor('one\ntwo'), NIGHT, 80);
    expect(multi.lines.slice(1, 3)).toEqual([`${TINT}\x1b[K › one\x1b[49m`, `${TINT}\x1b[K   two\x1b[49m`]);
    for (const line of renderInput(editor('x'.repeat(50)), NIGHT, 20).lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
  });
});

describe('bordered input', () => {
  it('uses rules around `› text` when the ground is not measured', () => {
    const v = renderInput(editor('hi'), UNMEASURED, 10);
    expect(v.lines.slice(0, 3)).toEqual(['\x1b[90m──────────\x1b[39m', '› hi', '\x1b[90m──────────\x1b[39m']);
    expect(v.cursor).toEqual({ row: 1, col: 4 });
  });
  it('uses > and - without Unicode, including where the hint is cut', () => {
    const v = renderInput(editor('hi'), ASCII, 10);
    expect([...v.lines.join('')].filter((ch) => ch > '~')).toEqual([]);
    expect(v.lines.slice(0, 3)).toEqual(['\x1b[90m----------\x1b[39m', '> hi', '\x1b[90m----------\x1b[39m']);
  });
});

// C-10 (B6): typing a command shows the matching commands from the registry under the input, the top
// one first, with Tab to complete it; arguments, plain text or no match bring the hint back.
describe('the slash menu', () => {
  const CMDS = [
    { name: 'help', description: 'List these commands' },
    { name: 'lanes', description: 'The lanes, ready or not' },
    { name: 'model', description: 'Show the model, or switch: /model <id>' },
  ];
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[mK]/g, '');
  const below = (text: string) => renderInput(editor(text), UNMEASURED, 80, CMDS).lines.slice(3).map(strip);
  it('lists the matching commands, narrowed as you type, and says Tab completes the first', () => {
    expect(below('/')).toEqual(['  /help        List these commands', '  /lanes       The lanes, ready or not', '  /model       Show the model, or switch: /model <id>', '  Tab completes /help']);
    expect(below('/la')).toEqual(['  /lanes       The lanes, ready or not', '  Tab completes /lanes']);
  });
  it('shows the hint again for plain text, for arguments, and when nothing matches', () => {
    for (const text of ['hello', '/model openai/gpt-5.5', '/zz']) expect(below(text), text).toEqual(['  Enter to send · Ctrl+J newline · / commands']);
  });
});
