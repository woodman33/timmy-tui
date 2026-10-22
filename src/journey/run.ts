/**
 * R10 (H164): a run in project context (journey step 4: "Inspect its workflow progress, result and receipt without losing
 * project context"), for the Workbench, the companion and Studio alike, from the ONE run detail every surface draws
 * (src/ops/run-detail.ts readRunDetail, src/contracts/run-detail.ts: nothing here is computed from anything else):
 *
 *   progress   the workflow stage: steps done of total (never a percentage), the step running now, the run's state in the
 *              shared words (its verdict: running, waiting on you, completed, no change, failed, cancelled …)
 *   result     each process's or runner's own exit, kept apart from the verdict; its outputs (each with where it opens);
 *              the verdict's words; its cost as reported (or unknown, with why: never an invented 0)
 *   receipt    its own receipt (its workflow's, else its newest that is not the prediction: the pipeline row's rule, as the
 *              recent work picks it), and every receipt of the run, each verified here now (chain link, body, signature)
 *   project    the project it belongs to: its name, its folder and its id
 *
 * Reads files only: nothing runs, seals or writes.
 */
import type { RunDetail, RunVerdict } from '../contracts/run-detail.js';
import type { JobRecord } from '../jobs/index.js';
import { readRunDetail, type RunDetailRefusal } from '../ops/run-detail.js';
import { readChain, type Receipt } from '../utils/receipts.js';
import { openTarget, type OpenTarget } from './open.js';
import { receiptOutputs, runTitle, verifyMany } from './recent.js';

type Env = Record<string, string | undefined>;

/** A run's state as its progress says it (src/contracts/run-detail.ts RunVerdict, "needs you" as the journey says it). */
export type RunProgressState = Exclude<RunVerdict, 'needs you'> | 'waiting on you';

export interface RunReceipt { id: string; kind: string; verified: boolean; why?: string }

export interface RunSummary {
  ok: true;
  operation: string;
  /** the project it belongs to (the run detail's: its record's project name, its folder, its id) */
  project: { name: string; root: string; id: string };
  /** its request in plain words (./recent.ts runTitle), or what its runs' records say when it has no record */
  title: string;
  /** its request as recorded, for an inspector (a raw command), or null */
  request: string | null;
  progress: { state: RunProgressState; done: number; total: number | null; current: string | null; words: string };
  result: {
    /** Timmy's verdict in words (its record's state and why) */
    verdict: string;
    exits: Array<{ who: string; code: number | null; state?: string }>;
    outputs: Array<{ path: string; open: OpenTarget }>;
    cost: RunDetail['cost'];
  };
  /** its own receipt, verified here now; null when it has none yet */
  receipt: RunReceipt | null;
  /** every receipt of the run, in the order they were sealed, each verified here now */
  receipts: RunReceipt[];
  time: RunDetail['time'];
  /** where its full run detail opens (the companion's Workflows tab) */
  open: OpenTarget;
  /** its request says FAKE */
  fake: boolean;
  /** what no record says, with why (the run detail's) */
  unknown: RunDetail['unknown'];
}

export type RunSummaryAnswer = RunSummary | { ok: false; refusal: RunDetailRefusal; why: string };

export interface RunCtx {
  project: { name: string; root: string };
  env?: Env;
  /** the runs chain as the surface read it; else the project's store (TIMMY_STORE, else its own) */
  chain?: readonly Receipt[];
  /** the job records the surface holds (the Workbench's, the REPL's); else the run detail reads Timmy's jobs folder */
  jobs?: readonly JobRecord[];
  /** a NEEDS YOU box waiting for this operation in the caller's own process, in words */
  waiting?: (operation: string) => string | undefined;
}

const stepsWords = (done: number, total: number | null): string => (total === null ? (done > 0 ? `${done} step${done === 1 ? '' : 's'} done of a number not recorded` : 'steps not recorded') : `${done} of ${total} step${total === 1 ? '' : 's'}`);

/** A run's progress, result and receipt in project context, from its run detail; or why there is none (never thrown). */
export function runSummary(ctx: RunCtx, runId: string): RunSummaryAnswer {
  const env = ctx.env ?? process.env;
  const root = ctx.project.root;
  const chain = ctx.chain ?? (() => { try { return env.TIMMY_STORE ? readChain('runs') : readChain('runs', root); } catch { return []; } })();
  const made = readRunDetail(String(runId ?? '').trim(), {
    project: root, chain, env: env as NodeJS.ProcessEnv, ...(ctx.jobs ? { jobs: ctx.jobs } : {}), ...(ctx.waiting ? { waiting: ctx.waiting } : {}),
  });
  if (!made.ok) return { ok: false, refusal: made.refusal, why: made.why };
  const d = made.detail;
  // the run's receipts on the chain, by their short ids (the run detail names them so), each verified here, once per epoch
  const mine = chain.filter((r) => r.operation_id === d.operation);
  const hashOf = new Map<string, string>();
  for (const r of mine) hashOf.set(r.hash.slice(7, 15), r.hash);
  for (const x of d.receipts) if (!hashOf.has(x.id)) { const r = chain.find((c) => c.hash.slice(7, 15) === x.id); if (r) hashOf.set(x.id, r.hash); }
  const checked = verifyMany(chain, [...hashOf.values()]);
  const receipts: RunReceipt[] = d.receipts.map((x) => {
    const h = hashOf.get(x.id);
    const v = h ? checked.get(h) : undefined;
    return v?.ok ? { id: x.id, kind: x.kind, verified: true } : { id: x.id, kind: x.kind, verified: false, why: v && !v.ok ? v.reason : 'it is not on the chain read here' };
  });
  const own = [...receipts].reverse().find((x) => x.kind === 'workflow') ?? [...receipts].reverse().find((x) => x.kind !== 'predict') ?? null;
  const state: RunProgressState = d.verdict.state === 'needs you' ? 'waiting on you' : d.verdict.state;
  const request = d.objective?.value ?? null;
  // its outputs as the run inspection lists its files (src/ops/run-detail.ts outputsInspected): what its workflow, task,
  // recipe or preview receipts sealed, then the run detail's output, preview and native files in the project
  const outputs = receiptOutputs(mine);
  for (const f of d.files) {
    if (f.role !== 'output' && f.role !== 'preview' && f.role !== 'native') continue;
    if (f.path.startsWith('~') || f.path.startsWith('/') || f.path.split('/').includes('.timmy') || f.path.split('/').includes('..') || outputs.includes(f.path)) continue;
    outputs.push(f.path);
  }
  return {
    ok: true, operation: d.operation, project: { name: d.project.name, root: d.project.root, id: d.project.id },
    title: request ? runTitle(request) : `Operation ${d.operation} (no record of its request here)`, request,
    progress: { state, done: d.stage.done, total: d.stage.total, current: d.stage.current, words: `${stepsWords(d.stage.done, d.stage.total)} · ${state}${d.stage.current && state === 'running' ? `: ${d.stage.current}` : ''}` },
    result: {
      verdict: d.verdict.words,
      exits: d.exits.map((e) => ({ who: e.who, code: e.code, ...(e.state ? { state: e.state } : {}) })),
      outputs: outputs.map((p) => ({ path: p, open: openTarget({ kind: 'result', id: p }) })),
      cost: d.cost,
    },
    receipt: own, receipts, time: d.time, open: openTarget({ kind: 'run', id: d.operation }),
    fake: /\bFAKE\b/.test(request ?? ''), unknown: d.unknown,
  };
}
