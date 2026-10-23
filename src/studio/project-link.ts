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
 *   names itself with when it takes the actions of Timmy Canvas's drawn cards (src/studio/card-relay.ts); and (R7 H149) follow:
 *   true when the naming is a REPL's switch (its /project, or its follow of the active project), passed on only while the canvas
 *   is that REPL's (it holds what is shown, or the canvas followed the active project itself since that REPL last named one).
 *
 * The server reads only what the REPL named: the project's folder, its jobs folder and its receipts store. It never answers
 * with a path it was given: the project's name, its id (a hash of its folder, as receipts name it) and project-relative
 * paths only. R4 (H81): the cards' detail (?detail=1: every block's command, every parameter file's values) only with the
 * server's token or a canvas page's session that counts now (src/studio/card-relay.ts), else 401 (R5 H137: to a page's session
 * paused now, a plain 200 that says why, with nothing of the project: src/studio/session-pause.ts). R4 (H83): the card list
 * (GET /api/project) and the named project's name and id (GET /api/project/active) likewise: they are the project's content;
 * without a credential, /api/project/active says only whether a project is named and whether a page is open. The live
 * board's address may be named (http://127.0.0.1:<port>/ exactly, so never its token); the canvas links to it and keeps it
 * nowhere.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import type express from 'express';
import { projectId } from '../project/index.js';
import { projectCards, type CardSource, type ProjectCards } from './project-cards.js';
import { pausedRefusal } from './session-pause.js';

export const PROJECT_TOKEN = /^[0-9a-f]{64}$/;
/** The live board's address as /board live prints it, without its token: nothing after the slash. */
export const BOARD_ADDRESS = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/$/;
export const HANDOFF_LIMIT = 4096;
const NAME_MAX = 120;
const PATH_MAX = 4096;
const KEYS = new Set(['root', 'name', 'jobs', 'receipts', 'board', 'holder', 'follow']);
/**
 * R7 (H149): what a REPL's switch passed on (`follow: true`: its /project, or its follow of the active project) is told when the
 * canvas is another REPL's: the switch is not passed on, and the canvas keeps what it shows.
 */
export const FOLLOW_REFUSED = (shown: string): string => `Not passed on: another Timmy REPL holds the canvas now (it shows ${shown} for it), so this REPL's switch is not shown there. In this REPL: /canvas open names its project to the canvas and opens it.`;
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
  /**
   * R4 (H109): how it came to be shown: named by a Timmy REPL (`repl`), or followed by this server from the active-project file
   * of its Timmy home (`active`, src/studio/active-follow.ts; never with a holder)
   */
  via?: 'repl' | 'active';
}

