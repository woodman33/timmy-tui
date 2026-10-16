/**
 * Adapted from Cloudroom Core, `integrations/bb/client.ts`, at revision 3949daaea3c7613458e9ad14afddbd267a0a56bc.
 * Licensed under the Apache License, Version 2.0; the license text is `LICENSE-cloudroom-core.txt` beside this file
 * (the core repository has no NOTICE file). The Cloudroom GUI at f939f4103c5a2946f03d85de37af94d1a58053fb carries a
 * byte-identical copy at `gui/apps/server/src/services/cloudroom/client.ts`; this file was adapted from the core's
 * copy, and nothing in it was taken from the GUI.
 *
 * Modified by Timmy (R4 H121): a client for one self-hosted Cloudroom Core, for Timmy's fleet adapter.
 *   Kept, adapted: the URL rules (https, or http on loopback only; no credentials, query or fragment), the token
 *   checks, the error classes, request / json / command, the receipt and record validators, the SSE stream parser,
 *   and health, ready, capabilities, listSessions, start, prompt, interrupt, stop, resume, close, session,
 *   sessionWorkspace, stream and answerChild.
 *   Added: requestState (GET /v1/sessions/{id}/requests/{request}), recovery (GET /v1/sessions/{id}/recovery) and
 *   eventsPage (GET /v1/sessions/{id}/events?after=N, at most 256 records a page).
 *   Changed: the token may be a function, called at each request (Timmy reads its 0600 file only then) and checked
 *   each time; it travels only in the Authorization header (the X-Cloudroom-Token copy and the gate cookie are gone);
 *   every error message is scrubbed of it. A timeout is a connection error (`timedOut`), told apart from the caller's
 *   own cancel, so an unconfirmed command can be retried with the same request id. An error keeps Core's own code and
 *   text (`coreCode`, `detail`) beside the message, never for 401/403. A receipt keeps Core's `error`. The rejection
 *   messages are Timmy's own words, for the codes the kept commands can return. `start` takes no child-thread or
 *   side-chat fields, and `prompt` no attachments or content blocks.
 *   Dropped: Teleport; accounts and logins (Codex, Claude, Cursor, Pi keys and setup); runOnVm (POST /v1/vm/run: a
 *   shell on the Core machine, a host-control bridge Timmy does not wrap); attachments and upload parts; Claude version
 *   matching; dashboard; workspace mappings; edit, cancel, reorder, steer, compact, goal, rewind, sleep, detach and
 *   secret answers; and the snapshot replay helper events() (eventsPage replaces it).
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Harness = 'codex' | 'pi' | 'cursor' | 'claude-code' | 'fx' | 'opencode' | 'hermes' | 'devin';
/** The harness ids Core 3949daa knows (`src/runtime/mod.rs` Kind). */
export const HARNESSES: readonly Harness[] = ['codex', 'pi', 'cursor', 'claude-code', 'fx', 'opencode', 'hermes', 'devin'];
export type Receipt = {
  request_id: string;
  command: string;
  state: string;
  input: Json;
  model?: string;
  provider?: string;
  workspace?: { id: string; path: string };
  error?: string;
};
export type Acceptance = { session_id: string; receipt: Receipt; saving: Json };
export type SessionRecord = {
  sequence: number;
  session_id: string;
  kind: string;
  data: Json;
  native?: string;
  timestamp_ms?: number;
};
export type Session = {
  session_id: string;
  harness: Harness;
  state: string;
  native_id: string | null;
  current_request: string | null;
  last_sequence: number;
  queue: string[];
  receipts: { [id: string]: Receipt };
};
export type SessionSummary = {
  session_id: string;
  harness: Harness;
  model: string | null;
  provider: string | null;
  state: string;
  workspace: { id: string; path: string } | null;
  parent_session: string | null;
  current_request: string | null;
  queued: number;
  last_sequence: number;
  last_activity_ms: number | null;
};
/** One request's state as `GET .../requests/{request}` gives it: null when Core has no receipt for that id. */
export type RequestState = { archived: boolean; state: string | null; error: string | null };
/** `GET .../recovery`: whether a stopped session could resume. File availability is not proof the resume will work. */
export type Recovery = { status: 'ready' | 'empty' | 'missing' | 'unavailable'; message: string };
/** A token, or a function that reads it when a request is made (Timmy's config reads its 0600 file only then). */
export type TokenSource = string | (() => string);

