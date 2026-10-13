/**
 * Pi Durable, slice S1 (R4 H118): how any Timmy process gets the project's Pi worker (plan b.1.6, b.2).
 *
 * `ensureWorker(root)`: read worker.json; when its writer is alive (the writerState proof: pid AND process start) and its
 * hello answers with this project's id and store, attach. Otherwise start `node <worker entry> --project <root>`
 * DETACHED (its own process group, its output appended to .timmy/pi/worker.log) and wait up to 10 s for its hello. A
 * started worker that exits 3 found the store owned (another starter won the race): attach to that owner. The SQLite
 * lock is the guarantee that one store never has two workers; worker.json is only the directory.
 *
 * The start budget (plan b.2: a budget for restarting a worker that keeps dying): at most 3 starts per 10 minutes per
 * project that did not end cleanly, counted in .timmy/pi/starts.jsonl. A start that lost the race (exit 3) does not
 * count, nor one whose worker exited cleanly (exit 0, which the worker records there itself), so Timmy sessions that
 * come and go are never refused. A bad line is skipped, never the whole budget. Past it nothing is started: a NEEDS
 * YOU with the last lines of worker.log (`PiNeedsYou`). A store held by a live owner that does not answer is refused
 * with words naming it; Timmy never kills it by itself.
 *
 * `recoverOnStart(root)` is the start-up rule of b.2: the worker is started again only when there is persisted pending
 * work, the setting allows it ("free local work only", the default, or "never"), and the budget holds; it then resumes
 * only when every pending run's route costs nothing (S1: the FAKE route), never a run that could cost money.
 *
 * `attachWorker(root)` only attaches; it never starts anything (what a UI that is just looking does).
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { THIS_PROCESS } from '../ops/process-proof.js';
import { freeRoute } from './cost.js';
import { ownerState, readOwner, readToken, sha256Hex } from './owner.js';
import { piPaths, STORE_REL, type PiPaths } from './paths.js';
import { PiClient, type OnExit, type ResumeResult } from './protocol.js';
import { listRuns } from './runs.js';

export const START_WAIT_MS = 10_000;
export const START_BUDGET = Object.freeze({ limit: 3, windowMs: 10 * 60_000 });
/** provider keys the worker never needs in S1 (its only model is FAKE): blanked in its environment, as planAgent blanks OPENROUTER_API_KEY */
export const BLANKED_KEYS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

export interface EnsureOptions {
  readonly workerDir?: string;
  /** how long to wait for a started worker's hello (default 10 s) */
  readonly waitMs?: number;
  /** how long one hello may take (default 5 s) */
  readonly helloTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** who is asking, sent in hello */
  readonly surface?: string;
  /** the worker's exit setting and timings, passed as its arguments when this call starts it */
  readonly worker?: { readonly onExit?: OnExit; readonly idleMs?: number; readonly leaseGraceMs?: number; readonly trialShell?: boolean };
  /** the start budget (default 3 per 10 minutes) */
  readonly budget?: { readonly limit: number; readonly windowMs: number };
}

export interface Attached {
  readonly client: PiClient;
  readonly how: 'attached' | 'started' | 'attached after exit 3';
  /** the pid this call started, when it started one (it may have exited 3) */
  readonly spawned?: number;
  readonly spawnedExit?: number | null;
}

/** Something only a person can settle: the words to show, and the end of the worker's log. */
export class PiNeedsYou extends Error {
  readonly needsYou = true;
  constructor(readonly words: string, readonly log: string) { super(words); this.name = 'PiNeedsYou'; }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Attaches to the project's live worker, or answers why not (never starts one). */
export async function attachWorker(root: string, surface = 'timmy', helloTimeoutMs = 5000): Promise<PiClient | { error: string }> {
  const paths = piPaths(root);
  const owner = readOwner(paths);
  if (!owner) return { error: 'no Pi worker record (worker.json) in this project' };
  const state = ownerState(owner);
  if (state === 'gone') return { error: `the Pi worker recorded (pid ${owner.pid}) is gone` };
  if (owner.project_id !== paths.projectId || owner.store !== STORE_REL) return { error: 'worker.json names another project or store' };
  const token = readToken(paths);
  if (!token || owner.token_sha256 !== sha256Hex(token)) return { error: 'the Pi worker token does not match worker.json' };
  let client: PiClient;
  try {
    client = await PiClient.connect(owner.socket, { token, pid: THIS_PROCESS.pid, started: THIS_PROCESS.started, surface }, helloTimeoutMs);
  } catch (e) { return { error: `the Pi worker (pid ${owner.pid}) did not answer hello: ${e instanceof Error ? e.message : String(e)}` }; }
  if (client.hello.project_id !== paths.projectId || client.hello.store !== STORE_REL || client.hello.pid !== owner.pid) {
    client.close();
    return { error: 'the worker that answered is not this project\'s (its hello names another project, store or pid)' };
  }
  return client;
}

/** The worker's entry and how node runs it: the built .js as it is, the source .ts through tsx's loader. */
export function workerCommand(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith('.ts')) {
    const entry = fileURLToPath(new URL('./worker.ts', import.meta.url));
    const loader = createRequire(import.meta.url).resolve('tsx');
    return { command: process.execPath, args: ['--import', loader, entry] };
  }
  return { command: process.execPath, args: [fileURLToPath(new URL('./worker.js', import.meta.url))] };
}

