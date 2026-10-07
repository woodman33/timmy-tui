/**
 * Reading a prompt (playbook §17.2). On an interactive terminal: the block input with a real line
 * editor, raw mode and bracketed paste; Enter sends, Ctrl+J, Alt+Enter or a trailing `\` add a line.
 * Otherwise plain input: piped stdin is read whole as one prompt, with no raw mode and no queries.
 */
import { createInterface, emitKeypressEvents, type Key } from 'node:readline';
import type { TerminalCapabilities } from '../term/capabilities.js';
import type { LiveRegion } from '../term/live-region.js';
import { markPromptRows } from '../term/marks.js';
import type { TerminalSession } from '../term/session.js';
import type { Theme } from '../term/theme.js';
import type { LineEditor } from './editor.js';
import { menuMatches, renderInput, type MenuCommand } from './input-view.js';

export type PromptResult = { kind: 'submit'; text: string } | { kind: 'cancel' } | { kind: 'eof' };

export interface PromptDeps {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  caps: TerminalCapabilities;
  theme: Theme;
  region: LiveRegion;
  session: TerminalSession;
  editor: LineEditor;
  /** Put OSC 133 prompt marks around the kept block (stdout is a terminal). */
  marks?: boolean;
  /** The slash menu's commands (C-10, B6): shown while a command is typed; Tab completes the first. */
  commands?: readonly MenuCommand[];
  /** Ctrl+G: hands the input to the editor and returns what was saved, or null to keep it (C-10). */
  openEditor?: (text: string) => string | null;
}

export function readPrompt(d: PromptDeps): Promise<PromptResult> {
  if (d.caps.interactive && d.region.live && !d.caps.plain) return readBlockPrompt(d);
  return readPlainPrompt(d);
}

const consumed = new WeakSet<object>();

/** Piped stdin: the whole input is one prompt, then end of input. A plain terminal: one line. */
export function readPlainPrompt(d: Pick<PromptDeps, 'stdin' | 'stdout' | 'theme'>): Promise<PromptResult> {
  const { stdin } = d;
  if (!stdin.isTTY) {
    if (consumed.has(stdin)) return Promise.resolve({ kind: 'eof' });
    consumed.add(stdin);
    return new Promise((resolve) => {
      let text = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk: string) => { text += chunk; });
      stdin.on('end', () => resolve(text.trim() ? { kind: 'submit', text: text.trimEnd() } : { kind: 'eof' }));
      stdin.resume();
    });
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: d.stdout, terminal: false });
    let done = false;
    rl.on('close', () => { if (!done) resolve({ kind: 'eof' }); });
    d.stdout.write(`${d.theme.glyphs.prompt} `);
    rl.once('line', (line) => { done = true; rl.close(); resolve({ kind: 'submit', text: line }); });
  });
}

const DOUBLE_CTRL_C_MS = 2000;

