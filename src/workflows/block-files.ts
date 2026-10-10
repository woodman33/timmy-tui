/**
 * Round R4 (helper H74): the files a workflow block's receipt names: only what Timmy can prove the block changed.
 *
 * Timmy does not follow a block's own commands: upmd runs them and their writes are not observed, so what they wrote
 * themselves is never listed (a snapshot of the project around a block would show what changed while it ran, not what the
 * block changed). What Timmy can prove is what its own runs wrote: a flow, a native run and a code agent run each keep a
 * record naming the files it wrote with their sha256, sealed by a receipt on the chain. A block's `timmy act` (or
 * `timmy md`) joins its run's operation (TIMMY_OPERATION), so the runs it starts carry that operation's id; and upmd runs
 * one block at a time, so a run of that operation that started after the block before ended (or after the run started) and
 * ended before this block ended was started by this block.
 *
 * Each file is named as its record names it: its path, its sha256, what it is, the run, the record and the receipt that
 * sealed the record (when one on the chain sealed those bytes). A file two runs name is listed once, as the first names
 * it; the runs a flow's record names (its agent run, its native run) are read with the flow, not again.
 *
 * Not told apart (and so the words say "ran wholly while this block ran"): a process an earlier block left running in the
 * background that starts a run of the operation while a later block runs.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_DIR, listAgentRuns } from '../code-agents/index.js';
import { FLOWS_DIR } from '../flows/iterate.js';
import { listNativeRuns, readNativeRecord } from '../native/index.js';
import { flowOutputs } from '../ops/card.js';
import { flowClaims } from '../ops/outcome.js';
import type { Receipt } from '../utils/receipts.js';
import { receiptShort, type ProvenFile } from './block-receipts.js';

/** What a block receipt's `files` were found by, in words (sealed with them as `files_checked`). */
export const BLOCK_FILES_CHECKED = 'the records of Timmy\'s own runs (flows, native runs, code agent runs) that joined this run\'s operation and ran wholly while this block ran (after the block before it ended, or the run started, and before this block ended, as Timmy saw them; upmd runs one block at a time): each file as its record names it, with its sha256, and the receipt that sealed that record. What the block\'s own commands wrote is not followed and is not listed';
/** The same when the run belongs to no operation. */
export const BLOCK_FILES_NO_OPERATION = 'nothing: the run belongs to no operation, so no run of Timmy\'s can be joined to this block. What the block\'s own commands wrote is not followed and is not listed';
/** At most this many files are named in one block receipt; the rest are counted. */
export const BLOCK_FILES_MAX = 50;
const RECORD_MAX = 2 * 1024 * 1024;

/** When a block ran, as Timmy saw it (ms since the epoch): from the end of the block before it (or the run's start) to its end. */
export interface BlockWindow { from: number; to: number }

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const time = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : Number.NaN);
/** A path inside the project as '/'-separated parts, or undefined. */
const inProject = (p: unknown): string | undefined => {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.startsWith('/') || p.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('~')) return undefined;
  const parts = p.split('/').filter((x) => x && x !== '.');
  return parts.length && !parts.includes('..') ? parts.join('/') : undefined;
};
/** Whether [start, end] lies inside the window; a run with no end recorded did not end inside it. */
const within = (w: BlockWindow, start: number, end: number): boolean => Number.isFinite(start) && Number.isFinite(end) && start >= w.from && end <= w.to && end >= start;

/** A record file of the project: its value and its sha256, never through a link, never a large one. */
function readRecord(root: string, rel: string): { value: unknown; sha256: string } | undefined {
  try {
    const abs = path.join(root, ...rel.split('/'));
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size > RECORD_MAX) return undefined;
    const buf = fs.readFileSync(abs);
    return { value: JSON.parse(buf.toString('utf8')), sha256: createHash('sha256').update(buf).digest('hex') };
  } catch { return undefined; }
}

/** The flow records modified since the window opened (a cheap filter before any is read), by name. */
function recentFlows(root: string, since: number): string[] {
  try {
    return fs.readdirSync(path.join(root, FLOWS_DIR)).filter((n) => /^f[0-9a-f]{8}\.json$/.test(n)).filter((n) => {
      try { return fs.statSync(path.join(root, FLOWS_DIR, n)).mtimeMs >= since - 2000; } catch { return false; }
    }).sort();
  } catch { return []; }
}

