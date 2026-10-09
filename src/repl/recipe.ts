/**
 * /recipe in the REPL (round R3, helper H11): the CadQuery enclosure-tray recipe (enclosure.tray/1) as a
 * durable job. The request is validated and its analytic prediction sealed before any native start; a
 * refused request or a missing runtime starts nothing. A started job shows in /jobs as a Timmy job (the
 * watcher, src/recipes/watch.ts) whose label carries the recipe job's UUID (its operation ID), its request
 * hash and its source hash; /stop reaches the recipe's own cancel path through that watcher. The durable
 * jobs live in the project (.timmy/recipe-jobs), so /recipe status lists them after a restart.
 */
import type { ChildProcess } from 'node:child_process';
import type { JobRecord, JobSpec } from '../jobs/index.js';
import { projectId } from '../project/index.js';
import {
  checkCopy, deliver, DOCTRINE_15, failureFiles, isRecipeJobId, launchRecipe, listRecipeJobs, nativeRuntime, outcomeLines, outDir,
  PARAMETER_HELP, PARAMETER_NAMES, parseWords, prepareRecipe, PYTHON_SETUP, readCard, RECIPE_ID, short, watcherSpec,
} from '../recipes/index.js';
import { cancel, recover, status } from '../../lanes/recipes/jobs.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import type { ReceiptInput } from '../utils/receipts.js';

type Line = Segment[];

/** Test seams only (labeled where used): a fake executor for jobs.ts enqueue, the supervisor's process, the watcher's poll. */
export interface RecipeTestSeams { executor?: string; onSupervisor?: (child: ChildProcess) => void; pollMs?: number }

export interface RecipeContext {
  root: string;
  project: string;
  env: NodeJS.ProcessEnv;
  glyphs: GlyphSet;
  seal: (input: ReceiptInput) => string | undefined;
  /** Starts the watcher as this REPL's job (so /stop reaches it) and remembers its recipe UUID. */
  startJob: (spec: JobSpec, uuid: string) => JobRecord;
  test?: RecipeTestSeams;
}

const say = (text: string, role: Segment['role'] = 'secondary'): Line[] => [[{ text: `  ${text}`, role }]];
const doctrine = (): Line[] => say(DOCTRINE_15, 'strong');
const sep = (c: RecipeContext): string => ` ${c.glyphs.sep} `;
const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

/** What the agent's run_recipe gets back: data, never a claim of a finished build. */
export type RecipeStarted =
  | { ok: true; job: string; operation: string; request_sha256: string; source_sha256: string; predicted: { bounds_mm: number[]; volume_mm3: number }; prediction_receipt: string; outputs_when_succeeded: string; note: string; doctrine: string }
  | { ok: false; stage: 'refused' | 'setup' | 'enqueue' | 'start'; error: string; setup?: string; operation?: string };

/** Validate, seal the prediction, start the durable job and its watcher. Shared by /recipe tray and run_recipe. */
export async function startRecipeJob(c: RecipeContext, given: Record<string, unknown>): Promise<RecipeStarted> {
  const p = prepareRecipe(given, { root: c.root, env: c.env, ...(c.test?.executor ? { executor: c.test.executor } : {}) });
  if (!p.ok) return { ok: false, stage: p.stage, error: p.error, ...(p.stage === 'setup' ? { setup: PYTHON_SETUP } : {}) };
  const { id, job, predicted } = p.prepared;
  // The analytic prediction is sealed on the runs chain before any native start, bound to the operation ID,
  // the request hash and the signed job file (the worker seals its own prediction again in the job store).
  let sealed: string | undefined;
  try {
    sealed = c.seal({
      kind: 'predict', subject: `recipe · predict · ${RECIPE_ID} · ${id}`, policy: 'human-gated', status: 'ok', project: c.project, project_id: projectId(c.root),
      sources: [{ path: `.timmy/recipe-jobs/${id}/job.json`, recipe: RECIPE_ID, operation: id, request_sha256: job.requestHash, source_sha256: job.sourceHash, parameters: p.prepared.parameters, bounds_mm: predicted.bounds, volume_mm3: predicted.volumeMm3, units: 'mm' }],
      cost_usd: 0,
    });
  } catch { sealed = undefined; }
  // No sealed prediction, no start: the job stays queued (listed by /recipe status), and nothing native runs.
  if (!sealed) return { ok: false, stage: 'start', operation: id, error: `the prediction could not be sealed, so job ${id} was written but not started` };
  try { await launchRecipe(c.root, id, c.test?.onSupervisor); } catch (e) {
    return { ok: false, stage: 'start', operation: id, error: `the job was written but did not start: ${e instanceof Error ? e.message : String(e)}` };
  }
  const label = `recipe ${RECIPE_ID} ${id} · request ${short(job.requestHash)} · source ${short(job.sourceHash)}`;
  let watcher: JobRecord;
  try { watcher = c.startJob(watcherSpec({ root: c.root, id, label, project: c.project, ...(c.test?.pollMs ? { pollMs: c.test.pollMs } : {}) }), id); } catch (e) {
    return { ok: false, stage: 'start', operation: id, error: `job ${id} runs, but its watcher did not start (${e instanceof Error ? e.message : String(e)}); /recipe status follows it` };
  }
  return {
    ok: true, job: watcher.id, operation: id, request_sha256: job.requestHash, source_sha256: job.sourceHash,
    predicted: { bounds_mm: predicted.bounds, volume_mm3: predicted.volumeMm3 }, prediction_receipt: sealed,
    outputs_when_succeeded: `${outDir(id)}/`,
    note: `Started, not finished: the recipe runs as a durable job. /jobs ${watcher.id} follows it; its exports are copied only after the signed result verifies.`,
    doctrine: DOCTRINE_15,
  };
}

