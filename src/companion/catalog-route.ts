/**
 * The unified Workspace order (2026-10-27): GET /api/catalog — the one integration catalog (src/capabilities/catalog.ts)
 * for the request's principal and project: the capability inventory (read as Tools & integrations reads it, kept 30 s per
 * project; ?refresh=1 reads again), the native and vision finders, the provider audit, the host's own app listing (hostable,
 * running, this principal's receipts) and Treg's five words (the operator's). Nothing is run or contacted.
 */
import type express from 'express';
import { buildCatalog, type AppListingRow, type TregRungs } from '../capabilities/catalog.js';
import { inventory as readInventory, type Inventory } from '../capabilities/inventory.js';
import { scrubHomes } from '../utils/home-scrub.js';

type Env = Record<string, string | undefined>;

export interface CatalogScope { principal: string; operator: boolean; project: { name: string; root: string }; env: Env }
export interface CatalogRouteContext {
  withToken: express.RequestHandler;
  withUser: express.RequestHandler;
  scopeOf: (req: express.Request) => CatalogScope | null;
  apps: (req: express.Request) => AppListingRow[] | null;
  treg: (scope: CatalogScope) => TregRungs | null;
  /** a test's FAKE inventory for the request's project (the companion's own inventory seam) */
  inventory?: (req: express.Request) => Promise<Inventory | null>;
}

export const CATALOG_ROUTE = '/api/catalog';
export const CATALOG_KEEP_MS = 30_000;

export function mountCatalog(app: express.Express, ctx: CatalogRouteContext): void {
  const kept = new Map<string, { at: number; inv: Inventory }>();
  app.get(CATALOG_ROUTE, ctx.withToken, ctx.withUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const scope = ctx.scopeOf(req);
    if (!scope) { res.status(404).json({ ok: false, error: 'No project is open for this page, so there is no catalog to read for it.' }); return; }
    let inv: Inventory | null = null; let inventoryError: string | undefined;
    try {
      const key = `${scope.principal}|${scope.project.root}`;
      const have = kept.get(key);
      if (have && req.query.refresh !== '1' && Date.now() - have.at < CATALOG_KEEP_MS) inv = have.inv;
      else { inv = ctx.inventory ? await ctx.inventory(req) : readInventory({ env: scope.env, cwd: scope.project.root }); if (inv) kept.set(key, { at: Date.now(), inv }); }
    } catch (e) { inventoryError = e instanceof Error ? e.message : String(e); }
    let treg: TregRungs | null = null;
    try { treg = scope.operator ? ctx.treg(scope) : null; } catch { treg = null; }
    const catalog = buildCatalog({ inventory: inv, ...(inventoryError ? { inventoryError } : {}), apps: ctx.apps(req), treg, env: scope.env, cwd: scope.project.root });
    // no home path leaves the companion in the catalog's words
    res.type('application/json').send(scrubHomes(JSON.stringify({ ok: true, project: { name: scope.project.name }, catalog }), scope.env as NodeJS.ProcessEnv));
  });
}
