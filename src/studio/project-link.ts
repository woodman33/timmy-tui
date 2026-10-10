/**
 * Round R4 (H55): which project Timmy Canvas shows. The REPL names its active project to the canvas server (on /canvas
 * open, when the server is the REPL's own as it starts, on a /project switch, and when /board live starts or stops), and
 * the server answers a read-only project API from it: GET /api/project, the project's cards (src/studio/project-cards.ts).
 *
 * The handoff, POST /api/project/active, is protected as the bridge is, and more:
 * - Host and Origin, as every route of this server (isLocalRequest in server.ts): this machine only;
 * - it comes from Timmy's REPL, never from a page: a request that carries an Origin header is refused;
 * - `Authorization: Bearer <token>`, 32 random bytes the server makes as it starts, compared in constant time. The REPL
 *   that started the server holds it in memory; `timmy studio` and the REPL's own server also keep it, with their pid, in
 *   <canvas folder>/project-token-<port> (mode 0600), so another REPL of the same user and Timmy home can name its project
 *   there, and another user of the machine cannot; a file whose process is gone is not used;
 * - JSON only, at most 4 KB, these keys only: root, name, jobs, receipts, board and (R4 H75) holder: a random id the REPL
 *   names itself with when it takes the actions of Timmy Canvas's drawn cards (src/studio/card-relay.ts).
 *
 * The server reads only what the REPL named: the project's folder, its jobs folder and its receipts store. It never answers
 * with a path it was given: the project's name, its id (a hash of its folder, as receipts name it) and project-relative
 * paths only. The live board's address may be named (http://127.0.0.1:<port>/ exactly, so never its token); the canvas
 * links to it and keeps it nowhere.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import type express from 'express';
import { projectId } from '../project/index.js';
import { projectCards, type CardSource, type ProjectCards } from './project-cards.js';

export const PROJECT_TOKEN = /^[0-9a-f]{64}$/;
/** The live board's address as /board live prints it, without its token: nothing after the slash. */
export const BOARD_ADDRESS = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/$/;
export const HANDOFF_LIMIT = 4096;
const NAME_MAX = 120;
const PATH_MAX = 4096;
const KEYS = new Set(['root', 'name', 'jobs', 'receipts', 'board', 'holder']);
/** R4 (H75): the id a REPL that takes the drawn cards' actions names itself with (32 hex). */
export const HOLDER_ID = /^[0-9a-f]{32}$/;

/** What the REPL named, as the server keeps it (never sent back but its name and id). */
export interface NamedProject extends CardSource {
  /** a hash of the project's real folder (projectId), as its receipts name it */
  id: string;
  /** the live board's address, while /board live runs */
  board: string | null;
  since: string;
  /** R4 (H75): the REPL that takes this project's card actions (its own random id), or null: none does */
  holder: string | null;
}

// ── the token file ───────────────────────────────────────────────────────────

export const projectTokenFile = (dir: string, port: number): string => join(dir, `project-token-${port}`);

/** Writes the token with this process's pid (mode 0600, written whole); false when it cannot be written. */
export function writeProjectToken(dir: string, port: number, token: string, pid = process.pid): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const file = projectTokenFile(dir, port);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ token, pid })}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** The token a canvas server on `port` left in `dir`: only a regular file, in its shape, whose process still runs. */
export function readProjectToken(dir: string, port: number): string | null {
  try {
    const file = projectTokenFile(dir, port);
    if (!lstatSync(file).isFile()) return null;
    const o = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown; pid?: unknown };
    if (typeof o.token !== 'string' || !PROJECT_TOKEN.test(o.token) || !Number.isInteger(o.pid) || (o.pid as number) <= 0) return null;
    return alive(o.pid as number) ? o.token : null;
  } catch { return null; }
}

/** Removes the token file when it still holds this token (another server may have written its own since). */
export function dropProjectToken(dir: string, port: number, token: string): void {
  try {
    const file = projectTokenFile(dir, port);
    const o = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown };
    if (o.token === token) unlinkSync(file);
  } catch { /* gone, or not ours */ }
}

