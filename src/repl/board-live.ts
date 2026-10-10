/**
 * The live board (round R3): `/board live` serves the project's board on 127.0.0.1, owned by the REPL
 * session, with Stop, Run and Observe buttons. It is the read-only board (src/repl/board.ts) plus a small
 * page that polls its state and sends structured, allowlisted actions; it is not a workflow editor.
 *
 * What keeps it to this machine's operator (each one tested in tests/board-live.test.ts):
 * - it listens on 127.0.0.1 only, on an ephemeral port, and refuses a request whose Host is not exactly
 *   127.0.0.1:<port> (DNS rebinding) or whose Origin, when there is one, is not this page's;
 * - state and actions need `Authorization: Bearer <token>` (32 random bytes, hex, compared in constant
 *   time). The page reads the token from its URL fragment, which is never sent to a server, keeps it in
 *   memory only (no storage, no cookie) and drops it from the address bar; R4 (H60): a tab opened without
 *   it asks another tab of the same board for it (LIVE_SCRIPT's handoff, one origin only);
 * - the page itself carries no project data: everything comes from the token-protected state;
 * - actions are POST only, JSON only, at most 4 KB, one of three shapes, each checked against the current
 *   state, then run as the typed command they stand for (`/stop <id>`, `/run <doc> <block>`,
 *   `/observe <file>`) through the same Workspace method, so approvals, policies and receipts are the
 *   same. No free command text is accepted;
 * - every response is no-store and nosniff with no referrer, no CORS header, and a Content-Security-Policy
 *   that allows only this page's own nonce'd script and style and requests to itself.
 *
 * Round R4 (H22): a fourth action, Rebuild (`/recipe tray`, the typed command, as above), and POST /edit for the
 * two structured edits (the parameter form and the workflow node editor, src/repl/board-edits.ts): the same
 * checks as /action (token, Host, Origin, JSON only), at most EDIT_LIMIT bytes, run in the same queue; the
 * Workspace checks each edit on the server and writes nothing it refuses. No edit runs a command.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BOARD_CSS } from './board.js';
import { EDIT_CSS, EDIT_LIMIT, EDIT_SCRIPT } from './board-edits.js';
// Round R4 (H49): VoxVision's actions, and its highlight images through /file (src/repl/board-vox.ts).
import { checkVoxAction, VOX_LIVE_SCRIPT } from './board-vox.js';
// Round R4 (H50): Timmy Memory's Check (src/memory/board.ts): the typed /lesson check <id>.
import { checkLessonAction } from '../memory/board.js';
// Round R4 (H60): /file serves only inert images (the audit of every route is in that module's comment).
import { FILE_HEADERS, imageOnly } from './board-file-guard.js';
// Round R4 (H65): the review's Restore: the typed /restore <file> --from <kept>, only for a pair the board offers.
import { checkRestoreAction } from '../review/html.js';
import { HOMEBREW } from '../theme/tokens.js';
import { FLOW_ID } from '../flows/iterate.js';

/** An action as the page sends it: one of these shapes, nothing else. */
export type BoardAction =
  | { action: 'stop'; job: string }
  /** R4 (H48): the Control Room's Stop on a flow this REPL runs: the typed `/stop <flow-id>`, as a job's is `/stop <job>` */
  | { action: 'stop'; flow: string }
  | { action: 'run'; doc: string; block: string }
  | { action: 'observe'; file: string }
  | { action: 'rebuild'; recipe: string }
  | { action: 'vox'; verb: 'inspect' | 'measure' | 'detect' | 'compare'; file: string; other?: string; color?: string; at?: string }
  /** R4 (H61): View in Rerun on a VoxVision record the board shows: the typed `/vox view <id> rerun` */
  | { action: 'vox'; verb: 'view'; id: string }
  /** R4 (H50): Memory's Check on a lesson the board shows: the typed `/lesson check <id>` */
  | { action: 'lesson'; verb: 'check'; id: string }
  /** R4 (H65): the review's Restore of a pair the board offers: the typed `/restore <file> --from <kept previous version>` */
  | { action: 'restore'; file: string; from: string };

