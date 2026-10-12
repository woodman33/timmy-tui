/**
 * Pi Durable, slice S1 (R4 H118): how Timmy processes talk to the project's Pi worker (plan b.1.5). JSON lines over a
 * Unix domain socket at ${TMPDIR}/timmy-pi-<project id, first 12 hex>.sock, created under umask 077 and chmod 0600.
 * Nothing listens on the network. A connection's first message must be `hello` carrying the worker's token (from
 * worker.token, 0600); the worker compares its sha256 with its own in constant time. Each request is
 * `{id, method, params}` and each answer `{id, ok: true, result}` or `{id, ok: false, error}`; requests on one
 * connection may be answered out of order (a Stop that waits for a deaf tool does not hold a status read).
 *
 * Frozen for S2 (records, the follower job) and S3 (the delegation tools): PROTOCOL_VERSION and the methods below.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

export const PROTOCOL_VERSION = 1;
export const METHODS = ['hello', 'delegate', 'status', 'list', 'stop', 'pause', 'resume', 'shutdown'] as const;
export type Method = (typeof METHODS)[number];
/** A line longer than this ends the connection (a client is never trusted with the worker's memory). */
export const MAX_LINE = 1024 * 1024;

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
  readonly setting: { readonly on_exit: 'pause' };
}

export interface Request { readonly id: number; readonly method: string; readonly params?: unknown }
export type Response = { readonly id: number; readonly ok: true; readonly result: unknown } | { readonly id: number; readonly ok: false; readonly error: string };

export interface Peer { readonly pid?: number; readonly started?: string; readonly surface?: string }
export type Handler = (method: Method, params: Record<string, unknown>, peer: Peer) => Promise<unknown>;

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
export async function serve(socketPath: string, tokenSha256Hex: string, handler: Handler, hello: () => HelloResult): Promise<Server> {
  rmSync(socketPath, { force: true });
  const expected = Buffer.from(tokenSha256Hex, 'hex');
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
        peer = { pid: typeof params.pid === 'number' ? params.pid : undefined, started: typeof params.started === 'string' ? params.started : undefined, surface: typeof params.surface === 'string' ? params.surface : undefined };
        send({ id, ok: true, result: hello() });
        return;
      }
      if (!(METHODS as readonly string[]).includes(req.method)) { send({ id, ok: false, error: `no such method: ${String(req.method)}` }); return; }
      const who = peer;
      void handler(req.method as Method, params, who).then(
        (result) => send({ id, ok: true, result }),
        (e: unknown) => send({ id, ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    });
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
