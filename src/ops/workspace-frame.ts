/**
 * R5 lead (2026-10-15): the one producer of the workspace frame (src/contracts/workspace.ts) that the terminal Workbench, the
 * browser companion and Timmy Studio draw around their own content. Reads only, and never the network: the connections are
 * what Timmy last observed, from the record `checkConnections` writes (`timmy workspace check`). A connection is `live` only
 * when a request it answered was observed within LIVE_FOR_MS; an older answer says how old it is and is `configured`; a
 * setting with no answer ever is `configured` too, never live (DESIGN.md §10 B10).
 *
 * The actions are the tab's real commands, the REPL's or `timmy`'s, the same on every surface; at most one per tab is the
 * primary next step, chosen from what the records say (no chat route yet, something waits on you, nothing has run). What no
 * record says goes to `unknown` with why.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OllamaProbe } from '../capabilities/ollama-row.js';
import {
  TABS, WORKSPACE_SCHEMA, WORKSPACE_VERSION,
  type ConnectionId, type LogTone, type TabId, type WorkspaceAction, type WorkspaceConnection, type WorkspaceFrame, type WorkspaceLogEntry, type WorkspaceTurn,
} from '../contracts/workspace.js';
import { timmyHome } from '../setup/home.js';
import { readSettings as readWorkbenchSettings } from '../workbench/settings.js';
import { chainOf, readTurns, workbenchJson, type StateDeps, type WorkbenchJson } from '../workbench/state.js';
import type { TurnRow } from '../workbench/model.js';
import { took } from '../workbench/text.js';
import { modelKeyFingerprint, modelKeySource } from '../utils/model-key.js';
import { edgeUrlOrNull } from '../utils/edge-host.js';
import { readSettings as readDecisionSettings } from '../decision/settings.js';
import { cloudroomConfigPath } from '../fleet/cloudroom/config.js';
import { studioBaseUrl } from '../studio/config.js';
import { freeOnlyOn } from '../agent/model-price.js';
import { askedCompanionPort } from '../setup/companion-port.js';
import { runningTurns, surfaceWords, type OtherTurn } from '../agent/chat-turn.js';
import type { ChatSurface } from '../contracts/chat-session.js';
import { turnEndWords } from '../contracts/stop-words.js';
import { ollamaAddress, ollamaStartStep } from '../capabilities/ollama-route.js';
import { onPath as onPathNow } from '../utils/on-path.js';
import { THIS_PROCESS, withProcessTable, writerState } from './process-proof.js';

type Env = Record<string, string | undefined>;

/** Where the companion is asked to listen (TIMMY_COMPANION_PORT, else 3001); a busy port makes it take another, which it says. */
export const companionBaseUrl = (env: Env = process.env): string => {
  let port = 3001;
  try { port = askedCompanionPort([], env); } catch { /* the default */ }
  return `http://127.0.0.1:${port}/`;
};

/** An answered request counts as live for this long; after it, the frame says how old the answer is. */
export const LIVE_FOR_MS = 30 * 60_000;
/** R6 (H140): that bound, in a card's words. */
export const LIVE_FOR_WORDS = 'an answer within the last 30 min';
export const CONNECTIONS_SCHEMA = 'timmy.connections/1' as const;
/** How many log lines the frame carries, the newest first. */
export const LOG_MAX = 30;

/** One observation: what a request was answered with, and when. */
export interface ConnectionCheck {
  /**
   * accepted: the service answered and took the request; refused: it answered no (a rejected key); no answer: nothing came
   * back, or something else answered; not running: a local surface Timmy starts on demand (Studio, the companion) refused
   * the connection, so it is simply not started. R6 (H140): listening: a local surface noted that it started listening,
   * which is no answer (nothing has asked it yet)
   */
  answer: 'accepted' | 'refused' | 'no answer' | 'not running' | 'not asked' | 'listening';
  /**
   * R6 (H140): the process that noted it, for a local surface's own note (noteAnswered, noteListening): its pid and when it
   * started (src/ops/process-proof.ts writerState), so a server killed before it could note its stop is seen gone at once
   */
  pid?: number;
  started?: string;
  at: string;
  /** words worth keeping: "3 models", "HTTP 200", "studio running, page connected" */
  detail?: string;
  /**
   * R5 lead (the QA round, defect 3; the operator's 22:32 order, item 1): what was asked, as it was set up then: the address
   * (Ollama's, the companion's, Studio's, the edge's) or, for OpenRouter, the key's fingerprint ("key <12 hex>", never the
   * key). A check of another address or key than the one set up now says nothing about it (forNow).
   */
  asked?: string;
}

export interface ConnectionsRecord {
  schema: typeof CONNECTIONS_SCHEMA;
  checks: Partial<Record<ConnectionId, ConnectionCheck>>;
}

export const connectionsPath = (env: Env = process.env): string => join(timmyHome(env), 'state', 'connections.json');

/** The last observations, or none when there is no readable record. */
export function readConnections(env: Env = process.env): ConnectionsRecord {
  try {
    const raw = JSON.parse(readFileSync(connectionsPath(env), 'utf8')) as ConnectionsRecord;
    if (raw?.schema === CONNECTIONS_SCHEMA && raw.checks && typeof raw.checks === 'object') return raw;
  } catch { /* none yet, or unreadable: nothing observed */ }
  return { schema: CONNECTIONS_SCHEMA, checks: {} };
}

