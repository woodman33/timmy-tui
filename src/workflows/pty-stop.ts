/**
 * Round R4 (helper H67, ledger row 162, r20 on the Mac): a live run's pty wrapper's stop file (workers/upmd/pty_run.py
 * --stop-file): what the wrapper saw of the run, written as it exited, whatever ended it. When the REPL that started a run
 * has ended (a kill, a crash), recovery (src/repl/workflow-recover.ts) reads it: the wrapper saw what that REPL could not
 * (upmd's lines after the REPL's end, and its own stop of upmd, which it makes at once once its parent has ended).
 *
 *   makeRunFolder   the run's own folder (<jobs dir>/runs/w<8 hex>/, mode 0700), made before the run starts, and the stop
 *                   file's path in it, which the job's arguments then carry (`--stop-file`)
 *   readPtyStop     the file, checked: a regular file of at most 64 KB, one JSON object of schema timmy.pty-stop/1, written
 *                   by the job's own process (its pid), each field of the shape the wrapper writes; else not used, and why
 *   mergePtyStop    the job's steps as Timmy recorded them, joined with the blocks the wrapper saw: a block whose end
 *                   Timmy did not see takes the wrapper's (completed or failed, its exit and moments, marked seen by the
 *                   wrapper); the block running when the wrapper stopped upmd is interrupted (its end moment the stop's);
 *                   a block only the wrapper saw is added, named by its number when upmd had not said its name. What came
 *                   after is 'not run' only when the file proves nothing more could start (the wrapper stopped every
 *                   process group of upmd's, or upmd had ended, or was never started), else 'not seen'.
 *   wrapperDid      what the wrapper did, in words
 */
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { JobRecord, JobStep, WrapperAccount } from '../jobs/index.js';

export const PTY_STOP_SCHEMA = 'timmy.pty-stop/1';
const MAX_BYTES = 64 * 1024;
const STOP_FILE = 'stop.json';

/** One block as the wrapper saw it: 'stopped' was running when it began to stop upmd; 'running': its end was not seen. */
export interface PtyStopBlock { n: number; count?: number; name?: string; state: 'completed' | 'failed' | 'stopped' | 'running'; code?: number; started_at?: string; ended_at?: string; stopped_at?: string }
export interface PtyStop {
  wrapper_pid: number;
  /** the command's file name (upmd's) */
  command: string;
  /** null: the command was not started */
  command_pid: number | null;
  started_at: string;
  /** when the file was written */
  at: string;
  /** the wrapper's own words: why it ended */
  why: string;
  parent: { pid: number; ended: boolean };
  /** whether the wrapper stopped the command */
  stopped: boolean;
  stopping_at?: string;
  said?: string;
  signals: string[];
  groups: number[];
  /** the process groups still running after SIGKILL */
  left: number[];
  /** the command's exit (128 + n for signal n) as the wrapper saw it; null when not known */
  exit: number | null;
  blocks: PtyStopBlock[];
}

/**
 * The run's own folder, made now (<jobsDir>/runs/w<8 hex>/, mode 0700), and the path of the stop file its wrapper is to
 * write there; undefined when it cannot be made (the run then goes without one, and recovery proves nothing by it).
 */
export function makeRunFolder(jobsDir: string): string | undefined {
  for (let attempt = 0; attempt < 5; attempt++) {
    const dir = path.join(path.resolve(jobsDir), 'runs', `w${randomBytes(4).toString('hex')}`);
    try {
      mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
      mkdirSync(dir, { mode: 0o700 });
      return path.join(dir, STOP_FILE);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
    }
  }
  return undefined;
}

export type PtyStopRead = { ok: true; stop: PtyStop } | { ok: false; why: string };

const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const str = (v: unknown, max = 600): v is string => typeof v === 'string' && v.length <= max;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const stamp = (v: unknown): v is string => typeof v === 'string' && STAMP.test(v);
const SIG = /^SIG[A-Z0-9]+$/;

