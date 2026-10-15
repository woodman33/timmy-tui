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
import {
  TABS, WORKSPACE_SCHEMA, WORKSPACE_VERSION,
  type ConnectionId, type LogTone, type TabId, type WorkspaceAction, type WorkspaceConnection, type WorkspaceFrame, type WorkspaceLogEntry,
} from '../contracts/workspace.js';
import { timmyHome } from '../setup/home.js';
import { readSettings as readWorkbenchSettings } from '../workbench/settings.js';
import { workbenchJson, type StateDeps, type WorkbenchJson } from '../workbench/state.js';
import { modelKeySource } from '../utils/model-key.js';
import { edgeUrlOrNull } from '../utils/edge-host.js';
import { readSettings as readDecisionSettings } from '../decision/settings.js';
import { cloudroomConfigPath } from '../fleet/cloudroom/config.js';
import { studioBaseUrl } from '../studio/config.js';
import { freeOnlyOn } from '../agent/model-price.js';
import { askedCompanionPort } from '../setup/companion-port.js';

type Env = Record<string, string | undefined>;

/** Where the companion is asked to listen (TIMMY_COMPANION_PORT, else 3001); a busy port makes it take another, which it says. */
export const companionBaseUrl = (env: Env = process.env): string => {
  let port = 3001;
  try { port = askedCompanionPort([], env); } catch { /* the default */ }
  return `http://127.0.0.1:${port}/`;
};

/** An answered request counts as live for this long; after it, the frame says how old the answer is. */
export const LIVE_FOR_MS = 30 * 60_000;
export const CONNECTIONS_SCHEMA = 'timmy.connections/1' as const;
/** How many log lines the frame carries, the newest first. */
export const LOG_MAX = 30;

/** One observation: what a request was answered with, and when. */
export interface ConnectionCheck {
  /**
   * accepted: the service answered and took the request; refused: it answered no (a rejected key); no answer: nothing came
   * back, or something else answered; not running: a local surface Timmy starts on demand (Studio, the companion) refused
   * the connection, so it is simply not started
   */
  answer: 'accepted' | 'refused' | 'no answer' | 'not running' | 'not asked';
  at: string;
  /** words worth keeping: "3 models", "HTTP 200", "studio running, page connected" */
  detail?: string;
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

const ago = (at: string, now: number): string => {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
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
      return fresh
        ? { ...base, state: 'live', words: `answered ${ago(c.at, o.now)}${said}`, observedAt: c.at }
        : { ...base, state: o.configured ? 'configured' : 'unknown', words: `answered ${ago(c.at, o.now)}${said}; check again to see it now`, observedAt: c.at };
    }
  }
  if (!o.configured) return { ...base, state: o.notConfiguredState ?? 'not set up', words: o.setupWords, observedAt: null };
  return { ...base, state: 'configured', words: 'set up, not checked yet (a setting is not a connection)', observedAt: null };
}

