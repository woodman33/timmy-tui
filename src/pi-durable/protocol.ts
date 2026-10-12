/**
 * Pi Durable, slice S1 (R4 H118): how Timmy processes talk to the project's Pi worker (plan b.1.5). JSON lines over a
 * Unix domain socket at ${TMPDIR}/timmy-pi-<project id, first 12 hex>.sock, created under umask 077 and chmod 0600.
 * Nothing listens on the network. A connection's first message must be `hello` carrying the worker's token (from
 * worker.token, 0600); the worker compares its sha256 with its own in constant time. Each request is
 * `{id, method, params}` and each answer `{id, ok: true, result}` or `{id, ok: false, error}`; requests on one
 * connection may be answered out of order (a Stop that waits for a deaf tool does not hold a status read).
 *
 * An authenticated connection is a LEASE (plan b.2): the worker knows which Timmy processes are attached (hello's pid,
 * process start and surface), drops a lease when its connection closes or its process is proven gone, and treats "no
 * lease for the grace period" as Timmy's exit.
 *
 * FROZEN for S2-S5 as PROTOCOL_VERSION 1: the twelve methods of plan b.1.5 and the parameter and result shapes below.
 * A change of meaning is a new version.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { CostWords } from './cost.js';
import type { EffectRecord } from './effects.js';
import type { FauxScript } from './faux.js';

export const PROTOCOL_VERSION = 1;
export const METHODS = ['hello', 'delegate', 'status', 'list', 'events', 'stop', 'pause', 'resume', 'answer', 'message', 'transcript', 'shutdown'] as const;
export type Method = (typeof METHODS)[number];
/** A line longer than this ends the connection (a client is never trusted with the worker's memory). */
export const MAX_LINE = 1024 * 1024;

export type OnExit = 'pause' | 'keep-working';
export interface WorkerSetting {
  /** what the worker does when Timmy exits (no lease for lease_grace_ms): "pause" is the plan's proposed default, not yet the operator's decision */
  readonly on_exit: OnExit;
  /** with no lease and no live work for this long, the worker exits */
  readonly idle_ms: number;
  readonly lease_grace_ms: number;
  /** whether the trial_shell fixture tool is offered */
  readonly trial_shell: boolean;
}

// ── hello ──────────────────────────────────────────────────────────────────────────────────────
export interface HelloParams { readonly token: string; readonly pid?: number; readonly started?: string; readonly surface?: string }
export interface HelloResult {
  readonly protocol: number;
  readonly project_id: string;
  readonly store: string;
  readonly pid: number;
  readonly started: string;
  readonly pins: Record<string, string>;
  readonly node: string;
  readonly scheduling: 'paused' | 'running';
  readonly setting: WorkerSetting;
  /** attached Timmy processes, this one included */
  readonly leases: number;
}

// ── delegate, status, list ─────────────────────────────────────────────────────────────────────
/** S1's one model route is FAKE (pi-ai's scripted faux provider). */
export interface DelegateParams { readonly task: string; readonly key?: string; readonly model: { readonly route: 'faux'; readonly script: FauxScript } }
export type DelegateResult =
  | { readonly ok: true; readonly started: true; readonly run: string; readonly conversation: number; readonly submission: number; readonly request_id: string; readonly model: string }
  | { readonly ok: false; readonly refused: string; readonly run?: string; readonly submission?: number };

export type RunWords = 'queued' | 'running' | 'needs you' | 'paused' | 'interrupted' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export interface NeedsYouItem { readonly key: string; readonly why: string; readonly at: string; readonly answered?: { readonly decision: AnswerDecision; readonly by: string; readonly at: string } }
export interface StatusResult {
  readonly run: string;
  readonly key: string | null;
  readonly status: RunWords;
  readonly scheduling: 'paused' | 'running';
  /** the run's newest submission */
  readonly submission: { readonly id: number; readonly status: string; readonly reason: string | null; readonly request_id: string | null } | null;
  readonly submissions: number[];
  readonly conversation: number | null;
  readonly tasks: { readonly id: number; readonly kind: string; readonly status: string; readonly phase: string | null; readonly owner: number | null; readonly abort_requested: boolean; readonly inspect: string }[];
  readonly entries: { readonly id: number; readonly kind: string; readonly stop: string | null; readonly text: string }[];
  readonly user_entries: number;
  readonly effects: EffectRecord[];
  readonly needs_you: NeedsYouItem[];
  readonly stop_requested: { readonly by: string; readonly at: string } | null;
  readonly paused: { readonly why: string; readonly at: string } | null;
  readonly interrupted: { readonly why: string; readonly at: string } | null;
  readonly cost: CostWords;
  readonly resubmitted: { readonly submission: number; readonly same: boolean; readonly first?: true }[];
  readonly messages: { readonly n: number; readonly key?: string; readonly mode: 'steer' | 'followUp'; readonly submission: number }[];
  readonly ended: { readonly status: RunWords; readonly reason?: string; readonly at: string } | null;
  readonly model: string;
}
export interface ListResult { readonly scheduling: 'paused' | 'running'; readonly runs: { readonly run: string; readonly key: string | null; readonly status: RunWords; readonly created: string }[] }

