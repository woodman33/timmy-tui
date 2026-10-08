/**
 * The agent bridge (plan F-4, slice 2). The canvas page holds one WebSocket to the studio server;
 * the agent's canvas tools send it Editor API code. The page runs the code against the live editor
 * and answers with the result and the canvas revision, so what Timmy says about the canvas is read
 * back from it, never assumed.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

export const NO_CANVAS = 'No canvas is open. Open it with /web studio, then try again.';

export interface CanvasAnswer {
  ok: boolean;
  result?: unknown;
  error?: string;
  jobId: string;
  /** The canvas store's revision after the call (the page counts its changes). */
  revision?: number;
  /** The sha256 of the canvas document the page saved after the call (fourth order, step 5). */
  sourceRevision?: string;
  /** Why the page could not save after the call (another window saved a newer canvas, say). */
  saveError?: string;
}

/** An HTTP-shaped outcome: 200 the page answered, 503 no canvas open, 504 no answer in time. */
export interface CanvasOutcome {
  status: 200 | 503 | 504;
  body: CanvasAnswer;
}

interface Pending {
  page: WebSocket;
  jobId: string;
  done: (outcome: CanvasOutcome) => void;
  timer: NodeJS.Timeout;
}

export class CanvasBridge {
  private page: WebSocket | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly sockets = new WebSocketServer({ noServer: true });

  constructor(
    /** Whether a request comes from this machine's own pages (Host and Origin both local). */
    private readonly isLocal: (req: IncomingMessage) => boolean,
    private readonly timeoutMs = 30_000,
  ) {}

  /** Takes WebSocket upgrades for /bridge on `server`; anything else, or from elsewhere, is refused. */
  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (path !== '/bridge' || !this.isLocal(req)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      this.sockets.handleUpgrade(req, socket, head, (ws) => this.adopt(ws));
    });
  }

  get open(): boolean {
    return this.page?.readyState === WebSocket.OPEN;
  }

  /** Runs `code` on the open canvas (the newest page to connect). */
  exec(code: string, jobId: string): Promise<CanvasOutcome> {
    const page = this.page;
    if (!page || page.readyState !== WebSocket.OPEN) return Promise.resolve({ status: 503, body: { ok: false, error: NO_CANVAS, jobId } });
    const id = ++this.seq;
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        done({ status: 504, body: { ok: false, error: `The canvas did not answer within ${this.timeoutMs / 1000} s.`, jobId } });
      }, this.timeoutMs);
      this.pending.set(id, { page, jobId, done, timer });
      page.send(JSON.stringify({ type: 'exec', id, code, jobId }));
    });
  }

  close(): void {
    for (const [id, p] of this.pending) this.settle(id, p, { status: 503, body: { ok: false, error: 'The canvas server stopped.', jobId: p.jobId } });
    for (const ws of this.sockets.clients) ws.terminate();
    this.sockets.close();
  }

  private adopt(ws: WebSocket): void {
    this.page = ws; // the newest canvas wins
    ws.on('message', (data) => this.answer(String(data)));
    ws.on('close', () => {
      if (this.page === ws) this.page = null;
      for (const [id, p] of this.pending) {
        if (p.page === ws) this.settle(id, p, { status: 503, body: { ok: false, error: 'The canvas closed before it answered.', jobId: p.jobId } });
      }
    });
  }

  private answer(text: string): void {
    let m: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown; revision?: unknown; sourceRevision?: unknown; saveError?: unknown };
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    const p = typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
    if (!p) return;
    const body: CanvasAnswer = m.ok === true
      ? { ok: true, result: m.result ?? null, jobId: p.jobId }
      : { ok: false, error: typeof m.error === 'string' && m.error ? m.error : 'The canvas reported an error.', jobId: p.jobId };
    if (typeof m.revision === 'number') body.revision = m.revision;
    if (typeof m.sourceRevision === 'string' && /^[0-9a-f]{64}$/.test(m.sourceRevision)) body.sourceRevision = m.sourceRevision;
    if (typeof m.saveError === 'string' && m.saveError) body.saveError = m.saveError.slice(0, 300);
    this.settle(m.id as number, p, { status: 200, body });
  }

  private settle(id: number, p: Pending, outcome: CanvasOutcome): void {
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.done(outcome);
  }
}
