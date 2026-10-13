/**
 * Round R4 (H75): Timmy Canvas's drawn cards act through the Timmy REPL that holds the project, never in this server. The
 * canvas server only carries an action from the canvas page to that REPL and its answer back; the REPL checks it against the
 * live board's own state and runs it through the live board's own path (src/repl/canvas-actions.ts): Run and Rebuild as the
 * board's run and rebuild actions (the typed /run and /recipe, as the REPL's own jobs), a parameter save as the board's
 * set-params or set-scad-params edit (the file guard, the previous version kept, a human-gated edit receipt).
 *
 * Who may do what, each refused otherwise (tests/studio-card-relay.test.ts):
 * - The REPL that named the project (POST /api/project/active with the server's token, src/studio/project-link.ts) says it
 *   takes actions by naming a `holder`, a random id of its own; it then asks for them at GET /api/project/inbox (a long poll)
 *   and answers at POST /api/project/inbox/<id>. Both carry the server's token and no Origin (they come from the REPL, never
 *   a page), and only the holder of the project named now is given its actions.
 * - The page gets the right to act from the REPL, never from this server alone: `/canvas open` asks for a grant (POST
 *   /api/project/grant: the server's token, no Origin; 128 random bits, one use, 2 minutes; R4 H81: for the project named
 *   then and the REPL holding it, so it is refused while no project is named) and opens the page with it in the address's
 *   fragment, which a browser never sends; the page removes it from the address at once and trades it, in a JSON body, for
 *   a session (POST /api/project/session): 32 random bytes kept only in the page's memory and only their sha256 here. A
 *   page opened any other way, or reloaded, has none, and its cards say so and give the typed command.
 * - R4 (H81): a session lasts SESSION_MS (12 hours) from its making, not renewed by use, and counts only for the project and
 *   the holder its grant was made for: once another project (or another REPL, or none) holds the canvas, it neither reads
 *   the cards' detail nor acts until the canvas shows that project from that REPL again. /canvas open gives a new one.
 *   R4 (H109; the operator's direction of 2026-10-11, "Following windows change project together; pinned windows keep their
 *   visibly identified project"): a session follows the project its own REPL names next (the same holder: that REPL's /project)
 *   and the active project this server followed from its Timmy home's file (src/studio/active-follow.ts, `via: 'active'`, no
 *   holder); another REPL's project (another holder, or none named by a REPL) stays refused, as before. Every project a
 *   session has counted for is its reach: a board pinned to one of them keeps reading it (GET /api/project?project=<id>,
 *   read only), and nothing else.
 * - R4 (H81): the cards' detail (GET /api/project?detail=1: each block's command, each parameter file's values) is read with
 *   the server's token (the REPL) or a page session that counts now (src/studio/project-link.ts); the plain card list (GET
 *   /api/project) needs neither.
 * - A page's action (POST /api/project/act) passes the live board's own rules for actions: Host is exactly this server's
 *   address (127.0.0.1 or localhost with its own port) and Origin is exactly that page's; `Authorization: Bearer <session>`,
 *   a session that counts now; JSON only, at most ACT_LIMIT bytes, exactly {project, card, act}; the act one of run,
 *   rebuild, set-params and set-scad-params, and the one its card offers (a workflow card runs its own document, a
 *   parameter card saves and rebuilds its own file); the card's project the one named now; and a REPL holding it now.
 *   Nothing else is relayed; the token goes in a header, never in an address or a log.
 * - What these rules prove, and what they do not (R4 H81): a request that passes them came from this canvas page, which
 *   holds a session. They cannot tell the page's own code from other code running in it: the agent's canvas_exec runs its
 *   code in the page (companion/studio-canvas/src/canvas.js). The page's own code sends an action only for a person's click
 *   on a button it drew, and keeps the session where such code cannot read it (companion/studio-canvas/src/cards.js), but
 *   code on the page can still change what the page shows and move a button under a person's next click. The REPL's own
 *   NEEDS YOU box for canvas_exec, asked before every script (src/repl/approvals.ts), is the barrier for code on the page;
 *   and the REPL checks every action against the live board's state, asks NEEDS YOU before a risky block, and records it.
 *   R4 (H83): the bridge's own route, POST /api/canvas/exec (src/studio/server.ts), takes code only with this server's token
 *   (in an Authorization header) and, while a project is named, only from the REPL that holds it (its holder id); and the
 *   bridge sends code only to a page that joined with a session that counts now (src/studio/bridge.ts). So the code a page
 *   runs comes from the REPL that holds its project, which asked NEEDS YOU about it.
 * - An action no REPL picked up in PICKUP_MS was not run, and the page is told so; one picked up but not answered in
 *   ANSWER_MS may have run, and the page is told that instead.
 *
 * GET /api/project/image serves the one kind of image the board's highlights are (src/repl/board-vox.ts voxFileFor: a shown
 * highlight of a verified or stale VoxVision record, its bytes still the ones it recorded) through the board's own guard
 * (src/repl/board-file-guard.ts: a PNG by its signature, an SVG only as plain drawing), as a download under a sandboxing policy.
 * R4 (H83): it is the project's content, so it is served only with the server's token or a page session that counts now (the
 * page fetches it with its session and shows it from memory: companion/studio-canvas/src/cards.js).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type express from 'express';
import { paramsFileFor } from '../native/scad-params.js';
import { paramsPath } from '../recipes/params-file.js';
import { FILE_HEADERS, imageOnly } from '../repl/board-file-guard.js';
import { voxFileFor } from '../repl/board-vox.js';
import { inProject } from './card-detail.js';
import { cardText, readRunsChain } from './project-cards.js';
import { HOLDER_ID, readBody, type NamedProject, type ProjectLink } from './project-link.js';

/** The actions a canvas card sends: the live board's run and rebuild actions and its two parameter saves. */
export const CARD_ACTS = ['run', 'rebuild', 'set-params', 'set-scad-params'] as const;
export type CardAct = (typeof CARD_ACTS)[number];
export const GRANT = /^[0-9a-f]{32}$/;
const SESSION = /^Bearer ([0-9a-f]{64})$/;
/** The largest page action read (an OpenSCAD parameter save is the largest an act carries). */
export const ACT_LIMIT = 32 * 1024;
const ANSWER_LIMIT = 64 * 1024;
const SESSIONS_MAX = 32;
const GRANTS_MAX = 64;
export const GRANT_MS = 120_000;
/** R4 (H81): how long a page's session lasts from its making (use does not renew it; /canvas open gives a new one). */
export const SESSION_MS = 12 * 60 * 60 * 1000;
export const POLL_MS = 25_000;
export const PICKUP_MS = 10_000;
export const ANSWER_MS = 120_000;
/**
 * A holder counts as listening while it waits in a poll, and this long after its last poll ended (it asks again at once,
 * or after running the action it was handed: an action starts a job and answers, it does not wait for the job). A poll
 * that goes away without an answer (the REPL ended) ends it at once.
 */
