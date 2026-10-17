/**
 * The agent bridge (plan F-4, slice 2). The canvas page holds one WebSocket to the studio server;
 * the agent's canvas tools send it Editor API code. The page runs the code against the live editor
 * and answers with the result and the canvas revision, so what Timmy says about the canvas is read
 * back from it, never assumed.
 *
 * R4 (H83): a page joins only with a session that counts now. It sends its session as a WebSocket subprotocol
 * (`timmy-session.<64 hex>`, beside `timmy-canvas`, which is the one the server selects, so the page's socket never names its
 * session back), never in the address. An upgrade without one (a program on this machine that forges Origin, a page opened
 * without a grant, a page whose session ended or was given for another project or REPL) is answered 401 and closed before any
 * code is sent to it. Code goes only to the newest page whose session counts now, checked again at each call, so a page whose
 * session stopped counting (another project or REPL holds the canvas, or it ended) is sent no more code; a page whose session
 * ended for good is closed (4401). An answer is taken only from the socket its call was sent to.
 *
 * R6 (H139; Studio project isolation): every call names the project it was made for (`project`: its id and name, the project named
 * to the canvas when the REPL sent it), and a page runs it only on that project's board, never while it switches boards; it says
 * when it did not (`notRun`). And when the project named changes, every page joined is told at once (announce): the project, to a
 * page whose session counts for it; to any other, only that it cannot show it (why, in words), never which project it is.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { ProjectRef } from './boards.js';

/** R4 (H83): what a page answers about (and the bridge selects): never the session. */
export const CANVAS_PROTOCOL = 'timmy-canvas';
/** R4 (H83): the subprotocol a page sends its session in. */
export const SESSION_PROTOCOL = /^timmy-session\.([0-9a-f]{64})$/;

export const NO_CANVAS = 'No canvas is open. In Timmy: /canvas open opens it, then try again.';

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
  /** Round R1: whether the call left the canvas changed (a lookup, or a call that was undone, did not). */
  changed?: boolean;
  /** Round R1: the call failed and the page undid what it drew; the canvas is as it was before the call. */
  rolledBack?: boolean;
  /** The call crashed tldraw, so the page started a fresh editor from the canvas as it was before it. */
  restarted?: boolean;
  /** The call failed and its changes could not be undone: why (the canvas may hold part of it). */
  rollbackError?: string;
  /**
   * R5 (H133): a call sent as a draft: its id, how many shapes it left marked as a draft (a person accepts or discards them on
   * the page), the revision it was made from; or why it was refused (`stale`: made from a revision the canvas has left, nothing
   * ran; `changes`: it changed what was already on the board, nothing kept), with the revision the canvas is at (`now`).
   */
  draft?: { id: string; shapes?: number; from?: number; refused?: 'stale' | 'changes'; now?: number };
  /** R5 (H133): the draft was made from a revision the canvas has left; nothing of it ran. */
  stale?: true;
  /**
   * R6 (H139): the project the call was made for (the canvas server's stamp), and, when the page did not run it, why: its board is
   * another project's (`project`), or it was switching boards (`switching`). Nothing of such a call ran, on either board.
   */
  project?: ProjectRef;
  notRun?: 'project' | 'switching';
}

/** R5 (H133): a call sent as a draft: its id (made by the server) and the canvas revision the agent made it from (null: now). */
export interface DraftAsk { id: string; baseRevision: number | null }

const DRAFT_ID = /^draft-[0-9a-f]{8,32}$/;
const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

/** R5 (H133): the draft part of a page's answer, kept only in its own shape (and only for the draft the call was sent as). */
function draftAnswer(m: unknown, asked: DraftAsk | null): CanvasAnswer['draft'] | undefined {
  if (!asked || !m || typeof m !== 'object') return undefined;
  const d = m as Record<string, unknown>;
  if (d.id !== asked.id) return undefined;
  const out: NonNullable<CanvasAnswer['draft']> = { id: asked.id };
  if (isCount(d.shapes)) out.shapes = d.shapes;
  if (isCount(d.from)) out.from = d.from;
  if (d.refused === 'stale' || d.refused === 'changes') out.refused = d.refused;
  if (isCount(d.now)) out.now = d.now;
  return out;
}

/**
 * An HTTP-shaped outcome: 200 the page answered, 503 no canvas open, 504 no answer in time; R4 (H83): 409 a page is open, but
 * its session does not count for the project named now (or by the REPL holding it).
 */
export interface CanvasOutcome {
  status: 200 | 409 | 503 | 504;
  body: CanvasAnswer;
}

/**
 * R4 (H83): whether a page's session counts now (by its key, the sha256 of the session), and why not in words. R6 (H139): `session`,
 * the same in the words the page's own readings are told (what announce sends a page that cannot show the project named).
 */
export type PageCheck = { ok: true } | { ok: false; why: string; words: string; ended: boolean; session?: string };

