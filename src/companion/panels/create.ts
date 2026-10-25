/**
 * R7 (H153): the 3D & Motion panel's routes (tab 6; the 3D part of reference 06), under /api/panel/create/…, each behind the
 * companion's token and answering for the project the page shows (?project=<id>, else the one followed). What each answers is
 * made by src/vox/meshes.ts from that project's own files. R9 (H159): the list asks the installed Rerun CLI to read each listed
 * recording not read yet (src/vox/rrd-cli.ts: in the background, one at a time, bounded, each call in the project's log), and
 * answers "being read" until it is done; nothing else here runs a tool, starts a viewer or writes. The page side is
 * src/companion/client/panel-create.js.
 *
 *   route                                          answers
 *   GET /api/panel/create/meshes                   the project's meshes (its STL, OBJ and PLY files, and a STEP's tessellations a
 *                                                  VoxVision record names), each with its kind and reader id, measured from the
 *                                                  whole file by Timmy's own reader of its kind (R8 H154: OBJ and PLY), and its
 *                                                  Rerun recordings with their header facts (timmy.meshes/1)
 *   GET /api/panel/create/sources                  R11 round 7 (H176): the guided flow's sources, read only: the project's parameter
 *                                                  files with their values, its workflow documents with their blocks, the three
 *                                                  Houdini starters and the Houdini lane as probed (timmy.create-sources/1)
 *   GET /api/panel/create/mesh?path=<p>[&sha=<s>]  one listed mesh's triangles for the view: little-endian float32, nine per
 *                                                  triangle (every one up to the cap, else an even pick through the file's
 *                                                  order); X-Timmy-Triangles says shown/total, X-Timmy-Sha256 the bytes read;
 *                                                  a path the list does not name for this project is refused with why, and
 *                                                  bytes other than the sha256 named are 409
 *
 * A request without the token is refused (401) before anything is read; a project the companion does not know is 404.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type express from 'express';
import type { PanelContext } from '../panels.js';
import { probeWire } from '../../forge/stubs.js';
import { projectId } from '../../project/index.js';
import { inProject } from '../../studio/card-detail.js';
import { studioBaseUrl } from '../../studio/config.js';
import { projectCards, type ProjectCard } from '../../studio/project-cards.js';
import { starterTemplates } from '../../studio/templates.js';
import { readChain, type Receipt } from '../../utils/receipts.js';
import { listMeshes, meshView } from '../../vox/meshes.js';

export const CREATE_PANEL = {
  meshes: '/api/panel/create/meshes',
  mesh: '/api/panel/create/mesh',
  /**
   * R11 round 7 (H176): the page's guided starter flow (01 Define the geometry · 02 Set the parameters · 03 Cook in Houdini) read
   * from the project's own records, nothing run: its parameter files (the tray recipe's, OpenSCAD models') with their values as
   * the live board's parameter card reads them, its workflow documents with their blocks (what /run would take), the three
   * Houdini starters (src/studio/templates.ts) and the Houdini lane as src/forge/stubs.ts probes it (flag_off, not_configured or
   * ready: available ≠ exercised; nothing here calls it). Editing, Save, Rebuild and Run are Studio's and the REPL's: each item
   * carries the typed command and Studio's address, never a button that runs. timmy.create-sources/1.
   */
  sources: '/api/panel/create/sources',
} as const;

export const SOURCES_SCHEMA = 'timmy.create-sources/1';

/** A parameter file as the page shows it: its values read now, what runs on it (in Studio or by its typed command), never a button here. */
export interface SourceParams {
  id: string;
  engine: 'tray' | 'scad' | 'unknown';
  title: string;
  state: string;
  file: string | null;
  values: Array<{ name: string; value: string; unit: string | null }>;
  more: number;
  /** the typed command that runs it in Timmy (/recipe tray, /scad <model>) */
  command: string;
  /** whether the live board's save takes this file (Studio's parameter node), and why not */
  save: { offered: boolean; why: string | null };
  rebuild: boolean;
  receipt: string | null;
}
/** A workflow document as the page shows it: its blocks, each with the state its newest run left and whether /run takes it. */
export interface SourceWorkflow {
  id: string;
  title: string;
  state: string;
  doc: string | null;
  runnable: boolean;
  notRunnable: string | null;
  blocks: Array<{ name: string; word: string; glyph: string; runnable: boolean; command: string | null }>;
  running: boolean;
  last: { word: string; met: boolean | null; receipt: string | null; endedAt: string | null } | null;
  /** whether the document names Houdini's hython, hbatch or houdini (the only native cook path a workflow could take), read from its text: named is not configured, let alone run */
  houdini: boolean;
}
export interface HoudiniLane {
  status: 'flag_off' | 'not_configured' | 'ready';
  flag: string;
  bin: string;
  /** what the status means for this page, exactly: available / configured / never exercised here */
  words: string;
}