const LISTEN_MS = 15_000;

export const NO_SESSION = 'Refused: this canvas page has no session to act with. A page opened by Timmy\'s /canvas open gets one; a page opened another way, or reloaded, has none. In Timmy: /canvas open.';
/** R4 (H83): what a reading of a highlight without the server's token or a page session is told. */
export const IMAGE_REFUSED = 'Refused: a highlight of the project is read with Timmy\'s token or a canvas page\'s session. In Timmy: /canvas open.';
const FROM_REPL = 'Refused: this route is for Timmy\'s REPL, never a page.';

/** One action on its way to the REPL: what the page sent, checked, with an id of its own. */
export interface CardEnvelope { id: string; project: string; card: string; act: Record<string, unknown> }
export interface CardAnswer { status: number; text: string }

interface Pending {
  envelope: CardEnvelope;
  holder: string;
  handed: boolean;
  done: (a: CardAnswer) => void;
  timer: NodeJS.Timeout;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const keysAre = (o: Record<string, unknown>, keys: string[]): boolean => {
  const have = Object.keys(o).sort();
  return have.length === keys.length && [...keys].sort().every((k, i) => have[i] === k);
};
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Whether an act is one the card offers (null when it is; else why not): Run on a workflow card, for its own document;
 * a parameter card's save and Rebuild, for its own file. The REPL checks the act itself against the live board's state.
 */
export function actFits(card: string, act: Record<string, unknown>): string | null {
  const at = card.indexOf(':');
  const kind = at > 0 ? card.slice(0, at) : '';
  const rest = at > 0 ? card.slice(at + 1) : '';
  if (act.action === 'run') return kind === 'workflow' && act.doc === rest ? null : 'Run is a workflow card\'s action, for its own document.';
  if (act.action === 'rebuild' || act.action === 'set-params') {
    return kind === 'params' && typeof act.recipe === 'string' && /^[a-z]+$/.test(act.recipe) && rest === paramsPath(act.recipe) ? null : 'Save and Rebuild are a recipe parameter card\'s actions, for its own file.';
  }
  if (act.action === 'set-scad-params') {
    return kind === 'params' && typeof act.model === 'string' && /\.scad$/i.test(act.model) && rest === paramsFileFor(act.model) ? null : 'Save is an OpenSCAD parameter card\'s action, for its own file.';
  }
  return `A canvas card sends ${CARD_ACTS.join(', ')}; nothing else.`;
}

export interface RelayOptions { now?: () => number; pollMs?: number; pickupMs?: number; answerMs?: number; grantMs?: number; sessionMs?: number }

/** R4 (H81): what a grant, and the session traded for it, was made for: the project named then (its id) and its holder. */
export interface SessionFor { project: string; holder: string | null }

/** R4 (H81): whether a page's session counts now, and why not in words (`why`: none, unknown, expired, project, holder). */
export type SessionCheck = { ok: true } | { ok: false; why: 'none' | 'unknown' | 'expired' | 'project' | 'holder'; words: string };

const SESSION_WORDS = {
  none: NO_SESSION,
  unknown: 'Refused: this canvas page\'s session is not one this canvas server made (it restarted since, or the session was let go). In Timmy: /canvas open.',
  expired: 'Refused: this canvas page\'s session has ended (a session lasts 12 hours). In Timmy: /canvas open gives the page a new one.',
  project: 'Refused: this canvas page\'s session was given for another project than the one the canvas shows now. In Timmy: /canvas open, from the REPL that holds this project.',
  holder: 'Refused: this canvas page\'s session was given by another Timmy REPL than the one that holds the project now. In Timmy: /canvas open, from the REPL that holds it.',
} as const;

/** R4 (H109): what a board pinned to a project this page's session never counted for is told. */
export const PIN_WORDS = 'Refused: this board is pinned to a project this canvas page was never opened for (nor followed to), so it does not read it. In Timmy: /canvas open, from that project.';

/** The grants, the page sessions, and the actions waiting for (or handed to) the REPL that holds the project. */
export class CardRelay {
  /** R4 (H81): each grant with when it ends and what it was made for */
  private readonly grants = new Map<string, { until: number; for: SessionFor }>();
  /**
   * sha256 of each page session token, with when it ends and what it was given for (R4 H81): the tokens themselves are kept
   * only by the pages. R4 (H109): and its reach, the projects it has counted for (the one given, and those it followed since).
   */
  private readonly sessions = new Map<string, { until: number; for: SessionFor; reach: Set<string> }>();
  private readonly queue: Pending[] = [];
  private readonly handed = new Map<string, Pending>();
  private poller: { holder: string; give: (e: CardEnvelope | null) => void } | null = null;
  private readonly seen = new Map<string, number>();
  private closed = false;