function usage(c: RecipeContext): Line[] {
  const card = readCard();
  const lines: Line[] = [[{ text: '  Recipes    ', role: 'secondary' }, { text: `${card.id} (tray)`, role: 'strong' }, { text: `  ${card.engine}`, role: 'secondary' }]];
  for (const name of PARAMETER_NAMES) {
    lines.push([{ text: `    ${name.padEnd(14)}` }, { text: `${String(card.parameters[name]).padStart(4)} mm`, role: 'strong' }, { text: `  ${PARAMETER_HELP[name]}`, role: 'secondary' }]);
  }
  const fixed = Object.entries(card.fixed).map(([k, v]) => `${k} ${v}`).join(', ');
  lines.push(...say(`  fixed (mm): ${fixed}; exports: four feature STLs and a STEP; a 30-check gate`));
  const r = nativeRuntime(c.env);
  lines.push(r.ok
    ? [{ text: '  Runtime    ', role: 'secondary' }, { text: 'TIMMY_CADQUERY_PYTHON is set', role: 'strong' }, { text: `${sep(c)}checked when a job runs, not now`, role: 'secondary' }]
    : [{ text: '  Runtime    ', role: 'secondary' }, { text: `${r.why}`, role: 'estimate' }, { text: `${sep(c)}${PYTHON_SETUP}`, role: 'secondary' }]);
  lines.push(...say('Start: /recipe tray [width=140] [wall=3] [supportOffset=10] [bore=3]; jobs: /recipe status; /recipe recover <uuid>; /recipe cancel <uuid>'));
  lines.push(...doctrine());
  return lines;
}

async function startView(c: RecipeContext, words: string[]): Promise<Line[]> {
  const given = parseWords(words);
  if ('error' in given) return say(`${given.error}. Nothing started.`, 'failure');
  const r = await startRecipeJob(c, given);
  if (!r.ok) {
    if (r.stage === 'refused') return say(`Refused before any native start: ${r.error}. Nothing started.`, 'failure');
    if (r.stage === 'setup') return [...say(`Not started: ${r.error}.`, 'estimate'), ...say(`Setup: ${PYTHON_SETUP}, then /recipe tray again.`)];
    return say(`${r.error}${r.operation ? `${sep(c)}/recipe status` : ''}`, 'failure');
  }
  const [x, y, z] = r.predicted.bounds_mm;
  return [
    [{ text: '  Predicted  ', role: 'secondary' }, { text: `${fmt(x)} x ${fmt(y)} x ${fmt(z)} mm, ${fmt(r.predicted.volume_mm3)} mm3`, role: 'strong' }, { text: `  analytic, sealed before the build${r.prediction_receipt ? `${sep(c)}receipt ${r.prediction_receipt}` : ''}`, role: 'secondary' }],
    [{ text: '  Recipe job ', role: 'secondary' }, { text: r.operation, role: 'strong' }, { text: `  request ${short(r.request_sha256)}${sep(c)}source ${short(r.source_sha256)}`, role: 'secondary' }],
    [{ text: '  Running    ', role: 'secondary' }, { text: r.job, role: 'strong' }, { text: `  CadQuery builds the tray${sep(c)}/jobs ${r.job}${sep(c)}/stop ${r.job}`, role: 'secondary' }],
  ];
}