// ── the named project ────────────────────────────────────────────────────────

type Named = { ok: true; project: NamedProject } | { ok: false; status: number; error: string };
const bad = (status: number, error: string): Named => ({ ok: false, status, error });
const sha = (s: string): Buffer => createHash('sha256').update(s).digest();
const pathOk = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= PATH_MAX && !v.includes('\0') && isAbsolute(v);

export class ProjectLink {
  readonly token: string;
  private named: NamedProject | null = null;

  constructor(token?: string) {
    this.token = token && PROJECT_TOKEN.test(token) ? token : randomBytes(32).toString('hex');
  }

  /** The project the REPL named last, or null. */
  get project(): NamedProject | null { return this.named; }

  /** Whether an Authorization header carries this server's token (constant time; a malformed header compares nothing). */
  authorized(header: unknown): boolean {
    const m = typeof header === 'string' ? /^Bearer ([0-9a-f]{64})$/.exec(header) : null;
    const given = m ? m[1] : '';
    return timingSafeEqual(sha(given), sha(this.token)) && given.length === this.token.length;
  }

  /** Checks a handoff's body and keeps it: exact keys, an absolute folder that is one, a plain name, the board's bare address. */
  name(body: unknown, now = new Date()): Named {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad(400, 'Send JSON: {"root": "<the project folder>", "name": "<its name>", "jobs": …, "receipts": …, "board": …}.');
    const o = body as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !KEYS.has(k));
    if (extra.length) return bad(400, `Unknown field${extra.length > 1 ? 's' : ''}: ${extra.slice(0, 5).map((k) => JSON.stringify(k).slice(0, 40)).join(', ')}. The fields are root, name, jobs, receipts, board and holder.`);
    if (!pathOk(o.root)) return bad(400, 'root must be the project folder, an absolute path.');
    if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(o.name)) return bad(400, `name must be the project's name: 1 to ${NAME_MAX} characters, no control characters.`);
    for (const k of ['jobs', 'receipts'] as const) if (o[k] !== undefined && o[k] !== null && !pathOk(o[k])) return bad(400, `${k} must be an absolute path, or null.`);
    if (o.board !== undefined && o.board !== null && (typeof o.board !== 'string' || !BOARD_ADDRESS.test(o.board))) return bad(400, 'board must be the live board\'s address as /board live prints it (http://127.0.0.1:<port>/, nothing after it), or null.');
    if (o.holder !== undefined && o.holder !== null && (typeof o.holder !== 'string' || !HOLDER_ID.test(o.holder))) return bad(400, 'holder must be the 32 hex characters the REPL names itself with, or null.');
    let dir = false;
    try { dir = statSync(o.root as string).isDirectory(); } catch { dir = false; }
    // The folder is not named back: the answer says only that it is not one.
    if (!dir) return bad(404, 'The folder named as the project is not a folder on this machine.');
    const root = resolve(o.root as string);
    this.named = {
      root, name: o.name.trim(), id: projectId(root),
      jobs: typeof o.jobs === 'string' ? resolve(o.jobs) : null, receipts: typeof o.receipts === 'string' ? resolve(o.receipts) : null,
      board: typeof o.board === 'string' ? o.board : null, since: now.toISOString(),
      holder: typeof o.holder === 'string' ? o.holder : null,
    };
    return { ok: true, project: this.named };
  }
}

// ── the routes ───────────────────────────────────────────────────────────────

/** The request body up to `limit` bytes, or null when it is longer (the rest is not kept). */
export function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((done, fail) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { req.resume(); return done(null); }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; done(null); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) done(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', fail);
  });
}

const NOT_NAMED = 'Timmy has not named a project to this canvas yet. In Timmy: /canvas open.';

