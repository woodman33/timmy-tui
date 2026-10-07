import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../src/term/capabilities.js';
import { buildTheme } from '../src/term/theme.js';
import { LineEditor } from '../src/repl/editor.js';
import { readBlockPrompt, type PromptDeps } from '../src/repl/input.js';

// C-10: Tab completes the command the slash menu shows first; Ctrl+G opens the input in your editor
// ($VISUAL or $EDITOR, Neovim included) and takes back what you saved, with the terminal handed over
// in between (raw mode off while the editor runs, on again after).
const tick = () => new Promise((r) => setImmediate(r));
function prompt(extra: Partial<PromptDeps> = {}) {
  const stdin = new PassThrough();
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write: () => true });
  const raw: boolean[] = [];
  const region = { set: () => {}, commit: () => {} };
  const session = { setRaw: (on: boolean) => void raw.push(on), enableBracketedPaste: () => {}, showCursor: () => {} };
  const tty = { isTTY: true, columns: 80, rows: 24 };
  const caps = detectCapabilities({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' }, stdin: tty, stdout: tty, stderr: tty });
  const deps = { stdin, stdout, caps, theme: buildTheme(caps), region, session, editor: new LineEditor(), ...extra } as unknown as PromptDeps;
  return { stdin, raw, result: readBlockPrompt(deps) };
}

describe('keys in the block input', () => {
  it('Tab completes the first matching command', async () => {
    const { stdin, result } = prompt({ commands: [{ name: 'lanes', description: 'x' }, { name: 'help', description: 'y' }] } as Partial<PromptDeps>);
    stdin.write('/la');
    await tick();
    stdin.write('\t');
    await tick();
    stdin.write('\r');
    await expect(result).resolves.toEqual({ kind: 'submit', text: '/lanes ' });
  });
  // Playbook §19.5: Esc backs out. Of the slash menu: the half-typed command goes and the hint comes
  // back. Typed text that is not a command stays. (A lone ESC reaches keypress after readline's 500ms.)
  it('Esc backs out of the slash menu and keeps ordinary text', async () => {
    const commands = [{ name: 'lanes', description: 'x' }];
    const a = prompt({ commands } as Partial<PromptDeps>);
    a.stdin.write('/la');
    await tick();
    a.stdin.write('\x1b');
    await new Promise((r) => setTimeout(r, 600));
    a.stdin.write('hi\r');
    await expect(a.result).resolves.toEqual({ kind: 'submit', text: 'hi' });
    const b = prompt({ commands } as Partial<PromptDeps>);
    b.stdin.write('draft');
    await tick();
    b.stdin.write('\x1b');
    await new Promise((r) => setTimeout(r, 600));
    b.stdin.write('\r');
    await expect(b.result).resolves.toEqual({ kind: 'submit', text: 'draft' });
  });
  it('Ctrl+G hands the input to the editor and takes back what it saved', async () => {
    const seen: string[] = [];
    const { stdin, raw, result } = prompt({ openEditor: (text: string) => { seen.push(text); return 'written in the editor'; } } as Partial<PromptDeps>);
    stdin.write('draft');
    await tick();
    stdin.write('\x07');
    await tick();
    stdin.write('\r');
    await expect(result).resolves.toEqual({ kind: 'submit', text: 'written in the editor' });
    expect(seen).toEqual(['draft']);
    expect(raw.slice(-3)).toEqual([false, true, false]);
  });
});
