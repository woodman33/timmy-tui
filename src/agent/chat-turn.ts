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
 *   trusted. A message given a key (src/contracts/chat-session.ts sendOnce, CHAT_KEY) is kept in `.timmy/chat-turns/keys.jsonl`
 *   as its turn starts and as it ends: sent again with that key, a turn that went out is refused naming its receipt, one that
 *   sent nothing is sent (a retry), and one whose end was never recorded (its process ended during it) is refused (R4 lead).
 * - the project's kept conversation (`.sessions` in the project, as the REPL keeps it since R1): the turn continues the newest
 *   conversation as it is on disk now, so a turn the Workbench or the monitor sent is in what the REPL's next turn reads, and
 *   the other way round. A conversation this surface started (the REPL's /new) and has not written yet is kept: it is the
 *   newest. Only the agent's own conversation is read and loaded: nothing is merged or rewritten.
 * - the surface, named on the turn's receipt (src/repl/seal.ts sealTurn).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CHAT_KEY, type ChatSurface } from '../contracts/chat-session.js';
import { THIS_PROCESS, writerState } from '../ops/process-proof.js';
import type { SealedTurn, TurnFacts } from '../repl/seal.js';
import type { Transcript } from '../repl/transcript.js';
import { runTurn, type TurnAbandon, type TurnAgent, type TurnInspect, type TurnMarks, type TurnResult, type TurnSummary } from '../repl/turn.js';
import type { ConversationManager } from './conversation.js';
import { cloudModelTag, ollamaAt } from '../setup/ollama-models.js';
import type { InferenceAt, RoutePolicy } from './route-policy.js';

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
/**
 * Another turn's hold on the project, as a refusal names it. R5 lead (the operator's 22:32 order, item 1): `id` is the hold's
 * own name (t<pid>-<8 hex>), the turn's identity: its receipt names it (turn_id), so a reader matches a hold to its receipt by
 * identity, never by surface and time.
 */
export interface OtherTurn { id: string; surface: ChatSurface; pid: number; taken: string; mine: boolean; proof: 'alive' | 'unknown' }
/** A hold's name without its .json: the turn's id. */
export const TURN_ID = /^t[0-9]+-[0-9a-f]{8}$/;
const STOP_SCHEMA = 'timmy.chat-turn-stop/1';

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

/**
 * The turns that hold the project now, other than `except` (a file name); a stale one (its writer gone) is removed as it is
 * seen, unless `readOnly` (R5 lead: the workspace frame reads, never writes).
 */
export function runningTurns(root: string, except?: string, o: { readOnly?: boolean } = {}): OtherTurn[] {
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
    // a hold whose writer is gone (it ended, or crashed mid-turn) is no running turn; a stop asked of it goes with it
    if (proof === 'gone') { if (!o.readOnly) { for (const f of [file, file.replace(/\.json$/, '.stop')]) { try { fs.unlinkSync(f); } catch { /* already gone */ } } } continue; }
    out.push({ id: n.replace(/\.json$/, ''), surface: r.surface, pid: r.owner.pid, taken: r.taken, mine, proof });
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

/** A turn's hold: its id (the turn's identity, sealed on its receipt as turn_id), and its release. */
export interface TurnHold { id: string; release(): void }

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
  return { ok: true, hold: { id: name.replace(/\.json$/, ''), release } };
}

/**
 * R5 lead (the operator's 22:32 order, item 2): asks the turn `id` of the project to stop, from any surface (the companion's
 * Stop, the Workbench's Enter on Stop the turn): a request file beside its hold, which the process that holds the turn watches
 * (watchTurnStop) and answers by stopping the turn as its own Esc or Ctrl+C would. Refused when no such turn is being answered
 * now: the id is not a turn's, there is no such hold, or its writer has ended (nothing to stop). Writes nothing else.
 */
export function requestTurnStop(root: string, id: string, by: ChatSurface): { ok: true; surface: ChatSurface; pid: number } | { ok: false; why: string } {
  if (!TURN_ID.test(id)) return { ok: false, why: 'that is not a chat turn\'s id' };
  const dir = turnsDir(root, false);
  if (!dir.ok) return { ok: false, why: 'that chat turn is not being answered now (it ended, or it was never this project\'s)' };
  const r = readHold(path.join(dir.abs, `${id}.json`));
  if (!r) return { ok: false, why: 'that chat turn is not being answered now (it ended, or it was never this project\'s)' };
  const mine = r.owner.pid === THIS_PROCESS.pid && r.owner.started === THIS_PROCESS.started;
  if (!mine && writerState(r.owner) === 'gone') return { ok: false, why: 'that chat turn\'s process has ended, so there is nothing left to stop' };
  try {
    const tmp = path.join(dir.abs, `.${id}.stop.${randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify({ schema: STOP_SCHEMA, by, at: new Date().toISOString() })}\n`, { flag: 'wx' });
    fs.renameSync(tmp, path.join(dir.abs, `${id}.stop`));
  } catch (e) {
    return { ok: false, why: `the stop could not be written (${(e as NodeJS.ErrnoException).code ?? 'error'} in ${CHAT_TURNS_DIR})` };
  }
  return { ok: true, surface: r.surface, pid: r.owner.pid };
}

/**
 * Watches for a stop asked of this process's turn `id` (requestTurnStop), every `everyMs`: `onStop` is told once, with the
 * surface that asked. close() ends the watch and removes the request (the turn has ended).
 */
export function watchTurnStop(root: string, id: string, onStop: (by: ChatSurface | null) => void, everyMs = 200): { close(): void } {
  const dir = turnsDir(root, false);
  if (!dir.ok || !TURN_ID.test(id)) return { close: () => undefined };
  const file = path.join(dir.abs, `${id}.stop`);
  let done = false;
  const look = (): void => {
    if (done) return;
    let raw: string;
    try { const st = fs.lstatSync(file); if (!st.isFile() || st.size > 4096) return; raw = fs.readFileSync(file, 'utf8'); } catch { return; }
    done = true;
    clearInterval(timer);
    let by: ChatSurface | null = null;
    try { const x = JSON.parse(raw) as { schema?: string; by?: string }; if (x?.schema === STOP_SCHEMA && typeof x.by === 'string' && ['repl', 'monitor', 'workbench', 'companion'].includes(x.by)) by = x.by as ChatSurface; } catch { /* a request with no readable surface still stops */ }
    onStop(by);
  };
  const timer = setInterval(look, everyMs);
  timer.unref?.();
  return { close: () => { done = true; clearInterval(timer); try { fs.unlinkSync(file); } catch { /* none asked */ } } };
}

/**
 * A record of `.timmy/chat-turns/keys.jsonl`: a keyed message's turn as it started (before anything was sent, by the process
 * `owner` names) and as it ended (whether a request went out, how it ended, its receipt once sealed). The newest record of a key
 * decides what a message sent again with it gets (keyDecision). Records H113 wrote before (no `state`) are read too: one with a
 * receipt as a turn that went out, one without as a turn whose end was not recorded.
 */
export interface KeyedTurn {
  key: string;
  surface: ChatSurface;
  at: string;
  state?: 'started' | 'ended';
  owner?: { pid: number; started: string };
  /** an ended turn: whether a request left this computer for a model (absent: not recorded) */
  sent?: boolean;
  /** an ended turn: how it ended (src/repl/turn.ts TurnResult: ok, failed, cancelled) */
  status?: string;
  receipt?: string;
}

/** How much of the end of keys.jsonl is read: a message is sent again within minutes, never after thousands of others. */
const KEYS_TAIL = 256 * 1024;

/** The newest record of `key` in the project's keys file, or null (none kept, or not a key). */
export function keyedTurn(root: string, key: string): KeyedTurn | null {
  if (!CHAT_KEY.test(key)) return null;
  const dir = turnsDir(root, false);
  if (!dir.ok) return null;
  let text = '';
  try {
    const file = path.join(dir.abs, KEYS_FILE);
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null;
    const fd = fs.openSync(file, 'r');
    try {
      const from = Math.max(0, st.size - KEYS_TAIL);
      const buf = Buffer.alloc(st.size - from);
      const n = fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.subarray(0, n).toString('utf8');
      // a read that starts inside a line leaves that line out
      if (from > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const k = JSON.parse(lines[i]) as KeyedTurn; if (k && k.key === key) return k; } catch { /* a line that is not one */ }
  }
  return null;
}

function keepKey(root: string, k: KeyedTurn): void {
  if (!CHAT_KEY.test(k.key)) return;
  const dir = turnsDir(root, true);
  if (!dir.ok) return;
  try { fs.appendFileSync(path.join(dir.abs, KEYS_FILE), `${JSON.stringify(k)}\n`, 'utf8'); } catch { /* the hold stood for the turn; the key is help */ }
}

const NOTHING_SENT = 'Nothing was sent to any model.';

/**
 * What a message sent with `key` gets now, from the key's newest record (src/contracts/chat-session.ts sendOnce's table): sent
 * (no turn had it, or its turn ended having sent nothing: a retry), or refused with the words that say why.
 */
export function keyDecision(root: string, key: string): { send: true; retry: boolean } | { send: false; lines: string[] } {
  if (!CHAT_KEY.test(key)) {
    return { send: false, lines: ['Not sent: the message\'s key is not one Timmy keeps (8 to 80 letters, digits, - or _), so sending it only once could not be kept.', NOTHING_SENT] };
  }
  const k = keyedTurn(root, key);
  if (!k) return { send: true, retry: false };
  const from = surfaceWords(k.surface);
  const ended = k.state === 'ended' || (k.state === undefined && typeof k.receipt === 'string');
  if (ended && k.sent === false) return { send: true, retry: true };
  const receipt = k.receipt ? ` (receipt ${k.receipt.slice(7, 15)})` : '';
  if (ended) {
    return { send: false, lines: [k.sent === true || k.state === undefined
      ? `Not sent again: this message was already sent from ${from} at ${k.at}${receipt}.`
      : `Not sent again: this message was tried from ${from} at ${k.at}${receipt}, and whether it reached a model was not recorded.`, NOTHING_SENT] };
  }
  // started, and not ended: its turn runs now, or its process ended during it
  const proof = k.owner ? (k.owner.pid === THIS_PROCESS.pid && k.owner.started === THIS_PROCESS.started ? 'alive' : writerState(k.owner)) : 'gone';
  if (proof !== 'gone') {
    return { send: false, lines: [`Not sent again: this message is being sent now from ${from} (${proof === 'alive' && k.owner!.pid === THIS_PROCESS.pid ? 'this process' : `pid ${k.owner!.pid}`}, since ${k.at}).`, NOTHING_SENT] };
  }
  return { send: false, lines: [
    `Not sent again: this message was being sent from ${from} at ${k.at} when that process ended, so whether it reached a model is not known.`,
    `Try: send it as a new message if it should be asked again. ${NOTHING_SENT}`,
  ] };
}

/**
 * The end of a keyed turn, as a surface that seals after the turn knows it (the chat session): whether it sent, how it ended,
 * and its receipt. Sent again, the message is refused naming the receipt (or sent, when this turn sent nothing).
 */
export function noteTurnKey(root: string, key: string, surface: ChatSurface, end: { sent: boolean; status: string; receipt?: string }): void {
  keepKey(root, { key, surface, at: new Date().toISOString(), state: 'ended', sent: end.sent, status: end.status, ...(end.receipt ? { receipt: end.receipt } : {}) });
}

// ── the turn's route (R10, H169) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * R10 (H169; the operator's order of 2026-10-22: "Record actual returned model separately from the requested model", and the
 * spec's "Requested model, returned model, inference destination, gateway path and log destination are distinct fields"): each
 * turn's route, snapshotted as the turn starts (a model chosen while it runs changes only the next turn) and closed as it ends
 * (the model the provider named in its answer, how it ended), kept beside the holds in `.timmy/chat-turns/routes.jsonl`, one
 * line at each, under the turn's id (its hold's, sealed on its receipt as turn_id). A receipt is never rewritten: this record
 * sits beside it, and both are read by the turn's id.
 */
export const TURN_ROUTE_SCHEMA = 'timmy.chat-turn-route/1';
const ROUTES_FILE = 'routes.jsonl';

/** Where a turn's model call goes, as the turn starts. */
export interface TurnRouteStart {
  source: 'openrouter' | 'ollama-local' | 'ollama-cloud';
  /** the model the turn asks for */
  model: string;
  /** where the inference runs (src/agent/route-policy.ts inferenceAt) */
  inference: InferenceAt;
  /** the address asked, never a key: openrouter.ai, an Ollama's host, ollama.com */
  endpoint: string;
  gateway: 'none' | 'cloudflare';
  /** the route policy the turn was checked against */
  policy?: RoutePolicy;
}

/** One line of routes.jsonl. */
export interface TurnRouteLine {
  schema: typeof TURN_ROUTE_SCHEMA;
  turn: string;
  surface: ChatSurface;
  state: 'started' | 'ended';
  at: string;
  route?: TurnRouteStart;
  /** where the turn's log is kept: on this computer, the project's conversation file and this record (project-relative) */
  log?: { where: 'this computer'; conversation: string | null; record: string };
  status?: TurnResult;
  sent?: boolean;
  /** the model the provider named in its answer (OpenRouter's response `model`; Ollama's), when it named one */
  returned?: string;
  /** the last-resort local answer came in place of the requested route (src/agent/core.ts lastFallback) */
  fallback?: { model: string; host: string };
  /** what the turn observed of its route's connection: it answered, or did not answer (a failed connection) */
  connection?: 'answered' | 'did not answer';
}

/** A turn's route, its start and its end merged (the end absent while it runs, or when its process ended during it). */
export interface TurnRoute {
  turn: string;
  surface: ChatSurface;
  startedAt: string;
  requested: { source: TurnRouteStart['source']; model: string };
  inference: InferenceAt;
  endpoint: string;
  gateway: 'none' | 'cloudflare';
  log: { where: 'this computer'; conversation: string | null; record: string };
  policy?: RoutePolicy;
  ended?: { at: string; status: TurnResult; sent: boolean; returned?: string; fallback?: { model: string; host: string }; connection?: 'answered' | 'did not answer' };
}

/** The route an agent's next turn takes, as it can tell (src/agent/core.ts Agent localChatRoute and openRouterModel), else null. */
export function routeOfAgent(agent: unknown): TurnRouteStart | null {
  const a = agent as { localChatRoute?: () => { host: string; model: string } | null; openRouterModel?: () => string };
  try {
    const local = typeof a.localChatRoute === 'function' ? a.localChatRoute() : null;
    if (local) {
      const at = ollamaAt(local.host);
      const inference: InferenceAt = cloudModelTag(local.model) ? 'cloud' : 'error' in at ? 'not known' : at.loopback ? 'this computer' : 'another computer';
      return { source: 'ollama-local', model: local.model, inference, endpoint: 'error' in at ? local.host : at.host, gateway: 'none' };
    }
    if (typeof a.openRouterModel === 'function') return { source: 'openrouter', model: a.openRouterModel(), inference: 'cloud', endpoint: 'openrouter.ai', gateway: 'none' };
  } catch { /* an agent that cannot tell */ }
  return null;
}

function keepRoute(root: string, line: TurnRouteLine): void {
  const dir = turnsDir(root, true);
  if (!dir.ok) return;
  try { fs.appendFileSync(path.join(dir.abs, ROUTES_FILE), `${JSON.stringify(line)}\n`, 'utf8'); } catch { /* the receipt still names the turn; this record is help */ }
}

/** The lines of routes.jsonl (its last 256 KiB), oldest first. */
function routeLines(root: string): TurnRouteLine[] {
  const dir = turnsDir(root, false);
  if (!dir.ok) return [];
  let text = '';
  try {
    const file = path.join(dir.abs, ROUTES_FILE);
    const st = fs.lstatSync(file);
    if (!st.isFile()) return [];
    const fd = fs.openSync(file, 'r');
    try {
      const from = Math.max(0, st.size - KEYS_TAIL);
      const buf = Buffer.alloc(st.size - from);
      const n = fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.subarray(0, n).toString('utf8');
      if (from > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const out: TurnRouteLine[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l) as TurnRouteLine; if (r && r.schema === TURN_ROUTE_SCHEMA && typeof r.turn === 'string' && TURN_ID.test(r.turn)) out.push(r); } catch { /* a line that is not one */ }
  }
  return out;
}

function merged(lines: TurnRouteLine[]): TurnRoute | null {
  const start = lines.find((l) => l.state === 'started' && l.route);
  if (!start || !start.route) return null;
  const end = [...lines].reverse().find((l) => l.state === 'ended');
  const r = start.route;
  return {
    turn: start.turn, surface: start.surface, startedAt: start.at, requested: { source: r.source, model: r.model }, inference: r.inference, endpoint: r.endpoint,
    gateway: r.gateway, log: start.log ?? { where: 'this computer', conversation: null, record: `${CHAT_TURNS_DIR}/${ROUTES_FILE}` }, ...(r.policy ? { policy: r.policy } : {}),
    ...(end ? { ended: { at: end.at, status: end.status ?? 'failed', sent: end.sent === true, ...(end.returned ? { returned: end.returned } : {}), ...(end.fallback ? { fallback: end.fallback } : {}), ...(end.connection ? { connection: end.connection } : {}) } } : {}),
  };
}

/** A turn's route by its id (its receipt's turn_id), or null when this project keeps none for it (a turn before R10). */
export function turnRoute(root: string, id: string): TurnRoute | null {
  if (!TURN_ID.test(id)) return null;
  return merged(routeLines(root).filter((l) => l.turn === id));
}

/** The project's newest turns' routes, the newest first. */
export function turnRoutes(root: string, max = 20): TurnRoute[] {
  const lines = routeLines(root);
  const ids: string[] = [];
  for (let i = lines.length - 1; i >= 0 && ids.length < max; i--) if (!ids.includes(lines[i].turn)) ids.push(lines[i].turn);
  return ids.map((id) => merged(lines.filter((l) => l.turn === id))).filter((r): r is TurnRoute => r !== null);
}

/** The route in a line, for a row: "OpenRouter · cloud · logs on this computer", "Ollama on this computer · logs on this computer". */
export function turnRouteWords(r: Pick<TurnRoute, 'requested' | 'inference' | 'gateway'>): string {
  const where = r.requested.source === 'openrouter' ? 'OpenRouter · cloud'
    : r.requested.source === 'ollama-cloud' ? 'Ollama Cloud · cloud'
      : r.inference === 'this computer' ? 'Ollama on this computer' : r.inference === 'cloud' ? 'Ollama · its cloud' : `Ollama · ${r.inference}`;
  return `${where}${r.gateway === 'cloudflare' ? ' · through Cloudflare' : ''} · logs on this computer`;
}

/**
 * What a turn's end says of its route's connection, when it says something for certain: the route answered (an answered turn
 * that went out, the requested route's own answer), or the Ollama it asked did not answer (Timmy's own words for a failed
 * connection, src/agent/local-chat.ts). Anything else (an error the service gave, a stop, a refusal) says nothing of it.
 */
export function turnConnection(route: TurnRouteStart, s: Pick<TurnSummary, 'result' | 'sent' | 'error'>, fellBack: boolean): { id: 'ollama' | 'openrouter'; answer: 'accepted' | 'no answer'; detail: string } | null {
  const id = route.source === 'openrouter' ? 'openrouter' : route.source === 'ollama-local' ? 'ollama' : null;
  if (!id) return null;
  if (s.result === 'ok' && s.sent && !fellBack) return { id, answer: 'accepted', detail: route.model };
  if (s.result === 'failed' && id === 'ollama') {
    const msg = String((s.error as Error | undefined)?.message ?? s.error ?? '');
    if (/ did not answer, so nothing was sent\.| stopped answering\./.test(msg)) {
      const why = /\nReason: ([^\n]+)/.exec(msg)?.[1]?.trim();
      return { id, answer: 'no answer', detail: why ?? 'the connection failed' };
    }
  }
  return null;
}

/** What this module reads of an agent's kept conversation (src/agent/core.ts Agent keptConversation, useSessions). */
interface KeepsConversation {
  keptConversation?: () => Pick<ConversationManager, 'directory' | 'current' | 'chosen' | 'listSessions' | 'load' | 'getHistory'>;
  useSessions?: (dir: string) => { resumed: boolean; messages: number };
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
 * (another surface's turns included), or one a person started on this surface and it has not written yet (the REPL's /new),
 * which is the newest. The conversation an agent started by itself when it opened (nothing was kept then) is not a choice:
 * when another surface has written one since, that one is continued (R4 lead: the package rehearsal at 2ba6b73 opened the
 * Workbench, then a REPL, chatted in the Workbench first, and the REPL's turn began a second conversation). An agent with no
 * kept conversation (a test's FAKE) is left as it is.
 */
export function continueConversation(agent: unknown, root: string): Continued {
  // R4 lead: through the agent's public accessor (src/agent/core.ts keptConversation), never its private fields
  const a = agent as KeepsConversation;
  const none: Continued = { session: null, messages: 0, added: 0, moved: false };
  if (typeof a.keptConversation !== 'function' || typeof a.useSessions !== 'function') return none;
  const conv = a.keptConversation();
  const dir = path.join(root, '.sessions');
  if (!conv.directory || real(conv.directory) !== real(dir)) {
    const r = a.useSessions(dir);
    return { session: a.keptConversation().current, messages: r.messages, added: 0, moved: true };
  }
  const held = conv.getHistory().length;
  const current = conv.current;
  let newest: string | null = null;
  try { newest = conv.listSessions()[0] ?? null; } catch { newest = null; }
  // nothing kept on disk, or a new conversation a person started here (/new), not written yet: it is the newest
  if (!newest) return { session: current, messages: held, added: 0, moved: false };
  if (current && conv.chosen && current !== newest && current > newest && !fs.existsSync(path.join(dir, `${current}.jsonl`))) return { session: current, messages: held, added: 0, moved: false };
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
  /**
   * R10 (H169): the turn's route, as the surface took it when the turn started (absent: what the agent tells,
   * routeOfAgent); kept in routes.jsonl under the turn's id
   */
  route?: TurnRouteStart | null;
  /** R10 (H169): the model the provider named in its answer, asked as the turn ends (absent: what the agent tells) */
  returned?: () => string | undefined;
}

export type ProjectTurnResult =
  | { status: 'refused'; lines: string[] }
  | { status: TurnResult; continued: Continued };

/**
 * One turn of the project's conversation, on any surface: the key (when given), the hold, the conversation, the turn, its
 * receipt naming the surface. A keyed message's start is kept before anything is sent and its end before the hold is given
 * back, so a message sent again with its key, from any process, finds how it went (keyDecision).
 */
/**
 * R10 (H169): a turn's observation of its route's connection, kept where the checks keep theirs (the Timmy home's
 * connections record, src/ops/workspace-frame.ts noteTurnAnswer), named as a turn's and for the address or key it asked.
 * Loaded only when there is one to keep; a record that cannot be written changes nothing.
 */
let noting: Promise<void> = Promise.resolve();
/** Settles once every turn's observation this process started is kept (a test's wait; the turn never waits for it). */
export const observationsKept = (): Promise<void> => noting;

async function noteObserved(o: NonNullable<ReturnType<typeof turnConnection>>, route: TurnRouteStart): Promise<void> {
  try {
    const frame = await import('../ops/workspace-frame.js');
    let asked: string | undefined;
    if (o.id === 'ollama') { const at = ollamaAt(route.endpoint); asked = 'error' in at ? undefined : at.origin; }
    else { const { modelKeyFingerprint } = await import('../utils/model-key.js'); asked = modelKeyFingerprint() ?? undefined; }
    frame.noteTurnAnswer(o.id, { answer: o.answer, detail: o.detail, ...(asked ? { asked } : {}) });
  } catch { /* the observation is help: the turn and its receipt stand */ }
}

export async function projectTurn(i: ProjectTurnInput): Promise<ProjectTurnResult> {
  const root = i.project.root;
  if (i.key !== undefined) {
    const d = keyDecision(root, i.key);
    if (!d.send) return { status: 'refused', lines: d.lines };
  }
  const taken = takeTurnHold(root, i.surface);
  if (!taken.ok) return { status: 'refused', lines: taken.lines };
  const key = i.key;
  if (key !== undefined) {
    // read again under the hold: another process may have started this key between the first reading and the hold
    const d = keyDecision(root, key);
    if (!d.send) { taken.hold.release(); return { status: 'refused', lines: d.lines }; }
    keepKey(root, { key, surface: i.surface, at: new Date().toISOString(), state: 'started', owner: { pid: THIS_PROCESS.pid, started: THIS_PROCESS.started } });
  }
  let sealed: SealedTurn | null = null;
  let summary: TurnSummary | null = null;
  let keyEnded = false;
  const endKey = (): void => {
    if (key === undefined || keyEnded) return;
    keyEnded = true;
    const s = summary as TurnSummary | null;
    const r = sealed as SealedTurn | null;
    keepKey(root, { key, surface: i.surface, at: new Date().toISOString(), state: 'ended', ...(s ? { sent: s.sent, status: s.result } : {}), ...(r ? { receipt: r.hash } : {}) });
  };
  // R5 lead (the operator's 22:32 order, items 1 and 2): the turn's identity (its hold's id) is sealed on its receipt
  // (turn_id), so every surface tells this turn's end from another's by identity; and a stop any surface asks of it
  // (requestTurnStop) stops it here as this surface's own Esc or Ctrl+C would, its receipt naming who asked (stopped_by)
  const turnId = taken.hold.id;
  // R10 (H169): the turn's route, snapshotted now (a model chosen while the turn runs changes only the next turn)
  const route = i.route === undefined ? routeOfAgent(i.agent) : i.route;
  if (route) {
    const conv = (() => { try { const c = (i.agent as KeepsConversation).keptConversation?.(); return c?.current ? path.relative(root, path.join(c.directory, `${c.current}.jsonl`)).split(path.sep).join('/') : null; } catch { return null; } })();
    keepRoute(root, { schema: TURN_ROUTE_SCHEMA, turn: turnId, surface: i.surface, state: 'started', at: new Date().toISOString(), route, log: { where: 'this computer', conversation: conv && !conv.startsWith('..') ? conv : null, record: `${CHAT_TURNS_DIR}/${ROUTES_FILE}` } });
  }
  let routeEnded = false;
  let observed: ReturnType<typeof turnConnection> = null;
  const endRoute = (): void => {
    if (!route || routeEnded) return;
    routeEnded = true;
    const s = summary as TurnSummary | null;
    const a = i.agent as { lastFallback?: () => { model: string; host: string } | null; lastLocalTurn?: () => { actualModel?: string } | null; lastReturnedModel?: () => string | null };
    const fb = (() => { try { return a.lastFallback?.() ?? null; } catch { return null; } })();
    const returned = (() => {
      try {
        if (i.returned) return i.returned();
        if (fb) return `ollama/${fb.model}`;
        if (route.source === 'ollama-local') return a.lastLocalTurn?.()?.actualModel || undefined;
        return a.lastReturnedModel?.() ?? undefined;
      } catch { return undefined; }
    })();
    observed = s ? turnConnection(route, s, Boolean(fb)) : null;
    keepRoute(root, {
      schema: TURN_ROUTE_SCHEMA, turn: turnId, surface: i.surface, state: 'ended', at: new Date().toISOString(),
      ...(s ? { status: s.result, sent: s.sent } : {}), ...(returned ? { returned } : {}), ...(fb ? { fallback: { model: fb.model, host: fb.host } } : {}),
      ...(observed ? { connection: observed.answer === 'accepted' ? 'answered' as const : 'did not answer' as const } : {}),
    });
  };
  let stoppedBy: ChatSurface | null | undefined;
  const asked = new AbortController();
  const signal = i.signal ? AbortSignal.any([i.signal, asked.signal]) : asked.signal;
  const watch = watchTurnStop(root, turnId, (by) => { stoppedBy = by; asked.abort(); });
  const own = (facts: TurnFacts): TurnFacts => ({ ...facts, turnId, ...(stoppedBy !== undefined && facts.status === 'cancelled' ? { stoppedBy: stoppedBy ?? 'unknown' } : {}) });
  try {
    const continued = continueConversation(i.agent, root);
    i.onContinue?.(continued);
    const seal = i.seal ? (facts: TurnFacts): SealedTurn => { sealed = i.seal!({ ...own(facts), surface: i.surface }); return sealed; } : undefined;
    // the hold is given back once the turn has ended and is sealed (its summary), the key's end kept first, before the REPL's
    // inspector looks for where to inspect it: the conversation is whole by then. A surface that seals after the turn (the
    // chat session) gets the facts with the turn's id in them.
    const more: TurnInspect = {
      ...i.more,
      summary: (s) => { summary = s; if (s.facts) s.facts = own(s.facts); endKey(); endRoute(); watch.close(); taken.hold.release(); i.more?.summary?.(s); },
      // who asked this turn to stop, when another surface did: the cancel line names them (src/repl/transcript.ts)
      stoppedBy: () => (stoppedBy === undefined ? undefined : stoppedBy === null ? 'another surface' : surfaceWords(stoppedBy)),
    };
    const status = await runTurn(i.agent, i.sink as Transcript, i.text, i.clock, i.marks, signal, seal, i.abandon, more);
    // R10 (H169; pass 2c's R2 and R4): what the turn saw of its route's connection is the connection's newest observation (the
    // frame's row, src/ops/workspace-frame.ts): an answer, or a connection that did not answer (it ends "live")
    endRoute();
    const seen = observed as ReturnType<typeof turnConnection>;
    // kept after the turn has ended, without holding its answer back (the frame's module may load the first time)
    if (seen && route) noting = noting.then(() => noteObserved(seen, route));
    return { status, continued };
  } finally {
    // a turn that ended without its summary (abandoned, or thrown): its end kept, whether it sent not recorded
    endKey();
    endRoute();
    watch.close();
    taken.hold.release();
  }
}
