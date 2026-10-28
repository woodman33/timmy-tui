/**
 * R12 (the operator's order of 2026-10-25, 03:04 PT: "spend the night coding the timmy tui into rive and tldraw dont stop until
 * its done"): the Timmy app — Timmy's main UI as a tldraw board of cards with the Rive faces (companion/timmy-app, bundled on
 * this machine by scripts/canvas/build-app.mjs) — served by the browser companion at /app, beside the companion's own page.
 *
 *   GET /app, /app/                the app's page (companion/timmy-app/index.html), under its own policy (appPolicy)
 *   GET /app/dist/<file>           its bundle (app.js, app.css), tldraw's own fonts, icons and translations, the license texts
 *   GET /api/app/config            { ok, tldrawVersion, licenseKey, built, principal, project: { name, root }, ollama } — the launch token first (the
 *                                  key is the operator's); the project is the one the request's principal works in (the operator's
 *                                  followed project, or a signed-in user's own), its root the one the Chat's turn names
 *
 * The app reads and acts through the companion's existing routes only (the Chat's /api/chat/*, the providers' /api/connections/*,
 * the Rive listing /api/rive/assets), with the same launch token in an Authorization header; it has no route of its own that
 * reads a project, sends a prompt or spends. Nothing here starts a model.
 *
 * The policy is the companion page's, with the two things tldraw needs: inline styles (tldraw positions its shapes and menus
 * with style attributes) and data:/blob: images and fonts (its icons are inlined; a pasted image is a blob). Scripts stay this
 * server's own ('self', plus 'wasm-unsafe-eval' for the Rive runtime's WebAssembly); requests only to this server and its own
 * WebSocket; no frames, plugins, <base> or form posts; no page may frame it.
 */
import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectId } from '../project/index.js';
import { boardDir } from '../studio/boards.js';
import { studioConfig } from '../studio/config.js';
import { CanvasDocuments, MAX_CANVAS_BYTES, canvasDir } from '../studio/document.js';
import { installSteps, SIZE_NOTE, STARTER_MODELS } from '../setup/ollama-local.js';
import { tildePath } from '../utils/home-scrub.js';

type Env = Record<string, string | undefined>;