/** The typed command a valid action stands for: its name, its argument string and the line as typed. */
export interface BoardCommand { name: 'stop' | 'run' | 'observe' | 'recipe' | 'inspect' | 'measure' | 'detect' | 'compare' | 'lesson' | 'vox' | 'restore'; args: string; line: string }

/** What the live board shows and what its actions are checked against; no absolute path in any of it. */
export interface LiveState {
  project: string;
  madeAt: string;
  /** The board's table of contents and sections (renderBoardBody with live buttons); every string escaped. */
  toc: string;
  html: string;
  /** Changes when anything but the jobs' states and times changes: the page then redraws its sections. */
  shape: string;
  jobs: Array<{ id: string; state: string; label: string; seconds?: string; stoppable: boolean }>;
  workflows: Array<{ rel: string; blocks: string[] }>;
  /** The project files the board shows, relative to the project, with their kind. */
  files: Array<{ rel: string; kind: string; bytes: number }>;
  /** R4: the recipes whose parameter card the board shows (their Rebuild runs `/recipe <name>`). */
  recipes?: string[];
  /** R4 (H48): the running flows the Control Room shows; `stoppable` only for one this REPL runs (its Stop is `/stop <flow-id>`). */
  flows?: Array<{ id: string; state: string; stoppable: boolean }>;
  /** R4 (H49): the files VoxVision offers (its buttons run /inspect, /measure, /detect, /compare on them). */
  voxFiles?: Array<{ rel: string; kind: string }>;
  /** R4 (H61): the VoxVision records whose View in Rerun the board offers (verified or stale), by id. */
  voxRecords?: string[];
  /** R4 (H47): the OpenSCAD models whose parameter file a workflow card shows (the set-scad-params edit saves only these). */
  scadModels?: string[];
  /** R4 (H47): each workflow block's state in words (and each document's newest run, key ''), set in place like the jobs'. */
  wfStates?: Array<{ doc: string; key: string; word: string; glyph: string; detail: string }>;
  /** R4 (H50): the lessons whose Check the board offers (not retired), by id. */
  lessons?: string[];
  /** R4 (H65): the kept versions the review shows now (src/review/html.ts restorePairs): a file and its kept previous version. */
  restores?: Array<{ file: string; from: string }>;
}

export interface LiveBoardDeps {
  /** A request carried the valid token (round R4: the page that opened the board is then no longer needed). */
  onAuthorized?: () => void;
  /** The board as it is now (read for every request, so a switched project shows at once). */
  state: () => LiveState;
  /** Runs a checked action as its typed command; the lines it printed, as plain text (no ANSI). */
  execute: (command: BoardCommand) => Promise<string[]>;
  /** R4: checks and applies a structured edit (set-params, save-workflow) against the state; absent: /edit refuses. */
  edit?: (body: unknown, state: LiveState) => Promise<{ status: number; text: string }>;
  /** Writes the project's folder as "." and the home folder as "~" (used on the error path too). */
  scrub?: (text: string) => string;
  /** R4 (H49): a VoxVision highlight's type and bytes for GET /file, or null (404); absent: /file answers 404. */
  file?: (path: string) => { type: string; body: Buffer } | null;
}

/** The largest action body read; a larger one is refused before it is parsed. */
export const ACTION_LIMIT = 4096;
const TOKEN_HEX = /^[0-9a-f]{64}$/;
const NAME_MAX = 512;

/** Strips terminal escapes (CSI, OSC such as OSC 8 links) and other control characters but newlines and tabs. */
export const plainText = (s: string): string => s
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[@-_]/g, '')
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

