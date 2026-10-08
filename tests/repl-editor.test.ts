import { describe, expect, it } from 'vitest';
import { LineEditor } from '../src/repl/editor.js';

// The line editor model behind the block input (playbook §17.2): grapheme-safe editing, word moves
// and deletes, Ctrl+K keeps its line-editing meaning (DESIGN.md §10 B6), multi-line text, history.
const at = (e: LineEditor) => `${e.text.slice(0, e.cursor)}|${e.text.slice(e.cursor)}`;

describe('LineEditor', () => {
  it('inserts at the cursor and moves by grapheme, so emoji and CJK never split', () => {
    const e = new LineEditor();
    e.insert('a👍🏽日b');
    e.left();
    e.left();
    expect(at(e)).toBe('a👍🏽|日b');
    e.backspace();
    expect(at(e)).toBe('a|日b');
    e.deleteForward();
    expect(at(e)).toBe('a|b');
  });
  it('moves and deletes by word', () => {
    const e = new LineEditor();
    e.insert('make the storyboard');
    e.wordLeft();
    expect(at(e)).toBe('make the |storyboard');
    e.deleteWordBefore();
    expect(at(e)).toBe('make |storyboard');
    e.wordRight();
    expect(at(e)).toBe('make storyboard|');
  });
  it('keeps Ctrl+K (kill to end) and Ctrl+U (kill to start) on the current line', () => {
    const e = new LineEditor();
    e.insert('one two\nthree four');
    e.home();
    e.wordRight();
    e.killToLineEnd();
    expect(e.text).toBe('one two\nthree');
    e.killToLineStart();
    expect(e.text).toBe('one two\n');
  });
  it('turns a pasted CR or CRLF into a newline', () => {
    const e = new LineEditor();
    e.insert('a\r\nb\rc');
    expect(e.text).toBe('a\nb\nc');
  });
  it('moves between lines with up and down, and walks history from the first and last line', () => {
    const e = new LineEditor(['first prompt', 'second prompt']);
    e.insert('draft');
    e.up();
    expect(e.text).toBe('second prompt');
    e.up();
    expect(e.text).toBe('first prompt');
    e.down();
    e.down();
    expect(e.text).toBe('draft');
    e.insert('\nline two');
    e.up();
    expect(e.text).toBe('draft\nline two');
    expect(e.position).toEqual({ line: 0, col: 5 });
  });
  it('submits the text, records it in history once, and starts empty', () => {
    const e = new LineEditor();
    e.insert('run tests');
    expect(e.submit()).toBe('run tests');
    e.insert('run tests');
    e.submit();
    expect([e.text, e.cursor, e.history]).toEqual(['', 0, ['run tests']]);
  });
});
