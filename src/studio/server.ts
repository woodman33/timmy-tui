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
 *   POST /api/canvas/jobs/<job>/receipt     the token only; no Origin, no query string             a write, by the REPL that sealed the turn
 *   POST /api/canvas/exec                   the token only; no Origin, no query string; while a   code that runs in the canvas page with its rights
 *                                           project is named, the holder id of the REPL holding
 *                                           it; a page on the bridge whose session counts now
 *   GET /bridge (WebSocket)                 a session, as a subprotocol (src/studio/bridge.ts)     the page the code is sent to
 *   POST /api/project/active                the token; no Origin                                   names the project (project-link.ts)
 *   GET /api/project/active                 nothing more: whether a project is named and a page    the project's name is its content
 *                                           open; its name and id with the token or a session
 *   GET /api/project (?detail=1)            the token or a session                                 the project's cards, and their detail
 *   GET /api/project/image                  the token or a session                                 a highlight image of the project
 *   POST /api/project/grant                 the token; no Origin; a project named                  a one-time grant for the page /canvas open opens
 *   POST /api/project/session               this page (Host and Origin exactly this server's);     the page's session (card-relay.ts)
 *                                           a grant, once
 *   POST /api/project/act                   this page; a session; the act its card offers          a card's action, for the REPL that holds it
 *   GET /api/project/inbox, POST ../<id>    the token; no Origin; the holder id                    the REPL's own actions
 *   GET /receipts/<id>                      nothing more (open; see below)                         C-13's receipt pages
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
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanvasBridge } from './bridge.js';
import { STUDIO_PORT, TLDRAW_VERSION, studioConfig } from './config.js';
import { studioHealth } from './health.js';
import { CanvasDocuments, MAX_CANVAS_BYTES, canvasDir, shownPath } from './document.js';
import { publicTemplates } from './templates.js';
import { FONT_FILES, HOMEBREW, TYPE, themeCss } from '../theme/tokens.js';
// Round R4 (H55): the project the REPL names, and the read-only project API built from the board's readers.
import { dropProjectToken, HOLDER_ID, mountProjectRoutes, ProjectLink, writeProjectToken } from './project-link.js';
// Round R4 (H75): the drawn cards' actions, carried to the REPL that holds the project (this server runs none of them).
import { CardRelay, mountCardRoutes, type RelayOptions } from './card-relay.js';
// Round R4 (H83): who may run code, read and save the canvas, and join the bridge.
import { bridgeGate, callerOf, DOCUMENT_REFUSED, EXEC_REFUSED, holderMayRun, JOBS_REFUSED, keepOthers, LINK_REFUSED, refuse, replOnly, withholdOthers } from './canvas-auth.js';
// R4 (H84): the local-request rule, shared with the browser companion and `timmy logs`.
import { isLocalRequest as isLocal } from '../utils/local-request.js';
// R4 (H109): the canvas follows the active project of its Timmy home (state/active-project.json)
import { ActiveFollower, activeProjectFile } from './active-follow.js';
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
/** R4 (H83): what an exec call carries, and nothing else (a token never goes in a body). */
const EXEC_KEYS: ReadonlySet<string> = new Set(['code', 'jobId', 'holder']);

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
  const documents = new CanvasDocuments(savedIn, { maxBytes: maxCanvasBytes });
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
  app.get('/api/canvas/health', (req, res) => {
    const saved = documents.peek();
    const jobs = documents.jobs();
    const latest = link.authorized(req.headers.authorization) ? jobs[0] : undefined;
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      app: 'timmy-canvas',
      tldrawVersion: TLDRAW_VERSION,
      built: existsSync(join(root, 'dist', 'canvas.js')),
      pageConnected: bridge.open,
      revision: saved.revision,
      sourceRevision: saved.sourceRevision,
      savedAt: saved.savedAt,
      ...(saved.unreadable ? { unreadable: true } : {}),
      jobs: jobs.length,
      latestJob: latest ? { id: latest.id, ok: latest.ok, revision: latest.revision, at: latest.at, ...(latest.receipt ? { receipt: latest.receipt } : {}) } : null,
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
  // where it was and every surface reads the same document, revision and source revision.
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
  app.get('/api/canvas/document', credited(DOCUMENT_REFUSED), (req, res) => {
    const state = documents.load();
    res.set('Cache-Control', 'no-store');
    if (res.locals.by === 'token') { res.json(state); return; }
    // A page's session counts for the project named now: every drawn card of another project comes with its kept detail withheld.
    // R4 (H109): another project the session reaches (it was given for it, or followed it since) is not withheld from it.
    const shown = withholdOthers(state.snapshot, relay.reachOf(req.headers.authorization));
    res.json({ ...state, snapshot: shown.snapshot, withheld: shown.withheld });
  });
  app.put('/api/canvas/document', jsonOnly('Send JSON: {"snapshot": {...}, "revision": N, "baseRevision": N}.'), credited(DOCUMENT_REFUSED),
    express.json({ limit: Math.max(2 * maxCanvasBytes, 1024 * 1024) }), (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // A page's session: another project's cards keep their saved identity and kept detail (never erased by a withheld copy).
      // Checked again after the body was read: the project named may have changed meanwhile.
      if (res.locals.by === 'session') {
        const still = callerOf(req.headers.authorization, link, relay, DOCUMENT_REFUSED);
        if (!still.ok) { refuse(res, still); return; }
      }
      // R4 (H109): the projects the session reaches count as its own
      const toSave = res.locals.by === 'session' ? { ...body, snapshot: keepOthers(body.snapshot, documents.storedSnapshot(), relay.reachOf(req.headers.authorization)).snapshot } : body;
      const saved = documents.save(toSave);
      const status = saved.ok ? 200 : 'conflict' in saved ? 409 : 'tooLarge' in saved ? 413 : 400;
      res.status(status).set('Cache-Control', 'no-store').json(saved);
    });
  app.get('/api/canvas/jobs', credited(JOBS_REFUSED), (_req, res) => {
    res.set('Cache-Control', 'no-store').json(documents.jobs());
  });
  // Public templates start blank: the seeds' four fields only; the page opens one as an empty board.
  app.get('/api/canvas/templates', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ templates: publicTemplates() });
  });
  // The REPL links the receipt it sealed for a turn to that turn's canvas job. R4 (H83): a write, the REPL's only (the token).
  app.post('/api/canvas/jobs/:job/receipt', (req, res, next) => { if (replOnly(req, res, link, LINK_REFUSED)) next(); }, jsonOnly('Send JSON: {"receipt": "<its short hash>"}.'), express.json({ limit: '1kb' }), (req, res) => {
    const job = String(req.params.job);
    const { receipt } = (req.body ?? {}) as { receipt?: unknown };
    res.set('Cache-Control', 'no-store');
    try {
      if (!documents.linkReceipt(job, String(receipt))) {
        res.status(404).json({ ok: false, error: `No canvas job ${JOB_ID.test(job) ? job : 'like that'}.` });
        return;
      }
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    res.json({ ok: true, job, receipt });
  });
  // The agent's canvas tools: Editor API code in, the page's answer out. JSON only, so a form on
  // another site cannot post here without a CORS preflight that this server never grants. R4 (H83): the REPL's only: the
  // token in an Authorization header (never a page, never in an address), and while a project is named, the REPL holding it.
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
      res.status(400).json({ ok: false, error: `Unknown field${extra.length > 1 ? 's' : ''}: ${extra.slice(0, 5).map((k) => JSON.stringify(k).slice(0, 40)).join(', ')}. The fields are code, jobId and holder.` });
      return;
    }
    const { code, jobId, holder } = body as { code?: unknown; jobId?: unknown; holder?: unknown };
    if (typeof code !== 'string' || !code.trim()) {
      res.status(400).json({ ok: false, error: 'Send {"code": "..."}: the Editor API code to run.' });
      return;
    }
    if (holder !== undefined && holder !== null && (typeof holder !== 'string' || !HOLDER_ID.test(holder))) {
      res.status(400).json({ ok: false, error: 'holder is the 32 hex characters the REPL named itself with, or null.' });
      return;
    }
    const id = typeof jobId === 'string' && JOB_ID.test(jobId) ? jobId : `canvas-${randomUUID()}`;
    const may = holderMayRun(link.project, typeof holder === 'string' ? holder : null);
    if (!may.ok) {
      res.status(409).set('Cache-Control', 'no-store').json({ ok: false, error: may.words, jobId: id });
      return;
    }
    // The bridge sends it only to a page whose session counts now for the project named and its holder (409 when the page
    // open cannot act for it, 503 when none is open).
    const outcome = await bridge.exec(code, id);
    // The page answers after saving: a call with the source revision it produced joins the jobs ledger.
    const { ok, revision, sourceRevision } = outcome.body;
    if (outcome.status === 200 && sourceRevision) {
      try {
        documents.recordJob(id, { ok, revision: revision ?? 0, sourceRevision });
      } catch {
        // The call's own answer stands; the ledger is a record of it, not a condition for it.
      }
    }
    res.status(outcome.status).set('Cache-Control', 'no-store').json(outcome.body);
  });
  // R4 (H55): the active project, named by the REPL (token), and its cards, read-only. R4 (H75): with whether a REPL takes
  // the drawn cards' actions, and those actions carried to it.
  mountProjectRoutes(app, {
    link, pageOpen: () => bridge.open, holding: (p) => relay.listening(p.holder), named: (p) => relay.heldBy(p.holder),
    // R4 (H81): the cards' detail is read with this server's token or a page session that counts for the project now
    pageSession: (authorization, p) => relay.sessionFor(authorization, p),
    // R4 (H109): a board pinned to a project the session reaches reads it; the active project of this Timmy home is said by a
    // server that follows it (one that does not reads no Timmy home's file)
    reach: (authorization, id) => relay.reaches(authorization, id),
    ...(follower ? { active: () => follower.active() } : {}),
  });
  mountCardRoutes(app, { link, relay, port: cardWiring.port });
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
    follow: (a) => { const p = link.follow(a, { jobs: join(timmyHome(env), 'jobs'), receipts: (root) => receiptsDir(root) }); relay.heldBy(p.holder); },
    ...(options.followEveryMs ? { everyMs: options.followEveryMs } : {}),
    ...(options.followGraceMs !== undefined ? { graceMs: options.followGraceMs } : {}),
  });
  let bound = 0;
  const server = Object.assign(createServer(createStudioApp(options, bridge, link, { relay, port: () => bound }, follower)), { projectToken: link.token });
  bridge.attach(server);
  // R4 (H55): where the token is kept for other REPLs of this Timmy home, once the port is known.
  const tokenDir = options.canvasDir ?? canvasDir(options.env ?? process.env);
  let tokenPort = 0;
  // An open canvas holds its WebSocket for good: closing the server closes the bridge first, or
  // server.close() would wait for the page forever.
  const closeServer = server.close.bind(server);
  server.close = ((done?: (err?: Error) => void) => {
    follower?.stop();
    bridge.close();
    relay.close();
    if (tokenPort) dropProjectToken(tokenDir, tokenPort, link.token);
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