  constructor(private readonly o: RelayOptions = {}) {}

  private now(): number { return this.o.now?.() ?? Date.now(); }

  /** The server is stopping: no more polls are held. */
  get stopping(): boolean { return this.closed; }

  /**
   * A one-time grant for a page the REPL opens (its fragment carries it). R4 (H81): for the project named now and the REPL
   * holding it (`forWhat`); the session traded for it counts only for them.
   */
  grant(forWhat: SessionFor): { grant: string; expires: string } {
    const now = this.now();
    for (const [g, x] of this.grants) if (x.until <= now) this.grants.delete(g);
    while (this.grants.size >= GRANTS_MAX) this.grants.delete(this.grants.keys().next().value!);
    const grant = randomBytes(16).toString('hex');
    const until = now + (this.o.grantMs ?? GRANT_MS);
    this.grants.set(grant, { until, for: { project: forWhat.project, holder: forWhat.holder } });
    return { grant, expires: new Date(until).toISOString() };
  }

  /**
   * A page's session for a grant, once: null when the grant was never made here, was used, or has expired. R4 (H81): it
   * lasts SESSION_MS from now and counts for what its grant was made for.
   */
  exchange(grant: string): string | null {
    const g = this.grants.get(grant);
    if (g === undefined) return null;
    this.grants.delete(grant);
    const now = this.now();
    if (g.until <= now) return null;
    const token = randomBytes(32).toString('hex');
    for (const [h, s] of this.sessions) if (s.until <= now) this.sessions.delete(h);
    this.sessions.set(sha(token), { until: now + (this.o.sessionMs ?? SESSION_MS), for: g.for, reach: new Set([g.for.project]) });
    while (this.sessions.size > SESSIONS_MAX) this.sessions.delete(this.sessions.keys().next().value!);
    return token;
  }