/** Where the app's page and its bundle are: companion/timmy-app in a source checkout and in the installed package alike. */
export function appRoot(): string {
  const candidates = ['../../companion/timmy-app', '../../../companion/timmy-app'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
  return candidates.find(existsSync) ?? candidates[0];
}

/** The words where the bundle is not built (a source checkout before `npm run build:app`). */
export const APP_NOT_BUILT = 'The Timmy app is not built on this computer: run npm run build:app in the checkout (the installed package ships it built).';

const HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;

/** The app page's Content-Security-Policy (see the header). */
export function appPolicy(host: string | undefined): string {
  const socket = typeof host === 'string' && HOST.test(host) ? ` ws://${host}` : '';
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self'${socket}`,
    "worker-src 'self' blob:",
    // R13: the hosted mini-apps' gateways (src/companion/miniapps/host.ts), loopback only; nothing else may be framed
    "frame-src http://127.0.0.1:* http://localhost:*",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export interface TimmyAppDeps {
  /** the launch token's check (src/companion/server.ts withToken) */
  withToken: express.RequestHandler;
  /** the environment the tldraw license key is read from (TLDRAW_LICENSE_KEY), this process's when absent */
  env?: Env;
  /** the folder the page and its dist/ are served from (a test's); appRoot() when absent */
  root?: string;
  /** a signed-in user's session when the request carries one (src/companion/server.ts withUserOrOperator) */
  withUser?: express.RequestHandler;
  /** the project the request's principal works in (name and root; env: the principal's Timmy home), null when none is known */
  projectOf?: (req: express.Request) => { name: string; root: string; env?: Env } | null;
  /** the operator's environment (its Timmy home holds the operator's projects' desks): `env` when absent */
  storeEnv?: Env;
}

/** The folder, beside the project's Studio board, that holds the Timmy app's Canvas desk (its own revisions, never Studio's file). */
export const DESK_FOLDER = 'app-desk';
/** The Canvas desk of the project in folder `root`, in the Timmy home of `env`: <TIMMY_HOME>/canvas/projects/<project id>/app-desk/. */
export function deskOf(root: string, env: Env): CanvasDocuments {
  return new CanvasDocuments(join(boardDir(canvasDir(env), projectId(root)), DESK_FOLDER));
}
export const DESK_NO_PROJECT = 'No project is open for this page, so its Canvas desk has nowhere to be kept: open one in Timmy (`timmy app` in its folder).';

// ── the unified Workspace order (2026-10-27): several saved boards per project ──────────────────────────────────────────
//
// The project's first board is the desk it already had (app-desk/, id `desk`): nothing is moved or renamed on disk. Each
// further board is its own CanvasDocuments in app-boards/<id>/ (the same revisions, conflict copies and size limit), and
// app-boards/boards.json names them (and the desk's own name, once renamed). A new board starts blank.
export const BOARDS_FOLDER = 'app-boards';
export const FIRST_BOARD = 'desk';
export const BOARD_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_BOARDS = 64;
export interface BoardEntry { id: string; name: string; createdAt: string | null }
const boardsDirOf = (root: string, env: Env): string => join(boardDir(canvasDir(env), projectId(root)), BOARDS_FOLDER);
/** A board's name as the person typed it: one line, at most 80 characters; an empty one is refused. */
export function boardName(raw: unknown): string | null {
  const n = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return n ? n : null;
}
/** The project's boards, the desk first (named "Desk" until renamed), then the others in the order they were made. */
export function readBoards(root: string, env: Env): BoardEntry[] {
  let listed: BoardEntry[] = [];
  try {
    const f = JSON.parse(readFileSync(join(boardsDirOf(root, env), 'boards.json'), 'utf8')) as { boards?: unknown };
    if (Array.isArray(f.boards)) listed = f.boards.filter((b): b is BoardEntry => Boolean(b) && typeof (b as BoardEntry).id === 'string' && BOARD_ID.test((b as BoardEntry).id) && typeof (b as BoardEntry).name === 'string');
  } catch { listed = []; }
  const desk = listed.find((b) => b.id === FIRST_BOARD);
  return [{ id: FIRST_BOARD, name: desk ? desk.name : 'Desk', createdAt: desk ? desk.createdAt : null }, ...listed.filter((b) => b.id !== FIRST_BOARD)];
}
function writeBoards(root: string, env: Env, boards: BoardEntry[]): void {
  const dir = boardsDirOf(root, env);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `boards.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify({ schema: 'timmy.app-boards/1', boards }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, join(dir, 'boards.json'));
}
/** One board's documents: the desk's own folder for `desk`, app-boards/<id>/ for another; null for an id the project has not. */
export function boardDocsOf(root: string, env: Env, id: string): CanvasDocuments | null {
  if (id === FIRST_BOARD) return deskOf(root, env);
  if (!BOARD_ID.test(id) || !readBoards(root, env).some((b) => b.id === id)) return null;
  return new CanvasDocuments(join(boardsDirOf(root, env), id));
}
/** A new board, blank: its id from its name (made unique), recorded after the others. */
export function createBoard(root: string, env: Env, name: string, now = new Date()): BoardEntry | { error: string } {
  const boards = readBoards(root, env);
  if (boards.length >= MAX_BOARDS) return { error: `A project keeps at most ${MAX_BOARDS} boards.` };
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'board';
  let n = base === FIRST_BOARD ? 2 : 1;
  let id = n === 1 ? base : `${base}-${n}`;
  while (boards.some((b) => b.id === id)) { n += 1; id = `${base}-${n}`.slice(0, 40); }
  const entry: BoardEntry = { id, name, createdAt: now.toISOString() };
  writeBoards(root, env, [...boards.filter((b) => b.id !== FIRST_BOARD || b.createdAt !== null || b.name !== 'Desk'), entry]);
  return entry;
}
/** Renames a board (its id, folder and saved work stay as they are). */
export function renameBoard(root: string, env: Env, id: string, name: string): BoardEntry | null {
  const boards = readBoards(root, env);
  const b = boards.find((x) => x.id === id);
  if (!b) return null;
  const renamed = { ...b, name };
  writeBoards(root, env, boards.map((x) => (x.id === id ? renamed : x)));
  return renamed;
}

export function mountTimmyApp(app: express.Application, deps: TimmyAppDeps): { root: string } {
  const root = deps.root ?? appRoot();
  const dist = join(root, 'dist');
  const policy: express.RequestHandler = (req, res, next) => {
    res.setHeader('Content-Security-Policy', appPolicy(req.headers.host));
    next();
  };
  const page = (_req: express.Request, res: express.Response): void => {
    const file = join(root, 'index.html');
    if (!existsSync(file) || !existsSync(join(dist, 'app.js'))) { res.status(200).type('text/plain').set('Cache-Control', 'no-store').send(`${APP_NOT_BUILT}\n`); return; }
    res.set('Cache-Control', 'no-store').type('text/html').sendFile(file);
  };
  app.get(['/app', '/app/', '/app/index.html'], policy, page);
  app.use('/app/dist', policy, express.static(dist, { etag: true, index: false, fallthrough: true }));
  const guards = [deps.withToken, deps.withUser].filter((g): g is express.RequestHandler => typeof g === 'function');
  app.get('/api/app/config', ...guards, (req, res) => {
    const config = studioConfig(deps.env ?? process.env);
    const p = (() => { try { return deps.projectOf ? deps.projectOf(req) : null; } catch { return null; } })();
    // R12 (the finish brief's private-cache scope): who this page reads as, as a short one-way key (never the id itself): the
    // page keys what it keeps in its browser (the Canvas desk) by it, so two principals on one browser never share a desk
    const u = (req as express.Request & { user?: { id?: unknown; operator?: boolean } }).user;
    const principal = !u || u.operator ? 'operator' : `u-${createHash('sha256').update(`timmy-app:${String(u.id ?? '')}`).digest('hex').slice(0, 16)}`;
    res.set('Cache-Control', 'no-store').json({
      ok: true, tldrawVersion: config.tldrawVersion, licenseKey: config.licenseKey, built: existsSync(join(dist, 'app.js')),
      principal,
      // (root: only for the turn's request body; display: what the page shows, the home as ~)
      project: p ? { name: p.name, root: p.root, display: tildePath(p.root) } : null,
      // the local models' starters (what the Models card offers to download, each only after its size and the person's yes)
      // and how Ollama is installed and started on this computer's system (words and the official page; nothing is run)
      ollama: { starters: STARTER_MODELS.map(({ model, size, use, page, default: d }) => ({ model, size, use, page, default: d })), sizeNote: SIZE_NOTE, install: installSteps(process.platform) },
    });
  });
  // R12 (the operator's 2026-10-24 order: boards are kept in Timmy's project storage, never in the browser alone): the Canvas
  // desk of the request's principal's project — read (GET) and saved (POST, at a revision, only over the revision it was
  // opened at). A save that finds a newer desk saves nothing over it: the page's version is kept as a copy beside it.
  const projectFor = (req: express.Request): { root: string; env: Env; name: string } | null => {
    const p = (() => { try { return deps.projectOf ? deps.projectOf(req) : null; } catch { return null; } })();
    return p ? { root: p.root, env: p.env ?? deps.storeEnv ?? deps.env ?? process.env, name: p.name } : null;
  };
  /** The request's board (?board=<id>, the desk when absent) of its principal's project; `missing` when the project has no such board. */
  const deskFor = (req: express.Request): { docs: CanvasDocuments; name: string; board: string } | { missing: string } | null => {
    const p = projectFor(req);
    if (!p) return null;
    const board = typeof req.query.board === 'string' && req.query.board ? req.query.board : FIRST_BOARD;
    const docs = boardDocsOf(p.root, p.env, board);
    return docs ? { docs, name: p.name, board } : { missing: board };
  };
  const noBoard = (res: express.Response, id: string): void => { res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: `This project has no board ${JSON.stringify(id.slice(0, 40))}.` }); };
  app.get('/api/app/boards', ...guards, (req, res) => {
    const p = projectFor(req);
    if (!p) { res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: DESK_NO_PROJECT }); return; }
    const boards = readBoards(p.root, p.env).map((b) => {
      const s = boardDocsOf(p.root, p.env, b.id)!.load();
      return { ...b, revision: s.revision, savedAt: s.savedAt };
    });
    res.set('Cache-Control', 'no-store').json({ ok: true, project: p.name, boards });
  });
  app.post('/api/app/boards', ...guards, express.json({ limit: '2kb' }), (req, res) => {
    const p = projectFor(req);
    if (!p) { res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: DESK_NO_PROJECT }); return; }
    const name = boardName((req.body ?? {}).name);
    if (!name) { res.status(400).set('Cache-Control', 'no-store').json({ ok: false, error: 'A board needs a name.' }); return; }
    const made = createBoard(p.root, p.env, name);
    if ('error' in made) { res.status(409).set('Cache-Control', 'no-store').json({ ok: false, error: made.error }); return; }
    res.set('Cache-Control', 'no-store').json({ ok: true, project: p.name, board: made });
  });
  app.post('/api/app/boards/:id/rename', ...guards, express.json({ limit: '2kb' }), (req, res) => {
    const p = projectFor(req);
    if (!p) { res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: DESK_NO_PROJECT }); return; }
    const name = boardName((req.body ?? {}).name);
    if (!name) { res.status(400).set('Cache-Control', 'no-store').json({ ok: false, error: 'A board needs a name.' }); return; }
    const b = renameBoard(p.root, p.env, String(req.params.id), name);
    if (!b) { noBoard(res, String(req.params.id)); return; }
    res.set('Cache-Control', 'no-store').json({ ok: true, project: p.name, board: b });
  });
  app.get('/api/app/desk', ...guards, (req, res) => {
    const d = deskFor(req);
    if (!d) { res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: DESK_NO_PROJECT }); return; }
    if ('missing' in d) { noBoard(res, d.missing); return; }
    const s = d.docs.load();
    res.set('Cache-Control', 'no-store').json({ ok: true, project: d.name, board: d.board, revision: s.revision, savedAt: s.savedAt, snapshot: s.snapshot, ...(s.notice ? { notice: s.notice } : {}) });
  });
  app.post('/api/app/desk', ...guards, express.json({ limit: 2 * MAX_CANVAS_BYTES }), (req, res) => {
    const d = deskFor(req);
    if (!d) { res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: DESK_NO_PROJECT }); return; }
    if ('missing' in d) { noBoard(res, d.missing); return; }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { snapshot?: unknown; revision?: unknown; baseRevision?: unknown };
    const r = d.docs.save(body);
    if (r.ok) { res.set('Cache-Control', 'no-store').json({ ...r, project: d.name }); return; }
    if ('conflict' in r && r.conflict) {
      const kept = d.docs.keepCopy(body);
      res.status(409).set('Cache-Control', 'no-store').json({ ...r, project: d.name, ...(kept.ok ? { kept: kept.kept } : {}) });
      return;
    }
    res.status('tooLarge' in r && r.tooLarge ? 413 : 400).set('Cache-Control', 'no-store').json({ ...r, project: d.name });
  });
  return { root };
}