function statusView(c: RecipeContext): Line[] {
  const jobs = listRecipeJobs(c.root);
  if (!jobs.length) return say('No recipe jobs in this project yet: /recipe tray starts one.');
  const g = c.glyphs;
  const lines: Line[] = [[{ text: `  Recipe jobs in ${c.project}`, role: 'strong' }, { text: '  .timmy/recipe-jobs, newest first', role: 'secondary' }]];
  for (const j of jobs.slice(0, 12)) {
    if (j.error) { lines.push([{ text: `  ${g.fail} `, role: 'failure' }, { text: j.id, role: 'strong' }, { text: `  unreadable: ${j.error}`, role: 'failure' }]); continue; }
    const mark = j.state === 'succeeded' ? g.ok : j.state === 'failed' || j.state === 'interrupted' ? g.fail : j.state === 'cancelled' ? ' ' : g.bullet;
    const result = j.resultReceipt ? `${sep(c)}verified result receipt ${j.resultReceipt} (${short(j.resultHash ?? '', 19)})` : '';
    lines.push([{ text: `  ${mark} `, role: j.state === 'failed' || j.state === 'interrupted' ? 'failure' : undefined }, { text: j.id, role: 'strong' },
      { text: `  ${String(j.state).padEnd(11)} ${j.progress}${j.reason ? `: ${j.reason}` : ''}${sep(c)}request ${short(j.requestHash ?? '')}${sep(c)}source ${short(j.sourceHash ?? '')}${result}`, role: 'secondary' }]);
    if (j.state === 'succeeded') {
      const copy = checkCopy(c.root, j.id);
      lines.push(...say(copy.ok ? `    copied: ${copy.dir}/ (every sha256 matches)` : `    not in the project: ${copy.error}; /recipe copy ${j.id}`));
    } else if (j.state === 'failed' || j.state === 'interrupted' || j.state === 'cancelled') {
      const kept = failureFiles(c.root, j.id);
      if (kept.length) lines.push(...say(`    kept: ${kept.join(', ')}`));
    }
  }
  lines.push(...say('Recover one: /recipe recover <uuid>; copy a succeeded one: /recipe copy <uuid>'));
  return lines;
}

function recoverView(c: RecipeContext, id: string | undefined): Line[] {
  if (!id || !isRecipeJobId(id)) return say('Usage: /recipe recover <uuid> (from /recipe status)');
  let before: ReturnType<typeof status>;
  let after: ReturnType<typeof status>;
  try { before = status(c.root, id); after = recover(c.root, id); } catch (e) { return say(`${id} could not be read: ${e instanceof Error ? e.message : String(e)}`, 'failure'); }
  const changed = before.state !== after.state || before.progress !== after.progress;
  const why = after.reason ? `: ${after.reason}` : '';
  const plain = after.state === 'succeeded'
    ? `its signed result verified; recorded as succeeded without building again. /recipe copy ${id} copies its exports`
    : after.progress === 'verification-failed'
      ? 'its recorded result could not be verified; nothing was repaired or rerun'
      : after.state === 'interrupted'
        ? 'its worker stopped answering; the native outcome is unknown and nothing was rerun'
        : after.state === 'running'
          ? 'its worker is still answering (a heartbeat within 5 s); nothing changed'
          : after.state === 'queued' ? 'it has not started; nothing to recover' : `it already ${after.state}; nothing changed`;
  return [[{ text: `  ${id} ${after.state}`, role: after.state === 'succeeded' ? 'strong' : after.state === 'interrupted' || after.state === 'failed' ? 'failure' : 'strong' },
    { text: `  ${changed ? `was ${before.state}; ` : ''}${plain}${why}`, role: 'secondary' }]];
}

/**
 * `/recipe cancel <uuid>` (the review of ee70b9e, M12): the recipe's own cancel, for a job whose watcher is gone
 * (its REPL ended, or the watcher could not start). It writes the job's cancel request; the job's supervisor stops
 * its own process group. Nothing here signals a process or reads a PID from disk; partial artifacts are kept.
 */