  /** Whether an Authorization header carries a page session made here that has not ended (by the sha256 of its token). */
  session(header: unknown): boolean {
    const m = typeof header === 'string' ? SESSION.exec(header) : null;
    const s = m ? this.sessions.get(sha(m[1])) : undefined;
    return !!s && s.until > this.now();
  }

  /** R4 (H83): the key a session is known by here (the sha256 of its token), from an Authorization header; null without one. */
  static keyOf(header: unknown): string | null {
    const m = typeof header === 'string' ? SESSION.exec(header) : null;
    return m ? sha(m[1]) : null;
  }

  /** R4 (H83): the key of a session token itself (64 hex), as a page sends it in its bridge subprotocol. */
  static keyOfToken(token: string): string { return sha(token); }

  /**
   * R4 (H81): whether a page's session counts now for `named` (the project named to the canvas now, or null): made here, not
   * ended, and given for that project and the REPL holding it now. With no project named, a session that has not ended counts
   * (there is nothing of a project to read or act on). An ended session is let go.
   */
  sessionFor(header: unknown, named: Pick<NamedProject, 'id' | 'holder' | 'via'> | null): SessionCheck {
    return this.countsByKey(CardRelay.keyOf(header), named);
  }

  /**
   * R4 (H83): sessionFor by the session's key (the bridge keeps each page's key, never its token). R4 (H109): a session also
   * counts for the project its own REPL (the holder its grant was made for) names next, and for the active project this server
   * followed (`via: 'active'`); either is added to its reach.
   */
  countsByKey(key: string | null, named: Pick<NamedProject, 'id' | 'holder' | 'via'> | null): SessionCheck {
    const no = (why: Exclude<SessionCheck, { ok: true }>['why']): SessionCheck => ({ ok: false, why, words: SESSION_WORDS[why] });
    if (!key) return no('none');
    const s = this.sessions.get(key);
    if (!s) return no('unknown');
    if (s.until <= this.now()) { this.sessions.delete(key); return no('expired'); }
    if (!named) return { ok: true };
    const given = s.for.project === named.id && s.for.holder === named.holder;
    const follows = (named.holder !== null && named.holder === s.for.holder) || named.via === 'active';
    if (given || follows) { s.reach.add(named.id); return { ok: true }; }
    if (s.for.project !== named.id) return no('project');
    return no('holder');
  }

