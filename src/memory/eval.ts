/**
 * Timmy Memory (round R4, helper H50): `/lesson eval <id>`, an evaluated improvement, not training. From the flow records
 * only (results/flows/*.json), it sets the runs of the lesson's kinds that did not use it, before its first use, beside
 * the runs that used it, and counts for each side: n; completion (succeeded of all); correctness (readback matches of
 * those compared); the median duration; cost (the sum of the costs recorded, and how many were unknown: an unknown cost
 * is never counted as 0); interventions (runs a person stopped, as recorded: outcome cancelled); and recovery
 * (interrupted runs that a later session's recovery recorded). Unknown stays unknown. With fewer than 5 runs on either
 * side it says "too few runs to compare" beside the numbers, and it never claims significance.
 */
import type { FlowKind } from '../repl/board-steps.js';
import type { Lesson, LessonKind } from './lessons.js';
import { readFlows, type FlowUse } from './usage.js';

/** Below this many runs on either side, the numbers are shown with "too few runs to compare". */
export const EVAL_MIN_RUNS = 5;
const FLOW_KINDS: readonly LessonKind[] = ['tray', 'blender', 'scad', 'freecad', 'ae'];

export interface EvalSide {
  n: number;
  succeeded: number;
  /** readbacks that compared (matches or differs), and how many matched */
  compared: number;
  matched: number;
  /** runs whose start and end are both recorded, and the median of their durations (ms); null when none */
  timed: number;
  medianMs: number | null;
  /** the sum of the costs recorded as numbers, how many were, how many were recorded unknown (null), how many carry none */
  costUsd: number;
  costRecorded: number;
  costUnknown: number;
  costNone: number;
  /** stopped by a person (cancelled) */
  interventions: number;
  /** interrupted runs recorded by a later session's recovery */
  recovered: number;
  /** the flow ids, newest first */
  ids: string[];
}

export interface LessonEval {
  kinds: FlowKind[];
  /** kinds the lesson names that have no flow records (agent, vox, run): not compared here */
  notFlowKinds: LessonKind[];
  firstUse?: string;
  without: EvalSide;
  with: EvalSide;
  tooFew: boolean;
  unreadable: Array<{ rel: string; error: string }>;
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const time = (v: unknown): number => { const t = typeof v === 'string' ? Date.parse(v) : Number.NaN; return Number.isNaN(t) ? Number.NaN : t; };

/** The counts of one side. */
export function sideOf(flows: readonly FlowUse[]): EvalSide {
  const s: EvalSide = { n: flows.length, succeeded: 0, compared: 0, matched: 0, timed: 0, medianMs: null, costUsd: 0, costRecorded: 0, costUnknown: 0, costNone: 0, interventions: 0, recovered: 0, ids: [] };
  const durations: number[] = [];
  for (const f of [...flows].sort((a, b) => String(b.record.started_at).localeCompare(String(a.record.started_at)))) {
    const r = f.record;
    s.ids.push(String(r.id));
    if (r.outcome === 'succeeded') s.succeeded++;
    const verdict = obj(r.readback)?.verdict;
    if (verdict === 'matches' || verdict === 'differs') { s.compared++; if (verdict === 'matches') s.matched++; }
    const a = time(r.started_at);
    const b = time(r.ended_at);
    if (!Number.isNaN(a) && !Number.isNaN(b) && b >= a) durations.push(b - a);
    const cost = obj(r.agent) && Object.hasOwn(obj(r.agent)!, 'cost_usd') ? obj(r.agent)!.cost_usd : undefined;
    if (typeof cost === 'number' && Number.isFinite(cost)) { s.costUsd += cost; s.costRecorded++; } else if (cost === null) s.costUnknown++; else s.costNone++;
    if (r.outcome === 'cancelled') s.interventions++;
    if ((r.outcome as string) === 'interrupted' && obj(r.recovered)) s.recovered++;
  }
  durations.sort((x, y) => x - y);
  s.timed = durations.length;
  if (durations.length) {
    const m = Math.floor(durations.length / 2);
    s.medianMs = durations.length % 2 ? durations[m] : (durations[m - 1] + durations[m]) / 2;
  }
  return s;
}

/**
 * The evaluation: the lesson's flow kinds (its own, or, when it names none, the kinds of the flows that used it), the
 * flows of those kinds that did not use it and started before its first use, and the flows that used it.
 */
export function evaluateLesson(root: string, lesson: Lesson): LessonEval {
  const { flows, unreadable } = readFlows(root);
  const usedBy = flows.filter((f) => f.lessons.includes(lesson.id));
  const named = lesson.applies_to.kinds.filter((k) => FLOW_KINDS.includes(k)) as FlowKind[];
  const kinds = named.length ? named : [...new Set(usedBy.map((f) => f.kind).filter((k): k is FlowKind => !!k))];
  const notFlowKinds = lesson.applies_to.kinds.filter((k) => !FLOW_KINDS.includes(k));
  const starts = usedBy.map((f) => time(f.record.started_at)).filter((t) => !Number.isNaN(t));
  const first = starts.length ? Math.min(...starts) : undefined;
  const without = flows.filter((f) => !f.lessons.includes(lesson.id) && f.kind !== undefined && kinds.includes(f.kind)
    && (first === undefined || time(f.record.started_at) < first));
  const w = sideOf(without);
  const u = sideOf(usedBy);
  return {
    kinds, notFlowKinds, ...(first !== undefined ? { firstUse: new Date(first).toISOString() } : {}),
    without: w, with: u, tooFew: w.n < EVAL_MIN_RUNS || u.n < EVAL_MIN_RUNS, unreadable,
  };
}

/** A duration for people: "850 ms", "42 s", "3.5 min". */
export const durationText = (ms: number | null): string => (ms === null ? 'unknown (no run with both times)' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 120_000 ? `${Math.round(ms / 100) / 10} s` : `${Math.round(ms / 6000) / 10} min`);
const of = (a: number, b: number): string => (b ? `${a} of ${b} (${Math.round((a / b) * 100)}%)` : 'none to count');

/** One side's numbers as words, row by row (the same rows for both sides). */
export function sideRows(s: EvalSide): Record<'runs' | 'completion' | 'correctness' | 'duration' | 'cost' | 'interventions' | 'recovery', string> {
  return {
    runs: String(s.n),
    completion: s.n ? `${of(s.succeeded, s.n)} succeeded` : 'no runs',
    correctness: s.compared ? `${of(s.matched, s.compared)} readbacks matched` : 'no readback compared',
    duration: s.timed ? `median ${durationText(s.medianMs)} over ${s.timed} run${s.timed === 1 ? '' : 's'}` : durationText(null),
    cost: `${s.costRecorded ? `$${s.costUsd.toFixed(4)} recorded over ${s.costRecorded} run${s.costRecorded === 1 ? '' : 's'}` : 'none recorded as a number'}; ${s.costUnknown} unknown (not counted as 0)${s.costNone ? `; ${s.costNone} with no cost recorded` : ''}`,
    interventions: `${s.interventions} stopped by a person`,
    recovery: `${s.recovered} interrupted and recorded by recovery`,
  };
}