/** Timmy's words for the codes the kept commands can return. Core's own text stays on the error as `detail`. */
const rejectionMessages: Record<string, string> = {
  request_conflict: 'This request id already belongs to different content on the Core; it was not run again.',
  harness_not_configured: 'The Core has no such harness configured.',
  invalid_model: 'The Core does not offer this model for the harness.',
  invalid_provider: 'The Core refused the provider (Pi only).',
  invalid_reasoning_effort: 'The Core refused the reasoning level for this model.',
  invalid_service_tier: 'The Core refused the service tier for this model.',
  invalid_workspace: 'The Core could not select the workspace folder.',
  storage_blocked: 'The Core is blocking new work while its storage is unsafe (temporary).',
  service_stopping: 'The Core is restarting (temporary).',
  service_draining: 'The Core is draining before it sleeps (temporary).',
  model_catalog_unavailable: 'The Core could not read its model catalog (temporary).',
  codex_auth_required: 'The Core has no Codex sign-in. A person signs in on the Core machine itself; Timmy copies no sign-ins.',
  codex_auth_unavailable: 'The Core could not check its Codex sign-in (temporary).',
  codex_usage_limit: "The Core's Codex account has reached its usage limit.",
  claude_auth_required: 'The Core has no Claude Code sign-in. A person signs in on the Core machine itself; Timmy copies no sign-ins.',
  claude_auth_unavailable: 'The Core could not check its Claude Code sign-in (temporary).',
  cursor_auth_required: 'The Core has no Cursor sign-in. A person signs in on the Core machine itself; Timmy copies no sign-ins.',
  cursor_auth_unavailable: 'The Core could not check its Cursor sign-in (temporary).',
};
const transientRejections = new Set(['storage_blocked', 'service_stopping', 'service_draining', 'model_catalog_unavailable', 'codex_auth_unavailable', 'claude_auth_unavailable', 'cursor_auth_unavailable']);

export class CloudroomError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly retryable: boolean;
  /** Core's own error text (at most 500 characters, token scrubbed); never read for 401/403. */
  readonly detail: string | null;
  /** Core's own code, also one this client has no words for (request_rejected, storage_unavailable, ...). */
  readonly coreCode: string | null;

  constructor(message: string, status: number | null = null, code: string | null = null, extra: { detail?: string | null; coreCode?: string | null } = {}) {
    super(message);
    this.name = 'CloudroomError';
    this.status = status;
    this.code = code;
    this.detail = extra.detail ?? null;
    this.coreCode = extra.coreCode ?? null;
    this.retryable = code && Object.hasOwn(rejectionMessages, code)
      ? transientRejections.has(code)
      : status === null || status >= 500 || [408, 409, 429].includes(status);
  }
}

export class CloudroomConnectionError extends CloudroomError {
  readonly networkCode: string | null;
  /** No answer arrived within the client's timeout: the command may or may not have been accepted. */
  readonly timedOut: boolean;

  constructor(message: string, cause?: unknown, timedOut = false) {
    super(message);
    this.name = 'CloudroomConnectionError';
    this.timedOut = timedOut;
    const detail = cause instanceof Error && cause.cause ? cause.cause : cause;
    const code = detail && typeof detail === 'object' && 'code' in detail ? detail.code : null;
    this.networkCode = typeof code === 'string' && [
      'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
      'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
    ].includes(code) ? code : null;
  }
}

/** Reads the core's `{ code, error }` body: an allowlisted code, Core's own code when it is a plain word, and its text. */
async function rejection(response: Response): Promise<{ code: string | null; raw: string | null; error: string | null }> {
  const none = { code: null, raw: null, error: null };
  const reader = response.body?.getReader();
  if (!reader) return none;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) return none;
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const text = new TextDecoder().decode(bytes);
    let body: { code?: unknown; error?: unknown } | null = null;
    try { body = JSON.parse(text); } catch { return { code: null, raw: null, error: text.trim().slice(0, 500) || null }; }
    const error = typeof body?.error === 'string' ? body.error.slice(0, 500) : null;
    const raw = typeof body?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(body.code) ? body.code : null;
    if (raw && Object.hasOwn(rejectionMessages, raw)) return { code: raw, raw, error };
    const legacy: Record<string, string> = {
      'invalid reasoning effort': 'invalid_reasoning_effort', 'invalid model': 'invalid_model',
      'storage unsafe; new execution is blocked': 'storage_blocked', 'service is stopping': 'service_stopping', 'service is draining': 'service_draining',
    };
    return { code: error !== null && Object.hasOwn(legacy, error) ? legacy[error] : null, raw, error };
  } catch { return none; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** fetch() hides the network cause (ECONNREFUSED, DNS, TLS) in `error.cause`. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause : null;
  const code = cause && 'code' in cause && typeof cause.code === 'string' ? `${cause.code} ` : '';
  return cause ? `${error.message}: ${code}${cause.message}` : error.message;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CloudroomError('Invalid Cloudroom response');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new CloudroomError('Invalid Cloudroom response');
  return value;
}