/** How /observe reads its first argument (src/repl/workspace.ts observe()): the same pattern. */
const OBSERVE_ARGS = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s*([\s\S]*)$/;
/** A project path written so /observe reads it back exactly, or null when no quoting can. */
export function observeArg(rel: string): string | null {
  const plain = !/\s/.test(rel) && !/^["']/.test(rel);
  const arg = plain ? rel : !rel.includes('"') ? `"${rel}"` : !rel.includes("'") ? `'${rel}'` : null;
  if (arg === null) return null;
  const m = arg.match(OBSERVE_ARGS);
  return m && (m[1] ?? m[2] ?? m[3]) === rel && m[4] === '' ? arg : null;
}

type Checked = { ok: true; command: BoardCommand } | { ok: false; status: number; error: string };
const bad = (status: number, error: string): Checked => ({ ok: false, status, error });
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= NAME_MAX && !/[\x00-\x1f\x7f]/.test(v);
const keysAre = (o: Record<string, unknown>, keys: string[]): boolean => {
  const have = Object.keys(o).sort();
  return have.length === keys.length && [...keys].sort().every((k, i) => have[i] === k);
};

/**
 * An action body checked against the board's state: the typed command it stands for, or why not (with
 * the HTTP status). Exact shapes only; a name must be one the state holds right now.
 */
export function checkAction(body: unknown, state: LiveState): Checked {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad(400, 'The action must be a JSON object.');
  const o = body as Record<string, unknown>;
  // R4 (H48): a flow's Stop (the Control Room): only a flow on this board that this REPL runs, as the typed /stop <flow-id>.
  if (o.action === 'stop' && 'flow' in o) {
    if (!keysAre(o, ['action', 'flow']) || !text(o.flow)) return bad(400, 'A flow\'s stop action is {"action":"stop","flow":"<flow id>"}.');
    const flow = (state.flows ?? []).find((f) => f.id === o.flow);
    if (!flow) return bad(404, `No running flow ${o.flow} on this board: /iterate lists the flows.`);
    if (!flow.stoppable) return bad(409, `${flow.id} is ${flow.state}: the board stops only a flow this REPL runs.`);
    if (!FLOW_ID.test(flow.id)) return bad(422, `${flow.id} cannot be written as one /stop argument.`);
    return { ok: true, command: { name: 'stop', args: flow.id, line: `/stop ${flow.id}` } };
  }
  if (o.action === 'stop') {
    if (!keysAre(o, ['action', 'job']) || !text(o.job)) return bad(400, 'A stop action is {"action":"stop","job":"<id>"}.');
    const job = state.jobs.find((j) => j.id === o.job);
    if (!job) return bad(404, `No job ${o.job} on this board: /jobs lists them.`);
    if (!job.stoppable) return bad(409, `${job.id} is ${job.state}: the board stops only a running job this REPL started.`);
    if (/\s/.test(job.id)) return bad(422, `${job.id} cannot be written as one /stop argument.`);
    return { ok: true, command: { name: 'stop', args: job.id, line: `/stop ${job.id}` } };
  }
  if (o.action === 'run') {
    if (!keysAre(o, ['action', 'block', 'doc']) || !text(o.doc) || !text(o.block)) return bad(400, 'A run action is {"action":"run","doc":"<workflow>","block":"<name>"}.');
    const doc = state.workflows.find((w) => w.rel === o.doc);
    if (!doc) return bad(404, `No workflow ${o.doc} on this board: /workflows lists them.`);
    if (!doc.blocks.includes(o.block)) return bad(404, `No block named ${o.block} in ${doc.rel}: ${doc.blocks.join(', ') || 'it has no named blocks'}.`);
    // /run reads one word for the document and one for the block: what it cannot read, the board does not send.
    if (/\s/.test(doc.rel) || /\s/.test(o.block)) return bad(422, `${doc.rel} › ${o.block} cannot be written as /run's two arguments.`);
    return { ok: true, command: { name: 'run', args: `${doc.rel} ${o.block}`, line: `/run ${doc.rel} ${o.block}` } };
  }
  if (o.action === 'observe') {
    if (!keysAre(o, ['action', 'file']) || !text(o.file)) return bad(400, 'An observe action is {"action":"observe","file":"<image>"}.');
    const file = state.files.find((f) => f.rel === o.file);
    if (!file || file.kind !== 'image') return bad(404, `${o.file} is not an image file on this board.`);
    const arg = observeArg(file.rel);
    if (!arg) return bad(422, `${file.rel} cannot be written as /observe's argument.`);
    return { ok: true, command: { name: 'observe', args: arg, line: `/observe ${arg}` } };
  }
  if (o.action === 'rebuild') {
    if (!keysAre(o, ['action', 'recipe']) || !text(o.recipe)) return bad(400, 'A rebuild action is {"action":"rebuild","recipe":"tray"}.');
    if (!(state.recipes ?? []).includes(o.recipe) || !/^[a-z]+$/.test(o.recipe)) return bad(404, `No recipe ${o.recipe} on this board.`);
    return { ok: true, command: { name: 'recipe', args: o.recipe, line: `/recipe ${o.recipe}` } };
  }
  if (o.action === 'vox') return checkVoxAction(o, state.voxFiles ?? [], state.voxRecords ?? []);
  if (o.action === 'lesson') return checkLessonAction(o, state.lessons ?? []); // R4 (H50)
  if (o.action === 'restore') return checkRestoreAction(o, state.restores ?? []); // R4 (H65)
  return bad(400, 'Unknown action: stop, run, observe, rebuild, vox, lesson and restore are the actions.');
}

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

export class LiveBoard {
  /** 32 random bytes, hex: in the page's URL fragment, never in a request URL. */
  readonly token = randomBytes(32).toString('hex');
  private server?: Server;
  private port = 0;
  /** Actions run one at a time, in the order they came. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: LiveBoardDeps) {}

  get listening(): boolean { return !!this.server?.listening; }
  /** Where it answers: http://127.0.0.1:<port>/ (no token). */
  get address(): string { return `http://127.0.0.1:${this.port}/`; }
  /** The page's address with its token in the fragment: what the operator opens. */
  get url(): string { return `${this.address}#t=${this.token}`; }
  get boundPort(): number { return this.port; }
  /** The address the socket is bound to, as the operating system reports it ('127.0.0.1'). */
  get boundHost(): string | undefined { const a = this.server?.address(); return a && typeof a === 'object' ? a.address : undefined; }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res); });
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        server.off('error', reject);
        this.port = (server.address() as AddressInfo).port;
        this.server = server;
        resolve();
      });
    });
  }

  /** Stops answering: the port is closed and open connections are ended. */
  close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  /** The process is exiting at once: close without waiting. */
  closeNow(): void {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.close();
    server.closeAllConnections();
  }

  private headers(res: ServerResponse, type: string, csp = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"): void {
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  }

  private send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}): void {
    this.headers(res, type);
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    res.statusCode = status;
    res.end(body);
  }

  private authorized(req: IncomingMessage): boolean {
    const h = req.headers.authorization;
    const m = typeof h === 'string' ? h.match(/^Bearer ([0-9a-f]{64})$/) : null;
    // Compared in constant time, as hashes of equal length; a malformed header compares an empty string.
    const given = m && TOKEN_HEX.test(m[1]) ? m[1] : '';
    const ok = timingSafeEqual(sha(given), sha(this.token)) && given.length === this.token.length;
    if (ok) this.d.onAuthorized?.();
    return ok;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // DNS rebinding: a page that resolved another name to 127.0.0.1 still sends its own Host.
      if (req.headers.host !== `127.0.0.1:${this.port}`) return this.send(res, 403, 'Refused: this board answers only to 127.0.0.1 with its own port.');
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://127.0.0.1:${this.port}`) return this.send(res, 403, 'Refused: a request from another page.');
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return this.send(res, 405, 'GET only.', undefined, { Allow: 'GET, HEAD' });
        const nonce = randomBytes(18).toString('base64');
        this.headers(res, 'text/html; charset=utf-8',
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
        res.statusCode = 200;
        return void res.end(req.method === 'HEAD' ? undefined : livePage(nonce));
      }
      if (path === '/state') {
        if (req.method !== 'GET') return this.send(res, 405, 'GET only.', undefined, { Allow: 'GET' });
        if (!this.authorized(req)) return this.send(res, 401, 'Refused: no valid token. Open the address /board live printed.', undefined, { 'WWW-Authenticate': 'Bearer' });
        return this.send(res, 200, JSON.stringify(this.d.state()), 'application/json; charset=utf-8');
      }
      if (path === '/action') {
        if (req.method !== 'POST') return this.send(res, 405, 'POST only.', undefined, { Allow: 'POST' });
        if (!this.authorized(req)) return this.send(res, 401, 'Refused: no valid token. Open the address /board live printed.', undefined, { 'WWW-Authenticate': 'Bearer' });
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') return this.send(res, 415, 'Refused: an action is sent as application/json.');
        const raw = await readBody(req, ACTION_LIMIT);
        if (raw === null) return this.send(res, 413, `Refused: an action is at most ${ACTION_LIMIT} bytes.`, undefined, { Connection: 'close' });
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return this.send(res, 400, 'Refused: the action is not valid JSON.'); }
        const run = this.queue.then(async () => {
          const checked = checkAction(body, this.d.state());
          if (!checked.ok) return { status: checked.status, text: checked.error };
          const lines = await this.d.execute(checked.command);
          return { status: 200, text: [`board ${checked.command.line}`, ...lines.map(plainText)].join('\n') };
        });
        this.queue = run.catch(() => undefined);
        const out = await run;
        return this.send(res, out.status, out.text);
      }
      // R4 (H22): the structured edits, under the same checks as an action, with their own size limit.
      if (path === '/edit') {
        if (req.method !== 'POST') return this.send(res, 405, 'POST only.', undefined, { Allow: 'POST' });
        if (!this.authorized(req)) return this.send(res, 401, 'Refused: no valid token. Open the address /board live printed.', undefined, { 'WWW-Authenticate': 'Bearer' });
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') return this.send(res, 415, 'Refused: an edit is sent as application/json.');
        const edit = this.d.edit;
        if (!edit) return this.send(res, 404, 'Not here: this board edits nothing.');
        const raw = await readBody(req, EDIT_LIMIT);
        if (raw === null) return this.send(res, 413, `Refused: an edit is at most ${EDIT_LIMIT} bytes.`, undefined, { Connection: 'close' });
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return this.send(res, 400, 'Refused: the edit is not valid JSON.'); }
        const run = this.queue.then(() => edit(body, this.d.state()));
        this.queue = run.catch(() => undefined);
        const out = await run;
        return this.send(res, out.status, plainText(out.text));
      }
      // R4 (H49): a VoxVision highlight, for the page's script to show as a blob: URL (the token is a header, never in an address).
      if (path === '/file') {
        if (req.method !== 'GET') return this.send(res, 405, 'GET only.', undefined, { Allow: 'GET' });
        if (!this.authorized(req)) return this.send(res, 401, 'Refused: no valid token. Open the address /board live printed.', undefined, { 'WWW-Authenticate': 'Bearer' });
        const f = this.d.file?.(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('p') ?? '');
        if (!f) return this.send(res, 404, 'Not here: no such highlight on this board.');
        // R4 (H60): only bytes no browser runs script in (src/repl/board-file-guard.ts has the audit), as a sandboxed download.
        const image = imageOnly(f.type, f.body);
        if (!image.ok) return this.send(res, 404, `Not shown: this highlight is not an image the board shows (${image.why}).`);
        this.headers(res, image.type);
        for (const [k, v] of Object.entries(FILE_HEADERS)) res.setHeader(k, v);
        res.statusCode = 200;
        return void res.end(f.body);
      }
      return this.send(res, 404, 'Not here: this board has /, /state, /action, /edit and /file.');
    } catch (err) {
      if (!res.headersSent) this.send(res, 500, `The board could not answer: ${err instanceof Error ? plainText((this.d.scrub ?? ((t: string) => t))(err.message)) : 'error'}`);
      else res.destroy();
    }
  }
}

