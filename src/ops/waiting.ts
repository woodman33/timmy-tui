/**
 * R6 (H140; the operator's order of 2026-10-16, priority 2, "one waiting count everywhere"; the R5 interaction review, defect
 * 2): what waits on you in a project: the same items, and so the same count, for every surface and every process: the
 * Workbench's run line, Activity and Control Room (src/workbench/state.ts readDecisions), and the workspace frame
 * (src/ops/workspace-frame.ts: the companion, Studio, `timmy workspace`).
 *
 * src/room/decisions.ts gatherDecisions reads the project's own records (jobs, receipts, flows, the runs a session left,
 * lessons) the same from any process. Two of its inputs lived in one process's memory, and are read here as every process
 * sees them:
 *   NEEDS YOU boxes   this process's (src/repl/approvals.ts waitingApprovals), and those other live processes of this Timmy
 *                     home wait on in this project (src/ops/waiting-record.ts), each said as waiting there
 *   /tools rows       the newer of the caller's own check and the last check any process recorded
 *                     (src/capabilities/tools-record.ts)
 * and one more is counted:
 *   Studio drafts     a draft Timmy proposed on the project's board, waiting for Accept or Discard, counts once (the reader is
 *                     Studio's, src/studio/boards.ts pendingDrafts, H139's; a test may pass its own as `drafts`)
 * A stopped chat turn is never an item (src/room/decisions.ts toolUses: a stopped turn is no use of a row).
 */
import type { JobRecord } from '../jobs/index.js';
import { projectId, sameFolder } from '../project/index.js';
import { waitingApprovals, type WaitingApproval } from '../repl/approvals.js';
import { DECISIONS_SHOWN, gatherDecisions, type Decision, type DecisionsView } from '../room/decisions.js';
import type { RoomTools } from '../room/index.js';
import { newerTools, readToolsCheck } from '../capabilities/tools-record.js';
import { scrubHomes } from '../utils/home-scrub.js';
import type { Receipt } from '../utils/receipts.js';
import { othersWaiting, type ElsewhereBox } from './waiting-record.js';
import { pendingDrafts } from '../studio/boards.js';

type Env = Record<string, string | undefined>;

/** Studio's reader of a project's pending drafts (its saved board): their count and the jobs that made them; null: not known. */
export type DraftsReader = (projectRoot: string, env: Env) => { count: number; jobs: string[] } | null;

export interface WaitingDeps {
  root: string;
  /** the jobs to read (any project's: those of `root` are kept) */
  jobs: readonly JobRecord[];
  chain: readonly Receipt[];
  /** the caller's own /tools rows (the Workbench's last check): used when newer than the recorded check */
  tools?: RoomTools;
  env?: Env;
  /** this process's boxes; src/repl/approvals.ts waitingApprovals when absent (a test's) */
  own?: () => WaitingApproval[];
  /** other processes' boxes; src/ops/waiting-record.ts othersWaiting when absent (a test's) */
  others?: (root: string, env: Env) => ElsewhereBox[];
  /** Studio's reader of pending drafts; src/studio/boards.ts pendingDrafts when absent (a test's) */
  drafts?: DraftsReader;
}

/** Another process's box, said as waiting where it is (its keys are pressed there, not here). */
export function elsewhereApproval(b: ElsewhereBox): WaitingApproval {
  const summary = b.summary ? ` (${b.summary})` : '';
  const there = `another Timmy process on this computer (pid ${b.pid})`;
  return {
    tool: b.tool, reason: b.reason, summary: b.summary, session: b.session, since: b.since, shown: b.shown, ...(b.operation ? { operation: b.operation } : {}),
    words: b.words
      ? { ...b.words, needed: `${b.words.needed} (it waits in ${there})`, keys: false, kind: b.words.kind ?? 'NEEDS YOU, in another process' }
      : {
        title: `NEEDS YOU: ${b.tool}${summary}`, needed: `answer its NEEDS YOU box where it waits: ${there}; the call waits for it`,
        why: `the chat agent asked to run ${b.tool}, and Timmy asks first because it ${b.reason}`, commands: [], keys: false, kind: 'NEEDS YOU, in another process',
      },
  };
}

/** A project's pending Studio drafts as one item: what Timmy proposed waits for a person's Accept or Discard. */
export function draftsItem(d: { count: number; jobs: string[] }, now = Date.now()): Decision {
  const n = d.count === 1 ? 'a draft' : `${d.count} drafts`;
  return {
    key: `draft:${d.jobs.join(',') || d.count}`, kind: 'approval', blocks: false, kindWords: 'a Timmy draft on the Studio canvas',
    title: `${d.count === 1 ? 'A draft' : `${d.count} drafts`} Timmy proposed on the Studio canvas wait${d.count === 1 ? 's' : ''} for you`,
    needed: `Accept or Discard ${d.count === 1 ? 'it' : 'each'} in Studio (s in the Workbench, or timmy studio, opens it); nothing is kept until you do`,
    why: `Studio's board of this project holds ${n} proposed by Timmy${d.jobs.length ? ` (${d.jobs.slice(0, 3).join(', ')}${d.jobs.length > 3 ? ', …' : ''})` : ''}`,
    commands: ['/studio'], at: now,
  };
}

/** What waits on you in the project at `root`, as every surface and process counts it. */
export function waitingNow(d: WaitingDeps): DecisionsView {
  const env = d.env ?? process.env;
  try {
    const tools = newerTools(d.tools, readToolsCheck(env));
    const approvals = [...(d.own ?? waitingApprovals)(), ...(d.others ?? ((r, e) => othersWaiting(r, { env: e })))(d.root, env).map(elsewhereApproval)];
    const view = gatherDecisions({
      root: d.root, projectId: projectId(d.root), jobs: d.jobs.filter((j) => sameFolder(j.root, d.root)), chain: d.chain, approvals,
      ...(tools ? { tools } : {}), scrub: (t) => scrubHomes(t.split(d.root).join('.'), env as NodeJS.ProcessEnv),
    });
    const drafts = (() => { try { return (d.drafts ?? pendingDrafts)(d.root, env) ?? null; } catch { return null; } })();
    if (!drafts || drafts.count <= 0) return view;
    // the drafts come after what blocks a running operation, before the rest (newest first within each, as gatherDecisions orders)
    const merged = [...view.items.filter((x) => x.blocks), draftsItem(drafts), ...view.items.filter((x) => !x.blocks)];
    const items = merged.slice(0, DECISIONS_SHOWN);
    return { ...view, items, more: view.more + merged.length - items.length, total: view.total + 1 };
  } catch (e) {
    return { items: [], more: 0, total: 0, otherSetup: 0, tools: {}, operations: {}, notes: [`What waits on you could not be read: ${e instanceof Error ? e.message : String(e)}`] };
  }
}