function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CloudroomError('Invalid Cloudroom sequence');
  }
  return value;
}

function json(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const items = Array.isArray(value) ? value : Object.values(object(value));
  for (const item of items) json(item);
  return value as Json;
}

function receipt(value: unknown): Receipt {
  const item = object(value);
  return {
    request_id: text(item.request_id),
    command: text(item.command),
    state: text(item.state),
    input: json(item.input),
    ...(item.model === undefined || item.model === null ? {} : { model: text(item.model) }),
    ...(item.provider === undefined || item.provider === null ? {} : { provider: text(item.provider) }),
    ...(item.workspace === undefined || item.workspace === null
      ? {}
      : { workspace: { id: text(object(item.workspace).id), path: text(object(item.workspace).path) } }),
    ...(item.error === undefined || item.error === null ? {} : { error: text(item.error) }),
  };
}

function record(value: unknown, sessionId: string): SessionRecord {
  const item = object(value);
  if (item.session_id !== sessionId) throw new CloudroomError('Cloudroom session mismatch');
  return {
    sequence: sequence(item.sequence),
    session_id: sessionId,
    kind: text(item.kind),
    data: json(item.data),
    ...(item.native === undefined || item.native === null ? {} : { native: text(item.native) }),
    ...(item.timestamp_ms === undefined || item.timestamp_ms === null ? {} : { timestamp_ms: sequence(item.timestamp_ms) }),
  };
}

const REQUEST_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function requestId(value: string): string {
  if (!REQUEST_ID.test(value)) {
    throw new CloudroomError('request_id must be 1–64 letters, digits, underscores or hyphens', 400);
  }
  return value;
}

function sessionPath(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new CloudroomError('A valid Cloudroom session ID is required', 400);
  return `/v1/sessions/${encodeURIComponent(id)}`;
}

/** Why a Core URL is refused (https, or http on loopback; no credentials, query or fragment), or undefined when it is fine. */
export function coreUrlProblem(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return 'Invalid Cloudroom URL'; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    return 'Use an HTTPS core URL without credentials, query or fragment (plain http only on this computer\'s loopback)';
  }
  return undefined;
}

/** A token a header can carry: visible ASCII only, no spaces. */
export const tokenIsUsable = (token: string): boolean => !!token && !/[^\x21-\x7e]/.test(token);

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const STREAM_SILENCE_MS = 45_000;

export interface CloudroomClientOptions {
  url: string;
  token: TokenSource;
  /** Per request, for everything but the event stream (default 30 s). */
  timeoutMs?: number;
  /** The event stream fails when nothing, not even a keep-alive, arrives for this long (default 45 s). */
  streamSilenceMs?: number;
}

export class CloudroomClient {
  #base: string;
  #token: TokenSource;
  #timeoutMs: number;
  #silenceMs: number;

  constructor(options: CloudroomClientOptions) {
    const problem = coreUrlProblem(options.url);
    if (problem) throw new CloudroomError(problem);
    if (typeof options.token === 'string' && !tokenIsUsable(options.token)) {
      throw new CloudroomError('A core access token is required');
    }
    if (typeof options.token !== 'string' && typeof options.token !== 'function') throw new CloudroomError('A core access token is required');
    this.#base = new URL(options.url).href.replace(/\/$/, '');
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#silenceMs = options.streamSilenceMs ?? STREAM_SILENCE_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new CloudroomError('timeoutMs must be a positive integer');
    }
    if (!Number.isSafeInteger(this.#silenceMs) || this.#silenceMs <= 0) {
      throw new CloudroomError('streamSilenceMs must be a positive integer');
    }
  }

