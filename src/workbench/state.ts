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
 *   turns        R4 (H117): the project's chat turns, every surface's, from their sealed receipts (src/repl/seal.ts chatTurnOf),
 *                as the REPL's Control Room reads them; a receipt holds hashes only, so no turn's words are shown
 *
 * Nothing here runs, seals or writes. A record that cannot be read is said to be unreadable, with why; nothing is guessed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chatRouteNow } from '../agent/chat-route.js';
import { ConversationManager } from '../agent/conversation.js';
import type { JobRecord } from '../jobs/index.js';
import { listNativeRuns } from '../native/index.js';
import { jobOutcome } from '../ops/outcome.js';
import {
  listProjectFiles, listProjects, projectId, readActiveProject, readProjectFile, sameFolder, type ActiveProject, type FileRole, type ProjectFile,
} from '../project/index.js';
import { endedByRecovery } from '../repl/job-command.js';
import { workflowForBoard } from '../repl/board-nodes.js';
import { connectWorkflow, NODE_GLYPH, type NodeWord } from '../repl/board-workflows.js';
import { chatTurnOf } from '../repl/seal.js';
import type { DecisionsView } from '../room/decisions.js';
import { jobJudgement, judgeIndex, type JobMark } from '../room/judge.js';
import { shortReceipt, turnOllama, type RoomTools } from '../room/index.js';
import { tildePath, scrubHomes } from '../utils/home-scrub.js';
import { timmyHome } from '../setup/home.js';
import { loadConfig } from '../utils/config.js';
import { readChain, type Receipt } from '../utils/receipts.js';
import { VOX_DIR, VOX_ID } from '../vox/record.js';
import { blockCount } from '../workflows/block-count.js';
import { findUpmd, findWorkflowDocs } from '../workflows/upmd.js';
import { readOperationRecord } from '../ops/operations.js';
import { waitingNow } from '../ops/waiting.js';
import type { PipelineStage, PipelineView, TurnRow } from './model.js';
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
export interface FilesView {
  total: number; truncated: boolean; groups: Array<{ kind: FileKind; title: string; files: FileRow[] }>;
  /** R5 (H131): of `total`, the logs Timmy itself writes in the folder (TIMMY_LOGS) */
  timmyLogs?: number;
}

/**
 * R5 (H131; the QA round's defect 24): the logs Timmy itself writes into the folder it runs in (src/utils/logger.ts makes them,
 * empty, when it is loaded, in the working folder): they are not the project's files, so Home counts them apart. Named here,
 * not imported: loading that module makes them.
 */
export const TIMMY_LOGS: ReadonlySet<string> = new Set(['logs/timmy-tui.log', 'logs/companion.log', 'logs/browser-launcher.log', 'logs/workspace-launcher.log', 'logs/agent-events.log']);

export function readFiles(root: string): FilesView {
  const { files, truncated } = listProjectFiles(root);
  const rows: FileRow[] = files.map((f) => ({ ...f, kind: KIND_OF_ROLE[f.role] }));
  return {
    total: rows.length, truncated,
    groups: KIND_ORDER.map((kind) => ({ kind, title: KIND_TITLE[kind], files: rows.filter((f) => f.kind === kind) })).filter((g) => g.files.length),
    timmyLogs: rows.filter((f) => TIMMY_LOGS.has(f.rel)).length,
  };
}

// ── workflows ──────────────────────────────────────────────────────────────────

/** R5 (H131; the QA round's defect 18): a block's mark in the terminal, one meaning each: ▶ running and … waiting its turn (the
 *  board's ● and ○ say live and configured here); the board's own marks for every other state. The word is always beside it. */
const BLOCK_GLYPH: Partial<Record<NodeWord, string>> = { running: '▶', waiting: '…' };

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
            doc: r.rel, key: n?.key ?? String(b.index ?? i + 1), name: b.name, lang: b.lang ?? '', needs: [...b.deps], word, glyph: BLOCK_GLYPH[word] ?? NODE_GLYPH[word], detail: n?.detail ?? '',
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

