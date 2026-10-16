/**
 * The Timmy Canvas server (plan F-4): the canvas page, its configuration and the agent bridge,
 * on 127.0.0.1 only.
 *
 * R4 (H83): what each route requires. Every route first: Host is 127.0.0.1, localhost or [::1] (so no other name rebinds to
 * this machine) and Origin, when a browser sends one, is a page of this machine (isLocalRequest). "The token" is this server's
 * (Timmy's REPL holds it: src/studio/project-link.ts); "a session" is a canvas page's that counts now: made by this server
 * from a one-time grant /canvas open asked for, for the project named then and the REPL holding it, for 12 hours
 * (src/studio/card-relay.ts). Both go in an Authorization header, never in an address, a body or a log. src/studio/canvas-auth.ts
 * holds the rules for the canvas's own routes.
 *
 *   route                                   requires                                               why
 *   GET /timmy-theme.css, /fonts/<name>     nothing more                                           Timmy's look, Monaspace Argon: no project content
 *   GET /, /index.html, the page's files    nothing more                                           the canvas page's code (public in the repository);
 *                                                                                                  without a session it loads no canvas and says so
 *   GET /api/canvas/templates               nothing more                                           the public templates, blank
 *   GET /studio-config.json                 nothing more; the tldraw license key only with the     the pinned tldraw version and the one folder the blank
 *                                           token or a session                                     board names; the license key is the operator's
 *   GET /api/canvas/health                  nothing more; the latest job only with the token       whether this is Timmy Canvas, built, a page open, the
 *                                                                                                  saved revision, its hash and time, how many jobs (a
 *                                                                                                  job's id may be a model's words)
 *   GET /api/canvas/document                the token (as saved), or a session (each drawn card    the whole canvas of this Timmy home, every project's
 *                                           of another project with its kept detail withheld)      cards on it
 *   PUT /api/canvas/document                the token, or a session (another project's kept        a write; a withheld copy never erases what is saved
 *                                           detail is kept as saved)
 *   GET /api/canvas/jobs                    the token or a session                                 the canvas jobs (ids a model may name, receipts)
 *   GET /api/workspace                      the token or a session                                 R5 (H133): the shared workspace frame of the project
 *                                                                                                  named now (src/ops/workspace-frame.ts), for the strip
 *                                                                                                  above the canvas
 *   POST /api/canvas/jobs/<job>/receipt     the token only; no Origin, no query string             a write, by the REPL that sealed the turn
 *   POST /api/canvas/exec                   the token only; no Origin, no query string; while a   code that runs in the canvas page with its rights
 *                                           project is named, the holder id of the REPL holding    (R5 H133: as a draft, when the agent asks, which
 *                                           it; a page on the bridge whose session counts now      a person accepts or discards on the page)
 *   GET /api/canvas/drafts                  the token or a session                                 R5 (H133): the drafts record (proposed, refused,
 *                                                                                                  accepted, discarded)
 *   POST /api/canvas/drafts                 the token or a session                                 R5 (H133): a decision on a draft, once saved
 *   POST /api/canvas/document/copy          the token or a session                                 R5 (H133): a page's version kept beside the
 *                                                                                                  canvas (a newer one is on disk)
 *   GET /bridge (WebSocket)                 a session, as a subprotocol (src/studio/bridge.ts)     the page the code is sent to
 *   POST /api/project/active                the token; no Origin                                   names the project (project-link.ts)
 *   GET /api/project/active                 nothing more: whether a project is named and a page    the project's name is its content
 *                                           open; its name and id with the token or a session
 *   GET /api/project (?detail=1)            the token or a session                                 the project's cards, and their detail
 *     R4 (H109) &project=<id>               the token, or a session that reaches that project      a board pinned to a project not shown
 *                                           (given for it, or followed to it: card-relay.ts)        reads it (read only)
 *   GET /api/project/image                  the token or a session                                 a highlight image of the project
 *   GET /api/project/run-detail?op=<id>     as GET /api/project (with &project= likewise)          R4 (H109): an operation's run detail
 *                                                                                                  (src/studio/run-detail-route.ts)
 *   POST /api/project/grant                 the token; no Origin; a project named                  a one-time grant for the page /canvas open opens
 *   POST /api/project/session               this page (Host and Origin exactly this server's);     the page's session (card-relay.ts)
 *                                           a grant, once
 *   POST /api/project/act                   this page; a session; the act its card offers          a card's action, for the REPL that holds it
 *   GET /api/project/inbox, POST ../<id>    the token; no Origin; the holder id                    the REPL's own actions
 *   GET /receipts/<id>                      nothing more (open; see below)                         C-13's receipt pages
 *
 * R5 (H137; the rehearsal's one console error): a reading a canvas page makes by itself (GET /api/canvas/jobs, /api/workspace,
 * /api/project, /api/project/image) refuses a paused session (one this server keeps, given for another project or by another
 * REPL than the one holding the project now: a REPL's /canvas open took the canvas while the page was open) with a plain 200,
 * `{ ok: false, error, session }` and nothing of the project (canvas-auth.ts refuseReading): the page cannot know it was paused
 * before it asks. No credential, a forged one and a session that ended are still refused with 401, as every write and action is.
 *
 * R5 lead, R5 (H137; the QA round, defect 19's analog): the Studio the shared frame names (no TIMMY_STUDIO_URL, and Studio's
 * port) records in the frame's observations (src/ops/workspace-frame.ts) that it started listening, that its page asked for its
 * frame, and that it stopped (on close, or as its process exits), so no surface says Studio answered after it ended.
 *
 * The receipt pages (C-13, src/studio/receipt-page.ts) stay open: a person opens them by clicking a link (the REPL's receipt
 * line and its "where to inspect" rows, /web <id>, the canvas page's jobs panel, a receipt page's previous-receipt link), a
 * browser navigation that cannot carry an Authorization header, so a credential would break each of those links. They show
 * a receipt's kind, subject, status, tools and their outcomes, model, spend, time, the hashes of its prompt and answer (never
 * their text), its signer's fingerprint, its chain links and its canvas jobs, from the receipts store of this server's own
 * folder. The smallest plan to close them: the REPL opens a receipt page with a one-time code in its fragment, as /canvas open
 * does, and the page trades it for a short read; a link opened later then says to open it from Timmy again (/web <id>).
 */
