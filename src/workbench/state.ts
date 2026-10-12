/**
 * R4 (H110): what the terminal Workbench shows, read from the records that exist, through the readers the REPL, the board and
 * Timmy Studio already use (one reading of each thing for every surface):
 *
 *   project      the shared active-project record (<TIMMY_HOME>/state/active-project.json, src/project): the REPL, the monitor
 *                and Timmy Studio follow the same record
 *   files        listProjectFiles and its roles, named here as kinds: editable source, references, workflows, results, run records
 *   workflows    each workflow document's named blocks with their states in the board's own words (connectWorkflow)
 *   jobs         the job store /jobs reads (<TIMMY_HOME>/jobs), each job as Timmy judged it (src/room/judge.ts), never by its
 *                exit alone; its outcome in src/ops/outcome.ts's words (a run that changed nothing says no change)
 *   decisions    what waits on a person (src/room/decisions.ts), as the Control Room shows it
 *   route        where a chat message would go, in the words the REPL's header and the monitor's top line use
 *
 * Nothing here runs, seals or writes. A record that cannot be read is said to be unreadable, with why; nothing is guessed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { localRouteWords, resolveChatRoute } from '../agent/chat-route.js';
import { ConversationManager } from '../agent/conversation.js';
import type { JobRecord } from '../jobs/index.js';
import { listNativeRuns } from '../native/index.js';
import { jobOutcome } from '../ops/outcome.js';
import {
  listProjectFiles, listProjects, projectId, readActiveProject, readProjectFile, sameFolder, type ActiveProject, type FileRole, type ProjectFile,
} from '../project/index.js';
import { waitingApprovals } from '../repl/approvals.js';
import { workflowForBoard } from '../repl/board-nodes.js';
import { connectWorkflow, NODE_GLYPH, type NodeWord } from '../repl/board-workflows.js';
import { gatherDecisions, type DecisionsView } from '../room/decisions.js';
import { jobJudgement, judgeIndex, type JobMark } from '../room/judge.js';
import type { RoomTools } from '../room/index.js';
import { chatRoute } from '../setup/questions.js';
import { tildePath, scrubHomes } from '../utils/home-scrub.js';
import { timmyHome } from '../setup/home.js';
import { modelKeySource } from '../utils/model-key.js';
import { readChain, type Receipt } from '../utils/receipts.js';
import { VOX_DIR, VOX_ID } from '../vox/record.js';
import { blockCount } from '../workflows/block-count.js';
import { findUpmd, findWorkflowDocs } from '../workflows/upmd.js';
import { FAMILY_APPS, GROUP_LABEL, NAV, type WorkspaceId } from './nav.js';
import { took } from './text.js';

type Env = Record<string, string | undefined>;

// ── the project ────────────────────────────────────────────────────────────────

export interface ProjectView {
  name: string;
  root: string;
  /** the folder as a person reads it (the home folder as ~) */
  shown: string;
  /** chosen in a surface (the shared record names it); false: this folder, nothing chosen yet */
  chosen: boolean;
  id: string;
}

export const projectView = (p: ActiveProject, env: Env = process.env): ProjectView => ({ name: p.name, root: p.root, shown: tildePath(p.root, env as NodeJS.ProcessEnv), chosen: p.chosen, id: projectId(p.root) });

/** The project the shared record names (else the folder Timmy was started in). */
export const activeProject = (cwd: string = process.cwd(), env: Env = process.env): ProjectView => projectView(readActiveProject(cwd), env);

export interface ProjectChoice { name: string; root: string; shown: string; changedMs: number; active: boolean }

/** The projects under the Timmy home, the most recently changed first. */
export function projectChoices(active: ProjectView, env: Env = process.env): ProjectChoice[] {
  const rows = listProjects().map((p) => {
    let changedMs = 0;
    try { changedMs = statSync(p.root).mtimeMs; } catch { /* gone meanwhile */ }
    return { ...p, shown: tildePath(p.root, env as NodeJS.ProcessEnv), changedMs, active: sameFolder(p.root, active.root) };
  });
  return rows.sort((a, b) => b.changedMs - a.changedMs || a.name.localeCompare(b.name));
}