/**
 * R4 (H112): a job a session left, in the words recovery uses (src/repl/recover.ts, src/repl/workflow-recover.ts,
 * src/ops/recover-operations.ts), read from its record and the process table as they are now, never decided here:
 *   left running        its record says it runs, the session that started it has ended, and its process still runs
 *   stale               its record says it runs, and no process of it runs: its session ended without recording its end
 *   ended by recovery   a later session's recovery wrote its end (JobManager endLeft), from what it found, not as it happened
 */
export type RecoveryState = 'left running' | 'stale' | 'ended by recovery';

export interface JobRow {
  id: string;
  label: string;
  /** R4 (H112): the project it runs in, by name and folder (a run keeps its own project when the view switches) */
  project: string;
  root: string;
  /** R4 (H112): recovery's words for a job a session left, with what to do */
  recovery?: { state: RecoveryState; words: string };
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
  const recovery = recoveryOf(j, { live, owner, ownerWords });
  // R4 (H112): a stale record is not judged by its own state (it says it runs, and nothing of it does): its outcome is unknown
  const mark: JobMark = j.stale ? 'unknown' : r.mark;
  const word = j.stale ? 'stale' : r.word;
  return {
    id: j.id, label: j.label, project: j.project, root: j.root, ...(recovery ? { recovery } : {}),
    kind: j.kind, state: j.state, mark, word, why: r.why ?? '', outcome: { state: out.state, words: out.words },
    live, stale: j.stale === true, startedAt: j.startedAt, ...(j.endedAt ? { endedAt: j.endedAt } : {}), elapsedMs, elapsed: took(elapsedMs),
    ...(j.operation ? { operation: j.operation } : {}), ...(j.receipt ? { receipt: j.receipt } : {}), ...(count ? { blocks: count.words } : {}),
    owner, ownerWords, steps: j.steps, ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}), ...(j.error ? { error: j.error } : {}), ...(j.note ? { note: j.note } : {}),
  };
}

/** R4 (H112): recovery's words for a job a session left (RecoveryState), or none. */
function recoveryOf(j: JobRecord, o: { live: boolean; owner: JobOwner; ownerWords: string }): JobRow['recovery'] | undefined {
  if (j.stale) {
    return { state: 'stale', words: `stale: its record says it ${j.state === 'ready' ? 'serves' : 'runs'}, and no process of it runs: the session that started it ended without recording how it ended. /recover in the REPL records it (nothing is run again).` };
  }
  if (o.live && o.owner === 'ended-session') {
    return { state: 'left running', words: `left running: ${o.ownerWords}, and its process still runs. Stop ends it through recovery's stop (only when the process table proves the group is the job's).` };
  }
  if (!o.live && endedByRecovery(j)) {
    const why = (j.error ?? j.note ?? '').replace(/\s+/g, ' ').trim();
    return { state: 'ended by recovery', words: `ended by recovery: a later session's recovery wrote its end from what it found${why ? ` (${why})` : ''}; nothing was run again.` };
  }
  return undefined;
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
  /** R4 (H112): the event's own name, the same at every reading (a selection in Activity stays on it while rows arrive) */
  key: string;
  /** R4 (H112): its order among events of the same time (a job's start before its blocks, a job's lines in the order seen) */
  seq?: number;
  job?: string;
  operation?: string;
  /** a decision waits on a person */
  attention?: boolean;
  failed?: boolean;
  /** R4 (H112): a line the job printed (its log), not an event of its record */
  output?: boolean;
}

export interface ActivityView {
  running: number;
  waiting: number;
  last: ActivityEvent | null;
  /** newest first */
  events: ActivityEvent[];
  /** R4 (H112): of `running`, how many this Workbench started in another project than the one shown, and where */
  away?: { running: number; where: string[] };
}

/** R4 (H112): the newest first; at the same time, the later in its own order first. */
export const newestFirst = (a: ActivityEvent, b: ActivityEvent): number => (Date.parse(b.at) - Date.parse(a.at)) || ((b.seq ?? 0) - (a.seq ?? 0));

/** Each job's start, each block's start and end, and the job's end, from the records themselves (newest first). A job of
 *  another project than the one shown (R4, H112: one this Workbench started) says where it runs. */