/** The last lines of the worker's log, for a failure's words. */
export function logTail(paths: PiPaths, n = 12): string {
  try { return readFileSync(paths.log, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return '(no worker log)'; }
}

interface StartLine { at: string; pid: number; by_pid?: number; surface?: string; lost_race?: true; clean_exit?: true }

/**
 * The starts that count against the budget in its window: every start, less those that lost the race (exit 3) and
 * those whose worker exited cleanly (a later line of the same pid says so). A line that does not parse is skipped.
 */
export function startsInWindow(paths: PiPaths, windowMs: number, now = Date.now()): { pid: number; at: string }[] {
  let text = '';
  try { text = readFileSync(paths.starts, 'utf8'); } catch { text = ''; }
  const lines: StartLine[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      const x = JSON.parse(l) as StartLine;
      if (x && typeof x.pid === 'number' && typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at))) lines.push(x);
    } catch { /* a line cut by a crash: skipped, the rest still counts */ }
  }
  const ended = lines.filter((l) => l.lost_race || l.clean_exit);
  const endedLater = (s: StartLine): boolean => ended.some((e) => e.pid === s.pid && Date.parse(e.at) >= Date.parse(s.at));
  return lines.filter((l) => !l.lost_race && !l.clean_exit && !endedLater(l) && now - Date.parse(l.at) < windowMs).map((l) => ({ pid: l.pid, at: l.at }));
}

const recordStart = (paths: PiPaths, line: StartLine): void => {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  appendFileSync(paths.starts, `${JSON.stringify(line)}\n`, { mode: 0o600 });
};

