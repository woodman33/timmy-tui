/**
 * R4 (H113): one conversation per project, whichever surface sends to it: the REPL (`timmy`), the monitor (`timmy watch`), the
 * terminal Workbench (`timmy workbench`) and the companion. Each is a process of its own, and each turn is the one turn
 * implementation (src/repl/turn.ts runTurn). Before it runs, this module makes it the project's:
 *
 * - one turn at a time in a project, across processes: a turn takes the project's chat hold (`.timmy/chat-turns/`, written
 *   before anything is sent, its writer named by pid and process start: src/ops/process-proof.ts, the proof rule recovery
 *   uses), and a turn from any surface while another runs is refused with whose it is and since when; nothing is sent then,
 *   so two surfaces open on one project never run a second agent for one turn, and a message sent again while its turn runs
 *   (a duplicate Enter, a page that reconnected) is not sent twice. A hold whose writer is gone is stale: removed, never
 *   trusted. A message given a key (the companion's page sends one) that this project has already run is refused after its
 *   turn too, naming the receipt it got (`.timmy/chat-turns/keys.jsonl`).
 * - the project's kept conversation (`.sessions` in the project, as the REPL keeps it since R1): the turn continues the newest
 *   conversation as it is on disk now, so a turn the Workbench or the monitor sent is in what the REPL's next turn reads, and
 *   the other way round. A conversation this surface started (the REPL's /new) and has not written yet is kept: it is the
 *   newest. Only the agent's own conversation is read and loaded: nothing is merged or rewritten.
 * - the surface, named on the turn's receipt (src/repl/seal.ts sealTurn).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatSurface } from '../contracts/chat-session.js';
import { THIS_PROCESS, writerState } from '../ops/process-proof.js';
import type { SealedTurn, TurnFacts } from '../repl/seal.js';
import type { Transcript } from '../repl/transcript.js';
import { runTurn, type TurnAbandon, type TurnAgent, type TurnInspect, type TurnMarks, type TurnResult } from '../repl/turn.js';

export const CHAT_TURNS_DIR = '.timmy/chat-turns';
export const CHAT_HOLD_SCHEMA = 'timmy.chat-turn-hold/1';
const HOLD_FILE = /^t[0-9]+-[0-9a-f]{8}\.json$/;
const KEYS_FILE = 'keys.jsonl';

const SURFACE_WORDS: Readonly<Record<ChatSurface, string>> = { repl: 'the REPL', monitor: 'the monitor', workbench: 'the Workbench', companion: 'the companion' };
export const surfaceWords = (s: ChatSurface): string => SURFACE_WORDS[s] ?? s;

interface HoldRecord {
  schema: typeof CHAT_HOLD_SCHEMA;
  surface: ChatSurface;
  owner: { pid: number; started: string };
  taken: string;
}

/** Another turn's hold on the project, as a refusal names it. */
export interface OtherTurn { surface: ChatSurface; pid: number; taken: string; mine: boolean; proof: 'alive' | 'unknown' }

/** The project's chat-turns folder, inside the project and through no link (made when `make`). */
function turnsDir(root: string, make: boolean): { ok: true; abs: string } | { ok: false; error: string; missing?: true } {
  let real: string;
  try { real = fs.realpathSync(root); } catch { return { ok: false, error: 'the project folder is not there', missing: true }; }
  let at = real;
  for (const part of CHAT_TURNS_DIR.split('/')) {
    at = path.join(at, part);
    try {
      if (fs.lstatSync(at).isSymbolicLink()) return { ok: false, error: `${path.relative(real, at).split(path.sep).join('/')} is a symbolic link` };
    } catch {
      if (!make) return { ok: false, error: 'no turns', missing: true };
      try { fs.mkdirSync(at); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, error: `${(e as NodeJS.ErrnoException).code ?? 'error'} making ${CHAT_TURNS_DIR}` }; }
    }
  }
  return { ok: true, abs: at };
}

function readHold(file: string): HoldRecord | undefined {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 16 * 1024) return undefined;
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as HoldRecord;
    if (!r || r.schema !== CHAT_HOLD_SCHEMA || !r.owner || typeof r.owner.pid !== 'number' || typeof r.owner.started !== 'string') return undefined;
    return r;
  } catch { return undefined; }
}

/** The turns that hold the project now, other than `except` (a file name); a stale one (its writer gone) is removed as it is seen. */
export function runningTurns(root: string, except?: string): OtherTurn[] {
  const dir = turnsDir(root, false);
  if (!dir.ok) return [];
  let names: string[];
  try { names = fs.readdirSync(dir.abs).filter((n) => HOLD_FILE.test(n) && n !== except); } catch { return []; }
  const out: OtherTurn[] = [];
  for (const n of names) {
    const file = path.join(dir.abs, n);
    const r = readHold(file);
    if (!r) continue;
    const mine = r.owner.pid === THIS_PROCESS.pid && r.owner.started === THIS_PROCESS.started;
    const proof = mine ? 'alive' : writerState(r.owner);
    if (proof === 'gone') { try { fs.unlinkSync(file); } catch { /* already gone */ } continue; }
    out.push({ surface: r.surface, pid: r.owner.pid, taken: r.taken, mine, proof });
  }
  return out.sort((a, b) => a.taken.localeCompare(b.taken));
}

