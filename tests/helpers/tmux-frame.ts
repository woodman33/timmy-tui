// R5 (H136; the operator's finish line, item 5): how the tmux PTY tests read the terminal Workbench, wait on it, send it keys
// and keep its screens, in one place for tests/workbench-pty.test.ts, tests/workbench-interaction-pty.test.ts,
// tests/workbench-captures-pty.test.ts and tests/workbench-control-grid-pty.test.ts.
//
// Ink draws a frame that fills the terminal by clearing the screen and writing the frame from its top row down (src/term/
// screen-stream.ts). A capture that lands while it writes holds the new frame's top rows and blank rows under them: a wait
// that matched such a screen read words from half a frame, and a kept capture kept it (2 of 300 captures at load 13, measured
// in R5; the Control Room kept mid-redraw at 100x30). So, while the Workbench has its own screen up (tmux's alternate screen),
// a screen counts as read only when it is a whole frame:
//   1. row 1's tab titles are drawn (TIMMY first, on one of the first three rows);
//   2. its last row is Activity & log's bottom border, as wide as the terminal (the last row a frame writes);
//   3. the row above it is the key-hint line (a kept capture), or for a wait either that line or the notice drawn in its place
//      for a few seconds (src/workbench/views.ts bottomView);
//   4. two reads, one poll apart, are the same.
// Once the Workbench has left its screen (it quit), the terminal's own screen is read: two reads the same.
//
// Keys go one at a time: each is sent once the Workbench has read every byte of the one before (FIONREAD on the pane's
// terminal, which the Workbench holds in raw mode, is 0 on two reads), so two keys never arrive as one and a key is never
// sent while the one before it is still on its way. A wait polls (POLL_MS) until its condition holds or its deadline passes;
// a deadline says what it waited for, why the last screen did not count, and that screen, with this machine's folders and
// name scrubbed.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

/** The poll interval of every wait here. */
export const POLL_MS = 50;

/** A tmux server of a test's own: its command (tmux -L <label> …), the window read when none is named, and what to scrub. */
export interface Pane {
  tmux: (...args: string[]) => string;
  target: string;
  /** this machine's folders a screen in an error must not show (the test's sandbox; the temporary folder and home are always) */
  folders?: readonly string[];
  /** more for a deadline to say (the pane's processes, what its terminal holds unread) */
  diagnose?: () => string;
}

/** One read of a pane: its screen as capture-pane prints it, its size, and whether its program has its own screen up. */
export interface Read { text: string; cols: number; rows: number; alternate: boolean }

/** What the row above the bottom border must be: the key-hint line itself, or that line or a notice in its place. */
export type Foot = 'hints' | 'drawn';

const BOTTOM = /^[╰┗][─━]+[╯┛]$/;
// the two hints every width keeps (src/workbench/hub.ts hintLine: the keys that matter most first)
const HINTS = /\[1–0\] tabs {2}\[Enter\] acts/;
const FIONREAD = 'import fcntl,os,struct,sys,termios\nfd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOCTTY|os.O_NONBLOCK)\nprint(struct.unpack("i",fcntl.ioctl(fd,termios.FIONREAD,b"\\0"*4))[0])';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// (the synchronous reads' poll: a wait that blocks its caller, as a synchronous screen read does)
const pause = (ms: number): void => { execFileSync('sleep', [String(ms / 1000)]); };

/** The pane's size, whether its program's screen is up, and its screen: one tmux call, so the three are of one moment. */
export function readPane(p: Pane, target = p.target): Read {
  const out = p.tmux('display-message', '-p', '-t', target, '#{pane_width} #{pane_height} #{alternate_on}', ';', 'capture-pane', '-p', '-t', target);
  const nl = out.indexOf('\n');
  const [cols, rows, alternate] = out.slice(0, nl).trim().split(/\s+/).map(Number);
  return { text: out.slice(nl + 1), cols, rows, alternate: alternate === 1 };
}

/** Why a read is not a whole Workbench frame (null when it is one). */
export function frameProblem(r: Read, foot: Foot = 'drawn'): string | null {
  const rows = r.text.replace(/\n$/, '').split('\n');
  if (rows.length !== r.rows) return `${rows.length} rows were read of the terminal's ${r.rows}`;
  if (!rows.slice(0, 3).some((l) => /^TIMMY\b/.test(l))) return 'row 1, TIMMY and the tab titles, is not drawn';
  const last = rows[r.rows - 1].trimEnd();
  if (!BOTTOM.test(last) || [...last].length !== r.cols) return `its last row is not Activity & log's bottom border, ${r.cols} cells wide (a frame still being drawn)`;
  const above = rows[r.rows - 2] ?? '';
  if (foot === 'hints' && !HINTS.test(above)) return 'the row above the bottom border is not the key-hint line (a notice holds its place for a few seconds)';
  if (!above.replace(/[│┃]/g, '').trim()) return 'the row above the bottom border is blank';
  return null;
}