  /**
   * R4 (H109): whether a page's session reaches project `id` (it was given for it, or has counted for it since), for a board
   * pinned to it while the canvas shows another project: read only, never an action.
   */
  reaches(header: unknown, id: string): SessionCheck {
    const key = CardRelay.keyOf(header);
    if (!key) return { ok: false, why: 'none', words: SESSION_WORDS.none };
    const s = this.sessions.get(key);
    if (!s) return { ok: false, why: 'unknown', words: SESSION_WORDS.unknown };
    if (s.until <= this.now()) { this.sessions.delete(key); return { ok: false, why: 'expired', words: SESSION_WORDS.expired }; }
    return s.reach.has(id) ? { ok: true } : { ok: false, why: 'project', words: PIN_WORDS };
  }

  /** R4 (H109): the projects a page's session reaches now (empty when it has none, or it ended). */
  reachOf(header: unknown): ReadonlySet<string> {
    const key = CardRelay.keyOf(header);
    const s = key ? this.sessions.get(key) : undefined;
    return s && s.until > this.now() ? new Set(s.reach) : new Set();
  }

  /** Whether the holder asks for actions: it waits in a poll now, or asked moments ago. */
  listening(holder: string | null | undefined): boolean {
    if (!holder || this.closed) return false;
    if (this.poller?.holder === holder) return true;
    const at = this.seen.get(holder);
    return at !== undefined && this.now() - at < LISTEN_MS;
  }

  /** Sends an action to the holder and waits for its answer (or says why there is none). */
  submit(holder: string, envelope: CardEnvelope): Promise<CardAnswer> {
    return new Promise((resolve) => {
      const p: Pending = { envelope, holder, handed: false, done: resolve, timer: setTimeout(() => this.expire(p), this.o.pickupMs ?? PICKUP_MS) };
      if (this.closed) { clearTimeout(p.timer); resolve({ status: 503, text: 'Timmy Canvas is stopping; nothing was run.' }); return; }
      if (this.poller?.holder === holder) this.hand(p);
      else this.queue.push(p);
    });
  }

  private hand(p: Pending): void {
    const poller = this.poller;
    if (!poller) { this.queue.push(p); return; }
    this.poller = null;
    this.seen.set(p.holder, this.now());
    p.handed = true;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => this.expire(p), this.o.answerMs ?? ANSWER_MS);
    this.handed.set(p.envelope.id, p);
    poller.give(p.envelope);
  }

  private expire(p: Pending): void {
    const i = this.queue.indexOf(p);
    if (i >= 0) this.queue.splice(i, 1);
    this.handed.delete(p.envelope.id);
    p.done(p.handed
      ? { status: 504, text: `Timmy's REPL took the action but did not answer in ${Math.round((this.o.answerMs ?? ANSWER_MS) / 1000)} s; it may have run: /jobs in Timmy says.` }
      : { status: 503, text: `No Timmy REPL took the action in ${Math.round((this.o.pickupMs ?? PICKUP_MS) / 1000)} s; nothing was run. In Timmy: /canvas open, or type the card's command.` });
  }

