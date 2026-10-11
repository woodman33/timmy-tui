/**
 * Round R4 (helper H78): what God's Eye View reads, and from where. Every part comes through the reader that already
 * exists for it (the board's, the Control Room's, Waiting on you's, VoxVision's, Memory's and the review's), and a caller
 * that has read a part already (the REPL's board, every 2 s) gives it, so nothing is read twice. Each part is read inside
 * its own guard: a part that cannot be read is kept as its error, and its section says "unknown" with why; nothing here
 * runs, writes, seals or contacts anything, and no tree is walked beyond the existing readers' own bounds (2,000 project
 * files; 50 workflow documents; the newest flow and VoxVision records).
 */
import fs from 'node:fs';
import path from 'node:path';
import { listAgentRuns, scrubPaths, type AgentRunRecord } from '../code-agents/index.js';
import type { JobRecord } from '../jobs/index.js';
import { readBoardMemory, type BoardMemory } from '../memory/board.js';
import { annotateRoom, buildIndex, operationCard, recentOperations, type OpIndex } from '../ops/card.js';
import { listProjectFiles, projectId, readProjectFile, type ProjectFile } from '../project/index.js';
import { paramsCard } from '../repl/board-cards.js';
import type { BoardCanvas } from '../repl/board-canvas.js';
import { readBoardFlows, type BoardFlows } from '../repl/board-flows.js';
import { workflowForBoard, type WorkflowDocInput } from '../repl/board-nodes.js';
import { readBoardVox, type BoardVox } from '../repl/board-vox.js';
import { connectWorkflow } from '../repl/board-workflows.js';
import { reviewView, type ReviewView } from '../review/changes.js';
import type { BoardReview } from '../review/html.js';
import { gatherDecisions, markWaiting, type DecisionsView } from '../room/decisions.js';
import { gatherRoom, type RoomRun, type RoomTools, type RoomView } from '../room/index.js';
import { readProjectJobs, readRunsChain } from '../studio/project-cards.js';
import type { Receipt } from '../utils/receipts.js';
import { findWorkflowDocs } from '../workflows/upmd.js';

/** What a caller has read already (the REPL's board data), given so that nothing is read twice. */
export interface OverviewGiven {
  /** this project's job records, newest first (its own and earlier sessions') */
  jobs?: readonly JobRecord[];
  chain?: readonly Receipt[];
  /** why the runs chain could not be read (the chain given is then empty) */
  chainError?: string;
  files?: readonly ProjectFile[];
  filesTruncated?: boolean;
  /** the board's workflow documents, each connected to its runs (connectWorkflow) */
  workflows?: readonly WorkflowDocInput[];
  /** how many documents the board left off */
  workflowsMore?: number;
  flows?: BoardFlows;
  /** the Control Room's view, with its decisions and operation cards */
  room?: RoomView;
  ix?: OpIndex;
  vox?: BoardVox;
  memory?: BoardMemory;
  review?: BoardReview;
  /** what the REPL found of Timmy Canvas */
  canvas?: BoardCanvas;
  /** the flows this REPL runs */
  activeFlows?: readonly string[];
  /** the /tools rows as the Control Room last checked them */
  tools?: RoomTools;
  /** when the caller read these (ISO); default now */
  readAt?: string;
}

export interface OverviewOptions {
  /** the project's name (default: its folder's name) */
  name?: string;
  /** the jobs folder the REPL keeps its job records in (<TIMMY_HOME>/jobs); null or absent: none named */
  jobsDir?: string | null;
  /** the receipts store the REPL seals to (its runs.jsonl is read); null or absent: none named */
  store?: string | null;
  /** for Timmy Canvas's folder and port and VoxVision's tools (default: this process's environment) */
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** the project's folder written as "." and the home folder as "~" (default: scrubPaths) */
  scrub?: (t: string) => string;
  given?: OverviewGiven;
}