import express from 'express';
import { mountReceiptPages, type ReceiptSource } from './receipt-page.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanvasBridge } from './bridge.js';
import { STUDIO_PORT, TLDRAW_VERSION, studioConfig, studioPort } from './config.js';
import { studioHealth } from './health.js';
import { type CanvasDocuments, DRAFT_ID, MAX_CANVAS_BYTES, canvasDir, shownPath } from './document.js';
// R6 (H139): each project's own board, and the old layout's files given to their project once
import { adoptOldLayout, boardDir, CanvasBoards, oldLayoutWords, PROJECT_ID } from './boards.js';
import { pausedRefusal } from './session-pause.js';
import { guidedTemplates, publicTemplates } from './templates.js';
import { FONT_FILES, HOMEBREW, TYPE, themeCss } from '../theme/tokens.js';
// Round R4 (H55): the project the REPL names, and the read-only project API built from the board's readers.
import { dropProjectToken, HOLDER_ID, mountProjectRoutes, ProjectLink, writeProjectToken } from './project-link.js';
// Round R4 (H75): the drawn cards' actions, carried to the REPL that holds the project (this server runs none of them).
import { CardRelay, mountCardRoutes, type RelayOptions } from './card-relay.js';
// Round R4 (H83): who may run code, read and save the canvas, and join the bridge.
import { bridgeGate, callerOf, DOCUMENT_REFUSED, EXEC_REFUSED, holderMayRun, JOBS_REFUSED, keepOthers, LINK_REFUSED, refuse, refuseReading, replOnly, withholdOthers, WORKSPACE_REFUSED } from './canvas-auth.js';
// R4 (H84): the local-request rule, shared with the browser companion and `timmy logs`.
import { isLocalRequest as isLocal } from '../utils/local-request.js';
// R4 (H109): the canvas follows the active project of its Timmy home (state/active-project.json)
import { ActiveFollower, activeProjectFile } from './active-follow.js';
// R4 (H109): an operation's run detail (src/contracts/run-detail.ts), drawn in the canvas page's side panel
import { mountRunDetailRoute, type RunDetailProducer } from './run-detail-route.js';
import { timmyHome } from '../setup/home.js';
import { receiptsDir } from '../utils/receipts.js';

export { STUDIO_PORT };

export interface StudioOptions {
  env?: Record<string, string | undefined>;
  /** The page's folder; defaults to the packaged companion/studio-canvas. */
  root?: string;
  /** How long a canvas call may take before it fails (default 30 s). */
  execTimeoutMs?: number;
  /** Where the receipt pages read the chain (C-13); defaults to this folder's store. */
  receipts?: ReceiptSource;
  /** Where the canvas is saved; defaults to `<TIMMY_HOME>/canvas` from `env`. */
  canvasDir?: string;
  /** The largest canvas document Timmy saves (default 25 MB). */
  maxCanvasBytes?: number;
  /** R4 (H55): the token a REPL names its project with (64 hex); made at random when absent. */
  projectToken?: string;
  /** R4 (H55): also keep the token in <canvas folder>/project-token-<port> (0600) for other REPLs of this Timmy home. */
  projectTokenFile?: boolean;
  /** R4 (H83): the card relay's clock and times (a test's: a session's 12 hours, a grant's 2 minutes). */
  relay?: RelayOptions;
  /**
   * R4 (H109): follow a change of the active project of this Timmy home (<TIMMY_HOME>/state/active-project.json, from `env`) made
   * after the server starts (src/studio/active-follow.ts); how often it is looked at and how long a REPL has to name the project
   * itself first (ms). By default a server follows when it serves a Timmy home for its REPLs (`projectTokenFile`: the REPL's own
   * canvas server and `timmy studio`); one made without (a test's, given no Timmy home) reads no Timmy home's file.
   */
  followActive?: boolean;
  followEveryMs?: number;
  followGraceMs?: number;
  /**
   * R4 (H109): what makes an operation's run detail (src/contracts/run-detail.ts); absent: src/ops/run-detail.ts's runDetail when
   * it is in this revision (src/studio/run-detail-route.ts), else the route says it is not built yet. Tests give a FIXTURE.
   */
  runDetail?: RunDetailProducer;
}

/** R4 (H55): the server, with the token its REPL names the active project with. */
export type StudioServer = Server & { projectToken: string };

/** R4 (H75): the card relay a server uses, with the port its page routes check Host and Origin against. */
export interface CardWiring { relay: CardRelay; port: () => number }

