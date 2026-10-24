/**
 * R6 lead: the browser companion's tab panels, server side.
 *
 * A panel is what a workspace tab shows of its own records on the page: Studio's board artifacts (tab 4,
 * src/companion/panels/studio.ts), VoxVision's observations and recordings (tab 5, src/companion/panels/vox.ts) and Tools & MCP's
 * servers, schemas, calls and results (tab 9, src/companion/panels/tools.ts); R8 (H155): the Control Room's panes (tab 7,
 * src/companion/panels/control.ts, from src/ops/panes.ts, the Workbench's tab 7's own source).
 * Each panel's module mounts its own routes under /api/panel/<tab>/…, each behind the token check, each answering for the
 * project its page shows (?project=<id>, else the one followed). The page side is src/companion/client/panels.js (the
 * registry companion.js draws through) and src/companion/client/panel-<tab>.js (each panel's own drawing).
 *
 * A panel draws what Timmy's records hold and says plainly what is not there; an engine that is not installed stays
 * named as not installed. Nothing here starts an engine on its own.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type express from 'express';
import type { WorkspaceFrame } from '../contracts/workspace.js';
import type { JobRecord } from '../jobs/index.js';
import { projectId, type ActiveProject } from '../project/index.js';
import { chatTurnOf, TURN_FROM } from '../repl/seal.js';
import { timmyHome } from '../setup/home.js';
import { scrubHomes } from '../utils/home-scrub.js';
import { readChain, verifyReceiptIn, type Receipt } from '../utils/receipts.js';
import { mountVoxPanel } from './panels/vox.js';
import type { InventorySource } from './panels/tools.js';
import { mountToolsPanel } from './panels/tools.js';
import { mountStudioPanel } from './panels/studio.js';
import { mountCreatePanel } from './panels/create.js';
import { mountControlPanel } from './panels/control.js';

export interface PanelContext {
  /** The token check every content route of the companion uses (a request without the token is refused, 401). */
  withToken: express.RequestHandler;
  /** The project a request is about: the one its page names (?project=<id>), else the one followed; null when unknown. */
  projectFor: (req: express.Request) => ActiveProject | null;
  /** The words a request for a project this companion does not know is answered with (404). */
  projectUnknown: string;
  /** The environment the panels read with: a test's (its TIMMY_HOME), else this process's. */
  env: Record<string, string | undefined>;
  /** R8 (H155): the workspace frame of a project, as the page's GET /api/workspace makes it (src/companion/workspace.ts: one
   *  made in the last moment answers again); absent: a panel that would say the frame's words says it has none. */
  frame?: (project: ActiveProject) => Promise<WorkspaceFrame>;
  /** R11 Phase 2 (H171): a project's Tools & integrations inventory (a test's FAKE rows, in the capability inventory's shape)
   *  with one sentence of how it was read; absent: src/capabilities inventory({ env, cwd }) (files, settings and receipts;
   *  nothing run). */
  inventory?: (project: ActiveProject) => Promise<InventorySource>;
}

/** Mounts every panel's routes (server.ts calls it once, after the workspace routes and before the page's own). */
export function mountPanels(app: express.Express, ctx: PanelContext): void {
  mountVoxPanel(app, ctx);
  mountToolsPanel(app, ctx);
  mountStudioPanel(app, ctx);
  // R7 (H153): tab 6, the project's meshes and recordings (src/companion/panels/create.ts)
  mountCreatePanel(app, ctx);
  // R8 (H155): tab 7, the Control Room's panes (src/companion/panels/control.ts)
  mountControlPanel(app, ctx);
  // R11 round 7 (H169): the Runs & receipts list and the Workflows documents, read from the project's records (below)
  mountRunsPanel(app, ctx);
  mountWorkflowsPanel(app, ctx);
}