/** A part read, or why it could not be. */
export type Part<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Part<T> => ({ ok: true, value });
const fail = <T>(error: string): Part<T> => ({ ok: false, error });
export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface Sources {
  root: string;
  name: string;
  pid: string;
  now: number;
  asOf: string;
  scrub: (t: string) => string;
  env: Record<string, string | undefined>;
  /** read outside a REPL: what only a REPL holds (NEEDS YOU boxes, refused board saves, its own flows) is not known */
  standalone: boolean;
  jobs: Part<readonly JobRecord[]> & { named: boolean };
  jobMap: ReadonlyMap<string, JobRecord>;
  chain: Part<readonly Receipt[]> & { named: boolean };
  /** the chain as read (empty when it could not be) */
  receipts: readonly Receipt[];
  files: Part<{ list: readonly ProjectFile[]; truncated: boolean }>;
  flows: Part<BoardFlows>;
  ix: Part<OpIndex>;
  room: Part<RoomView>;
  decisions: Part<DecisionsView>;
  workflows: Part<{ list: readonly WorkflowDocInput[]; more: number }>;
  vox: Part<BoardVox>;
  memory: Part<BoardMemory>;
  review: Part<ReviewView>;
  /** every code agent run's own record, by run (their tasks and outcomes) */
  agentRuns: Part<ReadonlyMap<string, AgentRunRecord>>;
  canvas?: BoardCanvas;
  activeFlows: readonly string[];
  notes: string[];
}

const FLOW_RECORD = /^results\/flows\/f[0-9a-f]{8}\.json$/;

/** Reads a part inside a guard. */
function guard<T>(read: () => T): Part<T> {
  try { return ok(read()); } catch (e) { return fail(message(e)); }
}

/** The runs chain in a named store: [] when it has no runs.jsonl yet; an error when it is there and cannot be read. */
function chainOf(store: string): Part<readonly Receipt[]> {
  const file = path.join(store, 'runs.jsonl');
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return fail(`the store's runs.jsonl is not a file`);
    fs.accessSync(file, fs.constants.R_OK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return ok([]);
    return fail(`the store's runs.jsonl cannot be read (${code ?? message(e)})`);
  }
  return ok(readRunsChain(store));
}

