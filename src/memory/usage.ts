/**
 * Timmy Memory (round R4, helper H50): which runs used each lesson, and the flow records an evaluation compares. A run
 * used a lesson when its record says so: a flow record's `lessons` (results/flows/*.json, read by readFlowRecord) or an
 * /agent run's record (.timmy/agents/<run>/, read by listAgentRuns). A flow's own agent run is the flow's, not counted
 * again: only /agent's runs carry lessons in their own record. Records that cannot be read are counted and named.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { listAgentRuns } from '../code-agents/index.js';
import { FLOWS_DIR, readFlowRecord, type FlowRecord } from '../flows/iterate.js';
import { flowKind, type FlowKind } from '../repl/board-steps.js';

export interface FlowUse { rel: string; record: FlowRecord & Record<string, unknown>; kind: FlowKind | undefined; lessons: string[] }

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((x) => (typeof obj(x)?.id === 'string' ? [obj(x)!.id as string] : [])) : []);

/** Every flow record of the project (each with its kind and the lessons it was given), and each one that cannot be read. */
export function readFlows(root: string): { flows: FlowUse[]; unreadable: Array<{ rel: string; error: string }> } {
  let names: string[] = [];
  try { names = readdirSync(path.join(root, ...FLOWS_DIR.split('/'))).filter((n) => n.endsWith('.json')).sort(); } catch { return { flows: [], unreadable: [] }; }
  const flows: FlowUse[] = [];
  const unreadable: Array<{ rel: string; error: string }> = [];
  for (const n of names) {
    const rel = `${FLOWS_DIR}/${n}`;
    const r = readFlowRecord(root, rel);
    if (!r.ok) { unreadable.push({ rel, error: r.error }); continue; }
    const record = r.record as FlowRecord & Record<string, unknown>;
    flows.push({ rel, record, kind: flowKind(record), lessons: ids(record.lessons) });
  }
  return { flows, unreadable };
}

/** For each lesson id, the runs that used it: flows (by their record file) and /agent runs (by their run id). */
export function lessonUsage(root: string): Map<string, Array<{ kind: 'flow' | 'agent'; id: string }>> {
  const used = new Map<string, Array<{ kind: 'flow' | 'agent'; id: string }>>();
  const add = (lesson: string, run: { kind: 'flow' | 'agent'; id: string }): void => { used.set(lesson, [...(used.get(lesson) ?? []), run]); };
  for (const f of readFlows(root).flows) for (const id of new Set(f.lessons)) add(id, { kind: 'flow', id: String(f.record.id) });
  for (const r of listAgentRuns(root)) for (const id of new Set(ids((r as { lessons?: unknown }).lessons))) add(id, { kind: 'agent', id: r.run });
  return used;
}
