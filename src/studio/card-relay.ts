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
 *   /api/project/grant: the server's token, no Origin; 128 random bits, one use, 2 minutes) and opens the page with it in the
 *   address's fragment, which a browser never sends; the page removes it from the address at once and trades it, in a JSON
 *   body, for a session (POST /api/project/session): 32 random bytes kept only in the page's memory and only their sha256
 *   here. A page opened any other way, or reloaded, has none, and its cards say so and give the typed command.
 * - A page's action (POST /api/project/act) passes the live board's own rules for actions: Host is exactly this server's
 *   address (127.0.0.1 or localhost with its own port) and Origin is exactly that page's; `Authorization: Bearer <session>`;
 *   JSON only, at most ACT_LIMIT bytes, exactly {project, card, act}; the act one of run, rebuild, set-params and
 *   set-scad-params, and the one its card offers (a workflow card runs its own document, a parameter card saves and rebuilds
 *   its own file); the card's project the one named now; and a REPL holding it now. Nothing else is relayed; the token goes
 *   in a header, never in an address or a log.
 * - An action no REPL picked up in PICKUP_MS was not run, and the page is told so; one picked up but not answered in
 *   ANSWER_MS may have run, and the page is told that instead.
 *
 * GET /api/project/image serves the one kind of image the board's highlights are (src/repl/board-vox.ts voxFileFor: a shown
 * highlight of a verified or stale VoxVision record, its bytes still the ones it recorded) through the board's own guard
 * (src/repl/board-file-guard.ts: a PNG by its signature, an SVG only as plain drawing), as a download under a sandboxing policy.
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

export interface RelayOptions { now?: () => number; pollMs?: number; pickupMs?: number; answerMs?: number; grantMs?: number }

/** The grants, the page sessions, and the actions waiting for (or handed to) the REPL that holds the project. */
export class CardRelay {
  private readonly grants = new Map<string, number>();
  /** sha256 of each page session token, with when it was made: the tokens themselves are kept only by the pages */
  private readonly sessions = new Map<string, number>();
  private readonly queue: Pending[] = [];
  private readonly handed = new Map<string, Pending>();
  private poller: { holder: string; give: (e: CardEnvelope | null) => void } | null = null;
  private readonly seen = new Map<string, number>();
  private closed = false;

  constructor(private readonly o: RelayOptions = {}) {}

  private now(): number { return this.o.now?.() ?? Date.now(); }

  /** The server is stopping: no more polls are held. */
  get stopping(): boolean { return this.closed; }

  /** A one-time grant for a page the REPL opens (its fragment carries it). */
  grant(): { grant: string; expires: string } {
    const now = this.now();
    for (const [g, until] of this.grants) if (until <= now) this.grants.delete(g);
    while (this.grants.size >= GRANTS_MAX) this.grants.delete(this.grants.keys().next().value!);
    const grant = randomBytes(16).toString('hex');
    const until = now + (this.o.grantMs ?? GRANT_MS);
    this.grants.set(grant, until);
    return { grant, expires: new Date(until).toISOString() };
  }

  /** A page's session for a grant, once: null when the grant was never made here, was used, or has expired. */
  exchange(grant: string): string | null {
    const until = this.grants.get(grant);
    if (until === undefined) return null;
    this.grants.delete(grant);
    if (until <= this.now()) return null;
    const token = randomBytes(32).toString('hex');
    this.sessions.set(sha(token), this.now());
    while (this.sessions.size > SESSIONS_MAX) this.sessions.delete(this.sessions.keys().next().value!);
    return token;
  }

  /** Whether an Authorization header carries a page session made here (by the sha256 of its token). */
  session(header: unknown): boolean {
    const m = typeof header === 'string' ? SESSION.exec(header) : null;
    return !!m && this.sessions.has(sha(m[1]));
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

  // The REPL: a grant for the page it opens.
  app.post('/api/project/grant', (req, res) => {
    if (!fromRepl(req, res)) return;
    res.json({ ok: true, ...o.relay.grant() });
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

  // The page: one card's action, carried to the REPL that holds the project, and its answer back.
  app.post('/api/project/act', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const refused = fromOwnPage(req, o.port());
    if (refused) { res.status(403).json({ ok: false, error: refused }); return; }
    if (!o.relay.session(req.headers.authorization)) { res.status(401).set('WWW-Authenticate', 'Bearer').json({ ok: false, error: NO_SESSION }); return; }
    const body = await jsonBody(req, res, ACT_LIMIT);
    if (body === undefined) return;
    if (!isObject(body) || !keysAre(body, ['act', 'card', 'project']) || typeof body.project !== 'string' || typeof body.card !== 'string' || body.card.length > 600
      || !isObject(body.act) || !(CARD_ACTS as readonly unknown[]).includes(body.act.action)) {
      res.status(400).json({ ok: false, error: `An action is {"project": "<id>", "card": "<card id>", "act": {"action": one of ${CARD_ACTS.join(', ')}, …}}.` });
      return;
    }
    const p = o.link.project;
    if (!p) { res.status(409).json({ ok: false, error: 'No project is named to this canvas; nothing was run. In Timmy: /canvas open.' }); return; }
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

  // A highlight the board shows, for a drawn result card (no token: the same reads as GET /api/project, under the board's file guard).
  app.get('/api/project/image', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const p: NamedProject | null = o.link.project;
    const rel = inProject(String(req.query.p ?? ''));
    const f = p && rel ? voxFileFor({ root: p.root, path: rel, chain: readRunsChain(p.receipts), projectId: p.id }) : null;
    if (!f) { res.status(404).type('text/plain').send('Not here: no such highlight of a record the board shows.'); return; }
    const image = imageOnly(f.type, f.body);
    if (!image.ok) { res.status(404).type('text/plain').send(`Not shown: this highlight is not an image the board shows (${image.why}).`); return; }
    res.set({ ...FILE_HEADERS, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' }).type(image.type).send(f.body);
  });
}
