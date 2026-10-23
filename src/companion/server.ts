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
 *   GET /web/island/*, /web/styles/*,      nothing more                      the page's built chat (Streamdown), its styles and its
 *       /web/fonts/*                                                         fonts (R4 H95: src/companion/web-assets.ts); no content
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
 *
 * R4 (H92): the page loads nothing from the internet (r23c: about 1,130 requests to public CDNs, whose code ran with the
 * page's token). Its scripts, style sheets and fonts are all this server's (src/companion/page.ts; R4 H97: the files of
 * H92's page that H95's replaced, its chat and markdown scripts, Timmy's theme, Monaspace's files and marked, are gone),
 * and every answer carries the page's Content-Security-Policy: scripts and style sheets only from here, no inline script,
 * handler or style, requests only to here and its own WebSocket, no plugins, no <base>, never framed by another page.
 *
 * R4 (H104): the page's CHAT MIRROR (r24: empty, with nothing saying why) shows this session's chat as this socket carries
 * it: this monitor's own (`sync`, `agent:delta`, from src/tui/hooks/useCompanionSync.ts) with its words, and each REPL turn
 * as the bus carries it (`receipt.sealed` of kind `turn`: its receipt and step count only; the REPL seals a turn's prompt
 * and answer as hashes, so its words are never on the bus). The welcome says when this companion started (`since`).
 * R4 (H113): every surface's turn of the project, not the REPL's alone: the terminal Workbench's, a monitor's and a companion
 * page's turns are the one turn implementation too, sealed into the project (kind `chat`, their subject naming the surface:
 * src/repl/seal.ts), and the page labels each with its surface, its receipt and its steps.
 *
 * R4 (H104, second part; the operator's direction of 2026-10-11: one project, three connected workspaces):
 *  - the PROJECT: each page shows one (the welcome and `project` messages: its name, its folder from ~, following, pinned or
 *    fixed; src/companion/project.ts): the active project (<TIMMY_HOME>/state/active-project.json), followed when it changes,
 *    unless the page pinned it ({type:'pin'} / {type:'unpin'}; a reloaded page names its pin in its hello); TIMMY_REPO fixes
 *    the folder instead. The bus tail, its live events and the receipts a page reads are that project's folder's;
 *  - the CHAT's route (GET /api/chat/route, POST /chat): the setup's (src/companion/chat-route.ts): the local model through
 *    the recorded Ollama with no tools, OpenRouter with a key as before, or none, and then Send is off, saying why;
 *  - a RUN DETAIL by operation id: GET /run/<id> is the page with that run's detail open, GET /api/run/<id> (the token) is
 *    src/contracts/run-detail.ts's RunDetail from its producer (src/companion/run-detail.ts);
 *  - the page's icon (r25's D11), the companion's own SVG (src/companion/favicon.ts).
 *
 *   route                                  requires                          why
 *   GET /run/<operation id>                nothing more                      the page (as GET /), its RUN DETAIL tab on that id
 *   GET /api/chat/route                    the token                         the chat's route in words (never a key)
 *   GET /api/run/<operation id>            the token                         the operator's records, as a run detail
 *   GET /api/newest-run-image              the token                         R7 H152: the newest run that holds an image
 *
 * R5 (H132, the operator's completion order of 2026-10-15: one project workspace across the terminal, the companion and
 * Studio): the page draws the workspace frame every surface shares (src/contracts/workspace.ts, made only by
 * src/ops/workspace-frame.ts) around its own content, and may change the two start-up settings the terminal Workbench keeps
 * (src/companion/workspace.ts says what each answer is). Timmy's shared look is served beside the page (src/companion/page.ts).
 *
 *   route                                  requires                          why
 *   GET /api/workspace                     the token                         the frame of the project the page shows: the
 *                                                                            operator's records (projects, jobs, connections)
 *   POST /api/workspace/prefs              the token                         writes the Workbench's settings file, checked
 *                                                                            against the frame's revision (409 when stale)
 *   POST /api/chat/stop                    the token                         R5 lead: asks the process answering the chat
 *                                                                            turn {turn: <id>} of the shown project to stop
 *                                                                            it (409 when that turn is not running now)
 *   GET /timmy-theme.css,                  nothing more                      Timmy's look and Monaspace Argon: no content
 *       /web/fonts/monaspace-argon-*
 *
 * R10 (H164): the journey's data (src/journey/routes.ts), read only, for the shown project, so the page draws what the
 * terminal Workbench draws, from the same functions:
 *
 *   route                                  requires                          why
 *   GET /api/journey/route                 the token                         the route the next chat turn takes (never a key)
 *   GET /api/journey/recent                the token                         the project's newest work, where each opens
 *   GET /api/journey/run/<operation id>    the token                         a run's progress, result and receipt
 *   GET /api/journey/open                  the token                         what the page's address asks for, what is shown
 *                                                                            for it, and a notice when that differs
 *   GET /api/journey/file                  the token                         a project file for the preview: an image (data URL,
 *                                                                            its size in pixels) or a text's first 64 KB
 *
 * R10 CHAT (H171; the operator's order of 2026-10-22: ONE main Chat screen): the Chat composition's data, read only, for the
 * shown project (src/companion/chat-view.ts):
 *
 *   route                                  requires                          why
 *   GET /api/chat/view                     the token                         the project's saved conversation, each answer's
 *                                                                            model from its receipt; this page's route; the
 *                                                                            providers' states; where the logs are
 *   GET /api/chat/models                   the token                         one source's model rows, sorted and filtered
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
// R4 (H92): the page's policy; R4 (H95): its built web code (/web/), served from here.
import { companionHeaders, mountTheme, mountWebAssets, sendSlateAbsent } from './page.js';
// R4 (H104): the page's icon (r25's D11)
import { FAVICON_PATHS, faviconSvg } from './favicon.js';
// R4 (H104, second part): the project a page shows, the chat's route, a run detail by operation id
import { projectId, type ActiveProject } from '../project/index.js';
import { busFilesOf, ProjectFollower, type ProjectMode } from './project.js';
import { openRouterKey, pageRoute, streamLocalChat } from './chat-route.js';
import { OPERATION_ID, runDetailAnswer, type RunDetailProducer } from './run-detail.js';
// R5 (H132): the workspace frame every surface draws, and the page's two start-up settings
import { CompanionWorkspace, type WorkspaceDeps } from './workspace.js';
import { mountPanels } from './panels.js';
// R10 (H164): the journey's read-only routes (src/journey/routes.ts)
import { mountJourneyRoutes } from '../journey/routes.js';
// R10 CHAT (H171): the Chat composition's read-only routes (src/companion/chat-view.ts)
import { mountChatView } from './chat-view.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// R11 (H169, Phase 0 item 2): the /chat proxy's OpenRouter model is the route's (pageRoute: the model chosen in the settings,
// the same the Workbench's Models chose); with none chosen the route is not ready and nothing is sent. No fixed model here.
/** Where /chat sends its completion unless a test gives a FAKE (CompanionOptions.upstream). */
const OPENROUTER_CHAT = 'https://openrouter.ai/api/v1/chat/completions';