/** A running turn in words: whose surface, which process, since when. */
export function turnWords(t: OtherTurn): string {
  const since = (() => { const d = new Date(t.taken); return Number.isNaN(d.getTime()) ? t.taken : d.toLocaleTimeString(); })();
  return `${surfaceWords(t.surface)} (${t.mine ? 'this process' : `pid ${t.pid}`}, since ${since})${t.proof === 'unknown' ? '; its start could not be read, so it is taken as running' : ''}`;
}

/** The lines a message gets when another turn holds the project: nothing was sent. */
export function busyLines(t: OtherTurn): string[] {
  return [
    `Not sent: a chat turn of this project is running in ${turnWords(t)}.`,
    'Try: send it again when that turn ends: one turn at a time keeps the project\'s one conversation in order. Nothing was sent to any model.',
  ];
}

export interface TurnHold { release(): void }

/**
 * Takes the project for one turn: writes this turn's hold, then reads the others; another live one refuses it (this hold is
 * removed again), so two turns started at the same moment in two processes are both refused, never both sent. A project
 * folder that is not there, or whose hold cannot be written, takes no hold: the turn says why it was not sent.
 */
export function takeTurnHold(root: string, surface: ChatSurface): { ok: true; hold: TurnHold } | { ok: false; lines: string[] } {
  const dir = turnsDir(root, true);
  if (!dir.ok) return { ok: false, lines: [`Not sent: the project's chat hold could not be taken (${dir.error}), so one turn at a time cannot be kept.`, 'Nothing was sent to any model.'] };
  const name = `t${THIS_PROCESS.pid}-${randomBytes(4).toString('hex')}.json`;
  const file = path.join(dir.abs, name);
  const rec: HoldRecord = { schema: CHAT_HOLD_SCHEMA, surface, owner: { pid: THIS_PROCESS.pid, started: THIS_PROCESS.started }, taken: new Date().toISOString() };
  try {
    const tmp = path.join(dir.abs, `.${name}.${randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(rec)}\n`, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    return { ok: false, lines: [`Not sent: the project's chat hold could not be written (${(e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : 'error')} in ${CHAT_TURNS_DIR}).`, 'Nothing was sent to any model.'] };
  }
  let released = false;
  const release = (): void => { if (released) return; released = true; try { fs.unlinkSync(file); } catch { /* already gone */ } };
  const other = runningTurns(root, name)[0];
  if (other) { release(); return { ok: false, lines: busyLines(other) }; }
  return { ok: true, hold: { release } };
}

/** A turn sent with a key, as `.timmy/chat-turns/keys.jsonl` keeps it. */
export interface KeyedTurn { key: string; surface: ChatSurface; at: string; receipt?: string }

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

/** The turn this project already ran with `key`, or null. */
export function keyedTurn(root: string, key: string): KeyedTurn | null {
  if (!KEY_PATTERN.test(key)) return null;
  const dir = turnsDir(root, false);
  if (!dir.ok) return null;
  try {
    const lines = fs.readFileSync(path.join(dir.abs, KEYS_FILE), 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const k = JSON.parse(lines[i]) as KeyedTurn; if (k && k.key === key) return k; } catch { /* a line that is not one */ }
    }
  } catch { /* none kept */ }
  return null;
}

function keepKey(root: string, k: KeyedTurn): void {
  if (!KEY_PATTERN.test(k.key)) return;
  const dir = turnsDir(root, true);
  if (!dir.ok) return;
  try { fs.appendFileSync(path.join(dir.abs, KEYS_FILE), `${JSON.stringify(k)}\n`, 'utf8'); } catch { /* the hold stood for the turn; the key is help */ }
}

/** The receipt a keyed turn got, for a surface that seals after its turn (the chat session): a later resend names it. */
export function noteTurnKey(root: string, key: string, surface: ChatSurface, receipt: string): void {
  keepKey(root, { key, surface, at: new Date().toISOString(), receipt });
}

/** The agent's kept conversation, as src/agent/conversation.ts ConversationManager has it (read through its shape). */
interface KeptConversation {
  readonly directory?: string;
  listSessions?(): string[];
  load?(id: string): unknown[];
  getHistory?(): unknown[];
  currentSession?: string | null;
}

export interface Continued {
  /** the conversation the turn continues (its session id), or null when the agent keeps none */
  session: string | null;
  /** how many messages it holds before the turn */
  messages: number;
  /** how many of them another surface (another process) added since this agent last held it */
  added: number;
  /** the agent's conversation was not this project's (the monitor's agent, or another project's), and is now */
  moved: boolean;
}