export function jobEvents(rows: readonly JobRow[], max = 60, shown?: string): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const j of rows.slice(0, 24)) {
    const op = j.operation ? { operation: j.operation } : {};
    const where = shown !== undefined && !sameFolder(j.root, shown) ? ` (in ${j.project})` : '';
    out.push({ at: j.startedAt, key: `job:${j.id}:start`, seq: 0, job: j.id, ...op, words: `${j.id} started: ${j.label}${where}` });
    j.steps.forEach((s, i) => {
      if (s.startedAt) out.push({ at: s.startedAt, key: `job:${j.id}:s${i}:start`, seq: 1 + 2 * i, job: j.id, ...op, words: `${j.id} ${s.name} started${where}` });
      if (s.endedAt) out.push({ at: s.endedAt, key: `job:${j.id}:s${i}:end`, seq: 2 + 2 * i, job: j.id, ...op, words: `${j.id} ${s.name} ${s.outcome ?? s.state}${s.code !== undefined ? ` (exit ${s.code})` : ''}${where}`, ...(s.state === 'failed' && !s.outcome ? { failed: true } : {}) });
    });
    if (j.endedAt) out.push({ at: j.endedAt, key: `job:${j.id}:end`, seq: 1e6, job: j.id, ...op, words: `${j.id} ${j.word}${j.blocks ? `: ${j.blocks}` : ''}${j.error ? `: ${j.error}` : ''}${where}`, ...(j.mark === 'failed' ? { failed: true } : {}) });
  }
  return out.sort(newestFirst).slice(0, max);
}

/** R4 (H112): the lines jobs printed, as Activity's events (src/workbench/output.ts OutputWatch keeps them as first seen). */
export function outputEvents(lines: ReadonlyArray<{ job: string; n: number; text: string; at: string; operation?: string }>, o: { where?: (job: string) => string; bar?: string } = {}): ActivityEvent[] {
  const bar = o.bar ?? '│';
  return lines.map((l) => ({ at: l.at, key: `out:${l.job}:${l.n}`, seq: l.n, job: l.job, ...(l.operation ? { operation: l.operation } : {}), words: `${l.job} ${bar} ${l.text}${o.where?.(l.job) ?? ''}`, output: true }));
}

/** How many events Activity keeps (the newest). */
export const ACTIVITY_MAX = 200;

/**
 * Activity: the records' events, the Workbench's own notices and the jobs' lines, newest first. R4 (H112): `away` is the
 * live jobs this Workbench started in another project than the one shown (`shown`, its folder): counted as running, with where.
 */
export function activityOf(rows: readonly JobRow[], waiting: number, extra: readonly ActivityEvent[] = [], o: { away?: readonly JobRow[]; shown?: string; output?: readonly ActivityEvent[] } = {}): ActivityView {
  const away = o.away ?? [];
  const events = [...extra, ...(o.output ?? []), ...jobEvents([...rows, ...away], 60, o.shown)].sort(newestFirst).slice(0, ACTIVITY_MAX);
  const awayLive = away.filter((j) => j.live);
  return {
    running: rows.filter((j) => j.live).length + awayLive.length, waiting, last: events[0] ?? null, events,
    ...(awayLive.length ? { away: { running: awayLive.length, where: [...new Set(awayLive.map((j) => j.project))] } } : {}),
  };
}

/** The job Stop current names: this Workbench's newest live job first (R4, H112: in any project), else the project's newest
 *  live job; null: idle. */
export function stopTarget(rows: readonly JobRow[], away: readonly JobRow[] = []): JobRow | null {
  const live = rows.filter((j) => j.live);
  return live.find((j) => j.owner === 'workbench') ?? away.find((j) => j.live && j.owner === 'workbench') ?? live[0] ?? null;
}

// ── the chat route ─────────────────────────────────────────────────────────────

export interface RouteView {
  kind: 'openrouter' | 'local' | 'none';
  /** the words the REPL's header and the monitor's top line use */
  words: string;
  /** a message could be sent on this route now (a key, or a local model chosen); not whether it would be answered */
  ready: boolean;
  /** R4 lead: why a message would not be sent on it (the one route's own lines), when it is not ready */
  refusal?: string[];
}