// ── R11 round 7 (H169): Runs & receipts ──────────────────────────────────────────────────────────────────────────────────
//
// GET /api/panel/runs/list?project=<id>&limit=<n>   the project's runs and sealed receipts, NEWEST FIRST, at most `limit`
// (RUNS_MAX by default): each row one line in words, its model, its duration, its state, and its receipt — marked verified
// ONLY when verifyReceiptIn confirmed it against the chain read for this answer (a receipt not checked says so). A chat turn's
// row links back to the Chat (its turn id and surface); a job's row names its operation (the run detail's id). Read from the
// project's job store and runs chain; nothing is run, started or changed. The schema is timmy.runs-list/1.

export const RUNS_PANEL = { list: '/api/panel/runs/list' } as const;
export const RUNS_LIST_SCHEMA = 'timmy.runs-list/1' as const;
export const RUNS_MAX = 40;
const RUNS_FAILED = 'The Runs & receipts panel could not read what this request needs, so it answers with nothing. The companion is still running.';

export interface RunRow {
  /** a sealed chat turn (every surface's), a job of the job store (a workflow run, another job), another sealed receipt */
  kind: 'turn' | 'job' | 'receipt';
  /** the receipt's short id (8 hex), or the job's id */
  id: string;
  /** when: the receipt's seal, or the job's start (ISO) */
  at: string;
  /** one line, in words (never the turn's words, never a path of this computer) */
  line: string;
  /** the model that answered, as sealed; null: not recorded (a job that asked no model: null) */
  model: string | null;
  /** how long it took; null: not recorded or still running */
  ms: number | null;
  /** its state, in the one table's words: running · answered · stopped · failed · ok (a sealed non-turn receipt) · unknown */
  state: 'running' | 'answered' | 'stopped' | 'failed' | 'ok' | 'unknown';
  /** its mark (▶ running, ✓ answered/ok, ■ stopped, ✕ failed, ? unknown) */
  mark: string;
  /** its receipt: verified true ONLY when verifyReceiptIn confirmed it now; false with why; null: no receipt (a running job) */
  receipt: { short: string; hash: string; verified: boolean; why?: string } | null;
  /** the operation it ran in (the run detail's id); null: none */
  operation: string | null;
  /** a chat turn: its identity and the surface it was sent from, for the link back to the Chat */
  turn?: { id: string | null; surface: string; from: string; stoppedBy?: string };
  /** a job: its label (a workflow run's "<document> › <block>"), and its blocks counted */
  job?: { id: string; label: string; blocks?: string; live: boolean };
}

export interface RunsList {
  schema: typeof RUNS_LIST_SCHEMA;
  at: string;
  project: { name: string };
  /** how many rows the records hold in all (the list carries at most `limit`) */
  total: number;
  running: number;
  rows: RunRow[];
  /** what could not be read, in words */
  notes: string[];
}

const RUN_MARK: Readonly<Record<RunRow['state'], string>> = { running: '▶', answered: '✓', ok: '✓', stopped: '■', failed: '✕', unknown: '?' };
const short = (hash: string): string => (/^sha256[:_][0-9a-f]{8}/.test(hash) ? hash.slice(7, 15) : hash.slice(0, 8));
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0];

/** The runs chain this companion's seals go to (src/workbench/state.ts chainOf): the env's TIMMY_STORE, else the project's own store. */
function runsChainOf(root: string, env: Record<string, string | undefined>): Receipt[] {
  try { return env.TIMMY_STORE ? readChain('runs') : readChain('runs', root); } catch { return []; }
}