/** R4 (H109): how many projects named in this server's life it keeps, so a board pinned to one keeps reading it. */
export const KNOWN_MAX = 8;

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
  /** R4 (H109): the projects named in this server's life (the newest last), by id: what a pinned board may keep reading */
  private readonly known = new Map<string, NamedProject>();
  /** R4 (H109): the last project a REPL named (its jobs folder and receipts store are this Timmy home's) */
  private lastRepl: NamedProject | null = null;
  /** R7 (H149): each REPL holder's last naming (what restore gives back), and the holder of each project's last naming by a REPL */
  private readonly byHolder = new Map<string, NamedProject>();
  private readonly namer = new Map<string, string | null>();

  constructor(token?: string) {
    this.token = token && PROJECT_TOKEN.test(token) ? token : randomBytes(32).toString('hex');
  }

  /** The project the REPL named last, or null. */
  get project(): NamedProject | null { return this.named; }

  /** R4 (H109): a project named in this server's life, by its id (null when it was never named here, or many were since). */
  knownProject(id: string): NamedProject | null { return this.known.get(id) ?? null; }

  private keep(p: NamedProject): void {
    this.known.delete(p.id);
    this.known.set(p.id, p);
    while (this.known.size > KNOWN_MAX) this.known.delete(this.known.keys().next().value!);
  }

  /**
   * R4 (H109): names the active project of this Timmy home, followed from its file (src/studio/active-follow.ts): the folder the
   * file names, read with the jobs folder and receipts store a REPL named last (else `fallback`'s), no live board, and no holder.
   */
  follow(a: { name: string; root: string }, fallback: { jobs: string | null; receipts: (root: string) => string | null }, now = new Date()): NamedProject {
    const root = resolve(a.root);
    const from = this.lastRepl;
    this.named = {
      root, name: a.name.trim().slice(0, NAME_MAX) || root, id: projectId(root),
      jobs: from ? from.jobs : fallback.jobs, receipts: from ? from.receipts : fallback.receipts(root),
      board: null, since: now.toISOString(), holder: null, via: 'active',
    };
    this.keep(this.named);
    return this.named;
  }

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
    if (extra.length) return bad(400, `Unknown field${extra.length > 1 ? 's' : ''}: ${extra.slice(0, 5).map((k) => JSON.stringify(k).slice(0, 40)).join(', ')}. The fields are root, name, jobs, receipts, board, holder and follow.`);
    if (!pathOk(o.root)) return bad(400, 'root must be the project folder, an absolute path.');
    if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(o.name)) return bad(400, `name must be the project's name: 1 to ${NAME_MAX} characters, no control characters.`);
    for (const k of ['jobs', 'receipts'] as const) if (o[k] !== undefined && o[k] !== null && !pathOk(o[k])) return bad(400, `${k} must be an absolute path, or null.`);
    if (o.board !== undefined && o.board !== null && (typeof o.board !== 'string' || !BOARD_ADDRESS.test(o.board))) return bad(400, 'board must be the live board\'s address as /board live prints it (http://127.0.0.1:<port>/, nothing after it), or null.');
    if (o.holder !== undefined && o.holder !== null && (typeof o.holder !== 'string' || !HOLDER_ID.test(o.holder))) return bad(400, 'holder must be the 32 hex characters the REPL names itself with, or null.');
    if (o.follow !== undefined && typeof o.follow !== 'boolean') return bad(400, 'follow is true (a REPL\'s switch, passed on only while the canvas is that REPL\'s) or false.');
    // R7 (H149): a REPL's switch is passed on while the canvas is that REPL's: it holds the project shown, or the canvas followed
    // the active project itself since that REPL was the last to name one (a follow takes the canvas from no REPL); else refused
    if (o.follow === true && this.named) {
      const holder = typeof o.holder === 'string' ? o.holder : null;
      const claim = (this.named.via ?? 'repl') === 'active' ? this.lastRepl?.holder ?? null : this.named.holder;
      if (holder === null || claim !== holder) return bad(409, FOLLOW_REFUSED(this.named.name));
    }
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
      via: 'repl',
    };
    // R4 (H109): kept, so a board pinned to it keeps reading it; and this Timmy home's jobs folder and store, for a follow
    this.keep(this.named);
    this.lastRepl = this.named;
    // R7 (H149): what this REPL named last, and who named this project last
    this.namer.set(this.named.id, this.named.holder);
    if (this.named.holder) this.byHolder.set(this.named.holder, this.named);
    while (this.byHolder.size > KNOWN_MAX) this.byHolder.delete(this.byHolder.keys().next().value!);
    while (this.namer.size > KNOWN_MAX * 4) this.namer.delete(this.namer.keys().next().value!);
    return { ok: true, project: this.named };
  }

  /**
   * R7 (H149; R6 defect N1): the canvas followed the active project back to a project a REPL still holds. A REPL whose last naming
   * was project `id`, that was the last REPL to name it, and that still names it now (`holder` asks for actions for it: src/studio/
   * card-relay.ts, its standby) is its holder again, by its own naming (its folder, jobs folder, receipts store and board), as
   * though it had named it now. Only while the canvas shows `id` as followed (`via: 'active'`, no holder); null otherwise.
   */
  restore(holder: string, id: string, now = new Date()): NamedProject | null {
    const shown = this.named;
    if (!shown || shown.id !== id || (shown.via ?? 'repl') !== 'active' || shown.holder !== null) return null;
    const last = this.byHolder.get(holder);
    if (!last || last.id !== id || this.namer.get(id) !== holder) return null;
    this.named = { ...last, since: now.toISOString(), via: 'repl' };
    this.keep(this.named);
    this.lastRepl = this.named;
    return this.named;
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
  /**
   * R4 (H81): who may read the cards' detail (?detail=1: each block's command, each parameter file's values) besides the REPL
   * with this server's token: a canvas page whose session counts now for `p` (src/studio/card-relay.ts sessionFor). Absent:
   * the server's token only.
   */
  pageSession?: (authorization: unknown, p: NamedProject | null) => { ok: true } | { ok: false; why: string; words: string };
  /**
   * R4 (H109): whether a page's session reaches project `id` (it was given for it, or followed it since: src/studio/card-relay.ts
   * reaches), for a board pinned to it while the canvas shows another. Absent: no page reads a project not shown.
   */
  reach?: (authorization: unknown, id: string) => { ok: true } | { ok: false; why: string; words: string };
  /** R4 (H109): the active project of this Timmy home, as its file names it now (src/studio/active-follow.ts); absent: not said */
  active?: () => { name: string; id: string; at: string | null } | null;
  /**
   * R7 (H149, the shape agreed with H151): a switch this canvas is about to make (src/studio/active-follow.ts ActiveFollower.pending:
   * the active-project file names another project than the one shown, and no REPL has named it yet), or null; absent: not said
   */
  pending?: () => { id: string; name: string; since: string } | null;
}