function connectionsOf(env: Env, cwd: string, wb: WorkbenchJson, now: number, unknown: WorkspaceFrame['unknown']): WorkspaceConnection[] {
  const checks = readConnections(env).checks;
  const out: WorkspaceConnection[] = [];
  const key = (() => { try { return modelKeySource(env, cwd); } catch { return null; } })();
  out.push(connectionOf('openrouter', 'OpenRouter (cloud chat)', {
    configured: key !== null, setupWords: 'no key: run timmy setup, or set OPENROUTER_API_KEY', setup: key ? 'timmy workspace check' : 'timmy setup',
    check: checks.openrouter, now, ...(key ? { detail: `key from ${key}${freeOnlyOn(env) ? '; free-only on (a model not known to be free is refused)' : ''}` } : {}),
  }));
  const ollamaBase = env.OLLAMA_HOST || env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  // set up when the chat route is the local model, or when an address for it is set; otherwise it is optional
  const ollamaChosen = wb.route.kind === 'local' || Boolean(env.OLLAMA_HOST || env.OLLAMA_BASE_URL);
  out.push(connectionOf('ollama', 'Ollama (local models)', {
    configured: ollamaChosen, setupWords: 'optional: run Ollama with a model pulled, then timmy setup can choose it for chat',
    setup: ollamaChosen ? 'timmy workspace check' : 'timmy setup', check: checks.ollama, now, detail: `asked at ${ollamaBase.replace(/\/+$/, '')}, no charge (local)`,
  }));
  const edge = (() => { try { return edgeUrlOrNull(); } catch { return null; } })();
  out.push(connectionOf('cloudflare', 'Cloudflare edge (optional)', {
    configured: edge !== null, setupWords: 'not set up (optional; it is not the chat provider)', setup: null, check: checks.cloudflare, now,
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
  out.push(connectionOf('companion', 'Browser companion', {
    configured: true, setupWords: '', setup: 'timmy watch', check: checks.companion, now, startWords: 'c in the Workbench, or timmy watch, starts it',
    detail: `at ${companionBaseUrl(env)}; ${wbSet.openCompanionAtStart ? 'opens with the workspace' : 'opens when asked'}`,
  }));
  out.push(connectionOf('studio', 'Timmy Studio (tldraw)', {
    configured: true, setupWords: '', setup: 'timmy studio', check: checks.studio, now, startWords: 's in the Workbench, or timmy studio, starts it',
    detail: `at ${studioBaseUrl(env)}; ${wbSet.openStudioAtStart ? 'opens with the workspace' : 'opens when asked'}`,
  }));
  for (const [id, label, cmd] of [['mcp-sdk', 'MCP to CLI: the SDK route', '/mcp call --route sdk <tool> {json} -- <server command>'], ['mcporter', 'MCP to CLI: the mcporter route', '/mcp call --route mcporter <tool> {json} -- <server command>']] as const) {
    out.push({ id, label, state: 'unknown', observedAt: null, setup: cmd, words: 'used by a call when you make one; this computer keeps no check of it yet' });
  }
  if (!wb.route.ready) unknown.push({ field: 'chat', why: wb.route.refusal?.join(' ') || 'no chat route is set up' });
  return out;
}

const act = (n: number, label: string, command: string, o: Partial<Pick<WorkspaceAction, 'primary' | 'enabled' | 'why' | 'effect'>> = {}): WorkspaceAction => ({
  n, label, command, primary: o.primary ?? false, enabled: o.enabled ?? true, effect: o.effect ?? 'read', ...(o.why ? { why: o.why } : {}),
});

/** Each tab's actions. Only commands that exist (the REPL's registry, `timmy`'s verbs); the primary one comes from the records. */
export function actionsOf(wb: WorkbenchJson): Record<TabId, WorkspaceAction[]> {
  const waiting = wb.activity.waiting_on_you;
  const running = wb.activity.running;
  const routeReady = wb.route.ready;
  const stop = wb.activity.stop_current;
  const blocked = wb.workflows.docs.flatMap((d) => d.blocks.filter((b) => b.needs_person).map((b) => `${d.rel} › ${b.name}`));
  const firstBlock = wb.workflows.docs.flatMap((d) => d.blocks.map((b) => ({ doc: d.rel, block: b.name })))[0];
  const lastOp = wb.jobs.find((j) => j.operation)?.operation ?? null;
  const homeNext: WorkspaceAction = !routeReady
    ? act(1, 'Set up chat: an OpenRouter key or a local model', 'timmy setup', { primary: true, effect: 'local change' })
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
    chat: [
      act(1, 'Send a message', 'type in Chat, then Enter', { primary: routeReady, enabled: routeReady, effect: 'network', ...(routeReady ? {} : { why: 'no chat route: timmy setup' }) }),
      act(2, 'Choose the model', '/model'),
      act(3, 'Stop the turn', 'Esc in the composer', { enabled: false, why: 'only while a turn runs' }),
      act(4, 'Show it in the companion', 'timmy watch'),
    ],
    workflows: [
      firstBlock
        ? act(1, `Run ${firstBlock.doc} › ${firstBlock.block}`, `/run ${firstBlock.doc} ${firstBlock.block}`, { primary: waiting === 0 && running === 0, effect: 'local change' })
        : act(1, 'Start a workflow document', '/workflows', { primary: running === 0 }),
      act(2, blocked.length ? `Review what needs you (${blocked.length})` : 'Review the last run', lastOp ? `/op ${lastOp}` : '/ops', { primary: waiting > 0 && running === 0 }),
      act(3, 'Stop current', '/stop', { enabled: stop.job !== null, ...(stop.job ? {} : { why: 'nothing runs' }) }),
      act(4, 'Receipts of this project', '/receipts'),
    ],
    studio: [
      act(1, 'Open Studio', '/studio', { primary: true, effect: 'local change' }),
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

/** The frame. Reads the records only; the same inputs give the same revision. */
export async function buildWorkspaceFrame(d: StateDeps & { now?: number } = {}): Promise<WorkspaceFrame> {
  const env = d.env ?? process.env;
  const cwd = d.cwd ?? process.cwd();
  const now = d.now ?? Date.now();
  const wb = await workbenchJson(d);
  const unknown: WorkspaceFrame['unknown'] = [];
  const connections = connectionsOf(env, cwd, wb, now, unknown);
  const settings = readWorkbenchSettings(env).settings;
  const surface = (id: 'companion' | 'studio', openAtStart: boolean) => {
    const c = connections.find((x) => x.id === id);
    const running = c?.state === 'live';
    return { openAtStart, url: running ? (id === 'studio' ? studioBaseUrl(env) : companionBaseUrl(env)) : null, state: running ? 'running' as const : c?.observedAt ? 'not running' as const : 'unknown' as const };
  };
  const log: WorkspaceLogEntry[] = wb.events.slice(0, LOG_MAX).map((e) => ({
    at: e.at, tag: e.output ? 'job.output' : e.job ? 'job' : 'event', words: e.words, tone: tone(e),
    ...(e.operation ? { operation: e.operation } : {}), source: e.job ? `job ${e.job}` : e.key,
  }));
  if (!log.length) unknown.push({ field: 'log', why: 'no job has run in this project yet' });
  const body = {
    schema: WORKSPACE_SCHEMA, version: WORKSPACE_VERSION,
    project: { id: wb.project.id, name: wb.project.name, shown: wb.project.shown, chosen: wb.project.chosen, switch: '/project <name>', create: '/project new <name>' },
    tabs: TABS.map((t) => ({ id: t.id, key: t.key, label: t.label, refs: t.refs, waiting: t.id === 'control' || t.id === 'home' ? wb.activity.waiting_on_you : 0 })),
    actions: actionsOf(wb),
    connections,
    activity: { running: wb.activity.running, waitingOnYou: wb.activity.waiting_on_you, stopCurrent: wb.activity.stop_current },
    log,
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
  if (or === 'accepted') checks.openrouter = { answer: 'accepted', at: stamp(), detail: 'the key endpoint took the key' };
  else if (or === 'rejected') checks.openrouter = { answer: 'refused', at: stamp(), detail: 'the key endpoint rejected the key' };
  else if (or === 'unreachable') checks.openrouter = { answer: 'no answer', at: stamp(), detail: 'the key endpoint did not answer' };
  else delete checks.openrouter;
  const ollama = d.ollama ?? (async () => (await import('../agent/providers.js')).probeOllama());
  const ol = await ollama();
  checks.ollama = ol.ok
    ? { answer: 'accepted', at: stamp(), detail: `${ol.models.length} model${ol.models.length === 1 ? '' : 's'} listed` }
    : { answer: 'no answer', at: stamp(), detail: (ol.answer && 'why' in ol.answer ? String(ol.answer.why) : ol.answer?.state) ?? 'no answer' };
  const studio = d.studio ?? (async (u: string) => (await import('../studio/health.js')).studioHealth(u) as Promise<{ state: string; pageConnected?: boolean | null; detail?: string }>);
  const st = await studio(studioBaseUrl(env));
  checks.studio = st.state === 'running'
    ? { answer: 'accepted', at: stamp(), detail: st.pageConnected ? 'running, a page is open' : 'running' }
    : st.state === 'not-running' ? { answer: 'not running', at: stamp() } : { answer: 'no answer', at: stamp(), detail: st.detail ?? st.state };
  // the companion asks for its token on /api/auth: a 401 there is a companion answering; a refused connection, none started
  const companion = d.companion ?? (async (u: string): Promise<number | 'refused' | null> => {
    try { return (await fetch(`${u}api/auth`, { signal: AbortSignal.timeout(1500), redirect: 'manual' })).status; } catch (e) {
      const err = e as { cause?: { code?: string } };
      return err?.cause?.code === 'ECONNREFUSED' ? 'refused' : null;
    }
  });
  const cp = await companion(companionBaseUrl(env));
  checks.companion = cp === 401 || cp === 200 ? { answer: 'accepted', at: stamp(), detail: 'running' }
    : cp === 'refused' ? { answer: 'not running', at: stamp() }
    : { answer: 'no answer', at: stamp(), detail: cp === null ? 'nothing answered in time' : `HTTP ${cp}: another program may hold the port` };
  const edgeUrl = (() => { try { return edgeUrlOrNull(); } catch { return null; } })();
  if (edgeUrl) {
    const edge = d.edge ?? (async (u: string) => {
      try { return (await fetch(`${u.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(3000), redirect: 'manual' })).status; } catch { return null; }
    });
    const code = await edge(edgeUrl);
    checks.cloudflare = code === null ? { answer: 'no answer', at: stamp() } : code >= 200 && code < 300 ? { answer: 'accepted', at: stamp(), detail: `HTTP ${code}` } : { answer: 'refused', at: stamp(), detail: `HTTP ${code}` };
  } else delete checks.cloudflare;
  const record: ConnectionsRecord = { schema: CONNECTIONS_SCHEMA, checks };
  return { record, path: writeConnections(record, env) };
}