/** The project's runs and receipts, newest first (files only; nothing run). */
export async function readRunsList(i: { root: string; name: string; env: Record<string, string | undefined>; limit?: number; now?: number }): Promise<RunsList> {
  const [{ JobManager }, state] = await Promise.all([import('../jobs/index.js'), import('../workbench/state.js')]);
  const limit = Math.max(1, Math.min(200, Math.floor(i.limit ?? RUNS_MAX)));
  const notes: string[] = [];
  const chain = runsChainOf(i.root, i.env);
  const verify = (hash: string): { ok: true } | { ok: false; reason: string } => { const v = verifyReceiptIn(chain, hash); return v.ok ? { ok: true } : v; };
  const scrub = (s: string): string => scrubHomes(s.split(i.root).join('.'), i.env as NodeJS.ProcessEnv);
  const rows: RunRow[] = [];
  const seen = new Set<string>();
  // the sealed chat turns, every surface's, with their receipts verified now
  let turns: ReturnType<typeof state.readTurns> = [];
  try { turns = state.readTurns(chain, i.root, 10_000, verify); } catch (e) { notes.push(`The chat turns could not be read from the chain: ${msgOf(e)}`); }
  for (const t of turns) {
    const hash = t.hash ?? '';
    if (hash) seen.add(hash);
    const from = TURN_FROM[t.surface] ?? t.surface;
    const ended = t.state === 'stopped' ? `stopped${t.stoppedBy ? ` (asked from ${TURN_FROM[t.stoppedBy as keyof typeof TURN_FROM] ?? t.stoppedBy})` : ''}` : t.state;
    rows.push({
      kind: 'turn', id: t.receipt, at: t.at, line: `Chat turn ${ended} · ${from}`, model: t.model, ms: typeof t.ms === 'number' ? t.ms : null,
      state: t.state, mark: RUN_MARK[t.state],
      receipt: hash ? { short: t.receipt, hash, verified: t.verified?.ok === true, ...(t.verified && !t.verified.ok ? { why: t.verified.reason } : {}) } : null,
      operation: t.operation, turn: { id: t.turn ?? null, surface: t.surface, from, ...(t.stoppedBy ? { stoppedBy: t.stoppedBy } : {}) },
    });
  }
  // the job store's jobs of this project (workflow runs and other jobs), with Timmy's judgement of each
  const jobsDir = join(timmyHome(i.env), 'jobs');
  let records: JobRecord[] = [];
  try { records = existsSync(jobsDir) ? new JobManager({ dir: jobsDir }).list() : []; } catch (e) { notes.push(`The job store could not be read (${msgOf(e)}): no job is shown from it`); }
  let jobs: ReturnType<typeof state.readJobs> = [];
  try { jobs = state.readJobs(records, i.root, { mine: new Set(), chain }); } catch (e) { notes.push(`The jobs could not be read: ${msgOf(e)}`); }
  for (const j of jobs) {
    const st: RunRow['state'] = j.live ? 'running' : j.outcome.state === 'succeeded' ? 'ok' : j.outcome.state === 'failed' ? 'failed' : j.outcome.state === 'stopped' ? 'stopped' : j.outcome.state === 'no change' ? 'ok' : 'unknown';
    const rc = j.receipt && /^sha256[:_]/.test(j.receipt) ? j.receipt : null;
    if (rc) seen.add(rc);
    const v = rc ? verify(rc) : null;
    rows.push({
      kind: 'job', id: j.id, at: j.startedAt, line: scrub(`${j.label} · ${j.live ? j.word : j.outcome.words}`), model: null, ms: j.elapsedMs,
      state: st, mark: RUN_MARK[st],
      receipt: rc ? { short: short(rc), hash: rc, verified: v?.ok === true, ...(v && !v.ok ? { why: v.reason } : {}) } : null,
      operation: j.operation ?? null, job: { id: j.id, label: scrub(j.label), ...(j.blocks ? { blocks: j.blocks } : {}), live: j.live },
    });
  }
  // the other sealed receipts of the project (an agent run, an export, a workflow receipt no job row carries)
  for (const r of chain) {
    const hash = typeof r.hash === 'string' ? r.hash : '';
    if (!hash || seen.has(hash) || chatTurnOf(r)) continue;
    const pid = (r as { project_id?: unknown }).project_id;
    if (typeof pid === 'string' && pid !== projectId(i.root)) continue;
    seen.add(hash);
    const status = typeof (r as { status?: unknown }).status === 'string' ? String((r as { status?: unknown }).status) : 'ok';
    const st: RunRow['state'] = status === 'ok' || status === 'completed' ? 'ok' : status === 'cancelled' || status === 'stopped' ? 'stopped' : status === 'failed' ? 'failed' : 'unknown';
    const v = verify(hash);
    const ms = (r as { ms?: unknown }).ms;
    const model = (r as { model_resolved?: unknown; model_requested?: unknown });
    rows.push({
      kind: 'receipt', id: short(hash), at: r.ts, line: scrub(`${r.kind} · ${r.subject}`), model: typeof model.model_resolved === 'string' ? model.model_resolved : typeof model.model_requested === 'string' ? model.model_requested : null,
      ms: typeof ms === 'number' && Number.isFinite(ms) ? ms : null, state: st, mark: RUN_MARK[st],
      receipt: { short: short(hash), hash, verified: v.ok, ...(v.ok ? {} : { why: v.reason }) },
      operation: typeof (r as { operation_id?: unknown }).operation_id === 'string' ? String((r as { operation_id?: unknown }).operation_id) : null,
    });
  }
  // what runs now first, then newest first
  const live = (r: RunRow): number => (r.state === 'running' ? 1 : 0);
  rows.sort((a, b) => live(b) - live(a) || b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  return { schema: RUNS_LIST_SCHEMA, at: new Date(i.now ?? Date.now()).toISOString(), project: { name: i.name }, total: rows.length, running: rows.filter((r) => r.state === 'running').length, rows: rows.slice(0, limit), notes };
}

function mountRunsPanel(app: express.Express, ctx: PanelContext): void {
  app.get(RUNS_PANEL.list, ctx.withToken, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const project = ctx.projectFor(req);
    if (!project) { res.status(404).json({ ok: false, error: ctx.projectUnknown }); return; }
    try {
      const limit = Number(req.query.limit);
      const answer = await readRunsList({ root: project.root, name: project.name, env: { ...ctx.env }, ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}) });
      res.json({ ok: true, ...answer });
    } catch { res.status(500).json({ ok: false, error: RUNS_FAILED }); }
  });
}

