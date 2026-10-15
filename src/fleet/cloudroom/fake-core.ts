/**
 * Round R4 (H121): a FAKE Cloudroom Core for offline tests and the offline slice — a node:http server on 127.0.0.1 with
 * a random port and a random token. Nothing here runs a harness, calls a model, starts a VM or reaches the network: a
 * scripted harness writes records the way Core 3949daa does (a state, text deltas, an item_completed and a receipt,
 * with small pauses), and every response says FAKE (an `X-Timmy-Fake` header, a `fake` field in each JSON body, an SSE
 * comment at the start of each stream).
 *
 * The subset Timmy's adapter uses, with Core's shapes and rules as read at 3949daa (docs/api.md, src/api/mod.rs,
 * src/session/mod.rs, state.rs, thread.rs; written here from those facts, not copied):
 *   - a bearer token on every request (or X-Cloudroom-Token), else 401 {"error":"unauthorized"};
 *   - commands answer 202 {session_id, receipt, saving}; a retried request id returns that receipt (its current state)
 *     and never repeats work; the same id with other content is 409 request_conflict;
 *   - one sequence for the whole journal, so a session's sequences are not contiguous; `GET .../events?after=N` pages
 *     at most 256 records; `GET .../stream?after=N` is SSE named `record`, its id the sequence, and never ends by itself;
 *   - interrupt only the active request (else 409); close refused while a session is `starting`; any command on a
 *     closed, failed or process_lost session refused; close fails queued prompts and cuts a running turn to `unknown`;
 *   - a child request (`room-cli thread spawn` without --shared-sandbox) is recorded and waits for the app's answer
 *     (Core: 60 s); an {"error"} answer fails the spawn; no answer runs the child IN THE PARENT'S FOLDER (a child_thread
 *     record), and for the next 5 minutes every spawn on this Core shares its parent's folder without asking; an error
 *     answer is not remembered, so a repeated one gets 404, as in Core.
 *
 * Simplified on purpose (it is a test double): models are not checked against a catalog, child sessions are not
 * simulated (only the parent's child_thread record), no database, no sleep, no restart, no rewind, no attachments.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_CORE_LABEL = 'FAKE Cloudroom Core (simulation: an in-process server on 127.0.0.1; no harness runs, no model is called, no VM exists)';

/** The flags Core 3949daa's GET /v1/capabilities sets to true (src/lib.rs FEATURES). */
export const CORE_FEATURES_3949DAA: readonly string[] = [
  'stop', 'resume', 'launch_settings', 'prompt_reasoning', 'workspaces', 'sync', 'mcp_sync', 'direct_workspaces', 'root_workspace',
  'teleport', 'command_guard', 'strip_ai_co_authors', 'system_prompt', 'computer_use', 'codex_auth', 'codex_auth_import', 'cursor_auth',
  'claude_auth', 'pi_auth_import', 'pi_setup', 'structured_prompt', 'queue_edit', 'queue_cancel', 'queue_reorder', 'steer', 'rewind', 'fork',
  'side_chat', 'attachments', 'upload_parts', 'compact', 'goal', 'usage', 'subagents', 'child_threads', 'session_list', 'drain', 'terminals',
  'files_wait',
];

/** Core's own waits for a child request (src/session/thread.rs APP_WAIT, APP_MISSED_FOR). */
export const CORE_CHILD_WAIT_MS = 60_000;
export const CORE_CHILD_MISSED_FOR_MS = 300_000;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** What one session's scripted harness does wrong, on purpose. */
export interface FakeSessionFaults {
  /** The first event stream of this session is cut (its socket destroyed) after this many records were sent on it. */
  dropStreamAfter?: number;
  /** The agent asks for a child in its own sandbox (`room-cli thread spawn`, no --shared-sandbox) during its turn. */
  childRequest?: boolean;
  /** The agent starts a child with --shared-sandbox: it runs in this folder at once (a child_thread record). */
  sharedChild?: boolean;
  /** After a child (either kind) the turn pauses this long before going on, so an interrupt can land while it runs. */
  holdAfterChildMs?: number;
  /** The prompt's receipt ends unknown (or unknown_after_restart): nobody can say whether the turn ran. */
  unknownReceipt?: 'unknown' | 'unknown_after_restart';
  /** The prompt's receipt ends failed with this error. */
  failPrompt?: string;
  /** The first N prompt requests get 503 storage_unavailable (nothing is recorded; Core says retry the same id). */
  prompt503?: number;
  /** The first N start requests get 503 storage_unavailable. */
  start503?: number;
  /** The start is accepted at once but its 202 is sent this late (for the first `slowAcceptTimes` replies). */
  slowAcceptMs?: number;
  slowAcceptTimes?: number;
  /** A text delta, and the final message, carry this text (for redaction tests). */
  leakText?: string;
  /** How many text deltas the turn writes (default 2). */
  deltas?: number;
  /** This session's pause between records, in ms (default: the core's). */
  stepDelayMs?: number;
}

