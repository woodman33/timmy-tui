/**
 * The Timmy Canvas server (plan F-4): the canvas page, its configuration and the agent bridge,
 * on 127.0.0.1 only.
 */
import express from 'express';
import { mountReceiptPages, type ReceiptSource } from './receipt-page.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { CanvasBridge } from './bridge.js';
import { STUDIO_PORT, studioConfig } from './config.js';

export { STUDIO_PORT };

export interface StudioOptions {
  env?: Record<string, string | undefined>;
  /** The page's folder; defaults to the packaged companion/studio-canvas. */
  root?: string;
  /** How long a canvas call may take before it fails (default 30 s). */
  execTimeoutMs?: number;
  /** Where the receipt pages read the chain (C-13); defaults to this folder's store. */
  receipts?: ReceiptSource;
}

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

export function createStudioApp(options: StudioOptions = {}, bridge = new CanvasBridge(isLocalRequest, options.execTimeoutMs)): express.Express {
  const env = options.env ?? process.env;
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (isLocalRequest(req)) return next();
    res.status(403).type('text/plain').send('Timmy Canvas answers 127.0.0.1 and localhost only.');
  });
  app.get('/studio-config.json', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(studioConfig(env));
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
    res.status(outcome.status).set('Cache-Control', 'no-store').json(outcome.body);
  });
  // C-13: the receipt pages, served by the same local server, with a text fallback.
  mountReceiptPages(app, options.receipts);
  app.use(express.static(options.root ?? studioRoot(), { etag: true }));
  app.use((err: { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const tooLarge = err?.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({ ok: false, error: tooLarge ? 'That code is too long for one call (32 KB).' : 'Send valid JSON.' });
  });
  return app;
}

export async function startStudioServer(port = STUDIO_PORT, options: StudioOptions = {}): Promise<Server> {
  const bridge = new CanvasBridge(isLocalRequest, options.execTimeoutMs);
  const server = createServer(createStudioApp(options, bridge));
  bridge.attach(server);
  // An open canvas holds its WebSocket for good: closing the server closes the bridge first, or
  // server.close() would wait for the page forever.
  const closeServer = server.close.bind(server);
  server.close = ((done?: (err?: Error) => void) => {
    bridge.close();
    return closeServer(done);
  }) as Server['close'];
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}

export type EnsureResult = { state: 'started'; server: Server } | { state: 'already-running' } | { state: 'failed'; error: string };

/**
 * For /web studio: serve Timmy Canvas from this process unless something already listens on the
 * port (another `timmy studio` or REPL), which then serves the page and the bridge for everyone.
 */
export async function ensureStudioServer(port = STUDIO_PORT, options: StudioOptions = {}): Promise<EnsureResult> {
  try {
    return { state: 'started', server: await startStudioServer(port, options) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code === 'EADDRINUSE' ? { state: 'already-running' } : { state: 'failed', error: err.message };
  }
}