/** A screen with this machine's folders and name taken out (for an error a test prints). */
export function scrub(text: string, folders: readonly string[] = []): string {
  const named: Array<[string, string]> = [...folders.map((f): [string, string] => [f, '<the test folder>']), [tmpdir(), '<tmp>'], [homedir(), '<home>']];
  let out = text;
  for (const [f, name] of named.filter(([f]) => f.length > 1).sort((a, b) => b[0].length - a[0].length)) out = out.split(f).join(name);
  const host = hostname();
  return host.length > 3 ? out.split(host).join('<this machine>') : out;
}

function deadline(p: Pane, what: string, ms: number, why: string, text: string): Error {
  return new Error(`timed out after ${ms} ms waiting for ${what}: ${why || 'nothing was read'}.\nThe screen it saw last:\n${scrub(text, p.folders)}${p.diagnose ? `\n${p.diagnose()}` : ''}`);
}

export interface Until {
  /** what is waited for, in words (a deadline says it) */
  what: string;
  /** the screen matches this */
  re?: RegExp;
  /** and this holds of it */
  test?: (screen: string) => boolean;
  ms?: number;
  target?: string;
  foot?: Foot;
  /** false: the screen is not a frame of the Workbench though its screen is still up (one killed outright leaves its last
   *  frame there, and the shell writes over it); then only the condition and two reads the same count */
  frame?: boolean;
}

/** Why a read does not count yet (null: it does): a whole frame while the Workbench's screen is up, and the condition. */
function notYet(r: Read, o: Until): string | null {
  const problem = r.alternate && o.frame !== false ? frameProblem(r, o.foot) : null;
  if (problem) return problem;
  if (o.re && !o.re.test(r.text)) return `${o.re} does not match it`;
  if (o.test && !o.test(r.text)) return 'its condition does not hold of it';
  return null;
}

/** Waits until the pane shows a whole frame (or, once the Workbench quit, a screen) that meets `o`, the same in two reads. */
export async function waitScreen(p: Pane, o: Until): Promise<string> {
  const ms = o.ms ?? 30_000;
  let prev: string | null = null;
  let last = '';
  let why = '';
  for (const end = Date.now() + ms; Date.now() < end; await sleep(POLL_MS)) {
    const r = readPane(p, o.target);
    last = r.text;
    const problem = notYet(r, o);
    if (problem) { why = problem; prev = null; continue; }
    if (r.text !== prev) { why = 'it changed between two reads'; prev = r.text; continue; }
    return r.text;
  }
  throw deadline(p, o.what + (o.re ? ` (${o.re})` : ''), ms, why, last);
}

/** The same, for a synchronous caller (a read inside a synchronous helper): it blocks while it polls, up to `o.ms` (10 s). */
export function settledScreen(p: Pane, o: Partial<Until> = {}): string {
  const ms = o.ms ?? 10_000;
  const what = o.what ?? 'a whole frame, the same in two reads';
  let prev: string | null = null;
  let last = '';
  let why = '';
  for (const end = Date.now() + ms; Date.now() < end; pause(POLL_MS)) {
    const r = readPane(p, o.target);
    last = r.text;
    const problem = notYet(r, { what, ...o });
    if (problem) { why = problem; prev = null; continue; }
    if (r.text !== prev) { why = 'it changed between two reads'; prev = r.text; continue; }
    return r.text;
  }
  throw deadline(p, what, ms, why, last);
}

/**
 * Keeps the screen as `<dir>/<name>.ansi` (capture-pane -e) and `.txt`: a whole frame with its key-hint line (`foot`
 * 'hints', the default) that meets `o`, and the very same plain screen read before and after its .ansi is taken, so the two
 * files are of one frame. Returns the plain screen.
 */
export function keepScreen(p: Pane, dir: string, name: string, o: Partial<Until> = {}): string {
  const ms = o.ms ?? 15_000;
  const want: Until = { what: `the screen to keep as ${name}`, foot: 'hints', ...o };
  let last = '';
  let why = '';
  for (const end = Date.now() + ms; Date.now() < end; pause(POLL_MS)) {
    const a = readPane(p, want.target);
    last = a.text;
    const problem = notYet(a, want);
    if (problem) { why = problem; continue; }
    const ansi = p.tmux('capture-pane', '-e', '-p', '-t', want.target ?? p.target);
    const b = readPane(p, want.target);
    if (b.text !== a.text) { why = 'it changed between two reads'; last = b.text; continue; }
    writeFileSync(join(dir, `${name}.ansi`), ansi);
    writeFileSync(join(dir, `${name}.txt`), a.text);
    return a.text;
  }
  throw deadline(p, want.what + (want.re ? ` (${want.re})` : ''), ms, why, last);
}