// ── events ─────────────────────────────────────────────────────────────────────────────────────
/** `after`: the last event number the caller has (0 for all); `wait_ms` (at most 30 s): wait for a newer one before answering. */
export interface EventsParams { readonly run: string; readonly after?: number; readonly limit?: number; readonly wait_ms?: number }
/** pi-durable's agent events as they came (experimental upstream), numbered from 1, kept in the run's events file. */
export interface EventsResult { readonly run: string; readonly events: { readonly n: number; readonly at: string; readonly event: Record<string, unknown> }[]; readonly next: number; readonly more: boolean }

// ── stop, pause, resume ────────────────────────────────────────────────────────────────────────
export interface StopResult { readonly run: string; readonly result: string; readonly ms?: number; readonly scheduling?: 'paused' | 'running'; readonly status: RunWords }
export interface PauseResult { readonly scheduling: 'paused'; readonly runs?: string[]; readonly already?: true }
export interface ResumeResult { readonly scheduling: 'running'; readonly resumed?: { readonly run: string; readonly submission: number; readonly same: boolean; readonly first?: true }[]; readonly already?: true }

// ── answer (a NEEDS YOU decision) ──────────────────────────────────────────────────────────────
/** accept: the effect is taken as done; retry: one more attempt is allowed (its earlier outcome stays unknown); stop: the run stops. */
export type AnswerDecision = 'accept' | 'retry' | 'stop';
export interface AnswerParams { readonly run: string; readonly key: string; readonly decision: AnswerDecision }
export type AnswerResult =
  | { readonly ok: true; readonly run: string; readonly key: string; readonly decision: AnswerDecision; readonly ledger: EffectRecord | null; readonly stop?: StopResult }
  | { readonly ok: false; readonly refused: string };

// ── message (steer or follow-up) ───────────────────────────────────────────────────────────────
export interface MessageParams { readonly run: string; readonly text: string; readonly mode: 'steer' | 'followUp'; readonly key?: string }
export type MessageResult =
  | { readonly ok: true; readonly run: string; readonly n: number; readonly submission: number; readonly request_id: string; readonly mode: 'steer' | 'followUp' }
  | { readonly ok: false; readonly refused: string; readonly n?: number; readonly submission?: number };

// ── transcript ─────────────────────────────────────────────────────────────────────────────────
export interface TranscriptParams { readonly run: string; readonly after?: number; readonly limit?: number }
export interface TranscriptEntry {
  readonly id: number; readonly kind: string; readonly by_task: number | null; readonly role: string | null; readonly stop: string | null;
  readonly text: string; readonly tool_calls: { readonly id: string; readonly name: string; readonly arguments: unknown }[]; readonly error: string | null;
}
export interface TranscriptResult { readonly run: string; readonly conversation: number | null; readonly note: string; readonly entries: TranscriptEntry[]; readonly more: boolean }

// ── shutdown ───────────────────────────────────────────────────────────────────────────────────
export interface ShutdownResult { readonly ok: true; readonly on_exit: 'pause'; readonly words: string }

// ── the server ─────────────────────────────────────────────────────────────────────────────────
export interface Request { readonly id: number; readonly method: string; readonly params?: unknown }
export type Response = { readonly id: number; readonly ok: true; readonly result: unknown } | { readonly id: number; readonly ok: false; readonly error: string };

/** One authenticated connection: a lease. */
export interface Peer { readonly id: number; readonly pid?: number; readonly started?: string; readonly surface?: string; readonly since: number }
export type Handler = (method: Method, params: Record<string, unknown>, peer: Peer) => Promise<unknown>;
export interface LeaseHooks {
  /** a connection said hello with the token: a lease begins (`end()` closes it) */
  opened(peer: Peer, end: () => void): void;
  /** its connection closed */
  closed(peer: Peer): void;
}

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Splits a socket's bytes into lines, refusing any over MAX_LINE. */
function lines(socket: Socket, onLine: (line: string) => void): void {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_LINE && !buf.includes('\n')) { socket.destroy(); return; }
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
}

