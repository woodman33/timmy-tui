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
  // Third order, checkpoint 2: an editor such as vim turns bracketed paste off when it exits; the
  // input turns it back on, or the next multi-line paste would send its first line (found in a PTY).
  it('Ctrl+G turns bracketed paste back on after the editor', async () => {
    const calls: string[] = [];
    const session = { setRaw: (on: boolean) => void calls.push(`raw ${on}`), enableBracketedPaste: () => void calls.push('paste on'), showCursor: () => {} };
    const { stdin, result } = prompt({ session, openEditor: () => { calls.push('editor'); return 'x'; } } as unknown as Partial<PromptDeps>);
    stdin.write('\x07');
    await tick();
    stdin.write('\r');
    await result;
    const at = calls.indexOf('editor');
    expect(calls.slice(at, at + 3)).toEqual(['editor', 'raw true', 'paste on']);
  });
});

// R4 lead (2026-10-12; established from tests/chat-one-conversation-pty.test.ts failing under load at the integrated head):
// between a chat turn and the next prompt the REPL left the terminal cooked for a moment. Keys typed then were echoed by the
// terminal, and their Enter became a line feed (ICRNL), which this editor takes for Ctrl+J, a new line: a "/exit" typed as a
// turn ended stayed in the next prompt, unsent. The REPL's loop now keeps the terminal raw from the prompt into the turn and
// back (PromptDeps.keepRaw, watchCtrlC's keepRaw), and gives a slash command a cooked terminal itself, as before.
describe('the terminal between a prompt, a turn and the next prompt (R4 lead)', () => {
  it('a line feed (Enter through a cooked terminal) is a new line in the editor; a carriage return (Enter, raw) sends', async () => {
    const a = prompt();
    let settled = false;
    void a.result.then(() => { settled = true; });
    a.stdin.write('/exit\n');
    await tick();
    await tick();
    expect(settled).toBe(false);
    a.stdin.write('\r');
    await expect(a.result).resolves.toMatchObject({ kind: 'submit' });
    const b = prompt();
    b.stdin.write('/exit\r');
    await expect(b.result).resolves.toEqual({ kind: 'submit', text: '/exit' });
  });
  it('keepRaw: the prompt ends with the terminal still raw; without it, raw is turned off as before', async () => {
    const kept = prompt({ keepRaw: true } as Partial<PromptDeps>);
    kept.stdin.write('hi\r');
    await expect(kept.result).resolves.toEqual({ kind: 'submit', text: 'hi' });
    expect(kept.raw).toEqual([true]);
    const before = prompt();
    before.stdin.write('hi\r');
    await before.result;
    expect(before.raw).toEqual([true, false]);
  });
  it('the turn\'s Ctrl+C watcher keeps the terminal raw when the next prompt follows, and still hears Ctrl+C until then', async () => {
    const { watchCtrlC } = await import('../src/repl/main.js');
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin }) as unknown as NodeJS.ReadStream;
    const raw: boolean[] = [];
    let ctrlC = 0;
    const stop = watchCtrlC(stdin, { setRaw: (on: boolean) => void raw.push(on) }, () => { ctrlC++; });
    (stdin as unknown as PassThrough).write('\x03');
    await tick();
    expect(ctrlC).toBe(1);
    stop({ keepRaw: true });
    expect(raw).toEqual([true]);
    const stop2 = watchCtrlC(stdin, { setRaw: (on: boolean) => void raw.push(on) }, () => { ctrlC++; });
    stop2();
    expect(raw).toEqual([true, true, false]);
  });
});

// R13 (classified from the 030d0942 full suite's one failure): a message typed before the REPL's first prompt arrives as one
// line through the cooked terminal (its Enter a line feed); keys typed during a turn were dropped by the Ctrl+C watcher.
describe('typed ahead: at the REPL\'s start and during a turn (R13)', () => {
  it('the first prompt, marked typedAhead: the typed-ahead line\'s final line feed sends it; a later line feed is still a new line', async () => {
    const a = prompt({ typedAhead: true } as Partial<PromptDeps>);
    a.stdin.write('hello\n');
    await expect(a.result).resolves.toEqual({ kind: 'submit', text: 'hello' });
    const b = prompt({ typedAhead: true } as Partial<PromptDeps>);
    let settled = false;
    void b.result.then(() => { settled = true; });
    b.stdin.write('one');
    await tick();
    b.stdin.write('\n');
    await tick();
    await tick();
    expect(settled).toBe(false);
    b.stdin.write('two\r');
    await expect(b.result).resolves.toEqual({ kind: 'submit', text: 'one\ntwo' });
  });
  it('the turn\'s watcher keeps what is typed during the turn (Ctrl+C aside) and hands it to the next prompt', async () => {
    const { watchCtrlC } = await import('../src/repl/main.js');
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin }) as unknown as NodeJS.ReadStream;
    let ctrlC = 0;
    const stop = watchCtrlC(stdin, { setRaw: () => undefined }, () => { ctrlC++; });
    (stdin as unknown as PassThrough).write('/ex');
    (stdin as unknown as PassThrough).write('\x03it\r');
    await tick();
    stop({ keepRaw: true });
    expect(ctrlC).toBe(1);
    const chunks: string[] = [];
    stdin.on('data', (c: Buffer) => chunks.push(c.toString()));
    stdin.resume();
    await tick();
    expect(chunks.join('')).toBe('/exit\r');
  });
  it('an approval answered during the turn discards what the turn kept: nothing meant for a question reaches the next prompt', async () => {
    const { watchCtrlC } = await import('../src/repl/main.js');
    const { discardTurnKeys } = await import('../src/repl/turn-keys.js');
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin }) as unknown as NodeJS.ReadStream;
    const stop = watchCtrlC(stdin, { setRaw: () => undefined }, () => undefined);
    (stdin as unknown as PassThrough).write('y');
    await tick();
    discardTurnKeys(stdin);
    stop({ keepRaw: true });
    const chunks: string[] = [];
    stdin.on('data', (c: Buffer) => chunks.push(c.toString()));
    stdin.resume();
    await tick();
    expect(chunks).toEqual([]);
  });
});
