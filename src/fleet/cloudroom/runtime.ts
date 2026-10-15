/**
 * Round R4 (H121): Timmy's fleet Runtime on one self-hosted Cloudroom Core — each worker is one Core session (a session
 * on a shared machine, never a VM), its task one prompt.
 *
 * What it keeps (the operator, 2026-10-15):
 *   - 202 is accepted, never completed. Each command carries its own request id, derived from Timmy's
 *     (cloudroomRequestId); a command that was not confirmed (a connection error, a timeout, a 503) is sent again
 *     with the SAME id a bounded number of times, never under a new one.
 *   - An `unknown` or `unknown_after_restart` receipt ends the worker as failed and is never resent.
 *   - Native records ride beside Timmy's events: each NativeEvent keeps Core's kind, data and native line in `data`
 *     (with the Core machine's own folder paths left out). Upstream "completed" is delivery, not verification.
 *   - Every child request is refused at once ({"error": CHILD_REFUSAL}), whatever the plan, because Timmy starts no
 *     sandboxes for children; so Core's no-answer fallback (the child running in this folder, and every spawn on the
 *     Core sharing its parent's folder for 5 minutes after) does not fire while Timmy is reading the stream. A child
 *     that starts in this folder anyway (`--shared-sandbox`, a harness's own managed child, or a missed answer) arrives
 *     as `child_thread` / `child` and becomes child.spawned {sharedWithParent: true}: detected, not prevented.
 *   - A dropped stream ends the iterator; the scheduler resumes from its persisted cursor.
 *   - No host-control bridge: nothing here runs a command on the Core machine (POST /v1/vm/run is not wrapped), and
 *     no sign-in is read or copied. Core serves no file contents: collect() returns the final assistant text and says
 *     where the work stays (the session's branch and commit on the Core machine), never the remote folder's path.
 */
import { createHash } from 'node:crypto';
import type { NativeEvent, Runtime, RuntimeCapabilities, SessionOpen, SessionState } from '../backend.js';
import { HARNESS_DEFAULT_MODEL } from '../plan.js';
import { redactString } from '../../utils/redact.js';
import { scrubHomes } from '../../utils/home-scrub.js';
import { CloudroomConnectionError, CloudroomError, HARNESSES, type CloudroomClient, type Harness, type Json, type SessionRecord } from './client.js';

/** Timmy's answer to every child request on the Core. */
export const CHILD_REFUSAL = "Timmy's fleet starts no sandboxes for children: this session is one worker of a Timmy fleet and does its task itself. Do not retry with --shared-sandbox: a child in this folder fails this worker.";
/** The reason a worker fails with when Core's receipt is unknown or unknown_after_restart. */
export const UNKNOWN_REASON = 'the runtime could not say whether the work ran (unknown); it is not resent';
/** R4 (lead): told to an agent whose plan allows no children (a request, not enforcement: see open()). */
export const NO_CHILDREN_NOTE = "This session is one worker of a Timmy fleet: do its task yourself, in this folder. Do not start child threads (room-cli thread spawn) or subagents; a child request is refused, and a child started in this folder fails this worker.";
/** What stands in for a folder path on the Core machine wherever a record carries one. */
export const REMOTE_PATH = '[a path on the Core machine; not kept]';

/**
 * A Timmy request id (e.g. "f645a0527:w001:a1:open") as a Cloudroom request id (1–64 of [A-Za-z0-9_-]): ":" becomes "_".
 * Deterministic, so a resent command carries the same id. Timmy's own ids hold no "_", which keeps that mapping one to
 * one; an id that holds one, or any other character, or that would run past 64 characters, ends in a hash of the whole
 * original instead.
 */
export function cloudroomRequestId(timmyId: string): string {
  if (!timmyId) throw new Error('a Cloudroom request id needs a Timmy request id');
  const plain = timmyId.replace(/:/g, '_');
  if (/^[A-Za-z0-9:-]{1,64}$/.test(timmyId)) return plain;
  const digest = createHash('sha256').update(timmyId).digest('hex').slice(0, 16);
  return `${plain.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 46)}_h${digest}`;
}
/** Core names a session "cr_" plus its start request's id. */
export const sessionIdFor = (startId: string): string => `cr_${startId}`;
export const startIdOf = (sessionId: string): string => (sessionId.startsWith('cr_') ? sessionId.slice(3) : sessionId);
/**
 * The first prompt's id, derived from the start's (already a Cloudroom id), so it is known again from the session id
 * alone: "<start id>_prompt", or a hashed form when that would pass 64 characters.
 */