export interface FakeCoreOptions {
  /** Default: a random FAKE token made now (never written anywhere). */
  token?: string;
  /** Capability flags set to true (default: Core 3949daa's). */
  features?: readonly string[];
  harnesses?: Array<{ id: string; model: string }>;
  /** Pause between scripted records (default 2 ms). */
  stepDelayMs?: number;
  /** How long a child request waits for the app's answer (Core: 60 s). */
  childAnswerWindowMs?: number;
  /** After a missed child request, how long every spawn shares its parent's folder without asking (Core: 5 min). */
  missedForMs?: number;
  /** SSE keep-alive comment interval (Core: axum's default, 15 s). */
  keepAliveMs?: number;
  /** Faults for one session; `worker` is read from a Timmy-made session id ("..._w001_..."), when it has one. */
  faults?: (s: { sessionId: string; worker?: number }) => FakeSessionFaults | undefined;
}

export interface FakeCall {
  method: string;
  path: string;
  status: number;
  at: number;
  /** The parsed JSON body of a POST (prompt text included); never the token. */
  body?: Record<string, unknown>;
}

interface Receipt {
  request_id: string;
  command: string;
  input: Json;
  state: string;
  model?: string;
  provider?: string;
  workspace?: { id: string; path: string };
  error?: string;
}

interface CoreRecord {
  sequence: number;
  session_id: string;
  kind: string;
  timestamp_ms: number;
  data: Json;
  native?: string;
}

interface Turn {
  request: string;
  interruptedBy?: string;
  closedBy?: string;
}

interface FSession {
  id: string;
  n: number;
  worker?: number;
  harness: string;
  model: string;
  state: string;
  native_id: string | null;
  current_request: string | null;
  current_turn: string | null;
  receipts: Map<string, Receipt>;
  queue: string[];
  queue_paused: boolean;
  close_request: string | null;
  interrupting: boolean;
  ready: boolean;
  workspace: { id: string; path: string };
  records: CoreRecord[];
  subscribers: Set<(r: CoreRecord) => void>;
  faults: FakeSessionFaults;
  turn?: Turn;
  streamDropped: boolean;
  slowReplies: number;
  prompt503: number;
  closedAt?: number;
}

/** A FAKE Core's records, for tests. */
export interface FakeCore {
  url: string;
  /** The FAKE bearer token (random unless given); tests check it never reaches a stored file or an error. */
  token: string;
  label: string;
  /** Every request, in order. */
  calls: FakeCall[];
  /** Child requests the scripted agents made, and when. */
  childRequests: Array<{ sessionId: string; id: string; at: number }>;
  /** Answers the app sent to child requests, and what this FAKE said back. */
  childAnswers: Array<{ sessionId: string; id: string; body: Record<string, unknown>; at: number; status: number }>;
  /** Children that ran in their parent's folder because nobody answered in time (should stay 0 with Timmy). */
  fallbacks: () => number;
  sessionIds: () => string[];
  /** A session's records, in order (a copy). */
  records: (sessionId: string) => Array<Record<string, unknown>>;
  receipt: (sessionId: string, requestId: string) => Record<string, unknown> | undefined;
  sessionState: (sessionId: string) => string | undefined;
  /** Most sessions open (started, not yet closed) at once. */
  peakOpen: () => number;
  openNow: () => number;
  setReady: (ready: boolean) => void;
  close: () => Promise<void>;
}

const VALID_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const FINAL = new Set(['completed', 'interrupted', 'failed', 'unknown_after_restart']);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const workerOf = (sessionId: string): number | undefined => {
  const m = /_w(\d{3})_/.exec(sessionId);
  return m ? Number(m[1]) : undefined;
};

/** Core's code for a conflict message (src/api/mod.rs, the subset these routes can give). */
function codeOf(message: string): string {
  if (message === 'request_id already has different content' || message === 'session already exists') return 'request_conflict';
  if (message === 'harness is not configured') return 'harness_not_configured';
  if (message === 'invalid model') return 'invalid_model';
  return 'request_rejected';
}

