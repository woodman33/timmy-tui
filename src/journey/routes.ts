/**
 * R10 (H164): the journey's read-only routes on the browser companion (src/companion/server.ts mounts them), so the page, its
 * screens and Studio's draw the facts the terminal Workbench draws, from the same functions (./index.ts):
 *
 *   route                                       answers
 *   GET /api/journey/route[?surface=<s>]        routeNow: the route the next chat turn of surface <s> takes (repl, monitor,
 *                                               workbench or companion; the companion page's own Send when none is named),
 *                                               from the environment the page's chat reads (never a key)
 *   GET /api/journey/recent[?limit=<n>]         recentWork: the shown project's newest work (at most 50), each with where it
 *                                               opens
 *   GET /api/journey/run/<operation id>         runSummary: a run's progress, result and receipt, with its project; 400 for an
 *                                               id that is not one; ok false, with why, for one the project has no record of
 *   GET /api/journey/open?<the page's query>    askedOf and shownFor (R9 review F5, F6): what the page's own address asks for
 *                                               (tab=, mesh=, recording=, file=, vox=, run=, receipt=), and what it shows for
 *                                               it from what the shown project has (tab 6's list, tab 5's records, the file),
 *                                               with a notice whenever that is not what was asked
 *   GET /api/journey/file?path=<its path>       projectFile (./file.ts): a file of the project for the preview (journey step
 *                                               3): an image (png, jpg, jpeg, webp, gif; up to 4 MB) as a data URL with its
 *                                               width and height, or a text file's first 64 KB; anything else, and any path
 *                                               not plainly in the project's own folder, refused in words (400 for a path
 *                                               that is not one in the project, ok false otherwise)
 *
 * Each needs the companion's token, as every content route (refused, 401, before anything is read), and answers for the
 * project the page shows (?project=<id>, else the one followed; a project the companion does not know is 404). Nothing here
 * writes, runs or asks the network. Every answer has the home folder written as ~, and none carries a key or the token (a
 * token in an address is refused before any route: src/companion/server.ts).
 */