export const promptIdFor = (startId: string): string => {
  const plain = `${startId}_prompt`;
  return plain.length <= 64 ? plain : cloudroomRequestId(`${startId}:prompt`);
};

type JsonObject = Record<string, Json>;
const obj = (v: Json | undefined): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
const str = (v: Json | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const said = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

/** A record's data with the Core machine's own folder paths left out (a workspace folder, a native history file). */
export function withoutRemotePaths(kind: string, data: Json): Json {
  const d = obj(data);
  if ((kind === 'workspace' || kind === 'native_identity') && typeof d.path === 'string') return { ...d, path: REMOTE_PATH };
  if (kind === 'receipt') {
    const ws = obj(d.workspace);
    if (typeof ws.path === 'string') return { ...d, workspace: { ...ws, path: REMOTE_PATH } };
  }
  return data;
}

/** The text of an assistant message in an item_completed record, whichever harness wrote it, or undefined. */
export function assistantItemText(data: Json): string | undefined {
  const d = obj(data);
  const text = str(d.text);
  if (text === undefined) return undefined;
  const type = str(d.item_type);
  if (type === 'text' || type === 'agentMessage') return text; // Claude Code; the ACP harnesses (Cursor, OpenCode, ...)
  if (type === undefined && str(d.method) === 'item/completed' && !d.tool_name) return text; // Codex: the item's own text
  return undefined;
}

/** The task prompt's assistant text, followed record by record: the last whole message, else the deltas of its turn. */
export class TextTrail {
  private deltas: string[] = [];
  private item: string | undefined;
  constructor(readonly promptId: string) {}
  add(rec: SessionRecord): void {
    const d = obj(rec.data);
    const forTask = (d.request_id === undefined || d.request_id === null || d.request_id === this.promptId);
    if (rec.kind === 'state' && str(d.state) === 'starting_turn' && d.request_id === this.promptId) { this.deltas = []; this.item = undefined; }
    else if (rec.kind === 'text_delta' && forTask && typeof d.delta === 'string') this.deltas.push(d.delta);
    else if (rec.kind === 'item_completed' && forTask) { const t = assistantItemText(rec.data); if (t !== undefined) this.item = t; }
  }
  value(): string { return this.item ?? this.deltas.join(''); }
}

const summaryOf = (text: string): string | undefined => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t ? (t.length > 200 ? `${t.slice(0, 199)}…` : t) : undefined;
};

/**
 * One Core record in Timmy's vocabulary (src/fleet/scheduler.ts judgeEvent), Core's kind, data and native line kept in
 * `data`. The task's prompt receipt ends the worker: completed → session.completed (delivered, not verified); failed,
 * unknown or unknown_after_restart → session.failed (an unknown one with UNKNOWN_REASON; nothing is resent);
 * interrupted → session.interrupted. A failed or process_lost session state → session.failed. child_thread, or a
 * child that started, → child.spawned in the parent's folder. Text deltas → message. Anything else keeps its kind.
 */