/** R4 (H109): what a page is told of a project this server never named (or named too long ago to keep). */
export const PIN_UNKNOWN = 'This canvas server does not know that project now (it restarted since, or it has named many others since), so this board, pinned to it, is shown as last read. In Timmy: /canvas open, from that project, names it here again.';

/** R4 (H81): what a reading of the cards' detail without the server's token or a page session is told. */
export const DETAIL_REFUSED = 'Refused: the cards\' detail (their commands and values) is read with Timmy\'s token or a canvas page\'s session. In Timmy: /canvas open.';
/** R4 (H83): what a reading of the card list without the server's token or a page session is told (the list is the project's content too). */
export const CARDS_REFUSED = 'Refused: the project\'s cards are read with Timmy\'s token or a canvas page\'s session. In Timmy: /canvas open.';

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
  // R4 (H83): which project is named (its name and id) only with the server's token or a page session that counts now: a project's
  // name is its content. Without either: whether one is named, and whether a page is open, nothing more.
  const credited = (req: express.Request, p: NamedProject | null): { ok: true } | { ok: false; why: string; words: string } => {
    if (o.link.authorized(req.headers.authorization)) return { ok: true };
    return o.pageSession?.(req.headers.authorization, p) ?? { ok: false, why: 'none', words: CARDS_REFUSED };
  };
  // R4 (H109): the active project of this Timmy home (its name, id and when it was chosen), said with the project shown; null when
  // its file names none; absent (undefined, so left out of the answer) from a server that does not follow it
  const activeNow = (): { name: string; id: string; at: string | null } | null | undefined => {
    if (!o.active) return undefined;
    try { const a = o.active(); return a ? { name: a.name, id: a.id, at: a.at } : null; } catch { return null; }
  };
  // R7 (H149, with H151): the switch pending now, as { project: { id, name }, since } or null; absent from a server that does not follow
  const pendingNow = (): { project: { id: string; name: string }; since: string } | null | undefined => {
    if (!o.pending) return undefined;
    try { const s = o.pending(); return s ? { project: { id: s.id, name: s.name }, since: s.since } : null; } catch { return null; }
  };
  app.get('/api/project/active', (req, res) => {
    const p = o.link.project;
    res.set('Cache-Control', 'no-store');
    if (p && !credited(req, p).ok) {
      res.json({ ok: true, app: 'timmy-canvas', project: null, named: true, hidden: true, since: null, board: false, pageConnected: o.pageOpen(),
        words: 'A project is named to this canvas; which one is said only with Timmy\'s token or a canvas page\'s session. In Timmy: /canvas.' });
      return;
    }
    res.json({
      ok: true, app: 'timmy-canvas', project: p ? { name: p.name, id: p.id } : null, named: Boolean(p), since: p?.since ?? null, board: Boolean(p?.board), pageConnected: o.pageOpen(),
      // R4 (H109): how it came to be shown, and the active project of this Timmy home; R7 (H149): a switch pending now
      via: p ? p.via ?? 'repl' : null, active: activeNow(), pending: pendingNow(),
    });
  });
  app.get('/api/project', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const named = o.link.project;
    const madeAt = new Date().toISOString();
    // R4 (H75): ?detail=1 adds each card's drawn-card detail and whether a REPL takes the project's card actions now.
    const detail = req.query.detail === '1';
    // R4 (H109): ?project=<id>: a board pinned to a project reads that project while the canvas shows another (a page's session
    // reads it only when it reaches it: given for it, or followed to it); the project shown otherwise
    const asked = typeof req.query.project === 'string' ? req.query.project : null;
    if (asked !== null && !/^[0-9a-f]{16}$/.test(asked)) { res.status(400).json({ ok: false, error: 'project is a project\'s id: 16 hex characters.' }); return; }
    const pinned = asked !== null && asked !== (named?.id ?? null);
    // R5 (H137): a paused session's refusal is a plain 200 with nothing of the project (src/studio/session-pause.ts): the panel
    // reads the cards every few seconds by itself, and a REPL's /canvas open may have taken the canvas since its last reading
    const refusing = (why: string): express.Response => (pausedRefusal(why) ? res.status(200) : res.status(401).set('WWW-Authenticate', 'Bearer'));
    if (pinned) {
      const r = o.link.authorized(req.headers.authorization) ? { ok: true as const } : o.reach?.(req.headers.authorization, asked) ?? { ok: false as const, why: 'none', words: CARDS_REFUSED };
      if (!r.ok) {
        refusing(r.why).json({ ok: false, error: r.why === 'none' ? (detail ? DETAIL_REFUSED : CARDS_REFUSED) : r.words, session: r.why, pinned: true });
        return;
      }
    }
    const p = pinned ? o.link.knownProject(asked!) : named;
    if (pinned && !p) { res.status(404).json({ ok: false, error: PIN_UNKNOWN, pinned: true }); return; }
    // R4 (H81): the detail holds each block's whole command and each parameter file's values: never to any local process
    // without a credential. The REPL reads it with this server's token, a canvas page with a session that counts now. R4 (H83):
    // the plain list too (titles, states, typed commands, records): it is the project's content.
    if (!pinned) {
      const s = credited(req, p);
      if (!s.ok) {
        const refused = detail ? DETAIL_REFUSED : CARDS_REFUSED;
        refusing(s.why).json({ ok: false, error: s.why === 'none' ? refused : s.words, session: s.why });
        return;
      }
    }
    if (!p) {
      res.json({ ok: true, project: null, madeAt, board: null, cards: [], notes: [], operations: [], message: NOT_NAMED, active: activeNow(), ...(detail ? { actions: { holder: false, words: 'No project is named to this canvas: in Timmy, /canvas open.' } } : {}) });
      return;
    }
    let gone = false;
    try { gone = !statSync(p.root).isDirectory(); } catch { gone = true; }
    const read: ProjectCards = gone ? { cards: [], notes: ['The project\'s folder is not there any more: in Timmy, /project names another.'] } : cards(p, detail);
    // R4 (H109): a pinned board's project acts through no REPL here (the canvas shows another); the project shown, as before
    const holding = !pinned && o.holding?.(p) === true;
    // R4 (H109): the project the canvas shows, beside a pinned board's own (named only to a caller it counts for)
    const shownToo = pinned && named && (o.link.authorized(req.headers.authorization) || o.pageSession?.(req.headers.authorization, named).ok === true) ? { name: named.name, id: named.id } : null;
    const followed = (p.via ?? 'repl') === 'active'
      ? [`Timmy Canvas follows the active project of this Timmy home (state/active-project.json): ${p.name}. No Timmy REPL took its cards' actions when it was followed: /canvas open in Timmy, in ${p.name}, gives them to that REPL.`]
      : [];
    res.json({
      // R4 (H100): with the operations the cards name, each as its own record says it, its cards in the order they ran
      ok: true, project: { name: p.name, id: p.id }, madeAt, board: p.board && !pinned ? { address: p.board } : null, cards: read.cards, notes: [...followed, ...read.notes], operations: read.operations ?? [],
      // R4 (H109): how it came to be shown; the active project of this Timmy home; a pinned board's reading says so, and what is shown
      via: p.via ?? 'repl', active: activeNow(), ...(pinned ? { pinned: true, shown: shownToo } : {}),
      ...(detail ? {
        actions: {
          holder: holding,
          words: pinned ? `This board is pinned to ${p.name}, and the canvas shows ${shownToo ? shownToo.name : 'another project'} now: ${p.name}'s cards are read here and act through no Timmy REPL. To act on them: /canvas open in Timmy, in ${p.name}.`
            : holding ? `The Timmy REPL that named ${p.name} takes its cards' actions from this canvas.`
              : (p.via ?? 'repl') === 'active' ? `No Timmy REPL takes ${p.name}'s card actions: the canvas followed it as the active project of this Timmy home. Type a card's command in Timmy, or /canvas open there.`
                : p.holder ? `No Timmy REPL takes ${p.name}'s card actions now: the one that named it is not asking (it ended, or another named its project since). Type a card's command in Timmy, or /canvas open there.`
                  : `The Timmy REPL that named ${p.name} does not take card actions from this canvas (an older Timmy, or one started without them). Type a card's command in Timmy.`,
        },
      } : {}),
    });
  });
}
