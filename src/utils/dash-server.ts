/**
 * Round R4 (helper H97): the server of TIMMY Studios' dashboard and the Slate pages (`/panes`, `/publish`, the legacy Slate
 * panel's site and canvas panes), on this computer only, serving only what those pages need.
 *
 * Before, src/utils/dash.ts started `python3 -m http.server 4273 --directory <the working folder>`: Python's server listens
 * on every network address of the computer by default, and it served the whole working folder, its `.env` and `.timmy/`
 * (receipts, tokens, private settings) included, to anyone who could reach the port. Now it is Node's own server, in the
 * Timmy that asked for it (it ends with that Timmy), and:
 *   - it listens on 127.0.0.1 only, and answers only under Timmy's local rule (src/utils/local-request.ts isLocalRequest:
 *     Host 127.0.0.1, localhost or [::1]; Origin, when a browser sends one, a page of this computer), so another computer
 *     cannot reach it and a page elsewhere cannot rebind a name of its own to it;
 *   - GET and HEAD only, and only:
 *       /                         a short page that says what this is and where the dashboard is;
 *       /health                   that it is Timmy's dashboard server, and for which folder (a hash, never a path);
 *       /data/generations.json    the generation ledger's rows as the dashboard draws them (from .timmy/generations.json,
 *                                 read here: the file itself is never served), with the frames' addresses;
 *       /data/events.jsonl        the last 25 lines of .timmy/runs/events.jsonl (the dashboard's event list);
 *       /studio/<path>            a regular file under <folder>/studio (the dashboard, each Slate project's site, canvas,
 *                                 refs, generations and frames, and the files the Projects panel opens), never through a
 *                                 link that leads out of it, never a dotfile or a file in a dot folder;
 *     anything else is refused: a dotfile or a private folder anywhere in the address (`.env`, `.timmy/…`, `.git/…`) with
 *     403, everything else of the folder with 404; a folder is never listed;
 *   - every answer has nosniff, no-store, no referrer and same-origin resources; a page has a Content-Security-Policy that
 *     lets it load nothing from elsewhere (an older canvas page on disk that asks a CDN for code gets nothing);
 *   - a failure answers with words, no path of this computer and no stack (src/utils/server-failure.ts).
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, createReadStream, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import { loadGenerations } from './generations.js';
import { tildePath } from './home-scrub.js';
import { isLocalRequest, refuseRequest } from './local-request.js';
import { failRequest } from './server-failure.js';

/** The dashboard's port (its pages' addresses name it). */
export const DASH_PORT = 4273;
/** What /health says this server is. */
export const DASH_SERVER = 'timmy-dash';

export const DASH_FOREIGN = 'Refused: Timmy\'s dashboard server answers only this computer\'s own pages (127.0.0.1 or localhost).';
export const DASH_PRIVATE = 'Refused: a dotfile or a private folder (.env, .timmy, .git and the like) is never served.';
export const DASH_NOT_SERVED = 'Not served: Timmy\'s dashboard server serves the files of this folder\'s studio/ (its pages and what they show) and the dashboard\'s two records, and nothing else of the folder.';
export const DASH_BAD_PATH = 'Not an address this server reads (a path that leaves its folder, or that cannot be read as one).';
export const DASH_METHOD = 'Only GET and HEAD are answered here; nothing was changed.';
export const DASH_FAILED = 'Timmy\'s dashboard server could not read what this request needs, so it answers with nothing and changed nothing. It is still running.';

/** The pages' policy: everything from this server only (inline script and style allowed: the pages are Timmy's own files). */
export const DASH_PAGE_POLICY = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  "media-src 'self'", "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');
/** An SVG opened as a document: drawn, never run. */
const SVG_POLICY = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.cue': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
};
const typeOf = (file: string): string => TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/** The folder's id that /health gives: a hash of its real path (never the path). */
export function dashRootId(root: string): string {
  let real = path.resolve(root);
  try { real = realpathSync(real); } catch { /* as given */ }
  return createHash('sha256').update(real).digest('hex').slice(0, 16);
}

/** A ledger row as the dashboard draws it. `cost`: the reported dollars; null when it is not known (a placeholder); absent when none was recorded. */
export interface DashGeneration {
  id: string; created_at: string; provider: string; model?: string; status: string; prompt: string;
  cost?: number | null; frameCount?: number; frames: string | null; artifact?: string;
}