export function nativeEventOf(rec: SessionRecord, ctx: { startId: string; promptId: string }, summary?: string): NativeEvent {
  const data = withoutRemotePaths(rec.kind, rec.data);
  const core: Record<string, unknown> = { kind: rec.kind, data, ...(rec.native === undefined ? {} : { native: rec.native }) };
  const at = new Date(rec.timestamp_ms ?? Date.now()).toISOString();
  const ev = (type: string, extra: Record<string, unknown> = {}): NativeEvent => ({ seq: rec.sequence, type, at, data: { ...extra, ...core } });
  const d = obj(data);
  switch (rec.kind) {
    case 'receipt': {
      const id = str(d.request_id);
      const state = str(d.state);
      const command = str(d.command);
      const error = str(d.error);
      if (command === 'prompt' && id === ctx.promptId) {
        if (state === 'completed') return ev('session.completed', { summary: summary ?? "the task's prompt receipt says completed" });
        if (state === 'failed') return ev('session.failed', { reason: `the task's prompt failed${error ? `: ${error}` : ''}` });
        if (state === 'interrupted') return ev('session.interrupted');
        if (state === 'unknown' || state === 'unknown_after_restart') return ev('session.failed', { reason: UNKNOWN_REASON, receiptState: state, ...(error ? { receiptError: error } : {}) });
      }
      if (command === 'start' && id === ctx.startId) {
        if (state === 'completed') return ev('session.started', { harness: str(obj(d.input).harness) ?? 'codex', model: str(d.model) ?? '' });
        if (state === 'failed') return ev('session.failed', { reason: `the session did not start${error ? `: ${error}` : ''}; its harness never ran the task` });
        if (state === 'unknown' || state === 'unknown_after_restart') return ev('session.failed', { reason: UNKNOWN_REASON, receiptState: state });
      }
      return ev('receipt');
    }
    case 'state': {
      const state = str(d.state);
      const why = str(d.reason);
      if (state === 'failed' || state === 'process_lost') return ev('session.failed', { reason: `the Core says the session is ${state}${why ? `: ${why}` : ''}` });
      if (state === 'closed') return ev('session.closed');
      return ev('state');
    }
    case 'child_thread':
      return ev('child.spawned', { child: str(d.id) ?? '', sandbox: "the parent's folder", sharedWithParent: true, via: 'child_thread' });
    case 'child': {
      const state = str(d.state);
      if (state === 'completed' || state === 'failed') return ev('child'); // the end of a child already reported when it started
      return ev('child.spawned', { child: str(d.id) ?? '', sandbox: "the parent's folder", sharedWithParent: true, via: 'child' });
    }
    case 'text_delta':
      return ev('message', { role: 'assistant', text: str(d.delta) ?? '', delta: true });
    default:
      return ev(rec.kind);
  }
}

const PROMPT_FINAL = new Set(['completed', 'failed', 'interrupted', 'unknown', 'unknown_after_restart', 'cancelled']);

/** Timmy's session state from Core's session state and the task prompt's receipt state (null: Core has none). */
export function sessionStateOf(session: { state: string; current_request: string | null }, prompt: string | null, promptId: string): SessionState {
  if (prompt === 'completed') return 'completed';
  if (prompt === 'failed' || prompt === 'unknown' || prompt === 'unknown_after_restart') return 'failed';
  if (prompt === 'interrupted' || prompt === 'cancelled') return 'interrupted';
  const s = session.state;
  if (s === 'closed' || s === 'closing') return 'closed';
  if (s === 'failed' || s === 'process_lost') return 'failed';
  if (s === 'pending' || s === 'starting' || s === 'resuming' || s === 'waiting_for_files') return 'starting';
  if ((s === 'starting_turn' || s === 'running' || s === 'interrupting') && session.current_request === promptId) return 'running';
  if (prompt === 'delivered' || prompt === 'running') return 'running';
  if (prompt === 'accepted') return 'waiting';
  return 'unknown';
}

/** Worth sending again with the same id: the command may not have arrived, or Core could not save it (503). */
const unconfirmed = (e: unknown): boolean => e instanceof CloudroomConnectionError || (e instanceof CloudroomError && e.status === 503);
/** A drop: the stream may come back (a connection error, or a 5xx). */
const droppable = (e: unknown): boolean => e instanceof CloudroomConnectionError || (e instanceof CloudroomError && e.status !== null && e.status >= 500);
const authFailure = (e: unknown): boolean => e instanceof CloudroomError && (e.status === 401 || e.status === 403);
const NEVER = new AbortController().signal;

export interface CloudroomRuntimeOptions {
  client: CloudroomClient;
  /** Shown beside the runtime: FAKE for the FAKE Core, "not verified" for a real one until a live check passes. */
  label: string;
  mode: 'real' | 'fake';
  /** Tries for one command with the same id when it was not confirmed (default 4). */
  tries?: number;
  /** Pause before the next try, times the try number (default 150 ms). */
  retryDelayMs?: number;
  /** How long close() waits for a session that is still starting (default 30 s). */
  closeWaitMs?: number;
  /** Most event pages collect() reads (256 records each; default 4000). */
  maxPages?: number;
}

