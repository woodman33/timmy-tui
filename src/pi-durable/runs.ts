/**
 * Pi Durable, slice S1 (R4 H118): the worker's own record of each delegated run, <project>/.timmy/pi/runs/<run>.json
 * (0600, temp file and rename; the worker is the single writer). It names the run's conversation, request id and
 * submission in the store, the key it was delegated with, and what Timmy knows that Pi does not: a stop someone asked
 * for, a pause and why, an interruption, NEEDS YOU items, and cost words. It is readable while the worker is down.
 * (S2 replaces it with the code-agent run records, .timmy/agents/<run>/; the store's own run index, a session document
 * written in the conversation's creating commit, stays the authority for which conversation a run has.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivate } from './owner.js';
import type { FauxScript } from './faux.js';
import type { PiPaths } from './paths.js';

export const RUN_SCHEMA = 'timmy.pi-run/1';

export type RunWords = 'queued' | 'running' | 'needs you' | 'paused' | 'interrupted' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface Stamp { readonly why: string; readonly at: string }

export interface RunFile {
  readonly schema: typeof RUN_SCHEMA;
  readonly run: string;
  readonly key?: string;
  readonly task: string;
  readonly request_id: string;
  conversation?: number;
  submission?: number;
  /** FAKE: S1's only model route is pi-ai's scripted faux provider */
  readonly model: { readonly route: 'faux'; readonly provider: string; readonly model: 'faux-1'; readonly fake: true; readonly script: FauxScript };
  readonly created: string;
  updated: string;
  paused?: Stamp | null;
  interrupted?: Stamp | null;
  stop_requested?: { readonly by: string; readonly at: string } | null;
  needs_you?: { readonly key: string; readonly why: string; readonly at: string }[];
  /** set when a model request was in flight at a kill: it is sent again, and its first cost is never recorded (spike G) */
  cost_unknown?: string | null;
  /** each re-submission with the same request id at a Resume, and whether the store returned the same submission (`first`: none existed yet) */
  resubmitted?: { readonly at: string; readonly submission: number; readonly same: boolean; readonly first?: true }[];
  ended?: { readonly status: RunWords; readonly reason?: string; readonly at: string } | null;
}

export const runPath = (paths: PiPaths, run: string): string => join(paths.runs, `${run}.json`);

export function readRun(paths: PiPaths, run: string): RunFile | undefined {
  if (!/^[0-9a-f]{8}$/.test(run)) return undefined;
  try {
    const r = JSON.parse(readFileSync(runPath(paths, run), 'utf8')) as RunFile;
    return r?.schema === RUN_SCHEMA ? r : undefined;
  } catch { return undefined; }
}

export function writeRun(paths: PiPaths, r: RunFile): RunFile {
  r.updated = new Date().toISOString();
  writePrivate(runPath(paths, r.run), `${JSON.stringify(r, null, 2)}\n`);
  return r;
}

export function listRuns(paths: PiPaths): RunFile[] {
  let names: string[] = [];
  try { names = readdirSync(paths.runs); } catch { return []; }
  return names.filter((n) => /^[0-9a-f]{8}\.json$/.test(n)).map((n) => readRun(paths, n.slice(0, 8))).filter((r): r is RunFile => !!r)
    .sort((a, b) => a.created.localeCompare(b.created));
}