/** A path's address under /studio/, when it is a folder or file of `<root>/studio` with no dot segment; else null. */
export function studioAddress(root: string, abs: string | undefined): string | null {
  if (!abs) return null;
  const rel = path.relative(path.join(path.resolve(root), 'studio'), path.resolve(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.some((p) => p === '' || p.startsWith('.'))) return null;
  return `/studio/${parts.map(encodeURIComponent).join('/')}`;
}

/** The ledger's rows for the dashboard (only what it draws; no hash, span or decision; paths never absolute). */
export function dashGenerations(root: string): DashGeneration[] {
  return loadGenerations(root).map((g) => {
    const artifact = g.artifact ? (() => {
      const rel = path.relative(path.resolve(root), path.resolve(root, g.artifact!));
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : tildePath(g.artifact!);
    })() : undefined;
    return {
      id: g.id, created_at: g.created_at, provider: g.provider, ...(g.model ? { model: g.model } : {}), status: g.status, prompt: g.prompt,
      // a declared-unknown cost (cost_measured false) is not known, never $0
      ...(g.cost_measured === false ? { cost: null } : typeof g.cost_usd === 'number' ? { cost: g.cost_usd } : {}),
      ...(typeof g.frameCount === 'number' ? { frameCount: g.frameCount } : {}),
      frames: studioAddress(root, g.framesDir),
      ...(artifact ? { artifact } : {}),
    };
  });
}

/** The last `n` lines of a file, read from its end (at most 64 KiB); '' when it cannot be read. */
function lastLines(file: string, n: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return '';
    const size = Math.min(st.size, 64 * 1024);
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, st.size - size);
    const lines = buf.toString('utf8').split('\n');
    if (size < st.size) lines.shift(); // the first line read from the middle of the file is a part of a line
    return lines.filter(Boolean).slice(-n).join('\n');
  } catch { return ''; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The root page: what this server is, in Timmy's look (its tokens; no file, no script). */
function rootPage(): string {
  return ['<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TIMMY Studios: this computer only</title>',
    `<style>body{margin:0;padding:24px;background:${HOMEBREW.ground};color:${HOMEBREW.text};font:${TYPE.size.body}px/${TYPE.lineHeight} ${TYPE.stack}}`,
    `a{color:${HOMEBREW.link}}code{color:${HOMEBREW.accent}}p{max-width:72ch}</style></head><body>`,
    `<p>${esc('Timmy\'s dashboard server: this computer only (127.0.0.1). It serves the files of this folder\'s studio/ and the dashboard\'s records, nothing else.')}</p>`,
    '<p><a href="/studio/dashboard.html">The dashboard</a> (written by <code>/panes</code>).</p>',
    '</body></html>', ''].join('\n');
}

/** Headers every answer carries. */
function safety(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

function send(req: IncomingMessage, res: ServerResponse, type: string, body: string | Buffer): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  if (type.startsWith('text/html')) res.setHeader('Content-Security-Policy', DASH_PAGE_POLICY);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** What an address under /studio/ is: a file to send, or why not (a status and its words). */
export function studioFile(root: string, pathname: string): { file: string } | { status: 400 | 403 | 404; words: string } {
  const raw = pathname.slice('/studio/'.length).split('/');
  const parts: string[] = [];
  for (const p of raw) {
    let d: string;
    try { d = decodeURIComponent(p); } catch { return { status: 400, words: DASH_BAD_PATH }; }
    if (d === '' || d === '.' || d === '..' || /[\\/\0]/.test(d)) return { status: d === '' ? 404 : 400, words: d === '' ? DASH_NOT_SERVED : DASH_BAD_PATH };
    if (d.startsWith('.')) return { status: 403, words: DASH_PRIVATE };
    parts.push(d);
  }
  let base: string;
  let real: string;
  try { base = realpathSync(path.join(path.resolve(root), 'studio')); } catch { return { status: 404, words: DASH_NOT_SERVED }; }
  try { real = realpathSync(path.join(base, ...parts)); } catch { return { status: 404, words: DASH_NOT_SERVED }; }
  const rel = path.relative(base, real);
  // a link that leads out of studio/, or into a dot folder or dotfile in it: refused like the address itself would be
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { status: 404, words: DASH_NOT_SERVED };
  if (rel.split(path.sep).some((s) => s.startsWith('.'))) return { status: 403, words: DASH_PRIVATE };
  return { file: real };
}

/** Sends a regular file (opened once, checked by what was opened: never a folder, a FIFO or a device). */
function sendFile(req: IncomingMessage, res: ServerResponse, file: string): void {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { failRequest(res, 404, DASH_NOT_SERVED, 'text'); return; }
  let size = 0;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) { closeSync(fd); failRequest(res, 404, DASH_NOT_SERVED, 'text'); return; }
    size = st.size;
  } catch { try { closeSync(fd); } catch { /* closed */ } failRequest(res, 500, DASH_FAILED, 'text'); return; }
  const type = typeOf(file);
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  if (type.startsWith('text/html')) res.setHeader('Content-Security-Policy', DASH_PAGE_POLICY);
  else if (type === 'image/svg+xml') res.setHeader('Content-Security-Policy', SVG_POLICY);
  res.setHeader('Content-Length', size);
  if (req.method === 'HEAD') { closeSync(fd); res.end(); return; }
  const stream = createReadStream('', { fd, autoClose: true });
  stream.on('error', () => { res.destroy(); });
  stream.pipe(res);
}