/** The request body up to `limit` bytes, or null when it is longer (the rest is not read). */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { req.resume(); return resolve(null); }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

const LIVE_CSS = `
.live { color: ${HOMEBREW.accent}; }
#status { min-height: 1.5em; }
#status.bad { color: ${HOMEBREW.failure}; }
.act { font: inherit; font-size: 12px; font-weight: 600; color: ${HOMEBREW.ground}; background: ${HOMEBREW.accent}; border: 1px solid ${HOMEBREW.accent}; border-radius: 6px; padding: 3px 10px; cursor: pointer; align-self: flex-start; margin-right: 6px; }
.act:hover, .act:focus-visible { outline: 2px solid ${HOMEBREW.text}; outline-offset: 1px; }
.act[disabled] { opacity: .55; cursor: progress; }
.blocks .act { margin-left: 2px; }
#out { white-space: pre-wrap; overflow-wrap: anywhere; background: ${HOMEBREW.surface}; border: 1px solid ${HOMEBREW.line}; border-radius: 8px; padding: 10px 12px; margin: 0 0 12px; font-size: 13px; }
#out[hidden] { display: none; }
#out.bad { border-color: ${HOMEBREW.failure}; }
`;

/**
 * The page's one script. The token comes from the fragment and stays in this closure; requests carry it
 * as a header. Sections are drawn from the state's HTML, which the server escaped; a job's state and
 * time are updated in place, and the sections are redrawn only when their shape changes and no action
 * is in flight. Text from responses is set with textContent, never as HTML.
 *
 * R4 (H45): a flow card's <details> carry a key (data-keep, "<flow-id>:<part>") and say whether they were drawn open
 * (data-open-default). Before a redraw, each one the operator opened or closed against its default is noted by its key;
 * after it, the new one with that key is set as the operator left it. One whose default changed meanwhile (a flow that
 * failed) follows its new default unless the operator had chosen otherwise. Nothing is stored outside this page's memory.
 *
 * R4 (H60): the token handoff between tabs of this board. A tab opened without the token (Timmy Canvas's "Open on the
 * board" links the bare address and a section, #room) asks for it on a BroadcastChannel named for the board's port:
 * exactly {t:"timmy-board-token?", n:<32 hex, new each tab>}. A tab that holds the token, and whose last /state the board
 * accepted, answers only that shape, only when the message's origin is its own (a channel never crosses origins: another
 * port on 127.0.0.1 is another origin), with {t:"timmy-board-token", n:<the same n>, k:<the token>}; the asking tab takes
 * only an answer to its own n. The token stays in this closure: never in the address (a section anchor is kept there,
 * the token never), never in storage, never in the page's text, never on Timmy Canvas. No other document is served on the
 * board's origin to listen (src/repl/board-file-guard.ts has the audit). A tab no other tab answers says how to open the
 * board from Timmy, and keeps asking while it is open.
 */
