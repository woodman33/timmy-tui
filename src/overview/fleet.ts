/**
 * Round R4 (lead): God's Eye View's Fleets part, from the fleet plans' own files (`.timmy/fleet/<plan>/plan.json` and
 * `state.json`, written by `timmy fleet`: src/fleet). It is present only in a project that has a fleet plan and is drawn
 * after Costs, so a project without one sees the overview it saw before.
 *
 * Nothing here runs, stops, reconciles, collects, seals or contacts anything. A fleet is `running` only when the process
 * that runs it answers (its runner's pid); one whose ledger says running with no process is said so. "Delivered" is the
 * runtime's word (it said completed); nothing a fleet run delivers is verified by the run, and the counts keep the two
 * apart. A simulation (the FAKE backend) is labelled one everywhere: it allocated nothing and spent nothing, so nothing it
 * left can need a person. What waits on a person in a real fleet (a worker whose compute is unknown; a fleet whose process
 * ended while it ran) is also given to Needs you (fleetNeeds).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fleetRoot } from '../fleet/ledger.js';
import type { FleetPlan } from '../fleet/plan.js';
import { readFleetView, type FleetView } from '../fleet/service.js';
import { planHashOf } from '../utils/approvals.js';
import { FLEET_TITLE, ITEMS_MAX, type Count, type FleetItem, type FleetSection, type FleetWorkerLine, type NeedsItem, type Tone, type Unreadable } from './model.js';
import { message, type Sources } from './sources.js';

const PLAN_ID = /^f[0-9a-f]{8}$/;
/** How many plans are read (the newest by their state file's time); the rest are counted, not read. */
export const FLEET_READ_MAX = 20;
/** How many workers a plan's item lists. */
const WORKERS_SHOWN = 6;

type S = Pick<Sources, 'root' | 'asOf' | 'scrub'>;

interface Read { views: Array<{ view: FleetView; plan: FleetPlan }>; unreadable: Unreadable[]; notRead: number }

