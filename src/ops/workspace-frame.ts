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
import { existsSync } from 'node:fs';
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
import { readClefConfig } from '../decision/config.js';
import { providerFromConfig } from '../decision/provider.js';
import { cloudroomConfigPath } from '../fleet/cloudroom/config.js';
import { studioBaseUrl } from '../studio/config.js';
import { pendingDrafts } from '../studio/boards.js';
import { freeOnlyOn } from '../agent/model-price.js';
import { localOnlyOn } from '../agent/route-policy.js';
import { keyFingerprint, keyInUse, keyWhere } from '../setup/provider-keys.js';
import { askedCompanionPort } from '../setup/companion-port.js';
import { runningTurns, surfaceWords, type OtherTurn } from '../agent/chat-turn.js';
import type { ChatSurface } from '../contracts/chat-session.js';
import { turnEndWords } from '../contracts/stop-words.js';
import { ollamaAddress, ollamaStartStep } from '../capabilities/ollama-route.js';
import { onPath as onPathNow } from '../utils/on-path.js';
import { readProcessTable, THIS_PROCESS, withProcessTable, writerState, type ProcessTable } from './process-proof.js';
import { readMcpCalls, type McpCallRead } from '../connectors/mcp-records.js';
// R10 (H169; CI at 704d8510): the connections record lives in ./connections-record.ts (a chat turn keeps its observation there
// without loading this module); the frame reads and writes it through the same functions, and re-exports them unchanged
import { CONNECTIONS_SCHEMA, readConnections, writeConnections, type ConnectionCheck, type ConnectionsRecord } from './connections-record.js';
export { CONNECTIONS_SCHEMA, connectionsPath, noteTurnAnswer, readConnections, writeConnections, type ConnectionCheck, type ConnectionsRecord } from './connections-record.js';
import type { Receipt } from '../utils/receipts.js';

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
/** How many log lines the frame carries, the newest first. */
export const LOG_MAX = 30;

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

/** R7 lead (H148's N4): the step for an Ollama that answered with no local model Timmy can use. */
export const NO_MODEL_STEP = 'pull a local model (ollama pull <model>, not a cloud one), then timmy workspace check';

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
    // R10 (H169; H168's pass 2c, R2 and R4): a chat turn's observation is said as a turn's, never as a check's
    // (the brief's words: it ends "live", "○ configured · did not answer HH:MM", until a check or a turn answers again)
    if (c.by === 'turn' && c.answer === 'no answer') return { ...base, state: o.configured ? 'configured' : (o.notConfiguredState ?? 'not set up'), words: `did not answer a chat turn ${ago(c.at, o.now)}${said}; a check or a turn that answers makes it live again`, observedAt: c.at };
    if (c.by === 'turn' && c.answer === 'accepted') {
      return fresh
        ? { ...base, state: 'live', words: `answered a chat turn ${ago(c.at, o.now)}${said}; live: ${LIVE_FOR_WORDS}`, observedAt: c.at }
        : { ...base, state: o.configured ? 'configured' : 'unknown', words: `answered a chat turn ${ago(c.at, o.now)}${said}; check again to see it now`, observedAt: c.at };
    }
    if (c.answer === 'refused') return { ...base, state: 'refused', words: `refused when checked ${ago(c.at, o.now)}${said}`, observedAt: c.at };
    // a surface Timmy starts on demand that is not started is not a failure: it is set up, and says how to start it
    if (c.answer === 'not running') return { ...base, state: 'configured', words: `not running when checked ${ago(c.at, o.now)}${o.startWords ? `; ${o.startWords}` : ''}`, observedAt: c.at };
    if (c.answer === 'no answer') {
      // an optional service nobody chose: nothing answering is not a failure either; it is not set up, with its step
      if (!o.configured) return { ...base, state: o.notConfiguredState ?? 'not set up', words: `nothing answered when checked ${ago(c.at, o.now)}${said}; ${o.setupWords}`, observedAt: c.at };
      return { ...base, state: 'unreachable', words: `no answer when checked ${ago(c.at, o.now)}${said}`, observedAt: c.at };
    }
    // R7 lead (H148's N4: "✕ unreachable … (listed)" and Next "Start Ollama" for an Ollama that answered with no usable
    // model): it answered, so it is not unreachable; it is not set up for chat until a model is there, and says which step
    if (c.answer === 'no model') return { ...base, state: 'not set up', words: `answered when checked ${ago(c.at, o.now)}, but holds no model Timmy can use${said}; ${NO_MODEL_STEP}`, observedAt: c.at };
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