export class CloudroomRuntime implements Runtime {
  private caps: { flags: Set<string>; harnesses: string[] } | undefined;
  private capsError: string | undefined;
  /** The prompt each session's task now is (send() moves it on); the first prompt's id when this process sent none. */
  private readonly prompts = new Map<string, string>();
  private readonly drops = new Map<string, number>();
  private readonly trails = new Map<string, TextTrail>();

  constructor(private readonly opts: CloudroomRuntimeOptions) {}

  get client(): CloudroomClient { return this.opts.client; }

  /** Reads GET /v1/capabilities, so the synchronous capabilities() can answer; a failure is kept as the reason. */
  async refresh(signal?: AbortSignal): Promise<RuntimeCapabilities> {
    try {
      const raw = await this.client.capabilities(signal);
      const flags = new Set(Object.entries(raw).filter(([, v]) => v === true).map(([k]) => k));
      const harnesses = Array.isArray(raw.harnesses)
        ? raw.harnesses.map((h) => (h && typeof h === 'object' && typeof (h as { id?: unknown }).id === 'string' ? (h as { id: string }).id : '')).filter(Boolean)
        : [];
      this.caps = { flags, harnesses };
      this.capsError = undefined;
    } catch (e) {
      this.caps = undefined;
      this.capsError = `the Core's capabilities could not be read: ${said(e)}`;
    }
    return this.capabilities();
  }

  /** The Core's capability flags as last read (empty before refresh()). */
  flags(): string[] { return [...(this.caps?.flags ?? [])].sort(); }

  capabilities(): RuntimeCapabilities {
    const base = { runtime: 'cloudroom', label: this.opts.label };
    const c = this.caps;
    if (!c) {
      return {
        ...base, available: false,
        unavailableReason: this.capsError ?? "the Core's capabilities have not been read yet (refresh() reads GET /v1/capabilities)",
        sessions: false, messages: false, events: false, status: false, queue: false, interrupt: false, close: false, recover: false,
        childSpawn: 'may-share-parent', harnesses: [],
      };
    }
    // Sessions, prompts, the event stream, status, the queue, interrupt, close and the recovery check are Core's base
    // API (docs/api.md); child threads and a harness's own subagents are flags, and a missing flag means unavailable.
    return {
      ...base, available: true, sessions: true, messages: true, events: true, status: true, queue: true, interrupt: true, close: true, recover: true,
      childSpawn: c.flags.has('child_threads') || c.flags.has('subagents') ? 'may-share-parent' : 'none',
      harnesses: c.harnesses,
    };
  }

  private currentPrompt(sessionId: string): string {
    return this.prompts.get(sessionId) ?? promptIdFor(startIdOf(sessionId));
  }

  /** Runs one command, resent with the same request id while it is unconfirmed, a bounded number of times. */
  private async sameId<T>(what: string, requestId: string, call: () => Promise<T>): Promise<T> {
    const tries = this.opts.tries ?? 4;
    for (let i = 1; ; i++) {
      try {
        return await call();
      } catch (e) {
        if (!unconfirmed(e)) throw e;
        if (i >= tries) {
          throw new CloudroomError(`${what} ${requestId} was not confirmed after ${tries} tries with that same request id (${said(e)}); its outcome is unknown, and it was not sent under another id`);
        }
        await sleep((this.opts.retryDelayMs ?? 150) * i);
      }
    }
  }

  /** A read, tried again on a connection error or a 5xx (reads have no side effects). */
  private async read<T>(call: () => Promise<T>): Promise<T> {
    const tries = this.opts.tries ?? 4;
    for (let i = 1; ; i++) {
      try {
        return await call();
      } catch (e) {
        if (!droppable(e) || i >= tries) throw e;
        await sleep((this.opts.retryDelayMs ?? 150) * i);
      }
    }
  }