export interface ProjectRoutes {
  link: ProjectLink;
  /** whether a canvas page holds the bridge */
  pageOpen: () => boolean;
  /** the cards of a named project, with (R4 H75) their drawn cards' detail when asked (a test may give its own reader; the default is projectCards) */
  cards?: (p: NamedProject, detail: boolean) => ProjectCards;
  /** R4 (H75): whether a REPL takes the named project's card actions now (src/studio/card-relay.ts) */
  holding?: (p: NamedProject) => boolean;
  /** R4 (H75): a project was named (by a REPL; another holder, or none, may hold it now) */
  named?: (p: NamedProject) => void;
}

/** POST /api/project/active (the handoff), GET /api/project/active (what is named) and GET /api/project (its cards). */
export function mountProjectRoutes(app: express.Express, o: ProjectRoutes): void {
  const cards = o.cards ?? ((p: NamedProject, detail: boolean) => projectCards(p, {}, { detail }));
  app.post('/api/project/active', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers.origin !== undefined) {
      res.status(403).json({ ok: false, error: 'The project is named by Timmy\'s REPL, never by a page.' });
      return;
    }
    if (!o.link.authorized(req.headers.authorization)) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({ ok: false, error: 'Refused: no valid token. Timmy\'s REPL names its project with the token this canvas server made.' });
      return;
    }
    if (!req.is('application/json')) {
      res.status(415).json({ ok: false, error: 'Send JSON.' });
      return;
    }
    let raw: string | null;
    try { raw = await readBody(req, HANDOFF_LIMIT); } catch { res.status(400).json({ ok: false, error: 'The request could not be read.' }); return; }
    if (raw === null) {
      res.status(413).set('Connection', 'close').json({ ok: false, error: `A handoff is at most ${HANDOFF_LIMIT} bytes.` });
      return;
    }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { res.status(400).json({ ok: false, error: 'Send valid JSON.' }); return; }
    const named = o.link.name(body);
    if (!named.ok) {
      res.status(named.status).json({ ok: false, error: named.error });
      return;
    }
    o.named?.(named.project);
    res.json({ ok: true, project: { name: named.project.name, id: named.project.id }, board: named.project.board !== null });
  });
  app.get('/api/project/active', (_req, res) => {
    const p = o.link.project;
    res.set('Cache-Control', 'no-store').json({
      ok: true, app: 'timmy-canvas', project: p ? { name: p.name, id: p.id } : null, since: p?.since ?? null, board: Boolean(p?.board), pageConnected: o.pageOpen(),
    });
  });
  app.get('/api/project', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const p = o.link.project;
    const madeAt = new Date().toISOString();
    // R4 (H75): ?detail=1 adds each card's drawn-card detail and whether a REPL takes the project's card actions now.
    const detail = req.query.detail === '1';
    if (!p) {
      res.json({ ok: true, project: null, madeAt, board: null, cards: [], notes: [], message: NOT_NAMED, ...(detail ? { actions: { holder: false, words: 'No project is named to this canvas: in Timmy, /canvas open.' } } : {}) });
      return;
    }
    let gone = false;
    try { gone = !statSync(p.root).isDirectory(); } catch { gone = true; }
    const read: ProjectCards = gone ? { cards: [], notes: ['The project\'s folder is not there any more: in Timmy, /project names another.'] } : cards(p, detail);
    const holding = o.holding?.(p) === true;
    res.json({
      ok: true, project: { name: p.name, id: p.id }, madeAt, board: p.board ? { address: p.board } : null, cards: read.cards, notes: read.notes,
      ...(detail ? {
        actions: {
          holder: holding,
          words: holding ? `The Timmy REPL that named ${p.name} takes its cards' actions from this canvas.`
            : p.holder ? `No Timmy REPL takes ${p.name}'s card actions now: the one that named it is not asking (it ended, or another named its project since). Type a card's command in Timmy, or /canvas open there.`
              : `The Timmy REPL that named ${p.name} does not take card actions from this canvas (an older Timmy, or one started without them). Type a card's command in Timmy.`,
        },
      } : {}),
    });
  });
}