/** Writes the observations atomically, mode 0600 (it names services, never a key). */
export function writeConnections(rec: ConnectionsRecord, env: Env = process.env): string {
  const file = connectionsPath(env);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, `${JSON.stringify(rec, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  return file;
}

/** The address a local surface is asked at (the frame's card names it): Studio's, the companion's. */
const surfaceAddress = (id: 'studio' | 'companion', env: Env): string => (id === 'studio' ? studioBaseUrl(env) : companionBaseUrl(env)).replace(/\/+$/, '');

/**
 * R5 lead (the operator's 22:32 order, item 1): an observation counts only for what it asked, as it is set up now (the
 * address, or the key's fingerprint): one that names another (asked before the setup changed) is no observation of this,
 * and the card says so. A record from before observations named what they asked counts as it did.
 */
function forNow(c: ConnectionCheck | undefined, now: string | null): { check?: ConnectionCheck; other?: string } {
  if (!c) return {};
  if (c.asked && now !== null && c.asked.replace(/\/+$/, '') !== now.replace(/\/+$/, '')) return { other: c.asked.replace(/\/+$/, '') };
  return { check: c };
}

/**
 * R6 (H140; the R5 interaction review, claim c: the companion's card stayed "● live · answered just now" for 2.5 min after the
 * Workbench that served it quit): a local surface Timmy starts on demand (the companion, Studio) is live only while it answers,
 * an answer observed within this bound (the card says so), and only while the process that noted it runs.
 */
export const SURFACE_LIVE_MS = 60_000;
/** R6 (H140): the bound in the cards' words. */
export const SURFACE_LIVE_WORDS = 'an answer within the last 60 s';
/** R5 lead: how often a surface that answers its own page notes it (noteAnswered). R6 (H140): well inside SURFACE_LIVE_MS. */
export const SELF_NOTE_MS = 20_000;
/** R6 (H140): the words a surface's start note gives (src/companion/server.ts, src/studio/server.ts): a start is no answer. */
export const STARTED_LISTENING = 'it started listening';

/** R6 (H140): this process, as a surface's own note names it (its pid and start: src/ops/process-proof.ts). */
const noter = (): { pid: number; started: string } => ({ pid: THIS_PROCESS.pid, started: THIS_PROCESS.started });

/**
 * R5 lead (H133's note: Studio's own page showed "Open Studio" as its next step until a `timmy workspace check` had seen
 * Studio): a local surface that just answered a request records that answer, as a check made then would have seen it. At
 * most once in SELF_NOTE_MS, so a page asking every few seconds writes little; true when it wrote. A record that cannot be
 * written leaves the frame as the last check left it (nothing is said that was not observed).
 *
 * R6 (H140): the note names the process that answered (pid and start), so the frame sees that process gone at once when it
 * was killed before it could note its stop; and a start ("it started listening") is no answer: it is noted as listening
 * (noteListening), never as accepted.
 */
export function noteAnswered(id: 'studio' | 'companion', detail: string, env: Env = process.env, now = Date.now()): boolean {
  if (detail === STARTED_LISTENING) return noteListening(id, env, now);
  try {
    const rec = readConnections(env);
    const last = rec.checks[id];
    const asked = surfaceAddress(id, env);
    const me = noter();
    const mine = last?.pid === me.pid && last?.started === me.started;
    if (last?.answer === 'accepted' && mine && (last.asked ?? asked) === asked && now - Date.parse(last.at) < SELF_NOTE_MS) return false;
    writeConnections({ ...rec, checks: { ...rec.checks, [id]: { answer: 'accepted', at: new Date(now).toISOString(), detail, asked, ...me } } }, env);
    return true;
  } catch {
    return false;
  }
}

/**
 * R6 (H140): a local surface that started listening records it, naming its process: the frame says it listens (not live: no
 * answer is seen yet) while that process runs, and not running once it does not. A record that cannot be written changes nothing.
 */
export function noteListening(id: 'studio' | 'companion', env: Env = process.env, now = Date.now()): boolean {
  try {
    const rec = readConnections(env);
    writeConnections({ ...rec, checks: { ...rec.checks, [id]: { answer: 'listening', at: new Date(now).toISOString(), detail: STARTED_LISTENING, asked: surfaceAddress(id, env), ...noter() } } }, env);
    return true;
  } catch {
    return false;
  }
}

/**
 * R5 lead (the QA round, defect 19): a local surface that stops records it, as a check made then would see it (refused,
 * so not running), so no surface goes on saying it answered after it ended. A record that cannot be written changes nothing.
 */
export function noteStopped(id: 'studio' | 'companion', env: Env = process.env, now = Date.now()): boolean {
  try {
    const rec = readConnections(env);
    writeConnections({ ...rec, checks: { ...rec.checks, [id]: { answer: 'not running', at: new Date(now).toISOString(), detail: 'it stopped', asked: surfaceAddress(id, env) } } }, env);
    return true;
  } catch {
    return false;
  }
}

/**
 * How long ago, in words that change at most once a minute (R5 lead, H132's note: words in seconds changed the frame's
 * revision every second, so a revision check went stale by itself): "just now", then minutes, hours, days. The exact time is the connection's observedAt.
 */
const ago = (at: string, now: number): string => {
  const s = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
};

/** A connection's state from its setting and its last observation (pure: the frame's tests drive it with FAKE checks). */
export function connectionOf(
  id: ConnectionId, label: string,
  o: { configured: boolean; setupWords: string; setup: string | null; check?: ConnectionCheck; now: number; detail?: string; notConfiguredState?: WorkspaceConnection['state']; startWords?: string },
): WorkspaceConnection {
  const base = { id, label, setup: o.setup, ...(o.detail ? { detail: o.detail } : {}) };
  const c = o.check;
  if (c && Number.isFinite(Date.parse(c.at))) {
    const fresh = o.now - Date.parse(c.at) <= LIVE_FOR_MS;
    const said = c.detail ? ` (${c.detail})` : '';
    if (c.answer === 'refused') return { ...base, state: 'refused', words: `refused when checked ${ago(c.at, o.now)}${said}`, observedAt: c.at };
    // a surface Timmy starts on demand that is not started is not a failure: it is set up, and says how to start it
    if (c.answer === 'not running') return { ...base, state: 'configured', words: `not running when checked ${ago(c.at, o.now)}${o.startWords ? `; ${o.startWords}` : ''}`, observedAt: c.at };
    if (c.answer === 'no answer') {
      // an optional service nobody chose: nothing answering is not a failure either; it is not set up, with its step
      if (!o.configured) return { ...base, state: o.notConfiguredState ?? 'not set up', words: `nothing answered when checked ${ago(c.at, o.now)}${said}; ${o.setupWords}`, observedAt: c.at };
      return { ...base, state: 'unreachable', words: `no answer when checked ${ago(c.at, o.now)}${said}`, observedAt: c.at };
    }
    if (c.answer === 'accepted') {
      // R6 (H140): the bound is said beside the answer, so "live" says how current it has to be
      return fresh
        ? { ...base, state: 'live', words: `answered ${ago(c.at, o.now)}${said}; live: ${LIVE_FOR_WORDS}`, observedAt: c.at }
        : { ...base, state: o.configured ? 'configured' : 'unknown', words: `answered ${ago(c.at, o.now)}${said}; check again to see it now`, observedAt: c.at };
    }
  }
  if (!o.configured) return { ...base, state: o.notConfiguredState ?? 'not set up', words: o.setupWords, observedAt: null };
  return { ...base, state: 'configured', words: 'set up, not checked yet (a setting is not a connection)', observedAt: null };
}

/** R6 (H140): whether the process a surface's note names runs now (src/ops/process-proof.ts writerState); a test's seam. */
export type ProcessAlive = (owner: { pid?: unknown; started?: unknown }) => 'alive' | 'gone' | 'unknown';

/**
 * R6 (H140; the R5 interaction review, claim c, and REMAINING-DEFECTS #4, #33): a local surface Timmy starts on demand (the
 * companion, Studio), from its last observation. It is `live` (green) only while a current observation says it answered at
 * the address the frame names: an answer (its own page's request, or `timmy workspace check`) seen within SURFACE_LIVE_MS,
 * by a process that still runs. A start record is no answer: listening, it is `configured` and says nothing has asked it. A
 * process gone without noting its stop (killed) is seen at once by its pid: not running, with what it last did. An answer
 * older than the bound is `configured`, says how old, and names the check that asks it now.
 */
export function surfaceConnectionOf(
  id: 'companion' | 'studio', label: string,
  o: { check?: ConnectionCheck; now: number; setup: string | null; startWords: string; detail?: string; alive?: ProcessAlive },
): WorkspaceConnection {
  return surfaceReading(id, label, o).connection;
}

/** R6 (H140): what a local surface's last observation says of it now: its card, and whether it runs (`surfaces` in the frame). */
type SurfaceNow = 'live' | 'listening' | 'not live' | 'gone' | 'not running' | 'no answer' | 'refused' | 'not checked';

function surfaceReading(
  id: 'companion' | 'studio', label: string,
  o: { check?: ConnectionCheck; now: number; setup: string | null; startWords: string; detail?: string; alive?: ProcessAlive },
): { connection: WorkspaceConnection; now: SurfaceNow } {
  const base = { id, label, setup: o.setup, ...(o.detail ? { detail: o.detail } : {}) };
  const c = o.check;
  const out = (now: SurfaceNow, state: WorkspaceConnection['state'], words: string, observedAt: string | null) => ({ now, connection: { ...base, state, words, observedAt } });
  if (!c || !Number.isFinite(Date.parse(c.at)) || c.answer === 'not asked') return out('not checked', 'configured', 'set up, not checked yet (a setting is not a connection)', null);
  const when = ago(c.at, o.now);
  const said = c.detail ? ` (${c.detail})` : '';
  if (c.answer === 'refused') return out('refused', 'refused', `refused when checked ${when}${said}`, c.at);
  if (c.answer === 'not running') return out('not running', 'configured', `not running when checked ${when}; ${o.startWords}`, c.at);
  if (c.answer === 'no answer') return out('no answer', 'unreachable', `no answer when checked ${when}${said}`, c.at);
  // Studio's card says what answered: its canvas server (an answer says nothing of whether anyone opened Studio)
  const who = id === 'studio' ? 'its canvas server ' : '';
  // a note of its own names its process (a check names none): answered then, or listening since it started
  const own = c.pid !== undefined;
  // the process that noted it, gone (killed before it could note its stop): said at once, whatever the time
  if (own && (o.alive ?? writerState)({ pid: c.pid, started: c.started }) === 'gone') {
    const last = c.answer === 'listening' ? `${who || 'it '}started listening ${when} and nothing had asked it` : `${who || 'it '}last answered ${when}${said}`;
    return out('gone', 'configured', `not running: the process that served it ended without noting its stop; ${last}; ${o.startWords}`, c.at);
  }
  if (c.answer === 'listening') {
    return out('listening', 'configured', `${who ? `${who}is ` : ''}listening, since it started ${when}; nothing has asked it since, so not live: a page, or timmy workspace check, asks it`, c.at);
  }
  if (o.now - Date.parse(c.at) <= SURFACE_LIVE_MS) return out('live', 'live', `${who}answered ${when}${said}; live: ${SURFACE_LIVE_WORDS}`, c.at);
  return out('not live', 'configured', `${who}last answered ${when}${said}; not live: no answer in the last 60 s (timmy workspace check asks it now)`, c.at);
}

/**
 * R5 lead (H131's finding): the Ollama address the check asks and the card names: the one the local chat asks (the setup's
 * record, src/agent/chat-route.ts resolveChatRoute) when the chat is set to the local model, else OLLAMA_HOST (or
 * OLLAMA_BASE_URL), else Ollama's default. Before, the card and the check asked OLLAMA_HOST or the default while the chat
 * asked the recorded address, so a chat answering at its own address could be said "no answer". R6 (H140): one function for
 * /tools and the frame alike (src/capabilities/ollama-route.ts), so /tools asks that address too.
 */
export { ollamaAddress };

function connectionsOf(env: Env, cwd: string, wb: WorkbenchJson, now: number, unknown: WorkspaceFrame['unknown'], alive?: ProcessAlive, surfaces: Partial<Record<'companion' | 'studio', SurfaceNow>> = {}): WorkspaceConnection[] {
  const checks = readConnections(env).checks;
  const out: WorkspaceConnection[] = [];
  const key = (() => { try { return modelKeySource(env, cwd); } catch { return null; } })();
  const keyNow = key ? (() => { try { return modelKeyFingerprint(env, cwd); } catch { return null; } })() : null;
  const or = forNow(checks.openrouter, keyNow);
  out.push(connectionOf('openrouter', 'OpenRouter (cloud chat)', {
    configured: key !== null, setupWords: 'no key: timmy init --chat openrouter asks for it (typed hidden), or set OPENROUTER_API_KEY', setup: key ? 'timmy workspace check' : 'timmy init --chat openrouter',
    check: or.check, now, ...(key ? { detail: `key from ${key}${freeOnlyOn(env) ? '; free-only on (a model not known to be free is refused)' : ''}${or.other ? '; not checked with this key yet (the last check asked with another key)' : ''}` } : {}),
  }));
  const ollamaBase = ollamaAddress(env);
  // set up when the chat route is the local model, or when an address for it is set; otherwise it is optional
  const ollamaChosen = wb.route.kind === 'local' || Boolean(env.OLLAMA_HOST || env.OLLAMA_BASE_URL);
  // R5 lead (the QA round, defect 3): a check that asked another address (before the setup changed it) is not this one's
  const ol = forNow(checks.ollama, ollamaBase);
  out.push(connectionOf('ollama', 'Ollama (local models)', {
    configured: ollamaChosen, setupWords: 'optional: run Ollama with a model pulled, then timmy init --chat local --model <name> chooses it for chat',
    setup: ollamaChosen ? 'timmy workspace check' : 'timmy init --chat local --model <name>', check: ol.check, now,
    detail: `asked at ${ollamaBase.replace(/\/+$/, '')}, no charge (local)${ol.other ? `; not checked at this address yet (the last check asked ${ol.other})` : ''}`,
  }));
  const edge = (() => { try { return edgeUrlOrNull(); } catch { return null; } })();
  const cf = forNow(checks.cloudflare, edge);
  out.push(connectionOf('cloudflare', 'Cloudflare edge (optional)', {
    configured: edge !== null, setupWords: 'not set up (optional; it is not the chat provider)', setup: null, check: cf.check, now,
    ...(cf.other ? { detail: `not checked at this address yet (the last check asked ${cf.other})` } : {}),
  }));
  const clef = (() => { try { return readDecisionSettings(env); } catch { return null; } })();
  const clefOn = clef?.settings?.useClef === true;
  out.push({
    id: 'clef', label: 'Clef-Omni (decision recommender)', state: clefOn ? 'configured' : 'not set up', observedAt: null, setup: 'timmy decide mode',
    words: clefOn ? 'Use Clef routing is on; no live call is authorized, so it is not checked here' : 'Use Clef routing is off (the default): routes stay deterministic',
  });
  const cloudroom = existsSync(cloudroomConfigPath(timmyHome(env)));
  out.push({
    id: 'cloudroom', label: 'Cloudroom Core (fleet backend)', state: cloudroom ? 'configured' : 'not set up', observedAt: null,
    setup: cloudroom ? 'timmy fleet providers' : 'timmy fleet connect cloudroom <url> --token-file <file>',
    words: cloudroom ? 'a Core is recorded; not checked here (no live call is authorized)' : 'no Core connected; the FAKE backend is the simulation',
  });
  const wbSet = readWorkbenchSettings(env).settings;
  // R6 (H140): the companion and Studio are live only while they answer (surfaceConnectionOf: a bound, and the process that
  // noted the answer still running), at the address the frame names (forNow)
  const cp = forNow(checks.companion, surfaceAddress('companion', env));
  const companion = surfaceReading('companion', 'Browser companion', {
    setup: 'timmy watch', check: cp.check, now, startWords: 'c in the Workbench, or timmy watch, starts it', ...(alive ? { alive } : {}),
    detail: `at ${companionBaseUrl(env)}; ${wbSet.openCompanionAtStart ? 'opens with the workspace' : 'opens when asked'}${cp.other ? `; not checked at this address yet (the last check asked ${cp.other})` : ''}`,
  });
  out.push(companion.connection);
  surfaces.companion = companion.now;
  const st = forNow(checks.studio, surfaceAddress('studio', env));
  const studio = surfaceReading('studio', 'Timmy Studio (tldraw)', {
    setup: 'timmy studio', check: st.check, now, startWords: 's in the Workbench, or timmy studio, starts it', ...(alive ? { alive } : {}),
    detail: `at ${studioBaseUrl(env)}; ${wbSet.openStudioAtStart ? 'opens with the workspace' : 'opens when asked'}${st.other ? `; not checked at this address yet (the last check asked ${st.other})` : ''}`,
  });
  out.push(studio.connection);
  surfaces.studio = studio.now;
  for (const [id, label, cmd] of [['mcp-sdk', 'MCP to CLI: the SDK route', '/mcp call --route sdk <tool> {json} -- <server command>'], ['mcporter', 'MCP to CLI: the mcporter route', '/mcp call --route mcporter <tool> {json} -- <server command>']] as const) {
    out.push({ id, label, state: 'unknown', observedAt: null, setup: cmd, words: 'used by a call when you make one; this computer keeps no check of it yet' });
  }
  if (!wb.route.ready) unknown.push({ field: 'chat', why: chatNotReady(wb.route) });
  return out;
}

/** Lines said as one paragraph: each ends as a sentence (a line with no closing mark gets a full stop), so none runs on. */
export const sentences = (lines: readonly string[]): string => lines.map((l) => l.trim()).filter(Boolean).map((l) => (/[.!?:)]$/.test(l) ? l : `${l}.`)).join(' ');

/**
 * R5 lead (H131's note): why chat is not ready, said as a state. A route's refusal is a message's ("so this message was not
 * sent", "Nothing was sent to any model"), and a frame is no message. With no route at all, the frame's one step, the same
 * as Home's first action (timmy init); otherwise the route's own cause and fix (a local model not answering, free-only).
 * R5 lead (H131's finding): `timmy setup` scaffolds a governed folder and asks nothing; `timmy init` is the setup's questions.
 */
export function chatNotReady(r: Pick<WorkbenchJson['route'], 'kind' | 'refusal'>): string {
  if (r.kind === 'none') return 'No chat route yet: no OpenRouter key, and the chat is not set to a local model. timmy init --chat openrouter asks for a key (typed hidden); timmy init --chat local --model <name> uses a model your Ollama lists.';
  const lines = (r.refusal ?? [])
    .filter((l) => !/^\s*Nothing was sent to any model\.?\s*$/i.test(l))
    .map((l) => l.replace(/,?\s*so this message was not sent/i, '').replace(/^\s*Error:\s*/, ''))
    .map((l) => l.charAt(0).toUpperCase() + l.slice(1));
  return sentences(lines) || 'The chat route is not ready.';
}

/**
 * R5 lead (the operator's finish line, item 3): the one fix for a chat that cannot answer, specific to what is wrong. Each
 * names a command a surface can carry out or show: `timmy init --chat openrouter` asks for a key hidden (never typed into a tab),
 * `/model` chooses the local model among those Ollama lists, `/model free` chooses a free model while free-only stays on
 * (turning free-only off is never the fix offered), `timmy workspace check` asks again once Ollama runs.
 */
export type ChatProblem = 'no-route' | 'no-local-model' | 'ollama-address' | 'ollama-unreachable' | 'free-only' | 'key-refused';
export interface ChatFix { problem: ChatProblem; label: string; command: string; effect: WorkspaceAction['effect']; words: string }

export function chatFix(route: Pick<WorkbenchJson['route'], 'kind' | 'ready' | 'refusal'>, conns: readonly (Pick<WorkspaceConnection, 'id' | 'state' | 'words'> & { observedAt?: string | null })[] = [], recentTurns: readonly Pick<TurnRow, 'state' | 'at' | 'local'>[] = [], o: { start?: string } = {}): ChatFix | null {
  // R6 (H140): how Ollama is started here (src/capabilities/ollama-route.ts ollamaStartStep: `ollama serve` with its program,
  // else this platform's install); `ollama serve` when the caller does not say
  const start = o.start ?? 'ollama serve';
  // R5 lead (the rehearsal): the project's newest chat turn on that route that ended by itself (answered or failed; a stopped
  // turn says nothing about the route) is a newer observation than an older check: answered after the check, no fix is
  // offered for the failure the check saw (the connection keeps the check's own words and time); failed, the check stands.
  // A turn's receipt names its Ollama endpoint (TurnRow.local true or false) on the Ollama route and none on OpenRouter's,
  // recentTurns come newest first, and a check with no time is never outdated by a turn.
  const answeredSince = (c: { observedAt?: string | null } | undefined, via: 'ollama' | 'openrouter') => {
    const t = recentTurns.find((x) => x.state !== 'stopped' && (via === 'ollama' ? x.local !== undefined : x.local === undefined));
    return Boolean(t && t.state === 'answered' && c?.observedAt && Date.parse(t.at) > Date.parse(c.observedAt));
  };
  const first = (route.refusal ?? [])[0] ?? '';
  const conn = (id: string) => conns.find((c) => c.id === id);
  if (route.kind === 'none') {
    return { problem: 'no-route', label: 'Set up chat: an OpenRouter key (asked hidden) or a local model', command: 'timmy init --chat openrouter', effect: 'local change', words: chatNotReady(route) };
  }
  if (route.kind === 'local' && !route.ready) {
    if (/no model is chosen/i.test(first)) {
      // R5 lead (the QA round, defect 3): the models to choose from are what Ollama lists, so while the last check found
      // nothing answering at the address the chat asks, starting Ollama comes first (choosing one would list nothing)
      const ol = conn('ollama');
      if (ol && (ol.state === 'unreachable' || ol.state === 'refused') && !answeredSince(ol, 'ollama')) {
        return { problem: 'ollama-unreachable', label: 'Start Ollama, then check again (no charge)', command: 'timmy workspace check', effect: 'network', words: `Ollama: ${ol.words}. No local model is chosen, and the models to choose from are what Ollama lists: start it (${start}), check again, then choose one with /model.` };
      }
      return { problem: 'no-local-model', label: 'Choose the local model (from what Ollama lists)', command: '/model', effect: 'local change', words: chatNotReady(route) };
    }
    return { problem: 'ollama-address', label: 'Set the Ollama address the chat uses', command: '/setup chat', effect: 'local change', words: chatNotReady(route) };
  }
  if (route.kind === 'local' && route.ready) {
    const ol = conn('ollama');
    if (ol && (ol.state === 'unreachable' || ol.state === 'refused') && !answeredSince(ol, 'ollama')) {
      return { problem: 'ollama-unreachable', label: 'Start Ollama, then check again (no charge)', command: 'timmy workspace check', effect: 'network', words: `Ollama: ${ol.words}. Start it (${start}), then check again.` };
    }
    return null;
  }
  if (route.kind === 'openrouter' && !route.ready) {
    return { problem: 'free-only', label: 'Choose a free model (free-only stays on)', command: '/model free', effect: 'local change', words: chatNotReady(route) };
  }
  if (route.kind === 'openrouter' && route.ready) {
    const k = conn('openrouter');
    // R5 lead (H131's finding): with a key stored, `timmy init --chat openrouter` asks nothing and keeps the refused key;
    // `timmy init --openrouter -` replaces it (read hidden at a terminal), as the REPL's /setup key does
    if (k?.state === 'refused' && !answeredSince(k, 'openrouter')) return { problem: 'key-refused', label: 'Give a working OpenRouter key (read hidden)', command: 'timmy init --openrouter -', effect: 'local change', words: `OpenRouter: ${k.words}. timmy init --openrouter - reads a new key hidden at a terminal (or /setup key in the REPL); a key set in OPENROUTER_API_KEY or timmy-tui.config.json is used before the stored one.` };
  }
  return null;
}

/**
 * R5 lead (the QA round, defect 9): where a chat turn being answered is stopped, by the surface that sent it: Esc in the
 * Workbench's or the monitor's composer, Ctrl+C in the REPL (it has no composer), Stop on the companion page that sent it.
 */
export const turnStopWords = (s: ChatSurface): string => (s === 'repl' ? 'Ctrl+C in the REPL' : s === 'companion' ? 'Stop on the page that sent it' : 'Esc in its composer');
/** The same, as the chat tab's "Stop the turn" command (the Workbench reads "Esc in the composer" as its own Esc). */
export const turnStopCommand = (s: ChatSurface): string => (s === 'repl' ? 'Ctrl+C in the REPL that sent it' : s === 'companion' ? 'Stop on the companion page that sent it' : `Esc in the composer that sent it (${surfaceWords(s)})`);

const act = (n: number, label: string, command: string, o: Partial<Pick<WorkspaceAction, 'primary' | 'enabled' | 'why' | 'effect'>> = {}): WorkspaceAction => ({
  n, label, command, primary: o.primary ?? false, enabled: o.enabled ?? true, effect: o.effect ?? 'read', ...(o.why ? { why: o.why } : {}),
});

/** Each tab's actions. Only commands that exist (the REPL's registry, `timmy`'s verbs); the primary one comes from the records. */
export function actionsOf(wb: WorkbenchJson, turns: readonly Pick<OtherTurn, 'surface'>[] = [], o: { studioRunning?: boolean; connections?: readonly (Pick<WorkspaceConnection, 'id' | 'state' | 'words'> & { observedAt?: string | null })[]; recentTurns?: readonly Pick<TurnRow, 'state' | 'at' | 'local'>[]; ollamaStart?: string } = {}): Record<TabId, WorkspaceAction[]> {
  const waiting = wb.activity.waiting_on_you;
  const running = wb.activity.running;
  const routeReady = wb.route.ready;
  const stop = wb.activity.stop_current;
  const firstBlock = wb.workflows.docs.flatMap((d) => d.blocks.map((b) => ({ doc: d.rel, block: b.name })))[0];
  const lastOp = wb.jobs.find((j) => j.operation)?.operation ?? null;
  // R5 lead (the finish line, item 3): what keeps chat from answering, and its own fix (null: nothing known to be wrong)
  const fix = chatFix(wb.route, o.connections ?? [], o.recentTurns ?? [], o.ollamaStart ? { start: o.ollamaStart } : {});
  const homeNext: WorkspaceAction = fix
    ? act(1, fix.label, fix.command, { primary: true, effect: fix.effect })
    : waiting > 0
      ? act(1, `Answer what waits on you (${waiting})`, '/room', { primary: true })
      : act(1, 'Continue in Chat', '2', { primary: true });
  return {
    home: [
      homeNext,
      act(2, 'Check connections (free requests)', 'timmy workspace check', { effect: 'network' }),
      act(3, 'New project', '/project new <name>', { effect: 'local change' }),
      act(4, 'Switch project', '/project <name>'),
    ],
    // R5 lead (the independent review, defect 1): a turn being answered is running; Stop the turn is the next step then, and a
    // second message waits (one turn at a time per project)
    chat: [
      turns.length
        ? act(1, 'Send a message', 'type in Chat, then Enter', { enabled: false, effect: 'network', why: `one turn at a time: a turn is being answered in ${surfaceWords(turns[0].surface as Parameters<typeof surfaceWords>[0])}` })
        : act(1, 'Send a message', 'type in Chat, then Enter', { primary: routeReady && !fix, enabled: routeReady, effect: 'network', ...(routeReady ? {} : { why: fix ? `${fix.label.charAt(0).toLowerCase()}${fix.label.slice(1)}: ${fix.command}` : 'no chat route: timmy init --chat openrouter' }) }),
      fix && !turns.length ? act(2, fix.label, fix.command, { primary: true, effect: fix.effect }) : act(2, 'Choose the model', '/model'),
      turns.length
        ? act(3, 'Stop the turn', turnStopCommand(turns[0].surface as ChatSurface), { primary: true })
        : act(3, 'Stop the turn', 'Esc in the composer', { enabled: false, why: 'only while a turn runs' }),
      act(4, 'Show it in the companion', 'timmy watch'),
    ],
    workflows: [
      firstBlock
        ? act(1, `Run ${firstBlock.doc} › ${firstBlock.block}`, `/run ${firstBlock.doc} ${firstBlock.block}`, { primary: waiting === 0 && running === 0, effect: 'local change' })
        : act(1, 'Start a workflow document', '/workflows', { primary: running === 0 }),
      // R5 lead (H131's report): "needs you" has one meaning on a screen, what waits on a person now (the activity's count);
      // a block that asks first says so on its own row of the Workflows list, not in this count
      waiting > 0
        ? act(2, `Answer what waits on you (${waiting})`, '/room', { primary: running === 0 })
        : act(2, 'Review the last run', lastOp ? `/op ${lastOp}` : '/ops'),
      act(3, 'Stop current', '/stop', { enabled: stop.job !== null, ...(stop.job ? {} : { why: 'nothing runs' }) }),
      act(4, 'Receipts of this project', '/receipts'),
    ],
    // R5 lead: with Studio running, the next step is to have Timmy draw on it (a REPL holds the canvas: /canvas open)
    studio: [
      o.studioRunning
        ? act(1, 'Ask Timmy to draw: /canvas open in the REPL, then ask', '/canvas open', { primary: true, effect: 'local change' })
        : act(1, 'Open Studio', '/studio', { primary: true, effect: 'local change' }),
      act(2, 'Where Studio is, and its state', '/canvas'),
      act(3, 'Start a project from a public starter', '/project new <name> --from <starter>', { effect: 'local change' }),
      act(4, 'Show the board', '/board'),
    ],
    voxvision: [
      act(1, 'Observe a file', '/observe <file>', { primary: true, effect: 'local change' }),
      act(2, 'Measure', '/measure <file>'),
      act(3, 'Compare two observations', '/compare <a> <b>'),
      act(4, 'VoxVision records', '/vox'),
    ],
    create: [
      act(1, 'Blender scene', '/blender', { effect: 'local change' }),
      act(2, 'OpenSCAD model', '/scad', { effect: 'local change' }),
      act(3, 'After Effects composition', '/ae', { effect: 'local change' }),
      act(4, 'All tools and what each needs', '/tools'),
    ],
    control: [
      act(1, waiting > 0 ? `Decide what waits (${waiting})` : 'What waits on you', '/room', { primary: waiting > 0 }),
      act(2, 'Jobs', '/jobs'),
      act(3, 'Stop current', '/stop', { enabled: stop.job !== null, ...(stop.job ? {} : { why: 'nothing runs' }) }),
      act(4, 'Recover what a crash left', '/recover', { effect: 'local change' }),
    ],
    fleet: [
      act(1, 'Plan a fleet (the FAKE backend first)', 'timmy fleet plan --provider fake --workers 3 --prompt "<task>"', { effect: 'local change' }),
      act(2, 'Fleet status', 'timmy fleet status'),
      act(3, 'Ask Clef for a route (off by default)', 'timmy decide route --option <id> …'),
      act(4, 'Connect a Cloudroom Core', 'timmy fleet connect cloudroom <url> --token-file <file>', { effect: 'local change' }),
    ],
    tools: [
      act(1, 'Every tool with its rung', '/tools'),
      act(2, 'Call a tool: the SDK route', '/mcp call --route sdk <tool> {json} -- <server command>', { effect: 'local change' }),
      act(3, 'Call a tool: the mcporter route', '/mcp call --route mcporter <tool> {json} -- <server command>', { effect: 'local change' }),
      act(4, 'Projects', '/project list'),
    ],
    logs: [
      act(1, 'Receipts and the chain', '/receipts'),
      act(2, 'One operation in full', lastOp ? `/op ${lastOp}` : '/ops'),
      act(3, 'Follow events', 'timmy events --follow --human'),
      act(4, 'Project files', '/files'),
    ],
  };
}

const tone = (e: { attention?: boolean; failed?: boolean }): LogTone => (e.failed ? 'failure' : e.attention ? 'attention' : 'neutral');

const TURN_SURFACE: Readonly<Record<string, string>> = { repl: 'the REPL', monitor: 'the monitor', workbench: 'the Workbench', companion: 'the companion' };
/**
 * R5 lead (the finish line, item 3): a sealed chat turn as the frame carries it to every surface, in the words the Workbench's
 * log gives it (src/workbench/hub.ts turnEntry): how it ended, where, the model, its receipt and how long it took.
 */
export function turnOf(t: TurnRow): WorkspaceTurn {
  // R6 (H140): how it ended in the one table's words (src/contracts/stop-words.ts): a stopped turn always says who asked
  const ended = turnEndWords({ state: t.state, surface: t.surface, ...(t.stoppedBy ? { stoppedBy: t.stoppedBy } : {}) });
  return {
    receipt: t.receipt, surface: t.surface, state: t.state, model: t.model, at: t.at, ...(t.ms !== undefined ? { ms: t.ms } : {}),
    operation: t.operation, route: t.local === true ? 'local' : t.local === false ? 'remote' : 'openrouter',
    words: `turn ${ended} in ${TURN_SURFACE[t.surface] ?? t.surface} · ${t.model ?? 'model not recorded'} · receipt ${t.receipt}${t.ms !== undefined ? ` · ${took(t.ms)}` : ''}`,
    ...(t.turn ? { turn: t.turn } : {}), ...(t.stoppedBy ? { stoppedBy: t.stoppedBy } : {}),
  };
}

/** R6 (H140): whether the `ollama` program is on this PATH (the caller's lookup, else the PATH itself): it only words a step. */
const ollamaCli = (d: StateDeps, env: Env): boolean => {
  try { return d.onPath ? d.onPath('ollama') !== null : onPathNow('ollama', env); } catch { return false; }
};

/** The frame. Reads the records only; the same inputs give the same revision. */
export async function buildWorkspaceFrame(d: StateDeps & { now?: number; platform?: NodeJS.Platform; alive?: ProcessAlive } = {}): Promise<WorkspaceFrame> {
  const env = d.env ?? process.env;
  const cwd = d.cwd ?? process.cwd();
  const now = d.now ?? Date.now();
  const wb = await workbenchJson(d);
  const unknown: WorkspaceFrame['unknown'] = [];
  // R6 (H140): one reading of the process table for the frame's notes (src/ops/process-proof.ts withProcessTable)
  const read: Partial<Record<'companion' | 'studio', SurfaceNow>> = {};
  const connections = withProcessTable(() => connectionsOf(env, cwd, wb, now, unknown, d.alive, read));
  const settings = readWorkbenchSettings(env).settings;
  // R6 (H140): a surface runs when it answered within the bound (live), or while the process that noted it listening runs (it
  // listens; nothing has asked it yet); not running when a check or its own note says so, or its process is gone; else unknown
  const surface = (id: 'companion' | 'studio', openAtStart: boolean) => {
    const now_ = read[id];
    const running = now_ === 'live' || now_ === 'listening';
    const state = running ? 'running' as const : now_ === 'not running' || now_ === 'gone' || now_ === 'no answer' || now_ === 'refused' ? 'not running' as const : 'unknown' as const;
    return { openAtStart, url: running ? (id === 'studio' ? studioBaseUrl(env) : companionBaseUrl(env)) : null, state };
  };
  // R5 lead: the project's newest sealed chat turns (their receipts, newest first): newer observations of the chat route than
  // an older check
  const recentTurns = (() => { try { return readTurns(d.chain ? d.chain() : chainOf(wb.project.root, env), wb.project.root); } catch { return []; } })();
  // R5 lead: a chat turn being answered now (its hold in <project>/.timmy/chat-turns), read without removing a stale one (a
  // hold whose process has ended is no running turn). R5 lead (the QA round, defect 9; the operator's 22:32 order, item 1):
  // a hold whose own receipt is sealed has ended (the hold is let go a moment after): matched by the turn's identity, its
  // hold's id sealed on its receipt as turn_id, never by surface and time, so a next turn taken at once is still running
  const turns = (() => { try { return runningTurns(wb.project.root, undefined, { readOnly: true }); } catch { return []; } })()
    .filter((t) => !recentTurns.some((r) => r.turn === t.id));
  const turn = turns[0];
  // R5 lead (the QA round, defect 6): no clock time in the words; each surface shows `since` in its own one format
  const turnWordsNow = turn ? `a chat turn is being answered in ${surfaceWords(turn.surface)}` : '';
  const log: WorkspaceLogEntry[] = wb.events.slice(0, LOG_MAX).map((e) => ({
    at: e.at, tag: e.output ? 'job.output' : e.job ? 'job' : 'event', words: e.words, tone: tone(e),
    ...(e.operation ? { operation: e.operation } : {}), source: e.job ? `job ${e.job}` : e.key,
  }));
  if (!log.length) unknown.push({ field: 'log', why: 'no job has run in this project yet' });
  const body = {
    schema: WORKSPACE_SCHEMA, version: WORKSPACE_VERSION,
    project: { id: wb.project.id, name: wb.project.name, shown: wb.project.shown, chosen: wb.project.chosen, switch: '/project <name>', create: '/project new <name>' },
    tabs: TABS.map((t) => ({ id: t.id, key: t.key, label: t.label, refs: t.refs, purpose: t.purpose, waiting: t.id === 'control' || t.id === 'home' ? wb.activity.waiting_on_you : 0 })),
    actions: actionsOf(wb, turns, { studioRunning: connections.find((c) => c.id === 'studio')?.state === 'live', connections, recentTurns, ollamaStart: ollamaStartStep({ cli: ollamaCli(d, env), platform: d.platform ?? process.platform }) }),
    connections,
    activity: {
      running: wb.activity.running + turns.length, waitingOnYou: wb.activity.waiting_on_you,
      stopCurrent: wb.activity.stop_current.job || !turn ? wb.activity.stop_current : { job: null, words: `Stop current: the chat turn in ${surfaceWords(turn.surface)} (${turnStopWords(turn.surface)})` },
      chatTurn: turn ? { surface: turn.surface, since: turn.taken, words: turnWordsNow, id: turn.id } : null,
    },
    log,
    chat: { turns: recentTurns.map(turnOf) },
    surfaces: { companion: surface('companion', settings.openCompanionAtStart), studio: surface('studio', settings.openStudioAtStart) },
    unknown,
  };
  const revision = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  return { ...body, at: new Date(now).toISOString(), revision } as WorkspaceFrame;
}

// ── checking the connections (`timmy workspace check`) ─────────────────────────

/** What the check asks, each injectable so a test drives it with FAKE answers and nothing leaves the process. */
export interface CheckDeps {
  env?: Env;
  cwd?: string;
  now?: () => number;
  /** OpenRouter's key endpoint (no model call, no charge); absent: src/capabilities/live.ts openRouterProbe */
  openRouter?: (key: string | null) => Promise<'accepted' | 'rejected' | 'unreachable' | 'no-key' | 'not-asked'>;
  /** the key itself, read only to ask the key endpoint; never written or printed */
  key?: () => string | null;
  ollama?: () => Promise<{ ok: boolean; models: string[]; answer?: { state: string; why?: string } }>;
  studio?: (baseUrl: string) => Promise<{ state: string; pageConnected?: boolean | null; detail?: string }>;
  /** the companion's /api/auth: its HTTP status, 'refused' when nothing listens, null when nothing answered in time */
  companion?: (baseUrl: string) => Promise<number | 'refused' | null>;
  edge?: (url: string) => Promise<number | null>;
}

/**
 * Asks each service once, with short timeouts, and records what answered: OpenRouter's key endpoint (free), the local
 * Ollama's model list, Timmy Studio's health, the browser companion's token check (a 401 is a companion answering) and,
 * when one is set up, the Cloudflare edge's /health. No model is called and nothing is spent. Returns the record it wrote.
 */
export async function checkConnections(d: CheckDeps = {}): Promise<{ record: ConnectionsRecord; path: string }> {
  const env = d.env ?? process.env;
  const cwd = d.cwd ?? process.cwd();
  const now = d.now ?? Date.now;
  const stamp = (): string => new Date(now()).toISOString();
  const checks: ConnectionsRecord['checks'] = { ...readConnections(env).checks };
  let key: string | null = d.key ? d.key() : null;
  if (!d.key) {
    try {
      if (modelKeySource(env, cwd)) {
        const { loadConfig } = await import('../utils/config.js');
        key = loadConfig().apiKey || null;
      }
    } catch { key = null; }
  }
  const openRouter = d.openRouter ?? (async (k: string | null) => (await import('../capabilities/live.js')).openRouterProbe(k));
  const or = await openRouter(key);
  // R5 lead (the operator's 22:32 order, item 1): the key asked with, as its fingerprint (never the key), so a key changed
  // since is not said taken or refused
  const keyAsked = key ? { asked: `key ${createHash('sha256').update(key).digest('hex').slice(0, 12)}` } : {};
  if (or === 'accepted') checks.openrouter = { answer: 'accepted', at: stamp(), detail: 'the key endpoint took the key', ...keyAsked };
  else if (or === 'rejected') checks.openrouter = { answer: 'refused', at: stamp(), detail: 'the key endpoint rejected the key', ...keyAsked };
  else if (or === 'unreachable') checks.openrouter = { answer: 'no answer', at: stamp(), detail: 'the key endpoint did not answer', ...keyAsked };
  else delete checks.openrouter;
  const olAt = ollamaAddress(env);
  const ollama = d.ollama ?? (async () => (await import('../agent/providers.js')).probeOllama(1500, olAt));
  const ol = await ollama();
  checks.ollama = ol.ok
    // R5 lead: the same words as /tools (src/capabilities/ollama-row.ts): local models that pass Ollama's own check, and how
    // many more did not (the Mac rehearsal: "8 models listed" while Ollama listed 32, most of them cloud models)
    ? { answer: 'accepted', at: stamp(), detail: (await import('../capabilities/ollama-row.js')).ollamaRow(ol as OllamaProbe, { cli: true }).detail, asked: olAt }
    : { answer: 'no answer', at: stamp(), detail: (ol.answer && 'why' in ol.answer ? String(ol.answer.why) : ol.answer?.state) ?? 'no answer', asked: olAt };
  const studio = d.studio ?? (async (u: string) => (await import('../studio/health.js')).studioHealth(u) as Promise<{ state: string; pageConnected?: boolean | null; detail?: string }>);
  const st = await studio(studioBaseUrl(env));
  const studioAsked = surfaceAddress('studio', env);
  checks.studio = st.state === 'running'
    ? { answer: 'accepted', at: stamp(), detail: st.pageConnected ? 'running, a page is open' : 'running', asked: studioAsked }
    : st.state === 'not-running' ? { answer: 'not running', at: stamp(), asked: studioAsked } : { answer: 'no answer', at: stamp(), detail: st.detail ?? st.state, asked: studioAsked };
  // the companion asks for its token on /api/auth: a 401 there is a companion answering; a refused connection, none started
  const companion = d.companion ?? (async (u: string): Promise<number | 'refused' | null> => {
    try { return (await fetch(`${u}api/auth`, { signal: AbortSignal.timeout(1500), redirect: 'manual' })).status; } catch (e) {
      const err = e as { cause?: { code?: string } };
      return err?.cause?.code === 'ECONNREFUSED' ? 'refused' : null;
    }
  });
  const cp = await companion(companionBaseUrl(env));
  const companionAsked = surfaceAddress('companion', env);
  checks.companion = cp === 401 || cp === 200 ? { answer: 'accepted', at: stamp(), detail: 'running', asked: companionAsked }
    : cp === 'refused' ? { answer: 'not running', at: stamp(), asked: companionAsked }
    : { answer: 'no answer', at: stamp(), detail: cp === null ? 'nothing answered in time' : `HTTP ${cp}: another program may hold the port`, asked: companionAsked };
  const edgeUrl = (() => { try { return edgeUrlOrNull(); } catch { return null; } })();
  if (edgeUrl) {
    const edge = d.edge ?? (async (u: string) => {
      try { return (await fetch(`${u.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(3000), redirect: 'manual' })).status; } catch { return null; }
    });
    const code = await edge(edgeUrl);
    const edgeAsked = edgeUrl.replace(/\/+$/, '');
    checks.cloudflare = code === null ? { answer: 'no answer', at: stamp(), asked: edgeAsked } : code >= 200 && code < 300 ? { answer: 'accepted', at: stamp(), detail: `HTTP ${code}`, asked: edgeAsked } : { answer: 'refused', at: stamp(), detail: `HTTP ${code}`, asked: edgeAsked };
  } else delete checks.cloudflare;
  const record: ConnectionsRecord = { schema: CONNECTIONS_SCHEMA, checks };
  return { record, path: writeConnections(record, env) };
}