/**
 * The decision model as every surface's services list says it. R9 lead (H162): by its role, never as Clef-Omni: clef.json may
 * name another model (clef-flash, Jev, d1-ultra), and the setting's saved name (useClef) is not what it is called on screen.
 * Its setup is decide's help, which says how routing is turned on and pricing declared.
 *
 * R9 lead, after the R9 independent review (its F1): a model that clef.json names is "configured", with the model, where it is
 * reached and its pricing as declared, whether routing is on or off; before, it was "not set up" until routing was turned on,
 * beside the Workbench's tab 8 naming the model. The model and pricing come from the provider's own description
 * (src/decision/provider.ts), as tab 8's do, so a loopback address is never called free here either. Nothing is asked.
 */
function decisionModelConnection(env: Env): WorkspaceConnection {
  const set = (() => { try { return readDecisionSettings(env); } catch { return null; } })();
  const on = set?.settings?.useClef === true;
  const from = set?.useClefFrom === 'environment' ? `TIMMY_CLEF=${on ? 1 : 0}, for this process` : set?.useClefFrom === 'saved' ? 'saved' : 'the default';
  const base = { id: 'clef' as const, label: 'Decision model (recommender)', observedAt: null, setup: 'timmy decide --help' };
  const unusable = (why: string): WorkspaceConnection => ({
    ...base, state: 'not set up',
    words: `${why}; ${on ? `decision-model routing is on (${from}), but with no usable model routes stay deterministic` : `decision-model routing is off (${from}): routes stay deterministic`}`,
  });
  const read = (() => { try { return readClefConfig(env); } catch (e) { return { state: 'unreadable' as const, why: e instanceof Error ? e.message : String(e), path: '' }; } })();
  if (read.state === 'none yet') return unusable('no decision model is set up (no decision/clef.json)');
  if (read.state === 'off') return unusable('turned off in clef.json (transport "none")');
  if (read.state !== 'configured') return unusable(`clef.json cannot be used: ${read.why}`);
  if (read.config.transport === 'none') return unusable('turned off in clef.json (transport "none")');
  const d = providerFromConfig(read).describe();
  if (!d.available) return unusable(`clef.json cannot be used: ${d.reason ?? 'its model cannot be asked'}`);
  const where = d.transport === 'workers-ai' ? 'Workers AI (Cloudflare\'s hosted service, off this computer)'
    : d.endpoint === 'systemone-loopback' ? `SystemOne on this computer${d.cloudModel ? ' (a cloud model tag: what it is given leaves this computer)' : ''}` : 'SystemOne on another computer';
  const price = d.pricing.kind === 'free-local' ? 'free: local (declared in clef.json)' : d.pricing.words;
  return {
    ...base, state: 'configured',
    words: `${d.model} over ${where}, pricing ${price}; ${on ? 'decision-model routing is on; no live call is authorized, so it is not checked here' : `decision-model routing is off (${from}): routes stay deterministic`}`,
  };
}

/**
 * R10 (H169; H168's pass 2c, R4: "Ollama's row at launch tells the last check's time, not the newest answer's"): the newest
 * observation of a chat route's connection: its check (or a turn's own note), or the project's newest sealed turn on that route
 * that answered, when that is newer (a receipt that names an Ollama endpoint went through Ollama; one that names none,
 * OpenRouter). A turn's answer counts only while no check names another address or key than the one set up now.
 */