/** R4 (H83): who may join the bridge, and whether a page that joined still counts. */
export interface BridgeGate {
  /** the key of the session the upgrade carries in its subprotocols, when it carries one that counts now */
  admit(req: IncomingMessage): { ok: true; key: string } | { ok: false; status: 400 | 401; words: string };
  /** whether a page's session (by key) counts now; `ended`: it never will again (ended, or not known any more) */
  counts(key: string): PageCheck;
}

interface Pending {
  page: WebSocket;
  jobId: string;
  /** R5 (H133): the draft the call was sent as, or null */
  draft: DraftAsk | null;
  /** R6 (H139): the project the call was made for, or null (no project named) */
  project: ProjectRef | null;
  done: (outcome: CanvasOutcome) => void;
  timer: NodeJS.Timeout;
}

interface Joined { ws: WebSocket; key: string }

/** The reason a closed page is given when its session ended (it then stops asking to join). */
export const SESSION_ENDED = 4401;

export class CanvasBridge {
  /** R4 (H83): every page that joined with a session, oldest first */
  private pages: Joined[] = [];
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly sockets = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(CANVAS_PROTOCOL) ? CANVAS_PROTOCOL : false) });

  constructor(
    /** Whether a request comes from this machine's own pages (Host and Origin both local). */
    private readonly isLocal: (req: IncomingMessage) => boolean,
    private readonly timeoutMs = 30_000,
    /** R4 (H83): who may join; without one, no page joins */
    private readonly gate: BridgeGate | null = null,
  ) {}

  /** Takes WebSocket upgrades for /bridge on `server`; anything else, from elsewhere, or (R4 H83) without a session that counts now, is refused. */
  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (path !== '/bridge' || !this.isLocal(req)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const admitted = this.gate ? this.gate.admit(req) : { ok: false as const, status: 401 as const, words: 'This canvas server takes no pages.' };
      if (!admitted.ok) {
        const body = `${admitted.words}\n`;
        socket.end(`HTTP/1.1 ${admitted.status} ${admitted.status === 400 ? 'Bad Request' : 'Unauthorized'}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        return;
      }
      this.sockets.handleUpgrade(req, socket, head, (ws) => this.adopt(ws, admitted.key));
    });
  }

  /** R4 (H83): the newest page whose session counts now; pages whose sessions ended for good are closed. */
  private pick(): { page: WebSocket } | { refused: string } | null {
    let refused: string | null = null;
    for (const p of [...this.pages].reverse()) {
      if (p.ws.readyState !== WebSocket.OPEN) continue;
      const c = this.gate ? this.gate.counts(p.key) : { ok: false as const, why: 'none', words: NO_CANVAS, ended: true };
      if (c.ok) return { page: p.ws };
      refused ??= c.words;
      if (c.ended) p.ws.close(SESSION_ENDED, 'session ended');
    }
    return refused ? { refused } : null;
  }

  /** Whether a canvas page is open whose session counts now (R4 H83: a page that cannot act for the project named is not counted). */
  get open(): boolean {
    const p = this.pick();
    return !!p && 'page' in p;
  }

  /**
   * Runs `code` on the open canvas (the newest page to connect whose session counts now). R5 (H133): with `draft`, the page marks
   * what it creates as that draft (only adding; refused when made from a revision the canvas has left).
   */
  exec(code: string, jobId: string, draft: DraftAsk | null = null, project: ProjectRef | null = null): Promise<CanvasOutcome> {
    if (draft && !DRAFT_ID.test(draft.id)) return Promise.resolve({ status: 503, body: { ok: false, error: 'Not a draft id.', jobId } });
    const picked = this.pick();
    if (!picked) return Promise.resolve({ status: 503, body: { ok: false, error: NO_CANVAS, jobId } });
    if ('refused' in picked) return Promise.resolve({ status: 409, body: { ok: false, error: picked.refused, jobId } });
    const page = picked.page;
    const id = ++this.seq;
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        done({ status: 504, body: { ok: false, error: `The canvas did not answer within ${this.timeoutMs / 1000} s.`, jobId } });
      }, this.timeoutMs);
      this.pending.set(id, { page, jobId, draft, project, done, timer });
      page.send(JSON.stringify({ type: 'exec', id, code, jobId, ...(draft ? { draft: { id: draft.id, baseRevision: draft.baseRevision } } : {}), ...(project ? { project: { id: project.id, name: project.name } } : {}) }));
    });
  }

  /**
   * R6 (H139): the project named to the canvas changed (a REPL named it, or the server followed the active project): every page
   * joined is told at once, so it switches boards with it. A page whose session counts for `project` is told which (its id and
   * name); any other is told only that it cannot show the project named now, in words, never which; one whose session ended for
   * good is closed (4401). How many pages were told the project.
   */
  announce(project: ProjectRef | null): number {
    let told = 0;
    for (const p of [...this.pages]) {
      if (p.ws.readyState !== WebSocket.OPEN) continue;
      const c = this.gate ? this.gate.counts(p.key) : { ok: false as const, why: 'none', words: NO_CANVAS, ended: true };
      if (c.ok) {
        p.ws.send(JSON.stringify({ type: 'project', project: project ? { id: project.id, name: project.name } : null }));
        told += 1;
      } else {
        p.ws.send(JSON.stringify({ type: 'project', project: null, paused: c.session ?? c.words }));
        if (c.ended) p.ws.close(SESSION_ENDED, 'session ended');
      }
    }
    return told;
  }

  /**
   * R7 (H151; H147's R6 finding 9, REMAINING-DEFECTS row 18: for about 2 s after a switch Studio still showed the old project and
   * took edits for it): a switch is pending: the active-project record names another project than the one shown, and the server
   * has not named it yet (src/studio/active-follow.ts FollowDeps.pending, H149's, the shape agreed in the R7 handoff). Every page
   * joined whose session counts now is told at once, `{ type: 'pending', pending: { project: { id, name }, since } }`, so it stops
   * taking edits from that moment until the new project's board is shown; `pending: null` once the switch is made or given up (the
   * switch's end is announce's own message). How many pages were told.
   */
  announcePending(p: { id: string; name: string; since: string } | null): number {
    this.said = p ? { id: p.id, name: p.name, since: p.since } : null;
    let told = 0;
    for (const page of [...this.pages]) {
      if (page.ws.readyState !== WebSocket.OPEN) continue;
      const c = this.gate ? this.gate.counts(page.key) : { ok: false as const };
      if (!c.ok) continue;
      page.ws.send(JSON.stringify({ type: 'pending', pending: p ? { project: { id: p.id, name: p.name }, since: p.since } : null }));
      told += 1;
    }
    return told;
  }

  /** R7 (H151): the switch last said pending to the pages (announcePending), or null: what GET /api/project/active says too. */
  get lastPending(): { id: string; name: string; since: string } | null { return this.said; }
  private said: { id: string; name: string; since: string } | null = null;

  close(): void {
    for (const [id, p] of this.pending) this.settle(id, p, { status: 503, body: { ok: false, error: 'The canvas server stopped.', jobId: p.jobId } });
    for (const ws of this.sockets.clients) ws.terminate();
    this.sockets.close();
  }

  private adopt(ws: WebSocket, key: string): void {
    this.pages.push({ ws, key }); // the newest canvas wins, among those whose sessions count
    ws.on('message', (data) => this.answer(ws, String(data)));
    ws.on('close', () => {
      this.pages = this.pages.filter((p) => p.ws !== ws);
      for (const [id, p] of this.pending) {
        if (p.page === ws) this.settle(id, p, { status: 503, body: { ok: false, error: 'The canvas closed before it answered.', jobId: p.jobId } });
      }
    });
  }

  /** A page's answer: R4 (H83) taken only from the socket its call was sent to. */
  private answer(from: WebSocket, text: string): void {
    let m: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown; revision?: unknown; sourceRevision?: unknown; saveError?: unknown; changed?: unknown; rolledBack?: unknown; restarted?: unknown; rollbackError?: unknown; draft?: unknown; stale?: unknown; notRun?: unknown };
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    const p = typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
    if (!p || p.page !== from) return;
    const body: CanvasAnswer = m.ok === true
      ? { ok: true, result: m.result ?? null, jobId: p.jobId }
      : { ok: false, error: typeof m.error === 'string' && m.error ? m.error : 'The canvas reported an error.', jobId: p.jobId };
    if (typeof m.revision === 'number') body.revision = m.revision;
    if (typeof m.sourceRevision === 'string' && /^[0-9a-f]{64}$/.test(m.sourceRevision)) body.sourceRevision = m.sourceRevision;
    if (typeof m.saveError === 'string' && m.saveError) body.saveError = m.saveError.slice(0, 300);
    if (typeof m.changed === 'boolean') body.changed = m.changed;
    if (m.ok !== true && m.rolledBack === true) body.rolledBack = true;
    if (m.ok !== true && m.restarted === true) body.restarted = true;
    if (m.ok !== true && typeof m.rollbackError === 'string' && m.rollbackError) body.rollbackError = m.rollbackError.slice(0, 300);
    // R5 (H133): the draft the call was sent as (never one of another call's)
    const draft = draftAnswer(m.draft, p.draft);
    if (draft) body.draft = draft;
    if (m.ok !== true && m.stale === true && p.draft) body.stale = true;
    // R6 (H139): the project the call was made for (never the page's word for it), and why the page did not run it
    if (p.project) body.project = { id: p.project.id, name: p.project.name };
    if (m.ok !== true && (m.notRun === 'project' || m.notRun === 'switching')) {
      body.notRun = m.notRun;
      // a call the page did not run left nothing: no revision of it is a job's
      delete body.sourceRevision;
      body.changed = false;
    }
    this.settle(m.id as number, p, { status: 200, body });
  }

  private settle(id: number, p: Pending, outcome: CanvasOutcome): void {
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.done(outcome);
  }
}