/** Reads what God's Eye View shows, each part from what the caller gave or through its own reader. */
export function readSources(projectRoot: string, o: OverviewOptions): Sources {
  const root = path.resolve(projectRoot);
  const g = o.given ?? {};
  const now = (o.now ?? Date.now)();
  const scrub = o.scrub ?? ((t: string) => scrubPaths(t, root));
  const pid = projectId(root);
  const name = o.name ?? path.basename(root);
  const notes: string[] = [];
  const standalone = !g.room;
  const jobs = g.jobs ? { ...ok(g.jobs), named: true }
    : o.jobsDir ? { ...guard(() => readProjectJobs(o.jobsDir!, root)), named: true }
      : { ...ok<readonly JobRecord[]>([]), named: false };
  const jobList = jobs.ok ? jobs.value : [];
  const chain = g.chain ? (g.chainError ? { ...fail<readonly Receipt[]>(g.chainError), named: true } : { ...ok(g.chain), named: true })
    : o.store ? { ...chainOf(o.store), named: true }
      : { ...ok<readonly Receipt[]>([]), named: false };
  const receipts = chain.ok ? chain.value : [];
  const files = g.files ? ok({ list: g.files, truncated: g.filesTruncated === true }) : guard(() => { const l = listProjectFiles(root); return { list: l.files, truncated: l.truncated }; });
  const rels = files.ok ? files.value.list.map((f) => f.rel) : [];
  const flows = g.flows ? ok(g.flows) : guard(() => readBoardFlows(root, rels.filter((r) => FLOW_RECORD.test(r)), { receipts, projectId: pid, scrub }));
  const flowsValue = flows.ok ? flows.value : { list: [], more: 0 };
  const ix = g.ix ? ok(g.ix) : guard(() => buildIndex({ root, projectId: pid, chain: receipts, jobs: jobList, scrub }));
  const activeFlows = g.activeFlows ?? [];
  // The Control Room's view: given by the REPL (with its decisions and operation cards), or read here as the canvas does.
  const room: Part<RoomView> = g.room ? ok(g.room) : guard(() => {
    const r = gatherRoom({ root, project: name, projectId: pid, jobs: jobList, chain: receipts, flows: flowsValue, mine: () => false, activeFlows, scrub, ...(g.tools ? { tools: g.tools } : {}) });
    if (ix.ok) {
      annotateRoom(r, ix.value, jobList);
      r.view.operations = recentOperations(ix.value, 6).map((id) => operationCard(ix.value, id));
    }
    return r.view;
  });
  const decisions: Part<DecisionsView> = room.ok && room.value.decisions ? ok(room.value.decisions) : guard(() => gatherDecisions({
    root, projectId: pid, jobs: jobList, chain: receipts, flows: flowsValue, activeFlows, scrub, ...(g.tools ? { tools: g.tools } : {}),
  }));
  if (room.ok && !room.value.decisions && decisions.ok) markWaiting(room.value.operations, decisions.value);
  const workflows: Part<{ list: readonly WorkflowDocInput[]; more: number }> = g.workflows ? ok({ list: g.workflows, more: g.workflowsMore ?? 0 }) : guard(() => {
    const docs = findWorkflowDocs(root);
    const shown = docs.slice(0, 20).map((d) => {
      const r = readProjectFile(root, d.rel, 1024 * 1024);
      const view = workflowForBoard(d.rel, r.ok && r.text !== undefined && !r.truncated ? { text: r.text, ...(r.sha256 ? { sha256: r.sha256 } : {}) } : undefined);
      try { return connectWorkflow(view, { root, jobs: jobList, chain: receipts, files: rels, scrub, tray: () => paramsCard(root) }); } catch { return view; }
    });
    return { list: shown, more: Math.max(0, docs.length - shown.length) };
  });
  const vox = g.vox ? ok(g.vox) : guard(() => readBoardVox({ root, files: files.ok ? files.value.list : [], chain: receipts, projectId: pid, scrub, tools: { env: o.env ?? {}, onPath: () => null, root } }));
  const memory = g.memory ? ok(g.memory) : guard(() => readBoardMemory({ root, chain: receipts, projectId: pid, scrub }));
  const review: Part<ReviewView> = g.review ? ('error' in g.review ? fail(g.review.error) : ok(g.review)) : ix.ok ? guard(() => reviewView(ix.value, { max: 6 })) : fail(`the project's records could not be read: ${ix.ok ? '' : ix.error}`);
  const agentRuns = guard(() => new Map(listAgentRuns(root).map((r) => [r.run, r] as const)));
  if (standalone) notes.push('Read outside a REPL: a NEEDS YOU box, a save the board refused and the flows a REPL runs are held by that REPL, so they are not part of this overview.');
  if (!jobs.named) notes.push('No jobs folder was named: whether a run still runs cannot be proven here, so no run is called running.');
  return {
    root, name, pid, now, asOf: g.readAt ?? new Date(now).toISOString(), scrub, env: o.env ?? process.env, standalone,
    jobs, jobMap: new Map(jobList.map((j) => [j.id, j] as const)), chain, receipts, files, flows, ix, room, decisions, workflows, vox, memory, review, agentRuns,
    ...(g.canvas ? { canvas: g.canvas } : {}), activeFlows, notes,
  };
}

const RECORD_MAX = 1024 * 1024;
/** Why a record file its reader left out cannot be read as one, or null when it can (it was only left off a bounded list). */
export function unreadableWhy(root: string, rel: string, schema: string): string | null {
  const abs = path.join(root, rel);
  let buf: Buffer;
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return 'a symbolic link: records are read only in place';
    if (!st.isFile()) return 'not a regular file';
    if (st.size > RECORD_MAX) return `larger than ${RECORD_MAX / 1024 / 1024} MB`;
    buf = fs.readFileSync(abs);
  } catch (e) { return `it cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`; }
  let json: unknown;
  try { json = JSON.parse(buf.toString('utf8')); } catch (e) { return `not JSON (${message(e)})`; }
  const r = json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : undefined;
  if (!r) return 'not a JSON object';
  if (r.schema !== schema) return `its schema is not ${schema}`;
  return null;
}

/** The runs the Control Room's view lists for these owners: running first, then recent; and how many more it counted. */
export function roomRuns(v: RoomView, kinds: readonly string[]): { runs: RoomRun[]; more: number } {
  const groups = v.groups.filter((g) => kinds.includes(g.kind));
  return { runs: groups.flatMap((g) => [...g.running, ...g.recent]), more: groups.reduce((n, g) => n + g.more, 0) };
}