/** companion/studio-canvas, found from the source (src/studio) or the build (dist/src/studio). */
export function studioRoot(): string {
  const candidates = ['../../companion/studio-canvas', '../../../companion/studio-canvas'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
  return candidates.find(existsSync) ?? candidates[0];
}

/**
 * Addressed to this machine, and (when a browser says where it comes from) sent by this machine's pages: Host 127.0.0.1,
 * localhost or [::1], so a page elsewhere cannot rebind its DNS name to 127.0.0.1 and read it. R4 (H84): the one rule of
 * Timmy's local servers, kept in src/utils/local-request.ts (the browser companion and `timmy logs` use it too).
 */
export const isLocalRequest = (req: IncomingMessage): boolean => isLocal(req);

const JOB_ID = /^[\w.:-]{1,100}$/;
/**
 * R4 (H83): what an exec call carries, and nothing else (a token never goes in a body). R5 (H133): and whether it is a draft. R6
 * (H139): and the project the REPL draws on.
 */
const EXEC_KEYS: ReadonlySet<string> = new Set(['code', 'jobId', 'holder', 'draft', 'baseRevision', 'project']);
/** R5 (H133): what a decision on a draft carries, and nothing else. R6 (H139): and the project whose board it was made on. */
const DECISION_KEYS: ReadonlySet<string> = new Set(['draft', 'decision', 'shapes', 'job', 'from', 'at', 'revision', 'sourceRevision', 'project']);
/** R6 (H139): what is said when no project is named: each project has its own board, so there is none to show or save. */
const NO_BOARD = 'No project is named to this canvas, so it shows no board: each project has its own. In Timmy: /canvas open.';
const PROJECT_PARAM = 'project is a project\'s id: 16 hex characters.';
/** R6 (H139): one project's board, as a route uses it. */
interface Board { id: string; name: string; docs: CanvasDocuments }
/** R6 (H139): the project a reading names (?project=<16 hex>): null when it names none, false when what it names is not an id. */
function projectParam(req: express.Request): string | null | false {
  const q = req.query.project;
  if (q === undefined) return null;
  return typeof q === 'string' && PROJECT_ID.test(q) ? q : false;
}
/** R5 (H133): how many copies a canvas folder keeps before it asks for room. */
const MAX_COPIES = 50;
const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

/** Monaspace Argon's files, from its package (OFL-1.1, served unmodified); null when it is not installed. */
export function fontDir(): string | null {
  try {
    return join(dirname(createRequire(import.meta.url).resolve('@fontsource/monaspace-argon/package.json')), 'files');
  } catch {
    return null;
  }
}

/** The only font files this server hands out, by exact name. */
const SERVED_FONTS: ReadonlySet<string> = new Set(FONT_FILES.map((f) => f.file));

/**
 * What a canvas that is not built yet shows (fourth order, step 5): tldraw is bundled on this machine
 * by scripts/canvas/build.mjs, which `npm run build` runs and a fresh checkout has not run yet.
 */
const NOT_BUILT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Timmy Canvas</title>
<link rel="stylesheet" href="/timmy-theme.css">
<style>body{margin:0;padding:24px;background:${HOMEBREW.ground};color:${HOMEBREW.text};font:${TYPE.size.body}px/${TYPE.lineHeight} var(--timmy-font-mono)}code{color:${HOMEBREW.accent}}</style></head>
<body><h1 style="font-size:16px">Timmy Canvas is not built yet</h1>
<p>Its tldraw bundle (dist/canvas.js) is missing. In the Timmy checkout, run:</p>
<p><code>npm run build:canvas</code></p><p>then reload this page.</p></body></html>`;

export function createStudioApp(options: StudioOptions = {}, bridge = new CanvasBridge(isLocalRequest, options.execTimeoutMs), link = new ProjectLink(options.projectToken), cardWiring: CardWiring = { relay: new CardRelay(options.relay), port: () => STUDIO_PORT }, follower?: ActiveFollower): express.Express {
  const env = options.env ?? process.env;
  const { relay } = cardWiring;
  const maxCanvasBytes = options.maxCanvasBytes ?? MAX_CANVAS_BYTES;
  const savedIn = options.canvasDir ?? canvasDir(env);
  // R6 (H139): each project's own board (src/studio/boards.ts); once, the old layout's files become the board of their project
  const boards = new CanvasBoards(savedIn, { maxBytes: maxCanvasBytes });
  try { adoptOldLayout(savedIn); } catch { /* the old files stay where they are, and a project's board says so */ }
  /** R6 (H139): a project's name as this server knows it (named in its life), else its id. */
  const nameOf = (id: string): string => (link.project?.id === id ? link.project.name : link.knownProject(id)?.name ?? id);
  const board = (id: string): Board => ({ id, name: nameOf(id), docs: boards.of(id) });
  /** R6 (H139): what a page asking for another project's board, jobs, drafts or workspace than the one shown now is told. */
  const notShown = (res: express.Response, asked: string): void => {
    const named = link.project;
    res.status(409).json({ ok: false, notShown: true, asked, shows: named ? { id: named.id, name: named.name } : null,
      error: named ? `The canvas shows ${named.name} now, not the project this page asked for (${nameOf(asked)}).` : NO_BOARD });
  };
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (isLocalRequest(req)) return next();
    res.status(403).type('text/plain').send('Timmy Canvas answers 127.0.0.1 and localhost only.');
  });
  const root = options.root ?? studioRoot();
  // Round R1 (DESIGN.md §10 B9): the shared look, as CSS variables and font faces, for every page this
  // server shows; and Monaspace Argon's files, by name only, for a machine without the font installed.
  app.get('/timmy-theme.css', (_req, res) => {
    res.set('Cache-Control', 'no-store').type('text/css').send(themeCss());
  });
  app.get('/fonts/:file', (req, res) => {
    const file = String(req.params.file);
    const dir = fontDir();
    if (!SERVED_FONTS.has(file) || !dir || !existsSync(join(dir, file))) {
      res.status(404).type('text/plain').send('No such font here.');
      return;
    }
    res.set('Cache-Control', 'public, max-age=86400').type('font/woff2').sendFile(join(dir, file));
  });
  // Round R1: what this server is and what state the canvas is in, for the REPL and `timmy tools`.
  // It runs nothing in the page and never carries the license key. R4 (H83): no content without the token: the latest job
  // (its id may be a model's words) only with it; pageConnected only for a page whose session counts now (src/studio/bridge.ts).
  // R6 (H139): of the board of the project named now (none named: no board, revision 0); with a credential, the project it is of,
  // and with the token any project's (?project=<id>)
  app.get('/api/canvas/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const asked = projectParam(req);
    if (asked === false) { res.status(400).json({ ok: false, error: PROJECT_PARAM }); return; }
    const token = link.authorized(req.headers.authorization);
    const credited = token || callerOf(req.headers.authorization, link, relay, DOCUMENT_REFUSED).ok;
    const named = link.project;
    if (asked && credited && !token && asked !== named?.id) { notShown(res, asked); return; }
    const id = asked && token ? asked : named?.id ?? null;
    const docs = id ? boards.of(id) : null;
    const saved = docs ? docs.peek() : { revision: 0, sourceRevision: null, savedAt: null };
    const jobs = docs ? docs.jobs() : [];
    const latest = token ? jobs[0] : undefined;
    res.json({
      ok: true,
      app: 'timmy-canvas',
      tldrawVersion: TLDRAW_VERSION,
      built: existsSync(join(root, 'dist', 'canvas.js')),
      pageConnected: bridge.open,
      revision: saved.revision,
      sourceRevision: saved.sourceRevision,
      savedAt: saved.savedAt,
      ...('unreadable' in saved && saved.unreadable ? { unreadable: true } : {}),
      jobs: jobs.length,
      latestJob: latest ? { id: latest.id, ok: latest.ok, revision: latest.revision, at: latest.at, ...(latest.receipt ? { receipt: latest.receipt } : {}) } : null,
      ...(credited ? { project: id ? { id, name: nameOf(id) } : null } : {}),
    });
  });
  app.get('/studio-config.json', (req, res) => {
    // canvasDir: the folder this server saves the canvas in, which the blank board names (the 20:14 order). R4 (H83): the
    // tldraw license key only to the REPL (the token) or a page with a session that counts now; to anyone else, none.
    const config = studioConfig(env);
    const credited = callerOf(req.headers.authorization, link, relay, DOCUMENT_REFUSED).ok;
    res.set('Cache-Control', 'no-store').json({ ...config, licenseKey: credited ? config.licenseKey : null, canvasDir: shownPath(savedIn) });
  });
  // Fourth order, step 5: the canvas, saved by Timmy in its home and opened from there, so it reopens
  // where it was and every surface reads the same document, revision and source revision. R6 (H139): each project's own board.
  const jsonOnly = (message: string): express.RequestHandler => (req, res, next) => {
    if (req.is('application/json')) return next();
    res.status(415).json({ ok: false, error: message });
  };
  // R4 (H83): the document and the jobs, with the token or a page session that counts now (checked before a body is read).
  const credited = (refused: string): express.RequestHandler => (req, res, next) => {
    const c = callerOf(req.headers.authorization, link, relay, refused);
    if (!c.ok) { refuse(res, c); return; }
    res.locals.by = c.by;
    next();
  };
  // R5 (H137): a reading the canvas page makes by itself, every few seconds (its jobs, its workspace strip): a paused session's
  // refusal is a plain 200 with nothing of the project (canvas-auth.ts refuseReading), so a page another REPL took the canvas from
  // logs no failed request; anyone else's is the 401 above
  const creditedReading = (refused: string): express.RequestHandler => (req, res, next) => {
    const c = callerOf(req.headers.authorization, link, relay, refused);
    if (!c.ok) { refuseReading(res, c); return; }
    res.locals.by = c.by;
    next();
  };
  /**
   * R6 (H139): a write's credential, checked before its body is read: the token, a session that counts now, or a session paused
   * now (another project or REPL holds the canvas) whose write is for a board it reaches (checked once the body names the board:
   * boardToWrite). No credential, a forged one and an ended session are refused here, as before.
   */
  const presented = (refused: string): express.RequestHandler => (req, res, next) => {
    const c = callerOf(req.headers.authorization, link, relay, refused);
    if (c.ok) { res.locals.by = c.by; next(); return; }
    if (pausedRefusal(c.why)) { res.locals.by = 'session'; res.locals.paused = c; next(); return; }
    refuse(res, c);
  };
  /**
   * R6 (H139): the board a reading is for (sent the refusal and undefined when refused): the token reads any project's board
   * (?project=<id>), else the one named now; a page's session reads only the board of the project named now, and one that asks for
   * another (asked before a switch) is told which project the canvas shows now (409), so no page takes another project's board,
   * jobs or drafts for its own. Null: no project is named, so there is no board.
   */
  const boardToRead = (req: express.Request, res: express.Response): Board | null | undefined => {
    const asked = projectParam(req);
    if (asked === false) { res.status(400).json({ ok: false, error: PROJECT_PARAM }); return undefined; }
    const named = link.project;
    if (asked && res.locals.by === 'token') return board(asked);
    if (asked && asked !== named?.id) { notShown(res, asked); return undefined; }
    return named ? board(named.id) : null;
  };
  /**
   * R6 (H139): the board a write is for (`project` in its body, else the project named now; sent the refusal and undefined when
   * refused). The token writes any project's board. A page's session writes the board of the project named now while it counts for
   * it, or the board of a project it reaches (given for it, or followed to it: src/studio/card-relay.ts) that is not the one named
   * now: a page's last save of the board it showed before a switch lands on that board, never on the board shown now (`kept`).
   */
  const boardToWrite = (req: express.Request, res: express.Response, body: Record<string, unknown>): { board: Board; kept: string | null } | undefined => {
    const p = body.project;
    if (p !== undefined && p !== null && (typeof p !== 'string' || !PROJECT_ID.test(p))) { res.status(400).json({ ok: false, error: 'project is the id of the project whose board this is (16 hex), or null for the project named now.' }); return undefined; }
    const named = link.project;
    const target = typeof p === 'string' ? p : named?.id ?? null;
    if (!target) { res.status(409).json({ ok: false, error: NO_BOARD }); return undefined; }
    const keptWords = (id: string): string => `Kept for ${nameOf(id)}: written to ${nameOf(id)}'s own board, because the canvas shows ${named ? named.name : 'no project'} now.`;
    if (res.locals.by === 'token') return { board: board(target), kept: named && target !== named.id ? keptWords(target) : null };
    if (named && target === named.id) {
      // checked again after the body was read: the project named may have changed meanwhile
      const s = relay.sessionFor(req.headers.authorization, named);
      if (!s.ok) { refuse(res, { ok: false, why: s.why, words: s.words }); return undefined; }
      return { board: board(target), kept: null };
    }
    const r = relay.reaches(req.headers.authorization, target);
    if (!r.ok) { refuse(res, { ok: false, why: r.why, words: r.words }); return undefined; }
    return { board: board(target), kept: keptWords(target) };
  };
  app.get('/api/canvas/document', credited(DOCUMENT_REFUSED), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = boardToRead(req, res);
    if (b === undefined) return;
    if (b === null) { res.status(409).json({ ok: false, error: NO_BOARD, project: null }); return; }
    const state = b.docs.load();
    // R6 (H139): which project's board this is, where it is kept, and what it says of the old layout
    const old = oldLayoutWords(savedIn, b.id);
    const of = { project: { id: b.id, name: b.name }, board: boards.shown(b.id), ...(old ? { oldLayout: old } : {}) };
    if (res.locals.by === 'token') { res.json({ ...state, ...of }); return; }
    // A page's session counts for the project named now: every drawn card of another project comes with its kept detail withheld.
    // R4 (H109): another project the session reaches (it was given for it, or followed it since) is not withheld from it.
    const shown = withholdOthers(state.snapshot, relay.reachOf(req.headers.authorization));
    res.json({ ...state, snapshot: shown.snapshot, withheld: shown.withheld, ...of });
  });
  app.put('/api/canvas/document', jsonOnly('Send JSON: {"snapshot": {...}, "revision": N, "baseRevision": N, "project": "<id>"}.'), presented(DOCUMENT_REFUSED),
    express.json({ limit: Math.max(2 * maxCanvasBytes, 1024 * 1024) }), (req, res) => {
      res.set('Cache-Control', 'no-store');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const to = boardToWrite(req, res, body);
      if (!to) return;
      const docs = to.board.docs;
      // A page's session: another project's cards keep their saved identity and kept detail (never erased by a withheld copy).
      // R4 (H109): the projects the session reaches count as its own
      const toSave = res.locals.by === 'session' ? { ...body, snapshot: keepOthers(body.snapshot, docs.storedSnapshot(), relay.reachOf(req.headers.authorization)).snapshot } : body;
      const saved = docs.save(toSave);
      const status = saved.ok ? 200 : 'conflict' in saved ? 409 : 'tooLarge' in saved ? 413 : 400;
      res.status(status).json({ ...saved, project: { id: to.board.id, name: to.board.name }, ...(to.kept && saved.ok ? { kept: to.kept } : {}) });
    });
  app.get('/api/canvas/jobs', creditedReading(JOBS_REFUSED), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = boardToRead(req, res);
    if (b === undefined) return;
    res.json(b ? b.docs.jobs() : []);
  });
  // R5 (H133): the shared workspace frame (src/contracts/workspace.ts) of the project named now, made from its records by
  // src/ops/workspace-frame.ts, as the terminal Workbench and the companion read it: the strip above the canvas draws it. The
  // token or a page session that counts now (the frame is the project's content); none while no project is named. R6 (H139): a
  // page that names the project it shows (?project=<id>) is told when the canvas shows another now (409), never sent its frame.
  app.get('/api/workspace', creditedReading(WORKSPACE_REFUSED), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const named = link.project;
    const asked = projectParam(req);
    if (asked === false) { res.status(400).json({ ok: false, error: PROJECT_PARAM }); return; }
    if (!named) { res.status(404).json({ ok: false, error: 'No project is named to this canvas, so it has no workspace to show. In Timmy: /canvas open.' }); return; }
    if (asked && asked !== named.id) { notShown(res, asked); return; }
    try {
      const { buildWorkspaceFrame, noteAnswered } = await import('../ops/workspace-frame.js');
      // R5 lead: this Studio answering its page is an answer observed now, so the frame (on every surface) says Studio answered
      // and its next step is no longer to open it. Only for the Studio the frame names: its port, no other URL set.
      if (framesStudio(env, cardWiring.port())) noteAnswered('studio', 'a Studio page asked for its frame', env);
      const frame = await buildWorkspaceFrame({ env, cwd: named.root, project: { name: named.name, root: named.root } });
      res.json({ ok: true, frame });
    } catch (e) {
      // its code only: a message can carry a path of this computer
      const code = e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? ` (${(e as { code: string }).code})` : '';
      res.status(500).json({ ok: false, error: `Timmy could not read the workspace of ${named.name}${code}.` });
    }
  });
  // R5 (H133): a page's version of the canvas, kept beside the canvas file when a newer version is on disk (the page may not save
  // over it). The canvas file is never touched; a copy holds what the page holds (another project's detail stays withheld in it).
  // R6 (H139): beside the board it is a version of (`project` in its body, else the project named now).
  app.post('/api/canvas/document/copy', jsonOnly('Send JSON: {"snapshot": {...}, "revision": N, "baseRevision": N, "project": "<id>"}.'), presented(DOCUMENT_REFUSED),
    express.json({ limit: Math.max(2 * maxCanvasBytes, 1024 * 1024) }), (req, res) => {
      res.set('Cache-Control', 'no-store');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const to = boardToWrite(req, res, body);
      if (!to) return;
      const dir = boardDir(savedIn, to.board.id);
      const copies = join(dir, 'copies');
      let kept = 0;
      try { kept = readdirSync(copies).filter((f) => f.endsWith('.json')).length; } catch { kept = 0; }
      if (kept >= MAX_COPIES) {
        res.status(507).json({ ok: false, error: `Timmy keeps at most ${MAX_COPIES} copies of the canvas, and ${shownPath(copies)} holds ${kept}. Move some elsewhere, then keep this one.` });
        return;
      }
      const result = to.board.docs.keepCopy(body);
      if (!result.ok) { res.status('tooLarge' in result ? 413 : 400).json(result); return; }
      res.json({ ...result, path: shownPath(join(dir, result.kept)), project: { id: to.board.id, name: to.board.name } });
    });
  // R5 (H133): the drafts record: what Timmy proposed, what was refused, and what a person accepted or discarded. R6 (H139): of the
  // board of the project named now (with the token, any project's: ?project=<id>).
  app.get('/api/canvas/drafts', credited(DOCUMENT_REFUSED), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = boardToRead(req, res);
    if (b === undefined) return;
    res.json({ drafts: b ? b.docs.drafts() : [], ...(b ? { project: { id: b.id, name: b.name } } : {}) });
  });
  // R5 (H133): a person's decision on a draft, recorded once its save is on disk (the page sends it after the save landed, with
  // the revision and source revision that hold it). It records; it runs nothing. R6 (H139): in the record of the board the draft is
  // on (`project`: the board the page decided on, which may no longer be the one shown).
  app.post('/api/canvas/drafts', jsonOnly('Send JSON: {"draft": "draft-…", "decision": "accepted" | "discarded", …}.'), presented(DOCUMENT_REFUSED), express.json({ limit: '2kb' }), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = req.body as Record<string, unknown>;
    const extra = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.keys(body).filter((k) => !DECISION_KEYS.has(k)) : ['(not an object)'];
    const { draft, decision, shapes, job, from, at, revision, sourceRevision } = (extra.length ? {} : body) as Record<string, unknown>;
    const wrong = extra.length ? `Unknown field${extra.length > 1 ? 's' : ''}: ${extra.slice(0, 5).map((k) => JSON.stringify(k).slice(0, 40)).join(', ')}.`
      : typeof draft !== 'string' || !DRAFT_ID.test(draft) ? 'draft is the draft\'s id (draft- and hex).'
        : decision !== 'accepted' && decision !== 'discarded' ? 'decision is accepted or discarded.'
          : !isCount(shapes) || shapes > 100_000 ? 'shapes is how many shapes the draft had.'
            : job !== null && job !== undefined && (typeof job !== 'string' || !JOB_ID.test(job)) ? 'job is the draft\'s job id, or null.'
              : from !== null && from !== undefined && !isCount(from) ? 'from is the revision the draft was made from, or null.'
                : at !== undefined && (typeof at !== 'string' || Number.isNaN(Date.parse(at))) ? 'at is when the decision was made (an ISO time).'
                  : !isCount(revision) || typeof sourceRevision !== 'string' || !/^[0-9a-f]{64}$/.test(sourceRevision) ? 'revision and sourceRevision are the save that holds the decision.'
                    : null;
    if (wrong) { res.status(400).json({ ok: false, error: wrong }); return; }
    const to = boardToWrite(req, res, body);
    if (!to) return;
    const docs = to.board.docs;
    const onDisk = docs.peek();
    if (onDisk.revision === null || (revision as number) > onDisk.revision) {
      res.status(409).json({ ok: false, error: `The save that holds this decision (revision ${revision}) is not on disk (${to.board.name}'s board is at revision ${onDisk.revision ?? 'unknown'}).` });
      return;
    }
    const id = draft as string;
    const proposed = docs.drafts().some((r) => r.draft === id && r.event === 'proposed');
    const line = docs.recordDraft({
      draft: id, event: decision as 'accepted' | 'discarded', job: typeof job === 'string' ? job : null, shapes: shapes as number,
      from: isCount(from) ? from : null, revision: revision as number, sourceRevision: sourceRevision as string,
      by: res.locals.by === 'token' ? 'token' : 'page', proposed, project: to.board.id, ...(typeof at === 'string' ? { at } : {}),
    });
    res.json({ ok: true, recorded: line, ...(to.kept ? { kept: to.kept } : {}) });
  });
  // Public templates start blank: the seeds' four fields only; the page opens one as an empty board. R5 (H133): and the guided
  // blank boards (text and empty frames that say what goes where; no image, sample, metric or asset).
  app.get('/api/canvas/templates', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ templates: publicTemplates(), guided: guidedTemplates() });
  });
  // The REPL links the receipt it sealed for a turn to that turn's canvas job. R4 (H83): a write, the REPL's only (the token).
  // R6 (H139): in the ledger of the board the job ran on (the project named now first, then every other board's).
  app.post('/api/canvas/jobs/:job/receipt', (req, res, next) => { if (replOnly(req, res, link, LINK_REFUSED)) next(); }, jsonOnly('Send JSON: {"receipt": "<its short hash>"}.'), express.json({ limit: '1kb' }), (req, res) => {
    const job = String(req.params.job);
    const { receipt } = (req.body ?? {}) as { receipt?: unknown };
    res.set('Cache-Control', 'no-store');
    try {
      const found = JOB_ID.test(job) ? boards.findJob(job, link.project?.id ?? null) : null;
      if (!found || !found.docs.linkReceipt(job, String(receipt))) {
        if (!/^[0-9a-f]{8,64}$/.test(String(receipt))) throw new Error(`Not a receipt ID: ${JSON.stringify(receipt).slice(0, 40)}`);
        res.status(404).json({ ok: false, error: `No canvas job ${JOB_ID.test(job) ? job : 'like that'}.` });
        return;
      }
      res.json({ ok: true, job, receipt, project: { id: found.project, name: nameOf(found.project) } });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  // The agent's canvas tools: Editor API code in, the page's answer out. JSON only, so a form on
  // another site cannot post here without a CORS preflight that this server never grants. R4 (H83): the REPL's only: the
  // token in an Authorization header (never a page, never in an address), and while a project is named, the REPL holding it.
  // R6 (H139): stamped with the project named now (the page runs it only on that project's board), refused when the REPL says it
  // draws on another (`project`), and recorded in that project's board (its jobs ledger and drafts record), whichever project the
  // canvas shows by the time the page answers.
  app.post('/api/canvas/exec', (req, res, next) => { if (replOnly(req, res, link, EXEC_REFUSED)) next(); }, (req, res, next) => {
    if (!req.is('application/json')) {
      res.status(415).json({ ok: false, error: 'Send JSON: {"code": "...", "jobId": "...", "holder": "..."}.' });
      return;
    }
    next();
  }, express.json({ limit: '32kb' }), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const extra = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.keys(body).filter((k) => !EXEC_KEYS.has(k)) : ['(not an object)'];
    if (extra.length) {
      res.status(400).json({ ok: false, error: `Unknown field${extra.length > 1 ? 's' : ''}: ${extra.slice(0, 5).map((k) => JSON.stringify(k).slice(0, 40)).join(', ')}. The fields are code, jobId, holder, draft, baseRevision and project.` });
      return;
    }
    const { code, jobId, holder, draft, baseRevision, project } = body as { code?: unknown; jobId?: unknown; holder?: unknown; draft?: unknown; baseRevision?: unknown; project?: unknown };
    // R5 (H133): a draft (what it creates waits for a person's Accept or Discard), made from the canvas revision the agent read
    if (draft !== undefined && typeof draft !== 'boolean') {
      res.status(400).json({ ok: false, error: 'draft is true (what the call creates waits for a person\'s Accept or Discard) or false.' });
      return;
    }
    if (baseRevision !== undefined && baseRevision !== null && !isCount(baseRevision)) {
      res.status(400).json({ ok: false, error: 'baseRevision is the canvas revision the call was made from (a whole number), or null.' });
      return;
    }
    if (typeof code !== 'string' || !code.trim()) {
      res.status(400).json({ ok: false, error: 'Send {"code": "..."}: the Editor API code to run.' });
      return;
    }
    if (holder !== undefined && holder !== null && (typeof holder !== 'string' || !HOLDER_ID.test(holder))) {
      res.status(400).json({ ok: false, error: 'holder is the 32 hex characters the REPL named itself with, or null.' });
      return;
    }
    if (project !== undefined && project !== null && (typeof project !== 'string' || !PROJECT_ID.test(project))) {
      res.status(400).json({ ok: false, error: 'project is the id of the project this REPL draws on (16 hex), or null.' });
      return;
    }
    const id = typeof jobId === 'string' && JOB_ID.test(jobId) ? jobId : `canvas-${randomUUID()}`;
    const named = link.project;
    // R6 (H139): the REPL draws on its own project: a canvas that shows another now runs nothing for it
    if (typeof project === 'string' && named && project !== named.id) {
      const theirs = link.knownProject(project)?.name;
      res.status(409).set('Cache-Control', 'no-store').json({ ok: false, jobId: id, project: { id: named.id, name: named.name },
        error: `Refused: this REPL draws on ${theirs ?? 'another project'}, but the canvas shows ${named.name} now, so nothing ran. In this REPL: /canvas open names its project to the canvas again; then ask again.` });
      return;
    }
    const may = holderMayRun(named, typeof holder === 'string' ? holder : null);
    if (!may.ok) {
      res.status(409).set('Cache-Control', 'no-store').json({ ok: false, error: may.words, jobId: id });
      return;
    }
    // The bridge sends it only to a page whose session counts now for the project named and its holder (409 when the page
    // open cannot act for it, 503 when none is open). R6 (H139): with the project it is for.
    const stamp = named ? { id: named.id, name: named.name } : null;
    const asked = draft === true ? { id: `draft-${randomBytes(6).toString('hex')}`, baseRevision: isCount(baseRevision) ? baseRevision : null } : null;
    const outcome = await bridge.exec(code, id, asked, stamp);
    // The page answers after saving: a call with the source revision it produced joins the jobs ledger. R6 (H139): of the board of
    // the project the call was made for, never of another (a call with no project named has no board, so no ledger).
    const { ok, revision, sourceRevision } = outcome.body;
    const docs = stamp ? boards.of(stamp.id) : null;
    if (docs && outcome.status === 200 && sourceRevision) {
      try {
        docs.recordJob(id, { ok, revision: revision ?? 0, sourceRevision, project: stamp!.id });
      } catch {
        // The call's own answer stands; the ledger is a record of it, not a condition for it.
      }
    }
    // R5 (H133): the drafts record: a draft that left shapes for a person to decide on, or one refused (and why)
    const d = outcome.status === 200 ? outcome.body.draft : undefined;
    if (docs && asked && d && (d.refused || (ok && (d.shapes ?? 0) > 0))) {
      try {
        docs.recordDraft({
          draft: asked.id, event: d.refused ? 'refused' : 'proposed', job: id, shapes: d.refused ? 0 : d.shapes ?? 0,
          from: d.from ?? asked.baseRevision, revision: revision ?? null, sourceRevision: sourceRevision ?? null, project: stamp!.id,
          ...(d.refused ? { reason: d.refused, why: String(outcome.body.error ?? '').slice(0, 400) } : {}),
        });
      } catch {
        // The call's own answer stands; the record is of it, not a condition for it.
      }
    }
    // R6 (H139): a call answered after the canvas switched to another project is kept for its own, and says so
    const now = link.project;
    const kept = stamp && outcome.status === 200 && now && now.id !== stamp.id
      ? { kept: `Kept for ${stamp.name}: the canvas switched to ${now.name} while this call ran, so what it did is ${stamp.name}'s (its board, its jobs ledger and drafts record), never ${now.name}'s.` }
      : {};
    res.status(outcome.status).set('Cache-Control', 'no-store').json({ ...outcome.body, ...kept });
  });
  // R4 (H55): the active project, named by the REPL (token), and its cards, read-only. R4 (H75): with whether a REPL takes
  // the drawn cards' actions, and those actions carried to it.
  mountProjectRoutes(app, {
    link, pageOpen: () => bridge.open, holding: (p) => relay.listening(p.holder),
    // R6 (H139): every page joined is told at once, so its board, drafts and jobs switch with the project named
    named: (p) => { relay.heldBy(p.holder); bridge.announce({ id: p.id, name: p.name }); },
    // R4 (H81): the cards' detail is read with this server's token or a page session that counts for the project now
    pageSession: (authorization, p) => relay.sessionFor(authorization, p),
    // R4 (H109): a board pinned to a project the session reaches reads it; the active project of this Timmy home is said by a
    // server that follows it (one that does not reads no Timmy home's file)
    reach: (authorization, id) => relay.reaches(authorization, id),
    ...(follower ? { active: () => follower.active() } : {}),
  });
  mountCardRoutes(app, { link, relay, port: cardWiring.port });
  // R4 (H109): an operation's run detail, for the canvas page's side panel (the same credentials as the project's cards)
  mountRunDetailRoute(app, { link, relay, ...(options.runDetail ? { producer: options.runDetail } : {}) });
  // C-13: the receipt pages, served by the same local server, with a text fallback.
  mountReceiptPages(app, options.receipts);
  // Checked on every request, so building while Timmy runs needs only a reload.
  app.get(['/', '/index.html'], (_req, res, next) => {
    if (existsSync(join(root, 'dist', 'canvas.js'))) return next();
    res.status(503).set('Cache-Control', 'no-store').type('html').send(NOT_BUILT);
  });
  app.use(express.static(root, { etag: true }));
  app.use((err: { type?: string }, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const tooLarge = err?.type === 'entity.too.large';
    const what = req.path === '/api/canvas/document' ? `This canvas is too large to save (over ${maxCanvasBytes} bytes).` : 'That code is too long for one call (32 KB).';
    res.status(tooLarge ? 413 : 400).json({ ok: false, error: tooLarge ? what : 'Send valid JSON.' });
  });
  return app;
}

/**
 * R5 lead, R5 (H137): whether a server on `port` is the Studio the shared frame names (src/ops/workspace-frame.ts: no other
 * address set, and Studio's port): only that Studio records in the frame's observations that it answered its page, and that it
 * stopped. A server on another port (a test's, a second one), or one that never listened (port 0), records neither.
 */
function framesStudio(env: Record<string, string | undefined>, port: number): boolean {
  return !env.TIMMY_STUDIO_URL?.trim() && port > 0 && port === studioPort(env);
}

export async function startStudioServer(port = STUDIO_PORT, options: StudioOptions = {}): Promise<StudioServer> {
  const link = new ProjectLink(options.projectToken);
  // R4 (H75): the page routes' Host and Origin rule needs the port this server is bound to.
  const relay = new CardRelay(options.relay);
  // R4 (H83): a page joins the bridge, and is sent code, only with a session that counts now.
  const bridge = new CanvasBridge(isLocalRequest, options.execTimeoutMs, bridgeGate(link, relay));
  // R4 (H109): a change of this Timmy home's active project, made after the server starts, is followed (src/studio/active-follow.ts)
  const env = options.env ?? process.env;
  const follower = !(options.followActive ?? options.projectTokenFile === true) ? undefined : new ActiveFollower({
    file: activeProjectFile(env),
    shown: () => link.project,
    follow: (a) => {
      const p = link.follow(a, { jobs: join(timmyHome(env), 'jobs'), receipts: (root) => receiptsDir(root) });
      relay.heldBy(p.holder);
      // R6 (H139): every page joined is told at once, so its board, drafts and jobs switch with the active project
      bridge.announce({ id: p.id, name: p.name });
    },
    ...(options.followEveryMs ? { everyMs: options.followEveryMs } : {}),
    ...(options.followGraceMs !== undefined ? { graceMs: options.followGraceMs } : {}),
  });
  let bound = 0;
  const server = Object.assign(createServer(createStudioApp(options, bridge, link, { relay, port: () => bound }, follower)), { projectToken: link.token });
  bridge.attach(server);
  // R4 (H55): where the token is kept for other REPLs of this Timmy home, once the port is known.
  const tokenDir = options.canvasDir ?? canvasDir(options.env ?? process.env);
  let tokenPort = 0;
  // R5 (H137; the QA round, defect 19's analog): the Studio the frame names records that it stopped (noteStopped), so no
  // surface goes on saying Studio answered after it ended: when it closes, and as its process exits without a close. Only this
  // server's own stop: one that never listened (its port held by another program, or another Timmy) records nothing. The
  // frame's module (src/ops/workspace-frame.ts) is loaded once it listens, so the note is written at once, also on exit.
  let frameOps: typeof import('../ops/workspace-frame.js') | null = null;
  let stopNoted = false;
  const noteStop = (): void => {
    if (stopNoted || !frameOps || !framesStudio(env, bound)) return;
    stopNoted = true;
    frameOps.noteStopped('studio', env);
  };
  // An open canvas holds its WebSocket for good: closing the server closes the bridge first, or
  // server.close() would wait for the page forever.
  const closeServer = server.close.bind(server);
  server.close = ((done?: (err?: Error) => void) => {
    follower?.stop();
    bridge.close();
    relay.close();
    if (tokenPort) dropProjectToken(tokenDir, tokenPort, link.token);
    if (server.listening) noteStop();
    return closeServer(done);
  }) as StudioServer['close'];
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const at = server.address();
      bound = typeof at === 'object' && at ? at.port : 0;
      resolve();
    });
  });
  // R4 (H109): only a server that listens looks at its Timmy home's active project (a port held by another program: nothing read)
  follower?.start();
  // R5 (H137): the Studio the frame names records that it started listening, as the companion does (src/companion/server.ts),
  // so a Studio started again after its stop is not said not running until its page first asks for its frame
  if (framesStudio(env, bound)) {
    try {
      frameOps = await import('../ops/workspace-frame.js');
      // R6 (H139; the interaction review, defect 14): what is true then, without implying that anyone opened Studio
      frameOps.noteAnswered('studio', 'its server started listening; no Studio page had opened yet', env);
    } catch { /* the record cannot be written: the frame says what the last check saw */ }
    const atExit = (): void => { if (server.listening) noteStop(); };
    process.once('exit', atExit);
    server.once('close', () => process.removeListener('exit', atExit));
  }
  if (options.projectTokenFile) {
    const at = server.address();
    const bound = typeof at === 'object' && at ? at.port : 0;
    if (bound && writeProjectToken(tokenDir, bound, link.token)) {
      tokenPort = bound;
      // A REPL ends without closing its canvas server: the token file goes with the process (a kill leaves it, unused).
      const drop = (): void => dropProjectToken(tokenDir, bound, link.token);
      process.once('exit', drop);
      server.once('close', () => process.removeListener('exit', drop));
    }
  }
  return server;
}

export type EnsureResult = { state: 'started'; server: StudioServer } | { state: 'already-running' } | { state: 'failed'; error: string };

/**
 * For /web studio: serve Timmy Canvas from this process unless something already listens on the
 * port (another `timmy studio` or REPL), which then serves the page and the bridge for everyone.
 */
export async function ensureStudioServer(port = STUDIO_PORT, options: StudioOptions = {}): Promise<EnsureResult> {
  try {
    return { state: 'started', server: await startStudioServer(port, options) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EADDRINUSE') return { state: 'failed', error: err.message };
    // Round R1: whatever holds the port must answer as Timmy Canvas before Timmy relies on it.
    const health = await studioHealth(`http://127.0.0.1:${port}`);
    return health.state === 'running'
      ? { state: 'already-running' }
      : { state: 'failed', error: `Port ${port} is used by another program, not Timmy Canvas. Set TIMMY_STUDIO_PORT to a free port.` };
  }
}