/**
 * The files Timmy can prove a block changed (see the module comment), at most BLOCK_FILES_MAX of them (`more` counts the
 * rest), and what was checked, in words. Never throws: a record that cannot be read is not a proof of anything.
 */
export function provenFiles(root: string, operation: string | undefined, w: BlockWindow, chain: readonly Receipt[]): { files: ProvenFile[]; more: number; checked: string } {
  if (!operation) return { files: [], more: 0, checked: BLOCK_FILES_NO_OPERATION };
  const files: ProvenFile[] = [];
  let more = 0;
  const add = (f: ProvenFile): void => {
    if (files.some((x) => x.path === f.path)) return;
    if (files.length >= BLOCK_FILES_MAX) { more++; return; }
    files.push(f);
  };
  const claimed = new Set<string>();
  // Flows: their outputs as their record names them (src/ops/card.ts flowOutputs, the operation card's own reading).
  for (const n of recentFlows(root, w.from)) {
    const rel = `${FLOWS_DIR}/${n}`;
    const read = readRecord(root, rel);
    const r = obj(read?.value);
    if (!read || !r || r.operation !== operation || !within(w, time(r.started_at), time(r.ended_at))) continue;
    for (const c of flowClaims(r)) claimed.add(c);
    const id = str(r.id) ?? n.slice(0, -5);
    const sealed = [...chain].reverse().find((x) => x.kind === 'flow' && (x.outputs ?? []).some((o) => o.path === rel && o.sha256 === read.sha256));
    for (const o of flowOutputs(r)) add({ path: o.path, ...(o.sha256 ? { sha256: o.sha256 } : {}), role: o.role, by: `flow ${id}`, record: rel, ...(sealed ? { receipt: receiptShort(sealed) } : {}) });
  }
  // Native runs not part of a flow: the files their last verdict says they wrote (present, written, with a sha256).
  let natives: ReturnType<typeof listNativeRuns> = [];
  try { natives = listNativeRuns(root); } catch { natives = []; }
  for (const n of natives) {
    if (claimed.has(`native:${n.run}`)) continue;
    let rec: ReturnType<typeof readNativeRecord>;
    try { rec = readNativeRecord(root, n.run); } catch { rec = undefined; }
    const last = rec?.verdicts.at(-1);
    if (!rec || !last || (rec.job as { operation?: unknown }).operation !== operation || !within(w, time(rec.job.started_at), time(last.judged_at))) continue;
    const sealed = [...chain].reverse().find((x) => x.kind === 'native' && x.native?.run === n.run);
    for (const f of last.files ?? []) {
      const rel = inProject(f.path);
      if (!rel || !f.present || !f.written || !f.sha256) continue;
      add({ path: rel, sha256: f.sha256, role: 'written by its native run', by: `${rec.job.app} run ${n.run.slice(0, 8)}`, record: `.timmy/native/${n.run}/job.json`, ...(sealed ? { receipt: receiptShort(sealed) } : {}) });
    }
  }
  // Code agent runs not part of a flow: what their record says changed in the project while the agent ran.
  let agents: ReturnType<typeof listAgentRuns> = [];
  try { agents = listAgentRuns(root); } catch { agents = []; }
  for (const a of agents) {
    if (claimed.has(`agent:${a.run}`) || a.operation !== operation || !within(w, time(a.started_at), time(a.ended_at))) continue;
    const sealed = [...chain].reverse().find((x) => x.kind === 'agent' && x.agent?.run === a.run);
    const by = `agent run ${a.run}`;
    const record = `${AGENTS_DIR}/${a.run}/result.json`;
    const receipt = sealed ? { receipt: receiptShort(sealed) } : {};
    for (const [list, role] of [[a.files?.added, 'added while its agent ran (its record)'], [a.files?.changed, 'changed while its agent ran (its record)'], [a.files?.deleted, 'deleted while its agent ran (its record)']] as const) {
      for (const f of list ?? []) {
        const rel = inProject(f.path);
        if (rel) add({ path: rel, ...(f.sha256 ? { sha256: f.sha256 } : {}), role, by, record, ...receipt });
      }
    }
  }
  return { files, more, checked: BLOCK_FILES_CHECKED };
}
