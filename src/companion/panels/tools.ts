/**
 * R6 (H142): the Tools & MCP panel's routes (tab 9; the operator's references 08 and 17), under /api/panel/tools/…, each
 * behind the companion's token, each for the project the page shows (?project=<id>, else the one followed). What they do
 * and the page's rule for a call are src/mcp/inspector.ts's; these routes only read the request and answer.
 *
 *   GET  state        the two routes with their rungs, Timmy's FAKE fixture, the four ingest modes, what sees the wire, the
 *                     page's rule, and the project's newest MCP calls (from their records; receipts verified now)
 *   GET  servers      the servers MCPorter's config and editor imports name, read from their files (nothing started)
 *   GET  calls        the newest calls again (the page reads them when the frame moves)
 *   GET  call/<id>    one call again: its record, request, answer, wire trace and receipt (verified now)
 *   POST list         a server's tools through the route picked: a real tools/list (it starts the server; no approval)
 *   POST check        the form's check: the arguments against the schema the listing gave, the request, the command lines
 *   POST call         one call: refused before anything is called when the tool is not on the server's list (404), when the
 *                     arguments fail its schema (422) or when it waits for you (409, with the line to type in Timmy's
 *                     terminal); else run through the route picked and kept as /mcp call keeps it (200)
 *
 * One listing or call at a time per companion (each starts processes); a second waits for the first, a third is told to.
 */
import express from 'express';
import type { PanelContext } from '../panels.js';
import { callFor, callRows, checkFor, configuredServers, inspectorState, listFor, parseServerSpec, projectChain, readCall } from '../../mcp/inspector.js';

type Env = Record<string, string | undefined>;

export const TOOLS_BUSY = 'One listing or call runs from this page at a time, and another is waiting: try again when they end.';

export function mountToolsPanel(app: express.Express, ctx: PanelContext): void {
  // the routes and the servers they start get this process's environment, with a test's own values over it
  const env = (): Env => (ctx.env === process.env ? process.env : { ...process.env, ...ctx.env });
  const json = express.json({ limit: '64kb' });
  const project = (req: express.Request, res: express.Response): { root: string; name: string } | null => {
    const p = ctx.projectFor(req);
    if (!p) { res.status(404).json({ ok: false, error: ctx.projectUnknown }); return null; }
    return { root: p.root, name: p.name };
  };
  // one route process at a time: a second request waits for the first; a third is refused with words
  let running: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  const oneAtATime = async <T>(res: express.Response, fn: () => Promise<T>): Promise<T | null> => {
    if (waiting >= 2) { res.status(429).json({ ok: false, error: TOOLS_BUSY }); return null; }
    waiting += 1;
    const turn = running.then(fn, fn);
    running = turn.catch(() => undefined);
    try { return await turn; } finally { waiting -= 1; }
  };
  const failed = (res: express.Response, e: unknown): void => {
    if (!res.headersSent) res.status(500).json({ ok: false, error: `The inspector could not answer: ${e instanceof Error ? e.message.replace(/\/(?:home|Users)\/[^\s'"]+/g, '…') : 'an error'}. Nothing more was done.` });
  };
  const base = '/api/panel/tools';
  app.use(base, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.get(`${base}/state`, ctx.withToken, (req, res) => {
    const p = project(req, res);
    if (!p) return;
    try { res.json({ ok: true, ...inspectorState(p.root, env()) }); } catch (e) { failed(res, e); }
  });

  app.get(`${base}/servers`, ctx.withToken, async (req, res) => {
    const p = project(req, res);
    if (!p) return;
    try {
      const s = await configuredServers(p.root, env());
      res.json({ ok: s.ok, servers: s.servers, ...(s.error ? { error: s.error } : {}), note: 'read from MCPorter\'s config files and the editors\' configs it imports: no server was started or contacted' });
    } catch (e) { failed(res, e); }
  });

  app.get(`${base}/calls`, ctx.withToken, (req, res) => {
    const p = project(req, res);
    if (!p) return;
    try { res.json({ ok: true, ...callRows(p.root, 12) }); } catch (e) { failed(res, e); }
  });

  app.get(`${base}/call/:id`, ctx.withToken, async (req, res) => {
    const p = project(req, res);
    if (!p) return;
    try {
      const view = await readCall(p.root, String(req.params.id), projectChain(p.root));
      if (!view) { res.status(404).json({ ok: false, error: `No MCP call record ${String(req.params.id).slice(0, 12)} in this project (a call's id is m and 8 hex digits).` }); return; }
      res.json({ ok: true, call: view });
    } catch (e) { failed(res, e); }
  });

  app.post(`${base}/list`, ctx.withToken, json, async (req, res) => {
    const p = project(req, res);
    if (!p) return;
    const body = (req.body ?? {}) as { server?: unknown; route?: unknown };
    const spec = parseServerSpec(body.server);
    if (!spec.ok) { res.status(400).json({ ok: false, error: spec.error }); return; }
    if (body.route !== 'sdk' && body.route !== 'mcporter') { res.status(400).json({ ok: false, error: 'pick a route: sdk or mcporter' }); return; }
    const route = body.route;
    try {
      const view = await oneAtATime(res, () => listFor(spec.spec, route, { root: p.root, env: env(), project: p.name }));
      if (view) res.json({ ...view });
    } catch (e) { failed(res, e); }
  });

  app.post(`${base}/check`, ctx.withToken, json, (req, res) => {
    const p = project(req, res);
    if (!p) return;
    try {
      const a = checkFor((req.body ?? {}) as Parameters<typeof checkFor>[0], env());
      if (a.status !== 200) { res.status(a.status).json({ ok: false, error: a.error }); return; }
      const { status: _s, ...rest } = a;
      res.json({ ok: true, ...rest });
    } catch (e) { failed(res, e); }
  });

  app.post(`${base}/call`, ctx.withToken, json, async (req, res) => {
    const p = project(req, res);
    if (!p) return;
    try {
      const a = await oneAtATime(res, () => callFor((req.body ?? {}) as Parameters<typeof callFor>[0], { root: p.root, env: env(), project: p.name }));
      if (!a) return;
      const { status, ...rest } = a;
      res.status(status).json({ ok: status === 200, ...rest });
    } catch (e) { failed(res, e); }
  });
}