// ── files ──────────────────────────────────────────────────────────────────────

export type FileKind = 'source' | 'workflow' | 'reference' | 'results' | 'records' | 'other';

/** The kinds as the operator's direction names them (PROJECT-WORKSPACE-CONTRACT §3), over src/project's roles. */
export const KIND_OF_ROLE: Readonly<Record<FileRole, FileKind>> = {
  source: 'source', script: 'source', workflow: 'workflow', reference: 'reference', output: 'results', history: 'records', other: 'other',
};
export const KIND_TITLE: Readonly<Record<FileKind, string>> = {
  source: 'Editable source', workflow: 'Workflows', reference: 'References', results: 'Results', records: 'Run records', other: 'Other',
};
export const KIND_WORD: Readonly<Record<FileKind, string>> = {
  source: 'editable source', workflow: 'workflow', reference: 'reference', results: 'result', records: 'run record', other: 'other',
};
export const KIND_ORDER: readonly FileKind[] = ['source', 'workflow', 'reference', 'results', 'records', 'other'];

export interface FileRow extends ProjectFile { kind: FileKind }
export interface FilesView { total: number; truncated: boolean; groups: Array<{ kind: FileKind; title: string; files: FileRow[] }> }

export function readFiles(root: string): FilesView {
  const { files, truncated } = listProjectFiles(root);
  const rows: FileRow[] = files.map((f) => ({ ...f, kind: KIND_OF_ROLE[f.role] }));
  return {
    total: rows.length, truncated,
    groups: KIND_ORDER.map((kind) => ({ kind, title: KIND_TITLE[kind], files: rows.filter((f) => f.kind === kind) })).filter((g) => g.files.length),
  };
}

// ── workflows ──────────────────────────────────────────────────────────────────

export interface BlockRow {
  doc: string;
  /** upmd's block number, or a place when the document gives none */
  key: string;
  name: string;
  lang: string;
  needs: string[];
  /** its state in the board's words */
  word: NodeWord;
  glyph: string;
  /** after the state: its exit code and own time */
  detail: string;
  /** the job its state comes from */
  run?: string;
  /** what a run of it runs: the blocks it needs first, then it */
  order: string[];
  /** needed blocks the document does not have */
  missing: string[];
  cycle?: string[];
  /** the blocks of its run whose command is a destructive shell command: a person decides before it runs (NEEDS YOU) */
  risky: Array<{ name: string; command: string }>;
  command?: string;
}

export interface WorkflowDoc {
  rel: string;
  title?: string;
  blocks: BlockRow[];
  /** names more than one block carries: /run runs none of them */
  repeated: string[];
  /** why the document could not be read whole */
  error?: string;
}

export interface WorkflowsView { upmd: boolean; docs: WorkflowDoc[] }