export async function startFakeCore(options: FakeCoreOptions = {}): Promise<FakeCore> {
  const token = options.token ?? `FAKE-core-${randomBytes(9).toString('hex')}`;
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error('FAKE: the token must be visible ASCII');
  const features = options.features ?? CORE_FEATURES_3949DAA;
  const harnesses = options.harnesses ?? [{ id: 'codex', model: 'fake-codex-model' }, { id: 'claude-code', model: 'fake-claude-model' }, { id: 'pi', model: 'fake-pi-model' }];
  const stepMs = options.stepDelayMs ?? 2;
  const windowMs = options.childAnswerWindowMs ?? CORE_CHILD_WAIT_MS;
  const missedForMs = options.missedForMs ?? CORE_CHILD_MISSED_FOR_MS;
  const keepAliveMs = options.keepAliveMs ?? 15_000;
  const sessions = new Map<string, FSession>();
  const calls: FakeCall[] = [];
  const childRequests: FakeCore['childRequests'] = [];
  const childAnswers: FakeCore['childAnswers'] = [];
  const pendingChildren = new Map<string, (answer: { thread?: string; error?: string } | undefined) => void>();
  const childOutcomes = new Map<string, { started?: string; here?: number }>();
  const timers = new Set<NodeJS.Timeout>();
  const streams = new Set<http.ServerResponse>();
  /** start503 faults left, by session id (a refused start records nothing, so no session holds the count). */
  const start503Left = new Map<string, number>();
  let sequence = 0;
  let sessionsMade = 0;
  let childKeys = 0;
  let fallbackCount = 0;
  let appMissedAt: number | undefined;
  let ready = true;
  let stopped = false;
  let peak = 0;

  const openNow = () => [...sessions.values()].filter((s) => s.closedAt === undefined).length;
  const saving = (): Json => ({ locally_recorded_through: sequence, externally_saved_through: sequence, pending_records: 0, last_upload_succeeded: true });
  const pause = (ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(() => { timers.delete(t); resolve(); }, ms);
    timers.add(t);
  });

  /** Appends one record to the journal (the next global sequence) and applies it, as Core's Local::append does. */
  function append(s: FSession, kind: string, data: Json, native?: string): CoreRecord {
    const rec: CoreRecord = { sequence: ++sequence, session_id: s.id, kind, timestamp_ms: Date.now(), data, ...(native === undefined ? {} : { native }) };
    s.records.push(rec);
    if (kind === 'state' && data && typeof data === 'object' && !Array.isArray(data)) {
      s.state = String(data.state);
      s.current_request = typeof data.request_id === 'string' ? data.request_id : null;
      s.current_turn = typeof data.turn_id === 'string' ? data.turn_id : null;
      if (s.state === 'closed' && s.closedAt === undefined) s.closedAt = Date.now();
    }
    if (kind === 'receipt') {
      const r = data as unknown as Receipt;
      s.receipts.set(r.request_id, { ...r });
    }
    for (const notify of [...s.subscribers]) notify(rec);
    return rec;
  }

  function finishReceipt(s: FSession, request: string, state: string, error?: string): void {
    const r = s.receipts.get(request);
    if (!r || FINAL.has(r.state) || r.state === state) return;
    append(s, 'receipt', { ...r, state, ...(error ? { error } : {}) } as unknown as Json);
  }

  const turnText = (s: FSession, i: number) => `FAKE output ${i} from ${s.harness} in session ${s.id}. `;

  async function launch(s: FSession, startId: string): Promise<void> {
    const step = s.faults.stepDelayMs ?? stepMs;
    await pause(step);
    if (stopped) return;
    if (s.close_request) { closeNow(s, s.close_request); return; } // closed while pending: no harness ever starts
    append(s, 'state', { state: 'starting' });
    await pause(step);
    if (stopped) return;
    append(s, 'harness', { pid: 40_000 + s.n });
    await pause(step);
    if (stopped) return;
    s.native_id = `fake-native-${s.n}`;
    append(s, 'native_identity', { id: s.native_id, model: s.model, provider: null, capabilities: { resume: true, interrupt: true, steer: true, subagents: true } });
    s.ready = true;
    append(s, 'state', { state: 'idle' });
    finishReceipt(s, startId, 'completed');
    if (s.close_request) { closeNow(s, s.close_request); return; }
    advance(s);
  }

  function advance(s: FSession): void {
    if (stopped || !s.ready || s.turn || s.close_request || s.queue_paused || s.state !== 'idle') return;
    const next = s.queue[0];
    if (next) void runTurn(s, next);
  }

  /** Ends a turn that an interrupt or a close cut; true when the turn must stop now. */
  function cut(s: FSession, turn: Turn): boolean {
    if (stopped) return true;
    if (turn.closedBy) {
      finishReceipt(s, turn.request, 'unknown', 'FAKE: the session was closed while this turn ran; nobody can say how far it got');
      s.turn = undefined;
      closeNow(s, turn.closedBy);
      return true;
    }
    if (turn.interruptedBy) {
      finishReceipt(s, turn.request, 'interrupted');
      finishReceipt(s, turn.interruptedBy, 'completed');
      s.turn = undefined;
      s.interrupting = false;
      append(s, 'state', { state: 'idle' });
      advance(s);
      return true;
    }
    return false;
  }

  async function runTurn(s: FSession, request: string): Promise<void> {
    const f = s.faults;
    const step = f.stepDelayMs ?? stepMs;
    const turn: Turn = { request };
    s.turn = turn;
    s.queue = s.queue.filter((q) => q !== request);
    const turnId = `fake-turn-${s.n}-${s.records.length}`;
    append(s, 'state', { state: 'starting_turn', request_id: request });
    await pause(step);
    if (cut(s, turn)) return;
    finishReceipt(s, request, 'delivered');
    append(s, 'state', { state: 'running', request_id: request, turn_id: turnId });
    const itemId = `fake-item-${s.n}`;
    const words: string[] = [];
    const delta = (text: string) => {
      words.push(text);
      append(s, 'text_delta', { harness: s.harness, request_id: request, item_id: itemId, delta: text }, JSON.stringify({ fake: true, type: 'text_delta', delta: text }));
    };
    for (let i = 1; i <= (f.deltas ?? 2); i++) {
      await pause(step);
      if (cut(s, turn)) return;
      delta(turnText(s, i));
    }
    if (f.leakText) delta(f.leakText);
    if (f.sharedChild) {
      const key = `fakechild${++childKeys}`;
      spawnHere(s, key, 'the agent asked for --shared-sandbox');
      delta(`FAKE: room-cli thread spawn --shared-sandbox started cr_child_${key} in this sandbox and folder. `);
      if (f.holdAfterChildMs) await pause(f.holdAfterChildMs);
      if (cut(s, turn)) return;
    }
    if (f.childRequest) {
      const said = await childRequest(s);
      if (said) delta(said);
      if (f.holdAfterChildMs) await pause(f.holdAfterChildMs);
      if (cut(s, turn)) return;
    }
    await pause(step);
    if (cut(s, turn)) return;
    const full = words.join('');
    append(s, 'item_completed', { harness: s.harness, request_id: request, item_id: itemId, item_type: 'agentMessage', text: full }, JSON.stringify({ fake: true, type: 'item_completed', text: full }));
    append(s, 'checkpoint', { kind: 'turn', id: turnId, request_id: request });
    if (f.unknownReceipt) finishReceipt(s, request, f.unknownReceipt, 'FAKE: the harness went away while this turn was dispatched; nobody can say whether it ran');
    else if (f.failPrompt) finishReceipt(s, request, 'failed', f.failPrompt);
    else finishReceipt(s, request, 'completed');
    s.turn = undefined;
    append(s, 'state', { state: 'idle' });
    advance(s);
  }

  /** A child in the parent's folder: Core's spawn_child records `child_thread` on the parent. */
  function spawnHere(s: FSession, key: string, _why: string): void {
    append(s, 'child_thread', { id: `cr_child_${key}`, harness: s.harness, title: null });
  }

  /** room-cli thread spawn without --shared-sandbox: a child_request, then the app's answer or the fallback. */
  async function childRequest(s: FSession): Promise<string> {
    const key = `fakechild${++childKeys}`;
    const id = `own_${key}`;
    const slot = `${s.id}/${id}`;
    if (appMissedAt !== undefined && Date.now() - appMissedAt < missedForMs) {
      fallbackCount += 1;
      spawnHere(s, key, 'the app missed an earlier child request in the last minutes');
      return `FAKE: room-cli thread spawn started cr_child_${key} in this sandbox and folder; the app missed an earlier child request, so it was not asked. `;
    }
    const answer = new Promise<{ thread?: string; error?: string } | undefined>((resolve) => pendingChildren.set(slot, resolve));
    childRequests.push({ sessionId: s.id, id, at: Date.now() });
    append(s, 'child_request', { id, prompt: 'FAKE child task: run the tests in a sandbox of its own', title: 'FAKE child' });
    const timer = setTimeout(() => {
      timers.delete(timer);
      const resolve = pendingChildren.get(slot);
      if (resolve) {
        // decided once, in the same step that ends the wait (Core decides under its lock): a later answer gets 409
        pendingChildren.delete(slot);
        childOutcomes.set(slot, { here: Date.now() });
        appMissedAt = Date.now();
        resolve(undefined);
      }
    }, windowMs);
    timers.add(timer);
    const got = await answer;
    clearTimeout(timer);
    timers.delete(timer);
    if (stopped) return '';
    if (!got) {
      fallbackCount += 1;
      spawnHere(s, key, 'no answer in time');
      return `FAKE: room-cli thread spawn started cr_child_${key} in this sandbox and folder; the app did not answer in time. `;
    }
    if (got.thread) return `FAKE: room-cli thread spawn started ${got.thread} in its own sandbox. `;
    return `FAKE: room-cli thread spawn failed (409): The child could not start in its own sandbox: ${got.error ?? 'unknown error'}. `;
  }

  function closeNow(s: FSession, closeId: string): void {
    if (s.state === 'closed') return;
    append(s, 'state', { state: 'closed' });
    finishReceipt(s, closeId, 'completed');
  }

  function sessionJson(s: FSession): Json {
    return {
      session_id: s.id, teleport_output: false, harness: s.harness, capabilities: {}, native_cursor: null, provider: null, native_id: s.native_id,
      native_path: null, native_offset: 0, state: s.state, current_request: s.current_request, current_turn: s.current_turn, startup_error: null,
      startup_reason: null, last_sequence: s.records.length ? s.records[s.records.length - 1].sequence : 0,
      receipts: Object.fromEntries([...s.receipts].map(([k, v]) => [k, v as unknown as Json])), queue: s.queue, prompts: {}, storage_paused: false,
      queue_paused: s.queue_paused, compacting: false, rewind_request: null, parent_session: null, archived: false, reasoning: null,
      workspace: s.workspace,
    };
  }

  // ---------------------------------------------------------------- HTTP
  const reply = (res: http.ServerResponse, call: FakeCall, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    call.status = status;
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify({ ...body, fake: FAKE_CORE_LABEL }));
  };
  const conflict = (res: http.ServerResponse, call: FakeCall, message: string, status = 409) => reply(res, call, status, { error: message, code: codeOf(message) });
  const accepted = (res: http.ServerResponse, call: FakeCall, s: FSession, r: Receipt) => reply(res, call, 202, { session_id: s.id, receipt: r, saving: saving() });

  async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown> | 'too-large' | 'invalid'> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 64 * 1024) return 'too-large';
      chunks.push(chunk as Buffer);
    }
    if (!size) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : 'invalid';
    } catch { return 'invalid'; }
  }

  const authorized = (req: http.IncomingMessage): boolean => {
    const bearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    const custom = typeof req.headers['x-cloudroom-token'] === 'string' ? req.headers['x-cloudroom-token'] : undefined;
    return [bearer, custom].some((t) => t !== undefined && t.length === token.length && createHash('sha256').update(t).digest('hex') === createHash('sha256').update(token).digest('hex'));
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const call: FakeCall = { method, path: url.pathname + url.search, status: 0, at: Date.now() };
    calls.push(call);
    res.setHeader('X-Timmy-Fake', FAKE_CORE_LABEL);
    res.setHeader('Cache-Control', 'no-store');
    if (!authorized(req)) {
      for await (const _ of req) { /* drained, never read */ }
      return reply(res, call, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }
    let body: Record<string, unknown> = {};
    if (method === 'POST') {
      const got = await readBody(req);
      if (got === 'too-large') return reply(res, call, 413, { error: 'FAKE: request body over 64 KiB' });
      if (got === 'invalid') return reply(res, call, 400, { error: 'FAKE: the body is not a JSON object' });
      body = got;
      call.body = body;
    }
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'v1') return reply(res, call, 404, { error: 'FAKE: no such route' });
    if (method === 'GET' && parts.length === 2) {
      if (parts[1] === 'health') return reply(res, call, 200, { status: 'ready', saving: saving(), storage: { state: 'ok' } });
      if (parts[1] === 'ready') return reply(res, call, ready ? 200 : 503, { ready });
      if (parts[1] === 'capabilities') {
        const caps: Record<string, unknown> = {
          version: 1, repository: '/srv/fake-core/repository', previews: false, mac_access: false,
          harnesses: harnesses.map((h) => ({ id: h.id, model: h.model, provider: null })),
        };
        for (const f of features) caps[f] = true;
        return reply(res, call, 200, caps);
      }
      if (parts[1] === 'sessions') {
        const list = [...sessions.values()].sort((a, b) => (b.records.at(-1)?.sequence ?? 0) - (a.records.at(-1)?.sequence ?? 0)).slice(0, 1000).map((s) => ({
          session_id: s.id, harness: s.harness, model: s.model, provider: null, state: s.state, workspace: s.workspace, parent_session: null,
          current_request: s.current_request, queued: s.queue.length, last_sequence: s.records.at(-1)?.sequence ?? 0, last_activity_ms: s.records.at(-1)?.timestamp_ms ?? null,
        }));
        return reply(res, call, 200, { total: sessions.size, sessions: list });
      }
    }
    if (method === 'POST' && parts.length === 2 && parts[1] === 'sessions') return start(res, call, body);
    if (parts[1] !== 'sessions' || parts.length < 3) return reply(res, call, 404, { error: 'FAKE: no such route' });
    const s = sessions.get(parts[2]);
    if (!s) return reply(res, call, 404, { error: 'session not found', code: 'request_rejected' });
    if (method === 'GET') {
      if (parts.length === 3) return reply(res, call, 200, { session: sessionJson(s), saving: saving() });
      if (parts[3] === 'requests' && parts.length === 5) {
        if (!VALID_KEY.test(parts[4])) return conflict(res, call, 'request_id must be 1-64 ASCII letters, digits, underscores or hyphens');
        const r = s.receipts.get(parts[4]);
        return reply(res, call, 200, { archived: false, state: r ? r.state : null, error: r?.error ?? null });
      }
      if (parts[3] === 'workspace' && parts.length === 4) {
        const head = createHash('sha1').update(`fake-head:${s.id}`).digest('hex');
        return reply(res, call, 200, { path: s.workspace.path, branch: `fake/${s.id}`, head });
      }
      if (parts[3] === 'recovery' && parts.length === 4) {
        if (s.close_request || s.state === 'closed') return reply(res, call, 200, { status: 'unavailable', message: 'This session is closed or has saved history only' });
        if (s.native_id) return reply(res, call, 200, { status: 'ready', message: 'Saved conversation is available; the native resume handshake is still required' });
        return reply(res, call, 200, { status: 'unavailable', message: 'No saved native conversation identity is available' });
      }
      if (parts[3] === 'events' && parts.length === 4) {
        const after = Number(url.searchParams.get('after') ?? '0');
        if (!Number.isSafeInteger(after) || after < 0) return conflict(res, call, 'invalid replay cursor');
        return reply(res, call, 200, { events: s.records.filter((r) => r.sequence > after).slice(0, 256), saving: saving() });
      }
      if (parts[3] === 'stream' && parts.length === 4) return stream(req, res, call, s, url);
    }
    if (method === 'POST' && parts.length === 4) {
      const command = parts[3];
      if (command === 'prompts') return promptCommand(res, call, s, body);
      if (command === 'interrupt' || command === 'stop' || command === 'resume' || command === 'close') return otherCommand(res, call, s, command, body);
    }
    if (method === 'POST' && parts.length === 5 && parts[3] === 'children') return answerChild(res, call, s, parts[4], body);
    return reply(res, call, 404, { error: 'FAKE: no such route (the FAKE Core serves only what Timmy uses)' });
  }

  async function start(res: http.ServerResponse, call: FakeCall, body: Record<string, unknown>): Promise<void> {
    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    if (!VALID_KEY.test(requestId)) return conflict(res, call, 'request_id must be 1-64 ASCII letters, digits, underscores or hyphens');
    if (body.parent_session !== undefined || body.fork !== undefined || body.prompt !== undefined) {
      return conflict(res, call, 'FAKE: child threads and side chats are not simulated');
    }
    const harness = typeof body.harness === 'string' ? body.harness : 'codex';
    const id = `cr_${requestId}`;
    const { request_id: _r, ...input } = body;
    const existing = sessions.get(id);
    if (existing) {
      const r = existing.receipts.get(requestId);
      if (!r || r.command !== 'start' || !sameJson(r.input, input)) return conflict(res, call, 'request_id already has different content');
      if (existing.slowReplies > 0) {
        existing.slowReplies -= 1;
        await pause(existing.faults.slowAcceptMs ?? 0);
      }
      return accepted(res, call, existing, r);
    }
    const profile = harnesses.find((h) => h.id === harness);
    if (!profile) return conflict(res, call, 'harness is not configured');
    const model = body.model === undefined ? profile.model : body.model;
    if (typeof model !== 'string' || !model || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model)) return conflict(res, call, 'invalid model');
    const worker = workerOf(id);
    const faults = options.faults?.({ sessionId: id, worker }) ?? {};
    // A storage failure records nothing, so the same request id may come again (Core: retry with the same request_id).
    const start503 = start503Left.get(id) ?? faults.start503 ?? 0;
    if (start503 > 0) {
      start503Left.set(id, start503 - 1);
      return reply(res, call, 503, { error: 'storage unavailable (FAKE: the journal write failed); retry with the same request_id', code: 'storage_unavailable' });
    }
    const n = ++sessionsMade;
    const s: FSession = {
      id, n, worker, harness, model, state: 'pending', native_id: null, current_request: null, current_turn: null, receipts: new Map(), queue: [],
      queue_paused: false, close_request: null, interrupting: false, ready: false,
      workspace: { id: `fake-ws-${n}`, path: `/srv/fake-core/workspaces/${id}` }, records: [], subscribers: new Set(), faults, streamDropped: false,
      slowReplies: faults.slowAcceptMs ? (faults.slowAcceptTimes ?? 1) : 0, prompt503: faults.prompt503 ?? 0,
    };
    sessions.set(id, s);
    peak = Math.max(peak, openNow());
    const receipt: Receipt = { request_id: requestId, command: 'start', input: input as Json, state: 'accepted', model, workspace: s.workspace };
    append(s, 'receipt', receipt as unknown as Json);
    void launch(s, requestId);
    if (s.slowReplies > 0) {
      s.slowReplies -= 1;
      await pause(faults.slowAcceptMs ?? 0);
    }
    return accepted(res, call, s, s.receipts.get(requestId) ?? receipt);
  }

  /** Core's command checks, in Core's order (src/session/mod.rs Manager::command), for the commands Timmy sends. */
  function refusal(s: FSession, command: string, input: Record<string, unknown>): string | undefined {
    if (s.close_request || (command !== 'close' && s.interrupting)) return 'wait for the pending close or interrupt';
    if (command === 'close' && s.state === 'starting') return 'session is still starting';
    if (['closed', 'process_lost', 'failed'].includes(s.state)) return 'process unavailable; history does not restore execution';
    if (command === 'interrupt' && (!s.ready || !s.turn || s.current_request !== input.target_request_id)) return 'interrupt target is no longer the active request';
    return undefined;
  }

  function promptCommand(res: http.ServerResponse, call: FakeCall, s: FSession, body: Record<string, unknown>): void {
    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    if (!VALID_KEY.test(requestId)) return conflict(res, call, 'request_id must be 1-64 ASCII letters, digits, underscores or hyphens');
    const textIn = typeof body.text === 'string' ? body.text : '';
    if (!textIn.trim() || Buffer.byteLength(textIn) > 32768) return conflict(res, call, 'prompt must contain 1-32768 bytes of text');
    const input: Record<string, Json> = { text: textIn, ...(typeof body.reasoning === 'string' ? { reasoning: body.reasoning } : {}) };
    const existing = s.receipts.get(requestId);
    if (existing) {
      if (existing.command !== 'prompt' || !sameJson(existing.input, input)) return conflict(res, call, 'request_id already has different content');
      return accepted(res, call, s, existing);
    }
    if (s.prompt503 > 0) {
      s.prompt503 -= 1;
      return reply(res, call, 503, { error: 'storage unavailable (FAKE: the journal write failed); retry with the same request_id', code: 'storage_unavailable' });
    }
    const why = refusal(s, 'prompt', body);
    if (why) return conflict(res, call, why);
    const receipt: Receipt = { request_id: requestId, command: 'prompt', input, state: 'accepted' };
    append(s, 'receipt', receipt as unknown as Json);
    s.queue.push(requestId);
    advance(s);
    return accepted(res, call, s, receipt);
  }

  function otherCommand(res: http.ServerResponse, call: FakeCall, s: FSession, command: string, body: Record<string, unknown>): void {
    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    if (!VALID_KEY.test(requestId)) return conflict(res, call, 'request_id must be 1-64 ASCII letters, digits, underscores or hyphens');
    const input: Record<string, Json> = command === 'interrupt' ? { target_request_id: typeof body.target_request_id === 'string' ? body.target_request_id : '' } : {};
    if (command === 'interrupt' && !VALID_KEY.test(String(input.target_request_id))) return conflict(res, call, 'request_id must be 1-64 ASCII letters, digits, underscores or hyphens');
    const existing = s.receipts.get(requestId);
    if (existing) {
      if (existing.command !== command || !sameJson(existing.input, input)) return conflict(res, call, 'request_id already has different content');
      return accepted(res, call, s, existing);
    }
    const why = refusal(s, command, input);
    if (why) return conflict(res, call, why);
    const receipt: Receipt = { request_id: requestId, command, input, state: 'accepted' };
    append(s, 'receipt', receipt as unknown as Json);
    if (command === 'interrupt' && s.turn) {
      s.interrupting = true;
      s.turn.interruptedBy = requestId;
      append(s, 'state', { state: 'interrupting', request_id: s.current_request, turn_id: s.current_turn });
    } else if (command === 'stop') {
      s.queue_paused = true;
      if (s.turn) {
        s.interrupting = true;
        s.turn.interruptedBy = requestId;
        append(s, 'state', { state: 'interrupting', request_id: s.current_request, turn_id: s.current_turn });
      } else finishReceipt(s, requestId, 'completed');
    } else if (command === 'resume') {
      s.queue_paused = false;
      finishReceipt(s, requestId, 'completed');
      advance(s);
    } else if (command === 'close') {
      s.close_request = requestId;
      append(s, 'state', { state: 'closing', request_id: s.current_request, turn_id: s.current_turn });
      for (const queued of s.queue) finishReceipt(s, queued, 'failed', 'the session was closed before this prompt ran');
      s.queue = [];
      if (s.turn) s.turn.closedBy = requestId;
      else if (s.state !== 'pending') closeNow(s, requestId);
      // a session still pending is closed by its launch, before any harness starts (launch checks close_request)
    }
    return accepted(res, call, s, s.receipts.get(requestId) ?? receipt);
  }

  function answerChild(res: http.ServerResponse, call: FakeCall, s: FSession, id: string, body: Record<string, unknown>): void {
    const extra = Object.keys(body).filter((k) => k !== 'thread' && k !== 'error');
    const at = Date.now();
    const done = (status: number, payload: Record<string, unknown>) => {
      childAnswers.push({ sessionId: s.id, id, body, at, status });
      reply(res, call, status, payload);
    };
    if (extra.length) return done(422, { error: `FAKE: unknown field ${extra[0]}` });
    const slot = `${s.id}/${id}`;
    const waiting = pendingChildren.get(slot);
    if (waiting) {
      pendingChildren.delete(slot);
      if (typeof body.thread === 'string') childOutcomes.set(slot, { started: body.thread });
      waiting(typeof body.thread === 'string' ? { thread: body.thread } : { error: typeof body.error === 'string' ? body.error : 'unknown error' });
      return done(202, { accepted: true });
    }
    const outcome = childOutcomes.get(slot);
    if (outcome) {
      if (outcome.started !== undefined && outcome.started === body.thread) return done(202, { accepted: true });
      return done(409, { error: "This child request already ended: the child runs in the parent's sandbox" });
    }
    return done(404, { error: 'Unknown or expired child request' });
  }

  function stream(req: http.IncomingMessage, res: http.ServerResponse, call: FakeCall, s: FSession, url: URL): void {
    const header = req.headers['last-event-id'];
    let after: number;
    if (typeof header === 'string') {
      after = Number(header);
      if (!Number.isSafeInteger(after) || after < 0) return conflict(res, call, 'invalid Last-Event-ID');
    } else {
      after = Number(url.searchParams.get('after') ?? '0');
      if (!Number.isSafeInteger(after) || after < 0) return conflict(res, call, 'invalid replay cursor');
    }
    const last = s.records.at(-1)?.sequence ?? 0;
    if (after > last) return conflict(res, call, 'cursor exceeds session history');
    call.status = 200;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`: ${FAKE_CORE_LABEL}\n\n`);
    streams.add(res);
    let cursor = after;
    let sent = 0;
    let ended = false;
    const keepAlive = setInterval(() => { if (!ended) res.write(': keep-alive\n\n'); }, keepAliveMs);
    const end = () => {
      if (ended) return;
      ended = true;
      clearInterval(keepAlive);
      s.subscribers.delete(send);
      streams.delete(res);
    };
    function send(rec: CoreRecord): void {
      if (ended || rec.sequence <= cursor) return;
      res.write(`id: ${rec.sequence}\nevent: record\ndata: ${JSON.stringify(rec)}\n\n`);
      cursor = rec.sequence;
      sent += 1;
      const dropAt = s.faults.dropStreamAfter;
      if (dropAt !== undefined && !s.streamDropped && sent >= dropAt) {
        s.streamDropped = true;
        end();
        res.destroy(); // the connection drops mid-stream; the client resumes from its own cursor
      }
    }
    for (const rec of [...s.records]) send(rec);
    if (!ended) s.subscribers.add(send);
    res.on('close', end);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'FAKE: internal error', fake: FAKE_CORE_LABEL }));
      } else res.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    label: FAKE_CORE_LABEL,
    calls,
    childRequests,
    childAnswers,
    fallbacks: () => fallbackCount,
    sessionIds: () => [...sessions.keys()],
    records: (id) => (sessions.get(id)?.records ?? []).map((r) => JSON.parse(JSON.stringify(r)) as Record<string, unknown>),
    receipt: (id, request) => {
      const r = sessions.get(id)?.receipts.get(request);
      return r ? (JSON.parse(JSON.stringify(r)) as Record<string, unknown>) : undefined;
    },
    sessionState: (id) => sessions.get(id)?.state,
    peakOpen: () => peak,
    openNow,
    setReady: (r) => { ready = r; },
    close: async () => {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const resolve of pendingChildren.values()) resolve(undefined);
      pendingChildren.clear();
      for (const r of streams) r.destroy();
      streams.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
