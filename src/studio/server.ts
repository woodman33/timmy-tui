/**
 * The Timmy Canvas server (plan F-4): the canvas page, its configuration and the agent bridge,
 * on 127.0.0.1 only.
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
import { dropProjectToken, mountProjectRoutes, ProjectLink, writeProjectToken } from './project-link.js';

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
}

/** R4 (H55): the server, with the token its REPL names the active project with. */
export type StudioServer = Server & { projectToken: string };

/** companion/studio-canvas, found from the source (src/studio) or the build (dist/src/studio). */
export function studioRoot(): string {
  const candidates = ['../../companion/studio-canvas', '../../../companion/studio-canvas'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
  return candidates.find(existsSync) ?? candidates[0];
}

/** Host headers this server answers: a page elsewhere cannot rebind its DNS name to 127.0.0.1 and read it. */
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
/** Origins allowed to call it: this machine's own pages (a browser always sends Origin on a WebSocket). */
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** Addressed to this machine, and (when a browser says where it comes from) sent by this machine's pages. */
export function isLocalRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return LOCAL_HOST.test(req.headers.host ?? '') && (origin === undefined || LOCAL_ORIGIN.test(origin));
}

const JOB_ID = /^[\w.:-]{1,100}$/;

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

export function createStudioApp(options: StudioOptions = {}, bridge = new CanvasBridge(isLocalRequest, options.execTimeoutMs), link = new ProjectLink(options.projectToken)): express.Express {
  const env = options.env ?? process.env;
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
  // It runs nothing in the page and never carries the license key.
  app.get('/api/canvas/health', (_req, res) => {
    const saved = documents.peek();
    const jobs = documents.jobs();
    const latest = jobs[0];
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
  app.get('/studio-config.json', (_req, res) => {
    // canvasDir: the folder this server saves the canvas in, which the blank board names (the 20:14 order).
    res.set('Cache-Control', 'no-store').json({ ...studioConfig(env), canvasDir: shownPath(savedIn) });
  });
  // Fourth order, step 5: the canvas, saved by Timmy in its home and opened from there, so it reopens
  // where it was and every surface reads the same document, revision and source revision.
  const jsonOnly = (message: string): express.RequestHandler => (req, res, next) => {
    if (req.is('application/json')) return next();
    res.status(415).json({ ok: false, error: message });
  };
  app.get('/api/canvas/document', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(documents.load());
  });
  app.put('/api/canvas/document', jsonOnly('Send JSON: {"snapshot": {...}, "revision": N, "baseRevision": N}.'),
    express.json({ limit: Math.max(2 * maxCanvasBytes, 1024 * 1024) }), (req, res) => {
      const saved = documents.save((req.body ?? {}) as Record<string, unknown>);
      const status = saved.ok ? 200 : 'conflict' in saved ? 409 : 'tooLarge' in saved ? 413 : 400;
      res.status(status).set('Cache-Control', 'no-store').json(saved);
    });
  app.get('/api/canvas/jobs', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(documents.jobs());
  });
  // Public templates start blank: the seeds' four fields only; the page opens one as an empty board.
  app.get('/api/canvas/templates', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ templates: publicTemplates() });
  });
  // The REPL links the receipt it sealed for a turn to that turn's canvas job.
  app.post('/api/canvas/jobs/:job/receipt', jsonOnly('Send JSON: {"receipt": "<its short hash>"}.'), express.json({ limit: '1kb' }), (req, res) => {
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
  // another site cannot post here without a CORS preflight that this server never grants.
  app.post('/api/canvas/exec', (req, res, next) => {
    if (!req.is('application/json')) {
      res.status(415).json({ ok: false, error: 'Send JSON: {"code": "...", "jobId": "..."}.' });
      return;
    }
    next();
  }, express.json({ limit: '32kb' }), async (req, res) => {
    const { code, jobId } = (req.body ?? {}) as { code?: unknown; jobId?: unknown };
    if (typeof code !== 'string' || !code.trim()) {
      res.status(400).json({ ok: false, error: 'Send {"code": "..."}: the Editor API code to run.' });
      return;
    }
    const id = typeof jobId === 'string' && JOB_ID.test(jobId) ? jobId : `canvas-${randomUUID()}`;
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
  // R4 (H55): the active project, named by the REPL (token), and its cards, read-only.
  mountProjectRoutes(app, { link, pageOpen: () => bridge.open });
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
  const bridge = new CanvasBridge(isLocalRequest, options.execTimeoutMs);
  const link = new ProjectLink(options.projectToken);
  const server = Object.assign(createServer(createStudioApp(options, bridge, link)), { projectToken: link.token });
  bridge.attach(server);
  // R4 (H55): where the token is kept for other REPLs of this Timmy home, once the port is known.
  const tokenDir = options.canvasDir ?? canvasDir(options.env ?? process.env);
  let tokenPort = 0;
  // An open canvas holds its WebSocket for good: closing the server closes the bridge first, or
  // server.close() would wait for the page forever.
  const closeServer = server.close.bind(server);
  server.close = ((done?: (err?: Error) => void) => {
    bridge.close();
    if (tokenPort) dropProjectToken(tokenDir, tokenPort, link.token);
    return closeServer(done);
  }) as StudioServer['close'];
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  if (options.projectTokenFile) {
    const at = server.address();
    const bound = typeof at === 'object' && at ? at.port : 0;
    if (bound && writeProjectToken(tokenDir, bound, link.token)) tokenPort = bound;
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