// ── R11 round 7 (H169): Workflows ────────────────────────────────────────────────────────────────────────────────────────
//
// GET /api/panel/workflows/docs?project=<id>   the project's workflow documents as the terminal Workbench reads them
// (src/workbench/state.ts readWorkflows: each document's named blocks with their state in the board's words — not run yet,
// running, ran, failed… — from the job store and the runs chain), whether the runner (upmd) is on this computer, the runs
// that run now, and the NEXT ACTION in words with the terminal's command (a run starts in the terminal Workbench or the REPL:
// this page starts none). The schema is timmy.workflows/1.

export const WORKFLOWS_PANEL = { docs: '/api/panel/workflows/docs' } as const;
export const WORKFLOWS_SCHEMA = 'timmy.workflows/1' as const;
const WORKFLOWS_FAILED = 'The Workflows panel could not read what this request needs, so it answers with nothing. The companion is still running.';

export interface WorkflowsAnswer {
  schema: typeof WORKFLOWS_SCHEMA;
  at: string;
  project: { name: string };
  /** the runner (upmd) found on this computer's PATH: without it no block runs anywhere */
  upmd: boolean;
  docs: Array<{ rel: string; title?: string; error?: string; repeated: string[]; blocks: Array<{ key: string; name: string; lang: string; needs: string[]; word: string; glyph: string; detail: string; run?: string; order: string[]; missing?: string[] }> }>;
  /** the runs that run now (the job store's live jobs of this project) */
  running: Array<{ id: string; label: string; operation: string | null; elapsed: string; word: string }>;
  /** the one next action: run a block (the terminal's command), open the newest run, or make a workflow from the starter */
  next: { kind: 'run' | 'open' | 'create' | 'install'; words: string; command?: string; operation?: string };
  notes: string[];
}

