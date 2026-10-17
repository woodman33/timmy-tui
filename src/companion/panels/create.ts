/**
 * R7 (H153): the 3D & Motion panel's routes (tab 6; the 3D part of reference 06), under /api/panel/create/…, each behind the
 * companion's token and answering for the project the page shows (?project=<id>, else the one followed). What each answers is
 * made by src/vox/meshes.ts from that project's own files; nothing here runs a tool, starts a viewer or writes. The page side
 * is src/companion/client/panel-create.js.
 *
 *   route                                          answers
 *   GET /api/panel/create/meshes                   the project's meshes (its STL files, and a STEP's tessellations a VoxVision
 *                                                  record names), each measured by Timmy's own STL reader from the whole file,
 *                                                  and its Rerun recordings with their header facts (timmy.meshes/1)
 *   GET /api/panel/create/mesh?path=<p>[&sha=<s>]  one listed mesh's triangles for the view: little-endian float32, nine per
 *                                                  triangle (every one up to the cap, else an even pick through the file's
 *                                                  order); X-Timmy-Triangles says shown/total, X-Timmy-Sha256 the bytes read;
 *                                                  a path the list does not name for this project is refused with why, and
 *                                                  bytes other than the sha256 named are 409
 *
 * A request without the token is refused (401) before anything is read; a project the companion does not know is 404.
 */
import type express from 'express';
import type { PanelContext } from '../panels.js';
import { projectId } from '../../project/index.js';
import { readChain, type Receipt } from '../../utils/receipts.js';
import { listMeshes, meshView } from '../../vox/meshes.js';

export const CREATE_PANEL = {
  meshes: '/api/panel/create/meshes',
  mesh: '/api/panel/create/mesh',
} as const;

const FAILED = 'The 3D & Motion panel could not read what this request needs, so it answers with nothing. The companion is still running.';
/** How long one list answer may spend measuring meshes it has not measured before (at least one is measured each time). */
export const LIST_BUDGET_MS = 400;
/** What a mesh answer carries beside its bytes: no caching, never sniffed, and a policy under which it runs nothing. */
const MESH_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } as const;

/** The runs chain the other panels read: TIMMY_STORE, else the project's own store. */
function chainOf(root: string): readonly Receipt[] {
  try { return process.env.TIMMY_STORE ? readChain('runs') : readChain('runs', root); } catch { return []; }
}

export function mountCreatePanel(app: express.Express, ctx: PanelContext): void {
  app.get(CREATE_PANEL.meshes, ctx.withToken, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const project = ctx.projectFor(req);
    if (!project) { res.status(404).json({ ok: false, error: ctx.projectUnknown }); return; }
    try {
      // within a time budget: a large mesh not measured yet is measured on a later read (the page asks again while any is)
      const list = listMeshes({ root: project.root, env: { ...ctx.env } as NodeJS.ProcessEnv, chain: () => chainOf(project.root) }, { budgetMs: LIST_BUDGET_MS });
      res.json({ ok: true, ...list, project: { id: projectId(project.root), name: project.name } });
    } catch { res.status(500).json({ ok: false, error: FAILED }); }
  });

  app.get(CREATE_PANEL.mesh, ctx.withToken, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const rel = typeof req.query.path === 'string' ? req.query.path : null;
    const sha = typeof req.query.sha === 'string' ? req.query.sha : undefined;
    if (rel === null) { res.status(400).json({ ok: false, error: 'Name one mesh of this project: ?path=<its path in the project>.' }); return; }
    if (sha !== undefined && !/^[0-9a-f]{64}$/.test(sha)) { res.status(400).json({ ok: false, error: 'Name the bytes by their sha256: 64 hex digits (the list gives it).' }); return; }
    const project = ctx.projectFor(req);
    if (!project) { res.status(404).json({ ok: false, error: ctx.projectUnknown }); return; }
    try {
      const v = meshView(project.root, rel, sha === undefined ? {} : { sha });
      if (!v.ok) { res.status(v.status).json({ ok: false, error: v.error }); return; }
      res.set({ ...MESH_HEADERS, 'X-Timmy-Triangles': `${v.shown}/${v.total}`, 'X-Timmy-Sha256': v.sha256 }).type('application/octet-stream').send(v.body);
    } catch { res.status(500).json({ ok: false, error: FAILED }); }
  });
}
