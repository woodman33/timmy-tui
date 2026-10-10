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
 *   memory only (no storage, no cookie) and drops it from the address bar;
 * - the page itself carries no project data: everything comes from the token-protected state;
 * - actions are POST only, JSON only, at most 4 KB, one of three shapes, each checked against the current
 *   state, then run as the typed command they stand for (`/stop <id>`, `/run <doc> <block>`,
 *   `/observe <file>`) through the same Workspace method, so approvals, policies and receipts are the
 *   same. No free command text is accepted;
 * - every response is no-store and nosniff with no referrer, no CORS header, and a Content-Security-Policy
 *   that allows only this page's own nonce'd script and style and requests to itself.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BOARD_CSS } from './board.js';
import { HOMEBREW } from '../theme/tokens.js';

/** An action as the page sends it: one of three shapes, nothing else. */
export type BoardAction =
  | { action: 'stop'; job: string }
  | { action: 'run'; doc: string; block: string }
  | { action: 'observe'; file: string };

/** The typed command a valid action stands for: its name, its argument string and the line as typed. */
export interface BoardCommand { name: 'stop' | 'run' | 'observe'; args: string; line: string }

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
}

export interface LiveBoardDeps {
  /** A request carried the valid token (round R4: the page that opened the board is then no longer needed). */
  onAuthorized?: () => void;
  /** The board as it is now (read for every request, so a switched project shows at once). */
  state: () => LiveState;
  /** Runs a checked action as its typed command; the lines it printed, as plain text (no ANSI). */
  execute: (command: BoardCommand) => Promise<string[]>;
  /** Writes the project's folder as "." and the home folder as "~" (used on the error path too). */
  scrub?: (text: string) => string;
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
  return bad(400, 'Unknown action: stop, run and observe are the actions.');
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
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
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
      return this.send(res, 404, 'Not here: this board has /, /state and /action.');
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
 */
const LIVE_SCRIPT = `
(function () {
  'use strict';
  var m = /(?:^#|&)t=([0-9a-f]{64})(?:&|$)/.exec(location.hash);
  var token = m ? m[1] : '';
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
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
  var apply = function (s) {
    project.textContent = s.project;
    document.title = 'Live board · ' + s.project;
    if (s.shape !== shape && !busy) { toc.innerHTML = s.toc; main.innerHTML = s.html; shape = s.shape; paint(); }
    else jobs(s.jobs);
  };
  var poll = function () {
    if (!token) { say('No token: open the address /board live printed in Timmy.', true); return; }
    fetch('/state', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw r.status; return r.json(); })
      .then(function (s) { apply(s); say('live · ' + s.madeAt + ' · updates every 2 s'); },
        function (e) { say(e === 401 ? 'Refused: this page has no valid token. Open the address /board live printed.' : 'Not connected: /board live in Timmy starts the board again.', true); });
  };
  var act = function (b) {
    var a = b.getAttribute('data-act');
    var body = a === 'stop' ? { action: 'stop', job: b.getAttribute('data-job') }
      : a === 'run' ? { action: 'run', doc: b.getAttribute('data-doc'), block: b.getAttribute('data-block') }
      : a === 'observe' ? { action: 'observe', file: b.getAttribute('data-file') } : null;
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
    `<style nonce="${nonce}">${BOARD_CSS}${LIVE_CSS}</style>`,
    '</head>',
    '<body>',
    '<header>',
    '<h1>Board · <span class="project" id="project"></span> <span class="live">live</span></h1>',
    '<p class="sub" id="status">connecting…</p>',
    '<p class="sub">Stop, Run and Observe act through Timmy as the typed command, shown in Timmy as coming from the board. A green command copies itself.</p>',
    '<pre id="out" hidden></pre>',
    '<nav class="toc" id="toc"></nav>',
    '</header>',
    '<main id="main"></main>',
    '<footer>Served by /board live on 127.0.0.1 for this Timmy session; /board off or leaving Timmy stops it. Measured values are deterministic computations on the pixels, shown as measured only when an observe receipt sealed the file and its image is unchanged; a model\'s claim is not a measurement.</footer>',
    `<script nonce="${nonce}">${LIVE_SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
