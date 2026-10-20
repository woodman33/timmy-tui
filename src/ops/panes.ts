/**
 * R8 (H155): the Control Room's panes, from ONE source. Which runs get a pane, in which order, and what each pane says: its
 * mark and word, who started it, its exit, its receipt (checked in this reading), how a chat turn being answered is stopped,
 * and its log's last lines. Two surfaces draw them:
 *
 *   the Workbench's tab 7   src/workbench/control-tab.ts (a terminal: the references' 2×2 grid from 160 columns, stacked
 *                           below; its keys x, Enter and the arrows)
 *   the companion's tab 7   src/companion/panels/control.ts answers GET /api/panel/control/panes, and
 *                           src/companion/client/panel-control.js draws it read-only (a pane opens its run detail)
 *
 * The rule (as the Control Room always had it, R5 H137): every job of the project that runs, then the chat turns being
 * answered (their holds, less any whose own receipt is sealed), then a Workbench's runs in another project; in the PANES_MAX
 * slots they leave, the project's newest ended runs, as quiet panes with their exit and receipt. A receipt is said verified
 * only when verifyReceiptIn confirms it against the chain read for this reading.
 *
 * Nothing here runs a program, writes or asks the network: the log reader opens a log for reading, its end only.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { ChatSurface } from '../contracts/chat-session.js';
import type { JobRecord } from '../jobs/index.js';
import { scrubHomes } from '../utils/home-scrub.js';
import { verifyReceiptIn, type Receipt } from '../utils/receipts.js';
import type { Glyphs } from '../workbench/frame.js';
import { lineText } from '../workbench/output.js';
import type { JobRow } from '../workbench/state.js';
import type { Role } from '../workbench/text.js';
import { turnStopWords } from './workspace-frame.js';

type Env = Record<string, string | undefined>;

/** How many panes the Control Room fills (the references' 2×2 grid): every run that is running first, then the newest ended
 *  runs in the slots left, as quiet panes. More running than this: the Workbench's grid shows four at a time and says how many
 *  more; the companion shows the first four and says how many more run. */
export const PANES_MAX = 4;
/** How many of a pane's log lines are read and drawn, at most. */
export const TAIL_MAX = 6;
/** The most bytes of a log's end read for its last lines. */
export const TAIL_BYTES = 16 * 1024;

/** A pane's log: its last lines (escapes removed, homes written from ~, the project's folder as .), or why there are none.
 *  `every`: while the job runs, how often its log is read again (no job of Timmy's tells a reader of its log that it printed,
 *  so the pane says how often it looks). */
export type PaneTail = ({ lines: string[] } | { why: string }) & { every?: number };

/** A quiet pane's receipt, checked in this reading: verified (verifyReceiptIn: its chain link, body hash and signature), not
 *  verified with why, or not found on the chain read here. */
export type ReceiptCheck = { state: 'verified' } | { state: 'failed'; reason: string } | { state: 'not found'; reason: string };

/** The jobs drawn as panes: every live one of the project, and a Workbench's runs in another project (`away`, as the Control
 *  Room always listed them apart); then, in the PANES_MAX slots the running ones (chat turns being answered among them) leave,
 *  the project's newest ended runs, as quiet panes. */
export function paneJobs(jobs: readonly JobRow[], away: readonly JobRow[], turnsRunning: number): { live: JobRow[]; away: JobRow[]; quiet: JobRow[] } {
  const live = jobs.filter((j) => j.live);
  const elsewhere = away.filter((j) => j.live);
  const left = Math.max(0, PANES_MAX - live.length - elsewhere.length - turnsRunning);
  return { live, away: elsewhere, quiet: jobs.filter((j) => !j.live).slice(0, left) };
}

/** One pane, in the order drawn: a job (running, running in another project, or quiet: ended), or a chat turn being answered. */
export type PaneEntry<T> = { kind: 'job'; job: JobRow; quiet: boolean; away: boolean } | { kind: 'turn'; turn: T };

/** The panes in the order both surfaces draw them: the project's running jobs, the chat turns being answered, a Workbench's
 *  runs in another project, then the newest ended. */
export function paneOrder<T>(p: { live: readonly JobRow[]; away: readonly JobRow[]; quiet: readonly JobRow[] }, turns: readonly T[]): Array<PaneEntry<T>> {
  return [
    ...p.live.map((job): PaneEntry<T> => ({ kind: 'job', job, quiet: false, away: false })),
    ...turns.map((turn): PaneEntry<T> => ({ kind: 'turn', turn })),
    ...p.away.map((job): PaneEntry<T> => ({ kind: 'job', job, quiet: false, away: true })),
    ...p.quiet.map((job): PaneEntry<T> => ({ kind: 'job', job, quiet: true, away: false })),
  ];
}

/** R5 (H131; the operator's 22:32 order, item 1): the turns being answered, less any whose own receipt is sealed (its hold is
 *  let go a moment after): matched by the turn's identity, never by surface and time. */