/** The request handler for the folder `root`. */
export function dashHandler(root: string): (req: IncomingMessage, res: ServerResponse) => void {
  const id = dashRootId(root);
  return (req, res) => {
    try {
      safety(res);
      if (!isLocalRequest(req)) { refuseRequest(res, 403, DASH_FOREIGN); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); failRequest(res, 405, DASH_METHOD, 'text'); return; }
      let pathname: string;
      try { pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname; } catch { failRequest(res, 400, DASH_BAD_PATH, 'text'); return; }
      // a dotfile or a dot folder anywhere in the address (as sent, or decoded): refused before anything is looked at
      const segments = pathname.split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
      if (segments.some((s) => s.startsWith('.') && s !== '.' && s !== '..')) { failRequest(res, 403, DASH_PRIVATE, 'text'); return; }
      if (pathname === '/' || pathname === '/index.html') { send(req, res, 'text/html; charset=utf-8', rootPage()); return; }
      if (pathname === '/health') { send(req, res, 'application/json; charset=utf-8', JSON.stringify({ ok: true, server: DASH_SERVER, root: id })); return; }
      if (pathname === '/data/generations.json') { send(req, res, 'application/json; charset=utf-8', JSON.stringify({ generations: dashGenerations(root) })); return; }
      if (pathname === '/data/events.jsonl') { send(req, res, 'text/plain; charset=utf-8', lastLines(path.join(path.resolve(root), '.timmy', 'runs', 'events.jsonl'), 25)); return; }
      if (pathname.startsWith('/studio/')) {
        const f = studioFile(root, pathname);
        if ('file' in f) sendFile(req, res, f.file);
        else failRequest(res, f.status, f.words, 'text');
        return;
      }
      failRequest(res, 404, DASH_NOT_SERVED, 'text');
    } catch { failRequest(res, 500, DASH_FAILED, 'text'); }
  };
}

export interface DashServer {
  /** the folder it serves */
  root: string;
  port: number;
  /** http://127.0.0.1:<port> */
  base: string;
  server: Server;
  close(): Promise<void>;
}

/**
 * Starts the server for the folder `root` on 127.0.0.1:`port` (0: a free port). It does not keep the process alive by
 * itself (unref): it serves while the Timmy that started it runs. Rejects with the listen error (EADDRINUSE: the port is
 * taken).
 */
export function startDashServer(o: { root: string; port?: number }): Promise<DashServer> {
  const root = path.resolve(o.root);
  const server = createServer(dashHandler(root));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? DASH_PORT, '127.0.0.1', () => {
      server.removeListener('error', reject);
      server.unref();
      const port = (server.address() as AddressInfo).port;
      resolve({
        root, port, base: `http://127.0.0.1:${port}`, server,
        close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections?.(); }),
      });
    });
  });
}

/** What answers on 127.0.0.1:`port`: Timmy's dashboard server (and for which folder's id), something else, or nothing. */
export async function dashHealth(port: number, timeoutMs = 1500): Promise<{ state: 'timmy'; root: string } | { state: 'other' | 'none' }> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    const body = await r.text();
    try {
      const j = JSON.parse(body) as { server?: unknown; root?: unknown };
      if (r.ok && j.server === DASH_SERVER && typeof j.root === 'string') return { state: 'timmy', root: j.root };
    } catch { /* not ours */ }
    return { state: 'other' };
  } catch { return { state: 'none' }; }
}