  /** Starts the session (its start id derived from `requestId`) and sends the task as its first prompt (its own id). */
  async open(_computeId: string, task: { harness: string; model: string; prompt: string; allowChildren: boolean }, requestId: string): Promise<SessionOpen> {
    if (!(HARNESSES as readonly string[]).includes(task.harness)) throw new CloudroomError(`Cloudroom Core has no "${task.harness}" harness`);
    const startId = cloudroomRequestId(requestId);
    const sessionId = sessionIdFor(startId);
    const promptId = promptIdFor(startId);
    // R4 (lead): the plan's "the harness default" is Timmy's words, not a model id: Core is then given no model. Without
    // children, the agent is also told not to start any; that is a request, not enforcement (every child request is
    // refused, and a child that starts in this folder anyway fails the worker)
    const model = task.model && task.model !== HARNESS_DEFAULT_MODEL ? task.model : undefined;
    const startOptions = { ...(model ? { model } : {}), ...(task.allowChildren ? {} : { system_prompt: NO_CHILDREN_NOTE }) };
    const started = await this.sameId('start', startId, () => this.client.start(startId, task.harness as Harness, startOptions));
    if (started.session_id !== sessionId) throw new CloudroomError(`the Core named the session ${started.session_id}, not ${sessionId}`);
    try {
      await this.sameId('prompt', promptId, () => this.client.prompt(sessionId, promptId, task.prompt));
    } catch (e) {
      // The task was refused or is unconfirmed: it is not sent again under another id, and the session is closed so a
      // prompt that did land cannot run unwatched.
      const closed = await this.closeCore(sessionId, cloudroomRequestId(`${requestId}:close-unprompted`)).then(
        (r) => (r === 'accepted' ? 'the session was closed' : 'the session had already ended'),
        (c) => `closing the session failed too: ${said(c)}`,
      );
      throw new CloudroomError(`the task's prompt was not accepted: ${said(e)}; ${closed}`, e instanceof CloudroomError ? e.status : null);
    }
    this.prompts.set(sessionId, promptId);
    return { sessionId, accepted: true };
  }

  async send(sessionId: string, text: string, requestId: string): Promise<{ accepted: true }> {
    const id = cloudroomRequestId(requestId);
    await this.sameId('prompt', id, () => this.client.prompt(sessionId, id, text));
    this.prompts.set(sessionId, id);
    return { accepted: true };
  }

  async *events(sessionId: string, afterSeq: number, signal?: AbortSignal): AsyncIterable<NativeEvent> {
    const promptId = this.currentPrompt(sessionId);
    const ctx = { startId: startIdOf(sessionId), promptId };
    const drops = this.drops.get(sessionId) ?? 0;
    if (drops > 0) await sleep(Math.min(100 * 2 ** (drops - 1), 2000), signal); // a dropping Core gets a little room
    if (signal?.aborted) return;
    let trail = this.trails.get(sessionId);
    if (!trail || trail.promptId !== promptId) { trail = new TextTrail(promptId); this.trails.set(sessionId, trail); }
    try {
      for await (const rec of this.client.stream(sessionId, { after: afterSeq, signal: signal ?? NEVER })) {
        this.drops.set(sessionId, 0);
        trail.add(rec);
        yield rec.kind === 'child_request' ? await this.refuseChild(sessionId, rec, ctx) : nativeEventOf(rec, ctx, summaryOf(trail.value()));
      }
      this.drops.set(sessionId, (this.drops.get(sessionId) ?? 0) + 1); // Core's stream never ends by itself: a drop
    } catch (e) {
      if (signal?.aborted) return;
      if (droppable(e)) {
        this.drops.set(sessionId, (this.drops.get(sessionId) ?? 0) + 1);
        return; // the scheduler resumes from its persisted cursor
      }
      throw e;
    }
  }