const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/**
 * Makes the agent's conversation the project's kept one, as it is on disk now: the newest conversation in `<root>/.sessions`
 * (another surface's turns included), or one this agent started and has not written yet (the REPL's /new), which is the
 * newest. An agent with no kept conversation (a test's FAKE) is left as it is.
 */
export function continueConversation(agent: unknown, root: string): Continued {
  const a = agent as { conversation?: KeptConversation; useSessions?: (dir: string) => { resumed: boolean; messages: number } };
  const conv = a.conversation;
  const none: Continued = { session: null, messages: 0, added: 0, moved: false };
  if (!conv || typeof a.useSessions !== 'function' || typeof conv.listSessions !== 'function' || typeof conv.load !== 'function' || typeof conv.getHistory !== 'function') return none;
  const dir = path.join(root, '.sessions');
  if (!conv.directory || real(conv.directory) !== real(dir)) {
    const r = a.useSessions(dir);
    const now = a.conversation;
    return { session: now?.currentSession ?? null, messages: r.messages, added: 0, moved: true };
  }
  const held = conv.getHistory().length;
  const current = conv.currentSession ?? null;
  let newest: string | null = null;
  try { newest = conv.listSessions()[0] ?? null; } catch { newest = null; }
  // nothing kept on disk, or this agent's own new conversation (started, not written yet): it is the newest
  if (!newest) return { session: current, messages: held, added: 0, moved: false };
  if (current && current !== newest && current > newest && !fs.existsSync(path.join(dir, `${current}.jsonl`))) return { session: current, messages: held, added: 0, moved: false };
  try {
    const loaded = conv.load(newest).length;
    return { session: newest, messages: loaded, added: current === newest ? Math.max(0, loaded - held) : loaded, moved: false };
  } catch {
    // an unreadable conversation file: the turn goes on with what this agent holds (nothing is rewritten)
    return { session: current, messages: held, added: 0, moved: false };
  }
}

export interface ProjectTurnInput {
  agent: TurnAgent;
  project: { name: string; root: string };
  surface: ChatSurface;
  text: string;
  /** where the turn is drawn (the REPL's transcript; another surface's own sink) */
  sink: Pick<Transcript, 'handle' | 'endTurn'>;
  clock?: () => number;
  marks?: TurnMarks;
  signal?: AbortSignal;
  /** seals the turn (src/repl/seal.ts sealTurn's facts); the surface is added to the facts before it is called */
  seal?: (facts: TurnFacts) => SealedTurn;
  abandon?: TurnAbandon;
  more?: TurnInspect;
  /**
   * a key the surface gave this message (the companion's page: 8 to 80 letters, digits, - or _): a key this project already
   * ran is refused, never sent again. A surface that seals after the turn notes its receipt with noteTurnKey.
   */
  key?: string;
  /** told what the turn continues, after the conversation is the project's and before anything is sent */
  onContinue?: (c: Continued) => void;
}

export type ProjectTurnResult =
  | { status: 'refused'; lines: string[] }
  | { status: TurnResult; continued: Continued };

/** One turn of the project's conversation, on any surface: the hold, the conversation, the turn, its receipt naming the surface. */
export async function projectTurn(i: ProjectTurnInput): Promise<ProjectTurnResult> {
  const root = i.project.root;
  if (i.key) {
    const before = keyedTurn(root, i.key);
    if (before) return { status: 'refused', lines: [`Not sent again: this message was already sent from ${surfaceWords(before.surface)} at ${before.at}${before.receipt ? ` (receipt ${before.receipt.slice(7, 15)})` : ''}.`, 'Nothing was sent to any model.'] };
  }
  const taken = takeTurnHold(root, i.surface);
  if (!taken.ok) return { status: 'refused', lines: taken.lines };
  let sealed: SealedTurn | null = null;
  try {
    const continued = continueConversation(i.agent, root);
    i.onContinue?.(continued);
    const seal = i.seal ? (facts: TurnFacts): SealedTurn => { sealed = i.seal!({ ...facts, surface: i.surface }); return sealed; } : undefined;
    if (i.key) keepKey(root, { key: i.key, surface: i.surface, at: new Date().toISOString() });
    // the hold is given back once the turn has ended and is sealed (its summary), before the REPL's inspector looks for where
    // to inspect it: the conversation is whole by then
    const more: TurnInspect = { ...i.more, summary: (s) => { taken.hold.release(); i.more?.summary?.(s); } };
    const status = await runTurn(i.agent, i.sink as Transcript, i.text, i.clock, i.marks, i.signal, seal, i.abandon, more);
    if (i.key && sealed) keepKey(root, { key: i.key, surface: i.surface, at: new Date().toISOString(), receipt: (sealed as SealedTurn).hash });
    return { status, continued };
  } finally {
    taken.hold.release();
  }
}