  /**
   * The holder's long poll: the next action for it, or null after pollMs (or when it asks again, the server stops, or the
   * request goes away). `gone` is called with a function that ends the wait, for the request's close.
   */
  poll(holder: string, gone: (end: () => void) => void): Promise<CardEnvelope | null> {
    this.seen.set(holder, this.now());
    return new Promise((resolve) => {
      if (this.closed) { resolve(null); return; }
      // One poll waits at a time: an older one ends empty.
      this.poller?.give(null);
      let settled = false;
      const timer = setTimeout(() => finish(null), this.o.pollMs ?? POLL_MS);
      const finish = (e: CardEnvelope | null, away = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.poller?.give === finish) this.poller = null;
        // A poll that went away unanswered: its REPL ended (or its connection did), so it no longer counts as listening.
        if (away) this.seen.delete(holder); else this.seen.set(holder, this.now());
        resolve(e);
      };
      this.poller = { holder, give: finish };
      gone(() => finish(null, true));
      const next = this.queue.findIndex((p) => p.holder === holder);
      if (next >= 0) this.hand(this.queue.splice(next, 1)[0]);
    });
  }

  /** The holder's answer to an action it was handed; false when there is no such action for it. */
  answer(holder: string, id: string, a: CardAnswer): boolean {
    const p = this.handed.get(id);
    if (!p || p.holder !== holder) return false;
    this.handed.delete(id);
    clearTimeout(p.timer);
    p.done(a);
    return true;
  }

  /** Another holder (or none) now: actions queued for an earlier holder are refused, unrun. */
  heldBy(holder: string | null): void {
    for (const p of [...this.queue]) {
      if (p.holder === holder) continue;
      this.queue.splice(this.queue.indexOf(p), 1);
      clearTimeout(p.timer);
      p.done({ status: 409, text: 'The canvas was named another project (or by another REPL) before the action reached a REPL; nothing was run.' });
    }
  }

  /** The server stops: the poll ends, actions not handed are refused unrun, handed ones are said to be unanswered. */
  close(): void {
    this.closed = true;
    this.poller?.give(null);
    for (const p of this.queue.splice(0)) { clearTimeout(p.timer); p.done({ status: 503, text: 'Timmy Canvas stopped before a REPL took the action; nothing was run.' }); }
    for (const p of [...this.handed.values()]) { this.handed.delete(p.envelope.id); clearTimeout(p.timer); p.done({ status: 504, text: 'Timmy Canvas stopped before the REPL answered; the action may have run: /jobs in Timmy says.' }); }
  }
}

// ── the routes ───────────────────────────────────────────────────────────────

/** The live board's rule for a page's action: Host is this server's own address, and Origin is exactly that page's. */
export function fromOwnPage(req: IncomingMessage, port: number): string | null {
  const host = String(req.headers.host ?? '');
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 'Refused: this route answers only to this canvas server\'s own address.';
  if (req.headers.origin !== `http://${host}`) return 'Refused: an action comes only from this canvas page.';
  return null;
}

/** The REPL's answer as the page gets it: plain lines, the project's folder as ".", the home folder as "~", no other absolute path. */
export function answerText(text: string, root: string): string {
  return String(text).split('\n').slice(0, 60).map((l) => cardText(l, root, 400)).join('\n');
}

export interface CardRoutes {
  link: ProjectLink;
  relay: CardRelay;
  /** this server's own port (the Host and Origin rule) */
  port: () => number;
}