export async function readWorkflowsAnswer(i: { root: string; name: string; env: Record<string, string | undefined>; now?: number; onPath?: (cmd: string) => string | null }): Promise<WorkflowsAnswer> {
  const [{ JobManager }, state] = await Promise.all([import('../jobs/index.js'), import('../workbench/state.js')]);
  const notes: string[] = [];
  const chain = runsChainOf(i.root, i.env);
  const jobsDir = join(timmyHome(i.env), 'jobs');
  let records: JobRecord[] = [];
  try { records = existsSync(jobsDir) ? new JobManager({ dir: jobsDir }).list() : []; } catch (e) { notes.push(`The job store could not be read (${msgOf(e)}): no run is shown from it`); }
  let files: string[] = [];
  try { files = state.readFiles(i.root).groups.flatMap((g) => g.files.map((f) => f.rel)); } catch (e) { notes.push(`The project's files could not be listed: ${msgOf(e)}`); }
  const own = records.filter((j) => sameRoot(j.root, i.root));
  const wf = state.readWorkflows(i.root, { jobs: own, chain, files, env: i.env, ...(i.onPath ? { onPath: i.onPath } : {}) });
  let jobs: ReturnType<typeof state.readJobs> = [];
  try { jobs = state.readJobs(records, i.root, { mine: new Set(), chain }); } catch { jobs = []; }
  const scrub = (s: string): string => scrubHomes(s.split(i.root).join('.'), i.env as NodeJS.ProcessEnv);
  const running = jobs.filter((j) => j.live).map((j) => ({ id: j.id, label: scrub(j.label), operation: j.operation ?? null, elapsed: j.elapsed, word: j.word }));
  const docs: WorkflowsAnswer['docs'] = wf.docs.map((d) => ({
    rel: d.rel, ...(d.title ? { title: d.title } : {}), ...(d.error ? { error: d.error } : {}), repeated: d.repeated,
    blocks: d.blocks.map((b) => ({ key: b.key, name: b.name, lang: b.lang, needs: b.needs, word: b.word, glyph: b.glyph, detail: scrub(b.detail), ...(b.run ? { run: b.run } : {}), order: b.order, ...((b as { missing?: string[] }).missing?.length ? { missing: (b as { missing?: string[] }).missing } : {}) })),
  }));
  // the next action, one: a run under way → open it; a block not run yet → run it (the terminal's command); nothing → the starter
  const newest = jobs.filter((j) => !j.live).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const firstNotRun = docs.flatMap((d) => d.blocks.map((b) => ({ d, b }))).find((x) => x.b.word === 'not run yet' && !x.d.error);
  const next: WorkflowsAnswer['next'] = running.length
    ? { kind: 'open', words: `Open the run under way: ${running[0].label}`, ...(running[0].operation ? { operation: running[0].operation } : {}) }
    : !wf.upmd && docs.length
      ? { kind: 'install', words: 'The runner (upmd) is not on this computer: no block runs until it is. Timmy\'s setup says how (timmy doctor).', command: 'timmy doctor' }
      : firstNotRun
        ? { kind: 'run', words: `Run ${firstNotRun.d.rel} › ${firstNotRun.b.name} in the terminal (the Workbench's R, or the REPL)`, command: `/run ${firstNotRun.d.rel} ${firstNotRun.b.name}` }
        : newest && newest.operation
          ? { kind: 'open', words: `Open the newest run: ${scrub(newest.label)}`, operation: newest.operation }
          : docs.length
            ? { kind: 'run', words: `Run a block again in the terminal (the Workbench's R, or the REPL's /run <document> <block>)`, command: `/run ${docs[0].rel} ${docs[0].blocks[0]?.name ?? '<block>'}` }
            : { kind: 'create', words: 'No workflow document in this project yet. A workflow is a Markdown file with named blocks (```bash [name:build]); the tray-workflow starter makes a project with one.', command: '/project new <name> --from tray-workflow' };
  return { schema: WORKFLOWS_SCHEMA, at: new Date(i.now ?? Date.now()).toISOString(), project: { name: i.name }, upmd: wf.upmd, docs, running, next, notes };
}

const sameRoot = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

function mountWorkflowsPanel(app: express.Express, ctx: PanelContext): void {
  app.get(WORKFLOWS_PANEL.docs, ctx.withToken, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const project = ctx.projectFor(req);
    if (!project) { res.status(404).json({ ok: false, error: ctx.projectUnknown }); return; }
    try {
      const answer = await readWorkflowsAnswer({ root: project.root, name: project.name, env: { ...ctx.env } });
      res.json({ ok: true, ...answer });
    } catch { res.status(500).json({ ok: false, error: WORKFLOWS_FAILED }); }
  });
}