/** R4 (H84): the subprotocol the server selects (a page offers it beside its token). */
export const COMPANION_PROTOCOL = 'timmy-companion';
/** R4 (H84): what a request without the token is told. */
export const COMPANION_REFUSED = 'Refused: this needs the browser companion\'s token. Open the companion from Timmy: in the Workbench (`timmy workbench`), press c; or in `timmy watch`, press q on HOME, which shows the companion\'s address with its token (after #, which the page keeps in memory and sends in a header).';
/**
 * R4 (H87): the files this server serves beside its code at run time, package-relative: every file of its client folder
 * (served as they are). The build copies each into dist/ (scripts/copy-runtime-assets.mjs RUNTIME_ASSETS);
 * tests/runtime-pages.test.ts keeps the lists together, so a new page cannot be left out of the package.
 * R4 (H92): the page and the files it needs (its scripts and style sheet were inline, or from CDNs).
 */
// R6 lead: the tab panels' page code (panels.js, the registry; panel-studio.js, panel-vox.js and panel-tools.js, each panel's own drawing)
// R6 (H144): panel-run.js, the Workflows tab's run detail
// R10 CHAT (H171): chat-shell.js and chat-shell.css, the shell's left menu and the Chat composition
const CLIENT_FILES = ['index.html', 'companion.css', 'companion.js', 'panels.js', 'panel-studio.js', 'panel-vox.js', 'panel-tools.js', 'panel-run.js', 'panel-create.js', 'panel-control.js', 'chat-shell.js', 'chat-shell.css'] as const;
export const COMPANION_RUNTIME_FILES: readonly string[] = Object.freeze(CLIENT_FILES.map((f) => `src/companion/client/${f}`));
/** R4 (H87): the words a failure answers with (never a path of this computer, never a stack). */
export const COMPANION_FAILED = 'The browser companion could not read what this request needs, so it answers with nothing and wrote nothing. It is still running.';
export const COMPANION_PAGE_ABSENT = 'The browser companion\'s page is missing from this installation (its file was not shipped), so there is nothing to show here. Reinstall Timmy; `timmy logs` has pages of its own.';
export const COMPANION_NOT_FOUND = 'The browser companion has nothing at this address.';
export const COMPANION_BAD_REQUEST = 'The browser companion could not read this request (its body is not the JSON it expects, or is too large); nothing was done.';
export const SLATE3D_ABSENT = 'Slate 3D is not part of this installation: its built bundle (companion/slate3d) ships only in a source checkout that has built it. Everything else in the browser companion works without it.';
export const COMPANION_FOREIGN = 'Refused: the browser companion answers only to this computer (127.0.0.1 or localhost), or with --lan to this computer\'s own network address, and only from its own pages.';
/** R4 (H104, second part): what a page that names a project the companion does not know is told. */
export const PROJECT_UNKNOWN = 'This page\'s project is not one this companion knows (it knows the active project, the projects under the Timmy home and the ones its pages have shown), so nothing was read.';
/** R4 (H104, second part): a pin where TIMMY_REPO fixed the folder. */
export const PIN_FIXED = 'This companion\'s folder is fixed by TIMMY_REPO (set when it started): it follows no project, so a pin changes nothing.';
/** R4 (H104, second part): a reloaded page's pin the companion cannot keep. */
export const PIN_UNKNOWN = 'The project this page had pinned is not one this companion knows (moved or removed, or this companion was started again), so this page follows the active project.';