export function mountCardRoutes(app: express.Express, o: CardRoutes): void {
  const fromRepl = (req: express.Request, res: express.Response): boolean => {
    res.set('Cache-Control', 'no-store');
    if (req.headers.origin !== undefined) { res.status(403).json({ ok: false, error: FROM_REPL }); return false; }
    if (!o.link.authorized(req.headers.authorization)) { res.status(401).set('WWW-Authenticate', 'Bearer').json({ ok: false, error: 'Refused: no valid token.' }); return false; }
    return true;
  };
  const jsonBody = async (req: express.Request, res: express.Response, limit: number): Promise<unknown | undefined> => {
    if (!req.is('application/json')) { res.status(415).json({ ok: false, error: 'Send JSON.' }); return undefined; }
    let raw: string | null;
    try { raw = await readBody(req, limit); } catch { res.status(400).json({ ok: false, error: 'The request could not be read.' }); return undefined; }
    if (raw === null) { res.status(413).set('Connection', 'close').json({ ok: false, error: `At most ${limit} bytes.` }); return undefined; }
    try { return JSON.parse(raw) as unknown; } catch { res.status(400).json({ ok: false, error: 'Send valid JSON.' }); return undefined; }
  };

  // The REPL: a grant for the page it opens. R4 (H81): for the project named now and the REPL holding it, so none while no
  // project is named (the REPL names its project first, then asks).
  app.post('/api/project/grant', (req, res) => {
    if (!fromRepl(req, res)) return;
    const p = o.link.project;
    if (!p) { res.status(409).json({ ok: false, error: 'No project is named to this canvas: a grant is for the project named, so name one first (POST /api/project/active).' }); return; }
    res.json({ ok: true, ...o.relay.grant({ project: p.id, holder: p.holder }) });
  });

  // The page: its grant, once, for a session kept in its memory.
  app.post('/api/project/session', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const refused = fromOwnPage(req, o.port());
    if (refused) { res.status(403).json({ ok: false, error: refused }); return; }
    const body = await jsonBody(req, res, 1024);
    if (body === undefined) return;
    if (!isObject(body) || !keysAre(body, ['grant']) || typeof body.grant !== 'string' || !GRANT.test(body.grant)) { res.status(400).json({ ok: false, error: 'Send {"grant": "<the code /canvas open gave this page>"}.' }); return; }
    const token = o.relay.exchange(body.grant);
    if (!token) { res.status(403).json({ ok: false, error: 'This page\'s grant is not valid: used, expired or never made here. In Timmy, /canvas open gives a new one.' }); return; }
    res.json({ ok: true, token });
  });

  // The page: one card's action, carried to the REPL that holds the project, and its answer back. What passing these checks
  // proves, and what it does not, is said in this module's comment (R4 H81): a request from this page with a session that
  // counts now; never, by itself, a person's click.
  app.post('/api/project/act', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const refused = fromOwnPage(req, o.port());
    if (refused) { res.status(403).json({ ok: false, error: refused }); return; }
    // R4 (H81): a session that has not ended, given for the project named now and the REPL that holds it
    const counts = o.relay.sessionFor(req.headers.authorization, o.link.project);
    if (!counts.ok) { res.status(401).set('WWW-Authenticate', 'Bearer').json({ ok: false, error: counts.words }); return; }
    const body = await jsonBody(req, res, ACT_LIMIT);
    if (body === undefined) return;
    if (!isObject(body) || !keysAre(body, ['act', 'card', 'project']) || typeof body.project !== 'string' || typeof body.card !== 'string' || body.card.length > 600
      || !isObject(body.act) || !(CARD_ACTS as readonly unknown[]).includes(body.act.action)) {
      res.status(400).json({ ok: false, error: `An action is {"project": "<id>", "card": "<card id>", "act": {"action": one of ${CARD_ACTS.join(', ')}, …}}.` });
      return;
    }
    const p = o.link.project;
    if (!p) { res.status(409).json({ ok: false, error: 'No project is named to this canvas; nothing was run. In Timmy: /canvas open.' }); return; }
    // the project named may have changed while the body was read: the session must still count for the one named now
    const still = o.relay.sessionFor(req.headers.authorization, p);
    if (!still.ok) { res.status(401).set('WWW-Authenticate', 'Bearer').json({ ok: false, error: still.words }); return; }
    if (body.project !== p.id) { res.status(409).json({ ok: false, error: `The canvas shows ${p.name} now, not this card's project; nothing was run.` }); return; }
    const fit = actFits(body.card, body.act);
    if (fit) { res.status(400).json({ ok: false, error: `${fit} Nothing was run.` }); return; }
    if (!o.relay.listening(p.holder)) { res.status(503).json({ ok: false, error: `No Timmy REPL takes ${p.name}'s actions from this canvas now; nothing was run. Type the card's command in Timmy, or /canvas open there.` }); return; }
    const answer = await o.relay.submit(p.holder!, { id: randomUUID(), project: p.id, card: body.card, act: body.act });
    res.status(answer.status).json({ ok: answer.status === 200, status: answer.status, text: answerText(answer.text, p.root) });
  });

  // The REPL that holds the project: its next action (a long poll).
  app.get('/api/project/inbox', async (req, res) => {
    if (!fromRepl(req, res)) return;
    const holder = String(req.query.holder ?? '');
    if (!HOLDER_ID.test(holder)) { res.status(400).json({ ok: false, error: 'holder is the 32 hex characters this REPL named itself with.' }); return; }
    const p = o.link.project;
    if (!p) { res.status(404).json({ ok: false, error: 'No project is named to this canvas.' }); return; }
    if (p.holder !== holder) { res.status(409).json({ ok: false, error: 'Another Timmy REPL (or none) holds the project this canvas shows now.' }); return; }
    if (o.relay.stopping) { res.status(503).json({ ok: false, error: 'Timmy Canvas is stopping.' }); return; }
    const next = await o.relay.poll(holder, (end) => { res.once('close', end); });
    if (res.writableEnded || res.destroyed) {
      // The REPL went away while an action was on its way: it was not delivered, and is said to be unanswered.
      if (next) o.relay.answer(holder, next.id, { status: 504, text: 'Timmy\'s REPL went away as the action reached it; it may not have run: /jobs in Timmy says.' });
      return;
    }
    if (!next) { res.status(204).end(); return; }
    res.json({ ok: true, action: next });
  });

  // The REPL's answer to an action it was handed.
  app.post('/api/project/inbox/:id', async (req, res) => {
    if (!fromRepl(req, res)) return;
    const body = await jsonBody(req, res, ANSWER_LIMIT);
    if (body === undefined) return;
    if (!isObject(body) || !keysAre(body, ['holder', 'status', 'text']) || typeof body.holder !== 'string' || !Number.isInteger(body.status) || typeof body.text !== 'string') {
      res.status(400).json({ ok: false, error: 'Send {"holder": …, "status": <HTTP status>, "text": "…"}.' });
      return;
    }
    const status = Math.min(599, Math.max(200, body.status as number));
    const ok = o.relay.answer(body.holder, String(req.params.id), { status, text: body.text });
    if (!ok) { res.status(404).json({ ok: false, error: 'No action like that is waiting for this REPL.' }); return; }
    res.json({ ok: true });
  });

  // A highlight the board shows, for a drawn result card (the same reads as GET /api/project, under the board's file guard). R4 (H83):
  // the project's content, so read only with the server's token or a page session that counts now, as GET /api/project is.
  app.get('/api/project/image', (req, res) => {
    res.set('Cache-Control', 'no-store');
    // R4 (H109): ?project=<id>: a highlight of the project a board is pinned to, for a page whose session reaches it (read only)
    const asked = typeof req.query.project === 'string' && /^[0-9a-f]{16}$/.test(req.query.project) ? req.query.project : null;
    const pinned = asked !== null && asked !== (o.link.project?.id ?? null);
    const p: NamedProject | null = pinned ? o.link.knownProject(asked!) : o.link.project;
    if (!o.link.authorized(req.headers.authorization)) {
      const s = pinned ? o.relay.reaches(req.headers.authorization, asked!) : o.relay.sessionFor(req.headers.authorization, p);
      if (!s.ok) { res.status(401).set('WWW-Authenticate', 'Bearer').type('text/plain').send(s.why === 'none' ? IMAGE_REFUSED : s.words); return; }
    }
    const rel = inProject(String(req.query.p ?? ''));
    const f = p && rel ? voxFileFor({ root: p.root, path: rel, chain: readRunsChain(p.receipts), projectId: p.id }) : null;
    if (!f) { res.status(404).type('text/plain').send('Not here: no such highlight of a record the board shows.'); return; }
    const image = imageOnly(f.type, f.body);
    if (!image.ok) { res.status(404).type('text/plain').send(`Not shown: this highlight is not an image the board shows (${image.why}).`); return; }
    res.set({ ...FILE_HEADERS, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' }).type(image.type).send(f.body);
  });
}