export const liveTurnsOf = <T extends { id?: string }>(turns: readonly T[], sealed: ReadonlyArray<{ turn?: string }>): T[] => turns.filter((t) => !t.id || !sealed.some((x) => x.turn === t.id));

/** A job's receipt (its short id, as the job store keeps it) checked against `chain`: found by its id and its job, then
 *  verified there (src/utils/receipts.ts verifyReceiptIn). */
export function checkReceipt(chain: readonly Receipt[], job: string, short: string): ReceiptCheck {
  const found = chain.filter((r) => typeof r.hash === 'string' && r.hash.slice(7, 15) === short && r.job?.id === job);
  if (!found.length) return { state: 'not found', reason: 'not found on the chain read here' };
  if (found.length > 1) return { state: 'not found', reason: 'more than one receipt of this job has this id' };
  const v = verifyReceiptIn(chain, found[0].hash);
  return v.ok ? { state: 'verified' } : { state: 'failed', reason: v.reason };
}

/** A log's last `n` printed lines (each as a terminal would leave it: after its last carriage return), or why none: at most
 *  TAIL_BYTES of its end are read, and a line cut where the read starts is left out. */
export function paneTail(file: string, n: number, clean: (t: string) => string): PaneTail {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { why: code === 'ENOENT' ? 'no log yet (it printed nothing, or never started)' : `its log could not be read (${code ?? 'error'})` };
  }
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - from);
    const got = readSync(fd, buf, 0, buf.length, from);
    const raw = buf.subarray(0, got).toString('utf8').split('\n');
    // a read that starts inside a line leaves that line out
    if (from > 0) raw.shift();
    const lines = raw.map((l) => {
      const shown = l.split('\r').filter((p) => p.trim()).pop() ?? '';
      return clean(lineText(shown));
    }).filter((l) => l.trim());
    return { lines: lines.slice(-n) };
  } catch (e) {
    return { why: `its log could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  } finally {
    try { closeSync(fd); } catch { /* closed */ }
  }
}

/** A job's pane log as both surfaces read it: its record's log's last TAIL_MAX lines, the job's folder written as . and the
 *  home folders as ~; or why, when its record was not read. */
export const paneTailOf = (rec: Pick<JobRecord, 'logPath'> | undefined, j: Pick<JobRow, 'root'>, env: Env): PaneTail => (rec
  ? paneTail(rec.logPath, TAIL_MAX, (t) => scrubHomes(t.split(j.root).join('.'), env as NodeJS.ProcessEnv))
  : { why: 'its record was not read here' });

/** A job's mark: ▶ running (never ●: that is a live connection), ✓ completed, ✕ failed (amber), ■ stopped, = no change, ? not
 *  known; its word is always beside it. */
export function jobMark(j: Pick<JobRow, 'mark' | 'live'>, g: Pick<Glyphs, 'next' | 'ok' | 'fail' | 'unicode'>): { glyph: string; role: Role } {
  if (j.mark === 'running' || (j.live && j.mark !== 'failed')) return { glyph: g.next, role: 'text' };
  if (j.mark === 'ok') return { glyph: g.ok, role: 'text' };
  if (j.mark === 'failed') return { glyph: g.fail, role: 'failure' };
  if (j.mark === 'stopped') return { glyph: g.unicode ? '■' : '#', role: 'text' };
  if (j.mark === 'unchanged') return { glyph: '=', role: 'text' };
  return { glyph: '?', role: 'secondary' };
}

/** Who started a job, in the Control Room's words. */
export const whoWords = (j: Pick<JobRow, 'owner'>): string => (j.owner === 'workbench' ? 'this Workbench' : j.owner === 'live-session' ? 'another session' : j.owner === 'ended-session' ? 'an ended session' : 'started by: not recorded');

/** A quiet pane's exit, as its record has it. */
export const exitWords = (j: Pick<JobRow, 'exitCode'>): string => (j.exitCode === undefined ? 'exit not recorded' : j.exitCode === null ? 'no exit code' : `exit ${j.exitCode}`);

/** A quiet pane's receipt in words, and their role: green (live) only when verifyReceiptIn confirmed it in this reading; amber
 *  with ✕ when it does not verify, with why; quiet when it is not found here or was not checked. */
export function receiptWords(j: Pick<JobRow, 'receipt'>, v: ReceiptCheck | undefined, g: Pick<Glyphs, 'ok' | 'fail'>): { words: string; role: Role } {
  if (!j.receipt) return { words: 'no receipt', role: 'secondary' };
  if (v?.state === 'verified') return { words: `${g.ok} receipt ${j.receipt} verified`, role: 'live' };
  if (v?.state === 'failed') return { words: `${g.fail} receipt ${j.receipt} does not verify: ${v.reason}`, role: 'failure' };
  return { words: `receipt ${j.receipt} (${v ? v.reason : 'not verified here'})`, role: 'secondary' };
}

/** How a chat turn being answered is stopped, where it was sent from, in the frame's words (src/ops/workspace-frame.ts
 *  turnStopWords): "Ctrl+C in the REPL stops it". */
export const turnStopLine = (s: ChatSurface): string => `${turnStopWords(s)} stops it`;
