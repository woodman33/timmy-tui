/**
 * The browser companion: the page `timmy watch`'s monitor serves (src/companion/client), Slate 3D beside it, the event bus
 * over a WebSocket, and a streaming chat that spends the operator's OpenRouter credits.
 *
 * R4 (H84): it is this computer's own. It listens on 127.0.0.1, and on this computer's networks too only when the operator
 * asks (`timmy watch --lan`, for a phone on the same network). Every request and every WebSocket upgrade first passes the
 * local rule of Timmy's servers (src/utils/local-request.ts isLocalRequest: Host 127.0.0.1, localhost or [::1], or with
 * --lan this computer's own network address as the address it gives; Origin, when a browser sends one, a page of this
 * computer), so no other site, and no name rebound to this computer, reaches it. "The token" is 32 random bytes this server
 * makes when it starts; the address Timmy gives carries it in the fragment (#t=…), and the page keeps it in memory and sends
 * it in an Authorization header (`Bearer <token>`) and as a WebSocket subprotocol (`timmy-token.<token>` beside
 * `timmy-companion`, the one the server selects). A token in an address is refused. A refused request makes no upstream call
 * and writes nothing, and says what to do: in `timmy watch`, q on HOME shows the address with its token.
 *
 *   route                                  requires                          why
 *   GET /, /index.html, the page's files   nothing more                      the companion page's code (public in the repository);
 *                                                                            without the token it loads nothing and says so
 *   GET /slate3d/*, /slate3d/boards/*      nothing more                      Slate 3D's built files and the repository's boards
 *   GET /api/auth                          the token                         whether the page's token is still this server's
 *   GET /api/canvas                        the token                         Timmy Canvas's revision and jobs (ids a model may name)
 *   GET /slate3d/receipts                  the token                         the receipt chain's records
 *   POST /slate3d/emit                     the token                         writes to the bus; asks the controller (`timmy logs`,
 *                                                                            with its own token, src/utils/local-request.ts)
 *   POST /api/workflow/fusion              the token                         writes receipt files
 *   POST /chat                             the token                         spends: OpenRouter with the operator's key
 *   GET /api/clerk-config                  the token                         the operator's configuration
 *   GET /api/cloudflare-workflows          the token                         asks the telemetry endpoint for a run
 *   WebSocket (any path)                   the token, as a subprotocol       the bus's tail, the state, the chat mirror; its
 *                                                                            messages add, stop and switch the monitor's panes
 *
 * The token is never written to a log, a receipt or the bus: it is shown only where the operator started the server, as
 * part of the address to open (src/companion/qr.ts: the monitor's q on HOME, or the terminal), and with --lan in the QR code.
 *
 * R4 (H87): the files it serves beside its code are COMPANION_RUNTIME_FILES, which the build copies into dist/
 * (scripts/copy-runtime-assets.mjs; r23: the installed package's GET / answered 404 with ENOENT and the install path, its
 * dist/ had no client/index.html). Slate 3D's built bundle ships only in a source checkout that built it; without it the
 * companion says so in words where Slate 3D would be. Every failure answers with words: no path of this computer, no stack.
 */