  /** The token for one request, read and checked now. Its own failure never carries the token. */
  #readToken(): string {
    let token: string;
    try {
      token = typeof this.#token === 'function' ? this.#token() : this.#token;
    } catch (error) {
      throw new CloudroomError(`The core access token could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    if (typeof token !== 'string' || !tokenIsUsable(token)) {
      throw new CloudroomError('A core access token is required (visible ASCII characters, no spaces)');
    }
    return token;
  }

  /** `message` without the token in it (defense in depth: Core does not echo it, but a proxy in front might). */
  static #scrub(message: string, token: string): string {
    return token.length >= 6 ? message.split(token).join('[REDACTED]') : message;
  }

  async #request(path: string, body: Json | undefined, caller: AbortSignal | undefined, timeout?: AbortSignal, timeoutMs?: number): Promise<{ response: Response; token: string }> {
    const token = this.#readToken();
    const scrub = (m: string) => CloudroomClient.#scrub(m, token);
    const signal = caller && timeout ? AbortSignal.any([caller, timeout]) : (caller ?? timeout);
    let response: Response;
    try {
      response = await fetch(`${this.#base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: path.includes('/stream?') ? 'text/event-stream' : 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal,
      });
    } catch (error) {
      if (caller?.aborted) throw new DOMException('Cloudroom request cancelled', 'AbortError');
      if (timeout?.aborted) {
        throw new CloudroomConnectionError(scrub(`Cloudroom did not answer within ${timeoutMs ?? this.#timeoutMs} ms. For an unconfirmed command, retry the same request_id.`), error, true);
      }
      throw new CloudroomConnectionError(scrub(`Cloudroom is unreachable (${describe(error)}). For an unconfirmed command, retry the same request_id.`), error);
    }
    if (!response.ok) {
      // Auth failures may echo credentials, so their body is never read.
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        throw new CloudroomError(`Cloudroom authentication failed (HTTP ${response.status})`, response.status, null);
      }
      const { code: known, raw, error } = await rejection(response);
      await response.body?.cancel().catch(() => {});
      // Only 400/409 codes steer retry decisions; other statuses keep status-based rules.
      const code = response.status === 400 || response.status === 409 ? known : null;
      const detail = error === null ? null : scrub(error);
      const message = code ? rejectionMessages[code] : `Cloudroom rejected the request (HTTP ${response.status})${detail ? `: ${detail}` : ''}`;
      throw new CloudroomError(scrub(message), response.status, code, { detail, coreCode: raw });
    }
    return { response, token };
  }

  async #json(path: string, body?: Json, caller?: AbortSignal, timeoutMs = this.#timeoutMs): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const { response } = await this.#request(path, body, caller, timeout, timeoutMs);
    if (body !== undefined && response.status !== 202) {
      await response.body?.cancel().catch(() => {});
      throw new CloudroomError('Cloudroom did not acknowledge command acceptance');
    }
    if (!response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel().catch(() => {});
      throw new CloudroomError('Expected a Cloudroom JSON response');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new CloudroomError('Empty Cloudroom response');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read().catch((error: unknown) => {
          if (caller?.aborted) throw new DOMException('Cloudroom request cancelled', 'AbortError');
          throw new CloudroomConnectionError('Cloudroom response disconnected. Retry unconfirmed commands with the same request_id.', error, timeout.aborted);
        });
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE_BYTES) throw new CloudroomError('Cloudroom response exceeds the size limit');
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return object(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      if (error instanceof CloudroomError || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      throw new CloudroomError('Incomplete or invalid Cloudroom response. Retry unconfirmed commands with the same request_id.');
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async #command(path: string, command: string, body: { request_id: string } & Record<string, Json>, sessionId?: string): Promise<Acceptance> {
    requestId(body.request_id);
    const value = await this.#json(path, body);
    const accepted = {
      session_id: text(value.session_id),
      receipt: receipt(value.receipt),
      saving: json(value.saving),
    };
    if (
      (sessionId !== undefined && accepted.session_id !== sessionId)
      || accepted.receipt.request_id !== body.request_id
      || accepted.receipt.command !== command
    ) {
      throw new CloudroomError('Cloudroom acceptance does not match the command');
    }
    return accepted;
  }

  health(signal?: AbortSignal) {
    return this.#json('/v1/health', undefined, signal);
  }
  /** 200 only when Core's storage and database are usable; a 503 comes back as a CloudroomError with status 503. */
  ready(signal?: AbortSignal) {
    return this.#json('/v1/ready', undefined, signal);
  }
  /** Feature flags and the configured harnesses. A missing flag means unsupported. */
  capabilities(signal?: AbortSignal) {
    return this.#json('/v1/capabilities', undefined, signal);
  }
  /** The latest 1,000 sessions, newest activity first. */
  async listSessions(signal?: AbortSignal): Promise<{ total: number; sessions: SessionSummary[] }> {
    const value = await this.#json('/v1/sessions', undefined, signal);
    if (!Array.isArray(value.sessions)) throw new CloudroomError('Invalid Cloudroom session list');
    return { total: sequence(value.total), sessions: value.sessions.map((item) => object(item) as SessionSummary) };
  }

  /** Starts a session `cr_{id}`. 202 means accepted: saved, not started and not finished. */
  start(id: string, harness: Harness = 'codex', options: { model?: string; reasoning?: string; workspace?: string; workspace_name?: string; provider?: string; command_guard_enabled?: boolean; strip_ai_co_authors?: boolean; system_prompt?: string } = {}) {
    if (!(HARNESSES as readonly string[]).includes(harness)) throw new CloudroomError('Unsupported Cloudroom harness');
    const fields: Record<string, Json> = {};
    for (const [key, value] of Object.entries(options) as Array<[string, string | boolean | undefined]>) if (value !== undefined) fields[key] = value;
    return this.#command('/v1/sessions', 'start', { request_id: id, harness, ...fields });
  }

  prompt(sessionId: string, id: string, prompt: string, reasoning?: string, extra: { service_tier?: string } = {}) {
    if (!prompt.trim() || new TextEncoder().encode(prompt).length > 32768) {
      throw new CloudroomError('Prompt must contain 1–32768 bytes of text', 400);
    }
    return this.#command(
      `${sessionPath(sessionId)}/prompts`,
      'prompt',
      { request_id: id, text: prompt, ...(reasoning ? { reasoning } : {}), ...(extra.service_tier ? { service_tier: extra.service_tier } : {}) },
      sessionId,
    );
  }

  /** Stops the current turn; Core refuses (409) when `targetRequestId` is not the active request. Queued prompts continue. */
  interrupt(sessionId: string, id: string, targetRequestId: string) {
    return this.#command(`${sessionPath(sessionId)}/interrupt`, 'interrupt', { request_id: id, target_request_id: requestId(targetRequestId) }, sessionId);
  }

  /** Pauses the queue (and stops a running turn). */
  stop(sessionId: string, id: string) {
    return this.#command(`${sessionPath(sessionId)}/stop`, 'stop', { request_id: id }, sessionId);
  }

  resume(sessionId: string, id: string) {
    return this.#command(`${sessionPath(sessionId)}/resume`, 'resume', { request_id: id }, sessionId);
  }

  /** Answers an agent's request for a child in its own sandbox: the child thread started, or why it could not. */
  async answerChild(sessionId: string, id: string, answer: { thread: string } | { error: string }): Promise<void> {
    await this.#json(`${sessionPath(sessionId)}/children/${encodeURIComponent(id)}`, answer);
  }

  /** Ends the session and keeps its history; queued prompts that never ran become failed. */
  close(sessionId: string, id: string) {
    return this.#command(`${sessionPath(sessionId)}/close`, 'close', { request_id: id }, sessionId);
  }

  async sessionWorkspace(sessionId: string, signal?: AbortSignal): Promise<{ path: string; branch: string | null; head: string | null }> {
    const value = await this.#json(`${sessionPath(sessionId)}/workspace`, undefined, signal);
    return {
      path: text(value.path),
      branch: value.branch === null ? null : text(value.branch),
      head: value.head === null ? null : text(value.head),
    };
  }

  async session(sessionId: string, signal?: AbortSignal): Promise<Session> {
    const value = object((await this.#json(sessionPath(sessionId), undefined, signal)).session);
    if (value.session_id !== sessionId || !(HARNESSES as readonly unknown[]).includes(value.harness)) {
      throw new CloudroomError('Cloudroom session mismatch or unsupported harness');
    }
    if (!Array.isArray(value.queue)) throw new CloudroomError('Invalid Cloudroom queue');
    return {
      session_id: sessionId,
      harness: value.harness as Harness,
      state: text(value.state),
      native_id: value.native_id === null ? null : text(value.native_id),
      current_request: value.current_request === null ? null : text(value.current_request),
      last_sequence: sequence(value.last_sequence),
      queue: value.queue.map(text),
      receipts: Object.fromEntries(Object.entries(object(value.receipts)).map(([id, item]) => [id, receipt(item)])),
    };
  }

  /** One request's state without the session's whole history: `cancelled` for a cancelled queued prompt, null when unknown. */
  async requestState(sessionId: string, id: string, signal?: AbortSignal): Promise<RequestState> {
    requestId(id);
    const value = await this.#json(`${sessionPath(sessionId)}/requests/${encodeURIComponent(id)}`, undefined, signal);
    if (typeof value.archived !== 'boolean') throw new CloudroomError('Invalid Cloudroom request state');
    return {
      archived: value.archived,
      state: value.state === null || value.state === undefined ? null : text(value.state),
      error: value.error === null || value.error === undefined ? null : text(value.error),
    };
  }

  async recovery(sessionId: string, signal?: AbortSignal): Promise<Recovery> {
    const value = await this.#json(`${sessionPath(sessionId)}/recovery`, undefined, signal);
    const status = text(value.status);
    if (!['ready', 'empty', 'missing', 'unavailable'].includes(status)) throw new CloudroomError('Invalid Cloudroom recovery status');
    return { status: status as Recovery['status'], message: text(value.message) };
  }

  /** At most 256 records after `after`, in order; page on with the last one's sequence (sequences need not be contiguous). */
  async eventsPage(sessionId: string, after = 0, signal?: AbortSignal): Promise<SessionRecord[]> {
    const cursor = sequence(after);
    const value = await this.#json(`${sessionPath(sessionId)}/events?after=${cursor}`, undefined, signal);
    if (!Array.isArray(value.events)) throw new CloudroomError('Invalid Cloudroom event page');
    let last = cursor;
    return value.events.map((item) => {
      const found = record(item, sessionId);
      if (found.sequence <= last) throw new CloudroomError('Cloudroom history is out of order');
      last = found.sequence;
      return found;
    });
  }

  /** Records after `after`, live, until the signal aborts or the connection drops (Core's stream itself never ends). */
  async *stream(sessionId: string, options: { after?: number; signal: AbortSignal; onConnected?: () => void | Promise<void> }): AsyncGenerator<SessionRecord> {
    let cursor = sequence(options.after ?? 0);
    for await (const item of this.#stream(sessionId, options)) {
      if (item.sequence > cursor) {
        cursor = item.sequence;
        yield item;
      }
    }
  }

  async *#stream(sessionId: string, options: { after?: number; signal: AbortSignal; onConnected?: () => void | Promise<void> }): AsyncGenerator<SessionRecord> {
    const cursor = sequence(options.after ?? 0);
    const { response } = await this.#request(`${sessionPath(sessionId)}/stream?after=${cursor}`, undefined, options.signal);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel().catch(() => {});
      throw new CloudroomError('Expected a Cloudroom event stream');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new CloudroomError('Empty Cloudroom stream');
    const decoder = new TextDecoder();
    let buffer = '';
    let data: string[] = [];
    let event = '';
    let id = '';
    let frameSize = 0;
    try {
      options.signal.throwIfAborted();
      await options.onConnected?.();
      while (true) {
        let silence: ReturnType<typeof setTimeout> | undefined;
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { silence = setTimeout(() => reject(new Error(`no data for ${this.#silenceMs} ms`)), this.#silenceMs); }),
        ]).catch((error: unknown) => {
          options.signal.throwIfAborted();
          throw new CloudroomConnectionError('Cloudroom event stream disconnected', error);
        }).finally(() => clearTimeout(silence));
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length + frameSize > MAX_RESPONSE_BYTES) throw new CloudroomError('Cloudroom event exceeds the size limit');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (line === '') {
            if (event === 'record' && data.length > 0) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(data.join('\n'));
              } catch {
                throw new CloudroomError('Invalid Cloudroom event JSON');
              }
              const item = record(parsed, sessionId);
              if (id !== String(item.sequence)) throw new CloudroomError('Cloudroom event cursor mismatch');
              yield item;
            }
            data = [];
            event = '';
            id = '';
            frameSize = 0;
          } else if (!line.startsWith(':')) {
            frameSize += line.length;
            if (frameSize > MAX_RESPONSE_BYTES) throw new CloudroomError('Cloudroom event exceeds the size limit');
            const separator = line.indexOf(':');
            const field = separator === -1 ? line : line.slice(0, separator);
            const content = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
            if (field === 'data') data.push(content);
            if (field === 'event') event = content;
            if (field === 'id') id = content;
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
