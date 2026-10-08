import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../src/term/capabilities.js';
import { buildTheme } from '../src/term/theme.js';
import { LineEditor } from '../src/repl/editor.js';
import { readBlockPrompt, type PromptDeps } from '../src/repl/input.js';

// A paste arrives as one key event per character. Redrawing the input block on each one turns a
// 2,000-character paste into 2,000 frames; the block is drawn once the paste is in (review item 9).
const tick = () => new Promise((r) => setImmediate(r));

function prompt() {
  const stdin = new PassThrough();
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write: () => true });
  const frames: string[][] = [];
  const region = { set: (lines: string[]) => void frames.push(lines), commit: () => {} };
  const session = { setRaw: () => {}, enableBracketedPaste: () => {}, showCursor: () => {} };
  const tty = { isTTY: true, columns: 80, rows: 24 };
  const caps = detectCapabilities({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' }, stdin: tty, stdout: tty, stderr: tty });
  const deps = { stdin, stdout, caps, theme: buildTheme(caps), region, session, editor: new LineEditor() } as unknown as PromptDeps;
  return { stdin, frames, result: readBlockPrompt(deps) };
}

describe('pasting into the block input', () => {
  it('draws a 2,000-character paste in at most two frames, and keeps every character', async () => {
    const { stdin, frames, result } = prompt();
    const before = frames.length;
    stdin.write(`\x1b[200~${'x'.repeat(2000)}\x1b[201~`);
    await tick();
    await tick();
    expect(frames.length - before).toBeLessThanOrEqual(2);
    stdin.write('\r');
    await expect(result).resolves.toEqual({ kind: 'submit', text: 'x'.repeat(2000) });
  });
  it('still shows a paste whose end marker never comes (drawn once the input is read)', async () => {
    const { stdin, frames } = prompt();
    stdin.write(`\x1b[200~${'y'.repeat(50)}`);
    await tick();
    await tick();
    expect(frames.at(-1)?.join('\n')).toContain('y'.repeat(50));
  });
});