const LIVE_SCRIPT = `
(function () {
  'use strict';
  var m = /(?:^#|&)t=([0-9a-f]{64})(?:&|$)/.exec(location.hash);
  var token = m ? m[1] : '';
  // R4 (H60): a section named in the address (#room, from Timmy Canvas) stays there and is shown once the board is drawn.
  var section = !m && /^#[a-z][a-z0-9-]{0,40}$/.test(location.hash) ? location.hash.slice(1) : '';
  try { history.replaceState(null, '', location.pathname + (section ? '#' + section : '')); } catch (e) {}
  var main = document.getElementById('main');
  var toc = document.getElementById('toc');
  var status = document.getElementById('status');
  var out = document.getElementById('out');
  var project = document.getElementById('project');
  var shape = '';
  var busy = 0;
  var say = function (t, isBad) { status.textContent = t; status.className = 'sub' + (isBad ? ' bad' : ''); };
  var paint = function () {
    var sw = main.querySelectorAll('[data-swatch]');
    for (var i = 0; i < sw.length; i++) { var c = sw[i].getAttribute('data-swatch'); if (/^#[0-9a-f]{6}$/i.test(c)) sw[i].style.background = c; }
  };
  var jobs = function (list) {
    var byId = {};
    for (var i = 0; i < list.length; i++) byId[list[i].id] = list[i];
    var cards = main.querySelectorAll('[data-job-card]');
    for (var k = 0; k < cards.length; k++) {
      var j = byId[cards[k].getAttribute('data-job-card')];
      if (!j) continue;
      var st = cards[k].querySelector('.state');
      if (st) { st.textContent = j.state; st.className = 'state state-' + j.state.replace(/[^a-z]/gi, ''); }
      var stop = cards[k].querySelector('button[data-act="stop"]');
      if (stop && !j.stoppable && !stop.disabled) stop.hidden = true;
    }
  };
  // R4 (H45): the operator's open or closed <details>, by key, kept across redraws (in memory only).
  var kept = Object.create(null);
  var remember = function () {
    var ds = main.querySelectorAll('details[data-keep]');
    for (var i = 0; i < ds.length; i++) {
      var k = ds[i].getAttribute('data-keep');
      if (ds[i].open !== ds[i].hasAttribute('data-open-default')) kept[k] = ds[i].open; else delete kept[k];
    }
  };
  var restore = function () {
    var ds = main.querySelectorAll('details[data-keep]');
    for (var i = 0; i < ds.length; i++) {
      var k = ds[i].getAttribute('data-keep');
      if (k in kept) ds[i].open = kept[k];
    }
  };
  var apply = function (s) {
    project.textContent = s.project;
    document.title = 'Live board · ' + s.project;
    // R4: a card being edited (data-editing) is never drawn over; jobs still update in place.
    if (s.shape !== shape && !busy && !main.querySelectorAll('[data-editing]').length) {
      remember(); toc.innerHTML = s.toc; main.innerHTML = s.html; restore(); shape = s.shape; paint(); if (typeof TimmyVox !== 'undefined') TimmyVox.paint(main);
      // R4 (H60): the section the address named, once its section is drawn.
      if (section) { var at = document.getElementById(section); if (at && at.scrollIntoView) at.scrollIntoView(); section = ''; }
    }
    else { jobs(s.jobs); if (typeof TimmyBoardEdit !== 'undefined' && TimmyBoardEdit.states) TimmyBoardEdit.states(s.wfStates); }
  };
  // R4 (H60): the token handoff between this board's tabs (see the comment above this script).
  var ASK = 'timmy-board-token?';
  var GIVE = 'timmy-board-token';
  var HEX64 = /^[0-9a-f]{64}$/;
  var HEX32 = /^[0-9a-f]{32}$/;
  var NO_TOKEN = 'No token: this tab was opened without the token of this board, and no other open tab of this board gave it one. In Timmy, type /board live: it gives you the address of this board with its token.';
  var good = false;
  var asked = '';
  var since = 0;
  var channel = null;
  try { if (typeof BroadcastChannel === 'function' && location.port) channel = new BroadcastChannel('timmy-board-' + location.port); } catch (e) { channel = null; }
  var only = function (d, keys) { var k = Object.keys(d).sort(); return k.join(',') === keys.join(','); };
  var ask = function () {
    if (!channel || typeof crypto === 'undefined' || !crypto.getRandomValues) return false;
    if (!asked) {
      var b = new Uint8Array(16);
      crypto.getRandomValues(b);
      for (var i = 0; i < b.length; i++) asked += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    }
    try { channel.postMessage({ t: ASK, n: asked }); return true; } catch (e) { return false; }
  };
  var poll;
  if (channel) channel.onmessage = function (e) {
    var d = e.data;
    if (e.origin !== location.origin || !d || typeof d !== 'object' || Array.isArray(d)) return;
    // A request: answered only by a tab whose token the board accepted, and only in this shape.
    if (d.t === ASK && only(d, ['n', 't']) && typeof d.n === 'string' && HEX32.test(d.n)) {
      if (token && good) channel.postMessage({ t: GIVE, n: d.n, k: token });
      return;
    }
    // An answer: taken only for this tab's own request, while it has no token.
    if (d.t === GIVE && only(d, ['k', 'n', 't']) && asked && d.n === asked && !token && typeof d.k === 'string' && HEX64.test(d.k)) {
      token = d.k;
      asked = '';
      poll();
    }
  };
  poll = function () {
    if (!token) {
      var asking = ask();
      if (!since) { since = Date.now(); if (asking) setTimeout(function () { if (!token) poll(); }, 1500); }
      if (asking && Date.now() - since < 1500) say('No token in this tab yet: asking the other tabs of this board for it.');
      else say(NO_TOKEN, true);
      return;
    }
    fetch('/state', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw r.status; return r.json(); })
      .then(function (s) { good = true; apply(s); say('live · ' + s.madeAt + ' · updates every 2 s'); },
        function (e) {
          if (e === 401) good = false;
          say(e === 401 ? 'Refused: the board did not take the token of this tab (it was started again). In Timmy, type /board live: it gives you the address of this board with its token.' : 'Not connected: /board live in Timmy starts the board again.', true);
        });
  };
  var act = function (b) {
    var a = b.getAttribute('data-act');
    var body = a === 'stop' ? { action: 'stop', job: b.getAttribute('data-job') }
      // R4 (H48): the Control Room's Stop: the same stop action, for a job or (data-flow) a flow.
      : a === 'room-stop' ? (b.hasAttribute('data-flow') ? { action: 'stop', flow: b.getAttribute('data-flow') } : { action: 'stop', job: b.getAttribute('data-job') })
      : a === 'run' ? { action: 'run', doc: b.getAttribute('data-doc'), block: b.getAttribute('data-block') }
      : a === 'observe' ? { action: 'observe', file: b.getAttribute('data-file') }
      : a === 'rebuild' ? { action: 'rebuild', recipe: b.getAttribute('data-recipe') }
      : a === 'vox' && typeof TimmyVox !== 'undefined' ? TimmyVox.body(b)
      // R4 (H50): Memory's Check on a lesson.
      : a === 'lesson-check' ? { action: 'lesson', verb: 'check', id: b.getAttribute('data-lesson') }
      // R4 (H65): the review's Restore: the file and the kept version it names, checked again by Timmy.
      : a === 'restore' ? { action: 'restore', file: b.getAttribute('data-file'), from: b.getAttribute('data-from') } : null;
    if (!body || !token) return;
    var label = b.textContent;
    b.disabled = true; b.textContent = label + ' …'; busy++;
    fetch('/action', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', credentials: 'omit' })
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, t: t }; }); })
      .then(function (x) { out.hidden = false; out.textContent = x.t; out.className = x.ok ? '' : 'bad'; },
        function () { out.hidden = false; out.textContent = 'The action did not reach Timmy: is /board live still running?'; out.className = 'bad'; })
      .then(function () { busy--; b.disabled = false; b.textContent = label; poll(); });
  };
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    var b = t.closest('button[data-act]');
    if (b) { if (!b.disabled) act(b); return; }
    var c = t.closest('[data-cmd]');
    if (!c) return;
    var cmd = c.getAttribute('data-cmd');
    var shown = function () { c.setAttribute('data-copied', ''); setTimeout(function () { c.removeAttribute('data-copied'); }, 1400); };
    var select = function () { var s = window.getSelection(); if (s) s.selectAllChildren(c); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cmd).then(shown, select); else select();
  });
  // R4: the editor (EDIT_SCRIPT) sends its edits through this function; the token stays in this closure.
  var sendEdit = function (body) {
    if (!token) return Promise.reject(new Error('no token'));
    return fetch('/edit', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', credentials: 'omit' })
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, status: r.status, t: t }; }); });
  };
  if (typeof TimmyBoardEdit !== 'undefined') TimmyBoardEdit.attach({ send: sendEdit, refresh: poll });
  // R4 (H49): VoxVision's highlights, fetched with the token (it stays in this closure).
  if (typeof TimmyVox !== 'undefined') TimmyVox.attach({ get: function (p) { return fetch('/file?p=' + encodeURIComponent(p), { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', credentials: 'omit' }); } });
  poll();
  setInterval(poll, 2000);
})();
`;