/** The project's fleet plans, read; undefined when it has none (no `.timmy/fleet`, or no plan in it). */
function readPlans(s: S): Read | { error: string } | undefined {
  const dir = fleetRoot(s.root);
  let names: string[];
  try { names = fs.readdirSync(dir).filter((d) => PLAN_ID.test(d)); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return { error: `.timmy/fleet could not be read: ${s.scrub(message(e))}` };
  }
  if (!names.length) return undefined;
  const mtime = (id: string): number => { try { return fs.statSync(path.join(dir, id, 'state.json')).mtimeMs; } catch { return 0; } };
  const ordered = names.map((id) => ({ id, t: mtime(id) })).sort((a, b) => b.t - a.t || a.id.localeCompare(b.id));
  const out: Read = { views: [], unreadable: [], notRead: Math.max(0, ordered.length - FLEET_READ_MAX) };
  for (const { id } of ordered.slice(0, FLEET_READ_MAX)) {
    let plan: FleetPlan;
    try {
      plan = JSON.parse(fs.readFileSync(path.join(dir, id, 'plan.json'), 'utf8')) as FleetPlan;
      JSON.parse(fs.readFileSync(path.join(dir, id, 'state.json'), 'utf8'));
    } catch (e) {
      out.unreadable.push({ record: `.timmy/fleet/${id}`, why: s.scrub(message(e)) });
      continue;
    }
    const view = readFleetView(s.root, id);
    if (!view || plan.id !== id) { out.unreadable.push({ record: `.timmy/fleet/${id}`, why: 'its plan.json and state.json are not a fleet plan Timmy can read' }); continue; }
    out.views.push({ view, plan });
  }
  out.views.sort((a, b) => b.view.createdAt.localeCompare(a.view.createdAt));
  return out;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const usd = (n: number): string => `$${n.toFixed(2)}`;
const noArticle = (w: string): string => w.replace(/^an? /, '');

/** The phases to read first: what failed or is unknown, then what runs, then what was delivered. */
const PHASE_ORDER: Readonly<Record<string, number>> = { unknown: 0, failed: 1, expired: 1, interrupted: 2, refused: 2, running: 3, allocating: 3, admitted: 4, queued: 5, cancelled: 6, delivered: 7 };

/**
 * The workers to read first (what failed or is unknown, then what runs), at most WORKERS_SHOWN; when every worker was
 * delivered, two of them as examples (the rest say the same). A delivered worker's reason (the runtime said completed) is
 * its phase's words already, so it is not repeated.
 */
function workerLines(v: FleetView): { lines: FleetWorkerLine[]; more: number } {
  const ordered = [...v.workers].sort((a, b) => (PHASE_ORDER[a.phase] ?? 8) - (PHASE_ORDER[b.phase] ?? 8) || a.index - b.index);
  const notDelivered = ordered.filter((w) => w.phase !== 'delivered').length;
  const shown = ordered.slice(0, notDelivered ? Math.min(WORKERS_SHOWN, notDelivered) : Math.min(2, ordered.length));
  const lines = shown.map((w) => {
    const compute = w.providerId ? `${v.simulation ? 'simulated ' : ''}${w.providerId} ${w.compute}` : `compute ${w.compute}`;
    const said = w.phase === 'delivered' ? 'delivered (not verified)' : w.phase;
    const got = w.collected ? `${plural(w.files, 'file')} collected` : w.session ? 'nothing collected' : '';
    const why = w.phase === 'delivered' ? '' : w.reason ?? '';
    return { index: w.index, phase: w.phase, words: [`w${String(w.index).padStart(3, '0')} ${said}`, compute, w.session ? `session ${w.session}` : '', got, why].filter(Boolean).join(' · ') };
  });
  return { lines, more: Math.max(0, v.workers.length - lines.length) };
}

function itemOf(v: FleetView, plan: FleetPlan): FleetItem {
  const id = v.planId;
  const c = v.counts;
  const proven = !!v.runner;
  const sim = v.simulation;
  const hash = planHashOf(plan);
  const budgeted = plan.budgets.infraUsd > 0 || plan.budgets.inferenceUsd > 0;
  const delivered = `${c.delivered} of ${c.requested} delivered (not verified)`;
  const failedWords = c.failed ? `, ${c.failed} failed` : '';
  let words: string;
  let tone: Tone;
  const needs: string[] = [];
  if (v.status === 'planned') {
    words = `planned, not run${plan.policy.requireReview ? ': a person runs it from a terminal; an agent needs a person\'s approval first' : ''}`;
    tone = 'attention';
  } else if ((v.status === 'running' || v.status === 'stopping') && proven) {
    words = `${v.status === 'stopping' ? 'stopping' : 'running'} in process ${v.runner!.pid}: ${c.running} running, ${c.queued} queued, ${delivered}${failedWords}`;
    tone = 'running';
  } else if (v.status === 'running' || v.status === 'stopping') {
    words = sim
      ? `its process ended while it ran (${delivered}): a simulation allocated nothing, so nothing is left behind`
      : `its process ended while it ran (${delivered}): what it left is not known until it is reconciled`;
    tone = 'attention';
  } else if (v.status === 'stopped') {
    words = `stopped: ${delivered}${failedWords}, ${c.cancelled} cancelled`;
    tone = 'attention';
  } else {
    words = `finished: ${delivered}${failedWords}`;
    tone = c.failed || c.refused ? 'failed' : 'neutral';
  }
  // what waits on a person: only in a real fleet (a simulation allocated nothing, so it can have left nothing)
  if (!sim) needs.push(...v.needsYou);
  if (v.status === 'planned' && budgeted) words += `; it may cost money, so even a person approves it first (timmy approve ${hash}) and runs it with that token`;
  const isoWords = `${v.perWorker === 'shared' ? 'shared allocations, ' : ''}each ${sim ? `a simulated ${noArticle(v.isolationWords)} (FAKE: nothing was allocated)` : v.isolationWords}`;
  const commands = [`timmy fleet status ${id}`];
  if (v.status === 'planned') commands.push(`timmy fleet run ${id}`, ...(plan.policy.requireReview || budgeted ? [`timmy approve ${hash}`] : []));
  if ((v.status === 'running' || v.status === 'stopping') && proven) commands.push(`timmy fleet stop ${id}`);
  if (!sim && (((v.status === 'running' || v.status === 'stopping') && !proven) || c.unknownAllocations)) commands.push(`timmy fleet reconcile ${id}`);
  commands.push(`timmy fleet events ${id}`, `timmy op ${v.operationId}`);
  const collected = v.workers.filter((w) => w.collected).length;
  const w = workerLines(v);
  const counts: Record<string, number> = {
    requested: c.requested, admitted: c.admitted, queued: c.queued, allocating: c.allocating, running: c.running,
    'live allocations': c.liveAllocations, 'unknown allocations': c.unknownAllocations, delivered: c.delivered, verified: c.verified,
    failed: c.failed, cancelled: c.cancelled, refused: c.refused,
  };
  return {
    plan: id, operation: v.operationId, created_at: v.createdAt, updated_at: v.updatedAt, status: v.status, running_proven: proven,
    provider: v.provider, backend: v.backend, simulation: sim, isolation: v.isolation, isolation_words: isoWords,
    harness: v.harness, model: v.model, workers: plan.agents, concurrency: plan.concurrency, counts,
    counts_line: `${c.requested} requested · ${c.admitted} admitted · ${c.queued} queued · ${c.running} running · ${c.liveAllocations} live and ${c.unknownAllocations} unknown allocations · ${c.delivered} delivered (not verified) · ${c.verified} verified · ${c.failed} failed · ${c.cancelled} cancelled · ${c.refused} refused`,
    revision: `${plan.project.revision.slice(0, 10)}${plan.project.dirty ? ' (with uncommitted changes)' : ''}`,
    spend_words: sim
      ? 'nothing spent: a simulation (no compute, no harness, no model)'
      : `budgets ${usd(plan.budgets.infraUsd)} compute and ${usd(plan.budgets.inferenceUsd)} inference (ceilings, not spend); spend: not reported`,
    words: `${id} ${words}${sim ? ' · a simulation' : ''}`,
    needs, worker_lines: w.lines, workers_more: w.more,
    results: collected ? `.timmy/fleet/${id}/w<NNN>/result/ (${plural(collected, 'worker')}' results, each with its MANIFEST.json)` : null,
    tone, commands,
    source: { record: `.timmy/fleet/${id}/state.json`, command: `timmy fleet status ${id}`, board: 'ov-fleet', detail: `ov-fleet-${id}` },
  };
}

/** The Fleets part, or undefined when the project has no fleet plan. */
export function fleetPart(s: S): FleetSection | undefined {
  const r = readPlans(s);
  if (!r) return undefined;
  const base = { id: 'fleet' as const, title: FLEET_TITLE, as_of: s.asOf, unreadable: [] as Unreadable[], notes: [] as string[] };
  if ('error' in r) return { ...base, state: 'unknown', why: r.error, summary: 'not known', counts: [], items: [], more: 0 };
  const all = r.views.map(({ view, plan }) => itemOf(view, plan));
  const items = all.slice(0, ITEMS_MAX);
  const by = (st: string): number => all.filter((i) => i.status === st).length;
  const running = all.filter((i) => (i.status === 'running' || i.status === 'stopping') && i.running_proven).length;
  const needing = all.filter((i) => i.needs.length).length;
  const sum = (k: string): number => all.reduce((n, i) => n + (i.counts[k] ?? 0), 0);
  const plans = all.length + r.unreadable.length + r.notRead;
  const sims = all.filter((i) => i.simulation).length;
  const counts: Count[] = [
    { n: plans, of: plans === 1 ? 'fleet plan' : 'fleet plans' },
    ...(running ? [{ n: running, of: 'running (a live process runs it)' }] : []),
    ...(by('planned') ? [{ n: by('planned'), of: 'planned, not run' }] : []),
    ...(needing ? [{ n: needing, of: needing === 1 ? 'needs a person' : 'need a person' }] : []),
    { n: sum('delivered'), of: 'workers delivered (not verified)' },
    { n: sum('verified'), of: 'verified' },
    ...(sum('failed') ? [{ n: sum('failed'), of: 'failed' }] : []),
    ...(sims ? [{ n: sims, of: sims === 1 ? 'is a simulation (FAKE)' : 'are simulations (FAKE)' }] : []),
  ];
  // the first line's item: what needs a person, else what runs, else what waits to be run; a finished plan is not urgent
  const first = all.find((i) => i.needs.length) ?? all.find((i) => i.tone === 'running') ?? all.find((i) => i.status === 'planned' || i.tone === 'attention' || i.tone === 'failed');
  const firstText = first ? (first.needs[0] ? `${first.plan}: ${withoutCommand(first.needs[0])}` : first.words) : '';
  const summary = !all.length
    ? 'not known'
    : [plural(plans, 'plan'), running ? `${running} running` : '', by('planned') ? `${by('planned')} planned` : '', `${sum('delivered')} delivered (not verified)`, sims === all.length ? 'simulation' : sims ? `${sims} simulated` : ''].filter(Boolean).join(', ');
  const notes = [
    'Read from the plans\' own files (.timmy/fleet); nothing here runs, stops, reconciles or collects. Delivered is the runtime\'s word (it said completed): nothing a fleet run delivers is verified by the run.',
    ...(sims ? ['A FAKE plan is a simulation: no compute, no harness, no model and no cost; nothing it left can need a person.'] : []),
    ...(r.notRead ? [`${plural(r.notRead, 'older plan')} not read (the newest ${FLEET_READ_MAX} are): timmy fleet status lists them all.`] : []),
  ];
  const state = !all.length ? 'unknown' : r.unreadable.length ? 'partial' : 'read';
  return {
    ...base, state, ...(state !== 'read' ? { why: `${plural(r.unreadable.length, 'plan')} could not be read` } : {}),
    summary, counts, unreadable: r.unreadable, notes, items, more: Math.max(0, all.length - items.length),
    ...(first ? { urgent: { text: firstText, tone: first.needs.length ? 'attention' : first.tone, source: first.source } } : {}),
  };
}

/** A need's words without the command the ledger put after them ("… (timmy fleet reconcile f…)"): the command is listed apart. */
const withoutCommand = (n: string): string => n.replace(/ \(timmy [^)]*\)$/, '');

/** What waits on a person in the project's real fleets, for Needs you (never a simulation's: it allocated nothing). */
export function fleetNeeds(part: FleetSection | undefined): NeedsItem[] {
  if (!part) return [];
  return part.items.flatMap((i) => i.needs.map((n): NeedsItem => {
    // the ledger's words (src/fleet/service.ts readFleetView): "worker N: …" for a worker whose compute is unknown
    const unknown = /^worker \d+:/.test(n);
    return {
      title: `fleet ${i.plan}: ${withoutCommand(n)}`,
      kind: unknown ? 'fleet-unknown' : 'fleet-left', blocks: false,
      needed: unknown ? 'a person checks this allocation with its provider; reconciling settles what can be read' : 'a person settles what the fleet left: reconcile reads each allocation it named',
      why: `${i.backend} (${i.provider}): ${i.words}`,
      commands: [...new Set([`timmy fleet reconcile ${i.plan}`, `timmy fleet status ${i.plan}`])],
      operation: i.operation, source: i.source,
    };
  }));
}