export interface CompanionOptions {
  /** R4 (H84): also listen on this computer's networks (`timmy watch --lan`): plain HTTP; every route but the page needs the token. */
  lan?: boolean;
  /** R4 (H84): the token (64 hex), a test's or a lane's; made at random when absent. */
  token?: string;
  /** R4 (H84): the chat completions address /chat sends to (a test's FAKE on 127.0.0.1); OpenRouter's when absent. */
  upstream?: string;
  /** R4 (H87): the folder its page is served from (a test's); its own client folder when absent. */
  clientDir?: string;
  /**
   * R4 (H95): the folder of the built web code its page serves at /web/ (a test's); the package's own build when absent
   * (dist/companion-web; a source checkout builds it on the first request: src/companion/web-assets.ts).
   */
  webDir?: string;
  /**
   * R4 (H104, second part): the environment the chat's route and its key are read from (a test's, so that nothing of this
   * computer's is): with it, no .env file is read and nothing is set in this process's environment. process.env when absent.
   */
  chatEnv?: Record<string, string | undefined>;
  /**
   * R4 (H104, second part): the run-detail producer GET /api/run/<id> asks (a test's FIXTURE); this revision's
   * src/ops/run-detail.ts when absent, and words saying there is none where it is not built yet.
   */
  runDetail?: RunDetailProducer;
  /**
   * R5 (H132): what GET /api/workspace and POST /api/workspace/prefs read and write with (src/companion/workspace.ts): a test's
   * environment (its TIMMY_HOME and TIMMY_SETTINGS_DIR), a FAKE frame producer, or a settings saver that fails; this
   * process's environment, src/ops/workspace-frame.ts and src/workbench/settings.ts when absent.
   */
  workspace?: WorkspaceDeps;
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
  // R4 (H104): when this companion started: its session. The page's chat mirror shows only this session's chat (the bus
  // tail it is sent on connecting reaches back six hours), and its empty state says since when none has come.
  const startedAt = new Date().toISOString();
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
  // R4 (H92): every answer with the page's Content-Security-Policy (Slate 3D's paths with their own; src/companion/page.ts)
  app.use(companionHeaders);
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