/** The page: its shell only. It names no project and holds no project data; the state brings both. */
export function livePage(nonce: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<title>Live board · Timmy</title>',
    `<style nonce="${nonce}">${BOARD_CSS}${LIVE_CSS}${EDIT_CSS}</style>`,
    '</head>',
    '<body>',
    '<header>',
    '<h1>Board · <span class="project" id="project"></span> <span class="live">live</span></h1>',
    '<p class="sub" id="status">connecting…</p>',
    '<p class="sub">Stop, Run, Observe, Rebuild, VoxVision\'s Inspect, Measure, Detect and Compare, Memory\'s Check and the review\'s Restore act through Timmy as the typed command, shown in Timmy as coming from the board. Saving parameters or workflow blocks is checked by Timmy, which keeps the previous version. A green command copies itself.</p>',
    '<pre id="out" hidden></pre>',
    '<nav class="toc" id="toc"></nav>',
    '</header>',
    '<main id="main"></main>',
    '<footer>Served by /board live on 127.0.0.1 for this Timmy session; /board off or leaving Timmy stops it. Measured values are deterministic computations on the pixels, shown as measured only when an observe receipt sealed the file and its image is unchanged; a model\'s claim is not a measurement.</footer>',
    // R4: one script, the editor first (it defines TimmyBoardEdit, which the live script hands its send to).
    `<script nonce="${nonce}">${EDIT_SCRIPT}${VOX_LIVE_SCRIPT}${LIVE_SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