  /** Answers a child request with a refusal at once, and says how that went. Answered before the record counts as read. */
  private async refuseChild(sessionId: string, rec: SessionRecord, ctx: { startId: string; promptId: string }): Promise<NativeEvent> {
    const base = nativeEventOf(rec, ctx);
    const id = str(obj(rec.data).id);
    const started = Date.now();
    let answer: Record<string, unknown>;
    if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
      answer = { sent: false, words: 'the child request carries no usable id, so no answer could be sent; if it runs, it runs in this folder and its record follows' };
    } else {
      try {
        for (let i = 1; ; i++) {
          try {
            await this.client.answerChild(sessionId, id, { error: CHILD_REFUSAL });
            break;
          } catch (e) {
            if (!(e instanceof CloudroomConnectionError) || i >= 3) throw e;
            await sleep(200 * i);
          }
        }
        answer = { sent: true, status: 202, ms: Date.now() - started, words: 'refused at once: Core fails the spawn (409) and does not start the child in this folder' };
      } catch (e) {
        const status = e instanceof CloudroomError ? e.status : null;
        answer = {
          sent: false, status, ms: Date.now() - started,
          words: status === 404
            ? 'Core no longer knows this request (its wait ended, or an answer was already applied); if its wait ended, the child runs in this folder and a child_thread record follows'
            : status === 409
              ? "Core says the request already ended: the child runs in the parent's folder, and a child_thread record follows"
              : `the refusal could not be sent: ${said(e)}`,
        };
      }
    }
    return { ...base, type: 'child.refused', data: { child: id ?? '', refusal: CHILD_REFUSAL, answer, ...base.data } };
  }

  private async state(sessionId: string): Promise<{ state: SessionState; lastSeq: number; core: string; prompt: string | null }> {
    const promptId = this.currentPrompt(sessionId);
    const session = await this.read(() => this.client.session(sessionId));
    const request = await this.read(() => this.client.requestState(sessionId, promptId));
    return { state: sessionStateOf(session, request.state, promptId), lastSeq: session.last_sequence, core: session.state, prompt: request.state };
  }

  /** What the Core says now. A Core that cannot be reached, or has no such session, is "unknown"; a refused token throws. */
  async status(sessionId: string): Promise<{ state: SessionState; lastSeq: number }> {
    try {
      const s = await this.state(sessionId);
      return { state: s.state, lastSeq: s.lastSeq };
    } catch (e) {
      if (authFailure(e)) throw e;
      return { state: 'unknown', lastSeq: 0 };
    }
  }

  /**
   * What the Core still knows about a session after Timmy lost track of it: undefined when it knows none (404). A
   * session Core suspended or put to sleep is "waiting" when its recovery check says its conversation can resume, else
   * "unknown". Nothing is resumed or resent here.
   */
  async recover(sessionId: string): Promise<{ state: SessionState; lastSeq: number } | undefined> {
    try {
      const s = await this.state(sessionId);
      let state = s.state;
      if ((s.core === 'suspended' || s.core === 'sleeping') && !PROMPT_FINAL.has(s.prompt ?? '')) {
        const check = await this.read(() => this.client.recovery(sessionId)).catch(() => undefined);
        state = check?.status === 'ready' ? 'waiting' : 'unknown';
      }
      return { state, lastSeq: s.lastSeq };
    } catch (e) {
      if (e instanceof CloudroomError && e.status === 404) return undefined;
      throw e;
    }
  }

  /**
   * Stops the task: an interrupt (its own id; the target is the task's prompt) when that prompt is the active turn; a
   * stop, which pauses the queue, when it is still queued, so it never starts (the close that follows fails it). When
   * the prompt has already ended, or the session has, there is nothing to stop.
   */
  async interrupt(sessionId: string, requestId: string): Promise<{ accepted: true }> {
    const target = this.currentPrompt(sessionId);
    const interruptId = cloudroomRequestId(requestId);
    const stopId = cloudroomRequestId(`${requestId}:stop`);
    for (let round = 1; round <= 3; round++) {
      const request = await this.read(() => this.client.requestState(sessionId, target)).catch(() => undefined);
      if (request?.state && PROMPT_FINAL.has(request.state)) return { accepted: true };
      const session = await this.read(() => this.client.session(sessionId)).catch((e: unknown) => (e instanceof CloudroomError && e.status === 404 ? null : undefined));
      if (session === null) return { accepted: true }; // the Core has no such session: nothing runs there
      if (session && ['closed', 'closing', 'failed', 'process_lost'].includes(session.state)) return { accepted: true };
      const active = session ? session.current_request === target : true;
      try {
        if (active) await this.sameId('interrupt', interruptId, () => this.client.interrupt(sessionId, interruptId, target));
        else await this.sameId('stop', stopId, () => this.client.stop(sessionId, stopId));
        return { accepted: true };
      } catch (e) {
        // 409: the prompt moved on (it started, ended, or another stop is pending): look again
        if (e instanceof CloudroomError && e.status === 409) continue;
        throw e;
      }
    }
    return { accepted: true };
  }

  /** Closes the session (its own id): the history stays on the Core; a prompt that never ran becomes failed there. */
  async close(sessionId: string, requestId: string): Promise<{ accepted: true }> {
    await this.closeCore(sessionId, cloudroomRequestId(requestId));
    return { accepted: true };
  }

  /** "accepted", or "nothing" when the session had already ended, is already closing, or is unknown to the Core. */
  private async closeCore(sessionId: string, id: string): Promise<'accepted' | 'nothing'> {
    const deadline = Date.now() + (this.opts.closeWaitMs ?? 30_000);
    for (;;) {
      try {
        await this.sameId('close', id, () => this.client.close(sessionId, id));
        return 'accepted';
      } catch (e) {
        const detail = e instanceof CloudroomError ? (e.detail ?? '') : '';
        if (e instanceof CloudroomError && e.status === 409 && /still starting/.test(detail) && Date.now() < deadline) {
          await sleep(100); // Core refuses a close while the session starts; the same id goes again once it has
          continue;
        }
        if (e instanceof CloudroomError && e.status === 409 && /process unavailable|pending close/.test(detail)) return 'nothing';
        if (e instanceof CloudroomError && e.status === 404) return 'nothing';
        throw e;
      }
    }
  }

  /**
   * The task's result as far as the Core can give it: the final assistant text (from the session's records, paged
   * 256 at a time; redacted) and where the work stays — the session's branch and commit on the Core machine. Core
   * serves no file contents, so no other file is collected; the remote folder's path is never kept.
   */
  async collect(sessionId: string): Promise<{ files: Array<{ path: string; bytes: number; sha256: string; content: Buffer }>; summary?: string }> {
    const trail = new TextTrail(this.currentPrompt(sessionId));
    const maxPages = this.opts.maxPages ?? 4000;
    let after = 0;
    let truncated = false;
    for (let pages = 0; ; pages++) {
      if (pages >= maxPages) { truncated = true; break; }
      const page = await this.read(() => this.client.eventsPage(sessionId, after));
      if (!page.length) break;
      for (const rec of page) trail.add(rec);
      after = page[page.length - 1].sequence;
    }
    const text = scrubHomes(redactString(trail.value()));
    let branch: string | null = null;
    let head: string | null = null;
    let unknownWhy: string | undefined;
    try {
      const ws = await this.read(() => this.client.sessionWorkspace(sessionId));
      branch = ws.branch; // ws.path is the Core machine's own folder: dropped here, never kept
      head = ws.head;
    } catch (e) {
      unknownWhy = `the Core did not say (${said(e)})`;
    }
    const where = unknownWhy
      ? `its branch and commit are unknown: ${unknownWhy}`
      : `branch ${branch ?? '(detached: no branch)'} at commit ${head ?? '(none yet)'}`;
    const note = `The work stays on the Cloudroom Core machine, in this session's folder: ${where}. Core serves no file contents, so Timmy collected only the final assistant text. Delivered by the runtime; not verified by Timmy.`;
    const finalText = text
      ? `${text}${text.endsWith('\n') ? '' : '\n'}`
      : `(no assistant text was recorded for this task${truncated ? ' in the pages read' : ''})\n`;
    const workspace = `${JSON.stringify({
      session: sessionId, branch, head, note,
      ...(truncated ? { truncated: `only the first ${maxPages} pages of records were read` } : {}),
      ...(this.opts.mode === 'fake' ? { simulation: 'FAKE Cloudroom Core: no repository exists; the branch and commit are made up' } : {}),
    }, null, 2)}\n`;
    const file = (p: string, s: string) => {
      const content = Buffer.from(s, 'utf8');
      return { path: p, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), content };
    };
    const summary = `${summaryOf(text) ?? 'no assistant text'} — the work stays on the Core machine (${where})`;
    return { files: [file('FINAL-MESSAGE.md', finalText), file('WORKSPACE.json', workspace)], summary };
  }
}