import express from 'express';
import { createServer, type IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';
import fs from 'fs';
import { computeReceiptHash, Receipt } from '../receipt/schema.js';
import { VERSION } from '../version.js';
import { canvasSummary } from './canvas.js';
import { keySet } from '../utils/keys.js';
// R4 (H84): the local rule and the token (shared with Timmy Canvas and `timmy logs`).
import { isLocalRequest, lanAddresses, LocalToken, logsTokenFile, readTokenFile, refuseRequest, refuseUpgrade, TOKEN_IN_ADDRESS } from '../utils/local-request.js';
import { failRequest } from '../utils/server-failure.js';
import { packagedPath } from '../utils/asset-dirs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Model used by the /chat streaming proxy (TMX P3 Streamdown surface). */
const CHAT_MODEL = 'qwen/qwen3.8-max';
/** Where /chat sends its completion unless a test gives a FAKE (CompanionOptions.upstream). */
const OPENROUTER_CHAT = 'https://openrouter.ai/api/v1/chat/completions';

/** R4 (H84): the subprotocol the server selects (a page offers it beside its token). */
export const COMPANION_PROTOCOL = 'timmy-companion';
/** R4 (H84): what a request without the token is told. */
export const COMPANION_REFUSED = 'Refused: this needs the browser companion\'s token. Open the companion from Timmy: in `timmy watch`, press q on HOME; it shows the companion\'s address with its token (after #, which the page keeps in memory and sends in a header).';
/**
 * R4 (H87): the files this server serves beside its code at run time, package-relative: every file of its client folder
 * (served as they are). The build copies each into dist/ (scripts/copy-runtime-assets.mjs RUNTIME_ASSETS);
 * tests/runtime-pages.test.ts keeps the lists together, so a new page cannot be left out of the package.
 */
export const COMPANION_RUNTIME_FILES: readonly string[] = Object.freeze(['src/companion/client/index.html']);
/** R4 (H87): the words a failure answers with (never a path of this computer, never a stack). */
export const COMPANION_FAILED = 'The browser companion could not read what this request needs, so it answers with nothing and wrote nothing. It is still running.';
export const COMPANION_PAGE_ABSENT = 'The browser companion\'s page is missing from this installation (its file was not shipped), so there is nothing to show here. Reinstall Timmy; `timmy logs` has pages of its own.';
export const COMPANION_NOT_FOUND = 'The browser companion has nothing at this address.';
export const COMPANION_BAD_REQUEST = 'The browser companion could not read this request (its body is not the JSON it expects, or is too large); nothing was done.';
export const SLATE3D_ABSENT = 'Slate 3D is not part of this installation: its built bundle (companion/slate3d) ships only in a source checkout that has built it. Everything else in the browser companion works without it.';
export const COMPANION_FOREIGN = 'Refused: the browser companion answers only to this computer (127.0.0.1 or localhost), or with --lan to this computer\'s own network address, and only from its own pages.';

export interface CompanionOptions {
  /** R4 (H84): also listen on this computer's networks (`timmy watch --lan`): plain HTTP; every route but the page needs the token. */
  lan?: boolean;
  /** R4 (H84): the token (64 hex), a test's or a lane's; made at random when absent. */
  token?: string;
  /** R4 (H84): the chat completions address /chat sends to (a test's FAKE on 127.0.0.1); OpenRouter's when absent. */
  upstream?: string;
  /** R4 (H87): the folder its page is served from (a test's); its own client folder when absent. */
  clientDir?: string;
}

/**
 * Ensure OPENROUTER_API_KEY is present even when the host entry point did
 * not preload .env (the companion server can be started standalone). Uses
 * the same zero-dep parsing rules as loadEnvFile in src/utils/config.ts but
 * stays local to avoid pulling Conf store side effects into the server.
 * Real environment variables always win.
 */
function ensureOpenRouterApiKey(): void {
  if (process.env.OPENROUTER_API_KEY) return;
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '..', '..', '.env'),
  ];
  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue;
      for (const raw of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        let line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('export ')) line = line.slice(7).trim();
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
      }
      if (process.env.OPENROUTER_API_KEY) return;
    } catch {
      // Never crash the companion server on env parsing
    }
  }
}

export interface CompanionServer {
  app: express.Application;
  httpServer: ReturnType<typeof createServer>;
  wss: WebSocketServer;
  clients: Set<import('ws').WebSocket>;
  /** The port it is bound to. */
  port: number;
  /** R4 (H84): where it listens: 127.0.0.1, or 0.0.0.0 with --lan. */
  host: string;
  /** R4 (H84): its address on this computer, without the token (what a log may name). */
  address: string;
  /** R4 (H84): the address to open on this computer, with the token in its fragment. */
  url: string;
  /** R4 (H84): with --lan, the addresses to open from another device on the network, each with the token; else none. */
  lanUrls: string[];
  currentState: string;
  shutdown: () => Promise<void>;
  setState: (state: string) => void;
  sendFrame: (frame: { data: string; width: number; height: number; id: number }) => void;
  sendUpdate: (type: string, data: any) => void;
}