/** The Houdini lane in the page's words: what is there, what is not, and that nothing here calls it. */
export function houdiniWords(p: ReturnType<typeof probeWire>): string {
  if (p.status === 'flag_off') return `No native Houdini operation is configured in Studio: the Houdini lane is off (${p.flag} is not set). A cook runs in Houdini itself, or through a workflow block a REPL runs; nothing on this page calls Houdini.`;
  if (p.status === 'not_configured') return `No native Houdini operation is configured in Studio: the lane is armed (${p.flag}=1), but ${p.server_bin} is not on this computer's PATH. Nothing on this page calls Houdini.`;
  return `${p.server_bin} is on this computer's PATH and the lane is armed (${p.flag}=1): available, not exercised from this page (nothing here calls it; a REPL's tool call would, and would say so in its receipt).`;
}

/** A parameter card's detail as the page shows it (a card without detail is named with what is known, its values unknown). */
function sourceParams(c: ProjectCard): SourceParams {
  const d = c.detail && c.detail.type === 'params' ? c.detail : null;
  return {
    id: c.id, engine: d ? d.engine : 'unknown', title: c.title, state: c.state, file: d ? d.file : c.record,
    values: d ? d.values.map((v) => ({ name: v.name, value: String(v.value), unit: v.unit ?? null })) : [],
    more: d ? d.more : 0, command: c.command, save: d ? d.save : { offered: false, why: 'its detail was not read' }, rebuild: d ? d.rebuild : false, receipt: c.receipt,
  };
}
/** Whether workflow document `rel` of project `root` names Houdini's hython, hbatch or houdini in its text (read whole, at most 256 KB; never outside the project). */
function namesHoudini(root: string, rel: string | null): boolean {
  const inside = rel ? inProject(rel) : null;
  if (!inside) return false;
  try {
    const file = join(root, inside);
    const st = statSync(file);
    if (!st.isFile() || st.size > 256 * 1024) return false;
    return /\bhython\b|\bhbatch\b|\bhoudini\b/i.test(readFileSync(file, 'utf8'));
  } catch { return false; }
}
function sourceWorkflow(c: ProjectCard, root: string): SourceWorkflow {
  const d = c.detail && c.detail.type === 'workflow' ? c.detail : null;
  const blocks = d ? d.blocks.map((b) => ({ name: b.name, word: b.word, glyph: b.glyph, runnable: b.runnable && d.runnable, command: b.runnable && d.runnable ? `/run ${d.doc} ${b.name}` : null })) : [];
  const houdini = namesHoudini(root, d ? d.doc : c.record);
  return {
    id: c.id, title: c.title, state: c.state, doc: d ? d.doc : c.record, runnable: !!d && d.runnable, notRunnable: d ? d.notRunnable : null, blocks,
    running: !!d && d.running, last: d && d.last ? { word: d.last.word, met: d.last.met, receipt: d.last.receipt, endedAt: d.last.endedAt } : null, houdini,
  };
}

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
      // within a time budget: a large mesh not measured yet is measured on a later read (the page asks again while any is); a
      // recording not read yet by the Rerun CLI is read in the background (the page asks again while any is being read)
      const list = listMeshes({ root: project.root, env: { ...ctx.env } as NodeJS.ProcessEnv, chain: () => chainOf(project.root) }, { budgetMs: LIST_BUDGET_MS, rrd: { start: true } });
      res.json({ ok: true, ...list, project: { id: projectId(project.root), name: project.name } });
    } catch { res.status(500).json({ ok: false, error: FAILED }); }
  });

  app.get(CREATE_PANEL.sources, ctx.withToken, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const project = ctx.projectFor(req);
    if (!project) { res.status(404).json({ ok: false, error: ctx.projectUnknown }); return; }
    try {
      // the project's own records, read as Studio's project reading reads them (detail: each parameter file's values, each
      // workflow's blocks); no jobs folder and no receipts store are named here, so a run's record is not read: the words say so
      const read = projectCards({ root: project.root, name: project.name, jobs: null, receipts: null }, {}, { detail: true });
      const params = read.cards.filter((c) => c.kind === 'params').map(sourceParams);
      const workflows = read.cards.filter((c) => c.kind === 'workflow').map((c) => sourceWorkflow(c, project.root));
      const lane = probeWire('houdini');
      res.json({
        ok: true, schema: SOURCES_SCHEMA, project: { id: projectId(project.root), name: project.name },
        params, workflows, notes: read.notes,
        starters: starterTemplates().map((t) => ({ id: t.id, title: t.title, domain: t.domain, intro: t.intro, from: t.from.template, steps: t.steps })),
        houdini: { status: lane.status, flag: lane.flag, bin: lane.server_bin, words: houdiniWords(lane) } satisfies HoudiniLane,
        studio: studioBaseUrl(ctx.env),
      });
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