export function readBlockPrompt(d: PromptDeps): Promise<PromptResult> {
  const { stdin, stdout, region, session, editor, theme } = d;
  emitKeypressEvents(stdin);
  session.setRaw(true);
  session.enableBracketedPaste();
  session.showCursor();
  let pasting = false;
  let lastCtrlC = 0;
  const columns = (): number => (stdout.columns && stdout.columns > 0 ? stdout.columns : d.caps.columns);
  // A paste arrives one key per character; its frames are coalesced to one per chunk of input.
  let pending: ReturnType<typeof setImmediate> | null = null;
  const draw = (): void => {
    if (pending) clearImmediate(pending);
    pending = null;
    const v = renderInput(editor, theme, columns(), d.commands);
    region.set(v.lines, v.cursor);
  };
  const drawSoon = (): void => {
    pending ??= setImmediate(draw);
  };
  return new Promise((resolve) => {
    /** `kept`: the rows that stay in scrollback (the submitted block, without the hint). */
    const finish = (result: PromptResult, kept: string[] = []): void => {
      if (pending) clearImmediate(pending);
      pending = null;
      stdin.off('keypress', onKey);
      stdout.off('resize', draw);
      region.set([]);
      if (kept.length) region.commit(kept);
      session.setRaw(false);
      stdin.pause();
      resolve(result);
    };
    const onKey = (str: string | undefined, key: Key = {}): void => {
      if (pasting) {
        if (key.name === 'paste-end') {
          pasting = false;
          return draw();
        }
        editor.insert(key.name === 'return' || key.name === 'enter' ? '\n' : (str ?? key.sequence ?? ''));
        return drawSoon();
      }
      if (key.name === 'paste-start') { pasting = true; return; }
      if (key.ctrl && key.name === 'c') {
        const now = Date.now();
        if (editor.text && now - lastCtrlC > DOUBLE_CTRL_C_MS) {
          lastCtrlC = now;
          editor.clear();
          return draw();
        }
        return finish({ kind: 'cancel' });
      }
      if (key.ctrl && key.name === 'd') {
        if (!editor.text) return finish({ kind: 'eof' });
        editor.deleteForward();
        return draw();
      }
      if (key.name === 'return' && !key.meta) {
        if (editor.text.endsWith('\\')) {
          editor.end();
          editor.backspace();
          editor.insert('\n');
          return draw();
        }
        if (!editor.text.trim()) { editor.clear(); return draw(); }
        const block = renderInput(editor, theme, columns()).lines.slice(0, -1);
        const kept = d.marks ? markPromptRows(block) : block;
        return finish({ kind: 'submit', text: editor.submit() }, kept);
      }
      if (key.name === 'escape' && d.commands && menuMatches(editor.text, d.commands).length) {
        // Esc backs out of the slash menu (playbook §19.5): the half-typed command goes, the hint comes back.
        editor.clear();
        return draw();
      }
      if (key.name === 'tab' && d.commands) {
        const [first] = menuMatches(editor.text, d.commands);
        if (!first) return;
        editor.clear();
        editor.insert(`/${first.name} `);
        return draw();
      }
      if (key.ctrl && key.name === 'g' && d.openEditor) {
        // The editor gets the terminal: the input block is cleared and raw mode is off while it runs.
        region.set([]);
        session.setRaw(false);
        const next = d.openEditor(editor.text);
        session.setRaw(true);
        // An editor such as vim turns bracketed paste off as it exits; turn it back on.
        session.enableBracketedPaste();
        if (next !== null) {
          editor.clear();
          editor.insert(next);
        }
        return draw();
      }
      if (key.name === 'enter' || (key.name === 'return' && key.meta)) editor.insert('\n');
      else if (key.name === 'backspace') key.meta || key.ctrl ? editor.deleteWordBefore() : editor.backspace();
      else if (key.name === 'delete') editor.deleteForward();
      else if (key.name === 'left') key.ctrl || key.meta ? editor.wordLeft() : editor.left();
      else if (key.name === 'right') key.ctrl || key.meta ? editor.wordRight() : editor.right();
      else if (key.meta && key.name === 'b') editor.wordLeft();
      else if (key.meta && key.name === 'f') editor.wordRight();
      else if (key.name === 'home' || (key.ctrl && key.name === 'a')) editor.home();
      else if (key.name === 'end' || (key.ctrl && key.name === 'e')) editor.end();
      else if (key.name === 'up') editor.up();
      else if (key.name === 'down') editor.down();
      else if (key.ctrl && key.name === 'w') editor.deleteWordBefore();
      else if (key.ctrl && key.name === 'u') editor.killToLineStart();
      else if (key.ctrl && key.name === 'k') editor.killToLineEnd();
      else if (str && !key.ctrl && !key.meta && str >= ' ' && key.name !== 'tab' && key.name !== 'escape') editor.insert(str);
      else return;
      draw();
    };
    stdin.on('keypress', onKey);
    stdout.on('resize', draw);
    stdin.resume();
    draw();
  });
}