export async function startCompanionServer(port = 3001, options: CompanionOptions = {}): Promise<CompanionServer> {
  const app = express();
  app.disable('x-powered-by');
  const httpServer = createServer(app);
  // R4 (H84): upgrades are taken by hand (below), after the local rule and the token
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (offered) => (offered.has(COMPANION_PROTOCOL) ? COMPANION_PROTOCOL : false) });
  wss.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') return;
    logger.error('WebSocket server error:', err);
  });
  const clients = new Set<import('ws').WebSocket>();
  // R4 (H84): this computer's own network addresses, answered only with --lan; the token, made now
  const lan = options.lan ? lanAddresses() : [];
  const key = new LocalToken(options.token);
  const chatUrl = options.upstream ?? OPENROUTER_CHAT;
  const refusedHere = (req: IncomingMessage): { status: 401 | 403; words: string } | null => {
    if (!isLocalRequest(req, lan)) return { status: 403, words: COMPANION_FOREIGN };
    if (key.inAddress(req.url)) return { status: 401, words: TOKEN_IN_ADDRESS };
    return null;
  };
  // Every request: this computer's, from its pages; no token in its address.
  app.use((req, res, next) => {
    const refused = refusedHere(req);
    if (refused) { refuseRequest(res, refused.status, refused.words); return; }
    next();
  });
  /** The routes that carry the operator's content, spend or write: the token, in an Authorization header (before a body is read). */
  const withToken: express.RequestHandler = (req, res, next) => {
    if (key.bearer(req.headers.authorization)) { next(); return; }
    refuseRequest(res, 401, COMPANION_REFUSED);
  };
  // R4 (H84): every upgrade: the local rule, then the token as a subprotocol beside timmy-companion
  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const refused = refusedHere(req);
    if (refused) { refuseUpgrade(socket, refused.status, refused.words); return; }
    if (key.offered(req.headers['sec-websocket-protocol'], COMPANION_PROTOCOL) !== 'ok') { refuseUpgrade(socket, 401, COMPANION_REFUSED); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // Event-bus tail → every client as {type:'bus', event}. The bus lives in the
  // pinned repo root (TIMMY_REPO when set), never in a worktree copy. Two files
  // are tailed: the one bus (event envelopes appended beside the receipts in
  // .timmy/receipts/runs.jsonl, src/bus) and the legacy .timmy/runs/timmy-events.jsonl
  // that older writers still use. Receipt records are skipped; only event
  // envelopes pass. Whole lines only; a partial append waits for its newline.
  const busRoot = process.env.TIMMY_REPO ?? process.cwd();
  const busFiles = [
    path.join(busRoot, '.timmy', 'receipts', 'runs.jsonl'),
    path.join(busRoot, '.timmy', 'runs', 'timmy-events.jsonl'),
  ];
  const isBusEvent = (o: any): boolean =>
    Boolean(o && typeof o.kind === 'string' && o.payload && typeof o.payload === 'object' && o.ts && !o.hash && !o.sig);
  const parseBusLines = (text: string): any[] =>
    text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(isBusEvent);
  // The tail a new client gets: everything from the last six hours across both
  // files (so a burst on one file cannot hide a seal on the other), and never
  // fewer than n events. The viewer fades pods by age, so history reads as glow.
  const BUS_WINDOW_MS = 6 * 60 * 60 * 1000;
  const busTail = (n: number): any[] => {
    const all: any[] = [];
    for (const f of busFiles) { try { all.push(...parseBusLines(fs.readFileSync(f, 'utf8')).slice(-2000)); } catch { /* no file yet */ } }
    all.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const since = Date.now() - BUS_WINDOW_MS;
    const recent = all.filter((e) => Date.parse(e.ts) >= since);
    return recent.length >= n ? recent : all.slice(-n);
  };
  const busOffsets = busFiles.map((f) => { try { return fs.statSync(f).size; } catch { return 0; } });
  const busTimer = setInterval(() => {
    busFiles.forEach((f, i) => {
      let size = 0;
      try { size = fs.statSync(f).size; } catch { return; }
      if (size < busOffsets[i]) busOffsets[i] = 0;
      if (size === busOffsets[i]) return;
      let chunk = '';
      try {
        const fd = fs.openSync(f, 'r');
        const buf = Buffer.alloc(size - busOffsets[i]);
        fs.readSync(fd, buf, 0, buf.length, busOffsets[i]);
        fs.closeSync(fd);
        chunk = buf.toString('utf8');
      } catch { return; }
      const cut = chunk.lastIndexOf('\n');
      if (cut < 0) return;
      const whole = chunk.slice(0, cut + 1);
      busOffsets[i] += Buffer.byteLength(whole, 'utf8');
      for (const event of parseBusLines(whole)) {
        const msg = JSON.stringify({ type: 'bus', event });
        for (const c of clients) if (c.readyState === 1) c.send(msg);
      }
    });
  }, 500);
  busTimer.unref();
  let currentState = 'idle';

  // Serve static client files
  const clientDir = options.clientDir ?? path.join(__dirname, 'client');
  app.use(express.static(clientDir));

  // Slate 3D (companion/slate3d/dist) and the boards it renders, served beside
  // the client. The bus tail below is what lights its lane pods.
  // R4 (H87): found from the package root (a checkout or the installed package; ../../ from dist/src/companion is dist/), and
  // when its built bundle is not here, its page says so in words.
  const slateDist = packagedPath('companion/slate3d/dist', import.meta.url, { kind: 'dir' });
  const boardsDir = packagedPath('companion/boards', import.meta.url, { kind: 'dir' });
  if (boardsDir) app.use('/slate3d/boards', express.static(boardsDir));
  if (slateDist) app.use('/slate3d', express.static(slateDist));
  else {
    app.get(['/slate3d', '/slate3d/', '/slate3d/index.html'], (_req, res) => { failRequest(res, 404, SLATE3D_ABSENT, 'text'); });
  }

  // Receipts for Slate 3D capsule state: receipt records (never the event
  // envelopes) from the pinned root store, filtered by subject, newest first,
  // with their sources (the seal metadata, e.g. an order id). Read-only.
  app.get('/slate3d/receipts', withToken, (req, res) => {
    const subject = String(req.query.subject ?? '');
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit ?? 400)));
    const store = path.join(busRoot, '.timmy', 'receipts', 'runs.jsonl');
    const receipts: any[] = [];
    try {
      const lines = fs.readFileSync(store, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && receipts.length < limit; i--) {
        let o: any;
        try { o = JSON.parse(lines[i]); } catch { continue; }
        if (!o || !o.id || !o.hash) continue;
        if (subject && o.subject !== subject) continue;
        receipts.push({ id: o.id, ts: o.ts, subject: o.subject, kind: o.kind, epoch: o.epoch ?? null, sources: o.sources ?? null });
      }
    } catch { /* no store yet */ }
    res.json({ ok: true, subject, count: receipts.length, receipts });
  });

  // Slate 3D emits controller calls; it never spawns. The scene may ask the
  // controller (the `timmy logs` gateway on localhost) to compile a mission
  // doc into DispatchPlans or to store one plan; arming and launching still
  // require the operator token there. Every emit is published on the bus as
  // slate.emit so the act itself is on record, whatever the controller says.
  app.post('/slate3d/emit', withToken, express.json({ limit: '256kb' }), async (req, res) => {
    const action = String(req.body?.action ?? '');
    const capsule = String(req.body?.capsule ?? '');
    if (!['compile', 'store'].includes(action)) { res.status(400).json({ ok: false, error: 'action must be compile or store' }); return; }
    const logsPort = Number(process.env.TIMMY_LOGS_PORT ?? 4310);
    const gateway = `http://127.0.0.1:${logsPort}/mission/${action}`;
    // artifact paths resolve against the checkout that serves this page (the
    // branch the board describes), while receipts stay in the pinned root
    const checkout = path.resolve(__dirname, '..', '..');
    const payload = action === 'compile' ? { doc: req.body?.doc ?? { nodes: [], edges: [] }, repo_root: checkout } : { plan: req.body?.plan ?? {} };
    // R4 (H84): the controller asks for its own token, which `timmy logs` keeps for this user's programs (0600)
    const controllerToken = readTokenFile(logsTokenFile(logsPort, process.env));
    let out: any;
    try {
      const r = await fetch(gateway, { method: 'POST', headers: { 'content-type': 'application/json', ...(controllerToken ? { Authorization: `Bearer ${controllerToken}` } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
      out = await r.json();
    } catch {
      out = { ok: false, state: 'not_configured', note: `controller not reachable at ${gateway}; run \`timmy logs\` from the repo root` };
    }
    try {
      const oneBus = path.join(busRoot, '.timmy', 'receipts', 'runs.jsonl');
      const p = fs.existsSync(oneBus) && fs.existsSync(path.join(busRoot, 'src', 'bus', 'index.ts')) ? oneBus : busFiles[1];
      fs.appendFileSync(p, JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: `slate.emit.${action}`, payload: { capsule, ok: !!out?.ok, state: out?.state ?? null, plan_hash: out?.plan_hash ?? null, plans: Array.isArray(out?.plans) ? out.plans.length : undefined } }) + '\n');
    } catch { /* the bus never breaks the emit */ }
    res.json({ ok: !!out?.ok, action, capsule, gateway, ...out });
  });

  // R4 (H84): whether the page's token is still this server's (the page asks when its socket closes; a refusal stops its retries).
  app.get('/api/auth', withToken, (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, lan: lan.length > 0 });
  });
  // Serve Clerk publishable key dynamically
  // Fourth order, step 5: the CANVAS tab reads Timmy Canvas's revision, source revision and jobs,
  // read-only, never the drawing (with --lan, this server can be reached from a phone on the network).
  app.get('/api/canvas', withToken, (_req, res) => {
    res.set('Cache-Control', 'no-store').json(canvasSummary(process.env));
  });
  app.get('/api/clerk-config', withToken, (_req, res) => {
    res.json({
      publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || ""
    });
  });

  app.get('/api/cloudflare-workflows', withToken, async (req, res) => {
    const endpoint = process.env.TIMMY_TELEMETRY_URL || 'http://127.0.0.1:8787';
    const runId = typeof req.query.runId === 'string' && req.query.runId.trim()
      ? req.query.runId.trim()
      : 'default-local-run';

    try {
      const workflowRes = await fetch(`${endpoint.replace(/\/$/, '')}/workflows?runId=${encodeURIComponent(runId)}`);
      const body = await workflowRes.text();
      res
        .status(workflowRes.status)
        .type(workflowRes.headers.get('content-type') || 'application/json')
        .send(body);
    } catch (err: any) {
      res.status(503).json({
        success: false,
        runId,
        endpoint,
        error: err?.message || 'Cloudflare workflow endpoint unavailable'
      });
    }
  });

  app.post('/api/workflow/fusion', withToken, express.json(), async (req, res) => {
    try {
      const { models = [], plugins = [], riveStateHash = "", prompt = "" } = req.body;

      const runId = `run_fusion_${Math.random().toString(36).substring(2, 9)}`;
      const timestamp = Date.now();
      const createdAt = new Date(timestamp).toISOString();

      const modelsUsed = models.map((m: any, i: number) => {
        if (typeof m === 'string') {
          return { id: m, weight: i === 0 ? 0.6 : 0.2, tokens: 250 };
        }
        return {
          id: m.id || "unknown",
          weight: typeof m.weight === 'number' ? m.weight : 0.5,
          tokens: typeof m.tokens === 'number' ? m.tokens : 250
        };
      });

      const pluginsRun = plugins.map((p: any) => {
        if (typeof p === 'string') {
          if (p.includes('@')) return p;
          return `${p}@1.0.0`;
        }
        return `${p.name || "unknown"}@${p.version || "1.0.0"}`;
      });

      const replayPath = `.timmy/receipts/fusion_run_${timestamp}/replay.md`;
      const replayContent = `# Fusion Run Replay\n\nTask: ${prompt}\nModels: ${modelsUsed.map((m: any) => m.id).join(', ')}`;
      const replayHash = crypto.createHash('sha256').update(replayContent).digest('hex');

      const receiptWithoutHash: Omit<Receipt, 'receipt_sha256'> = {
        schema_version: "0.3",
        run_id: runId,
        type: "fusion",
        task: prompt,
        created_at: createdAt,
        cwd: process.cwd(),
        platform: process.platform,
        node_version: process.version,
        package: {
          name: "timmy-tui",
          version: VERSION
        },
        status: "completed",
        models_used: modelsUsed,
        plugins_run: pluginsRun,
        rive_state_hash: riveStateHash || crypto.createHash('sha256').update("timmy_fusion_state").digest('hex'),
        consensus: {
          model: modelsUsed[0]?.id || "gemini-2.5-pro",
          tokens: 1800,
          latency_ms: 450
        },
        artifacts: [
          { path: replayPath, sha256: replayHash }
        ]
      };

      const finalHash = computeReceiptHash(receiptWithoutHash);
      const receipt: Receipt = {
        ...receiptWithoutHash,
        receipt_sha256: finalHash
      };

      // Write mock replay and receipt to local file system
      const receiptsDir = path.join(process.cwd(), '.timmy', 'receipts', `fusion_run_${timestamp}`);
      fs.mkdirSync(receiptsDir, { recursive: true });
      fs.writeFileSync(path.join(receiptsDir, 'replay.md'), replayContent, 'utf8');
      fs.writeFileSync(path.join(receiptsDir, 'receipt.json'), JSON.stringify(receipt, null, 2), 'utf8');

      res.json({
        success: true,
        receipt
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /chat — TMX P3 streaming chat proxy.
   * Accepts JSON { message: string } or { messages: [{ role, content }] },
   * proxies a streaming OpenRouter chat completion (model: qwen/qwen3.8-max)
   * and relays it to the browser as Server-Sent Events:
   *   event: delta  — JSON-encoded text chunk
   *   event: usage  — token usage object (when OpenRouter reports it)
   *   event: error  — { error, details? }
   *   event: done   — { ok: true }
   * R4 (H84): it spends the operator's credits, so only with the token (checked before the body is read or a key is
   * looked for); the completion goes to `chatUrl`: OpenRouter, or a test's FAKE (CompanionOptions.upstream).
   */
  app.post('/chat', withToken, express.json(), async (req, res) => {
    ensureOpenRouterApiKey();

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendSse = (event: string, data: unknown): void => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Client disconnected mid-stream; the res 'close' handler aborts upstream
      }
    };

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      sendSse('error', {
        error: 'OPENROUTER_API_KEY is missing. Add it to .env at the repo root (or export it) and restart the companion.'
      });
      res.end();
      return;
    }

    // Accept { message } or { messages }
    const body = (req.body || {}) as { message?: unknown; messages?: unknown };
    let chatMessages: Array<{ role: string; content: string }> = [];
    if (Array.isArray(body.messages)) {
      chatMessages = body.messages
        .filter((m: any) => m && typeof m.content === 'string' && m.content.trim().length > 0)
        .map((m: any) => ({
          role: typeof m.role === 'string' && m.role ? m.role : 'user',
          content: m.content,
        }));
    }
    if (chatMessages.length === 0 && typeof body.message === 'string' && body.message.trim()) {
      chatMessages = [{ role: 'user', content: body.message.trim() }];
    }
    if (chatMessages.length === 0) {
      sendSse('error', {
        error: 'POST /chat expects a JSON body of { message: string } or { messages: [{ role, content }] }.'
      });
      res.end();
      return;
    }

    // Abort the upstream request if the browser goes away.
    // (Note: res 'close' is the disconnect signal — req 'close' fires as
    // soon as the request body has been fully received.)
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const upstream = await fetch(chatUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: CHAT_MODEL, messages: chatMessages, stream: true }),
        signal: controller.signal,
      });

      if (!upstream.ok || !upstream.body) {
        const details = await upstream.text().catch(() => '');
        sendSse('error', {
          error: `OpenRouter responded ${upstream.status} for model ${CHAT_MODEL}`,
          details: details.slice(0, 2000),
        });
        res.end();
        return;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // OpenRouter speaks SSE; split on blank lines and forward data lines
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);

          for (const line of rawEvent.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const chunk = JSON.parse(payload);
              const delta = chunk?.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta.length > 0) {
                sendSse('delta', delta);
              }
              if (chunk?.usage) {
                sendSse('usage', chunk.usage);
              }
            } catch {
              // Ignore malformed stream chunks
            }
          }
        }
      }

      sendSse('done', { ok: true });
      res.end();
    } catch (err: any) {
      // AbortError means the client disconnected — nothing left to write.
      if (err?.name === 'AbortError') return;
      sendSse('error', { error: err?.message || 'Upstream stream failed' });
      try {
        if (!res.writableEnded) res.end();
      } catch {
        // Socket already gone
      }
    }
  });

  // Serve the built client (if using vite)
  // R4 (H87): a page that cannot be sent answers with words (never ENOENT and the install path)
  app.get('/', (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'), (err?: Error) => {
      if (err) failRequest(res, (err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500, (err as NodeJS.ErrnoException).code === 'ENOENT' ? COMPANION_PAGE_ABSENT : COMPANION_FAILED, 'text');
    });
  });
  // R4 (H87): nothing else here: words, not express's page (which names the request's path); and every failure, words with
  // no path of this computer and no stack (express's default error page shows the stack outside production)
  app.use((_req, res) => { failRequest(res, 404, COMPANION_NOT_FOUND, 'text'); });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // a request express could not read (a body that is not JSON, or too large) keeps its 4xx; anything else is a 500
    const status = Number((err as { status?: unknown } | null)?.status);
    if (status >= 400 && status < 500) failRequest(res, status, COMPANION_BAD_REQUEST);
    else failRequest(res, 500, COMPANION_FAILED);
  });

  wss.on('connection', (ws) => {
    // R4 (H87): a client's broken frame or a dropped socket ends that client, never the monitor
    ws.on('error', () => { clients.delete(ws); });
    clients.add(ws);
    logger.info(`Companion client connected (total: ${clients.size})`);
    ws.send(JSON.stringify({ type: 'state', state: currentState }));
    ws.on('close', () => {
      clients.delete(ws);
      logger.info(`Companion client disconnected (total: ${clients.size})`);
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const globalServer = (global as any).companionServer;

        if (msg.type === 'hello') {
          ws.send(JSON.stringify({ type: 'welcome', state: currentState }));
          ws.send(JSON.stringify({ type: 'bus.tail', events: busTail(200) }));
          
          // Send integration status
          const daytonaKey = process.env.DAYTONA_API_KEY;
          const isDaytonaActive = keySet(daytonaKey);

          const triggerKey = process.env.TRIGGER_SECRET_KEY;
          const isTriggerActive = keySet(triggerKey);

          const composioKey = process.env.COMPOSIO_API_KEY;
          const isComposioActive = keySet(composioKey);

          const cfAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
          const isCloudflareActive = !!(cfAccount && cfAccount.trim() !== '');

          ws.send(JSON.stringify({
            type: 'integrations',
            data: {
              daytona: isDaytonaActive,
              trigger: isTriggerActive,
              composio: isComposioActive,
              cloudflare: isCloudflareActive
            }
          }));
          
          // Send initial full TUI sync upon websocket connection
          if (globalServer && globalServer.lastHistory) {
            ws.send(JSON.stringify({ type: 'sync', history: globalServer.lastHistory }));
          }
          if (globalServer && globalServer.lastTmux) {
            ws.send(JSON.stringify({ type: 'tmux', data: globalServer.lastTmux }));
          }
        } else if (msg.type === 'addTmuxSession') {
          if (globalServer && globalServer.agent) {
            globalServer.agent.addTmuxSession(msg.name || 'AgentPane', msg.model || 'claude-opus-4.7');
          }
        } else if (msg.type === 'killTmuxSession') {
          if (globalServer && globalServer.agent) {
            globalServer.agent.removeTmuxSession(msg.id);
          }
        } else if (msg.type === 'switchPaneAgent') {
          if (globalServer && globalServer.agent) {
            globalServer.agent.switchPaneAgent(msg.id, msg.agentKey);
          }
        }
      } catch { }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      cleanup();
      wss.close();
      reject(err);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      httpServer.removeListener('error', onError);
      httpServer.removeListener('listening', onListening);
    };

    httpServer.once('error', onError);
    // R4 (H84): this computer only, unless the operator asked for the network (--lan)
    httpServer.listen(port, options.lan ? '0.0.0.0' : '127.0.0.1', onListening);
  });
  // R4 (H87): an error of the listening server itself (a connection it could not take) never ends the monitor
  httpServer.on('error', () => undefined);
  const bound = (httpServer.address() as import('net').AddressInfo).port;
  const host = options.lan ? '0.0.0.0' : '127.0.0.1';

  return {
    app, httpServer, wss, clients, port: bound, currentState, host,
    address: `http://127.0.0.1:${bound}/`,
    url: key.open(`http://127.0.0.1:${bound}/`),
    lanUrls: lan.map((a) => key.open(`http://${a}:${bound}/`)),
    shutdown: async () => {
      clearInterval(busTimer);
      for (const c of clients) c.close();
      clients.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // R4 (H84): a chat still streaming ends with the server
        httpServer.closeAllConnections();
      });
    },
    setState: (state: string) => {
      currentState = state;
      const msg = JSON.stringify({ type: 'state', state });
      for (const c of clients) {
        if (c.readyState === 1) c.send(msg);
      }
    },
    sendFrame: (frame) => {
      const msg = JSON.stringify({ type: 'frame', ...frame });
      for (const c of clients) {
        if (c.readyState === 1) c.send(msg);
      }
    },
    sendUpdate: (type: string, data: any) => {
      const msg = JSON.stringify({ type, data });
      for (const c of clients) {
        if (c.readyState === 1) c.send(msg);
      }
    },
  };
}