import type express from 'express';
import { lstatSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { ChatSurface } from '../contracts/chat-session.js';
import { privatePath, type ActiveProject } from '../project/index.js';
import { timmyHome } from '../setup/home.js';
import { scrubHomes, scrubStrings } from '../utils/home-scrub.js';
import { readChain, type Receipt } from '../utils/receipts.js';
import { askedOf, OPERATION_ID, shownFor, type PageHas } from './open.js';

type Env = Record<string, string | undefined>;

export const JOURNEY_ROUTES = { route: '/api/journey/route', recent: '/api/journey/recent', run: '/api/journey/run/:op', open: '/api/journey/open', file: '/api/journey/file' } as const;
const SURFACES: readonly ChatSurface[] = ['repl', 'monitor', 'workbench', 'companion'];
/** The most items one recent answer carries. */
export const RECENT_MAX = 50;
const FAILED = 'The companion could not read what this journey request needs, so it answers with nothing. It is still running.';

export interface JourneyRouteContext {
  /** the token check every content route of the companion uses */
  withToken: express.RequestHandler;
  /** the project a request is about (?project=<id>, else the one followed); null when the companion does not know it */
  projectFor: (req: express.Request) => ActiveProject | null;
  projectUnknown: string;
  /** the environment the page's chat route and key are read from (src/companion/server.ts chatEnv) */
  chatEnv: () => Env;
  /** the environment the project's records are read with (a test's TIMMY_HOME), else this process's */
  env: Env;
}

/** The runs chain as the companion's readers read it: TIMMY_STORE, else the project's own store. */
const chainOf = (root: string, env: Env): readonly Receipt[] => { try { return env.TIMMY_STORE ? readChain('runs') : readChain('runs', root); } catch { return []; } };

export function mountJourneyRoutes(app: express.Express, c: JourneyRouteContext): void {
  const scrub = <T>(v: T): T => scrubStrings(v, (t) => scrubHomes(t, c.env as NodeJS.ProcessEnv));
  const answer = (res: express.Response, status: number, body: unknown): void => { res.status(status).set('Cache-Control', 'no-store').json(scrub(body)); };

  app.get(JOURNEY_ROUTES.route, c.withToken, async (req, res) => {
    const asked = req.query.surface === undefined ? 'companion' : req.query.surface;
    if (typeof asked !== 'string' || !SURFACES.includes(asked as ChatSurface)) { answer(res, 400, { ok: false, error: `surface is one of ${SURFACES.join(', ')}.` }); return; }
    try {
      const { routeNow } = await import('./route.js');
      answer(res, 200, { ok: true, surface: asked, route: routeNow({ env: c.chatEnv(), cwd: process.cwd(), surface: asked as ChatSurface }) });
    } catch { answer(res, 500, { ok: false, error: FAILED }); }
  });

  app.get(JOURNEY_ROUTES.recent, c.withToken, async (req, res) => {
    const project = c.projectFor(req);
    if (!project) { answer(res, 404, { ok: false, error: c.projectUnknown }); return; }
    const n = Number(req.query.limit ?? 12);
    const limit = Number.isFinite(n) ? Math.min(RECENT_MAX, Math.max(1, Math.floor(n))) : 12;
    try {
      const { recentWork } = await import('./recent.js');
      // what waits on a person, as every surface counts it (src/ops/waiting.ts waitingNow: this process's NEEDS YOU boxes and
      // other processes'): a running run a box blocks is "waiting on you"
      const { waitingNow } = await import('../ops/waiting.js');
      const chain = chainOf(project.root, c.env);
      const boxes = new Map<string, string>();
      try { for (const d of waitingNow({ root: project.root, jobs: [], chain, env: c.env }).items) if (d.blocks && d.operation && !boxes.has(d.operation)) boxes.set(d.operation, d.title); } catch { /* none read: none said */ }
      answer(res, 200, { ok: true, ...recentWork({ project: { name: project.name, root: project.root }, env: c.env, chain, waiting: (op) => boxes.get(op) }, limit) });
    } catch { answer(res, 500, { ok: false, error: FAILED }); }
  });

  app.get(JOURNEY_ROUTES.run, c.withToken, async (req, res) => {
    const op = String(req.params.op ?? '');
    if (!OPERATION_ID.test(op)) { answer(res, 400, { ok: false, error: 'Not an operation id: an operation id is o and 8 hex digits (o1a2b3c4d), as Timmy prints it.' }); return; }
    const project = c.projectFor(req);
    if (!project) { answer(res, 404, { ok: false, error: c.projectUnknown }); return; }
    try {
      const { runSummary } = await import('./run.js');
      const r = runSummary({ project: { name: project.name, root: project.root }, env: c.env, jobsDir: join(timmyHome(c.env as NodeJS.ProcessEnv), 'jobs') }, op);
      if (r.ok) answer(res, 200, { ok: true, run: r });
      else answer(res, 200, { ok: false, reason: r.refusal, error: r.why });
    } catch { answer(res, 500, { ok: false, error: FAILED }); }
  });

  app.get(JOURNEY_ROUTES.open, c.withToken, async (req, res) => {
    const project = c.projectFor(req);
    if (!project) { answer(res, 404, { ok: false, error: c.projectUnknown }); return; }
    // the page's own query, as it sent it (its project named apart)
    const raw = req.originalUrl.split('?')[1] ?? '';
    const asked = askedOf(`?${raw.split('&').filter((p) => !p.startsWith('project=')).join('&')}`);
    try {
      const has: PageHas = {};
      const sel = asked.select;
      const env = c.env as NodeJS.ProcessEnv;
      if (asked.tab === 'create' || sel?.name === 'mesh' || sel?.name === 'recording') {
        // tab 6's own list (src/companion/panels/create.ts lists the same, by the same reader; nothing here starts the Rerun CLI)
        const { listMeshes } = await import('../vox/meshes.js');
        const list = listMeshes({ root: project.root, env, chain: () => chainOf(project.root, c.env) }, { budgetMs: 0 });
        has.meshes = list.meshes.map((m) => m.path);
        has.recordings = list.recordings.map((r) => r.path);
      }
      if (asked.tab === 'voxvision' || sel?.name === 'vox') {
        const { listVoxRecords } = await import('../vox/preview.js');
        has.records = listVoxRecords({ root: project.root, chain: chainOf(project.root, c.env), env }).records.map((r) => r.id);
      }
      if (sel?.name === 'file') {
        // a regular file of the project, reached with no link (not even a linked folder on the way), never a private one (a
        // key file, .git, .timmy/private)
        let file = false;
        try {
          const abs = join(project.root, sel.value);
          const st = lstatSync(abs);
          const inside = realpathSync(abs).startsWith(`${realpathSync(project.root)}${sep}`);
          file = st.isFile() && !st.isSymbolicLink() && inside && !privatePath(sel.value);
        } catch { file = false; }
        has.files = file ? [sel.value] : [];
      }
      answer(res, 200, { ok: true, asked, ...shownFor(asked, has) });
    } catch { answer(res, 500, { ok: false, error: FAILED }); }
  });

  app.get(JOURNEY_ROUTES.file, c.withToken, async (req, res) => {
    const project = c.projectFor(req);
    if (!project) { answer(res, 404, { ok: false, error: c.projectUnknown }); return; }
    try {
      const { projectFile } = await import('./file.js');
      const r = projectFile({ name: project.name, root: project.root }, req.query.path, c.env as NodeJS.ProcessEnv);
      const status = !r.ok && r.refusal === 'path' ? 400 : 200;
      // an image's data is its own bytes as base64 (never rewritten: a home folder's name may occur in base64 by chance);
      // every other string is written from ~, as every answer here
      if (r.ok && r.kind === 'image') res.status(status).set('Cache-Control', 'no-store').json({ ...scrub({ ...r, data: '' }), data: r.data });
      else answer(res, status, r);
    } catch { answer(res, 500, { ok: false, error: FAILED }); }
  });
}