  // Event-bus tail → each page as {type:'bus', event}. The bus lives in the
  // project's folder, never in a worktree copy. Two files are tailed: the one
  // bus (event envelopes appended beside the receipts in .timmy/receipts/runs.jsonl,
  // src/bus) and the legacy .timmy/runs/timmy-events.jsonl that older writers
  // still use. Receipt records are skipped; only event envelopes pass. Whole
  // lines only; a partial append waits for its newline.
  // R4 (H104, second part): the folder is the project the page shows (src/companion/project.ts): the active project,
  // followed when its record changes, unless the page pinned one; TIMMY_REPO, when it is set as this companion starts,
  // fixes the folder for every page (it was the one folder before). Each page's own view: the project it shows, whether it
  // pinned it, and whether it said hello (the welcome and the tail are sent then). Every folder a page shows is tailed.
  interface PageView { project: ActiveProject; pinned: boolean; hello: boolean }
  const views = new Map<import('ws').WebSocket, PageView>();
  const follower = new ProjectFollower({ cwd: process.cwd(), fixed: process.env.TIMMY_REPO || null, onChange: (p) => followed(p) });
  const isBusEvent = (o: any): boolean =>
    Boolean(o && typeof o.kind === 'string' && o.payload && typeof o.payload === 'object' && o.ts && !o.hash && !o.sig);
  const parseBusLines = (text: string): any[] =>
    text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(isBusEvent);
  // The tail a new client gets: everything from the last six hours across both
  // files (so a burst on one file cannot hide a seal on the other), and never
  // fewer than n events. The viewer fades pods by age, so history reads as glow.
  const BUS_WINDOW_MS = 6 * 60 * 60 * 1000;
  const busTail = (root: string, n: number): any[] => {
    const all: any[] = [];
    for (const f of busFilesOf(root)) { try { all.push(...parseBusLines(fs.readFileSync(f, 'utf8')).slice(-2000)); } catch { /* no file yet */ } }
    all.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const since = Date.now() - BUS_WINDOW_MS;
    const recent = all.filter((e) => Date.parse(e.ts) >= since);
    return recent.length >= n ? recent : all.slice(-n);
  };
  // how far each shown folder's two files have been read (bytes), by folder; a folder starts at its files' ends
  const tails = new Map<string, number[]>();
  const sizeOf = (f: string): number => { try { return fs.statSync(f).size; } catch { return 0; } };
  const tailFrom = (root: string): void => { if (!tails.has(root)) tails.set(root, busFilesOf(root).map(sizeOf)); };
  tailFrom(follower.current().root);
  const busTimer = setInterval(() => {
    const shown = new Set([...views.values()].map((v) => v.project.root));
    for (const root of [...tails.keys()]) if (!shown.has(root) && root !== follower.current().root) tails.delete(root);
    for (const root of shown) {
      const busOffsets = tails.get(root);
      if (!busOffsets) { tailFrom(root); continue; }
      busFilesOf(root).forEach((f, i) => {
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
          // R5 lead (the final QA of a77d80d, defect 1): a sealed receipt changes the frame (a turn's end, a run's): the frame
          // shared between reads is let go first, so a page that reads it again on this event is given the frame after it
          if (event.kind === 'receipt.sealed') workspace.forget(root);
          const msg = JSON.stringify({ type: 'bus', event });
          for (const [c, v] of views) if (v.project.root === root && c.readyState === 1) c.send(msg);
        }
      });
    }
  }, 500);
  busTimer.unref();
  // R4 (H104, second part): what a page is told of the project it shows, and a page moved to another project (its project,
  // then that folder's tail); a page that has not said hello yet is told in its welcome.
  const sendTo = (ws: import('ws').WebSocket, msg: unknown): void => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const modeOf = (v: PageView): ProjectMode => (follower.fixed ? 'fixed' : v.pinned ? 'pinned' : 'following');
  const showProject = (ws: import('ws').WebSocket, v: PageView, reason: string, note?: string): void => {
    if (v.hello) sendTo(ws, { type: 'project', reason, project: follower.view(v.project, modeOf(v), note) });
  };
  const moveTo = (ws: import('ws').WebSocket, v: PageView, p: ActiveProject, reason: string): void => {
    v.project = p;
    tailFrom(p.root);
    if (!v.hello) return;
    showProject(ws, v, reason);
    sendTo(ws, { type: 'bus.tail', events: busTail(p.root, 200), project: projectId(p.root) });
  };
  // the active project changed: every following page moves to it; a pinned page stays, and is told what is active now
  function followed(p: ActiveProject): void {
    for (const [ws, v] of views) {
      if (v.pinned) showProject(ws, v, 'active');
      else moveTo(ws, v, p, 'followed');
    }
  }
  /** The project a request is about: the one its page names (?project=<id>), else the one followed; null when unknown. */
  const projectFor = (req: express.Request): ActiveProject | null => {
    const asked = req.query.project;
    if (asked === undefined) return follower.current();
    return typeof asked === 'string' ? follower.find(asked) : null;
  };
  let currentState = 'idle';

  // Serve static client files
  const clientDir = options.clientDir ?? path.join(__dirname, 'client');
  // R5 (H132): Timmy's shared look (DESIGN.md §10 B10): the theme's variables and Monaspace Argon's files, at /web/fonts/
  // before the built web code's own (src/companion/page.ts)
  mountTheme(app);
  // R4 (H95): the page's built chat (Streamdown), its styles and its three fonts, from this computer (/web/)
  mountWebAssets(app, options.webDir);
  // R4 (H104, r25's D11): the page's icon, this server's own (the page declared none, so the browser's /favicon.ico was a 404)
  const favicon = faviconSvg();
  app.get([...FAVICON_PATHS], (_req, res) => {
    res.set('Cache-Control', 'public, max-age=86400').type('image/svg+xml').send(favicon);
  });
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
    // R4 (H92): the words as a page in Timmy's look (they were plain text, drawn black on the companion's dark frame)
    app.get(['/slate3d', '/slate3d/', '/slate3d/index.html'], (_req, res) => { sendSlateAbsent(res, SLATE3D_ABSENT); });
  }

  // Receipts for Slate 3D capsule state: receipt records (never the event
  // envelopes) from the pinned root store, filtered by subject, newest first,
  // with their sources (the seal metadata, e.g. an order id). Read-only.
  // R4 (H104, second part): the shown project's (?project=<id>, else the one followed).
  app.get('/slate3d/receipts', withToken, (req, res) => {
    const subject = String(req.query.subject ?? '');
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit ?? 400)));
    const project = projectFor(req);
    if (!project) { res.status(404).json({ ok: false, error: PROJECT_UNKNOWN }); return; }
    const store = path.join(project.root, '.timmy', 'receipts', 'runs.jsonl');
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
    // R4 (H104, second part): the act goes on the bus of the project the page shows
    const project = projectFor(req);
    if (!project) { res.status(404).json({ ok: false, error: PROJECT_UNKNOWN }); return; }
    const busRoot = project.root;
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
      const p = fs.existsSync(oneBus) && fs.existsSync(path.join(busRoot, 'src', 'bus', 'index.ts')) ? oneBus : busFilesOf(busRoot)[1];
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
  // R6 lead: the board of the project the page shows (?project=<id>, else the one followed): each project has its own (H139)
  app.get('/api/canvas', withToken, (req, res) => {
    const project = projectFor(req);
    if (!project) { res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: PROJECT_UNKNOWN }); return; }
    res.set('Cache-Control', 'no-store').json({ ...canvasSummary(process.env, project.root), project: project.name });
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
   * R4 (H104, second part): the environment the chat's route and key are read from: a test's (CompanionOptions.chatEnv), or
   * this process's, with the .env files it always read loaded first (never over a variable already set).
   */
  const chatEnv = (): Record<string, string | undefined> => {
    if (options.chatEnv) return options.chatEnv;
    ensureOpenRouterApiKey();
    return process.env;
  };
  // R4 (H104, second part): the chat's route, as the page shows it beside Send (src/companion/chat-route.ts; never a key)
  app.get('/api/chat/route', withToken, (_req, res) => {
    res.set('Cache-Control', 'no-store').json(pageRoute(chatEnv(), process.cwd()));
  });

  /**
   * POST /chat — TMX P3 streaming chat proxy.
   * Accepts JSON { message: string } or { messages: [{ role, content }] },
   * proxies a streaming OpenRouter chat completion (the model chosen in the settings: pageRoute; none chosen, nothing is sent)
   * and relays it to the browser as Server-Sent Events:
   *   event: delta  — JSON-encoded text chunk
   *   event: usage  — token usage object (when OpenRouter reports it)
   *   event: error  — { error, details? }
   *   event: done   — { ok: true }
   * R4 (H84): it spends the operator's credits, so only with the token (checked before the body is read or a key is
   * looked for); the completion goes to `chatUrl`: OpenRouter, or a test's FAKE (CompanionOptions.upstream).
   * R4 (H104, second part): on the route the setup chose, read at each request (src/companion/chat-route.ts), said first
   * (event: route {kind, label}): the local model streams from the recorded Ollama with no tools (event: notice, what the
   * turn says beside its answer; event: cost, none on this computer's Ollama or unknown with why), never OpenRouter; OpenRouter
   * with its key as before (the key where the REPL finds it); with no route, an error in words and nothing is sent anywhere.
   */
  app.post('/chat', withToken, express.json(), async (req, res) => {
    const env = chatEnv();
    // R11 (H169, Phase 0 item 2; the operator's order: "disable an unsafe Send path rather than using an unchosen model"): the
    // route names the model chosen in the settings, or is none (nothing is sent)
    const route = pageRoute(env, process.cwd());

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

    // R4 (H104, second part): the route first; with none, its words and nothing sent anywhere
    sendSse('route', { kind: route.kind, label: route.label });
    if (!route.ready) {
      sendSse('error', { error: route.words, route: route.kind });
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

    // R4 (H104, second part): the local route: the recorded Ollama, no tools, never OpenRouter
    if (route.kind === 'local') {
      await streamLocalChat({ route, messages: chatMessages, signal: controller.signal, send: sendSse });
      try { if (!res.writableEnded) res.end(); } catch { /* socket already gone */ }
      return;
    }
    // the OpenRouter route: its key where the REPL finds it (pageRoute found one a moment ago)
    const apiKey = openRouterKey(env, process.cwd())?.key;
    if (!apiKey) {
      sendSse('error', { error: 'No OpenRouter key is set any more, so nothing was sent. `timmy init` keeps one.', route: 'openrouter' });
      res.end();
      return;
    }

    try {
      const upstream = await fetch(chatUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: route.model, messages: chatMessages, stream: true }),
        signal: controller.signal,
      });

      if (!upstream.ok || !upstream.body) {
        const details = await upstream.text().catch(() => '');
        sendSse('error', {
          error: `OpenRouter responded ${upstream.status} for model ${route.model}`,
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

  // R4 (H104, second part): one operation's run detail by its id (src/companion/run-detail.ts), from the producer, for the
  // project the page shows (?project=<id>, else the one followed)
  app.get('/api/run/:op', withToken, async (req, res) => {
    const project = projectFor(req);
    if (!project) { res.set('Cache-Control', 'no-store').json({ ok: false, reason: 'project', error: PROJECT_UNKNOWN }); return; }
    const answer = await runDetailAnswer(String(req.params.op), project.root, options.runDetail);
    res.status(answer.status).set('Cache-Control', 'no-store').json(answer.body);
  });

  // R7 (H152; the R6 interaction review's N9): Home's newest run image, the newest run of the shown project's records that holds
  // one, whatever ran after it (src/companion/home-images.ts), asked of the same producer as the run detail
  app.get('/api/newest-run-image', withToken, async (req, res) => {
    const project = projectFor(req);
    if (!project) { res.set('Cache-Control', 'no-store').json({ ok: false, error: PROJECT_UNKNOWN }); return; }
    const { newestRunImage } = await import('./home-images.js');
    res.set('Cache-Control', 'no-store').json(await newestRunImage(project.root, options.runDetail));
  });

  // R5 (H132): the workspace frame of the project the page shows (?project=<id>, else the one followed), and the two start-up
  // settings it may change (src/companion/workspace.ts: 409 with the newer frame when the page's revision is stale)
  const workspace = new CompanionWorkspace(options.workspace);
  // R5 lead (the QA round, defect 4): this companion answering its page is an answer observed now, as Studio notes its own
  // (src/studio/server.ts): the frame then says the companion answered, not "not running" from an older check. Only for the
  // companion the frame names (its address, src/ops/workspace-frame.ts companionBaseUrl); at most once in SELF_NOTE_MS.
  // It notes that it started and that it stopped, too (noteStopped), so no surface says it answered after it ended.
  let selfPort: number | null = null;
  const noteSelf = async (what: 'started' | 'asked' | 'stopped'): Promise<void> => {
    const env = options.workspace?.env ?? process.env;
    try {
      const { companionBaseUrl, noteAnswered, noteStopped } = await import('../ops/workspace-frame.js');
      if (selfPort === null || companionBaseUrl(env) !== `http://127.0.0.1:${selfPort}/`) return;
      if (what === 'stopped') noteStopped('companion', env);
      else noteAnswered('companion', what === 'started' ? 'it started listening' : 'its page asked for its frame', env);
    } catch { /* the record cannot be written: the frame says what the last check saw */ }
  };
  app.get('/api/workspace', withToken, async (req, res) => {
    const project = projectFor(req);
    if (!project) { res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: PROJECT_UNKNOWN }); return; }
    await noteSelf('asked');
    const answer = await workspace.answerFrame(project);
    res.status(answer.status).set('Cache-Control', 'no-store').json(answer.body);
  });
  // R5 lead (the operator's 22:32 order, item 2): the page's Stop for the chat turn being answered in the project it shows,
  // whichever surface sent it. It asks the process that holds the turn (src/agent/chat-turn.ts requestTurnStop), which stops
  // it as its own Esc or Ctrl+C would; the turn is named by its id (the frame's activity.chatTurn.id), so the page stops the
  // turn it shows and never another. 200 {ok, words}; 400 for a body that names no turn; 409 when that turn is not being
  // answered now (it ended, or its process did). The token first, as every content route.
  app.post('/api/chat/stop', withToken, express.json({ limit: '1kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const project = projectFor(req);
    if (!project) { res.status(404).json({ ok: false, error: PROJECT_UNKNOWN }); return; }
    const { requestTurnStop, surfaceWords, TURN_ID } = await import('../agent/chat-turn.js');
    const id = req.body && typeof req.body === 'object' ? (req.body as { turn?: unknown }).turn : undefined;
    if (typeof id !== 'string' || !TURN_ID.test(id)) { res.status(400).json({ ok: false, error: 'Not stopped: the request names no chat turn ({turn: <its id>, as the frame gives it}).' }); return; }
    const r = requestTurnStop(project.root, id, 'companion');
    if (!r.ok) { res.status(409).json({ ok: false, error: `Not stopped: ${r.why}.` }); return; }
    res.json({ ok: true, words: `Stop asked of the turn being answered in ${surfaceWords(r.surface)}: it stops there at once, and its receipt says it was stopped, asked from this page.` });
  });
  app.post('/api/workspace/prefs', withToken, express.json({ limit: '4kb' }), async (req, res) => {
    const project = projectFor(req);
    if (!project) { res.status(404).set('Cache-Control', 'no-store').json({ error: PROJECT_UNKNOWN }); return; }
    const answer = await workspace.answerPrefs(project, req.body);
    res.status(answer.status).set('Cache-Control', 'no-store').json(answer.body);
  });

  // R6 lead: the tab panels' own routes (/api/panel/<tab>/…, src/companion/panels.ts), token-checked, for the shown project
  mountPanels(app, { withToken, projectFor, projectUnknown: PROJECT_UNKNOWN, env: options.workspace?.env ?? process.env, frame: (p) => workspace.frame(p) });
  // R10 (H164): the journey's routes (/api/journey/…), token-checked, for the shown project; the route of the page's own Send
  // read from the environment its /chat reads
  mountJourneyRoutes(app, { withToken, projectFor, projectUnknown: PROJECT_UNKNOWN, chatEnv, env: options.workspace?.env ?? process.env });
  // R10 CHAT (H171): the Chat's saved conversation, its route, the providers' states and the models (/api/chat/view, /models)
  mountChatView(app, { withToken, json: express.json({ limit: '2kb' }), projectFor, projectUnknown: PROJECT_UNKNOWN, chatEnv, env: options.workspace?.env ?? process.env });

  // Serve the built client (if using vite)
  // R4 (H87): a page that cannot be sent answers with words (never ENOENT and the install path)
  const sendPage = (res: express.Response): void => {
    res.sendFile(path.join(clientDir, 'index.html'), (err?: Error) => {
      if (err) failRequest(res, (err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500, (err as NodeJS.ErrnoException).code === 'ENOENT' ? COMPANION_PAGE_ABSENT : COMPANION_FAILED, 'text');
    });
  };
  app.get('/', (_req, res) => { sendPage(res); });
  // R4 (H104, second part): the address another surface links a run detail with (the terminal Workbench's Activity, a Timmy
  // Studio card): the page, its RUN DETAIL tab open on that id. It carries no token: Timmy's address for the page gives it.
  app.get('/run/:op', (req, res) => {
    if (OPERATION_ID.test(String(req.params.op))) { sendPage(res); return; }
    failRequest(res, 404, `${COMPANION_NOT_FOUND} A run detail's address is /run/<operation id>, an operation id being o and 8 hex digits.`, 'text');
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
    ws.on('error', () => { clients.delete(ws); views.delete(ws); });
    clients.add(ws);
    // R4 (H104, second part): a page shows the followed project until it says otherwise (a pin, in its hello or later)
    views.set(ws, { project: follower.current(), pinned: false, hello: false });
    logger.info(`Companion client connected (total: ${clients.size})`);
    ws.send(JSON.stringify({ type: 'state', state: currentState }));
    ws.on('close', () => {
      clients.delete(ws);
      views.delete(ws);
      logger.info(`Companion client disconnected (total: ${clients.size})`);
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const globalServer = (global as any).companionServer;
        const view = views.get(ws);

        if (msg.type === 'hello') {
          // R4 (H104, second part): a reloaded page names the project it had pinned (its id); kept when this companion knows it
          let note: string | undefined;
          if (view) {
            view.hello = true;
            if (typeof msg.pin === 'string' && msg.pin) {
              const pinned = follower.fixed ? null : follower.find(msg.pin);
              if (pinned) { view.project = pinned; view.pinned = true; } else note = follower.fixed ? PIN_FIXED : PIN_UNKNOWN;
            }
            tailFrom(view.project.root);
          }
          const root = view?.project.root ?? follower.current().root;
          // R4 (H104): `since`, this companion's start, before the bus tail (the page cuts the tail to this session with it).
          // R4 (H104, second part): the project the page shows, and the tail of that project's folder.
          ws.send(JSON.stringify({ type: 'welcome', state: currentState, since: startedAt, ...(view ? { project: follower.view(view.project, modeOf(view), note) } : {}) }));
          ws.send(JSON.stringify({ type: 'bus.tail', events: busTail(root, 200), project: projectId(root) }));
          
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
        } else if (msg.type === 'pin' && view) {
          // R4 (H104, second part): this page keeps the project it shows (`id`: the one it showed when the pin was pressed)
          if (follower.fixed) showProject(ws, view, 'pinned', PIN_FIXED);
          else {
            const asked = typeof msg.id === 'string' ? follower.find(msg.id) : null;
            view.pinned = true;
            if (asked && asked.root !== view.project.root) moveTo(ws, view, asked, 'pinned');
            else showProject(ws, view, 'pinned');
          }
        } else if (msg.type === 'unpin' && view) {
          // R4 (H104, second part): this page follows the active project again
          view.pinned = false;
          const now = follower.current();
          if (now.root !== view.project.root || now.name !== view.project.name) moveTo(ws, view, now, 'unpinned');
          else showProject(ws, view, 'unpinned');
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
      // R4 (H104, second part): nothing of this companion's keeps watching
      clearInterval(busTimer);
      follower.stop();
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
  selfPort = bound;
  await noteSelf('started');
  const host = options.lan ? '0.0.0.0' : '127.0.0.1';

  return {
    app, httpServer, wss, clients, port: bound, currentState, host,
    address: `http://127.0.0.1:${bound}/`,
    url: key.open(`http://127.0.0.1:${bound}/`),
    lanUrls: lan.map((a) => key.open(`http://${a}:${bound}/`)),
    shutdown: async () => {
      clearInterval(busTimer);
      follower.stop();
      for (const c of clients) c.close();
      clients.clear();
      views.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // R4 (H84): a chat still streaming ends with the server
        httpServer.closeAllConnections();
      });
      await noteSelf('stopped');
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