export function readWorkflows(root: string, o: { jobs: readonly JobRecord[]; chain: readonly Receipt[]; files: readonly string[]; env?: Env; onPath?: (cmd: string) => string | null }): WorkflowsView {
  const env = o.env ?? process.env;
  const upmd = findUpmd(env as NodeJS.ProcessEnv, o.onPath ?? (() => null)) !== null;
  const docs: WorkflowDoc[] = [];
  for (const d of findWorkflowDocs(root)) {
    const r = readProjectFile(root, d.rel, 1024 * 1024);
    if (!r.ok || r.binary || r.text === undefined || r.truncated) {
      docs.push({ rel: d.rel, blocks: [], repeated: [], error: r.ok ? 'it is not Markdown Timmy can read whole' : r.error });
      continue;
    }
    try {
      const view = connectWorkflow(workflowForBoard(r.rel, { text: r.text, ...(r.sha256 ? { sha256: r.sha256 } : {}) }), {
        root, jobs: o.jobs, chain: o.chain, files: o.files, upmd, scrub: (t) => scrubHomes(t.split(root).join('.'), env as NodeJS.ProcessEnv),
      });
      const c = view.connected;
      const title = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(r.text)?.[1];
      docs.push({
        rel: r.rel, ...(title ? { title } : {}), repeated: (c?.repeated ?? []).map((x) => x.name),
        blocks: view.blocks.map((b, i) => {
          const n = c?.nodes[i];
          const word: NodeWord = n?.word ?? 'not run yet';
          return {
            doc: r.rel, key: n?.key ?? String(b.index ?? i + 1), name: b.name, lang: b.lang ?? '', needs: [...b.deps], word, glyph: NODE_GLYPH[word], detail: n?.detail ?? '',
            ...(n?.run ? { run: n.run } : {}), order: n?.order ?? [b.name], missing: n?.missing ?? [], ...(n?.cycle ? { cycle: n.cycle } : {}), risky: n?.risky ?? [],
            ...(n?.command !== undefined ? { command: n.command } : {}),
          };
        }),
      });
    } catch (e) {
      docs.push({ rel: r.rel, blocks: [], repeated: [], error: `its blocks could not be read: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return { upmd, docs };
}

// ── jobs ───────────────────────────────────────────────────────────────────────

/** Who started a job, as far as this Workbench can tell without stopping anything. */
export type JobOwner = 'workbench' | 'live-session' | 'ended-session' | 'unknown';

export interface JobRow {
  id: string;
  label: string;
  kind: JobRecord['kind'];
  /** the record's own state */
  state: JobRecord['state'];
  /** Timmy's judgement: its mark and word (src/room/judge.ts), never the exit alone */
  mark: JobMark;
  word: string;
  /** the judge's words, when a record judged it */
  why: string;
  /** how an operation counts it (src/ops/outcome.ts): succeeded, failed, stopped, no change, running, unknown */
  outcome: { state: string; words: string };
  live: boolean;
  stale: boolean;
  startedAt: string;
  endedAt?: string;
  elapsedMs: number | null;
  elapsed: string;
  operation?: string;
  receipt?: string;
  /** a workflow run's blocks, counted once */
  blocks?: string;
  owner: JobOwner;
  ownerWords: string;
  steps: JobRecord['steps'];
  exitCode?: number | null;
  error?: string;
  note?: string;
}

const LIVE = new Set(['queued', 'running', 'ready']);
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export function jobRow(j: JobRecord, o: { mine: ReadonlySet<string>; judge?: ReturnType<typeof judgeIndex>; now?: number }): JobRow {
  const r = jobJudgement(j, o.judge);
  const live = LIVE.has(j.state) && !j.stale;
  const end = j.endedAt ? Date.parse(j.endedAt) : (o.now ?? Date.now());
  const start = Date.parse(j.startedAt);
  const elapsedMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
  let owner: JobOwner = 'unknown';
  let ownerWords = 'its record does not name the session that started it';
  if (o.mine.has(j.id)) { owner = 'workbench'; ownerWords = 'started by this Workbench'; }
  else if (j.owner) {
    const alive = j.owner.pid === process.pid || pidAlive(j.owner.pid);
    owner = alive ? 'live-session' : 'ended-session';
    ownerWords = alive ? `started by another Timmy session (pid ${j.owner.pid}), which is still running` : `started by a Timmy session that has ended (pid ${j.owner.pid})`;
  }
  const count = j.kind === 'workflow' ? blockCount(j, { ...(j.expected?.steps ? { order: j.expected.steps } : {}) }) : undefined;
  const out = jobOutcome(j);
  return {
    id: j.id, label: j.label, kind: j.kind, state: j.state, mark: r.mark, word: r.word, why: r.why ?? '', outcome: { state: out.state, words: out.words },
    live, stale: j.stale === true, startedAt: j.startedAt, ...(j.endedAt ? { endedAt: j.endedAt } : {}), elapsedMs, elapsed: took(elapsedMs),
    ...(j.operation ? { operation: j.operation } : {}), ...(j.receipt ? { receipt: j.receipt } : {}), ...(count ? { blocks: count.words } : {}),
    owner, ownerWords, steps: j.steps, ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}), ...(j.error ? { error: j.error } : {}), ...(j.note ? { note: j.note } : {}),
  };
}

/** This project's jobs, newest first, each judged. */
export function readJobs(all: readonly JobRecord[], root: string, o: { mine: ReadonlySet<string>; chain: readonly Receipt[] }): JobRow[] {
  const mine = all.filter((j) => sameFolder(j.root, root));
  let judge: ReturnType<typeof judgeIndex> | undefined;
  try { judge = judgeIndex({ root, chain: o.chain, projectId: projectId(root) }); } catch { judge = undefined; }
  return mine.map((j) => jobRow(j, { mine: o.mine, ...(judge ? { judge } : {}) }));
}

// ── activity ───────────────────────────────────────────────────────────────────

export interface ActivityEvent {
  at: string;
  words: string;
  job?: string;
  operation?: string;
  /** a decision waits on a person */
  attention?: boolean;
  failed?: boolean;
}

export interface ActivityView {
  running: number;
  waiting: number;
  last: ActivityEvent | null;
  /** newest first */
  events: ActivityEvent[];
}

/** Each job's start, each block's start and end, and the job's end, from the records themselves (newest first). */
export function jobEvents(rows: readonly JobRow[], max = 60): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const j of rows.slice(0, 24)) {
    const op = j.operation ? { operation: j.operation } : {};
    out.push({ at: j.startedAt, job: j.id, ...op, words: `${j.id} started: ${j.label}` });
    for (const s of j.steps) {
      if (s.startedAt) out.push({ at: s.startedAt, job: j.id, ...op, words: `${j.id} ${s.name} started` });
      if (s.endedAt) out.push({ at: s.endedAt, job: j.id, ...op, words: `${j.id} ${s.name} ${s.outcome ?? s.state}${s.code !== undefined ? ` (exit ${s.code})` : ''}`, ...(s.state === 'failed' && !s.outcome ? { failed: true } : {}) });
    }
    if (j.endedAt) out.push({ at: j.endedAt, job: j.id, ...op, words: `${j.id} ${j.word}${j.blocks ? `: ${j.blocks}` : ''}${j.error ? `: ${j.error}` : ''}`, ...(j.mark === 'failed' ? { failed: true } : {}) });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, max);
}

export function activityOf(rows: readonly JobRow[], waiting: number, extra: readonly ActivityEvent[] = []): ActivityView {
  const events = [...extra, ...jobEvents(rows)].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 80);
  return { running: rows.filter((j) => j.live).length, waiting, last: events[0] ?? null, events };
}

/** The job Stop current names: this Workbench's newest live job first, else the project's newest live job; null: idle. */
export function stopTarget(rows: readonly JobRow[]): JobRow | null {
  const live = rows.filter((j) => j.live);
  return live.find((j) => j.owner === 'workbench') ?? live[0] ?? null;
}

// ── the chat route ─────────────────────────────────────────────────────────────

export interface RouteView {
  kind: 'openrouter' | 'local';
  /** the words the REPL's header and the monitor's top line use */
  words: string;
  /** a message could be sent on this route now (a key, or a local model chosen); not whether it would be answered */
  ready: boolean;
}

export function readRoute(env: Env = process.env, cwd: string = process.cwd()): RouteView {
  try {
    const r = resolveChatRoute({ env });
    if (r.kind === 'local') return { kind: 'local', words: localRouteWords(r), ready: !('error' in r.at) && !!r.model };
    const key = modelKeySource(env, cwd) !== null;
    return { kind: 'openrouter', words: chatRoute({ key }), ready: key };
  } catch (e) {
    return { kind: 'openrouter', words: `chat: unknown (${e instanceof Error ? e.message : String(e)})`, ready: false };
  }
}

// ── what waits on a person ─────────────────────────────────────────────────────

export function readDecisions(root: string, jobs: readonly JobRecord[], chain: readonly Receipt[], tools?: RoomTools, env: Env = process.env): DecisionsView {
  try {
    return gatherDecisions({
      root, projectId: projectId(root), jobs: jobs.filter((j) => sameFolder(j.root, root)), chain, approvals: waitingApprovals(),
      ...(tools ? { tools } : {}), scrub: (t) => scrubHomes(t.split(root).join('.'), env as NodeJS.ProcessEnv),
    });
  } catch (e) {
    return { items: [], more: 0, total: 0, otherSetup: 0, tools: {}, operations: {}, notes: [`What waits on you could not be read: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

// ── the project's last conversation ────────────────────────────────────────────

export interface ChatTail { session: string | null; total: number; messages: Array<{ role: string; text: string; at?: number }>; error?: string }

/** The newest conversation kept in the project (.sessions, as the REPL keeps it), its last few turns. Reads only. */
export function readChatTail(root: string, max = 6): ChatTail {
  try {
    const conv = new ConversationManager(join(root, '.sessions'));
    const sessions = conv.listSessions();
    if (!sessions.length) return { session: null, total: 0, messages: [] };
    const all = conv.load(sessions[0]);
    const shown = all.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-max).map((m) => ({ role: m.role, text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content), ...(typeof m.timestamp === 'number' ? { at: m.timestamp } : {}) }));
    return { session: sessions[0], total: all.length, messages: shown };
  } catch (e) {
    return { session: null, total: 0, messages: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// ── each tool workspace's records in this project ──────────────────────────────

export interface RecordRow { id: string; what: string; state: string; at: string; record: string; operation?: string }

/** The project's VoxVision records (results/vox/v*.json), newest first: their action, status, first input and time. */
export function readVoxRecords(root: string, max = 12): RecordRow[] {
  const dir = join(root, VOX_DIR);
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => VOX_ID.test(n.replace(/\.json$/, '')) && n.endsWith('.json')); } catch { return []; }
  const rows: RecordRow[] = [];
  for (const n of names) {
    const rel = `${VOX_DIR}/${n}`;
    try {
      const v = JSON.parse(readFileSync(join(dir, n), 'utf8')) as { id?: unknown; action?: unknown; status?: unknown; made_at?: unknown; inputs?: Array<{ rel?: unknown; path?: unknown }>; operation?: unknown };
      const input = v.inputs?.[0];
      const name = typeof input?.rel === 'string' ? input.rel : typeof input?.path === 'string' ? input.path : 'its input';
      rows.push({ id: String(v.id ?? n.replace(/\.json$/, '')), what: `${String(v.action ?? 'action')} ${name}`, state: String(v.status ?? 'unknown'), at: String(v.made_at ?? ''), record: rel, ...(typeof v.operation === 'string' ? { operation: v.operation } : {}) });
    } catch (e) {
      rows.push({ id: n.replace(/\.json$/, ''), what: 'unreadable record', state: e instanceof Error ? e.message : 'unreadable', at: '', record: rel });
    }
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, max);
}

/** The project's native runs of the apps a workspace gathers (.timmy/native), newest first, with their newest verdict. */
export function readNativeRows(root: string, ws: WorkspaceId, max = 12): RecordRow[] {
  const apps = FAMILY_APPS[ws];
  if (!apps) return [];
  let runs: ReturnType<typeof listNativeRuns> = [];
  try { runs = listNativeRuns(root); } catch { return []; }
  return runs.filter((r) => apps.includes(r.app)).slice(0, max).map((r) => {
    const last = r.verdicts.at(-1) as { outcome?: unknown; why?: unknown } | undefined;
    return { id: r.run.slice(0, 8), what: `${r.app} run`, state: last ? `${String(last.outcome ?? 'judged')}${typeof last.why === 'string' && last.why ? `: ${last.why}` : ''}` : 'not judged', at: r.started_at, record: `.timmy/native/${r.run}` };
  });
}

/**
 * The runs chain where this process's seals for the project go (appendReceipt with no folder, after the Workbench has moved
 * into the project, as the REPL does): TIMMY_STORE when it is set, else the project's own store (its pin, else its folder's).
 */
export function chainOf(root: string, env: Env = process.env): Receipt[] {
  try { return env.TIMMY_STORE ? readChain('runs') : readChain('runs', root); } catch { return []; }
}

// ── the state model (`timmy workbench --json`) ─────────────────────────────────

export const STATE_SCHEMA = 'timmy.workbench/1';

export interface WorkbenchJson {
  schema: typeof STATE_SCHEMA;
  at: string;
  project: ProjectView;
  navigation: Array<{ group: string; items: Array<{ id: WorkspaceId; label: string; title: string; waiting?: number }> }>;
  activity: { running: number; waiting_on_you: number; last: ActivityEvent | null; stop_current: { job: string | null; words: string } };
  route: RouteView;
  files: { total: number; truncated: boolean; by_kind: Record<string, number> };
  workflows: { upmd: boolean; docs: Array<{ rel: string; blocks: Array<{ name: string; state: string; needs: string[]; needs_person: boolean }> }> };
  jobs: Array<{ id: string; label: string; state: string; judged: string; outcome: string; operation: string | null; elapsed: string; owner: string }>;
}

export interface StateDeps {
  env?: Env;
  cwd?: string;
  /** where job records are (<TIMMY_HOME>/jobs) */
  jobsDir?: string;
  onPath?: (cmd: string) => string | null;
  /** the job records (a test's); absent: read from jobsDir through the job store */
  jobs?: () => JobRecord[];
  chain?: () => Receipt[];
}

/** The shell's state model: what `timmy workbench --json` prints and what the app starts from. Reads only. */
export async function workbenchJson(d: StateDeps = {}): Promise<WorkbenchJson> {
  const env = d.env ?? process.env;
  const cwd = d.cwd ?? process.cwd();
  const project = activeProject(cwd, env);
  const jobsDir = d.jobsDir ?? join(timmyHome(env), 'jobs');
  let records: JobRecord[] = [];
  if (d.jobs) records = d.jobs();
  else if (existsSync(jobsDir)) {
    const { JobManager } = await import('../jobs/index.js');
    try { records = new JobManager({ dir: jobsDir }).list(); } catch { records = []; }
  }
  let chain: Receipt[] = [];
  try { chain = d.chain ? d.chain() : chainOf(project.root, env); } catch { chain = []; }
  const rows = readJobs(records, project.root, { mine: new Set(), chain });
  const decisions = readDecisions(project.root, records, chain, undefined, env);
  const files = readFiles(project.root);
  const wf = readWorkflows(project.root, { jobs: records.filter((j) => sameFolder(j.root, project.root)), chain, files: files.groups.flatMap((g) => g.files.map((f) => f.rel)), env, ...(d.onPath ? { onPath: d.onPath } : {}) });
  const act = activityOf(rows, decisions.total);
  const stop = stopTarget(rows);
  const groups = [...new Set(NAV.map((n) => n.group))];
  return {
    schema: STATE_SCHEMA, at: new Date().toISOString(), project,
    navigation: groups.map((g) => ({ group: GROUP_LABEL[g] || 'FOOT', items: NAV.filter((n) => n.group === g).map((n) => ({ id: n.id, label: n.label, title: n.title, ...(n.id === 'control' ? { waiting: decisions.total } : {}) })) })),
    activity: { running: act.running, waiting_on_you: act.waiting, last: act.last, stop_current: { job: stop?.id ?? null, words: stop ? `Stop current: ${stop.id} ${stop.label}` : 'Stop current: idle' } },
    route: readRoute(env, cwd),
    files: { total: files.total, truncated: files.truncated, by_kind: Object.fromEntries(files.groups.map((g) => [g.kind, g.files.length])) },
    workflows: { upmd: wf.upmd, docs: wf.docs.map((doc) => ({ rel: doc.rel, blocks: doc.blocks.map((b) => ({ name: b.name, state: b.word, needs: b.needs, needs_person: b.risky.length > 0 })) })) },
    jobs: rows.slice(0, 20).map((j) => ({ id: j.id, label: j.label, state: j.state, judged: j.word, outcome: j.outcome.words, operation: j.operation ?? null, elapsed: j.elapsed, owner: j.ownerWords })),
  };
}