/** Starts one worker, detached, with its output appended to worker.log. */
function startWorker(paths: PiPaths, opts: EnsureOptions): { pid: number; exited: Promise<number | null> } {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const fd = openSync(paths.log, 'a', 0o600);
  const { command, args } = workerCommand();
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
  for (const k of BLANKED_KEYS) delete env[k];
  const w = opts.worker ?? {};
  const workerArgs = [
    '--project', paths.root,
    ...(opts.workerDir ? ['--worker-dir', opts.workerDir] : []),
    ...(w.onExit ? ['--on-exit', w.onExit] : []),
    ...(w.idleMs !== undefined ? ['--idle-ms', String(w.idleMs)] : []),
    ...(w.leaseGraceMs !== undefined ? ['--lease-grace-ms', String(w.leaseGraceMs)] : []),
    ...(w.trialShell ? ['--allow-trial-shell'] : []),
  ];
  const child = spawn(command, [...args, ...workerArgs], { cwd: paths.root, env, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const exited = new Promise<number | null>((resolveExit) => {
    child.once('exit', (code) => resolveExit(code));
    child.once('error', () => resolveExit(null));
  });
  child.unref();
  if (child.pid === undefined) throw new Error('the Pi worker could not be started');
  return { pid: child.pid, exited };
}

/**
 * Attach to the live owner, or start the worker and attach to it. Never a second worker for one store: a start that
 * lost the race exits 3 and this call attaches to the winner. One more start is tried only when no owner appears at all.
 */
export async function ensureWorker(root: string, opts: EnsureOptions = {}): Promise<Attached> {
  const paths = piPaths(root);
  const surface = opts.surface ?? 'timmy';
  const helloMs = opts.helloTimeoutMs ?? 5000;
  const first = await attachWorker(root, surface, helloMs);
  if (first instanceof PiClient) return { client: first, how: 'attached' };
  const waitMs = opts.waitMs ?? START_WAIT_MS;
  const budget = opts.budget ?? START_BUDGET;
  let lastExit: number | null | undefined;
  let spawned: number | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const used = startsInWindow(paths, budget.windowMs);
    if (used.length >= budget.limit) {
      const log = logTail(paths);
      throw new PiNeedsYou(`NEEDS YOU: the Pi worker was started ${used.length} times in the last ${Math.round(budget.windowMs / 60_000)} minutes without ending cleanly (pids ${used.map((u) => u.pid).join(', ')}); it is not started again by itself. The end of its log (.timmy/pi/worker.log):\n${log}`, log);
    }
    const started = startWorker(paths, opts);
    spawned = started.pid;
    recordStart(paths, { at: new Date().toISOString(), pid: started.pid, by_pid: THIS_PROCESS.pid, surface });
    let exit: number | null | undefined;
    void started.exited.then((code) => {
      exit = code;
      if (code === 3) recordStart(paths, { at: new Date().toISOString(), pid: started.pid, lost_race: true });
    });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(100);
      const c = await attachWorker(root, surface, helloMs);
      if (c instanceof PiClient) {
        if (c.hello.pid === started.pid) return { client: c, how: 'started', spawned: started.pid };
        return { client: c, how: 'attached after exit 3', spawned: started.pid, spawnedExit: exit ?? (await Promise.race([started.exited, sleep(3000).then(() => undefined)])) ?? null };
      }
      if (exit !== undefined && exit !== 3) {
        throw new Error(`the Pi worker exited ${exit} before it answered: ${logTail(paths)}`);
      }
    }
    lastExit = exit;
    if (exit === undefined) throw new Error(`the Pi worker (pid ${started.pid}) did not answer hello within ${waitMs} ms: ${logTail(paths)}`);
    // it exited 3 and no owner answered in time: one more start
  }
  const owner = readOwner(paths);
  const state = owner ? ownerState(owner) : undefined;
  if (lastExit === 3 && owner && state !== 'gone') {
    throw new PiNeedsYou(`NEEDS YOU: the Pi store ${STORE_REL} is held by pid ${owner.pid} (${state}), which did not answer hello within ${helloMs} ms; a second worker cannot open it ("database is locked"). It may be stopped or hung: Timmy does not kill it by itself.`, logTail(paths));
  }
  throw new Error(`no Pi worker could be started or attached (last start exited ${String(lastExit)}, pid ${String(spawned)}): ${logTail(paths)}`);
}

export interface RecoverOptions extends EnsureOptions {
  /** the setting (plan g): "free local work only" (the default) or "never" */
  readonly resumeOnStart?: 'free local work only' | 'never';
}
export interface Recovered { readonly started: boolean; readonly resumed: boolean; readonly words: string; readonly attached?: Attached; readonly resume?: ResumeResult }

/**
 * Timmy's start-up pass for Pi (plan b.2): start the worker again only when there is persisted pending work (a run
 * record not ended), the setting allows it and the budget holds; resume only when every pending run is free.
 */
export async function recoverOnStart(root: string, opts: RecoverOptions = {}): Promise<Recovered> {
  const paths = piPaths(root);
  const pending = listRuns(paths).filter((r) => !r.ended);
  if (!pending.length) return { started: false, resumed: false, words: 'nothing pending: the Pi worker is not started' };
  if ((opts.resumeOnStart ?? 'free local work only') === 'never') return { started: false, resumed: false, words: `the setting is "never": the Pi worker is not started; ${pending.length} run(s) wait for Resume` };
  const attached = await ensureWorker(root, opts); // the budget applies here (PiNeedsYou past it)
  if (attached.client.hello.scheduling === 'running') return { started: attached.how !== 'attached', resumed: false, words: 'the Pi worker runs', attached };
  const paid = pending.filter((r) => !freeRoute({ route: r.model.route, model: r.model.model }));
  if (paid.length) return { started: attached.how !== 'attached', resumed: false, words: `the Pi worker is paused: ${paid.length} run(s) use a route that may cost money and wait for the operator's Resume`, attached };
  const resume = await attached.client.request<ResumeResult>('resume');
  return { started: attached.how !== 'attached', resumed: true, words: `resumed ${pending.length} free run(s) (the FAKE route costs nothing)`, attached, resume };
}
