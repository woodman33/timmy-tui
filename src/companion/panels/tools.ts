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
 *   POST list         the FAKE fixture's or a configured server's tools through the route picked: a real tools/list (it
 *                     starts the server, or reaches its address; no approval). A command line typed on the page is never
 *                     started from it: 409 NEEDS YOU with its lines for Timmy's terminal, before anything starts
 *   POST check        the form's check: the arguments against the schema the listing gave, the request, the command lines
 *   POST call         one call: refused before anything is called when it waits for you (409, with the line to type in
 *                     Timmy's terminal: a typed command line and a configured server before anything starts), when the
 *                     tool is not on the server's list (404) or when the arguments fail its schema (422); else run through
 *                     the route picked and kept as /mcp call keeps it (200)
 *
 * One listing or call at a time per companion (each starts processes); a second waits for the first, a third is told to.
 */
import express from 'express';
import type { PanelContext } from '../panels.js';
import { callFor, callRows, checkFor, configuredServers, inspectorState, listFor, parseServerSpec, projectChain, readCall, typedRefusal } from '../../mcp/inspector.js';
import type { ActiveProject } from '../../project/index.js';
import { inventory as readInventory } from '../../capabilities/inventory.js';
import { inventoryPage, type Inventory, type InventoryPage } from './tools-inventory.js';

/** How long one inventory answers every page of a project (it reads files, settings and receipts; a page polls); ?refresh=1 reads again. */
export const INVENTORY_KEEP_MS = 30_000;
/** How long GET …/state waits for the inventory before answering without it (the page then reads GET …/inventory). */
export const INVENTORY_STATE_WAIT_MS = 2_000;

/** A project's inventory and one sentence of how it was read (what was and was not run). */
export interface InventorySource { inventory: Inventory; read: string }
/** How the inventory reads (src/capabilities/inventory.ts): files, settings and the project's receipts; nothing run, nothing contacted. */
export const INVENTORY_READ = 'files, settings and this project\'s receipts read (src/capabilities inventory); nothing run, nothing contacted, no key left this computer';

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

  // R11 Phase 2 (H171): the Tools & integrations inventory: the rows the terminal's Chat rail reads (H170's capability
  // inventory, src/capabilities/inventory.ts: files, settings and the project's receipts; nothing run, nothing contacted),
  // as cards in the three words (src/companion/panels/tools-inventory.ts); a test gives FAKE rows through ctx.inventory.
  // One reading answers a project for INVENTORY_KEEP_MS; GET …/inventory carries it with the page's cards (?refresh=1 reads
  // again), and GET …/state carries the inventory itself.
  const kept = new Map<string, { at: number; answer: Promise<InventoryPage & { read: string }> }>();
  const inventoryFor = (p: ActiveProject, refresh: boolean): Promise<InventoryPage & { read: string }> => {
    const have = kept.get(p.root);
    const read = async (): Promise<InventoryPage & { read: string }> => {
      const source: InventorySource = ctx.inventory
        ? await ctx.inventory(p)
        : { inventory: readInventory({ env: env(), cwd: p.root }), read: INVENTORY_READ };
      return { ...inventoryPage(source.inventory), read: source.read };
    };
    const fresh = !have || refresh || Date.now() - have.at > INVENTORY_KEEP_MS;
    const entry = fresh ? { at: Date.now(), answer: read() } : have;
    if (fresh) { kept.set(p.root, entry); entry.answer.catch(() => { if (kept.get(p.root) === entry) kept.delete(p.root); }); }
    return entry.answer;
  };
  app.get(`${base}/state`, ctx.withToken, async (req, res) => {
    const p = ctx.projectFor(req);
    if (!p) { res.status(404).json({ ok: false, error: ctx.projectUnknown }); return; }
    try {
      const state = inspectorState(p.root, env());
      // R11 Phase 2 (H171): the capability inventory rides with the state (the same reading GET …/inventory answers); a
      // reading still under way after INVENTORY_STATE_WAIT_MS is left to GET …/inventory, so the state is not held up
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<{ inventory: null; inventoryPending: true }>((resolve) => { timer = setTimeout(() => resolve({ inventory: null, inventoryPending: true }), INVENTORY_STATE_WAIT_MS); });
      const inv = await Promise.race([
        inventoryFor(p, false).then((i) => ({ inventory: i.inventory }), (e: unknown) => ({ inventory: null, inventoryError: e instanceof Error ? e.message : String(e) })),
        late,
      ]).finally(() => clearTimeout(timer));
      res.json({ ok: true, ...state, ...inv });
    } catch (e) { failed(res, e); }
  });

  // the 07:37 completion pass: the Timmy MCP page — what `timmy mcp serve` declares (read from this Timmy's own code; a
  // declaration, not a listing of a running server: listing one through a route is the MCP → CLI page's)
  app.get(`${base}/timmy-mcp`, ctx.withToken, async (_req, res) => {
    try {
      const { TIMMY_MCP_TOOLS } = await import('../../mcp/server.js');
      res.json({ ok: true, serve: 'timmy mcp serve', transport: 'stdio', read: 'declared by this Timmy\'s code (tools/list answers the same list); nothing started', tools: TIMMY_MCP_TOOLS });
    } catch (e) { failed(res, e); }
  });

  app.get(`${base}/inventory`, ctx.withToken, async (req, res) => {
    const p = ctx.projectFor(req);
    if (!p) { res.status(404).json({ ok: false, error: ctx.projectUnknown }); return; }
    try {
      const inv = await inventoryFor(p, req.query.refresh === '1');
      res.json({ ok: true, ...inv, note: 'Nothing is set from these cards: a key or an address is set in Models & accounts, the environment or the .env file.' });
    } catch (e) { failed(res, e); }
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
      // a command line typed on the page: refused at once, outside the queue, and nothing starts
      if (spec.spec.kind === 'stdio') {
        const { status, ...rest } = typedRefusal(spec.spec.command, route, env());
        res.status(status).json({ ok: false, ...rest });
        return;
      }
      const startable = spec.spec;
      const view = await oneAtATime(res, () => listFor(startable, route, { root: p.root, env: env(), project: p.name }));
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