/** The stop file at `file`, written by the wrapper of `job` (its pid): see the module comment. */
export function readPtyStop(file: string, job: Pick<JobRecord, 'pid'>): PtyStopRead {
  let st;
  try { st = lstatSync(file); } catch (e) {
    return { ok: false, why: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'its pty wrapper wrote no stop file' : 'its pty wrapper\'s stop file could not be read' };
  }
  if (!st.isFile() || st.size > MAX_BYTES) return { ok: false, why: 'its pty wrapper\'s stop file is not one Timmy reads (a regular file of at most 64 KB)' };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return { ok: false, why: 'its pty wrapper\'s stop file is not JSON' }; }
  const stop = parseStop(raw);
  if (!stop) return { ok: false, why: `its pty wrapper's stop file is not of the shape ${PTY_STOP_SCHEMA}` };
  if (job.pid !== undefined && stop.wrapper_pid !== job.pid) return { ok: false, why: `its pty wrapper's stop file names process ${stop.wrapper_pid}, not the run's (${job.pid})` };
  return { ok: true, stop };
}

function parseStop(raw: unknown): PtyStop | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.schema !== PTY_STOP_SCHEMA || !int(r.wrapper_pid) || !str(r.command, 255) || !(r.command_pid === null || int(r.command_pid))) return undefined;
  if (!stamp(r.started_at) || !stamp(r.at) || !str(r.why) || typeof r.stopped !== 'boolean' || !(r.exit === null || int(r.exit))) return undefined;
  const parent = r.parent && typeof r.parent === 'object' ? r.parent as Record<string, unknown> : undefined;
  if (!parent || !int(parent.pid) || typeof parent.ended !== 'boolean') return undefined;
  const list = (v: unknown, ok: (x: unknown) => boolean, max: number): boolean => Array.isArray(v) && v.length <= max && v.every(ok);
  if (r.stopped && (!list(r.signals, (x) => typeof x === 'string' && SIG.test(x), 4) || !list(r.groups, int, 256) || !list(r.left, int, 256) || !stamp(r.stopping_at) || !str(r.said, 2000))) return undefined;
  if (!list(r.blocks, (b) => !!b && typeof b === 'object', 1000)) return undefined;
  const blocks: PtyStopBlock[] = [];
  for (const b of r.blocks as Array<Record<string, unknown>>) {
    if (!int(b.n) || b.n < 1 || !(b.state === 'completed' || b.state === 'failed' || b.state === 'stopped' || b.state === 'running')) return undefined;
    if ((b.count !== undefined && !int(b.count)) || (b.name !== undefined && !str(b.name, 200)) || (b.code !== undefined && !int(b.code))) return undefined;
    for (const k of ['started_at', 'ended_at', 'stopped_at'] as const) if (b[k] !== undefined && !stamp(b[k])) return undefined;
    blocks.push({
      n: b.n, state: b.state, ...(b.count !== undefined ? { count: b.count as number } : {}), ...(b.name !== undefined ? { name: b.name as string } : {}),
      ...(b.code !== undefined ? { code: b.code as number } : {}), ...(b.started_at ? { started_at: b.started_at as string } : {}),
      ...(b.ended_at ? { ended_at: b.ended_at as string } : {}), ...(b.stopped_at ? { stopped_at: b.stopped_at as string } : {}),
    });
  }
  return {
    wrapper_pid: r.wrapper_pid, command: r.command, command_pid: r.command_pid as number | null, started_at: r.started_at, at: r.at, why: r.why,
    parent: { pid: parent.pid as number, ended: parent.ended as boolean }, stopped: r.stopped,
    ...(r.stopped ? { stopping_at: r.stopping_at as string, said: r.said as string } : {}),
    signals: r.stopped ? [...r.signals as string[]] : [], groups: r.stopped ? [...r.groups as number[]] : [], left: r.stopped ? [...r.left as number[]] : [],
    exit: r.exit as number | null, blocks,
  };
}

/** What a merge of the job's steps with the wrapper's stop file says (see the module comment). */
export interface PtyStopMerge {
  steps: JobStep[];
  /** the block that was running when the wrapper stopped upmd (or, upmd not stopped, whose end it did not see) */
  running?: string;
  /** the blocks whose end the wrapper saw and Timmy had not recorded, in the order upmd showed them */
  ended: string[];
  /** whether anything after the steps could have started: 'not run' only when the file proves it could not */
  rest: 'not run' | 'not seen';
  /** upmd ended by itself, the wrapper seeing its exit (it did not stop it) */
  upmdEnded: boolean;
  /** the wrapper's account, as the record keeps it */
  account: WrapperAccount;
}