export function newestObservation(check: ConnectionCheck | undefined, via: 'ollama' | 'openrouter', turns: readonly Pick<TurnRow, 'state' | 'at' | 'local' | 'model'>[] = []): ConnectionCheck | undefined {
  const t = turns.filter((x) => x.state === 'answered' && Number.isFinite(Date.parse(x.at)) && (via === 'ollama' ? x.local !== undefined : x.local === undefined))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (!t) return check;
  if (check && Number.isFinite(Date.parse(check.at)) && Date.parse(check.at) >= Date.parse(t.at)) return check;
  return { answer: 'accepted', at: t.at, ...(t.model ? { detail: t.model } : {}), by: 'turn' };
}

function connectionsOf(env: Env, cwd: string, wb: WorkbenchJson, now: number, unknown: WorkspaceFrame['unknown'], alive?: ProcessAlive, surfaces: Partial<Record<'companion' | 'studio', SurfaceNow>> = {}, mcpCalls: readonly McpCallRead[] = [], recentTurns: readonly Pick<TurnRow, 'state' | 'at' | 'local' | 'model'>[] = []): WorkspaceConnection[] {
  const checks = readConnections(env).checks;
  const out: WorkspaceConnection[] = [];
  const key = (() => { try { return modelKeySource(env, cwd); } catch { return null; } })();
  const keyNow = key ? (() => { try { return modelKeyFingerprint(env, cwd); } catch { return null; } })() : null;
  const or = forNow(checks.openrouter, keyNow);
  out.push(connectionOf('openrouter', 'OpenRouter (cloud chat)', {
    configured: key !== null, setupWords: 'no key: timmy init --chat openrouter asks for it (typed hidden), or set OPENROUTER_API_KEY', setup: key ? 'timmy workspace check' : 'timmy init --chat openrouter',
    check: or.other ? or.check : newestObservation(or.check, 'openrouter', recentTurns), now, ...(key ? { detail: `key from ${key}${freeOnlyOn(env) ? '; free-only on (a model not known to be free is refused)' : ''}${or.other ? '; not checked with this key yet (the last check asked with another key)' : ''}` } : {}),
  }));
  const ollamaBase = ollamaAddress(env);
  // set up when the chat route is the local model, or when an address for it is set; otherwise it is optional
  const ollamaChosen = wb.route.kind === 'local' || Boolean(env.OLLAMA_HOST || env.OLLAMA_BASE_URL);
  // R5 lead (the QA round, defect 3): a check that asked another address (before the setup changed it) is not this one's
  const ol = forNow(checks.ollama, ollamaBase);
  out.push(connectionOf('ollama', 'Ollama (local models)', {
    configured: ollamaChosen, setupWords: 'optional: run Ollama with a model pulled, then timmy init --chat local --model <name> chooses it for chat',
    setup: ollamaChosen ? 'timmy workspace check' : 'timmy init --chat local --model <name>', check: ol.other ? ol.check : newestObservation(ol.check, 'ollama', recentTurns), now,
    detail: `asked at ${ollamaBase.replace(/\/+$/, '')}, no charge (local)${ol.other ? `; not checked at this address yet (the last check asked ${ol.other})` : ''}`,
  }));
  // R10 (H169; the lead's decision of 2026-10-22 18:02, on H170's proposal): Ollama Cloud, Ollama's hosted API, a connection of
  // its own: remote inference (labelled cloud; local-only refuses it, and free-only too: no price per request is known here),
  // set up by its key (H170's keyInUse: OLLAMA_API_KEY, else providers.json's ollama_cloud_api_key), observed by a check that
  // lists its models with that key and runs none (timmy workspace check, or the setup's own: H170's checkProvider), which names
  // the key's fingerprint. Only where the key is kept is said, never the key.
  const cloudKey = (() => { try { return keyWhere('ollama-cloud', env, cwd); } catch { return null; } })();
  const oc = forNow(checks['ollama-cloud'], cloudKey?.fingerprint ?? null);
  out.push(connectionOf('ollama-cloud', 'Ollama Cloud (cloud models, optional)', {
    configured: cloudKey !== null,
    setupWords: 'optional: an Ollama API key from ollama.com/settings/keys, as OLLAMA_API_KEY or saved by the setup in providers.json; remote inference, nothing to download',
    setup: cloudKey ? 'timmy workspace check' : null, check: cloudKey ? oc.check : undefined, now,
    detail: `remote inference on ollama.com (cloud, no local weights); ${localOnlyOn(env) ? 'local-only is on, so chat never uses it' : 'local-only refuses it'}; no price per request is known here, so free-only refuses it too${cloudKey ? `; key from ${cloudKey.words}` : ''}${cloudKey && oc.other ? '; not checked with this key yet (the last check asked with another key)' : ''}`,
  }));
  const edge = (() => { try { return edgeUrlOrNull(); } catch { return null; } })();
  const cf = forNow(checks.cloudflare, edge);
  out.push(connectionOf('cloudflare', 'Cloudflare edge (optional)', {
    configured: edge !== null, setupWords: 'not set up (optional; it is not the chat provider)', setup: null, check: cf.check, now,
    ...(cf.other ? { detail: `not checked at this address yet (the last check asked ${cf.other})` } : {}),
  }));
  out.push(decisionModelConnection(env));
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
  // R6 lead (H146's finding: after calls through both routes, `timmy workspace check` still said "? unknown · this computer
  // keeps no check of it yet"): each MCP-to-CLI route is said from the project's own call records (<project>/.timmy/mcp, H142's):
  // its newest call that answered or failed is its last observation, live only within the bound, as every other connection's
  // answer; with none recorded it is unknown, and says how to make one. A record sealed by a receipt that names its bytes says so.
  for (const [id, route, label, cmd] of [['mcp-sdk', 'sdk', 'MCP to CLI: the SDK route', '/mcp call --route sdk <tool> {json} -- <server command>'], ['mcporter', 'mcporter', 'MCP to CLI: the mcporter route', '/mcp call --route mcporter <tool> {json} -- <server command>']] as const) {
    const timeOf = (x: McpCallRead): number => { const t = Date.parse(x.record.ended_at); return Number.isFinite(t) ? t : Date.parse(x.record.started_at) || 0; };
    const c = mcpCalls.filter((x) => x.record.route === route && (x.record.outcome === 'answered' || x.record.outcome === 'failed')).sort((a, b) => timeOf(b) - timeOf(a))[0];
    if (!c) {
      out.push({ id, label, state: 'unknown', observedAt: null, setup: cmd, words: 'used by a call when you make one; no call through it is recorded in this project yet' });
      continue;
    }
    const r = c.record;
    const at = Number.isFinite(Date.parse(r.ended_at)) ? r.ended_at : r.started_at;
    const sealed = c.check.status === 'verified' ? `its record sealed by receipt ${c.check.receipt}` : `its record not sealed by a receipt that names it (${c.check.reason})`;
    const detail = `${r.tool} on ${r.server}${r.outcome === 'answered' && r.isError ? ', which answered with an error' : ''}${r.outcome === 'failed' && r.error ? ` (${String(r.error).slice(0, 120)})` : ''}; ${sealed}`;
    const when = ago(at, now);
    if (r.outcome === 'failed') out.push({ id, label, state: 'unreachable', observedAt: at, setup: cmd, detail, words: `the newest call through it failed ${when}` });
    else if (now - Date.parse(at) <= LIVE_FOR_MS) out.push({ id, label, state: 'live', observedAt: at, setup: cmd, detail, words: `a call through it answered ${when}; live: ${LIVE_FOR_WORDS}` });
    else out.push({ id, label, state: 'configured', observedAt: at, setup: cmd, detail, words: `a call through it answered ${when}; a new call shows it now` });
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
export type ChatProblem = 'no-route' | 'no-local-model' | 'ollama-address' | 'ollama-unreachable' | 'ollama-no-model' | 'free-only' | 'key-refused';
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
  // R7 lead (H148's N4): Ollama answered the last check but holds no local model Timmy can use (its card's words say so)
  const noModel = (c: Pick<WorkspaceConnection, 'state' | 'words'>): boolean => c.state === 'not set up' && c.words.includes(NO_MODEL_STEP);
  const pullFix = (c: Pick<WorkspaceConnection, 'words'>, then: string): ChatFix => ({
    problem: 'ollama-no-model', label: 'Pull a local model in Ollama, then check again (no charge)', command: 'timmy workspace check', effect: 'network',
    words: `Ollama: ${c.words}. Ollama runs; it has no local model the chat can use yet.${then}`,
  });
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
      if (ol && noModel(ol) && !answeredSince(ol, 'ollama')) return pullFix(ol, ' Then choose it with /model.');
      return { problem: 'no-local-model', label: 'Choose the local model (from what Ollama lists)', command: '/model', effect: 'local change', words: chatNotReady(route) };
    }
    return { problem: 'ollama-address', label: 'Set the Ollama address the chat uses', command: '/setup chat', effect: 'local change', words: chatNotReady(route) };
  }
  if (route.kind === 'local' && route.ready) {
    const ol = conn('ollama');
    if (ol && (ol.state === 'unreachable' || ol.state === 'refused') && !answeredSince(ol, 'ollama')) {
      return { problem: 'ollama-unreachable', label: 'Start Ollama, then check again (no charge)', command: 'timmy workspace check', effect: 'network', words: `Ollama: ${ol.words}. Start it (${start}), then check again.` };
    }
    if (ol && noModel(ol) && !answeredSince(ol, 'ollama')) return pullFix(ol, '');
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

const act = (n: number, label: string, command: string, o: Partial<Pick<WorkspaceAction, 'primary' | 'enabled' | 'why' | 'effect' | 'doneIn'>> = {}): WorkspaceAction => ({
  n, label, command, primary: o.primary ?? false, enabled: o.enabled ?? true, effect: o.effect ?? 'read', ...(o.why ? { why: o.why } : {}), ...(o.doneIn ? { doneIn: o.doneIn } : {}),
});

/** Each tab's actions. Only commands that exist (the REPL's registry, `timmy`'s verbs); the primary one comes from the records. */
export function actionsOf(wb: WorkbenchJson, turns: readonly Pick<OtherTurn, 'surface'>[] = [], o: { studioRunning?: boolean; connections?: readonly (Pick<WorkspaceConnection, 'id' | 'state' | 'words'> & { observedAt?: string | null })[]; recentTurns?: readonly Pick<TurnRow, 'state' | 'at' | 'local'>[]; ollamaStart?: string; drafts?: number } = {}): Record<TabId, WorkspaceAction[]> {
  const waiting = wb.activity.waiting_on_you;
  const running = wb.activity.running;
  const drafts = Math.max(0, Math.floor(o.drafts ?? 0));
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
        // R7 lead (H148's N3): done only where the turn was sent; another surface shows where, and never stops it on Enter
        ? act(3, 'Stop the turn', turnStopCommand(turns[0].surface as ChatSurface), { primary: true, doneIn: turns[0].surface as ChatSurface })
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
    // R5 lead: with Studio running, the next step is to have Timmy draw on it (a REPL holds the canvas: /canvas open).
    // R6 lead (the R5 interaction review, item 13): the label names what the command does and leaves the drawing request
    // to words, since the strip shows the command after it; before, "… then ask /canvas open" read as if /canvas open were
    // the request. Short enough that an 800 px strip stays two rows.
    // R7 lead (H147's R6 finding 2; the operator: "Make Studio's primary action reflect the actual next step when a draft is
    // waiting"): a draft Timmy proposed on the project's board (src/studio/boards.ts pendingDrafts, the one the waiting count
    // reads) is the next step until it is accepted or discarded, done on the draft itself in Studio
    studio: [
      drafts > 0
        ? act(1, drafts === 1 ? 'Accept or discard the draft Timmy proposed' : `Accept or discard the ${drafts} drafts Timmy proposed`, o.studioRunning ? 'Accept or Discard on the draft, in Studio' : '/studio, then Accept or Discard on the draft', { primary: true, effect: 'local change' })
        : o.studioRunning
          ? act(1, 'Open the canvas for Timmy (then ask it to draw)', '/canvas open', { primary: true, effect: 'local change' })
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
      act(3, 'Ask the decision model (off by default)', 'timmy decide route --option <id> …'),
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

type FrameDeps = StateDeps & { now?: number; platform?: NodeJS.Platform; alive?: ProcessAlive };

/**
 * The frame. Reads the records only; the same inputs give the same revision.
 *
 * R10 (H163; the turn-holds latency, the lead's item (e)): no proof the frame makes runs a program on the event loop. With a
 * process table given (d.processTable: the Workbench passes the one it last read), it is built once against it, each pid
 * looked up noted in d.processLooked. Without one, it is built first against no table at all: a frame that looks no pid up
 * (no chat hold, no surface's listening note, no record an ended session left) needs none and runs no program; one that does
 * is built again against the table, read by a child process the event loop does not wait on (src/ops/process-proof.ts
 * readProcessTable). Before, a frame build ran ps -A and ps -p on the event loop: on a loaded computer 0.1 to 0.5 s in which
 * the Workbench drew nothing.
 */
export async function buildWorkspaceFrame(d: FrameDeps = {}): Promise<WorkspaceFrame> {
  if (d.processTable) return frameWith(d, d.processTable);
  const looked = new Set<number>();
  const first = await frameWith({ ...d, processLooked: looked }, { rows: new Map(), at: Date.now() });
  if (!looked.size) return first;
  return frameWith({ ...d, processLooked: undefined }, await readProcessTable());
}

/** The frame built against `table` (every proof looked up in it, none running a program). */
async function frameWith(d: FrameDeps, table: ProcessTable): Promise<WorkspaceFrame> {
  const env = d.env ?? process.env;
  const cwd = d.cwd ?? process.cwd();
  const now = d.now ?? Date.now();
  const looked = d.processLooked;
  const wb = await workbenchJson({ ...d, processTable: table });
  const unknown: WorkspaceFrame['unknown'] = [];
  // R6 (H140): one reading of the process table for the frame's notes (src/ops/process-proof.ts withProcessTable)
  const read: Partial<Record<'companion' | 'studio', SurfaceNow>> = {};
  // R6 lead: the project's chain, read once (the MCP routes' records and the chat turns are checked against it)
  let chainRead: Receipt[] | null = null;
  const chainOnce = (): Receipt[] => (chainRead ??= d.chain ? d.chain() : chainOf(wb.project.root, env));
  const mcpCalls = (() => { try { return readMcpCalls(wb.project.root, chainOnce(), 12).list; } catch { return []; } })();
  // R5 lead: the project's newest sealed chat turns (their receipts, newest first): newer observations of the chat route than
  // an older check. R10 (H169): read before the connections, whose rows take the newest answer (R4)
  const recentTurns = (() => { try { return readTurns(chainOnce(), wb.project.root); } catch { return []; } })();
  const connections = withProcessTable(() => connectionsOf(env, cwd, wb, now, unknown, d.alive, read, mcpCalls, recentTurns), table, looked);
  const settings = readWorkbenchSettings(env).settings;
  // R6 (H140): a surface runs when it answered within the bound (live), or while the process that noted it listening runs (it
  // listens; nothing has asked it yet); not running when a check or its own note says so, or its process is gone; else unknown
  const surface = (id: 'companion' | 'studio', openAtStart: boolean) => {
    const now_ = read[id];
    const running = now_ === 'live' || now_ === 'listening';
    const state = running ? 'running' as const : now_ === 'not running' || now_ === 'gone' || now_ === 'no answer' || now_ === 'refused' ? 'not running' as const : 'unknown' as const;
    return { openAtStart, url: running ? (id === 'studio' ? studioBaseUrl(env) : companionBaseUrl(env)) : null, state };
  };
  // R5 lead: a chat turn being answered now (its hold in <project>/.timmy/chat-turns), read without removing a stale one (a
  // hold whose process has ended is no running turn). R5 lead (the QA round, defect 9; the operator's 22:32 order, item 1):
  // a hold whose own receipt is sealed has ended (the hold is let go a moment after): matched by the turn's identity, its
  // hold's id sealed on its receipt as turn_id, never by surface and time, so a next turn taken at once is still running
  const turns = (() => { try { return withProcessTable(() => runningTurns(wb.project.root, undefined, { readOnly: true }), table, looked); } catch { return []; } })()
    .filter((t) => !recentTurns.some((r) => r.turn === t.id));
  const turn = turns[0];
  // R7 lead: the drafts waiting on the project's board, as the waiting count reads them (src/ops/waiting.ts)
  const draftsNow = (() => { try { return withProcessTable(() => pendingDrafts(wb.project.root, env)?.count ?? 0, table, looked); } catch { return 0; } })();
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
    tabs: TABS.map((t) => ({ id: t.id, key: t.key, label: t.label, refs: t.refs, purpose: t.purpose, waiting: t.id === 'control' || t.id === 'home' ? wb.activity.waiting_on_you : 0, ...(t.unfinished ? { unfinished: t.unfinished } : {}) })),
    actions: actionsOf(wb, turns, { studioRunning: connections.find((c) => c.id === 'studio')?.state === 'live', connections, recentTurns, ollamaStart: ollamaStartStep({ cli: ollamaCli(d, env), platform: d.platform ?? process.platform }), drafts: draftsNow }),
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
  /** R10 (H169): the Ollama Cloud key, read only to list its models; never written or printed. Absent: H170's keyInUse */
  ollamaCloudKey?: () => string | null;
  /** Ollama Cloud's model list with that key (no model runs, no charge); absent: src/models/ollama-list.ts listOllamaCloudModels */
  ollamaCloud?: (key: string) => Promise<{ ok: true; models: readonly unknown[] } | { ok: false; why: string; status?: number }>;
}

/**
 * Asks each service once, with short timeouts, and records what answered: OpenRouter's key endpoint (free), the local
 * Ollama's model list, Timmy Studio's health, the browser companion's token check (a 401 is a companion answering) and,
 * when one is set up, Ollama Cloud's model list with its key (R10 H169) and the Cloudflare edge's /health. No model is called
 * and nothing is spent. Returns the record it wrote.
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
    // R7 lead (H148's N4): Ollama answered and listed models, none of them a local one that passed its check: an answer with
    // no usable model (the /tools row's words), never "no answer"
    : ol.answer?.state === 'listed'
      ? { answer: 'no model', at: stamp(), detail: (await import('../capabilities/ollama-row.js')).ollamaRow(ol as OllamaProbe, { cli: true, base: olAt }).detail, asked: olAt }
      : { answer: 'no answer', at: stamp(), detail: (ol.answer && 'why' in ol.answer ? String(ol.answer.why) : ol.answer?.state) ?? 'no answer', asked: olAt };
  // R10 (H169): Ollama Cloud, when its key is set up: GET https://ollama.com/api/tags with the key (a list; no model runs,
  // nothing is charged), recorded as the setup's own check records it (H170's checkProvider: the key's fingerprint as `asked`)
  const cloudKey = d.ollamaCloudKey ? d.ollamaCloudKey() : (() => { try { return keyInUse('ollama-cloud', env, cwd)?.key ?? null; } catch { return null; } })();
  if (cloudKey) {
    const list = d.ollamaCloud ?? (async (k: string) => (await import('../models/ollama-list.js')).listOllamaCloudModels({ key: k, timeoutMs: 5000 }));
    const r = await list(cloudKey);
    const asked = keyFingerprint(cloudKey);
    checks['ollama-cloud'] = r.ok ? { answer: 'accepted', at: stamp(), detail: `it lists ${r.models.length} model${r.models.length === 1 ? '' : 's'}; none was run`, asked }
      : r.status === 401 || r.status === 403 ? { answer: 'refused', at: stamp(), detail: `HTTP ${r.status}: Ollama refused the key`, asked }
        : { answer: 'no answer', at: stamp(), detail: r.why, asked };
  } else delete checks['ollama-cloud'];
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
