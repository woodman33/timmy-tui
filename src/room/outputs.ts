/**
 * Round R4 (helper H59; r18, ledger row 157): the Control Room lists an output only when its file is there.
 *
 * On the Mac, /room <flow> listed ".timmy/agents/<run>/result.json  agent result" for a flow interrupted in its agent step,
 * although its agent never wrote a result: the flow's record names where the result would be, and the room listed every
 * file a record names. Now each file a flow's or an agent run's record names is looked for in the project (lstat: nothing
 * is followed, read or written): one that is there is an output; one that is not is named as missing in words
 * ("result.json: not written"), never listed as an output. An agent's result.json is "not written" when the run's own
 * record says no result was written (interrupted by recovery), "not written yet" while its record says submitted; any other
 * file that is not there is "not there". The board and /room draw the missing ones apart (src/repl/board-room.ts,
 * src/room/text.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AGENTS_DIR, RUN_RECORD } from '../code-agents/index.js';
import type { Receipt } from '../utils/receipts.js';
import type { RoomOutput } from './index.js';

/** A file a run's record names that is not in the project now, and why, in words. */
export interface RoomMissing { role: string; path: string; words: string }

export const NOT_THERE = 'not there';
const RESULT = new RegExp(`^${AGENTS_DIR.replace(/\./g, '\\.')}/(a[0-9a-f]{8})/result\\.json$`);
const RECORD_MAX = 4 * 1024 * 1024;

/** Whether a project-relative file is there now, as itself: a link is there as a link (nothing is followed or read). */
export function isThere(root: string, rel: string): boolean {
  try { fs.lstatSync(path.join(root, rel)); return true; } catch { return false; }
}

/** An agent run's record (run.json) as its own words say it: its state, or undefined when it cannot be read. */
function runState(root: string, run: string): string | undefined {
  try {
    const file = path.join(root, AGENTS_DIR, run, RUN_RECORD);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > RECORD_MAX) return undefined;
    const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as { run?: unknown; state?: unknown };
    return rec && rec.run === run && typeof rec.state === 'string' ? rec.state : undefined;
  } catch { return undefined; }
}

/** The words for a file a record names that is not there: an agent's result by its run's own record, anything else "not there". */
export function missingWords(root: string, rel: string): string {
  const m = RESULT.exec(rel);
  if (!m) return NOT_THERE;
  const state = runState(root, m[1]);
  return state === 'interrupted' ? 'not written' : state === 'submitted' ? 'not written yet' : NOT_THERE;
}

/** The files a record names, split: those there now are its outputs; the others are named as missing, in words. */
export function splitOutputs(root: string, named: readonly RoomOutput[]): { outputs: RoomOutput[]; missing: RoomMissing[] } {
  const outputs: RoomOutput[] = [];
  const missing: RoomMissing[] = [];
  for (const o of named) {
    if (isThere(root, o.path)) outputs.push(o);
    else missing.push({ role: o.role, path: o.path, words: missingWords(root, o.path) });
  }
  return { outputs, missing };
}

/**
 * The receipt that seals a record's bytes as they are now (one whose outputs or sources name its path with its sha256: a
 * recover receipt for a plain run's end, a flow receipt for its agent step's), newest first, by its short id; or undefined.
 */
export function sealedBy(root: string, rel: string, chain: readonly Receipt[], projectId: string): string | undefined {
  let sha: string;
  try {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size > RECORD_MAX) return undefined;
    sha = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch { return undefined; }
  const names = (list: unknown): boolean => Array.isArray(list) && list.some((x) => !!x && typeof x === 'object' && (x as { path?: unknown }).path === rel && (x as { sha256?: unknown }).sha256 === sha);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const r = chain[i];
    if (!r || r.project_id !== projectId || !(names(r.outputs) || names((r as { sources?: unknown }).sources))) continue;
    return typeof r.hash === 'string' && r.hash.length > 15 ? r.hash.slice(7, 15) : String(r.id ?? '?');
  }
  return undefined;
}