/**
 * The job's steps (as Timmy recorded them) joined with the blocks the wrapper saw. `nameOf` names a block by its number
 * (and upmd's count) when neither Timmy's steps nor upmd's own lines did.
 */
export function mergePtyStop(steps: readonly JobStep[], stop: PtyStop, nameOf: (n: number, count?: number) => string | undefined = () => undefined): PtyStopMerge {
  const out: JobStep[] = steps.map((s) => ({ ...s }));
  const ended: string[] = [];
  let running: string | undefined;
  const last = (pred: (s: JobStep) => boolean): JobStep | undefined => { for (let i = out.length - 1; i >= 0; i--) if (pred(out[i])) return out[i]; return undefined; };
  for (const b of stop.blocks) {
    let s = last((x) => x.index === b.n) ?? (b.name !== undefined ? last((x) => x.index === undefined && x.name === b.name) : undefined);
    const name = s?.name ?? b.name ?? nameOf(b.n, b.count) ?? `block ${b.n}`;
    if (b.state === 'completed' || b.state === 'failed') {
      if (!s) {
        out.push({ name, index: b.n, state: b.state, ...(b.code !== undefined ? { code: b.code } : {}), ...(b.started_at ? { startedAt: b.started_at } : {}), ...(b.ended_at ? { endedAt: b.ended_at } : {}), seen: 'wrapper' });
        ended.push(name);
      } else if (s.state === 'running') {
        s.state = b.state;
        if (b.code !== undefined) s.code = b.code;
        if (b.ended_at) s.endedAt = b.ended_at;
        if (!s.startedAt && b.started_at) s.startedAt = b.started_at;
        s.seen = 'wrapper';
        ended.push(name);
      }
      // else: Timmy saw it end itself, and its own record stands
      continue;
    }
    if (!s) {
      s = { name, index: b.n, state: 'running', ...(b.started_at ? { startedAt: b.started_at } : {}) };
      out.push(s);
    }
    if (s.state !== 'running') continue;
    running = s.name;
    if (b.state === 'stopped') {
      // running when the wrapper stopped upmd, as its REPL had ended: interrupted, its end moment the wrapper's stop
      s.state = 'interrupted';
      if (!s.endedAt && b.stopped_at) s.endedAt = b.stopped_at;
      s.seen = 'wrapper';
    }
  }
  running ??= last((x) => x.state === 'running')?.name;
  const started = stop.command_pid !== null;
  const upmdEnded = started && !stop.stopped && stop.exit !== null;
  const proven = !started || (stop.stopped && stop.left.length === 0) || upmdEnded;
  return {
    steps: out, ...(running ? { running } : {}), ended, rest: proven ? 'not run' : 'not seen', upmdEnded,
    account: { why: stop.why, at: stop.stopping_at ?? stop.at, stopped: stop.stopped, signals: [...stop.signals], left: stop.left.length, exit: stop.exit },
  };
}

const PARENT_ENDED = /^its parent \(process \d+\) ended$/;
const PARENT_GONE_FIRST = /^its parent \(process \d+\) had ended before /;
const RECEIVED = /^(SIG[A-Z0-9]+) received$/;

/** What the wrapper did, in words (its account as a record keeps it). */
export function wrapperDid(a: WrapperAccount): string {
  const left = a.left ? `; ${a.left} process group${a.left === 1 ? '' : 's'} of it still ran after SIGKILL` : '';
  const signals = a.signals.join(', then ');
  if (a.stopped && PARENT_ENDED.test(a.why)) return `its pty wrapper saw its REPL end and stopped upmd at once (${signals})${left}`;
  const got = RECEIVED.exec(a.why);
  if (a.stopped && got) return `its pty wrapper received ${got[1]} and stopped upmd (${signals})${left}`;
  if (a.stopped) return `its pty wrapper stopped upmd (${signals}): ${a.why}${left}`;
  if (PARENT_GONE_FIRST.test(a.why)) return 'its REPL had ended before upmd started, so its pty wrapper did not start upmd';
  if (a.exit !== null) return `its pty wrapper saw upmd end by itself (exit ${a.exit})`;
  return `its pty wrapper said: ${a.why}`;
}