/**
 * The chat's route, read here for the Workbench's top line, Chat and Settings until its chat session is open (views.ts
 * routeShown prefers the session's own). R4 lead (2026-10-12): the one route every surface reads (src/agent/chat-route.ts
 * chatRouteNow, as the Workbench: the key looked for where the chat session looks, from this process's folder; the OpenRouter
 * model the settings name, as the session's agent has it), so these say what the session's route() says, word for word.
 */
export function readRoute(env: Env = process.env, cwd: string = process.cwd()): RouteView {
  try {
    const model = (() => { try { return loadConfig().model || null; } catch { return null; } })();
    const now = chatRouteNow({ env, cwd, openRouterModel: model, surface: 'workbench' });
    return { kind: now.state.kind, words: now.state.words, ready: now.state.ready, ...(now.state.refusal?.length ? { refusal: [...now.state.refusal] } : {}) };
  } catch (e) {
    return { kind: 'none', words: `chat: unknown (${e instanceof Error ? e.message : String(e)})`, ready: false };
  }
}

// ── what waits on a person ─────────────────────────────────────────────────────

// R6 (H140; the lead at integration): the one waiting count. The Workbench counts what every surface and process counts
// (src/ops/waiting.ts waitingNow: this process's NEEDS YOU boxes and other live processes', the recorded /tools check, and
// Studio's pending drafts), so its run line, Activity and Control Room say the same number as the companion and Studio.
export function readDecisions(root: string, jobs: readonly JobRecord[], chain: readonly Receipt[], tools?: RoomTools, env: Env = process.env): DecisionsView {
  return waitingNow({ root, jobs, chain, ...(tools ? { tools } : {}), env });
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

// ── the project's chat turns ───────────────────────────────────────────────────

/** R4 (H117): how many chat turns the Control Room lists (the newest). */
export const TURNS_SHOWN = 8;

/**
 * R4 (H117): the project's chat turns from their sealed receipts, whichever surface sent each (src/repl/seal.ts chatTurnOf:
 * the REPL's, the Workbench's, a monitor's, a companion page's), the newest first and one per receipt (the same receipt read
 * twice is one turn), as the REPL's Control Room reads them (src/room/index.ts chatRuns). A turn being answered has no receipt
 * yet and is not here. Receipts hold hashes only, and so do these rows: never a word of a prompt or an answer.
 */
export function readTurns(chain: readonly Receipt[], root: string, max = TURNS_SHOWN): TurnRow[] {
  const id = projectId(root);
  const seen = new Set<string>();
  const out: TurnRow[] = [];
  // the chain is in the order its receipts were sealed: read from its end, the newest come first
  for (let i = chain.length - 1; i >= 0 && out.length < max; i -= 1) {
    const r = chain[i];
    const turn = chatTurnOf(r);
    if (!turn || r.project_id !== id || seen.has(String(r.hash))) continue;
    seen.add(String(r.hash));
    // a receipt that records no status counts as answered, as the REPL's Control Room reads it (chatRuns)
    const status = r.status ?? 'ok';
    const model = [r.model_resolved, r.model_requested].find((m): m is string => typeof m === 'string' && m.trim() !== '') ?? null;
    const endpoint = turnOllama(r)?.endpoint;
    out.push({
      receipt: shortReceipt(r), surface: turn.surface, state: status === 'ok' ? 'answered' : status === 'cancelled' ? 'stopped' : 'failed',
      model, at: r.ts, ...(typeof r.ms === 'number' && Number.isFinite(r.ms) ? { ms: r.ms } : {}),
      operation: typeof r.operation_id === 'string' && r.operation_id ? r.operation_id : null,
      ...(endpoint === 'local' ? { local: true } : endpoint ? { local: false } : {}),
      ...(typeof r.turn_id === 'string' && r.turn_id ? { turn: r.turn_id } : {}),
      ...(typeof r.stopped_by === 'string' && r.stopped_by ? { stoppedBy: r.stopped_by } : {}),
    });
  }
  return out;
}

// ── the newest run's pipeline (the Chat tab's row) ─────────────────────────────

/**
 * R5 (H131): the project's newest run as its records say it, for the Chat tab's pipeline row (the operator's references 02 and
 * 11: intent → predict → sandbox → receipt): its operation's request (the operation record), the prediction sealed before it
 * (a `predict` receipt of the operation), what ran it (its job record; a sandbox only when a record names one), and the
 * operation's own receipt, verified here by `verify` (its chain link, body hash and signature: src/utils/receipts.ts
 * verifyReceiptIn). What no record says is said so; nothing is guessed. Reads only.
 */
export function readPipeline(root: string, rows: readonly JobRow[], chain: readonly Receipt[], verify: (hash: string) => { ok: true } | { ok: false; reason: string }, o: PipelineTurns = {}): PipelineView {
  const none = (words: string): PipelineStage => ({ state: 'not run yet', words });
  const job = rows.find((j) => j.operation);
  // R5 (H131; the QA round's defect 8): the newest operation, a chat turn too: one being answered now, else the newest of the
  // newest job's and the newest sealed turn's, by when each began
  if (o.sending?.operation) return turnPipeline(root, o.sending.operation, chain, verify, { live: true, surface: 'workbench', ...(o.sending.request ? { request: o.sending.request } : {}) });
  const turn = o.turns?.find((t) => t.operation);
  const began = (t: TurnRow): number => Date.parse(t.at) - (t.ms ?? 0);
  if (turn?.operation && (!job || began(turn) >= Date.parse(job.startedAt))) return turnPipeline(root, turn.operation, chain, verify, { live: false, surface: turn.surface, state: turn.state });
  if (!job?.operation) {
    return { operation: null, label: null, intent: none('not run yet'), predict: none('not run yet'), sandbox: none('not run yet'), receipt: none('not run yet') };
  }
  const op = job.operation;
  const rec = readOperationRecord(root, op);
  const intent: PipelineStage = rec.ok ? { state: 'done', words: rec.record.request } : { state: 'unknown', words: `its operation record could not be read (${rec.error})` };
  const mine = chain.filter((r) => r.operation_id === op);
  const predicted = [...mine].reverse().find((r) => r.kind === 'predict');
  const predict: PipelineStage = predicted ? { state: 'done', words: `sealed before it ran (${shortReceipt(predicted)})` } : { state: 'none', words: 'none recorded for this run' };
  const runner = job.kind === 'workflow' ? 'upmd' : `a ${job.kind} job`;
  const sandbox: PipelineStage = {
    state: job.live ? 'running' : job.mark === 'failed' ? 'failed' : 'done',
    words: `none recorded: ${runner} ran it on this computer · ${job.word}`,
  };
  // the operation's own receipt: its run's (a workflow's), else its newest that is not the prediction
  const own = [...mine].reverse().find((r) => r.kind === 'workflow') ?? [...mine].reverse().find((r) => r.kind !== 'predict');
  let receipt: PipelineStage;
  if (!own) receipt = job.live ? { state: 'running', words: 'not sealed yet: it runs' } : { state: 'none', words: 'none sealed for this run' };
  else {
    const v = verify(own.hash);
    receipt = v.ok
      ? { state: 'done', words: `sealed ${shortReceipt(own)} · verified here`, verified: true }
      : { state: 'failed', words: `sealed ${shortReceipt(own)} · does not verify: ${v.reason}` };
  }
  return { operation: op, label: job.label, kind: 'job', intent, predict, sandbox, receipt };
}

/** R5 (H131): the chat turns readPipeline weighs: the project's sealed turns (newest first) and this Workbench's own turn being
 *  answered now. */
export interface PipelineTurns { turns?: readonly TurnRow[]; sending?: { operation?: string; request?: string } | null }

const SURFACE_NAME: Readonly<Record<string, string>> = { repl: 'the REPL', monitor: 'the monitor', workbench: 'the Workbench', companion: 'the companion' };

/** R5 (H131): a chat turn's operation as the pipeline row says it, from its records: its request, a prediction if one was
 *  sealed, what answered it, and its own receipt (verified here). A turn being answered has no receipt yet. */
function turnPipeline(root: string, op: string, chain: readonly Receipt[], verify: (hash: string) => { ok: true } | { ok: false; reason: string }, t: { live: boolean; surface: string; state?: TurnRow['state']; request?: string }): PipelineView {
  const where = SURFACE_NAME[t.surface] ?? t.surface;
  const rec = readOperationRecord(root, op);
  // (a turn being answered here: its operation's record is written as its receipt is sealed; until then its request is the
  // message this Workbench sent)
  const intent: PipelineStage = rec.ok ? { state: 'done', words: rec.record.request }
    : t.live && t.request ? { state: 'done', words: t.request }
      : { state: 'unknown', words: `its operation record could not be read (${rec.error})` };
  const mine = chain.filter((r) => r.operation_id === op);
  const predicted = [...mine].reverse().find((r) => r.kind === 'predict');
  const predict: PipelineStage = predicted ? { state: 'done', words: `sealed before it ran (${shortReceipt(predicted)})` } : { state: 'none', words: 'none recorded for this turn' };
  const word = t.live ? 'being answered' : t.state ?? 'ended';
  const sandbox: PipelineStage = {
    state: t.live ? 'running' : t.state === 'failed' ? 'failed' : 'done',
    words: `none recorded: a chat turn in ${where} · ${word}`,
  };
  const own = [...mine].reverse().find((r) => chatTurnOf(r)) ?? [...mine].reverse().find((r) => r.kind !== 'predict');
  let receipt: PipelineStage;
  if (!own) receipt = t.live ? { state: 'running', words: 'not sealed yet: it is being answered' } : { state: 'none', words: 'none sealed for this turn' };
  else {
    const v = verify(own.hash);
    receipt = v.ok
      ? { state: 'done', words: `sealed ${shortReceipt(own)} · verified here`, verified: true }
      : { state: 'failed', words: `sealed ${shortReceipt(own)} · does not verify: ${v.reason}` };
  }
  return { operation: op, label: `chat turn in ${where}`, kind: 'chat', ...(t.live ? { live: true } : {}), intent, predict, sandbox, receipt };
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
/** R5 lead: how many activity events `timmy workbench --json` carries (the newest first). */
export const EVENTS_IN_JSON = 40;

export interface WorkbenchJson {
  schema: typeof STATE_SCHEMA;
  at: string;
  project: ProjectView;
  navigation: Array<{ group: string; items: Array<{ id: WorkspaceId; label: string; title: string; waiting?: number }> }>;
  activity: { running: number; waiting_on_you: number; last: ActivityEvent | null; stop_current: { job: string | null; words: string } };
  /** R5 lead: the newest activity first (at most EVENTS_IN_JSON), for the workspace frame's log (src/ops/workspace-frame.ts) */
  events: ActivityEvent[];
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
  /** R5 lead (H131's report): the project to read, named by the caller (a Workbench pinned to its own while another surface
   * chose another); absent: the active project (src/project readActiveProject: the one chosen, else the folder here) */
  project?: { name: string; root: string };
}

/** The shell's state model: what `timmy workbench --json` prints and what the app starts from. Reads only. */
export async function workbenchJson(d: StateDeps = {}): Promise<WorkbenchJson> {
  const env = d.env ?? process.env;
  const cwd = d.cwd ?? process.cwd();
  const project = d.project ? projectView({ name: d.project.name, root: d.project.root, chosen: true }, env) : activeProject(cwd, env);
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
    events: act.events.slice(0, EVENTS_IN_JSON),
    route: readRoute(env, cwd),
    files: { total: files.total, truncated: files.truncated, by_kind: Object.fromEntries(files.groups.map((g) => [g.kind, g.files.length])) },
    workflows: { upmd: wf.upmd, docs: wf.docs.map((doc) => ({ rel: doc.rel, blocks: doc.blocks.map((b) => ({ name: b.name, state: b.word, needs: b.needs, needs_person: b.risky.length > 0 })) })) },
    jobs: rows.slice(0, 20).map((j) => ({ id: j.id, label: j.label, state: j.state, judged: j.word, outcome: j.outcome.words, operation: j.operation ?? null, elapsed: j.elapsed, owner: j.ownerWords })),
  };
}