function cancelView(c: RecipeContext, id: string | undefined): Line[] {
  if (!id || !isRecipeJobId(id)) return say('Usage: /recipe cancel <uuid> (a queued or running job from /recipe status)');
  let before: ReturnType<typeof status>;
  let after: ReturnType<typeof status>;
  try { before = status(c.root, id); after = cancel(c.root, id); } catch (e) { return say(`${id} could not be read: ${e instanceof Error ? e.message : String(e)}`, 'failure'); }
  if (before.state !== 'queued' && before.state !== 'running') return [[{ text: `  ${id} ${after.state}`, role: 'strong' }, { text: '  it had already ended; nothing to cancel', role: 'secondary' }]];
  return [[{ text: `  ${id} ${after.state}`, role: 'strong' },
    { text: `  cancel requested through the recipe's own path: its supervisor stops its own process group; partial artifacts are kept and nothing is replayed${sep(c)}/recipe status`, role: 'secondary' }]];
}

function copyView(c: RecipeContext, id: string | undefined): Line[] {
  if (!id || !isRecipeJobId(id)) return say('Usage: /recipe copy <uuid> (a succeeded job from /recipe status)');
  const d = deliver(c.root, id);
  if (!d.ok) return say(`Refused to copy ${id}: ${d.error}`, 'failure');
  return outcomeLines(d.v, d.dir).map((l, i) => [{ text: `  ${l}`, role: i === 0 || l === DOCTRINE_15 ? 'strong' : 'secondary' }]);
}

/** /recipe [tray name=value… | status | recover <uuid> | copy <uuid>] */
export async function recipeView(c: RecipeContext, args: string): Promise<Line[]> {
  const w = args.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return usage(c);
  if (w[0] === 'status') return statusView(c);
  if (w[0] === 'recover') return recoverView(c, w[1]);
  if (w[0] === 'copy') return copyView(c, w[1]);
  if (w[0] === 'cancel') return cancelView(c, w[1]);
  if (w[0] === 'tray' || w[0] === RECIPE_ID) return startView(c, w.slice(1));
  return say(`No recipe ${w[0]}: /recipe lists ${RECIPE_ID} (tray).`);
}

/** The notice when a recipe's watcher job ends: the verified outcome, or what happened and where it is kept. */
export function recipeEnded(c: RecipeContext, job: JobRecord, id: string): Line[] {
  const g = c.glyphs;
  let s: ReturnType<typeof status>;
  try { s = status(c.root, id); } catch (e) { return [[{ text: `  ${g.fail} `, role: 'failure' }, { text: `${job.id} recipe ${id}`, role: 'failure' }, { text: `  could not be read: ${e instanceof Error ? e.message : String(e)}`, role: 'secondary' }]]; }
  if (s.state === 'succeeded') {
    const copy = checkCopy(c.root, id);
    if (!copy.ok) return [[{ text: `  ${g.fail} `, role: 'failure' }, { text: `${job.id} recipe ${id} succeeded`, role: 'strong' }, { text: `  but its exports are not in the project: ${copy.error}${sep(c)}/jobs ${job.id}${sep(c)}/recipe copy ${id}`, role: 'secondary' }]];
    return outcomeLines(copy.v, copy.dir).map((l, i) => i === 0
      ? [{ text: `  ${g.ok} ` }, { text: `${job.id} ${l}`, role: 'strong' }]
      : [{ text: `    ${l}`, role: l === DOCTRINE_15 ? 'strong' : 'secondary' }]);
  }
  const kept = failureFiles(c.root, id);
  const where = kept.length ? `${sep(c)}kept: ${kept.join(', ')}` : '';
  const next = s.state === 'interrupted' ? `${sep(c)}/recipe recover ${id}` : s.state === 'queued' || s.state === 'running' ? `${sep(c)}the watcher ended first: /recipe status` : '';
  return [[{ text: `  ${s.state === 'cancelled' ? ' ' : g.fail} `, role: s.state === 'cancelled' ? undefined : 'failure' }, { text: `${job.id} recipe ${id} ${s.state}`, role: s.state === 'cancelled' ? 'strong' : 'failure' },
    { text: `  ${s.progress}${s.reason ? `: ${s.reason}` : ''}${where}${next}`, role: 'secondary' }]];
}