/**
 * A NEEDS YOU box takes no answer in its first `guardMs` (src/workbench/controller.ts GUARD_MS, the REPL's type-ahead guard):
 * waits until that long has passed since `seenAt`, when a wait saw the box drawn (the box opened no later than that).
 */
export async function pastGuard(seenAt: number, guardMs: number): Promise<void> {
  while (Date.now() - seenAt <= guardMs) await sleep(POLL_MS);
}

/** The bytes typed into a terminal that no process has read yet (FIONREAD, by this machine's python3). */
export function unreadOn(tty: string): number {
  return Number(execFileSync('python3', ['-c', FIONREAD, tty], { encoding: 'utf8', timeout: 5000 }).trim());
}

/** Sends `keys` to the pane one at a time (tmux key names; text with `literal`), each once the one before it was read. */
export async function sendKeys(p: Pane, keys: readonly string[], o: { target?: string; literal?: boolean; ms?: number } = {}): Promise<void> {
  const target = o.target ?? p.target;
  const tty = p.tmux('display-message', '-p', '-t', target, '#{pane_tty}').trim();
  for (const k of keys) {
    p.tmux('send-keys', '-t', target, ...(o.literal ? ['-l', k] : [k]));
    await readBy(p, tty, target, JSON.stringify(k), o.ms ?? 10_000);
  }
}

/** Waits until every byte typed into `tty` has been read: 0 unread on two reads, one poll apart. */
async function readBy(p: Pane, tty: string, target: string, what: string, ms: number): Promise<void> {
  let zeros = 0;
  let n = 0;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(POLL_MS)) {
    n = unreadOn(tty);
    zeros = n === 0 ? zeros + 1 : 0;
    if (zeros >= 2) return;
  }
  throw deadline(p, `the Workbench to read the key ${what}`, ms, `${n} bytes typed into its terminal are unread`, readPane(p, target).text);
}

/** One block row of the Workflows list as a whole frame draws it: its document, its name, and whether it is the selected one. */
export interface ListBlock { doc: string; block: string; selected: boolean }

/**
 * The Workflows list as a frame draws it (src/workbench/workflows-tab.ts: under its PLAN row, each document's row, then its
 * blocks' rows, the selected one marked ▸): its block rows in order, whether it shows from its first row (no ↑ row above it),
 * and whether the list has the keyboard (the body's title marked ◆). Null when no Workflows body is drawn.
 */
export function workflowsList(screen: string): { blocks: ListBlock[]; fromTop: boolean; focused: boolean } | null {
  const rows = screen.split('\n');
  const head = /[╭┏][─━] (◆ )?\S+ \/ Workflows/;
  const top = rows.findIndex((l) => head.test(l));
  if (top < 0) return null;
  const focused = head.exec(rows[top])![1] !== undefined;
  const planAt = rows.findIndex((l, y) => y > top && l.includes('PLAN · '));
  if (planAt < 0) return null;
  const x = rows[planAt].indexOf('PLAN · ');
  const blocks: ListBlock[] = [];
  let doc = '';
  let fromTop = true;
  for (let y = planAt + 1; y < rows.length; y++) {
    const cell = rows[y].slice(x);
    if (y === planAt + 1 && /^[↑^] /.test(cell)) { fromTop = false; continue; }
    const d = /^(\S+) · \d+ blocks?\b/.exec(cell);
    if (d) { doc = d[1]; continue; }
    const b = /^(▸| ) {2}\d+ (\S+)/.exec(cell);
    if (b && doc) { blocks.push({ doc, block: b[2], selected: b[1] === '▸' }); continue; }
    break;
  }
  return { blocks, fromTop, focused };
}

/** The block the Workflows list has selected, and whether the list has the keyboard (null: none drawn selected). */
export function selectedBlock(screen: string): (ListBlock & { focused: boolean }) | null {
  const list = workflowsList(screen);
  const b = list?.blocks.find((x) => x.selected);
  return list && b ? { ...b, focused: list.focused } : null;
}

/** Enter on a block of the Workflows list: only once a whole frame shows it selected (▸) in the list that has the keyboard. */
export async function enterOnBlock(p: Pane, doc: string, block: string, o: { target?: string; ms?: number } = {}): Promise<void> {
  await waitScreen(p, {
    what: `${doc} › ${block} selected (▸) in the Workflows list, which has the keyboard`, target: o.target, ms: o.ms ?? 10_000,
    test: (s) => { const b = selectedBlock(s); return !!b && b.focused && b.doc === doc && b.block === block; },
  });
  await sendKeys(p, ['Enter'], { target: o.target });
}
