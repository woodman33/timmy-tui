/**
 * R6 (H143): the VoxVision panel's routes (tab 5; references 04, 05, 15 and 16), under /api/panel/voxvision/…, each behind
 * the companion's token and answering for the project the page shows (?project=<id>, else the one followed). What each
 * answers is made by src/vox/preview.ts from the project's own records and files; nothing here runs a tool or writes.
 *
 *   route                                       answers
 *   GET /api/panel/voxvision/records            the project's VoxVision records, newest first (timmy.vox-list/1): each
 *                                               with its action, status, check, receipt (verified or not) and counts
 *   GET /api/panel/voxvision/record?id=<id>     one record's preview (timmy.vox-preview/1): its images, what was measured
 *                                               over them, its entity tree, frames, values, pipeline, engines, meshes,
 *                                               recordings, receipt and commands
 *   GET /api/panel/voxvision/file?id=<id>&path=<path>
 *                                               an image the record names (an input, a highlight the board shows, a
 *                                               frame): a regular file inside the project, reached without a link or
 *                                               "..", PNG, JPEG, GIF or WebP by its bytes and name (SVG only for Timmy's
 *                                               own drawings), at most 32 MB; anything else is refused with why
 *
 * A request without the token is refused (401) before anything is read; a project the companion does not know is 404.
 */
import type express from 'express';
import type { PanelContext } from '../panels.js';
import { readChain, type Receipt } from '../../utils/receipts.js';
import { listVoxRecords, voxFile, voxPreview, type PreviewInput } from '../../vox/preview.js';

export const VOX_PANEL = {
  records: '/api/panel/voxvision/records',
  record: '/api/panel/voxvision/record',
  file: '/api/panel/voxvision/file',
} as const;

/** What a file answer carries beside its bytes: no caching, and a policy under which an image (an SVG too) runs nothing. */
const FILE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const FAILED = 'The VoxVision panel could not read what this request needs, so it answers with nothing. The companion is still running.';

/** The runs chain the frame and the run detail read: TIMMY_STORE, else the project's own store. */
function chainOf(root: string): readonly Receipt[] {
  try { return process.env.TIMMY_STORE ? readChain('runs') : readChain('runs', root); } catch { return []; }
}

export function mountVoxPanel(app: express.Express, ctx: PanelContext): void {
  const inputOf = (req: express.Request, res: express.Response): PreviewInput | null => {
    const project = ctx.projectFor(req);
    if (!project) { res.status(404).json({ ok: false, error: ctx.projectUnknown }); return null; }
    return { root: project.root, chain: chainOf(project.root), env: { ...ctx.env } as NodeJS.ProcessEnv };
  };
  const one = (v: unknown): string | null => (typeof v === 'string' ? v : null);

  app.get(VOX_PANEL.records, ctx.withToken, (req, res) => {
    const i = inputOf(req, res);
    if (!i) return;
    try { res.set('Cache-Control', 'no-store').json({ ok: true, ...listVoxRecords(i) }); } catch { res.status(500).json({ ok: false, error: FAILED }); }
  });

  app.get(VOX_PANEL.record, ctx.withToken, (req, res) => {
    const id = one(req.query.id);
    if (id === null) { res.status(400).json({ ok: false, error: 'Name one record: ?id=v<8 hex digits>.' }); return; }
    const i = inputOf(req, res);
    if (!i) return;
    try {
      const p = voxPreview(i, id);
      if (!p.ok) { res.status(p.status).json({ ok: false, error: p.error }); return; }
      res.set('Cache-Control', 'no-store').json({ ok: true, preview: p.preview });
    } catch { res.status(500).json({ ok: false, error: FAILED }); }
  });

  app.get(VOX_PANEL.file, ctx.withToken, (req, res) => {
    const id = one(req.query.id);
    const path = one(req.query.path);
    if (id === null || path === null) { res.status(400).json({ ok: false, error: 'Name one record and one of its files: ?id=v<8 hex digits>&path=<path in the project>.' }); return; }
    const i = inputOf(req, res);
    if (!i) return;
    try {
      const f = voxFile(i, id, path);
      if (!f.ok) { res.status(f.status).json({ ok: false, error: f.error }); return; }
      res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': FILE_POLICY, 'X-Content-Type-Options': 'nosniff' }).type(f.type).send(f.body);
    } catch { res.status(500).json({ ok: false, error: FAILED }); }
  });
}