/** Listens on the socket path (a stale file there is removed first: the caller holds the store's lock). */
export async function serve(socketPath: string, tokenSha256Hex: string, handler: Handler, hello: (peer: Peer) => HelloResult, leases?: LeaseHooks): Promise<Server> {
  rmSync(socketPath, { force: true });
  const expected = Buffer.from(tokenSha256Hex, 'hex');
  let nextPeer = 1;
  const server = createServer((socket) => {
    let peer: Peer | undefined;
    const send = (r: Response): void => { if (!socket.destroyed) socket.write(`${JSON.stringify(r)}\n`); };
    lines(socket, (line) => {
      let req: Request;
      try { req = JSON.parse(line) as Request; } catch { send({ id: -1, ok: false, error: 'not JSON' }); return; }
      const id = typeof req.id === 'number' ? req.id : -1;
      const params = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;
      if (!peer) {
        const token = typeof params.token === 'string' ? params.token : '';
        if (req.method !== 'hello' || expected.length !== 32 || !timingSafeEqual(sha(token), expected)) {
          send({ id, ok: false, error: 'say hello with the worker token first' });
          socket.end();
          return;
        }
        peer = {
          id: nextPeer++, since: Date.now(),
          pid: typeof params.pid === 'number' ? params.pid : undefined,
          started: typeof params.started === 'string' ? params.started : undefined,
          surface: typeof params.surface === 'string' ? params.surface.slice(0, 64) : undefined,
        };
        leases?.opened(peer, () => socket.destroy());
        send({ id, ok: true, result: hello(peer) });
        return;
      }
      if (!(METHODS as readonly string[]).includes(req.method)) { send({ id, ok: false, error: `no such method: ${String(req.method)}` }); return; }
      const who = peer;
      void handler(req.method as Method, params, who).then(
        (result) => send({ id, ok: true, result }),
        (e: unknown) => send({ id, ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    });
    socket.on('close', () => { if (peer) leases?.closed(peer); });
    socket.on('error', () => { /* a client that went away */ });
  });
  const was = process.umask(0o077);
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(socketPath, () => { server.off('error', rejectListen); resolveListen(); });
    });
  } finally { process.umask(was); }
  chmodSync(socketPath, 0o600);
  return server;
}

/** One connection to a worker, after a successful hello. */
export class PiClient {
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ended = false;
  hello!: HelloResult;

  private constructor(private readonly socket: Socket) {
    lines(socket, (line) => {
      let r: Response;
      try { r = JSON.parse(line) as Response; } catch { return; }
      const w = this.waiting.get(r.id);
      if (!w) return;
      this.waiting.delete(r.id);
      clearTimeout(w.timer);
      if (r.ok) w.resolve(r.result); else w.reject(new Error(r.error));
    });
    const fail = (why: string): void => {
      this.ended = true;
      for (const [, w] of this.waiting) { clearTimeout(w.timer); w.reject(new Error(why)); }
      this.waiting.clear();
    };
    socket.on('close', () => fail('the Pi worker closed the connection'));
    socket.on('error', (e) => fail(`the Pi worker's socket: ${e.message}`));
  }

  /** Connects and says hello; rejects when the socket is not there, the token is refused, or nothing answers in time. */
  static async connect(socketPath: string, hello: HelloParams, timeoutMs = 5000): Promise<PiClient> {
    const socket = await new Promise<Socket>((resolveConn, rejectConn) => {
      const s = createConnection(socketPath);
      const t = setTimeout(() => { s.destroy(); rejectConn(new Error('the Pi worker did not accept the connection in time')); }, timeoutMs);
      s.once('connect', () => { clearTimeout(t); resolveConn(s); });
      s.once('error', (e) => { clearTimeout(t); rejectConn(e); });
    });
    const client = new PiClient(socket);
    try {
      client.hello = await client.request<HelloResult>('hello', { ...hello }, timeoutMs);
    } catch (e) { client.close(); throw e; }
    return client;
  }

  request<T = unknown>(method: Method, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.ended) return Promise.reject(new Error('the Pi worker connection has ended'));
    const id = this.next++;
    return new Promise<T>((resolveReq, rejectReq) => {
      const timer = setTimeout(() => { this.waiting.delete(id); rejectReq(new Error(`the Pi worker did not answer ${method} in ${timeoutMs} ms`)); }, timeoutMs);
      this.waiting.set(id, { resolve: resolveReq as (v: unknown) => void, reject: rejectReq, timer });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  close(): void { this.ended = true; this.socket.end(); this.socket.destroy(); }
}
